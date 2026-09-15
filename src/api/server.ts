import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DaemonConfig } from '../config.js';
import { managementOrigin } from '../config.js';
import { HarborError } from '../errors.js';
import type { SessionService } from '../auth/sessions.js';
import type { ApplicationService } from '../lifecycle/service.js';
import type { Logger } from '../lifecycle/context.js';
import type { PlatformToolsService } from '../tools/service.js';
import type { AppearanceService } from '../appearance/service.js';
import type { PowerControl } from '../system/power.js';
import type { TerminalService, TerminalSession } from '../system/terminal.js';
import type { SetupRequest, TerminalClientMessage } from '../contracts/api.js';
import type { SetupService } from '../auth/setup.js';
import { lanHostAllowed } from '../system/lan.js';
import { hostname as osHostname } from 'node:os';
import { hostFacts } from '../system/metrics.js';
import { ID_PATTERN, UUID_PATTERN } from '../contracts/patterns.js';
import { HOSTNAME_RE } from '../exposure/urls.js';
import { PRODUCT } from '../naming.js';
import { createFolder, listFolders, listMounts } from '../system/host-storage.js';
import { existsSync as fsExists, accessSync, constants as fsConstants, mkdirSync } from 'node:fs';

export interface ApiDeps {
  config: DaemonConfig;
  service: ApplicationService;
  sessions: SessionService;
  tools: PlatformToolsService;
  appearance: AppearanceService;
  power: PowerControl;
  terminals: TerminalService;
  setup: SetupService;
  tailscaleFacts: () => Promise<{ installed: boolean; loggedIn: boolean }>;
  log: Logger;
  version: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: string;
    bearer?: string;
  }
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
// style-src allows inline styles for the terminal (xterm.js injects a stylesheet); scripts stay strict.
const UI_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const errorBodySchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        nextAction: { type: 'string' },
        operationId: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
      },
      required: ['code', 'message', 'nextAction'],
    },
  },
  required: ['error'],
} as const;

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const { config, service, sessions, tools, log, appearance, power, terminals, setup, tailscaleFacts } = deps;
  const origin = managementOrigin(config);
  const allowedOrigins = new Set([origin, `http://127.0.0.1:${config.listen.port}`]);
  const allowedHosts = new Set([`localhost:${config.listen.port}`, `127.0.0.1:${config.listen.port}`]);

  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: true, strict: true } },
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: `${PRODUCT.displayName} local API`, version: deps.version, description: 'Loopback-only administration API for the Harbor local preview. Bearer sessions; JSON only.' },
      servers: [{ url: origin }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  // --- request guards
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    const host = req.headers.host ?? '';
    const extra = tools.extraOrigins(); // tailnet UI exposure, when configured
    const lanOk = (h: string) => config.lan.enabled && lanHostAllowed(h, config.lan.port, config.listen.port);
    if (!allowedHosts.has(host) && !extra.hosts.includes(host) && !lanOk(host)) {
      throw new HarborError('FORBIDDEN_ORIGIN', `Host ${host || '(missing)'} is not the configured management address`, { nextAction: `Use ${origin}.` });
    }
    const reqOrigin = req.headers.origin;
    if (reqOrigin !== undefined && !allowedOrigins.has(reqOrigin) && !extra.origins.includes(reqOrigin)) {
      let originHost: string;
      try {
        originHost = new URL(reqOrigin).host;
      } catch {
        originHost = '';
      }
      if (!(originHost && lanOk(originHost))) throw new HarborError('FORBIDDEN_ORIGIN', `Origin ${reqOrigin} is not allowed`);
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none' && req.url.startsWith('/v1/')) {
      throw new HarborError('FORBIDDEN_ORIGIN', `cross-site request (${site}) is not allowed`);
    }
    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && req.url.startsWith('/v1/')) {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (ct !== 'application/json') throw new HarborError('INVALID_REQUEST', 'content-type must be application/json');
    }
  });

  const requireAuth = async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const session = sessions.authenticate(token);
    req.actor = session.actor;
    if (token !== undefined) req.bearer = token;
  };

  // --- error mapping
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HarborError) {
      if (err.code === 'UNAUTHENTICATED') reply.header('www-authenticate', 'Bearer');
      return reply.status(err.httpStatus).send(err.toBody());
    }
    const e = err as { code?: string; statusCode?: number; validation?: unknown[]; message?: string };
    if (e.validation) {
      const details = (e.validation as { instancePath?: string; message?: string }[]).map((v) => `${v.instancePath || '/'}: ${v.message}`);
      return reply.status(422).send(new HarborError('INVALID_REQUEST', `invalid request: ${details[0] ?? ''}`, { details }).toBody());
    }
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 400 : 422).send(new HarborError(e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'MALFORMED_JSON' : 'INVALID_REQUEST', e.message ?? 'unsupported content type').toBody());
    }
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) {
      return reply.status(413).send(new HarborError('INVALID_REQUEST', 'request body exceeds 256 KiB').toBody());
    }
    if (e.statusCode === 400 || err instanceof SyntaxError) {
      return reply.status(400).send(new HarborError('MALFORMED_JSON', 'request body is not valid JSON').toBody());
    }
    log.error(`unhandled error on ${req.method} ${req.url}: ${e.message ?? String(err)}`);
    return reply.status(500).send(new HarborError('INTERNAL', 'internal error').toBody());
  });

  // --- liveness
  app.get('/healthz', { schema: { description: 'Daemon liveness only.', security: [], response: { 200: { type: 'object', properties: { status: { const: 'ok' } } } } } }, async () => ({ status: 'ok' }));

  // --- first-run setup (open while no administrator exists; guarded by the installer's setup code)
  app.get('/v1/setup', { schema: { description: 'Whether this Harbor still needs its first administrator, plus what the setup wizard shows.', security: [] } }, async () => {
    const sys = service.system();
    return { needed: setup.needed(), hostname: osHostname(), deviceName: sys.deviceName, lan: sys.lan, tailscale: await tailscaleFacts(), version: sys.version };
  });
  app.post(
    '/v1/setup',
    {
      schema: {
        description: 'Create the first administrator (setup code from the installer required), optionally name the machine, and get a session. Refused once an administrator exists.',
        security: [],
        body: { type: 'object', additionalProperties: false, required: ['code', 'username', 'password'], properties: { code: { type: 'string', minLength: 6, maxLength: 8 }, username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 }, deviceName: { type: 'string', maxLength: 80 } } },
      },
    },
    async (req, reply) => reply.status(201).send(await setup.claim(req.body as SetupRequest, req.ip)),
  );

  // --- Harbor's own updates
  app.get('/v1/system/update', { preHandler: requireAuth, schema: { description: 'Installed version, newest release, and the state of an update in progress.' } }, async () => service.selfUpdateStatus());
  app.post('/v1/system/update/check', { preHandler: requireAuth, schema: { description: 'Ask GitHub Releases now whether a newer Harbor exists.' } }, async () => service.selfUpdateCheck());
  app.post('/v1/system/update/apply', { preHandler: requireAuth, schema: { description: 'Update Harbor to the newest release: downloads, verifies, installs in place and restarts the daemon (the console reconnects).' } }, async (req, reply) => reply.status(202).send(await service.selfUpdateApply(req.actor!)));

  // --- sessions
  app.post(
    '/v1/sessions',
    {
      schema: {
        description: 'Log in the local administrator. Rate limited.',
        security: [],
        body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 }, code: { type: 'string', minLength: 6, maxLength: 12 } } },
        response: { 201: { type: 'object', properties: { token: { type: 'string' }, expiresAt: { type: 'string' } }, required: ['token', 'expiresAt'] }, 401: errorBodySchema, 429: errorBodySchema },
      },
    },
    async (req, reply) => {
      const { username, password, code } = req.body as { username: string; password: string; code?: string };
      const result = await sessions.login(username, password, req.ip, code);
      return reply.status(201).send(result);
    },
  );
  app.delete('/v1/sessions/current', { preHandler: requireAuth, schema: { description: 'Revoke the current session.', response: { 204: { type: 'null' } } } }, async (req, reply) => {
    sessions.logout(req.bearer!);
    return reply.status(204).send();
  });

  // --- reads
  app.get('/v1/system', { preHandler: requireAuth, schema: { description: 'Daemon/Docker availability.' } }, async () => service.system());
  app.get('/v1/catalog', { preHandler: requireAuth, schema: { description: 'Bundled packages.' } }, async () => ({ items: service.catalog() }));
  app.get(
    '/v1/catalog/:id/asset/:name',
    // Unauthenticated on purpose: <img src> cannot carry the bearer token, and the assets are static
    // files of the bundled, hash-verified catalog (no instance or host data). Same-origin/Host guards still apply.
    { schema: { description: 'Package presentation asset (icon/gallery) from the bundled package. Open (no session): static catalog content only.', security: [], params: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string', pattern: ID_PATTERN }, name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}\\.(svg|png|jpg|jpeg|webp)$' } } } } },
    async (req, reply) => {
      const { id, name } = req.params as { id: string; name: string };
      const a = service.asset(id, name);
      reply.header('content-type', a.contentType);
      reply.header('cache-control', 'private, max-age=300');
      if (a.contentType === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      return reply.send(a.bytes);
    },
  );
  app.get('/v1/system/metrics', { preHandler: requireAuth, schema: { description: 'Host metrics for the console (cpu, memory, disk, docker).' } }, async () => service.metrics());
  app.get('/v1/system/storage/usage', { preHandler: requireAuth, schema: { description: 'Volume disk usage grouped per app (docker system df, cached 60 s).' } }, async () => service.storageUsage());
  app.get('/v1/instances', { preHandler: requireAuth, schema: { description: 'All instances including retained records.' } }, async () => ({ items: service.instances() }));
  app.get(
    '/v1/instances/:id',
    { preHandler: requireAuth, schema: { description: 'Instance detail with safe events, resource roles and setup guidance.', params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } } },
    async (req) => service.instance((req.params as { id: string }).id),
  );
  app.get('/v1/plans/:id', { preHandler: requireAuth, schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'] } } }, async (req) => service.plan((req.params as { id: string }).id));
  app.get('/v1/operations/:id', { preHandler: requireAuth, schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'] } } }, async (req) => service.operation((req.params as { id: string }).id));
  app.get('/v1/platform-tools', { preHandler: requireAuth, schema: { description: 'Cockpit/Portainer/Tailscale/proxy state and real links.' } }, async () => ({ items: await tools.list() }));
  app.get('/v1/exposures', { preHandler: requireAuth, schema: { description: 'Published addresses (tailnet/public) of all instances.' } }, async () => ({ items: service.exposuresList(), ui: tools.uiExposure() }));

  // --- account
  app.put(
    '/v1/account/password',
    {
      preHandler: requireAuth,
      schema: { description: 'Change the administrator password (current password required); every other session is revoked.', body: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 1024 }, newPassword: { type: 'string', minLength: 1, maxLength: 1024 } } } },
    },
    async (req) => {
      const b = req.body as { currentPassword: string; newPassword: string };
      return sessions.changePassword(req.bearer!, b.currentPassword, b.newPassword);
    },
  );

  // --- two-factor authentication (TOTP)
  app.get('/v1/account/security', { preHandler: requireAuth, schema: { description: 'Whether two-factor login is on.' } }, async () => sessions.security());
  app.post('/v1/account/totp/setup', { preHandler: requireAuth, schema: { description: 'Start two-factor setup: returns a fresh secret (base32) and an otpauth URL for a QR code. Not active until enabled with a live code.' } }, async () => sessions.setupTotp(`Harbor${service.system().deviceName ? ` (${service.system().deviceName})` : ''}`));
  app.post(
    '/v1/account/totp/enable',
    { preHandler: requireAuth, schema: { description: 'Confirm the new authenticator with its current code; two-factor login is on from now.', body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', minLength: 6, maxLength: 12 } } } } },
    async (req, reply) => {
      sessions.enableTotp((req.body as { code: string }).code);
      return reply.status(204).send();
    },
  );
  app.post(
    '/v1/account/totp/disable',
    { preHandler: requireAuth, schema: { description: 'Turn two-factor login off (password required).', body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } } } } },
    async (req, reply) => {
      await sessions.disableTotp((req.body as { password: string }).password);
      return reply.status(204).send();
    },
  );

  // --- device name
  app.put(
    '/v1/system/name',
    { preHandler: requireAuth, schema: { description: 'Name this machine (shown in Settings and on the login page); empty resets to the hostname.', body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: ['string', 'null'], maxLength: 80 } } } } },
    async (req) => service.setDeviceName((req.body as { name: string | null }).name),
  );

  // --- troubleshoot: logs
  app.get(
    '/v1/logs/harbor',
    { preHandler: requireAuth, schema: { description: "Harbor's own recent log lines (systemd journal on a real host).", querystring: { type: 'object', additionalProperties: false, properties: { lines: { type: 'string', pattern: '^([1-9][0-9]|[1-9][0-9]{2}|1[0-9]{3}|2000)$' } } } } },
    async (req) => service.harborLogs(Number((req.query as { lines?: string }).lines ?? 300)),
  );
  app.get(
    '/v1/instances/:id/logs',
    { preHandler: requireAuth, schema: { description: 'Recent container logs of one app.', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } }, querystring: { type: 'object', additionalProperties: false, properties: { lines: { type: 'string', pattern: '^([1-9][0-9]|[1-9][0-9]{2}|1[0-9]{3}|2000)$' } } } } },
    async (req) => service.instanceLogs((req.params as { id: string }).id, Number((req.query as { lines?: string }).lines ?? 300)),
  );

  // --- terminal (WebSocket). Auth by the first message, never by URL. Same-origin/Host guards above apply to the upgrade.
  app.get('/v1/terminal', { websocket: true, schema: { hide: true } }, (socket, req) => {
    let session: TerminalSession | null = null;
    const authTimer = setTimeout(() => {
      if (!session) socket.close(4401, 'no auth');
    }, 10_000);
    const sendJson = (m: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      if (!session) {
        clearTimeout(authTimer);
        try {
          const m = JSON.parse(bytes.toString('utf8')) as TerminalClientMessage;
          if (m.type !== 'auth') throw new HarborError('UNAUTHENTICATED', 'first message must authenticate');
          const who = sessions.authenticate(m.token);
          const s = terminals.start(
            { cols: Number(m.cols) || 80, rows: Number(m.rows) || 24 },
            (chunk) => {
              if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
            },
            (code, reason) => {
              sendJson({ type: 'exit', code, reason });
              setTimeout(() => socket.close(1000, 'shell exited'), 50);
            },
          );
          session = s;
          log.info('terminal session started', { actor: who.actor, ip: req.ip });
          sendJson({ type: 'ready' });
        } catch (e) {
          sendJson({ type: 'error', message: e instanceof HarborError ? `${e.message}. ${e.nextAction}` : 'terminal unavailable' });
          socket.close(4401, 'unauthorized');
        }
        return;
      }
      if (isBinary) {
        session.write(bytes);
        return;
      }
      try {
        const m = JSON.parse(bytes.toString('utf8')) as TerminalClientMessage;
        if (m.type === 'input' && typeof m.data === 'string') session.write(m.data);
        else if (m.type === 'resize') session.resize(Number(m.cols), Number(m.rows));
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      session?.close('connection closed');
    });
    socket.on('error', () => session?.close('connection error'));
  });

  // --- host storage (for the folder picker; read-only except creating one named folder in a writable parent)
  const writable = (p: string) => {
    try {
      accessSync(p, fsConstants.W_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  app.get('/v1/host/storage', { preHandler: requireAuth, schema: { description: 'Disks (mounts), the Harbor data folder and folders in use by apps.' } }, async () => ({
    dataFolder: { path: config.userDataDir, exists: fsExists(config.userDataDir), writable: fsExists(config.userDataDir) && writable(config.userDataDir) },
    mounts: listMounts(),
    inUse: service.foldersInUse(),
  }));
  app.get(
    '/v1/host/folders',
    { preHandler: requireAuth, schema: { description: 'Subfolders of a host folder (system locations hidden).', querystring: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } } },
    async (req) => listFolders((req.query as { path: string }).path),
  );
  app.post(
    '/v1/host/folders',
    { preHandler: requireAuth, schema: { description: 'Create one new folder inside a parent the Harbor service account may write to.', body: { type: 'object', additionalProperties: false, required: ['parent', 'name'], properties: { parent: { type: 'string', minLength: 1, maxLength: 4096 }, name: { type: 'string', minLength: 1, maxLength: 64 } } } } },
    async (req, reply) => {
      const b = req.body as { parent: string; name: string };
      if (b.parent === config.userDataDir && !fsExists(config.userDataDir)) mkdirSync(config.userDataDir, { recursive: true, mode: 0o755 });
      return reply.status(201).send(createFolder(b.parent, b.name));
    },
  );

  // --- public domains (wizard for publishing on the internet)
  app.get('/v1/domains', { preHandler: requireAuth, schema: { description: 'Registered public domains with DNS check results, this machine\'s public address and which app uses each domain.' } }, async () => service.domains());
  app.post(
    '/v1/domains',
    { preHandler: requireAuth, schema: { description: 'Register a domain you own and check that its DNS points at this machine.', body: { type: 'object', additionalProperties: false, required: ['hostname'], properties: { hostname: { type: 'string', minLength: 3, maxLength: 253 } } } } },
    async (req, reply) => reply.status(201).send(await service.addDomain((req.body as { hostname: string }).hostname)),
  );
  app.post(
    '/v1/domains/:hostname/check',
    { preHandler: requireAuth, schema: { description: 'Re-check a registered domain\'s DNS.', params: { type: 'object', required: ['hostname'], properties: { hostname: { type: 'string', pattern: HOSTNAME_RE.source, maxLength: 253 } } } } },
    async (req) => service.checkDomain((req.params as { hostname: string }).hostname),
  );
  app.delete(
    '/v1/domains/:hostname',
    { preHandler: requireAuth, schema: { description: 'Forget a registered domain (refused while an app is published at it).', params: { type: 'object', required: ['hostname'], properties: { hostname: { type: 'string', pattern: HOSTNAME_RE.source, maxLength: 253 } } } } },
    async (req, reply) => {
      service.removeDomain((req.params as { hostname: string }).hostname);
      return reply.status(204).send();
    },
  );

  // --- appearance: wallpaper (uploaded or rotating), launcher order, per-app look
  const OPEN_IMAGE_CSP = "default-src 'none'; sandbox";
  app.get('/v1/appearance', { preHandler: requireAuth, schema: { description: 'Wallpaper state (uploaded/rotating with attribution), rotation settings (no secrets) and the launcher order.' } }, async () => appearance.status());
  app.get('/v1/appearance/wallpaper', { schema: { description: 'The current wallpaper picture (open: background art loaded by <img>/CSS, which cannot send a token).', security: [] } }, async (_req, reply) => {
    const w = appearance.activeWallpaper();
    if (!w) throw new HarborError('NOT_FOUND', 'no wallpaper set');
    reply.header('content-type', w.contentType);
    reply.header('cache-control', 'private, max-age=60');
    reply.header('content-security-policy', OPEN_IMAGE_CSP);
    return reply.send(w.bytes);
  });
  app.put(
    '/v1/appearance/wallpaper',
    {
      preHandler: requireAuth,
      bodyLimit: 8 * 1024 * 1024,
      schema: { description: 'Set your own wallpaper: a PNG, JPEG or WebP picture as a data URL (max 6 MB).', body: { type: 'object', additionalProperties: false, required: ['dataUrl'], properties: { dataUrl: { type: 'string', minLength: 32, maxLength: 8 * 1024 * 1024 } } } },
    },
    async (req, reply) => {
      appearance.setUploaded((req.body as { dataUrl: string }).dataUrl);
      return reply.status(204).send();
    },
  );
  app.delete('/v1/appearance/wallpaper', { preHandler: requireAuth, schema: { description: 'Remove your uploaded wallpaper picture.' } }, async (_req, reply) => {
    appearance.clearUploaded();
    return reply.status(204).send();
  });
  app.put(
    '/v1/appearance/rotation',
    {
      preHandler: requireAuth,
      schema: {
        description: 'Rotating wallpapers: turn on/off, choose the source (reddit needs your own Reddit app credentials; bing and wikimedia need none), subreddits and how often. Fetches the first picture right away when turning on.',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            source: { enum: ['reddit', 'bing', 'wikimedia'] },
            subreddits: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 32 } },
            everyHours: { type: 'integer', minimum: 1, maximum: 720 },
            reddit: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['clientId'], properties: { clientId: { type: 'string', minLength: 1, maxLength: 128 }, clientSecret: { type: 'string', minLength: 1, maxLength: 256 } } }] },
          },
        },
      },
    },
    async (req) => appearance.updateRotation(req.body as Parameters<AppearanceService['updateRotation']>[0]),
  );
  app.post('/v1/appearance/rotation/next', { preHandler: requireAuth, schema: { description: 'Skip to the next rotating wallpaper now.' } }, async () => appearance.next());
  app.put(
    '/v1/appearance/home',
    { preHandler: requireAuth, schema: { description: 'Launcher order (instance ids, first to last). Unknown ids are dropped; missing ones keep their default position.', body: { type: 'object', additionalProperties: false, required: ['order'], properties: { order: { type: 'array', maxItems: 500, items: { type: 'string', pattern: UUID_PATTERN } } } } } },
    async (req) => appearance.setHomeOrder((req.body as { order: string[] }).order),
  );
  app.put(
    '/v1/instances/:id/appearance',
    {
      preHandler: requireAuth,
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        description: 'Customise how an app appears on the launcher: display name and icon (default, an emoji/letters on a colour, or an uploaded picture up to 1 MB).',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            displayName: { type: ['string', 'null'], maxLength: 80 },
            icon: {
              oneOf: [
                { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'default' } } },
                { type: 'object', additionalProperties: false, required: ['kind', 'glyph', 'color'], properties: { kind: { const: 'glyph' }, glyph: { type: 'string', minLength: 1, maxLength: 16 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } } },
                { type: 'object', additionalProperties: false, required: ['kind', 'dataUrl'], properties: { kind: { const: 'image' }, dataUrl: { type: 'string', minLength: 32, maxLength: 1500 * 1024 } } },
              ],
            },
          },
        },
      },
    },
    async (req) => {
      const id = (req.params as { id: string }).id;
      appearance.setInstanceAppearance(id, req.body as Parameters<AppearanceService['setInstanceAppearance']>[1]);
      return service.instances().find((i) => i.id === id);
    },
  );
  app.get('/v1/instances/:id/icon', { schema: { description: 'Custom launcher icon picture of an app (open: loaded by <img>).', security: [], params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } } }, async (req, reply) => {
    const icon = appearance.instanceIcon((req.params as { id: string }).id);
    if (!icon) throw new HarborError('NOT_FOUND', 'no custom icon');
    reply.header('content-type', icon.contentType);
    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-security-policy', OPEN_IMAGE_CSP);
    return reply.send(icon.bytes);
  });

  // --- your own apps: uploaded packages (zip with manifest.yaml, compose.yaml, README.md, icon…)
  app.post(
    '/v1/packages',
    {
      preHandler: requireAuth,
      bodyLimit: 72 * 1024 * 1024,
      schema: {
        description: 'Upload a package zip. Harbor validates it like a bundled package, pins tag images by digest at the registry and writes release.json. A higher revision of an already uploaded id becomes an update for its instances.',
        body: { type: 'object', additionalProperties: false, required: ['fileName', 'dataUrl'], properties: { fileName: { type: 'string', minLength: 1, maxLength: 200 }, dataUrl: { type: 'string', minLength: 32, maxLength: 70 * 1024 * 1024 } } },
      },
    },
    async (req, reply) => {
      const b = req.body as { fileName: string; dataUrl: string };
      const m = /^data:(?:application\/(?:zip|x-zip-compressed|octet-stream));base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
      if (!m) throw new HarborError('INVALID_REQUEST', 'send the zip as a data URL (application/zip, base64)');
      const bytes = Buffer.from(m[1]!, 'base64');
      if (bytes.length > 50 * 1024 * 1024) throw new HarborError('INVALID_REQUEST', 'the package zip must be 50 MB or smaller');
      return reply.status(201).send(await service.importPackage(bytes, b.fileName, req.actor!));
    },
  );
  app.delete(
    '/v1/packages/:id',
    { preHandler: requireAuth, schema: { description: 'Remove an uploaded package (refused while an app installed from it exists).', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: ID_PATTERN } } } } },
    async (req, reply) => {
      service.removePackage((req.params as { id: string }).id);
      return reply.status(204).send();
    },
  );

  // --- the machine: facts for the Settings overview, restart / shut down
  app.get('/v1/system/host', { preHandler: requireAuth, schema: { description: 'Hostname, OS, CPU and whether Harbor may restart or shut down this machine.' } }, async () => {
    const p = await power.available();
    return { ...hostFacts(), power: { available: p.ok, note: p.note } };
  });
  app.post(
    '/v1/system/power',
    { preHandler: requireAuth, schema: { description: 'Restart or shut down the machine (apps come back on their own after a restart).', body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['reboot', 'poweroff'] } } } } },
    async (req, reply) => {
      const { action } = req.body as { action: 'reboot' | 'poweroff' };
      log.warn(`${action} requested from the console by ${req.actor}`);
      if (action === 'reboot') await power.reboot();
      else await power.powerOff();
      return reply.status(202).send({ action, accepted: true });
    },
  );

  // --- remote access (Tailscale) from the console
  app.post(
    '/v1/platform-tools/tailscale/login',
    { preHandler: requireAuth, schema: { description: 'Log this host into a tailnet: with an auth key, or get a login URL to approve in a browser.', body: { type: 'object', additionalProperties: false, properties: { authKey: { type: 'string', minLength: 8, maxLength: 512 } } } } },
    async (req) => {
      const b = (req.body ?? {}) as { authKey?: string };
      const r = await tools.tailscaleLogin(b.authKey ?? null, path.join(config.stateDir, 'tailscale-authkey.tmp'));
      return { loginUrl: r.loginUrl, status: r.loginUrl ? 'login_url' : 'logged_in' };
    },
  );
  app.post('/v1/platform-tools/tailscale/logout', { preHandler: requireAuth, schema: { description: 'Log this host out of the tailnet (withdraws tailnet addresses).' } }, async (_req, reply) => {
    await tools.tailscaleLogout();
    return reply.status(204).send();
  });
  app.put(
    '/v1/ui-exposure',
    { preHandler: requireAuth, schema: { description: 'Expose the Harbor UI on the tailnet (never publicly).', body: { type: 'object', additionalProperties: false, required: ['via'], properties: { via: { const: 'tailnet' } } } } },
    async (req, reply) => reply.status(201).send(await tools.exposeUi(config.listen.port)),
  );
  app.delete('/v1/ui-exposure', { preHandler: requireAuth, schema: { description: 'Withdraw the tailnet exposure of the Harbor UI.' } }, async (_req, reply) => {
    await tools.unexposeUi(config.listen.port);
    return reply.status(204).send();
  });
  app.put(
    '/v1/platform-tools/:id',
    {
      preHandler: requireAuth,
      schema: {
        description: 'Bind an already installed tool by its loopback URL without taking ownership.',
        params: { type: 'object', properties: { id: { enum: ['cockpit', 'portainer'] } }, required: ['id'] },
        body: { type: 'object', additionalProperties: false, required: ['browserUrl'], properties: { browserUrl: { type: 'string', minLength: 8, maxLength: 256 } } },
      },
    },
    async (req) => {
      tools.bind((req.params as { id: string }).id, (req.body as { browserUrl: string }).browserUrl);
      return { items: await tools.list() };
    },
  );
  app.delete(
    '/v1/platform-tools/:id',
    { preHandler: requireAuth, schema: { description: 'Remove an external tool binding.', params: { type: 'object', properties: { id: { enum: ['cockpit', 'portainer'] } }, required: ['id'] } } },
    async (req, reply) => {
      tools.unbind((req.params as { id: string }).id);
      return reply.status(204).send();
    },
  );

  // --- plans & operations
  app.post(
    '/v1/plans',
    {
      preHandler: requireAuth,
      schema: {
        description: 'Create an immutable plan. Install: {kind, packageId, name?}. Others: {kind, instanceId}.',
        body: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'packageId'],
              properties: {
                kind: { const: 'install' },
                packageId: { type: 'string', pattern: ID_PATTERN },
                name: { type: 'string', pattern: ID_PATTERN },
                // storage claim id -> host directory ("bring your own folder"); only claims the manifest marks `external`
                storage: { type: 'object', maxProperties: 16, propertyNames: { pattern: ID_PATTERN }, additionalProperties: { type: 'object', additionalProperties: false, required: ['hostPath'], properties: { hostPath: { type: 'string', minLength: 1, maxLength: 4096 } } } },
              },
            },
            { type: 'object', additionalProperties: false, required: ['kind', 'instanceId'], properties: { kind: { enum: ['start', 'stop', 'remove', 'reinstall', 'purge'] }, instanceId: { type: 'string', pattern: UUID_PATTERN } } },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'instanceId'],
              properties: {
                kind: { const: 'update' },
                instanceId: { type: 'string', pattern: UUID_PATTERN },
                // folders for storage claims the new release adds (same shape as install)
                storage: { type: 'object', maxProperties: 16, propertyNames: { pattern: ID_PATTERN }, additionalProperties: { type: 'object', additionalProperties: false, required: ['hostPath'], properties: { hostPath: { type: 'string', minLength: 1, maxLength: 4096 } } } },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'instanceId', 'via'],
              properties: {
                kind: { const: 'expose' },
                instanceId: { type: 'string', pattern: UUID_PATTERN },
                endpointId: { type: 'string', pattern: ID_PATTERN },
                via: { enum: ['tailnet', 'public'] },
                hostname: { type: 'string', pattern: HOSTNAME_RE.source, maxLength: 253 },
                protection: { enum: ['none', 'basic'] },
                makePrimary: { type: 'boolean' },
              },
            },
            { type: 'object', additionalProperties: false, required: ['kind', 'instanceId', 'via'], properties: { kind: { const: 'unexpose' }, instanceId: { type: 'string', pattern: UUID_PATTERN }, endpointId: { type: 'string', pattern: ID_PATTERN }, via: { enum: ['tailnet', 'public'] } } },
            { type: 'object', additionalProperties: false, required: ['kind', 'instanceId', 'primary'], properties: { kind: { const: 'reconfigure' }, instanceId: { type: 'string', pattern: UUID_PATTERN }, primary: { enum: ['loopback', 'tailnet', 'public'] } } },
          ],
        },
        response: { 201: { type: 'object', additionalProperties: true } },
      },
    },
    async (req, reply) => {
      const plan = await service.createPlan(req.body as Parameters<ApplicationService['createPlan']>[0], req.actor!);
      return reply.status(201).send(plan);
    },
  );
  app.post(
    '/v1/operations',
    {
      preHandler: requireAuth,
      schema: {
        description: 'Submit an exact plan ID. Requires Idempotency-Key. Returns 202 with the (possibly existing) operation.',
        headers: { type: 'object', properties: { 'idempotency-key': { type: 'string', pattern: IDEMPOTENCY_KEY_RE.source } }, required: ['idempotency-key'] },
        body: { type: 'object', additionalProperties: false, required: ['planId'], properties: { planId: { type: 'string', pattern: UUID_PATTERN } } },
      },
    },
    async (req, reply) => {
      const key = req.headers['idempotency-key'] as string;
      const { planId } = req.body as { planId: string };
      const result = service.submit(planId, key, req.actor!);
      return reply.status(202).send({ operationId: result.operation.id, created: result.created, operation: service.operation(result.operation.id) });
    },
  );

  // --- static UI
  if (config.uiDir && existsSync(path.join(config.uiDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.uiDir,
      wildcard: false,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (reply) => {
        reply.header('content-security-policy', UI_CSP);
      },
    });
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1/') && (req.headers.accept ?? '').includes('text/html')) {
        return reply.header('content-security-policy', UI_CSP).sendFile('index.html');
      }
      return reply.status(404).send(new HarborError('NOT_FOUND', `no route ${req.method} ${req.url}`).toBody());
    });
  } else {
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => reply.status(404).send(new HarborError('NOT_FOUND', `no route ${req.method} ${req.url}`).toBody()));
  }

  return app;
}
