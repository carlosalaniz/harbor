import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ComposeError, type ComposeInvocation, type ComposeResult, type ComposeRunner, type ContainerInfo, type ContainerStats, type DockerAdapter, type DockerDiskUsage, type EngineInfo, type ExecResult, type NetworkInfo, type VolumeInfo } from './adapter.js';
import type { Clock } from '../util.js';
import { rfc3339 } from '../util.js';
import { subnetsOverlap } from '../planner/subnets.js';

// In-memory Docker for unit/integration/UI tests. The fake Compose runner interprets the
// *generated* compose file (the same bytes the real CLI would receive), creates fake
// containers with the right labels/ports, and runs a real HTTP listener on each published
// loopback port so readiness probes exercise the real code path.

interface FakeContainer extends ContainerInfo {
  project: string;
  service: string;
  // network id -> aliases on it (decision 126 link networks)
  aliases?: Record<string, string[]>;
  env?: Record<string, string>;
  // what Compose's config hash covers: a change recreates the container on the next `up` (decision 171)
  configHash?: string;
}

export interface FakeBehaviour {
  // Per-service HTTP responder: return status code for a path. Default 200.
  // Return { status, body } to serve a custom body (e.g. widget JSON in tests).
  respond?: (service: string, path: string) => number | 'hang' | 'refuse' | { status: number; body: string };
  failPull?: string | null; // error message
  failUp?: string | null;
  failUpImage?: string | null; // fail `up` only when a service image contains this text (update rollback tests)
  failBuild?: string | null; // fail docker build (git-source tests)
  failExec?: string | null; // afterStart hook exits 1 with this output
  engineDown?: boolean;
  // Usage a running container reports (defaults below); keyed by container name, fallback '*'.
  stats?: Record<string, ContainerStats>;
  // Volume sizes reported by diskUsage(); keyed by volume name, fallback default.
  volumeSizes?: Record<string, number>;
  // decision 179: runtimes `docker info` lists (default: runc only, no NVIDIA toolkit)
  runtimes?: string[];
  // decision 183 (dev/e2e only, set from src/dev.ts): `pull` for a project with these images resolves when this does
  // (a test holds a pull and releases it; unset = instant)
  pullWait?: (images: string[]) => Promise<void>;
}

// Decision 183 (dev/e2e only; src/dev.ts wires it to HARBOR_DEV_FAKE_CONTROL): hold a fake pull of these images
// while the control says so, reading it again every pollMs. `{hold: true, match}` holds until the control no longer
// matches (a test releases it by writing `{}`); `{pullDelayMs, match}` holds at most that long (with or without hold).
// No match, no hold and no delay, or a control that is not an object = no wait at all.
export async function holdPull(images: string[], read: () => unknown, opts: { pollMs?: number } = {}): Promise<void> {
  const pollMs = opts.pollMs ?? 150;
  const held = (): { maxMs: number } | null => {
    const c = read();
    if (!c || typeof c !== 'object') return null;
    const { hold, pullDelayMs, match } = c as { hold?: unknown; pullDelayMs?: unknown; match?: unknown };
    const maxMs = typeof pullDelayMs === 'number' && pullDelayMs > 0 ? pullDelayMs : hold === true ? Infinity : 0;
    if (!maxMs) return null;
    const m = typeof match === 'string' ? match : '';
    return images.some((i) => i.includes(m)) ? { maxMs } : null;
  };
  const t0 = Date.now();
  for (let h = held(); h && Date.now() - t0 < h.maxMs; h = held()) await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, h.maxMs - (Date.now() - t0)))));
}

export class FakeDocker implements DockerAdapter, ComposeRunner {
  readonly description = 'fake docker (in-memory)';
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, VolumeInfo>();
  readonly networks = new Map<string, NetworkInfo>();
  // every network gets its own /24, as Docker never hands out one subnet twice while it is in use
  private netSeq = 0;
  private nextSubnet(prefix: '172.29' | '172.30'): { gateway: string; subnet: string } {
    const n = this.netSeq++ % 250;
    return { gateway: `${prefix}.${n}.1`, subnet: `${prefix}.${n}.0/24` };
  }
  // decision 191: a subnet Harbor chose, refused like Docker does when another network has it already
  private chosenSubnet(subnet: string, name: string): { gateway: string; subnet: string } {
    const clash = [...this.networks.values()].find((n) => (n.subnets ?? []).some((s) => subnetsOverlap(s, subnet)));
    if (clash) throw Object.assign(new Error(`invalid pool request: Pool overlaps with other one on this address space (${name} vs ${clash.name})`), { statusCode: 403 });
    return { gateway: subnet.replace(/\.0\/24$/, '.1'), subnet };
  }
  readonly listeners = new Map<string, Server>(); // container id -> server
  behaviour: FakeBehaviour = {};
  readonly log: string[] = [];
  private seq = 0;

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${randomBytes(28).toString('hex')}${String(this.seq).padStart(4, '0')}`.slice(0, 64);
  }

  private assertUp(): void {
    if (this.behaviour.engineDown) throw new Error('connect ENOENT /var/run/docker.sock (fake engine down)');
  }

  // --- DockerAdapter
  async ping(): Promise<EngineInfo> {
    if (this.behaviour.engineDown) return { available: false, version: null, apiVersion: null, error: 'fake engine down' };
    return { available: true, version: 'fake-29.0', apiVersion: '1.51', error: null };
  }
  async info(): Promise<{ runtimes: string[] }> {
    this.assertUp();
    return { runtimes: [...(this.behaviour.runtimes ?? ['runc'])] };
  }
  async listContainers(opts: { all: boolean; labels?: Record<string, string> }): Promise<ContainerInfo[]> {
    this.assertUp();
    return [...this.containers.values()].filter((c) => (opts.all || c.state === 'running') && matches(c.labels, opts.labels)).map((c) => clone(c, this.networks));
  }
  async inspectContainer(id: string): Promise<ContainerInfo | null> {
    this.assertUp();
    const c = this.containers.get(id) ?? [...this.containers.values()].find((x) => x.name === id);
    return c ? clone(c, this.networks) : null;
  }
  async startContainer(id: string): Promise<void> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
    if (c.state !== 'running') {
      c.state = 'running';
      c.startedAt = rfc3339(this.clock.now());
      await this.listen(c);
    }
    this.log.push(`start ${c.name}`);
  }
  async stopContainer(id: string, _timeoutSeconds: number): Promise<void> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
    c.state = 'exited';
    await this.unlisten(c.id);
    this.log.push(`stop ${c.name}`);
  }
  async removeContainer(id: string): Promise<void> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c) return;
    if (c.state === 'running') throw Object.assign(new Error('cannot remove a running container'), { statusCode: 409 });
    await this.unlisten(c.id);
    this.containers.delete(id);
    for (const n of this.networks.values()) n.containerIds = n.containerIds.filter((x) => x !== id);
    this.log.push(`rm ${c.name}`);
  }
  async listVolumes(labels?: Record<string, string>): Promise<VolumeInfo[]> {
    this.assertUp();
    return [...this.volumes.values()].filter((v) => matches(v.labels, labels)).map((v) => ({ ...v, labels: { ...v.labels } }));
  }
  async inspectVolume(name: string): Promise<VolumeInfo | null> {
    this.assertUp();
    const v = this.volumes.get(name);
    return v ? { ...v, labels: { ...v.labels } } : null;
  }
  async createVolume(name: string, labels: Record<string, string>, opts: { driverOpts?: Record<string, string> } = {}): Promise<VolumeInfo> {
    this.assertUp();
    const existing = this.volumes.get(name);
    if (existing) return existing; // Docker semantics: create is idempotent by name
    const v: VolumeInfo = { name, labels: { ...labels }, createdAt: rfc3339(this.clock.now()), driver: 'local', mountpoint: opts.driverOpts?.['device'] ?? `/var/lib/docker/volumes/${name}/_data` };
    this.volumes.set(name, v);
    // Record the backing path so tests can assert install-location rooting.
    if (opts.driverOpts?.['device']) this.log.push(`volume create ${name} device=${opts.driverOpts['device']}`);
    else this.log.push(`volume create ${name}`);
    return v;
  }
  async removeVolume(name: string): Promise<void> {
    this.assertUp();
    if (!this.volumes.has(name)) throw new Error(`no such volume ${name}`);
    this.volumes.delete(name);
    this.log.push(`volume rm ${name}`);
  }
  async inspectNetwork(idOrName: string): Promise<NetworkInfo | null> {
    this.assertUp();
    const n = this.networks.get(idOrName) ?? [...this.networks.values()].find((x) => x.name === idOrName);
    return n ? { ...n, labels: { ...n.labels }, containerIds: [...n.containerIds], gateways: [...n.gateways], subnets: [...(n.subnets ?? [])] } : null;
  }
  async listNetworks(labels?: Record<string, string>): Promise<NetworkInfo[]> {
    this.assertUp();
    return [...this.networks.values()].filter((n) => matches(n.labels, labels)).map((n) => ({ ...n, labels: { ...n.labels }, containerIds: [...n.containerIds], gateways: [...n.gateways], subnets: [...(n.subnets ?? [])] }));
  }
  async removeNetwork(id: string): Promise<void> {
    this.assertUp();
    const n = this.networks.get(id) ?? [...this.networks.values()].find((x) => x.name === id);
    if (!n) return;
    if (n.containerIds.length) throw Object.assign(new Error('network has active endpoints'), { statusCode: 403 });
    this.networks.delete(n.id);
    this.internal.delete(n.id);
    this.log.push(`network rm ${n.name}`);
  }
  readonly internal = new Set<string>(); // network ids created with internal: true
  async createNetwork(name: string, labels: Record<string, string>, opts: { internal: boolean; subnet?: string }): Promise<NetworkInfo> {
    this.assertUp();
    if ([...this.networks.values()].some((n) => n.name === name)) throw Object.assign(new Error(`network with name ${name} already exists`), { statusCode: 409 });
    const ipam = opts.subnet ? this.chosenSubnet(opts.subnet, name) : this.nextSubnet('172.29');
    const net: NetworkInfo = { id: this.id('n'), name, labels: { ...labels }, containerIds: [], gateways: [ipam.gateway], subnets: [ipam.subnet] };
    this.networks.set(net.id, net);
    if (opts.internal) this.internal.add(net.id);
    this.log.push(`network create ${name}${opts.internal ? ' --internal' : ''}`);
    return { ...net, labels: { ...net.labels }, containerIds: [], gateways: [...net.gateways], subnets: [...net.subnets] };
  }
  async connectNetwork(networkId: string, containerId: string, aliases: string[]): Promise<void> {
    this.assertUp();
    const n = this.networks.get(networkId);
    const c = this.containers.get(containerId);
    if (!n) throw Object.assign(new Error(`network ${networkId} not found`), { statusCode: 404 });
    if (!c) throw Object.assign(new Error(`container ${containerId} not found`), { statusCode: 404 });
    if (!n.containerIds.includes(c.id)) n.containerIds.push(c.id);
    if (!c.networkIds.includes(n.id)) c.networkIds.push(n.id);
    (c.aliases ??= {})[n.id] = [...aliases];
    this.log.push(`network connect ${n.name} ${c.name}${aliases.length ? ` --alias ${aliases.join(',')}` : ''}`);
  }
  async disconnectNetwork(networkId: string, containerId: string): Promise<void> {
    this.assertUp();
    const n = this.networks.get(networkId);
    const c = this.containers.get(containerId);
    if (!n || !c) return;
    n.containerIds = n.containerIds.filter((x) => x !== c.id);
    c.networkIds = c.networkIds.filter((x) => x !== n.id);
    if (c.aliases) delete c.aliases[n.id];
    this.log.push(`network disconnect ${n.name} ${c.name}`);
  }
  // Test helper: every name that resolves on a network (container names + aliases), as Docker's DNS has them.
  namesOn(networkName: string): string[] {
    const n = [...this.networks.values()].find((x) => x.name === networkName);
    if (!n) return [];
    return n.containerIds.flatMap((id) => {
      const c = this.containers.get(id);
      return c ? [c.name, ...(c.aliases?.[n.id] ?? [])] : [];
    });
  }
  // Test helper: the aliases a container answers to on a network (by network name).
  aliasesOn(containerName: string, networkName: string): string[] | null {
    const c = [...this.containers.values()].find((x) => x.name === containerName);
    const n = [...this.networks.values()].find((x) => x.name === networkName);
    if (!c || !n || !n.containerIds.includes(c.id)) return null;
    return c.aliases?.[n.id] ?? [];
  }
  envOf(containerName: string): Record<string, string> | null {
    const c = [...this.containers.values()].find((x) => x.name === containerName);
    return c ? { ...(c.env ?? {}) } : null;
  }
  async containerLogs(id: string, tail: number): Promise<string> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c) return '';
    const lines = [`${c.createdAt} [fake] container ${c.name} created from ${c.image}`, ...(c.startedAt ? [`${c.startedAt} [fake] ${c.service} listening on ${c.ports.map((p) => p.hostPort).join(',') || 'no ports'}`] : []), `${rfc3339(this.clock.now())} [fake] state ${c.state}`];
    return lines.slice(-tail).join('\n') + '\n';
  }

  async publishedHostPorts(): Promise<number[]> {
    this.assertUp();
    const ports = new Set<number>();
    for (const c of this.containers.values()) for (const p of c.ports) ports.add(p.hostPort);
    return [...ports];
  }

  async containerStats(id: string): Promise<ContainerStats | null> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c || c.state !== 'running') return null;
    return this.behaviour.stats?.[c.name] ?? this.behaviour.stats?.['*'] ?? { cpuPercent: 1.5, memoryBytes: 64 * 1024 * 1024, memoryLimitBytes: 8 * 1024 * 1024 * 1024 };
  }

  async diskUsage(): Promise<DockerDiskUsage> {
    this.assertUp();
    return {
      volumes: [...this.volumes.keys()].map((name) => ({ name, sizeBytes: this.behaviour.volumeSizes?.[name] ?? 32 * 1024 * 1024 })),
    };
  }

  // --- ComposeRunner
  async version(): Promise<string | null> {
    return 'fake-compose-2.0';
  }
  async config(inv: ComposeInvocation, _timeoutMs: number): Promise<string> {
    const text = readFileSync(inv.file, 'utf8');
    const doc = parseYaml(text) as Record<string, unknown>;
    if (!doc || typeof doc !== 'object' || !doc['services']) throw new ComposeError('fake compose config: no services', { command: ['config'], exitCode: 1, stderrTail: 'no services', timedOut: false });
    // Mimic Compose interpolation: unescape $$ -> $ and reject unresolved ${...}.
    if (/(^|[^$])\$\{/.test(text)) throw new ComposeError('fake compose config: unresolved variable', { command: ['config'], exitCode: 1, stderrTail: 'required variable is missing a value', timedOut: false });
    return text.replace(/\$\$/g, '$');
  }
  async pull(inv: ComposeInvocation, _timeoutMs: number): Promise<ComposeResult> {
    this.assertUp();
    if (this.behaviour.failPull) throw new ComposeError(`docker compose pull failed: ${this.behaviour.failPull}`, { command: ['pull'], exitCode: 1, stderrTail: this.behaviour.failPull, timedOut: false });
    if (this.behaviour.pullWait) {
      const doc = parseYaml(readFileSync(inv.file, 'utf8')) as { services?: Record<string, { image?: string }> };
      await this.behaviour.pullWait(Object.values(doc?.services ?? {}).map((svc) => String(svc.image ?? '')));
    }
    this.log.push(`pull ${inv.projectName}`);
    return { stdout: '', stderr: '' };
  }
  // Like Compose: a container whose configuration changed (or every one with forceRecreate) is recreated and so
  // loses the networks the runner attached; an unchanged one keeps them. Networks Compose attaches carry the
  // container name and the service name as aliases (decision 171). noStart creates without starting.
  async up(inv: ComposeInvocation, _timeoutMs: number, opts: { forceRecreate?: boolean; noStart?: boolean } = {}): Promise<ComposeResult> {
    this.assertUp();
    if (this.behaviour.failUp) throw new ComposeError(`docker compose up failed: ${this.behaviour.failUp}`, { command: ['up'], exitCode: 1, stderrTail: this.behaviour.failUp, timedOut: false });
    const text = readFileSync(inv.file, 'utf8').replace(/\$\$/g, '$');
    const doc = parseYaml(text) as {
      services: Record<string, { image: string; labels?: Record<string, string>; ports?: { target: number; published: string; host_ip: string; protocol?: string }[]; volumes?: { source: string }[]; environment?: Record<string, string>; networks?: string[] | Record<string, { aliases?: string[] } | null> }>;
      volumes?: Record<string, { name?: string; external?: boolean }>;
      networks?: Record<string, { name?: string; labels?: Record<string, string>; external?: boolean; ipam?: { config?: { subnet?: string }[] } }>;
    };
    // External networks (decision 126 link networks) must exist, exactly like Compose demands.
    for (const [, n] of Object.entries(doc.networks ?? {})) {
      if (n.external && n.name && ![...this.networks.values()].some((x) => x.name === n.name)) {
        throw new ComposeError(`network ${n.name} declared as external, but could not be found`, { command: ['up'], exitCode: 1, stderrTail: `network ${n.name} declared as external, but could not be found`, timedOut: false });
      }
    }
    for (const [, v] of Object.entries(doc.volumes ?? {})) {
      if (v.external && v.name && !this.volumes.has(v.name)) {
        throw new ComposeError(`external volume "${v.name}" not found`, { command: ['up'], exitCode: 1, stderrTail: `external volume "${v.name}" not found`, timedOut: false });
      }
    }
    if (this.behaviour.failUpImage && Object.values(doc.services).some((svc) => svc.image.includes(this.behaviour.failUpImage!))) {
      throw new ComposeError(`docker compose up failed: image ${this.behaviour.failUpImage} refuses to start (simulated)`, { command: ['up'], exitCode: 1, stderrTail: 'simulated failure', timedOut: false });
    }
    const netName = doc.networks?.['default']?.name ?? `${inv.projectName}_default`;
    let net = [...this.networks.values()].find((n) => n.name === netName);
    if (!net) {
      const chosen = doc.networks?.['default']?.ipam?.config?.[0]?.subnet;
      let ipam: { gateway: string; subnet: string };
      try {
        ipam = chosen ? this.chosenSubnet(chosen, netName) : this.nextSubnet('172.30');
      } catch (e) {
        throw new ComposeError(`docker compose up failed: ${(e as Error).message}`, { command: ['up'], exitCode: 1, stderrTail: (e as Error).message, timedOut: false });
      }
      net = { id: this.id('n'), name: netName, labels: { ...(doc.networks?.['default']?.labels ?? {}), 'com.docker.compose.project': inv.projectName, 'com.docker.compose.network': 'default' }, containerIds: [], gateways: [ipam.gateway], subnets: [ipam.subnet] };
      this.networks.set(net.id, net);
    }
    for (const [service, def] of Object.entries(doc.services)) {
      const name = `${inv.projectName}-${service}-1`;
      const hash = JSON.stringify(def);
      let c = [...this.containers.values()].find((x) => x.name === name);
      const recreate = Boolean(c && (opts.forceRecreate || c.configHash !== hash));
      if (!c) {
        c = {
          id: this.id('c'),
          name,
          image: def.image,
          state: 'created',
          labels: { ...(def.labels ?? {}), 'com.docker.compose.project': inv.projectName, 'com.docker.compose.service': service },
          createdAt: rfc3339(this.clock.now()),
          startedAt: null,
          health: 'none',
          ports: (def.ports ?? []).map((p) => ({ hostIp: p.host_ip, hostPort: Number(p.published), containerPort: p.target, ...(p.protocol === 'udp' ? { protocol: 'udp' as const } : {}) })),
          networkIds: [net.id],
          project: inv.projectName,
          service,
          aliases: {},
          env: {},
        };
        this.containers.set(c.id, c);
        net.containerIds.push(c.id);
      }
      // Compose recreates a container whose configuration changed; the fake keeps its id and syncs in place.
      c.configHash = hash;
      c.env = { ...(def.environment ?? {}) };
      const wanted = new Map<string, string[]>([[net.id, []]]);
      const svcNets = Array.isArray(def.networks) ? Object.fromEntries(def.networks.map((k) => [k, null])) : (def.networks ?? { default: null });
      for (const [key, cfg] of Object.entries(svcNets)) {
        if (key === 'default') continue;
        const decl = doc.networks?.[key];
        const target = [...this.networks.values()].find((x) => x.name === (decl?.name ?? key));
        if (target) wanted.set(target.id, [name, service, ...(cfg?.aliases ?? [])]);
      }
      for (const n of this.networks.values()) {
        const has = n.containerIds.includes(c.id);
        const want = wanted.has(n.id);
        if (want && !has) n.containerIds.push(c.id);
        if (!want && has && recreate) n.containerIds = n.containerIds.filter((x) => x !== c.id);
      }
      c.networkIds = [...this.networks.values()].filter((n) => n.containerIds.includes(c.id)).map((n) => n.id);
      c.aliases ??= {};
      for (const id of Object.keys(c.aliases)) if (!c.networkIds.includes(id)) delete c.aliases[id];
      for (const [id, al] of wanted) if (id !== net.id && (recreate || !c.aliases[id])) c.aliases[id] = al;
      if (opts.noStart) {
        if (recreate && c.state === 'running') {
          c.state = 'created';
          c.startedAt = null;
          await this.unlisten(c.id);
        }
        continue;
      }
      if (c.state !== 'running') {
        c.state = 'running';
        c.startedAt = rfc3339(this.clock.now());
        await this.listen(c);
      }
    }
    if (opts.forceRecreate && !opts.noStart) {
      for (const c of this.containers.values()) if (c.project === inv.projectName) c.startedAt = rfc3339(this.clock.now());
    }
    this.log.push(`up ${inv.projectName}${opts.noStart ? ' --no-start' : ''}${opts.forceRecreate ? ' --force-recreate' : ''}`);
    return { stdout: '', stderr: '' };
  }
  async start(inv: ComposeInvocation, _timeoutMs: number): Promise<ComposeResult> {
    this.assertUp();
    for (const c of this.containers.values()) {
      if (c.project === inv.projectName && c.state !== 'running') await this.startContainer(c.id);
    }
    return { stdout: '', stderr: '' };
  }
  // docker build (git sources): records the tag; behaviour.failBuild simulates a broken Dockerfile.
  builtTags: string[] = [];
  async build(opts: { contextDir: string; dockerfile: string; tag: string; timeoutMs: number; onLog?: (line: string) => void }): Promise<void> {
    this.assertUp();
    if (this.behaviour.failBuild) throw new ComposeError(`docker build failed: ${this.behaviour.failBuild}`, { command: ['build'], exitCode: 1, stderrTail: this.behaviour.failBuild, timedOut: false });
    if (!readFileSync(path.join(opts.contextDir, opts.dockerfile), 'utf8').trim()) throw new ComposeError('docker build failed: empty Dockerfile', { command: ['build'], exitCode: 1, stderrTail: 'empty Dockerfile', timedOut: false });
    this.builtTags.push(opts.tag);
    opts.onLog?.(`#1 building ${opts.tag} (fake)`);
    this.log.push(`build ${opts.tag}`);
  }

  // exec (afterStart hooks): recorded for assertions; behaviour.failExec simulates a failing hook.
  readonly execs: { id: string; cmd: string[]; user?: string; env: Record<string, string> }[] = [];
  async exec(id: string, opts: { cmd: string[]; user?: string; env?: Record<string, string>; timeoutMs: number }): Promise<ExecResult> {
    this.assertUp();
    const c = this.containers.get(id);
    if (!c || c.state !== 'running') throw Object.assign(new Error(`container ${id} is not running`), { statusCode: 409 });
    this.execs.push({ id, cmd: [...opts.cmd], ...(opts.user ? { user: opts.user } : {}), env: { ...(opts.env ?? {}) } });
    this.log.push(`exec ${c.name} ${opts.cmd[0] ?? ''}`);
    if (this.behaviour.failExec) return { exitCode: 1, output: this.behaviour.failExec, timedOut: false };
    return { exitCode: 0, output: '', timedOut: false };
  }

  // --- fake app listeners
  private async listen(c: FakeContainer): Promise<void> {
    for (const p of c.ports) {
      if (p.protocol === 'udp') continue; // a fixed UDP port (decision 163) has no HTTP listener to fake
      // the fake always binds loopback (LAN mode renders 0.0.0.0 but tests must not open the machine)
      const server = createServer((req, res) => {
        const verdict = this.behaviour.respond?.(c.service, req.url ?? '/') ?? 200;
        if (verdict === 'hang') return; // never respond
        if (verdict === 'refuse') {
          req.socket.destroy();
          return;
        }
        if (typeof verdict === 'object') {
          res.statusCode = verdict.status;
          res.setHeader('content-type', 'application/json');
          res.end(verdict.body);
          return;
        }
        res.statusCode = verdict;
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><title>${c.service}</title><h1>fake ${c.service}</h1>`);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: p.hostPort, host: '127.0.0.1', exclusive: true }, () => resolve());
      }).catch((e: Error) => {
        c.state = 'exited';
        throw new ComposeError(`Bind for 127.0.0.1:${p.hostPort} failed: port is already allocated (${e.message})`, { command: ['up'], exitCode: 1, stderrTail: e.message, timedOut: false });
      });
      this.listeners.set(c.id, server);
    }
  }
  private async unlisten(id: string): Promise<void> {
    const s = this.listeners.get(id);
    if (!s) return;
    this.listeners.delete(id);
    await new Promise<void>((resolve) => {
      s.closeAllConnections();
      s.close(() => resolve());
    });
  }
  async shutdown(): Promise<void> {
    for (const id of [...this.listeners.keys()]) await this.unlisten(id);
  }
}

function matches(labels: Record<string, string>, want?: Record<string, string>): boolean {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => labels[k] === v);
}
function clone(c: FakeContainer, networks: Map<string, NetworkInfo>): ContainerInfo {

  return { id: c.id, name: c.name, image: c.image, state: c.state, labels: { ...c.labels }, createdAt: c.createdAt, startedAt: c.startedAt, health: c.health, ports: c.ports.map((p) => ({ ...p })), networkIds: [...c.networkIds], networkAliases: Object.fromEntries(c.networkIds.map((n) => [networks.get(n)?.name ?? n, [...(c.aliases?.[n] ?? [])]])) };
}
