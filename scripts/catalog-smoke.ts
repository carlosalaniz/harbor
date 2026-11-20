// Smoke test of one catalog app on a real Docker engine (decision 175): the compatibility check of the
// catalog's upstream-update bot. It runs Harbor's own engine in-process (real Dockerode adapter + real
// `docker compose`, a throwaway state dir), so it proves what a box would do, not a hand-written compose up:
//
//   upgrade  (with --base) install the revision the box has now, let it initialise its data, restart Harbor
//            with the new catalog and update: the update must succeed without a rollback and stay healthy;
//   fresh    remove it with its data, install the new revision from nothing: it must come up healthy.
//
// "Healthy" is Harbor's own readiness (the package's health path answers with an expected status), then a
// settle window in which every container keeps running without restarting again (scripts/smoke-settle.ts: the
// revision boxes already run may have restarted on its way to healthy; the new revision may not).
//
//   pnpm catalog:smoke --docker-socket /var/run/docker.sock --catalog <new apps dir> [--base <old apps dir>]
//                      <id> [--out result.json] [--record] [--settle 60]
//
// The engine is never discovered: --docker-socket names it. Only Harbor-labelled resources of this run are
// removed afterwards (images stay). --record writes a passed qualification into the new package's
// release.json (and refreshes its hashes) when every phase passed. GitHub runners (ubuntu-24.04, x86-64) are
// where harbor-apps CI runs it; anywhere else it is a developer's own engine (Docker Desktop is fine).
import Docker from 'dockerode';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { normalizeConfig, type DaemonConfig } from '../src/config.js';
import type { InstanceSummary, OperationDto, PlanDto } from '../src/contracts/api.js';
import { findDockerBinary, startDaemon, type Daemon } from '../src/daemon.js';
import { FakeEgressProvider } from '../src/egress/provider.js';
import { FakeGuardProvider } from '../src/guard/provider.js';
import { enrollAdministrator } from '../src/maintenance.js';
import { LABELS } from '../src/naming.js';
import { loadPackage, readCatalogIndex } from '../src/packages/catalog.js';
import { packageVersionOf } from '../src/packages/version.js';
import { initializeState } from '../src/state/db.js';
import { systemClock, systemIds } from '../src/util.js';
import { HARBOR_ROOT } from './catalog-dir.mjs';
import { smokeSecrets } from './smoke-secrets.js';
import { restartBaseline, settleProblem, toleratedRestarts, type SettleContainer } from './smoke-settle.js';

// A WireGuard file with the shape of one (keys are 32 bytes of base64, not real); the fake provider never dials it.
const SMOKE_VPN = `[Interface]\nPrivateKey = ${Buffer.alloc(32, 1).toString('base64')}\nAddress = 10.66.0.2/32\nDNS = 10.64.0.1\n\n[Peer]\nPublicKey = ${Buffer.alloc(32, 2).toString('base64')}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 192.0.2.1:51820\n`;
const ADMIN = { username: 'smoke', password: `smoke-${randomBytes(12).toString('hex')}` };

export interface SmokePhase {
  name: 'upgrade-install' | 'upgrade' | 'fresh';
  ok: boolean;
  seconds: number;
  revision: string;
  version: string | null;
  message: string;
  events?: string[];
  logs?: Record<string, string>;
}
export interface SmokeResult {
  id: string;
  ok: boolean;
  skipped: string | null;
  fromRevision: string | null;
  toRevision: string;
  fromVersion: string | null;
  toVersion: string | null;
  phases: SmokePhase[];
  host: { os: string; docker: string | null; compose: string | null; node: string };
  at: string;
}

function args(): { socket: string; catalog: string; base: string | null; id: string; out: string | null; record: boolean; settle: number } {
  const a = process.argv.slice(2);
  const take = (f: string): string | null => {
    const i = a.indexOf(f);
    if (i < 0) return null;
    const v = a[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${f} needs a value`);
    a.splice(i, 2);
    return v;
  };
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const socket = take('--docker-socket');
  const catalog = take('--catalog');
  const base = take('--base');
  const out = take('--out');
  const settle = Number(take('--settle') ?? '60');
  const record = a.includes('--record');
  const id = a.filter((x) => x !== '--record')[0];
  if (!socket || !catalog || !id) throw new Error('usage: catalog-smoke.ts --docker-socket <sock> --catalog <apps dir> [--base <apps dir>] <id> [--out <file>] [--record] [--settle <s>]');
  if (!existsSync(socket)) throw new Error(`no Docker socket at ${socket}`);
  if (!Number.isInteger(settle) || settle < 0 || settle > 1800) throw new Error('--settle is seconds, 0 to 1800');
  return { socket, catalog: path.resolve(cwd, catalog), base: base ? path.resolve(cwd, base) : null, id, out: out ? path.resolve(cwd, out) : null, record, settle };
}

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A catalog dir with only this app (its index entry as published).
function subset(from: string, id: string, to: string): void {
  const index = readCatalogIndex(from);
  const entry = index.packages[id];
  if (!entry) throw new Error(`${from} has no app ${id}`);
  mkdirSync(to, { recursive: true });
  cpSync(path.join(from, entry.dir), path.join(to, entry.dir), { recursive: true });
  writeFileSync(path.join(to, 'index.json'), JSON.stringify({ schemaVersion: 1, packages: { [id]: entry } }, null, 2) + '\n');
}

class Client {
  token: string | null = null;
  constructor(private readonly base: string) {}
  async call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const h: Record<string, string> = { connection: 'close', ...headers };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${this.base}${url}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${json?.error?.message ?? text.slice(0, 300)}${json?.error?.nextAction ? ` (${json.error.nextAction})` : ''}`);
    return json as T;
  }
  async login(): Promise<void> {
    this.token = (await this.call<{ token: string }>('POST', '/v1/sessions', ADMIN)).token;
  }
  async run(req: unknown, secrets: Record<string, string>, timeoutMs: number): Promise<{ plan: PlanDto; op: OperationDto }> {
    const plan = await this.call<PlanDto>('POST', '/v1/plans', req);
    const sub = await this.call<{ operationId: string }>('POST', '/v1/operations', { planId: plan.id, acceptPermissions: true, ...(Object.keys(secrets).length ? { secrets } : {}) }, { 'idempotency-key': `smoke-${randomBytes(8).toString('hex')}` });
    const start = Date.now();
    for (;;) {
      const op = await this.call<OperationDto>('GET', `/v1/operations/${sub.operationId}`);
      if (['succeeded', 'failed', 'needs_action', 'cancelled'].includes(op.state)) return { plan, op };
      if (Date.now() - start > timeoutMs) throw new Error(`operation ${op.kind} did not finish in ${Math.round(timeoutMs / 60000)} min`);
      await sleep(1000);
    }
  }
  async instance(name: string): Promise<InstanceSummary | undefined> {
    return (await this.call<{ items: InstanceSummary[] }>('GET', '/v1/instances')).items.find((i) => i.name === name);
  }
}

export async function smoke(o: ReturnType<typeof args>): Promise<SmokeResult> {
  const next = loadPackage(o.catalog, o.id);
  const prev = o.base && existsSync(path.join(o.base, 'index.json')) && readCatalogIndex(o.base).packages[o.id] ? loadPackage(o.base, o.id) : null;
  const needsVpn = next.manifest.network?.requireVpn === true || prev?.manifest.network?.requireVpn === true;
  const docker = new Docker({ socketPath: o.socket });
  const dockerBin = findDockerBinary();
  if (!dockerBin) throw new Error('the docker CLI is not installed (Harbor runs `docker compose`)');
  const pluginDirs = [path.join(homedir(), '.docker', 'cli-plugins')].filter((d) => existsSync(d));
  const ver = (cmd: string[]) => {
    try {
      return execFileSync(dockerBin, cmd, { encoding: 'utf8', env: { ...process.env, DOCKER_HOST: `unix://${o.socket}` } }).trim();
    } catch {
      return null;
    }
  };
  const result: SmokeResult = {
    id: o.id,
    ok: false,
    skipped: null,
    fromRevision: prev?.revision ?? null,
    toRevision: next.revision,
    fromVersion: prev ? packageVersionOf(prev) : null,
    toVersion: packageVersionOf(next),
    phases: [],
    host: { os: `${process.platform} ${process.arch}`, docker: ver(['version', '--format', '{{.Server.Version}}']), compose: ver(['compose', 'version', '--short']), node: process.version },
    at: new Date().toISOString(),
  };
  try {
    const rel = readFileSync('/etc/os-release', 'utf8');
    result.host.os = `${/^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] ?? 'Linux'} ${process.arch === 'x64' ? 'x86_64' : process.arch}`;
  } catch {
    /* not Linux: keep platform + arch */
  }

  // What an install needs besides the package: required typed-in secrets get throwaway values; optional ones
  // stay empty, as most installs leave them (a throwaway in a field the app reads as a URL, like ntfy's iPhone
  // relay, stops the app, which no operator would see); a required own folder gets an empty temp folder; a
  // required link to another app cannot be smoke-tested alone.
  const required = (next.manifest.links ?? []).filter((l) => !l.optional);
  if (required.length) {
    result.skipped = `needs another app (${required.map((l) => l.id).join(', ')}); check it by hand`;
    return result;
  }
  const secrets = smokeSecrets(next.manifest.secrets ?? []);
  const root = mkdtempSync(path.join(tmpdir(), 'harbor-smoke-'));
  const storage: Record<string, { hostPath: string }> = {};
  for (const s of next.manifest.storage ?? []) {
    if (!s.external?.required) continue;
    const dir = path.join(root, 'folders', s.id);
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    storage[s.id] = { hostPath: dir };
  }
  const stateDir = path.join(root, 'state');
  const port = await freePort();
  const appBase = 18700 + Math.floor(Math.random() * 400);
  const configFor = (catalogDir: string): DaemonConfig =>
    normalizeConfig({ stateDir, catalogDir, docker: { mode: 'socket', socketPath: o.socket, cliPluginDirs: pluginDirs }, listen: { host: '127.0.0.1', port }, appPortRange: { from: appBase, to: appBase + 40 }, logLevel: 'warn', imagePullTimeoutMs: 40 * 60_000, catalog: { url: null } }, root);
  const nextDir = path.join(root, 'catalog-next');
  subset(o.catalog, o.id, nextDir);
  let installationId: string | null = null;
  let daemon: Daemon | null = null;
  const api = new Client(`http://localhost:${port}`);
  const name = o.id;
  const timeoutMs = 60 * 60_000;

  const start = async (catalogDir: string) => {
    const config = configFor(catalogDir);
    if (!installationId) {
      installationId = initializeState(stateDir, { clock: systemClock, ids: systemIds, config: {} }).installationId;
      await enrollAdministrator(config, ADMIN.username, ADMIN.password, { reset: false });
    }
    // The host firewall is not what a smoke run proves (it has no root and no VPN): VPN and Access Guard run on
    // their fakes. An app that requires the VPN (decision 208) gets a stand-in tunnel so its install is accepted;
    // its containers then ask a resolver that answers nothing, so its health path must not need the internet.
    daemon = await startDaemon(config, { observerIntervalMs: 2000, egress: new FakeEgressProvider(), guard: new FakeGuardProvider() });
    await api.login();
    if (needsVpn) await api.call('PUT', '/v1/vpn', { config: SMOKE_VPN, name: 'smoke stand-in' });
  };
  const stop = async () => {
    await daemon?.close();
    daemon = null;
  };
  const containers = async (instanceId: string) => docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABELS.instance}=${instanceId}`] }) });
  const logs = async (instanceId: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const c of await containers(instanceId)) {
      const svc = c.Labels?.['com.docker.compose.service'] ?? c.Names[0] ?? c.Id.slice(0, 12);
      try {
        out[svc] = execFileSync(dockerBin, ['logs', '--tail', '60', c.Id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOCKER_HOST: `unix://${o.socket}` } }).slice(-6000);
      } catch (e) {
        out[svc] = String((e as { stdout?: string; stderr?: string }).stderr ?? e).slice(-6000);
      }
    }
    return out;
  };
  const snapshot = async (instanceId: string): Promise<SettleContainer[]> => {
    const out: SettleContainer[] = [];
    for (const c of await containers(instanceId)) {
      const s = await docker.getContainer(c.Id).inspect();
      out.push({ id: c.Id, service: c.Labels?.['com.docker.compose.service'] ?? c.Id.slice(0, 12), running: Boolean(s.State.Running), exitCode: s.State.ExitCode, restarts: s.RestartCount });
    }
    return out;
  };
  // Harbor said healthy; now every container must keep running, not restart beyond `allowed`, and readiness must hold.
  const settle = async (instanceId: string, allowed: Map<string, number>): Promise<string | null> => {
    const deadline = Date.now() + o.settle * 1000;
    for (;;) {
      const why = settleProblem(await snapshot(instanceId), allowed);
      if (why) return why;
      const inst = await api.instance(name);
      if (inst && inst.readiness === 'unhealthy') return `Harbor's health check failed after the app was up (readiness ${inst.readiness})`;
      if (Date.now() >= deadline) return null;
      await sleep(5000);
    }
  };
  // allow: 'at-healthy' = the restarts a container had when Harbor said healthy (the published revision); a map =
  // restarts already counted before the phase (containers it does not re-create); see scripts/smoke-settle.ts
  const phase = async (p: Omit<SmokePhase, 'ok' | 'seconds' | 'message'>, run: () => Promise<{ op: OperationDto } | null>, allow: 'at-healthy' | Map<string, number> = new Map()): Promise<boolean> => {
    const t0 = Date.now();
    let ok = false;
    let message: string;
    let events: string[] | undefined;
    let logsOut: Record<string, string> | undefined;
    try {
      const r = await run();
      const op = r?.op;
      const inst = await api.instance(name);
      if (op && op.state !== 'succeeded') {
        message = `${op.kind} ${op.state}: ${op.error?.message ?? 'no message'}`;
        events = op.events.slice(-25).map((e) => `${e.phase}: ${e.message}`);
      } else if (op && op.result?.['rolledBack'] === true) {
        message = 'the update rolled back';
      } else if (!inst || inst.runtime !== 'running') {
        message = `the app is not running (${inst?.runtime ?? 'gone'})`;
      } else {
        const healthy = Math.round((Date.now() - t0) / 1000);
        const atHealthy = allow === 'at-healthy' ? await snapshot(inst.id) : null;
        const allowed = atHealthy ? restartBaseline(atHealthy) : (allow as Map<string, number>);
        const early = atHealthy ? toleratedRestarts(atHealthy, allowed) : null;
        const why = await settle(inst.id, allowed);
        ok = why === null;
        message = ok ? `healthy after ${healthy} s${early ? ` (${early} before that)` : ''}, still healthy ${o.settle} s later` : why!;
      }
      if (!ok && inst) logsOut = await logs(inst.id);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
      const inst = await api.instance(name).catch(() => undefined);
      if (inst) logsOut = await logs(inst.id).catch(() => undefined);
    }
    result.phases.push({ ...p, ok, seconds: Math.round((Date.now() - t0) / 1000), message, ...(events ? { events } : {}), ...(logsOut ? { logs: logsOut } : {}) });
    console.error(`${o.id} ${p.name} (revision ${p.revision}${p.version ? `, ${p.version}` : ''}): ${ok ? 'ok' : 'FAILED'}: ${message}`);
    return ok;
  };

  try {
    if (prev && prev.revision !== next.revision) {
      const baseDir = path.join(root, 'catalog-base');
      subset(o.base!, o.id, baseDir);
      await start(baseDir);
      const installed = await phase({ name: 'upgrade-install', revision: prev.revision, version: packageVersionOf(prev) }, () => api.run({ kind: 'install', packageId: o.id, name, ...(Object.keys(storage).length ? { storage } : {}) }, secrets, timeoutMs), 'at-healthy');
      await stop();
      if (!installed) return result;
      // Harbor restarts on the new catalog, like a box that downloaded it; the app keeps running meanwhile
      await start(nextDir);
      const inst = await api.instance(name);
      if (!inst?.updateAvailable) throw new Error(`Harbor offers no update from revision ${prev.revision} to ${next.revision}`);
      const before = restartBaseline(await snapshot(inst.id));
      const updated = await phase({ name: 'upgrade', revision: next.revision, version: packageVersionOf(next) }, () => api.run({ kind: 'update', instanceId: inst.id }, {}, timeoutMs), before);
      if (!updated) return result;
      const purge = await api.run({ kind: 'purge', instanceId: inst.id }, {}, timeoutMs);
      if (purge.op.state !== 'succeeded') throw new Error(`could not remove the updated copy: ${purge.op.error?.message}`);
    } else {
      await start(nextDir);
    }
    const fresh = await phase({ name: 'fresh', revision: next.revision, version: packageVersionOf(next) }, () => api.run({ kind: 'install', packageId: o.id, name, ...(Object.keys(storage).length ? { storage } : {}) }, secrets, timeoutMs));
    result.ok = fresh && result.phases.every((p) => p.ok);
    const inst = await api.instance(name);
    if (inst) await api.run({ kind: 'purge', instanceId: inst.id }, {}, timeoutMs).catch(() => undefined);
    return result;
  } finally {
    await stop().catch(() => undefined);
    // only what this run created: its installation's containers, networks and volumes
    if (installationId) {
      const filters = JSON.stringify({ label: [`${LABELS.installation}=${installationId}`] });
      for (const c of await docker.listContainers({ all: true, filters })) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
      for (const n of await docker.listNetworks({ filters })) await docker.getNetwork(n.Id).remove().catch(() => undefined);
      for (const v of (await docker.listVolumes({ filters })).Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// A passed run becomes the package's qualification: the host it ran on and what it proved.
export function recordQualification(catalogDir: string, r: SmokeResult): void {
  const releasePath = path.join(catalogDir, r.id, 'release.json');
  const release = JSON.parse(readFileSync(releasePath, 'utf8'));
  const proved = r.phases.map((p) => (p.name === 'upgrade-install' ? `installed revision ${p.revision}${p.version ? ` (${p.version})` : ''} ${p.message}` : p.name === 'upgrade' ? `updated to revision ${p.revision} without a rollback, ${p.message}` : `fresh install of revision ${p.revision} ${p.message}`));
  release.qualification = {
    status: 'passed',
    date: r.at.slice(0, 10),
    node: r.host.node,
    ...(r.host.docker ? { dockerEngine: r.host.docker } : {}),
    ...(r.host.compose ? { dockerCompose: r.host.compose } : {}),
    hostOs: r.host.os,
    appVersions: Object.fromEntries(Object.entries(release.images as Record<string, { appVersion?: string; tag: string }>).map(([svc, img]) => [svc, img.appVersion ?? img.tag])),
    notes: [
      ...((release.qualification?.notes ?? []) as string[]).filter((n) => n.startsWith('Digest of ')),
      `Smoke run ${r.at} (pnpm catalog:smoke, Harbor's engine on a real Docker host): ${proved.join('; ')}.`,
    ],
  };
  writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');
  execFileSync('pnpm', ['-s', 'tsx', 'scripts/catalog-hash.ts', '--catalog', catalogDir, r.id], { stdio: ['ignore', 'inherit', 'inherit'], cwd: HARBOR_ROOT });
}

async function main(): Promise<void> {
  const o = args();
  const r = await smoke(o);
  if (o.out) writeFileSync(o.out, JSON.stringify(r, null, 2) + '\n');
  if (r.skipped) console.error(`${o.id}: smoke skipped: ${r.skipped}`);
  else console.error(`${o.id}: smoke ${r.ok ? 'passed' : 'FAILED'}`);
  if (r.ok && o.record) recordQualification(o.catalog, r);
  process.exit(r.ok ? 0 : r.skipped ? 3 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
