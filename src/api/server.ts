import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifySwagger from '@fastify/swagger';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DaemonConfig } from '../config.js';
import { managementOrigin } from '../config.js';
import { HarborError } from '../errors.js';
import type { SessionService } from '../auth/sessions.js';
import type { ApplicationService } from '../lifecycle/service.js';
import type { Logger } from '../lifecycle/context.js';
import type { PlatformToolsService } from '../tools/service.js';
import { ID_PATTERN, UUID_PATTERN } from '../contracts/patterns.js';
import { PRODUCT } from '../naming.js';

export interface ApiDeps {
  config: DaemonConfig;
  service: ApplicationService;
  sessions: SessionService;
  tools: PlatformToolsService;
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
const UI_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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
  const { config, service, sessions, tools, log } = deps;
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

  // --- request guards
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host)) {
      throw new HarborError('FORBIDDEN_ORIGIN', `Host ${host || '(missing)'} is not the configured management address`, { nextAction: `Use ${origin}.` });
    }
    const reqOrigin = req.headers.origin;
    if (reqOrigin !== undefined && !allowedOrigins.has(reqOrigin)) {
      throw new HarborError('FORBIDDEN_ORIGIN', `Origin ${reqOrigin} is not allowed`);
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

  // --- sessions
  app.post(
    '/v1/sessions',
    {
      schema: {
        description: 'Log in the local administrator. Rate limited.',
        security: [],
        body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 } } },
        response: { 201: { type: 'object', properties: { token: { type: 'string' }, expiresAt: { type: 'string' } }, required: ['token', 'expiresAt'] }, 401: errorBodySchema, 429: errorBodySchema },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body as { username: string; password: string };
      const result = await sessions.login(username, password, req.ip);
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
  app.get('/v1/instances', { preHandler: requireAuth, schema: { description: 'All instances including retained records.' } }, async () => ({ items: service.instances() }));
  app.get(
    '/v1/instances/:id',
    { preHandler: requireAuth, schema: { description: 'Instance detail with safe events, resource roles and setup guidance.', params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] } } },
    async (req) => service.instance((req.params as { id: string }).id),
  );
  app.get('/v1/plans/:id', { preHandler: requireAuth, schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'] } } }, async (req) => service.plan((req.params as { id: string }).id));
  app.get('/v1/operations/:id', { preHandler: requireAuth, schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'] } } }, async (req) => service.operation((req.params as { id: string }).id));
  app.get('/v1/platform-tools', { preHandler: requireAuth, schema: { description: 'Cockpit/Portainer state and real links.' } }, async () => ({ items: await tools.list() }));
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
            { type: 'object', additionalProperties: false, required: ['kind', 'packageId'], properties: { kind: { const: 'install' }, packageId: { type: 'string', pattern: ID_PATTERN }, name: { type: 'string', pattern: ID_PATTERN } } },
            { type: 'object', additionalProperties: false, required: ['kind', 'instanceId'], properties: { kind: { enum: ['start', 'stop', 'remove', 'reinstall'] }, instanceId: { type: 'string', pattern: UUID_PATTERN } } },
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
