import type { InstanceSummary } from '../../../../src/contracts/api';
import { api } from '../../api';
import { Copy, Empty, Pill } from '../components';
import { fmtTime } from '../format';
import type { Console } from '../store';

export function Publishing({ c, onPublish }: { c: Console; onPublish: (i: InstanceSummary) => void }) {
  const { data } = c;
  const ts = data.tools.find((t) => t.id === 'tailscale');
  const publishable = data.instances.filter((i) => i.installState === 'installed' && i.runtime === 'running');
  return (
    <>
      <section className="card" aria-labelledby="pub-h">
        <h2 id="pub-h">Published addresses</h2>
        <p className="muted small">Apps always listen on 127.0.0.1. These are the HTTPS front doors Harbor put in front of them.</p>
        {data.exposures.length === 0 && !data.uiExposure ? (
          <Empty title="Nothing published" hint="Everything is loopback-only. Publish an app on your tailnet or on a public hostname from its Publish… button." />
        ) : (
          <ul className="plain">
            {data.uiExposure && (
              <li className="row between">
                <span>
                  <Pill tone="info">tailnet</Pill> <strong>Harbor console</strong>{' '}
                  <a href={data.uiExposure.url} target="_blank" rel="noopener noreferrer">
                    {data.uiExposure.url}
                  </a>
                  <Copy text={data.uiExposure.url} />
                </span>
                <button className="btn ghost" onClick={() => void api.unexposeUi().then(() => c.refresh())}>
                  Withdraw
                </button>
              </li>
            )}
            {data.exposures.map((e) => (
              <li key={e.id} className="row between">
                <span>
                  <Pill tone="info">{e.via}</Pill> <strong>{e.instanceName}</strong>{' '}
                  <a href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.url}
                  </a>
                  <Copy text={e.url} /> <Pill tone={e.state === 'active' ? 'ok' : e.state === 'degraded' ? 'warn' : 'busy'}>{e.state}</Pill>
                  {e.isPrimary && <span className="muted small"> primary</span>}
                  {e.protection === 'basic' && <span className="muted small"> · basic auth</span>}
                  <span className="muted small"> · checked {fmtTime(e.observedAt)}</span>
                  {e.note && e.state !== 'active' && <span className="warn small"> · {e.note}</span>}
                </span>
                <button className="btn" onClick={() => onPublish(data.instances.find((i) => i.id === e.instanceId)!)} disabled={c.busy}>
                  Manage
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="two">
        <section className="card" aria-labelledby="pubapps-h">
          <h2 id="pubapps-h">Publish an app</h2>
          {publishable.length === 0 ? (
            <p className="muted">Install and start an app first.</p>
          ) : (
            <ul className="plain">
              {publishable.map((i) => (
                <li key={i.id} className="row between">
                  <span>
                    <strong>{i.name}</strong> <span className="muted small">{i.packageName}</span>
                  </span>
                  <button className="btn" onClick={() => onPublish(i)} disabled={c.busy} aria-label={`Publish ${i.name}`}>
                    Publish…
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="pubui-h">
          <h2 id="pubui-h">Harbor on your tailnet</h2>
          <p className="muted small">Reach this console from your other devices over Tailscale. It is never published on the public internet.</p>
          {ts?.installationState !== 'installed' ? (
            <p className="warn">{ts?.note ?? 'Tailscale is not set up on this host.'}</p>
          ) : data.uiExposure ? (
            <p>
              Available at{' '}
              <a href={data.uiExposure.url} target="_blank" rel="noopener noreferrer">
                {data.uiExposure.url}
              </a>
            </p>
          ) : (
            <button className="btn" onClick={() => void api.exposeUi().then(() => c.refresh())}>
              Expose Harbor UI on tailnet
            </button>
          )}
        </section>
      </div>
    </>
  );
}
