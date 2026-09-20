import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogItemDto, InstanceSummary, SystemMetricsDto, WidgetDto } from '../../../../src/contracts/api';
import { api } from '../../api';
import { AppIcon, InstanceIcon, Pill, appLabel, openUrl } from '../components';
import { ArrowUpIcon, EllipsisIcon } from '../icons';
import { fmtBytes, fmtUptime, plainStatus } from '../format';
import { useReorder } from '../reorder';
import type { Console } from '../store';

const PICKS = ['nextcloud', 'immich', 'jellyfin', 'open-webui', 'vaultwarden', 'n8n'];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// The header greets the administrator by name ("Good morning, Carlos") once the
// account endpoint answers; before that it falls back to the bare greeting.
// The username is capitalized for display ("carlos" → "Carlos").
function useGreeting(): string {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    api
      .security()
      .then((s) => {
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
  const attention = data.instances.filter((i) => ['failed', 'needs_action'].includes(i.installState) || i.readiness === 'unhealthy' || i.runtime === 'unavailable' || Boolean(i.needsDrive));
  const degraded = data.exposures.filter((e) => e.state === 'degraded');
  const picks = PICKS.map((id) => data.catalog.find((i) => i.id === id)).filter((i): i is CatalogItemDto => Boolean(i && i.availability === 'available'));
  const active = data.instances.filter((i) => i.installState !== 'retained');
  const retained = data.instances.filter((i) => i.installState === 'retained');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // launcher order: the saved order first, then anything new in install order
  const saved = data.appearance?.home.order ?? [];
  const sortedIds = useMemo(() => {
    const ids = active.map((i) => i.id);
    const rank = new Map(saved.map((id, i) => [id, i]));
    return ids.slice().sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || ids.indexOf(a) - ids.indexOf(b));
  }, [active.map((i) => i.id).join('|'), saved.join('|')]);
  const commit = useCallback(
    (order: string[]) => {
      c.patchData((d) => (d.appearance ? { ...d, appearance: { ...d.appearance, home: { order } } } : d));
      void api.setHomeOrder(order).catch(() => c.refresh());
    },
    [c],
  );
  const re = useReorder(sortedIds, commit);
  const byId = new Map(active.map((i) => [i.id, i]));
  const tiles = re.order.map((id) => byId.get(id)).filter((i): i is InstanceSummary => Boolean(i));
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
          {active.length > 1 && (
            <button className={`btn ghost ${re.arranging ? 'active' : ''}`} onClick={() => re.setArranging(!re.arranging)} aria-pressed={re.arranging}>
              {re.arranging ? 'Done' : 'Arrange'}
            </button>
          )}
          <button className="btn primary" onClick={onGoStore}>
            + Add an app
          </button>
        </div>
      </header>
      <SystemStrip m={data.metrics} dockerAvailable={data.system?.docker.available ?? null} />
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
                disabled={c.busy}
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
                    <strong>{appLabel(i)}</strong> <span className="muted small">{i.revision} → {i.updateAvailable!.revision}{i.updateAvailable!.version ? ` (${i.updateAvailable!.version})` : ''}</span>
                    {i.updateAvailable!.releaseNotes && <span className="muted small"> · {i.updateAvailable!.releaseNotes}</span>}
                  </span>
                </span>
                <button className="btn primary" disabled={c.busy} onClick={() => c.start({ kind: 'update', instance: i })} aria-label={`Update ${i.name}`}>
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
                  <strong>{appLabel(i)}</strong> — {plainStatus(i).label}
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
      <section className={`launcher ${re.arranging ? 'arranging' : ''}`} aria-labelledby="apps-h">
        <h2 id="apps-h" className="visually-hidden">
          Your apps
        </h2>
        {re.arranging && (
          <p className="muted small arrange-hint" role="status">
            Drag icons to arrange them. Arrow keys move the focused app. Press Done (or Esc) when you are happy.
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
            <ul className="icons" aria-label="Installed apps">
              {tiles.map((i) => (
                <AppIconTile key={i.id} inst={i} onDetails={() => onOpenApp(i)} reorder={re} />
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
            {retained.length > 0 && (
              <details className="retained-list">
                <summary className="muted small">
                  {retained.length} removed app{retained.length === 1 ? '' : 's'} with data kept
                </summary>
                <ul className="icons">
                  {retained.map((i) => (
                    <AppIconTile key={i.id} inst={i} onDetails={() => onOpenApp(i)} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
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

function AppIconTile({ inst, onDetails, reorder }: { inst: InstanceSummary; onDetails: () => void; reorder?: ReturnType<typeof useReorder> }) {
  const url = openUrl(inst);
  const arranging = reorder?.arranging ?? false;
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && url && !arranging;
  const status = plainStatus(inst);
  const label = appLabel(inst);
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
      className={`icon-tile instance ${inst.installState} tone-${status.tone} ${reorder?.dragging === inst.id ? 'dragging' : ''}`}
      aria-busy={inst.installState === 'installing'}
      onPointerDown={tp?.onPointerDown}
      onKeyDown={tp?.onKeyDown}
      style={tp?.style}
      data-instance={inst.name}
    >
      {canOpen ? (
        <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`} title={`${label} — ${status.label}${usageText}`} onClick={guard} draggable={false}>
          <InstanceIcon inst={inst} size={64} />
          <span className="icon-label">{label}</span>
          <span className="icon-status">
            <span className={`dot tone-${status.tone}`} aria-hidden="true" />
            <span className="visually-hidden">{status.label}</span>
          </span>
        </a>
      ) : (
        <button className="icon-btn" onClick={(e) => (arranging || reorder?.suppressClick(inst.id) ? guard(e) : onDetails())} aria-label={arranging ? `Move ${inst.name}` : `Manage ${inst.name}`} title={`${label} — ${status.label}${usageText}`}>
          <InstanceIcon inst={inst} size={64} />
          <span className="icon-label">{label}</span>
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
        <span className="update-dot" title={`Update available: revision ${inst.updateAvailable.revision}`} aria-label={`Update available for ${inst.name}`}>
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
