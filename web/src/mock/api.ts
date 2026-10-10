import type {
  AppearanceDto,
  CatalogItemDto,
  DomainsDto,
  ExposureDto,
  HostStorageDto,
  InstanceDetail,
  InstanceSummary,
  NetworkHttpsDto,
  NotificationChannelDto,
  NotificationsDto,
  OperationDto,
  PlanDto,
  PlatformToolDto,
  StorageUsageDto,
  SystemDto,
  SystemHostDto,
  SystemMetricsDto,
  UiExposureDto,
  LinkDto,
  AppBackupsDto,
  BackupAppPolicyDto,
  BackupPolicyDto,
  BackupsOverviewDto,
  BackupTargetDto,
} from '../../../src/contracts/api';
import {
  mockAppearance,
  mockCatalog,
  mockChannels,
  mockDomains,
  mockExposures,
  mockHost,
  mockInstances,
  mockMetrics,
  mockNotifications,
  mockStorage,
  mockStorageUsage,
  mockSystem,
  mockTools,
} from './fixtures';

// Design mode: the whole console renders from in-memory fixtures, no daemon, no login.
// Every mutating call pretends to succeed after a beat so dialogs, drawers, wizards and the
// tray can be exercised. Enable with `pnpm dev:ui` (sets VITE_HARBOR_UI_MOCK=1),
// with `?mock=1` in the URL, or with localStorage `harbor.ui-mock = 1`.
export const isMockUi = (): boolean => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.['VITE_HARBOR_UI_MOCK'] === '1') return true;
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mock') === '1') return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('harbor.ui-mock') === '1') return true;
    return false;
  } catch {
    return false;
  }
};

const beat = (ms = 350) => new Promise((r) => setTimeout(r, ms));

let instances = mockInstances();
let notifications = mockNotifications();
let channels = mockChannels();
let storage = mockStorage();
const appearance = mockAppearance();
let order: string[] = [];

// Design-mode device state: mount/unmount flip the fixture so the row, the
// spinner and the 2s poll can be exercised with clicks, like the real daemon.
function mockMountpointFor(name: string): string {
  const label = storage.devices.find((d) => d.name === name)?.label ?? name;
  return `/mnt/${label.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || name}`;
}
function mockMountDevice(name: string): void {
  const mp = mockMountpointFor(name);
  const dev = storage.devices.find((d) => d.name === name);
  const fsType = dev?.fsType ?? 'vfat';
  const eligible = ['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'apfs', 'hfs'].includes(fsType.toLowerCase());
  const label = dev?.label ?? name;
  storage = {
    ...storage,
    mounts: storage.mounts.some((m) => m.mountpoint === mp) ? storage.mounts : [...storage.mounts, { mountpoint: mp, device: `/dev/${name}`, fsType, totalBytes: 16 * 1024 * 1024 * 1024, usedBytes: 4 * 1024 * 1024 * 1024, writable: true, label: `Drive "${name}"` }],
    devices: storage.devices.map((d) => (d.name === name ? { ...d, mounted: true, mountpoint: mp } : d)),
    // A mount makes the drive's apps folder a candidate — eligible when the
    // filesystem qualifies, disabled with a reason (like the daemon) when not.
    installCandidates: storage.installCandidates.some((c) => c.dir === `${mp}/harbor-apps`)
      ? storage.installCandidates
      : [
          ...storage.installCandidates,
          {
            dir: `${mp}/harbor-apps`,
            label: `Drive "${label}" (${mp}/harbor-apps)`,
            fsType,
            totalBytes: 16 * 1024 * 1024 * 1024,
            usedBytes: 4 * 1024 * 1024 * 1024,
            writable: true,
            eligible,
            reason: eligible ? null : `the ${fsType} filesystem cannot hold apps (needs ext4, btrfs, xfs, zfs or apfs)`,
          },
        ],
  };
}
function mockUnmountDevice(name: string): void {
  const mp = mockMountpointFor(name);
  storage = {
    ...storage,
    mounts: storage.mounts.filter((m) => m.mountpoint !== mp),
    devices: storage.devices.map((d) => (d.name === name ? { ...d, mounted: false, mountpoint: null } : d)),
    // An unmounted drive offers no candidate (like the daemon: candidates come from mounts).
    installCandidates: storage.installCandidates.filter((c) => c.dir !== `${mp}/harbor-apps`),
  };
}
// Format in design mode: the drive becomes ext4 + mounted at its label-derived
// mountpoint, and its candidate flips to eligible — like the real daemon.
function mockFormatDevice(name: string, mp: string, label: string): void {
  storage = {
    ...storage,
    mounts: storage.mounts.some((m) => m.mountpoint === mp) ? storage.mounts.map((m) => (m.mountpoint === mp ? { ...m, fsType: 'ext4', usedBytes: 0 } : m)) : [...storage.mounts, { mountpoint: mp, device: `/dev/${name}`, fsType: 'ext4', totalBytes: 16 * 1024 * 1024 * 1024, usedBytes: 0, writable: true, label: `Drive "${label}"` }],
    devices: storage.devices.map((d) => (d.name === name ? { ...d, fsType: 'ext4', mounted: true, mountpoint: mp } : d)),
    installCandidates: storage.installCandidates.some((c) => c.dir === `${mp}/harbor-apps`)
      ? storage.installCandidates.map((c) => (c.dir === `${mp}/harbor-apps` ? { ...c, fsType: 'ext4', eligible: true, reason: null } : c))
      : [...storage.installCandidates, { dir: `${mp}/harbor-apps`, label: `Drive "${label}" (${mp}/harbor-apps)`, fsType: 'ext4', totalBytes: 16 * 1024 * 1024 * 1024, usedBytes: 0, writable: true, eligible: true, reason: null }],
  };
}

const planFor = (kind: PlanDto['kind'], instanceId: string, packageId: string, name: string): PlanDto => ({
  id: `plan-mock-${kind}`,
  kind,
  instanceId,
  name,
  packageId,
  revision: '1',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  expectedGeneration: 1,
  changes: [`Mock plan: ${kind} ${name || packageId} (nothing runs in design mode)`],
  endpoints: [],
  storage: [],
  location: null,
  secrets: [],
  links: [],
  warnings: [],
});

const opFor = (kind: OperationDto['kind'], instanceId: string, planId: string): OperationDto => ({
  id: `op-mock-${kind}`,
  kind,
  instanceId,
  planId,
  state: 'succeeded',
  phase: 'verifying',
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  error: null,
  result: null,
  events: [{ cursor: '1', at: new Date().toISOString(), phase: 'verifying', message: 'Mock run finished instantly.' }],
});

const detailFor = (inst: InstanceSummary): InstanceDetail => ({
  ...inst,
  description: `${inst.packageName} in design mode: every button works, nothing runs.`,
  setup: null,
  defaultCredentials: null,
  resources: [],
  events: [],
  lastError: null,
});

// Backups (decisions 149–154): two places, one app on, a week of restore points.
const BK_PACKAGES: BackupsOverviewDto['packages'] = [
  { id: 'folder', name: 'Another disk', description: 'A folder on a second disk or a USB drive plugged into this machine.', status: 'stable', revision: '1', transport: 'local', fields: [{ id: 'path', label: 'Folder', type: 'text', required: true, default: null, hint: 'A folder under /mnt or /media' }], readme: null },
  { id: 's3', name: 'S3-compatible storage', description: 'Backblaze B2, Cloudflare R2, Wasabi, Amazon S3, MinIO.', status: 'stable', revision: '1', transport: 's3', fields: [{ id: 'endpoint', label: 'Endpoint', type: 'text', required: true, default: null, hint: null }, { id: 'bucket', label: 'Bucket', type: 'text', required: true, default: null, hint: null }, { id: 'accessKeyId', label: 'Access key ID', type: 'text', required: true, default: null, hint: null }, { id: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true, default: null, hint: null }], readme: null },
  { id: 'sftp', name: 'SFTP server', description: 'Any machine you can reach over SSH.', status: 'stable', revision: '1', transport: 'sftp', fields: [{ id: 'host', label: 'Server', type: 'text', required: true, default: null, hint: null }, { id: 'user', label: 'User', type: 'text', required: true, default: null, hint: null }, { id: 'path', label: 'Folder on the server', type: 'text', required: true, default: null, hint: null }, { id: 'privateKey', label: 'Private key', type: 'secret', required: true, default: null, hint: null }], readme: null },
  { id: 'protondrive', name: 'Proton Drive', description: 'Your Proton Drive, through rclone. Beta.', status: 'beta', revision: '1', transport: 'rclone', fields: [{ id: 'username', label: 'Proton email', type: 'text', required: true, default: null, hint: null }, { id: 'password', label: 'Password', type: 'secret', required: true, default: null, hint: null }], readme: null },
];
let bkPolicy: BackupPolicyDto = { window: '02:00', cadence: 'daily', weekday: 0, maxDowntimeMinutes: 5, retention: { daily: 7, weekly: 4, monthly: 6 }, paused: false };
let bkTargets: BackupTargetDto[] = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', packageId: 's3', packageName: 'S3-compatible storage', status: 'stable', name: 'Backblaze B2', values: { endpoint: 's3.us-west-002.backblazeb2.com', bucket: 'harbor-home', accessKeyId: 'K002', secretAccessKey: '••••' }, createdAt: '2026-10-01T10:00:00Z', repo: 'ready', note: null, checkedAt: '2026-10-10T02:04:00Z', lastPruneAt: '2026-10-06T03:00:00Z', lastCheckAt: '2026-10-01T03:00:00Z', usedBy: [] },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', packageId: 'folder', packageName: 'Another disk', status: 'stable', name: 'USB disk', values: { path: '/mnt/backup/harbor' }, createdAt: '2026-10-01T10:05:00Z', repo: 'ready', note: null, checkedAt: '2026-10-10T02:03:00Z', lastPruneAt: null, lastCheckAt: null, usedBy: [] },
];
const bkApps: Record<string, BackupAppPolicyDto> = {};
// design mode: these packages count as encrypted, and immich already backs up to both places
const BK_SEALED = new Set(['immich', 'memos', 'vaultwarden']);
const bkImmich = instances.find((i) => i.packageId === 'immich');
if (bkImmich) bkApps[bkImmich.id] = { enabled: true, targets: ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'], window: null, cadence: null, weekday: null };
function bkFor(id: string): AppBackupsDto {
  const inst = instances.find((i) => i.id === id) ?? instances[0]!;
  const policy = bkApps[id] ?? { enabled: false, targets: [], window: null, cadence: null, weekday: null };
  const days = policy.enabled ? 7 : 0;
  const points = Array.from({ length: days }, (_, d) => ({ runId: `bbbbbbbb-0000-4000-8000-00000000000${d}`, time: new Date(Date.UTC(2026, 9, 10 - d, 2, 3)).toISOString(), instanceId: id, packageId: inst.packageId, totalBytes: 2_400_000_000 - d * 12_000_000, places: bkTargets.filter((t) => policy.targets.includes(t.id)).map((t) => ({ targetId: t.id, name: t.name, snapshotId: `c0ffee0${d}` })) }));
  const run = (d: number) => ({ id: `cccccccc-0000-4000-8000-00000000000${d}`, instanceId: id, instanceName: inst.displayName ?? inst.name, kind: 'backup' as const, trigger: 'schedule' as const, state: 'succeeded' as const, startedAt: new Date(Date.UTC(2026, 9, 10 - d, 2, 0)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 10 - d, 2, 3)).toISOString(), downtimeSeconds: 14 + d, bytesAdded: 48_000_000, totalBytes: 2_400_000_000, message: 'Backblaze B2: ok · USB disk: ok', operationId: null, targets: [] });
  return { instanceId: id, name: inst.displayName ?? inst.name, packageId: inst.packageId, eligible: Boolean(inst.home) || BK_SEALED.has(inst.packageId), reason: inst.home || BK_SEALED.has(inst.packageId) ? null : `${inst.name} keeps its data in plain Docker volumes, which Harbor does not back up. Encrypt it first.`, policy, nextAt: policy.enabled ? '2026-10-11T02:00:00Z' : null, lastRun: days ? run(0) : null, lastSuccessAt: days ? run(0).finishedAt : null, runs: Array.from({ length: Math.min(days, 5) }, (_, d) => run(d)), points, previous: null };
}
function bkOverview(): BackupsOverviewDto {
  const apps = instances.filter((i) => i.installState !== 'retained').map((i) => {
    const { runs: _r, points: _p, previous: _x, ...a } = bkFor(i.id);
    return a;
  });
  return { available: true, reason: null, engine: 'fake', keyReady: true, policy: bkPolicy, packages: BK_PACKAGES, targets: bkTargets.map((t) => ({ ...t, usedBy: apps.filter((a) => a.policy.targets.includes(t.id)).map((a) => ({ instanceId: a.instanceId, name: a.name })) })), apps, activity: [], recent: apps.flatMap((a) => (a.lastRun ? [a.lastRun] : [])) };
}

export const mockApi = {
  async login(): Promise<{ token: string; expiresAt: string }> {
    await beat(150);
    return { token: 'mock-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
  currentToken: (): string | null => 'mock-token',
  setupStatus: async () => ({ needed: false, hostname: 'harbor', deviceName: 'homelab', lan: { enabled: false, url: null }, tailscale: { installed: true, loggedIn: true }, version: '0.9.0' }),
  setup: async () => ({ token: 'mock-token', expiresAt: new Date(Date.now() + 3600_000).toISOString(), recoveryKey: 'abandon ability able about above absent absorb abstract absurd abuse access accident' }),
  selfUpdate: async () => mockSystem().update,
  selfUpdateCheck: async () => mockSystem().update,
  selfUpdateApply: async () => mockSystem().update,
  logout: async (): Promise<void> => {
    await beat(100);
  },
  sessions: async () => [{ createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), lastSeenAt: new Date().toISOString(), kind: 'remember' as const, current: true }],
  revokeOtherSessions: async (): Promise<void> => {
    await beat(100);
  },
  system: async (): Promise<SystemDto> => mockSystem(),
  metrics: async (): Promise<SystemMetricsDto> => mockMetrics(),
  catalog: async (): Promise<CatalogItemDto[]> => mockCatalog(),
  instances: async (): Promise<InstanceSummary[]> => instances,
  instance: async (id: string): Promise<InstanceDetail> => {
    const inst = instances.find((i) => i.id === id) ?? instances[0]!;
    return detailFor(inst);
  },
  widget: async () => null,
  tools: async (): Promise<PlatformToolDto[]> => mockTools(),
  installTool: async (id: string): Promise<PlatformToolDto> => {
    await beat();
    const t = mockTools().find((x) => x.id === id)!;
    return { ...t, install: { state: 'succeeded', message: 'Mock install finished.', at: new Date().toISOString() } };
  },
  exposures: async (): Promise<{ items: ExposureDto[]; ui: UiExposureDto | null }> => mockExposures(),
  links: async (): Promise<LinkDto[]> => [],
  exposeUi: async (): Promise<UiExposureDto> => mockExposures().ui!,
  unexposeUi: async (): Promise<void> => {
    await beat();
  },
  plan: async (req: { kind: PlanDto['kind']; packageId?: string; instanceId?: string; name?: string; location?: { dir: string } }): Promise<PlanDto> => {
    await beat();
    const inst = req.instanceId ? (instances.find((i) => i.id === req.instanceId) ?? instances[0]!) : instances[0]!;
    const p = planFor(req.kind, req.instanceId ?? inst.id, req.packageId ?? inst.packageId, req.name ?? inst.name);
    if (req.location) {
      p.location = { dir: req.location.dir, encrypted: true };
      p.changes = [...p.changes, `Whole app encrypted at ${req.location.dir}`];
      p.warnings = [...p.warnings, 'Write down the app passphrase: losing it loses the data.'];
    }
    return p;
  },
  submit: async (planId: string) => {
    await beat();
    const op = opFor('install', instances[0]!.id, planId);
    op.result = { recoveryKey: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', recoveryNote: 'Mock recovery key: write down these 12 words in the real console.' };
    return { operationId: op.id, created: true, operation: op };
  },
  foundApps: async () => [
    { home: '/mnt/photos/harbor-apps/immich/immich-2', name: 'immich-2', displayName: 'Immich (2)', packageId: 'immich', packageRevision: '1', instanceId: null, drive: 'Photos', adopted: false, error: null },
  ],
  adoptFoundApp: async (home: string) => {
    await beat();
    const inst = instances[0]!;
    return { ...inst, name: 'immich-2', home: { path: home, encrypted: true, state: 'locked' as const, sealed: true, silentUnlock: false } };
  },
  unlockApp: async (id: string) => {
    await beat();
    const inst = instances.find((i) => i.id === id) ?? instances[0]!;
    return { ...inst, home: inst.home ? { ...inst.home, state: 'unlocked' as const } : inst.home };
  },
  lockApp: async (id: string) => {
    await beat();
    const inst = instances.find((i) => i.id === id) ?? instances[0]!;
    return { ...inst, home: inst.home ? { ...inst.home, state: 'locked' as const } : inst.home };
  },
  operation: async (id: string): Promise<OperationDto> => opFor('install', instances[0]!.id, id),
  changePassword: async () => {
    await beat();
    return { revokedSessions: 1 };
  },
  hostStorage: async (): Promise<HostStorageDto> => storage,
  backups: async () => bkOverview(),
  setBackupPolicy: async (p: Partial<BackupPolicyDto>) => {
    await beat(150);
    bkPolicy = { ...bkPolicy, ...p };
    return bkPolicy;
  },
  addBackupTarget: async (packageId: string, name: string, values: Record<string, string>) => {
    await beat(700);
    const pkg = BK_PACKAGES.find((p) => p.id === packageId)!;
    const t: BackupTargetDto = { id: `aaaaaaaa-0000-4000-8000-0000000000${10 + bkTargets.length}`, packageId, packageName: pkg.name, status: pkg.status, name, values, createdAt: new Date().toISOString(), repo: 'ready', note: null, checkedAt: new Date().toISOString(), lastPruneAt: null, lastCheckAt: null, usedBy: [] };
    bkTargets = [...bkTargets, t];
    return { target: t, recoveryKey: null };
  },
  updateBackupTarget: async (id: string, patch: { name?: string }) => {
    await beat(500);
    bkTargets = bkTargets.map((t) => (t.id === id ? { ...t, ...(patch.name ? { name: patch.name } : {}) } : t));
    return bkTargets.find((t) => t.id === id)!;
  },
  testBackupTarget: async (id: string) => (await beat(500), bkTargets.find((t) => t.id === id)!),
  removeBackupTarget: async (id: string) => {
    await beat(300);
    bkTargets = bkTargets.filter((t) => t.id !== id);
    return { removed: 0 };
  },
  backupTargetApps: async () => [],
  appBackups: async (id: string) => bkFor(id),
  setAppBackups: async (id: string, p: Partial<BackupAppPolicyDto>) => {
    await beat(150);
    bkApps[id] = { ...(bkApps[id] ?? { enabled: false, targets: [], window: null, cadence: null, weekday: null }), ...p };
    return bkFor(id);
  },
  backupNow: async (id: string) => (await beat(200), bkFor(id)),
  setStoragePolicy: async (p: { autoMount?: boolean; autoStart?: boolean }): Promise<{ autoMount: boolean; autoStart: boolean }> => {
    await beat(150);
    storage = { ...storage, storagePolicy: { autoMount: p.autoMount ?? storage.storagePolicy.autoMount, autoStart: p.autoStart ?? storage.storagePolicy.autoStart } };
    return storage.storagePolicy;
  },
  mountDevice: async (name: string) => {
    await beat(1200); // slow enough that the Mounting… spinner + disabled lock is visible
    mockMountDevice(name);
    const dev = storage.devices.find((d) => d.name === name);
    return { device: name, state: 'mounted', message: `mounted at ${dev?.mountpoint ?? '/mnt/mock'} (mock)`, mountpoint: dev?.mountpoint ?? '/mnt/mock' };
  },
  unmountDevice: async (name: string) => {
    await beat(1200);
    mockUnmountDevice(name);
    return { device: name, state: 'unmounted', message: 'unmounted (mock)', mountpoint: null };
  },
  deviceStatus: async (name: string) => {
    const dev = storage.devices.find((d) => d.name === name);
    return dev?.mounted
      ? { device: name, state: 'mounted', message: `mounted at ${dev.mountpoint} (mock)`, mountpoint: dev.mountpoint }
      : { device: name, state: 'unmounted', message: 'unmounted (mock)', mountpoint: null };
  },
  formatDevice: async (name: string) => {
    await beat(1200); // slow enough that the Formatting… spinner + disabled lock is visible
    const mp = mockMountpointFor(name);
    const label = storage.devices.find((d) => d.name === name)?.label ?? name;
    mockFormatDevice(name, mp, label);
    return { device: name, state: 'formatted', message: `formatted as ext4 and mounted at ${mp} (mock)`, fsType: 'ext4', mountpoint: mp };
  },
  formatStatus: async (name: string) => {
    const dev = storage.devices.find((d) => d.name === name);
    return dev?.fsType === 'ext4' && dev.mounted
      ? { device: name, state: 'formatted', message: `formatted as ext4 and mounted at ${dev.mountpoint} (mock)`, fsType: 'ext4', mountpoint: dev.mountpoint }
      : { device: name, state: 'unmounted', message: 'no format operation recorded (mock)', fsType: null, mountpoint: null };
  },
  storageUsage: async (): Promise<StorageUsageDto> => mockStorageUsage(),
  notifications: async (): Promise<NotificationsDto> => notifications,
  markNotificationRead: async (id: string): Promise<NotificationsDto> => {
    notifications = { unread: Math.max(0, notifications.unread - 1), items: notifications.items.map((i) => (i.id === id ? { ...i, read: true } : i)) };
    return notifications;
  },
  markAllNotificationsRead: async (): Promise<NotificationsDto> => {
    notifications = { unread: 0, items: notifications.items.map((i) => ({ ...i, read: true })) };
    return notifications;
  },
  dismissNotification: async (id: string): Promise<NotificationsDto> => {
    const removed = notifications.items.find((i) => i.id === id);
    notifications = { unread: Math.max(0, notifications.unread - (removed && !removed.read ? 1 : 0)), items: notifications.items.filter((i) => i.id !== id) };
    return notifications;
  },
  dismissAllNotifications: async (): Promise<NotificationsDto> => {
    notifications = { unread: 0, items: [] };
    return notifications;
  },
  notificationChannels: async () => ({ channels }),
  setNotificationChannels: async (next: NotificationChannelDto[]) => {
    await beat();
    channels = next;
    return { channels };
  },
  testNotificationChannels: async () => ({ results: channels.map((c) => ({ kind: c.kind, ok: true, error: null })) }),
  updatesPolicy: async () => ({ autoDefault: true }),
  setUpdatesPolicy: async (autoDefault: boolean) => {
    await beat();
    return { autoDefault };
  },
  setAutoUpdate: async (instanceId: string, enabled: boolean): Promise<InstanceSummary> => {
    await beat(150);
    const inst = instances.find((i) => i.id === instanceId)!;
    const next = { ...inst, autoUpdate: enabled };
    instances = instances.map((i) => (i.id === instanceId ? next : i));
    return next;
  },
  adoptDrive: async (instanceId: string): Promise<InstanceSummary> => {
    await beat(150);
    const inst = instances.find((i) => i.id === instanceId)!;
    const next = { ...inst, needsDrive: null };
    instances = instances.map((i) => (i.id === instanceId ? next : i));
    return next;
  },
  applyAllUpdates: async () => ({ started: [{ instanceId: 'inst-immich', name: 'immich', operationId: 'op-mock-update' }], skipped: [] }),
  packageSources: async () => [],
  addPackageSource: async () => {
    throw new Error('Design mode: git sources are read-only here.');
  },
  checkPackageSource: async () => {
    throw new Error('Design mode: git sources are read-only here.');
  },
  setSourceAutoRedeploy: async () => {
    throw new Error('Design mode: git sources are read-only here.');
  },
  removePackageSource: async (): Promise<void> => {
    await beat(150);
  },
  folders: async (path: string) => ({ path, parent: path === '/' ? null : '/', writable: true, entries: [{ name: 'Photos', path: `${path.replace(/\/$/, '')}/Photos`, writable: true }] }),
  createFolder: async (parent: string, name: string) => {
    await beat(150);
    return { name, path: `${parent.replace(/\/$/, '')}/${name}`, writable: true };
  },
  tailscaleLogin: async () => ({ loginUrl: 'https://login.tailscale.com/admin/mock', status: 'login_url' as const }),
  tailscaleLogout: async (): Promise<void> => {
    await beat(150);
  },
  // LAN HTTPS in design mode: the toggle flips the fixture so the card, the
  // trust probe (mocked trusted) and the banner can be exercised with clicks.
  networkHttps: async (): Promise<NetworkHttpsDto> => ({ ...mockSystem().network.https, breaksWhenOff: [], restartToApply: [] }),
  addressOptions: async () => ({ local: { kind: 'http' as const, host: 'homelab.local' }, tailnet: { hostname: 'homelab.tail1234.ts.net' }, domains: ['cloud.example.com'] }),
  setNetworkHttps: async (enabled: boolean): Promise<NetworkHttpsDto> => {
    await beat(150);
    return enabled
      ? { enabled: true, url: 'https://harbor.local/', fingerprint: 'AA:BB:CC (mock)', expiresAt: new Date(Date.now() + 800 * 86400_000).toISOString(), hosts: ['harbor.local', 'homelab.local'], breaksWhenOff: [], restartToApply: ['nextcloud'] }
      : { enabled: false, url: null, fingerprint: null, expiresAt: null, hosts: [], breaksWhenOff: [], restartToApply: ['nextcloud'] };
  },
  probeHttpsTrust: async (): Promise<'trusted' | 'untrusted' | 'unreachable'> => 'trusted',
  domains: async (): Promise<DomainsDto> => mockDomains(),
  addDomain: async (hostname: string) => {
    await beat();
    return { hostname, dns: { state: 'points_here' as const, addresses: ['203.0.113.7'], checkedAt: new Date().toISOString(), note: null }, usedBy: null };
  },
  checkDomain: async (hostname: string) => {
    await beat();
    return { hostname, dns: { state: 'points_here' as const, addresses: ['203.0.113.7'], checkedAt: new Date().toISOString(), note: null }, usedBy: null };
  },
  forgetDomain: async (): Promise<void> => {
    await beat(150);
  },
  appearance: async (): Promise<AppearanceDto> => ({ ...appearance, home: { order } }),
  setRotation: async () => appearance,
  nextWallpaper: async () => appearance,
  setHomeOrder: async (next: string[]) => {
    order = next;
    return { ...appearance, home: { order } };
  },
  setInstanceAppearance: async (id: string) => instances.find((i) => i.id === id) ?? instances[0]!,
  systemHost: async (): Promise<SystemHostDto> => mockHost(),
  security: async () => ({ username: 'carlos', displayName: 'Carlos', twoFactor: false, pending: false, recoveryKey: { createdAt: new Date(Date.now() - 86_400_000).toISOString() } }),
  setDisplayName: async (name: string | null) => {
    await beat(150);
    return { username: 'carlos', displayName: name?.trim() ? name.trim() : null };
  },
  rotateRecoveryKey: async () => {
    await beat();
    return { recoveryKey: 'zebra zone zoo zero youth yellow year wrong write worth world work', restamped: ['Immich'], unreachable: [] };
  },
  totpSetup: async () => ({ secret: 'MOCK-SECRET', otpauthUrl: 'otpauth://totp/Harbor?secret=MOCK' }),
  totpEnable: async (): Promise<void> => {
    await beat(150);
  },
  totpDisable: async (): Promise<void> => {
    await beat(150);
  },
  setDeviceName: async (name: string | null): Promise<SystemDto> => ({ ...mockSystem(), deviceName: name }),
  harborLogs: async () => ({ source: 'memory' as const, lines: ['[mock] harbor started', '[mock] watching 7 apps'] }),
  instanceLogs: async () => ({ containers: [{ name: 'web', service: 'web', lines: ['[mock] listening on :80'] }] }),
  uploadPackage: async () => {
    throw new Error('Design mode: uploads are disabled here.');
  },
  removePackage: async (): Promise<void> => {
    await beat(150);
  },
  power: async (action: 'reboot' | 'poweroff') => {
    await beat(150);
    return { action, accepted: true };
  },
  setWallpaper: async (): Promise<void> => {
    await beat(150);
  },
  clearWallpaper: async (): Promise<void> => {
    await beat(150);
  },
  hasWallpaper: async (): Promise<boolean> => false,
};
