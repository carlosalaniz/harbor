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
import { jsonLogger, LOG_ORDER, type Ctx, type Logger, type LogLevel } from './lifecycle/context.js';
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
import { LogBuffer } from './system/logs.js';
import { TerminalService } from './system/terminal.js';
import { FakeReleaseFeed, FakeUnitStarter, GitHubReleaseFeed, SelfUpdateService, SystemctlStarter, type ReleaseFeed, type UnitStarter } from './system/selfupdate.js';
import { SetupService } from './auth/setup.js';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { hostname } from 'node:os';
import { FakeRegistry, RegistryResolver, type ImageResolver } from './packages/registry.js';
import { FakeTransport, Notifier, realTransport, type NotifyTransport } from './notify/notifier.js';
import { FakeGit, GitCli, type GitFetcher } from './packages/git.js';
import { MachineKeyHolder } from './auth/machine-holder.js';

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
  sourceCheckMs?: number;
  toolsProbe?: ConstructorParameters<typeof PlatformToolsService>[2];
  toolsInstallStarter?: ConstructorParameters<typeof PlatformToolsService>[5];
  tailscale?: TailscaleProvider;
  caddy?: CaddyAdmin;
  verify?: UrlVerifier;
  net?: NetProvider;
  fetcher?: Fetcher;
  power?: PowerControl;
  registry?: ImageResolver;
  releaseFeed?: ReleaseFeed;
  unitStarter?: UnitStarter;
  notifyTransport?: NotifyTransport;
  git?: GitFetcher;
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
  selfUpdate: SelfUpdateService;
  url: string;
  close(): Promise<void>;
}

export function findDockerBinary(): string | null {
  for (const p of ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker']) if (existsSync(p)) return p;
  return null;
}

export async function startDaemon(config: DaemonConfig, overrides: DaemonOverrides = {}): Promise<Daemon> {
  // stderr honours the configured level; the Troubleshoot buffer always keeps info and above
  const logBuffer = new LogBuffer();
  const bufferLevel: LogLevel = LOG_ORDER[config.logLevel] > LOG_ORDER.info ? 'info' : config.logLevel;
  const log = overrides.log ?? jsonLogger(bufferLevel, (line, lvl) => {
    if (LOG_ORDER[lvl] >= LOG_ORDER[config.logLevel]) process.stderr.write(line + '\n');
    logBuffer.push(line);
  });
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
    const fetcher = overrides.fetcher ?? (fakeMode ? demoFetcher() : new RealFetcher());
    const version = productVersion();
    const feed = overrides.releaseFeed ?? (fakeMode ? demoReleaseFeed(version) : config.updates.repo ? new GitHubReleaseFeed(fetcher, config.updates.repo) : null);
    const unitStarter = overrides.unitStarter ?? (fakeMode ? new FakeUnitStarter() : new SystemctlStarter());
    const selfUpdate = new SelfUpdateService(version, feed, unitStarter, config.stateDir, clock, log);
    const notifyTransport = overrides.notifyTransport ?? (fakeMode ? new FakeTransport() : realTransport());
    const notifier = new Notifier(repo, ids, log, notifyTransport, () => repo.setting<string>('device.name') ?? hostname());
    const git = overrides.git ?? (fakeMode ? new FakeGit() : new GitCli());
    const machineKey = new MachineKeyHolder(log);
    // The service needs the ctx and the ctx needs the service (runner secret
    // handoff): build the ctx first with a placeholder, then link both ways.
    const ctx: Ctx = { config, repo, docker, compose, ports: overrides.ports ?? realPortObserver, clock, ids, log, installationId: installation.id, version, tailscale, caddy, verify, net, packages, logBuffer, selfUpdate, notifier, git, machineKey, service: null as unknown as ApplicationService };
    const service = new ApplicationService(ctx);
    ctx.service = service;
    const runner = new OperationRunner(ctx);
    const sessions = new SessionService(repo, clock, ids, config.sessionTtlSeconds, machineKey);
    // One-click tool installs: the harbor user may start harbor-tools-install@<id>.service
    // (polkit rule from bootstrap); in fake mode there is no systemd, so the endpoint refuses
    // with the exact root command instead.
    const tools = new PlatformToolsService(
      repo,
      clock,
      overrides.toolsProbe,
      { tailscale, caddy },
      config.stateDir,
      overrides.toolsInstallStarter ?? (fakeMode ? null : async (unit: string) => {
        const { spawn } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          const child = spawn('/usr/bin/systemctl', ['start', '--no-block', unit], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let err = '';
          child.stderr.on('data', (d: Buffer) => (err += d.toString()));
          child.on('error', reject);
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `systemctl exited ${code}`))));
        });
      }),
    );
    const observer = new Observer(ctx, service, overrides.observerIntervalMs ?? 10_000, overrides.sourceCheckMs ?? 15 * 60_000);
    const power = overrides.power ?? (fakeMode ? new FakePower() : new SystemdPower());
    const { DeviceMountService } = await import('./system/device-mount.js');
    const startUnit = async (unit: string) => {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/systemctl', ['start', '--no-block', unit], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `systemctl exited ${code}`))));
      });
    };
    const devices = new DeviceMountService(repo, clock, config.stateDir, fakeMode ? null : startUnit);
    ctx.devices = devices;
    const appearance = new AppearanceService(repo, config.stateDir, fetcher, clock, log);
    // the console's terminal: the harbor service account's shell on a real host; the developer's shell in fake mode
    const terminals = new TerminalService(log, fakeMode ? { shell: [process.env['SHELL'] ?? '/bin/bash', '-il'], env: { HOME: process.env['HOME'] ?? config.stateDir, USER: process.env['USER'] ?? 'harbor' }, cwd: config.stateDir } : { shell: ['/bin/bash', '-il'], env: { HOME: config.stateDir, USER: 'harbor', LOGNAME: 'harbor' }, cwd: config.stateDir });
    service.onSubmit(() => runner.wake());

    const recovered = runner.recoverOnStartup();
    if (recovered) log.warn(`marked ${recovered} interrupted operation(s) needs_action`);
    repo.purgeExpiredSessions();

    const setup = new SetupService(repo, sessions, config.stateDir);
    const tailscaleFacts = async () => {
      try {
        const installed = await tailscale.installed();
        const st = installed ? await tailscale.status() : null;
        return { installed, loggedIn: Boolean(st && st.backendState === 'Running' && st.dnsName) };
      } catch {
        return { installed: false, loggedIn: false };
      }
    };
    const app = await buildApi({ config, service, sessions, tools, devices, appearance, power, terminals, setup, tailscaleFacts, log, version: ctx.version });
    await app.listen({ host: config.listen.host, port: config.listen.port });
    // LAN mode: a second listener on every interface hands requests (and WebSocket upgrades) to the same routes.
    let lanServer: HttpServer | null = null;
    if (config.lan.enabled) {
      lanServer = createHttpServer((req, res) => app.routing(req, res));
      lanServer.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
      await new Promise<void>((resolve, reject) => {
        lanServer!.once('error', reject);
        lanServer!.listen({ host: '::', port: config.lan.port }, () => resolve());
      }).catch((e: Error) => {
        // Caddy owns port 80 when the public proxy is installed: it proxies the console for LAN names instead (observer)
        if (/EADDRINUSE/.test(e.message)) log.info(`port ${config.lan.port} is taken (Caddy): the LAN console is served through the proxy`);
        else log.error(`LAN listener on port ${config.lan.port} failed: ${e.message}; the console stays reachable on 127.0.0.1:${config.listen.port}`);
        lanServer = null;
      });
      if (lanServer) log.info('LAN listener up', { port: config.lan.port });
    }
    observer.start();
    appearance.start();
    selfUpdate.start();
    const url = `http://localhost:${config.listen.port}`;
    log.info(`daemon listening`, { url, stateDir: config.stateDir, docker: docker.description, installationId: installation.id });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      machineKey.clear(); // AFU -> BFU: the unsealed key never outlives the process
      observer.stop();
      appearance.stop();
      selfUpdate.stop();
      terminals.closeAll();
      if (lanServer) await new Promise<void>((r) => lanServer!.close(() => r()));
      const graceful = runner.shutdown();
      await Promise.race([graceful, new Promise((r) => setTimeout(r, 20_000))]);
      await app.close();
      if (ownedFake) await ownedFake.shutdown();
      db.close();
      lock?.release();
      log.info('daemon stopped');
    };
    return { app, ctx, service, runner, observer, sessions, tools, appearance, selfUpdate, url, close };
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
  const days = ['Fort Union National Monument, New Mexico (© Demo Photographer/Getty Images)', 'Aurora over Lofoten, Norway (© Demo Photographer)', 'Dunes at dusk, Namibia (© Demo Photographer)'];
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

// Fake mode: "a newer Harbor exists" so the update flow can be exercised without GitHub.
export function demoReleaseFeed(current: string): FakeReleaseFeed {
  const f = new FakeReleaseFeed();
  const [a, b, c] = current.split('.').map(Number);
  const next = `${a}.${b}.${(c ?? 0) + 1}`;
  f.info = { version: next, tag: `v${next}`, publishedAt: '2026-09-15T12:00:00Z', notes: 'Demo release: what a newer Harbor would say here.', url: `https://github.com/carlosalaniz/harbor/releases/tag/v${next}`, archiveUrl: `https://github.com/carlosalaniz/harbor/releases/download/v${next}/harbor-${next}-linux-x64.tar.gz`, sumsUrl: `https://github.com/carlosalaniz/harbor/releases/download/v${next}/SHA256SUMS` };
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
