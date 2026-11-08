import { tailnetServeTarget } from '../../src/system/lan-https.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';
import type { ExposureDto, InstanceSummary, NotificationsDto, PlanDto, PlanRequest, TailnetAllDto } from '../../src/contracts/api.js';
import { TAILNET_ALL_SETTING, TAILNET_POLICY_ACTOR } from '../../src/lifecycle/tailnet-all.js';
import { HarborError } from '../../src/errors.js';

// Decision 177: "Give every app a Tailscale address" — an opt-in policy the observer carries out through ordinary
// expose plans (actor tailnet-policy), one at a time, once per app and daemon start.
let h: Harness;
const ids: Record<string, string> = {};
beforeAll(async () => {
  h = await startHarness();
  writePackage(h.catalogDir, 'demo', { manifest: MINIMAL_MANIFEST, compose: `services:\n  web:\n    image: example/demo@${DIGEST_A}\n`, images: { web: `example/demo@${DIGEST_A}` } });
  const withSetup = MINIMAL_MANIFEST.replace('id: demo', 'id: demo-setup').replace('name: Demo', 'name: Demo Setup') + 'setup:\n  endpoint: web\n  instructions: The first visitor creates the owner account.\n';
  writePackage(h.catalogDir, 'demo-setup', { manifest: withSetup, compose: `services:\n  web:\n    image: example/demo@${DIGEST_A}\n`, images: { web: `example/demo@${DIGEST_A}` } });
});
afterAll(async () => {
  await h.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const policy = () => h.api.expect<TailnetAllDto>(200, 'GET', '/v1/exposures/tailnet-all');
const setPolicy = (enabled: boolean) => h.api.expect<TailnetAllDto>(200, 'PUT', '/v1/exposures/tailnet-all', { enabled });
const tailnetOf = async () => (await h.api.expect<{ items: ExposureDto[] }>(200, 'GET', '/v1/exposures')).items.filter((e) => e.via === 'tailnet');
const policyOps = (instanceId?: string) => h.daemon.ctx.repo.listOperations(500).filter((o) => o.actor === TAILNET_POLICY_ACTOR && (!instanceId || o.instanceId === instanceId));
const appState = (p: TailnetAllDto, name: string) => p.apps.find((a) => a.name === name);
const failureRows = async (instanceId: string) => (await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items.filter((n) => n.kind === 'tailnet-all-failed' && n.instanceId === instanceId);
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const healthy = (name: string) => until(`${name} healthy`, async () => (await h.api.instances()).find((i: InstanceSummary) => i.name === name && i.readiness === 'healthy'));
const onTailnet = (name: string) => until(`${name} on the tailnet`, async () => (await tailnetOf()).find((e) => e.instanceId === ids[name]));
async function install(name: string, packageId = 'demo'): Promise<PlanDto> {
  const r = await h.api.run({ kind: 'install', packageId, name });
  expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
  ids[name] = r.op.instanceId;
  return r.plan;
}

describe('every app gets a Tailscale address (decision 177)', () => {
  it('installs five apps; removes one (kept for Reinstall)', async () => {
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'omega']) {
      // with the policy off the install plan says nothing about the tailnet
      expect((await install(name)).notes.join(' ')).not.toMatch(/tailnet/);
    }
    expect((await h.api.run({ kind: 'remove', instanceId: ids['omega'] })).op.state).toBe('succeeded');
    const p = await policy();
    expect(p).toMatchObject({ enabled: false, status: 'off', except: [] });
    expect(p.apps.map((a) => a.name).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']); // a removed app is not listed
  });

  it('turning it on is refused while Tailscale has no HTTPS certificates (or is offline); nothing changes', async () => {
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: false };
    const err = await h.api.expectError(422, 'UNSUPPORTED_CAPABILITY', 'PUT', '/v1/exposures/tailnet-all', { enabled: true });
    expect(err.error.message).toMatch(/HTTPS certificates are off/);
    expect(err.error.nextAction).toMatch(/Enable HTTPS/);
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: true, online: false };
    expect((await h.api.expectError(422, 'UNSUPPORTED_CAPABILITY', 'PUT', '/v1/exposures/tailnet-all', { enabled: true })).error.message).toMatch(/offline/);
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: false, online: true };
    expect((await policy()).enabled).toBe(false);
  });

  it('on while Tailscale is not ready (it went away after): status waiting, nothing planned', async () => {
    h.daemon.ctx.repo.setSetting(TAILNET_ALL_SETTING, { enabled: true, except: [] });
    await sleep(1_500); // three observer ticks
    const p = await policy();
    expect(p).toMatchObject({ enabled: true, status: 'waiting', reason: expect.stringMatching(/HTTPS certificates are off/) });
    expect(policyOps()).toEqual([]);
    expect(await tailnetOf()).toEqual([]);
  });

  it('excluded, stopped and needs_action apps are left alone; the eligible app gets exactly one address via the policy', async () => {
    await h.api.expect(200, 'PUT', `/v1/instances/${ids['gamma']}/tailnet-all`, { included: false });
    expect((await h.api.run({ kind: 'stop', instanceId: ids['beta'] })).op.state).toBe('succeeded');
    h.daemon.ctx.repo.updateInstance(ids['delta']!, { installState: 'needs_action' });
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: true };
    await until('alpha on the tailnet', async () => (await tailnetOf()).find((e) => e.instanceId === ids['alpha'] && e.state === 'active'));
    await sleep(1_500);
    const tn = await tailnetOf();
    expect(tn.map((e) => e.instanceName)).toEqual(['alpha']);
    expect(tn[0]).toMatchObject({ isPrimary: false, url: expect.stringMatching(/^https:\/\/harbor-test\.tail1234\.ts\.net:\d+\/$/) });
    const ops = policyOps();
    expect(ops.map((o) => [o.instanceId, o.kind, o.state])).toEqual([[ids['alpha'], 'expose', 'succeeded']]);
    const p = await policy();
    expect(p.status).toBe('on');
    expect(appState(p, 'alpha')).toMatchObject({ state: 'published', url: tn[0]!.url });
    expect(appState(p, 'beta')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/stopped/) });
    expect(appState(p, 'gamma')?.state).toBe('excluded');
    expect(appState(p, 'delta')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/needs action/) });
    expect(p.except).toEqual([ids['gamma']]);
    // the main address did not move
    expect((await h.api.instances()).find((i) => i.id === ids['alpha'])!.endpoints[0]!.primary).toBe('loopback');
  });

  it('waits its turn: nothing is planned while another app or the app itself is busy; then it gets its address', async () => {
    const fakeOp = '0b0b0b0b-0000-4000-8000-000000000174';
    h.daemon.ctx.repo.updateInstance(ids['alpha']!, { activeOperationId: fakeOp }); // another app is busy
    expect((await h.api.run({ kind: 'start', instanceId: ids['beta'] })).op.state).toBe('succeeded');
    await healthy('beta');
    await sleep(1_500);
    expect(policyOps(ids['beta'])).toEqual([]);
    h.daemon.ctx.repo.updateInstance(ids['alpha']!, { activeOperationId: null });
    h.daemon.ctx.repo.updateInstance(ids['beta']!, { activeOperationId: fakeOp }); // now the candidate itself
    await sleep(1_500);
    expect(policyOps(ids['beta'])).toEqual([]);
    expect(appState(await policy(), 'beta')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/another operation/) });
    h.daemon.ctx.repo.updateInstance(ids['beta']!, { activeOperationId: null });
    await onTailnet('beta');
    expect(policyOps(ids['beta'])).toHaveLength(1);
  });

  it('a new install says it gets an address after it starts; one with a first-run page warns that the tailnet reaches it', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'demo', name: 'probe' });
    expect(plan.notes.join(' ')).toMatch(/also gets an address on your tailnet once it runs/);
    expect(plan.warnings.join(' ')).not.toMatch(/first-run page/);
    const setup = await h.api.plan({ kind: 'install', packageId: 'demo-setup', name: 'probe-setup' });
    expect(setup.warnings.join(' ')).toMatch(/first-run page \(the first visitor creates the account\) is reachable from every device on your tailnet/);
  });

  it('withdrawing an address by hand keeps that app off: it joins the exceptions and is not published again', async () => {
    const plan = await h.api.plan({ kind: 'unexpose', instanceId: ids['alpha'], via: 'tailnet' });
    expect(plan.notes.join(' ')).toMatch(/keeps it off the tailnet/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    expect((await policy()).except.sort()).toEqual([ids['alpha'], ids['gamma']].sort());
    await sleep(1_500);
    expect((await tailnetOf()).map((e) => e.instanceName)).toEqual(['beta']);
    expect(appState(await policy(), 'alpha')?.state).toBe('excluded');
    expect(policyOps(ids['alpha'])).toHaveLength(1); // the original publish only
  });

  it('switching an app back on lets the policy publish it at its next check', async () => {
    const p = await h.api.expect<TailnetAllDto>(200, 'PUT', `/v1/instances/${ids['gamma']}/tailnet-all`, { included: true });
    expect(p.except).toEqual([ids['alpha']]);
    await onTailnet('gamma');
  });

  it('turning it off withdraws nothing', async () => {
    const before = (await tailnetOf()).map((e) => e.instanceName).sort();
    expect(before).toEqual(['beta', 'gamma']);
    const p = await setPolicy(false);
    expect(p).toMatchObject({ enabled: false, status: 'off' });
    await sleep(1_200);
    expect((await tailnetOf()).map((e) => e.instanceName).sort()).toEqual(before);
    expect(h.daemon.ctx.repo.listOperations(500).filter((o) => o.kind === 'unexpose' && o.actor === TAILNET_POLICY_ACTOR)).toEqual([]);
  });

  it('a withdrawal while the policy is off is remembered too: turning it on again leaves that app off', async () => {
    const plan = await h.api.plan({ kind: 'unexpose', instanceId: ids['gamma'], via: 'tailnet' });
    expect(plan.notes.join(' ')).toMatch(/if you turn on Every app on Tailscale later/);
    expect((await h.api.waitOperation((await h.api.submit(plan.id)).operationId)).state).toBe('succeeded');
    expect((await policy()).except.sort()).toEqual([ids['alpha'], ids['gamma']].sort());
  });

  it('a withdrawal cancelled while it waited (decision 183) leaves the app in the policy: nothing was changed', async () => {
    // keep the queue busy with another app's restart, held in its readiness check
    h.fake.behaviour.respond = () => 503;
    const held = await h.api.submit((await h.api.plan({ kind: 'restart', instanceId: ids['alpha'] })).id); // alpha: kept off the tailnet already
    await until('the restart checking', async () => h.daemon.ctx.repo.operation(held.operationId)?.phase === 'checking');
    const plan = await h.api.plan({ kind: 'unexpose', instanceId: ids['beta'], via: 'tailnet' });
    const waiting = await h.api.submit(plan.id);
    expect(waiting.operation.state).toBe('queued');
    const c = await h.api.json<{ state: string }>('POST', `/v1/operations/${waiting.operationId}/cancel`, {});
    expect([c.status, c.body.state]).toEqual([200, 'cancelled']);
    expect((await policy()).except).not.toContain(ids['beta']);
    expect((await tailnetOf()).map((e) => e.instanceId)).toContain(ids['beta']);
    delete h.fake.behaviour.respond;
    expect((await h.api.waitOperation(held.operationId)).state).toBe('succeeded');
    expect((await policy()).except).not.toContain(ids['beta']);
  });

  it('plans open for review: the policy keeps away from their app and from their tailnet port, so approving them still works', async () => {
    for (const name of ['kappa', 'lambda', 'mu']) await install(name); // the policy is off
    const reviewLambda = await h.api.plan({ kind: 'expose', instanceId: ids['lambda'], via: 'tailnet' }); // a manual Publish… under review
    const reviewKappa = await h.api.plan({ kind: 'restart', instanceId: ids['kappa'] }); // any plan under review
    await setPolicy(true);
    await onTailnet('mu');
    await sleep(1_500);
    expect(policyOps(ids['kappa'])).toEqual([]);
    expect(policyOps(ids['lambda'])).toEqual([]);
    expect(policyOps(ids['gamma'])).toHaveLength(1); // withdrawn while off: still kept off
    const p = await policy();
    expect(appState(p, 'kappa')).toMatchObject({ state: 'waiting', note: expect.stringMatching(/open for review/) });
    expect(appState(p, 'gamma')?.state).toBe('excluded');
    const mu = (await tailnetOf()).find((e) => e.instanceId === ids['mu'])!;
    expect(mu.url).not.toBe(reviewLambda.exposure!.url); // the reviewed plan's port was held
    // both approvals go through: no NAME_CONFLICT on the port, no STATE_CHANGED on kappa
    const lambdaOp = await h.api.waitOperation((await h.api.submit(reviewLambda.id)).operationId);
    expect(lambdaOp.state, JSON.stringify(lambdaOp.error)).toBe('succeeded');
    const kappaOp = await h.api.waitOperation((await h.api.submit(reviewKappa.id)).operationId);
    expect(kappaOp.state, JSON.stringify(kappaOp.error)).toBe('succeeded');
    await healthy('kappa');
    await onTailnet('kappa'); // once its plan is used, the policy carries on
    expect(policyOps(ids['kappa'])).toHaveLength(1);
    expect(policyOps(ids['lambda'])).toEqual([]); // the operator published it
  });

  it('a new install gets exactly one address after it starts, without anyone asking', async () => {
    await install('nu');
    await onTailnet('nu');
    await sleep(1_000);
    expect(policyOps(ids['nu']).map((o) => [o.kind, o.state])).toEqual([['expose', 'succeeded']]);
  });

  it('a passing refusal at submit (the app got busy meanwhile) is not a failure: it is tried again', async () => {
    const svc = h.daemon.service;
    const orig = svc.submit.bind(svc);
    let refused = 0;
    svc.submit = ((planId: string, key: string, actor: string, ...rest: unknown[]) => {
      if (actor === TAILNET_POLICY_ACTOR && refused === 0) {
        refused++;
        throw new HarborError('BUSY', 'instance xi has an active operation');
      }
      return (orig as (...a: unknown[]) => ReturnType<typeof orig>)(planId, key, actor, ...rest);
    }) as typeof svc.submit;
    try {
      await install('xi');
      await onTailnet('xi');
    } finally {
      svc.submit = orig;
    }
    expect(refused).toBe(1);
    expect(policyOps(ids['xi'])).toHaveLength(1);
    expect(await failureRows(ids['xi']!)).toEqual([]);
  });

  it('an app kept off while its plan was being made is not published (the setting is read again before submit)', async () => {
    const svc = h.daemon.service;
    const orig = svc.createPlan.bind(svc);
    let made = 0;
    svc.createPlan = (async (req: PlanRequest, actor: string, ...rest: unknown[]) => {
      const plan = await (orig as (...a: unknown[]) => Promise<PlanDto>)(req, actor, ...rest);
      if (actor === TAILNET_POLICY_ACTOR) {
        made++;
        await h.api.expect(200, 'PUT', `/v1/instances/${ids['omicron']}/tailnet-all`, { included: false }); // the drawer, meanwhile
      }
      return plan;
    }) as typeof svc.createPlan;
    try {
      await install('omicron');
      await until('the policy planned omicron', async () => made > 0);
      await sleep(1_500);
    } finally {
      svc.createPlan = orig;
    }
    expect(policyOps(ids['omicron'])).toEqual([]);
    expect((await tailnetOf()).some((e) => e.instanceId === ids['omicron'])).toBe(false);
    expect(appState(await policy(), 'omicron')?.state).toBe('excluded');
  });

  it('an operation that failed after the address was recorded counts as published: no failure row stays', async () => {
    const runner = h.daemon.runner as unknown as { hookAfterAddressChange: (op: { actor: string }, inst: unknown) => Promise<void> };
    const orig = runner.hookAfterAddressChange;
    runner.hookAfterAddressChange = async (op) => {
      if (op.actor === TAILNET_POLICY_ACTOR) throw new HarborError('OPERATION_FAILED', 'the afterStart hook failed');
    };
    try {
      await install('pi');
      await onTailnet('pi');
      await until('its policy operation failed', async () => policyOps(ids['pi'])[0]?.state === 'failed');
      await sleep(1_500);
    } finally {
      runner.hookAfterAddressChange = orig;
    }
    expect(appState(await policy(), 'pi')?.state).toBe('published');
    expect(await failureRows(ids['pi']!)).toEqual([]);
  });

  it('a failing publish is tried once per start, reported once per app (no generic operation-failed row), leaves no serve entry, and is tried again after a restart', async () => {
    h.tailscale.serveFails = 'after-apply'; // the CLI wrote its entry, then reported a failure (a late timeout)
    h.daemon.ctx.repo.updateInstance(ids['delta']!, { installState: 'installed' });
    const failed = await until('delta failed', async () => appState(await policy(), 'delta')?.state === 'failed' && (await policy()));
    expect(appState(failed, 'delta')!.note).toMatch(/tailscale serve failed/);
    await sleep(1_500);
    expect(policyOps(ids['delta'])).toHaveLength(1);
    expect((await tailnetOf()).some((e) => e.instanceId === ids['delta'])).toBe(false); // no half-made record
    const deltaPort = (await h.api.instances()).find((i) => i.id === ids['delta'])!.endpoints[0]!.hostPort;
    expect(h.tailscale.entries.some((e) => e.target === tailnetServeTarget(deltaPort))).toBe(false); // and no orphan serve entry
    expect(await failureRows(ids['delta']!)).toHaveLength(1);
    const notes = (await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items;
    expect(notes.some((n) => n.kind === 'operation-failed' && n.instanceId === ids['delta'])).toBe(false);
    expect(notes.find((n) => n.kind === 'tailnet-all-failed')!.link).toBe('#/settings/remote');
    h.tailscale.serveFails = null;
    await h.restart();
    await onTailnet('delta');
    expect(policyOps(ids['delta'])).toHaveLength(2);
    await until('failure row resolved', async () => (await failureRows(ids['delta']!)).length === 0);
  });

  it('a restart in the middle of an address change leaves the app as it was (the operation alone needs attention)', async () => {
    const { repo } = h.daemon.ctx;
    const plan = await h.api.plan({ kind: 'unexpose', instanceId: ids['nu'], via: 'tailnet' });
    const opId = '0c0c0c0c-0000-4000-8000-000000000174';
    repo.insertOperation({ id: opId, idempotencyKey: `k-${opId}`, planId: plan.id, actor: TAILNET_POLICY_ACTOR, kind: 'unexpose', instanceId: ids['nu']! });
    repo.consumePlan(plan.id, opId);
    repo.setOperationPhase(opId, 'verifying', 'checking');
    repo.updateInstance(ids['nu']!, { activeOperationId: opId });
    await h.restart();
    expect(h.daemon.ctx.repo.operation(opId)!.state).toBe('needs_action');
    expect(h.daemon.ctx.repo.instance(ids['nu']!)!.installState).toBe('installed');
  });

  it('a purged app leaves the exceptions', async () => {
    expect((await policy()).except).toContain(ids['alpha']);
    expect((await h.api.run({ kind: 'purge', instanceId: ids['alpha'] })).op.state).toBe('succeeded');
    expect((await policy()).except).not.toContain(ids['alpha']);
  });
});

describe('Also on Tailscale at install (decision 186)', () => {
  const installWith = async (name: string, tailnet?: boolean, packageId = 'demo') => {
    const r = await h.api.run({ kind: 'install', packageId, name, ...(tailnet === undefined ? {} : { tailnet }) });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    ids[name] = r.op.instanceId;
    return r.plan;
  };

  it('with the policy off, the app whose install asked gets exactly one address; one that did not ask gets none', async () => {
    await setPolicy(false);
    const asked = await h.api.plan({ kind: 'install', packageId: 'demo', name: 'sigma-probe', tailnet: true });
    expect(asked.notes.join(' ')).toMatch(/It also gets an address on your tailnet once it runs\./);
    const setup = await h.api.plan({ kind: 'install', packageId: 'demo-setup', name: 'sigma-setup', tailnet: true });
    expect(setup.warnings.join(' ')).toMatch(/Also on Tailscale: Demo Setup's first-run page \(the first visitor creates the account\) is reachable from every device on your tailnet/);
    expect((await h.api.plan({ kind: 'install', packageId: 'demo', name: 'sigma-probe' })).notes.join(' ')).not.toMatch(/tailnet/);
    await installWith('sigma', true);
    await installWith('tau');
    await onTailnet('sigma');
    await sleep(1_500);
    expect(policyOps(ids['sigma']).map((o) => [o.kind, o.state])).toEqual([['expose', 'succeeded']]);
    expect(policyOps(ids['tau'])).toEqual([]);
    expect((await tailnetOf()).some((e) => e.instanceId === ids['tau'])).toBe(false);
    const p = await policy();
    expect(p.enabled).toBe(false);
    expect(p.asked).toEqual([]); // dropped once it has its address
    expect(appState(p, 'sigma')?.state).toBe('published');
    // not the main address
    expect((await h.api.instances()).find((i) => i.id === ids['sigma'])!.endpoints[0]!.primary).toBe('loopback');
  });

  it('a tailnet main address already is one: the install records no extra choice', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'demo', name: 'phi-probe', main: { via: 'tailnet' }, tailnet: true });
    expect(plan.exposure).toMatchObject({ via: 'tailnet', makePrimary: true });
    expect(plan.notes.join(' ')).not.toMatch(/also gets an address/);
  });

  it('with the policy on, an install that says no stays off: it joins the exceptions', async () => {
    await setPolicy(true);
    await onTailnet('tau'); // the policy covers the app that did not ask
    const plan = await h.api.plan({ kind: 'install', packageId: 'demo', name: 'upsilon-probe', tailnet: false });
    expect(plan.notes.join(' ')).toMatch(/stays off your tailnet/);
    expect(plan.warnings.join(' ')).not.toMatch(/tailnet/);
    await installWith('upsilon', false);
    await sleep(1_500);
    expect(policyOps(ids['upsilon'])).toEqual([]);
    const p = await policy();
    expect(p.except).toContain(ids['upsilon']);
    expect(appState(p, 'upsilon')?.state).toBe('excluded');
  });

  it('the request schema takes only a boolean', async () => {
    expect((await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'demo', name: 'chi', tailnet: 'yes' })).error.message).toMatch(/tailnet: must be boolean/);
  });
});

describe('Tailscale by default (decisions 196-197)', () => {
  it('an app address reaches the app through its relay, and an address from before 0.42.0 is moved onto it', async () => {
    const name = 'relayed';
    await install(name);
    const row = (await h.api.instances()).find((i) => i.id === ids[name])!;
    await setPolicy(false);
    expect((await h.api.run({ kind: 'expose', instanceId: row.id, via: 'tailnet' })).op.state).toBe('succeeded');
    const e = (await tailnetOf()).find((x) => x.instanceId === row.id)!;
    const want = tailnetServeTarget(row.endpoints[0]!.hostPort);
    expect(h.tailscale.entries).toContainEqual({ port: e.port, target: want });
    // what 0.41 left: tailscale points straight at the app
    await h.tailscale.serve(e.port, `http://127.0.0.1:${row.endpoints[0]!.hostPort}`);
    await until('moved onto the relay', async () => h.tailscale.entries.some((x) => x.port === e.port && x.target === want));
    await h.api.run({ kind: 'unexpose', instanceId: row.id, via: 'tailnet' });
  });

  it('an existing Harbor is asked once; Not now is remembered', async () => {
    await setPolicy(false);
    const repo = h.daemon.ctx.repo;
    repo.setSetting(TAILNET_ALL_SETTING, { ...(repo.setting(TAILNET_ALL_SETTING) as object), except: [] });
    expect((await policy()).offer).toBe(true);
    const after = await h.api.expect<TailnetAllDto>(200, 'PUT', '/v1/exposures/tailnet-all', { dismissOffer: true });
    expect(after.offer).toBe(false);
    expect(after.enabled).toBe(false);
    expect((await policy()).offer).toBe(false);
  });

  it('a machine without Tailscale says nothing about it, even with the policy on', async () => {
    const repo = h.daemon.ctx.repo;
    repo.setSetting(TAILNET_ALL_SETTING, { ...(repo.setting(TAILNET_ALL_SETTING) as object), enabled: true });
    const before = h.tailscale.statusValue;
    h.tailscale.statusValue = null;
    expect((await h.api.plan({ kind: 'install', packageId: 'demo', name: 'quiet-probe' })).notes.join(' ')).not.toMatch(/tailnet/);
    h.tailscale.statusValue = before;
    repo.setSetting(TAILNET_ALL_SETTING, { ...(repo.setting(TAILNET_ALL_SETTING) as object), enabled: false });
  });
});
