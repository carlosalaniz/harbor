import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ComposeError, type ComposeInvocation, type ComposeResult, type ComposeRunner, type ContainerInfo, type DockerAdapter, type EngineInfo, type NetworkInfo, type VolumeInfo } from './adapter.js';
import type { Clock } from '../util.js';
import { rfc3339 } from '../util.js';

// In-memory Docker for unit/integration/UI tests. The fake Compose runner interprets the
// *generated* compose file (the same bytes the real CLI would receive), creates fake
// containers with the right labels/ports, and runs a real HTTP listener on each published
// loopback port so readiness probes exercise the real code path.

interface FakeContainer extends ContainerInfo {
  project: string;
  service: string;
}

export interface FakeBehaviour {
  // Per-service HTTP responder: return status code for a path. Default 200.
  respond?: (service: string, path: string) => number | 'hang' | 'refuse';
  failPull?: string | null; // error message
  failUp?: string | null;
  failUpImage?: string | null; // fail `up` only when a service image contains this text (update rollback tests)
  engineDown?: boolean;
}

export class FakeDocker implements DockerAdapter, ComposeRunner {
  readonly description = 'fake docker (in-memory)';
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, VolumeInfo>();
  readonly networks = new Map<string, NetworkInfo>();
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
  async listContainers(opts: { all: boolean; labels?: Record<string, string> }): Promise<ContainerInfo[]> {
    this.assertUp();
    return [...this.containers.values()].filter((c) => (opts.all || c.state === 'running') && matches(c.labels, opts.labels)).map(clone);
  }
  async inspectContainer(id: string): Promise<ContainerInfo | null> {
    this.assertUp();
    const c = this.containers.get(id) ?? [...this.containers.values()].find((x) => x.name === id);
    return c ? clone(c) : null;
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
  async createVolume(name: string, labels: Record<string, string>): Promise<VolumeInfo> {
    this.assertUp();
    const existing = this.volumes.get(name);
    if (existing) return existing; // Docker semantics: create is idempotent by name
    const v: VolumeInfo = { name, labels: { ...labels }, createdAt: rfc3339(this.clock.now()), driver: 'local' };
    this.volumes.set(name, v);
    this.log.push(`volume create ${name}`);
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
    return n ? { ...n, labels: { ...n.labels }, containerIds: [...n.containerIds] } : null;
  }
  async removeNetwork(id: string): Promise<void> {
    this.assertUp();
    const n = this.networks.get(id);
    if (!n) return;
    if (n.containerIds.length) throw Object.assign(new Error('network has active endpoints'), { statusCode: 403 });
    this.networks.delete(id);
    this.log.push(`network rm ${n.name}`);
  }
  async publishedHostPorts(): Promise<number[]> {
    this.assertUp();
    const ports = new Set<number>();
    for (const c of this.containers.values()) for (const p of c.ports) ports.add(p.hostPort);
    return [...ports];
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
    this.log.push(`pull ${inv.projectName}`);
    return { stdout: '', stderr: '' };
  }
  async up(inv: ComposeInvocation, _timeoutMs: number): Promise<ComposeResult> {
    this.assertUp();
    if (this.behaviour.failUp) throw new ComposeError(`docker compose up failed: ${this.behaviour.failUp}`, { command: ['up'], exitCode: 1, stderrTail: this.behaviour.failUp, timedOut: false });
    const text = readFileSync(inv.file, 'utf8').replace(/\$\$/g, '$');
    const doc = parseYaml(text) as {
      services: Record<string, { image: string; labels?: Record<string, string>; ports?: { target: number; published: string; host_ip: string }[]; volumes?: { source: string }[] }>;
      volumes?: Record<string, { name?: string; external?: boolean }>;
      networks?: Record<string, { name?: string; labels?: Record<string, string> }>;
    };
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
      net = { id: this.id('n'), name: netName, labels: { ...(doc.networks?.['default']?.labels ?? {}), 'com.docker.compose.project': inv.projectName, 'com.docker.compose.network': 'default' }, containerIds: [] };
      this.networks.set(net.id, net);
    }
    for (const [service, def] of Object.entries(doc.services)) {
      const name = `${inv.projectName}-${service}-1`;
      let c = [...this.containers.values()].find((x) => x.name === name);
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
          ports: (def.ports ?? []).map((p) => ({ hostIp: p.host_ip, hostPort: Number(p.published), containerPort: p.target })),
          networkIds: [net.id],
          project: inv.projectName,
          service,
        };
        this.containers.set(c.id, c);
        net.containerIds.push(c.id);
      }
      if (c.state !== 'running') {
        c.state = 'running';
        c.startedAt = rfc3339(this.clock.now());
        await this.listen(c);
      }
    }
    this.log.push(`up ${inv.projectName}`);
    return { stdout: '', stderr: '' };
  }
  async start(inv: ComposeInvocation, _timeoutMs: number): Promise<ComposeResult> {
    this.assertUp();
    for (const c of this.containers.values()) {
      if (c.project === inv.projectName && c.state !== 'running') await this.startContainer(c.id);
    }
    return { stdout: '', stderr: '' };
  }

  // --- fake app listeners
  private async listen(c: FakeContainer): Promise<void> {
    for (const p of c.ports) {
      if (p.hostIp !== '127.0.0.1') continue;
      const server = createServer((req, res) => {
        const verdict = this.behaviour.respond?.(c.service, req.url ?? '/') ?? 200;
        if (verdict === 'hang') return; // never respond
        if (verdict === 'refuse') {
          req.socket.destroy();
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
function clone(c: FakeContainer): ContainerInfo {
  return { id: c.id, name: c.name, image: c.image, state: c.state, labels: { ...c.labels }, createdAt: c.createdAt, startedAt: c.startedAt, health: c.health, ports: c.ports.map((p) => ({ ...p })), networkIds: [...c.networkIds] };
}
