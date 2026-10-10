// App backups in the console (decisions 149–154): Settings → Backups (places, the nightly policy, every
// app at a glance, restoring another Harbor's apps), the app drawer's Backups panel, and the place types
// in the App Store. Everything here calls the daemon; plans (restore) go through the usual review.
import { useEffect, useState, type FormEvent } from 'react';
import type { AppBackupsDto, BackupPolicyDto, BackupsOverviewDto, BackupTargetDto, BackupTargetPackageDto, FoundBackupAppDto, HostStorageDto, InstanceSummary } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Dialog, Pill, RecoveryCard } from '../components';
import { fmtBytes, fmtWhen as fmtTime } from '../format';
import type { Action, Console } from '../store';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const errText = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.nextAction ? ` ${e.nextAction}` : ''}` : e instanceof Error ? e.message : String(e));

function placeTone(t: BackupTargetDto): 'ok' | 'warn' | 'bad' | 'muted' {
  return t.repo === 'ready' ? 'ok' : t.repo === 'foreign' ? 'warn' : t.repo === 'unreachable' ? 'bad' : 'muted';
}
function placeState(t: BackupTargetDto): string {
  return t.repo === 'ready' ? 'Ready' : t.repo === 'foreign' ? "Another Harbor's backups" : t.repo === 'unreachable' ? 'Unreachable' : 'Not tested';
}
function runTone(state: string): 'ok' | 'warn' | 'bad' | 'muted' | 'busy' {
  return state === 'succeeded' ? 'ok' : state === 'partial' || state === 'skipped' ? 'warn' : state === 'failed' ? 'bad' : state === 'running' ? 'busy' : 'muted';
}
const RUN_LABEL: Record<string, string> = { succeeded: 'Backed up', partial: 'Some places', skipped: 'Skipped', failed: 'Failed', running: 'Running' };

// ---------------------------------------------------------------- add / edit a place

export function AddPlaceDialog({ packages, initialType, existing, onClose, onDone }: { packages: BackupTargetPackageDto[]; initialType?: string; existing?: BackupTargetDto; onClose: () => void; onDone: (r: { target: BackupTargetDto; recoveryKey: string | null }) => void }) {
  const [type, setType] = useState<string | null>(existing?.packageId ?? initialType ?? null);
  const pkg = packages.find((p) => p.id === type) ?? null;
  const [name, setName] = useState(existing?.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(existing?.values ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pkg) return;
    setBusy(true);
    setError(null);
    try {
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
      if (existing) onDone({ target: await api.updateBackupTarget(existing.id, { name, values: clean }), recoveryKey: null });
      else onDone(await api.addBackupTarget(pkg.id, name || pkg.name, clean));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={existing ? `Change ${existing.name}` : pkg ? `Back up to ${pkg.name}` : 'Add a place to back up to'} onClose={onClose}>
      {!pkg ? (
        <ul className="plain place-types">
          {packages.map((p) => (
            <li key={p.id}>
              <button className="place-type" onClick={() => (setType(p.id), setName(p.name))} aria-label={`Choose ${p.name}`}>
                <strong>{p.name}</strong> {p.status === 'beta' && <Pill tone="warn">Beta</Pill>}
                <span className="muted small">{p.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="stack">
          <p className="muted small">{pkg.description}</p>
          <label>
            Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder={pkg.name} maxLength={64} />
          </label>
          {pkg.fields.map((f) => (
            <label key={f.id}>
              {f.label}
              {f.required ? '' : ' (optional)'}
              {f.type === 'textarea' ? (
                <textarea value={values[f.id] ?? ''} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} rows={3} spellCheck={false} />
              ) : f.type === 'secret' && pkg.id === 'sftp' && f.id === 'privateKey' ? (
                <textarea value={values[f.id] ?? ''} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} rows={4} spellCheck={false} placeholder={existing ? '•••• (unchanged)' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
              ) : (
                <input
                  type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={values[f.id] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                  placeholder={f.default ?? ''}
                  autoComplete="off"
                  required={f.required && !(existing && f.type === 'secret')}
                />
              )}
              {f.hint && <span className="muted small">{f.hint}</span>}
            </label>
          ))}
          <p className="muted small">Harbor tests the place before it saves anything. Your data is encrypted on this machine first: the place only ever stores pieces it cannot read.</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row end">
            {!existing && (
              <button type="button" className="btn ghost" onClick={() => setType(null)}>
                Back
              </button>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Testing…' : existing ? 'Test and save' : 'Test and add'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Settings → Backups

export function BackupsSettings({ c }: { c: Console }) {
  const [o, setO] = useState<BackupsOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BackupTargetDto | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => api.backups().then(setO, (e) => setError(errText(e)));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);
  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  if (!o) return <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  return (
    <>
      {card && <RecoveryCard words={card} title="Your Harbor recovery key" note="Write these 12 words down and keep them away from this machine. They open every app this Harbor encrypts, and every backup it makes, on any machine." onDismiss={() => setCard(null)} />}
      <section className="card" aria-labelledby="bk-places-h">
        <div className="row between wrap">
          <div>
            <h2 id="bk-places-h">Backups</h2>
            <p className="muted small">Encrypted on this machine, sent only as changes, to every place you pick. The places cannot read what they store; your Harbor recovery key opens it on any machine.</p>
          </div>
          <button className="btn primary" onClick={() => setAdding(true)} disabled={!o.available}>
            Add a place
          </button>
        </div>
        {!o.available && <p className="error small">{o.reason}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {msg && (
          <p className="notice small" role="status">
            {msg}
          </p>
        )}
        {o.targets.length === 0 ? (
          <p className="muted">No places yet. Add a disk, an S3 bucket, an SFTP server or Proton Drive.</p>
        ) : (
          <ul className="plain places">
            {o.targets.map((t) => (
              <li key={t.id} className="place">
                <div className="row between wrap">
                  <span>
                    <strong>{t.name}</strong> <span className="muted small">· {t.packageName}</span> <Pill tone={placeTone(t)}>{placeState(t)}</Pill> {t.status === 'beta' && <Pill tone="warn">Beta</Pill>}
                  </span>
                  <span className="row wrap">
                    <button className="btn small" disabled={busy === t.id} onClick={() => void act(t.id, () => api.testBackupTarget(t.id), `${t.name} tested.`)} aria-label={`Test ${t.name}`}>
                      Test
                    </button>
                    <button className="btn small ghost" disabled={busy === t.id} onClick={() => setEditing(t)} aria-label={`Change ${t.name}`}>
                      Change…
                    </button>
                  </span>
                </div>
                <p className="muted small">
                  {t.usedBy.length ? `Backs up ${t.usedBy.map((u) => u.name).join(', ')}` : 'No app backs up here yet'}
                  {t.checkedAt ? ` · tested ${fmtTime(t.checkedAt)}` : ''}
                  {t.lastCheckAt ? ` · verified ${fmtTime(t.lastCheckAt)}` : ''}
                </p>
                {t.note && <p className="small warn-text">{t.note}</p>}
                {t.repo === 'foreign' && <OpenForeign target={t} onOpened={() => void load()} />}
                {t.repo === 'ready' && <FoundApps target={t} instances={c.data.instances} onAction={(a) => void c.start(a)} />}
                <RemovePlace target={t} onRemoved={(n) => (setMsg(n), void load())} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <PolicyCard policy={o.policy} onSaved={() => void load()} />
      <section className="card" aria-labelledby="bk-apps-h">
        <h2 id="bk-apps-h">Apps</h2>
        <p className="muted small">Turn backups on for an app from its window on Home (Backups). Apps go one at a time; each is down only for its last pass.</p>
        <ul className="plain backup-apps">
          {o.apps.map((a) => {
            const live = o.activity.find((x) => x.instanceId === a.instanceId);
            return (
              <li key={a.instanceId} className="row between wrap">
                <span>
                  <strong>{a.name}</strong>{' '}
                  <span className="muted small">
                    {!a.eligible ? 'Not encrypted: cannot be backed up' : a.policy.enabled ? `To ${a.policy.targets.length} place${a.policy.targets.length === 1 ? '' : 's'} · next ${fmtTime(a.nextAt)}` : 'Backups off'}
                  </span>
                </span>
                <span className="row wrap">
                  {live ? <Pill tone="busy">{live.phase === 'cold' ? 'Last pass (app paused)' : live.phase === 'warm' ? `Copying${live.percent !== null ? ` ${live.percent}%` : ''}` : 'Queued'}</Pill> : a.lastRun ? <Pill tone={runTone(a.lastRun.state)}>{`${RUN_LABEL[a.lastRun.state] ?? a.lastRun.state} ${fmtTime(a.lastRun.finishedAt ?? a.lastRun.startedAt)}`}</Pill> : null}
                  {a.eligible && a.policy.enabled && (
                    <button className="btn small" disabled={busy === a.instanceId || Boolean(live)} onClick={() => void act(a.instanceId, () => api.backupNow(a.instanceId), `${a.name} queued.`)} aria-label={`Back up ${a.name} now`}>
                      Back up now
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {o.recent.length > 0 && (
          <details>
            <summary className="small">Recent runs</summary>
            <ul className="plain small">
              {o.recent.map((r) => (
                <li key={r.id}>
                  <Pill tone={runTone(r.state)}>{RUN_LABEL[r.state] ?? r.state}</Pill> {fmtTime(r.startedAt)} · {r.kind === 'backup' ? (r.instanceName ?? 'app') : r.kind === 'prune' ? 'cleanup' : 'check'}
                  {r.downtimeSeconds !== null && r.downtimeSeconds > 0 ? ` · down ${r.downtimeSeconds}s` : ''}
                  {r.bytesAdded ? ` · ${fmtBytes(r.bytesAdded)} sent` : ''}
                  {r.message ? <span className="muted"> · {r.message}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      {(adding || editing) && (
        <AddPlaceDialog
          packages={o.packages}
          {...(editing ? { existing: editing } : {})}
          onClose={() => (setAdding(false), setEditing(null))}
          onDone={(r) => {
            setAdding(false);
            setEditing(null);
            if (r.recoveryKey) setCard(r.recoveryKey);
            setMsg(r.target.repo === 'foreign' ? `${r.target.name} holds another Harbor's backups. Open them with that Harbor's recovery key below.` : `${r.target.name} is ready.`);
            void load();
          }}
        />
      )}
    </>
  );
}

function PolicyCard({ policy, onSaved }: { policy: BackupPolicyDto; onSaved: () => void }) {
  const [p, setP] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setP(policy), [JSON.stringify(policy)]);
  const save = async (next: BackupPolicyDto) => {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      setP(await api.setBackupPolicy(next));
      setMsg('Saved.');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="bk-policy-h">
      <h2 id="bk-policy-h">Schedule</h2>
      <p className="muted small">Every app with backups on is copied while it runs, then paused only for its last pass. If that pass would take longer than the limit, the app keeps running and you get a notification.</p>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void save(p);
        }}
      >
        <label>
          Starts at <input type="time" value={p.window} onChange={(e) => setP({ ...p, window: e.target.value })} aria-label="Backup window start" />
        </label>
        <label>
          How often{' '}
          <select value={p.cadence} onChange={(e) => setP({ ...p, cadence: e.target.value as BackupPolicyDto['cadence'] })}>
            <option value="daily">Every night</option>
            <option value="weekly">Once a week</option>
          </select>
        </label>
        {p.cadence === 'weekly' && (
          <label>
            On{' '}
            <select value={p.weekday} onChange={(e) => setP({ ...p, weekday: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Longest pause per app (minutes) <input className="narrow" type="number" min={1} max={120} value={p.maxDowntimeMinutes} onChange={(e) => setP({ ...p, maxDowntimeMinutes: Number(e.target.value) })} />
        </label>
        <fieldset className="retention">
          <legend>Restore points to keep</legend>
          {(['daily', 'weekly', 'monthly'] as const).map((k) => (
            <label key={k} className="row">
              <input type="number" min={0} max={400} value={p.retention[k]} onChange={(e) => setP({ ...p, retention: { ...p.retention, [k]: Number(e.target.value) } })} aria-label={`Keep ${k} restore points`} />
              {k}
            </label>
          ))}
        </fieldset>
        <label className="row">
          <input type="checkbox" checked={p.paused} onChange={(e) => setP({ ...p, paused: e.target.checked })} /> Pause all scheduled backups
        </label>
        <button type="submit" className="btn" disabled={busy}>
          Save schedule
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
      {msg && (
        <p className="notice small" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}

function OpenForeign({ target, onOpened }: { target: BackupTargetDto; onOpened: () => void }) {
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        api.openBackupTarget(target.id, words).then(
          () => (setWords(''), onOpened()),
          (err) => (setError(errText(err)), setBusy(false)),
        );
      }}
    >
      <label>
        Recovery key of the Harbor that made these backups
        <input value={words} onChange={(e) => setWords(e.target.value)} autoComplete="off" spellCheck={false} placeholder="12 words" aria-label={`Recovery key for ${target.name}`} />
      </label>
      {error && <p className="error small">{error}</p>}
      <button type="submit" className="btn" disabled={busy || words.trim().split(/\s+/).length !== 12}>
        Open these backups
      </button>
    </form>
  );
}

// Apps at a place that are not on this machine: restore one here (a new machine, or one purged here).
function FoundApps({ target, instances, onAction }: { target: BackupTargetDto; instances: InstanceSummary[]; onAction: (a: Action) => void }) {
  const [apps, setApps] = useState<FoundBackupAppDto[] | null>(null);
  const [storage, setStorage] = useState<HostStorageDto | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.backupTargetApps(target.id).then(setApps, (e) => setError(errText(e)));
    api.hostStorage().then(setStorage, () => setStorage(null));
  };
  const away = (apps ?? []).filter((a) => !a.installedHere && !instances.some((i) => i.id === a.instanceId));
  const places = (storage?.installCandidates ?? []).filter((c) => c.eligible);
  return (
    <details onToggle={(e) => (e.target as HTMLDetailsElement).open && apps === null && load()}>
      <summary className="small">Restore apps from here…</summary>
      {error && <p className="error small">{error}</p>}
      {apps === null ? (
        <p className="muted small">Looking…</p>
      ) : away.length === 0 ? (
        <p className="muted small">Every app backed up here is already on this machine. Restore those from their own window.</p>
      ) : (
        <ul className="plain">
          {away.map((a) => {
            const latest = a.points[0];
            const dir = pick[a.instanceId] ?? places[0]?.dir ?? '';
            return (
              <li key={a.instanceId} className="row between wrap">
                <span>
                  <strong>{a.name}</strong> <span className="muted small">· {a.packageId} · latest {fmtTime(latest?.time ?? null)}</span>
                </span>
                <span className="row wrap">
                  <select value={dir} onChange={(e) => setPick({ ...pick, [a.instanceId]: e.target.value })} aria-label={`Where to restore ${a.name}`}>
                    {places.map((c) => (
                      <option key={c.dir} value={c.dir}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <button className="btn small" disabled={!latest || !dir} onClick={() => latest && onAction({ kind: 'restore-app', targetId: target.id, instanceId: a.instanceId, runId: latest.runId, dir: `${dir}/${a.packageId}` })} aria-label={`Restore ${a.name} here`}>
                    Restore here
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

function RemovePlace({ target, onRemoved }: { target: BackupTargetDto; onRemoved: (msg: string) => void }) {
  const [del, setDel] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="danger-zone quiet">
      <summary className="small">Remove this place…</summary>
      <p className="small">Apps stop backing up here and Harbor forgets its credentials. The backups already stored there stay, unless you also delete them.</p>
      <label className="row small">
        <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} /> Also delete every backup this Harbor stored there
      </label>
      {del && (
        <label className="small">
          Type <strong>{target.name}</strong> to confirm <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label={`Type ${target.name} to confirm`} />
        </label>
      )}
      {error && <p className="error small">{error}</p>}
      <button
        className="btn danger small"
        disabled={busy || (del && confirm !== target.name)}
        onClick={() => {
          setBusy(true);
          setError(null);
          api.removeBackupTarget(target.id, del, del ? confirm : undefined).then(
            (r) => onRemoved(del ? `${target.name} removed; ${r.removed} restore points deleted there.` : `${target.name} removed; its backups stay where they are.`),
            (e) => (setError(errText(e)), setBusy(false)),
          );
        }}
      >
        Remove {target.name}
      </button>
    </details>
  );
}

// ---------------------------------------------------------------- the app drawer

export function AppBackupsPanel({ inst, busy, onAction }: { inst: InstanceSummary; busy: boolean; onAction: (a: Action) => void }) {
  const [b, setB] = useState<AppBackupsDto | null>(null);
  const [places, setPlaces] = useState<BackupTargetDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // optimistic: the boxes follow the click at once; the daemon's answer (or an error) settles them
  const [draft, setDraft] = useState<{ targets: string[]; enabled: boolean } | null>(null);
  const load = (refresh = false) =>
    Promise.all([api.appBackups(inst.id, refresh), api.backups()]).then(
      ([x, o]) => (setB(x), setPlaces(o.targets.filter((t) => t.repo === 'ready'))),
      (e) => setError(errText(e)),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [inst.id]);
  const save = async (patch: Parameters<typeof api.setAppBackups>[1], done?: string) => {
    setWorking(true);
    setError(null);
    setMsg(null);
    try {
      setB(await api.setAppBackups(inst.id, patch));
      if (done) setMsg(done);
    } catch (e) {
      setError(errText(e));
    } finally {
      setDraft(null);
      setWorking(false);
    }
  };
  if (!b) return error ? <p className="error small">{error}</p> : null;
  const chosen = new Set(draft?.targets ?? b.policy.targets);
  const enabled = draft?.enabled ?? b.policy.enabled;
  return (
    <details className="backups-panel">
      <summary>
        Backups{' '}
        <span className="muted small">
          {!b.eligible ? '· not encrypted' : b.policy.enabled ? `· ${b.lastSuccessAt ? `last ${fmtTime(b.lastSuccessAt)}` : 'none yet'} · next ${fmtTime(b.nextAt)}` : '· off'}
        </span>
      </summary>
      {!b.eligible ? (
        <p className="small muted">{b.reason}</p>
      ) : places.length === 0 ? (
        <p className="small muted">Add a place first in Settings → Backups (a disk, S3, SFTP or Proton Drive).</p>
      ) : (
        <>
          <fieldset className="plain">
            <legend className="small">Back up to</legend>
            {places.map((t) => (
              <label key={t.id} className="row small">
                <input
                  type="checkbox"
                  checked={chosen.has(t.id)}
                  disabled={working}
                  onChange={(e) => {
                    const next = e.target.checked ? [...chosen, t.id] : [...chosen].filter((x) => x !== t.id);
                    setDraft({ targets: next, enabled: next.length ? enabled : false });
                    void save({ targets: next, ...(next.length ? {} : { enabled: false }) });
                  }}
                  aria-label={`Back up ${inst.name} to ${t.name}`}
                />
                {t.name} <span className="muted">· {t.packageName}</span>
              </label>
            ))}
          </fieldset>
          <div className="row wrap">
            <label className="row small">
              <input type="checkbox" checked={enabled} disabled={working || chosen.size === 0} onChange={(e) => (setDraft({ targets: [...chosen], enabled: e.target.checked }), void save({ enabled: e.target.checked, targets: [...chosen] }))} aria-label={`Back up ${inst.name} every night`} />
              Back up on the schedule
            </label>
            <label className="small">
              Own start time <input type="time" value={b.policy.window ?? ''} onChange={(e) => void save({ window: e.target.value || null })} aria-label={`Own backup time for ${inst.name}`} />
            </label>
            {b.policy.window && (
              <button className="btn ghost small" onClick={() => void save({ window: null })}>
                Use the global time
              </button>
            )}
            <button className="btn small" disabled={working || busy || chosen.size === 0} onClick={() => void api.backupNow(inst.id).then((x) => (setB(x), setMsg('Queued. It runs as soon as no other app is being backed up.')), (e) => setError(errText(e)))} aria-label={`Back up ${inst.name} now`}>
              Back up now
            </button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
      {msg && (
        <p className="notice small" role="status">
          {msg}
        </p>
      )}
      {b.previous && (
        <p className="small">
          The copy from before the last restore is kept at <code className="path">{b.previous.path}</code>.{' '}
          <button className="btn ghost small" onClick={() => void api.deletePreviousCopy(inst.id).then(() => load(), (e) => setError(errText(e)))}>
            Delete it
          </button>
        </p>
      )}
      {(b.eligible || b.points.length > 0) && (
      <>
      <div className="row between wrap">
        <h4>Restore points</h4>
        <button className="btn ghost small" onClick={() => void load(true)}>
          Refresh
        </button>
      </div>
      {b.points.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="plain restore-points">
          {b.points.slice(0, 20).map((p) => (
            <li key={p.runId} className="row between wrap">
              <span className="small">
                {fmtTime(p.time)} <span className="muted">· {p.totalBytes !== null ? fmtBytes(p.totalBytes) : '?'} · {p.places.map((x) => x.name).join(', ')}</span>
              </span>
              <button className="btn small" disabled={busy || Boolean(b.previous) || inst.installState === 'retained'} onClick={() => onAction({ kind: 'restore', instance: inst, runId: p.runId })} aria-label={`Restore ${inst.name} to ${fmtTime(p.time)}`}>
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}
      </>
      )}
      {b.runs.length > 0 && (
        <ul className="plain small">
          {b.runs.slice(0, 5).map((r) => (
            <li key={r.id}>
              <Pill tone={runTone(r.state)}>{RUN_LABEL[r.state] ?? r.state}</Pill> {fmtTime(r.startedAt)}
              {r.downtimeSeconds !== null && r.downtimeSeconds > 0 ? ` · paused ${r.downtimeSeconds}s` : ''}
              {r.message && r.state !== 'succeeded' ? <span className="muted"> · {r.message}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

// ---------------------------------------------------------------- the App Store's Backup section

export function BackupPlaces({ onAdded }: { onAdded?: () => void }) {
  const [o, setO] = useState<BackupsOverviewDto | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.backups().then(setO, () => setO(null));
  }, []);
  if (!o) return null;
  const installed = (id: string) => o.targets.filter((t) => t.packageId === id).length;
  return (
    <section aria-labelledby="store-backup-h" className="git-sources">
      <h3 id="store-backup-h">Backup places</h3>
      <p className="muted small">Where your apps' backups go. Add as many as you like; each app picks its own.</p>
      {card && <RecoveryCard words={card} title="Your Harbor recovery key" note="It opens every app this Harbor encrypts, and every backup it makes, on any machine." onDismiss={() => setCard(null)} />}
      {msg && (
        <p className="notice small" role="status">
          {msg}
        </p>
      )}
      <ul className="plain place-types">
        {o.packages.map((p) => (
          <li key={p.id} className="row between wrap">
            <span>
              <strong>{p.name}</strong> {p.status === 'beta' && <Pill tone="warn">Beta</Pill>} {installed(p.id) > 0 && <Pill tone="ok">{`${installed(p.id)} added`}</Pill>}
              <br />
              <span className="muted small">{p.description}</span>
            </span>
            <button className="btn small" disabled={!o.available} onClick={() => setType(p.id)} aria-label={`Add ${p.name}`}>
              Add
            </button>
          </li>
        ))}
      </ul>
      {type && (
        <AddPlaceDialog
          packages={o.packages}
          initialType={type}
          onClose={() => setType(null)}
          onDone={(r) => {
            setType(null);
            if (r.recoveryKey) setCard(r.recoveryKey);
            setMsg(`${r.target.name} added. Turn backups on per app from its window on Home.`);
            void api.backups().then(setO);
            onAdded?.();
          }}
        />
      )}
    </section>
  );
}
