import { useState } from 'react';
import type { CatalogItemDto } from '../../../../src/contracts/api';
import { StoreCard } from '../components';
import { categoryLabel } from '../format';
import type { Console } from '../store';

export function Store({ c, onOpen, onInstall }: { c: Console; onOpen: (item: CatalogItemDto) => void; onInstall: (item: CatalogItemDto) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const cats = ['all', ...new Set(c.data.catalog.map((i) => i.presentation.category))];
  const items = c.data.catalog.filter((i) => (cat === 'all' || i.presentation.category === cat) && (!q || `${i.name} ${i.description} ${i.presentation.tagline ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const installedOf = (id: string) => c.data.instances.filter((x) => x.packageId === id && x.installState !== 'retained').length;
  return (
    <section className="card" aria-labelledby="store-h">
      <div className="row between wrap">
        <h2 id="store-h">App Store</h2>
        <input className="search" type="search" placeholder="Search apps" aria-label="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="row wrap chips" role="tablist" aria-label="Categories">
        {cats.map((k) => (
          <button key={k} role="tab" aria-selected={cat === k} className={`chip ${cat === k ? 'active' : ''}`} onClick={() => setCat(k)}>
            {k === 'all' ? 'All' : categoryLabel(k)}
          </button>
        ))}
      </div>
      {!c.loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="grid store">
          {items.map((i) => (
            <li key={i.id} className="store-wrap">
              <StoreCard item={i} onOpen={() => onOpen(i)} onInstall={() => onInstall(i)} disabled={c.busy} />
              {installedOf(i.id) > 0 && <span className="muted small installed-note">{installedOf(i.id)} installed</span>}
              {i.availability === 'unavailable' && <p className="error small">{i.reason}</p>}
            </li>
          ))}
          {items.length === 0 && <li className="muted">No apps match.</li>}
        </ul>
      )}
    </section>
  );
}
