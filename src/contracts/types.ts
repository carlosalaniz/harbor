// Runtime types matching the JSON Schemas. Kept by hand and checked by tests
// (schema validation of fixtures + TypeScript compile of the same fixtures).

export type ServiceRole = 'application' | 'infrastructure';

export interface Manifest {
  apiVersion: 'harbor/v1alpha1';
  kind: 'Application';
  metadata: { id: string; name: string; description: string };
  release: { revision: string; version?: string; minHarbor?: string };
  deployment: { compose: 'compose.yaml'; multiInstance: boolean; services: Record<string, ServiceRole> };
  endpoints: Record<string, ManifestEndpoint>;
  ports?: Record<string, ManifestPort>; // decision 163
  permissions?: Record<string, ManifestPermission[]>; // decision 163
  network?: { internet?: InternetMode }; // decision 185
  health: { endpoint: string; path: string; expectedStatus: number[]; timeoutSeconds: number; deadlineSeconds: number };
  ui: { primaryEndpoint: string };
  storage?: StorageClaim[];
  secrets?: SecretClaim[];
  configuration?: ConfigurationBinding[];
  links?: LinkClaim[];
  settings?: ManifestSetting[]; // decision 180
  setup?: { endpoint: string; instructions: string };
  presentation?: PackagePresentation;
  defaultCredentials?: { username: string; password: string; note?: string };
  // Harbor provisions the admin account at first install (decision 79): a generated
  // password (and username unless fixed) is injected via env vars on `service`,
  // shown once in the operation result and retained as instance secrets.
  provisionedCredentials?: { service: string; passwordEnv: string; usernameEnv?: string; username?: string; note?: string; label?: string };
  // Decision 116: run inside `service` after every start/publish/unpublish with the app's current
  // addresses (HARBOR_ADDRESSES, HARBOR_PROXIES, HARBOR_URL) in the environment.
  hooks?: { afterStart?: AfterStartHook };
}

export interface AfterStartHook {
  service: string;
  user?: string;
  command: string[];
  timeoutSeconds?: number;
}

export type PackageCategory = 'productivity' | 'media' | 'files' | 'automation' | 'network' | 'developer' | 'ai' | 'security' | 'finance' | 'home' | 'other';
export interface PackagePresentation {
  tagline?: string;
  category?: PackageCategory;
  icon?: string;
  gallery?: string[];
  developer?: string;
  website?: string;
  source?: string;
  releaseNotes?: string;
  sizeHint?: string; // decision 148: plain-words disk need for the install page
  // Home widget (decision 81): JSON the app serves on its own port, proxied by the daemon.
  widget?: { endpoint: string; path: string; kind: 'metrics' | 'list'; refreshSeconds?: number };
  // decision 131: suggest hiding the app from Home (helpers without a page of their own); the operator decides
  hideFromHome?: boolean;
}

// Decision 163: a fixed host port published on every interface (no proxy, no URL)
export interface ManifestPort {
  service: string;
  containerPort: number;
  hostPort: number;
  protocol: 'udp';
  purpose: string;
}
// Decision 179: gpu = this machine's graphics card (Harbor renders the device access from host facts)
export type ManifestPermission = 'net-admin' | 'tun' | 'ip-forwarding' | 'gpu' | 'privileged' | 'binder';
// Decision 184: how an app reaches the internet (direct, only through Harbor's VPN tunnel, or not at all)
export type InternetMode = 'direct' | 'vpn' | 'offline';


// Decision 179: what the GpuObserver found on this machine; a planner input (the planner never probes the host).
// nvidia: an NVIDIA card Docker can hand to a container (driver + NVIDIA container toolkit). dri: an Intel/AMD
// render node (/dev/dri/renderD*; an nvidia-drm node does not count): only that node and its group reach the
// container (never the card's primary node, so no display/KMS access). none: the app runs on the CPU.
// problem (informational): NVIDIA_TOOLKIT_MISSING = an NVIDIA card is present, but the NVIDIA container toolkit is
// not installed; NVIDIA_DOCKER_RESTART_NEEDED = the toolkit is installed, but Docker has not restarted since, so it
// cannot hand the card over yet.
// Decision 181 (0.34.1; checked before the toolkit, read-only: Harbor never installs drivers):
// NVIDIA_DRIVER_MISSING = an NVIDIA card is on the PCI bus (not bound to vfio-pci/pci-stub) but no NVIDIA driver runs;
// NVIDIA_REBOOT_NEEDED = the running driver's (driverVersion) libraries are gone and another version (libraryVersion)
// is installed: apt updated it, the machine has not restarted since; NVIDIA_DRIVER_TOO_OLD = a note on a usable card
// (kind nvidia): the running driver is older than 525, so images built on CUDA 12 or newer cannot use it.
export type GpuProblem = 'NVIDIA_TOOLKIT_MISSING' | 'NVIDIA_DOCKER_RESTART_NEEDED' | 'NVIDIA_DRIVER_MISSING' | 'NVIDIA_REBOOT_NEEDED' | 'NVIDIA_DRIVER_TOO_OLD';
export interface HostGpu {
  kind: 'nvidia' | 'dri' | 'none';
  problem?: GpuProblem;
  driverVersion?: string; // decision 181: the running NVIDIA kernel module, e.g. 595.99.02
  libraryVersion?: string; // decision 181: the installed NVIDIA userspace driver (libnvidia-ml.so.<version>): the running one's when installed, else the newest
  renderNode?: string; // dri: the render node's name, e.g. renderD128
  renderGid?: number;
  detail: string; // "NVIDIA GeForce RTX 3090", "Intel graphics", "No graphics card found"
}

export interface ManifestEndpoint {
  service: string;
  containerPort: number;
  scheme: 'http';
  exposure: 'direct';
  browserContext: 'secure' | 'ordinary';
  httpsRequired?: boolean; // decision 116: unusable over plain http; needs an HTTPS main address in LAN mode
  kind?: 'web' | 'api'; // decision 141: api = no Open button (addresses only)
  cookies?: 'isolated' | 'shared'; // decision 167: shared = the relay leaves this endpoint's own cookies untagged
}

export interface StorageClaim {
  id: string;
  composeVolume: string;
  purpose: string;
  retention: 'retain';
  // present when the operator may bind the claim to a host directory ("bring your own folder")
  external?: { hint: string; required?: boolean; readOnly?: boolean };
}
export interface SecretClaim {
  id: string;
  // decision 125: 'operator' = the operator types the value at install (prompt shown); default 'generated'
  source?: 'generated' | 'operator';
  bytes?: 32; // generated only
  encoding?: 'hex'; // generated only
  prompt?: string; // operator only
  optional?: boolean; // operator only: install may proceed without it (the variable is then not set)
  minLength?: number; // operator only
  maxLength?: number; // operator only (default 4096)
  retention: 'retain';
  showOnce?: string; // generated only (decision 138): label of a value shown to the operator once
  // template (decision 139): a literal with one {{value}}; encode url percent-encodes the value first
  bindings: { service: string; environment: string; template?: string; encode?: 'url' }[];
}
export function isOperatorSecret(s: SecretClaim): boolean {
  return s.source === 'operator';
}

// Decision 126: a private link to another installed app (the provider), resolved at install.
export type LinkFormat = 'url' | 'authority' | 'host' | 'port';
export interface LinkClaim {
  id: string;
  purpose: string;
  optional?: boolean;
  provider?: { packages?: string[]; endpoint?: string };
  bindings: { service: string; environment: string; format?: LinkFormat }[];
}
// Decision 180: a typed, non-secret value the operator can see and change (install review → Options, app page →
// Settings → Change…). Rendered as environment literals of the bound services; the default comes from the release.
export type SettingType = 'integer' | 'number' | 'boolean' | 'string' | 'choice';
export type SettingValue = string | number | boolean;
export interface ManifestSetting {
  id: string;
  label: string;
  help?: string;
  type: SettingType;
  default: SettingValue;
  min?: number; // integer/number only
  max?: number; // integer/number only
  maxLength?: number; // string only (default 256)
  choices?: { value: string; label?: string }[]; // choice only
  onValue?: string; // boolean only (default "true")
  offValue?: string; // boolean only (default "false")
  // template: a literal with one {{value}} where the value goes (same rules as secret templates)
  bindings: { service: string; environment: string; template?: string }[];
}
export type ConfigurationFormat = 'url' | 'origin' | 'authority' | 'host' | 'scheme';
export interface ConfigurationBinding { service: string; environment: string; endpoint: string; format?: ConfigurationFormat }

export interface ComposeSourceService {
  // image XOR build (decision 80): built services exist only in git-sourced packages;
  // Harbor builds them locally and pins provenance by the commit SHA.
  image?: string;
  build?: { context: string; dockerfile?: string };
  command?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: 'service_started' | 'service_healthy' }>;
  healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string; disable?: true };
  volumes?: { type: 'volume'; source: string; target: string; read_only?: boolean }[];
}
export interface ComposeSource {
  services: Record<string, ComposeSourceService>;
  volumes?: Record<string, Record<string, never>>;
}

export interface ReleaseImage {
  reference: string;
  repository: string;
  tag: string;
  platform: 'linux/amd64';
  platformDigest: string;
  appVersion?: string;
  imageCreated?: string;
  source?: string;
}
export interface ReleaseInventory {
  schemaVersion: 1;
  package: { id: string; revision: string };
  files: Record<'manifest.yaml' | 'compose.yaml' | 'README.md', { sha256: string }>;
  assets?: Record<string, { sha256: string }>;
  images: Record<string, ReleaseImage>;
  // services built from a git source (decision 80): provenance = the commit
  builds?: Record<string, { context: string; dockerfile?: string; commit: string; tag: string }>;
  qualification: {
    status: 'passed' | 'blocked' | 'pending';
    date: string;
    node?: string;
    dockerEngine?: string;
    dockerCompose?: string;
    hostOs?: string;
    appVersions?: Record<string, string>;
    notes: string[];
  };
}

export interface CatalogIndex {
  schemaVersion: 1;
  packages: Record<string, { revision: string; dir: string; minHarbor?: string }>;
}

export interface LoadedPackage {
  id: string;
  revision: string;
  dir: string;
  manifest: Manifest;
  compose: ComposeSource;
  release: ReleaseInventory;
  readme: string;
  raw: { manifest: Buffer; compose: Buffer; readme: Buffer; release: Buffer };
  hashes: Record<'manifest.yaml' | 'compose.yaml' | 'README.md', string>;
  // presentation assets (icon, gallery) verified against release.json `assets`
  assets: Record<string, Buffer>;
}
