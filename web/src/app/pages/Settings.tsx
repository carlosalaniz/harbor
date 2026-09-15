import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DomainsDto, HostStorageDto, PlatformToolDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { FolderPicker, Pill } from '../components';
import { fmtBytes } from '../format';
import type { Console } from '../store';
import { WALLPAPERS, applyTheme, applyWallpaper, applyWallpaperPhoto, readTheme, readWallpaper, type Theme, type Wallpaper } from '../theme';

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

export function Settings({ c, onLogout, initialSection, onSection }: { c: Console; onLogout: () => void; initialSection?: string; onSection?: (s: string) => void }) {
  const [section, setSectionState] = useState<Section>((SECTIONS.some((s) => s.id === initialSection) ? initialSection : 'account') as Section);
  useEffect(() => {
    if (initialSection && SECTIONS.some((s) => s.id === initialSection)) setSectionState(initialSection as Section);
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
  const names: Record<Wallpaper, string> = { harbor: 'Harbor blue', dusk: 'Dusk', forest: 'Forest', plain: 'Plain', photo: 'My picture' };
  const [hasPhoto, setHasPhoto] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void api.hasWallpaper().then(setHasPhoto);
  }, []);
  const upload = (f: File) => {
    if (f.size > 6 * 1024 * 1024) return setMsg('Pick a picture of 6 MB or less.');
    const reader = new FileReader();
    reader.onload = () => {
      api.setWallpaper(String(reader.result)).then(
        () => {
          setHasPhoto(true);
          applyWallpaperPhoto(true);
          pickWallpaper('photo');
          setMsg(null);
        },
        (e: Error) => setMsg(e.message),
      );
    };
    reader.readAsDataURL(f);
  };
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
          {WALLPAPERS.filter((w) => w !== 'photo' || hasPhoto).map((w) => (
            <li key={w}>
              <button role="radio" aria-checked={wallpaper === w} className={`swatch wp-${w} ${wallpaper === w ? 'active' : ''}`} onClick={() => pickWallpaper(w)} aria-label={names[w]}>
                <span className="swatch-name">{names[w]}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="visually-hidden" aria-label="Choose a picture" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button className="btn" onClick={() => file.current?.click()}>
            {hasPhoto ? 'Replace my picture…' : 'Use my own picture…'}
          </button>
          {hasPhoto && (
            <button
              className="btn ghost"
              onClick={() =>
                void api.clearWallpaper().then(() => {
                  setHasPhoto(false);
                  applyWallpaperPhoto(false);
                  setWallpaper(readWallpaper());
                })
              }
            >
              Remove picture
            </button>
          )}
        </div>
        <p className="muted small">PNG, JPEG or WebP up to 6 MB, stored on this machine for everyone who uses this Harbor. The preset choice is remembered in this browser. Harbor does not fetch pictures from the internet; download one you like (r/wallpapers is full of them) and pick it here.</p>
        {msg && (
          <p className="error small" role="alert">
            {msg}
          </p>
        )}
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
