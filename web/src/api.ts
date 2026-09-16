import type { ApiErrorBody, AppearanceDto, InstanceAppearancePatch, InstanceLogsDto, LogsDto, PackageImportResultDto, RotationPatch, SecurityDto, SelfUpdateStatusDto, SessionInfoDto, SetupRequest, SetupStatusDto, SystemHostDto, TotpSetupDto, CatalogItemDto, DomainDto, DomainsDto, ExposureDto, FolderListingDto, HostStorageDto, NotificationChannelDto, NotificationsDto, StorageUsageDto, AddSourceResult, PackageSourceDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlanRequest, PlatformToolDto, SessionDto, SystemDto, SystemMetricsDto, TailscaleLoginDto, UiExposureDto, WidgetDto } from '../../src/contracts/api';
import { isMockUi, mockApi } from './mock/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nextAction: string,
    readonly operationId?: string,
  ) {
    super(message);
  }
}

// Session token storage. The short session lives only in memory (a reload asks for the
// password again). "Remember this browser" keeps the 30-day token in localStorage so a
// reload resumes silently; the daemon only ever sees the bearer token.
let token: string | null = null;

const REMEMBER_KEY = 'harbor.remember';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
function lsDel(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function hasToken(): boolean {
  return token !== null;
}
export function forgetToken(): void {
  token = null;
}
// A remembered browser resumes silently: restore the stored token into memory.
// Returns false when there is nothing stored (full login needed).
export function restoreRemembered(): boolean {
  if (token) return true;
  const saved = lsGet(REMEMBER_KEY);
  if (!saved) return false;
  token = saved;
  return true;
}
export function saveRemembered(tok: string): void {
  lsSet(REMEMBER_KEY, tok);
}
export function clearRemembered(): void {
  lsDel(REMEMBER_KEY);
}

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { accept: 'application/json', ...headers };
  if (token) h['authorization'] = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (parsed as ApiErrorBody | null)?.error;
    if (res.status === 401) token = null;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `HTTP ${res.status}`, e?.nextAction ?? '', e?.operationId);
  }
  return parsed as T;
}

// Design mode (`pnpm dev:ui`, `?mock=1`, or localStorage harbor.ui-mock=1): the console renders
// from in-memory fixtures with no daemon and no login. The mock object mirrors this module's
// surface; unknown keys fall back to the real fetch path so new endpoints fail loudly.
const realApi = {
  async login(username: string, password: string, code?: string, remember = false): Promise<SessionDto> {
    const s = await call<SessionDto>('POST', '/v1/sessions', { username, password, ...(code ? { code } : {}), ...(remember ? { remember: true } : {}) });
    token = s.token;
    if (remember) saveRemembered(s.token);
    else clearRemembered();
    return s;
  },
  // the terminal authenticates with the session token in its first WebSocket message
  currentToken: (): string | null => token,
  // first-run setup (open routes)
  setupStatus: () => call<SetupStatusDto>('GET', '/v1/setup'),
  async setup(req: SetupRequest): Promise<SessionDto> {
    const s = await call<SessionDto>('POST', '/v1/setup', req);
    token = s.token;
    return s;
  },
  // Harbor's own updates
  selfUpdate: () => call<SelfUpdateStatusDto>('GET', '/v1/system/update'),
  selfUpdateCheck: () => call<SelfUpdateStatusDto>('POST', '/v1/system/update/check', {}),
  selfUpdateApply: () => call<SelfUpdateStatusDto>('POST', '/v1/system/update/apply', {}),
  async logout(): Promise<void> {
    try {
      await call<void>('DELETE', '/v1/sessions/current');
    } finally {
      token = null;
      clearRemembered();
    }
  },
  sessions: () => call<{ items: SessionInfoDto[] }>('GET', '/v1/sessions').then((r) => r.items),
  revokeOtherSessions: () => call<void>('DELETE', '/v1/sessions/others'),
  system: () => call<SystemDto>('GET', '/v1/system'),
  metrics: () => call<SystemMetricsDto>('GET', '/v1/system/metrics'),
  catalog: () => call<{ items: CatalogItemDto[] }>('GET', '/v1/catalog').then((r) => r.items),
  instances: () => call<{ items: InstanceSummary[] }>('GET', '/v1/instances').then((r) => r.items),
  instance: (id: string) => call<InstanceDetail>('GET', `/v1/instances/${id}`),
  widget: (id: string) => call<WidgetDto | null>('GET', `/v1/instances/${id}/widget`),
  tools: () => call<{ items: PlatformToolDto[] }>('GET', '/v1/platform-tools').then((r) => r.items),
  installTool: (id: string) => call<PlatformToolDto>('POST', `/v1/platform-tools/${id}/install`, {}),
  exposures: () => call<{ items: ExposureDto[]; ui: UiExposureDto | null }>('GET', '/v1/exposures'),
  exposeUi: () => call<UiExposureDto>('PUT', '/v1/ui-exposure', { via: 'tailnet' }),
  unexposeUi: () => call<void>('DELETE', '/v1/ui-exposure'),
  plan: (req: PlanRequest) => call<PlanDto>('POST', '/v1/plans', req),
  submit: (planId: string, idempotencyKey: string) => call<{ operationId: string; created: boolean; operation: OperationDto }>('POST', '/v1/operations', { planId }, { 'idempotency-key': idempotencyKey }),
  operation: (id: string) => call<OperationDto>('GET', `/v1/operations/${id}`),
  // settings
  changePassword: (currentPassword: string, newPassword: string) => call<{ revokedSessions: number }>('PUT', '/v1/account/password', { currentPassword, newPassword }),
  hostStorage: () => call<HostStorageDto>('GET', '/v1/host/storage'),
  storageUsage: () => call<StorageUsageDto>('GET', '/v1/system/storage/usage'),
  notifications: () => call<NotificationsDto>('GET', '/v1/notifications'),
  markNotificationRead: (id: string) => call<NotificationsDto>('POST', `/v1/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => call<NotificationsDto>('POST', '/v1/notifications/read-all', {}),
  notificationChannels: () => call<{ channels: NotificationChannelDto[] }>('GET', '/v1/notifications/channels'),
  setNotificationChannels: (channels: NotificationChannelDto[]) => call<{ channels: NotificationChannelDto[] }>('PUT', '/v1/notifications/channels', { channels }),
  testNotificationChannels: () => call<{ results: { kind: string; ok: boolean; error: string | null }[] }>('POST', '/v1/notifications/channels/test', {}),
  updatesPolicy: () => call<{ autoDefault: boolean }>('GET', '/v1/updates/policy'),
  setUpdatesPolicy: (autoDefault: boolean) => call<{ autoDefault: boolean }>('PUT', '/v1/updates/policy', { autoDefault }),
  setAutoUpdate: (instanceId: string, enabled: boolean) => call<InstanceSummary>('PUT', `/v1/instances/${instanceId}/auto-update`, { enabled }),
  applyAllUpdates: () => call<{ started: { instanceId: string; name: string; operationId: string }[]; skipped: { instanceId: string; name: string; reason: string }[] }>('POST', '/v1/updates/apply-all', {}),
  packageSources: () => call<{ items: PackageSourceDto[] }>('GET', '/v1/package-sources').then((r) => r.items),
  addPackageSource: (req: { url: string; ref?: string; subpath?: string; autoRedeploy?: boolean }) => call<AddSourceResult>('POST', '/v1/package-sources', req),
  checkPackageSource: (id: string) => call<PackageSourceDto>('POST', `/v1/package-sources/${id}/check`, {}),
  setSourceAutoRedeploy: (id: string, enabled: boolean) => call<PackageSourceDto>('PUT', `/v1/package-sources/${id}/auto-redeploy`, { enabled }),
  removePackageSource: (id: string) => call<void>('DELETE', `/v1/package-sources/${id}`),
  folders: (path: string) => call<FolderListingDto>('GET', `/v1/host/folders?path=${encodeURIComponent(path)}`),
  createFolder: (parent: string, name: string) => call<{ name: string; path: string; writable: boolean }>('POST', '/v1/host/folders', { parent, name }),
  tailscaleLogin: (authKey?: string) => call<TailscaleLoginDto>('POST', '/v1/platform-tools/tailscale/login', authKey ? { authKey } : {}),
  tailscaleLogout: () => call<void>('POST', '/v1/platform-tools/tailscale/logout', {}),
  domains: () => call<DomainsDto>('GET', '/v1/domains'),
  addDomain: (hostname: string) => call<DomainDto>('POST', '/v1/domains', { hostname }),
  checkDomain: (hostname: string) => call<DomainDto>('POST', `/v1/domains/${encodeURIComponent(hostname)}/check`, {}),
  forgetDomain: (hostname: string) => call<void>('DELETE', `/v1/domains/${encodeURIComponent(hostname)}`),
  // appearance
  appearance: () => call<AppearanceDto>('GET', '/v1/appearance'),
  setRotation: (patch: RotationPatch) => call<AppearanceDto>('PUT', '/v1/appearance/rotation', patch),
  nextWallpaper: () => call<AppearanceDto>('POST', '/v1/appearance/rotation/next', {}),
  setHomeOrder: (order: string[]) => call<AppearanceDto>('PUT', '/v1/appearance/home', { order }),
  setInstanceAppearance: (id: string, patch: InstanceAppearancePatch) => call<InstanceSummary>('PUT', `/v1/instances/${id}/appearance`, patch),
  systemHost: () => call<SystemHostDto>('GET', '/v1/system/host'),
  // security, device, logs
  security: () => call<SecurityDto>('GET', '/v1/account/security'),
  totpSetup: () => call<TotpSetupDto>('POST', '/v1/account/totp/setup', {}),
  totpEnable: (code: string) => call<void>('POST', '/v1/account/totp/enable', { code }),
  totpDisable: (password: string) => call<void>('POST', '/v1/account/totp/disable', { password }),
  setDeviceName: (name: string | null) => call<SystemDto>('PUT', '/v1/system/name', { name }),
  harborLogs: (lines = 300) => call<LogsDto>('GET', `/v1/logs/harbor?lines=${lines}`),
  instanceLogs: (id: string, lines = 300) => call<InstanceLogsDto>('GET', `/v1/instances/${id}/logs?lines=${lines}`),
  // your own apps
  uploadPackage: (fileName: string, dataUrl: string) => call<PackageImportResultDto>('POST', '/v1/packages', { fileName, dataUrl }),
  removePackage: (id: string) => call<void>('DELETE', `/v1/packages/${encodeURIComponent(id)}`),
  power: (action: 'reboot' | 'poweroff') => call<{ action: string; accepted: boolean }>('POST', '/v1/system/power', { action }),
  setWallpaper: (dataUrl: string) => call<void>('PUT', '/v1/appearance/wallpaper', { dataUrl }),
  clearWallpaper: () => call<void>('DELETE', '/v1/appearance/wallpaper'),
  hasWallpaper: async (): Promise<boolean> => {
    try {
      if (isMockUi()) return false;
      const r = await fetch('/v1/appearance/wallpaper', { method: 'HEAD' });
      return r.ok;
    } catch {
      return false;
    }
  },
};

// Design mode (`pnpm dev:ui`, `?mock=1`, or localStorage harbor.ui-mock=1): the console renders
// from in-memory fixtures with no daemon and no login. The mock object mirrors this module's
// surface; unknown keys fall back to the real fetch path so new endpoints fail loudly.
export const api: typeof realApi = new Proxy(realApi, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && isMockUi() && prop in mockApi) return Reflect.get(mockApi, prop);
    return Reflect.get(target, prop, receiver);
  },
});

// crypto.randomUUID needs a secure context; LAN mode serves the console over plain http://harbor.local, where
// only getRandomValues is available. Same entropy, hand-formatted.
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return `ui-${crypto.randomUUID()}`;
  const b = crypto.getRandomValues(new Uint8Array(16));
  return `ui-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
