import { useState } from 'react';
import type { CatalogItemDto } from '../../../../src/contracts/api';
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
    </section>
  );
}
