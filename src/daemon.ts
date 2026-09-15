import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApi } from './api/server.js';
import { SessionService } from './auth/sessions.js';
import { loadConfig, type DaemonConfig } from './config.js';
import type { ComposeRunner, DockerAdapter } from './docker/adapter.js';
import { ComposeCli } from './docker/compose-cli.js';
import { DockerodeAdapter } from './docker/dockerode-adapter.js';
import { FakeDocker } from './docker/fake.js';
import { realPortObserver, type PortObserver } from './docker/ports.js';
import { HarborError } from './errors.js';
import { jsonLogger, type Ctx, type Logger } from './lifecycle/context.js';
import { Observer } from './lifecycle/observer.js';
import { OperationRunner } from './lifecycle/runner.js';
import { ApplicationService } from './lifecycle/service.js';
import { acquireLock, type ProcessLock } from './state/lock.js';
import { openState } from './state/db.js';
import { Repo } from './state/repo.js';
import { PlatformToolsService } from './tools/service.js';
import { systemClock, systemIds, type Clock, type Ids } from './util.js';
import { FakeTailscale, TailscaleCli, type TailscaleProvider } from './exposure/tailscale.js';
import { FakeNet, RealNet, type NetProvider } from './system/net.js';
import { CaddyAdminClient, FakeCaddyAdmin, type CaddyAdmin } from './exposure/caddy.js';
import { FakeVerifier, httpsVerifier } from './exposure/verify.js';
import type { UrlVerifier } from './lifecycle/context.js';
import { AppearanceService } from './appearance/service.js';
import { FakeFetcher, RealFetcher, json as fakeJson, type Fetcher } from './appearance/fetcher.js';
import { FakePower, SystemdPower, type PowerControl } from './system/power.js';
import { PackageStore } from './packages/store.js';
import { FakeRegistry, RegistryResolver, type ImageResolver } from './packages/registry.js';

export function productVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export interface DaemonOverrides {
  docker?: DockerAdapter;
  compose?: ComposeRunner;
  ports?: PortObserver;
  clock?: Clock;
  ids?: Ids;
  log?: Logger;
  observerIntervalMs?: number;
  toolsProbe?: ConstructorParameters<typeof PlatformToolsService>[2];
  tailscale?: TailscaleProvider;
  caddy?: CaddyAdmin;
  verify?: UrlVerifier;
  net?: NetProvider;
  fetcher?: Fetcher;
  power?: PowerControl;
  registry?: ImageResolver;
}

export interface Daemon {
  app: FastifyInstance;
  ctx: Ctx;
  service: ApplicationService;
  runner: OperationRunner;
  observer: Observer;
  sessions: SessionService;
  tools: PlatformToolsService;
  appearance: AppearanceService;
  url: string;
  close(): Promise<void>;
}

export function findDockerBinary(): string | null {
  for (const p of ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker']) if (existsSync(p)) return p;
  return null;
}

export async function startDaemon(config: DaemonConfig, overrides: DaemonOverrides = {}): Promise<Daemon> {
  const log = overrides.log ?? jsonLogger(config.logLevel);
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? systemIds;
  let lock: ProcessLock | null = null;
  lock = acquireLock(config.stateDir, 'daemon');
  try {
    const db = openState(config.stateDir);
    const repo = new Repo(db, clock);
    const installation = repo.installation();

    let docker: DockerAdapter;
    let compose: ComposeRunner;
    let ownedFake: FakeDocker | null = null;
    if (overrides.docker && overrides.compose) {
      docker = overrides.docker;
      compose = overrides.compose;
    } else if (config.docker.mode === 'fake') {
      const fake = new FakeDocker(clock);
      ownedFake = fake;
      docker = overrides.docker ?? fake;
      compose = overrides.compose ?? fake;
    } else {
      const bin = findDockerBinary();
      if (!bin) throw new HarborError('DOCKER_UNAVAILABLE', 'docker CLI not found in /usr/bin, /usr/local/bin or /opt/homebrew/bin');
      docker = overrides.docker ?? new DockerodeAdapter(config.docker.socketPath);
      compose = overrides.compose ?? new ComposeCli({ dockerBinary: bin, socketPath: config.docker.socketPath, configDir: path.join(config.stateDir, 'docker-config'), pluginDirs: config.docker.cliPluginDirs });
    }

    // Exposure providers: real host CLIs/APIs in socket mode, in-memory fakes in fake mode (tests, pnpm dev).
    const fakeMode = config.docker.mode === 'fake';
    const tailscale = overrides.tailscale ?? (fakeMode ? new FakeTailscale() : new TailscaleCli());
    const caddy = overrides.caddy ?? (fakeMode ? new FakeCaddyAdmin() : new CaddyAdminClient());
    const verify = overrides.verify ?? (fakeMode ? new FakeVerifier().fn : httpsVerifier);
    const net = overrides.net ?? (fakeMode ? new FakeNet() : new RealNet());
    const registry = overrides.registry ?? (fakeMode ? demoRegistry() : new RegistryResolver());
    const packages = new PackageStore(config.catalogDir, config.localPackagesDir, registry, clock);
    const ctx: Ctx = { config, repo, docker, compose, ports: overrides.ports ?? realPortObserver, clock, ids, log, installationId: installation.id, version: productVersion(), tailscale, caddy, verify, net, packages };
    const service = new ApplicationService(ctx);
    const runner = new OperationRunner(ctx);
    const sessions = new SessionService(repo, clock, ids, config.sessionTtlSeconds);
    const tools = new PlatformToolsService(repo, clock, overrides.toolsProbe, { tailscale, caddy });
    const observer = new Observer(ctx, service, overrides.observerIntervalMs ?? 10_000);
    const fetcher = overrides.fetcher ?? (fakeMode ? demoFetcher() : new RealFetcher());
    const power = overrides.power ?? (fakeMode ? new FakePower() : new SystemdPower());
    const appearance = new AppearanceService(repo, config.stateDir, fetcher, clock, log);
    service.onSubmit(() => runner.wake());

    const recovered = runner.recoverOnStartup();
    if (recovered) log.warn(`marked ${recovered} interrupted operation(s) needs_action`);
    repo.purgeExpiredSessions();

    const app = await buildApi({ config, service, sessions, tools, appearance, power, log, version: ctx.version });
    await app.listen({ host: config.listen.host, port: config.listen.port });
    observer.start();
    appearance.start();
    const url = `http://localhost:${config.listen.port}`;
    log.info(`daemon listening`, { url, stateDir: config.stateDir, docker: docker.description, installationId: installation.id });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      observer.stop();
      appearance.stop();
      const graceful = runner.shutdown();
      await Promise.race([graceful, new Promise((r) => setTimeout(r, 20_000))]);
      await app.close();
      if (ownedFake) await ownedFake.shutdown();
      db.close();
      lock?.release();
      log.info('daemon stopped');
    };
    return { app, ctx, service, runner, observer, sessions, tools, appearance, url, close };
  } catch (e) {
    lock?.release();
    throw e;
  }
}

// Fake mode (`pnpm dev`, e2e): a wallpaper "internet" with Bing's shape and a generated picture, so the
// rotation can be exercised end to end without leaving the machine.
export function demoFetcher(): FakeFetcher {
  const f = new FakeFetcher();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const days = ['Fort Union National Monument, New Mexico (© zrfphoto/Getty Images)', 'Aurora over Lofoten, Norway (© Demo Photographer)', 'Dunes at dusk, Namibia (© Demo Photographer)'];
  f.on('https://www.bing.com/HPImageArchive.aspx', fakeJson({ images: days.map((c, i) => ({ urlbase: `/th?id=OHR.Demo${i}`, copyright: c, copyrightlink: 'https://www.bing.com/' })) }));
  f.on('https://www.bing.com/th?id=', { status: 200, contentType: 'image/png', body: png });
  f.on('https://api.wikimedia.org/feed/v1/wikipedia/en/featured/', fakeJson({ image: { title: 'File:Demo.jpg', image: { source: 'https://upload.wikimedia.org/wikipedia/commons/d/d0/Demo.jpg', width: 2400, height: 1600 }, artist: { text: 'Demo Artist' }, file_page: 'https://commons.wikimedia.org/wiki/File:Demo.jpg', description: { text: 'A demo picture of the day' } } }));
  f.on('https://upload.wikimedia.org/', { status: 200, contentType: 'image/png', body: png });
  f.on('https://www.reddit.com/api/v1/access_token', (_u, o) => (/^Basic /.test(o.headers?.['authorization'] ?? '') && !/Basic YmFkOmJhZA==/.test(o.headers?.['authorization'] ?? '') ? fakeJson({ access_token: 'demo-token', token_type: 'bearer', expires_in: 86400 }) : fakeJson({ error: 401 }, 401)));
  f.on('https://oauth.reddit.com/r/', (u) => {
    const sub = /\/r\/([^/]+)\//.exec(u)?.[1] ?? 'EarthPorn';
    return fakeJson({ data: { children: [{ data: { title: `Sunrise over the fjord [OC] (${sub})`, author: 'demo_user', url: 'https://i.redd.it/demo1.jpg', permalink: `/r/${sub}/comments/demo1/sunrise/`, over_18: false, preview: { images: [{ source: { url: 'https://preview.redd.it/demo1.jpg?auto=webp', width: 3000, height: 2000 } }] } } }, { data: { title: 'Vertical phone shot', author: 'tall', url: 'https://i.redd.it/tall.jpg', permalink: '/r/x/comments/tall/', over_18: false, preview: { images: [{ source: { url: 'https://preview.redd.it/tall.jpg', width: 1080, height: 2340 } }] } } }, { data: { title: 'nsfw', author: 'no', url: 'https://i.redd.it/nsfw.jpg', over_18: true } }] } });
  });
  f.on('https://i.redd.it/', { status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]) });
  return f;
}

// Fake mode: a registry that knows a few demo tags so uploaded packages can be pinned without the internet.
export function demoRegistry(): FakeRegistry {
  const r = new FakeRegistry();
  r.add('nginx:1.27-alpine', 'sha256:' + '1'.repeat(64), { created: '2026-05-01T00:00:00Z' });
  r.add('nginx:1.28-alpine', 'sha256:' + '2'.repeat(64), { created: '2026-08-01T00:00:00Z' });
  r.add('nginx:alpine', 'sha256:' + '3'.repeat(64));
  r.add('hello/hello:1.0.0', 'sha256:' + '4'.repeat(64));
  r.add('hello/hello:1.1.0', 'sha256:' + '5'.repeat(64));
  r.add('excalidraw/excalidraw:latest', 'sha256:f7ee194addd607bf831d2af0f0a34463dd4225e426cf35199ef0b12a803398e9');
  return r;
}

// `node dist/daemon.js --config /etc/harbor/harbor.json`
async function main(): Promise<void> {
  const idx = process.argv.indexOf('--config');
  const file = idx >= 0 ? process.argv[idx + 1] : process.env['HARBOR_CONFIG'];
  if (!file) {
    console.error('usage: harbor-daemon --config <file>');
    process.exit(2);
  }
  const config = loadConfig(file);
  const daemon = await startDaemon(config);
  const stop = (signal: string) => {
    daemon.ctx.log.info(`received ${signal}, shutting down`);
    void daemon.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && /daemon\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof HarborError ? `${e.code}: ${e.message}\n${e.nextAction}` : e);
    process.exit(e instanceof HarborError ? e.exitCode : 1);
  });
}
