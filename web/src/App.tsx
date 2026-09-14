import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CatalogItemDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlanKind, PlatformToolDto, SystemDto } from '../../src/contracts/api';
import { ApiError, api, forgetToken, hasToken, newIdempotencyKey } from './api';

type View = { kind: 'login' } | { kind: 'dashboard' };

export function App() {
  const [view, setView] = useState<View>(hasToken() ? { kind: 'dashboard' } : { kind: 'login' });
  const [notice, setNotice] = useState<string | null>(null);
  const onAuthLost = useCallback((msg?: string) => {
    forgetToken();
    setNotice(msg ?? 'Your session ended. Log in again to continue; running operations keep going on the server.');
    setView({ kind: 'login' });
  }, []);
  return (
    <>
      <header className="topbar">
        <h1>
          Harbor <span className="badge">local preview</span>
        </h1>
        {view.kind === 'dashboard' && (
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.logout();
              } finally {
                onAuthLost('Logged out.');
              }
            }}
          >
            Log out
          </button>
        )}
      </header>
      <main>
        {view.kind === 'login' ? (
          <Login
            notice={notice}
            onDone={() => {
              setNotice(null);
              setView({ kind: 'dashboard' });
            }}
          />
        ) : (
          <Dashboard onAuthLost={onAuthLost} />
        )}
      </main>
      <footer className="foot">
        Trusted local preview. Bound to 127.0.0.1 only; the daemon has Docker (root-equivalent) authority. Tokens are kept in memory and a reload requires login.
      </footer>
    </>
  );
}

// ---------------- Login

function Login({ onDone, notice }: { onDone: () => void; notice: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : 'Cannot reach the Harbor daemon.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card login" aria-labelledby="login-h">
      <h2 id="login-h">Log in</h2>
      {notice && <p className="notice">{notice}</p>}
      <form onSubmit={submit}>
        <label>
          Username
          <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </section>
  );
}

// ---------------- Dashboard

interface DashboardData {
  system: SystemDto | null;
  catalog: CatalogItemDto[];
  instances: InstanceSummary[];
  tools: PlatformToolDto[];
}

type PendingAction = { kind: 'install'; packageId: string; name: string } | { kind: Exclude<PlanKind, 'install'>; instance: InstanceSummary };

function Dashboard({ onAuthLost }: { onAuthLost: (msg?: string) => void }) {
  const [data, setData] = useState<DashboardData>({ system: null, catalog: [], instances: [], tools: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [plan, setPlan] = useState<PlanDto | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [watching, setWatching] = useState<OperationDto | null>(null);
  const [inspecting, setInspecting] = useState<InstanceDetail | null>(null);
  const [showRetained, setShowRetained] = useState(true);
  const submitKey = useRef<string | null>(null);
  const submitting = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [system, catalog, instances, tools] = await Promise.all([api.system(), api.catalog(), api.instances(), api.tools()]);
      setData({ system, catalog, instances, tools });
      setLoadError(null);
      setLoaded(true);
      // Resume watching an accepted operation after reload/relogin.
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
        if (isFinal(op)) void refresh();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onAuthLost();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [watching, refresh, onAuthLost]);

  const startAction = async (action: PendingAction) => {
    setPending(action);
    setPlan(null);
    setPlanError(null);
    try {
      const p = await api.plan(action.kind === 'install' ? { kind: 'install', packageId: action.packageId, ...(action.name ? { name: action.name } : {}) } : { kind: action.kind, instanceId: action.instance.id });
      setPlan(p);
      submitKey.current = newIdempotencyKey();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onAuthLost();
      setPlanError(e instanceof ApiError ? `${e.message} ${e.nextAction}` : String(e));
    }
  };

  const approve = async () => {
    if (!plan || submitting.current) return;
    submitting.current = true;
    try {
      // The same idempotency key is reused for this plan, so double clicks or retries cannot duplicate work.
      const key = submitKey.current ?? (submitKey.current = newIdempotencyKey());
      const r = await api.submit(plan.id, key);
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

  const busy = Boolean(watching && !isFinal(watching)) || data.system?.busyOperationId != null;
  const installed = data.instances.filter((i) => showRetained || i.installState !== 'retained');

  return (
    <>
      {loadError && (
        <p className="error banner" role="alert">
          Cannot load dashboard: {loadError}
        </p>
      )}
      {watching && <OperationPanel op={watching} onDismiss={() => setWatching(null)} />}

      <section className="card" aria-labelledby="installed-h">
        <div className="row between">
          <h2 id="installed-h">Installed</h2>
          <label className="check">
            <input type="checkbox" checked={showRetained} onChange={(e) => setShowRetained(e.target.checked)} /> show removed (retained)
          </label>
        </div>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : installed.length === 0 ? (
          <p className="muted">No applications installed yet. Pick one from Available below.</p>
        ) : (
          <ul className="grid">
            {installed.map((i) => (
              <InstanceCard key={i.id} inst={i} busy={busy} onAction={(kind) => void startAction({ kind, instance: i })} onInspect={async () => setInspecting(await api.instance(i.id))} />
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="available-h">
        <h2 id="available-h">Available</h2>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="grid">
            {data.catalog.map((c) => (
              <li key={c.id} className="tile">
                <h3>{c.name}</h3>
                <p>{c.description}</p>
                <p className="muted small">
                  {c.id} rev {c.revision} · qualification {c.qualification}
                </p>
                {c.availability === 'unavailable' ? (
                  <p className="error small">Unavailable: {c.reason}</p>
                ) : (
                  <InstallForm pkg={c} disabled={busy} onSubmit={(name) => void startAction({ kind: 'install', packageId: c.id, name })} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="two">
        <section className="card" aria-labelledby="system-h">
          <h2 id="system-h">System</h2>
          {data.system ? (
            <dl>
              <dt>Harbor</dt>
              <dd>
                version {data.system.version} · {data.system.profile} · {data.system.managementOrigin}
              </dd>
              <dt>Docker Engine</dt>
              <dd>
                <StatusDot ok={data.system.docker.available ? 'ok' : 'bad'} />
                {data.system.docker.available ? `available (${data.system.docker.version ?? '?'})` : `unavailable${data.system.docker.error ? `: ${data.system.docker.error}` : ''}`}
                <span className="muted small"> observed {fmtTime(data.system.docker.observedAt)}</span>
              </dd>
              <dt>Busy operation</dt>
              <dd>{data.system.busyOperationId ?? 'none'}</dd>
            </dl>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </section>

        <section className="card" aria-labelledby="tools-h">
          <h2 id="tools-h">Platform tools</h2>
          {!loaded ? (
            <p className="muted">Loading…</p>
          ) : (
            <ul className="tools">
              {data.tools.map((t) => (
                <li key={t.id} className="tool">
                  <div>
                    <strong>{t.name}</strong>{' '}
                    <span className={`pill ${t.installationState}`}>{t.installationState.replace('_', ' ')}</span>{' '}
                    <span className={`pill ${t.availability}`}>{t.availability}</span>
                    <div className="muted small">
                      {t.note ?? ''} {t.observedAt ? `· observed ${fmtTime(t.observedAt)}` : ''}
                    </div>
                  </div>
                  {t.browserUrl && t.installationState !== 'not_installed' ? (
                    <a className="btn" href={t.browserUrl} target="_blank" rel="noopener noreferrer">
                      Open {t.name}
                    </a>
                  ) : (
                    <span className="muted small">no link</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {pending && (
        <Dialog title={plan ? `Confirm ${plan.kind}` : `Planning ${pending.kind}…`} onClose={() => setPending(null)}>
          {planError && (
            <p className="error" role="alert">
              {planError}
            </p>
          )}
          {plan && <PlanView plan={plan} />}
          <div className="row end">
            <button className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void approve()} disabled={!plan || Boolean(planError)}>
              {plan?.kind === 'remove' ? 'Remove (keep data)' : plan?.kind === 'install' ? 'Install' : plan ? capitalize(plan.kind) : '…'}
            </button>
          </div>
        </Dialog>
      )}

      {inspecting && (
        <Dialog title={`${inspecting.name} details`} onClose={() => setInspecting(null)}>
          <InstanceDetails d={inspecting} />
          <div className="row end">
            <button className="btn" onClick={() => setInspecting(null)}>
              Close
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function isFinal(op: OperationDto): boolean {
  return op.state === 'succeeded' || op.state === 'failed' || op.state === 'needs_action';
}

function InstallForm({ pkg, disabled, onSubmit }: { pkg: CatalogItemDto; disabled: boolean; onSubmit: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name.trim());
      }}
    >
      <label className="small">
        Instance name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z][a-z0-9-]{0,62}" placeholder={pkg.id} aria-label={`Instance name for ${pkg.name}`} />
      </label>
      <button className="btn primary" type="submit" disabled={disabled} aria-label={`Install ${pkg.name}`}>
        Install
      </button>
    </form>
  );
}

function InstanceCard({ inst, busy, onAction, onInspect }: { inst: InstanceSummary; busy: boolean; onAction: (kind: Exclude<PlanKind, 'install'>) => void; onInspect: () => void }) {
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const retained = inst.installState === 'retained';
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running';
  const canStop = (inst.installState === 'installed' || inst.installState === 'needs_action' || inst.installState === 'failed') && inst.runtime !== 'stopped';
  const canStart = inst.installState === 'installed' && inst.desired === 'stopped';
  const inFlight = inst.installState === 'installing';
  return (
    <li className={`tile instance ${inst.installState}`} aria-busy={inFlight}>
      <div className="row between">
        <h3>{inst.name}</h3>
        <span className="muted small">{inst.packageName}</span>
      </div>
      <p className="states">
        <span className={`pill ${inst.installState}`}>{inst.installState.replace('_', ' ')}</span>
        {!retained && <span className={`pill ${inst.runtime}`}>{inst.runtime}</span>}
        {!retained && <span className={`pill ${inst.readiness}`}>{inst.readiness}</span>}
        <span className="muted small">desired {inst.desired}</span>
      </p>
      {primary && !retained && <p className="muted small">{primary.browserUrl}</p>}
      {retained && <p className="muted small">Removed. Data volumes and secrets are retained; reinstall restores the exact same release.</p>}
      <p className="muted small">observed {fmtTime(inst.observedAt)}</p>
      <div className="row wrap">
        {canOpen && primary && (
          <a className="btn primary" href={primary.browserUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`}>
            Open
          </a>
        )}
        {canStart && (
          <button className="btn" disabled={busy} onClick={() => onAction('start')} aria-label={`Start ${inst.name}`}>
            Start
          </button>
        )}
        {canStop && !inFlight && (
          <button className="btn" disabled={busy} onClick={() => onAction('stop')} aria-label={`Stop ${inst.name}`}>
            Stop
          </button>
        )}
        {!retained && !inFlight && (
          <button className="btn danger" disabled={busy} onClick={() => onAction('remove')} aria-label={`Remove ${inst.name}`}>
            Remove
          </button>
        )}
        {retained && inst.hasRetainedData && (
          <button className="btn" disabled={busy} onClick={() => onAction('reinstall')} aria-label={`Reinstall ${inst.name}`}>
            Reinstall
          </button>
        )}
        <button className="btn ghost" onClick={onInspect} aria-label={`Details of ${inst.name}`}>
          Details
        </button>
      </div>
    </li>
  );
}

function PlanView({ plan }: { plan: PlanDto }) {
  return (
    <div className="plan">
      <p>
        <strong>{plan.name}</strong> · {plan.packageId} revision {plan.revision} · plan expires {fmtTime(plan.expiresAt)}
      </p>
      <ul>
        {plan.changes.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      {plan.endpoints.length > 0 && (
        <p>
          <strong>Ports:</strong> {plan.endpoints.map((e) => `${e.id} → ${e.browserUrl}`).join(', ')}
        </p>
      )}
      {plan.storage.length > 0 && (
        <p>
          <strong>Storage:</strong> {plan.storage.map((s) => `${s.volumeName} (${s.state})`).join(', ')}
        </p>
      )}
      {plan.secrets.length > 0 && (
        <p>
          <strong>Secrets:</strong> {plan.secrets.map((s) => `${s.id} (${s.state})`).join(', ')} — values are never shown.
        </p>
      )}
      {plan.warnings.map((w, i) => (
        <p key={i} className="warn">
          {w}
        </p>
      ))}
      {plan.kind === 'remove' && <p className="warn">Containers and the private network are deleted. Data volumes, secrets, the name and port allocations are retained.</p>}
    </div>
  );
}

function OperationPanel({ op, onDismiss }: { op: OperationDto; onDismiss: () => void }) {
  const final = isFinal(op);
  return (
    <section className={`card op ${op.state}`} aria-live="polite" aria-labelledby="op-h">
      <div className="row between">
        <h2 id="op-h">
          {capitalize(op.kind)} {op.state === 'succeeded' ? 'succeeded' : op.state === 'failed' ? 'failed' : op.state === 'needs_action' ? 'needs action' : `in progress — ${op.phase}`}
        </h2>
        {final && (
          <button className="btn ghost" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {!final && <progress aria-label="operation progress" />}
      {op.error && (
        <p className="error">
          {op.error.code}: {op.error.message} <br />
          <span className="muted">Next: {op.error.nextAction}</span>
        </p>
      )}
      <ol className="events">
        {op.events.slice(-8).map((e) => (
          <li key={e.cursor}>
            <span className="muted small">{fmtTime(e.at)}</span> <code>{e.phase}</code> {e.message}
          </li>
        ))}
      </ol>
    </section>
  );
}

function InstanceDetails({ d }: { d: InstanceDetail }) {
  return (
    <div className="details">
      <p className="muted small">
        {d.packageName} · {d.packageId} rev {d.revision} · id {d.id}
      </p>
      {d.setup && (
        <p className="setup">
          <strong>Onboarding required inside the app:</strong> {d.setup.instructions}{' '}
          <a href={d.setup.browserUrl} target="_blank" rel="noopener noreferrer">
            Open {d.name}
          </a>
          <br />
          <span className="muted small">Harbor did not create any account in this application; readiness only means it answers HTTP.</span>
        </p>
      )}
      {d.lastError && (
        <p className="error">
          {d.lastError.code}: {d.lastError.message}
          <br />
          <span className="muted">Next: {d.lastError.nextAction}</span>
        </p>
      )}
      <h4>Endpoints</h4>
      <ul>
        {d.endpoints.map((e) => (
          <li key={e.id}>
            {e.id}: {e.browserUrl} (container port {e.containerPort})
          </li>
        ))}
      </ul>
      <h4>Owned resources</h4>
      <ul>
        {d.resources.map((r) => (
          <li key={`${r.kind}-${r.role}`}>
            <code>{r.kind}</code> {r.role}: {r.name} {r.present === null ? '(unknown)' : r.present ? '' : '(absent)'}
          </li>
        ))}
        {d.resources.length === 0 && <li className="muted">none recorded</li>}
      </ul>
      <h4>Recent events</h4>
      <ol className="events">
        {d.events.slice(-10).map((e) => (
          <li key={e.cursor}>
            <span className="muted small">{fmtTime(e.at)}</span> <code>{e.phase}</code> {e.message}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dlg-h">
      <h2 id="dlg-h">{title}</h2>
      {children}
    </dialog>
  );
}

function StatusDot({ ok }: { ok: 'ok' | 'bad' | 'unknown' }) {
  return <span className={`dot ${ok}`} aria-hidden="true" />;
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString();
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
