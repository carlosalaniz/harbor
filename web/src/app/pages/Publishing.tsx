import type { ExposureDto, InstanceSummary } from '../../../../src/contracts/api';
import { api } from '../../api';
import { Copy, Empty, InstanceIcon, Pill } from '../components';
import { fmtTime } from '../format';
import type { Console } from '../store';

// Decision 189: addresses grouped by how people reach them. Public names (and your own proxy's) get the attention:
// they cost a domain, need DNS and can break, so problems float to the top and healthy rows stay quiet. The tailnet
// is plumbing: one compact card under its hostname. Running apps with no address at all are listed last.
const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const STATE_TONE = { active: 'ok', degraded: 'warn', pending: 'busy', removing: 'busy' } as const;

function AppName({ inst, name }: { inst: InstanceSummary | undefined; name: string }) {
  return (
    <span className="pub-name">
      {inst && <InstanceIcon inst={inst} size={28} />}
      <span>
        <strong>{name}</strong> {inst && <span className="muted small">{inst.packageName}</span>}
      </span>
    </span>
  );
}

// Healthy addresses show only the link; the state, its note and the last check appear when something is off.
function State({ e }: { e: ExposureDto }) {
  if (e.state === 'active') return null;
  return (
    <div className="pub-state">
      <Pill tone={STATE_TONE[e.state]}>{e.state}</Pill>
      {e.note && <span className="warn small"> {e.note}</span>}
      <span className="muted small"> · checked {fmtTime(e.observedAt)}</span>
    </div>
  );
}

export function Publishing({ c, onPublish }: { c: Console; onPublish: (i: InstanceSummary) => void }) {
  const { data } = c;
  const ts = data.tools.find((t) => t.id === 'tailscale');
  const byId = new Map(data.instances.map((i) => [i.id, i]));
  const manage = (id: string) => {
    const inst = byId.get(id);
    if (inst) onPublish(inst);
  };

  const internet = data.exposures.filter((e) => e.via !== 'tailnet');
  const tailnet = data.exposures.filter((e) => e.via === 'tailnet');
  const apps = [...new Set(internet.map((e) => e.instanceId))]
    .map((id) => ({ id, items: internet.filter((e) => e.instanceId === id) }))
    .sort((a, b) => Number(b.items.some((e) => e.state === 'degraded')) - Number(a.items.some((e) => e.state === 'degraded')));
  const base = (data.uiExposure && hostOf(data.uiExposure.url)) ?? (tailnet[0] ? hostOf(tailnet[0].url) : null);
  const published = new Set(data.exposures.map((e) => e.instanceId));
  const running = data.instances.filter((i) => i.installState === 'installed' && i.runtime === 'running');
  const unpublished = running.filter((i) => !published.has(i.id));

  return (
    <>
      <section className="card" aria-labelledby="pub-net-h">
        <div className="row between pub-head">
          <h2 id="pub-net-h">On the internet</h2>
          <a className="small" href="#/settings/public">
            Domains
          </a>
        </div>
        <p className="muted small">Public HTTPS addresses. The apps themselves keep listening on 127.0.0.1.</p>
        {apps.length === 0 ? (
          <Empty title="Nothing on the internet" hint="Publish an app on a domain you own and Harbor gets its HTTPS certificate." />
        ) : (
          <ul className="plain">
            {apps.map(({ id, items }) => {
              const inst = byId.get(id);
              const name = items[0]!.instanceName;
              return (
                <li key={id} className="pub-row">
                  <AppName inst={inst} name={name} />
                  <div className="pub-addrs">
                    {items.map((e) => (
                      <div key={e.id} className="pub-addr" title={e.state === 'active' ? `checked ${fmtTime(e.observedAt)}` : undefined}>
                        <a href={e.url} target="_blank" rel="noopener noreferrer">
                          {shortUrl(e.url)}
                        </a>
                        <Copy text={e.url} />
                        {e.via === 'proxy' && <span className="muted small"> your proxy</span>}
                        {e.isPrimary && items.length > 1 && <span className="muted small"> · main</span>}
                        {e.protection === 'basic' && <span className="muted small"> · basic auth</span>}
                        <State e={e} />
                      </div>
                    ))}
                  </div>
                  <button className="btn" onClick={() => manage(id)} aria-label={`Manage ${name}`}>
                    Manage
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="two">
        <section className="card" aria-labelledby="pub-ts-h">
          <div className="row between pub-head">
            <h2 id="pub-ts-h">On your tailnet</h2>
            {base && <span className="muted small pub-base">{base}</span>}
          </div>
          <p className="muted small">
            Only your devices signed in to Tailscale can open these. <a href="#/settings/remote">Choose apps…</a>
          </p>
          <ul className="plain pub-compact">
            <li className="row between">
              <span>
                <strong>Harbor console</strong>{' '}
                {data.uiExposure ? (
                  <a href={data.uiExposure.url} target="_blank" rel="noopener noreferrer">
                    {base === hostOf(data.uiExposure.url) ? 'Open' : shortUrl(data.uiExposure.url)}
                  </a>
                ) : (
                  <span className="muted small">not on the tailnet</span>
                )}
              </span>
              {data.uiExposure ? (
                <button className="btn ghost" aria-label="Withdraw Harbor console from the tailnet" onClick={() => void api.unexposeUi().then(() => c.refresh())}>
                  Withdraw
                </button>
              ) : (
                ts?.installationState === 'installed' && (
                  <button className="btn" aria-label="Expose Harbor UI on tailnet" onClick={() => void api.exposeUi().then(() => c.refresh())}>
                    Expose
                  </button>
                )
              )}
            </li>
            {tailnet.map((e) => (
              <li key={e.id} className="row between">
                <div>
                  <strong>{e.instanceName}</strong>{' '}
                  <a href={e.url} target="_blank" rel="noopener noreferrer" aria-label={e.url}>
                    {base === hostOf(e.url) ? `:${e.port}` : shortUrl(e.url)}
                  </a>
                  <Copy text={e.url} />
                  <State e={e} />
                </div>
                <button className="btn ghost" onClick={() => manage(e.instanceId)} aria-label={`Manage ${e.instanceName}`}>
                  Manage
                </button>
              </li>
            ))}
          </ul>
          {ts?.installationState !== 'installed' && (
            <p className="warn small">
              {ts?.note ?? 'Tailscale is not set up on this host.'} <a href="#/settings/remote">Set it up</a>
            </p>
          )}
        </section>
        <section className="card" aria-labelledby="pub-none-h">
          <h2 id="pub-none-h">Not published</h2>
          {running.length === 0 ? (
            <p className="muted">Install and start an app first.</p>
          ) : unpublished.length === 0 ? (
            <p className="muted">Every running app has an address.</p>
          ) : (
            <>
              <p className="muted small">Running apps with no tailnet or public address yet.</p>
              <ul className="plain pub-compact">
                {unpublished.map((i) => (
                  <li key={i.id} className="row between">
                    <AppName inst={i} name={i.name} />
                    <button className="btn" onClick={() => onPublish(i)} aria-label={`Publish ${i.name}`}>
                      Publish…
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
