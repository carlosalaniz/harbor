import { useEffect, useId, useRef, useState } from 'react';
import type { DomainsDto, HostStorageDto, InstallCandidateDto } from '../../../src/contracts/api';
import type { AddressOptionsDto, CatalogItemDto, ExposureDto, InstanceSummary, PackageImportResultDto, PlanDto, PlatformToolDto } from '../../../src/contracts/api';
import { ApiError, api } from '../api';
import { AppIcon, Copy, Dialog, FolderPicker, InstanceIcon, OpenCopy, Pill, RecoveryCard, StatusPill, UpdateButton, appLabel, copiesOf, endpointUrlHere, outdatedCopy } from './components';
import { defaultCopyName, installView, nameProblem } from './copies';
import { categoryLabel, fmtTime, fmtVersion, updateLine } from './format';
import { gpuReviewText } from './gpu-text';
import { DriveIcon, GlobeIcon, LockIcon, PeopleIcon } from './icons';
import { INTERNET_CHOICES, internetHint, internetLabel, type InternetMode } from './internet-text';
import type { Action, Console } from './store';
import { DOING, VERB, capitalize as cap, isRunning, notCancellableReason, whoOf } from './queue';
import { SettingFields } from './settings-fields';
import { changedValues, draftOf, optionsSummary, settingText, type SettingDraft } from './setting-draft';

// App links (decision 126): installed apps that can satisfy one link of a package.
export function linkCandidates(link: { packages: string[] | null }, instances: InstanceSummary[], selfId?: string): InstanceSummary[] {
  return instances.filter((i) => i.id !== selfId && i.installState === 'installed' && (!link.packages || link.packages.includes(i.packageId)));
}

// decision 194: 24 characters from the browser's CSPRNG (getRandomValues works on plain-http LAN pages too)
function generatedPassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

// Decisions 194 and 199: Show asks for the Harbor password first, then shows the values (the app's login password, or
// the generated values its package marks revealable; those carry a visible label).
type RevealedValue = { key: string; label: string; value: string; visibleLabel: boolean };
function RevealDialog({ title, load, onClose }: { title: string; load: (password: string) => Promise<RevealedValue[]>; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<RevealedValue[] | null>(null);
  return (
    <Dialog title={title} onClose={onClose}>
      {values ? (
        <>
          {values.map((v) => (
            <div key={v.key}>
              {v.visibleLabel && <p className="small">{v.label}</p>}
              <div className="cmd">
                <pre className="code wrap" aria-label={v.label}>
                  {v.value}
                </pre>
                <Copy text={v.value} />
              </div>
            </div>
          ))}
          <div className="row end">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            load(password).then(
              setValues,
              (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
            ).finally(() => setBusy(false));
          }}
        >
          <label>
            Your Harbor password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </label>
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
          <div className="row end">
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" type="submit" disabled={busy || !password}>
              Show
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function RevealLoginDialog({ inst, title, onClose }: { inst: InstanceSummary; title: string; onClose: () => void }) {
  return <RevealDialog title={`Password of ${title}`} load={(password) => api.revealAppLogin(inst.id, password).then((r) => [{ key: 'password', label: 'Password', value: r.password ?? '', visibleLabel: false }])} onClose={onClose} />;
}

export function RevealSecretsDialog({ inst, title, onClose }: { inst: InstanceSummary; title: string; onClose: () => void }) {
  return <RevealDialog title={`Saved passwords of ${title}`} load={(password) => api.revealSecrets(inst.id, password).then((r) => r.secrets.map((s) => ({ key: s.id, label: s.label, value: s.value, visibleLabel: true })))} onClose={onClose} />;
}

// Operator-provided secrets (decision 125): one password-style field per value the plan asks for.
function SecretFields({ plan, values, onChange }: { plan: PlanDto; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const asked = plan.secrets.filter((s) => s.ask);
  if (!asked.length) return null;
  return (
    <fieldset className="storage-choices">
      <legend>{asked.length === 1 ? 'A value this app needs from you' : 'Values this app needs from you'}</legend>
      {asked.map((s) => (
        <label key={s.id} className="small">
          <span>
            {s.prompt ?? s.id}
            {s.ask === 'optional' ? <span className="muted"> · optional</span> : null}
            {s.minLength ? <span className="muted"> · at least {s.minLength} characters</span> : null}
          </span>
          <span className="row">
            <input
              type={shown[s.id] ? 'text' : 'password'}
              value={values[s.id] ?? ''}
              onChange={(e) => onChange({ ...values, [s.id]: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              aria-label={`Value for ${s.id}`}
              maxLength={s.maxLength ?? 4096}
            />
            <button className="btn ghost" type="button" onClick={() => setShown({ ...shown, [s.id]: !shown[s.id] })} aria-label={shown[s.id] ? `Hide ${s.id}` : `Show ${s.id}`}>
              {shown[s.id] ? 'Hide' : 'Show'}
            </button>
            {s.id === 'harbor.login' && (
              // decision 194: a strong one, shown so it can be copied before approving
              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  onChange({ ...values, [s.id]: generatedPassword() });
                  setShown({ ...shown, [s.id]: true });
                }}
              >
                Generate
              </button>
            )}
          </span>
        </label>
      ))}
      <p className="muted small">
        {asked.every((s) => s.id === 'harbor.login') ? "Kept on this machine as a secret of the app; the app's drawer shows it again after you type your Harbor password." : 'Kept on this machine as a secret of the app (like the ones Harbor generates); never shown again, never in logs.'}
      </p>
    </fieldset>
  );
}

// Step 2 of every wizard: review the server-side plan, approve, then the tray takes over.
export function PlanDialog({ c }: { c: Console }) {
  const { pending, plan, planError } = c;
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  // decision 163: permissions get their own explicit yes
  const [permissionsAccepted, setPermissionsAccepted] = useState(false);
  // decision 180: Options — the settings this plan asks about, at their defaults until changed
  const askedSettings = plan?.settings?.filter((s) => s.ask) ?? [];
  const [settingDraft, setSettingDraft] = useState<SettingDraft>({});
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    setSecretValues({});
    setPermissionsAccepted(false);
    setOptionsOpen(false);
    setSettingDraft(draftOf(plan?.settings?.filter((s) => s.ask) ?? [], (s) => s.default));
  }, [plan?.id]);
  const chosenSettings = changedValues(askedSettings, settingDraft, (s) => s.default);
  if (!pending) return null;
  if (c.queuedBehind && 'instance' in pending) {
    // Decision 183: the app is busy, so this action joins the queue without a plan; Harbor plans it at its turn.
    const behind = c.queuedBehind;
    const who = whoOf(c.data.instances.find((i) => i.id === pending.instance.id) ?? pending.instance, pending.instance.name);
    const v = VERB[pending.kind] ?? pending.kind;
    const now = isRunning(behind) ? `Harbor is ${(DOING[behind.kind] ?? behind.kind).toLowerCase()} ${who} right now.` : `${who} is waiting to ${VERB[behind.kind] ?? behind.kind} first.`;
    const dup = c.duplicate;
    if (dup) {
      // The same action already waits for this app: show it (with its Cancel) instead of queueing it twice.
      return (
        <Dialog title={`${isRunning(dup) ? 'Already running' : 'Already queued'}: ${cap(v)} ${who}`} onClose={c.cancel}>
          {planError && (
            <p className="error" role="alert">
              {planError}
            </p>
          )}
          <div className="plan">
            {isRunning(dup) ? (
              // a running Update counts too (decision 183): a second one would only fail at its turn
              <p className="lead">
                Harbor is {(DOING[dup.kind] ?? dup.kind).toLowerCase()} {who} right now. Nothing more to queue.
              </p>
            ) : (
              <p className="lead">
                {cap(v)} {who} is already waiting in the queue. Harbor {dup.queuedAction ? `plans and runs it at its turn` : 'runs it at its turn'}.
              </p>
            )}
            {!dup.cancellable && !isRunning(dup) && <p className="muted">{notCancellableReason(dup)}</p>}
          </div>
          <div className="row end">
            {dup.cancellable && (
              <button className="btn danger" onClick={() => void c.cancelDuplicate()} aria-label={`Cancel ${v} ${who}`}>
                Cancel {v}
              </button>
            )}
            <button className="btn primary" onClick={c.cancel}>
              Keep it
            </button>
          </div>
        </Dialog>
      );
    }
    return (
      <Dialog title={`Queue: ${cap(v)} ${who}`} onClose={c.cancel}>
        {planError && (
          <p className="error" role="alert">
            {planError}
          </p>
        )}
        <div className="plan">
          <p className="lead">
            {now} Harbor will {v} it as soon as that finishes, planning it then.
          </p>
          <p className="muted">It stops and asks you only if it needs something new from you.</p>
          {pending.kind === 'purge' && <p className="warn">Its data volumes, secrets and stored release are deleted. This cannot be undone.</p>}
          {pending.kind === 'remove' && <p className="muted small">Data, secrets, the name and its ports are kept, so Reinstall brings it back as it was.</p>}
        </div>
        <div className="row end">
          <button className="btn" onClick={c.cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void c.approve()}>
            Queue {v}
          </button>
        </div>
      </Dialog>
    );
  }
  const missingSecret = plan ? plan.secrets.some((s) => s.ask === 'required' && (secretValues[s.id] ?? '').length < Math.max(1, s.minLength ?? 1)) : false;
  const opensPorts = plan?.opensPorts ?? [];
  const needsPermission = plan ? (plan.permissions.length > 0 || opensPorts.length > 0) && !permissionsAccepted : false;
  const settingProblem = chosenSettings.problem;
  const typed = Object.fromEntries(Object.entries(secretValues).filter(([id, v]) => v !== '' || plan?.secrets.find((s) => s.id === id)?.ask === 'optional' && plan.kind === 'configure'));
  const title = plan ? (plan.kind === 'install' && pending.kind === 'restore-app' ? 'Review restore' : plan.kind === 'configure' && internetOnly(plan) ? 'Review internet access' : pending.kind === 'configure' && pending.login ? 'Review login' : `Review ${verb(plan.kind)}`) : `Planning ${pending.kind === 'restore-app' ? 'restore' : verb(pending.kind)}…`;
  const appName = plan ? (c.data.catalog.find((i) => i.id === plan.packageId)?.name ?? plan.name) : '';
  const displayName = plan ? (plan.name === plan.packageId ? appName : `${appName} (${plan.name})`) : '';
  const approveLabel = !plan ? '…' : plan.kind === 'remove' ? 'Remove (keep data)' : plan.kind === 'purge' ? 'Delete everything' : plan.kind === 'install' ? (pending.kind === 'restore-app' ? 'Restore here' : 'Install') : plan.kind === 'restore' ? 'Restore now' : plan.kind === 'update' ? 'Update now' : plan.kind === 'expose' ? 'Publish' : plan.kind === 'unexpose' ? 'Withdraw' : plan.kind === 'reconfigure' ? 'Switch' : plan.kind === 'configure' ? 'Apply' : plan.kind === 'seal' ? 'Encrypt now' : plan.kind === 'move' ? 'Move now' : capitalize(plan.kind);
  return (
    <Dialog title={c.locked ? 'Type your password to continue' : title} onClose={c.cancel}>
      {c.locked && <UnlockPrompt onUnlock={c.unlockAndRetry} />}
      {planError && (
        <p className="error" role="alert">
          {planError}
        </p>
      )}
      {c.waitingFor && !plan && (
        <p className="muted" role="status">
          {c.waitingFor}
        </p>
      )}
      {plan && (
        <div className="plan">
          <p className="lead">{humanSummary(plan, displayName)}</p>
          <ul className="plain facts-list">
            {plan.endpoints.length > 0 && plan.kind === 'install' && (
              // decision 157: the same words as the install page — who can reach it, at which address
              <li>
                <span className="fact-k">Access</span>
                <span className="url">
                  {plan.endpoints[0]!.urls.lan || plan.endpoints[0]!.urls.lanSecure ? 'Devices on your home network' : 'Only you, on this machine'} · {endpointUrlHere(plan.endpoints[0]!)}
                </span>
              </li>
            )}
            {plan.ports.map((x) => (
              <li key={`port-${x.id}`}>
                <span className="fact-k">Port</span>
                <span>
                  {x.protocol.toUpperCase()} {x.hostPort} on every network · {x.purpose} <span className="muted small">· to reach it from outside, forward this port on your router to this machine</span>
                </span>
              </li>
            ))}
            {plan.location && (
              <li>
                <span className="fact-k">Storage</span>
                <span>{plan.location.onDrive ? 'Your drive' : 'This machine'}</span>
              </li>
            )}
            {!plan.location && plan.kind === 'install' && (
              <li>
                <span className="fact-k">Encrypted</span>
                <span>no — plain Docker volumes</span>
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
                          {s.purpose || s.id} <span className="muted small">(encrypted with the app)</span>
                        </>
                      ) : (
                        `${s.purpose || s.id}${s.state === 'existing' ? ' (kept from before)' : ''}`
                      )}
                    </span>
                  ))}
                  <span className="muted small"> · Harbor never deletes data</span>
                </span>
              </li>
            )}
            {plan.secrets.some((s) => s.source === 'generated') && (
              <li>
                <span className="fact-k">Secrets</span>
                <span>
                  {plan.secrets.filter((s) => s.source === 'generated').length} generated for the app{plan.secrets.some((s) => s.state === 'existing') ? ' (existing ones kept)' : ''} <span className="muted small">· never shown</span>
                </span>
              </li>
            )}
            {plan.links.filter((l) => l.change !== 'keep').map((l) => (
              <li key={l.id}>
                <span className="fact-k">Link</span>
                <span>
                  {l.change === 'clear' ? (
                    <>unlink {l.id}</>
                  ) : l.provider ? (
                    <>
                      reaches <strong>{l.provider.name}</strong> privately at <code>{l.provider.url}</code> <span className="muted small">· {l.purpose} · a network only these two join</span>
                    </>
                  ) : (
                    <>
                      {l.id}: no provider yet <span className="muted small">· optional · {l.purpose}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
            {(plan.settings ?? [])
              .filter((x) => !x.ask)
              .map((x) => (
                // decision 180: what a configure plan changes, and what an update resets or drops
                <li key={`setting-${x.id}`}>
                  <span className="fact-k">Setting</span>
                  <span>
                    {x.label}:{' '}
                    {x.change === 'dropped' ? (
                      <>no longer part of this release{x.previous !== null ? ` (your value ${settingText(x, x.previous)} is dropped)` : ''}</>
                    ) : x.change === 'reset' ? (
                      <>
                        back to the default {settingText(x, x.default)} <span className="muted small">· this release no longer allows {x.previous !== null ? settingText(x, x.previous) : 'your value'}</span>
                      </>
                    ) : (
                      <>
                        {x.previous !== null ? `${settingText(x, x.previous)} → ` : ''}
                        <strong>{settingText(x, x.value)}</strong>
                        {x.value === x.default ? <span className="muted small"> (default)</span> : null}
                      </>
                    )}
                  </span>
                </li>
              ))}
            {plan.gpu && !plan.permissions.some((x) => x.permission === 'gpu') && (
              // decision 179: already allowed (an update): say what the app gets on this machine now
              <li>
                <span className="fact-k">Graphics card</span>
                <span>{gpuReviewText(plan.gpu, false)}</span>
              </li>
            )}
            {plan.update && (
              <li>
                <span className="fact-k">Version</span>
                <span>{updateLine({ revision: plan.update.fromRevision, version: plan.update.fromVersion }, { revision: plan.update.toRevision, version: plan.update.toVersion })}</span>
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
                  {/* not a link: nothing answers there until this plan is approved and has run */}
                  <span className="url">{plan.exposure.url}</span> <span className="muted small">(once you approve)</span> via {plan.exposure.via === 'tailnet' ? 'your tailnet' : plan.exposure.via === 'proxy' ? 'your own proxy' : 'the public internet'}
                  {plan.exposure.protection === 'basic' ? ', behind a generated password' : ''}
                  {plan.exposure.makePrimary ? '; becomes the address the app uses for itself' : ''}
                </span>
              </li>
            )}
          </ul>
          {(plan.permissions.length > 0 || opensPorts.length > 0) && (
            <fieldset className="permissions">
              <legend>{plan.kind === 'update' ? 'This update also asks to' : 'This app asks to'}</legend>
              <ul className="plain">
                {plan.permissions.map((x) => (
                  <li key={`${x.service}-${x.permission}`}>
                    {x.label} <span className="muted small">· {x.service}</span>
                  </li>
                ))}
                {opensPorts.map((p) => (
                  <li key={`port-${p}`}>
                    Open port {p} on every network this machine is on <span className="muted small">· reachable from outside if your router forwards it</span>
                  </li>
                ))}
              </ul>
              {plan.gpu && plan.permissions.some((x) => x.permission === 'gpu') && <p className="small">{gpuReviewText(plan.gpu)}</p>}
              <label className="row small">
                <input type="checkbox" checked={permissionsAccepted} onChange={(e) => setPermissionsAccepted(e.target.checked)} /> Allow {displayName} to do this
              </label>
            </fieldset>
          )}
          <SecretFields plan={plan} values={secretValues} onChange={setSecretValues} />
          {askedSettings.length > 0 && (
            <details
              className="options"
              open={optionsOpen || Boolean(settingProblem)}
              onToggle={(e) => {
                // an option that cannot be used keeps the section open (Install is off until it is fixed)
                const el = e.currentTarget;
                if (!el.open && settingProblem) el.open = true;
                else setOptionsOpen(el.open);
              }}
            >
              <summary className="small">
                Options <span className={settingProblem ? 'error-text' : 'muted'}>· {optionsSummary(Object.keys(chosenSettings.values).length, chosenSettings.invalid.length, plan.kind === 'update' ? { newCount: askedSettings.length } : null)}</span>
              </summary>
              <SettingFields settings={askedSettings} draft={settingDraft} onChange={setSettingDraft} />
              <p className="muted small">You can change these later on the app page (Settings).</p>
            </details>
          )}
          {plan.notes.map((n, i) => (
            <p key={`n${i}`} className="muted">
              {n}
            </p>
          ))}
          {plan.warnings.map((w, i) => (
            <p key={i} className="warn">
              {w}
            </p>
          ))}
          {plan.kind === 'remove' && <p className="warn">Containers and the private network are deleted. Data, secrets, the name and its ports are kept, so Reinstall brings it back as it was.</p>}
          <details>
            <summary className="muted small">Exactly what Harbor will do ({plan.changes.length} steps)</summary>
            {plan.location && (
              <p className="muted small">
                Stored at <code>{plan.location.dir}</code>
              </p>
            )}
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
      {plan && settingProblem && (
        <p className="error small" role="alert">
          Fix an option first: {settingProblem}
        </p>
      )}
      <div className="row end">
        <button className="btn" onClick={c.cancel}>
          Cancel
        </button>
        {!c.locked && <button className="btn primary" onClick={() => void c.approve(typed, permissionsAccepted, chosenSettings.values)} disabled={!plan || Boolean(planError) || missingSecret || needsPermission || Boolean(settingProblem)} title={missingSecret ? 'Fill in the value the app needs first' : needsPermission ? 'Allow the permissions first' : settingProblem ? `Fix an option first: ${settingProblem}` : undefined}>
          {approveLabel}
        </button>}
      </div>
    </Dialog>
  );
}

// Decision 164: after a daemon restart this machine's key is locked. Instead of "log out and log in", the
// dialog asks for the password once and carries on with the same install, restore or encryption.
function UnlockPrompt({ onUnlock }: { onUnlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack unlock-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        setError(null);
        onUnlock(password).then(
          () => setBusy(false),
          (err: unknown) => {
            setBusy(false);
            setError(err instanceof ApiError ? err.message : String(err));
          },
        );
      }}
    >
      <p className="muted">Harbor restarted, so the key that opens your encrypted apps is locked. Your password unlocks it; nothing else changes.</p>
      <label className="stack">
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus aria-label="Your Harbor password" />
      </label>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button className="btn primary" type="submit" disabled={!password || busy}>
          {busy ? 'Unlocking…' : 'Unlock and continue'}
        </button>
      </div>
    </form>
  );
}

// Free bytes of an install location, null when unknown.
function freeBytes(cd: { totalBytes: number | null; usedBytes: number | null }): number | null {
  return cd.totalBytes !== null && cd.usedBytes !== null ? Math.max(0, cd.totalBytes - cd.usedBytes) : null;
}

// Decimal units on the install page (decision 157), so free space reads like the packages' size hints
// ("about 4 GB") and like the label on the drive itself.
function fmtGB(n: number): string {
  const units: [number, string][] = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
  ];
  for (const [u, name] of units) if (n >= u) return `${(n / u).toFixed(n / u >= 100 ? 0 : 1).replace(/\.0$/, '')} ${name}`;
  return `${Math.round(n / 1e3)} kB`;
}
// lsblk sizes ("14.4G") are binary units: show them in the same decimal units.
function fmtDeviceSize(size: string): string {
  const m = /^([\d.]+)([KMGTP])$/i.exec(size.trim());
  if (!m) return size;
  return fmtGB(Number(m[1]) * 1024 ** ('KMGTP'.indexOf(m[2]!.toUpperCase()) + 1));
}

export function InstallWizard({ item, instances = [], installed = 0, mode: startMode = 'page', onClose, onStart, onRemovePackage, onOpenInstance }: { item: CatalogItemDto; instances?: InstanceSummary[]; installed?: number; mode?: 'page' | 'copy'; onClose: () => void; onStart: (a: Action) => void; onRemovePackage?: () => void; onOpenInstance?: (i: InstanceSummary) => void }) {
  // Decision 170: an installed app's page opens the copy you have; "Add another copy…" (copyable apps only)
  // turns it into the install page, which says it is a separate copy and asks for its name (prefilled
  // with the name the daemon proposes, e.g. immich-2).
  const copies = copiesOf(item.id, instances);
  const copyable = item.multiInstance !== false;
  const [mode, setMode] = useState<'page' | 'copy'>(startMode);
  const view = installView(item, instances, mode);
  // 'reinstall': a one-copy app whose only copy was removed with its data kept — its page brings that copy
  // back instead of offering an install the daemon refuses (decision 170: no dead buttons)
  const appPage = view === 'page' || view === 'reinstall';
  const copyMode = view === 'copy';
  const [name, setName] = useState(() => (copies.active.length > 0 ? defaultCopyName(item, instances) : ''));
  const nameTrim = name.trim();
  // the same check, shown next to whichever name field is on screen (the copy notice, or Advanced)
  const nameError = nameProblem(name, instances, copyMode);
  const nameBlocked = nameError !== null;
  // Decision 126: which installed app satisfies each link ('' = none, optional links only).
  const [linkPick, setLinkPick] = useState<Record<string, string>>({});
  const linkSel = (l: CatalogItemDto['links'][number]) => linkPick[l.id] ?? (l.optional ? '' : (linkCandidates(l, instances)[0]?.id ?? ''));
  const links = Object.fromEntries(item.links.filter((l) => linkSel(l)).map((l) => [l.id, { instanceId: linkSel(l) }]));
  const missingLink = item.links.some((l) => !l.optional && !linkSel(l));
  const [gallery, setGallery] = useState<number | null>(null); // decision 164: the enlarged screenshot, if any
  // storage claim id -> host folder ('' = managed volume)
  const [folders, setFolders] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null); // claim id being chosen
  const [candidates, setCandidates] = useState<HostStorageDto['installCandidates'] | null>(null);
  const [devices, setDevices] = useState<HostStorageDto['devices']>([]);
  // One storage question (decisions 97, 148): the whole app, its data included, is sealed either
  // in the Harbor data folder ('local', Harbor's own key, silent unlock) or on a drive at
  // <mount>/harbor-apps/<package>/<instance>. Apps that offer a media folder default to the
  // plugged-in drive with the most free space; everything else defaults to this machine.
  const [placePick, setPlace] = useState<'local' | 'external' | null>(null);
  const [driveDir, setDriveDir] = useState<string | null>(null); // selected drive candidate dir (<mount>/harbor-apps)
  const [passphrase, setPassphrase] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [formatTarget, setFormatTarget] = useState<HostStorageDto['devices'][number] | null>(null);
  const [formatTyped, setFormatTyped] = useState('');
  // Main address (decision 116): only choices that exist right now; apps that need HTTPS cannot pick plain http.
  const [addr, setAddr] = useState<AddressOptionsDto | null>(null);
  const [mainPick, setMainPick] = useState<string | null>(null); // 'local' | 'tailnet' | 'public:<host>'
  // Decision 186: Also on Tailscale. Ticked by default while Every app on Tailscale is on; the request carries the
  // choice only when it differs from that (absent = the policy decides).
  const [tailnetPolicyOn, setTailnetPolicyOn] = useState(false);
  const [tailnetPick, setTailnetPick] = useState<boolean | null>(null);
  useEffect(() => {
    api.addressOptions().then(setAddr, () => setAddr({ local: { kind: 'loopback', host: 'localhost' }, tailnet: null, domains: [] }));
    api.tailnetAll().then(
      (p) => setTailnetPolicyOn(p.enabled),
      () => setTailnetPolicyOn(false),
    );
  }, []);
  const localOk = !item.requiresHttps || (addr?.local.kind ?? 'loopback') !== 'http';
  const mainChoices: { id: string; label: string; ok: boolean }[] = addr
    ? [
        { id: 'local', label: addr.local.kind === 'loopback' ? 'This machine only' : `Your home network — ${addr.local.kind}://${addr.local.host}`, ok: localOk },
        ...(addr.tailnet ? [{ id: 'tailnet', label: `Tailscale — https://${addr.tailnet.hostname}`, ok: true }] : []),
        ...addr.domains.map((d) => ({ id: `public:${d}`, label: `Your domain — https://${d}`, ok: true })),
      ]
    : [];
  const mainSel = mainPick ?? mainChoices.find((m) => m.ok)?.id ?? null;
  const mainBlocked = addr !== null && !mainChoices.some((m) => m.ok);
  const main = mainSel === 'tailnet' ? { via: 'tailnet' as const } : mainSel?.startsWith('public:') ? { via: 'public' as const, hostname: mainSel.slice('public:'.length) } : undefined;
  const offerTailnet = Boolean(addr?.tailnet) && mainSel !== 'tailnet';
  // Decision 197: a new Harbor has the policy on, so its apps join Tailscale; "Not now" on an existing one is respected.
  const alsoTailnet = tailnetPick ?? tailnetPolicyOn;
  const tailnetReq = offerTailnet && tailnetPick !== null && tailnetPick !== tailnetPolicyOn ? { tailnet: tailnetPick } : {};
  const [askPassword, setAskPassword] = useState(false); // decision 195
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
  const roomiest = (candidates ?? [])
    .filter((cd) => cd.eligible && !cd.label.startsWith('Harbor data folder') && devices.some((d) => d.mountpoint && (cd.dir === `${d.mountpoint}/harbor-apps` || cd.dir.startsWith(`${d.mountpoint}/`))))
    .sort((a, b) => (freeBytes(b) ?? 0) - (freeBytes(a) ?? 0))[0] ?? null;
  // Decision 157: the drive wins only when it has more room than this machine (a 14 GB stick must not
  // beat 219 GB on the system disk for a photo library); unknown local space lets a drive win.
  const localFree = dataCandidate ? freeBytes(dataCandidate) : null;
  const driveWins = roomiest !== null && (localFree === null || (freeBytes(roomiest) ?? 0) > localFree);
  const place = placePick ?? (driveWins && item.claims.some((c) => c.external) ? 'external' : 'local');
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
    const first = roomiest ?? (candidates ?? []).filter((cd) => !cd.label.startsWith('Harbor data folder') && cd.eligible).sort((a, b) => (freeBytes(b) ?? 0) - (freeBytes(a) ?? 0))[0] ?? null;
    if (first) setDriveDir(first.dir);
  }, [place, candidates, driveDir, roomiest]);
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
            if (st.state === 'mounted' && st.mountpoint) {
              setPlace('external');
              setDriveDir(`${st.mountpoint}/harbor-apps`);
            }
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
            if (st.state === 'formatted' && st.mountpoint) {
              setPlace('external');
              setDriveDir(`${st.mountpoint}/harbor-apps`);
            }
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
  // A passphrase is opt-in wherever the app lives (decision 106): without one
  // the Harbor recovery key is what opens the app on another machine.
  const locationMissingPass = customPass && passphrase.length < 8;
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
  // Decision 148: summaries in plain words, the choices behind "Change", everything that can wait
  // (name, own passphrase, own folders, versions) behind "Advanced".
  const [changing, setChanging] = useState<{ storage: boolean; access: boolean; internet: boolean }>({ storage: false, access: false, internet: false });
  // decision 184: internet access; the package's default unless the operator picks another
  const internetDefault: InternetMode = item.internet ?? 'direct';
  const [internetPick, setInternetPick] = useState<InternetMode>(internetDefault);
  const [howOpen, setHowOpen] = useState(false);
  const sectionId = useId();
  const drives = (candidates ?? []).filter((cd) => !cd.label.startsWith('Harbor data folder'));
  const deviceFor = (cd: InstallCandidateDto) => devices.find((d) => d.mountpoint && (cd.dir === `${d.mountpoint}/harbor-apps` || cd.dir.startsWith(`${d.mountpoint}/`))) ?? null;
  const driveName = (cd: InstallCandidateDto) => deviceFor(cd)?.label ?? cd.label.replace(/ \(.*\)$/, '').replace(/^Drive "(.*)"$/, '$1');
  const free = (cd: InstallCandidateDto | null) => {
    const n = cd ? freeBytes(cd) : null;
    return n !== null ? ` · ${fmtGB(n)} free` : '';
  };
  const storeName = place === 'local' ? 'This machine' : driveCandidate ? driveName(driveCandidate) : formattedDrive ? (formattedDrive.label ?? formattedDrive.name) : 'No drive chosen yet';
  const storeFree = place === 'local' ? free(dataCandidate) : free(driveCandidate);
  const optionalFolders = external.filter((c) => !c.external!.required);
  const requiredFolders = external.filter((c) => c.external!.required);
  const ownFolders = external.filter((c) => (folders[c.id] ?? '').trim());
  // decision 157: the headline names what is NOT encrypted as soon as an own folder is ticked
  const plainParts = external.filter((c) => c.id in folders || c.external!.required).map((c) => c.purpose.charAt(0).toLowerCase() + c.purpose.slice(1));
  const singlePlace = candidates !== null && drives.length === 0 && !formattedDrive;
  const onTs = Boolean(addr?.tailnet) && (mainSel === 'tailnet' || alsoTailnet);
  const reachBase = !addr || addr.local.kind === 'loopback' ? 'This machine' : 'Your home network';
  const reach = mainSel?.startsWith('public:') ? (onTs ? `${reachBase}, Tailscale and the internet` : `${reachBase} and the internet`) : onTs ? `${reachBase} and Tailscale` : reachBase === 'This machine' ? 'Only you, on this machine' : reachBase;
  const reachLine = [addr && addr.local.kind !== 'loopback' ? `${addr.local.kind}://${addr.local.host}` : null, onTs && addr?.tailnet ? `https://${addr.tailnet.hostname}` : null, mainSel?.startsWith('public:') ? `https://${mainSel.slice('public:'.length)}` : null].filter(Boolean).join(' · ');
  const hasPassword = item.login?.locked === 'required' || askPassword;
  // decision 195: an app behind Harbor's password has no account to create at the door
  const nextStep = hasPassword ? `After install, copy its password${item.setup ? ', then finish setup inside the app' : ''}.` : item.setup ? `After install you'll create your ${item.name} account.` : item.defaultCredentials ? 'After install, sign in with the default login above.' : `After install, ${item.name} is ready to open.`;
  const formatButton = (d: HostStorageDto['devices'][number]) => (
    <button
      type="button"
      className="btn small danger"
      disabled={busyDevice !== null}
      onClick={(e) => {
        e.preventDefault();
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
  );
  const mountButton = (d: HostStorageDto['devices'][number]) => (
    <button type="button" className="btn small" disabled={busyDevice !== null} onClick={() => mount(d.name)} aria-label={busyDevice === d.name ? `Mounting ${d.label ?? d.name}` : `Mount ${d.label ?? d.name}`} aria-busy={busyDevice === d.name}>
      {busyDevice === d.name ? (
        <>
          <span className="spin" aria-hidden="true" /> Mounting…
        </>
      ) : (
        'Mount it'
      )}
    </button>
  );
  const folderChoice = (c: (typeof external)[number]) => (
    <div className="folder-choice">
      <button className="btn" onClick={() => setPicking(c.id)} aria-label={`Choose folder for ${c.purpose}`}>
        {folders[c.id] ? 'Change folder…' : 'Choose a folder…'}
      </button>
      {folders[c.id] ? <code className="path">{folders[c.id]}</code> : <span className="muted small">{c.external!.hint}</span>}
      <input className="visually-hidden" readOnly value={folders[c.id] ?? ''} aria-label={`Folder for ${c.purpose}`} tabIndex={-1} />
    </div>
  );
  return (
    <Dialog title={item.name} onClose={onClose} wide>
      {copyMode && (
        <div className="copy-notice" role="note" aria-label="Another copy">
          <p>
            <strong>{copies.active.length === 1 ? `You already have ${item.name}.` : `You already have ${copies.active.length} copies of ${item.name}.`}</strong>{' '}
            {copies.active.length === 1 ? 'This installs a separate copy with its own data, address and login; the first one is not touched.' : 'This installs another separate copy with its own data, address and login; the others are not touched.'}
          </p>
          <label className="small">
            Name for this copy
            <input value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9-]{0,62}" aria-label="Name for this copy" aria-invalid={nameBlocked} autoComplete="off" spellCheck={false} />
          </label>
          {nameError && nameTrim !== '' ? (
            <p className="error small" role="alert">
              {nameError}
            </p>
          ) : (
            <p className="muted small">It shows under the icon on Home, so you can tell the copies apart.</p>
          )}
        </div>
      )}
      {!appPage && !copyMode && copies.removed.length > 0 && copyable && (
        <div className="copy-notice" role="note" aria-label="A removed copy">
          <p>A removed copy of {item.name} still keeps its data. This installs a new, separate copy; to get that data back, reinstall the removed copy instead.</p>
          {onOpenInstance && (
            <p>
              <button className="btn small" type="button" onClick={() => onOpenInstance(copies.removed[0]!)} aria-label={`Show the removed copy of ${item.name}`}>
                Show the removed copy
              </button>
            </p>
          )}
        </div>
      )}
      <div className="app-head">
        <AppIcon packageId={item.id} icon={item.presentation.icon} name={item.name} size={56} />
        <div className="stack app-head-text">
          <p className="lead">{item.description}</p>
          {/* decision 164: the project's own pages, from the manifest; the source code (GitHub) first */}
          {(item.presentation.source || item.presentation.website) && (
            <p className="row wrap app-links small">
              {item.presentation.source && (
                <a href={item.presentation.source} target="_blank" rel="noopener noreferrer">
                  {/^https:\/\/github\.com\//.test(item.presentation.source) ? 'Source code on GitHub' : 'Source code'} ↗
                </a>
              )}
              {item.presentation.website && item.presentation.website !== item.presentation.source && (
                <a href={item.presentation.website} target="_blank" rel="noopener noreferrer">
                  {!item.presentation.source && /^https:\/\/github\.com\//.test(item.presentation.website) ? 'Project on GitHub' : 'Website'} ↗
                </a>
              )}
              {item.presentation.developer && <span className="muted">by {item.presentation.developer}</span>}
            </p>
          )}
        </div>
      </div>
      {item.presentation.gallery.length > 0 && (
        <div className="gallery">
          {gallery !== null ? (
            <figure className="gallery-big">
              <img src={`/v1/catalog/${item.id}/asset/${item.presentation.gallery[gallery]}`} alt={`${item.name} screenshot ${gallery + 1}`} />
              <div className="row between">
                <span className="row">
                  <button className="btn ghost small" disabled={gallery === 0} onClick={() => setGallery(gallery - 1)} aria-label="Previous screenshot">
                    ‹
                  </button>
                  <span className="muted small">
                    {gallery + 1} / {item.presentation.gallery.length}
                  </span>
                  <button className="btn ghost small" disabled={gallery === item.presentation.gallery.length - 1} onClick={() => setGallery(gallery + 1)} aria-label="Next screenshot">
                    ›
                  </button>
                </span>
                <button className="btn ghost small" onClick={() => setGallery(null)}>
                  Close
                </button>
              </div>
            </figure>
          ) : (
            <ul className="plain gallery-strip" aria-label={`${item.name} screenshots`}>
              {item.presentation.gallery.map((g, i) => (
                <li key={g}>
                  <button className="gallery-thumb" onClick={() => setGallery(i)} aria-label={`Enlarge screenshot ${i + 1}`}>
                    <img src={`/v1/catalog/${item.id}/asset/${g}`} alt={`${item.name} screenshot ${i + 1}`} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {appPage ? (
        <>
          <section className="install-section" aria-labelledby={`${sectionId}-have`}>
            <h3 className="section-kicker" id={`${sectionId}-have`}>
              On this machine
            </h3>
            <ul className="plain copies">
              {(view === 'reinstall' ? copies.removed : copies.active).map((i) => (
                <li key={i.id} className="row between wrap">
                  <span className="row">
                    <InstanceIcon inst={i} size={28} />
                    <strong>{appLabel(i, instances)}</strong>
                    <StatusPill inst={i} />
                  </span>
                  <button className="btn ghost small" type="button" onClick={() => (onOpenInstance ?? onClose)(i)} aria-label={`See details of ${i.name}`}>
                    Details
                  </button>
                </li>
              ))}
            </ul>
            {!copyable && <p className="muted small">{view === 'reinstall' ? `${item.name} runs as one copy per machine; your removed copy still keeps its data, so reinstall that one.` : `${item.name} runs as one copy per machine.`}</p>}
          </section>
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Close
            </button>
            {copyable && item.availability === 'available' && (
              <button className="btn" onClick={() => setMode('copy')} aria-label={`Add another copy of ${item.name}`}>
                Add another copy…
              </button>
            )}
            {view === 'reinstall' ? (
              // its drawer has Reinstall (the kept data comes back), the same place the Store card goes
              <button className="btn primary" onClick={() => (onOpenInstance ?? onClose)(copies.removed[0]!)} aria-label={`Reinstall ${item.name}`}>
                Reinstall…
              </button>
            ) : (
              <>
                <OpenCopy inst={copies.active[0]!} name={item.name} onManage={(i) => (onOpenInstance ?? onClose)(i)} primary={!outdatedCopy(copies.active)} />
                {outdatedCopy(copies.active) && <UpdateButton inst={outdatedCopy(copies.active)!} copies={copies.active} onUpdate={(i) => onStart({ kind: 'update', instance: i })} />}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {item.defaultCredentials && <DefaultLogin creds={item.defaultCredentials} />}
          <section className="install-section" aria-labelledby={`${sectionId}-storage`}>
            <h3 className="section-kicker" id={`${sectionId}-storage`}>
              Where it lives
            </h3>
            <div className="choice">
              <span className="choice-icon">
                <DriveIcon />
              </span>
              <div className="choice-text">
                <p className="choice-main">
                  <strong>{storeName}</strong>
                  {storeFree}
                </p>
                {item.presentation.sizeHint && <p className="muted small">Needs {item.presentation.sizeHint.charAt(0).toLowerCase() + item.presentation.sizeHint.slice(1)}</p>}
                <p className="muted small">
                  {plainParts.length ? `Encrypted, except ${plainParts.join(' and ')} (your folder)` : customPass ? 'Encrypted with your own passphrase' : 'Encrypted, unlocks when you sign in'}{' '}
                  <button className="btn ghost small" type="button" aria-expanded={howOpen} onClick={() => setHowOpen(!howOpen)} aria-label="How the encryption works">
                    How?
                  </button>
                </p>
                {place === 'external' && <p className="muted small">Unplug the drive and {item.name} pauses until it is back.</p>}
                {howOpen && (
                  <p className="muted small">
                    Harbor seals the whole app, database and files, with Linux's built-in encryption: on disk nothing is readable without the key, not even by root. Your Harbor recovery key opens it on another
                    machine{customPass ? ', and so does your passphrase' : ''}.
                  </p>
                )}
              </div>
              <button className="btn ghost small" type="button" aria-expanded={changing.storage} aria-controls={`${sectionId}-where`} aria-label={`Change where ${item.name} is stored`} onClick={() => setChanging({ ...changing, storage: !changing.storage })}>
                {changing.storage ? 'Done' : 'Change'}
              </button>
            </div>
            {ownFolders.map((c) => (
              <p key={c.id} className="muted small">
                {c.purpose}: your folder <code>{folders[c.id]}</code> (not encrypted)
              </p>
            ))}
            {requiredFolders.map((c) => (
              <div key={c.id} className="claim">
                <p className="claim-title">
                  <strong>{c.purpose}</strong>
                  {c.external!.readOnly && <span className="muted small"> · read-only</span>}
                  <span className="warn small"> · {item.name} needs a folder for this</span>
                </p>
                {folderChoice(c)}
              </div>
            ))}
            {place === 'external' && locationNeedsFormat && (
              <div className="folder-choice">
                <p className="warn small" role="alert">
                  This drive{locationFormatDrive?.fsType ? ` is ${locationFormatDrive.fsType}` : ''} — apps need ext4 (or btrfs, xfs, zfs, apfs). Formatting erases everything on it.
                </p>
                {locationFormatDrive ? formatButton(locationFormatDrive) : <span className="muted small">Format the drive as ext4 in Settings → Storage to use it.</span>}
              </div>
            )}
            {place === 'external' && !locationNeedsFormat && locationNeedsMount && (locationDrive ?? unmountedDrive) && (
              <div className="folder-choice">
                <p className="warn small" role="alert">
                  {(locationDrive ?? unmountedDrive)!.label ?? (locationDrive ?? unmountedDrive)!.name} is plugged in but not mounted — mount it before installing, or pick another drive.
                </p>
                {mountButton((locationDrive ?? unmountedDrive)!)}
              </div>
            )}
            {deviceError && (
              <p className="error small" role="alert">
                {deviceError}
              </p>
            )}
            {changing.storage && (
              <fieldset className="storage-choices" id={`${sectionId}-where`}>
                <legend>Where to keep {item.name}</legend>
                {singlePlace ? (
                  // one place only: plain text, not a one-option radio group (decision 157)
                  <p className="check">This machine{free(dataCandidate)} · the only place right now</p>
                ) : (
                  <label className="check">
                    <input type="radio" name="loc" checked={place === 'local'} onChange={() => setPlace('local')} /> This machine{free(dataCandidate)}
                  </label>
                )}
                {drives.map((cd) => {
                  const drive = deviceFor(cd);
                  return (
                    <label key={cd.dir} className="check" title={cd.eligible ? undefined : (cd.reason ?? 'not available')}>
                      <input
                        type="radio"
                        name="loc"
                        checked={place === 'external' && driveDir === cd.dir}
                        disabled={!cd.eligible}
                        onChange={() => {
                          setPlace('external');
                          setDriveDir(cd.dir);
                        }}
                      />{' '}
                      {driveName(cd)}
                      {free(cd)}
                      {!cd.eligible && (
                        <span className="muted small">
                          {' '}
                          · {cd.reason} {drive ? formatButton(drive) : <span className="muted small">(format the drive as ext4 in Settings → Storage to use it)</span>}
                        </span>
                      )}
                    </label>
                  );
                })}
                {formattedDrive && !driveCandidate && (
                  <label className="check">
                    <input type="radio" name="loc" checked={place === 'external'} onChange={() => setPlace('external')} /> {formattedDrive.label ?? formattedDrive.name} · {fmtDeviceSize(formattedDrive.size)}
                  </label>
                )}
                {candidates === null && <p className="muted small">Checking drives…</p>}
                {candidates !== null && drives.length === 0 && unmounted.length === 0 && !formattedDrive && <p className="muted small">No external drive found. Plug one in to see it here.</p>}
                {unmounted.map((d) => {
                  // A drive on the wrong filesystem can never hold an app even once mounted: offer Format, not Mount.
                  const wrongFs = needsFormatForApps(d.fsType);
                  return (
                    <p key={d.device} className="muted small">
                      {wrongFs ? `${d.label ?? d.name} (${fmtDeviceSize(d.size)}) uses ${d.fsType}, which cannot hold apps. Format it as ext4 to use it.` : `${d.label ?? d.name} (${fmtDeviceSize(d.size)}) is plugged in. Mount it to use it.`} {wrongFs ? formatButton(d) : mountButton(d)}
                    </p>
                  );
                })}
              </fieldset>
            )}
          </section>
          <section className="install-section" aria-labelledby={`${sectionId}-access`}>
            <h3 className="section-kicker" id={`${sectionId}-access`}>
              Who can reach it
            </h3>
            <div className="choice">
              <span className="choice-icon">
                <PeopleIcon />
              </span>
              <div className="choice-text">
                <p className="choice-main">
                  <strong>{reach}</strong>
                </p>
                {reachLine ? <p className="muted small url">{reachLine}</p> : null}
                {addr && !addr.tailnet ? (
                  <p className="muted small">
                    Tailscale is not connected. <a href="#/settings/remote">Connect it</a> to reach your apps from anywhere.
                  </p>
                ) : null}
              </div>
              {(mainChoices.length > 1 || offerTailnet) && (
                <button className="btn ghost small" type="button" aria-expanded={changing.access} aria-controls={`${sectionId}-main`} aria-label={`Change who can reach ${item.name}`} onClick={() => setChanging({ ...changing, access: !changing.access })}>
                  {changing.access ? 'Done' : 'Change'}
                </button>
              )}
            </div>
            {mainBlocked && (
              <p className="warn small" role="alert">
                {item.name} needs HTTPS: browsers block what it needs on a plain http:// address. Turn on secure addresses in Settings → Network, or connect Tailscale, then install it.
              </p>
            )}
            {changing.access && (
              <fieldset className="storage-choices" id={`${sectionId}-main`}>
                <legend>Opens first at</legend>
                <p className="muted small">The address {item.name} puts in links it sends. Tailscale or a domain also shares it there.</p>
                {mainChoices.map((m) => (
                  <label key={m.id} className="check url" title={m.ok ? undefined : 'Needs HTTPS'}>
                    <input type="radio" name="main-address" checked={mainSel === m.id} disabled={!m.ok} onChange={() => setMainPick(m.id)} /> {m.label}
                    {!m.ok && <span className="muted small"> — needs HTTPS</span>}
                  </label>
                ))}
              </fieldset>
            )}
            {changing.access && offerTailnet && addr?.tailnet && (
              <label className="check small">
                <input type="checkbox" checked={alsoTailnet} onChange={(e) => setTailnetPick(e.target.checked)} aria-label="Also on Tailscale" /> Also on Tailscale — your tailnet devices get their own address
                {tailnetPolicyOn && !alsoTailnet ? <span className="muted"> · kept off although every app gets one</span> : null}
              </label>
            )}
            {item.login && item.login.locked !== 'never' && (
              <div className="choice">
                <span className="choice-icon">
                  <LockIcon />
                </span>
                <div className="choice-text">
                  {item.login.locked === 'required' ? (
                    <>
                      <p className="choice-main">
                        <strong>One password for the whole app</strong>
                      </p>
                      <p className="muted small">This app requires it. Harbor makes one and shows it after install.</p>
                    </>
                  ) : (
                    <label className="check">
                      <input type="checkbox" checked={askPassword} onChange={(e) => setAskPassword(e.target.checked)} aria-label="Ask for a password first" /> <strong>Ask for a password first</strong>
                      <span className="muted small block">{item.login.ownLogin ? `${item.name} has its own login, so this would ask twice.` : 'One password for the whole app, at every address.'} Harbor makes one and shows it after install.</span>
                    </label>
                  )}
                </div>
              </div>
            )}
            <div className="choice">
              <span className="choice-icon">
                <GlobeIcon />
              </span>
              <div className="choice-text">
                <p className="choice-main">
                  <strong>Internet: {internetLabel(internetPick)}</strong>
                  {internetPick === internetDefault && internetDefault !== 'direct' ? <span className="muted small"> · what {item.name} asks for</span> : null}
                </p>
                <p className="muted small">{internetHint(internetPick)}</p>
              </div>
              <button className="btn ghost small" type="button" aria-expanded={changing.internet} aria-controls={`${sectionId}-internet`} aria-label={`Change how ${item.name} reaches the internet`} onClick={() => setChanging({ ...changing, internet: !changing.internet })}>
                {changing.internet ? 'Done' : 'Change'}
              </button>
            </div>
            {changing.internet && (
              <fieldset className="storage-choices" id={`${sectionId}-internet`}>
                <legend>Internet access</legend>
                <p className="muted small">People reach {item.name} the same way in every case; this only decides what it may open itself.</p>
                {INTERNET_CHOICES.map((m) => (
                  <label key={m.mode} className="check">
                    <input type="radio" name="internet-access" checked={internetPick === m.mode} onChange={() => setInternetPick(m.mode)} /> {m.label}
                    {m.mode === internetDefault && internetDefault !== 'direct' ? <span className="muted small"> (its default)</span> : null}
                  </label>
                ))}
              </fieldset>
            )}
          </section>
          {item.links.length > 0 && (
            <fieldset className="storage-choices">
              <legend>Talks privately to</legend>
              <p className="muted small">Only these two apps are connected; everything else stays separate.</p>
              {item.links.map((l) => {
                const cands = linkCandidates(l, instances);
                return (
                  <label key={l.id} className="small">
                    <span>
                      {l.purpose}
                      {l.optional ? <span className="muted"> · optional</span> : null}
                    </span>
                    {cands.length ? (
                      <select value={linkSel(l)} onChange={(e) => setLinkPick({ ...linkPick, [l.id]: e.target.value })} aria-label={`Provider for ${l.id}`}>
                        {l.optional && <option value="">None for now</option>}
                        {cands.map((i) => (
                          <option key={i.id} value={i.id}>
                            {appLabel(i)} ({i.name})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={l.optional ? 'muted small' : 'warn small'} role={l.optional ? undefined : 'alert'}>
                        {l.optional ? 'Nothing to link to yet; you can link it later from the app page.' : `Install ${l.packages ? l.packages.join(' or ') : 'the app it talks to'} first.`}
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}
          <details className="advanced">
            <summary>More options: name, passphrase, folders, technical details</summary>
            <div className="advanced-body">
              {!copyMode && (
                <label className="small">
                  Instance name (optional)
                  <input value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z][a-z0-9-]{0,62}" placeholder={item.id} aria-label={`Instance name for ${item.name}`} aria-invalid={nameBlocked} />
                  {nameError && (
                    <span className="error small" role="alert">
                      {nameError}
                    </span>
                  )}
                </label>
              )}
              {!customPass ? (
                <p className="muted small">
                  <button className="btn ghost" type="button" onClick={() => setCustomPass(true)}>
                    Use my own passphrase instead…
                  </button>
                </p>
              ) : (
                <label className="small">
                  Encryption passphrase (8+ characters). Write it down: losing it loses the data. Only needed to open {item.name} where your Harbor recovery key is not available, for example on a drive you hand
                  to someone else.
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
              {optionalFolders.map((c) => (
                <div key={c.id} className="claim">
                  <label className="check">
                    <input type="checkbox" checked={c.id in folders} onChange={(e) => (e.target.checked ? setFolders((f) => ({ ...f, [c.id]: f[c.id] ?? '' })) : setFolders(({ [c.id]: _drop, ...rest }) => rest))} /> Keep{' '}
                    {c.purpose.charAt(0).toLowerCase() + c.purpose.slice(1)} in a folder of my own (not encrypted)
                    {c.external!.readOnly && <span className="muted small"> · read-only</span>}
                  </label>
                  {c.id in folders && folderChoice(c)}
                </div>
              ))}
              <dl className="tech">
                <dt>Stored at</dt>
                <dd>
                  <code className="path">{locationHome ?? (formattedDrive && driveDir ? `${driveDir}/${item.id}/${slugName}` : '…')}</code>
                </dd>
                <dt>Data</dt>
                <dd>{item.storage ? `${item.storage} data volume${item.storage > 1 ? 's' : ''}, kept when you remove the app` : 'No data of its own'}</dd>
                <dt>Version</dt>
                <dd>
                  {[
                    item.version ? `Version ${item.version.replace(/^v(?=\d)/, '')}` : null,
                    `Harbor package revision ${item.revision}`,
                    item.origin === 'local' ? 'your own upload' : item.qualification === 'passed' ? 'tested on a real machine' : 'not yet tested on a real machine',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </dd>
                <dt>About</dt>
                <dd>
                  {categoryLabel(item.presentation.category)}
                  {item.presentation.developer ? ` · by ${item.presentation.developer}` : ''}
                </dd>
                {item.presentation.releaseNotes && (
                  <>
                    <dt>Release notes</dt>
                    <dd>{item.presentation.releaseNotes}</dd>
                  </>
                )}
              </dl>
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
            </div>
          </details>
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
          <p className="next-step muted small">{nextStep}</p>
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={item.availability !== 'available' || nameBlocked || mainBlocked || missingRequired || missingLink || locationMissingPass || locationBlocked || (place === 'local' && !locationDir) || (place === 'external' && !locationDir && !formattedDrive)}
              onClick={() => onStart({ kind: 'install', packageId: item.id, name: nameTrim, storage, ...(main ? { main } : {}), ...tailnetReq, ...(askPassword ? { login: true } : {}), ...(Object.keys(links).length ? { links } : {}), ...(internetPick !== internetDefault ? { internet: internetPick } : {}), ...(locationDir ? (customPass ? { location: { dir: locationDir, passphrase } } : { location: { dir: locationDir } }) : formattedDrive && driveDir ? (customPass ? { location: { dir: `${driveDir}/${item.id}`, passphrase } } : { location: { dir: `${driveDir}/${item.id}` } }) : {}) })}
              aria-label={`Install ${item.name} now`}
              title={nameError ? nameError : locationBlocked ? (locationNeedsFormat ? 'This drive needs formatting as ext4 first' : 'Mount the drive before installing') : locationMissingPass ? 'The encryption passphrase needs 8+ characters' : undefined}
            >
              Install
            </button>
          </div>
        </>
      )}
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

// Decision 198: Add a domain (one dialog: the name, the DNS record to create, a live check), your own proxy, and the
// list of an app's addresses. Tailscale lives on the app's own switch and on the Publishing page.
export type PublishMode = 'domain' | 'proxy' | 'manage';
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
function suggestedDomain(items: DomainsDto['items'], name: string): string {
  const parent = [...items].reverse().map((d) => d.hostname.split('.')).find((p) => p.length >= 3 && !(p.length === 3 && p[1]!.length <= 3))?.slice(1).join('.');
  return parent ? `${name}.${parent}` : '';
}
export function PublishWizard({ inst, exposures, tools, mode: startMode = 'domain', onClose, onStart }: { inst: InstanceSummary; exposures: ExposureDto[]; tools: PlatformToolDto[]; mode?: PublishMode; onClose: () => void; onStart: (a: Action) => void }) {
  const [mode, setMode] = useState<PublishMode>(startMode);
  const [proxyFrom, setProxyFrom] = useState('');
  const [hostname, setHostname] = useState('');
  const [domains, setDomains] = useState<DomainsDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [makePrimary, setMakePrimary] = useState(false);
  const login = inst.login;
  const canAsk = Boolean(login && login.locked === null && !login.on);
  const [askPassword, setAskPassword] = useState(Boolean(login && !login.ownLogin));
  useEffect(() => {
    api.domains().then(
      (d) => {
        setDomains(d);
        setHostname((h) => h || (startMode === 'domain' ? suggestedDomain(d.items, inst.name) : ''));
      },
      () => setDomains(null),
    );
  }, [inst.id, inst.name, startMode]);
  const px = tools.find((t) => t.id === 'proxy');
  const primary = inst.endpoints.find((e) => e.id === inst.primaryEndpoint) ?? inst.endpoints[0];
  const known = domains?.items.find((d) => d.hostname === hostname) ?? null;
  const validHost = HOST_RE.test(hostname);
  const proxyReady = px?.installationState === 'installed';
  const has = exposures.some((e) => e.via === 'proxy');
  const taken = known?.usedBy && known.usedBy.instanceId !== inst.id ? known.usedBy.instanceName : null;
  const check = async () => {
    if (!validHost) return;
    setChecking(true);
    setDnsError(null);
    try {
      if (known) await api.checkDomain(hostname);
      else await api.addDomain(hostname);
      setDomains(await api.domains());
    } catch (e) {
      setDnsError(e instanceof ApiError ? `${e.message}. ${e.nextAction ?? ''}`.trim() : String(e));
    } finally {
      setChecking(false);
    }
  };
  const recordValue = domains?.publicIp.v4 ?? domains?.publicIp.v6 ?? null;
  const recordType = domains?.publicIp.v4 ? 'A' : 'AAAA';
  const title = mode === 'manage' ? `Addresses of ${inst.name}` : mode === 'proxy' ? `Use your own proxy for ${inst.name}` : `Add a domain to ${inst.name}`;
  return (
    <Dialog title={title} onClose={onClose}>
      {mode === 'manage' && (
        <>
          <ul className="plain">
            {exposures.map((e) => (
              <li key={e.id} className="row between">
                <span>
                  <Pill tone="info">{e.via === 'tailnet' ? 'Tailscale' : e.via === 'public' ? 'Domain' : 'Your proxy'}</Pill>{' '}
                  <a href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.url}
                  </a>{' '}
                  {e.state !== 'active' && <Pill tone={e.state === 'degraded' ? 'warn' : 'busy'}>{e.state}</Pill>}
                  {e.isPrimary && <span className="muted small"> main</span>}
                  {e.protection === 'basic' && <span className="muted small"> · basic auth</span>}
                  {e.note && <span className="muted small"> · {e.note}</span>}
                </span>
                <span className="row">
                  {!e.isPrimary && e.state === 'active' && e.via !== 'proxy' && (
                    <button className="btn ghost" onClick={() => onStart({ kind: 'reconfigure', instance: inst, primary: e.via as 'tailnet' | 'public', ...(e.via === 'public' ? { hostname: e.hostname } : {}) })} aria-label={e.via === 'public' ? `Make ${e.hostname} primary` : `Make ${e.via} primary`}>
                      Make main
                    </button>
                  )}
                  <button className="btn danger" onClick={() => onStart({ kind: 'unexpose', instance: inst, via: e.via, ...(e.via === 'public' ? { hostname: e.hostname } : {}) })} aria-label={e.via === 'public' ? `Withdraw ${e.hostname}` : `Withdraw ${e.via} address`}>
                    Withdraw
                  </button>
                </span>
              </li>
            ))}
            {primary && primary.primary !== 'loopback' && (
              <li className="row between">
                <span>
                  <Pill tone="muted">Home</Pill> {primary.urls.loopback}
                </span>
                <button className="btn ghost" onClick={() => onStart({ kind: 'reconfigure', instance: inst, primary: 'loopback' })} aria-label="Make the home address primary">
                  Make main
                </button>
              </li>
            )}
          </ul>
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setMode('domain');
                setHostname(suggestedDomain(domains?.items ?? [], inst.name));
              }}
            >
              Add a domain…
            </button>
          </div>
        </>
      )}
      {mode === 'domain' && (
        <>
          {!proxyReady && <p className="warn">{px?.note ?? 'The public proxy is not set up.'}</p>}
          <label className="small">
            Domain
            <input value={hostname} onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} onBlur={() => void (validHost && !known ? check() : undefined)} placeholder="app.example.com" aria-label="Domain" autoComplete="off" spellCheck={false} />
          </label>
          {taken && (
            <p className="warn small" role="alert">
              {taken} already uses this domain.
            </p>
          )}
          {validHost && !taken && (
            <section className="dns-card" aria-label="DNS check" role="status">
              {known?.dns.state === 'points_here' ? (
                <>
                  <strong className="ok-text">Points to this machine</strong>
                  <p className="muted small">Harbor gets the HTTPS certificate on its own.</p>
                </>
              ) : (
                <>
                  <strong className="warn">{known?.dns.state === 'points_elsewhere' ? 'Points somewhere else' : known?.dns.state === 'no_record' ? 'Not pointing here yet' : 'Not checked yet'}</strong>
                  {recordValue ? (
                    <>
                      <p className="small">Add this record where you manage the domain. If this machine is behind a router, also forward ports 80 and 443 to it.</p>
                      <table className="dns-record">
                        <thead>
                          <tr>
                            <th scope="col">Type</th>
                            <th scope="col">Name</th>
                            <th scope="col">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>{recordType}</td>
                            <td>{hostname}</td>
                            <td>
                              {recordValue} <Copy text={recordValue} />
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </>
                  ) : (
                    <p className="warn small">Harbor could not detect this machine's public address{domains?.publicIp.error ? ` (${domains.publicIp.error})` : ''}. Find it in your router or from your provider.</p>
                  )}
                </>
              )}
              <div className="row">
                <button className="btn small" type="button" disabled={checking} onClick={() => void check()}>
                  {checking ? 'Checking…' : known ? 'Check again' : 'Check'}
                </button>
              </div>
            </section>
          )}
          {dnsError && (
            <p className="error small" role="alert">
              {dnsError}
            </p>
          )}
          {login && login.on && <p className="muted small">The internet gets this app's one password first{login.locked === 'required' ? ' (always on)' : ''}.</p>}
          {canAsk && (
            <label className="check">
              <input type="checkbox" checked={askPassword} onChange={(e) => setAskPassword(e.target.checked)} aria-label="Ask for a password first" /> Ask for a password first
              <span className="muted small block">
                {login!.ownLogin ? `${inst.name} has its own login, so this would ask twice.` : `${inst.name} has no login of its own.`} {login!.hasPassword ? 'Uses the password it already has.' : 'Harbor makes one and shows it once.'} {inst.name} restarts once.
              </span>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={makePrimary} onChange={(e) => setMakePrimary(e.target.checked)} aria-label="Make this the main address" /> Make this the main address
            <span className="muted small block">Links the app sends will use it.</span>
          </label>
          <div className="row between wrap">
            <button className="btn ghost" onClick={() => setMode('proxy')}>
              Use my own proxy instead
            </button>
            <span className="row">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!proxyReady || !validHost || Boolean(taken)} onClick={() => onStart({ kind: 'expose', instance: inst, via: 'public', hostname, protection: 'none', makePrimary, ...(canAsk && askPassword ? { login: true } : {}) })}>
                Review…
              </button>
            </span>
          </div>
        </>
      )}
      {mode === 'proxy' && (
        <>
          <label className="small">
            Hostname your proxy serves
            <input value={hostname} onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} placeholder="cloud.example.com" aria-label="Hostname your proxy serves" />
          </label>
          <label className="small">
            Your proxy&apos;s LAN address (the machine it runs on)
            <input value={proxyFrom} onChange={(e) => setProxyFrom(e.target.value.trim())} placeholder="192.168.0.20" aria-label="Your proxy's LAN address" />
          </label>
          <p className="muted small">
            Your proxy keeps the certificate and forwards to this machine on port {primary?.hostPort ?? '…'} (turn WebSockets on). Harbor tells the app about the hostname and trusts forwarded headers only from that address.
          </p>
          <div className="row end">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={has || !hostname || !proxyFrom} onClick={() => onStart({ kind: 'expose', instance: inst, via: 'proxy', hostname, protection: 'none', makePrimary: false, proxyFrom })}>
              {has ? 'Already on your proxy' : 'Review…'}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

export function UnlockForm({ inst, onUnlocked, onError }: { inst: InstanceSummary; onUnlocked: () => void; onError: (m: string | null) => void }) {
  const [pass, setPass] = useState('');
  const [show, setShow] = useState(false);
  const [working, setWorking] = useState(false);
  return (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pass || working) return;
        setWorking(true);
        onError(null);
        void api
          .unlockApp(inst.id, pass)
          .then(() => {
            setPass('');
            onUnlocked();
          })
          .catch((err: Error) => onError(err.message))
          .finally(() => setWorking(false));
      }}
    >
      <input value={pass} onChange={(e) => setPass(e.target.value)} type={show ? 'text' : 'password'} autoComplete="current-password" aria-label={`Encryption passphrase for ${inst.name}`} placeholder="App passphrase or 12-word recovery key" />
      <button className="btn ghost" type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide passphrase' : 'Show passphrase'}>
        {show ? 'Hide' : 'Show'}
      </button>
      <button className="btn primary" type="submit" disabled={working || !pass} aria-label={`Unlock ${inst.name}`}>
        {working ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  );
}

// Decision 145: move an encrypted app to another place that can hold apps (data folder, an ext4 drive).
export function MovePanel({ inst, current, onMove }: { inst: InstanceSummary; current: string; onMove: (dir: string) => void }) {
  const [cands, setCands] = useState<HostStorageDto['installCandidates'] | null>(null);
  const [pick, setPick] = useState('');
  const load = () => api.hostStorage().then((s) => setCands(s.installCandidates), () => setCands([]));
  const options = (cands ?? []).filter((c) => c.eligible && !current.startsWith(`${c.dir}/`));
  return (
    <details className="quiet-panel" onToggle={(e) => (e.target as HTMLDetailsElement).open && cands === null && void load()}>
      <summary className="small">Move to…</summary>
      <p className="small muted">
        Lives at <code className="path">{current}</code>. Moving copies its data sealed (never as plaintext on a disk) and keeps its passphrase and recovery words. It is down during the copy.
      </p>
      {cands === null ? (
        <p className="muted small">Checking places…</p>
      ) : options.length === 0 ? (
        <p className="muted small">No other place can hold it right now. Plug in an ext4 drive (Settings → Storage can format one).</p>
      ) : (
        <div className="row wrap">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`New place for ${inst.name}`}>
            <option value="">Choose a place…</option>
            {options.map((c) => (
              <option key={c.dir} value={c.dir}>
                {c.label}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!pick} onClick={() => onMove(`${pick}/${inst.packageId}`)} aria-label={`Move ${inst.name}`}>
            Move
          </button>
        </div>
      )}
    </details>
  );
}

// Decision 143: change how an encrypted app opens. Its data is not re-encrypted: the app key is wrapped anew.
export function PassphrasePanel({ inst, defaultKey: given, onChanged }: { inst: InstanceSummary; defaultKey: boolean; onChanged: ((i: InstanceSummary) => void) | undefined }) {
  // follows the server, and our own change at once (the drawer's detail poll lags a few seconds)
  const [defaultKey, setDefaultKey] = useState(given);
  useEffect(() => setDefaultKey(given), [given]);
  const [mode, setMode] = useState<'own' | 'harbor'>(defaultKey ? 'own' : 'harbor');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [words, setWords] = useState<string | null>(null);
  const mismatch = mode === 'own' && again.length > 0 && next !== again;
  const ready = mode === 'harbor' ? !defaultKey : next.length >= 8 && next === again;
  return (
    <details className="quiet-panel">
      <summary className="small">Change passphrase…</summary>
      <p className="small muted">{defaultKey ? "It opens with Harbor's own key now and unlocks when you log in." : 'It opens with its own passphrase now.'} Changing this re-wraps its key; the data itself is not copied or re-encrypted.</p>
      <fieldset className="storage-choices">
        <legend className="small">Open it with</legend>
        <label className="check">
          <input type="radio" name={`pp-${inst.id}`} checked={mode === 'own'} onChange={() => setMode('own')} /> {defaultKey ? 'My own passphrase' : 'A new passphrase'}
        </label>
        <label className="check">
          <input type="radio" name={`pp-${inst.id}`} checked={mode === 'harbor'} disabled={defaultKey} onChange={() => setMode('harbor')} /> Harbor's own key (unlocks when you log in on this machine)
        </label>
      </fieldset>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || working) return;
          setWorking(true);
          setMsg(null);
          void api
            .changePassphrase(inst.id, current, mode === 'harbor' ? null : next)
            .then((r) => {
              setCurrent('');
              setNext('');
              setAgain('');
              setWords(r.recoveryKey);
              setDefaultKey(mode === 'harbor');
              setMsg(mode === 'harbor' ? "Done: it opens with Harbor's own key now." : 'Done: it has its new passphrase.');
              onChanged?.(r.instance);
            })
            .catch((err: Error) => setMsg(err.message))
            .finally(() => setWorking(false));
        }}
      >
        {!defaultKey && <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-label={`Current passphrase of ${inst.name}`} placeholder="Current passphrase, its 12 words or your Harbor recovery key" />}
        {mode === 'own' && (
          <>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label={`New passphrase for ${inst.name}`} placeholder="New passphrase (8+ characters)" />
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label={`New passphrase for ${inst.name} again`} placeholder="New passphrase again" />
            {mismatch && <p className="warn small">The two new passphrases differ.</p>}
          </>
        )}
        <button className="btn" type="submit" disabled={!ready || working} aria-label={`Change passphrase of ${inst.name}`}>
          {working ? 'Changing…' : 'Change'}
        </button>
      </form>
      {msg && (
        <p className="small" role="status">
          {msg}
        </p>
      )}
      {words && <RecoveryCard words={words} note={`These 12 words open ${inst.name} on any Harbor machine if its passphrase is forgotten. Shown once.`} onDismiss={() => setWords(null)} />}
    </details>
  );
}

// Decision 184: Direct, Through the VPN, Offline, or back to the app's own default; Review makes a configure plan.
export function InternetDialog({ inst, title, onClose, onReview }: { inst: InstanceSummary; title: string; onClose: () => void; onReview: (m: InternetMode | 'default') => void }) {
  const current: InternetMode | 'default' = inst.internet.choice ?? 'default';
  const [pick, setPick] = useState<InternetMode | 'default'>(current);
  const def = inst.internet.packageDefault;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (pick !== current) onReview(pick);
        }}
      >
        <p className="muted small">People reach the app the same way in every case. A running app restarts for a few seconds, so its lookups follow too.</p>
        <fieldset className="storage-choices">
          <legend>Internet access</legend>
          <label className="check">
            <input type="radio" name="internet-pick" checked={pick === 'default'} onChange={() => setPick('default')} /> The app's default: {internetLabel(def)}
          </label>
          {INTERNET_CHOICES.map((m) => (
            <label key={m.mode} className="check">
              <input type="radio" name="internet-pick" checked={pick === m.mode} onChange={() => setPick(m.mode)} /> {m.label}
              <span className="muted small"> · {m.hint}</span>
            </label>
          ))}
        </fieldset>
        {inst.internet.allApps && (pick === 'direct' || (pick === 'default' && def === 'direct')) && <p className="notice small">Every app goes through the VPN right now (Settings → VPN), so this one does too.</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pick === current} title={pick === current ? 'Pick another one first' : undefined}>
            Review
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function humanSummary(plan: PlanDto, n: string): string {  switch (plan.kind) {
    case 'install':
      return plan.location
        ? `Harbor will install ${n} ${plan.location.onDrive ? 'on your drive' : 'on this machine'}, encrypted. It usually takes a minute or two (the first time includes downloading the app).`
        : `Harbor will install ${n} on this machine. It usually takes a minute or two (the first time includes downloading the app).`;
    case 'start':
      return `Harbor will start ${n} again with the same data and address.`;
    case 'stop':
      return `Harbor will stop ${n}. Nothing is deleted; Start brings it back.`;
    case 'restart':
      return `Harbor will restart ${n} with its current addresses (for example after you changed network settings). Data, secrets and ports stay.`;
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
    case 'configure':
      if (internetOnly(plan)) return `Harbor will change what ${n} may open on the internet. The firewall changes first; a running app then restarts for a few seconds so its lookups follow too. People reach ${n} as before.`;
      return `Harbor will apply the new settings to ${n} and recreate only what changed. Data, ports and addresses stay.`;
    case 'move':
      return `Harbor will move ${n} to ${plan.location?.dir ?? 'its new place'}: it stops, its data is copied sealed (never as plaintext on a disk), and it starts from there. The old copy is deleted only after that works.`;
    case 'backup':
      return `Harbor will stop ${n} for a moment, send what changed since the last pass to its backup places, and start it again.`;
    case 'restore':
      return `Harbor will put ${n} back as it was at ${plan.changes.find((c) => c.includes('restore the data of'))?.match(/data of (\S+)/)?.[1] ?? 'the restore point'}. Its current data is kept aside until you delete it; if anything fails, it runs as it was.`;
    case 'seal':
      return `Harbor will encrypt ${n} in place: it stops, its data is copied into a sealed home at ${plan.location?.dir ?? 'the Harbor data folder'}, and it starts again on the sealed copy. The plain copy is deleted only after that works.`;
    case 'update':
      return `Harbor will update ${n} ${updateSentence(plan)}. Data, ports and addresses stay; if the new release does not start, the previous one is put back automatically.`;
    case 'relink':
      return `Harbor will attach the private links of ${n} again with only the names it gives them. Nothing is recreated; each link drops for a moment.`;
  }
}

// decision 184: a configure plan that only changes internet access (a host rule; nothing is recreated)
function internetOnly(plan: PlanDto): boolean {
  return Boolean(plan.internet) && plan.changes.every((c) => c.startsWith('Internet access'));
}

function verb(kind: PlanDto['kind']): string {
  return { install: 'install', start: 'start', stop: 'stop', remove: 'removal', reinstall: 'reinstall', purge: 'full uninstall', update: 'update', expose: 'publishing', unexpose: 'withdrawal', reconfigure: 'address switch', restart: 'restart', configure: 'new settings', seal: 'encryption', move: 'move', backup: 'backup', restore: 'restore', relink: 'link check' }[kind];
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

// "from v0.11.3 to v0.12.0" when both versions are known and differ (decision 174), else the revisions.
function updateSentence(plan: PlanDto): string {
  const u = plan.update;
  if (!u) return `to revision ${plan.revision}`;
  if (u.fromVersion && u.toVersion && u.fromVersion !== u.toVersion) return `from ${fmtVersion(u.fromVersion)} to ${fmtVersion(u.toVersion)}`;
  return `from revision ${u.fromRevision} to ${u.toRevision}${u.toVersion ? ` (${fmtVersion(u.toVersion)})` : ''}`;
}
