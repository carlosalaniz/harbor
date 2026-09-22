import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Terminal } from '../Terminal';
import type { AppearanceDto, DomainsDto, FoundAppDto, HostStorageDto, InstanceLogsDto, LogsDto, NotificationChannelDto, PlatformToolDto, SecurityDto, SelfUpdateStatusDto, SessionInfoDto, StorageUsageDto, SystemHostDto, WallpaperSource } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Copy, Dialog, FolderPicker, InstanceIcon, Pill, RecoveryCard, appLabel } from '../components';
import { Mark, PencilIcon } from '../icons';
import { fmtBytes, fmtUptime } from '../format';
import type { Console } from '../store';
import { WALLPAPERS, applySurfacesOpacity, applyTheme, applyWallpaper, hasExplicitWallpaper, readSurfacesOpacity, readTheme, readWallpaper, syncWallpaperPicture, type Theme, type Wallpaper } from '../theme';

type Section = 'overview' | 'account' | 'remote' | 'public' | 'storage' | 'appearance' | 'notifications' | 'access' | 'troubleshoot' | 'about';
// One 16px stroke set for the settings rail: same weight, same box, no emoji.
const SECTION_ICON: Record<Section, ReactNode> = {
  overview: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  account: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.8 13.5c.8-2.6 2.8-3.8 5.2-3.8s4.4 1.2 5.2 3.8" />
    </svg>
  ),
  remote: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 9.5a6.5 6.5 0 0 1 11 0" />
      <path d="M4.8 11.5a3.4 3.4 0 0 1 6.4 0" />
      <circle cx="8" cy="13.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  public: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c-3.6 3.4-3.6 7.6 0 11 3.6-3.4 3.6-7.6 0-11Z" />
    </svg>
  ),
  storage: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <ellipse cx="8" cy="4.5" rx="5" ry="2" />
      <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  ),
  appearance: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" />
      <path d="M4.5 10.5c1 1.2 2.2 1.8 3.5 1.8 1 0 1.9-.3 2.7-.9" />
    </svg>
  ),
  notifications: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.8c-2.4 0-3.8 1.6-3.8 4v2.1L3 10.5h10l-1.2-1.6V6.8c0-2.4-1.4-4-3.8-4Z" />
      <path d="M6.7 12.3c.2.8.7 1.2 1.3 1.2s1.1-.4 1.3-1.2" />
    </svg>
  ),
  access: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="8" rx="1.5" />
      <path d="m5 6.5 1.5 1.5L5 9.5M8 9.5h3M4.5 13.5h7" />
    </svg>
  ),
  troubleshoot: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2.5a2 2 0 0 1 4 0v5.2l2.5 4.1a1.5 1.5 0 0 1-1.3 2.2H4.8a1.5 1.5 0 0 1-1.3-2.2L6 7.7V2.5Z" />
      <path d="M4.5 10.5h7" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.3v3.2" />
      <circle cx="8" cy="5.3" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
};
const SECTIONS: { id: Section; label: string; blurb: string }[] = [
  { id: 'overview', label: 'Overview', blurb: 'This machine at a glance' },
  { id: 'account', label: 'Account', blurb: 'Password, recovery key and sessions' },
  { id: 'remote', label: 'Remote access', blurb: 'Reach Harbor from your other devices' },
  { id: 'public', label: 'Public addresses', blurb: 'Publishing apps on the internet' },
  { id: 'storage', label: 'Storage', blurb: 'Disks and folders your apps use' },
  { id: 'appearance', label: 'Appearance', blurb: 'Theme and wallpapers' },
  { id: 'notifications', label: 'Notifications', blurb: 'Reach you when something needs attention' },
  { id: 'access', label: 'Advanced access', blurb: 'Terminal, SSH forwarding, CLI' },
  { id: 'troubleshoot', label: 'Troubleshoot', blurb: 'Harbor and app logs' },
  { id: 'about', label: 'About', blurb: 'Version and trust boundary' },
];

export function Settings({ c, initialSection, onSection }: { c: Console; initialSection?: string; onSection?: (s: string) => void }) {
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
                <span className="nav-icon" aria-hidden="true">
                  {SECTION_ICON[s.id]}
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
        {section === 'overview' && <Overview c={c} go={setSection} />}
        {section === 'account' && <Account />}
        {section === 'remote' && <RemoteAccess c={c} />}
        {section === 'public' && <PublicAddresses c={c} />}
        {section === 'storage' && <Storage />}
        {section === 'appearance' && <Appearance c={c} />}
        {section === 'notifications' && <Notifications />}
        {section === 'access' && <Access c={c} />}
        {section === 'troubleshoot' && <Troubleshoot c={c} />}
        {section === 'about' && <About c={c} />}
      </div>
    </div>
  );
}

// Harbor updating itself: newest GitHub release, one button, progress that survives the daemon's restart.
function HarborUpdate({ c }: { c: Console }) {
  const initial = c.data.system?.update ?? null;
  const [st, setSt] = useState<SelfUpdateStatusDto | null>(initial);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching) setSt(c.data.system?.update ?? null);
  }, [c.data.system, watching]);
  // while an update runs the daemon restarts: poll gently and forgive errors until it is back
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => {
      api
        .selfUpdate()
        .then((s) => {
          setSt(s);
          if (s.applying && (s.applying.state === 'succeeded' || s.applying.state === 'failed')) {
            setWatching(false);
            void c.refresh();
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [watching, c]);
  const check = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setSt(await api.selfUpdateCheck());
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setConfirm(false);
    setBusy(true);
    setMsg(null);
    try {
      setSt(await api.selfUpdateApply());
      setWatching(true);
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!st) return null;
  const running = st.applying && ['requested', 'downloading', 'installing'].includes(st.applying.state);
  return (
    <section className={`card harbor-update ${st.available ? 'attention-soft' : ''}`} aria-labelledby="hu-h">
      <div className="row between wrap">
        <div>
          <h2 id="hu-h">Harbor {st.current}</h2>
          <p className="muted small">
            {st.available && st.latest
              ? `Version ${st.latest.version} is available${st.latest.publishedAt ? ` (released ${new Date(st.latest.publishedAt).toLocaleDateString()})` : ''}.`
              : st.error
                ? `Could not check for updates: ${st.error}`
                : st.checkedAt
                  ? `Up to date · checked ${new Date(st.checkedAt).toLocaleTimeString()}`
                  : 'Not checked yet.'}
          </p>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => void check()} disabled={busy || Boolean(running)}>
            Check now
          </button>
          {st.available && !running && (
            <button className="btn primary" onClick={() => setConfirm(true)} disabled={busy} aria-label={`Update Harbor to ${st.latest?.version}`}>
              Update to {st.latest?.version}
            </button>
          )}
        </div>
      </div>
      {st.available && st.latest?.notes && (
        <details>
          <summary className="muted small">What is new in {st.latest.version}</summary>
          <pre className="code wrap notes">{st.latest.notes}</pre>
          {st.latest.url && (
            <a className="small" href={st.latest.url} target="_blank" rel="noopener noreferrer">
              Release page ↗
            </a>
          )}
        </details>
      )}
      {st.applying && (
        <p className={`small ${st.applying.state === 'failed' ? 'error' : st.applying.state === 'succeeded' ? 'notice' : ''}`} role="status">
          {running ? <progress aria-label="update progress" /> : null}
          {st.applying.state === 'succeeded' ? `Updated to ${st.applying.version}.` : st.applying.state === 'failed' ? `Update to ${st.applying.version} failed: ${st.applying.message}` : `Updating to ${st.applying.version}: ${st.applying.message}. Harbor restarts for a minute, then reconnects.`}
        </p>
      )}
      {msg && (
        <p className="error small" role="alert">
          {msg}
        </p>
      )}
      {confirm && st.latest && (
        <Dialog title={`Update Harbor to ${st.latest.version}?`} onClose={() => setConfirm(false)}>
          <p>Harbor downloads the release from GitHub, verifies its checksum, installs it and restarts. Your apps keep running; the console is unavailable for about a minute. The database is migrated automatically.</p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void apply()}>
              Update now
            </button>
          </div>
        </Dialog>
      )}
      <AutoUpdateDefault />
    </section>
  );
}

// Global default for app auto-updates (decision 78): applies to newly installed apps; per-app toggles win.
function AutoUpdateDefault() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api.updatesPolicy().then((p) => setOn(p.autoDefault), () => setOn(null));
  }, []);
  if (on === null) return null;
  return (
    <label className="row auto-upd">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          void api.setUpdatesPolicy(e.target.checked).catch(() => setOn(!e.target.checked));
        }}
        aria-label="Automatic app updates for new installs"
      />
      <span className="muted small">Turn on automatic updates for newly installed apps (each app can be changed in its drawer; failed updates roll back)</span>
    </label>
  );
}

// The Umbrel-style landing: the machine, its vitals, power, and the wallpaper picker right there.
function Overview({ c, go }: { c: Console; go: (s: Section) => void }) {
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
            <span className="device-anchor">
              <Mark size={14} />
            </span>
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
              <PencilIcon />
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
          <dd>
            {c.data.system?.version ?? '—'}
            {c.data.system?.update.available && c.data.system.update.latest ? <span className="notice"> · {c.data.system.update.latest.version} is available (below)</span> : c.data.system?.update.latest && !c.data.system.update.error ? <span className="muted"> · up to date</span> : null}
          </dd>
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
      <HarborUpdate c={c} />
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

// The Harbor recovery key: one card per installation that opens every app it
// encrypts. Shown once at setup, so Settings can only say when it was issued
// and offer to replace it. Replacing re-stamps every app Harbor can reach
// right now; an unplugged drive keeps opening with the old card, and the
// result says which ones.
function RecoveryKey() {
  const [sec, setSec] = useState<SecurityDto | null>(null);
  const [password, setPassword] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ words: string; restamped: string[]; unreachable: string[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api.security().then(setSec, () => setSec(null)), []);
  useEffect(() => void load(), [load]);
  const rotate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.rotateRecoveryKey(password);
      setPassword('');
      setAsking(false);
      setFresh({ words: r.recoveryKey, restamped: r.restamped, unreachable: r.unreachable });
      await load();
    } catch (err) {
      setMsg(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="rec-h">
      <h2 id="rec-h">Recovery key</h2>
      <p className="muted small">
        Twelve words that open every app this Harbor encrypts, on any machine, even if this one is lost. Harbor showed them once when you set it up and keeps
        them only behind your password, so it cannot show them again. Replace them if the paper is lost or someone else has seen it.
      </p>
      {sec && !sec.recoveryKey && (
        <p className="muted small">
          No recovery key yet on this Harbor. The next app you install encrypted issues one and shows it once.
        </p>
      )}
      {sec?.recoveryKey && <p className="muted small">Issued {new Date(sec.recoveryKey.createdAt).toLocaleDateString()}.</p>}
      {fresh && (
        <>
          <RecoveryCard
            words={fresh.words}
            title="Your new Harbor recovery key."
            note={`It replaces the previous one${fresh.restamped.length ? ` for ${fresh.restamped.join(', ')}` : ''}.`}
            onDismiss={() => setFresh(null)}
          />
          {fresh.unreachable.length > 0 && (
            <p className="warn" role="alert">
              Still opening with the OLD key: {fresh.unreachable.join(', ')}. Harbor could not reach {fresh.unreachable.length === 1 ? 'it' : 'them'} just now.
              Plug the drive in, or unlock the app, then replace the key again. Keep the old card until then.
            </p>
          )}
        </>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      {asking ? (
        <form className="stack" onSubmit={rotate}>
          <label>
            Your Harbor password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Password to replace the recovery key" />
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !password}>
              {busy ? 'Replacing…' : 'Replace it'}
            </button>
            <button className="btn ghost" type="button" onClick={() => (setAsking(false), setPassword(''), setMsg(null))}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setAsking(true)} aria-label="Replace the recovery key">
            Replace it…
          </button>
        </div>
      )}
    </section>
  );
}

function Account() {
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
      <RecoveryKey />
      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <p className="muted small">Use at least 8 characters. Every other logged-in browser or CLI is signed out when you change it.</p>
        <form className="stack" onSubmit={submit}>
          <label>
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
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
        <h2 id="sess-h">Sessions</h2>
        <p className="muted small">Staying logged in lasts 30 days. Otherwise the session ends with the tab or after 12 hours. “Log out” locks this browser; “Log out of other sessions” keeps this one.</p>
        <SessionList />
        <div className="row wrap">
          <button className="btn" onClick={() => void api.revokeOtherSessions().then(() => location.reload())}>
            Log out of other sessions
          </button>
          <button className="btn danger" onClick={() => void api.logout().then(() => location.reload())}>
            Log out
          </button>
        </div>
      </section>
    </>
  );
}

function SessionList() {
  const [items, setItems] = useState<SessionInfoDto[] | null>(null);
  useEffect(() => {
    api.sessions().then(setItems, () => setItems(null));
  }, []);
  if (!items || items.length === 0) return null;
  return (
    <ul className="plain sessions">
      {items.map((s, i) => (
        <li key={i} className="row between wrap">
          <span>
            {s.current ? <strong>This browser</strong> : s.kind === 'remember' ? 'Remembered browser' : 'Session'}
            <span className="muted small"> · since {new Date(s.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            {s.lastSeenAt && <span className="muted small"> · last seen {new Date(s.lastSeenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
          </span>
          <span className="muted small">expires {new Date(s.expiresAt).toLocaleDateString()}</span>
        </li>
      ))}
    </ul>
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
      <div className="tfa-head">
        <h2 id="tfa-h">Two-factor login</h2>
        {sec && (
          <Pill tone={sec.twoFactor ? 'ok' : 'muted'}>
            <span className="dot" aria-hidden="true" />
            {sec.twoFactor ? 'On' : 'Off'}
          </Pill>
        )}
      </div>
      <p className="muted small">A 6-digit code from an authenticator app (1Password, Google Authenticator, Authy…) is asked at every login, on top of the password.</p>
      {sec && !sec.twoFactor && !setup && (
        <button className="btn primary tfa-cta" disabled={busy} onClick={() => void start()}>
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
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the auth key" aria-label="Tailscale auth key" />
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

// Delivery channels for the bell's notifications: ntfy, webhook, email. Secrets are write-only.
function Notifications() {
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.notificationChannels().then((r) => (setChannels(r.channels), setLoaded(true)), (e: Error) => setError(e.message));
  }, []);
  const save = async (next: NotificationChannelDto[]) => {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api.setNotificationChannels(next);
      setChannels(r.channels);
      setMsg('Saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api.testNotificationChannels();
      const failed = r.results.filter((x) => !x.ok);
      setMsg(failed.length === 0 ? `Test sent to ${r.results.length} channel${r.results.length === 1 ? '' : 's'}.` : `Failed: ${failed.map((f) => `${f.kind} (${f.error ?? 'unknown'})`).join(', ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (idx: number, patch: Partial<NotificationChannelDto>) => setChannels((cs) => cs.map((c, i) => (i === idx ? ({ ...c, ...patch } as NotificationChannelDto) : c)));
  return (
    <section className="card" aria-labelledby="notif-h">
      <h2 id="notif-h">Notification channels</h2>
      <p className="muted small">
        The bell in the sidebar always works. Channels below also reach you when you are not looking at the console: a{' '}
        <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">
          ntfy
        </a>{' '}
        topic on your phone, any webhook, or email. Severity filters keep the noise down.
      </p>
      {error && <p className="error">{error}</p>}
      {msg && (
        <p role="status" className="notice small">
          {msg}
        </p>
      )}
      {loaded &&
        channels.map((ch, idx) => (
          <div className="channel" key={idx}>
            <div className="row between wrap">
              <strong>{ch.kind === 'ntfy' ? 'ntfy push' : ch.kind === 'webhook' ? 'Webhook' : 'Email'}</strong>
              <button className="btn ghost small" disabled={busy} onClick={() => void save(channels.filter((_, i) => i !== idx))}>
                Remove
              </button>
            </div>
            {ch.kind === 'ntfy' && (
              <div className="row wrap">
                <label>
                  Server <input value={ch.server} onChange={(e) => update(idx, { server: e.target.value })} placeholder="https://ntfy.sh" />
                </label>
                <label>
                  Topic <input value={ch.topic} onChange={(e) => update(idx, { topic: e.target.value })} placeholder="my-harbor" />
                </label>
                <label>
                  Access token (optional) <input type="password" value={ch.token ?? ''} onChange={(e) => update(idx, { token: e.target.value })} />
                </label>
              </div>
            )}
            {ch.kind === 'webhook' && (
              <div className="row wrap">
                <label>
                  URL <input value={ch.url} onChange={(e) => update(idx, { url: e.target.value })} placeholder="https://…" />
                </label>
                <label>
                  Signing secret (optional) <input type="password" value={ch.secret ?? ''} onChange={(e) => update(idx, { secret: e.target.value })} />
                </label>
              </div>
            )}
            {ch.kind === 'email' && (
              <div className="row wrap">
                <label>
                  SMTP host <input value={ch.smtp.host} onChange={(e) => update(idx, { smtp: { ...ch.smtp, host: e.target.value } })} />
                </label>
                <label>
                  Port <input type="number" value={ch.smtp.port} onChange={(e) => update(idx, { smtp: { ...ch.smtp, port: Number(e.target.value) } })} />
                </label>
                <label className="row">
                  <input type="checkbox" checked={ch.smtp.secure} onChange={(e) => update(idx, { smtp: { ...ch.smtp, secure: e.target.checked } })} /> TLS from the start (465)
                </label>
                <label>
                  User (optional) <input value={ch.smtp.user ?? ''} onChange={(e) => update(idx, { smtp: { ...ch.smtp, user: e.target.value } })} />
                </label>
                <label>
                  Password <input type="password" value={ch.smtp.pass ?? ''} onChange={(e) => update(idx, { smtp: { ...ch.smtp, pass: e.target.value } })} />
                </label>
                <label>
                  From <input value={ch.from} onChange={(e) => update(idx, { from: e.target.value })} placeholder="harbor@example.org" />
                </label>
                <label>
                  To <input value={ch.to} onChange={(e) => update(idx, { to: e.target.value })} placeholder="you@example.org" />
                </label>
              </div>
            )}
            <label>
              Send{' '}
              <select value={ch.minSeverity ?? 'info'} onChange={(e) => update(idx, { minSeverity: e.target.value as 'info' | 'warning' | 'error' })}>
                <option value="info">everything</option>
                <option value="warning">warnings and failures</option>
                <option value="error">only failures</option>
              </select>
            </label>
          </div>
        ))}
      <div className="row wrap">
        <button className="btn" disabled={busy || channels.length >= 5} onClick={() => setChannels((cs) => [...cs, { kind: 'ntfy', server: 'https://ntfy.sh', topic: '' }])}>
          + ntfy
        </button>
        <button className="btn" disabled={busy || channels.length >= 5} onClick={() => setChannels((cs) => [...cs, { kind: 'webhook', url: '' }])}>
          + webhook
        </button>
        <button className="btn" disabled={busy || channels.length >= 5} onClick={() => setChannels((cs) => [...cs, { kind: 'email', smtp: { host: '', port: 587, secure: false }, from: '', to: '' }])}>
          + email
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !loaded} onClick={() => void save(channels)}>
          Save
        </button>
        <button className="btn" disabled={busy || channels.length === 0} onClick={() => void test()}>
          Send a test
        </button>
      </div>
    </section>
  );
}

function FoundApps() {
  const [apps, setApps] = useState<FoundAppDto[] | null>(null);
  const [storage, setStorage] = useState<HostStorageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [name, setName] = useState('');
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  useEffect(() => {
    api.foundApps().then(setApps, (e: Error) => setError(e.message));
    api.hostStorage().then(setStorage, () => undefined);
    // An unmounted drive hides its apps (the scan only sees mounts): poll
    // gently so a freshly mounted drive's apps appear without a reload.
    const t = setInterval(() => {
      api.foundApps().then(setApps, () => undefined);
      api.hostStorage().then(setStorage, () => undefined);
    }, 5000);
    return () => clearInterval(t);
  }, []);
  const mount = (dev: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(dev);
    api.mountDevice(dev).then(
      () => {
        let tries = 0;
        const t = setInterval(() => {
          tries += 1;
          api.deviceStatus(dev).then(
            (st) => {
              if (st.state === 'mounted' || st.state === 'failed' || tries >= 20) {
                clearInterval(t);
                setBusyDevice(null);
                if (st.state === 'failed') setError(st.message);
                api.foundApps().then(setApps, (e: Error) => setError(e.message));
                api.hostStorage().then(setStorage, () => undefined);
              }
            },
            (e: Error) => {
              clearInterval(t);
              setBusyDevice(null);
              setError(e.message);
            },
          );
        }, 1500);
      },
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  if (error) return <p className="error">{error}</p>;
  if (apps === null) return <p className="muted small">Looking for apps on your drives…</p>;
  const fresh = apps.filter((a) => !a.adopted);
  const needsFormat = (fsType: string | null): boolean => !!fsType && !['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'apfs', 'hfs'].includes(fsType.toLowerCase());
  const unmounted = (storage?.devices ?? []).filter((d) => !d.mounted || !d.mountpoint);
  if (fresh.length === 0 && unmounted.length === 0) return <p className="muted small">No apps waiting. Plug in a drive that holds an encrypted app and it appears here.</p>;
  return (
    <ul className="plain">
      {unmounted.map((d) => (
        <li key={`unmounted-${d.device}`} className="row between wrap">
          <span>
            <strong>{d.label ?? d.name}</strong> <span className="muted small">· {d.size}{d.fsType ? ` · ${d.fsType}` : ''} · {needsFormat(d.fsType) ? 'needs formatting as ext4 before it can hold apps — see Disks above' : 'plugged in but not mounted — its apps (if any) are hidden until it is mounted'}</span>
          </span>
          {!needsFormat(d.fsType) && (
          <button
            className="btn small"
            disabled={busyDevice !== null}
            onClick={() => mount(d.name)}
            aria-label={busyDevice === d.name ? `Mounting ${d.label ?? d.name}` : `Mount ${d.label ?? d.name} to see its apps`}
            aria-busy={busyDevice === d.name}
          >
            {busyDevice === d.name ? (
              <>
                <span className="spin" aria-hidden="true" /> Mounting…
              </>
            ) : (
              'Mount to see its apps'
            )}
          </button>
          )}
        </li>
      ))}
      {fresh.map((a) => (
        <li key={a.home} className="row between wrap">
          <span>
            <strong>{a.displayName}</strong> <span className="muted small">· {a.drive} · {a.home}</span>
            {a.error && <span className="error"> · {a.error}</span>}
          </span>
          {adopting === a.home ? (
            <span className="row wrap">
              <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" autoComplete="off" placeholder="App passphrase" aria-label={`Passphrase for ${a.displayName}`} />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label={`Name for adopted ${a.displayName}`} />
              <button
                className="btn small primary"
                disabled={!pass}
                onClick={() => {
                  setError(null);
                  void api
                    .adoptFoundApp(a.home, pass, name.trim() || undefined)
                    .then(() => api.foundApps().then(setApps, (e: Error) => setError(e.message)))
                    .catch((e: Error) => setError(e.message))
                    .finally(() => {
                      setAdopting(null);
                      setPass('');
                      setName('');
                    });
                }}
              >
                Adopt
              </button>
              <button className="btn small ghost" onClick={() => setAdopting(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="btn small" onClick={() => setAdopting(a.home)} aria-label={`Adopt ${a.displayName}`}>
              Adopt…
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// Format a removable drive as ext4 so it can hold encrypted apps. Two-step:
// "Format…" opens the confirm dialog (names the drive, states the wipe, asks
// for the typed drive name); the dialog's Format button runs the root oneshot.
function FormatDriveButton({ d, busy, formatting, onFormat }: { d: HostStorageDto['devices'][number]; busy: boolean; formatting: boolean; onFormat: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const name = d.label ?? d.name;
  const expected = d.name;
  return (
    <>
      <button className="btn small danger" disabled={busy} onClick={() => (setTyped(''), setConfirm(true))} aria-label={formatting ? `Formatting ${name}` : `Format ${name} as ext4`} aria-busy={formatting}>
        {formatting ? (
          <>
            <span className="spin" aria-hidden="true" /> Formatting…
          </>
        ) : (
          'Format as ext4…'
        )}
      </button>
      {confirm && (
        <Dialog title={`Format ${name} as ext4?`} onClose={() => setConfirm(false)}>
          <p>
            This <strong>erases everything</strong> on {d.device} ({d.size}
            {d.fsType ? `, currently ${d.fsType}` : ''}) and formats it as ext4 so Harbor can install encrypted apps on it. The drive is remounted at its usual place afterwards.
          </p>
          <p className="muted small">Harbor only formats removable drives — never the system disk. Formatting is refused while an app uses the drive.</p>
          <label className="small">
            <span>
              Type <code>{expected}</code> to confirm
            </span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${expected} to confirm`} autoComplete="off" />
          </label>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              disabled={typed.trim() !== expected}
              onClick={() => {
                setConfirm(false);
                onFormat();
              }}
            >
              Format (erase everything)
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function Storage() {
  const [s, setS] = useState<HostStorageDto | null>(null);
  const [usage, setUsage] = useState<StorageUsageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const load = () => api.hostStorage().then(setS, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    api.storageUsage().then(setUsage, () => setUsage(null)); // best-effort: Docker may be down
    // Physical pull feels real-time: re-read the device list every 2s so an
    // inserted or yanked drive appears/disappears without a manual reload.
    const t = setInterval(() => {
      api.hostStorage().then(setS, () => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, []);
  // A mount/unmount/format is a root oneshot that takes seconds (format: up to
  // minutes on a big drive): poll the per-device status until it settles, then
  // reload the list so the row flips by itself. The busy flag is already set
  // by mount()/unmount()/format() so the button locks instantly on click
  // (no double-submit while the POST is in flight).
  const watchDevice = (name: string) => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api.deviceStatus(name).then(
        (st) => {
          if (st.state === 'mounted' || st.state === 'unmounted' || st.state === 'failed' || tries >= 20) {
            clearInterval(t);
            setBusyDevice(null);
            if (st.state === 'failed') setError(st.message);
            void load();
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setError(e.message);
        },
      );
    }, 1500);
  };
  const watchFormat = (name: string) => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api.formatStatus(name).then(
        (st) => {
          if (st.state === 'formatted' || st.state === 'failed' || tries >= 120) {
            clearInterval(t);
            setBusyDevice(null);
            if (st.state === 'failed') setError(st.message);
            void load();
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setError(e.message);
        },
      );
    }, 2000);
  };
  const mount = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.mountDevice(name).then(
      () => watchDevice(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  const unmount = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.unmountDevice(name).then(
      () => watchDevice(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  const format = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.formatDevice(name).then(
      () => watchFormat(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  return (
    <>
      <section className="card" aria-labelledby="disks-h">
        <h2 id="disks-h">Disks</h2>
        <p className="muted small">Where your apps keep big data. Point an app at a folder on any disk when you install it.</p>
        {error && <p className="error">{error}</p>}
        {s?.storagePolicy && (
          <div className="stack" role="group" aria-label="Removable-drive behaviour">
            <label className="row">
              <input
                type="checkbox"
                checked={s.storagePolicy.autoMount}
                onChange={(e) => {
                  const next = { autoMount: e.target.checked };
                  setS((cur) => (cur ? { ...cur, storagePolicy: { ...cur.storagePolicy, ...next } } : cur));
                  void api.setStoragePolicy(next).then(
                    (p) => setS((cur) => (cur ? { ...cur, storagePolicy: p } : cur)),
                    (err: Error) => setError(err.message),
                  );
                }}
              />
              <span className="muted small">Mount drives automatically when plugged in</span>
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={s.storagePolicy.autoStart}
                onChange={(e) => {
                  const next = { autoStart: e.target.checked };
                  setS((cur) => (cur ? { ...cur, storagePolicy: { ...cur.storagePolicy, ...next } } : cur));
                  void api.setStoragePolicy(next).then(
                    (p) => setS((cur) => (cur ? { ...cur, storagePolicy: p } : cur)),
                    (err: Error) => setError(err.message),
                  );
                }}
              />
              <span className="muted small">Start apps again when their drive comes back</span>
            </label>
          </div>
        )}
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
          {s && s.mounts.length === 0 && s.devices.length === 0 && <li className="muted small">No disks detected.</li>}
          {s && s.devices.length > 0 && (
            <li className="muted small" aria-hidden="true">
              Removable
            </li>
          )}
          {s?.devices.map((d) => (
            <li key={d.device} className="disk">
              <div className="row between wrap">
                <strong>{d.label ?? d.name}</strong>
                <span className="muted small">
                  {d.mounted && d.mountpoint ? `${d.mountpoint} · ` : 'Not mounted · '}
                  {d.size}
                  {d.fsType ? ` · ${d.fsType}` : ''}
                  {d.fsType && !['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs'].includes(d.fsType.toLowerCase()) && (
                    <> · needs formatting as ext4 before it can hold apps</>
                  )}
                </span>
              </div>
              <div className="row wrap">
                {d.mounted && d.mountpoint ? (
                  <button
                    className="btn small"
                    disabled={busyDevice !== null}
                    onClick={() => unmount(d.name)}
                    aria-label={busyDevice === d.name ? `Ejecting ${d.label ?? d.name}` : `Eject ${d.label ?? d.name}`}
                    aria-busy={busyDevice === d.name}
                  >
                    {busyDevice === d.name ? (
                      <>
                        <span className="spin" aria-hidden="true" /> Ejecting…
                      </>
                    ) : (
                      'Eject'
                    )}
                  </button>
                ) : d.fsType && !['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs'].includes(d.fsType.toLowerCase()) ? (
                  // A wrong-filesystem drive can never hold an app even once
                  // mounted: Mount would only dead-end, so offer Format first.
                  <span className="muted small">This drive is {d.fsType}, which can&apos;t hold apps — format it as ext4 first.</span>
                ) : (
                  <button
                    className="btn small"
                    disabled={busyDevice !== null}
                    onClick={() => mount(d.name)}
                    aria-label={busyDevice === d.name ? `Mounting ${d.label ?? d.name}` : `Mount ${d.label ?? d.name}`}
                    aria-busy={busyDevice === d.name}
                  >
                    {busyDevice === d.name ? (
                      <>
                        <span className="spin" aria-hidden="true" /> Mounting…
                      </>
                    ) : (
                      'Mount'
                    )}
                  </button>
                )}
                <FormatDriveButton d={d} busy={busyDevice !== null} formatting={busyDevice === d.name} onFormat={() => format(d.name)} />
                {busyDevice === d.name && <span className="muted small" role="status">Working…</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="found-h">
        <h2 id="found-h">Found apps</h2>
        <FoundApps />
      </section>
      <section className="card" aria-labelledby="df-h">
        <h2 id="df-h">Harbor data folder</h2>
        {s && (
          <p>
            <code className="path">{s.dataFolder.path}</code>{' '}
            {s.dataFolder.exists ? (s.dataFolder.writable ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">exists, Harbor cannot write</Pill>) : <Pill tone="muted">created on first use</Pill>}
          </p>
        )}
        <p className="muted small">Harbor can create folders here (for example “Photos” for Immich). Elsewhere, folders must already exist. Harbor never deletes folders.</p>
        <button className="btn" onClick={() => setBrowsing(true)}>
          Browse and create folders…
        </button>
        {browsing && <FolderPicker title="Folders" hint="Browse your disks. Create folders inside the Harbor data folder or anywhere the harbor account may write." onClose={() => setBrowsing(false)} onPick={() => setBrowsing(false)} />}
      </section>
      <section className="card" aria-labelledby="appspace-h">
        <h2 id="appspace-h">Space used by apps</h2>
        {!usage && <p className="muted small">Sizes are unavailable right now (Docker may be busy or down).</p>}
        {usage && usage.apps.length === 0 && <p className="muted small">No app keeps data in managed volumes yet.</p>}
        <ul className="plain">
          {usage?.apps.map((a) => (
            <li key={a.instanceId} className="row between wrap">
              <span>{a.name}</span>
              <span className="muted small" title={a.volumes.map((v) => `${v.id}: ${fmtBytes(v.sizeBytes)}`).join(' · ')}>
                {fmtBytes(a.totalBytes)}
                {a.volumes.length > 1 ? ` in ${a.volumes.length} volumes` : ''}
              </span>
            </li>
          ))}
        </ul>
        {usage && usage.unownedBytes > 0 && <p className="muted small">Other Docker volumes not managed by Harbor use {fmtBytes(usage.unownedBytes)}.</p>}
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
  const [opacity, setOpacity] = useState<number>(readSurfacesOpacity());
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
        <h4>Readability over pictures</h4>
        <p className="muted small">When a photo wallpaper makes text hard to read, make cards and panels more solid. This stays on this browser only.</p>
        <div className="opacity-row">
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.01}
            value={opacity}
            aria-label="Surface opacity"
            onChange={(e) => {
              const v = Number(e.target.value);
              setOpacity(v);
              applySurfacesOpacity(v);
            }}
          />
          <span className="muted small" aria-live="polite">
            {opacity >= 0.995 ? 'Solid' : `${Math.round(opacity * 100)}%`}
          </span>
          {Math.abs(opacity - 0.82) > 0.001 && (
            <button
              className="btn ghost"
              onClick={() => {
                setOpacity(0.82);
                applySurfacesOpacity(0.82);
              }}
            >
              Reset
            </button>
          )}
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
