import type { PlatformToolDto } from '../../../../src/contracts/api';
import { Pill } from '../components';
import { fmtTime } from '../format';
import type { Console } from '../store';

const ORDER = ['tailscale', 'proxy', 'cockpit', 'portainer'];
const BLURB: Record<string, string> = {
  tailscale: 'Private access from your own devices (tailnet).',
  proxy: 'Public HTTPS addresses for apps you choose to publish.',
  cockpit: 'Operating-system console (services, logs, updates). Log in with an OS account.',
  portainer: 'Docker console with full Docker authority. Has its own admin account.',
};

export function Platform({ c }: { c: Console }) {
  const { data } = c;
  const tools = [...data.tools].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return (
    <>
      <section className="card" aria-labelledby="sys-h">
        <h2 id="sys-h">Harbor</h2>
        {data.system ? (
          <dl className="kv">
            <dt>Version</dt>
            <dd>
              {data.system.version} · {data.system.profile}
            </dd>
            <dt>Docker Engine</dt>
            <dd>
              <Pill tone={data.system.docker.available ? 'ok' : 'bad'}>{data.system.docker.available ? `available ${data.system.docker.version ?? ''}` : 'unavailable'}</Pill>
              <span className="muted small"> observed {fmtTime(data.system.docker.observedAt)}</span>
              {data.system.docker.error && <span className="error small"> {data.system.docker.error}</span>}
            </dd>
            <dt>Busy</dt>
            <dd>{data.system.busyOperationId ?? 'no operation running'}</dd>
            <dt>Installation</dt>
            <dd>
              <code>{data.system.installationId}</code>
            </dd>
          </dl>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
      <section className="card" aria-labelledby="tools-h">
        <h2 id="tools-h">Platform tools</h2>
        <ul className="grid tools">
          {tools.map((t) => (
            <ToolCard key={t.id} t={t} />
          ))}
        </ul>
      </section>
    </>
  );
}

function ToolCard({ t }: { t: PlatformToolDto }) {
  const tone = t.installationState === 'installed' ? (t.availability === 'reachable' ? 'ok' : t.availability === 'unreachable' ? 'bad' : 'muted') : t.installationState === 'setup_required' ? 'warn' : 'muted';
  const label = t.installationState === 'installed' ? (t.availability === 'reachable' ? 'Ready' : t.availability === 'unreachable' ? 'Not reachable' : 'Installed') : t.installationState === 'setup_required' ? 'Setup required' : t.installationState === 'not_installed' ? 'Not set up' : 'Unknown';
  return (
    <li className={`tile tool ${t.id}`}>
      <div className="tile-main static">
        <div>
          <h3>{t.name}</h3>
          <p className="muted small">{BLURB[t.id] ?? ''}</p>
          <Pill tone={tone}>
            <span className="dot" aria-hidden="true" />
            {label}
          </Pill>{' '}
          <span className="muted small">{t.mode !== 'absent' ? t.mode : ''}</span>
          {t.note && <p className="small note">{t.note}</p>}
          {t.facts && Object.keys(t.facts).length > 0 && (
            <p className="muted small">
              {Object.entries(t.facts)
                .filter(([, v]) => v !== null && v !== '')
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join(' · ')}
            </p>
          )}
          <p className="muted small">observed {fmtTime(t.observedAt)}</p>
        </div>
      </div>
      {t.browserUrl && t.installationState !== 'not_installed' && (
        <a className="btn" href={t.browserUrl} target="_blank" rel="noopener noreferrer">
          Open {t.name.split(' ')[0]}
        </a>
      )}
    </li>
  );
}
