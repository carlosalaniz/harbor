import { useCallback, useEffect, useRef, useState } from 'react';
import type { InternetMode, LinkChoice, LoginChange, SettingValue } from '../../../src/contracts/api';
import type { AppearanceDto, CatalogItemDto, InstallMainAddress, ExposureDto, InstanceSummary, NotificationsDto, OperationDto, OperationQueueDto, PlanDto, PlanRequest, PlatformToolDto, QueueableKind, SystemDto, SystemMetricsDto, UiExposureDto } from '../../../src/contracts/api';
import { ApiError, api, newIdempotencyKey } from '../api';
import { REFRESH_MS, alreadyQueued, clearFinished as withoutPlainFinished, isFinal, isQueueable, keepFinished, queuePollMs, reviewHasValues } from './queue';

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
  | { kind: 'install'; packageId: string; name: string; storage?: Record<string, { hostPath: string }>; location?: { dir: string; passphrase?: string }; main?: InstallMainAddress; links?: Record<string, LinkChoice>; internet?: InternetMode; tailnet?: boolean }
  // decisions 125/126/180: replace typed-in secrets (values asked in the review dialog), change link providers
  // and/or settings (the new values, from the app page's Settings → Change…)
  // decision 184: internet access (a mode, or 'default' to follow the package again)
  | { kind: 'configure'; instance: InstanceSummary; secrets?: string[]; links?: Record<string, LinkChoice | null>; settings?: Record<string, SettingValue>; internet?: InternetMode | 'default'; login?: Record<string, LoginChange> }
  | { kind: 'start' | 'stop' | 'restart' | 'remove' | 'reinstall' | 'purge' | 'update' | 'seal'; instance: InstanceSummary }
  | { kind: 'expose'; instance: InstanceSummary; via: 'tailnet' | 'public' | 'proxy'; hostname: string; protection: 'none' | 'basic'; makePrimary: boolean; proxyFrom?: string }
  // decision 127: hostname names one of several public names (withdraw it / make it the main address)
  | { kind: 'unexpose'; instance: InstanceSummary; via: 'tailnet' | 'public' | 'proxy'; hostname?: string }
  | { kind: 'reconfigure'; instance: InstanceSummary; primary: 'loopback' | 'tailnet' | 'public'; hostname?: string }
  // decision 145: dir = <candidate>/<package>
  | { kind: 'move'; instance: InstanceSummary; dir: string }
  // decision 153: restore in place from a restore point (its run), optionally from one place
  | { kind: 'restore'; instance: InstanceSummary; runId: string; targetId?: string }
  // decision 153: restore an app from a place onto this machine (an install plan from /v1/backups/restore)
  | { kind: 'restore-app'; targetId: string; instanceId: string; runId: string; dir: string; name?: string };

export function planRequestFor(a: Action): PlanRequest {
  switch (a.kind) {
    case 'install':
      // The passphrase is validated at plan time but never stored in the plan:
      // planRequestFor strips it for the plan call; the approve step sends it
      // with the submission (see submitPassphraseFor).
      return { kind: 'install', packageId: a.packageId, ...(a.name ? { name: a.name } : {}), ...(a.storage && Object.keys(a.storage).length ? { storage: a.storage } : {}), ...(a.location ? { location: a.location } : {}), ...(a.main ? { main: a.main } : {}), ...(a.links && Object.keys(a.links).length ? { links: a.links } : {}), ...(a.internet ? { internet: a.internet } : {}), ...(a.tailnet !== undefined ? { tailnet: a.tailnet } : {}) };
    case 'configure':
      return { kind: 'configure', instanceId: a.instance.id, ...(a.secrets?.length ? { secrets: a.secrets } : {}), ...(a.links && Object.keys(a.links).length ? { links: a.links } : {}), ...(a.settings && Object.keys(a.settings).length ? { settings: a.settings } : {}), ...(a.internet ? { internet: a.internet } : {}), ...(a.login && Object.keys(a.login).length ? { login: a.login } : {}) };
    case 'expose':
      return { kind: 'expose', instanceId: a.instance.id, via: a.via, ...(a.via === 'public' ? { hostname: a.hostname, protection: a.protection } : {}), ...(a.via === 'proxy' ? { hostname: a.hostname, proxyFrom: a.proxyFrom ?? '' } : {}), makePrimary: a.makePrimary };
    case 'unexpose':
      return { kind: 'unexpose', instanceId: a.instance.id, via: a.via, ...(a.hostname ? { hostname: a.hostname } : {}) };
    case 'reconfigure':
      return { kind: 'reconfigure', instanceId: a.instance.id, primary: a.primary, ...(a.hostname ? { hostname: a.hostname } : {}) };
    case 'move':
      return { kind: 'move', instanceId: a.instance.id, location: { dir: a.dir } };
    case 'restore':
      return { kind: 'restore', instanceId: a.instance.id, runId: a.runId, ...(a.targetId ? { targetId: a.targetId } : {}) };
    case 'restore-app':
      throw new Error('restore-app plans come from /v1/backups/restore');
    default:
      return { kind: a.kind, instanceId: a.instance.id };
  }
}

export { isFinal };

// The install-location passphrase travels with the submission, never in the plan.
export function submitPassphraseFor(a: Action | null): string | undefined {
  return a?.kind === 'install' && a.location ? a.location.passphrase : undefined;
}

// One store for the console: polling, the plan → approve → operation flow with a stable idempotency
// key per plan, and the queue (decision 183): what runs and waits, plus the operations this console saw finish,
// each with its own results until dismissed. Everything comes from the daemon; nothing is cached across reloads.
export function useConsole(onAuthLost: (msg?: string) => void) {
  const [data, setData] = useState<Data>({ system: null, metrics: null, catalog: [], instances: [], tools: [], exposures: [], uiExposure: null, appearance: null, notifications: null });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // The app already runs an operation: the review waits its turn instead of failing (a plan is a snapshot of the
  // app, so it is made once the other operation is done). Text for the dialog while waiting; null otherwise.
  // Decision 183: only for kinds that cannot be queued without a plan (configure, publish, move, …).
  const [waitingFor, setWaitingFor] = useState<string | null>(null);
  // Decision 183: the review is in queue mode — the app is busy with this operation, and the action joins the queue
  // without a plan (Harbor plans it at its turn). Null for a normal review.
  const [queuedBehind, setQueuedBehind] = useState<OperationDto | null>(null);
  // Decision 183: the same action already waits for this app — the dialog shows it (with its Cancel) instead of
  // queueing it twice. Null otherwise.
  const [duplicate, setDuplicate] = useState<OperationDto | null>(null);
  const startToken = useRef(0);
  // decision 164: the daemon restarted and this machine's key is locked; the review dialog asks for the password
  const [locked, setLocked] = useState(false);
  const lastApprove = useRef<{ secrets?: Record<string, string>; acceptPermissions: boolean; settings?: Record<string, SettingValue> }>({ acceptPermissions: false });
  const key = useRef<string | null>(null);
  const submitting = useRef(false);

  // decision 183: the queue, and the finished operations this console saw (approved here or seen active)
  const [queue, setQueue] = useState<OperationQueueDto>({ active: [], recent: [] });
  const [finished, setFinished] = useState<OperationDto[]>([]);
  const [trayCollapsed, setTrayCollapsed] = useState(false);
  const tracked = useRef(new Set<string>());
  // accepted from this console: their results stay in the tray until dismissed, whatever the outcome
  const acceptedHere = useRef(new Set<string>());
  const cancelledHere = useRef(new Set<string>());
  const polling = useRef<Promise<void> | null>(null);
  const pollAgain = useRef(false);

  const refresh = useCallback(async () => {
    try {
      // Platform tools probe Tailscale and Caddy, which can be slow (a wedged Caddy took 15 s): they fill in
      // on their own and never hold back Home's app list.
      void api
        .tools()
        .then((tools) => setData((prev) => ({ ...prev, tools })))
        .catch(() => undefined);
      const [system, catalog, instances, exp, metrics, appearance, notifications] = await Promise.all([api.system(), api.catalog(), api.instances(), api.exposures(), api.metrics().catch(() => null), api.appearance().catch(() => null), api.notifications().catch(() => null)]);
      setData((prev) => ({ ...prev, system, metrics, catalog, instances, exposures: exp.items, uiExposure: exp.ui, appearance: appearance ?? prev.appearance, notifications: notifications ?? prev.notifications }));
      setLoadError(null);
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onAuthLost();
      else setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [onAuthLost]);

  // One pass over the queue: the daemon's list, then every operation this console tracks that left it (fetched one
  // by one for its events and one-time results). Overlapping calls run once more after the current pass.
  const pollQueueOnce = async (): Promise<void> => {
    let q: OperationQueueDto | null = null;
    try {
      q = await api.queue(10);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      // no list: the tracked operations below still keep the tray honest
    }
    for (const op of q?.active ?? []) tracked.current.add(op.id);
    const listed = new Set((q?.active ?? []).map((o) => o.id));
    const extra: OperationDto[] = [];
    const done: OperationDto[] = [];
    for (const id of [...tracked.current].filter((x) => !listed.has(x))) {
      try {
        const op = await api.operation(id);
        if (isFinal(op)) {
          tracked.current.delete(id);
          if (!cancelledHere.current.delete(id)) done.push(op);
        } else extra.push(op); // accepted after the list was read: shown at the end until the next pass
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return onAuthLost();
        if (e instanceof ApiError && e.status === 404) tracked.current.delete(id);
      }
    }
    setQueue({ active: [...(q?.active ?? []), ...extra], recent: q?.recent ?? [] });
    if (done.length) {
      // a background operation (Harbor's own actor) drops out when it went well (keepFinished); a person's stays
      const kept = done.filter((d) => keepFinished(d, acceptedHere.current.has(d.id)));
      for (const d of done) if (!kept.includes(d)) acceptedHere.current.delete(d.id);
      if (kept.length) setFinished((prev) => [...kept.filter((d) => !prev.some((p) => p.id === d.id)).reverse(), ...prev]);
      void refresh();
    }
  };
  const pollQueue = async (): Promise<void> => {
    if (polling.current) {
      pollAgain.current = true;
      return polling.current;
    }
    polling.current = (async () => {
      do {
        pollAgain.current = false;
        await pollQueueOnce();
      } while (pollAgain.current);
    })().finally(() => {
      polling.current = null;
    });
    return polling.current;
  };
  const pollRef = useRef(pollQueue);
  pollRef.current = pollQueue;

  // The full refresh every 10 s; the queue every 2 s while anything runs or waits, else with the refresh. A tracked
  // operation that finishes refreshes at once (pollQueueOnce).
  const anyActive = queue.active.length > 0;
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    void pollRef.current();
    const t = setInterval(() => void pollRef.current(), queuePollMs(anyActive));
    return () => clearInterval(t);
  }, [anyActive]);

  // The first operation of an app that is still running or waiting, in run order.
  const activeFor = (instanceId: string): OperationDto | null => queue.active.find((o) => o.instanceId === instanceId) ?? null;

  // An operation was accepted here: track it and show it at once. Finished items stay until dismissed (or Clear
  // finished): approving something new never hides a result or an error the operator has not seen.
  const accepted = (op: OperationDto) => {
    tracked.current.add(op.id);
    acceptedHere.current.add(op.id);
    setQueue((q) => (q.active.some((x) => x.id === op.id) ? q : { ...q, active: [...q.active, op] }));
    setTrayCollapsed(false);
    void pollQueue();
    // the app list too: an Update that started clears its "update available" without waiting for the 10 s refresh
    void refresh();
  };

  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'MACHINE_KEY_LOCKED') {
      setLocked(true);
      setPlanError(null);
      return;
    }
    setPlanError(e instanceof ApiError ? `${e.message} ${e.nextAction}` : String(e));
  };

  // Resolves when operation `id` has finished, or false when the review was cancelled or replaced meanwhile.
  const waitTurn = async (id: string, token: number): Promise<boolean> => {
    for (;;) {
      if (startToken.current !== token) return false;
      try {
        const op = await api.operation(id);
        if (isFinal(op)) return startToken.current === token;
        const who = data.instances.find((i) => i.id === op.instanceId);
        setWaitingFor(`Waiting for ${who ? `${who.displayName ?? who.name}'s` : 'the current'} ${op.kind} to finish. The review opens by itself when it is done.`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) throw e;
        if (!(e instanceof ApiError && e.status === 404)) throw e;
        return startToken.current === token; // the operation is gone: try again
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  // Decision 183: a queueable action on a busy app joins the queue without a plan.
  const queueKind = (action: Action): QueueableKind | null => (isQueueable(action.kind) && 'instance' in action ? action.kind : null);
  // `active`: the queue as known now; when the same action already waits for the app, show that one instead.
  const enterQueueMode = (behind: OperationDto, kind: QueueableKind, active: OperationDto[]) => {
    setPlan(null);
    setQueuedBehind(behind);
    // `behind` (the app's first item) may be newer than the list: put it first, in run order
    setDuplicate(alreadyQueued(active.some((o) => o.id === behind.id) ? active : [behind, ...active], behind.instanceId, kind));
    key.current = newIdempotencyKey();
  };

  // opts.wait: never queue — wait for the app and review again (decision 173). approve() asks for it when the review
  // carries values the operator gave (typed secrets, accepted permissions, changed settings): a queued action would
  // drop them.
  const start = async (action: Action, opts: { wait?: boolean } = {}) => {
    const token = ++startToken.current;
    setPending(action);
    setPlan(null);
    setPlanError(null);
    setWaitingFor(null);
    setQueuedBehind(null);
    setDuplicate(null);
    setLocked(false);
    const qk = opts.wait ? null : queueKind(action);
    const behind = qk && 'instance' in action ? activeFor(action.instance.id) : null;
    if (qk && behind) return enterQueueMode(behind, qk, queue.active);
    try {
      for (;;) {
        try {
          await planOnce(action);
          break;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'BUSY' && e.operationId) {
            // The app became busy between the render and the click: queue it instead of waiting.
            if (qk) {
              const id = e.operationId;
              const op = await api.operation(id).catch(() => null);
              if (startToken.current !== token) return;
              if (op && !isFinal(op)) return enterQueueMode(op, qk, queue.active);
              continue; // it finished meanwhile: plan again
            }
            if (!(await waitTurn(e.operationId, token))) return;
            continue;
          }
          throw e;
        }
      }
      if (startToken.current === token) setWaitingFor(null);
    } catch (e) {
      if (startToken.current !== token) return;
      setWaitingFor(null);
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      failed(e);
    }
  };

  const planOnce = async (action: Action) => {
    // Strip the passphrase for the plan call: the daemon validates it but
    // never stores it in the plan. It travels with approve() instead.
    if (action.kind === 'restore-app') {
      setPlan(await api.restoreAppPlan({ targetId: action.targetId, instanceId: action.instanceId, runId: action.runId, location: { dir: action.dir }, ...(action.name ? { name: action.name } : {}) }));
      key.current = newIdempotencyKey();
      return;
    }
    const req = planRequestFor(action);
    if (req.kind === 'install' && req.location) req.location = { dir: req.location.dir, passphrase: req.location.passphrase };
    setPlan(await api.plan(req));
    key.current = newIdempotencyKey();
  };

  // Queue mode: one idempotency key per dialog, so a double click queues it once.
  const approveQueued = async () => {
    const qk = pending ? queueKind(pending) : null;
    if (!pending || !qk || !('instance' in pending) || submitting.current) return;
    submitting.current = true;
    try {
      const k = key.current ?? (key.current = newIdempotencyKey());
      const r = await api.queueAction(qk, pending.instance.id, k);
      accepted(r.operation);
      setQueuedBehind(null);
      setPending(null);
      setPlan(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      failed(e);
    } finally {
      submitting.current = false;
    }
  };

  // secrets: values typed in the review dialog for operator-provided secrets (decision 125); in memory only.
  // settings: values changed under Options in the review (decision 180), only ids the plan asks about.
  const approve = async (secrets?: Record<string, string>, acceptPermissions = false, settings?: Record<string, SettingValue>) => {
    if (queuedBehind) return approveQueued();
    if (!plan || submitting.current) return;
    submitting.current = true;
    lastApprove.current = { ...(secrets ? { secrets } : {}), acceptPermissions, ...(settings ? { settings } : {}) };
    try {
      const k = key.current ?? (key.current = newIdempotencyKey());
      let r;
      try {
        r = await api.submit(plan.id, k, submitPassphraseFor(pending), secrets, acceptPermissions, settings);
      } catch (e) {
        // Another operation started on the app since the review was made: queue it (decision 183), or wait for it
        // and review again (the kinds that need a plan, and any review the operator gave values in).
        if (e instanceof ApiError && e.code === 'BUSY' && pending) {
          submitting.current = false;
          return void start(pending, { wait: reviewHasValues(lastApprove.current) });
        }
        throw e;
      }
      accepted(r.operation);
      setPending(null);
      setPlan(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      failed(e);
    } finally {
      submitting.current = false;
    }
  };

  const cancel = () => {
    startToken.current++;
    setWaitingFor(null);
    setQueuedBehind(null);
    setDuplicate(null);
    setPending(null);
    setPlan(null);
    setPlanError(null);
    setLocked(false);
  };

  // Decision 183: cancel a waiting item. Resolves to null, or to the reason it could not be cancelled.
  const cancelOperation = async (id: string): Promise<string | null> => {
    cancelledHere.current.add(id);
    try {
      await api.cancelOperation(id);
      tracked.current.delete(id);
      setQueue((q) => ({ ...q, active: q.active.filter((x) => x.id !== id) }));
      void pollQueue();
      void refresh();
      return null;
    } catch (e) {
      cancelledHere.current.delete(id);
      if (e instanceof ApiError && e.status === 401) {
        onAuthLost();
        return null;
      }
      void pollQueue();
      return e instanceof ApiError ? `${e.message}${e.nextAction ? ` ${e.nextAction}` : ''}` : String(e);
    }
  };

  // Unlock with the password, then carry on where it stopped (plan again, or approve again). Throws on a
  // wrong password so the prompt can say so.
  const unlockAndRetry = async (password: string) => {
    await api.unlockMachine(password);
    setLocked(false);
    if (plan) await approve(lastApprove.current.secrets, lastApprove.current.acceptPermissions, lastApprove.current.settings);
    else if (pending) await start(pending);
  };

  // Small settings writes (launcher order, an app's look, wallpaper) apply optimistically and re-sync.
  const patchData = useCallback((fn: (d: Data) => Data) => setData(fn), []);

  // The same action already waited: take that one out of the queue from the dialog, or say why it could not be.
  const cancelDuplicate = async () => {
    if (!duplicate) return;
    const err = await cancelOperation(duplicate.id);
    if (err) setPlanError(err);
    else cancel();
  };

  const dismiss = (id: string) => {
    acceptedHere.current.delete(id);
    setFinished((prev) => prev.filter((x) => x.id !== id));
  };
  // Clear finished: every finished item, except those still showing a value once (each needs its own yes).
  const clearFinished = () =>
    setFinished((prev) => {
      const left = withoutPlainFinished(prev);
      for (const p of prev) if (!left.includes(p)) acceptedHere.current.delete(p.id);
      return left;
    });
  return { data, loaded, loadError, pending, plan, planError, waitingFor, queuedBehind, duplicate, cancelDuplicate, clearFinished, locked, unlockAndRetry, queue, activeFor, finished, dismiss, cancelOperation, trayCollapsed, setTrayCollapsed, start, approve, cancel, refresh, patchData, accepted };
}

export type Console = ReturnType<typeof useConsole>;
