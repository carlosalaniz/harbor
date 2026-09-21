import type {
  AppearanceDto,
  CatalogItemDto,
  DomainsDto,
  ExposureDto,
  HostStorageDto,
  InstanceDetail,
  InstanceSummary,
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

export const mockApi = {
  async login(): Promise<{ token: string; expiresAt: string }> {
    await beat(150);
    return { token: 'mock-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
  currentToken: (): string | null => 'mock-token',
  setupStatus: async () => ({ needed: false, hostname: 'harbor', deviceName: 'homelab', lan: { enabled: false, url: null }, tailscale: { installed: true, loggedIn: true }, version: '0.9.0' }),
  setup: async () => ({ token: 'mock-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
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
    return { operationId: op.id, created: true, operation: op };
  },
  foundApps: async () => [
    { home: '/mnt/photos/harbor-apps/immich-2', name: 'immich-2', displayName: 'Immich (2)', packageId: 'immich', packageRevision: '1', instanceId: null, drive: 'Photos', adopted: false, error: null },
  ],
  adoptFoundApp: async (home: string) => {
    await beat();
    const inst = instances[0]!;
    return { ...inst, name: 'immich-2', home: { path: home, encrypted: true, state: 'unlocked' as const } };
  },
  operation: async (id: string): Promise<OperationDto> => opFor('install', instances[0]!.id, id),
  changePassword: async () => {
    await beat();
    return { revokedSessions: 1 };
  },
  hostStorage: async (): Promise<HostStorageDto> => storage,
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
  security: async () => ({ username: 'carlos', twoFactor: false, pending: false }),
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
