import type { ApiErrorBody, CatalogItemDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlanRequest, PlatformToolDto, SessionDto, SystemDto, SystemMetricsDto, UiExposureDto } from '../../src/contracts/api';

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
  async login(username: string, password: string): Promise<SessionDto> {
    const s = await call<SessionDto>('POST', '/v1/sessions', { username, password });
    token = s.token;
    return s;
  },
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
};

export function newIdempotencyKey(): string {
  return `ui-${crypto.randomUUID()}`;
}
