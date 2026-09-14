import type { InstanceSummary, SystemMetricsDto } from '../../../../src/contracts/api';
import { AppIcon, Empty, StatusPill } from '../components';
import { fmtBytes, fmtUptime, plainStatus } from '../format';
import type { Console } from '../store';

export function Home({ c, onOpenApp, onGoStore }: { c: Console; onOpenApp: (i: InstanceSummary) => void; onGoStore: () => void }) {
  const { data, loaded } = c;
  const attention = data.instances.filter((i) => ['failed', 'needs_action'].includes(i.installState) || i.readiness === 'unhealthy' || i.runtime === 'unavailable');
  const degraded = data.exposures.filter((e) => e.state === 'degraded');
  return (
    <>
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
          <button className="btn ghost" onClick={onGoStore}>
            Add an app →
          </button>
        </div>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : data.instances.length === 0 ? (
          <Empty title="No apps yet" hint="Pick one from the App Store. Everything runs on this machine and stays on 127.0.0.1 until you publish it." action={<button className="btn primary" onClick={onGoStore}>Open the App Store</button>} />
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
          <h3>{inst.name}</h3>
          <StatusPill inst={inst} />
          {url && <p className="muted small url">{url}</p>}
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
      <Meter label="Docker" value={m ? (m.docker.available ? `running ${m.docker.containersRunning}/${m.docker.containersTotal}` : 'unavailable') : '—'} sub={m ? `${m.docker.version ?? ''} · seen ${dockerObservedAt ? new Date(dockerObservedAt).toLocaleTimeString() : '—'}` : 'loading'} pct={m?.docker.available ? 100 : 0} tone={m && !m.docker.available ? 'bad' : 'ok'} />
    </section>
  );
}

function Meter({ label, value, sub, pct, tone = 'ok' }: { label: string; value: string; sub: string; pct: number; tone?: 'ok' | 'bad' }) {
  return (
    <div className={`meter ${tone}`}>
      <div className="meter-label">{label}</div>
      <div className="meter-value">{value}</div>
      <div className="bar" aria-hidden="true">
        <span className={pct > 90 ? 'hot' : ''} style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">{sub}</div>
    </div>
  );
}
