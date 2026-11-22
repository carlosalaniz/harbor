import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogItemDto, HostStorageDto, InstanceSummary, OperationDto, SystemMetricsDto, WidgetDto } from '../../../../src/contracts/api';
import { api } from '../../api';
import { AppIcon, Dialog, InstanceIcon, Pill, appLabel, copyName, openUrl } from '../components';
import { ArrowUpIcon, EllipsisIcon } from '../icons';
import { fmtBytes, fmtUptime, plainStatus, updateLine } from '../format';
import { useReorder, type GroupMove } from '../reorder';
import { tileStatus } from '../queue';
import type { Console } from '../store';
import { SHARED_WARNING, SpaceDialog } from '../Spaces';
import type { SpaceDto } from '../../../../src/contracts/api';

const LOOSE = 'loose'; // the main grid's group key (space ids are hex)
const PICKS = ['nextcloud', 'immich', 'jellyfin', 'open-webui', 'vaultwarden', 'n8n'];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The header greets by display name ("Good morning, Carlos") once the
// account endpoint answers; before that it falls back to the bare greeting.
// The display name is shown as-is (it is already what the operator typed);
// without one the login name is capitalized for display ("carlos" → "Carlos").
function useGreeting(): string {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    api
      .security()
      .then((s) => {
        const display = s.displayName?.trim();
        if (display) return setName(display);
        const raw = s.username?.trim();
        setName(raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null);
      })
      .catch(() => setName(null));
  }, []);
  const base = greeting();
  return name ? `${base}, ${name}` : base;
}

// Home is a launcher, the way a phone's home screen is: one icon per app, tap to open, hold (or Arrange)
// to move things around. Everything else lives one tap away in the app's drawer.
export function Home({ c, onOpenApp, onGoStore, onPick }: { c: Console; onOpenApp: (i: InstanceSummary) => void; onGoStore: () => void; onPick: (item: CatalogItemDto) => void }) {
  const { data, loaded } = c;
  const running = data.instances.filter((i) => i.installState === 'installed' && i.runtime === 'running').length;
  const attention = data.instances.filter((i) => ['failed', 'needs_action'].includes(i.installState) || i.readiness === 'unhealthy' || i.runtime === 'unavailable' || Boolean(i.needsDrive) || i.links.some((l) => l.state === 'needs_provider' && !l.optional));
  const degraded = data.exposures.filter((e) => e.state === 'degraded');
  const picks = PICKS.map((id) => data.catalog.find((i) => i.id === id)).filter((i): i is CatalogItemDto => Boolean(i && i.availability === 'available'));
  const active = data.instances.filter((i) => i.installState !== 'retained');
  const retained = data.instances.filter((i) => i.installState === 'retained');
  // decision 131: helpers the operator hid stay out of the launcher (still in the Store, Platform, lists)
  const shown = active.filter((i) => !i.hiddenFromHome);
  const hidden = active.filter((i) => i.hiddenFromHome);
  // decision 202: apps in a space show in that space's section; Arrange moves the others
  const spaces = data.spaces;
  const inSpace = new Set(spaces.flatMap((s) => s.apps.map((a) => a.instanceId)));
  const loose = shown.filter((i) => !inSpace.has(i.id));
  const [spaceEdit, setSpaceEdit] = useState<SpaceDto | 'new' | null>(null);
  // decision 210: a drop into a shared space waits for a confirmation; a failed move says why
  const [pendingMove, setPendingMove] = useState<GroupMove | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // launcher order: the saved order first, then anything new in install order
  const saved = data.appearance?.home.order ?? [];
  const sortedIds = useMemo(() => {
    const ids = loose.map((i) => i.id);
    const rank = new Map(saved.map((id, i) => [id, i]));
    return ids.slice().sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || ids.indexOf(a) - ids.indexOf(b));
  }, [loose.map((i) => i.id).join('|'), saved.join('|')]);
  const savedRank = new Map(saved.map((id, i) => [id, i]));
  const spaceTiles = (s: SpaceDto) =>
    s.apps
      .map((a) => shown.find((i) => i.id === a.instanceId))
      .filter((i): i is InstanceSummary => Boolean(i))
      .sort((a, b) => (savedRank.get(a.id) ?? 1e9) - (savedRank.get(b.id) ?? 1e9));
  const commit = useCallback(
    (shownOrder: string[]) => {
      // hidden apps keep their saved slot so Show puts them back where they were
      const order = [...shownOrder, ...saved.filter((id) => !shownOrder.includes(id))];
      c.patchData((d) => (d.appearance ? { ...d, appearance: { ...d.appearance, home: { order } } } : d));
      void api.setHomeOrder(order).catch(() => c.refresh());
    },
    [c, saved.join('|')],
  );
  const byIdAll = new Map(data.instances.map((i) => [i.id, i]));
  // Drag an app into a space, or out of one back to the main grid: one space change (the server takes the app out
  // of any other space), shown at once and confirmed by the next refresh.
  const applyMove = useCallback(
    (m: GroupMove) => {
      const target = spaces.find((s) => s.id === m.to);
      const source = spaces.find((s) => s.id === m.from);
      const name = byIdAll.get(m.id)?.name ?? m.id;
      setMoveError(null);
      c.patchData((d) => ({
        ...d,
        spaces: d.spaces.map((s) => {
          const apps = s.apps.filter((a) => a.instanceId !== m.id);
          return s.id === m.to ? { ...s, apps: [...apps, { instanceId: m.id, name, addresses: [] }] } : { ...s, apps };
        }),
      }));
      commit(m.order);
      const change = target ? api.updateSpace(target.id, { apps: [...target.apps.map((a) => a.instanceId).filter((a) => a !== m.id), m.id] }) : source ? api.updateSpace(source.id, { apps: source.apps.map((a) => a.instanceId).filter((a) => a !== m.id) }) : null;
      void change
        ?.catch((e: Error) => setMoveError(`${name} did not move: ${e.message}`))
        .finally(() => void c.refresh());
    },
    [c, commit, spaces, data.instances],
  );
  const onMove = useCallback(
    (m: GroupMove) => {
      const target = spaces.find((s) => s.id === m.to);
      if (target?.shared) setPendingMove(m);
      else applyMove(m);
    },
    [spaces, applyMove],
  );
  const re = useReorder([{ key: LOOSE, ids: sortedIds }, ...spaces.map((s) => ({ key: s.id, ids: spaceTiles(s).map((i) => i.id) }))], commit, onMove);
  const byId = new Map(active.map((i) => [i.id, i]));
  const tiles = re.orderOf(LOOSE).map((id) => byId.get(id)).filter((i): i is InstanceSummary => Boolean(i));
  const picture = data.appearance?.wallpaper.kind === 'rotating' ? data.appearance.wallpaper.current : null;
  const updates = active.filter((i) => i.updateAvailable && i.installState === 'installed');
  const hello = useGreeting();

  return (
    <>
      <header className="page-head launcher-head">
        <div>
          <p className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          <h1>{hello}</h1>
          <p className="muted">{!loaded ? 'Loading your apps…' : data.instances.length === 0 ? 'Your own cloud, on this machine. Add your first app to get started.' : `${running} of ${active.length} app${active.length === 1 ? '' : 's'} running · ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`}</p>
        </div>
        <div className="row wrap head-actions">
          {active.length > 0 && !re.arranging && (
            <button className="btn on-wallpaper" onClick={() => setSpaceEdit('new')}>
              New space
            </button>
          )}
          {shown.length > 1 && (
            <button className={`btn on-wallpaper ${re.arranging ? 'active' : ''}`} onClick={() => re.setArranging(!re.arranging)} aria-pressed={re.arranging}>
              {re.arranging ? 'Done' : 'Arrange'}
            </button>
          )}
          <button className="btn primary" onClick={onGoStore}>
            + Add an app
          </button>
        </div>
      </header>
      <SystemStrip m={data.metrics} dockerAvailable={data.system?.docker.available ?? null} />
      <DrivesCard />
      {updates.length > 0 && (
        <section className="card updates" aria-labelledby="upd-h">
          <div className="row between wrap">
            <div>
              <h2 id="upd-h">
                {updates.length} update{updates.length === 1 ? '' : 's'} available
              </h2>
              <p className="muted small">Your data, addresses and ports stay. If a new version does not start, Harbor puts the current one back.</p>
            </div>
            {updates.length > 1 && (
              <button
                className="btn"
                onClick={() => {
                  void api.applyAllUpdates().then(() => c.refresh());
                }}
                aria-label="Update all apps"
              >
                Update all
              </button>
            )}
          </div>
          <ul className="plain">
            {updates.map((i) => (
              <li key={i.id} className="row between wrap">
                <span className="row">
                  <InstanceIcon inst={i} size={28} />
                  <span>
                    <strong>{appLabel(i, data.instances)}</strong> <span className="muted small">{updateLine(i, i.updateAvailable!)}</span>
                    {i.updateAvailable!.releaseNotes && <span className="muted small"> · {i.updateAvailable!.releaseNotes}</span>}
                  </span>
                </span>
                <button className="btn primary" onClick={() => c.start({ kind: 'update', instance: i })} aria-label={`Update ${i.name}`}>
                  Update
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(attention.length > 0 || degraded.length > 0) && (
        <section className="card attention" aria-labelledby="att-h">
          <h2 id="att-h">Needs attention</h2>
          <ul className="plain">
            {attention.map((i) => (
              <li key={i.id} className="row between">
                <span>
                  <strong>{appLabel(i, data.instances)}</strong> — {plainStatus(i).label}
                </span>
                <button className="btn" onClick={() => onOpenApp(i)}>
                  Details
                </button>
              </li>
            ))}
            {degraded.map((e) => (
              <li key={e.id} className="row between">
                <span>
                  <strong>{e.instanceName}</strong> — {e.url} not reachable{e.note ? `: ${e.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={`launcher ${re.arranging ? 'arranging' : ''} ${re.dragging ? 'dragging' : ''}`} aria-labelledby="apps-h">
        <h2 id="apps-h" className="visually-hidden">
          Your apps
        </h2>
        {re.arranging && (
          <p className="muted small arrange-hint" role="status">
            Drag icons to arrange them{spaces.length ? ', or onto a space to move them there' : ''}. Arrow keys move the focused app. Press Done (or Esc) when you are happy.
          </p>
        )}
        {moveError && (
          <p className="error small" role="alert">
            {moveError}
          </p>
        )}
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : data.instances.length === 0 ? (
          <div className="card welcome">
            <p className="empty-title">No apps yet</p>
            <p className="muted">Popular picks to start with. One click installs; nothing leaves this machine until you publish it.</p>
            <ul className="grid picks">
              {picks.map((item) => (
                <li key={item.id} className="tile pick">
                  <button className="tile-main" onClick={() => onPick(item)} aria-label={`About ${item.name}`}>
                    <AppIcon packageId={item.id} icon={item.presentation.icon} name={item.name} size={56} />
                    <div>
                      <h3>{item.name}</h3>
                      <p className="muted small">{item.presentation.tagline ?? item.description}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn" onClick={onGoStore}>
              Browse the whole App Store →
            </button>
          </div>
        ) : (
          <>
            <ul className={`icons ${re.dropTarget === LOOSE ? 'drop-target' : ''}`} aria-label="Installed apps" ref={re.groupRef(LOOSE)}>
              {tiles.map((i) => (
                <AppIconTile key={i.id} inst={i} op={c.activeFor(i.id)} all={data.instances} onDetails={() => onOpenApp(i)} reorder={re} />
              ))}
              {!re.arranging && (
                <li className="icon-tile add">
                  <button className="icon-btn" onClick={onGoStore} aria-label="Add an app">
                    <span className="appicon large add-glyph" aria-hidden="true">
                      +
                    </span>
                    <span className="icon-label">Add app</span>
                  </button>
                </li>
              )}
            </ul>
            {spaces.map((s) => {
              const ts = re.orderOf(s.id).map((id) => byId.get(id)).filter((i): i is InstanceSummary => Boolean(i));
              return (
                <section key={s.id} ref={re.groupRef(s.id)} className={`space-group ${re.dropTarget === s.id ? 'drop-target' : ''}`} aria-labelledby={`space-h-${s.id}`}>
                  <div className="space-head">
                    <h2 id={`space-h-${s.id}`}>{s.name}</h2>
                    {s.shared && <Pill tone="warn">Shared network</Pill>}
                    {re.dropTarget === s.id && <span className="small drop-hint">Drop to move here</span>}
                    <button className="btn on-wallpaper small" onClick={() => setSpaceEdit(s)} aria-label={`Edit space ${s.name}`}>
                      Edit
                    </button>
                  </div>
                  {ts.length ? (
                    <ul className="icons" aria-label={`Apps in ${s.name}`}>
                      {ts.map((i) => (
                        <AppIconTile key={i.id} inst={i} op={c.activeFor(i.id)} all={data.instances} onDetails={() => onOpenApp(i)} reorder={re} />
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small space-empty">No apps here yet. Drag one here, or edit the space.</p>
                  )}
                </section>
              );
            })}
            {hidden.length > 0 && (
              <details className="retained-list">
                <summary className="muted small">
                  {hidden.length} hidden app{hidden.length === 1 ? '' : 's'}
                </summary>
                <ul className="icons">
                  {hidden.map((i) => (
                    <AppIconTile key={i.id} inst={i} op={c.activeFor(i.id)} all={data.instances} onDetails={() => onOpenApp(i)} />
                  ))}
                </ul>
              </details>
            )}
            {retained.length > 0 && (
              <details className="retained-list">
                <summary className="muted small">
                  {retained.length} removed app{retained.length === 1 ? '' : 's'} with data kept
                </summary>
                <ul className="icons">
                  {retained.map((i) => (
                    <AppIconTile key={i.id} inst={i} op={c.activeFor(i.id)} all={data.instances} onDetails={() => onOpenApp(i)} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
      {spaceEdit && <SpaceDialog c={c} space={spaceEdit === 'new' ? null : spaceEdit} onClose={() => setSpaceEdit(null)} />}
      {pendingMove && (
        <SharedMoveDialog
          app={byIdAll.get(pendingMove.id)?.name ?? pendingMove.id}
          space={spaces.find((s) => s.id === pendingMove.to)!}
          onCancel={() => setPendingMove(null)}
          onConfirm={() => {
            applyMove(pendingMove);
            setPendingMove(null);
          }}
        />
      )}
      {picture && (
        <p className="wallpaper-credit small">
          <span aria-hidden="true">◐ </span>
          {picture.link ? (
            <a href={picture.link} target="_blank" rel="noopener noreferrer">
              {picture.title}
            </a>
          ) : (
            picture.title
          )}
          {picture.author ? ` · ${picture.author}` : ''} · {picture.sourceName}
        </p>
      )}
    </>
  );
}

// Decision 210: dropping an app into a shared space puts it on that network, so the drop asks first, in the same words
// the space dialog uses when sharing is turned on.
function SharedMoveDialog({ app, space, onCancel, onConfirm }: { app: string; space: SpaceDto; onCancel: () => void; onConfirm: () => void }) {
  if (!space) return null;
  const others = space.apps.filter((a) => a.name !== app).map((a) => a.name);
  return (
    <Dialog title={`Move ${app} into ${space.name}?`} onClose={onCancel}>
      <div className="stack">
        <p>
          {space.name} shares a network{others.length ? ` with ${others.join(', ')}` : ''}. {app} joins it now, without a restart.
        </p>
        <div className="card warn-box" role="note">
          <p className="small">
            <strong>Not isolated.</strong> {SHARED_WARNING}
          </p>
        </div>
        <div className="row end">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={onConfirm}>
            Move into {space.name}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AppIconTile({ inst, op = null, all = [], onDetails, reorder }: { inst: InstanceSummary; op?: OperationDto | null; all?: InstanceSummary[]; onDetails: () => void; reorder?: ReturnType<typeof useReorder> }) {
  const url = openUrl(inst);
  const arranging = reorder?.arranging ?? false;
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && url && !arranging;
  // decision 183: the app's own operation first ("Updating…", "Waiting…"), then its plain state
  const status = op ? tileStatus(op) : plainStatus(inst);
  // decision 170: with several copies of one app, each tile names its copy on a line of its own
  const copy = copyName(inst, all);
  const label = copy ? inst.packageName : appLabel(inst);
  const fullLabel = copy ? `${label} · ${copy}` : label;
  const usageText = inst.usage ? ` · CPU ${inst.usage.cpuPercent}% · ${fmtBytes(inst.usage.memoryBytes)}` : '';
  const tp = reorder?.tileProps(inst.id);
  const guard = (e: React.MouseEvent) => {
    if (reorder?.suppressClick(inst.id) || arranging) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return (
    <li
      ref={tp?.ref}
      className={`icon-tile instance ${inst.installState} tone-${status.tone} ${op ? 'busy' : ''} ${reorder?.dragging === inst.id ? 'dragging' : ''}`}
      aria-busy={inst.installState === 'installing' || Boolean(op)}
      onPointerDown={tp?.onPointerDown}
      onKeyDown={tp?.onKeyDown}
      style={tp?.style}
      data-instance={inst.name}
    >
      {canOpen ? (
        <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`} title={`${fullLabel} — ${status.label}${usageText}`} onClick={guard} draggable={false}>
          <InstanceIcon inst={inst} size={64} />
          <span className="icon-label">{label}</span>
          {copy && <span className="icon-copy">{copy}</span>}
          <span className="icon-status">
            <span className={`dot tone-${status.tone}`} aria-hidden="true" />
            <span className="visually-hidden">{status.label}</span>
          </span>
        </a>
      ) : (
        <button className="icon-btn" onClick={(e) => (arranging || reorder?.suppressClick(inst.id) ? guard(e) : onDetails())} aria-label={arranging ? `Move ${inst.name}` : `Manage ${inst.name}`} title={`${fullLabel} — ${status.label}${usageText}`}>
          <InstanceIcon inst={inst} size={64} />
          <span className="icon-label">{label}</span>
          {copy && <span className="icon-copy">{copy}</span>}
          <span className="icon-status small">
            <span className={`dot tone-${status.tone}`} aria-hidden="true" /> {arranging ? 'drag to move' : status.label}
          </span>
        </button>
      )}
      {!arranging && (
        <button className="btn ghost icon more" onClick={onDetails} aria-label={`Details of ${inst.name}`} title="Details and actions">
          <EllipsisIcon />
        </button>
      )}
      {!arranging && <WidgetLine inst={inst} />}
      {inst.updateAvailable && !arranging && (
        <span className="update-dot" title={`Update available: ${updateLine(inst, inst.updateAvailable)}`} aria-label={`Update available for ${inst.name}`}>
          <ArrowUpIcon />
        </span>
      )}
    </li>
  );
}

// Home widget (decision 81): one line of live data under the icon, only when the app declares
// a widget and the proxied JSON parses. Malformed data hides the line — never an error.
function WidgetLine({ inst }: { inst: InstanceSummary }) {
  const [w, setW] = useState<WidgetDto | null | undefined>(undefined);
  useEffect(() => {
    if (inst.installState !== 'installed' || inst.runtime !== 'running') {
      setW(undefined);
      return;
    }
    let live = true;
    const load = () => {
      void api
        .widget(inst.id)
        .then((v) => live && setW(v))
        .catch(() => live && setW(null));
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [inst.id, inst.installState, inst.runtime]);
  if (!w) return null;
  const text = w.kind === 'metrics' ? w.items.map((x) => (x.unit ? `${x.label} ${x.value}${x.unit}` : `${x.label} ${x.value}`)).join(' · ') : w.items.map((x) => x.title).join(' · ');
  if (!text) return null;
  return (
    <span className="icon-widget" title={text}>
      {text}
    </span>
  );
}

function SystemStrip({ m, dockerAvailable }: { m: SystemMetricsDto | null; dockerAvailable: boolean | null }) {
  const pct = (used: number, total: number) => (total ? Math.min(100, Math.round((used / total) * 100)) : 0);
  return (
    <section className="strip" aria-label="System">
      <Meter label="Processor" value={m ? `${m.cpu.load1.toFixed(2)} load` : '—'} sub={m ? `${m.cpu.cores} cores · up ${fmtUptime(m.uptimeSeconds)}` : 'loading'} pct={m ? Math.min(100, Math.round((m.cpu.load1 / m.cpu.cores) * 100)) : 0} />
      <Meter label="Memory" value={m ? `${fmtBytes(m.memory.usedBytes)} / ${fmtBytes(m.memory.totalBytes)}` : '—'} sub={m ? `${pct(m.memory.usedBytes, m.memory.totalBytes)}% used` : 'loading'} pct={m ? pct(m.memory.usedBytes, m.memory.totalBytes) : 0} />
      <Meter label="Storage" value={m?.disk ? `${fmtBytes(m.disk.totalBytes - m.disk.usedBytes)} free` : '—'} sub={m?.disk ? `${pct(m.disk.usedBytes, m.disk.totalBytes)}% of ${fmtBytes(m.disk.totalBytes)} used` : 'loading'} pct={m?.disk ? pct(m.disk.usedBytes, m.disk.totalBytes) : 0} />
      <div className={`meter ${dockerAvailable === false ? 'bad' : ''}`}>
        <div className="meter-label">Apps engine</div>
        <div className="meter-value">{m ? (m.docker.available ? `${m.docker.containersRunning} container${m.docker.containersRunning === 1 ? '' : 's'} running` : 'Not reachable') : '—'}</div>
        <div className="row">
          <Pill tone={m ? (m.docker.available ? 'ok' : 'bad') : 'muted'}>
            <span className="dot" aria-hidden="true" />
            {m ? (m.docker.available ? 'Docker online' : 'Docker offline') : 'checking'}
          </Pill>
        </div>
      </div>
    </section>
  );
}

export function Meter({ label, value, sub, pct }: { label: string; value: string; sub: string; pct: number }) {
  const level = pct > 90 ? 'hot' : pct > 75 ? 'warm' : '';
  return (
    <div className="meter">
      <div className="meter-label">{label}</div>
      <div className="meter-value">{value}</div>
      <div className="bar" aria-hidden="true">
        <span className={level} style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

// Decision 122: drives that need the operator — mounted by the desktop where Harbor cannot write, or
// plugged in but not mounted. One quick fix per drive, a dismiss (until the condition changes) and a
// link to Settings → Storage. Self-polling: the console store does not carry host storage.
function DrivesCard() {
  const [devices, setDevices] = useState<HostStorageDto['devices']>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hostStorage().then(
      (s) => setDevices(s.devices),
      () => {},
    );
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  const shown = devices.filter((d) => d.attention && !d.dismissed);
  if (!shown.length) return null;
  const fix = (d: HostStorageDto['devices'][number]) => {
    setBusy(d.name);
    setError(null);
    (d.attention === 'foreign' ? api.takeoverDevice(d.name) : api.mountDevice(d.name)).then(
      () => {
        let tries = 0;
        const t = setInterval(() => {
          tries += 1;
          api.deviceStatus(d.name).then(
            (st) => {
              if (st.state === 'mounted' || st.state === 'failed' || tries >= 20) {
                clearInterval(t);
                setBusy(null);
                if (st.state === 'failed') setError(st.message);
                load();
              }
            },
            () => {
              clearInterval(t);
              setBusy(null);
            },
          );
        }, 1500);
      },
      (e: Error) => {
        setBusy(null);
        setError(e.message);
      },
    );
  };
  return (
    <section className="card attention" aria-labelledby="drives-h">
      <div className="row between wrap">
        <h2 id="drives-h">{shown.length === 1 ? 'A drive needs attention' : `${shown.length} drives need attention`}</h2>
        <a className="small" href="#/settings/storage">
          Manage drives
        </a>
      </div>
      <ul className="plain">
        {shown.map((d) => {
          const label = d.label ?? d.name;
          return (
            <li key={d.name} className="row between wrap">
              <span>
                <strong>{label}</strong> —{' '}
                {d.attention === 'foreign' ? `mounted by your desktop at ${d.mountpoint}, where apps cannot use it` : 'plugged in but not mounted'}
              </span>
              <span className="row">
                <button className="btn primary" disabled={busy !== null} onClick={() => fix(d)} aria-busy={busy === d.name} aria-label={d.attention === 'foreign' ? `Let Harbor manage ${label}` : `Mount ${label}`}>
                  {busy === d.name ? (
                    <>
                      <span className="spin" aria-hidden="true" /> {d.attention === 'foreign' ? 'Taking over…' : 'Mounting…'}
                    </>
                  ) : d.attention === 'foreign' ? (
                    'Let Harbor manage it'
                  ) : (
                    'Mount it'
                  )}
                </button>
                <button className="btn ghost" disabled={busy !== null} onClick={() => void api.dismissDevice(d.name).then(load)} aria-label={`Dismiss the notice about ${label}`} title="Hide until this changes">
                  ×
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
