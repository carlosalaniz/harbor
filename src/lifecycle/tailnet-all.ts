import type { InstallState, PlanDto, PlanRequest, Readiness, Runtime, TailnetAllAppDto, TailnetAllAppState, TailnetAllDto } from '../contracts/api.js';
import type { TailscaleProvider } from '../exposure/tailscale.js';
import { exposureUrl } from '../exposure/urls.js';
import { HarborError } from '../errors.js';
import type { InstanceRow, Repo } from '../state/repo.js';
import { rfc3339 } from '../util.js';
import type { Ctx } from './context.js';

// Decision 177: "Give every app a Tailscale address", an opt-in policy. The observer asks it once per tick (only on a
// tick that could see Docker); it never touches Docker or tailscale itself: each address is an ordinary expose plan
// (via tailnet, not the main address) submitted with actor `tailnet-policy` through the serial queue.

export const TAILNET_ALL_SETTING = 'exposure.tailnetAll';
export const TAILNET_POLICY_ACTOR = 'tailnet-policy';
export const TAILNET_ALL_NOTIFICATION = 'tailnet-all-failed';

export interface TailnetAllSetting {
  enabled: boolean;
  except: string[]; // instance ids the operator keeps off the tailnet
  // decision 186: apps whose install asked for an address (Also on Tailscale) while the policy is off; the policy
  // publishes them like any app, and drops them from here once they have one
  asked: string[];
  // decision 197: Not now on the one-time question of an existing Harbor
  offerDismissed?: boolean;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function readTailnetAll(repo: Repo): TailnetAllSetting {
  const raw = repo.setting<Partial<TailnetAllSetting>>(TAILNET_ALL_SETTING);
  return { enabled: raw?.enabled === true, except: ids(raw?.except), asked: ids(raw?.asked), ...(raw?.offerDismissed ? { offerDismissed: true } : {}) };
}

// Which apps the policy plans for: every app while it is on, else only the ones their install asked for.
export function policyCovers(s: Pick<TailnetAllSetting, 'enabled' | 'asked'>, instanceId: string): boolean {
  return s.enabled || s.asked.includes(instanceId);
}

// What the policy needs to know about one app (read from the repo by the caller; nothing here does I/O).
export interface TailnetAllCandidate {
  id: string;
  installState: InstallState;
  activeOperationId: string | null;
  runtime: Runtime;
  readiness: Readiness;
  tailnetUrl: string | null; // the tailnet address of its primary endpoint, when it has one
  hasPrimaryEndpoint: boolean;
  planOpen: boolean; // a plan for it is open for review (an approve would fail if the policy changed the app first)
}

export interface TailnetAllMemory {
  except: ReadonlySet<string>;
  attempted: ReadonlySet<string>; // tried since this daemon started
  failed: ReadonlyMap<string, string>; // instance -> why
  inFlight: ReadonlySet<string>; // its policy operation is queued or running
}

// Where one app stands under the policy. `pending` = it gets a plan at the next check (or its plan is running).
// Every kind of primary endpoint counts, API endpoints too: a tailnet address is as useful to a script on a laptop
// as to a browser.
export function tailnetAllState(app: TailnetAllCandidate, mem: TailnetAllMemory): { state: TailnetAllAppState; note: string | null } {
  if (app.tailnetUrl) return { state: 'published', note: null };
  if (mem.except.has(app.id)) return { state: 'excluded', note: 'kept off the tailnet' };
  const why = mem.failed.get(app.id);
  if (why !== undefined) return { state: 'failed', note: why };
  if (mem.inFlight.has(app.id)) return { state: 'pending', note: 'getting its address now' };
  if (app.installState === 'installing') return { state: 'waiting', note: 'installing; it gets its address once it runs' };
  if (app.installState !== 'installed') return { state: 'waiting', note: `it is ${app.installState.replace('_', ' ')}; it gets its address once it runs again` };
  if (app.activeOperationId) return { state: 'waiting', note: 'another operation is running' };
  if (app.planOpen) return { state: 'waiting', note: 'a plan for it is open for review; it gets its address once that is approved or expires' };
  if (!app.hasPrimaryEndpoint) return { state: 'waiting', note: 'it has no address to publish' };
  if (app.runtime !== 'running') return { state: 'waiting', note: 'stopped; it gets its address when it runs' };
  if (app.readiness !== 'healthy') return { state: 'waiting', note: 'not answering yet; it gets its address once it does' };
  if (mem.attempted.has(app.id)) return { state: 'waiting', note: 'tried once since Harbor started; publish it from its Publish dialog, or Try again' };
  return { state: 'pending', note: 'gets its address at the next check' };
}

// The apps that need a plan now (in order): eligible, not tried yet since the daemon started, nothing in flight.
export function tailnetAllCandidates(apps: TailnetAllCandidate[], mem: TailnetAllMemory): string[] {
  return apps.filter((a) => !mem.inFlight.has(a.id) && tailnetAllState(a, mem).state === 'pending').map((a) => a.id);
}

export type TailnetReadiness = { ready: true; hostname: string } | { ready: false; reason: string; nextAction: string };

export async function tailnetReadiness(ts: TailscaleProvider): Promise<TailnetReadiness> {
  let st;
  try {
    st = await ts.status();
  } catch {
    st = null;
  }
  if (!st) {
    const installed = await ts.installed().catch(() => false);
    if (!installed) return { ready: false, reason: 'Tailscale is not installed on this machine', nextAction: 'Run once on the machine: sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale, then log in under Settings → Remote access.' };
    return { ready: false, reason: 'Tailscale does not answer on this machine', nextAction: 'Check `tailscale status` on the machine, then try again.' };
  }
  if (st.backendState !== 'Running' || !st.dnsName) return { ready: false, reason: 'this machine is not logged in to your tailnet', nextAction: 'Log in under Settings → Remote access (or: harbor tailscale login).' };
  // a node that is logged in but offline would spend every app's one attempt on serves that fail
  if (!st.online) return { ready: false, reason: 'this machine is offline on your tailnet', nextAction: 'Check its network and `tailscale status` on the machine; Harbor carries on once it is back online.' };
  if (!st.httpsEnabled) return { ready: false, reason: 'HTTPS certificates are off for your tailnet', nextAction: 'In the Tailscale admin console, under DNS, turn on MagicDNS and click Enable HTTPS, then try again.' };
  return { ready: true, hostname: st.dnsName };
}

// Submit refusals that only mean "not now" (the app got busy, changed, or Docker blinked between the check and the
// submit): the app is not marked failed and is tried again at a later check.
const NOT_NOW = new Set(['BUSY', 'STATE_CHANGED', 'PLAN_EXPIRED', 'DOCKER_UNAVAILABLE']);

export interface TailnetAllHost {
  createPlan(req: PlanRequest, actor: string): Promise<PlanDto>;
  submit(planId: string, idempotencyKey: string, actor: string): { operation: { id: string } };
  instanceRow(idOrName: string): InstanceRow;
  primaryEndpointOf(i: InstanceRow): string;
}

export class TailnetAllPolicy {
  private readonly attempted = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly inFlight = new Map<string, string>(); // instance -> operation
  constructor(
    private readonly ctx: Ctx,
    private readonly host: TailnetAllHost,
  ) {}

  // The stored policy, without exceptions for apps that no longer exist (purged). A removed app that Harbor keeps
  // for Reinstall keeps its exception, so Reinstall honours the operator's choice. Reading never writes (a GET has
  // no side effects): the stored list is pruned by the observer's check and by every write.
  setting(): TailnetAllSetting {
    const s = readTailnetAll(this.ctx.repo);
    const known = new Set(this.ctx.repo.listInstances().map((i) => i.id));
    return { ...s, except: [...new Set(s.except.filter((id) => known.has(id)))], asked: [...new Set(s.asked.filter((id) => known.has(id)))] };
  }

  // Read-modify-write on the freshest stored value (nothing awaits in between), so a change made meanwhile by the
  // drawer, the CLI or a withdrawal is never lost.
  private update(fn: (s: TailnetAllSetting) => TailnetAllSetting): TailnetAllSetting {
    const next = fn(this.setting());
    this.ctx.repo.setSetting(TAILNET_ALL_SETTING, next);
    return next;
  }

  private candidates(): { row: InstanceRow; app: TailnetAllCandidate }[] {
    const { repo } = this.ctx;
    // plans someone is reviewing (the policy's own unsubmitted plans do not hold the app back)
    const openFor = new Set(repo.openPlans(rfc3339(this.ctx.clock.now())).filter((p) => p.actor !== TAILNET_POLICY_ACTOR).map((p) => p.instanceId));
    const out: { row: InstanceRow; app: TailnetAllCandidate }[] = [];
    for (const row of repo.listInstances()) {
      if (row.installState === 'retained') continue;
      let primary: string | null = null;
      try {
        primary = this.host.primaryEndpointOf(row);
      } catch {
        primary = null;
      }
      // the policy is about the address the app opens at: a tailnet address on another endpoint does not count
      const tailnet = repo.exposures(row.id).find((e) => e.via === 'tailnet' && e.endpointId === primary);
      out.push({ row, app: { id: row.id, installState: row.installState, activeOperationId: row.activeOperationId, runtime: row.runtime, readiness: row.readiness, tailnetUrl: tailnet ? exposureUrl(tailnet) : null, hasPrimaryEndpoint: primary !== null && row.endpoints.some((e) => e.id === primary), planOpen: openFor.has(row.id) } });
    }
    return out;
  }

  private memory(except: string[]): TailnetAllMemory {
    return { except: new Set(except), attempted: this.attempted, failed: this.failed, inFlight: new Set(this.inFlight.keys()) };
  }

  // A plain read: no write, no notification (the observer's check settles finished operations).
  async status(): Promise<TailnetAllDto> {
    const s = this.setting();
    const r = await tailnetReadiness(this.ctx.tailscale);
    const mem = this.memory(s.except);
    const apps: TailnetAllAppDto[] = this.candidates().map(({ row, app }) => ({ instanceId: row.id, name: row.displayName ?? row.name, url: app.tailnetUrl, ...tailnetAllState(app, mem) }));
    const offer = !s.enabled && r.ready && !s.offerDismissed && apps.some((a) => a.url === null && a.state !== 'excluded');
    return { enabled: s.enabled, status: !s.enabled ? 'off' : r.ready ? 'on' : 'waiting', reason: r.ready ? null : r.reason, nextAction: r.ready ? null : r.nextAction, except: s.except, asked: s.asked, apps, offer };
  }

  // Turning it on is refused while Tailscale cannot publish anything; turning it off never withdraws an address.
  async setEnabled(enabled: boolean): Promise<TailnetAllDto> {
    if (enabled) {
      const r = await tailnetReadiness(this.ctx.tailscale);
      if (!r.ready) throw new HarborError('UNSUPPORTED_CAPABILITY', `every app cannot get a Tailscale address yet: ${r.reason}`, { nextAction: r.nextAction });
    }
    const was = this.setting().enabled;
    if (enabled && !was) {
      // a fresh start of the policy: every app gets one attempt again
      this.attempted.clear();
      this.failed.clear();
    }
    this.update((s) => ({ ...s, enabled }));
    if (!enabled) this.resolveAll();
    this.ctx.log.info(`every-app Tailscale addresses ${enabled ? 'on' : 'off'}`, {});
    return this.status();
  }

  // Decision 197: Not now on the one-time question.
  async dismissOffer(): Promise<TailnetAllDto> {
    this.update((s) => ({ ...s, offerDismissed: true }));
    return this.status();
  }

  // The per-app switch. Excluding never withdraws the current address; including clears the exception and any
  // failed attempt, so the policy publishes it at its next check.
  async setIncluded(idOrName: string, included: boolean): Promise<TailnetAllDto> {
    const inst = this.host.instanceRow(idOrName);
    this.update((s) => ({ ...s, except: included ? s.except.filter((x) => x !== inst.id) : [...new Set([...s.except, inst.id])], asked: included ? s.asked : s.asked.filter((x) => x !== inst.id) }));
    if (included) {
      this.attempted.delete(inst.id);
      this.failed.delete(inst.id);
    }
    this.ctx.notifier.resolve(`tailnet-all:${inst.id}`);
    this.ctx.repo.addEvent({ instanceId: inst.id, phase: 'policy', message: included ? 'included in "every app gets a Tailscale address" again' : 'kept off the tailnet by the "every app gets a Tailscale address" policy (its current address, if any, stays)' });
    return this.status();
  }

  // The operator withdrew an app's tailnet address (policy on or off): keep it off from now on, so turning the
  // policy on later does not undo a deliberate withdrawal.
  operatorWithdrew(instanceId: string): void {
    const now = this.setting();
    if (now.except.includes(instanceId) && !now.asked.includes(instanceId)) return;
    this.update((s) => ({ ...s, except: [...new Set([...s.except, instanceId])], asked: s.asked.filter((x) => x !== instanceId) }));
    this.ctx.repo.addEvent({ instanceId, phase: 'policy', message: 'its Tailscale address was withdrawn by hand: the "every app gets a Tailscale address" policy leaves it off the tailnet from now on' });
  }

  // A line for the install plan (decision 177): the new app gets its address after it starts. `want` is the install's
  // Also on Tailscale choice (decision 186; absent = what the policy says). publishes: whether it will get one.
  async installNote(want?: boolean): Promise<{ note: string | null; publishes: boolean }> {
    const on = readTailnetAll(this.ctx.repo).enabled;
    if (want === false) return { note: on ? 'It stays off your tailnet (Every app on Tailscale leaves it out).' : null, publishes: false };
    if (!on && want !== true) return { note: null, publishes: false };
    const r = await tailnetReadiness(this.ctx.tailscale);
    const why = on ? ' (every app gets a Tailscale address)' : '';
    // decision 197: on by default on a new Harbor, so a machine without Tailscale says nothing about it
    if (!r.ready && want === undefined) return { note: null, publishes: false };
    return { note: r.ready ? `It also gets an address on your tailnet once it runs${why}.` : `It also gets an address on your tailnet once it runs and Tailscale is ready (${r.reason}).`, publishes: true };
  }

  // Decision 186: the install's Also on Tailscale choice, recorded once the app exists (the install operation).
  // Yes: the policy publishes it once it runs, policy on or off. No: kept off while the policy is on.
  installChoice(instanceId: string, want: boolean): void {
    const s = this.update((x) => ({
      ...x,
      except: want ? x.except.filter((id) => id !== instanceId) : x.enabled ? [...new Set([...x.except, instanceId])] : x.except,
      asked: want && !x.enabled ? [...new Set([...x.asked, instanceId])] : x.asked.filter((id) => id !== instanceId),
    }));
    if (want) {
      this.attempted.delete(instanceId);
      this.failed.delete(instanceId);
    }
    if (want || s.enabled) this.ctx.repo.addEvent({ instanceId, phase: 'policy', message: want ? 'gets an address on your tailnet once it runs (Also on Tailscale, chosen at install)' : 'kept off the tailnet (chosen at install)' });
  }

  private resolveAll(): void {
    for (const n of this.ctx.repo.notifications({ limit: 500 })) if (n.kind === TAILNET_ALL_NOTIFICATION) this.ctx.notifier.resolve(n.dedupeKey);
  }

  private fail(row: InstanceRow, why: string): void {
    this.failed.set(row.id, why);
    const label = row.displayName ?? row.name;
    this.ctx.notifier.notify({ kind: TAILNET_ALL_NOTIFICATION, severity: 'warning', title: `${label} did not get its Tailscale address`, body: `${why} Harbor tries once per start. Try again from Settings → Remote access, or publish it from its Publish dialog.`, instanceId: row.id, dedupeKey: `tailnet-all:${row.id}` });
    this.ctx.log.warn(`tailnet-policy could not publish ${row.name}: ${why}`, { instanceId: row.id });
  }

  // How the operations this policy submitted ended.
  private collect(): void {
    for (const [instanceId, operationId] of [...this.inFlight]) {
      const op = this.ctx.repo.operation(operationId);
      if (!op) {
        this.inFlight.delete(instanceId);
        continue;
      }
      if (op.state !== 'succeeded' && op.state !== 'failed' && op.state !== 'needs_action' && op.state !== 'cancelled') continue;
      this.inFlight.delete(instanceId);
      // decision 183: a person cancelled it before it ran: no failure to report, and not retried until the next start
      if (op.state === 'cancelled') continue;
      const row = this.ctx.repo.instance(instanceId);
      // the address is recorded (a later step such as a restart hook may have failed): that is the policy's success
      const published = row !== null && this.candidates().some((c) => c.row.id === instanceId && c.app.tailnetUrl !== null);
      if (op.state === 'succeeded' || published) {
        // attempts only stop failure loops: a success leaves the app free to get an address again if it loses it
        this.attempted.delete(instanceId);
        this.ctx.notifier.resolve(`tailnet-all:${instanceId}`);
      } else if (row) this.fail(row, `${op.errorMessage ?? `the operation ${op.state === 'failed' ? 'failed' : 'needs attention'}`}${/[.!?]$/.test(op.errorMessage ?? '') ? '' : '.'}`);
    }
  }

  // Called by the observer on a tick that saw Docker. One plan at a time, and only while no other operation runs:
  // a tailnet port is picked at plan time, so two plans made together could pick the same one.
  async reconcile(): Promise<void> {
    // the stored exceptions lose purged apps here (a read never writes)
    const stored = readTailnetAll(this.ctx.repo);
    if (stored.except.length !== this.setting().except.length || stored.asked.length !== this.setting().asked.length) this.update((x) => x);
    this.collect();
    const all = this.candidates();
    // an app that has its address now is no failure, whoever published it, and no longer waits for one (decision 186)
    for (const c of all) if (c.app.tailnetUrl) this.failed.delete(c.row.id);
    const got = new Set(all.filter((c) => c.app.tailnetUrl).map((c) => c.row.id));
    if (this.setting().asked.some((id) => got.has(id))) this.update((x) => ({ ...x, asked: x.asked.filter((id) => !got.has(id)) }));
    const s = this.setting();
    // a failure notification goes when its condition does (policy off, app kept off, published or retried later)
    for (const n of this.ctx.repo.notifications({ limit: 500 })) {
      if (n.kind !== TAILNET_ALL_NOTIFICATION || !n.instanceId) continue;
      if (!policyCovers(s, n.instanceId) || !this.failed.has(n.instanceId) || s.except.includes(n.instanceId)) this.ctx.notifier.resolve(n.dedupeKey);
    }
    if ((!s.enabled && !s.asked.length) || this.inFlight.size) return;
    if (this.ctx.repo.listInstances().some((i) => i.activeOperationId)) return;
    const next = tailnetAllCandidates(
      all.filter((c) => policyCovers(s, c.row.id)).map((c) => c.app),
      this.memory(s.except),
    )[0];
    if (!next) return;
    if (!(await tailnetReadiness(this.ctx.tailscale)).ready) return;
    const row = all.find((c) => c.row.id === next)!.row;
    this.attempted.add(row.id);
    try {
      const plan = await this.host.createPlan({ kind: 'expose', instanceId: row.id, via: 'tailnet', makePrimary: false }, TAILNET_POLICY_ACTOR);
      // planning awaited tailscale and Docker: the operator may have turned the policy off or kept this app off
      // meanwhile. Then the plan is simply never submitted (it expires).
      const now = this.setting();
      if (!policyCovers(now, row.id) || now.except.includes(row.id)) {
        this.attempted.delete(row.id);
        return;
      }
      const r = this.host.submit(plan.id, this.ctx.ids.uuid(), TAILNET_POLICY_ACTOR);
      this.inFlight.set(row.id, r.operation.id);
      this.ctx.log.info(`tailnet-policy publishes ${row.name} on the tailnet`, { instanceId: row.id, operationId: r.operation.id });
    } catch (e) {
      if (e instanceof HarborError && NOT_NOW.has(e.code)) {
        // a passing race, not a verdict on the app: try it again at a later check
        this.attempted.delete(row.id);
        this.ctx.log.info(`tailnet-policy will publish ${row.name} later: ${e.message}`, { instanceId: row.id });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.fail(row, `${msg}${/[.!?]$/.test(msg) ? '' : '.'}`);
    }
  }
}
