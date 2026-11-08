import { useEffect, useState, type ReactNode } from 'react';
import type { AppBackupsDto, CatalogItemDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, StorageUsageDto, TailnetAllDto } from '../../../src/contracts/api';
import { api } from '../api';
import { AppBackupsPanel } from './pages/Backups';
import { Copy, Dialog, EventList, InstanceIcon, Pill, StatusPill, appLabel, openUrl } from './components';
import { DefaultLogin, InternetDialog, MovePanel, PassphrasePanel, RevealLoginDialog, RevealSecretsDialog, UnlockForm, linkCandidates } from './dialogs';
import { fmtBytes, fmtTime, fmtVersion, updateLine } from './format';
import { gpuAppText } from './gpu-text';
import { internetHint, internetSummary } from './internet-text';
import type { Action } from './store';
import { appActionGates, appQueueLine } from './queue';
import { SettingsDialog } from './settings-fields';
import { settingText } from './setting-draft';

// Decision 198: the app page. A fixed header (status, Open, Start/Stop/Restart), one slot above the tabs for what
// blocks the app, then four tabs that are the same for every app: sections appear only when the app has something to
// show. A removed app has no tabs. Changes still go through plan -> review; this file only arranges them.

type Tab = 'overview' | 'access' | 'settings' | 'data';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'access', label: 'Access' },
  { id: 'settings', label: 'Settings' },
  { id: 'data', label: 'Data' },
];

// "Done, hide this" on the setup card: a per-browser convenience (UI state, never a secret)
const SETUP_DONE_KEY = 'harbor.setupDone';
function setupHidden(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SETUP_DONE_KEY) ?? '[]') as string[]).includes(id);
  } catch {
    return false;
  }
}
function hideSetup(id: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(SETUP_DONE_KEY) ?? '[]') as string[];
    localStorage.setItem(SETUP_DONE_KEY, JSON.stringify([...new Set([...all, id])]));
  } catch {
    /* private window: it just comes back next time */
  }
}

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-row">
      <div className="page-row-text">
        <div>{title}</div>
        {sub ? <div className="muted small">{sub}</div> : null}
      </div>
      {children ? <div className="page-row-actions">{children}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="page-section" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

const endpointTitle = (id: string, primary: boolean) => (primary ? 'Main page' : `${id.charAt(0).toUpperCase()}${id.slice(1).replace(/-/g, ' ')} page`);
const placeName = (via: string, url: string) => (via === 'tailnet' ? 'Tailscale' : via === 'public' ? 'Domain' : /\/\/(localhost|127\.)/.test(url) ? 'This machine' : 'Home network');

export function AppDrawer({ inst, exposures, ops = [], onClose, onAction, onPublish, onCustomize, onChanged, instances = [], catalog = [] }: { inst: InstanceSummary; exposures: ExposureDto[]; ops?: OperationDto[]; onClose: () => void; onAction: (a: Action) => void; onPublish: (mode: 'domain' | 'proxy' | 'manage') => void; onCustomize: () => void; onChanged?: (i: InstanceSummary) => void; instances?: InstanceSummary[]; catalog?: CatalogItemDto[] }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [relink, setRelink] = useState<Record<string, string>>({});
  const upd = inst.updateAvailable;
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(inst.autoUpdate);
  const [adopting, setAdopting] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState<string | null>(null);
  useEffect(() => setAutoUpdate(inst.autoUpdate), [inst.id, inst.autoUpdate]);
  const [hiddenFromHome, setHiddenFromHome] = useState(inst.hiddenFromHome);
  useEffect(() => setHiddenFromHome(inst.hiddenFromHome), [inst.id, inst.hiddenFromHome]);
  const [tailnetAll, setTailnetAll] = useState<TailnetAllDto | null>(null);
  const [backups, setBackups] = useState<AppBackupsDto | null>(null);
  const [usage, setUsage] = useState<StorageUsageDto | null>(null);
  useEffect(() => {
    let live = true;
    setTab('overview');
    api.tailnetAll().then(
      (p) => live && setTailnetAll(p),
      () => live && setTailnetAll(null),
    );
    api.appBackups(inst.id).then(
      (b) => live && setBackups(b),
      () => live && setBackups(null),
    );
    api.storageUsage().then(
      (u) => live && setUsage(u),
      () => live && setUsage(null),
    );
    return () => {
      live = false;
    };
  }, [inst.id]);
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
  const lockable = Boolean(home && home.sealed && home.state === 'unlocked' && !retained && inst.installState === 'installed');
  const canLock = lockable && inst.runtime === 'stopped';
  const [locking, setLocking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [internetOpen, setInternetOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false); // decision 199
  const [techOpen, setTechOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [setupDone, setSetupDone] = useState(() => setupHidden(inst.id));
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running' && !need && !locked;
  const gate = appActionGates(inst, ops);
  const canStart = gate.start && !need;
  const name = appLabel(inst, instances);
  const login = inst.login;
  const busy = inst.installState !== 'installed';
  const primaryUrl = primary ? (openUrl(inst, primary) ?? primary.urls.loopback) : null;
  const tailnetUrl = primary?.urls.tailnet ?? null;
  const keptOff = tailnetAll?.except.includes(inst.id) ?? false;
  const tailnetUsable = tailnetAll !== null && !tailnetAll.reason;
  const onTailnet = tailnetUrl !== null || (tailnetAll !== null && tailnetAll.enabled && !keptOff);
  const usedBytes = usage?.apps.find((a) => a.instanceId === inst.id)?.totalBytes ?? null;
  const setTailnet = (on: boolean) => {
    if (!tailnetAll) return;
    if (!on && tailnetUrl) return onAction({ kind: 'unexpose', instance: inst, via: 'tailnet' });
    if (on && !tailnetAll.enabled) return onAction({ kind: 'expose', instance: inst, via: 'tailnet', hostname: '', protection: 'none', makePrimary: false });
    void api.setTailnetAllIncluded(inst.id, on).then(setTailnetAll, (err: Error) => setError(err.message));
  };
  const domainsOf = (endpointId: string) => exposures.filter((e) => e.endpointId === endpointId && (e.via === 'public' || e.via === 'proxy'));

  const addressRows = (ep: InstanceSummary['endpoints'][number]) => {
    const urls = (['loopback', 'tailnet'] as const).flatMap((via) => (ep.urls[via] ? [{ via, url: ep.urls[via]! }] : []));
    return (
      <>
        {urls.map(({ via, url }) => (
          <div key={via} className="address-row">
            <span className="address-where">{placeName(via, url)}</span>
            <a href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
            {ep.primary === via && <span className="muted small">main</span>}
            <Copy text={url} />
          </div>
        ))}
        {domainsOf(ep.id).map((e) => (
          <div key={e.id} className="address-row">
            <span className="address-where">{e.via === 'proxy' ? 'Your proxy' : 'Domain'}</span>
            <a href={e.url} target="_blank" rel="noopener noreferrer">
              {e.url}
            </a>
            {e.state !== 'active' && <Pill tone={e.state === 'degraded' ? 'warn' : 'busy'}>{e.state}</Pill>}
            {ep.primary === 'public' && e.url === ep.urls.public && <span className="muted small">main</span>}
            <Copy text={e.url} />
          </div>
        ))}
      </>
    );
  };

  const header = (
    <>
      <div className="app-head">
        <InstanceIcon inst={inst} size={56} />
        <div>
          <p className="app-head-status">
            <StatusPill inst={inst} />{' '}
            <span className="muted small">
              {inst.version ? fmtVersion(inst.version) : `rev ${inst.revision}`}
              {inst.usage ? ` · ${fmtBytes(inst.usage.memoryBytes)}` : ''}
            </span>
          </p>
          {ops.length > 0 && (
            <p className="muted small" role="status" aria-label={`Queue for ${inst.name}`}>
              {appQueueLine(ops)}
            </p>
          )}
        </div>
      </div>
      <div className="row wrap actions">
        {canOpen && primary && !inst.apiOnly && (
          <a className="btn primary" href={openUrl(inst) ?? primary.urls.loopback} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`}>
            Open
          </a>
        )}
        {canStart && (
          <button className="btn" onClick={() => onAction({ kind: 'start', instance: inst })} aria-label={`Start ${inst.name}`}>
            Start
          </button>
        )}
        {gate.restart && (
          <button className="btn" onClick={() => onAction({ kind: 'restart', instance: inst })} aria-label={`Restart ${inst.name}`} title="Restart with the current addresses, for example after changing network settings">
            Restart
          </button>
        )}
        {gate.stop && (
          <button className="btn" onClick={() => onAction({ kind: 'stop', instance: inst })} aria-label={`Stop ${inst.name}`}>
            Stop
          </button>
        )}
      </div>
    </>
  );

  // Decision 198: what blocks the app, worst first, above the tabs so it shows on every tab
  const blockers = (
    <>
      {detail?.lastError && (
        <div className="update-banner needs-drive" role="alert">
          <div>
            <strong>{detail.lastError.code}</strong>
            <p className="muted small">
              {detail.lastError.message} Next: {detail.lastError.nextAction}
            </p>
          </div>
          {(inst.installState === 'needs_action' || inst.installState === 'failed') && inst.hasRetainedData && !need && (
            <button className="btn primary" onClick={() => onAction({ kind: 'restart', instance: inst })} aria-label={`Repair ${inst.name}`} title="Run it again from its stored release: re-render, recreate the containers, check it answers. Data, ports and addresses stay.">
              Repair
            </button>
          )}
        </div>
      )}
      {!detail?.lastError && (inst.installState === 'needs_action' || inst.installState === 'failed') && inst.hasRetainedData && !need && (
        <div className="update-banner needs-drive" role="alert">
          <div>
            <strong>It did not finish</strong>
            <p className="muted small">Run it again from its stored release. Data and addresses stay.</p>
          </div>
          <button className="btn primary" onClick={() => onAction({ kind: 'restart', instance: inst })} aria-label={`Repair ${inst.name}`}>
            Repair
          </button>
        </div>
      )}
      {need && (
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
              disabled={adopting || inst.runtime === 'running' || inst.runtime === 'starting'}
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
      {locked && (
        <div className="update-banner needs-drive" role="status">
          <div>
            <strong>Locked</strong>
            <p className="muted small">
              This app lives sealed at <code className="path">{home!.path}</code>
              {home!.sealed ? ': its files are ciphertext on the disk right now — nothing on this machine can read them, Docker included.' : '.'}{' '}
              {home!.defaultKey ? <>Log in again to unlock it silently.</> : home!.silentUnlock ? <>Its passphrase is your Harbor password: logging in again unlocks it, or type the passphrase (or the 12-word recovery key) below. A reboot locks it again.</> : <>Type the app passphrase (or the 12-word recovery key) to unlock it for this boot. A reboot locks it again.</>}
            </p>
          </div>
          {!home!.defaultKey && (
            <UnlockForm
              inst={inst}
              onUnlocked={() => {
                setError(null);
                void api.instance(inst.id).then(setDetail, (e: Error) => setError(e.message));
              }}
              onError={setError}
            />
          )}
        </div>
      )}
      {upd && (
        <div className="update-banner" role="status">
          <div>
            <strong>Update available</strong>
            <span className="muted small">
              {' '}
              {updateLine(inst, upd)}
              {upd.releaseNotes ? ` · ${upd.releaseNotes}` : ''}
            </span>
            <p className="muted small">Your data, addresses and ports stay. If the new version does not start, Harbor puts the current one back.</p>
          </div>
          <button className="btn primary" disabled={!gate.update} onClick={() => onAction({ kind: 'update', instance: inst })} aria-label={`Update ${inst.name}`}>
            Update
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );

  const overview = (
    <>
      {detail?.setup && !setupDone && (
        <section className="setup-card" aria-label="Finish setup">
          <h4>Finish setup inside the app</h4>
          <p className={`small${stepsOpen ? '' : ' clamp-2'}`}>{detail.setup.instructions}</p>
          <div className="row wrap">
            {/* Same address rule as the Open button: the server's browserUrl is loopback, unreachable from a LAN browser. */}
            <a className="btn small" href={openUrl(inst, inst.endpoints.find((e) => e.id === detail.setup!.endpointId)) ?? detail.setup.browserUrl} target="_blank" rel="noopener noreferrer">
              Open {endpointTitle(detail.setup.endpointId, detail.setup.endpointId === inst.primaryEndpoint).replace(/ page$/, '').toLowerCase()} page
            </a>
            <button className="btn small ghost" onClick={() => setStepsOpen(!stepsOpen)}>
              {stepsOpen ? 'Fewer steps' : 'Show all steps'}
            </button>
            <button
              className="btn small ghost push-end"
              onClick={() => {
                hideSetup(inst.id);
                setSetupDone(true);
              }}
              aria-label={`Hide the setup steps of ${inst.name}`}
            >
              Done, hide this
            </button>
          </div>
          <p className="muted small">Harbor did not create any account in this application; a green status only means it answers HTTP.</p>
        </section>
      )}
      {detail?.defaultCredentials && <DefaultLogin creds={detail.defaultCredentials} />}
      <div className="summary-rows">
        {primaryUrl && (
          <div className="page-row summary-static">
            <span className="muted">Address</span>
            <a className="url" href={primaryUrl} target="_blank" rel="noopener noreferrer">
              {primaryUrl}
            </a>
            <Copy text={primaryUrl} />
          </div>
        )}
        {login && login.locked !== 'never' && (
          <div className="page-row summary-static">
            <span className="muted">Password</span>
            <span>{login.on ? 'Asked at every address' : 'Off'}</span>
            {login.hasPassword && (
              <button className="btn small" onClick={() => setRevealOpen(true)} aria-label={`Show the password of ${name}`}>
                Show…
              </button>
            )}
          </div>
        )}
        <SummaryLink label="Internet" value={internetSummary(inst.internet).label} onGo={() => setTab('access')} />
        <SummaryLink label="Encrypted" value={home ? (home.defaultKey ? 'Yes, on this machine' : 'Yes, with its own passphrase') : 'No'} onGo={() => setTab('data')} />
        <SummaryLink label="Backups" value={backups ? (!backups.eligible ? 'Not available' : backups.policy.enabled ? `On${backups.lastSuccessAt ? `, last ${fmtTime(backups.lastSuccessAt)}` : ''}` : 'Off') : '…'} warn={backups?.eligible === true && !backups.policy.enabled} onGo={() => setTab('data')} />
        <SummaryLink label="Updates" value={autoUpdate ? 'Automatic' : 'Manual'} onGo={() => setTab('settings')} />
      </div>
    </>
  );

  const access = (
    <>
      {login && (
        <Section title="Password">
          {login.locked === 'never' ? (
            <Row title="Not possible for this app" sub="Its own apps and sync clients need to reach it directly." />
          ) : (
            <Row
              title={login.on ? 'One password for this whole app' : 'No password'}
              sub={
                login.on
                  ? `${login.locked === 'required' ? 'This app always uses it. ' : ''}Asked at every address${login.endpoints.length > 1 ? `, on all ${login.endpoints.length} of its pages` : ''}.${login.open.length ? ` ${login.open.join(', ')} stays open for its own clients.` : ''}`
                  : 'Anyone who reaches its addresses can open it.'
              }
            >
              {login.locked === null && login.on && (
                <button className="btn small" disabled={busy} onClick={() => onAction({ kind: 'configure', instance: inst, login: { on: false } })} aria-label={`Turn off the password of ${name}`}>
                  Turn off
                </button>
              )}
              {login.locked === null && !login.on && (
                <button className="btn small" disabled={busy} onClick={() => onAction({ kind: 'configure', instance: inst, login: { on: true, ...(login.hasPassword ? {} : { password: true as const }) } })} aria-label={`Turn on a password for ${name}`}>
                  Turn on…
                </button>
              )}
              {(login.on || login.hasPassword) && (
                <button className="btn small" disabled={busy} onClick={() => onAction({ kind: 'configure', instance: inst, login: { password: true } })} aria-label={`Change the password of ${name}`}>
                  Change…
                </button>
              )}
              {login.hasPassword && (
                <button className="btn small" onClick={() => setRevealOpen(true)} aria-label={`Show the password of ${name}`}>
                  Show…
                </button>
              )}
            </Row>
          )}
        </Section>
      )}
      {inst.endpoints.length > 0 && (
        <Section title="Addresses">
          {inst.endpoints.map((ep) => (
            <div key={ep.id} className="address-card">
              {inst.endpoints.length > 1 && <strong className="small">{endpointTitle(ep.id, ep.id === inst.primaryEndpoint)}</strong>}
              {addressRows(ep)}
            </div>
          ))}
          <div className="row wrap">
            <button className="btn small" disabled={!canOpen} onClick={() => onPublish('domain')} aria-label={`Add a domain to ${inst.name}`}>
              Add a domain…
            </button>
            {exposures.length > 0 && (
              <button className="btn small" onClick={() => onPublish('manage')} aria-label={`Manage the addresses of ${inst.name}`}>
                Manage…
              </button>
            )}
            <button className="btn small ghost" disabled={!canOpen} onClick={() => onPublish('proxy')} aria-label={`Use your own proxy for ${inst.name}`}>
              Use my own proxy…
            </button>
          </div>
          {tailnetAll && (tailnetUsable || tailnetUrl) ? (
            <label className="page-row">
              <span className="page-row-text">
                On Tailscale
                <span className="muted small block">Any device on your tailnet can reach it</span>
              </span>
              <input type="checkbox" checked={onTailnet} disabled={busy} onChange={(e) => setTailnet(e.target.checked)} aria-label={`${inst.name} on Tailscale`} />
            </label>
          ) : (
            <Row title="Tailscale" sub="Not connected. Reach your apps from anywhere, privately.">
              <a className="btn small" href="#/settings/remote" onClick={onClose}>
                Connect…
              </a>
            </Row>
          )}
        </Section>
      )}
      {inst.ports.length > 0 && (
        <Section title="Ports">
          {inst.ports.map((x) => (
            <Row key={x.id} title={`${x.protocol.toUpperCase()} ${x.hostPort}`} sub={`${x.purpose} · open on every network of this machine; to reach it from outside, forward ${x.protocol.toUpperCase()} ${x.hostPort} on your router to this machine`} />
          ))}
        </Section>
      )}
      <Section title="What this app can reach">
        <Row
          title={
            <>
              Internet: <strong>{internetSummary(inst.internet).label}</strong>
            </>
          }
          sub={`${internetSummary(inst.internet).why.charAt(0).toUpperCase()}${internetSummary(inst.internet).why.slice(1)}. ${internetHint(inst.internet.mode)}`}
        >
          <button className="btn small" disabled={busy} onClick={() => setInternetOpen(true)} aria-label={`Change how ${name} reaches the internet`}>
            Change…
          </button>
        </Row>
      </Section>
    </>
  );

  const settings = (
    <>
      {inst.settings && inst.settings.length > 0 && (
        <section className="page-section" aria-label="App options">
          <div className="page-section-head">
            <h4>App options</h4>
            <button className="btn small" disabled={busy} onClick={() => setSettingsOpen(true)} aria-label={`Change the settings of ${inst.name}`}>
              Change…
            </button>
          </div>
          {inst.settings.map((x) => (
            <Row key={x.id} title={x.label}>
              <strong>{settingText(x, x.value)}</strong>
              {!x.overridden ? <span className="muted small">default</span> : null}
            </Row>
          ))}
        </section>
      )}
      {(inst.links.length > 0 || inst.linkedBy.length > 0) && (
        <Section title="Connected apps">
          {inst.links.map((l) => {
            const claim = catalog.find((x) => x.id === inst.packageId)?.links.find((x) => x.id === l.id);
            const cands = linkCandidates({ packages: claim?.packages ?? null }, instances, inst.id);
            const pick = relink[l.id] ?? l.provider?.instanceId ?? cands[0]?.id ?? '';
            return (
              <Row key={l.id} title={l.purpose} sub={l.provider ? <>Linked to {l.provider.name} at <code>{l.url}</code></> : (l.note ?? (l.state === 'dormant' ? 'Paused' : 'Needs an app to link to'))}>
                {inst.installState === 'installed' && cands.length > 0 && (
                  <>
                    <select value={pick} onChange={(e) => setRelink({ ...relink, [l.id]: e.target.value })} aria-label={`New provider for ${l.id}`}>
                      {cands.map((i) => (
                        <option key={i.id} value={i.id}>
                          {appLabel(i)} ({i.name})
                        </option>
                      ))}
                    </select>
                    <button className="btn small" disabled={!pick || (pick === l.provider?.instanceId && l.state === 'active')} onClick={() => onAction({ kind: 'configure', instance: inst, links: { [l.id]: { instanceId: pick } } })} aria-label={`Link ${l.id} to the chosen app`}>
                      {l.provider ? 'Change' : 'Link'}
                    </button>
                    {l.optional && l.provider && (
                      <button className="btn small ghost" onClick={() => onAction({ kind: 'configure', instance: inst, links: { [l.id]: null } })} aria-label={`Unlink ${l.id}`}>
                        Unlink
                      </button>
                    )}
                  </>
                )}
              </Row>
            );
          })}
          {inst.linkedBy.map((b) => (
            <Row key={`${b.instanceId}-${b.linkId}`} title={<span className="muted">{b.name} reaches this app privately</span>} />
          ))}
        </Section>
      )}
      {inst.revealableSecrets.length > 0 && (
        // decision 199: generated values the package marks revealable; the values only after the Harbor password
        <Section title="Saved passwords">
          {inst.revealableSecrets.map((s) => (
            <Row key={s.id} title={s.label}>
              <button className="btn small ghost" onClick={() => setSavedOpen(true)} aria-label={`Show ${s.label}`}>
                Show…
              </button>
            </Row>
          ))}
        </Section>
      )}
      {inst.operatorSecrets.length > 0 && (
        <Section title="Values you provided">
          {inst.operatorSecrets.map((s) => (
            <Row key={s.id} title={s.prompt} sub={s.set ? 'Set, never shown' : 'Not set'}>
              <button className="btn small" disabled={busy} onClick={() => onAction({ kind: 'configure', instance: inst, secrets: [s.id] })} aria-label={`Change ${s.id}`}>
                {s.set ? 'Change…' : 'Add…'}
              </button>
            </Row>
          ))}
        </Section>
      )}
      {detail?.gpu && (
        <Section title="Graphics card">
          <Row title={gpuAppText(detail.gpu)} />
        </Section>
      )}
      <Section title="On this Harbor">
        <Row title="Name and icon" sub={inst.displayName ?? inst.packageName}>
          <button className="btn small" onClick={onCustomize} aria-label={`Customize ${inst.name}`}>
            Customize…
          </button>
        </Row>
        <label className="page-row">
          <span className="page-row-text">
            Update automatically
            <span className="muted small block">Backs up first if it has a backup place. Puts the current version back if the new one fails.</span>
          </span>
          <input
            type="checkbox"
            checked={autoUpdate}
            disabled={busy}
            onChange={(e) => {
              setAutoUpdate(e.target.checked); // optimistic; the poll corrects on failure
              void api.setAutoUpdate(inst.id, e.target.checked).catch(() => setAutoUpdate(!e.target.checked));
            }}
            aria-label={`Automatic updates for ${inst.name}`}
          />
        </label>
        <label className="page-row">
          <span className="page-row-text">
            Show on Home
            <span className="muted small block">Turn off for helpers without a page of their own</span>
          </span>
          <input
            type="checkbox"
            checked={!hiddenFromHome}
            onChange={(e) => {
              const hidden = !e.target.checked;
              setHiddenFromHome(hidden);
              void api.setInstanceAppearance(inst.id, { hidden }).then((u) => onChanged?.(u), () => setHiddenFromHome(!hidden));
            }}
            aria-label={`Show ${inst.name} on Home`}
          />
        </label>
      </Section>
      <Section title="Manage">
        <Row title="Technical details" sub="State, containers and volumes, recent events">
          <button className="btn small" onClick={() => setTechOpen(true)} aria-label={`Technical details of ${inst.name}`}>
            View…
          </button>
        </Row>
        {(gate.remove || gate.purge) && (
          <Row title="Remove this app" sub="Choose to keep its data or delete everything">
            <button className="btn small danger" onClick={() => setRemoveOpen(true)} aria-label={`Remove ${inst.name}`}>
              Remove…
            </button>
          </Row>
        )}
      </Section>
    </>
  );

  const data = (
    <>
      <AppBackupsPanel inst={inst} onAction={onAction} />
      <Section title="Encryption">
        {home ? (
          <Row title={home.defaultKey ? 'Encrypted on this machine' : 'Encrypted with its own passphrase'} sub={<code className="path">{home.path}</code>} />
        ) : (
          <Row title="Not encrypted" sub="Plain Docker volumes, readable on disk; starts on its own after a reboot">
            {inst.installState === 'installed' && (
              <button className="btn small" onClick={() => onAction({ kind: 'seal', instance: inst })} aria-label={`Encrypt ${inst.name}`} title="Move its data into a sealed home on this machine (Harbor's own key, unlocks when you log in)">
                Encrypt this app…
              </button>
            )}
          </Row>
        )}
        {home && home.sealed === false && !locked && <Row title="Not sealed yet" sub="Installed before Harbor sealed data in the kernel. Its next Start seals the existing data in place (one-time, verified, rolled back if it fails)." />}
        {lockable && (
          <Row title="Lock" sub={canLock ? "Evict the key from the kernel: its files become unreadable until the next unlock" : 'Stop the app first: its files are open while it runs'}>
            <button
              className="btn small"
              disabled={locking || !canLock}
              onClick={() => {
                setLocking(true);
                setError(null);
                void api
                  .lockApp(inst.id)
                  .then((s) => setDetail((d) => (d ? { ...d, home: s.home } : d)))
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setLocking(false));
              }}
              aria-label={`Lock ${inst.name}`}
            >
              {locking ? 'Locking…' : 'Lock'}
            </button>
          </Row>
        )}
        {home && !locked && <PassphrasePanel inst={inst} defaultKey={Boolean(home.defaultKey)} onChanged={onChanged} />}
        {home && !locked && inst.installState === 'installed' && <MovePanel inst={inst} current={home.path} onMove={(dir) => onAction({ kind: 'move', instance: inst, dir })} />}
      </Section>
      {detail?.storage && detail.storage.length > 0 && (
        <Section title="What it stores">
          {detail.storage.map((x) => (
            <Row key={x.id} title={x.purpose} sub={x.path ? <>Your folder <code className="path">{x.path}</code>{x.readOnly ? ' · read-only' : ''}</> : undefined} />
          ))}
          {usedBytes !== null && <Row title={<span className="muted">Space used</span>}>{fmtBytes(usedBytes)}</Row>}
        </Section>
      )}
    </>
  );

  const technical = detail && techOpen && (
    <Dialog title={`Technical details of ${name}`} onClose={() => setTechOpen(false)}>
      <dl className="kv">
        <dt>Install</dt>
        <dd>{inst.installState}</dd>
        <dt>Desired</dt>
        <dd>{inst.desired}</dd>
        <dt>Runtime</dt>
        <dd>{inst.runtime}</dd>
        <dt>Readiness</dt>
        <dd>{inst.readiness}</dd>
        <dt>Observed</dt>
        <dd>{fmtTime(inst.observedAt)}</dd>
        {inst.usage && (
          <>
            <dt>CPU</dt>
            <dd>{inst.usage.cpuPercent}%</dd>
          </>
        )}
        <dt>Package</dt>
        <dd>
          {inst.packageName} · {inst.name} · rev {inst.revision}
        </dd>
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
    </Dialog>
  );

  return (
    <Dialog title={name} onClose={onClose} wide>
      {retained ? (
        <>
          <div className="app-head">
            <InstanceIcon inst={inst} size={56} />
            <p className="muted">Removed. Data volumes and secrets are retained; Reinstall restores the exact same release.</p>
          </div>
          <div className="row wrap actions">
            {inst.hasRetainedData && (
              <button className="btn primary" onClick={() => onAction({ kind: 'reinstall', instance: inst })} aria-label={`Reinstall ${inst.name}`}>
                Reinstall
              </button>
            )}
            {gate.purge && (
              <button className="btn danger" onClick={() => setRemoveOpen(true)} aria-label={`Delete the data of ${inst.name}`}>
                Delete data…
              </button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
        </>
      ) : (
        <>
          {header}
          {blockers}
          <div className="tabs" role="tablist" aria-label="App sections">
            {TABS.map((t) => (
              <button key={t.id} role="tab" id={`app-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="app-tab-panel" className={`tab${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div id="app-tab-panel" role="tabpanel" aria-labelledby={`app-tab-${tab}`} className="tab-panel">
            {tab === 'overview' && overview}
            {tab === 'access' && access}
            {tab === 'settings' && settings}
            {tab === 'data' && data}
          </div>
        </>
      )}
      {revealOpen && <RevealLoginDialog inst={inst} title={name} onClose={() => setRevealOpen(false)} />}
      {savedOpen && <RevealSecretsDialog inst={inst} title={name} onClose={() => setSavedOpen(false)} />}
      {internetOpen && (
        <InternetDialog
          inst={inst}
          title={`Internet for ${name}`}
          onClose={() => setInternetOpen(false)}
          onReview={(internet) => {
            setInternetOpen(false);
            onAction({ kind: 'configure', instance: inst, internet });
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          inst={inst}
          title={`Settings of ${name}`}
          onClose={() => setSettingsOpen(false)}
          onReview={(values) => {
            setSettingsOpen(false);
            onAction({ kind: 'configure', instance: inst, settings: values });
          }}
        />
      )}
      {technical}
      {removeOpen && <RemoveDialog inst={inst} canKeep={gate.remove} canPurge={gate.purge} onClose={() => setRemoveOpen(false)} onAction={onAction} />}
    </Dialog>
  );
}

function SummaryLink({ label, value, warn = false, onGo }: { label: string; value: string; warn?: boolean; onGo: () => void }) {
  return (
    <button className="page-row summary-link" onClick={onGo} aria-label={`${label}: ${value}`}>
      <span className="muted">{label}</span>
      <span className={warn ? 'warn' : undefined}>{value}</span>
      <span className="muted" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

// Decision 198: Remove and Uninstall completely are one question; behind it, the same two plans as before.
function RemoveDialog({ inst, canKeep, canPurge, onClose, onAction }: { inst: InstanceSummary; canKeep: boolean; canPurge: boolean; onClose: () => void; onAction: (a: Action) => void }) {
  const [how, setHow] = useState<'keep' | 'delete'>(canKeep ? 'keep' : 'delete');
  const [typed, setTyped] = useState('');
  const blocked = how === 'delete' && typed.trim() !== inst.name;
  return (
    <Dialog title={`Remove ${inst.name}`} onClose={onClose}>
      {canKeep && (
        <label className="remove-choice">
          <input type="radio" name="remove-how" checked={how === 'keep'} onChange={() => setHow('keep')} aria-label="Keep its data" />
          <span>
            Keep its data
            <span className="muted small block">You can reinstall it later, exactly as it was.</span>
          </span>
        </label>
      )}
      {canPurge && (
        <label className="remove-choice">
          <input type="radio" name="remove-how" checked={how === 'delete'} onChange={() => setHow('delete')} aria-label="Delete everything" />
          <span>
            Delete everything
            <span className="muted small block">Containers, its data, secrets and stored release. Folders of yours stay untouched. There is no undo.</span>
          </span>
        </label>
      )}
      {how === 'delete' && (
        <label className="small">
          <span>
            Type <code>{inst.name}</code> to confirm
          </span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${inst.name} to confirm`} autoComplete="off" />
        </label>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={blocked} onClick={() => onAction({ kind: how === 'keep' ? 'remove' : 'purge', instance: inst })} aria-label={how === 'keep' ? `Review removing ${inst.name}` : `Uninstall ${inst.name} completely`}>
          Review…
        </button>
      </div>
    </Dialog>
  );
}
