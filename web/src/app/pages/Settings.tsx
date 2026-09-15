import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Terminal } from '../Terminal';
import type { AppearanceDto, DomainsDto, HostStorageDto, InstanceLogsDto, LogsDto, PlatformToolDto, SecurityDto, SystemHostDto, WallpaperSource } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Copy, Dialog, FolderPicker, InstanceIcon, Pill, appLabel } from '../components';
import { fmtBytes, fmtUptime } from '../format';
import type { Console } from '../store';
import { WALLPAPERS, applyTheme, applyWallpaper, hasExplicitWallpaper, readTheme, readWallpaper, syncWallpaperPicture, type Theme, type Wallpaper } from '../theme';

type Section = 'overview' | 'account' | 'remote' | 'public' | 'storage' | 'appearance' | 'access' | 'troubleshoot' | 'about';
const SECTIONS: { id: Section; label: string; glyph: string; blurb: string }[] = [
  { id: 'overview', label: 'Overview', glyph: '◉', blurb: 'This machine at a glance' },
  { id: 'account', label: 'Account', glyph: '👤', blurb: 'Password and session' },
  { id: 'remote', label: 'Remote access', glyph: '🛰', blurb: 'Reach Harbor from your other devices' },
  { id: 'public', label: 'Public addresses', glyph: '🌐', blurb: 'Publishing apps on the internet' },
  { id: 'storage', label: 'Storage', glyph: '💽', blurb: 'Disks and folders your apps use' },
  { id: 'appearance', label: 'Appearance', glyph: '🎨', blurb: 'Theme and wallpapers' },
  { id: 'access', label: 'Advanced access', glyph: '⌨️', blurb: 'Terminal, SSH forwarding, CLI' },
  { id: 'troubleshoot', label: 'Troubleshoot', glyph: '🩺', blurb: 'Harbor and app logs' },
  { id: 'about', label: 'About', glyph: 'ℹ️', blurb: 'Version and trust boundary' },
];

export function Settings({ c, onLogout, initialSection, onSection }: { c: Console; onLogout: () => void; initialSection?: string; onSection?: (s: string) => void }) {
  const [section, setSectionState] = useState<Section>((SECTIONS.some((s) => s.id === initialSection) ? initialSection : 'overview') as Section);
  useEffect(() => {
    if (SECTIONS.some((s) => s.id === initialSection)) setSectionState(initialSection as Section);
    else if (!initialSection) setSectionState('overview');
  }, [initialSection]);
  const setSection = (s: Section) => {
    setSectionState(s);
    onSection?.(s);
  };
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <ul className="plain">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button className={`settings-link ${section === s.id ? 'active' : ''}`} onClick={() => setSection(s.id)} aria-current={section === s.id ? 'page' : undefined}>
                <span className="glyph" aria-hidden="true">
                  {s.glyph}
                </span>
                <span>
                  <span className="settings-label">{s.label}</span>
                  <span className="muted small">{s.blurb}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-body">
        {section === 'overview' && <Overview c={c} onLogout={onLogout} go={setSection} />}
        {section === 'account' && <Account onLogout={onLogout} />}
        {section === 'remote' && <RemoteAccess c={c} />}
        {section === 'public' && <PublicAddresses c={c} />}
        {section === 'storage' && <Storage />}
        {section === 'appearance' && <Appearance c={c} />}
        {section === 'access' && <Access c={c} />}
        {section === 'troubleshoot' && <Troubleshoot c={c} />}
        {section === 'about' && <About c={c} />}
      </div>
    </div>
  );
}

// The Umbrel-style landing: the machine, its vitals, power, and the wallpaper picker right there.
function Overview({ c, onLogout, go }: { c: Console; onLogout: () => void; go: (s: Section) => void }) {
  const m = c.data.metrics;
  const [host, setHost] = useState<SystemHostDto | null>(null);
  const [confirm, setConfirm] = useState<'reboot' | 'poweroff' | null>(null);
  const [powerMsg, setPowerMsg] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    api.systemHost().then(setHost, () => setHost(null));
  }, []);
  const pct = (used: number, total: number) => (total ? Math.min(100, Math.round((used / total) * 100)) : 0);
  const hostname = host?.hostname ?? m?.host.hostname ?? 'this machine';
  const name = c.data.system?.deviceName ?? hostname;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const saveName = async () => {
    const sys = await api.setDeviceName(draft.trim() || null).catch(() => null);
    if (sys) c.patchData((d) => ({ ...d, system: sys }));
    setEditing(false);
  };
  const temp = m?.temperatureC ?? null;
  const tempTone = temp === null ? 'muted' : temp < 70 ? 'ok' : temp < 85 ? 'warn' : 'bad';
  const doPower = async (a: 'reboot' | 'poweroff') => {
    setConfirm(null);
    try {
      await api.power(a);
      setPowerMsg(a === 'reboot' ? 'Restarting… this page will reconnect when Harbor is back (usually under a minute).' : 'Shutting down. Turn the machine back on to use Harbor again.');
    } catch (e) {
      setPowerMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    }
  };
  return (
    <>
      <section className="card device" aria-labelledby="dev-h">
        <div className="device-preview" aria-hidden="true">
          <div className="device-screen">
            <span className="device-anchor">⚓</span>
            <span className="device-greeting">Good evening</span>
            <span className="device-dots">
              {c.data.instances
                .filter((i) => i.installState !== 'retained')
                .slice(0, 8)
                .map((i) => (
                  <span key={i.id} className="device-dot" />
                ))}
            </span>
          </div>
        </div>
        <div className="row wrap device-actions">
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
          <button className="btn" onClick={() => setConfirm('reboot')} disabled={host ? !host.power.available : false}>
            Restart
          </button>
          <button className="btn danger" onClick={() => setConfirm('poweroff')} disabled={host ? !host.power.available : false}>
            Shut down
          </button>
        </div>
        {host && !host.power.available && <p className="muted small">{host.power.note ?? 'Harbor cannot restart this machine from here.'}</p>}
        {powerMsg && (
          <p className="notice small" role="status">
            {powerMsg}
          </p>
        )}
        {editing ? (
          <form
            className="row wrap device-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={40} placeholder={hostname} aria-label="Device name" autoFocus />
            <button className="btn primary" type="submit">
              Save
            </button>
            <button className="btn ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h2 id="dev-h" className={`device-name ${c.data.system?.deviceName ? 'named' : ''}`}>
            {name}
            <button
              className="btn ghost icon rename"
              onClick={() => {
                setDraft(c.data.system?.deviceName ?? '');
                setEditing(true);
              }}
              aria-label="Rename this machine"
              title="Rename"
            >
              ✎
            </button>
          </h2>
        )}
        <dl className="kv device-facts">
          {c.data.system?.deviceName && (
            <>
              <dt>Hostname</dt>
              <dd>{hostname}</dd>
            </>
          )}
          <dt>Running on</dt>
          <dd>
            {host ? `${host.os} · ${host.arch}` : m ? `${m.host.os} · ${m.host.arch}` : '—'}
            {(host?.cpuModel ?? m?.host.cpuModel) ? <span className="muted"> · {host?.cpuModel ?? m?.host.cpuModel}</span> : null}
          </dd>
          <dt>Harbor version</dt>
          <dd>{c.data.system?.version ?? '—'}</dd>
          <dt>Up for</dt>
          <dd>{m ? fmtUptime(m.uptimeSeconds) : '—'}</dd>
        </dl>
      </section>
      <div className="vitals">
        <button className="card vital" onClick={() => go('storage')} aria-label="Storage details">
          <span className="meter-label">Storage</span>
          <span className="meter-value">
            {m?.disk ? fmtBytes(m.disk.usedBytes) : '—'} <span className="muted">/ {m?.disk ? fmtBytes(m.disk.totalBytes) : '—'}</span>
          </span>
          <span className="bar" aria-hidden="true">
            <span className={m?.disk && pct(m.disk.usedBytes, m.disk.totalBytes) > 90 ? 'hot' : ''} style={{ width: `${m?.disk ? pct(m.disk.usedBytes, m.disk.totalBytes) : 0}%` }} />
          </span>
        </button>
        <div className="card vital">
          <span className="meter-label">Memory</span>
          <span className="meter-value">
            {m ? fmtBytes(m.memory.usedBytes) : '—'} <span className="muted">/ {m ? fmtBytes(m.memory.totalBytes) : '—'}</span>
          </span>
          <span className="bar" aria-hidden="true">
            <span className={m && pct(m.memory.usedBytes, m.memory.totalBytes) > 90 ? 'hot' : ''} style={{ width: `${m ? pct(m.memory.usedBytes, m.memory.totalBytes) : 0}%` }} />
          </span>
        </div>
        <div className="card vital">
          <span className="meter-label">Temperature</span>
          <span className="meter-value">{temp === null ? 'n/a' : `${Math.round(temp)}°C`}</span>
          <span className="row">
            <Pill tone={tempTone}>
              <span className="dot" aria-hidden="true" />
              {temp === null ? 'Not reported by this machine' : temp < 70 ? 'Optimal' : temp < 85 ? 'Warm' : 'Hot'}
            </Pill>
          </span>
        </div>
        <button className="card vital" onClick={() => setLive((v) => !v)} aria-expanded={live}>
          <span className="meter-label">
            <span aria-hidden="true">∿ </span>Live usage
          </span>
          <span className="meter-value">{m ? `${m.cpu.load1.toFixed(2)} load` : '—'}</span>
          <span className="muted small">{live ? 'Hide details' : 'Open live usage'}</span>
        </button>
      </div>
      {live && m && (
        <section className="card" aria-label="Live usage">
          <dl className="kv">
            <dt>Processor</dt>
            <dd>
              {m.cpu.cores} cores · load {m.cpu.load1.toFixed(2)} / {m.cpu.load5.toFixed(2)} / {m.cpu.load15.toFixed(2)} (1 / 5 / 15 min)
            </dd>
            <dt>Memory</dt>
            <dd>
              {fmtBytes(m.memory.usedBytes)} used of {fmtBytes(m.memory.totalBytes)} ({pct(m.memory.usedBytes, m.memory.totalBytes)}%)
            </dd>
            <dt>Storage</dt>
            <dd>{m.disk ? `${fmtBytes(m.disk.usedBytes)} used of ${fmtBytes(m.disk.totalBytes)} on ${m.disk.path}` : 'unknown'}</dd>
            <dt>Apps engine</dt>
            <dd>{m.docker.available ? `Docker ${m.docker.version ?? ''} · ${m.docker.containersRunning} of ${m.docker.containersTotal} containers running` : 'Docker is not reachable'}</dd>
            <dt>Sampled</dt>
            <dd>{new Date(m.sampledAt).toLocaleTimeString()}</dd>
          </dl>
        </section>
      )}
      <WallpaperPicker c={c} compact onMore={() => go('appearance')} />
      {confirm && (
        <Dialog title={confirm === 'reboot' ? 'Restart this machine?' : 'Shut down this machine?'} onClose={() => setConfirm(null)}>
          <p>{confirm === 'reboot' ? 'Apps stop for a moment and come back on their own after the restart. Harbor reconnects when it is up again.' : 'Everything stops. You will need to turn the machine on again yourself (its power button, or your provider’s console) before Harbor and your apps are back.'}</p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className={`btn ${confirm === 'reboot' ? 'primary' : 'danger'}`} onClick={() => void doPower(confirm)}>
              {confirm === 'reboot' ? 'Restart now' : 'Shut down now'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function Account({ onLogout }: { onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (next !== again) return setMsg({ tone: 'bad', text: 'The two new passwords do not match.' });
    setBusy(true);
    try {
      const r = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setAgain('');
      setMsg({ tone: 'ok', text: `Password changed. ${r.revokedSessions} other session${r.revokedSessions === 1 ? '' : 's'} logged out; this one stays.` });
    } catch (err) {
      setMsg({ tone: 'bad', text: err instanceof ApiError ? `${err.message}. ${err.nextAction}` : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <TwoFactor />
      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <p className="muted small">Use at least 12 characters. Every other logged-in browser or CLI is signed out when you change it.</p>
        <form className="stack" onSubmit={submit}>
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
          </label>
          <label>
            New password (again)
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          </label>
          {msg && (
            <p className={msg.tone === 'ok' ? 'notice' : 'error'} role={msg.tone === 'ok' ? 'status' : 'alert'}>
              {msg.text}
            </p>
          )}
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </section>
      <section className="card" aria-labelledby="sess-h">
        <h2 id="sess-h">This session</h2>
        <p className="muted small">Your login lives in this tab only. Reloading asks you to log in again; running operations continue on the server.</p>
        <button className="btn" onClick={onLogout}>
          Log out
        </button>
      </section>
    </>
  );
}

// Two-factor login with any authenticator app (TOTP). Setup shows a QR code and the typed secret; a live
// code confirms it; the password turns it off. Recovery without the app: `harbor account totp reset --local` on the machine.
function TwoFactor() {
  const [sec, setSec] = useState<SecurityDto | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.security().then(setSec, () => setSec(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await load();
      if (ok) setMsg({ tone: 'ok', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      const r = await api.totpSetup();
      const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 196, color: { dark: '#000000', light: '#ffffff' } });
      setSetup({ ...r, qr });
      setCode('');
    });
  return (
    <section className="card" aria-labelledby="tfa-h">
      <div className="row between wrap">
        <div>
          <h2 id="tfa-h">Two-factor login</h2>
          <p className="muted small">A 6-digit code from an authenticator app (1Password, Google Authenticator, Authy…) is asked at every login, on top of the password.</p>
        </div>
        {sec && (
          <Pill tone={sec.twoFactor ? 'ok' : 'muted'}>
            <span className="dot" aria-hidden="true" />
            {sec.twoFactor ? 'On' : 'Off'}
          </Pill>
        )}
      </div>
      {sec && !sec.twoFactor && !setup && (
        <button className="btn primary" disabled={busy} onClick={() => void start()}>
          Turn on two-factor login
        </button>
      )}
      {setup && !sec?.twoFactor && (
        <div className="tfa-setup">
          <img src={setup.qr} alt="QR code for your authenticator app" className="qr" width={196} height={196} />
          <div className="stack">
            <p className="small">
              <strong>1.</strong> Scan this with your authenticator app, or type the key: <code className="secret">{setup.secret}</code> <Copy text={setup.secret} />
            </p>
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => (await api.totpEnable(code), setSetup(null), setCode('')), 'Two-factor login is on. Keep your authenticator safe; without it you need access to the machine to recover.');
              }}
            >
              <label className="small">
                <strong>2.</strong> Enter the code it shows now
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" pattern="[0-9 ]{6,7}" placeholder="123 456" aria-label="Authenticator code" autoComplete="one-time-code" />
              </label>
              <button className="btn primary" type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>
                Confirm and turn on
              </button>
              <button className="btn ghost" type="button" onClick={() => setSetup(null)}>
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}
      {sec?.twoFactor && (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => (await api.totpDisable(password), setPassword('')), 'Two-factor login is off.');
          }}
        >
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" aria-label="Password to turn off two-factor" autoComplete="current-password" />
          <button className="btn danger" type="submit" disabled={busy || !password}>
            Turn off
          </button>
          <span className="muted small">Lost the authenticator? On the machine: <code>sudo /opt/harbor/bin/harbor account totp reset --local --config /etc/harbor/harbor.json</code></span>
        </form>
      )}
      {msg && (
        <p className={`${msg.tone === 'ok' ? 'notice' : 'error'} small`} role={msg.tone === 'ok' ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

function RemoteAccess({ c }: { c: Console }) {
  const ts = c.data.tools.find((t) => t.id === 'tailscale');
  const [key, setKey] = useState('');
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const facts = (ts?.facts ?? {}) as Record<string, unknown>;
  const loggedIn = ts?.installationState === 'installed' || Boolean(facts['dnsName']);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await c.refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="card" aria-labelledby="ra-h">
        <h2 id="ra-h">Remote access with Tailscale</h2>
        <p className="muted small">Tailscale connects your devices in a private network (a tailnet). Once this machine is in it, you can open Harbor and your apps from your phone or laptop anywhere, with HTTPS, without opening ports on your router.</p>
        <StatusRow tool={ts} />
        {ts?.installationState === 'not_installed' || !ts ? (
          <div className="stack">
            <p>Tailscale is not installed on this machine yet. Run this once on the machine (as root), then come back here:</p>
            <pre className="code">sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale</pre>
          </div>
        ) : !loggedIn ? (
          <div className="stack">
            <h3>Connect this machine to your tailnet</h3>
            <p className="muted small">Easiest: click the button, approve the machine in the page that opens (log in with your Tailscale account), then come back. It shows up here within a few seconds.</p>
            <div className="row wrap">
              <button className="btn primary" disabled={busy} onClick={() => void run(async () => setLoginUrl((await api.tailscaleLogin()).loginUrl))}>
                Log in with Tailscale
              </button>
              {loginUrl && (
                <a className="btn" href={loginUrl} target="_blank" rel="noopener noreferrer">
                  Open the approval page ↗
                </a>
              )}
            </div>
            <details>
              <summary className="muted small">I have an auth key instead</summary>
              <div className="row wrap">
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tskey-auth-…" aria-label="Tailscale auth key" />
                <button className="btn" disabled={busy || !key.trim()} onClick={() => void run(async () => (await api.tailscaleLogin(key.trim()), setKey('')))}>
                  Connect with key
                </button>
              </div>
              <p className="muted small">Create one in the Tailscale admin console under Settings, Keys. It is used once and never stored.</p>
            </details>
          </div>
        ) : (
          <div className="stack">
            <p>
              This machine is <strong>{String(facts['dnsName'] ?? 'connected')}</strong>
              {facts['tailnet'] ? ` on tailnet ${String(facts['tailnet'])}` : ''}.
            </p>
            <dl className="kv">
              <dt>Tailnet addresses</dt>
              <dd>{String(facts['tailscaleIps'] ?? '—')}</dd>
              <dt>Node key expires</dt>
              <dd>{facts['keyExpiry'] ? new Date(String(facts['keyExpiry'])).toLocaleDateString() : 'never / unknown'}</dd>
              <dt>Auth key</dt>
              <dd className="muted">Used once at login and never stored by Harbor or Tailscale; create a new one in the admin console if you need another machine.</dd>
              <dt>Admin console</dt>
              <dd>
                <a href={String(facts['adminConsole'] ?? 'https://login.tailscale.com/admin/machines')} target="_blank" rel="noopener noreferrer">
                  login.tailscale.com/admin ↗
                </a>
              </dd>
            </dl>
            {facts['httpsEnabled'] === false && (
              <p className="warn">
                One more step in the Tailscale admin console: under <strong>DNS</strong>, turn on <strong>MagicDNS</strong> and click <strong>Enable HTTPS</strong>. Harbor needs it for the padlock on tailnet addresses.
              </p>
            )}
            <h3>Harbor on your tailnet</h3>
            {c.data.uiExposure ? (
              <p>
                Open Harbor from any device on your tailnet at{' '}
                <a href={c.data.uiExposure.url} target="_blank" rel="noopener noreferrer">
                  {c.data.uiExposure.url}
                </a>
                .{' '}
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.unexposeUi())}>
                  Turn off
                </button>
              </p>
            ) : (
              <button className="btn primary" disabled={busy || facts['httpsEnabled'] === false} onClick={() => void run(async () => void (await api.exposeUi()))}>
                Expose Harbor UI on tailnet
              </button>
            )}
            <p className="muted small">Apps are published individually from the Publishing page. Harbor is never published on the public internet.</p>
            <details>
              <summary className="muted small">Disconnect</summary>
              <p className="muted small">Logs this machine out of the tailnet and withdraws all tailnet addresses. Apps keep running locally.</p>
              <button className="btn danger" disabled={busy} onClick={() => void run(() => api.tailscaleLogout())}>
                Log out of the tailnet
              </button>
            </details>
          </div>
        )}
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
      </section>
    </>
  );
}

function PublicAddresses({ c }: { c: Console }) {
  const px = c.data.tools.find((t) => t.id === 'proxy');
  const [d, setD] = useState<DomainsDto | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.domains().then(setD, (e: Error) => setMsg(e.message));
  useEffect(() => {
    void load();
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  const installed = px && px.installationState !== 'not_installed';
  const stateLabel = (s: string) => ({ points_here: 'Points here', points_elsewhere: 'Points elsewhere', no_record: 'No DNS record yet', unknown: 'Not checked' })[s] ?? s;
  const stateTone = (s: string): 'ok' | 'warn' | 'muted' => (s === 'points_here' ? 'ok' : s === 'unknown' ? 'muted' : 'warn');
  return (
    <>
      <section className="card" aria-labelledby="pub-h">
        <h2 id="pub-h">Publish an app on the internet</h2>
        <p className="muted small">Three steps, all from here: point a domain you own at this machine, let Harbor confirm it, then choose the app. The HTTPS certificate is issued by Let's Encrypt automatically the moment the app is published, and renewed for you.</p>
        <StatusRow tool={px} />
        {!installed && (
          <div className="stack">
            <p>The public proxy (Caddy) is not installed. Run this once on the machine (as root), then come back:</p>
            <pre className="code">sudo /opt/harbor/bin/harbor bootstrap --yes --with-public-proxy</pre>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="ip-h">
        <h2 id="ip-h">
          <span className="step">1</span> This machine's public address
        </h2>
        {d ? (
          d.publicIp.v4 || d.publicIp.v6 ? (
            <p>
              Create an <strong>A record</strong> {d.publicIp.v6 ? 'and/or an AAAA record ' : ''}for your domain pointing at <code>{d.publicIp.v4 ?? d.publicIp.v6}</code>
              {d.publicIp.v4 && d.publicIp.v6 ? <> / <code>{d.publicIp.v6}</code></> : null}. If this machine is behind a home router, forward ports <strong>80</strong> and <strong>443</strong> to it.
            </p>
          ) : (
            <p className="warn">Harbor could not detect the public address ({d.publicIp.error ?? 'unknown'}). Find it in your router or from your provider, then continue below.</p>
          )
        ) : (
          <p className="muted">Detecting…</p>
        )}
      </section>
      <section className="card" aria-labelledby="dom-h">
        <h2 id="dom-h">
          <span className="step">2</span> Your domains
        </h2>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (host.trim()) void run(async () => (await api.addDomain(host.trim()), setHost('')));
          }}
        >
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="photos.example.com" aria-label="Domain name" />
          <button className="btn primary" type="submit" disabled={busy || !host.trim()}>
            Add and check
          </button>
        </form>
        {msg && (
          <p className="error small" role="alert">
            {msg}
          </p>
        )}
        <ul className="plain domains">
          {d?.items.map((dom) => (
            <li key={dom.hostname} className="domain">
              <div className="row between wrap">
                <span className="row wrap">
                  <strong>{dom.hostname}</strong>
                  <Pill tone={stateTone(dom.dns.state)}>
                    <span className="dot" aria-hidden="true" />
                    {stateLabel(dom.dns.state)}
                  </Pill>
                  {dom.usedBy && (
                    <Pill tone={dom.usedBy.exposureState === 'active' ? 'ok' : 'busy'}>
                      {dom.usedBy.instanceName} · {dom.usedBy.exposureState === 'active' ? 'live with HTTPS' : dom.usedBy.exposureState}
                    </Pill>
                  )}
                </span>
                <span className="row">
                  <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.checkDomain(dom.hostname))} aria-label={`Re-check ${dom.hostname}`}>
                    Re-check
                  </button>
                  {!dom.usedBy && (
                    <button className="btn ghost danger" disabled={busy} onClick={() => void run(() => api.forgetDomain(dom.hostname))} aria-label={`Forget ${dom.hostname}`}>
                      Forget
                    </button>
                  )}
                </span>
              </div>
              <p className="muted small">
                {dom.dns.addresses.length ? `Resolves to ${dom.dns.addresses.join(', ')}` : 'No address yet'}
                {dom.dns.checkedAt ? ` · checked ${new Date(dom.dns.checkedAt).toLocaleTimeString()}` : ''}
                {dom.dns.note ? ` · ${dom.dns.note}` : ''}
              </p>
            </li>
          ))}
          {d && d.items.length === 0 && <li className="muted small">No domains yet. Add the first one above.</li>}
        </ul>
      </section>
      <section className="card" aria-labelledby="pubapp-h">
        <h2 id="pubapp-h">
          <span className="step">3</span> Publish the app
        </h2>
        <p className="muted small">
          Once a domain says <em>Points here</em>, open <a href="#/publishing">Publishing</a>, pick the app, choose <em>Public</em> and select the domain. Apps without their own login get a generated password in front of them unless you opt out. The address shows as <em>pending</em> for a minute while the certificate is issued, then <em>active</em>.
        </p>
      </section>
    </>
  );
}

function StatusRow({ tool }: { tool: PlatformToolDto | undefined }) {
  if (!tool) return null;
  const tone = tool.installationState === 'installed' ? (tool.availability === 'reachable' ? 'ok' : 'warn') : tool.installationState === 'setup_required' ? 'warn' : 'muted';
  const label = tool.installationState === 'installed' ? 'Connected' : tool.installationState === 'setup_required' ? 'Needs one more step' : tool.installationState === 'not_installed' ? 'Not installed' : 'Unknown';
  return (
    <p className="row wrap status-row">
      <Pill tone={tone}>
        <span className="dot" aria-hidden="true" />
        {label}
      </Pill>
      {tool.note && <span className="muted small">{tool.note}</span>}
    </p>
  );
}

function Storage() {
  const [s, setS] = useState<HostStorageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const load = () => api.hostStorage().then(setS, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <section className="card" aria-labelledby="disks-h">
        <h2 id="disks-h">Disks</h2>
        <p className="muted small">Where your apps can keep big data. When you install an app such as Immich or Jellyfin, you can point it at a folder on any of these.</p>
        {error && <p className="error">{error}</p>}
        <ul className="plain disks">
          {s?.mounts.map((m) => {
            const pct = m.totalBytes && m.usedBytes !== null ? Math.round((m.usedBytes / m.totalBytes) * 100) : null;
            return (
              <li key={m.mountpoint} className="disk">
                <div className="row between wrap">
                  <strong>{m.label}</strong>
                  <span className="muted small">
                    {m.mountpoint} · {m.fsType}
                    {m.writable ? '' : ' · Harbor cannot create folders here'}
                  </span>
                </div>
                {pct !== null && (
                  <>
                    <div className="bar" aria-hidden="true">
                      <span className={pct > 90 ? 'hot' : pct > 75 ? 'warm' : ''} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="muted small">
                      {fmtBytes(m.totalBytes! - m.usedBytes!)} free of {fmtBytes(m.totalBytes!)}
                    </span>
                  </>
                )}
              </li>
            );
          })}
          {s && s.mounts.length === 0 && <li className="muted small">No disks detected (this happens on non-Linux development hosts).</li>}
        </ul>
      </section>
      <section className="card" aria-labelledby="df-h">
        <h2 id="df-h">Harbor data folder</h2>
        {s && (
          <p>
            <code className="path">{s.dataFolder.path}</code>{' '}
            {s.dataFolder.exists ? (s.dataFolder.writable ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">exists, Harbor cannot write</Pill>) : <Pill tone="muted">created on first use</Pill>}
          </p>
        )}
        <p className="muted small">The one place where Harbor itself may create folders for you (for example "Photos" for Immich). Folders elsewhere must already exist; Harbor never deletes any folder.</p>
        <button className="btn" onClick={() => setBrowsing(true)}>
          Browse and create folders…
        </button>
        {browsing && <FolderPicker title="Folders" hint="Browse your disks. Create folders inside the Harbor data folder or anywhere the harbor account may write." onClose={() => setBrowsing(false)} onPick={() => setBrowsing(false)} />}
      </section>
      <section className="card" aria-labelledby="inuse-h">
        <h2 id="inuse-h">Folders used by apps</h2>
        {s && s.inUse.length === 0 && <p className="muted small">No app uses a folder of yours yet; they all keep data in managed volumes.</p>}
        <ul className="plain">
          {s?.inUse.map((f) => (
            <li key={`${f.instanceId}-${f.path}`} className="row between wrap">
              <span>
                <code className="path">{f.path}</code> <span className="muted small">{f.readOnly ? 'read-only' : 'read-write'}</span>
              </span>
              <span className="muted small">
                {f.instanceName} · {f.purpose}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Appearance({ c }: { c: Console }) {
  const [theme, setTheme] = useState<Theme>(readTheme());
  return (
    <>
      <section className="card" aria-labelledby="theme-h">
        <h2 id="theme-h">Theme</h2>
        <div role="radiogroup" aria-label="Theme" className="seg">
          {(['system', 'dark', 'light'] as Theme[]).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={`seg-btn ${theme === t ? 'active' : ''}`} onClick={() => (applyTheme(t), setTheme(t))}>
              {t === 'system' ? 'Match device' : t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </section>
      <WallpaperPicker c={c} />
      <Rotation c={c} />
      <OwnPicture c={c} />
    </>
  );
}

const PRESET_NAMES: Record<Wallpaper, string> = { harbor: 'Harbor', dusk: 'Dusk', forest: 'Forest', plain: 'Plain', photo: 'Picture' };
function WallpaperPicker({ c, compact = false, onMore }: { c: Console; compact?: boolean; onMore?: () => void }) {
  const [wallpaper, setWallpaper] = useState<Wallpaper>(readWallpaper());
  const wp = c.data.appearance?.wallpaper;
  const hasPicture = Boolean(wp && wp.kind !== 'none');
  const active = hasPicture && !hasExplicitWallpaper() ? 'photo' : wallpaper;
  const choose = (w: Wallpaper) => {
    applyWallpaper(w);
    setWallpaper(w);
  };
  return (
    <section className="card" aria-labelledby="wp-h">
      <div className="row between wrap">
        <div>
          <h2 id="wp-h">Wallpaper</h2>
          <p className="muted small">{hasPicture ? (wp!.kind === 'rotating' ? `Picture rotates from ${wp!.current?.sourceName ?? 'the internet'}.` : 'Your uploaded picture.') : 'Presets, your own picture, or a new picture every day.'}</p>
        </div>
        {compact && (
          <button className="btn ghost" onClick={onMore}>
            More options →
          </button>
        )}
      </div>
      <ul className="wallpapers" role="listbox" aria-label="Wallpaper">
        {WALLPAPERS.filter((w) => w !== 'photo' || hasPicture).map((w) => (
          <li key={w}>
            <button role="option" aria-selected={active === w} className={`swatch wp-${w} ${active === w ? 'active' : ''}`} onClick={() => choose(w)} aria-label={`Wallpaper ${PRESET_NAMES[w]}`}>
              <span className="swatch-name">{w === 'photo' ? (wp?.kind === 'rotating' ? 'Rotating' : 'My picture') : PRESET_NAMES[w]}</span>
            </button>
          </li>
        ))}
      </ul>
      {compact && !hasPicture && <p className="muted small">Want a fresh photo every day? Turn on rotating wallpapers under More options.</p>}
    </section>
  );
}

const SOURCE_LABEL: Record<WallpaperSource, string> = { bing: 'Bing picture of the day', wikimedia: 'Wikimedia Commons picture of the day', reddit: 'Reddit (your favourite subreddits)' };
function Rotation({ c }: { c: Console }) {
  const a = c.data.appearance;
  const r = a?.rotation;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [subs, setSubs] = useState<string | null>(null);
  const [every, setEvery] = useState<number | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [optimistic, setOptimistic] = useState<boolean | null>(null); // the switch flips at once; the daemon confirms
  const [optSource, setOptSource] = useState<WallpaperSource | null>(null);
  const apply = async (fn: () => Promise<AppearanceDto>) => {
    setBusy(true);
    setMsg(null);
    try {
      const next = await fn();
      c.patchData((d) => ({ ...d, appearance: next }));
      syncWallpaperPicture({ present: next.wallpaper.kind !== 'none', version: next.wallpaper.version });
      if (next.rotation.lastError) setMsg(next.rotation.lastError);
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}${e.nextAction ? `. ${e.nextAction}` : ''}` : String(e));
    } finally {
      setBusy(false);
      setOptimistic(null);
      setOptSource(null);
    }
  };
  if (!r) return null;
  const subsValue = subs ?? r.subreddits.join(', ');
  const everyValue = every ?? r.everyHours;
  return (
    <section className="card" aria-labelledby="rot-h">
      <div className="row between wrap">
        <div>
          <h2 id="rot-h">Rotating wallpapers</h2>
          <p className="muted small">Harbor fetches a new picture for everyone who uses this Harbor. Your browser never contacts the source.</p>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={optimistic ?? r.enabled}
            disabled={busy}
            onChange={(e) => {
              setOptimistic(e.target.checked);
              void apply(() => api.setRotation({ enabled: e.target.checked }));
            }}
            aria-label="Rotating wallpapers"
          />
          <span className="switch-track" aria-hidden="true" />
          <span>{(optimistic ?? r.enabled) ? (busy ? 'Fetching a picture…' : 'On') : 'Off'}</span>
        </label>
      </div>
      <div className="stack rotation-body">
        <div role="radiogroup" aria-label="Picture source" className="sources">
          {(['bing', 'wikimedia', 'reddit'] as WallpaperSource[]).map((src) => (
            <label key={src} className={`source ${(optSource ?? r.source) === src ? 'active' : ''}`}>
              <input
                type="radio"
                name="wp-source"
                value={src}
                checked={(optSource ?? r.source) === src}
                disabled={busy}
                onChange={() => {
                  setOptSource(src);
                  void apply(() => api.setRotation({ source: src, ...(src === 'reddit' && !r.reddit.hasSecret ? { enabled: false } : {}) }));
                }}
              />
              <span>
                <span className="source-name">{SOURCE_LABEL[src]}</span>
                <span className="muted small">{src === 'bing' ? 'Beautiful landscapes, no account needed.' : src === 'wikimedia' ? 'Openly licensed photos, no account needed.' : 'Needs a free Reddit app key (below).'}</span>
              </span>
            </label>
          ))}
        </div>
        {r.source === 'reddit' && (
          <div className="stack reddit-box">
            <label>
              Subreddits
              <input value={subsValue} onChange={(e) => setSubs(e.target.value)} onBlur={() => subs !== null && subs !== r.subreddits.join(', ') && void apply(() => api.setRotation({ subreddits: subs.split(',') }))} placeholder="EarthPorn, wallpapers, SpacePorn" aria-label="Subreddits" />
            </label>
            <details open={!r.reddit.hasSecret}>
              <summary className="small">
                Reddit app key {r.reddit.hasSecret ? <Pill tone="ok">saved</Pill> : <Pill tone="warn">needed</Pill>}
              </summary>
              <ol className="steps">
                <li>
                  Open{' '}
                  <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener noreferrer">
                    reddit.com/prefs/apps
                  </a>{' '}
                  and click <em>create another app…</em>
                </li>
                <li>
                  Choose <em>script</em>, any name, and <code>http://localhost</code> as the redirect URI. Create it.
                </li>
                <li>Copy the short id under the app name and the <em>secret</em> into the fields below.</li>
              </ol>
              <div className="row wrap">
                <input value={clientId || r.reddit.clientId || ''} onChange={(e) => setClientId(e.target.value)} placeholder="client id" aria-label="Reddit client id" autoComplete="off" />
                <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={r.reddit.hasSecret ? 'secret (saved)' : 'secret'} aria-label="Reddit secret" autoComplete="off" />
                <button className="btn primary" disabled={busy || !(clientId || r.reddit.clientId) || (!secret && !r.reddit.hasSecret)} onClick={() => void apply(() => api.setRotation({ reddit: { clientId: clientId || r.reddit.clientId!, ...(secret ? { clientSecret: secret } : {}) }, enabled: true }).then((x) => (setSecret(''), x)))}>
                  Save and use Reddit
                </button>
              </div>
              <p className="muted small">Reddit stopped answering anonymous requests in 2026, so this key is required. It stays on this machine and is only used to read public posts. Adult-tagged posts are never used.</p>
            </details>
          </div>
        )}
        <div className="row wrap">
          <label className="small row">
            Change every
            <select value={everyValue} onChange={(e) => (setEvery(Number(e.target.value)), void apply(() => api.setRotation({ everyHours: Number(e.target.value) })))} aria-label="Change every" disabled={busy}>
              <option value={1}>hour</option>
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>day</option>
              <option value={168}>week</option>
            </select>
          </label>
          {r.enabled && (
            <button className="btn" disabled={busy} onClick={() => void apply(() => api.nextWallpaper())}>
              Next picture
            </button>
          )}
        </div>
        {a?.wallpaper.kind === 'rotating' && a.wallpaper.current && (
          <p className="small" role="status">
            Now showing <strong>{a.wallpaper.current.title}</strong>
            {a.wallpaper.current.author ? ` by ${a.wallpaper.current.author}` : ''} ({a.wallpaper.current.sourceName}){r.nextAt ? ` · next change ${new Date(r.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
        )}
        {(msg || r.lastError) && (
          <p className="error small" role="alert">
            {msg ?? r.lastError}
          </p>
        )}
      </div>
    </section>
  );
}

function OwnPicture({ c }: { c: Console }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const kind = c.data.appearance?.wallpaper.kind ?? 'none';
  const upload = (f: File | undefined) => {
    setMsg(null);
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) return setMsg('The picture must be 6 MB or smaller.');
    setBusy(true);
    const r = new FileReader();
    r.onload = async () => {
      try {
        await api.setWallpaper(String(r.result));
        const next = await api.appearance();
        c.patchData((d) => ({ ...d, appearance: next }));
        syncWallpaperPicture({ present: next.wallpaper.kind !== 'none', version: next.wallpaper.version });
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
    r.readAsDataURL(f);
  };
  return (
    <section className="card" aria-labelledby="own-h">
      <h2 id="own-h">Your own picture</h2>
      <p className="muted small">PNG, JPEG or WebP up to 6 MB, stored on this machine. Shown when rotating wallpapers are off.</p>
      <div className="row wrap">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => upload(e.target.files?.[0])} aria-label="Wallpaper picture file" />
        <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
          {busy ? 'Uploading…' : kind === 'uploaded' ? 'Replace picture…' : 'Choose a picture…'}
        </button>
        {kind === 'uploaded' && (
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              void api.clearWallpaper().then(async () => {
                const next = await api.appearance();
                c.patchData((d) => ({ ...d, appearance: next }));
                syncWallpaperPicture({ present: next.wallpaper.kind !== 'none', version: next.wallpaper.version });
              })
            }
          >
            Remove picture
          </button>
        )}
      </div>
      {msg && (
        <p className="error small" role="alert">
          {msg}
        </p>
      )}
    </section>
  );
}

function Access({ c }: { c: Console }) {
  const port = c.data.system ? new URL(c.data.system.managementOrigin).port : '18000';
  const apps = c.data.instances.filter((i) => i.installState !== 'retained');
  const appPorts = [...new Set(apps.flatMap((i) => i.endpoints.map((e) => e.hostPort)))].sort((a, b) => a - b);
  const fwd = (ports: number[]) => ports.map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ');
  const consoleLine = `ssh ${fwd([Number(port)])} <user>@<this-machine>`;
  const everything = `ssh ${fwd([Number(port), ...appPorts, 9090, 9443])} <user>@<this-machine>`;
  const [showTerminal, setShowTerminal] = useState(false);
  return (
    <>
      <section className="card" aria-labelledby="term-h">
        <div className="row between wrap">
          <div>
            <h2 id="term-h">Terminal</h2>
            <p className="muted small">A shell on this machine, right here. It runs as Harbor's own service account (it can use <code>docker</code> and the <code>harbor</code> command; it cannot change the system). Closes after 30 minutes of inactivity.</p>
          </div>
          {!showTerminal && (
            <button className="btn primary" onClick={() => setShowTerminal(true)}>
              Open terminal
            </button>
          )}
        </div>
        {showTerminal && <Terminal />}
      </section>
      <section className="card" aria-labelledby="access-h">
        <h2 id="access-h">SSH port forwarding</h2>
        <p className="muted small">Without Tailscale, Harbor and its apps answer only on this machine. From another computer, forward the same port numbers over SSH and open <code>http://localhost:{port}</code>. Keep the port numbers identical on both sides: Harbor rejects other addresses.</p>
        <h4>Just the console</h4>
        <div className="cmd">
          <pre className="code wrap">{consoleLine}</pre>
          <Copy text={consoleLine} />
        </div>
        <h4>Console, every app, Cockpit and Portainer</h4>
        <div className="cmd">
          <pre className="code wrap">{everything}</pre>
          <Copy text={everything} />
        </div>
        {apps.length > 0 && (
          <ul className="plain ports">
            {apps.map((i) => (
              <li key={i.id} className="row wrap">
                <InstanceIcon inst={i} size={28} />
                <span>
                  <strong>{appLabel(i)}</strong> <span className="muted small">{i.endpoints.map((e) => `port ${e.hostPort}`).join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Replace <code>&lt;user&gt;@&lt;this-machine&gt;</code> with your SSH login. If a local port is busy on your computer, free it first.</p>
      </section>
      <section className="card" aria-labelledby="cli-h">
        <h2 id="cli-h">Command line</h2>
        <p className="muted small">Everything the console does is also a command on the machine (or in the terminal above):</p>
        <ul className="cli-list">
          {[
            ['harbor list', 'apps, state, addresses, updates'],
            ['harbor install immich --storage library=/srv/harbor/Photos', 'install with your own folder'],
            ['harbor update <app>', 'update to the newest package revision'],
            ['harbor expose <app> --via tailnet', 'publish on your tailnet'],
            ['harbor packages add my-app.zip', 'upload your own app'],
            ['harbor wallpaper set --on --source bing', 'rotating wallpapers'],
            ['harbor logs <app>', 'container logs'],
          ].map(([cmd, what]) => (
            <li key={cmd}>
              <code>{cmd}</code> <span className="muted small">{what}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">The full list: <code>harbor --help</code>, and the operator guide in the repository.</p>
      </section>
    </>
  );
}

// Troubleshoot: Harbor's own log and each app's container logs, copyable.
function Troubleshoot({ c }: { c: Console }) {
  const apps = c.data.instances.filter((i) => i.installState !== 'retained');
  const [target, setTarget] = useState<string>('harbor');
  const [lines, setLines] = useState(300);
  const [text, setText] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (target === 'harbor') {
        const r: LogsDto = await api.harborLogs(lines);
        setText(r.lines.join('\n'));
        setSource(r.source === 'journal' ? 'systemd journal' : 'daemon memory (since the last start)');
      } else {
        const r: InstanceLogsDto = await api.instanceLogs(target, lines);
        setText(r.containers.map((k) => `== ${k.service} (${k.name})\n${k.lines.join('\n') || '(no output)'}`).join('\n\n') || 'No containers recorded for this app.');
        setSource('docker logs');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [target, lines]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <section className="card" aria-labelledby="logs-h">
        <div className="row between wrap">
          <div>
            <h2 id="logs-h">Logs</h2>
            <p className="muted small">When something misbehaves, this is where it says why. Copy and share when asking for help; the lines contain no passwords.</p>
          </div>
          <div className="row wrap">
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Log source">
              <option value="harbor">Harbor itself</option>
              {apps.map((i) => (
                <option key={i.id} value={i.id}>
                  {appLabel(i)}
                </option>
              ))}
            </select>
            <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="How many lines">
              <option value={100}>last 100</option>
              <option value={300}>last 300</option>
              <option value={1000}>last 1000</option>
            </select>
            <button className="btn" onClick={() => void load()} disabled={busy}>
              {busy ? 'Loading…' : 'Refresh'}
            </button>
            <Copy text={text} />
          </div>
        </div>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <pre className="code logbox" aria-label="Log output">
          {text || (busy ? '' : '(nothing yet)')}
        </pre>
        <p className="muted small">Source: {source || '—'}</p>
      </section>
      <section className="card" aria-labelledby="engine-h">
        <h2 id="engine-h">Apps engine</h2>
        <dl className="kv">
          <dt>Docker</dt>
          <dd>{c.data.system?.docker.available ? `online · ${c.data.system.docker.version ?? ''}` : `offline${c.data.system?.docker.error ? ` · ${c.data.system.docker.error}` : ''}`}</dd>
          <dt>Containers</dt>
          <dd>{c.data.metrics ? `${c.data.metrics.docker.containersRunning} of ${c.data.metrics.docker.containersTotal} running` : '—'}</dd>
          <dt>Harbor</dt>
          <dd>
            {c.data.system?.version ?? '—'} · installation <code>{c.data.system?.installationId.slice(0, 8) ?? '—'}</code>
          </dd>
        </dl>
      </section>
    </>
  );
}

function About({ c }: { c: Console }) {
  return (
    <section className="card" aria-labelledby="about-h">
      <h2 id="about-h">About Harbor</h2>
      <dl className="kv">
        <dt>Version</dt>
        <dd>{c.data.system?.version ?? '—'}</dd>
        <dt>Profile</dt>
        <dd>{c.data.system?.profile ?? '—'}</dd>
        <dt>Installation</dt>
        <dd>
          <code>{c.data.system?.installationId ?? '—'}</code>
        </dd>
        <dt>Trust boundary</dt>
        <dd>The Harbor service account has Docker (root-equivalent) authority. The console is not a sandbox against anyone with root or Docker access on this host.</dd>
        <dt>Source</dt>
        <dd>
          <a href="https://github.com/carlosalaniz/harbor" target="_blank" rel="noopener noreferrer">
            github.com/carlosalaniz/harbor
          </a>
        </dd>
      </dl>
    </section>
  );
}
