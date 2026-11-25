import { useEffect, useRef, useState } from 'react';
import type { CatalogItemDto, CatalogStatusDto, InstanceSummary, PackageSourceDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { StoreCard, copiesOf } from '../components';
import { categoryLabel, fmtAgo } from '../format';
import { RefreshIcon } from '../icons';
import type { Console } from '../store';
import { BackupPlaces } from './Backups';

type StoreTab = 'apps' | 'places' | 'sources';

export function Store({ c, onOpen, onInstall, onAddCopy, onManage, onUpload }: { c: Console; onOpen: (item: CatalogItemDto) => void; onInstall: (item: CatalogItemDto) => void; onAddCopy: (item: CatalogItemDto) => void; onManage: (i: InstanceSummary) => void; onUpload: () => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [tab, setTab] = useState<StoreTab>('apps');
  const [sources, setSources] = useState<PackageSourceDto[]>([]);
  const loadSources = () => api.packageSources().then(setSources, () => setSources([]));
  useEffect(() => {
    const t = setInterval(() => void loadSources(), 30_000);
    return () => clearInterval(t);
  }, []);
  // a repository added from "+ Your own app" refreshes the catalog: its tab shows at once, not on the next poll
  useEffect(() => {
    void loadSources();
  }, [c.data.catalog]);
  const cats = ['all', ...new Set(c.data.catalog.map((i) => i.presentation.category)), ...(c.data.catalog.some((i) => i.origin === 'local') ? ['mine'] : [])];
  const items = c.data.catalog.filter((i) => (cat === 'all' || (cat === 'mine' ? i.origin === 'local' : i.presentation.category === cat)) && (!q || `${i.name} ${i.description} ${i.presentation.tagline ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const tabs: { id: StoreTab; label: string }[] = [{ id: 'apps', label: 'Apps' }, { id: 'places', label: 'Backup places' }, ...(sources.length ? [{ id: 'sources' as const, label: 'Your repositories' }] : [])];
  const shown = tab === 'sources' && !sources.length ? 'apps' : tab;
  return (
    <section className="card" aria-labelledby="store-h">
      <div className="row between wrap store-head">
        <div>
          <h2 id="store-h">App Store</h2>
          <CatalogLine onLoaded={c.refresh} />
        </div>
        <div className="row wrap">
          {shown === 'apps' && <input className="search" type="search" placeholder="Search apps" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />}
          <button className="btn" onClick={onUpload} aria-label="Add your own app">
            + Your own app
          </button>
        </div>
      </div>
      {/* decision 164: backup places (and your git repositories) are their own menus, not a footer */}
      <div className="seg store-tabs" role="group" aria-label="Store sections">
        {tabs.map((t) => (
          <button key={t.id} className={`seg-btn ${shown === t.id ? 'active' : ''}`} aria-pressed={shown === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {shown === 'apps' && (
        <>
          <div className="row wrap chips" role="tablist" aria-label="Categories">
            {cats.map((k) => (
              <button key={k} role="tab" aria-selected={cat === k} className={`chip ${cat === k ? 'active' : ''}`} onClick={() => setCat(k)}>
                {k === 'all' ? 'All' : k === 'mine' ? 'Your apps' : categoryLabel(k)}
              </button>
            ))}
          </div>
          {!c.loaded ? (
            <p className="muted">Loading…</p>
          ) : (
            <ul className="grid store">
              {items.map((i) => {
                const copies = copiesOf(i.id, c.data.instances);
                return (
                  <li key={i.id} className="store-wrap">
                    <StoreCard item={i} copies={copies.active} removed={copies.removed} onOpen={() => onOpen(i)} onInstall={() => onInstall(i)} onAddCopy={() => onAddCopy(i)} onManage={onManage} onUpdate={(inst) => void c.start({ kind: 'update', instance: inst })} />
                    {i.availability === 'unavailable' && <p className="error small">{i.reason}</p>}
                  </li>
                );
              })}
              {items.length === 0 && <li className="muted">No apps match.</li>}
            </ul>
          )}
        </>
      )}
      {shown === 'places' && <BackupPlaces />}
      {shown === 'sources' && <GitSources sources={sources} reload={loadSources} />}
    </section>
  );
}

// Repositories Harbor watches as app sources (decision 80): check now, toggle redeploy, forget.
function GitSources({ sources, reload }: { sources: PackageSourceDto[]; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; next?: string } | null>(null);
  // decision 211: the source whose token form is open, and what is typed in it (sent once, never shown again)
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const load = reload;
  const act = async (id: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, ...(e.nextAction ? { next: e.nextAction } : {}) } : { message: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const closeToken = () => {
    setTokenFor(null);
    setToken('');
  };
  return (
    <section aria-labelledby="sources-h" className="git-sources">
      <h3 id="sources-h">Apps from your repositories</h3>
      <p className="muted small">Harbor watches each branch; a new commit becomes an update.</p>
      {error && (
        <div className="error small" role="alert">
          <p>{error.message}</p>
          {error.next && <p className="muted">{error.next}</p>}
        </div>
      )}
      <ul className="plain">
        {sources.map((s) => (
          <li key={s.id} className="row between wrap">
            <span>
              <strong>{s.packageId}</strong>{' '}
              <span className="muted small">
                {s.url.replace(/^https:\/\//, '')} · {s.ref}
                {s.subpath ? ` · ${s.subpath}` : ''} · at {s.pinnedCommit?.slice(0, 12) ?? '—'}
                {s.hasToken ? ' · private (token stored)' : ''}
                {s.note ? ` · ⚠ ${s.note}` : ''}
              </span>
            </span>
            <span className="row wrap">
              <label className="row small muted" title="New pushes to the branch deploy themselves; a failed deployment rolls back">
                <input type="checkbox" checked={s.autoRedeploy} disabled={busy === s.id} onChange={(e) => void act(s.id, () => api.setSourceAutoRedeploy(s.id, e.target.checked))} aria-label={`Redeploy ${s.packageId} on commit`} />
                on commit
              </label>
              <button className="btn small" disabled={busy === s.id} onClick={() => void act(s.id, () => api.checkPackageSource(s.id))}>
                Check now
              </button>
              <button className="btn small" disabled={busy === s.id} aria-expanded={tokenFor === s.id} onClick={() => (tokenFor === s.id ? closeToken() : (setTokenFor(s.id), setToken('')))} aria-label={`Access token for ${s.packageId}`}>
                Token
              </button>
              <button className="btn ghost small" disabled={busy === s.id} onClick={() => void act(s.id, () => api.removePackageSource(s.id))} title="The app and its package stay; only the repository link goes">
                Forget
              </button>
            </span>
            {tokenFor === s.id && (
              <form
                className="row wrap source-token"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(s.id, () => api.setSourceToken(s.id, token.trim())).then((ok) => ok && closeToken());
                }}
              >
                <label className="small">
                  {s.hasToken ? 'New access token' : 'Access token'}
                  <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`New access token for ${s.packageId}`} />
                </label>
                <button type="submit" className="btn primary small" disabled={busy === s.id || token.trim().length < 8}>
                  Save token
                </button>
                {s.hasToken && (
                  <button type="button" className="btn ghost small" disabled={busy === s.id} onClick={() => void act(s.id, () => api.clearSourceToken(s.id)).then((ok) => ok && closeToken())}>
                    Remove token
                  </button>
                )}
                <span className="muted small">Harbor tries it on the branch before keeping it. GitHub: a fine-grained token for this repository, Contents: read-only.</span>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Decision 158: which official catalog this Harbor uses, and a way to look for a newer one now. Decision 164:
// it sits under the Store's title with a refresh icon; Harbor checks on its own every hour, and this line
// re-reads the status every few minutes, loading new apps by itself when a newer catalog arrived. A stored
// failure of the automatic check shows on load, so a stuck catalog is never silent.
function CatalogLine({ onLoaded }: { onLoaded: () => Promise<void> }) {
  const [st, setSt] = useState<CatalogStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const serial = useRef<number | null>(null);
  useEffect(() => {
    const read = (first: boolean) =>
      api.catalogStatus().then(
        (s) => {
          setSt(s);
          if (first && s.source && s.error) setResult({ text: `Last check failed: ${s.error}`, error: true });
          if (serial.current !== null && s.serial > serial.current) {
            void onLoaded();
            setResult({ text: 'New apps and updates loaded', error: false });
          }
          serial.current = s.serial;
        },
        () => (first ? setSt(null) : undefined),
      );
    void read(true);
    const t = setInterval(() => void read(false), 5 * 60_000);
    return () => clearInterval(t);
  }, [onLoaded]);
  if (!st) return null;
  const from = st.createdAt ? new Date(st.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const next = await api.catalogRefresh();
      if (next.error) setResult({ text: next.error, error: true });
      else if (next.serial > st.serial) {
        await onLoaded();
        setResult({ text: 'New apps and updates loaded', error: false });
      } else setResult({ text: 'Up to date', error: false });
      serial.current = next.serial;
      setSt(next);
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="catalog-line row wrap small muted">
      <span>{from ? `App catalog from ${from}` : 'App catalog bundled with this Harbor'}</span>
      {st.source && st.checkedAt && <span title={new Date(st.checkedAt).toLocaleString()}>· checked {fmtAgo(st.checkedAt)}</span>}
      {st.source ? (
        <button className="btn ghost icon small refresh" disabled={busy} onClick={() => void check()} aria-label={busy ? 'Checking…' : 'Check for new apps'} title="Check for new apps">
          <RefreshIcon spinning={busy} />
        </button>
      ) : (
        <span>· Catalog updates are off</span>
      )}
      <span role="status" className={result?.error ? 'error' : undefined}>
        {result?.text ?? ''}
      </span>
    </div>
  );
}
