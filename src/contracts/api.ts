// API DTOs shared by daemon, CLI and Web UI. Never contain secret values, raw Compose,
// image credentials or provider responses.

export type Desired = 'running' | 'stopped' | 'retained';
export type InstallState = 'installing' | 'installed' | 'failed' | 'needs_action' | 'retained';
export type Runtime = 'running' | 'stopped' | 'starting' | 'unavailable' | 'unknown';
export type Readiness = 'healthy' | 'unhealthy' | 'checking' | 'unknown';
export type OperationState = 'queued' | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'needs_action';
export type PlanKind = 'install' | 'start' | 'stop' | 'remove' | 'reinstall' | 'purge' | 'update' | 'expose' | 'unexpose' | 'reconfigure';
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
  // a newer revision of this app's package is available (bundled catalog after a Harbor upgrade, or an uploaded package)
  updateAvailable: { revision: string; version: string | null; releaseNotes: string | null } | null;
  // launcher customisation (Customize… in the app drawer); null = package defaults
  displayName: string | null;
  customIcon: { kind: 'glyph'; glyph: string; color: string } | { kind: 'image'; url: string } | null;
}

export interface EventDto {
  cursor: string; // decimal string of a 64-bit cursor
  at: string;
  phase: string;
  message: string;
}

export interface ResourceDto {
  // bind: an operator-chosen host directory (name = path); never created or deleted by Harbor
  kind: 'container' | 'volume' | 'network' | 'bind';
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
  mode: 'managed' | 'external';
  // managed: the retained Docker volume; external: null
  volumeName: string | null;
  // external: the host directory bound into the container
  hostPath: string | null;
  readOnly: boolean;
  purpose: string;
  state: 'new' | 'existing';
}

export interface StorageClaimDto {
  id: string;
  purpose: string;
  external: { hint: string; required: boolean; readOnly: boolean } | null;
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
  // update plans: what changes between the installed release and the new one
  update?: { fromRevision: string; toRevision: string; fromVersion: string | null; toVersion: string | null; images: { service: string; from: string; to: string }[]; newSecrets: string[]; newStorage: string[]; newEndpoints: string[]; releaseNotes: string | null };
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
  version: string | null;
  origin: 'bundled' | 'local'; // local = uploaded by the operator ("your own apps")
  availability: 'available' | 'unavailable';
  reason: string | null;
  qualification: 'passed' | 'blocked' | 'pending' | 'invalid';
  presentation: { tagline: string | null; category: string; icon: string | null; gallery: string[]; developer: string | null; website: string | null; releaseNotes: string | null };
  setup: boolean;
  storage: number;
  claims: StorageClaimDto[];
}

export interface SystemMetricsDto {
  sampledAt: string;
  uptimeSeconds: number;
  host: { hostname: string; os: string; arch: string; cpuModel: string | null };
  temperatureC: number | null;
  cpu: { cores: number; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number };
  disk: { path: string; totalBytes: number; usedBytes: number } | null;
  docker: { available: boolean; version: string | null; containersRunning: number; containersTotal: number };
}

export interface SystemDto {
  version: string;
  profile: 'local-preview';
  deviceName: string | null; // operator-chosen name for this machine (Settings → Overview); null = use the hostname
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
  | { kind: 'install'; packageId: string; name?: string; storage?: Record<string, { hostPath: string }> }
  | { kind: 'start' | 'stop' | 'remove' | 'reinstall' | 'purge'; instanceId: string }
  | { kind: 'update'; instanceId: string; storage?: Record<string, { hostPath: string }> }
  | { kind: 'expose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string; protection?: 'none' | 'basic'; makePrimary?: boolean }
  | { kind: 'unexpose'; instanceId: string; endpointId?: string; via: ExposureVia }
  | { kind: 'reconfigure'; instanceId: string; primary: PrimaryExposure };

export interface DomainDto {
  hostname: string;
  dns: { state: 'points_here' | 'points_elsewhere' | 'no_record' | 'unknown'; addresses: string[]; checkedAt: string | null; note: string | null };
  // the app published at this hostname, if any
  usedBy: { instanceId: string; instanceName: string; exposureState: string; url: string } | null;
}
export interface DomainsDto {
  publicIp: { v4: string | null; v6: string | null; detectedAt: string | null; error: string | null };
  items: DomainDto[];
}

export interface HostStorageDto {
  dataFolder: { path: string; exists: boolean; writable: boolean };
  mounts: { mountpoint: string; device: string; fsType: string; totalBytes: number | null; usedBytes: number | null; writable: boolean; label: string }[];
  // folders currently used by apps (bind resources), with the instance that uses each
  inUse: { path: string; instanceId: string; instanceName: string; purpose: string; readOnly: boolean }[];
}

export interface FolderListingDto {
  path: string;
  parent: string | null;
  writable: boolean;
  entries: { name: string; path: string; writable: boolean }[];
}

export interface TailscaleLoginDto {
  loginUrl: string | null; // present when the node must be approved in a browser
  status: 'logged_in' | 'login_url' | 'pending';
}

export interface UiExposureDto {
  via: 'tailnet';
  url: string;
  state: 'pending' | 'active' | 'degraded';
  note: string | null;
}

// ---- appearance: wallpaper (uploaded or rotating from a public source), launcher layout
export type WallpaperSource = 'reddit' | 'bing' | 'wikimedia';
export interface WallpaperPictureDto {
  title: string;
  author: string | null;
  sourceName: string; // "r/EarthPorn", "Bing", "Wikimedia Commons"
  link: string | null; // where the picture came from (post/page), for attribution
  fetchedAt: string;
}
export interface RotationDto {
  enabled: boolean;
  source: WallpaperSource;
  subreddits: string[];
  everyHours: number;
  nextAt: string | null;
  lastError: string | null;
  reddit: { clientId: string | null; hasSecret: boolean };
}
export interface AppearanceDto {
  wallpaper: { kind: 'none' | 'uploaded' | 'rotating'; version: string | null; current: WallpaperPictureDto | null };
  rotation: RotationDto;
  home: { order: string[] };
}
export interface RotationPatch {
  enabled?: boolean;
  source?: WallpaperSource;
  subreddits?: string[];
  everyHours?: number;
  reddit?: { clientId: string; clientSecret?: string } | null;
}
export type InstanceAppearancePatch = { displayName?: string | null; icon?: { kind: 'default' } | { kind: 'glyph'; glyph: string; color: string } | { kind: 'image'; dataUrl: string } };
export interface SystemHostDto {
  hostname: string;
  os: string;
  arch: string;
  cpuModel: string | null;
  power: { available: boolean; note: string | null };
}

// ---- your own apps: uploaded packages
export interface PackageImportResultDto {
  item: CatalogItemDto;
  // images Harbor pinned for you at upload time (tag -> digest)
  pinned: { service: string; from: string; to: string }[];
  notes: string[];
  replacedRevision: string | null; // when a package with the same id already existed
  // instances that can now be updated to this package
  updatable: { instanceId: string; name: string; fromRevision: string }[];
}

// ---- account security, logs, terminal
export interface SecurityDto {
  twoFactor: boolean;
  pending: boolean;
}
export interface TotpSetupDto {
  secret: string; // base32, for typing into an authenticator
  otpauthUrl: string; // for the QR code
}
export interface LogsDto {
  source: 'journal' | 'memory' | 'docker';
  lines: string[];
}
export interface InstanceLogsDto {
  containers: { name: string; service: string; lines: string[] }[];
}
// WebSocket /v1/terminal: first client message {type:'auth', token, cols, rows}; then {type:'input', data} /
// {type:'resize', cols, rows}; server sends binary frames (terminal bytes) and JSON {type:'ready'|'exit'|'error'}.
export type TerminalClientMessage = { type: 'auth'; token: string; cols: number; rows: number } | { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
export type TerminalServerMessage = { type: 'ready' } | { type: 'exit'; code: number | null; reason: string } | { type: 'error'; message: string };
