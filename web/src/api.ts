import type { ApiErrorBody, AppearanceDto, InstanceAppearancePatch, InstanceLogsDto, LogsDto, PackageImportResultDto, RotationPatch, SecurityDto, SystemHostDto, TotpSetupDto, CatalogItemDto, DomainDto, DomainsDto, ExposureDto, FolderListingDto, HostStorageDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlanRequest, PlatformToolDto, SessionDto, SystemDto, SystemMetricsDto, TailscaleLoginDto, UiExposureDto } from '../../src/contracts/api';

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

// The bearer token lives only in this module's memory. Never cookies, localStorage or sessionStorage:
// a reload requires logging in again, then the UI resumes from server state.
let token: string | null = null;

export function hasToken(): boolean {
  return token !== null;
}
export function forgetToken(): void {
  token = null;
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

export const api = {
  async login(username: string, password: string, code?: string): Promise<SessionDto> {
    const s = await call<SessionDto>('POST', '/v1/sessions', { username, password, ...(code ? { code } : {}) });
    token = s.token;
    return s;
  },
  // the terminal authenticates with the session token in its first WebSocket message
  currentToken: (): string | null => token,
  async logout(): Promise<void> {
    try {
      await call<void>('DELETE', '/v1/sessions/current');
    } finally {
      token = null;
    }
  },
  system: () => call<SystemDto>('GET', '/v1/system'),
  metrics: () => call<SystemMetricsDto>('GET', '/v1/system/metrics'),
  catalog: () => call<{ items: CatalogItemDto[] }>('GET', '/v1/catalog').then((r) => r.items),
  instances: () => call<{ items: InstanceSummary[] }>('GET', '/v1/instances').then((r) => r.items),
  instance: (id: string) => call<InstanceDetail>('GET', `/v1/instances/${id}`),
  tools: () => call<{ items: PlatformToolDto[] }>('GET', '/v1/platform-tools').then((r) => r.items),
  exposures: () => call<{ items: ExposureDto[]; ui: UiExposureDto | null }>('GET', '/v1/exposures'),
  exposeUi: () => call<UiExposureDto>('PUT', '/v1/ui-exposure', { via: 'tailnet' }),
  unexposeUi: () => call<void>('DELETE', '/v1/ui-exposure'),
  plan: (req: PlanRequest) => call<PlanDto>('POST', '/v1/plans', req),
  submit: (planId: string, idempotencyKey: string) => call<{ operationId: string; created: boolean; operation: OperationDto }>('POST', '/v1/operations', { planId }, { 'idempotency-key': idempotencyKey }),
  operation: (id: string) => call<OperationDto>('GET', `/v1/operations/${id}`),
  // settings
  changePassword: (currentPassword: string, newPassword: string) => call<{ revokedSessions: number }>('PUT', '/v1/account/password', { currentPassword, newPassword }),
  hostStorage: () => call<HostStorageDto>('GET', '/v1/host/storage'),
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
      const r = await fetch('/v1/appearance/wallpaper', { method: 'HEAD' });
      return r.ok;
    } catch {
      return false;
    }
  },
};

export function newIdempotencyKey(): string {
  return `ui-${crypto.randomUUID()}`;
}
