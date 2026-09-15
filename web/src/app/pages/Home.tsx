import type { CatalogItemDto, InstanceSummary, SystemMetricsDto } from '../../../../src/contracts/api';
import { AppIcon, Pill } from '../components';
import { fmtBytes, fmtUptime, plainStatus } from '../format';
import type { Console } from '../store';

const PICKS = ['nextcloud', 'immich', 'jellyfin', 'open-webui', 'vaultwarden', 'n8n'];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// Home is a launcher, the way a phone's home screen is: one icon per app, tap to open. Everything
// else (status words, addresses, actions) lives one tap away in the app's drawer.
export function Home({ c, onOpenApp, onGoStore, onPick }: { c: Console; onOpenApp: (i: InstanceSummary) => void; onGoStore: () => void; onPick: (item: CatalogItemDto) => void }) {
  const { data, loaded } = c;
  const running = data.instances.filter((i) => i.installState === 'installed' && i.runtime === 'running').length;
  const attention = data.instances.filter((i) => ['failed', 'needs_action'].includes(i.installState) || i.readiness === 'unhealthy' || i.runtime === 'unavailable');
  const degraded = data.exposures.filter((e) => e.state === 'degraded');
  const picks = PICKS.map((id) => data.catalog.find((i) => i.id === id)).filter((i): i is CatalogItemDto => Boolean(i && i.availability === 'available'));
  const active = data.instances.filter((i) => i.installState !== 'retained');
  const retained = data.instances.filter((i) => i.installState === 'retained');
  const now = new Date();
  return (
    <>
      <header className="page-head launcher-head">
        <div>
          <p className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          <h1>{greeting()}</h1>
          <p className="muted">{!loaded ? 'Loading your apps…' : data.instances.length === 0 ? 'Your own cloud, on this machine. Add your first app to get started.' : `${running} of ${active.length} app${active.length === 1 ? '' : 's'} running · ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`}</p>
        </div>
        <button className="btn primary" onClick={onGoStore}>
          + Add an app
        </button>
      </header>
      <SystemStrip m={data.metrics} dockerAvailable={data.system?.docker.available ?? null} />
      {(attention.length > 0 || degraded.length > 0) && (
        <section className="card attention" aria-labelledby="att-h">
          <h2 id="att-h">Needs attention</h2>
          <ul className="plain">
            {attention.map((i) => (
              <li key={i.id} className="row between">
                <span>
                  <strong>{i.packageName}</strong>
                  {i.name !== i.packageId ? ` (${i.name})` : ''} — {plainStatus(i).label}
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
      <section className="launcher" aria-labelledby="apps-h">
        <h2 id="apps-h" className="visually-hidden">
          Your apps
        </h2>
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
              {active.map((i) => (
                <AppIconTile key={i.id} inst={i} onDetails={() => onOpenApp(i)} />
              ))}
              <li className="icon-tile add">
                <button className="icon-btn" onClick={onGoStore} aria-label="Add an app">
                  <span className="appicon large add-glyph" aria-hidden="true">
                    +
                  </span>
                  <span className="icon-label">Add app</span>
                </button>
              </li>
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
    </>
  );
}

function AppIconTile({ inst, onDetails }: { inst: InstanceSummary; onDetails: () => void }) {
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const url = primary ? (primary.urls[primary.primary as keyof typeof primary.urls] ?? primary.urls.loopback) : null;
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && url;
  const status = plainStatus(inst);
  const label = inst.name === inst.packageId ? inst.packageName : `${inst.packageName} · ${inst.name}`;
  return (
    <li className={`icon-tile instance ${inst.installState} tone-${status.tone}`} aria-busy={inst.installState === 'installing'}>
      {canOpen ? (
        <a className="icon-btn" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`} title={`${label} — ${status.label}`}>
          <AppIcon packageId={inst.packageId} icon={inst.icon} name={inst.packageName} size={72} />
          <span className="icon-label">{label}</span>
          <span className="icon-status">
            <span className={`dot tone-${status.tone}`} aria-hidden="true" />
            <span className="visually-hidden">{status.label}</span>
          </span>
        </a>
      ) : (
        <button className="icon-btn" onClick={onDetails} aria-label={`Manage ${inst.name}`} title={`${label} — ${status.label}`}>
          <AppIcon packageId={inst.packageId} icon={inst.icon} name={inst.packageName} size={72} />
          <span className="icon-label">{label}</span>
          <span className="icon-status small">
            <span className={`dot tone-${status.tone}`} aria-hidden="true" /> {status.label}
          </span>
        </button>
      )}
      <button className="btn ghost icon more" onClick={onDetails} aria-label={`Details of ${inst.name}`} title="Details and actions">
        ⋯
      </button>
    </li>
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

function Meter({ label, value, sub, pct }: { label: string; value: string; sub: string; pct: number }) {
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
