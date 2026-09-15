import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CatalogItemDto, FolderListingDto, HostStorageDto, InstanceSummary, OperationDto } from '../../../src/contracts/api';
import { api } from '../api';
import { fmtBytes, fmtTime, monogram, plainStatus } from './format';

export function AppIcon({ packageId, icon, name, size = 44 }: { packageId: string; icon: string | null; name: string; size?: number }) {
  const cls = size >= 64 ? 'appicon large' : size <= 28 ? 'appicon small' : 'appicon';
  if (icon) return <img className={cls} src={`/v1/catalog/${packageId}/asset/${icon}`} alt="" width={size} height={size} />;
  return (
    <span className={`${cls} monogram`} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'busy' | 'info'; children: ReactNode }) {
  return <span className={`pill tone-${tone}`}>{children}</span>;
}

export function StatusPill({ inst }: { inst: InstanceSummary }) {
  const s = plainStatus(inst);
  return (
    <Pill tone={s.tone}>
      <span className="dot" aria-hidden="true" />
      {s.label}
    </Pill>
  );
}

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId(); // dialogs can nest (install page → folder picker); each needs its own label
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} onClose={onClose} aria-labelledby={headingId}>
      <div className="dialog-head">
        <h2 id={headingId}>{title}</h2>
        <button className="btn ghost icon" onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {action}
    </div>
  );
}

export function StoreCard({ item, installed = 0, onOpen, onInstall, disabled }: { item: CatalogItemDto; installed?: number; onOpen: () => void; onInstall: () => void; disabled: boolean }) {
  return (
    <li className="tile store">
      <button className="tile-main" onClick={onOpen} aria-label={`About ${item.name}`}>
        <AppIcon packageId={item.id} icon={item.presentation.icon} name={item.name} size={56} />
        <div>
          <h3>{item.name}</h3>
          <p className="muted small">{item.presentation.tagline ?? item.description}</p>
          <p className="row wrap badges">
            {installed > 0 && <Pill tone="ok">{installed === 1 ? 'Installed' : `${installed} installed`}</Pill>}
            {item.qualification !== 'passed' && item.availability === 'available' && (
              <Pill tone={item.qualification === 'blocked' ? 'warn' : 'muted'}>{item.qualification === 'blocked' ? 'Live check failed' : 'Not yet live-checked'}</Pill>
            )}
          </p>
        </div>
      </button>
      {item.availability === 'unavailable' ? (
        <Pill tone="bad">Unavailable</Pill>
      ) : (
        <button className="btn primary" disabled={disabled} onClick={onInstall} aria-label={`Install ${item.name}`}>
          Install
        </button>
      )}
    </li>
  );
}

export function EventList({ events }: { events: OperationDto['events'] }) {
  return (
    <ol className="events">
      {events.slice(-8).map((e) => (
        <li key={e.cursor}>
          <span className="muted small">{fmtTime(e.at)}</span> <code>{e.phase}</code> {e.message}
        </li>
      ))}
    </ol>
  );
}

export function Copy({ text }: { text: string }) {
  return (
    <button
      className="btn ghost icon"
      aria-label={`Copy ${text}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
      }}
    >
      ⧉
    </button>
  );
}

// Folder picker: disks and the Harbor data folder as starting points, subfolder navigation, and a
// "new folder" affordance wherever the Harbor service account may create one. Paths can still be typed.
export function FolderPicker({ title, hint, initial, onPick, onClose }: { title: string; hint?: string; initial?: string | null; onPick: (path: string) => void; onClose: () => void }) {
  const [storage, setStorage] = useState<HostStorageDto | null>(null);
  const [listing, setListing] = useState<FolderListingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [typed, setTyped] = useState(initial ?? '');
  const open = (p: string) => {
    setError(null);
    api.folders(p).then(setListing, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    api.hostStorage().then(
      (s) => {
        setStorage(s);
        open(initial || (s.dataFolder.exists ? s.dataFolder.path : '/'));
      },
      (e: Error) => setError(e.message),
    );
  }, [initial]);
  const create = () => {
    if (!listing || !newName.trim()) return;
    api.createFolder(listing.path, newName.trim()).then(
      () => {
        setNewName('');
        open(listing.path);
      },
      (e: Error) => setError(e.message),
    );
  };
  return (
    <Dialog title={title} onClose={onClose} wide>
      {hint && <p className="muted small">{hint}</p>}
      <div className="picker">
        <aside className="picker-side">
          <h4>Places</h4>
          <ul className="plain">
            {storage?.dataFolder && (
              <li>
                <button className="btn ghost place" onClick={() => open(storage.dataFolder.path)}>
                  <span aria-hidden="true">⌂</span> Harbor data folder
                  <span className="muted small">{storage.dataFolder.path}</span>
                </button>
              </li>
            )}
            {storage?.mounts.map((m) => (
              <li key={m.mountpoint}>
                <button className="btn ghost place" onClick={() => open(m.mountpoint)}>
                  <span aria-hidden="true">▣</span> {m.label}
                  <span className="muted small">
                    {m.mountpoint}
                    {m.totalBytes !== null && m.usedBytes !== null ? ` · ${fmtBytes(m.totalBytes - m.usedBytes)} free` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <div className="picker-main">
          {listing && (
            <>
              <div className="row between wrap">
                <div className="row">
                  {listing.parent !== null && (
                    <button className="btn ghost icon" onClick={() => open(listing.parent!)} aria-label="Up one folder">
                      ↑
                    </button>
                  )}
                  <code className="path">{listing.path}</code>
                </div>
                {!listing.writable && listing.path !== '/' && <Pill tone="warn">Harbor cannot create folders here</Pill>}
              </div>
              <ul className="plain folders" aria-label="Folders">
                {listing.entries.map((e) => (
                  <li key={e.path}>
                    <button className="btn ghost folder" onClick={() => open(e.path)} aria-label={`Open folder ${e.name}`}>
                      <span aria-hidden="true">📁</span> {e.name}
                    </button>
                  </li>
                ))}
                {listing.entries.length === 0 && <li className="muted small">No subfolders.</li>}
              </ul>
              {listing.writable && (
                <div className="row wrap new-folder">
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New folder name" aria-label="New folder name" />
                  <button className="btn" onClick={create} disabled={!newName.trim()}>
                    Create folder here
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
          <details>
            <summary className="muted small">Type a path instead</summary>
            <div className="row wrap">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="/mnt/photos" aria-label="Folder path" />
              <button className="btn" onClick={() => typed.trim() && onPick(typed.trim())}>
                Use this path
              </button>
            </div>
          </details>
        </div>
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!listing || listing.path === '/'} onClick={() => listing && onPick(listing.path)} aria-label="Use this folder">
          Use {listing ? listing.path : 'this folder'}
        </button>
      </div>
    </Dialog>
  );
}
