import { useState } from 'react';
import type { InstanceSummary, SpaceDto } from '../../../src/contracts/api';
import { api } from '../api';
import { appLabel, Copy, Dialog, InstanceIcon } from './components';
import type { Console } from './store';

// Decision 202: what sharing costs, in the words the API, the CLI and the review use.
export const SHARED_WARNING = "Every service of these apps, databases included, can reach every other one. Harbor's app login does not apply between them; only each app's own login does. Turn it on only for apps you trust with each other's data.";

// Make or change a space: its name, its apps (they leave any other space), and the shared network (off by default;
// turning it on needs an explicit tick under the warning).
export function SpaceDialog({ c, space, onClose }: { c: Console; space: SpaceDto | null; onClose: () => void }) {
  const all = c.data.instances.filter((i) => i.installState !== 'retained');
  const [name, setName] = useState(space?.name ?? '');
  const [apps, setApps] = useState<string[]>(space?.apps.map((a) => a.instanceId) ?? []);
  const [shared, setShared] = useState(space?.shared ?? false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newlyShared = shared && !space?.shared;
  const otherSpace = (id: string) => c.data.spaces.find((s) => s.id !== space?.id && s.apps.some((a) => a.instanceId === id));
  const toggle = (id: string) => setApps(apps.includes(id) ? apps.filter((a) => a !== id) : [...apps, id]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await c.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(() => {
      const body = { name: name.trim(), apps, shared, ...(newlyShared ? { confirmShared: true } : {}) };
      return space ? api.updateSpace(space.id, body) : api.createSpace(body);
    });
  return (
    <Dialog title={space ? `Edit ${space.name}` : 'New space'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Productivity" aria-label="Space name" required />
        </label>
        <fieldset className="space-apps">
          <legend>Apps</legend>
          {all.length === 0 ? (
            <p className="muted small">No apps installed yet.</p>
          ) : (
            <ul className="plain">
              {all.map((i: InstanceSummary) => {
                const other = otherSpace(i.id);
                return (
                  <li key={i.id}>
                    <label className="check">
                      <input type="checkbox" checked={apps.includes(i.id)} onChange={() => toggle(i.id)} aria-label={appLabel(i, c.data.instances)} />
                      <InstanceIcon inst={i} size={24} />
                      <span>
                        {appLabel(i, c.data.instances)}
                        {other && <span className="muted small"> · in {other.name}{apps.includes(i.id) ? ', moves here' : ''}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>
            Share a network
            <span className="muted small block">The apps reach each other by name; each app's page shows its addresses. Off: each app stays on its own network.</span>
          </span>
        </label>
        {newlyShared && (
          <div className="card warn-box" role="note">
            <p className="small">
              <strong>Not isolated.</strong> {SHARED_WARNING}
            </p>
            <label className="check small">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I understand, share the network
            </label>
          </div>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="row between wrap">
          {space ? (
            confirmDelete ? (
              <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => api.deleteSpace(space.id))}>
                Delete {space.name}? Apps stay installed
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(true)}>
                Delete space
              </button>
            )
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || !name.trim() || (newlyShared && !understood)}>
              {space ? 'Save' : 'Create space'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// The overview line: the space's name, and whether it shares a network.
export function spaceLabel(spaces: SpaceDto[], instanceId: string): string | null {
  const s = spaces.find((x) => x.apps.some((a) => a.instanceId === instanceId));
  return s ? `${s.name}${s.shared ? ', shared network' : ''}` : null;
}

// App page: which space the app is in and, when shared, the names the other apps of the space use for it.
export function SpaceCard({ c, inst }: { c: Console; inst: InstanceSummary }) {
  const space = c.data.spaces.find((s) => s.apps.some((a) => a.instanceId === inst.id));
  const [editing, setEditing] = useState(false);
  if (!space) return null;
  const me = space.apps.find((a) => a.instanceId === inst.id)!;
  const others = space.apps.filter((a) => a.instanceId !== inst.id).map((a) => a.name);
  return (
    <section className="page-section" aria-label="Space">
      <div className="page-section-head">
        <h4>Space: {space.name}</h4>
        <button className="btn small" onClick={() => setEditing(true)} aria-label={`Edit space ${space.name}`}>
          Edit…
        </button>
      </div>
      {space.shared ? (
        <>
          <div className="page-row">
            <div className="page-row-text">
              <div>Shared network{others.length ? ` with ${others.join(', ')}` : ''}</div>
              <div className="muted small">Other apps of the space reach {inst.name} at these addresses (paste one into the other app).</div>
            </div>
          </div>
          {me.addresses.map((a) => (
            <div className="page-row" key={a.alias}>
              <div className="page-row-text">
                <div>
                  <code>{a.address}</code>
                </div>
                <div className="muted small">{a.main ? 'Main page' : `Service ${a.service}`}</div>
              </div>
              <div className="page-row-actions">
                <Copy text={a.address} />
              </div>
            </div>
          ))}
          {space.conflicts.length > 0 && <p className="muted small">Left out: {space.conflicts.join('; ')}</p>}
        </>
      ) : (
        <div className="page-row">
          <div className="page-row-text">
            <div>Grouped on Home{others.length ? ` with ${others.join(', ')}` : ''}</div>
            <div className="muted small">No shared network: each app stays on its own.</div>
          </div>
        </div>
      )}
      {editing && <SpaceDialog c={c} space={space} onClose={() => setEditing(false)} />}
    </section>
  );
}
