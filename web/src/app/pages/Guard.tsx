// Settings → Allowed addresses (Access Guard, decision 207): only addresses on the list reach the apps published on the
// internet; everyone else is dropped before a connection opens. The list, what is never dropped, the addresses that were
// dropped (packet counts, tags, where they are) and, with an IP lookup app installed (decision 209), an online check.
import { useCallback, useEffect, useState } from 'react';
import type { AccessGuardDto, BlockedAddressDto, GuardEntryDto, GuardLookupDto } from '../../../../src/contracts/api';
import { ApiError, api } from '../../api';
import { Dialog, Pill } from '../components';

const errText = (e: unknown) => (e instanceof ApiError ? `${e.message}${e.nextAction ? `. ${e.nextAction}` : ''}` : e instanceof Error ? e.message : String(e));
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const until = (iso: string): string => {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return 'expired';
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min left`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h left`;
  return `${Math.round(s / 86400)} days left`;
};
const EXPIRY: { label: string; hours: number | null }[] = [
  { label: 'Never', hours: null },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];
const splitTags = (s: string) =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export function Guard() {
  const [g, setG] = useState<AccessGuardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [adding, setAdding] = useState<{ address: string; tags: string } | null>(null);
  const [editing, setEditing] = useState<GuardEntryDto | null>(null);
  const [tagging, setTagging] = useState<BlockedAddressDto | null>(null);
  const [lookups, setLookups] = useState<Record<string, GuardLookupDto | 'busy' | { error: string }>>({});
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(async () => {
    try {
      setG(await api.accessGuard());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (fn: () => Promise<AccessGuardDto>) => {
    setBusy(true);
    setError(null);
    try {
      setG(await fn());
    } catch (e) {
      setError(errText(e));
      void load();
    } finally {
      setBusy(false);
    }
  };
  const lookup = async (address: string, online: boolean) => {
    setLookups((l) => ({ ...l, [address]: 'busy' }));
    try {
      const r = await api.guardLookup(address, online);
      setLookups((l) => ({ ...l, [address]: r }));
    } catch (e) {
      setLookups((l) => ({ ...l, [address]: { error: errText(e) } }));
    }
  };

  if (!g) {
    return (
      <section className="card" aria-labelledby="guard-h">
        <h2 id="guard-h">Allowed addresses</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }
  const onlineApp = g.lookupApps.find((a) => a.running);
  const dropped = g.blocked.filter((b) => b.packets > 0 || b.tags.length);
  const shown = showAll ? dropped : dropped.slice(0, 25);
  return (
    <>
      <section className="card" aria-labelledby="guard-h">
        <h2 id="guard-h">Allowed addresses</h2>
        <p className="muted small">
          Choose who can reach the apps you publish on the internet. With the list on, a connection from any other address is dropped before it opens: no page, no login screen, no answer at all. Your own network, the tailnet and
          this machine always get in.
        </p>
        {!g.available && (
          <p className="warn small" role="alert">
            {g.reason}
          </p>
        )}
        <div className="row wrap" role="radiogroup" aria-label="Who can reach your public apps">
          <button className={`btn ${!g.enabled ? 'primary' : ''}`} role="radio" aria-checked={!g.enabled} disabled={busy || !g.available} onClick={() => g.enabled && void act(() => api.setAccessGuard(false))}>
            Everyone
          </button>
          <button className={`btn ${g.enabled ? 'primary' : ''}`} role="radio" aria-checked={g.enabled} disabled={busy || !g.available} onClick={() => !g.enabled && setConfirmOn(true)}>
            Allowed list only
          </button>
          <Pill tone={g.state === 'failed' ? 'bad' : g.enabled ? 'ok' : 'muted'}>{g.state === 'failed' ? 'not applied' : g.enabled ? 'on' : 'off'}</Pill>
        </div>
        <p className="small" role="status">
          {g.publicApps.length ? (
            <>
              {g.enabled ? 'Guarding' : 'Published on the internet'}: {g.publicApps.map((p) => p.hostname).join(', ')}
            </>
          ) : (
            <span className="muted">No app is published on the internet yet (Settings → Public addresses). The list applies as soon as one is.</span>
          )}
        </p>
        {g.state === 'failed' && (
          <p className="error small" role="alert">
            Harbor could not load the list: {g.message}. The previous setting stays in force.
          </p>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="guard-list-h">
        <div className="row between wrap">
          <h2 id="guard-list-h">Allowed</h2>
          <button className="btn primary" disabled={busy} onClick={() => setAdding({ address: '', tags: '' })}>
            Add address…
          </button>
        </div>
        {g.entries.length === 0 ? (
          <p className="muted small">{g.enabled ? 'Nobody yet: every connection from the internet is dropped.' : 'Nobody yet. Add the addresses you connect from (your home, your office) before you turn the list on.'}</p>
        ) : (
          <ul className="plain guard-list">
            {g.entries.map((e) => (
              <li key={e.id} className="guard-row">
                <div className="guard-main">
                  <code>{e.address}</code>
                  <span>{e.label ?? <span className="muted">no label</span>}</span>
                  {e.tags.map((t) => (
                    <span key={t} className="guard-tag">
                      {t}
                    </span>
                  ))}
                  {e.expiresAt && <Pill tone={e.expired ? 'bad' : 'warn'}>{e.expired ? 'expired' : until(e.expiresAt)}</Pill>}
                </div>
                <div className="row">
                  <button className="btn ghost small" disabled={busy} onClick={() => setEditing(e)} aria-label={`Edit ${e.address}`}>
                    Edit
                  </button>
                  <button className="btn ghost small danger" disabled={busy} onClick={() => void act(() => api.removeGuardEntry(e.id))} aria-label={`Remove ${e.address}`}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">On a phone? Reach your apps through the tailnet (Settings → Remote access). Mobile carriers change your address too often to allow.</p>
      </section>

      <section className="card" aria-labelledby="guard-drop-h">
        <div className="row between wrap">
          <h2 id="guard-drop-h">Dropped</h2>
          <button className="btn small" disabled={busy || !g.enabled} onClick={() => void act(() => api.checkAccessGuard())}>
            Check now
          </button>
        </div>
        {dropped.length === 0 ? (
          <p className="muted small">{g.enabled ? 'Nothing dropped yet. Harbor reads the counts every 10 minutes.' : 'Nothing is dropped while everyone can reach your apps.'}</p>
        ) : (
          <>
            <p className="muted small">
              {g.totals.packets.toLocaleString()} packets from {g.totals.addresses.toLocaleString()} addresses, {g.totals.addresses24h.toLocaleString()} of them in the last 24 hours. A client resends its first packet when nobody answers, so one try
              counts about 2–3.
            </p>
            <ul className="plain guard-list">
              {shown.map((b) => {
                const l = lookups[b.address];
                const geo = l && l !== 'busy' && 'geo' in l ? l.geo : b.geo;
                const online = l && l !== 'busy' && 'online' in l ? l.online : b.online;
                return (
                  <li key={b.address} className="guard-row">
                    <div className="guard-main">
                      <code>{b.address}</code>
                      <strong className="guard-count">{b.packets.toLocaleString()}</strong>
                      <span className="muted small">{b.packets ? `last ${ago(b.lastSeen)}` : 'not dropped yet'}</span>
                      {b.allowed && <Pill tone="ok">allowed now</Pill>}
                      {b.tags.map((t) => (
                        <span key={t} className="guard-tag">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="guard-where small">
                      {l === 'busy' ? (
                        <span className="muted">Looking up…</span>
                      ) : l && 'error' in l ? (
                        <span className="error">{l.error}</span>
                      ) : geo ? (
                        <span>
                          {geo.countryName ?? geo.country ?? 'Unknown country'}
                          {geo.org ? ` · ${geo.org}` : ''}
                          {geo.asn ? <span className="muted"> ({geo.asn})</span> : null}
                        </span>
                      ) : null}
                      {online && (
                        <ul className="plain guard-online">
                          {online.results.map((r, i) => (
                            <li key={i}>
                              <span className="muted">{r.source}:</span>{' '}
                              {r.ok
                                ? [
                                    [r.city, r.region, r.country].filter(Boolean).join(', '),
                                    r.abuseScore !== undefined ? `abuse score ${r.abuseScore}%${r.reports !== undefined ? ` (${r.reports} reports)` : ''}` : '',
                                    r.usage ?? '',
                                    r.flags?.length ? r.flags.join(', ') : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ') || 'nothing known'
                                : `failed (${r.error ?? 'unknown'})`}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="row wrap">
                      {!geo && (
                        <button className="btn ghost small" disabled={l === 'busy'} onClick={() => void lookup(b.address, false)} aria-label={`Look up ${b.address}`}>
                          Look up
                        </button>
                      )}
                      {onlineApp && (
                        <button className="btn ghost small" disabled={l === 'busy'} onClick={() => void lookup(b.address, true)} aria-label={`Ask ${onlineApp.name} about ${b.address}`}>
                          Ask online
                        </button>
                      )}
                      <button className="btn ghost small" onClick={() => setTagging(b)} aria-label={`Tag ${b.address}`}>
                        Tag
                      </button>
                      {!b.allowed && (
                        <button className="btn ghost small" onClick={() => setAdding({ address: b.address, tags: b.tags.join(', ') })} aria-label={`Allow ${b.address}`}>
                          Allow…
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {dropped.length > shown.length && (
              <button className="btn ghost small" onClick={() => setShowAll(true)}>
                Show all {dropped.length}
              </button>
            )}
          </>
        )}
        <p className="muted small">
          Locations come from a database on this machine (downloaded the first time you look one up, refreshed monthly); the address itself never leaves it.{' '}
          <a href={g.geo.attribution.url} target="_blank" rel="noreferrer">
            {g.geo.attribution.text}
          </a>
          .{' '}
          {onlineApp
            ? `Ask online sends the address to the services ${onlineApp.name} uses, through your VPN.`
            : g.lookupApps.length
              ? `${g.lookupApps[0]!.name} is installed but not running: start it to ask online.`
              : 'For abuse reports and more detail, install IP Lookup from the App Store (it goes through your VPN).'}
        </p>
      </section>

      <section className="card" aria-labelledby="guard-exempt-h">
        <h2 id="guard-exempt-h">Never dropped</h2>
        <p className="muted small">Your own network, Docker's networks, the tailnet and this machine itself, so a wrong list never locks you out. The console is never on the internet either way.</p>
        <p className="small">
          <code>{g.exempt.join(' · ')}</code>
        </p>
        {g.own.length > 0 && (
          <p className="small">
            This machine's public address{g.own.length === 1 ? '' : 'es'}: <code>{g.own.join(', ')}</code> <span className="muted">(where your public names point; some routers send home traffic back in through it)</span>
          </p>
        )}
      </section>

      {confirmOn && (
        <Dialog title="Allow only the addresses on the list?" onClose={() => setConfirmOn(false)}>
          <p>
            {g.entries.length
              ? `Only ${g.entries.length} allowed ${g.entries.length === 1 ? 'entry' : 'entries'}, your own network and the tailnet will reach ${g.publicApps.length ? g.publicApps.map((p) => p.hostname).join(', ') : 'your public apps'}. Every other connection is dropped from now on.`
              : 'The list is empty: nobody on the internet will reach your public apps. Your own network and the tailnet still do.'}
          </p>
          <p className="warn small">That includes you on mobile data or someone else's Wi-Fi, unless you connect through the tailnet.</p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirmOn(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setConfirmOn(false);
                void act(() => api.setAccessGuard(true));
              }}
            >
              Allow only the list
            </button>
          </div>
        </Dialog>
      )}
      {adding && (
        <AddDialog
          initial={adding}
          onClose={() => setAdding(null)}
          onSave={async (body) => {
            setG(await api.addGuardEntry(body));
            setAdding(null);
          }}
        />
      )}
      {editing && (
        <EditDialog
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            setG(await api.updateGuardEntry(editing.id, patch));
            setEditing(null);
          }}
        />
      )}
      {tagging && (
        <TagDialog
          item={tagging}
          onClose={() => setTagging(null)}
          onSave={async (tags) => {
            setG(await api.tagGuardAddress(tagging.address, tags));
            setTagging(null);
          }}
        />
      )}
    </>
  );
}

function AddDialog({ initial, onClose, onSave }: { initial: { address: string; tags: string }; onClose: () => void; onSave: (b: { address: string; label?: string; tags?: string[]; expiresAt?: string }) => Promise<void> }) {
  const [address, setAddress] = useState(initial.address);
  const [label, setLabel] = useState('');
  const [tags, setTags] = useState(initial.tags);
  const [hours, setHours] = useState<string>('never');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Allow an address" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const h = hours === 'never' ? null : Number(hours);
          onSave({ address: address.trim(), ...(label.trim() ? { label: label.trim() } : {}), ...(splitTags(tags).length ? { tags: splitTags(tags) } : {}), ...(h ? { expiresAt: new Date(Date.now() + h * 3600_000).toISOString() } : {}) })
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="small">
          Address or range
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.7 or 2001:db8:4a::/64" spellCheck={false} autoComplete="off" aria-label="Address or range" required />
        </label>
        <p className="muted small">One address, or a range for a connection whose address changes within it. Home IPv6 usually needs its /64.</p>
        <label className="small">
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} placeholder="Home fibre" aria-label="Label" />
        </label>
        <label className="small">
          Tags (optional, comma separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="home, family" aria-label="Tags" />
        </label>
        <label className="small">
          Expires
          <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Expires">
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.hours === null ? 'never' : String(x.hours)}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !address.trim()} aria-busy={busy}>
            {busy ? 'Allowing…' : 'Allow'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({ entry, onClose, onSave }: { entry: GuardEntryDto; onClose: () => void; onSave: (p: { label?: string | null; tags?: string[]; expiresAt?: string | null }) => Promise<void> }) {
  const [label, setLabel] = useState(entry.label ?? '');
  const [tags, setTags] = useState(entry.tags.join(', '));
  const [hours, setHours] = useState<string>('keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Edit ${entry.address}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          onSave({ label: label.trim() || null, tags: splitTags(tags), ...(hours === 'keep' ? {} : { expiresAt: hours === 'never' ? null : new Date(Date.now() + Number(hours) * 3600_000).toISOString() }) })
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="small">
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} aria-label="Label" />
        </label>
        <label className="small">
          Tags (comma separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
        </label>
        <label className="small">
          Expires
          <select value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Expires">
            <option value="keep">{entry.expiresAt ? `As it is (${until(entry.expiresAt)})` : 'As it is (never)'}</option>
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.hours === null ? 'never' : String(x.hours)}>
                {x.hours === null ? 'Never' : `In ${x.label}`}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TagDialog({ item, onClose, onSave }: { item: BlockedAddressDto; onClose: () => void; onSave: (tags: string[]) => Promise<void> }) {
  const [tags, setTags] = useState(item.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Tag ${item.address}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          onSave(splitTags(tags))
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="small">
          Tags (comma separated)
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="scanner" aria-label="Tags" autoFocus />
        </label>
        <p className="muted small">A tagged address is kept past 30 days and never notified about. Leave empty to remove its tags.</p>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
            Save tags
          </button>
        </div>
      </form>
    </Dialog>
  );
}
