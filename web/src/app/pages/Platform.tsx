import { useState } from 'react';
import type { PlatformToolDto } from '../../../../src/contracts/api';
import { api, ApiError } from '../../api';
import { Dialog, Pill } from '../components';
import { fmtTime } from '../format';
import type { Console } from '../store';

const ADVANCED_ACK_KEY = 'harbor.advanced-tools-ack';
function readAdvancedAck(): boolean {
  try {
    return localStorage.getItem(ADVANCED_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

const ORDER = ['tailscale', 'proxy', 'cockpit', 'portainer'];
const BLURB: Record<string, string> = {
  tailscale: 'Private access from your own devices (tailnet).',
  proxy: 'Public HTTPS addresses for apps you choose to publish.',
  cockpit: 'Operating-system console (services, logs, updates). Log in with an OS account.',
  portainer: 'Docker console with full Docker authority. Has its own admin account.',
};

export function Platform({ c }: { c: Console }) {
  const { data } = c;
  const [advanced, setAdvanced] = useState<boolean>(() => readAdvancedAck());
  const ack = () => {
    try {
      localStorage.setItem(ADVANCED_ACK_KEY, '1');
    } catch {
      /* per-browser convenience only; the page still works */
    }
    setAdvanced(true);
  };
  const tools = [...data.tools].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const core = tools.filter((t) => t.id === 'tailscale' || t.id === 'proxy');
  const extra = tools.filter((t) => t.id === 'cockpit' || t.id === 'portainer');
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
          {core.map((t) => (
            <ToolCard key={t.id} t={t} />
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="adv-h">
        <h2 id="adv-h">Advanced tools</h2>
        {!advanced ? (
          <p className="muted small">
            Cockpit and Portainer are system consoles for advanced users.{' '}
            <button className="btn" onClick={ack}>
              Show advanced tools
            </button>
          </p>
        ) : (
          <ul className="grid tools">
            {extra.map((t) => (
              <ToolCard key={t.id} t={t} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ToolCard({ t }: { t: PlatformToolDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const installing = t.install && (t.install.state === 'requested' || t.install.state === 'installing');
  const installable = (t.id === 'cockpit' || t.id === 'portainer') && (t.mode === 'absent' || t.installationState === 'not_installed') && !installing;
  const tone = t.installationState === 'installed' ? (t.availability === 'reachable' ? 'ok' : t.availability === 'unreachable' ? 'bad' : 'muted') : t.installationState === 'setup_required' ? 'warn' : 'muted';
  const label = installing ? 'Installing…' : t.installationState === 'installed' ? (t.availability === 'reachable' ? 'Ready' : t.availability === 'unreachable' ? 'Not reachable' : 'Installed') : t.installationState === 'setup_required' ? 'Setup required' : t.installationState === 'not_installed' ? 'Not set up' : 'Unknown';
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.installTool(t.id);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };
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
      {installable && (
        <button className="btn primary" onClick={() => setConfirm(true)} disabled={busy} aria-label={`Set up ${t.name}`}>
          {busy ? 'Starting…' : `Set up ${t.name.split(' ')[0]}`}
        </button>
      )}
      {confirm && (
        <Dialog title={`Set up ${t.name}?`} onClose={() => setConfirm(false)}>
          <p>
            {t.id === 'portainer'
              ? 'Portainer gets full Docker authority (root-equivalent): it can start, stop and delete any container and volume on this machine. Only continue if you understand that.'
              : 'Cockpit is an operating-system console: it can manage services, logs and updates with an OS account. Only continue if you understand that.'}
          </p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setConfirm(false);
                void install();
              }}
            >
              I understand — set up
            </button>
          </div>
        </Dialog>
      )}
      {installing && t.install && <p className="small" role="status">{t.install.message} This page refreshes by itself.</p>}
      {t.install?.state === 'failed' && (
        <p className="error small" role="alert">
          Install failed: {t.install.message}
        </p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {t.browserUrl && t.installationState !== 'not_installed' && (
        <a className="btn" href={t.browserUrl} target="_blank" rel="noopener noreferrer">
          Open {t.name.split(' ')[0]}
        </a>
      )}
    </li>
  );
}
