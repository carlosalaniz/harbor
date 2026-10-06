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
  // where the engine keeps the data (root-only on a real host); `harbor seal` hands it to the root step
  mountpoint?: string | null;
}

export interface NetworkInfo {
  id: string;
  name: string;
  labels: Record<string, string>;
  containerIds: string[];
  // IPAM gateways: where a published port's loopback traffic (Caddy, tailscale serve, the LAN HTTPS proxy)
  // appears to come from inside the app network — what an app's trusted-proxy list must name.
  gateways: string[];
}

// One command run inside a running container (package `afterStart` hooks, decision 116).
export interface ExecResult {
  exitCode: number | null;
  output: string; // stdout+stderr, tail-capped
  timedOut: boolean;
}

export interface EngineInfo {
  available: boolean;
  version: string | null;
  apiVersion: string | null;
  error: string | null;
}

// One-shot resource usage of a running container (no stream; the stats API's precpu
// field provides the two samples a CPU percentage needs).
export interface ContainerStats {
  cpuPercent: number; // 0..(100 * cores)
  memoryBytes: number;
  memoryLimitBytes: number;
}

// Volume disk usage (docker system df -v equivalent). Expensive: callers must cache.
export interface DockerDiskUsage {
  volumes: { name: string; sizeBytes: number }[];
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
  createVolume(name: string, labels: Record<string, string>, opts?: { driverOpts?: Record<string, string> }): Promise<VolumeInfo>;
  // Only ever called for a volume whose ownership labels were verified moments before (full uninstall).
  removeVolume(name: string): Promise<void>;
  listNetworks(labels?: Record<string, string>): Promise<NetworkInfo[]>;
  inspectNetwork(idOrName: string): Promise<NetworkInfo | null>;
  removeNetwork(id: string): Promise<void>;
  // App links (decision 126): Harbor creates the link network itself (internal: no route out, no published
  // ports), attaches the other side live (so the provider is not restarted), and detaches before removal.
  createNetwork(name: string, labels: Record<string, string>, opts: { internal: boolean }): Promise<NetworkInfo>;
  connectNetwork(networkId: string, containerId: string, aliases: string[]): Promise<void>;
  disconnectNetwork(networkId: string, containerId: string): Promise<void>;
  // Host ports published by any container on this engine (for allocation conflict checks).
  publishedHostPorts(): Promise<number[]>;
  // Last N log lines of one container (stdout+stderr, timestamps), for the Troubleshoot page.
  containerLogs(id: string, tail: number): Promise<string>;
  // One-shot usage sample; null when the container is not running or stats are unsupported.
  containerStats(id: string): Promise<ContainerStats | null>;
  // Volume sizes (docker system df). Expensive; callers cache (observer never calls this).
  diskUsage(): Promise<DockerDiskUsage>;
  // Run a command inside a running container; never through a shell on the host.
  exec(id: string, opts: { cmd: string[]; user?: string; env?: Record<string, string>; timeoutMs: number }): Promise<ExecResult>;
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
  // forceRecreate: Restart (decision 116) recreates every container so new configuration applies.
  up(inv: ComposeInvocation, timeoutMs: number, opts?: { forceRecreate?: boolean }): Promise<ComposeResult>;
  start(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult>;
  // docker build for git-sourced services (decision 80). onLog receives progress lines.
  build(opts: { contextDir: string; dockerfile: string; tag: string; timeoutMs: number; onLog?: (line: string) => void }): Promise<void>;
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
