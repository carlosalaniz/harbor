// API DTOs shared by daemon, CLI and Web UI. Never contain secret values, raw Compose,
// image credentials or provider responses.

export type Desired = 'running' | 'stopped' | 'retained';
export type InstallState = 'installing' | 'installed' | 'failed' | 'needs_action' | 'retained';
export type Runtime = 'running' | 'stopped' | 'starting' | 'unavailable' | 'unknown';
export type Readiness = 'healthy' | 'unhealthy' | 'checking' | 'unknown';
// cancelled (decision 183): a waiting item cancelled before it started, or never started before a daemon restart.
export type OperationState = 'queued' | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'needs_action' | 'cancelled';
// configure (decisions 125/126/180): change an installed app's operator-provided secrets, link providers and/or settings.
// backup/restore (decisions 151, 153): the cold pass of a backup run, and restoring an app in place.
export type PlanKind = 'install' | 'start' | 'stop' | 'remove' | 'reinstall' | 'purge' | 'update' | 'expose' | 'unexpose' | 'reconfigure' | 'restart' | 'configure' | 'seal' | 'move' | 'backup' | 'restore' | 'relink';
// Decision 183: kinds that may be queued as an action without a plan (`POST /v1/operations {action}`); Harbor plans
// them when their turn comes. They take no typed values, so a queued action never holds a secret.
export const QUEUEABLE_KINDS = ['start', 'stop', 'restart', 'update', 'remove', 'reinstall', 'purge'] as const;
export type QueueableKind = (typeof QUEUEABLE_KINDS)[number];
// The actor names Harbor itself writes on plans and operations (background work nobody clicked). A session's actor
// is the login name, so a person must never be able to log in under one of these (decision 183: a guard's item is
// not cancellable and an auto-update's refusal rings the bell, both decided by the actor name). A person's queued
// action never merges into an item of one of these actors (decision 183 dedupe); the console reads the same list.
// vpn-policy (decision 184): the restarts that move running apps' DNS when every-app VPN is switched
export const INTERNAL_ACTORS = ['drive-guard', 'link-guard', 'lock-guard', 'scheduler', 'auto-update', 'git-source', 'tailnet-policy', 'vpn-policy'] as const;
export type InternalActor = (typeof INTERNAL_ACTORS)[number];
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

// Decision 163: a fixed host port published on every interface (a VPN tunnel port); no URL, no proxy
export interface FixedPortDto {
  id: string;
  service: string;
  protocol: 'udp';
  hostPort: number;
  containerPort: number;
  purpose: string;
}
// Decision 163: a privilege the operator accepts when approving (label: what it lets the app do)
export interface PermissionDto {
  service: string;
  permission: 'net-admin' | 'tun' | 'ip-forwarding' | 'gpu' | 'privileged' | 'binder'; // privileged + binder: decision 193
  label: string;
}
// Decision 179: the graphics card this machine offers apps that ask for `gpu` (never group ids or paths).
// problem (informational, never a refusal): NVIDIA_TOOLKIT_MISSING = an NVIDIA card is present, but Docker cannot
// use it until the operator installs the NVIDIA container toolkit; NVIDIA_DOCKER_RESTART_NEEDED = the toolkit is
// installed, but Docker has not restarted since. With kind dri, the problem is about an NVIDIA card next to the
// Intel/AMD graphics the app uses.
// Decision 181 (0.34.1, checked first; Harbor never installs drivers): NVIDIA_DRIVER_MISSING = an NVIDIA card is on
// the PCI bus (not one bound to vfio-pci/pci-stub for a VM) but no NVIDIA driver runs (libraryVersion present: its
// files are installed, it is not loaded); NVIDIA_REBOOT_NEEDED = the running driver's (driverVersion) libraries are
// gone and another version (libraryVersion) is installed: the machine has not restarted since the update;
// NVIDIA_DRIVER_TOO_OLD = a NOTE with kind nvidia (the card is handed over): the running driver is older than 525, so
// CUDA 12 images cannot use it. driverVersion / libraryVersion: absent when unknown (and from daemons before 0.34.1).
export interface GpuDto {
  kind: 'nvidia' | 'dri' | 'none';
  detail: string;
  problem?: 'NVIDIA_TOOLKIT_MISSING' | 'NVIDIA_DOCKER_RESTART_NEEDED' | 'NVIDIA_DRIVER_MISSING' | 'NVIDIA_REBOOT_NEEDED' | 'NVIDIA_DRIVER_TOO_OLD';
  driverVersion?: string;
  libraryVersion?: string;
}

// Decision 180: a setting the operator can change (not a secret: values appear in plans, events and logs).
// value = the effective value (the operator's override, else the current release's default); overridden = an
// override is stored. min/max: integer/number; maxLength: string; choices: choice.
export type SettingValue = string | number | boolean;

// ---- VPN and offline apps (decision 184)
export type InternetMode = 'direct' | 'vpn' | 'offline';
export interface InternetDto {
  // what the app runs with now ("every app through the VPN" applied)
  mode: InternetMode;
  // the operator's choice; null = follows the package's default
  choice: InternetMode | null;
  // the package's network.internet (direct when it says nothing)
  packageDefault: InternetMode;
  // every app goes through the VPN (turns direct into vpn)
  allApps: boolean;
}
export interface VpnDto {
  // this machine can load the firewall (nftables); tunnelAvailable: and bring up WireGuard
  available: boolean;
  tunnelAvailable: boolean;
  reason: string | null;
  // never a private or preshared key
  tunnel: { name: string | null; endpoint: string; addresses: string[]; dns: string[]; dnsFallback: boolean; mtu: number; peerPublicKey: string; setAt: string } | null;
  status: { state: 'off' | 'connecting' | 'connected' | 'down'; latestHandshakeAt: string | null; rxBytes: number; txBytes: number; checkedAt: string | null };
  allApps: boolean;
  // apps that do not go direct (by effective mode)
  apps: { instanceId: string; name: string; mode: 'vpn' | 'offline' }[];
  // the host rules: ok = loaded this daemon run, failed = the last apply failed (message), none = nothing applied yet
  rules: { state: 'ok' | 'failed' | 'none'; message: string | null; appliedAt: string | null };
}
// In a plan: install (to = what it starts with), configure (from → to), update (the package default moved)
export interface PlanInternetDto {
  from: InternetMode | null;
  to: InternetMode;
  choice: InternetMode | null;
  packageDefault: InternetMode;
  // a VPN is set up (when to is vpn and there is none, the app has no internet until there is)
  vpnReady: boolean;
}
export interface SettingDto {
  id: string;
  label: string;
  help: string | null;
  type: 'integer' | 'number' | 'boolean' | 'string' | 'choice';
  default: SettingValue;
  value: SettingValue;
  overridden: boolean;
  min: number | null;
  max: number | null;
  maxLength: number | null;
  choices: { value: string; label: string }[] | null;
}
// In a plan. new: install (every setting) or a setting an update adds — ask: the submission may carry a value
// (`settings` of POST /v1/operations); set: a configure plan changes it (previous = the value before); reset: an
// update no longer allows the stored value and puts back the default; dropped: the update no longer has it.
export interface PlanSettingDto extends SettingDto {
  change: 'new' | 'set' | 'reset' | 'dropped';
  ask: boolean;
  previous: SettingValue | null;
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
  // decision 174: the app's own version of the installed revision (manifest release.version, else the main
  // image's version from release.json); null when the package does not say
  version: string | null;
  desired: Desired;
  installState: InstallState;
  runtime: Runtime;
  readiness: Readiness;
  observedAt: string | null;
  endpoints: EndpointDto[];
  ports: FixedPortDto[]; // decision 163: fixed ports published on every interface (a VPN tunnel port)
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
  // decision 180: the app's settings with their effective values (absent when the package declares none)
  settings?: SettingDto[];
  // decision 131: not shown on Home (the operator's choice, else the package's presentation.hideFromHome)
  hiddenFromHome: boolean;
  // decision 184: how the app reaches the internet
  internet: InternetDto;
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
// decision 194: a configure plan's change to Harbor's app login of one endpoint (password: a new one comes with the
// submission as secret `harbor.login.<endpoint>`)
export interface LoginChange {
  on?: boolean;
  password?: true;
}

// decision 194: one endpoint's app login, as the drawer shows it (the password itself only through /login/reveal)
export interface AppLoginDto {
  endpoint: string;
  on: boolean;
  locked: 'required' | 'never' | null;
  hasPassword: boolean;
}

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
  // Decision 167: HTTPS only — the plain-http console redirects to https (except the CA download and the probe)
  // and apps are rendered on loopback, reachable from the network only through the secure relay.
  httpsOnly: boolean;
  url: string | null; // https://harbor.local/ when on (console)
  fingerprint: string | null; // SHA-256 of the CA cert, for the "compare on the device" step
  expiresAt: string | null; // server cert notAfter
  hosts: string[]; // names the server cert covers
  // Decision 165: false = a CA minted before 0.31.0, which can sign any name; POST /v1/network/https/ca replaces it.
  caLimited?: boolean;
  // Decision 116: apps whose only HTTPS address is the secure LAN one (they stop working when it is
  // turned off), and running apps that must be restarted to pick up a change of addresses.
  // (only on GET/PUT /v1/network/https; the system DTO's copy omits them)
  breaksWhenOff?: string[];
  restartToApply?: string[];
  // Decision 167: running apps whose ports follow the HTTPS-only switch only after a restart (still open on
  // plain http while it is on; secure address only while it is off). Same GET/PUT-only rule as above.
  rebindToApply?: string[];
}

// Main-address choices available right now (decision 116): only what is set up appears.
export interface AddressOptionsDto {
  local: { kind: 'https' | 'http' | 'loopback'; host: string }; // "this network"
  tailnet: { hostname: string } | null; // Tailscale running with HTTPS certificates
  domains: string[]; // registered domains that point at this machine
}

// ---- notifications (decision 77)
// Decision 164: the buttons a notification offers, derived from its kind (so old rows get them too).
// The console runs each one; `route` is set for 'route' only.
export interface NotificationActionDto {
  label: string;
  do: 'update-harbor' | 'update-app' | 'open-app' | 'back-up-now' | 'route';
  route: string | null;
}
export interface NotificationDto {
  link: string | null; // console route to fix it (decision 122), e.g. #/settings/storage
  actions: NotificationActionDto[]; // decision 164: first one is the primary call to action
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
  // decision 179: for an app whose package grants gpu: what this machine offers now, and whether the app's
  // current Compose file hands THAT card to its containers (false = found after it last started, or it runs with a
  // different one: Restart uses the one found now). Decision 181: also true with kind none + NVIDIA_REBOOT_NEEDED when
  // the containers still have the NVIDIA card from before the driver update (a Restart before the reboot drops it)
  gpu?: GpuDto & { inUse: boolean };
  // decision 194: Harbor's app login of each web endpoint (absent on a removed app)
  login?: AppLoginDto[];
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
  // decision 163: fixed ports this plan publishes; permissions the approver must accept (update: only new ones)
  ports: FixedPortDto[];
  permissions: PermissionDto[];
  // decision 165: update plans: fixed ports the update newly opens on every interface; accepted like permissions
  opensPorts?: number[];
  // decision 179: the graphics card found when planning (only for a package that grants gpu to a service)
  gpu?: GpuDto;
  storage: StorageDto[];
  // install-location plans: where the whole app will live (null = system disk). Decision 157: onDrive =
  // not the Harbor data folder; defaultKey = Harbor's own key (unlocks at sign-in), false = own passphrase
  location: { dir: string; encrypted: true; onDrive: boolean; defaultKey: boolean } | null;
  // decision 125: source operator = the submission carries the value (ask: required/optional); never a value here
  secrets: { id: string; state: 'new' | 'existing'; source: 'generated' | 'operator'; prompt: string | null; optional: boolean; minLength: number | null; maxLength: number | null; ask: 'required' | 'optional' | null }[];
  // decision 126: links this plan sets up or changes
  links: { id: string; purpose: string; optional: boolean; provider: { instanceId: string; name: string; endpointId: string; url: string } | null; alias: string; network: string; change: 'set' | 'keep' | 'clear' }[];
  // decision 180: settings this plan sets or asks about (absent when there are none)
  settings?: PlanSettingDto[];
  // decision 184: internet access this plan sets (install, configure) or moves (update of a following app)
  internet?: PlanInternetDto;
  warnings: string[];
  // decision 157: plain facts worth reading before approving (how it opens, what happens next) — not warnings
  notes: string[];
  // update plans: what changes between the installed release and the new one
  update?: { fromRevision: string; toRevision: string; fromVersion: string | null; toVersion: string | null; images: { service: string; from: string; to: string }[]; newSecrets: string[]; newStorage: string[]; newEndpoints: string[]; releaseNotes: string | null };
  exposure?: { endpointId: string; via: ExposureVia; url: string; protection: 'none' | 'basic'; makePrimary: boolean; credentials?: { username: string; password: string } };
}

export interface OperationDto {
  id: string;
  kind: PlanKind;
  instanceId: string;
  // decision 183: the app's display name (kept when a cancelled install freed its row)
  instanceName: string;
  // null while a queued action waits to be planned (decision 183)
  planId: string | null;
  // who queued it: the session user, 'auto-update', 'drive-guard', 'link-guard', 'lock-guard', 'scheduler', …
  actor: string;
  // decision 183: true while it waits to be planned at its turn (queued without a plan)
  queuedAction: boolean;
  // decision 183: a person may cancel it now (waiting, not picked yet, not queued by Harbor to protect something)
  cancellable: boolean;
  state: OperationState;
  phase: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string; nextAction: string } | null;
  result: Record<string, unknown> | null;
  events: EventDto[];
}

// GET /v1/operations (decision 183): the queue. `active` in run order (the running one first); `recent` finished,
// newest first. List items carry `events: []`; GET /v1/operations/:id has the events and one-time results.
export interface OperationQueueDto {
  active: OperationDto[];
  recent: OperationDto[];
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
  presentation: { tagline: string | null; category: string; icon: string | null; gallery: string[]; developer: string | null; website: string | null; source: string | null; releaseNotes: string | null; sizeHint: string | null; hasWidget: boolean };
  // apps that ship with a fixed login (not generated by Harbor); shown with a "change it" warning
  defaultCredentials: { username: string; password: string; note: string | null } | null;
  setup: boolean;
  storage: number;
  claims: StorageClaimDto[];
  // decision 125: values the install asks the operator for
  operatorSecrets: { id: string; prompt: string; optional: boolean; minLength: number | null; maxLength: number | null }[];
  // decision 126: other apps this one talks to privately (the install picks a provider for each)
  links: { id: string; purpose: string; optional: boolean; packages: string[] | null; endpoint: string | null }[];
  // decision 170: whether the package allows several copies (manifest deployment.multiInstance); absent when
  // Harbor cannot read the package. false = one copy per machine (the Store shows Open, never a second Install).
  multiInstance?: boolean;
  // decision 170: the name the next install gets by default (the planner's rule: the package id, else -2, -3…)
  proposedName?: string;
  // decision 185: the package's network.internet (absent = direct, or a package Harbor cannot read)
  internet?: InternetMode;
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
    https: { enabled: boolean; httpsOnly: boolean; url: string | null; fingerprint: string | null; expiresAt: string | null; hosts: string[] }; // httpsOnly: decision 167
  };
  update: SelfUpdateStatusDto;
  docker: { available: boolean; observedAt: string | null; version: string | null; error: string | null };
  busyOperationId: string | null;
  installationId: string;
  managementOrigin: string;
  // Decision 190: Harbor restarted since the last password (BFU) and something waits on this machine's key
  // (an app home that unlocks with it, or a backup place). A session that outlived the restart shows the
  // lock screen, which types the password once (POST /v1/account/unlock) instead of logging out and in.
  unlockNeeded: boolean;
  // Decision 193: developer mode lets packages that are not from the official catalog ask for the trusted-only
  // permissions (privileged, binder); the console shows a banner while it is on.
  developerMode: DeveloperModeDto;
}

// GET/PUT /v1/system/developer-mode (decision 193)
export interface DeveloperModeDto {
  enabled: boolean;
  since: string | null; // when it was turned on
  // installed apps holding a trusted-only permission without coming from the official catalog
  untrustedApps: string[];
}
export const DEVELOPER_MODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'since', 'untrustedApps'],
  properties: { enabled: { type: 'boolean' }, since: { type: ['string', 'null'] }, untrustedApps: { type: 'array', items: { type: 'string' } } },
} as const;

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
  // internet (decision 184): the operator's choice for the new app (absent = the package's default)
  // tailnet (decision 186): Also on Tailscale — an address on the tailnet once it runs (absent = what Every app on
  // Tailscale says; false keeps it off while that is on). Not the main address: that is `main`.
  | { kind: 'install'; packageId: string; name?: string; storage?: Record<string, { hostPath: string }>; location?: InstallLocationRequest; main?: InstallMainAddress; links?: Record<string, LinkChoice>; internet?: InternetMode; tailnet?: boolean }
  | { kind: 'start' | 'stop' | 'restart' | 'remove' | 'reinstall' | 'purge'; instanceId: string }
  | { kind: 'update'; instanceId: string; storage?: Record<string, { hostPath: string }>; links?: Record<string, LinkChoice> }
  // decisions 125/126: secrets listed in `secrets` are replaced by the values the submission carries;
  // links: a provider per link id, or null to unlink an optional one
  // decision 180: settings: new values by setting id (a value equal to the default removes the override)
  // internet (decision 184): a mode, or 'default' to follow the package again
  | { kind: 'configure'; instanceId: string; secrets?: string[]; links?: Record<string, LinkChoice | null>; settings?: Record<string, SettingValue>; internet?: InternetMode | 'default'; login?: Record<string, LoginChange> }
  | { kind: 'expose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string; protection?: 'none' | 'basic'; makePrimary?: boolean; proxyFrom?: string }
  // decision 127: hostname picks one of several public names (required when there are several)
  | { kind: 'unexpose'; instanceId: string; endpointId?: string; via: ExposureVia; hostname?: string }
  // decision 127: with primary public, hostname names the main public name (default: the first published)
  | { kind: 'reconfigure'; instanceId: string; primary: PrimaryExposure; hostname?: string }
  // decision 142: move an app's plain Docker volumes into a sealed home in the Harbor data folder, in place
  | { kind: 'seal'; instanceId: string }
  // decision 145: move an encrypted app's home to another install location (<candidate>/<package>), keeping its key
  | { kind: 'move'; instanceId: string; location: { dir: string } }
  // decision 151: the cold pass of a backup run (normally submitted by the scheduler, actor `scheduler`)
  | { kind: 'backup'; instanceId: string; runId: string }
  // decision 153: put an app back as it was at a restore point (its run), from one place that holds it
  | { kind: 'restore'; instanceId: string; runId: string; targetId?: string }
  // decision 171: attach an app's links again with only the names Harbor gives (no container recreated).
  // Internal: queued by the daemon's one-time check after an upgrade (actor `link-guard`), not by the API.
  | { kind: 'relink'; instanceId: string };

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
  // decision 163/179: what adopting asks the operator to accept (absent: nothing, or the package is not on this
  // machine); the adopt request must carry acceptPermissions: true when present
  permissions?: PermissionDto[];
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

// Decision 177: "Give every app a Tailscale address" (opt-in). published = it has a tailnet address; pending = it
// gets one at the next check (or its plan runs now); waiting = not now (stopped, busy, installing…; see note);
// failed = the one attempt since Harbor started failed (note says why); excluded = the operator keeps it off.
export type TailnetAllAppState = 'published' | 'pending' | 'waiting' | 'failed' | 'excluded';
export interface TailnetAllAppDto {
  instanceId: string;
  name: string; // the app's label (display name or instance name)
  state: TailnetAllAppState;
  url: string | null; // its tailnet address when published
  note: string | null;
}
export interface TailnetAllDto {
  enabled: boolean;
  // off = policy off; waiting = on, but Tailscale cannot publish now (reason + nextAction); on = publishing
  status: 'off' | 'waiting' | 'on';
  // why Tailscale cannot publish right now (set whether the policy is on or off; null when it can)
  reason: string | null;
  nextAction: string | null;
  except: string[]; // instance ids kept off the tailnet
  asked: string[]; // decision 186: instance ids whose install asked for an address (published even with the policy off)
  apps: TailnetAllAppDto[]; // every app that is not removed, whatever the policy says (the confirm dialog lists them)
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
  // decision 179: the graphics card apps that ask for `gpu` get (absent from daemons before 0.34.0)
  gpu?: GpuDto;
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
  available: boolean; // a newer release whose archive, SHA256SUMS and SHA256SUMS.sig are all published
  // a newer release that cannot be installed yet (its files are still being uploaded), in plain words; else null
  pending?: string | null;
  checkedAt: string | null;
  error: string | null;
  // set while (or after) an update runs; written by the root apply step, so it survives the daemon restart.
  // 'rolled-back' means the new release failed and the previous one was restored (the console is back).
  applying: { version: string; state: 'requested' | 'downloading' | 'installing' | 'succeeded' | 'failed' | 'rolled-back'; message: string; at: string } | null;
}

// ---- the official app catalog (decision 158): bundles from the catalog repository's releases (HTTPS, no signature)
export interface CatalogStatusDto {
  source: string | null; // release-asset base URL Harbor checks; null = catalog updates are off
  serial: number; // the active catalog's serial (catalog commit time, unix seconds); 0 = a dev seed without catalog.json
  commit: string | null; // catalog repository commit of the active catalog
  createdAt: string | null; // when that bundle was built
  origin: 'bundled' | 'downloaded'; // shipped with this Harbor release, or downloaded since
  packages: number;
  checkedAt: string | null; // last check since the daemon started
  error: string | null; // why the last check failed (the active catalog is unchanged)
}
// Route response schema (fastify serialises with it; keep it in step with the interface above).
export const CATALOG_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'serial', 'commit', 'createdAt', 'origin', 'packages', 'checkedAt', 'error'],
  properties: {
    source: { type: ['string', 'null'] },
    serial: { type: 'integer' },
    commit: { type: ['string', 'null'] },
    createdAt: { type: ['string', 'null'] },
    origin: { type: 'string', enum: ['bundled', 'downloaded'] },
    packages: { type: 'integer' },
    checkedAt: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
  },
} as const;

// ---- first-run setup (no administrator yet)
// GET /v1/setup is open (no token). Decision 169: once an administrator exists it answers only `needed: false`
// and `https` (the login page and the http->https move need nothing else); the other fields are only sent while
// setup is still needed, so they are optional.
export interface SetupStatusDto {
  needed: boolean;
  hostname?: string;
  deviceName?: string | null;
  lan?: { enabled: boolean; url: string | null };
  tailscale?: { installed: boolean; loggedIn: boolean };
  version?: string;
  // decision 164: the console on plain http probes these https hosts and moves there when the browser trusts the certificate
  https: { enabled: boolean; hosts: string[] };
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

// ---- app backups (decisions 149–154)
export interface BackupRetentionDto {
  daily: number;
  weekly: number;
  monthly: number;
}
export type BackupCadence = 'daily' | 'weekly';
// Settings → Backups. window = local time the nightly run starts ("02:00"); weekday 0 = Sunday.
export interface BackupPolicyDto {
  window: string;
  cadence: BackupCadence;
  weekday: number;
  maxDowntimeMinutes: number;
  retention: BackupRetentionDto;
  paused: boolean;
}
// Drawer → Backups. null window/cadence/weekday = the global policy's.
export interface BackupAppPolicyDto {
  enabled: boolean;
  targets: string[]; // installed target ids (the fan-out)
  window: string | null;
  cadence: BackupCadence | null;
  weekday: number | null;
}
export interface BackupTargetFieldDto {
  id: string;
  label: string;
  type: 'text' | 'secret' | 'textarea' | 'number';
  required: boolean;
  default: string | null;
  hint: string | null;
}
// A target package (the App Store's Backup section): a form, no code.
export interface BackupTargetPackageDto {
  id: string;
  name: string;
  description: string;
  status: 'stable' | 'beta';
  revision: string;
  transport: 'local' | 's3' | 'sftp' | 'rclone' | 'rest';
  fields: BackupTargetFieldDto[];
  readme: string | null;
}
// An installed place. values: the operator's answers, secrets as "••••".
// repo: ready = Harbor's backups open here; foreign = another Harbor's backups are here (open them with
// that Harbor's recovery key); unreachable = the last test failed; unknown = never tested.
export interface BackupTargetDto {
  id: string;
  packageId: string;
  packageName: string;
  status: 'stable' | 'beta';
  name: string;
  values: Record<string, string>;
  createdAt: string;
  repo: 'unknown' | 'ready' | 'foreign' | 'unreachable';
  note: string | null;
  checkedAt: string | null;
  lastPruneAt: string | null;
  lastCheckAt: string | null;
  usedBy: { instanceId: string; name: string }[];
}
export interface BackupRunTargetDto {
  targetId: string;
  name: string;
  state: 'succeeded' | 'failed' | 'skipped';
  snapshotId: string | null;
  bytesAdded: number | null;
  error: string | null;
}
export interface BackupRunDto {
  id: string;
  instanceId: string | null;
  instanceName: string | null;
  kind: 'backup' | 'restore' | 'prune' | 'check';
  trigger: 'schedule' | 'manual';
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  downtimeSeconds: number | null;
  bytesAdded: number | null;
  totalBytes: number | null;
  message: string | null;
  operationId: string | null;
  targets: BackupRunTargetDto[];
}
// One restore point = one run, on every place that holds it.
export interface RestorePointDto {
  runId: string;
  time: string;
  instanceId: string;
  packageId: string;
  totalBytes: number | null;
  places: { targetId: string; name: string; snapshotId: string }[];
}
export interface BackupAppDto {
  instanceId: string;
  name: string;
  packageId: string;
  // eligible = Harbor can back this app up (an encrypted home); reason says why not
  eligible: boolean;
  reason: string | null;
  policy: BackupAppPolicyDto;
  nextAt: string | null;
  lastRun: BackupRunDto | null;
  lastSuccessAt: string | null;
}
export interface BackupActivityDto {
  instanceId: string;
  name: string;
  phase: 'queued' | 'warm' | 'cold' | 'restoring' | 'maintenance';
  percent: number | null;
  since: string;
}
export interface BackupsOverviewDto {
  // tools: restic/rclone present (root engine) or the fake engine; reason when backups cannot run here
  available: boolean;
  reason: string | null;
  engine: 'root' | 'fake';
  keyReady: boolean; // the backup key exists (made on the first place you add)
  policy: BackupPolicyDto;
  packages: BackupTargetPackageDto[];
  targets: BackupTargetDto[];
  apps: BackupAppDto[];
  activity: BackupActivityDto[];
  recent: BackupRunDto[];
}
export interface AppBackupsDto extends BackupAppDto {
  runs: BackupRunDto[];
  points: RestorePointDto[];
  // the copy kept by the last in-place restore, until you delete it
  previous: { path: string; createdAt: string } | null;
}
// Apps found at a place (restore on a new machine): grouped from its snapshots.
export interface FoundBackupAppDto {
  instanceId: string;
  packageId: string;
  name: string;
  installedHere: boolean;
  points: RestorePointDto[];
}
