import Docker from 'dockerode';
import type { ContainerInfo, DockerAdapter, EngineInfo, NetworkInfo, VolumeInfo } from './adapter.js';

type InspectInfo = Docker.ContainerInspectInfo;

function isNotFound(e: unknown): boolean {
  return (e as { statusCode?: number })?.statusCode === 404;
}

function fromInspect(c: InspectInfo): ContainerInfo {
  const ports = [];
  for (const [key, bindings] of Object.entries(c.NetworkSettings?.Ports ?? {})) {
    const containerPort = Number(key.split('/')[0]);
    for (const b of bindings ?? []) {
      ports.push({ hostIp: b.HostIp, hostPort: Number(b.HostPort), containerPort });
    }
  }
  const health = c.State.Health?.Status as ContainerInfo['health'] | undefined;
  return {
    id: c.Id,
    name: c.Name.replace(/^\//, ''),
    image: c.Config.Image,
    state: c.State.Status as ContainerInfo['state'],
    labels: c.Config.Labels ?? {},
    createdAt: c.Created,
    startedAt: c.State.StartedAt && c.State.StartedAt !== '0001-01-01T00:00:00Z' ? c.State.StartedAt : null,
    health: health ?? 'none',
    ports,
    networkIds: Object.values(c.NetworkSettings?.Networks ?? {}).map((n) => n.NetworkID),
  };
}

export class DockerodeAdapter implements DockerAdapter {
  private readonly docker: Docker;
  readonly description: string;

  constructor(socketPath: string) {
    // Only the configured socket. No DOCKER_HOST/context inheritance.
    this.docker = new Docker({ socketPath });
    this.description = `unix://${socketPath}`;
  }

  async ping(): Promise<EngineInfo> {
    try {
      const v = await this.docker.version();
      return { available: true, version: v.Version, apiVersion: v.ApiVersion, error: null };
    } catch (e) {
      return { available: false, version: null, apiVersion: null, error: (e as Error).message };
    }
  }

  async listContainers(opts: { all: boolean; labels?: Record<string, string> }): Promise<ContainerInfo[]> {
    const filters: Record<string, string[]> = {};
    if (opts.labels) filters['label'] = Object.entries(opts.labels).map(([k, v]) => `${k}=${v}`);
    const list = await this.docker.listContainers({ all: opts.all, filters: JSON.stringify(filters) });
    const out: ContainerInfo[] = [];
    for (const c of list) {
      const info = await this.inspectContainer(c.Id);
      if (info) out.push(info);
    }
    return out;
  }

  async inspectContainer(id: string): Promise<ContainerInfo | null> {
    try {
      return fromInspect(await this.docker.getContainer(id).inspect());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async startContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).start();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 304) return; // already started
      throw e;
    }
  }

  async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    try {
      await this.docker.getContainer(id).stop({ t: timeoutSeconds });
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 304) return; // already stopped
      throw e;
    }
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await this.docker.getContainer(id).remove({ v: false, force: false });
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
  }

  async listVolumes(labels?: Record<string, string>): Promise<VolumeInfo[]> {
    const filters: Record<string, string[]> = {};
    if (labels) filters['label'] = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
    const res = await this.docker.listVolumes({ filters: JSON.stringify(filters) });
    return (res.Volumes ?? []).map((v) => ({ name: v.Name, labels: v.Labels ?? {}, createdAt: (v as { CreatedAt?: string }).CreatedAt ?? null, driver: v.Driver }));
  }

  async inspectVolume(name: string): Promise<VolumeInfo | null> {
    try {
      const v = await this.docker.getVolume(name).inspect();
      return { name: v.Name, labels: v.Labels ?? {}, createdAt: (v as { CreatedAt?: string }).CreatedAt ?? null, driver: v.Driver };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<VolumeInfo> {
    const v = await this.docker.createVolume({ Name: name, Driver: 'local', Labels: labels });
    const info = v as unknown as { Name: string; Labels?: Record<string, string>; CreatedAt?: string; Driver: string };
    return { name: info.Name, labels: info.Labels ?? {}, createdAt: info.CreatedAt ?? null, driver: info.Driver };
  }

  async inspectNetwork(idOrName: string): Promise<NetworkInfo | null> {
    try {
      const n = await this.docker.getNetwork(idOrName).inspect();
      return { id: n.Id, name: n.Name, labels: n.Labels ?? {}, containerIds: Object.keys(n.Containers ?? {}) };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async removeNetwork(id: string): Promise<void> {
    try {
      await this.docker.getNetwork(id).remove();
    } catch (e) {
      if (isNotFound(e)) return;
      throw e;
    }
  }

  async publishedHostPorts(): Promise<number[]> {
    const list = await this.docker.listContainers({ all: true });
    const ports = new Set<number>();
    for (const c of list) {
      for (const p of c.Ports ?? []) if (p.PublicPort) ports.add(p.PublicPort);
    }
    return [...ports];
  }
}
