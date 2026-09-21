import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CatalogItemDto, FolderListingDto, HostStorageDto, InstanceSummary, OperationDto } from '../../../src/contracts/api';
import { api } from '../api';
import { fmtBytes, fmtTime, monogram, plainStatus } from './format';

export type CustomIcon = InstanceSummary['customIcon'];
export function AppIcon({ packageId, icon, name, size = 44, custom = null }: { packageId: string; icon: string | null; name: string; size?: number; custom?: CustomIcon }) {
  const cls = size >= 64 ? 'appicon large' : size <= 28 ? 'appicon small' : 'appicon';
  // a picture that fails to load (asset gone, icon file missing) falls back to the monogram instead of a broken image
  const [broken, setBroken] = useState<string | null>(null);
  const src = custom?.kind === 'image' ? custom.url : icon ? `/v1/catalog/${packageId}/asset/${icon}` : null;
  if (custom?.kind === 'glyph')
    return (
      <span className={`${cls} monogram glyph-icon`} aria-hidden="true" style={{ background: custom.color }}>
        {custom.glyph}
      </span>
    );
  if (src && broken !== src) return <img className={cls} src={src} alt="" width={size} height={size} onError={() => setBroken(src)} />;
  return (
    <span className={`${cls} monogram`} aria-hidden="true">
      {monogram(name)}
    </span>
  );
}
// The icon of an installed app, honouring its customisation.
export function InstanceIcon({ inst, size = 44 }: { inst: InstanceSummary; size?: number }) {
  return <AppIcon packageId={inst.packageId} icon={inst.icon} name={inst.packageName} size={size} custom={inst.customIcon} />;
}
// What the launcher calls an app: the custom name, else the package name (plus the instance name when it differs).
export function appLabel(inst: InstanceSummary): string {
  return inst.displayName ?? (inst.name === inst.packageId ? inst.packageName : `${inst.packageName} · ${inst.name}`);
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
            {item.origin === 'local' && <Pill tone="info">Your app{item.version ? ` · ${item.version}` : ''}</Pill>}
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
        // navigator.clipboard needs a secure context; on http://harbor.local fall back to the selection trick
        if (navigator.clipboard && window.isSecureContext) void navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
          } finally {
            ta.remove();
          }
        }
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
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [formatTarget, setFormatTarget] = useState<HostStorageDto['devices'][number] | null>(null);
  const [formatTyped, setFormatTyped] = useState('');
  const open = (p: string) => {
    setError(null);
    api.folders(p).then(setListing, (e: Error) => setError(e.message));
  };
  // A mount is a root oneshot that takes seconds: poll the per-device status
  // until it settles, then reload Places so the row flips by itself.
  // The busy flag is already set by mount() so the button locks instantly
  // on click (no double-submit while the POST is in flight).
  const watchDevice = (name: string) => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api.deviceStatus(name).then(
        (st) => {
          if (st.state === 'mounted' || st.state === 'unmounted' || st.state === 'failed' || tries >= 20) {
            clearInterval(t);
            setBusyDevice(null);
            if (st.state === 'failed') setError(st.message);
            api.hostStorage().then(setStorage, (e: Error) => setError(e.message));
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setError(e.message);
        },
      );
    }, 1500);
  };
  const watchFormat = (name: string) => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api.formatStatus(name).then(
        (st) => {
          if (st.state === 'formatted' || st.state === 'failed' || tries >= 120) {
            clearInterval(t);
            setBusyDevice(null);
            if (st.state === 'failed') setError(st.message);
            api.hostStorage().then(setStorage, (e: Error) => setError(e.message));
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setError(e.message);
        },
      );
    }, 2000);
  };
  const mount = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.mountDevice(name).then(
      () => watchDevice(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  const unmount = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.unmountDevice(name).then(
      () => watchDevice(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  const format = (name: string) => {
    setError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    setFormatTarget(null);
    setFormatTyped('');
    api.formatDevice(name).then(
      () => watchFormat(name),
      (e: Error) => {
        setBusyDevice(null);
        setError(e.message);
      },
    );
  };
  // Filesystems Harbor trusts for whole encrypted apps. Anything else (vfat,
  // exfat, ntfs, …) can still hold plain folders, but needs a format before
  // it can hold an app — so the picker offers Format right where it matters.
  const needsFormatForApps = (fsType: string | null): boolean => {
    if (!fsType) return false;
    return !['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'apfs', 'hfs'].includes(fsType.toLowerCase());
  };
  useEffect(() => {
    api.hostStorage().then(
      (s) => {
        setStorage(s);
        open(initial || (s.dataFolder.exists ? s.dataFolder.path : '/'));
      },
      (e: Error) => setError(e.message),
    );
    // Removable media can appear or vanish while the picker is open: re-read
    // the device list every 5s and drop the selection if its mountpoint is gone.
    const t = setInterval(() => {
      api.hostStorage().then(
        (s) => {
          setStorage(s);
          setListing((cur) => {
            if (!cur) return cur;
            // Still there if it is a known mount, a known device mountpoint,
            // the data folder, the root, or a subfolder of any of those (for
            // example /mnt/usb20fd/immich inside the mounted drive — the old
            // exact-match check kicked the user back to /srv/harbor here).
            const roots = [...s.mounts.map((m) => m.mountpoint), ...s.devices.flatMap((d) => (d.mountpoint ? [d.mountpoint] : [])), s.dataFolder.path, '/'];
            const stillThere = roots.some((r) => cur.path === r || (r !== '/' && cur.path.startsWith(r + '/')));
            if (!stillThere) {
              setError('That folder is no longer available (the drive was removed).');
              open(s.dataFolder.exists ? s.dataFolder.path : '/');
              return cur;
            }
            return cur;
          });
        },
        (e: Error) => setError(e.message),
      );
    }, 5000);
    return () => clearInterval(t);
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
            {(storage?.devices.length ?? 0) > 0 && (
              <li aria-hidden="true">
                <h4 className="muted small">Removable</h4>
              </li>
            )}
            {storage?.devices.map((d) => (
              <li key={d.device}>
                {d.mounted && d.mountpoint ? (
                  <span className="place-row">
                    <button className="btn ghost place" onClick={() => open(d.mountpoint!)}>
                      <span aria-hidden="true">▢</span> {d.label ?? d.name}
                      <span className="muted small">
                        {d.mountpoint} · {d.size}
                        {d.fsType ? ` · ${d.fsType}` : ''}
                        {needsFormatForApps(d.fsType) && ' · needs formatting for apps'}
                      </span>
                    </button>
                    <span className="row">
                      <button
                        className="btn small ghost"
                        disabled={busyDevice !== null}
                        onClick={() => unmount(d.name)}
                        aria-label={busyDevice === d.name ? `Ejecting ${d.label ?? d.name}` : `Eject ${d.label ?? d.name}`}
                        aria-busy={busyDevice === d.name}
                      >
                        {busyDevice === d.name ? (
                          <>
                            <span className="spin" aria-hidden="true" /> Ejecting…
                          </>
                        ) : (
                          'Eject'
                        )}
                      </button>
                      {needsFormatForApps(d.fsType) && (
                        <button
                          className="btn small danger"
                          disabled={busyDevice !== null}
                          onClick={() => (setFormatTyped(''), setFormatTarget(d))}
                          aria-label={`Format ${d.label ?? d.name} as ext4`}
                        >
                          Format…
                        </button>
                      )}
                    </span>
                  </span>
                ) : (
                  <span className="place-row">
                    <span className="btn ghost place" aria-disabled="true" title="Inserted but not mounted">
                      <span aria-hidden="true">▢</span> {d.label ?? d.name}
                      <span className="muted small">
                        {d.size}
                        {d.fsType ? ` · ${d.fsType}` : ''} · not mounted
                        {needsFormatForApps(d.fsType) && ' · needs formatting for apps'}
                      </span>
                    </span>
                    {needsFormatForApps(d.fsType) ? (
                      <button
                        className="btn small danger"
                        disabled={busyDevice !== null}
                        onClick={() => (setFormatTyped(''), setFormatTarget(d))}
                        aria-label={busyDevice === d.name ? `Formatting ${d.label ?? d.name}` : `Format ${d.label ?? d.name} as ext4`}
                        aria-busy={busyDevice === d.name}
                      >
                        {busyDevice === d.name ? (
                          <>
                            <span className="spin" aria-hidden="true" /> Formatting…
                          </>
                        ) : (
                          'Format…'
                        )}
                      </button>
                    ) : (
                      <button
                        className="btn small"
                        disabled={busyDevice !== null}
                        onClick={() => mount(d.name)}
                        aria-label={busyDevice === d.name ? `Mounting ${d.label ?? d.name}` : `Mount ${d.label ?? d.name}`}
                        aria-busy={busyDevice === d.name}
                      >
                        {busyDevice === d.name ? (
                          <>
                            <span className="spin" aria-hidden="true" /> Mounting…
                          </>
                        ) : (
                          'Mount'
                        )}
                      </button>
                    )}
                  </span>
                )}
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
                {listing.entries
                  .filter((e) => e.name !== 'System Volume Information' || listing.entries.length === 1)
                  .map((e) => (
                    <li key={e.path}>
                      <button className="btn ghost folder" onClick={() => open(e.path)} aria-label={`Open folder ${e.name}`}>
                        <span aria-hidden="true">📁</span> {e.name}
                      </button>
                    </li>
                  ))}
                {listing.entries.length === 0 && <li className="muted small">Empty — create a folder below, or pick this one.</li>}
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
      {formatTarget && (
        <Dialog title={`Format ${formatTarget.label ?? formatTarget.name} as ext4?`} onClose={() => setFormatTarget(null)}>
          <p>
            This <strong>erases everything</strong> on {formatTarget.device} ({formatTarget.size}
            {formatTarget.fsType ? `, currently ${formatTarget.fsType}` : ''}) and formats it as ext4 so Harbor can install encrypted apps on it. The drive is remounted at its usual place afterwards.
          </p>
          <p className="muted small">Harbor only formats removable drives — never the system disk. Formatting is refused while an app uses the drive.</p>
          <label className="small">
            <span>
              Type <code>{formatTarget.name}</code> to confirm
            </span>
            <input value={formatTyped} onChange={(e) => setFormatTyped(e.target.value)} aria-label={`Type ${formatTarget.name} to confirm`} autoComplete="off" />
          </label>
          <div className="row end">
            <button className="btn" onClick={() => setFormatTarget(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              disabled={formatTyped.trim() !== formatTarget.name}
              onClick={() => format(formatTarget.name)}
            >
              Format (erase everything)
            </button>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

// The address to open an app at, from where this page was opened: the tailnet/public address when it is
// primary, else the LAN address with the host the browser used (mDNS name or IP), else loopback.
export function openUrl(inst: InstanceSummary, endpoint = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0]): string | null {
  if (!endpoint) return null;
  const primary = endpoint.urls[endpoint.primary as keyof typeof endpoint.urls];
  if (primary && endpoint.primary !== 'loopback') return primary;
  const here = location.hostname;
  if (here !== 'localhost' && here !== '127.0.0.1' && here !== '[::1]') {
    if (endpoint.urls.lan) {
      try {
        const u = new URL(endpoint.urls.lan);
        u.hostname = here;
        return u.toString();
      } catch {
        return endpoint.urls.lan;
      }
    }
  }
  return endpoint.urls.loopback;
}
