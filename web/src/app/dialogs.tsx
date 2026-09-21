import { useEffect, useRef, useState } from 'react';
import type { DomainsDto, HostStorageDto } from '../../../src/contracts/api';
import type { CatalogItemDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, PackageImportResultDto, PlanDto, PlatformToolDto } from '../../../src/contracts/api';
import { ApiError, api } from '../api';
import { AppIcon, Copy, Dialog, EventList, FolderPicker, InstanceIcon, Pill, StatusPill, appLabel, openUrl } from './components';
import { categoryLabel, fmtBytes, fmtTime } from './format';
import type { Action, Console } from './store';

// Step 2 of every wizard: review the server-side plan, approve, then the tray takes over.
export function PlanDialog({ c }: { c: Console }) {
  const { pending, plan, planError } = c;
  if (!pending) return null;
  const title = plan ? `Review ${verb(plan.kind)}` : `Planning ${verb(pending.kind)}…`;
  const appName = plan ? (c.data.catalog.find((i) => i.id === plan.packageId)?.name ?? plan.name) : '';
  const displayName = plan ? (plan.name === plan.packageId ? appName : `${appName} (${plan.name})`) : '';
  const approveLabel = !plan ? '…' : plan.kind === 'remove' ? 'Remove (keep data)' : plan.kind === 'purge' ? 'Delete everything' : plan.kind === 'install' ? 'Install' : plan.kind === 'update' ? 'Update now' : plan.kind === 'expose' ? 'Publish' : plan.kind === 'unexpose' ? 'Withdraw' : plan.kind === 'reconfigure' ? 'Switch' : capitalize(plan.kind);
  return (
    <Dialog title={title} onClose={c.cancel}>
      {planError && (
        <p className="error" role="alert">
          {planError}
        </p>
      )}
      {plan && (
        <div className="plan">
          <p className="lead">{humanSummary(plan, displayName)}</p>
          <ul className="plain facts-list">
            {plan.endpoints.length > 0 && plan.kind === 'install' && (
              <li>
                <span className="fact-k">Address</span>
                <span>{plan.endpoints.map((e) => e.browserUrl).join(', ')} <span className="muted small">(this machine only, until you publish)</span></span>
              </li>
            )}
            {plan.location && (
              <li>
                <span className="fact-k">Lives on</span>
                <span>
                  <code>{plan.location.dir}</code> <span className="muted small">(whole app, encrypted — the passphrase unlocks it on any Harbor machine)</span>
                </span>
              </li>
            )}
            {plan.storage.length > 0 && (
              <li>
                <span className="fact-k">Data</span>
                <span>
                  {plan.storage.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 ? ', ' : ''}
                      {s.mode === 'external' ? (
                        <>
                          your folder <code>{s.hostPath}</code>
                          {s.readOnly ? ' (read-only)' : ''}
                        </>
                      ) : s.mode === 'home' ? (
                        <>
                          {s.purpose || s.id} on the drive <span className="muted small">(encrypted with the app)</span>
                        </>
                      ) : (
                        `${s.purpose || s.id} in a retained volume${s.state === 'existing' ? ' (kept from before)' : ''}`
                      )}
                    </span>
                  ))}
                  <span className="muted small"> · Harbor never deletes data</span>
                </span>
              </li>
            )}
            {plan.secrets.length > 0 && (
              <li>
                <span className="fact-k">Secrets</span>
                <span>
                  {plan.secrets.length} generated for the app{plan.secrets.some((s) => s.state === 'existing') ? ' (existing ones kept)' : ''} <span className="muted small">· never shown</span>
                </span>
              </li>
            )}
            {plan.update && (
              <li>
                <span className="fact-k">Changes</span>
                <span>
                  {plan.update.images.length ? `${plan.update.images.length} image${plan.update.images.length === 1 ? '' : 's'} change` : 'Same images, new package files'}
                  {plan.update.newSecrets.length ? ` · ${plan.update.newSecrets.length} new secret${plan.update.newSecrets.length === 1 ? '' : 's'}` : ''}
                  {plan.update.newStorage.length ? ` · new storage: ${plan.update.newStorage.join(', ')}` : ''}
                  {plan.update.newEndpoints.length ? ` · new address${plan.update.newEndpoints.length === 1 ? '' : 'es'}: ${plan.update.newEndpoints.join(', ')}` : ''}
                  {plan.update.releaseNotes ? <span className="muted small"> · {plan.update.releaseNotes}</span> : null}
                </span>
              </li>
            )}
            {plan.exposure && (
              <li>
                <span className="fact-k">Address</span>
                <span>
                  <a href={plan.exposure.url} target="_blank" rel="noopener noreferrer">
                    {plan.exposure.url}
                  </a>{' '}
                  via {plan.exposure.via === 'tailnet' ? 'your tailnet' : 'the public internet'}
                  {plan.exposure.protection === 'basic' ? ', behind a generated password' : ''}
                  {plan.exposure.makePrimary ? '; becomes the address the app uses for itself' : ''}
                </span>
              </li>
            )}
          </ul>
          {plan.warnings.map((w, i) => (
            <p key={i} className="warn">
              {w}
            </p>
          ))}
          {plan.kind === 'remove' && <p className="warn">Containers and the private network are deleted. Data, secrets, the name and its ports are kept, so Reinstall brings it back as it was.</p>}
          <details>
            <summary className="muted small">Exactly what Harbor will do ({plan.changes.length} steps)</summary>
            <ul className="steps">
              {plan.changes.map((ch, i) => (
                <li key={i}>{ch}</li>
              ))}
            </ul>
            <p className="muted small">
              {plan.packageId} rev {plan.revision} · this plan is valid until {fmtTime(plan.expiresAt)}
            </p>
          </details>
        </div>
      )}
      <div className="row end">
        <button className="btn" onClick={c.cancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void c.approve()} disabled={!plan || Boolean(planError)}>
          {approveLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function InstallWizard({ item, busy, installed = 0, onClose, onStart, onRemovePackage }: { item: CatalogItemDto; busy: boolean; installed?: number; onClose: () => void; onStart: (a: Action) => void; onRemovePackage?: () => void }) {
  const [name, setName] = useState('');
  const [gallery, setGallery] = useState(0);
  // storage claim id -> host folder ('' = managed volume)
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null); // claim id being chosen
  const [candidates, setCandidates] = useState<HostStorageDto['installCandidates'] | null>(null);
  const [devices, setDevices] = useState<HostStorageDto['devices']>([]);
  // Two choices only (decision 97): 'local' = encrypted in the Harbor data
  // folder (Harbor's own key, silent unlock); 'external' = encrypted on a
  // removable drive at <mount>/harbor-apps/<package>/<instance> (passphrase).
  const [place, setPlace] = useState<'local' | 'external'>('local');
  const [driveDir, setDriveDir] = useState<string | null>(null); // selected drive candidate dir (<mount>/harbor-apps)
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [formatTarget, setFormatTarget] = useState<HostStorageDto['devices'][number] | null>(null);
  const [formatTyped, setFormatTyped] = useState('');
  const external = item.claims.filter((c) => c.external);
  const missingRequired = external.some((c) => c.external!.required && !(folders[c.id] ?? '').trim());
  const storage = Object.fromEntries(Object.entries(folders).filter(([, v]) => v.trim()).map(([k, v]) => [k, { hostPath: v.trim() }]));
  // The enforced package dir: <candidate>/<packageId>. The home itself
  // (<dir>/<instanceName>) is created at apply time from the planned name,
  // so the instance name is NOT part of the dir (the wizard cannot know the
  // unique -2 suffix before planning). The preview below shows the full home
  // path for honesty; only the package dir is sent.
  const slugName = name.trim() || item.id;
  const dataCandidate = (candidates ?? []).find((cd) => cd.label.startsWith('Harbor data folder')) ?? null;
  const driveCandidate = driveDir !== null ? ((candidates ?? []).find((cd) => cd.dir === driveDir) ?? null) : null;
  const locationDir = place === 'local' ? (dataCandidate ? `${dataCandidate.dir}/${item.id}` : null) : driveCandidate ? `${driveCandidate.dir}/${item.id}` : null;
  const locationHome = locationDir ? `${locationDir}/${slugName}` : null;
  const reloadStorage = () => {
    api.hostStorage().then(
      (s) => {
        setCandidates(s.installCandidates);
        setDevices(s.devices);
      },
      () => setCandidates([]),
    );
  };
  useEffect(() => {
    reloadStorage();
  }, []);
  // Default to the first eligible drive when the operator picks External.
  useEffect(() => {
    if (place !== 'external' || driveDir !== null) return;
    const first = (candidates ?? []).filter((cd) => !cd.label.startsWith('Harbor data folder') && cd.eligible)[0] ?? null;
    if (first) setDriveDir(first.dir);
  }, [place, candidates, driveDir]);
  // A mount/format is a root oneshot that takes seconds: poll the per-device
  // status until it settles, then reload the candidate list so the row flips
  // by itself (an unmounted drive becomes eligible; a formatted one too).
  const watchDevice = (name: string) => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      api.deviceStatus(name).then(
        (st) => {
          if (st.state === 'mounted' || st.state === 'unmounted' || st.state === 'failed' || tries >= 20) {
            clearInterval(t);
            setBusyDevice(null);
            if (st.state === 'failed') setDeviceError(st.message);
            // A fresh mount makes the drive's apps folder selectable: pick it
            // so the wizard continues straight to the passphrase.
            if (st.state === 'mounted' && st.mountpoint) setDriveDir(`${st.mountpoint}/harbor-apps`);
            reloadStorage();
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setDeviceError(e.message);
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
            if (st.state === 'failed') setDeviceError(st.message);
            // Formatting remounts at the usual place: select the now-eligible
            // apps folder (also repairs a bare mountpoint pick like /mnt/usb20fd).
            if (st.state === 'formatted' && st.mountpoint) setDriveDir(`${st.mountpoint}/harbor-apps`);
            reloadStorage();
          }
        },
        (e: Error) => {
          clearInterval(t);
          setBusyDevice(null);
          setDeviceError(e.message);
        },
      );
    }, 2000);
  };
  const mount = (name: string) => {
    setDeviceError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    api.mountDevice(name).then(
      () => watchDevice(name),
      (e: Error) => {
        setBusyDevice(null);
        setDeviceError(e.message);
      },
    );
  };
  const format = (name: string) => {
    setDeviceError(null);
    if (busyDevice) return;
    setBusyDevice(name);
    setFormatTarget(null);
    setFormatTyped('');
    api.formatDevice(name).then(
      () => watchFormat(name),
      (e: Error) => {
        setBusyDevice(null);
        setDeviceError(e.message);
      },
    );
  };
  // An inserted-but-unmounted drive has no candidate row yet (candidates come
  // from mounts): surface it here so the wizard never dead-ends with "no
  // eligible drive". A mounted-but-wrong-filesystem drive already has a
  // disabled row with a Format hint — the button below makes it one click.
  const unmounted = devices.filter((d) => !d.mounted || !d.mountpoint);
  // Local seals with Harbor's own key — no passphrase to type, nothing to
  // remember. A custom passphrase is opt-in (portability on another machine
  // needs it); external drives always need one (portable by nature).
  const [customPass, setCustomPass] = useState(false);
  // Reset the opt-in when the place changes.
  useEffect(() => {
    setCustomPass(false);
  }, [place]);
  const locationMissingPass = place === 'external' ? passphrase.length < 8 : customPass && passphrase.length < 8;
  // Filesystems Harbor trusts for whole encrypted apps. Anything else (ntfs,
  // vfat, exfat, …) can never hold an app — mounting it still leaves the
  // wizard dead-ended, so offer Format instead of Mount/passphrase there.
  const needsFormatForApps = (fsType: string | null): boolean => {
    if (!fsType) return false;
    return !['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'apfs', 'hfs'].includes(fsType.toLowerCase());
  };
  // The chosen drive may use a filesystem Harbor can't use for apps, or may
  // be unmounted: then no passphrase prompt — offer Format/Mount instead,
  // and block Install until the drive qualifies.
  const driveMountpoint = (d: { mountpoint: string | null; label: string | null; name: string }): string | null => {
    if (d.mountpoint) return d.mountpoint;
    const slug = (d.label ?? d.name).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || d.name;
    return `/mnt/${slug}`;
  };
  const locationCandidate = place === 'external' && driveCandidate ? driveCandidate : place === 'local' ? dataCandidate ?? null : null;
  const locationDrive = place === 'external' && driveCandidate ? (devices.find((d) => d.mountpoint && (driveCandidate.dir === `${d.mountpoint}/harbor-apps` || driveCandidate.dir.startsWith(d.mountpoint + '/'))) ?? null) : null;
  // A drive picked by its expected /mnt/<label> path but with no candidate
  // row yet (unmounted, or a fixture mount listMounts cannot see): match by
  // the expected mountpoint. Only truly unmounted devices count here — a
  // mounted device with no candidate row is the fixture-formatted case
  // handled by formattedDrive below, not a mount prompt.
  const unmountedDrive = place === 'external' && driveDir !== null && !locationDrive ? (devices.find((d) => {
    if (d.mounted && d.mountpoint) return false;
    const mp = driveMountpoint(d);
    return mp !== null && driveDir === `${mp}/harbor-apps`;
  }) ?? null) : null;
  // Fixture-formatted case (e2e/dev): the device reports mounted ext4 at its
  // mountpoint, but listMounts cannot see the fake mount so no candidate row
  // exists. Treat it as the selected drive so the passphrase prompt appears
  // (the test proves the wizard continues; a real mount always has a row).
  // Require a known-good filesystem: an unknown (null) fsType must never
  // count as formatted — it would let an NTFS drive through with no row.
  const formattedDrive = place === 'external' && driveDir !== null && !driveCandidate ? (devices.find((d) => d.mounted && d.mountpoint && d.fsType && !needsFormatForApps(d.fsType) && driveDir === `${d.mountpoint}/harbor-apps`) ?? null) : null;
  // Any ineligible candidate blocks Install — wrong filesystem AND
  // not-writable alike. The old check only treated "wrong FS but writable"
  // as needing format, so a non-writable NTFS mount slipped through to the
  // passphrase prompt with Install enabled. A database on NTFS is corruption,
  // not portability, regardless of writability.
  const locationNeedsFormat = Boolean(place === 'external' && ((locationCandidate && !locationCandidate.eligible) || (unmountedDrive && needsFormatForApps(unmountedDrive.fsType))));
  const locationNeedsMount = Boolean(place === 'external' && !locationNeedsFormat && (unmountedDrive || (locationDrive && (!locationDrive.mounted || !locationDrive.mountpoint))));
  const locationFormatDrive = locationDrive ?? unmountedDrive;
  const locationBlocked = place === 'external' && (locationNeedsFormat || locationNeedsMount || (!driveCandidate && !formattedDrive));
  const genPassphrase = () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    setPassphrase(btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'harbor-recovery-key');
  };
  return (
    <Dialog title={item.name} onClose={onClose} wide>
      <div className="app-head">
        <AppIcon packageId={item.id} icon={item.presentation.icon} name={item.name} size={72} />
        <div>
          <p className="lead">{item.presentation.tagline ?? item.description}</p>
          <p className="muted small">
            {categoryLabel(item.presentation.category)}
            {item.presentation.developer ? ` · by ${item.presentation.developer}` : ''}
            {item.presentation.website ? (
              <>
                {' · '}
                <a href={item.presentation.website} target="_blank" rel="noopener noreferrer">
                  website
                </a>
              </>
            ) : null}
            {' · rev '}
            {item.revision}
            {item.version ? ` · version ${item.version}` : ''}
            {item.origin === 'local' ? ' · your own upload' : ` · qualification ${item.qualification}`}
          </p>
        </div>
      </div>
      {item.presentation.gallery.length > 0 && (
        <div className="gallery">
          <img src={`/v1/catalog/${item.id}/asset/${item.presentation.gallery[gallery]}`} alt={`${item.name} screenshot ${gallery + 1}`} />
          {item.presentation.gallery.length > 1 && (
            <div className="row">
              {item.presentation.gallery.map((_, i) => (
                <button key={i} className={`btn ghost ${i === gallery ? 'active' : ''}`} onClick={() => setGallery(i)} aria-label={`Screenshot ${i + 1}`}>
                  {i + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p>{item.description}</p>
      {item.presentation.releaseNotes && <p className="muted small">{item.presentation.releaseNotes}</p>}
      {item.defaultCredentials && <DefaultLogin creds={item.defaultCredentials} />}
      <ul className="facts">
        <li>{item.storage ? `${item.storage} retained data volume${item.storage > 1 ? 's' : ''}` : 'No server-side data'}</li>
        <li>{item.setup ? 'Has its own account setup after install' : 'No account setup needed'}</li>
        <li>Runs on 127.0.0.1 only until you publish it</li>
      </ul>
      {external.length > 0 && (
        <fieldset className="storage-choices">
          <legend>Where should the data live?</legend>
          {external.map((c) => (
            <div key={c.id} className="claim">
              <p className="claim-title">
                <strong>{c.purpose}</strong>
                {c.external!.readOnly && <span className="muted small"> · read-only</span>}
                {c.external!.required && <span className="warn small"> · a folder is required</span>}
              </p>
              {!c.external!.required && (
                <label className="check">
                  <input type="radio" name={`st-${c.id}`} checked={!(c.id in folders)} onChange={() => setFolders(({ [c.id]: _drop, ...rest }) => rest)} /> Managed by Harbor (Docker volume on this machine)
                </label>
              )}
              <label className="check">
                <input type="radio" name={`st-${c.id}`} checked={c.id in folders || Boolean(c.external!.required)} onChange={() => setFolders((f) => ({ ...f, [c.id]: f[c.id] ?? '' }))} /> Use a folder on this machine
              </label>
              {(c.id in folders || c.external!.required) && (
                <div className="folder-choice">
                  <button className="btn" onClick={() => setPicking(c.id)} aria-label={`Choose folder for ${c.purpose}`}>
                    {folders[c.id] ? 'Change folder…' : 'Choose a folder…'}
                  </button>
                  {folders[c.id] ? <code className="path">{folders[c.id]}</code> : <span className="muted small">{c.external!.hint}</span>}
                  <input className="visually-hidden" readOnly value={folders[c.id] ?? ''} aria-label={`Folder for ${c.purpose}`} tabIndex={-1} />
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}
      <fieldset className="storage-choices">
        <legend>Where should the app live?</legend>
        <label className="check">
          <input type="radio" name="loc" checked={place === 'local'} onChange={() => setPlace('local')} /> Local — encrypted on this machine, unlocks silently when you log in
        </label>
        <label className="check">
          <input type="radio" name="loc" checked={place === 'external'} onChange={() => setPlace('external')} /> External drive — encrypted, portable with a passphrase
        </label>
        {place === 'external' && (
          <>
            {(candidates ?? []).filter((cd) => !cd.label.startsWith('Harbor data folder')).map((cd) => {
              // A mounted-but-wrong-filesystem drive carries a disabled
              // (grayed-out) row with a reason: offer Format inline (one
              // click, typed confirm) instead of sending the operator to
              // Settings and back. Formatting is a root oneshot, so it is
              // offered whenever the drive is known — writability of the
              // current (wrong) filesystem is irrelevant.
              const drive = devices.find((d) => d.mountpoint && (cd.dir === `${d.mountpoint}/harbor-apps` || cd.dir.startsWith(`${d.mountpoint}/`)));
              const formattable = !cd.eligible && drive;
              return (
                <label key={cd.dir} className="check" title={cd.eligible ? undefined : (cd.reason ?? 'not available')}>
                  <input type="radio" name="drive" checked={driveDir === cd.dir} disabled={!cd.eligible} onChange={() => setDriveDir(cd.dir)} /> {cd.label}
                  {!cd.eligible && (
                    <span className="muted small">
                      {' '}
                      · {cd.reason}{' '}
                      {formattable ? (
                        <button
                          type="button"
                          className="btn small danger"
                          disabled={busyDevice !== null}
                          onClick={(e) => {
                            e.preventDefault();
                            setFormatTyped('');
                            setFormatTarget(drive!);
                          }}
                          aria-label={busyDevice === drive!.name ? `Formatting ${drive!.label ?? drive!.name}` : `Format ${drive!.label ?? drive!.name} as ext4`}
                          aria-busy={busyDevice === drive!.name}
                        >
                          {busyDevice === drive!.name ? (
                            <>
                              <span className="spin" aria-hidden="true" /> Formatting…
                            </>
                          ) : (
                            'Format as ext4…'
                          )}
                        </button>
                      ) : (
                        <span className="muted small">(format the drive as ext4 in Settings → Storage to use it)</span>
                      )}
                    </span>
                  )}
                </label>
              );
            })}
            {candidates === null && <p className="muted small">Checking drives…</p>}
            {place === 'external' && (candidates ?? []).filter((cd) => !cd.label.startsWith('Harbor data folder')).length === 0 && unmounted.length === 0 && (
              <p className="muted small">No external drive found. Plug one in, or install locally instead.</p>
            )}
          </>
        )}
        {place === 'external' && unmounted.length > 0 && (
          <div className="unmounted-hint">
            {unmounted.map((d) => {
              // A drive on the wrong filesystem can never hold an app even
              // once mounted: offer Format, not Mount, right here.
              const wrongFs = needsFormatForApps(d.fsType);
              return (
                <p key={d.device} className="muted small">
                  {d.label ?? d.name} ({d.size}
                  {d.fsType ? `, ${d.fsType}` : ''}) is plugged in but not mounted.
                  {wrongFs ? ' Format it as ext4 to use it for apps.' : ''}{' '}
                  {wrongFs ? (
                    <button
                      type="button"
                      className="btn small danger"
                      disabled={busyDevice !== null}
                      onClick={() => {
                        setFormatTyped('');
                        setFormatTarget(d);
                      }}
                      aria-label={busyDevice === d.name ? `Formatting ${d.label ?? d.name}` : `Format ${d.label ?? d.name} as ext4`}
                      aria-busy={busyDevice === d.name}
                    >
                      {busyDevice === d.name ? (
                        <>
                          <span className="spin" aria-hidden="true" /> Formatting…
                        </>
                      ) : (
                        'Format as ext4…'
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
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
                        'Mount it'
                      )}
                    </button>
                  )}
                </p>
              );
            })}
          </div>
        )}
        {deviceError && (
          <p className="error small" role="alert">
            {deviceError}
          </p>
        )}
        {place === 'local' && (
          <div className="folder-choice">
            <code className="path">{locationHome ?? '…'}</code>
            <>
              <p className="muted small">The whole app (including its database) is installed encrypted here. Harbor unlocks it silently when you log in — nothing to remember, nothing to type.</p>
              {!customPass ? (
                <p className="muted small">
                  <button className="btn ghost" type="button" onClick={() => setCustomPass(true)}>
                    Use my own passphrase instead…
                  </button>
                </p>
              ) : (
                <label className="small">
                  Encryption passphrase (8+ characters) — write it down; losing it loses the data. Needed only to open this app on another Harbor machine.
                  <span className="row">
                    <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type={showPass ? 'text' : 'password'} autoComplete="new-password" aria-label="Encryption passphrase for this app" placeholder="correct horse battery staple" />
                    <button className="btn ghost" type="button" onClick={() => setShowPass(!showPass)} aria-label={showPass ? 'Hide passphrase' : 'Show passphrase'}>
                      {showPass ? 'Hide' : 'Show'}
                    </button>
                    <button className="btn ghost" type="button" onClick={genPassphrase} aria-label="Generate a recovery key">
                      Generate
                    </button>
                  </span>
                </label>
              )}
            </>
          </div>
        )}
        {place === 'external' && locationNeedsFormat && (
          <div className="folder-choice">
            <code className="path">{locationHome ?? '…'}</code>
            <p className="warn small" role="alert">
              This drive{(locationFormatDrive as { fsType?: string | null } | null)?.fsType ? ` is ${(locationFormatDrive as { fsType?: string | null }).fsType}` : ''} — apps need ext4 (or btrfs, xfs, zfs, apfs). Formatting erases everything on it.
            </p>
            {locationFormatDrive ? (
              <button
                type="button"
                className="btn small danger"
                disabled={busyDevice !== null}
                onClick={() => {
                  setFormatTyped('');
                  setFormatTarget(locationFormatDrive);
                }}
                aria-label={busyDevice === locationFormatDrive.name ? `Formatting ${locationFormatDrive.label ?? locationFormatDrive.name}` : `Format ${locationFormatDrive.label ?? locationFormatDrive.name} as ext4`}
                aria-busy={busyDevice === locationFormatDrive.name}
              >
                {busyDevice === locationFormatDrive.name ? (
                  <>
                    <span className="spin" aria-hidden="true" /> Formatting…
                  </>
                ) : (
                  'Format as ext4…'
                )}
              </button>
            ) : (
              <span className="muted small">Format the drive as ext4 in Settings → Storage to use it.</span>
            )}
          </div>
        )}
        {place === 'external' && !locationNeedsFormat && locationNeedsMount && (locationDrive ?? unmountedDrive) && (
          <div className="folder-choice">
            <code className="path">{locationHome ?? '…'}</code>
            <p className="warn small" role="alert">
              {(locationDrive ?? unmountedDrive)!.label ?? (locationDrive ?? unmountedDrive)!.name} is plugged in but not mounted — mount it before installing, or pick another drive.
            </p>
            <button
              type="button"
              className="btn small"
              disabled={busyDevice !== null}
              onClick={() => mount((locationDrive ?? unmountedDrive)!.name)}
              aria-label={busyDevice === (locationDrive ?? unmountedDrive)!.name ? `Mounting ${(locationDrive ?? unmountedDrive)!.label ?? (locationDrive ?? unmountedDrive)!.name}` : `Mount ${(locationDrive ?? unmountedDrive)!.label ?? (locationDrive ?? unmountedDrive)!.name}`}
              aria-busy={busyDevice === (locationDrive ?? unmountedDrive)!.name}
            >
              {busyDevice === (locationDrive ?? unmountedDrive)!.name ? (
                <>
                  <span className="spin" aria-hidden="true" /> Mounting…
                </>
              ) : (
                'Mount it'
              )}
            </button>
          </div>
        )}
        {place === 'external' && !locationNeedsFormat && !locationNeedsMount && (driveCandidate ?? formattedDrive) && (
          <div className="folder-choice">
            <code className="path">{locationHome ?? (formattedDrive && driveDir ? `${driveDir}/${item.id}/${slugName}` : '…')}</code>
            <>
              <p className="muted small">The whole app (including its database) is installed encrypted here. Unplug the drive and the app stops; the passphrase unlocks it on any Harbor machine.</p>
              <label className="small">
                Encryption passphrase (8+ characters) — write it down; losing it loses the data
                <span className="row">
                  <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type={showPass ? 'text' : 'password'} autoComplete="new-password" aria-label="Encryption passphrase for this app" placeholder="correct horse battery staple" />
                  <button className="btn ghost" type="button" onClick={() => setShowPass(!showPass)} aria-label={showPass ? 'Hide passphrase' : 'Show passphrase'}>
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                  <button className="btn ghost" type="button" onClick={genPassphrase} aria-label="Generate a recovery key">
                    Generate
                  </button>
                </span>
              </label>
            </>
          </div>
        )}
      </fieldset>
      <label className="small">
        Instance name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z][a-z0-9-]{0,62}" placeholder={item.id} aria-label={`Instance name for ${item.name}`} />
      </label>
      {item.origin === 'local' && onRemovePackage && (
        <p className="muted small">
          This package was uploaded to this Harbor.{' '}
          {installed > 0 ? (
            'Uninstall its apps completely before removing it.'
          ) : (
            <button className="btn ghost danger" onClick={onRemovePackage} aria-label={`Remove package ${item.name}`}>
              Remove package
            </button>
          )}
        </p>
      )}
      {picking && (
        <FolderPicker
          title={`Folder for ${external.find((c) => c.id === picking)?.purpose ?? 'this app'}`}
          hint={external.find((c) => c.id === picking)?.external?.hint}
          initial={folders[picking] || null}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            setFolders((f) => ({ ...f, [picking]: p }));
            setPicking(null);
          }}
        />
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button
          className="btn primary"
          disabled={busy || item.availability !== 'available' || missingRequired || locationMissingPass || locationBlocked || (place === 'local' && !locationDir) || (place === 'external' && !locationDir && !formattedDrive)}
          onClick={() => onStart({ kind: 'install', packageId: item.id, name: name.trim(), storage, ...(locationDir ? (place === 'local' && !customPass ? { location: { dir: locationDir } } : { location: { dir: locationDir, passphrase } }) : formattedDrive && driveDir ? { location: { dir: `${driveDir}/${item.id}`, passphrase } } : {}) })}
          aria-label={`Install ${item.name} now`}
          title={locationBlocked ? (locationNeedsFormat ? 'This drive needs formatting as ext4 first' : 'Mount the drive before installing') : locationMissingPass ? 'The encryption passphrase needs 8+ characters' : undefined}
        >
          Install
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

export function PublishWizard({ inst, exposures, tools, onClose, onStart }: { inst: InstanceSummary; exposures: ExposureDto[]; tools: PlatformToolDto[]; onClose: () => void; onStart: (a: Action) => void }) {
  const [via, setVia] = useState<'tailnet' | 'public'>('tailnet');
  const [hostname, setHostname] = useState('');
  const [domains, setDomains] = useState<DomainsDto | null>(null);
  const [customHost, setCustomHost] = useState(false);
  useEffect(() => {
    api.domains().then(setDomains, () => setDomains(null));
  }, []);
  const freeDomains = (domains?.items ?? []).filter((d) => !d.usedBy);
  const [protection, setProtection] = useState<'none' | 'basic'>('basic');
  const [makePrimary, setMakePrimary] = useState(false);
  const ts = tools.find((t) => t.id === 'tailscale');
  const px = tools.find((t) => t.id === 'proxy');
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const has = (v: 'tailnet' | 'public') => exposures.some((e) => e.via === v);
  const providerOk = via === 'tailnet' ? ts?.installationState === 'installed' : px?.installationState === 'installed';
  return (
    <Dialog title={`Publish ${inst.name}`} onClose={onClose}>
      <p className="muted small">The app keeps listening on 127.0.0.1. Publishing adds an HTTPS address in front of the same port.</p>
      <ul className="plain">
        {exposures.map((e) => (
          <li key={e.id} className="row between">
            <span>
              <Pill tone="info">{e.via}</Pill>{' '}
              <a href={e.url} target="_blank" rel="noopener noreferrer">
                {e.url}
              </a>{' '}
              <Pill tone={e.state === 'active' ? 'ok' : e.state === 'degraded' ? 'warn' : 'busy'}>{e.state}</Pill>
              {e.isPrimary && <span className="muted small"> primary</span>}
              {e.note && <span className="muted small"> · {e.note}</span>}
            </span>
            <span className="row">
              {!e.isPrimary && e.state === 'active' && (
                <button className="btn ghost" onClick={() => onStart({ kind: 'reconfigure', instance: inst, primary: e.via })}>
                  Make primary
                </button>
              )}
              <button className="btn danger" onClick={() => onStart({ kind: 'unexpose', instance: inst, via: e.via })} aria-label={`Withdraw ${e.via} address`}>
                Withdraw
              </button>
            </span>
          </li>
        ))}
        {primary && primary.primary !== 'loopback' && (
          <li className="row between">
            <span>
              <Pill tone="muted">loopback</Pill> {primary.urls.loopback}
            </span>
            <button className="btn ghost" onClick={() => onStart({ kind: 'reconfigure', instance: inst, primary: 'loopback' })}>
              Make primary
            </button>
          </li>
        )}
      </ul>
      <h3>Add an address</h3>
      <div className="row wrap">
        <label className="check">
          <input type="radio" name="via" checked={via === 'tailnet'} onChange={() => setVia('tailnet')} /> Tailnet (private{ts?.facts?.['dnsName'] ? `, ${String(ts.facts['dnsName'])}` : ''})
        </label>
        <label className="check">
          <input type="radio" name="via" checked={via === 'public'} onChange={() => setVia('public')} /> Public (Caddy, Let&apos;s Encrypt)
        </label>
      </div>
      {!providerOk && <p className="warn">{via === 'tailnet' ? ts?.note ?? 'Tailscale is not set up.' : px?.note ?? 'The public proxy is not set up.'}</p>}
      {via === 'public' && (
        <>
          {freeDomains.length > 0 && !customHost ? (
            <label className="small">
              Domain (registered under Settings → Public addresses)
              <select value={hostname} onChange={(e) => (e.target.value === '__other' ? (setCustomHost(true), setHostname('')) : setHostname(e.target.value))} aria-label="Domain">
                <option value="">Choose a domain…</option>
                {freeDomains.map((d) => (
                  <option key={d.hostname} value={d.hostname}>
                    {d.hostname} — {d.dns.state === 'points_here' ? 'points here ✓' : d.dns.state === 'no_record' ? 'no DNS record yet' : d.dns.state === 'points_elsewhere' ? 'points elsewhere' : 'not checked'}
                  </option>
                ))}
                <option value="__other">Another hostname…</option>
              </select>
            </label>
          ) : (
            <label className="small">
              Hostname you control (its DNS record must point at this machine)
              <input value={hostname} onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} placeholder="app.example.com" />
              <span className="muted small">
                Tip: register it under <a href="#/settings/public">Settings → Public addresses</a> first and Harbor checks the DNS for you.
              </span>
            </label>
          )}
          <p className="muted small">The HTTPS certificate comes from Let's Encrypt automatically once the domain points here; nothing to upload.</p>
          <label className="small">
            Protection
            <select value={protection} onChange={(e) => setProtection(e.target.value as 'none' | 'basic')}>
              <option value="basic">Basic auth (generated credentials, shown once)</option>
              <option value="none">None (the app&apos;s own login only)</option>
            </select>
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={makePrimary} onChange={(e) => setMakePrimary(e.target.checked)} /> make it the primary address (apps that embed their URL are reconfigured)
      </label>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" disabled={!providerOk || has(via) || (via === 'public' && !hostname)} onClick={() => onStart({ kind: 'expose', instance: inst, via, hostname, protection, makePrimary })}>
          {has(via) ? `Already published via ${via}` : 'Publish'}
        </button>
      </div>
    </Dialog>
  );
}

export function AppDrawer({ inst, exposures, busy, onClose, onAction, onPublish, onCustomize }: { inst: InstanceSummary; exposures: ExposureDto[]; busy: boolean; onClose: () => void; onAction: (a: Action) => void; onPublish: () => void; onCustomize: () => void }) {
  const upd = inst.updateAvailable;
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState('');
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(inst.autoUpdate);
  const [adopting, setAdopting] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState<string | null>(null);
  useEffect(() => setAutoUpdate(inst.autoUpdate), [inst.id, inst.autoUpdate]);
  useEffect(() => {
    let live = true;
    const load = () => api.instance(inst.id).then((d) => live && (setDetail(d), setAdoptMsg(null)), (e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [inst.id]);
  const need = detail?.needsDrive ?? inst.needsDrive;
  const home = detail?.home ?? inst.home;
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const retained = inst.installState === 'retained';
  const locked = home?.state === 'locked';
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && !need && !locked;
  const canStop = (inst.installState === 'installed' || inst.installState === 'needs_action' || inst.installState === 'failed') && inst.runtime !== 'stopped';
  const canStart = inst.installState === 'installed' && inst.desired === 'stopped' && !need;
  return (
    <Dialog title={appLabel(inst)} onClose={onClose} wide>
      <div className="app-head">
        <InstanceIcon inst={inst} size={72} />
        <div>
          <p className="lead">
            {inst.packageName} <span className="muted small">· {inst.name} · rev {inst.revision}</span>
          </p>
          <StatusPill inst={inst} />
          <span className="muted small"> · observed {fmtTime(inst.observedAt)}</span>
          {inst.usage && (
            <p className="muted small" aria-label="Resource usage">
              CPU {inst.usage.cpuPercent}% · {fmtBytes(inst.usage.memoryBytes)} memory
            </p>
          )}
        </div>
      </div>
      {locked && !retained && (
        <div className="update-banner needs-drive" role="status">
          <div>
            <strong>Locked</strong>
            <p className="muted small">
              This app lives encrypted at <code className="path">{home!.path}</code>.{' '}
              {home!.defaultKey ? (
                <>This machine cannot read it yet — log in again to unlock it silently.</>
              ) : (
                <>This machine cannot read it yet — log in again to unlock with this machine&apos;s key, or adopt it with the app passphrase on a new machine.</>
              )}
            </p>
          </div>
        </div>
      )}
      {need && !retained && (
        <div className="update-banner needs-drive" role="alert">
          <div>
            <strong>Needs its drive</strong>
            <p className="muted small">
              <code className="path">{need.path}</code> ({need.purpose}) is not the folder this app was using: {need.detail} Re-insert the drive or restore the folder with its marker at the same path, then start the app.
            </p>
          </div>
          <div className="row wrap">
            <button
              className="btn"
              disabled={busy || adopting || inst.runtime === 'running' || inst.runtime === 'starting'}
              onClick={() => {
                setAdopting(true);
                setAdoptMsg(null);
                void api
                  .adoptDrive(inst.id, need.purpose)
                  .then(() => setAdoptMsg('Folder accepted as the new home. You can start the app now.'))
                  .catch((e: Error) => setAdoptMsg(e.message))
                  .finally(() => setAdopting(false));
              }}
              aria-label={`Accept the current folder as the new home for ${inst.name}`}
              title={inst.runtime === 'running' || inst.runtime === 'starting' ? 'Stop the app first' : 'Stamp the current folder with a new identity and use it from now on'}
            >
              {adopting ? 'Accepting…' : 'Use this folder instead'}
            </button>
          </div>
          {adoptMsg && (
            <p className="small" role="status">
              {adoptMsg}
            </p>
          )}
        </div>
      )}
      {upd && !retained && (
        <div className="update-banner" role="status">
          <div>
            <strong>Update available</strong>
            <span className="muted small">
              {' '}
              revision {inst.revision} → {upd.revision}
              {upd.version ? ` (${upd.version})` : ''}
              {upd.releaseNotes ? ` · ${upd.releaseNotes}` : ''}
            </span>
            <p className="muted small">Your data, addresses and ports stay. If the new version does not start, Harbor puts the current one back.</p>
          </div>
          <button className="btn primary" disabled={busy || inst.installState !== 'installed'} onClick={() => onAction({ kind: 'update', instance: inst })} aria-label={`Update ${inst.name}`}>
            Update
          </button>
        </div>
      )}
      {!retained && inst.installState === 'installed' && (
        <label className="row auto-upd">
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => {
              setAutoUpdate(e.target.checked); // optimistic; the poll corrects on failure
              void api.setAutoUpdate(inst.id, e.target.checked).catch(() => setAutoUpdate(!e.target.checked));
            }}
            aria-label={`Automatic updates for ${inst.name}`}
          />
          <span className="muted small">Update this app automatically when a new version arrives (rolls back if it does not start)</span>
        </label>
      )}
      <div className="row wrap actions">
        {canOpen && primary && (
          <a className="btn primary" href={openUrl(inst) ?? primary.urls.loopback} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`}>
            Open
          </a>
        )}
        {canOpen && (
          <button className="btn" disabled={busy} onClick={onPublish} aria-label={`Publish ${inst.name}`}>
            Publish…
          </button>
        )}
        {!retained && (
          <button className="btn" onClick={onCustomize} aria-label={`Customize ${inst.name}`}>
            Customize…
          </button>
        )}
        {canStart && (
          <button className="btn" disabled={busy} onClick={() => onAction({ kind: 'start', instance: inst })} aria-label={`Start ${inst.name}`}>
            Start
          </button>
        )}
        {canStop && inst.installState !== 'installing' && (
          <button className="btn" disabled={busy} onClick={() => onAction({ kind: 'stop', instance: inst })} aria-label={`Stop ${inst.name}`}>
            Stop
          </button>
        )}
        {!retained && inst.installState !== 'installing' && (
          <button className="btn danger" disabled={busy} onClick={() => onAction({ kind: 'remove', instance: inst })} aria-label={`Remove ${inst.name}`}>
            Remove
          </button>
        )}
        {retained && inst.hasRetainedData && (
          <button className="btn" disabled={busy} onClick={() => onAction({ kind: 'reinstall', instance: inst })} aria-label={`Reinstall ${inst.name}`}>
            Reinstall
          </button>
        )}
      </div>
      {primary && !retained && (
        <>
          <h4>Addresses</h4>
          <ul className="addresses">
            {(['loopback', 'tailnet', 'public'] as const).map((via) => {
              const url = primary.urls[via];
              if (!url) return null;
              const ex = exposures.find((e) => e.via === via);
              return (
                <li key={via}>
                  <Pill tone={via === 'loopback' ? 'muted' : ex?.state === 'active' ? 'ok' : ex?.state === 'degraded' ? 'warn' : 'busy'}>{via}</Pill>{' '}
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
                  <Copy text={url} />
                  {primary.primary === via && <span className="muted small"> primary</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {detail?.defaultCredentials && !retained && <DefaultLogin creds={detail.defaultCredentials} />}
      {retained && <p className="muted">Removed. Data volumes and secrets are retained; Reinstall restores the exact same release.</p>}
      {inst.installState !== 'installing' && (
        <details className="danger-zone" open={purgeOpen} onToggle={(e) => setPurgeOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="small">Uninstall completely…</summary>
          <p className="small">
            Deletes {inst.packageName}'s containers, <strong>its data</strong>, secrets and stored release, and frees the name. Folders of yours stay untouched. There is no undo.
          </p>
          <label className="small">
            <span>
              Type <code>{inst.name}</code> to confirm
            </span>
            <input value={confirmPurge} onChange={(e) => setConfirmPurge(e.target.value)} aria-label={`Type ${inst.name} to confirm`} autoComplete="off" />
          </label>
          <button className="btn danger" disabled={busy || confirmPurge.trim() !== inst.name} onClick={() => onAction({ kind: 'purge', instance: inst })} aria-label={`Uninstall ${inst.name} completely`}>
            Delete app and its data
          </button>
        </details>
      )}
      {error && <p className="error">{error}</p>}
      {detail && (
        <>
          {detail.setup && (
            <p className="setup">
              <strong>Finish setup inside the app:</strong> {detail.setup.instructions}{' '}
              <a href={detail.setup.browserUrl} target="_blank" rel="noopener noreferrer">
                Open {inst.name}
              </a>
              <br />
              <span className="muted small">Harbor did not create any account in this application; a green status only means it answers HTTP.</span>
            </p>
          )}
          {detail.lastError && (
            <p className="error">
              {detail.lastError.code}: {detail.lastError.message}
              <br />
              <span className="muted">Next: {detail.lastError.nextAction}</span>
            </p>
          )}
          <details>
            <summary>Technical details</summary>
            <dl className="kv">
              <dt>Install</dt>
              <dd>{inst.installState}</dd>
              <dt>Desired</dt>
              <dd>{inst.desired}</dd>
              <dt>Runtime</dt>
              <dd>{inst.runtime}</dd>
              <dt>Readiness</dt>
              <dd>{inst.readiness}</dd>
              <dt>Instance id</dt>
              <dd>
                <code>{inst.id}</code>
              </dd>
            </dl>
            <h4>Owned resources</h4>
            <ul>
              {detail.resources.map((r) => (
                <li key={`${r.kind}-${r.role}`}>
                  <code>{r.kind}</code> {r.role}: {r.name} {r.present === null ? '(unknown)' : r.present ? '' : '(absent)'}
                </li>
              ))}
              {detail.resources.length === 0 && <li className="muted">none recorded</li>}
            </ul>
            <h4>Recent events</h4>
            <EventList events={detail.events.slice(-10) as OperationDto['events']} />
          </details>
        </>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function humanSummary(plan: PlanDto, n: string): string {
  switch (plan.kind) {
    case 'install':
      return plan.location
        ? `Harbor will install ${n} encrypted at ${plan.location.dir}. It usually takes a minute or two (the first time includes downloading the app).`
        : `Harbor will install ${n} on this machine. It usually takes a minute or two (the first time includes downloading the app).`;
    case 'start':
      return `Harbor will start ${n} again with the same data and address.`;
    case 'stop':
      return `Harbor will stop ${n}. Nothing is deleted; Start brings it back.`;
    case 'remove':
      return `Harbor will remove ${n} but keep its data.`;
    case 'reinstall':
      return `Harbor will reinstall ${n} from the exact same release and reconnect its kept data.`;
    case 'expose':
      return `Harbor will publish ${n} at a new address. The app keeps running where it is.`;
    case 'unexpose':
      return `Harbor will withdraw one address of ${n}. The app itself is untouched.`;
    case 'reconfigure':
      return `Harbor will switch which address ${n} treats as its own, then restart it with the same data.`;
    case 'purge':
      return `Harbor will uninstall ${n} completely: containers, its data volumes, secrets and stored release. Folders of yours are left alone. This cannot be undone.`;
    case 'update':
      return `Harbor will update ${n} to revision ${plan.update?.toRevision ?? plan.revision}${plan.update?.toVersion ? ` (${plan.update.toVersion})` : ''}. Data, ports and addresses stay; if the new release does not start, the previous one is put back automatically.`;
  }
}

function verb(kind: PlanDto['kind']): string {
  return { install: 'install', start: 'start', stop: 'stop', remove: 'removal', reinstall: 'reinstall', purge: 'full uninstall', update: 'update', expose: 'publishing', unexpose: 'withdrawal', reconfigure: 'address switch' }[kind];
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Customize how an app looks on the launcher: its name and icon. Saved on the daemon, so every device sees it.
const GLYPHS = ['📷', '🎬', '🎵', '📁', '☁️', '📝', '💬', '🔐', '🏠', '📚', '🧠', '⚡', '🛠', '🌐', '📈', '🎨', '🎮', '🧭'];
const COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#8e8e93', '#1c1c1e'];
export function CustomizeDialog({ inst, onClose, onSaved }: { inst: InstanceSummary; onClose: () => void; onSaved: (i: InstanceSummary) => void }) {
  const [name, setName] = useState(inst.displayName ?? '');
  const [mode, setMode] = useState<'default' | 'glyph' | 'image'>(inst.customIcon?.kind ?? 'default');
  const [glyph, setGlyph] = useState(inst.customIcon?.kind === 'glyph' ? inst.customIcon.glyph : '📷');
  const [color, setColor] = useState(inst.customIcon?.kind === 'glyph' ? inst.customIcon.color : '#0a84ff');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const preview: InstanceSummary = { ...inst, displayName: name.trim() || null, customIcon: mode === 'default' ? null : mode === 'glyph' ? { kind: 'glyph', glyph, color } : dataUrl ? { kind: 'image', url: dataUrl } : inst.customIcon?.kind === 'image' ? inst.customIcon : null };
  const pickFile = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > 1024 * 1024) return setError('The picture must be 1 MB or smaller. A square PNG around 512×512 looks best.');
    const r = new FileReader();
    r.onload = () => setDataUrl(String(r.result));
    r.readAsDataURL(f);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const icon = mode === 'default' ? ({ kind: 'default' } as const) : mode === 'glyph' ? ({ kind: 'glyph', glyph, color } as const) : dataUrl ? ({ kind: 'image', dataUrl } as const) : undefined;
      const r = await api.setInstanceAppearance(inst.id, { displayName: name.trim() || null, ...(icon ? { icon } : {}) });
      onSaved(r);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Customize ${inst.packageName}`} onClose={onClose}>
      <div className="customize">
        <div className="customize-preview" aria-label="Preview">
          <InstanceIcon inst={preview} size={84} />
          <span className="icon-label">{appLabel(preview)}</span>
        </div>
        <div className="stack">
          <label>
            Name on the launcher
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={inst.packageName} maxLength={40} aria-label="Name on the launcher" />
          </label>
          <div role="radiogroup" aria-label="Icon" className="seg">
            {(['default', 'glyph', 'image'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={`seg-btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
                {m === 'default' ? "App's icon" : m === 'glyph' ? 'Emoji or letters' : 'My picture'}
              </button>
            ))}
          </div>
          {mode === 'glyph' && (
            <>
              <div className="glyphs" role="listbox" aria-label="Emoji">
                {GLYPHS.map((g) => (
                  <button key={g} type="button" role="option" aria-selected={glyph === g} className={`glyph-opt ${glyph === g ? 'active' : ''}`} onClick={() => setGlyph(g)}>
                    {g}
                  </button>
                ))}
              </div>
              <label className="small">
                Or type one emoji or up to two letters
                <input value={glyph} onChange={(e) => setGlyph(e.target.value)} maxLength={4} aria-label="Icon glyph" className="glyph-input" />
              </label>
              <div className="swatches" role="listbox" aria-label="Colour">
                {COLORS.map((c) => (
                  <button key={c} type="button" role="option" aria-selected={color === c} className={`swatch-dot ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />
                ))}
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" className="color-input" />
              </div>
            </>
          )}
          {mode === 'image' && (
            <div className="row wrap">
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pickFile(e.target.files?.[0])} aria-label="Icon picture file" />
              <button type="button" className="btn" onClick={() => file.current?.click()}>
                Choose a picture…
              </button>
              <span className="muted small">PNG, JPEG or WebP up to 1 MB. Square looks best.</span>
            </div>
          )}
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || (mode === 'image' && !dataUrl && inst.customIcon?.kind !== 'image')} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Dialog>
  );
}

// Upload your own app: a zip with manifest.yaml, compose.yaml (and README.md, icon, screenshots).
export function UploadPackageDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: PackageImportResultDto) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; next?: string; details?: string[] } | null>(null);
  const [result, setResult] = useState<PackageImportResultDto | null>(null);
  const [drag, setDrag] = useState(false);
  const [mode, setMode] = useState<'zip' | 'git'>('zip');
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('main');
  const [gitPath, setGitPath] = useState('');
  const [gitAuto, setGitAuto] = useState(false);
  const addGit = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.addPackageSource({ url: gitUrl.trim(), ref: gitRef.trim() || 'main', ...(gitPath.trim() ? { subpath: gitPath.trim() } : {}), autoRedeploy: gitAuto });
      setResult(r.import);
      onDone(r.import);
    } catch (e) {
      setError(e instanceof ApiError ? { message: e.message, next: e.nextAction, details: (e as ApiError & { details?: string[] }).details } : { message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  const send = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) return setError({ message: 'Choose a .zip file.' });
    if (f.size > 50 * 1024 * 1024) return setError({ message: 'The package must be 50 MB or smaller.' });
    setBusy(true);
    const r = new FileReader();
    r.onload = async () => {
      try {
        const dataUrl = String(r.result).replace(/^data:[^;]*;base64,/, 'data:application/zip;base64,');
        const res = await api.uploadPackage(f.name, dataUrl);
        setResult(res);
        onDone(res);
      } catch (e) {
        setError(e instanceof ApiError ? { message: e.message, next: e.nextAction, details: (e as ApiError & { details?: string[] }).details } : { message: String(e) });
      } finally {
        setBusy(false);
      }
    };
    r.readAsDataURL(f);
  };
  return (
    <Dialog title="Your own app" onClose={onClose}>
      {!result ? (
        <>
          <div role="radiogroup" aria-label="How to add the app" className="seg">
            <button role="radio" aria-checked={mode === 'zip'} className={`seg-btn ${mode === 'zip' ? 'active' : ''}`} onClick={() => setMode('zip')}>
              Package zip
            </button>
            <button role="radio" aria-checked={mode === 'git'} className={`seg-btn ${mode === 'git' ? 'active' : ''}`} onClick={() => setMode('git')}>
              Git repository
            </button>
          </div>
          {mode === 'zip' && (
            <>
              <p className="muted small">Bring an app of your own (or one you are developing) as a package zip. Harbor checks it the way it checks the built-in catalog, pins the images by digest for you and puts it in your App Store. Upload a higher revision later to update the apps installed from it.</p>
              <div
                className={`dropzone ${drag ? 'drag' : ''}`}
                onDragOver={(e) => (e.preventDefault(), setDrag(true))}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  send(e.dataTransfer.files[0]);
                }}
              >
                <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => send(e.target.files?.[0])} aria-label="Package zip file" />
                <p className="empty-title">{busy ? 'Checking the package…' : 'Drop a package .zip here'}</p>
                <button className="btn primary" disabled={busy} onClick={() => file.current?.click()}>
                  Choose a zip…
                </button>
              </div>
            </>
          )}
          {mode === 'git' && (
            <>
              <p className="muted small">
                Point Harbor at a repository with a <code>harbor/</code> folder (manifest + compose). Services can be built from your own <code>Dockerfile</code>; Harbor imports the branch head, and every new commit becomes an update — deployed automatically if you want.
              </p>
              <div className="stack">
                <label>
                  Repository URL
                  <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/your-app" aria-label="Repository URL" />
                </label>
                <div className="row wrap">
                  <label>
                    Branch <input value={gitRef} onChange={(e) => setGitRef(e.target.value)} aria-label="Branch" />
                  </label>
                  <label>
                    Folder (optional) <input value={gitPath} onChange={(e) => setGitPath(e.target.value)} placeholder="apps/notes" aria-label="Folder inside the repository" />
                  </label>
                </div>
                <label className="row">
                  <input type="checkbox" checked={gitAuto} onChange={(e) => setGitAuto(e.target.checked)} aria-label="Redeploy on commit" />
                  <span className="muted small">Redeploy on commit: new pushes to the branch deploy themselves (a failed deployment rolls back)</span>
                </label>
                <div className="row end">
                  <button className="btn primary" disabled={busy || !gitUrl.trim()} onClick={() => void addGit()}>
                    {busy ? 'Fetching the repository…' : 'Add from the repository'}
                  </button>
                </div>
              </div>
            </>
          )}
          <details>
            <summary className="muted small">{mode === 'zip' ? 'What goes in the zip' : 'What goes in the repository'}</summary>
            <ul className="steps">
              <li>
                <code>{mode === 'git' ? 'harbor/manifest.yaml' : 'manifest.yaml'}</code>: id, name, description, <code>release.revision</code>{mode === 'zip' ? ' (raise it for every new version)' : ' (the commit date is appended for you)'}, services, the endpoint people open, a health path.
              </li>
              <li>
                <code>{mode === 'git' ? 'harbor/compose.yaml' : 'compose.yaml'}</code>: services with <code>image:</code> (tags are fine, Harbor pins them){mode === 'git' ? ' or build: {context: ../app} pointing at your Dockerfile' : ''}, environment, named volumes. No host ports, no privileged flags.
              </li>
              <li>
                Optional: <code>README.md</code>, <code>icon.svg</code>/<code>.png</code>, screenshots named in <code>presentation.gallery</code>.
              </li>
            </ul>
            <p className="muted small">The full guide with a copy-paste template is docs/DEVELOPER_PACKAGES.md in the Harbor repository.</p>
          </details>
          {error && (
            <div className="error small" role="alert">
              <p>{error.message}</p>
              {error.next && <p className="muted">{error.next}</p>}
              {error.details && error.details.length > 1 && (
                <ul>
                  {error.details.slice(0, 6).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="stack" role="status">
          <div className="app-head">
            <AppIcon packageId={result.item.id} icon={result.item.presentation.icon} name={result.item.name} size={56} />
            <div>
              <p className="lead">
                <strong>{result.item.name}</strong> is in your App Store
              </p>
              <p className="muted small">
                revision {result.item.revision}
                {result.item.version ? ` · version ${result.item.version}` : ''}
                {result.replacedRevision ? ` · replaces revision ${result.replacedRevision}` : ''}
              </p>
            </div>
          </div>
          {result.pinned.length > 0 && (
            <div>
              <h4>Images pinned for you</h4>
              <ul className="steps">
                {result.pinned.map((p) => (
                  <li key={p.service}>
                    {p.service}: <code>{p.from}</code> → <code>{p.to.slice(0, p.to.indexOf('@') + 20)}…</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.notes.map((n, i) => (
            <p key={i} className="muted small">
              {n}
            </p>
          ))}
          {result.updatable.length > 0 && (
            <p className="small">
              <strong>Updates available</strong> for {result.updatable.map((u) => u.name).join(', ')}: open the app from Home and press Update.
            </p>
          )}
        </div>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          {result ? 'Done' : 'Cancel'}
        </button>
      </div>
    </Dialog>
  );
}

// Apps that ship with a fixed first login (documented by the upstream project). Shown with a copy button and
// the one thing that matters: change it right after signing in, because every copy of the app starts the same.
export function DefaultLogin({ creds }: { creds: { username: string; password: string; note: string | null } }) {
  return (
    <div className="default-login" role="note">
      <div className="row between wrap">
        <strong>Default login</strong>
        <Pill tone="warn">change it after the first sign-in</Pill>
      </div>
      <dl className="kv">
        <dt>Username</dt>
        <dd>
          <code>{creds.username}</code> <Copy text={creds.username} />
        </dd>
        <dt>Password</dt>
        <dd>
          <code>{creds.password}</code> <Copy text={creds.password} />
        </dd>
      </dl>
      <p className="muted small">{creds.note ?? 'This login is the same for everyone who installs this app; anyone who reaches it can use it until you change it.'}</p>
    </div>
  );
}
