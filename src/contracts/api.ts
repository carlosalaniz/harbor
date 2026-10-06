// API DTOs shared by daemon, CLI and Web UI. Never contain secret values, raw Compose,
// image credentials or provider responses.

export type Desired = 'running' | 'stopped' | 'retained';
export type InstallState = 'installing' | 'installed' | 'failed' | 'needs_action' | 'retained';
export type Runtime = 'running' | 'stopped' | 'starting' | 'unavailable' | 'unknown';
export type Readiness = 'healthy' | 'unhealthy' | 'checking' | 'unknown';
export type OperationState = 'queued' | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'needs_action';
// configure (decisions 125/126): change an installed app's operator-provided secrets and/or link providers.
export type PlanKind = 'install' | 'start' | 'stop' | 'remove' | 'reinstall' | 'purge' | 'update' | 'expose' | 'unexpose' | 'reconfigure' | 'restart' | 'configure' | 'seal' | 'move';
// 'proxy' = published through the operator's own reverse proxy (decision 118); Harbor runs nothing for it.
export type ExposureVia = 'tailnet' | 'public' | 'proxy';
// The address an app treats as its own, chosen at install (decision 116). Omitted = this network
// (HTTPS LAN when on, else LAN, else loopback); tailnet/public publish it in the same operation.
export type InstallMainAddress = { via: 'tailnet' } | { via: 'public'; hostname: string };
export type PrimaryExposure = 'loopback' | 'tailnet' | 'public';

export interface EndpointDto {
  id: string;
  containerPort: number;
  hostPort: number;
  browserUrl: string; // loopback URL (compatibility)
  // lan: present in LAN mode, http://<hostname>.local:<port> (the console swaps in the host it was opened with)
  // lanSecure: present when LAN HTTPS is on, https://<hostname>.local:<port+offset> (same swap)
  urls: { loopback: string; lan?: string; lanSecure?: string; tailnet?: string; public?: string; proxy?: string }; // proxy: your own reverse proxy (decision 118)
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
  // live resource usage summed over the app's containers; null when stopped or not yet sampled
  usage: { cpuPercent: number; memoryBytes: number; sampledAt: string } | null;
  // opt-in automatic updates (decision 78)
  autoUpdate: boolean;
  // drive guard: set when an external folder's identity check fails (drive
  // removed, unmounted, or swapped). The app is stopped; Start is refused
  // until the right folder is back or the operator adopts the new one.
  needsDrive: { path: string; purpose: string; detail: string } | null;
  // install-location apps: the encrypted home on the drive (null = system disk).
  // state locked means this machine cannot read it yet (BFU or foreign drive).
  home: AppHomeDto | null;
  // decision 126: this app's links to other apps (consumer side) and the apps linked to it (provider side)
  links: AppLinkDto[];
  linkedBy: { instanceId: string; name: string; linkId: string; state: AppLinkState }[];
  // decision 125: secrets the operator typed (never their values); set = a value is stored
  operatorSecrets: { id: string; prompt: string; optional: boolean; set: boolean }[];
  // decision 131: not shown on Home (the operator's choice, else the package's presentation.hideFromHome)
  hiddenFromHome: boolean;
  // decision 141: the main endpoint is machine-facing (kind api): addresses to copy, no Open button
  apiOnly: boolean;
}

// ---- app links (decision 126)
// active: the link network exists and both sides are attached; needs_provider: no provider chosen (or it
// was removed); dormant: this app is removed (data kept) and Reinstall brings the link back.
export type AppLinkState = 'active' | 'needs_provider' | 'dormant';
export interface AppLinkDto {
  id: string;
  purpose: string;
  optional: boolean;
  state: AppLinkState;
  provider: { instanceId: string; name: string; endpointId: string } | null;
  alias: string; // <id>-link: the name the provider answers to on the link network
  network: string; // Docker network name (Harbor-owned)
  url: string | null; // what the app's variable receives in url format (http://<alias>:<port>); null without a provider
  note: string | null;
}
// Settings → Internal networks: every link on this machine.
export interface LinkDto extends AppLinkDto {
  consumer: { instanceId: string; name: string };
}
// A provider for one link, chosen at install / configure / update (CLI: --link <id>=<instance>[/<endpoint>]).
export interface LinkChoice {
  instanceId: string;
  endpointId?: string;
}

// Volume disk usage grouped per app (GET /v1/system/storage/usage; docker system df, cached).
export interface StorageUsageDto {
  sampledAt: string;
  apps: { instanceId: string; name: string; volumes: { id: string; volumeName: string; sizeBytes: number }[]; totalBytes: number }[];
  unownedBytes: number; // volumes on the engine that no Harbor instance owns
}

// ---- LAN HTTPS (decision 109): the local CA + secure addresses. The CA
// cert itself is public key material (trusting it is the whole point), so it
// is served openly; the private key never leaves <stateDir>/tls (0600).
export interface NetworkHttpsDto {
  enabled: boolean;
  url: string | null; // https://harbor.local/ when on (console)
  fingerprint: string | null; // SHA-256 of the CA cert, for the "compare on the device" step
  expiresAt: string | null; // server cert notAfter
  hosts: string[]; // names the server cert covers
  // Decision 116: apps whose only HTTPS address is the secure LAN one (they stop working when it is
  // turned off), and running apps that must be restarted to pick up a change of addresses.
  // (only on GET/PUT /v1/network/https; the system DTO's copy omits them)
  breaksWhenOff?: string[];
  restartToApply?: string[];
}

// Main-address choices available right now (decision 116): only what is set up appears.
export interface AddressOptionsDto {
  local: { kind: 'https' | 'http' | 'loopback'; host: string }; // "this network"
  tailnet: { hostname: string } | null; // Tailscale running with HTTPS certificates
  domains: string[]; // registered domains that point at this machine
}

// ---- notifications (decision 77)
export interface NotificationDto {
  link: string | null; // console route to fix it (decision 122), e.g. #/settings/storage
  id: string;
  createdAt: string;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  instanceId: string | null;
  read: boolean;
}
export interface NotificationsDto {
  items: NotificationDto[];
  unread: number;
}
// ---- Home widgets (decision 81): proxied app JSON, metrics or list
export type WidgetDto = { kind: 'metrics'; items: { label: string; value: string; unit?: string }[] } | { kind: 'list'; items: { title: string; subtitle?: string }[] };

// ---- git package sources (decision 80)
export interface PackageSourceDto {
  id: string;
  kind: 'git';
  url: string;
  ref: string;
  subpath: string | null;
  packageId: string;
  pinnedCommit: string | null;
  lastSeenCommit: string | null;
  autoRedeploy: boolean;
  createdAt: string;
  checkedAt: string | null;
  note: string | null;
  // a newer commit exists on the branch than the imported one
  updateAvailable: boolean;
}
export interface AddSourceResult {
  source: PackageSourceDto;
  import: PackageImportResultDto;
}

// External delivery channels; secrets stay server-side (the GET returns them redacted).
export type NotificationChannelDto =
  | { kind: 'ntfy'; server: string; topic: string; token?: string; minSeverity?: 'info' | 'warning' | 'error' }
  | { kind: 'webhook'; url: string; secret?: string; minSeverity?: 'info' | 'warning' | 'error' }
  | { kind: 'email'; smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string }; from: string; to: string; minSeverity?: 'info' | 'warning' | 'error' };

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
  defaultCredentials: { username: string; password: string; note: string | null } | null;
  resources: ResourceDto[];
  events: EventDto[];
  lastError: { code: string; message: string; nextAction: string } | null;
}

export interface StorageDto {
  id: string;
  mode: 'managed' | 'external' | 'home';
  // managed/home: the retained Docker volume; external: null
  volumeName: string | null;
  // external: the host directory bound into the container
  hostPath: string | null;
  readOnly: boolean;
  purpose: string;
  state: 'new' | 'existing';
}

// Where the whole app lives (install-location): the app home on the drive plus
// whether this machine currently holds it unlocked.
export interface AppHomeDto {
  path: string; // the app home folder, e.g. /mnt/photos/harbor-apps/immich
  encrypted: true;
  // locked: this machine cannot read the vault (BFU, or a foreign machine).
  // unlocked: the machine key opened it silently. The passphrase is never exposed.
  state: 'locked' | 'unlocked';
  // defaultKey: sealed with Harbor's own key (data folder, no custom
  // passphrase). A locked default-key home unlocks at the next login — the
  // drawer says "log in again", never "type the passphrase".
  defaultKey?: true;
  // silentUnlock: this machine holds a wrapping of the app key under its own
  // (login-sealed) machine key — default-key homes always, custom-passphrase
  // homes when the passphrase equals the Harbor password. Such a home
  // unlocks at login without typing; its own passphrase still works too.
  silentUnlock: boolean;
  // sealed: <home>/volumes is fscrypt-encrypted in the kernel, so `locked`
  // means ciphertext names + ENOKEY for every reader, Docker included.
  // false only for homes installed before sealing worked: the next Start
  // seals their data in place (one-time migration).
  sealed: boolean;
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
  // install-location plans: where the whole app will live (null = system disk)
  location: { dir: string; encrypted: true } | null;
  // decision 125: source operator = the submission carries the value (ask: required/optional); never a value here
  secrets: { id: string; state: 'new' | 'existing'; source: 'generated' | 'operator'; prompt: string | null; optional: boolean; minLength: number | null; maxLength: number | null; ask: 'required' | 'optional' | null }[];
  // decision 126: links this plan sets up or changes
  links: { id: string; purpose: string; optional: boolean; provider: { instanceId: string; name: string; endpointId: string; url: string } | null; alias: string; network: string; change: 'set' | 'keep' | 'clear' }[];
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
  requiresHttps: boolean; // decision 116: needs an HTTPS main address in LAN mode
  presentation: { tagline: string | null; category: string; icon: string | null; gallery: string[]; developer: string | null; website: string | null; releaseNotes: string | null; hasWidget: boolean };
  // apps that ship with a fixed login (not generated by Harbor); shown with a "change it" warning
  defaultCredentials: { username: string; password: string; note: string | null } | null;
  setup: boolean;
  storage: number;
  claims: StorageClaimDto[];
  // decision 125: values the install asks the operator for
  operatorSecrets: { id: string; prompt: string; optional: boolean; minLength: number | null; maxLength: number | null }[];
  // decision 126: other apps this one talks to privately (the install picks a provider for each)
  links: { id: string; purpose: string; optional: boolean; packages: string[] | null; endpoint: string | null }[];
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
  hostname: string;
  lan: { enabled: boolean; url: string | null }; // http://<hostname>.local[:port] when LAN mode is on
  // LAN HTTPS (decision 109): off by default; when on, the console answers at
  // https://harbor.local/ (plus <hostname>.local) with a Harbor-minted local
  // CA the operator trusts once per device. Apps get one secure address each.
  network: {
    https: { enabled: boolean; url: string | null; fingerprint: string | null; expiresAt: string | null; hosts: string[] };
  };
  update: SelfUpdateStatusDto;
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
  // one-click install from the console (cockpit/portainer only): the root oneshot's progress
  install?: { state: 'requested' | 'installing' | 'succeeded' | 'failed'; message: string; at: string } | null;
}

export interface SessionDto {
  token: string;
  expiresAt: string;
}

export interface SessionInfoDto {
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  kind: 'session' | 'remember';
  current: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; nextAction: string; operationId?: string; details?: string[] };
}

export interface InstallLocationRequest {
  // Package directory that will hold this app's home, e.g.
  // /mnt/photos/harbor-apps/immich. The app home (<dir>/<instance-name>/
  // {manifest.json, vault/}) is created inside it at apply time (decision 97:
  // enforced <candidate>/<packageId> nesting; the instance name is not part
  // of the dir because the unique -2 suffix is only known at plan time).
  dir: string;
  // Encrypt the whole app home. Required for removable drives (the drive is
  // portable, so its contents must be sealed); optional for the Harbor data
  // folder (the system disk is not portable, so the default is Harbor's own
  // key — silent unlock, no passphrase to remember). Shown once at install;
  // a custom passphrase (or recovery key) is the only way to adopt on
  // another machine.
  passphrase?: string;
}
export type PlanRequest =
  | { kind: 'install'; packageId: string; name?: string; storage?: Record<string, { hostPath: string }>; location?: InstallLocationRequest; main?: InstallMainAddress; links?: Record<string, LinkChoice> }
  | { kind: 'start' | 'stop' | 'restart' | 'remove' | 'reinstall' | 'purge'; instanceId: string }
  | { kind: 'update'; instanceId: string; storage?: Record<string, { hostPath: string }>; links?: Record<string, LinkChoice> }
  // decisions 125/126: secrets listed in `secrets` are replaced by the values the submission carries;
  // links: a provider per link id, or null to unlink an optional one
  | { kind: 'configure'; instanceId: string; secrets?: string[]; links?: Record<string, LinkChoice | null> }
  | { kind: 'expose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string; protection?: 'none' | 'basic'; makePrimary?: boolean; proxyFrom?: string }
  // decision 127: hostname picks one of several public names (required when there are several)
  | { kind: 'unexpose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string }
  // decision 127: with primary public, hostname names the main public name (default: the first published)
  | { kind: 'reconfigure'; instanceId: string; primary: PrimaryExposure; hostname?: string }
  // decision 142: move an app's plain Docker volumes into a sealed home in the Harbor data folder, in place
  | { kind: 'seal'; instanceId: string }
  // decision 145: move an encrypted app's home to another install location (<candidate>/<package>), keeping its key
  | { kind: 'move'; instanceId: string; location: { dir: string } };

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

export interface InstallCandidateDto {
  dir: string; // existing directory that can hold app homes, e.g. /mnt/photos/harbor-apps
  label: string; // plain-words name for the picker
  fsType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  writable: boolean;
  // Only POSIX filesystems qualify for app homes (a database on exFAT/NTFS is
  // corruption, not portability). Non-qualifying candidates carry the reason.
  eligible: boolean;
  reason: string | null;
}

export interface HostStorageDto {
  dataFolder: { path: string; exists: boolean; writable: boolean };
  mounts: { mountpoint: string; device: string; fsType: string; totalBytes: number | null; usedBytes: number | null; writable: boolean; label: string }[];
  // removable block devices (USB sticks, external drives), mounted or not
  devices: {
    name: string; device: string; size: string; fsType: string | null; label: string | null; uuid: string | null; removable: boolean; mounted: boolean; mountpoint: string | null;
    // decision 122: who mounted it, and whether it needs the operator ('foreign' = a desktop mount Harbor
    // cannot write; 'unmounted' = plugged in, not mounted); dismissed = hidden until the condition changes
    mountedBy: 'harbor' | 'other' | null;
    attention: 'foreign' | 'unmounted' | null;
    dismissed: boolean;
  }[];
  // folders currently used by apps (bind resources), with the instance that uses each
  inUse: { path: string; instanceId: string; instanceName: string; purpose: string; readOnly: boolean }[];
  // removable-drive behaviour: auto-mount on insert, and auto-start apps whose
  // drive came back (both on; the drive guard still stops apps on return).
  storagePolicy: { autoMount: boolean; autoStart: boolean };
  // install locations: existing folders that can hold whole encrypted apps
  installCandidates: InstallCandidateDto[];
}

// Portable app homes found on mounted drives but not adopted by this machine
// (foreign or locked). The console shows them as locked tiles; adopting one
// prompts for the encryption passphrase.
export interface FoundAppDto {
  home: string; // app home folder, e.g. /mnt/photos/harbor-apps/immich
  name: string; // folder name (display fallback)
  displayName: string;
  packageId: string;
  packageRevision: string;
  instanceId: string;
  drive: string; // mountpoint the home was found under
  adopted: boolean; // this machine already has an instance for it
  error: string | null; // manifest unreadable (corrupt home)
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
export type InstanceAppearancePatch = { displayName?: string | null; hidden?: boolean; icon?: { kind: 'default' } | { kind: 'glyph'; glyph: string; color: string } | { kind: 'image'; dataUrl: string } };
export interface SystemHostDto {
  hostname: string;
  os: string;
  arch: string;
  cpuModel: string | null;
  power: { available: boolean; note: string | null };
}

// ---- diagnostics bundle for beta testers (`harbor diagnostics`): versions,
// host facts, redacted instance summary, disk/mounts. Never carries secrets,
// tokens, passphrases, credentials, or provider responses — safe to paste
// into a bug report.
export interface DiagnosticsDto {
  sampledAt: string;
  version: string;
  installationId: string;
  host: { hostname: string; os: string; arch: string; cpuModel: string | null };
  lan: { enabled: boolean; url: string | null };
  docker: { available: boolean; observedAt: string | null; version: string | null; error: string | null };
  update: { current: string; available: boolean; latest: string | null; checkedAt: string | null; error: string | null };
  storagePolicy: { autoMount: boolean; autoStart: boolean };
  counts: { instances: number; exposures: number; domains: number; packageSources: number; notificationsUnread: number };
  instances: { name: string; packageId: string; revision: string; installState: string; desired: string; runtime: string; readiness: string; needsDrive: string | null; home: string | null; updateAvailable: string | null }[];
  exposures: { instanceName: string; endpointId: string; via: string; state: string; isPrimary: boolean }[];
  mounts: { mountpoint: string; fsType: string; totalBytes: number | null; usedBytes: number | null }[];
  devices: { name: string; mounted: boolean; mountpoint: string | null; fsType: string | null; size: string }[];
  logTail: { source: string; lines: string[] };
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

// ---- Harbor's own updates (GitHub Releases)
export interface SelfUpdateStatusDto {
  current: string;
  latest: { version: string; publishedAt: string | null; notes: string | null; url: string | null } | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  // set while (or after) an update runs; written by the root apply step, so it survives the daemon restart.
  // 'rolled-back' means the new release failed and the previous one was restored (the console is back).
  applying: { version: string; state: 'requested' | 'downloading' | 'installing' | 'succeeded' | 'failed' | 'rolled-back'; message: string; at: string } | null;
}

// ---- first-run setup (no administrator yet)
export interface SetupStatusDto {
  needed: boolean;
  hostname: string;
  deviceName: string | null;
  lan: { enabled: boolean; url: string | null };
  tailscale: { installed: boolean; loggedIn: boolean };
  version: string;
}
export interface SetupResultDto {
  token: string;
  expiresAt: string;
  // The Harbor recovery key: 12 words, shown once by the wizard and never
  // again. It opens every app this Harbor encrypts, on any machine.
  recoveryKey: string;
}
export interface SetupRequest {
  code: string; // the setup code printed by the installer
  username: string;
  password: string;
  deviceName?: string;
  displayName?: string; // what Home calls you ("Good evening, Carlos"); defaults to the username
}

// ---- account security, logs, terminal
export interface SecurityDto {
  username: string; // the login name (never shown in the Home greeting when a display name is set)
  displayName: string | null; // what Home greets ("Carlos"); null = fall back to the username
  twoFactor: boolean;
  pending: boolean;
  // The Harbor recovery key: when it was issued, never the words themselves.
  // Null on an installation that predates it; the next encrypted install
  // mints one and shows it once.
  recoveryKey: { createdAt: string } | null;
}
export interface RecoveryKeyRotationDto {
  recoveryKey: string; // the new 12 words, shown once
  // App homes re-stamped with the new card, and the ones that could not be
  // reached (drive unplugged): those keep opening with the OLD card.
  restamped: string[];
  unreachable: string[];
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
