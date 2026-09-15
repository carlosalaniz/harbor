import type { CatalogItemDto, InstanceSummary, SystemMetricsDto } from '../../../../src/contracts/api';
import { AppIcon, Pill, StatusPill } from '../components';
import { fmtBytes, fmtUptime, plainStatus } from '../format';
import type { Console } from '../store';

const PICKS = ['nextcloud', 'immich', 'jellyfin', 'open-webui', 'vaultwarden', 'n8n'];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home({ c, onOpenApp, onGoStore, onPick }: { c: Console; onOpenApp: (i: InstanceSummary) => void; onGoStore: () => void; onPick: (item: CatalogItemDto) => void }) {
  const { data, loaded } = c;
  const running = data.instances.filter((i) => i.installState === 'installed' && i.runtime === 'running').length;
  const picks = PICKS.map((id) => data.catalog.find((i) => i.id === id)).filter((i): i is CatalogItemDto => Boolean(i && i.availability === 'available'));
  const attention = data.instances.filter((i) => ['failed', 'needs_action'].includes(i.installState) || i.readiness === 'unhealthy' || i.runtime === 'unavailable');
  const degraded = data.exposures.filter((e) => e.state === 'degraded');
  return (
    <>
      <header className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <p className="muted">{!loaded ? 'Loading your apps…' : data.instances.length === 0 ? 'Your own cloud, on this machine. Add your first app to get started.' : `${running} of ${data.instances.length} app${data.instances.length === 1 ? '' : 's'} running. Everything stays private until you publish it.`}</p>
        </div>
        <button className="btn primary" onClick={onGoStore}>
          + Add an app
        </button>
      </header>
      <SystemStrip m={data.metrics} dockerObservedAt={data.system?.docker.observedAt ?? null} />
      {(attention.length > 0 || degraded.length > 0) && (
        <section className="card attention" aria-labelledby="att-h">
          <h2 id="att-h">Needs attention</h2>
          <ul className="plain">
            {attention.map((i) => (
              <li key={i.id} className="row between">
                <span>
                  <strong>{i.name}</strong> — {plainStatus(i).label}
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
      <section className="card" aria-labelledby="apps-h">
        <div className="row between">
          <h2 id="apps-h">Your apps</h2>
          {data.instances.length > 0 && (
            <button className="btn ghost" onClick={onGoStore}>
              Add an app →
            </button>
          )}
        </div>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : data.instances.length === 0 ? (
          <div className="welcome">
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
          <ul className="grid apps">
            {data.instances.map((i) => (
              <AppTile key={i.id} inst={i} onOpen={() => onOpenApp(i)} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AppTile({ inst, onOpen }: { inst: InstanceSummary; onOpen: () => void }) {
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const url = primary ? (primary.urls[primary.primary as keyof typeof primary.urls] ?? primary.urls.loopback) : null;
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && url;
  return (
    <li className={`tile instance ${inst.installState}`} aria-busy={inst.installState === 'installing'}>
      <button className="tile-main" onClick={onOpen} aria-label={`Details of ${inst.name}`}>
        <AppIcon packageId={inst.packageId} icon={inst.icon} name={inst.packageName} size={56} />
        <div>
          <h3>
            {inst.packageName}
            {inst.name !== inst.packageId && <span className="muted small instance-name"> {inst.name}</span>}
          </h3>
          <StatusPill inst={inst} />
          {url && <p className="muted small url">{url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</p>}
        </div>
      </button>
      {canOpen ? (
        <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`}>
          Open
        </a>
      ) : (
        <button className="btn" onClick={onOpen} aria-label={`Manage ${inst.name}`}>
          Manage
        </button>
      )}
    </li>
  );
}

function SystemStrip({ m, dockerObservedAt }: { m: SystemMetricsDto | null; dockerObservedAt: string | null }) {
  const pct = (used: number, total: number) => (total ? Math.min(100, Math.round((used / total) * 100)) : 0);
  return (
    <section className="strip" aria-label="System">
      <Meter label="Processor" value={m ? `${m.cpu.load1.toFixed(2)} load` : '—'} sub={m ? `${m.cpu.cores} cores · up ${fmtUptime(m.uptimeSeconds)}` : 'loading'} pct={m ? Math.min(100, Math.round((m.cpu.load1 / m.cpu.cores) * 100)) : 0} />
      <Meter label="Memory" value={m ? `${fmtBytes(m.memory.usedBytes)} / ${fmtBytes(m.memory.totalBytes)}` : '—'} sub={m ? `${pct(m.memory.usedBytes, m.memory.totalBytes)}% used` : 'loading'} pct={m ? pct(m.memory.usedBytes, m.memory.totalBytes) : 0} />
      <Meter label="Storage" value={m?.disk ? `${fmtBytes(m.disk.usedBytes)} / ${fmtBytes(m.disk.totalBytes)}` : '—'} sub={m?.disk ? `${pct(m.disk.usedBytes, m.disk.totalBytes)}% of ${m.disk.path}` : 'loading'} pct={m?.disk ? pct(m.disk.usedBytes, m.disk.totalBytes) : 0} />
      <div className={`meter ${m && !m.docker.available ? 'bad' : ''}`}>
        <div className="meter-label">Docker</div>
        <div className="meter-value">{m ? (m.docker.available ? `${m.docker.containersRunning} container${m.docker.containersRunning === 1 ? '' : 's'} running` : 'Not reachable') : '—'}</div>
        <div className="row">
          <Pill tone={m ? (m.docker.available ? 'ok' : 'bad') : 'muted'}>
            <span className="dot" aria-hidden="true" />
            {m ? (m.docker.available ? 'Engine online' : 'Engine offline') : 'checking'}
          </Pill>
        </div>
        <div className="muted small">{m ? `${m.docker.version ? `Docker ${m.docker.version} · ` : ''}checked ${dockerObservedAt ? new Date(dockerObservedAt).toLocaleTimeString() : '—'}` : 'loading'}</div>
      </div>
    </section>
  );
}

function Meter({ label, value, sub, pct }: { label: string; value: string; sub: string; pct: number }) {
  // colour follows pressure: calm until 75%, amber to 90%, red above
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
