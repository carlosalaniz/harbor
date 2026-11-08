import { useCallback, useEffect, useState } from 'react';
import type { PlanDto, TailnetAllDto } from '../../../src/contracts/api';
import { ApiError, api, newIdempotencyKey } from '../api';
import { Dialog, Pill } from './components';
import type { Console } from './store';

// Decision 177: "Give every app a Tailscale address" — opt-in; turning it on is reviewed in a dialog that lists the
// apps, turning it off withdraws nothing. Each address is still its own plan (actor tailnet-policy), one at a time.
const TAILNET_STATE: Record<TailnetAllDto['apps'][number]['state'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'busy' }> = {
  published: { label: 'on Tailscale', tone: 'ok' },
  pending: { label: 'next', tone: 'busy' },
  waiting: { label: 'later', tone: 'muted' },
  failed: { label: 'failed', tone: 'bad' },
  excluded: { label: 'kept off', tone: 'muted' },
};
export function EveryAppOnTailscale({ c }: { c: Console }) {
  const [p, setP] = useState<TailnetAllDto | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Decision 186: the bulk list. pick = the rows the operator changed (instance id -> wants an address); Review makes
  // one ordinary expose/unexpose plan per change, the dialog lists them, Apply approves them all (each its own
  // operation in the tray, run in turn by the queue).
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [bulk, setBulk] = useState<{ plans: { plan: PlanDto; name: string; on: boolean }[]; errors: string[] } | null>(null);
  const load = useCallback(() => api.tailnetAll().then(setP, () => setP(null)), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  const set = async (fn: () => Promise<TailnetAllDto>) => {
    setBusy(true);
    setMsg(null);
    try {
      setP(await fn());
      await c.refresh();
    } catch (e) {
      setMsg(e instanceof ApiError ? `${e.message}. ${e.nextAction}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!p) return null;
  const offerCount = p.apps.filter((a) => a.url === null && a.state !== 'excluded').length;
  const toGet = p.apps.filter((a) => a.state !== 'published' && a.state !== 'excluded');
  const keptOff = p.apps.filter((a) => a.state === 'excluded');
  const has = (a: TailnetAllDto['apps'][number]) => a.url !== null;
  const wants = (a: TailnetAllDto['apps'][number]) => pick[a.instanceId] ?? has(a);
  const changes = p.apps.filter((a) => wants(a) !== has(a));
  const canPublish = !p.reason;
  const selectAll = (on: boolean) => setPick(Object.fromEntries(p.apps.filter((a) => on !== has(a) && (canPublish || !on)).map((a) => [a.instanceId, on])));
  const review = async () => {
    setBusy(true);
    setMsg(null);
    const plans: { plan: PlanDto; name: string; on: boolean }[] = [];
    // one line per reason, naming the apps it stopped (no free port left reads once, not once per app)
    const refused = new Map<string, string[]>();
    for (const a of changes) {
      const on = wants(a);
      try {
        plans.push({ plan: await api.plan({ kind: on ? 'expose' : 'unexpose', instanceId: a.instanceId, via: 'tailnet' }), name: a.name, on });
      } catch (e) {
        const why = e instanceof ApiError ? `${e.message}. ${e.nextAction ?? ''}`.trim() : String(e);
        refused.set(why, [...(refused.get(why) ?? []), a.name]);
      }
    }
    setBulk({ plans, errors: [...refused].map(([why, names]) => `${names.join(', ')}: ${why}`) });
    setBusy(false);
  };
  const apply = async () => {
    if (!bulk) return;
    setBusy(true);
    const errors: string[] = [];
    for (const x of bulk.plans) {
      try {
        c.accepted((await api.submit(x.plan.id, newIdempotencyKey())).operation);
        // ticked by hand: no longer "kept off" either, so the drawer's On Tailscale switch agrees with this list
        if (x.on && p?.except.includes(x.plan.instanceId)) await api.setTailnetAllIncluded(x.plan.instanceId, true);
      } catch (e) {
        errors.push(`${x.name}: ${e instanceof ApiError ? e.message : String(e)}`);
      }
    }
    setBulk(null);
    setPick({});
    setBusy(false);
    if (errors.length) setMsg(`Not changed: ${errors.join('; ')}`);
    void load();
  };
  return (
    <div className="stack">
      {p.offer && (
        // decision 197: an existing Harbor is asked once; a new one starts this way
        <section className="offer-card" aria-label="Put your apps on Tailscale">
          <div>
            <strong>
              Put your {offerCount} other app{offerCount === 1 ? '' : 's'} on Tailscale?
            </strong>
            <p className="muted small">Asked once. Harbor never adds them without asking.</p>
          </div>
          <span className="row">
            <button className="btn small" disabled={busy} onClick={() => void set(() => api.dismissTailnetOffer())}>
              Not now
            </button>
            <button className="btn small primary" disabled={busy} onClick={() => setConfirm(true)}>
              Review {offerCount} app{offerCount === 1 ? '' : 's'}…
            </button>
          </span>
        </section>
      )}
      <div className="row between wrap">
        <div>
          <h3 id="ra-all-h">Every app on Tailscale</h3>
          <p className="muted small">Give every app its own address on your tailnet, new installs included. Any device on your tailnet can reach them. Keep one off with the On Tailscale switch in its drawer.</p>
        </div>
        <label className="row">
          <input
            type="checkbox"
            checked={p.enabled}
            disabled={busy}
            onChange={(e) => {
              if (!e.target.checked) void set(() => api.setTailnetAll(false));
              else if (p.reason) setMsg(`Every app cannot get a Tailscale address yet: ${p.reason}. ${p.nextAction ?? ''}`);
              else setConfirm(true);
            }}
            aria-label="Give every app a Tailscale address"
          />
          <span className="small">{p.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      {p.status === 'waiting' && (
        <p className="warn small" role="status">
          Waiting: {p.reason}. {p.nextAction}
        </p>
      )}
      {p.enabled && <p className="muted small">Turning this off keeps every address it gave. To take one app off the tailnet, untick it below and apply.</p>}
      {p.apps.length > 0 && (
        <div className="stack">
          <div className="row between wrap">
            <h3 id="ra-apps-h">Apps on Tailscale</h3>
            <span className="row">
              <button className="btn ghost small" disabled={busy || !canPublish} onClick={() => selectAll(true)}>
                Select all
              </button>
              <button className="btn ghost small" disabled={busy} onClick={() => selectAll(false)}>
                Select none
              </button>
            </span>
          </div>
          <ul className="addresses" aria-labelledby="ra-apps-h">
            {p.apps.map((a) => (
              <li key={a.instanceId}>
                <label className="check">
                  <input type="checkbox" checked={wants(a)} disabled={busy || (!has(a) && !canPublish)} onChange={(e) => setPick({ ...pick, [a.instanceId]: e.target.checked })} aria-label={`Address for ${a.name} on Tailscale`} /> <strong>{a.name}</strong>
                </label>{' '}
                {wants(a) !== has(a) ? (
                  <Pill tone="info">{wants(a) ? 'gets an address' : 'loses its address'}</Pill>
                ) : a.url ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.url}
                  </a>
                ) : p.enabled || p.asked.includes(a.instanceId) ? (
                  <>
                    <Pill tone={TAILNET_STATE[a.state].tone}>{TAILNET_STATE[a.state].label}</Pill> <span className="muted small">{a.note}</span>
                  </>
                ) : (
                  <span className="muted small">not on Tailscale</span>
                )}
                {a.state === 'failed' && !a.url && (
                  <button className="btn small" disabled={busy} onClick={() => void set(() => api.setTailnetAllIncluded(a.instanceId, true))} aria-label={`Try the Tailscale address of ${a.name} again`}>
                    Try again
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="row end">
            {changes.length > 0 && (
              <button className="btn ghost" disabled={busy} onClick={() => setPick({})}>
                Undo
              </button>
            )}
            <button className="btn primary" disabled={busy || changes.length === 0} onClick={() => void review()}>
              {changes.length ? `Review ${changes.length} change${changes.length === 1 ? '' : 's'}` : 'No changes'}
            </button>
          </div>
        </div>
      )}
      {bulk && (
        <Dialog title="Change Tailscale addresses?" onClose={() => setBulk(null)}>
          {bulk.plans.some((x) => x.on) && (
            <>
              <p>These apps get an address on your tailnet: any device on your tailnet can reach them.</p>
              <ul aria-label="Apps that get a Tailscale address">
                {bulk.plans
                  .filter((x) => x.on)
                  .map((x) => (
                    <li key={x.plan.id}>
                      {x.name} <span className="muted small url">· {x.plan.exposure?.url ?? 'tailnet'}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
          {bulk.plans.some((x) => !x.on) && (
            <>
              <p>These apps lose their tailnet address (Every app on Tailscale then leaves them off):</p>
              <ul aria-label="Apps that lose their Tailscale address">
                {bulk.plans
                  .filter((x) => !x.on)
                  .map((x) => (
                    <li key={x.plan.id}>
                      {x.name}
                      {x.plan.warnings.length ? <span className="muted small"> · {x.plan.warnings.join(' ')}</span> : null}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {bulk.errors.length > 0 && (
            <div className="warn small" role="alert">
              <p>Cannot change:</p>
              <ul>
                {bulk.errors.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">Each change is its own operation in the tray; they run one after another.</p>
          <div className="row end">
            <button className="btn" onClick={() => setBulk(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || bulk.plans.length === 0} onClick={() => void apply()}>
              Apply {bulk.plans.length} change{bulk.plans.length === 1 ? '' : 's'}
            </button>
          </div>
        </Dialog>
      )}
      {confirm && (
        <Dialog title="Give every app a Tailscale address?" onClose={() => setConfirm(false)}>
          <p>Every app gets an address on your tailnet: any device on your tailnet can reach it.</p>
          {toGet.length > 0 ? (
            <>
              <p className="muted small">These apps get one, one at a time, each as its own operation in the tray:</p>
              <ul aria-label="Apps that get a Tailscale address">
                {toGet.map((a) => (
                  <li key={a.instanceId}>
                    {a.name}
                    {a.state === 'waiting' && a.note ? <span className="muted small"> · {a.note}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted small">Every app already has one.</p>
          )}
          {keptOff.length > 0 && (
            <p className="muted small">
              Kept off (you withdrew their address, or switched them off in their drawer): {keptOff.map((a) => a.name).join(', ')}. Switch one back on in its drawer to include it.
            </p>
          )}
          <p className="muted small">New installs get theirs once they run, before you have created their account: create it right away. Their main address does not change. Turning this off later never withdraws an address.</p>
          <p className="muted small">They share your machine's one tailnet name, one port each. Harbor keeps each app's login cookies to itself.</p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                void set(() => api.setTailnetAll(true));
              }}
            >
              Give every app an address
            </button>
          </div>
        </Dialog>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </div>
  );
}

