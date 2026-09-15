import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { normalizeConfig, type DaemonConfig } from '../../src/config.js';
import { FakeDocker } from '../../src/docker/fake.js';
import { FakeTailscale } from '../../src/exposure/tailscale.js';
import { FakeNet } from '../../src/system/net.js';
import { FakePower } from '../../src/system/power.js';
import type { FakeFetcher } from '../../src/appearance/fetcher.js';
import { demoFetcher, demoRegistry } from '../../src/daemon.js';
import type { FakeRegistry } from '../../src/packages/registry.js';
import { FakeReleaseFeed, FakeUnitStarter } from '../../src/system/selfupdate.js';
import { FakeCaddyAdmin } from '../../src/exposure/caddy.js';
import { FakeVerifier } from '../../src/exposure/verify.js';
import { FakeTransport } from '../../src/notify/notifier.js';
import { startDaemon, type Daemon, type DaemonOverrides } from '../../src/daemon.js';
import { initializeState } from '../../src/state/db.js';
import { enrollAdministrator } from '../../src/maintenance.js';
import { systemClock, systemIds, type Clock } from '../../src/util.js';
import type { ApiErrorBody, InstanceSummary, OperationDto, PlanDto } from '../../src/contracts/api.js';

export const ADMIN = { username: 'admin', password: 'correct-horse-battery-staple' };
export const REPO_CATALOG = path.resolve(import.meta.dirname, '../../catalog');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

export class MutableClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface Harness {
  daemon: Daemon;
  fake: FakeDocker;
  tailscale: FakeTailscale;
  net: FakeNet;
  fetcher: FakeFetcher;
  power: FakePower;
  registry: FakeRegistry;
  releaseFeed: FakeReleaseFeed;
  unitStarter: FakeUnitStarter;
  userDataDir: string;
  caddy: FakeCaddyAdmin;
  verifier: FakeVerifier;
  notifyTransport: FakeTransport;
  config: DaemonConfig;
  stateDir: string;
  catalogDir: string;
  clock: MutableClock;
  baseUrl: string;
  token: string;
  api: Api;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export class Api {
  constructor(
    public baseUrl: string,
    public token: string | null,
  ) {}

  async raw(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { connection: 'close', ...headers };
    if (this.token && !('authorization' in h)) h['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined && !('content-type' in h)) h['content-type'] = 'application/json';
    return fetch(`${this.baseUrl}${url}`, { method, headers: h, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  }

  async json<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await this.raw(method, url, body, headers);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async expect<T>(status: number, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const r = await this.json<T>(method, url, body, headers);
    if (r.status !== status) throw new Error(`${method} ${url}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  async expectError(status: number, code: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiErrorBody> {
    const r = await this.json<ApiErrorBody>(method, url, body, headers);
    if (r.status !== status || r.body?.error?.code !== code) throw new Error(`${method} ${url}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  login(username = ADMIN.username, password = ADMIN.password): Promise<{ token: string; expiresAt: string }> {
    return this.expect(201, 'POST', '/v1/sessions', { username, password }, { authorization: '' });
  }

  plan(req: unknown): Promise<PlanDto> {
    return this.expect(201, 'POST', '/v1/plans', req);
  }

  submit(planId: string, key = `key-${Math.random().toString(36).slice(2, 12)}`): Promise<{ operationId: string; created: boolean; operation: OperationDto }> {
    return this.expect(202, 'POST', '/v1/operations', { planId }, { 'idempotency-key': key });
  }

  async waitOperation(id: string, timeoutMs = 60_000): Promise<OperationDto> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const op = await this.expect<OperationDto>(200, 'GET', `/v1/operations/${id}`);
      if (['succeeded', 'failed', 'needs_action'].includes(op.state)) return op;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`operation ${id} did not finish`);
  }

  async run(req: unknown): Promise<{ plan: PlanDto; op: OperationDto }> {
    const plan = await this.plan(req);
    const sub = await this.submit(plan.id);
    const op = await this.waitOperation(sub.operationId);
    return { plan, op };
  }

  async instances(): Promise<InstanceSummary[]> {
    return (await this.expect<{ items: InstanceSummary[] }>(200, 'GET', '/v1/instances')).items;
  }
}

export async function startHarness(opts: { catalogDir?: string; overrides?: DaemonOverrides; portRange?: { from: number; to: number }; noAdmin?: boolean; config?: Record<string, unknown> } = {}): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), 'harbor-it-'));
  const stateDir = path.join(root, 'state');
  const catalogDir = opts.catalogDir ?? path.join(root, 'catalog');
  if (!opts.catalogDir) cpSync(REPO_CATALOG, catalogDir, { recursive: true });
  const port = await freePort();
  const base = await freePort();
  const clock = new MutableClock();
  // A private port range far from the default so parallel test files do not collide.
  const range = opts.portRange ?? { from: base + 1, to: base + 40 };
  const config = normalizeConfig(
    { stateDir, catalogDir, userDataDir: path.join(root, 'data'), docker: { mode: 'fake' }, listen: { host: '127.0.0.1', port }, appPortRange: range, planTtlSeconds: 900, sessionTtlSeconds: 3600, logLevel: 'error', ...(opts.config ?? {}) },
    root,
  );
  initializeState(stateDir, { clock: systemClock, ids: systemIds, config: {} });
  if (!opts.noAdmin) await enrollAdministrator(config, ADMIN.username, ADMIN.password, { reset: false });
  const fake = new FakeDocker(clock);
  const tailscale = new FakeTailscale();
  const net = new FakeNet();
  const fetcher = demoFetcher();
  const power = new FakePower();
  const registry = demoRegistry();
  const releaseFeed = new FakeReleaseFeed();
  const unitStarter = new FakeUnitStarter();
  const caddy = new FakeCaddyAdmin();
  const verifier = new FakeVerifier();
  const notifyTransport = new FakeTransport();
  const start = () => startDaemon(config, { docker: fake, compose: fake, clock, observerIntervalMs: 500, tailscale, caddy, verify: verifier.fn, net, fetcher, power, registry, releaseFeed, unitStarter, notifyTransport, ...(opts.overrides ?? {}), toolsProbe: opts.overrides?.toolsProbe ?? (async () => ({ reachable: false, note: 'not probed in tests' })) });
  let daemon = await start();
  const baseUrl = `http://localhost:${port}`;
  const api = new Api(baseUrl, null);
  let token = '';
  if (!opts.noAdmin) {
    token = (await api.login()).token;
    api.token = token;
  }
  const h: Harness = {
    daemon,
    fake,
    tailscale,
    net,
    fetcher,
    power,
    registry,
    releaseFeed,
    unitStarter,
    userDataDir: config.userDataDir,
    caddy,
    verifier,
    notifyTransport,
    config,
    stateDir,
    catalogDir,
    clock,
    baseUrl,
    token,
    api,
    async restart() {
      await daemon.close();
      daemon = await start();
      h.daemon = daemon;
      const s = await api.login();
      api.token = s.token;
      h.token = s.token;
    },
    async close() {
      await daemon.close();
      await fake.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}
