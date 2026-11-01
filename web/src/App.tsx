import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { CatalogItemDto, InstanceDetail, InstanceSummary, NotificationsDto, OperationDto } from '../../src/contracts/api';
import { ApiError, api, forgetToken, hasToken, restoreRemembered } from './api';
import { Copy, EventList, RecoveryCard, openUrl as appOpenUrl } from './app/components';
import { EyeIcon, EyeOffIcon, Mark } from './app/icons';
import { AppDrawer, CustomizeDialog, InstallWizard, PlanDialog, PublishWizard, UploadPackageDialog } from './app/dialogs';
import { Home } from './app/pages/Home';
import { Notifications } from './app/pages/Notifications';
import { NotificationActions } from './app/NotificationActions';
import { Platform } from './app/pages/Platform';
import { Publishing } from './app/pages/Publishing';
import { Settings } from './app/pages/Settings';
import { Store } from './app/pages/Store';
import { useRoute, type Route } from './app/router';
import { applySurfacesOpacity, applyTheme, applyWallpaperPhoto, bootWallpaper, readSurfacesOpacity, readTheme, syncWallpaperPicture } from './app/theme';
import { isMockUi } from './mock/api';
import { Palette, usePaletteShortcut } from './app/Palette';
import { SetupWizard } from './app/Setup';
import type { SetupStatusDto } from '../../src/contracts/api';
import { useConsole, type Console } from './app/store';
import { PHASE, VERB, hasShownOnce, isRunning, notCancellableReason, opTitle, queueSummary, whoOf } from './app/queue';

type View = { kind: 'login' } | { kind: 'console' };
applyTheme(readTheme());
bootWallpaper();
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

// The lock screen's form (decision 190): the session is still valid, so only the password, which unseals the
// machine key in place (POST /v1/account/unlock). Wrong passwords count against the login limits.
function UnlockForm({ onDone, onAuthLost }: { onDone: () => void; onAuthLost: (msg?: string) => void }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.unlockMachine(password);
      setPassword('');
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setError(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : 'Cannot reach the Harbor daemon.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="auth-card" aria-labelledby="unlock-h">
      <h2 id="unlock-h" className="visually-hidden">
        Unlock
      </h2>
      <form onSubmit={submit}>
        <div className="auth-field">
          <label className="visually-hidden" htmlFor="unlock-password">
            Password
          </label>
          <input
            id="unlock-password"
            className="auth-input"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            autoFocus
          />
          <button className="auth-eye" type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {error && (
          <p className="error auth-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary auth-submit" type="submit" disabled={busy || !password}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </section>
  );
}

const NAV: { route: Route; label: string; short: string; icon: (active: boolean) => ReactNode }[] = [
  {
    route: { page: 'home' },
    label: 'Home',
    short: 'Home',
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
    short: 'Store',
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
    short: 'Publish',
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
    short: 'Platform',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="2.6" />
        <path d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M5 5l1.7 1.7M13.3 13.3 15 15M15 5l-1.7 1.7M6.7 13.3 5 15" />
      </svg>
    ),
  },
  {
    route: { page: 'notifications' },
    label: 'Notifications',
    short: 'Alerts',
    icon: (active) => (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10 3.5c-3 0-4.8 2-4.8 5v2.6L3.8 13h12.4l-1.4-1.9V8.5c0-3-1.8-5-4.8-5Z" />
        <path d="M8.3 15.5c.3 1 1 1.5 1.7 1.5s1.4-.5 1.7-1.5" />
      </svg>
    ),
  },
  {
    route: { page: 'settings' },
    label: 'Settings',
    short: 'Settings',
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
  const [storeItem, setStoreItemRaw] = useState<CatalogItemDto | null>(null);
  // decision 170: the app page (Open once installed) or straight to the install page for another copy
  const [storeMode, setStoreMode] = useState<'page' | 'copy'>('page');
  const setStoreItem = useCallback((item: CatalogItemDto | null, mode: 'page' | 'copy' = 'page') => {
    setStoreMode(mode);
    setStoreItemRaw(item);
  }, []);
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
  // Decision 190: Harbor restarted since the last password, so encrypted apps and backups wait for it. A remembered
  // session lands on the lock screen (like a phone after a reboot) instead of a console whose apps say Locked.
  if (c.data.system?.unlockNeeded) {
    return (
      <main className="login-wrap auth-wrap">
        <AuthHero sub="Harbor restarted. Enter your password to unlock your apps." />
        <UnlockForm onDone={() => void c.refresh()} onAuthLost={onAuthLost} />
      </main>
    );
  }
  return (
    <div className="shell">
      {c.data.system?.developerMode?.enabled && (
        <p className="devmode-banner" role="status">
          <span>
            <strong>Developer mode is on.</strong> Apps you upload or add from git can ask for full control of this machine.
          </span>
          <button className="btn ghost small" onClick={() => go({ page: 'settings', section: 'access' })}>
            Turn it off…
          </button>
        </p>
      )}
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
                  <span className="nav-long">{n.label}</span>
                  <span className="nav-short" aria-hidden="true">
                    {n.short}
                  </span>
                  {n.route.page === 'notifications' && (c.data.notifications?.unread ?? 0) > 0 && (
                    <span className="badge nav-badge" aria-hidden="true">
                      {c.data.notifications!.unread > 99 ? '99+' : c.data.notifications!.unread}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
        <NotificationBell c={c} onOpenApp={(id) => setDrawer(c.data.instances.find((i) => i.id === id) ?? null)} onViewAll={() => go({ page: 'notifications' })} />
        <div className="side-foot">
          <span className="muted small">{c.data.system ? `Harbor ${c.data.system.version}` : ''}</span>
        </div>
      </nav>
      <main className={`content ${page === 'settings' ? 'settings-page' : ''}`}>
        <HttpsBanner c={c} go={go} />
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
        {page === 'store' && (
          <Store
            c={c}
            onOpen={(item) => setStoreItem(item)}
            onInstall={(item) => setStoreItem(item)}
            onAddCopy={(item) => setStoreItem(item, 'copy')}
            onManage={(i) => {
              setStoreItem(null);
              setDrawer(i);
            }}
            onUpload={() => setUploading(true)}
          />
        )}
        {page === 'publishing' && <Publishing c={c} onPublish={setPublishing} />}
        {page === 'platform' && <Platform c={c} />}
        {page === 'notifications' && <Notifications c={c} onOpenApp={(id) => setDrawer(c.data.instances.find((i) => i.id === id) ?? null)} />}
        {page === 'settings' && <Settings c={c} initialSection={route.page === 'settings' ? route.section : undefined} onSection={(s) => go(s ? { page: 'settings', section: s } : { page: 'settings' })} />}
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
          key={`${storeItem.id}:${storeMode}`}
          item={c.data.catalog.find((i) => i.id === storeItem.id) ?? storeItem}
          mode={storeMode}
          onOpenInstance={(i) => {
            setStoreItem(null);
            setDrawer(i);
          }}
          instances={c.data.instances}
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
          ops={c.queue.active.filter((o) => o.instanceId === liveDrawer.id)}
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
          onChanged={(updated) => c.patchData((d) => ({ ...d, instances: d.instances.map((i) => (i.id === updated.id ? updated : i)) }))}
          instances={c.data.instances}
          catalog={c.data.catalog}
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

// Bell + panel: a quick preview of recent conditions and events. The full list lives on the
// Notifications screen (decision 114); "View all" navigates there.
function NotificationBell({ c, onOpenApp, onViewAll }: { c: ReturnType<typeof useConsole>; onOpenApp: (instanceId: string) => void; onViewAll: () => void }) {
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
  const dismiss = (id: string) => api.dismissNotification(id).then((res) => c.patchData((d) => ({ ...d, notifications: res }))).catch(() => {});
  const dismissAll = () => api.dismissAllNotifications().then((res) => c.patchData((d) => ({ ...d, notifications: res }))).catch(() => {});
  const openItem = (item: NonNullable<NotificationsDto['items']>[number]) => {
    if (!item.read) void markRead(item.id);
    if (item.instanceId) {
      onOpenApp(item.instanceId);
      setOpen(false);
    } else if (item.link) {
      // decision 122: e.g. a drive warning opens Settings → Storage, where it is fixed
      location.hash = item.link;
      setOpen(false);
    }
  };
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
            <span className="row" style={{ gap: 4 }}>
              {unread > 0 && (
                <button className="btn ghost small" onClick={() => void markAll()}>
                  Mark all read
                </button>
              )}
              {n && n.items.length > 0 && (
                <button className="btn ghost small" onClick={() => void dismissAll()}>
                  Dismiss all
                </button>
              )}
            </span>
          </div>
          {(!n || n.items.length === 0) && <p className="muted small">Nothing yet. Updates, warnings and failures appear here.</p>}
          <ul className="plain bell-list">
            {n?.items.slice(0, 30).map((item) => (
              <li key={item.id} className={item.read ? 'read' : 'unread'}>
                <div className="bell-row">
                  <button className="bell-item" onClick={() => openItem(item)}>
                    <span className={`dot tone-${item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : 'ok'}`} aria-hidden="true" />
                    <span className="bell-text">
                      <strong>{item.title}</strong>
                      <span className="muted small">{item.body}</span>
                      <span className="muted small">{new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </span>
                  </button>
                  <button className="bell-dismiss" aria-label={`Dismiss notification: ${item.title}`} title="Dismiss" onClick={() => void dismiss(item.id)}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
                <NotificationActions c={c} item={item} onOpenApp={onOpenApp} onDone={() => setOpen(false)} />
              </li>
            ))}
          </ul>
          {n && n.items.length > 0 && (
            <button
              className="btn ghost small bell-viewall"
              onClick={() => {
                setOpen(false);
                onViewAll();
              }}
            >
              All notifications{n.items.length > 30 ? ` (${n.items.length})` : ''}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Bottom-right queue panel (decision 183): the running operation (phase, progress), the waiting ones in run order
// (each with Cancel when a person may cancel it), and the operations this console saw finish, each with its own
// result (credentials and recovery words shown once) until dismissed. Collapses to one line.
function Tray({ c }: { c: ReturnType<typeof useConsole> }) {
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const active = c.queue.active;
  const finished = c.finished;
  if (!active.length && !finished.length) return null;
  const running = active.filter(isRunning);
  const waiting = active.filter((o) => !isRunning(o));
  const who = (op: OperationDto) => whoOf(c.data.instances.find((i) => i.id === op.instanceId), op.instanceName);
  const tone = finished.some((f) => f.state === 'failed' || f.state === 'needs_action') ? 'failed' : !active.length && finished.every((f) => f.state === 'succeeded') ? 'succeeded' : '';
  const cancel = (op: OperationDto) => {
    setCancelling(op.id);
    setCancelError(null);
    void c.cancelOperation(op.id).then((err) => {
      setCancelling(null);
      setCancelError(err);
    });
  };
  return (
    <aside className={`tray ${tone}`} aria-live="polite" aria-labelledby="tray-h">
      <h2 id="tray-h" className="tray-head">
        <button className="tray-toggle" aria-expanded={!c.trayCollapsed} onClick={() => c.setTrayCollapsed(!c.trayCollapsed)} title={c.trayCollapsed ? 'Show the queue' : 'Collapse to one line'}>
          <span>{queueSummary(running.length, waiting.length, finished.length)}</span>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={c.trayCollapsed ? 'chev up' : 'chev'}>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </h2>
      {!c.trayCollapsed && (
        <>
          {running.map((op) => (
            <section key={op.id} className="tray-item" aria-label={opTitle(op, who(op))}>
              <h3>{opTitle(op, who(op))}</h3>
              <p className="muted small">{op.queuedAction && op.phase === 'queued' ? 'planning it now' : (PHASE[op.phase] ?? op.phase)}</p>
              <progress aria-label="operation progress" />
            </section>
          ))}
          {waiting.length > 0 && (
            <ol className="plain tray-item tray-waiting" aria-label="Waiting">
              {waiting.map((op) => (
                <li key={op.id} className="row between">
                  <span className="tray-wait-text">
                    <span>{opTitle(op, who(op))}</span>
                    <span className="muted small"> · waiting{op.queuedAction ? ', planned at its turn' : ''}</span>
                    {!op.cancellable && <span className="muted small tray-why">{notCancellableReason(op)}</span>}
                  </span>
                  {op.cancellable && (
                    <button className="btn small ghost" disabled={cancelling === op.id} onClick={() => cancel(op)} aria-label={`Cancel ${VERB[op.kind] ?? op.kind} ${who(op)}`}>
                      {cancelling === op.id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {cancelError && (
            <p className="error small" role="alert">
              {cancelError}
            </p>
          )}
          {finished.some((f) => !hasShownOnce(f)) && (
            // every finished item at once; those showing a value once still need their own acknowledgment
            <div className="row end tray-clear">
              <button className="btn ghost small" onClick={c.clearFinished}>
                Clear finished
              </button>
            </div>
          )}
          {finished.map((op) => (
            <FinishedItem key={op.id} c={c} op={op} who={who(op)} />
          ))}
        </>
      )}
    </aside>
  );
}

function FinishedItem({ c, op, who }: { c: ReturnType<typeof useConsole>; op: OperationDto; who: string }) {
  const inst = c.data.instances.find((i) => i.id === op.instanceId);
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const finishedInstall = op.state === 'succeeded' && (op.kind === 'install' || op.kind === 'reinstall');
  useEffect(() => {
    if (!finishedInstall) return;
    api.instance(op.instanceId).then(setDetail, () => setDetail(null));
  }, [op.id, op.instanceId, finishedInstall]);
  const creds = op.result?.['credentials'] as { username: string; password: string } | undefined;
  // decision 138: the package's own name for it (an admin login is not basic-auth), and shown-once values
  const credsLabel = typeof op.result?.['credentialsLabel'] === 'string' ? (op.result['credentialsLabel'] as string) : 'Login';
  const credsNote = typeof op.result?.['credentialsNote'] === 'string' ? (op.result['credentialsNote'] as string) : null;
  const shownOnce = (op.result?.['shownOnce'] as { id: string; label: string; value: string }[] | undefined) ?? [];
  const recoveryKey = typeof op.result?.['recoveryKey'] === 'string' ? (op.result['recoveryKey'] as string) : null;
  const recoveryNote = typeof op.result?.['recoveryNote'] === 'string' ? (op.result['recoveryNote'] as string) : null;
  // The Harbor recovery key appears only in the operation that issued it.
  const harborKey = typeof op.result?.['installationRecoveryKey'] === 'string' ? (op.result['installationRecoveryKey'] as string) : null;
  const harborNote = typeof op.result?.['installationRecoveryNote'] === 'string' ? (op.result['installationRecoveryNote'] as string) : null;
  const title = opTitle(op, who);
  const openUrl = inst ? appOpenUrl(inst) : null;
  const dismiss = () => c.dismiss(op.id);
  return (
    <section className={`tray-item done ${op.state}`} aria-label={title} data-op={op.id}>
      <div className="row between">
        <h3>
          <span className={`dot tone-${op.state === 'succeeded' ? 'ok' : op.state === 'cancelled' ? 'muted' : 'bad'}`} aria-hidden="true" /> {title}
        </h3>
        <button className="btn ghost icon" onClick={dismiss} aria-label={`Dismiss: ${title}`} title="Dismiss">
          ×
        </button>
      </div>
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
          {credsLabel}, shown once: <code>{creds.username}</code> / <code>{creds.password}</code> <Copy text={creds.password} />
          {credsNote && <span className="muted small"> {credsNote}</span>}
        </p>
      )}
      {shownOnce.map((x) => (
        <p key={x.id} className="warn">
          {x.label}, shown once: <code>{x.value}</code> <Copy text={x.value} />
        </p>
      ))}
      {harborKey && <RecoveryCard words={harborKey} note={harborNote} title="Your Harbor recovery key" onDismiss={dismiss} />}
      {recoveryKey && <RecoveryCard words={recoveryKey} note={recoveryNote} onDismiss={dismiss} />}
      {op.error && op.state === 'cancelled' && <p className="muted small">{[op.error.message, op.error.nextAction].filter(Boolean).join(' ')}</p>}
      {op.error && op.state !== 'cancelled' && (
        <p className="error">
          {op.error.code}: {op.error.message}
          {op.error.nextAction && (
            <>
              <br />
              <span className="muted">Next: {op.error.nextAction}</span>
            </>
          )}
        </p>
      )}
      {op.events.length > 0 && (
        <details>
          <summary className="muted small">Technical steps</summary>
          <EventList events={op.events} />
        </details>
      )}
    </section>
  );
}

// The first-visit helper (decision 109): the browser's own scary page for the
// HTTPS address cannot be styled by Harbor, so the plain-HTTP console carries
// the pointer instead. Shown only when secure addresses are on AND this page
// was opened over plain HTTP — the one combination where the operator has the
// secure address but is not using it yet.
function HttpsBanner({ c, go }: { c: Console; go: (r: Route) => void }) {
  const state = c.data.system?.network.https;
  const [dismissed, setDismissed] = useState(false);
  if (!state?.enabled || !state.url) return null;
  if (dismissed) return null;
  try {
    if (window.location.protocol === 'https:') return null;
  } catch {
    // no window (tests): show the banner
  }
  return (
    <p className="notice banner" role="status">
      Secure addresses are on — open Harbor at{' '}
      <a href={state.url} target="_blank" rel="noopener noreferrer">
        {state.url}
      </a>{' '}
      with no warning once this browser trusts the certificate.{' '}
      <button className="btn ghost small" onClick={() => go({ page: 'settings', section: 'network' })}>
        How to trust it…
      </button>{' '}
      <button className="btn ghost icon" onClick={() => setDismissed(true)} aria-label="Dismiss">
        ×
      </button>
    </p>
  );
}
