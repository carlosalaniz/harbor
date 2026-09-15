import { useEffect, useState } from 'react';
import type { CatalogItemDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlatformToolDto } from '../../../src/contracts/api';
import { api } from '../api';
import { AppIcon, Copy, Dialog, EventList, FolderPicker, Pill, StatusPill } from './components';
import { categoryLabel, fmtTime } from './format';
import type { Action, Console } from './store';

// Step 2 of every wizard: review the server-side plan, approve, then the tray takes over.
export function PlanDialog({ c }: { c: Console }) {
  const { pending, plan, planError } = c;
  if (!pending) return null;
  const title = plan ? `Review ${verb(plan.kind)}` : `Planning ${verb(pending.kind)}…`;
  const appName = plan ? (c.data.catalog.find((i) => i.id === plan.packageId)?.name ?? plan.name) : '';
  const displayName = plan ? (plan.name === plan.packageId ? appName : `${appName} (${plan.name})`) : '';
  const approveLabel = !plan ? '…' : plan.kind === 'remove' ? 'Remove (keep data)' : plan.kind === 'install' ? 'Install' : plan.kind === 'expose' ? 'Publish' : plan.kind === 'unexpose' ? 'Withdraw' : plan.kind === 'reconfigure' ? 'Switch' : capitalize(plan.kind);
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

export function InstallWizard({ item, busy, onClose, onStart }: { item: CatalogItemDto; busy: boolean; onClose: () => void; onStart: (a: Action) => void }) {
  const [name, setName] = useState('');
  const [gallery, setGallery] = useState(0);
  // storage claim id -> host folder ('' = managed volume)
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null); // claim id being chosen
  const external = item.claims.filter((c) => c.external);
  const missingRequired = external.some((c) => c.external!.required && !(folders[c.id] ?? '').trim());
  const storage = Object.fromEntries(Object.entries(folders).filter(([, v]) => v.trim()).map(([k, v]) => [k, { hostPath: v.trim() }]));
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
            {item.revision} · qualification {item.qualification}
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
      <label className="small">
        Instance name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z][a-z0-9-]{0,62}" placeholder={item.id} aria-label={`Instance name for ${item.name}`} />
      </label>
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
        <button className="btn primary" disabled={busy || item.availability !== 'available' || missingRequired} onClick={() => onStart({ kind: 'install', packageId: item.id, name: name.trim(), storage })} aria-label={`Install ${item.name} now`}>
          Install
        </button>
      </div>
    </Dialog>
  );
}

export function PublishWizard({ inst, exposures, tools, onClose, onStart }: { inst: InstanceSummary; exposures: ExposureDto[]; tools: PlatformToolDto[]; onClose: () => void; onStart: (a: Action) => void }) {
  const [via, setVia] = useState<'tailnet' | 'public'>('tailnet');
  const [hostname, setHostname] = useState('');
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
          <label className="small">
            Hostname you control (its DNS record must point at this host)
            <input value={hostname} onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} placeholder="app.example.com" />
          </label>
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

export function AppDrawer({ inst, exposures, busy, onClose, onAction, onPublish }: { inst: InstanceSummary; exposures: ExposureDto[]; busy: boolean; onClose: () => void; onAction: (a: Action) => void; onPublish: () => void }) {
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.instance(inst.id).then((d) => live && setDetail(d), (e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [inst.id]);
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const retained = inst.installState === 'retained';
  const canOpen = inst.installState === 'installed' && inst.runtime === 'running';
  const canStop = (inst.installState === 'installed' || inst.installState === 'needs_action' || inst.installState === 'failed') && inst.runtime !== 'stopped';
  const canStart = inst.installState === 'installed' && inst.desired === 'stopped';
  return (
    <Dialog title={inst.name} onClose={onClose} wide>
      <div className="app-head">
        <AppIcon packageId={inst.packageId} icon={inst.icon} name={inst.packageName} size={72} />
        <div>
          <p className="lead">
            {inst.packageName} <span className="muted small">· {inst.packageId} rev {inst.revision}</span>
          </p>
          <StatusPill inst={inst} />
          <span className="muted small"> · observed {fmtTime(inst.observedAt)}</span>
        </div>
      </div>
      <div className="row wrap actions">
        {canOpen && primary && (
          <a className="btn primary" href={primary.urls[primary.primary as keyof typeof primary.urls] ?? primary.urls.loopback} target="_blank" rel="noopener noreferrer" aria-label={`Open ${inst.name}`}>
            Open
          </a>
        )}
        {canOpen && (
          <button className="btn" disabled={busy} onClick={onPublish} aria-label={`Publish ${inst.name}`}>
            Publish…
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
      {retained && <p className="muted">Removed. Data volumes and secrets are retained; Reinstall restores the exact same release.</p>}
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
      return `Harbor will install ${n} on this machine. It usually takes a minute or two (the first time includes downloading the app).`;
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
  }
}

function verb(kind: PlanDto['kind']): string {
  return { install: 'install', start: 'start', stop: 'stop', remove: 'removal', reinstall: 'reinstall', expose: 'publishing', unexpose: 'withdrawal', reconfigure: 'address switch' }[kind];
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
