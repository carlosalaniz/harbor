// Narrow Docker boundary. Only adapters perform I/O; everything above them is data in, data out.

export interface PortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  labels: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  ports: PortBinding[];
  networkIds: string[];
}

export interface VolumeInfo {
  name: string;
  labels: Record<string, string>;
  createdAt: string | null;
  driver: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  containerIds: string[];
}

export interface EngineInfo {
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  error: string | null;
}

export interface DockerAdapter {
  readonly description: string;
  ping(): Promise<EngineInfo>;
  listContainers(opts: { all: boolean; labels?: Record<string, string> }): Promise<ContainerInfo[]>;
  inspectContainer(id: string): Promise<ContainerInfo | null>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
  listVolumes(labels?: Record<string, string>): Promise<VolumeInfo[]>;
  inspectVolume(name: string): Promise<VolumeInfo | null>;
  createVolume(name: string, labels: Record<string, string>): Promise<VolumeInfo>;
  inspectNetwork(idOrName: string): Promise<NetworkInfo | null>;
  removeNetwork(id: string): Promise<void>;
  // Host ports published by any container on this engine (for allocation conflict checks).
  publishedHostPorts(): Promise<number[]>;
}

export interface ComposeInvocation {
  projectDir: string;
  projectName: string;
  file: string; // absolute path to compose file
}

export interface ComposeResult {
  stdout: string;
  stderr: string;
}

export interface ComposeRunner {
  readonly description: string;
  version(): Promise<string | null>;
  // Non-mutating canonical validation. Returns the canonical YAML.
  config(inv: ComposeInvocation, timeoutMs: number): Promise<string>;
  pull(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult>;
  up(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult>;
  start(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult>;
}

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly detail: { command: string[]; exitCode: number | null; stderrTail: string; timedOut: boolean },
  ) {
    super(message);
    this.name = 'ComposeError';
  }
}
