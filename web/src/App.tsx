import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CatalogItemDto, InstanceSummary } from '../../src/contracts/api';
import { ApiError, api, forgetToken, hasToken } from './api';
import { EventList } from './app/components';
import { AppDrawer, InstallWizard, PlanDialog, PublishWizard } from './app/dialogs';
import { Home } from './app/pages/Home';
import { Platform } from './app/pages/Platform';
import { Publishing } from './app/pages/Publishing';
import { Settings } from './app/pages/Settings';
import { Store } from './app/pages/Store';
import { useRoute, type Route } from './app/router';
import { isFinal, useConsole } from './app/store';

type View = { kind: 'login' } | { kind: 'console' };

export function App() {
  const [view, setView] = useState<View>(hasToken() ? { kind: 'console' } : { kind: 'login' });
  const [notice, setNotice] = useState<string | null>(null);
  const onAuthLost = useCallback((msg?: string) => {
    forgetToken();
    setNotice(msg ?? 'Your session ended. Log in again to continue; running operations keep going on the server.');
    setView({ kind: 'login' });
  }, []);
  if (view.kind === 'login') {
    return (
      <main className="login-wrap">
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

function Login({ onDone, notice }: { onDone: () => void; notice: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}. ${err.nextAction}` : 'Cannot reach the Harbor daemon.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card login" aria-labelledby="login-h">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          ⚓
        </span>
        <h1>Harbor</h1>
        <span className="badge">local preview</span>
      </div>
      <h2 id="login-h">Log in</h2>
      {notice && <p className="notice">{notice}</p>}
      <form onSubmit={submit}>
        <label>
          Username
          <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted small">Loopback-only console. Tokens stay in memory; reloading asks you to log in again.</p>
    </section>
  );
}

const NAV: { route: Route; label: string; glyph: string }[] = [
  { route: { page: 'home' }, label: 'Home', glyph: '⌂' },
  { route: { page: 'store' }, label: 'App Store', glyph: '▦' },
  { route: { page: 'publishing' }, label: 'Publishing', glyph: '⇗' },
  { route: { page: 'platform' }, label: 'Platform', glyph: '⚙' },
  { route: { page: 'settings' }, label: 'Settings', glyph: '☰' },
];

function ConsoleShell({ onAuthLost }: { onAuthLost: (msg?: string) => void }) {
  const c = useConsole(onAuthLost);
  const [route, go] = useRoute();
  const [storeItem, setStoreItem] = useState<CatalogItemDto | null>(null);
  const [drawer, setDrawer] = useState<InstanceSummary | null>(null);
  const [publishing, setPublishing] = useState<InstanceSummary | null>(null);

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

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      onAuthLost('Logged out.');
    }
  };

  const page = route.page === 'app' ? 'home' : route.page;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ⚓
          </span>
          <span className="brand-name">Harbor</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.route.page}>
              <a href={`#/${n.route.page}`} className={page === n.route.page ? 'active' : ''} aria-current={page === n.route.page ? 'page' : undefined}>
                <span className="glyph" aria-hidden="true">
                  {n.glyph}
                </span>
                <span>{n.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <button className="btn ghost logout" onClick={() => void logout()}>
          Log out
        </button>
      </nav>
      <main className="content">
        {c.loadError && (
          <p className="error banner" role="alert">
            Cannot load: {c.loadError}
          </p>
        )}
        {page === 'home' && <Home c={c} onOpenApp={setDrawer} onGoStore={() => go({ page: 'store' })} />}
        {page === 'store' && <Store c={c} onOpen={setStoreItem} onInstall={(item) => (item.claims.some((cl) => cl.external) ? setStoreItem(item) : void c.start({ kind: 'install', packageId: item.id, name: '' }))} />}
        {page === 'publishing' && <Publishing c={c} onPublish={setPublishing} />}
        {page === 'platform' && <Platform c={c} />}
        {page === 'settings' && <Settings c={c} onLogout={() => void logout()} />}
      </main>

      {storeItem && !c.pending && (
        <InstallWizard
          item={storeItem}
          busy={c.busy}
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
      <PlanDialog c={c} />
      <Tray c={c} />
    </div>
  );
}

// Bottom-right operation tray: progress while running, one-shot result (with credentials) when done.
function Tray({ c }: { c: ReturnType<typeof useConsole> }) {
  const op = c.watching ?? c.lastDone;
  if (!op) return null;
  const final = isFinal(op);
  const creds = op.result?.['credentials'] as { username: string; password: string } | undefined;
  const title = `${op.kind.charAt(0).toUpperCase()}${op.kind.slice(1)} ${op.state === 'succeeded' ? 'succeeded' : op.state === 'failed' ? 'failed' : op.state === 'needs_action' ? 'needs attention' : `in progress — ${op.phase}`}`;
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
      {!final && <progress aria-label="operation progress" />}
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
      <details open={!final}>
        <summary className="muted small">Steps</summary>
        <EventList events={op.events} />
      </details>
    </aside>
  );
}
