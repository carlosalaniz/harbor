import { useEffect, useState } from 'react';
import type { CatalogItemDto, PackageSourceDto } from '../../../../src/contracts/api';
import { api } from '../../api';
import { StoreCard } from '../components';
import { categoryLabel } from '../format';
import type { Console } from '../store';

export function Store({ c, onOpen, onInstall, onUpload }: { c: Console; onOpen: (item: CatalogItemDto) => void; onInstall: (item: CatalogItemDto) => void; onUpload: () => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const cats = ['all', ...new Set(c.data.catalog.map((i) => i.presentation.category)), ...(c.data.catalog.some((i) => i.origin === 'local') ? ['mine'] : [])];
  const items = c.data.catalog.filter((i) => (cat === 'all' || (cat === 'mine' ? i.origin === 'local' : i.presentation.category === cat)) && (!q || `${i.name} ${i.description} ${i.presentation.tagline ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const installedOf = (id: string) => c.data.instances.filter((x) => x.packageId === id && x.installState !== 'retained').length;
  return (
    <section className="card" aria-labelledby="store-h">
      <div className="row between wrap">
        <div>
          <h2 id="store-h">App Store</h2>
          <p className="muted small">{c.data.catalog.length} apps, every image pinned and checked on a real machine. Install with one click; the app runs privately on this computer.</p>
        </div>
        <div className="row wrap">
          <input className="search" type="search" placeholder="Search apps" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={onUpload} aria-label="Add your own app">
            + Your own app
          </button>
        </div>
      </div>
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
          {items.map((i) => (
            <li key={i.id} className="store-wrap">
              <StoreCard item={i} installed={installedOf(i.id)} onOpen={() => onOpen(i)} onInstall={() => onInstall(i)} disabled={c.busy} />
              {i.availability === 'unavailable' && <p className="error small">{i.reason}</p>}
            </li>
          ))}
          {items.length === 0 && <li className="muted">No apps match.</li>}
        </ul>
      )}
      <GitSources />
    </section>
  );
}

// Repositories Harbor watches as app sources (decision 80): check now, toggle redeploy, forget.
function GitSources() {
  const [sources, setSources] = useState<PackageSourceDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.packageSources().then(setSources, () => setSources([]));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);
  if (sources.length === 0) return null;
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="sources-h" className="git-sources">
      <h3 id="sources-h">Apps from your repositories</h3>
      {error && <p className="error small">{error}</p>}
      <ul className="plain">
        {sources.map((s) => (
          <li key={s.id} className="row between wrap">
            <span>
              <strong>{s.packageId}</strong>{' '}
              <span className="muted small">
                {s.url.replace(/^https:\/\//, '')} · {s.ref}
                {s.subpath ? ` · ${s.subpath}` : ''} · at {s.pinnedCommit?.slice(0, 12) ?? '—'}
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
              <button className="btn ghost small" disabled={busy === s.id} onClick={() => void act(s.id, () => api.removePackageSource(s.id))} title="The app and its package stay; only the repository link goes">
                Forget
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
