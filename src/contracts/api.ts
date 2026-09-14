// API DTOs shared by daemon, CLI and Web UI. Never contain secret values, raw Compose,
// image credentials or provider responses.

export type Desired = 'running' | 'stopped' | 'retained';
export type InstallState = 'installing' | 'installed' | 'failed' | 'needs_action' | 'retained';
export type Runtime = 'running' | 'stopped' | 'starting' | 'unavailable' | 'unknown';
export type Readiness = 'healthy' | 'unhealthy' | 'checking' | 'unknown';
export type OperationState = 'queued' | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'needs_action';
export type PlanKind = 'install' | 'start' | 'stop' | 'remove' | 'reinstall' | 'expose' | 'unexpose' | 'reconfigure';
export type ExposureVia = 'tailnet' | 'public';
export type PrimaryExposure = 'loopback' | ExposureVia;

export interface EndpointDto {
  id: string;
  containerPort: number;
  hostPort: number;
  browserUrl: string; // loopback URL (compatibility)
  urls: { loopback: string; tailnet?: string; public?: string };
  primary: PrimaryExposure;
}

export interface ExposureDto {
  id: string;
  instanceId: string;
  instanceName: string;
  endpointId: string;
  via: ExposureVia;
  url: string;
  hostname: string;
  port: number;
  protection: 'none' | 'basic';
  state: 'pending' | 'active' | 'degraded' | 'removing';
  observedAt: string | null;
  note: string | null;
  isPrimary: boolean;
}

export interface InstanceSummary {
  id: string;
  name: string;
  packageId: string;
  packageName: string;
  icon: string | null; // asset name inside the package; served at /v1/catalog/{packageId}/asset/{icon}
  category: string;
  revision: string;
  desired: Desired;
  installState: InstallState;
  runtime: Runtime;
  readiness: Readiness;
  observedAt: string | null;
  endpoints: EndpointDto[];
  primaryEndpoint: string;
  operationId: string | null;
  hasRetainedData: boolean;
}

export interface EventDto {
  cursor: string; // decimal string of a 64-bit cursor
  at: string;
  phase: string;
  message: string;
}

export interface ResourceDto {
  kind: 'container' | 'volume' | 'network';
  role: string;
  name: string;
  present: boolean | null;
}

export interface InstanceDetail extends InstanceSummary {
  description: string;
  setup: { endpointId: string; browserUrl: string; instructions: string } | null;
  resources: ResourceDto[];
  events: EventDto[];
  lastError: { code: string; message: string; nextAction: string } | null;
}

export interface StorageDto {
  id: string;
  volumeName: string;
  purpose: string;
  state: 'new' | 'existing';
}

export interface PlanDto {
  id: string;
  kind: PlanKind;
  instanceId: string;
  name: string;
  packageId: string;
  revision: string;
  expiresAt: string;
  expectedGeneration: number;
  changes: string[];
  endpoints: EndpointDto[];
  storage: StorageDto[];
  secrets: { id: string; state: 'new' | 'existing' }[];
  warnings: string[];
  exposure?: { endpointId: string; via: ExposureVia; url: string; protection: 'none' | 'basic'; makePrimary: boolean; credentials?: { username: string; password: string } };
}

export interface OperationDto {
  id: string;
  kind: PlanKind;
  instanceId: string;
  planId: string;
  state: OperationState;
  phase: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string; nextAction: string } | null;
  result: Record<string, unknown> | null;
  events: EventDto[];
}

export interface CatalogItemDto {
  id: string;
  name: string;
  description: string;
  revision: string;
  availability: 'available' | 'unavailable';
  reason: string | null;
  qualification: 'passed' | 'blocked' | 'pending' | 'invalid';
  presentation: { tagline: string | null; category: string; icon: string | null; gallery: string[]; developer: string | null; website: string | null; releaseNotes: string | null };
  setup: boolean;
  storage: number;
}

export interface SystemMetricsDto {
  sampledAt: string;
  uptimeSeconds: number;
  cpu: { cores: number; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number };
  disk: { path: string; totalBytes: number; usedBytes: number } | null;
  docker: { available: boolean; version: string | null; containersRunning: number; containersTotal: number };
}

export interface SystemDto {
  version: string;
  profile: 'local-preview';
  docker: { available: boolean; observedAt: string | null; version: string | null; error: string | null };
  busyOperationId: string | null;
  installationId: string;
  managementOrigin: string;
}

export interface PlatformToolDto {
  id: string;
  name: string;
  installationState: 'installed' | 'not_installed' | 'setup_required' | 'unknown';
  availability: 'reachable' | 'unreachable' | 'unknown';
  browserUrl: string | null;
  observedAt: string | null;
  note: string | null;
  mode: 'managed' | 'external' | 'absent';
  // provider facts (tailscale: node dns name / tailnet; proxy: public address) for the UI
  facts?: Record<string, string | boolean | null>;
}

export interface SessionDto {
  token: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; nextAction: string; operationId?: string; details?: string[] };
}

export type PlanRequest =
  | { kind: 'install'; packageId: string; name?: string }
  | { kind: 'start' | 'stop' | 'remove' | 'reinstall'; instanceId: string }
  | { kind: 'expose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string; protection?: 'none' | 'basic'; makePrimary?: boolean }
  | { kind: 'unexpose'; instanceId: string; endpointId?: string; via: ExposureVia }
  | { kind: 'reconfigure'; instanceId: string; primary: PrimaryExposure };

export interface UiExposureDto {
  via: 'tailnet';
  url: string;
  state: 'pending' | 'active' | 'degraded';
  note: string | null;
}
