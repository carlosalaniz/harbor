// Decision 193: the privileged and binder permissions. Only official-catalog apps get them, unless the operator
// turns on developer mode (password required); binder is loaded by the root step before the app's containers start.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { DeveloperModeDto, InstanceSummary, PlanDto, SystemDto } from '../../src/contracts/api.js';
import { sha256Hex } from '../../src/packages/inventory.js';
import { writeZip } from '../../src/packages/zip.js';
import { FakeKernelProvider } from '../../src/system/kernel.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

let h: Harness;
const kernel = new FakeKernelProvider('available');
beforeAll(async () => {
  h = await startHarness({ overrides: { kernel } });
});
afterAll(async () => h.close());

const manifest = (id: string, rev: string, perms: string[]) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Droid ${id}
  description: An Android test app
release:
  revision: "${rev}"
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
permissions:
  web: [${perms.join(', ')}]
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
const zip = (id: string, rev: string, perms: string[]) => ({ fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev, perms), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;
const runtimeOf = (id: string) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8'));
const install = async (packageId: string) => {
  const plan: PlanDto = await h.api.plan({ kind: 'install', packageId });
  const r = await h.api.json<{ operationId: string }>('POST', '/v1/operations', { planId: plan.id, acceptPermissions: true }, { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` });
  expect(r.status).toBe(202);
  const op = await h.api.waitOperation(r.body.operationId);
  expect(op.state, JSON.stringify([op.error, op.events.slice(-4)])).toBe('succeeded');
  return { plan, op, inst: await byName(plan.name) };
};

describe('developer mode and the trusted-only permissions (decision 193)', () => {
  it('is off by default, and an upload that asks for privileged is refused before anything is stored', async () => {
    expect((await h.api.expect<SystemDto>(200, 'GET', '/v1/system')).developerMode).toEqual({ enabled: false, since: null, untrustedApps: [] });
    const e = await h.api.expectError(403, 'UNTRUSTED_SOURCE', 'POST', '/v1/packages', zip('droid', '1', ['privileged']));
    expect(e.error.message).toMatch(/official app catalog/);
    expect(e.error.nextAction).toMatch(/developer mode/);
    const { items } = await h.api.expect<{ items: { id: string }[] }>(200, 'GET', '/v1/catalog');
    expect(items.some((i) => i.id === 'droid')).toBe(false);
    // the other permissions stay open to uploads
    await h.api.expect(201, 'POST', '/v1/packages', zip('plain-tun', '1', ['tun']));
  });

  it('turning it on needs the right password; turning it off needs none', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/system/developer-mode', { enabled: true });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/system/developer-mode', { enabled: true, password: 'wrong-password' });
    const on = await h.api.expect<DeveloperModeDto>(200, 'PUT', '/v1/system/developer-mode', { enabled: true, password: ADMIN.password });
    expect(on.enabled).toBe(true);
    expect(on.since).toBeTruthy();
    expect((await h.api.expect<SystemDto>(200, 'GET', '/v1/system')).developerMode.enabled).toBe(true);
    const off = await h.api.expect<DeveloperModeDto>(200, 'PUT', '/v1/system/developer-mode', { enabled: false });
    expect(off).toEqual({ enabled: false, since: null, untrustedApps: [] });
  });

  it('with it on, an uploaded privileged + binder app installs: privileged rendered, binder loaded first', async () => {
    await h.api.expect(200, 'PUT', '/v1/system/developer-mode', { enabled: true, password: ADMIN.password });
    await h.api.expect(201, 'POST', '/v1/packages', zip('droid', '1', ['privileged', 'binder']));
    const loadsBefore = kernel.loads;
    const { plan, op, inst } = await install('droid');
    expect(plan.permissions.map((p) => p.permission)).toEqual(['privileged', 'binder']);
    expect(plan.permissions[0]!.label).toMatch(/Full control of this machine/);
    expect(plan.permissions[1]!.label).toMatch(/binder/);
    expect(runtimeOf(inst.id).services.web.privileged).toBe(true);
    expect(kernel.loads).toBe(loadsBefore + 1);
    expect(op.events.some((e) => /binder driver/.test(e.message))).toBe(true);
    expect((await h.api.expect<DeveloperModeDto>(200, 'GET', '/v1/system/developer-mode')).untrustedApps).toEqual([inst.name]);
  });

  it('with it off again, the app keeps running but a new plan for it is refused', async () => {
    await h.api.expect(200, 'PUT', '/v1/system/developer-mode', { enabled: false });
    const inst = await byName('droid');
    expect(inst.runtime).toBe('running');
    // still listed, so the operator knows what holds full control
    expect((await h.api.expect<DeveloperModeDto>(200, 'GET', '/v1/system/developer-mode')).untrustedApps).toEqual([inst.name]);
    await h.api.expectError(403, 'UNTRUSTED_SOURCE', 'POST', '/v1/packages', zip('droid', '2', ['privileged', 'binder']));
    expect((await h.api.run({ kind: 'purge', instanceId: inst.id })).op.state).toBe('succeeded');
    await h.api.expectError(403, 'UNTRUSTED_SOURCE', 'POST', '/v1/plans', { kind: 'install', packageId: 'droid' });
  });

  it('a plan made while it was on is refused at approval once it is off', async () => {
    await h.api.expect(200, 'PUT', '/v1/system/developer-mode', { enabled: true, password: ADMIN.password });
    const plan: PlanDto = await h.api.plan({ kind: 'install', packageId: 'droid' });
    await h.api.expect(200, 'PUT', '/v1/system/developer-mode', { enabled: false });
    await h.api.expectError(403, 'UNTRUSTED_SOURCE', 'POST', '/v1/operations', { planId: plan.id, acceptPermissions: true }, { 'idempotency-key': 'devmode-stale-plan' });
    expect(await byName(plan.name)).toBeUndefined();
  });

  it('an official-catalog app gets them with developer mode off; a kernel without binder is refused at the plan', async () => {
    // the harness's private copy of the official catalog: excalidraw now asks for privileged + binder
    const dir = path.join(h.catalogDir, 'excalidraw');
    const m = readFileSync(path.join(dir, 'manifest.yaml'), 'utf8').replace(/\nhealth:/, '\npermissions:\n  web: [privileged, binder]\nhealth:');
    writeFileSync(path.join(dir, 'manifest.yaml'), m);
    const rel = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')) as { files: Record<string, { sha256: string }> };
    rel.files['manifest.yaml'] = { sha256: sha256Hex(Buffer.from(m)) };
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify(rel, null, 2));

    kernel.state = 'missing';
    const e = await h.api.expectError(409, 'KERNEL_MODULE_MISSING', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw' });
    expect(e.error.nextAction).toContain('linux-modules-extra-6.8.0-fake-generic');

    kernel.state = 'loaded';
    const loads = kernel.loads;
    const { inst } = await install('excalidraw');
    expect(runtimeOf(inst.id).services.web.privileged).toBe(true);
    expect(kernel.loads).toBe(loads); // already loaded: no root step
    expect((await h.api.expect<DeveloperModeDto>(200, 'GET', '/v1/system/developer-mode')).untrustedApps).toEqual([]);
  });
});
