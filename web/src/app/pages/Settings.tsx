import { useEffect, useState, type FormEvent } from 'react';
import type { HostStorageDto, PlatformToolDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { FolderPicker, Pill } from '../components';
import { fmtBytes } from '../format';
import type { Console } from '../store';
import { WALLPAPERS, applyTheme, applyWallpaper, readTheme, readWallpaper, type Theme, type Wallpaper } from '../theme';

type Section = 'account' | 'remote' | 'public' | 'storage' | 'appearance' | 'access' | 'about';
const SECTIONS: { id: Section; label: string; glyph: string; blurb: string }[] = [
  { id: 'account', label: 'Account', glyph: '👤', blurb: 'Password and session' },
  { id: 'remote', label: 'Remote access', glyph: '🛰', blurb: 'Reach Harbor from your other devices' },
  { id: 'public', label: 'Public addresses', glyph: '🌐', blurb: 'Publishing apps on the internet' },
  { id: 'storage', label: 'Storage', glyph: '💽', blurb: 'Disks and folders your apps use' },
  { id: 'appearance', label: 'Appearance', glyph: '🎨', blurb: 'Theme and wallpaper' },
  { id: 'access', label: 'Advanced access', glyph: '🔧', blurb: 'SSH forwarding, CLI' },
  { id: 'about', label: 'About', glyph: 'ℹ️', blurb: 'Version and trust boundary' },
];

export function Settings({ c, onLogout }: { c: Console; onLogout: () => void }) {
  const [section, setSection] = useState<Section>('account');
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
        {section === 'account' && <Account onLogout={onLogout} />}
        {section === 'remote' && <RemoteAccess c={c} />}
        {section === 'public' && <PublicAddresses c={c} />}
        {section === 'storage' && <Storage />}
        {section === 'appearance' && <Appearance />}
        {section === 'access' && <Access c={c} />}
        {section === 'about' && <About c={c} />}
      </div>
    </div>
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
  const publicOnes = c.data.exposures.filter((e) => e.via === 'public');
  return (
    <section className="card" aria-labelledby="pub-h">
      <h2 id="pub-h">Public addresses</h2>
      <p className="muted small">For apps you want the whole internet to reach (a blog, a shared photo album), Harbor can put a real HTTPS address in front of an app. It needs a domain name you own pointing at this machine and ports 80 and 443 open on your router.</p>
      <StatusRow tool={px} />
      {!px || px.installationState === 'not_installed' ? (
        <div className="stack">
          <p>The public proxy is not installed. Run this once on the machine (as root):</p>
          <pre className="code">sudo /opt/harbor/bin/harbor bootstrap --yes --with-public-proxy</pre>
        </div>
      ) : (
        <p>
          {publicOnes.length === 0 ? 'No app is public right now.' : `${publicOnes.length} public address${publicOnes.length === 1 ? '' : 'es'}.`} Publish or withdraw apps from the <a href="#/publishing">Publishing</a> page.
        </p>
      )}
    </section>
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

function Appearance() {
  const [theme, setTheme] = useState<Theme>(readTheme());
  const [wallpaper, setWallpaper] = useState<Wallpaper>(readWallpaper());
  const pickTheme = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  const pickWallpaper = (w: Wallpaper) => {
    applyWallpaper(w);
    setWallpaper(w);
  };
  const names: Record<Wallpaper, string> = { harbor: 'Harbor blue', dusk: 'Dusk', forest: 'Forest', plain: 'Plain' };
  return (
    <>
      <section className="card" aria-labelledby="look-h">
        <h2 id="look-h">Theme</h2>
        <div className="row wrap chips" role="radiogroup" aria-label="Theme">
          {(['system', 'dark', 'light'] as Theme[]).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} className={`chip ${theme === t ? 'active' : ''}`} onClick={() => pickTheme(t)}>
              {t === 'system' ? 'Match my device' : t === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </section>
      <section className="card" aria-labelledby="wp-h">
        <h2 id="wp-h">Wallpaper</h2>
        <ul className="wallpapers" role="radiogroup" aria-label="Wallpaper">
          {WALLPAPERS.map((w) => (
            <li key={w}>
              <button role="radio" aria-checked={wallpaper === w} className={`swatch wp-${w} ${wallpaper === w ? 'active' : ''}`} onClick={() => pickWallpaper(w)} aria-label={names[w]}>
                <span className="swatch-name">{names[w]}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">Remembered in this browser only.</p>
      </section>
    </>
  );
}

function Access({ c }: { c: Console }) {
  const port = c.data.system ? new URL(c.data.system.managementOrigin).port : '18000';
  const appPorts = [...new Set(c.data.instances.flatMap((i) => i.endpoints.map((e) => e.hostPort)))].sort();
  const forwards = [Number(port), ...appPorts, 9090, 9443].map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ');
  return (
    <>
      <section className="card" aria-labelledby="access-h">
        <h2 id="access-h">SSH port forwarding</h2>
        <p className="muted small">Without Tailscale, Harbor and its apps answer only on this machine. From another computer, forward the same port numbers over SSH and open them locally.</p>
        <pre className="code">ssh {forwards} user@this-host</pre>
        <p className="muted small">
          If a local port is busy, pick another local port for that entry (for example <code>-L 28080:127.0.0.1:18080</code>) and open it at that local port.
        </p>
      </section>
      <section className="card" aria-labelledby="cli-h">
        <h2 id="cli-h">Command line</h2>
        <p className="muted small">Everything the console does is also a command: <code>harbor catalog</code>, <code>harbor install immich --storage library=/srv/harbor/Photos</code>, <code>harbor expose n8n --via tailnet</code>, <code>harbor storage</code>, <code>harbor account set-password</code>. See the operator guide in the repository.</p>
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
