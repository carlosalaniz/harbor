// Decision 194: Harbor's app login. A gate (gate/gate.mjs) in front of an endpoint: the operator turns it on for any web
// endpoint with a password; a package may require it (on, locked) or rule it out (never). Passwords come back only
// through /login/reveal with the Harbor password.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceDetail, OperationDto, PlanDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
// @ts-expect-error -- plain ESM module without types (it runs inside the gate container as is)
import { verifyPassword } from '../../gate/gate.mjs';
import { ADMIN, startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (id: string, login: string | null, extra = '') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Gate ${id}
  description: A login test app
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
${login ? `    login: ${login}\n` : ''}${extra}health:
  endpoint: web
  path: /healthz
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
const upload = (id: string, login: string | null, extra = '') => h.api.json('POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, login, extra), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const detail = (id: string) => h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`);
const runtime = (id: string) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8'));
const submit = (planId: string, secrets?: Record<string, string>) => h.api.json<{ operationId: string; error?: { code: string; message: string } }>('POST', '/v1/operations', { planId, ...(secrets ? { secrets } : {}) }, { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` });
async function configure(id: string, login: Record<string, unknown>, secrets?: Record<string, string>): Promise<OperationDto> {
  const plan = await h.api.expect<PlanDto>(201, 'POST', '/v1/plans', { kind: 'configure', instanceId: id, login });
  const r = await submit(plan.id, secrets);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const op = await h.api.waitOperation(r.body.operationId);
  expect(op.state, JSON.stringify([op.error, op.events.slice(-4)])).toBe('succeeded');
  return op;
}
const reveal = (id: string, password = ADMIN.password) => h.api.json<{ password: string | null }>('POST', `/v1/instances/${id}/login/reveal`, { password });

describe("Harbor's app login (decision 194)", () => {
  let id: string;
  it('any web endpoint can have one; it is off until turned on, and turning it on needs a password', async () => {
    expect((await upload('plain', null)).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'plain' });
    expect(op.state).toBe('succeeded');
    id = op.instanceId!;
    expect((await detail(id)).login).toEqual({ on: false, locked: null, hasPassword: false, endpoints: ['web'], open: [], ownLogin: false });
    expect(runtime(id).services.web.ports).toHaveLength(1);
    const e = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: id, login: { on: true } });
    expect(e.error.message).toMatch(/needs a password/);
  });

  it('turned on: the review says so, the password rides the approval, and a gate publishes the port instead', async () => {
    const plan = await h.api.expect<PlanDto>(201, 'POST', '/v1/plans', { kind: 'configure', instanceId: id, login: { on: true, password: true } });
    expect(plan.changes.join('\n')).toMatch(/Ask for plain's password first/);
    expect(JSON.stringify(plan)).not.toContain('gate-FIXTURE');
    expect((await submit(plan.id)).body.error?.message).toMatch(/is needed/);
    expect((await submit(plan.id, { 'harbor.login': 'short' })).body.error?.message).toMatch(/at least 8/);
    const ok = await submit(plan.id, { 'harbor.login': 'gate-FIXTURE-one' });
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify([op.error, op.events.slice(-3)])).toBe('succeeded');
    const rt = runtime(id);
    const gate = rt.services.harbor_gate_web;
    expect(rt.services.web.ports).toBeUndefined();
    expect(gate.ports).toEqual([{ target: 8080, published: String((await detail(id)).endpoints[0]!.hostPort), host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host' }]);
    expect(gate.image).toMatch(/^node@sha256:[0-9a-f]{64}$/);
    expect(gate.environment.GATE_UPSTREAM).toBe('http://web:80');
    expect(gate.environment.GATE_HEALTH_PATH).toBe('/healthz');
    expect(verifyPassword('gate-FIXTURE-one', gate.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect(JSON.stringify(rt)).not.toContain('gate-FIXTURE-one');
    expect(gate.volumes[0]).toMatchObject({ type: 'bind', target: '/harbor-gate', read_only: true });
    expect(readFileSync(path.join(gate.volumes[0].source, 'gate.mjs'), 'utf8')).toContain('createGate');
    expect((await detail(id)).login).toEqual({ on: true, locked: null, hasPassword: true, endpoints: ['web'], open: [], ownLogin: false });
  });

  it('a re-render keeps the same gate (same hash), so a restart does not sign anyone out', async () => {
    const before = runtime(id).services.harbor_gate_web.environment;
    expect((await h.api.run({ kind: 'restart', instanceId: id })).op.state).toBe('succeeded');
    expect(runtime(id).services.harbor_gate_web.environment).toEqual(before);
  });

  it('Show asks for the Harbor password', async () => {
    expect((await reveal(id, 'wrong-password')).status).toBe(422);
    const r = await reveal(id);
    expect(r.status).toBe(200);
    expect(r.body.password).toBe('gate-FIXTURE-one');
  });

  it('a new password comes with a new cookie key (every browser signs in again)', async () => {
    const before = runtime(id).services.harbor_gate_web.environment;
    expect((await configure(id, { password: true }, { 'harbor.login': 'gate-FIXTURE-two' })).state).toBe('succeeded');
    const after = runtime(id).services.harbor_gate_web.environment;
    expect(after.GATE_COOKIE_KEY).not.toBe(before.GATE_COOKIE_KEY);
    expect(verifyPassword('gate-FIXTURE-two', after.GATE_PASSWORD_HASH)).toBe(true);
    expect(verifyPassword('gate-FIXTURE-one', after.GATE_PASSWORD_HASH)).toBe(false);
  });

  it('turned off: the app publishes its port again and the password is kept for next time', async () => {
    expect((await configure(id, { on: false })).state).toBe('succeeded');
    const rt = runtime(id);
    expect(rt.services.harbor_gate_web).toBeUndefined();
    expect(rt.services.web.ports).toHaveLength(1);
    expect((await detail(id)).login).toEqual({ on: false, locked: null, hasPassword: true, endpoints: ['web'], open: [], ownLogin: false });
    // back on without typing it again
    expect((await configure(id, { on: true })).state).toBe('succeeded');
    expect(verifyPassword('gate-FIXTURE-two', runtime(id).services.harbor_gate_web.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect((await h.api.run({ kind: 'purge', instanceId: id })).op.state).toBe('succeeded');
  });

  it('a package may require it: on from the install, password generated and shown once, cannot be turned off', async () => {
    expect((await upload('locked', 'required')).status).toBe(201);
    const plan = await h.api.plan({ kind: 'install', packageId: 'locked' });
    expect(plan.changes.join('\n')).toMatch(/Ask for Gate locked's password first/);
    const r = await submit(plan.id);
    const op = await h.api.waitOperation(r.body.operationId);
    expect(op.state).toBe('succeeded');
    const shown = (op.result?.['shownOnce'] as { id: string; label: string; value: string }[] | undefined) ?? [];
    expect(shown.map((x) => [x.id, x.label])).toEqual([['harbor.login', 'Gate locked password']]);
    const lid = op.instanceId!;
    expect(verifyPassword(shown[0]!.value, runtime(lid).services.harbor_gate_web.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect((await detail(lid)).login).toEqual({ on: true, locked: 'required', hasPassword: true, endpoints: ['web'], open: [], ownLogin: false });
    expect((await reveal(lid)).body.password).toBe(shown[0]!.value);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: lid, login: { on: false } });
    expect((await h.api.run({ kind: 'purge', instanceId: lid })).op.state).toBe('succeeded');
  });

  const ADMIN_PAGE = `  admin:
    service: web
    containerPort: 81
    scheme: http
    exposure: direct
    browserContext: ordinary
`;

  it('decision 195: one password for the whole app: every page shares it, its key and its cookie', async () => {
    expect((await upload('twopages', 'required', ADMIN_PAGE)).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'twopages' });
    expect(op.state).toBe('succeeded');
    const shown = (op.result?.['shownOnce'] as { id: string; label: string; value: string }[] | undefined) ?? [];
    expect(shown.map((x) => x.label)).toEqual(['Gate twopages password']);
    const rt = runtime(op.instanceId!);
    expect(Object.keys(rt.services).filter((x) => x.startsWith('harbor_gate_')).sort()).toEqual(['harbor_gate_admin', 'harbor_gate_web']);
    const [a, b] = [rt.services.harbor_gate_admin.environment, rt.services.harbor_gate_web.environment];
    expect(a.GATE_PASSWORD_HASH).toBe(b.GATE_PASSWORD_HASH);
    expect(a.GATE_COOKIE_KEY).toBe(b.GATE_COOKIE_KEY);
    expect(a.GATE_COOKIE).toBe(b.GATE_COOKIE);
    expect((await detail(op.instanceId!)).login).toEqual({ on: true, locked: 'required', hasPassword: true, endpoints: ['admin', 'web'], open: [], ownLogin: false });
    expect((await h.api.run({ kind: 'purge', instanceId: op.instanceId })).op.state).toBe('succeeded');
  });

  it('decision 195: a 0.41 app with one password per page adopts the main page password at its next render', async () => {
    expect((await upload('legacy', 'required', ADMIN_PAGE)).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'legacy' });
    const lid = op.instanceId!;
    const secrets = path.join(h.stateDir, 'instances', lid, 'secrets');
    // what 0.41.x left on disk
    const wr = (n: string, v: string) => writeFileSync(path.join(secrets, n), v, { mode: 0o600 });
    for (const n of ['harbor.login', 'harbor.login.key']) rmSync(path.join(secrets, n));
    wr('harbor.login.web', 'gate-FIXTURE-main-page');
    wr('harbor.login.web.key', 'aa'.repeat(32));
    wr('harbor.login.admin', 'gate-FIXTURE-admin-page');
    wr('harbor.login.admin.key', 'bb'.repeat(32));
    // before the render: Show already answers with the main page's
    expect((await reveal(lid)).body.password).toBe('gate-FIXTURE-main-page');
    expect((await h.api.run({ kind: 'restart', instanceId: lid })).op.state).toBe('succeeded');
    const rt = runtime(lid);
    expect(verifyPassword('gate-FIXTURE-main-page', rt.services.harbor_gate_admin.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect(rt.services.harbor_gate_web.environment.GATE_COOKIE_KEY).toBe('aa'.repeat(32));
    expect(readdirSync(secrets).filter((n) => n.startsWith('harbor.login')).sort()).toEqual(['harbor.login', 'harbor.login.key']);
    expect((await reveal(lid)).body.password).toBe('gate-FIXTURE-main-page');
    expect((await h.api.run({ kind: 'purge', instanceId: lid })).op.state).toBe('succeeded');
  });

  it('decision 195: an endpoint marked never stays open while the rest of the app asks', async () => {
    expect((await upload('syncs', null, `${ADMIN_PAGE}    login: never\n`)).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'syncs', login: true });
    expect(op.state).toBe('succeeded');
    const d = await detail(op.instanceId!);
    expect(d.login).toMatchObject({ on: true, endpoints: ['web'], open: ['admin'] });
    expect(runtime(op.instanceId!).services.harbor_gate_admin).toBeUndefined();
    expect((await h.api.run({ kind: 'purge', instanceId: op.instanceId })).op.state).toBe('succeeded');
  });

  it('decision 195: asked for at install, Harbor makes the password and shows it once', async () => {
    expect((await upload('asked', null)).status).toBe(201);
    const plan = await h.api.plan({ kind: 'install', packageId: 'asked', login: true });
    expect(plan.changes.join('\n')).toMatch(/Harbor makes one and shows it once/);
    const r = await submit(plan.id);
    const op = await h.api.waitOperation(r.body.operationId);
    expect(op.state, JSON.stringify([op.error, op.events.slice(-3)])).toBe('succeeded');
    const shown = (op.result?.['shownOnce'] as { value: string }[] | undefined) ?? [];
    expect(shown).toHaveLength(1);
    expect(verifyPassword(shown[0]!.value, runtime(op.instanceId!).services.harbor_gate_web.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect((await h.api.run({ kind: 'purge', instanceId: op.instanceId })).op.state).toBe('succeeded');
  });

  it('decision 195: Add a domain can put the password up first, instead of basic auth', async () => {
    expect((await upload('domained', null)).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'domained' });
    const did = op.instanceId!;
    const plan = await h.api.plan({ kind: 'expose', instanceId: did, via: 'public', hostname: 'gated.example.com', login: true });
    expect(plan.changes.join('\n')).toMatch(/Harbor makes one and shows it once/);
    expect(plan.exposure?.protection).toBe('none');
    const r = await submit(plan.id);
    const done = await h.api.waitOperation(r.body.operationId);
    expect(done.state, JSON.stringify([done.error, done.events.slice(-3)])).toBe('succeeded');
    const shown = (done.result?.['shownOnce'] as { value: string }[] | undefined) ?? [];
    expect(shown).toHaveLength(1);
    expect(done.result?.['credentials']).toBeUndefined();
    expect(verifyPassword(shown[0]!.value, runtime(did).services.harbor_gate_web.environment.GATE_PASSWORD_HASH)).toBe(true);
    expect((await detail(did)).login?.on).toBe(true);
    expect((await h.api.run({ kind: 'purge', instanceId: did })).op.state).toBe('succeeded');
  });

  it('a package may rule it out, and an API endpoint can never have it', async () => {
    expect((await upload('never', 'never')).status).toBe(201);
    const { op } = await h.api.run({ kind: 'install', packageId: 'never' });
    const e = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: op.instanceId, login: { on: true, password: true } });
    expect(e.error.message).toMatch(/cannot go in front of it/);
    expect((await h.api.run({ kind: 'purge', instanceId: op.instanceId })).op.state).toBe('succeeded');
    const bad = await upload('apigate', null, '    kind: api\n    login: required\n');
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toMatch(/cannot be used on an api endpoint/);
  });
});
