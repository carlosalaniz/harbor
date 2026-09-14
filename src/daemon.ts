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
}

export interface Daemon {
  app: FastifyInstance;
  ctx: Ctx;
  service: ApplicationService;
  runner: OperationRunner;
  observer: Observer;
  sessions: SessionService;
  tools: PlatformToolsService;
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
    if (overrides.docker && overrides.compose) {
      docker = overrides.docker;
      compose = overrides.compose;
    } else if (config.docker.mode === 'fake') {
      const fake = new FakeDocker(clock);
      docker = overrides.docker ?? fake;
      compose = overrides.compose ?? fake;
    } else {
      const bin = findDockerBinary();
      if (!bin) throw new HarborError('DOCKER_UNAVAILABLE', 'docker CLI not found in /usr/bin, /usr/local/bin or /opt/homebrew/bin');
      docker = overrides.docker ?? new DockerodeAdapter(config.docker.socketPath);
      compose = overrides.compose ?? new ComposeCli({ dockerBinary: bin, socketPath: config.docker.socketPath, configDir: path.join(config.stateDir, 'docker-config') });
    }

    const ctx: Ctx = { config, repo, docker, compose, ports: overrides.ports ?? realPortObserver, clock, ids, log, installationId: installation.id, version: productVersion() };
    const service = new ApplicationService(ctx);
    const runner = new OperationRunner(ctx);
    const sessions = new SessionService(repo, clock, ids, config.sessionTtlSeconds);
    const tools = new PlatformToolsService(repo, clock, overrides.toolsProbe);
    const observer = new Observer(ctx, service, overrides.observerIntervalMs ?? 10_000);
    service.onSubmit(() => runner.wake());

    const recovered = runner.recoverOnStartup();
    if (recovered) log.warn(`marked ${recovered} interrupted operation(s) needs_action`);
    repo.purgeExpiredSessions();

    const app = await buildApi({ config, service, sessions, tools, log, version: ctx.version });
    await app.listen({ host: config.listen.host, port: config.listen.port });
    observer.start();
    const url = `http://localhost:${config.listen.port}`;
    log.info(`daemon listening`, { url, stateDir: config.stateDir, docker: docker.description, installationId: installation.id });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      observer.stop();
      const graceful = runner.shutdown();
      await Promise.race([graceful, new Promise((r) => setTimeout(r, 20_000))]);
      await app.close();
      if (docker instanceof FakeDocker) await docker.shutdown();
      db.close();
      lock?.release();
      log.info('daemon stopped');
    };
    return { app, ctx, service, runner, observer, sessions, tools, url, close };
  } catch (e) {
    lock?.release();
    throw e;
  }
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
