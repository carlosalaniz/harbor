// Decision 183: the operation queue's pure parts — run order, claiming the head, cancelling, the app's active
// operation, the queueable kinds, the new error codes and how the CLI words the queue.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUEUEABLE_KINDS, type OperationDto } from '../../src/contracts/api.js';
import { HarborError, needsReview, personCanResolve } from '../../src/errors.js';
import { initializeState, openState } from '../../src/state/db.js';
import { Repo } from '../../src/state/repo.js';
import { isCancellable, operationInstanceName } from '../../src/lifecycle/dto.js';
import { busyQuestion, canQueueAction, queueStatus, queueStatusLine, queueText } from '../../src/cli/queue-view.js';
import { systemIds } from '../../src/util.js';
import { INTERNAL_ACTORS, reservedUsername } from '../../src/actors.js';
import { TAILNET_POLICY_ACTOR } from '../../src/lifecycle/tailnet-all.js';
import { validateUsername } from '../../src/auth/password.js';
import { sameQueuedAction } from '../../src/lifecycle/service.js';
import { enrollAdministrator } from '../../src/maintenance.js';
import { normalizeConfig } from '../../src/config.js';

const FIXED = new Date('2026-10-15T09:00:00Z');
function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'harbor-queue-'));
  initializeState(dir, { clock: { now: () => FIXED }, ids: systemIds, config: {} });
  return new Repo(openState(dir), { now: () => FIXED }); // every row in the same second
}
function app(r: Repo, id: string, name: string): void {
  r.insertInstance({ id, name, project: `hb_${name}`, packageId: 'demo', revision: '1', generation: 0, desired: 'running', installState: 'installed', runtime: 'running', readiness: 'healthy', everInstalled: true, releaseDir: 'x', releaseHashes: {}, endpoints: [], secrets: [], activeOperationId: null });
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('run order and claiming (decision 183)', () => {
  it('runs in insertion order within one second (ids are random), claims atomically, cancels only what never started', () => {
    const r = repo();
    app(r, A, 'alpha');
    app(r, B, 'beta');
    const ids = ['ffffffff-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '88888888-0000-4000-8000-000000000003'];
    r.insertQueuedAction({ id: ids[0]!, idempotencyKey: 'k1', actor: 'admin', kind: 'update', instanceId: A });
    r.insertQueuedAction({ id: ids[1]!, idempotencyKey: 'k2', actor: 'admin', kind: 'stop', instanceId: A });
    r.insertQueuedAction({ id: ids[2]!, idempotencyKey: 'k3', actor: 'auto-update', kind: 'update', instanceId: B });
    expect(r.activeOperations().map((o) => o.id)).toEqual(ids);
    expect(r.operation(ids[0]!)).toMatchObject({ planId: null, request: { kind: 'update', instanceId: A }, startedAt: null });
    // the app's active operation is its first not-final one in run order
    expect(r.syncActiveOperation(A)).toBe(ids[0]);
    expect(r.instance(A)!.activeOperationId).toBe(ids[0]);
    // the head is claimed (started_at), so it is no longer cancellable and not handed out again
    const head = r.claimHead()!;
    expect(head.id).toBe(ids[0]);
    expect(head.startedAt).not.toBeNull();
    expect(r.cancelOperation(ids[0]!, { message: 'm', nextAction: '' })).toBe(false);
    // a waiting one is cancelled once; the runner then skips it
    expect(r.cancelOperation(ids[1]!, { message: 'Cancelled by you before it started; nothing was changed.', nextAction: '' })).toBe(true);
    expect(r.cancelOperation(ids[1]!, { message: 'again', nextAction: '' })).toBe(false);
    expect(r.operation(ids[1]!)).toMatchObject({ state: 'cancelled', errorCode: 'CANCELLED', errorMessage: 'Cancelled by you before it started; nothing was changed.' });
    expect(r.claimHead()!.id).toBe(ids[2]);
    expect(r.claimHead()).toBeNull();
    // finishing the running one moves the app's active operation on (none left for A)
    r.finishOperation(ids[0]!, 'succeeded');
    expect(r.syncActiveOperation(A)).toBeNull();
    expect(r.instance(A)!.activeOperationId).toBeNull();
    const q = r.listQueue(10);
    expect(q.active.map((o) => o.id)).toEqual([ids[2]]);
    expect(q.recent.map((o) => o.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(r.listQueue(1).recent).toHaveLength(1);
    // the plan made at its turn is attached once
    r.insertPlan({ id: '33333333-3333-4333-8333-333333333333', actor: 'auto-update', kind: 'update', instanceId: B, proposal: { packageId: 'demo', revision: '2', name: 'beta', project: 'hb_beta', endpoints: [], storage: [], location: null, secrets: [], changes: [], warnings: [], releaseHashes: {} }, expectedGeneration: 0, createdAt: 't', expiresAt: 't' });
    r.attachPlan(ids[2]!, '33333333-3333-4333-8333-333333333333');
    expect(r.operation(ids[2]!)!.planId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('runs in insertion order even when the clock steps back between two items (seq, not created_at)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-queue-clock-'));
    initializeState(dir, { clock: { now: () => FIXED }, ids: systemIds, config: {} });
    let now = new Date('2026-10-15T10:00:05Z');
    const r = new Repo(openState(dir), { now: () => now });
    app(r, A, 'alpha');
    const U = 'ffffffff-0000-4000-8000-0000000000aa';
    const R = '00000000-0000-4000-8000-0000000000bb';
    r.insertQueuedAction({ id: U, idempotencyKey: 'ku', actor: 'admin', kind: 'update', instanceId: A });
    now = new Date('2026-10-15T10:00:02Z'); // NTP stepped the clock back 3 s
    r.insertQueuedAction({ id: R, idempotencyKey: 'kr', actor: 'admin', kind: 'remove', instanceId: A });
    expect(r.activeOperations().map((o) => o.id)).toEqual([U, R]);
    expect(r.activeOperationsOf(A).map((o) => o.id)).toEqual([U, R]);
    expect(r.syncActiveOperation(A)).toBe(U);
    expect(r.listQueue(5).active.map((o) => o.id)).toEqual([U, R]);
    expect(r.claimHead()!.id).toBe(U);
    expect(r.claimHead()!.id).toBe(R);
  });

  it('a person may cancel only a waiting item nobody protects', () => {
    const base = { state: 'queued' as const, startedAt: null, actor: 'admin' };
    expect(isCancellable(base as never)).toBe(true);
    expect(isCancellable({ ...base, startedAt: 't' } as never)).toBe(false);
    expect(isCancellable({ ...base, state: 'applying' } as never)).toBe(false);
    for (const actor of ['drive-guard', 'link-guard', 'lock-guard', 'scheduler']) expect(isCancellable({ ...base, actor } as never)).toBe(false);
    expect(isCancellable({ ...base, actor: 'auto-update' } as never)).toBe(true);
    // a login name that happens to be an Object.prototype key is an ordinary person
    for (const actor of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) expect(isCancellable({ ...base, actor } as never)).toBe(true);
    // a freed row keeps only its archived name
    expect(operationInstanceName({ name: 'immich~cancelled~12345678', purgedAt: 't', displayName: null } as never, 'x')).toBe('immich');
    expect(operationInstanceName({ name: 'immich', purgedAt: null, displayName: 'Photos' } as never, 'x')).toBe('Photos');
    expect(operationInstanceName(null, 'fallback')).toBe('fallback');
  });
});

describe('queueable kinds and error codes (decision 183)', () => {
  it('lists exactly the actions that take no typed values', () => {
    expect([...QUEUEABLE_KINDS]).toEqual(['start', 'stop', 'restart', 'update', 'remove', 'reinstall', 'purge']);
  });

  it('NOT_CANCELLABLE, REVIEW_NEEDED and CANCELLED are conflicts (409, exit 3) with a next action', () => {
    for (const code of ['NOT_CANCELLABLE', 'REVIEW_NEEDED', 'CANCELLED'] as const) {
      const e = new HarborError(code, 'x');
      expect([e.httpStatus, e.exitCode]).toEqual([409, 3]);
      expect(e.nextAction.length).toBeGreaterThan(10);
    }
  });

  it('refusals a person can resolve become REVIEW_NEEDED for a queued item; others do not', () => {
    for (const code of ['SECRET_MISSING', 'PERMISSION_REQUIRED', 'MACHINE_KEY_LOCKED', 'SETTING_INVALID', 'REVIEW_NEEDED'] as const) expect(needsReview(new HarborError(code, 'x'))).toBe(true);
    expect(needsReview(new HarborError('INVALID_STATE', 'already running'))).toBe(false);
    expect(needsReview(personCanResolve(new HarborError('INVALID_STATE', 'immich is locked')))).toBe(true);
    expect(needsReview(new Error('x'))).toBe(false);
  });
});

describe("Harbor's own actor names are not login names (decision 183)", () => {
  it('lists every background actor, and setup / enroll refuse them as usernames (any case)', () => {
    expect([...INTERNAL_ACTORS].sort()).toEqual(['auto-update', 'drive-guard', 'git-source', 'link-guard', 'lock-guard', 'scheduler', TAILNET_POLICY_ACTOR, 'vpn-policy', 'space-policy'].sort());
    for (const name of [...INTERNAL_ACTORS, 'Scheduler', 'DRIVE-GUARD']) expect(reservedUsername(name)).toMatch(/Harbor uses for its own background work/);
    expect(reservedUsername('carlos')).toBeNull();
    expect(reservedUsername('constructor')).toBeNull();
    expect(validateUsername('scheduler')).toMatch(/Harbor uses for its own background work/);
    expect(validateUsername('carlos')).toBeNull();
  });
});

describe('harbor queue wording (decision 183)', () => {
  const op = (o: Partial<OperationDto>): OperationDto => ({ id: 'id', kind: 'update', instanceId: A, instanceName: 'immich', planId: null, actor: 'admin', queuedAction: true, cancellable: true, state: 'queued', phase: 'queued', createdAt: 't', startedAt: null, finishedAt: null, error: null, result: null, events: [], ...o });
  it('marks running, waiting and finished items', () => {
    expect(queueStatus(op({}))).toBe('waiting');
    expect(queueStatus(op({ startedAt: 't' }))).toBe('running');
    expect(queueStatus(op({ state: 'applying', startedAt: 't' }))).toBe('running');
    expect(queueStatus(op({ state: 'failed', error: { code: 'REVIEW_NEEDED', message: '', nextAction: '' } }))).toBe('finished: needs your review');
    expect(queueStatus(op({ state: 'cancelled' }))).toBe('finished: cancelled');
    const text = queueText({ active: [op({ id: 'r1', kind: 'install', state: 'applying', phase: 'pulling', startedAt: 't', cancellable: false }), op({ id: 'w1' })], recent: [op({ id: 'f1', state: 'succeeded', finishedAt: '2026-10-15T09:00:00Z', cancellable: false })] });
    const lines = text.split('\n');
    expect(lines[1]).toMatch(/^1\s+running\s+install\s+immich\s+pulling\s+admin\s+-\s+r1$/);
    expect(lines[2]).toMatch(/^2\s+waiting\s+update\s+immich\s+queued\s+admin\s+yes\s+w1$/);
    expect(text).toContain('Finished:');
    expect(text).toContain('harbor queue cancel <id>');
    expect(queueText({ active: [], recent: [] })).toBe('Nothing is running or waiting.');
  });
  it('asks once before queueing on a busy app, and sums the queue up for harbor status', () => {
    expect(busyQuestion('Immich', 'update', { kind: 'install', state: 'applying', startedAt: 't' })).toBe('Immich is busy (install running). Queue update to run after it? Harbor plans it when its turn comes.');
    expect(busyQuestion('Immich', 'stop', { kind: 'update', state: 'queued', startedAt: null })).toContain('(update waiting)');
    expect(queueStatusLine({ active: [], recent: [] })).toBe('Queue: idle');
    expect(queueStatusLine({ active: [op({ kind: 'install', state: 'applying', phase: 'pulling', startedAt: 't' }), op({}), op({})], recent: [] })).toBe('Queue: install of immich running (pulling), 2 waiting');
  });
  it('queues only an action with nothing to hand over; accepted permissions, a passphrase or values wait for the app', () => {
    expect(canQueueAction({})).toBe(true);
    expect(canQueueAction({ acceptPermissions: false, passphraseStdin: false, values: 0 })).toBe(true);
    expect(canQueueAction({ acceptPermissions: true })).toBe(false);
    expect(canQueueAction({ passphraseStdin: true })).toBe(false);
    expect(canQueueAction({ values: 2 })).toBe(false);
  });
});

describe('the queue dedupe rule (decision 183 review R1/R3/R7)', () => {
  const item = (kind: string, o: Partial<{ actor: string; state: string; startedAt: string | null }> = {}) => ({ kind, actor: 'admin', state: 'queued', startedAt: null as string | null, ...o });
  it("is the app's last waiting item of the same kind, a person's", () => {
    const stop = item('stop');
    expect(sameQueuedAction([item('install', { state: 'applying', startedAt: 't' }), stop], 'stop')).toBe(stop);
    expect(sameQueuedAction([], 'stop')).toBeNull();
  });
  it("never an item something else waits behind, never one of Harbor's own, never a started one (an update aside)", () => {
    expect(sameQueuedAction([item('stop'), item('restart')], 'stop')).toBeNull();
    for (const actor of INTERNAL_ACTORS) expect(sameQueuedAction([item('stop', { actor })], 'stop')).toBeNull();
    expect(sameQueuedAction([item('stop', { actor: 'Drive-Guard' })], 'stop')).toBeNull();
    expect(sameQueuedAction([item('stop', { startedAt: 't' })], 'stop')).toBeNull();
    expect(sameQueuedAction([item('restart', { state: 'applying', startedAt: 't' })], 'restart')).toBeNull();
  });
  it('an update: any unfinished update of the app, wherever it is and whoever queued it (a second one could only fail; review round 3)', () => {
    const running = item('update', { state: 'verifying', startedAt: 't' });
    expect(sameQueuedAction([running], 'update')).toBe(running);
    const auto = item('update', { actor: 'auto-update', state: 'applying', startedAt: 't' });
    expect(sameQueuedAction([auto], 'update')).toBe(auto);
    const waitingAuto = item('update', { actor: 'auto-update' });
    expect(sameQueuedAction([item('install', { state: 'applying', startedAt: 't' }), waitingAuto], 'update')).toBe(waitingAuto);
    const first = item('update');
    expect(sameQueuedAction([first, item('stop')], 'update')).toBe(first);
    expect(sameQueuedAction([item('stop')], 'update')).toBeNull();
  });
});

describe('enroll --reset keeps an existing name (decision 183 review R5)', () => {
  function stateWith(username: string) {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-enroll-'));
    const config = normalizeConfig({ stateDir: path.join(root, 'state'), catalogDir: path.join(root, 'catalog'), userDataDir: path.join(root, 'data'), docker: { mode: 'fake' }, catalog: { url: null } }, root);
    initializeState(config.stateDir, { clock: { now: () => FIXED }, ids: systemIds, config: {} });
    const db = openState(config.stateDir);
    new Repo(db, { now: () => FIXED }).setAdministrator({ username, passwordHash: 'x', salt: 'x', params: {} });
    db.close();
    return config;
  }
  const adminName = (stateDir: string) => {
    const db = openState(stateDir);
    try {
      return new Repo(db, { now: () => FIXED }).administrator()?.username;
    } finally {
      db.close();
    }
  };
  it('lets an administrator enrolled before the rule reset under that same name; a new reserved name is refused', async () => {
    const config = stateWith('scheduler');
    await expect(enrollAdministrator(config, 'auto-update', 'correct horse battery', { reset: true })).rejects.toThrow(/Harbor uses for its own background work/);
    await expect(enrollAdministrator(config, 'Bad Name', 'correct horse battery', { reset: true })).rejects.toThrow(/lowercase/);
    const r = await enrollAdministrator(config, 'scheduler', 'correct horse battery', { reset: true });
    expect(r.created).toBe(false);
    expect(adminName(config.stateDir)).toBe('scheduler');
    // and a reset may still move to a new, free name
    await enrollAdministrator(config, 'carlos', 'correct horse battery', { reset: true });
    expect(adminName(config.stateDir)).toBe('carlos');
  });
});
