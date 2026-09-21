import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CatalogItemDto, InstanceDetail, InstanceSummary } from '../../src/contracts/api';
import { ApiError, api, forgetToken, hasToken, restoreRemembered } from './api';
import { EventList, openUrl as appOpenUrl } from './app/components';
import { EyeIcon, EyeOffIcon, Mark } from './app/icons';
import { AppDrawer, CustomizeDialog, InstallWizard, PlanDialog, PublishWizard, UploadPackageDialog } from './app/dialogs';
import { Home } from './app/pages/Home';
import { Platform } from './app/pages/Platform';
import { Publishing } from './app/pages/Publishing';
import { Settings } from './app/pages/Settings';
import { Store } from './app/pages/Store';
import { useRoute, type Route } from './app/router';
import { applySurfacesOpacity, applyTheme, applyWallpaper, applyWallpaperPhoto, readSurfacesOpacity, readTheme, readWallpaper, syncWallpaperPicture } from './app/theme';
import { isMockUi } from './mock/api';
import { Palette, usePaletteShortcut } from './app/Palette';
import { SetupWizard } from './app/Setup';
import type { SetupStatusDto } from '../../src/contracts/api';
import { isFinal, useConsole } from './app/store';

type View = { kind: 'login' } | { kind: 'console' };
applyTheme(readTheme());
applyWallpaper(readWallpaper());
applySurfacesOpacity(readSurfacesOpacity());
void api.hasWallpaper().then(applyWallpaperPhoto);

export function App() {
  // Design mode renders the console straight from fixtures: no daemon, no login.
  // Preview the login screen with ?screen=login for visual review.
  if (isMockUi()) {
    try {
      const screen = new URLSearchParams(window.location.search).get('screen');
      if (screen === 'login')
        return (
          <main className="login-wrap auth-wrap">
            <AuthHero name="homelab" />
            <Login notice={null} onDone={() => undefined} />
          </main>
        );
    } catch {
      /* ignore */
    }
    return <ConsoleShell onAuthLost={() => undefined} />;
  }
  // A remembered browser resumes silently: the stored token is restored into memory
  // and the first poll decides (valid → console, expired/revoked → login).
  const [view, setView] = useState<View>(() => (hasToken() || restoreRemembered() ? { kind: 'console' } : { kind: 'login' }));
  const [notice, setNotice] = useState<string | null>(null);
  // first run: no administrator yet → the setup wizard instead of the login form
  const [setup, setSetup] = useState<SetupStatusDto | null | undefined>(undefined);
  useEffect(() => {
    if (view.kind !== 'login') return;
    api.setupStatus().then((s) => setSetup(s.needed ? s : null), () => setSetup(null));
  }, [view.kind]);
  const onAuthLost = useCallback((msg?: string) => {
    forgetToken();
    // an explicit message (e.g. "Logged out.") must not be replaced by a racing poll's generic one
    setNotice((prev) => msg ?? prev ?? 'Your session ended. Log in again to continue; running operations keep going on the server.');
    setView({ kind: 'login' });
  }, []);
  if (view.kind === 'login' && setup) {
    return <SetupWizard status={setup} onDone={() => (setSetup(null), setView({ kind: 'console' }))} />;
  }
  if (view.kind === 'login') {
    return (
      <main className="login-wrap auth-wrap">
        <AuthHero />
        <Login
          notice={notice}
          onDone={() => {
            setNotice(null);
            setView({ kind: 'console' });
          }}
        />
      </main>
    );
  }
  return <ConsoleShell onAuthLost={onAuthLost} />;
}

// Umbrel-style auth hero: the Harbor mark, a lowercase greeting, one quiet line.
// The device name comes from the daemon when known (mock preview uses "homelab").
function AuthHero({ name, sub }: { name?: string | null; sub?: string }) {
  const [device, setDevice] = useState<string | null>(name ?? null);
  useEffect(() => {
    if (name !== undefined) return;
    api
      .system()
      .then((s) => setDevice(s.deviceName ?? s.hostname ?? null))
      .catch(() => setDevice(null));
  }, [name]);
  const label = device?.trim() ? device.trim() : 'your Harbor';
  return (
    <div className="auth-hero">
      <span className="auth-mark" aria-hidden="true">
        <Mark size={88} />
      </span>
      <h1 className="auth-title">welcome back</h1>
      <p className="auth-sub">{sub ?? `Enter the password to log in to ${label}`}</p>
    </div>
  );
}

function Login({ onDone, notice }: { onDone: () => void; notice: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  // Checked by default: a reload resumes silently (30-day session) and the
  // explicit Log out button in Settings → Account is the manual lock.
  // Untick for an ephemeral session that ends with the tab / after 12 h.
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password, needCode ? code.replace(/\s/g, '') : undefined, remember);
      setPassword('');
      setCode('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') setNeedCode(true);
      else setError(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : 'Cannot reach the Harbor daemon.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="auth-card" aria-labelledby="login-h">
      <h2 id="login-h" className="visually-hidden">
        Log in
      </h2>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <form onSubmit={submit}>
        {!needCode && (
          <div className="auth-field">
            <label className="visually-hidden" htmlFor="login-username">
              Username
            </label>
            <input
              id="login-username"
              className="auth-input"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              required
              autoFocus
            />
          </div>
        )}
        {needCode ? (
          <label className="visually-hidden" htmlFor="login-code">
            Two-factor code
          </label>
        ) : null}
        {needCode ? (
          <input
            id="login-code"
            className="auth-input"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            required
            autoFocus
          />
        ) : (
          <div className="auth-field">
            <label className="visually-hidden" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className="auth-input"
              name="password"
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />
            <button
              className="auth-eye"
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
            >
              {show ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        )}
        {error && (
          <p className="error auth-error" role="alert">
            {error}
          </p>
        )}
        <label className="auth-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Stay logged in on this browser for 30 days
        </label>
        <button className="btn primary auth-submit" type="submit" disabled={busy || (!needCode && (!username || !password)) || (needCode && !code)}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </section>
  );
}

const NAV: { route: Route; label: string; icon: (active: boolean) => ReactNode }[] = [
  {
    route: { page: 'home' },
    label: 'Home',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 10.5 10 4l6.5 6.5" />
        <path d="M5.5 9.5V16h9V9.5" />
      </svg>
    ),
  },
  {
    route: { page: 'store' },
    label: 'App Store',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.5" />
        <rect x="11" y="3.5" width="5.5" height="5.5" rx="1.5" />
        <rect x="3.5" y="11" width="5.5" height="5.5" rx="1.5" />
        <rect x="11" y="11" width="5.5" height="5.5" rx="1.5" />
      </svg>
    ),
  },
  {
    route: { page: 'publishing' },
    label: 'Publishing',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="6.5" />
        <path d="M3.5 10h13M10 3.5c-4.5 4.2-4.5 8.8 0 13 4.5-4.2 4.5-8.8 0-13Z" />
      </svg>
    ),
  },
  {
    route: { page: 'platform' },
    label: 'Platform',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="2.6" />
        <path d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M5 5l1.7 1.7M13.3 13.3 15 15M15 5l-1.7 1.7M6.7 13.3 5 15" />
      </svg>
    ),
  },
  {
    route: { page: 'settings' },
    label: 'Settings',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6.5h12M4 10h12M4 13.5h12" />
        <circle cx="8" cy="6.5" r="1.8" fill="var(--bg-2)" />
        <circle cx="13" cy="10" r="1.8" fill="var(--bg-2)" />
        <circle cx="7" cy="13.5" r="1.8" fill="var(--bg-2)" />
      </svg>
    ),
  },
];

function ConsoleShell({ onAuthLost }: { onAuthLost: (msg?: string) => void }) {
  const c = useConsole(onAuthLost);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [route, go] = useRoute();
  const [storeItem, setStoreItem] = useState<CatalogItemDto | null>(null);
  const [drawer, setDrawer] = useState<InstanceSummary | null>(null);
  const [publishing, setPublishing] = useState<InstanceSummary | null>(null);
  const [palette, setPalette] = useState(false);
  const [customizing, setCustomizing] = useState<InstanceSummary | null>(null);
  const [uploading, setUploading] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  usePaletteShortcut(openPalette);

  // the browser tab carries the machine's name
  useEffect(() => {
    document.title = c.data.system?.deviceName ? `${c.data.system.deviceName} · Harbor` : 'Harbor';
  }, [c.data.system?.deviceName]);

  // The wallpaper picture follows the daemon (uploaded or rotating); the version busts the cache when it changes.
  const wp = c.data.appearance?.wallpaper;
  useEffect(() => {
    if (wp) syncWallpaperPicture({ present: wp.kind !== 'none', version: wp.version });
  }, [wp?.kind, wp?.version]);

  // Deep links: #/store/<id> opens the app page; #/app/<id> opens the drawer.
  useEffect(() => {
    if (route.page === 'store' && route.packageId) {
      const item = c.data.catalog.find((i) => i.id === route.packageId);
      if (item) setStoreItem(item);
    }
    if (route.page === 'app') {
      const inst = c.data.instances.find((i) => i.id === route.instanceId);
      if (inst) setDrawer(inst);
    }
  }, [route, c.data.catalog, c.data.instances]);

  // Keep the drawer's instance fresh while polling.
  const liveDrawer = drawer ? (c.data.instances.find((i) => i.id === drawer.id) ?? drawer) : null;
  const livePublishing = publishing ? (c.data.instances.find((i) => i.id === publishing.id) ?? publishing) : null;

  const page = route.page === 'app' ? 'home' : route.page;
  const mock = isMockUi();
  return (
    <div className="shell">
      {mock && (
        <p className="mock-banner" role="status">
          Design mode — fixtures only, nothing runs. <a href="#/store">Store</a> · <a href="#/settings/appearance">Appearance</a> · <a href="#/settings">Settings</a>
        </p>
      )}
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Mark size={20} />
          </span>
          <span className="brand-name">Harbor</span>
        </div>
        <button className="btn ghost search-btn" onClick={openPalette} aria-label="Search (Cmd+K)" title="Search apps, store and settings (⌘K)">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
            <circle cx="9" cy="9" r="5.5" />
            <path d="m13.5 13.5 3 3" />
          </svg>
          <span>Search</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
        <ul>
          {NAV.map((n) => {
            const active = page === n.route.page;
            return (
              <li key={n.route.page}>
                <a href={`#/${n.route.page}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                  <span className="nav-icon" aria-hidden="true">
                    {n.icon(active)}
                  </span>
                  <span>{n.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
        <NotificationBell c={c} onOpenApp={(id) => setDrawer(c.data.instances.find((i) => i.id === id) ?? null)} />
        <div className="side-foot">
          <span className="muted small">{c.data.system ? `Harbor ${c.data.system.version}` : ''}</span>
        </div>
      </nav>
      <main className="content">
        {c.loadError && (
          <p className="error banner" role="alert">
            Cannot load: {c.loadError}
          </p>
        )}
        {noticeError && (
          <p className="error banner" role="alert">
            {noticeError}{' '}
            <button className="btn ghost icon" onClick={() => setNoticeError(null)} aria-label="Dismiss">
              ×
            </button>
          </p>
        )}
        {page === 'home' && <Home c={c} onOpenApp={setDrawer} onGoStore={() => go({ page: 'store' })} onPick={setStoreItem} />}
        {page === 'store' && <Store c={c} onOpen={setStoreItem} onInstall={(item) => setStoreItem(item)} onUpload={() => setUploading(true)} />}
        {page === 'publishing' && <Publishing c={c} onPublish={setPublishing} />}
        {page === 'platform' && <Platform c={c} />}
        {page === 'settings' && <Settings c={c} initialSection={route.page === 'settings' ? route.section : undefined} onSection={(s) => go(s === 'overview' ? { page: 'settings' } : { page: 'settings', section: s })} />}
      </main>

      {uploading && (
        <UploadPackageDialog
          onClose={() => setUploading(false)}
          onDone={() => {
            void c.refresh();
          }}
        />
      )}
      {storeItem && !c.pending && (
        <InstallWizard
          item={storeItem}
          busy={c.busy}
          installed={c.data.instances.filter((i) => i.packageId === storeItem.id).length}
          onRemovePackage={() => {
            void api.removePackage(storeItem.id).then(
              () => {
                setStoreItem(null);
                void c.refresh();
              },
              (e: Error) => setNoticeError(e.message),
            );
          }}
          onClose={() => {
            setStoreItem(null);
            if (route.page === 'store' && route.packageId) go({ page: 'store' });
          }}
          onStart={(a) => {
            setStoreItem(null);
            void c.start(a);
          }}
        />
      )}
      {liveDrawer && !c.pending && !publishing && (
        <AppDrawer
          inst={liveDrawer}
          exposures={c.data.exposures.filter((e) => e.instanceId === liveDrawer.id)}
          busy={c.busy}
          onClose={() => {
            setDrawer(null);
            if (route.page === 'app') go({ page: 'home' });
          }}
          onAction={(a) => {
            setDrawer(null);
            void c.start(a);
          }}
          onPublish={() => setPublishing(liveDrawer)}
          onCustomize={() => setCustomizing(liveDrawer)}
        />
      )}
      {customizing && (
        <CustomizeDialog
          inst={c.data.instances.find((i) => i.id === customizing.id) ?? customizing}
          onClose={() => setCustomizing(null)}
          onSaved={(updated) => {
            c.patchData((d) => ({ ...d, instances: d.instances.map((i) => (i.id === updated.id ? updated : i)) }));
            void c.refresh();
          }}
        />
      )}
      {livePublishing && !c.pending && (
        <PublishWizard
          inst={livePublishing}
          exposures={c.data.exposures.filter((e) => e.instanceId === livePublishing.id)}
          tools={c.data.tools}
          onClose={() => setPublishing(null)}
          onStart={(a) => {
            setPublishing(null);
            setDrawer(null);
            void c.start(a);
          }}
        />
      )}
      {palette && (
        <Palette
          c={c}
          go={(r) => go(r)}
          onOpenApp={(i) => setDrawer(i)}
          onAbout={(item) => {
            go({ page: 'store' });
            setStoreItem(item);
          }}
          onClose={() => setPalette(false)}
        />
      )}
      <PlanDialog c={c} />
      <Tray c={c} />
    </div>
  );
}

// Bell + panel: history of conditions and events (the Home attention list shows live state).
function NotificationBell({ c, onOpenApp }: { c: ReturnType<typeof useConsole>; onOpenApp: (instanceId: string) => void }) {
  const [open, setOpen] = useState(false);
  const n = c.data.notifications;
  const unread = n?.unread ?? 0;
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const markRead = (id: string) => api.markNotificationRead(id).then((res) => c.patchData((d) => ({ ...d, notifications: res }))).catch(() => {});
  const markAll = () => api.markAllNotificationsRead().then((res) => c.patchData((d) => ({ ...d, notifications: res }))).catch(() => {});
  return (
    <div className="bell-wrap bell-bottom" ref={panelRef}>
      <button className="btn ghost bell-btn" onClick={() => setOpen((v) => !v)} aria-label={unread ? `Notifications: ${unread} unread` : 'Notifications'} aria-expanded={open} title="Notifications">
        <span className="nav-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={open || unread > 0 ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 3.5c-3 0-4.8 2-4.8 5v2.6L3.8 13h12.4l-1.4-1.9V8.5c0-3-1.8-5-4.8-5Z" />
            <path d="M8.3 15.5c.3 1 1 1.5 1.7 1.5s1.4-.5 1.7-1.5" />
          </svg>
        </span>
        <span>Notifications</span>
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel card" role="dialog" aria-label="Notifications">
          <div className="row between">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="btn ghost small" onClick={() => void markAll()}>
                Mark all read
              </button>
            )}
          </div>
          {(!n || n.items.length === 0) && <p className="muted small">Nothing yet. Updates, warnings and failures appear here.</p>}
          <ul className="plain bell-list">
            {n?.items.slice(0, 30).map((item) => (
              <li key={item.id} className={item.read ? 'read' : 'unread'}>
                <button
                  className="bell-item"
                  onClick={() => {
                    if (!item.read) void markRead(item.id);
                    if (item.instanceId) {
                      onOpenApp(item.instanceId);
                      setOpen(false);
                    }
                  }}
                >
                  <span className={`dot tone-${item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : 'ok'}`} aria-hidden="true" />
                  <span className="bell-text">
                    <strong>{item.title}</strong>
                    <span className="muted small">{item.body}</span>
                    <span className="muted small">{new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const DOING: Record<string, string> = { install: 'Installing', start: 'Starting', stop: 'Stopping', remove: 'Removing', reinstall: 'Reinstalling', purge: 'Uninstalling', update: 'Updating', expose: 'Publishing', unexpose: 'Withdrawing the address of', reconfigure: 'Switching the address of' };
const DONE: Record<string, string> = { install: 'is ready', start: 'is running again', stop: 'is stopped', remove: 'was removed (data kept)', reinstall: 'is back', purge: 'was uninstalled completely', update: 'is up to date', expose: 'is published', unexpose: 'address withdrawn', reconfigure: 'address switched' };
const PHASE: Record<string, string> = { rollback: 'putting the previous version back', purging: 'deleting its data', queued: 'waiting for its turn', preparing: 'preparing', pulling: 'downloading the app', starting: 'starting containers', checking: 'waiting until it answers', stopping: 'stopping', removing: 'cleaning up', reconfiguring: 'applying the new address', verifying: 'checking the result', exposing: 'setting up the address', unexposing: 'removing the address' };

// Bottom-right operation tray: progress while running, one-shot result (with credentials) when done.
function Tray({ c }: { c: ReturnType<typeof useConsole> }) {
  const op = c.watching ?? c.lastDone;
  const inst = op ? c.data.instances.find((i) => i.id === op.instanceId) : undefined;
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const finishedInstall = Boolean(op && op.state === 'succeeded' && (op.kind === 'install' || op.kind === 'reinstall'));
  useEffect(() => {
    if (!op || !finishedInstall) {
      setDetail(null);
      return;
    }
    api.instance(op.instanceId).then(setDetail, () => setDetail(null));
  }, [op?.id, op?.state, finishedInstall]);
  if (!op) return null;
  const final = isFinal(op);
  const creds = op.result?.['credentials'] as { username: string; password: string } | undefined;
  const who = inst ? (inst.displayName ?? (inst.name === inst.packageId ? inst.packageName : `${inst.packageName} (${inst.name})`)) : 'the app';
  const title =
    op.state === 'succeeded'
      ? op.kind === 'unexpose' || op.kind === 'reconfigure'
        ? `${who}: ${DONE[op.kind]}`
        : `${who} ${DONE[op.kind] ?? 'done'}`
      : op.state === 'failed'
        ? `${DOING[op.kind] ?? op.kind} ${who} failed`
        : op.state === 'needs_action'
          ? `${who} needs your attention`
          : `${DOING[op.kind] ?? op.kind} ${who}…`;
  const openUrl = inst ? appOpenUrl(inst) : null;
  return (
    <aside className={`tray ${op.state}`} aria-live="polite" aria-labelledby="tray-h">
      <div className="row between">
        <h2 id="tray-h">{title}</h2>
        {final && (
          <button className="btn ghost icon" onClick={c.dismiss} aria-label="Dismiss">
            ×
          </button>
        )}
      </div>
      {!final && (
        <>
          <p className="muted small">{PHASE[op.phase] ?? op.phase}</p>
          <progress aria-label="operation progress" />
        </>
      )}
      {finishedInstall && inst && (
        <div className="next-step">
          {openUrl && (
            <a className="btn primary" href={openUrl} target="_blank" rel="noopener noreferrer" aria-label={`Launch ${inst.name}`}>
              Open {inst.packageName}
            </a>
          )}
          {detail?.setup ? (
            <p className="small">
              <strong>Next step:</strong> {detail.setup.instructions}
            </p>
          ) : (
            <p className="small muted">No account needed. It is yours to use.</p>
          )}
        </div>
      )}
      {op.state === 'succeeded' && Boolean(op.result?.['url']) && (
        <p>
          Published at{' '}
          <a href={String(op.result?.['url'])} target="_blank" rel="noopener noreferrer">
            {String(op.result?.['url'])}
          </a>{' '}
          ({String(op.result?.['exposureState'])})
        </p>
      )}
      {creds && (
        <p className="warn">
          Basic-auth credentials, shown once (kept as an instance secret): <code>{creds.username}</code> / <code>{creds.password}</code>
        </p>
      )}
      {op.error && (
        <p className="error">
          {op.error.code}: {op.error.message}
          <br />
          <span className="muted">Next: {op.error.nextAction}</span>
        </p>
      )}
      <details open={!final && false}>
        <summary className="muted small">Technical steps</summary>
        <EventList events={op.events} />
      </details>
    </aside>
  );
}
