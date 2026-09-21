import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppearanceDto, CatalogItemDto, ExposureDto, InstanceSummary, NotificationsDto, OperationDto, PlanDto, PlanRequest, PlatformToolDto, SystemDto, SystemMetricsDto, UiExposureDto } from '../../../src/contracts/api';
import { ApiError, api, newIdempotencyKey } from '../api';

export interface Data {
  system: SystemDto | null;
  metrics: SystemMetricsDto | null;
  catalog: CatalogItemDto[];
  instances: InstanceSummary[];
  tools: PlatformToolDto[];
  exposures: ExposureDto[];
  uiExposure: UiExposureDto | null;
  appearance: AppearanceDto | null;
  notifications: NotificationsDto | null;
}

export type Action =
  | { kind: 'install'; packageId: string; name: string; storage?: Record<string, { hostPath: string }>; location?: { dir: string; passphrase?: string } }
  | { kind: 'start' | 'stop' | 'remove' | 'reinstall' | 'purge' | 'update'; instance: InstanceSummary }
  | { kind: 'expose'; instance: InstanceSummary; via: 'tailnet' | 'public'; hostname: string; protection: 'none' | 'basic'; makePrimary: boolean }
  | { kind: 'unexpose'; instance: InstanceSummary; via: 'tailnet' | 'public' }
  | { kind: 'reconfigure'; instance: InstanceSummary; primary: 'loopback' | 'tailnet' | 'public' };

export function planRequestFor(a: Action): PlanRequest {
  switch (a.kind) {
    case 'install':
      // The passphrase is validated at plan time but never stored in the plan:
      // planRequestFor strips it for the plan call; the approve step sends it
      // with the submission (see submitPassphraseFor).
      return { kind: 'install', packageId: a.packageId, ...(a.name ? { name: a.name } : {}), ...(a.storage && Object.keys(a.storage).length ? { storage: a.storage } : {}), ...(a.location ? { location: a.location } : {}) };
    case 'expose':
      return { kind: 'expose', instanceId: a.instance.id, via: a.via, ...(a.via === 'public' ? { hostname: a.hostname, protection: a.protection } : {}), makePrimary: a.makePrimary };
    case 'unexpose':
      return { kind: 'unexpose', instanceId: a.instance.id, via: a.via };
    case 'reconfigure':
      return { kind: 'reconfigure', instanceId: a.instance.id, primary: a.primary };
    default:
      return { kind: a.kind, instanceId: a.instance.id };
  }
}

export const isFinal = (op: OperationDto) => op.state === 'succeeded' || op.state === 'failed' || op.state === 'needs_action';

// The install-location passphrase travels with the submission, never in the plan.
export function submitPassphraseFor(a: Action | null): string | undefined {
  return a?.kind === 'install' && a.location ? a.location.passphrase : undefined;
}

// One store for the console: polling, the plan → approve → operation flow with a stable idempotency
// key per plan, and the operation tray. Everything comes from the daemon; nothing is cached across reloads.
export function useConsole(onAuthLost: (msg?: string) => void) {
  const [data, setData] = useState<Data>({ system: null, metrics: null, catalog: [], instances: [], tools: [], exposures: [], uiExposure: null, appearance: null, notifications: null });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [watching, setWatching] = useState<OperationDto | null>(null);
  const [lastDone, setLastDone] = useState<OperationDto | null>(null);
  const key = useRef<string | null>(null);
  const submitting = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [system, catalog, instances, tools, exp, metrics, appearance, notifications] = await Promise.all([api.system(), api.catalog(), api.instances(), api.tools(), api.exposures(), api.metrics().catch(() => null), api.appearance().catch(() => null), api.notifications().catch(() => null)]);
      setData((prev) => ({ system, metrics, catalog, instances, tools, exposures: exp.items, uiExposure: exp.ui, appearance: appearance ?? prev.appearance, notifications: notifications ?? prev.notifications }));
      setLoadError(null);
      setLoaded(true);
      if (!watching) {
        const active = instances.find((i) => i.installState === 'installing' || (i.operationId && i.runtime === 'starting'));
        if (active?.operationId) setWatching(await api.operation(active.operationId));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthLost();
      else setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [onAuthLost, watching]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), watching && !isFinal(watching) ? 2000 : 10000);
    return () => clearInterval(t);
  }, [refresh, watching]);

  useEffect(() => {
    if (!watching || isFinal(watching)) return;
    const t = setInterval(async () => {
      try {
        const op = await api.operation(watching.id);
        setWatching(op);
        if (isFinal(op)) {
          setLastDone(op);
          void refresh();
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onAuthLost();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [watching, refresh, onAuthLost]);

  const start = async (action: Action) => {
    setPending(action);
    setPlan(null);
    setPlanError(null);
    try {
      // Strip the passphrase for the plan call: the daemon validates it but
      // never stores it in the plan. It travels with approve() instead.
      const req = planRequestFor(action);
      if (req.kind === 'install' && req.location) req.location = { dir: req.location.dir, passphrase: req.location.passphrase };
      setPlan(await api.plan(req));
      key.current = newIdempotencyKey();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      setPlanError(e instanceof ApiError ? `${e.message} ${e.nextAction}` : String(e));
    }
  };

  const approve = async () => {
    if (!plan || submitting.current) return;
    submitting.current = true;
    try {
      const k = key.current ?? (key.current = newIdempotencyKey());
      const r = await api.submit(plan.id, k, submitPassphraseFor(pending));
      setWatching(r.operation);
      setPending(null);
      setPlan(null);
      void refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      setPlanError(e instanceof ApiError ? `${e.message} ${e.nextAction}` : String(e));
    } finally {
      submitting.current = false;
    }
  };

  const cancel = () => {
    setPending(null);
    setPlan(null);
    setPlanError(null);
  };

  // Small settings writes (launcher order, an app's look, wallpaper) apply optimistically and re-sync.
  const patchData = useCallback((fn: (d: Data) => Data) => setData(fn), []);

  const busy = Boolean(watching && !isFinal(watching)) || data.system?.busyOperationId != null;
  return { data, loaded, loadError, pending, plan, planError, watching, lastDone, busy, start, approve, cancel, refresh, patchData, dismiss: () => { setWatching(null); setLastDone(null); } };
}

export type Console = ReturnType<typeof useConsole>;
