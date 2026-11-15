import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto, SpaceDto, SpacesDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { projectNameFor } from '../../src/naming.js';
import { isHarborSubnet } from '../../src/planner/subnets.js';
import { startHarness, type Harness } from './harness.js';

// Spaces (decision 202): grouping on Home, and an opt-in shared network on which every service of every member
// answers to `<app>` (first endpoint's service) and `<app>-<service>`, never to its bare service name. Both apps
// here have a service called `db`, which must never be a name on the shared network.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (id: string, port: number) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: ${id} for the spaces tests
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
    db: infrastructure
endpoints:
  web:
    service: web
    containerPort: ${port}
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const compose = `services:\n  web:\n    image: nginx:1.27-alpine\n  db:\n    image: nginx:1.27-alpine\n`;
const upload = (id: string, port: number, c = compose) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, port), 'compose.yaml': c }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const containerNamed = (name: string) => [...h.fake.containers.values()].find((c) => c.name === name)!;
const networkNamed = (name: string) => [...h.fake.networks.values()].find((n) => n.name === name);
const repo = () => h.daemon.ctx.repo;

// Wait until every space operation queued since `before` finished; returns them.
async function spaceOps(before: Set<string>) {
  for (let i = 0; i < 300; i += 1) {
    const ops = repo().listOperations(500).filter((o) => !before.has(o.id) && o.kind === 'space');
    if (ops.every((o) => ['succeeded', 'failed', 'needs_action', 'cancelled'].includes(o.state))) return ops;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('space operations did not finish');
}
const opIds = () => new Set(repo().listOperations(500).map((o) => o.id));

describe('spaces (decision 202)', () => {
  let erp: InstanceSummary;
  let ui: InstanceSummary;
  let space: SpaceDto;
  const erpWeb = () => `${projectNameFor(erp.id)}-web-1`;
  const erpDb = () => `${projectNameFor(erp.id)}-db-1`;
  const uiWeb = () => `${projectNameFor(ui.id)}-web-1`;
  const uiDb = () => `${projectNameFor(ui.id)}-db-1`;
  const shared = () => {
    const net = space.network!;
    expect(h.fake.aliasesOn(erpWeb(), net)).toEqual(['spaceerp', 'spaceerp-web']);
    expect(h.fake.aliasesOn(erpDb(), net)).toEqual(['spaceerp-db']);
    expect(h.fake.aliasesOn(uiWeb(), net)).toEqual(['spaceui', 'spaceui-web']);
    expect(h.fake.aliasesOn(uiDb(), net)).toEqual(['spaceui-db']);
    const names = h.fake.namesOn(net);
    expect(names).not.toContain('db');
    expect(names).not.toContain('web');
  };

  it('installs two apps that both have a db service', async () => {
    await upload('spaceerp', 8080);
    await upload('spaceui', 3000);
    expect((await h.api.run({ kind: 'install', packageId: 'spaceerp' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'install', packageId: 'spaceui' })).op.state).toBe('succeeded');
    erp = await byName('spaceerp');
    ui = await byName('spaceui');
  });

  it('a space is grouping only by default: no network, no operation', async () => {
    const before = opIds();
    space = await h.api.expect<SpaceDto>(201, 'POST', '/v1/spaces', { name: 'Productivity', apps: [erp.id, ui.id] });
    expect(space).toMatchObject({ name: 'Productivity', shared: false, network: null, conflicts: [] });
    expect(space.apps.map((a) => a.name)).toEqual(['spaceerp', 'spaceui']);
    expect(space.apps.every((a) => a.addresses.length === 0)).toBe(true);
    expect(await spaceOps(before)).toEqual([]);
    expect([...h.fake.networks.values()].some((n) => n.name.startsWith('hb_space_'))).toBe(false);
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/spaces', { name: 'productivity' });
  });

  it('sharing needs an explicit confirmation', async () => {
    const err = await h.api.expectError(409, 'PERMISSION_REQUIRED', 'PATCH', `/v1/spaces/${space.id}`, { shared: true });
    expect(err.error.message).toMatch(/databases included/);
    expect((await h.api.expect<SpaceDto>(200, 'GET', '/v1/spaces')) as unknown as SpacesDto).toMatchObject({ items: [{ shared: false }] });
  });

  it('sharing attaches every service live under <app> and <app>-<service> only, nothing recreated', async () => {
    const ids = [erpWeb(), erpDb(), uiWeb(), uiDb()].map((n) => containerNamed(n).id);
    const before = opIds();
    space = await h.api.expect<SpaceDto>(200, 'PATCH', `/v1/spaces/${space.id}`, { shared: true, confirmShared: true });
    expect(space.network).toBe(`hb_space_${space.id}`);
    const ops = await spaceOps(before);
    expect(ops.map((o) => [o.state, o.actor])).toEqual([
      ['succeeded', 'space-policy'],
      ['succeeded', 'space-policy'],
    ]);
    shared();
    expect([erpWeb(), erpDb(), uiWeb(), uiDb()].map((n) => containerNamed(n).id)).toEqual(ids);
    const net = networkNamed(space.network!)!;
    expect(h.fake.internal.has(net.id)).toBe(true);
    expect(isHarborSubnet(net.subnets[0]!)).toBe(true);
    // the app page's addresses: the main one first, with the endpoint's container port
    const erpDto = space.apps.find((a) => a.instanceId === erp.id)!;
    expect(erpDto.addresses).toEqual([
      { alias: 'spaceerp', service: 'web', address: 'http://spaceerp:8080', main: true },
      { alias: 'spaceerp-web', service: 'web', address: 'http://spaceerp-web:8080', main: false },
      { alias: 'spaceerp-db', service: 'db', address: 'spaceerp-db', main: false },
    ]);
  });

  it('Restart recreates the containers and they are back on the network before they start', async () => {
    const project = projectNameFor(erp.id);
    const from = h.fake.log.length;
    expect((await h.api.run({ kind: 'restart', instanceId: erp.id })).op.state).toBe('succeeded');
    const log = h.fake.log.slice(from);
    const create = log.indexOf(`up ${project} --no-start --force-recreate`);
    const attach = log.findIndex((l) => l.startsWith(`network connect ${space.network} ${erpWeb()}`));
    const start = log.lastIndexOf(`up ${project}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(attach);
    shared();
  });

  it('Stop and Start keep it', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: ui.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: ui.id })).op.state).toBe('succeeded');
    shared();
  });

  it('refuses an app whose name would be ambiguous on the network', async () => {
    await upload('db', 8081);
    expect((await h.api.run({ kind: 'install', packageId: 'db' })).op.state).toBe('succeeded');
    const dbApp = await byName('db');
    const err = await h.api.expectError(409, 'NAME_CONFLICT', 'PATCH', `/v1/spaces/${space.id}`, { apps: [erp.id, ui.id, dbApp.id] });
    expect(err.error.message).toMatch(/the name db \(db\) is also a service name inside spaceerp, spaceui/);
    // a space that does not share a network takes it
    const other = await h.api.expect<SpaceDto>(201, 'POST', '/v1/spaces', { name: 'Tools', apps: [dbApp.id] });
    expect(other.shared).toBe(false);
  });

  it('an app taken out of the space is detached live; moving it to another space takes it out of the first', async () => {
    const tools = (await h.api.expect<SpacesDto>(200, 'GET', '/v1/spaces')).items.find((s) => s.name === 'Tools')!;
    const before = opIds();
    await h.api.expect<SpaceDto>(200, 'PATCH', `/v1/spaces/${tools.id}`, { apps: [...tools.apps.map((a) => a.instanceId), ui.id] });
    const ops = await spaceOps(before);
    expect(ops.map((o) => [o.instanceId, o.state])).toEqual([[ui.id, 'succeeded']]);
    expect(h.fake.aliasesOn(uiWeb(), space.network!)).toBeNull();
    expect(h.fake.aliasesOn(uiDb(), space.network!)).toBeNull();
    expect(h.fake.aliasesOn(erpWeb(), space.network!)).toEqual(['spaceerp', 'spaceerp-web']);
    const list = await h.api.expect<SpacesDto>(200, 'GET', '/v1/spaces');
    expect(list.items.find((s) => s.id === space.id)!.apps.map((a) => a.name)).toEqual(['spaceerp']);
    expect(list.items.find((s) => s.id === tools.id)!.apps.map((a) => a.name)).toEqual(['db', 'spaceui']);
  });

  it('turning sharing off detaches the rest and deletes the network', async () => {
    const before = opIds();
    await h.api.expect<SpaceDto>(200, 'PATCH', `/v1/spaces/${space.id}`, { shared: false });
    expect((await spaceOps(before)).map((o) => o.state)).toEqual(['succeeded']);
    expect(networkNamed(space.network!)).toBeUndefined();
  });

  it('remove of the last member deletes a shared network left empty; deleting a space keeps its apps', async () => {
    let before = opIds();
    space = await h.api.expect<SpaceDto>(200, 'PATCH', `/v1/spaces/${space.id}`, { shared: true, confirmShared: true });
    await spaceOps(before);
    expect(h.fake.aliasesOn(erpWeb(), space.network!)).toEqual(['spaceerp', 'spaceerp-web']);
    expect((await h.api.run({ kind: 'remove', instanceId: erp.id })).op.state).toBe('succeeded');
    expect(networkNamed(space.network!)).toBeUndefined();
    before = opIds();
    const left = await h.api.expect<SpacesDto>(200, 'DELETE', `/v1/spaces/${space.id}`);
    expect(left.items.map((s) => s.name)).toEqual(['Tools']);
    expect(await spaceOps(before)).toEqual([]);
    expect((await h.api.instances()).some((i) => i.id === erp.id)).toBe(true);
  });

  it('the API never takes a space plan', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'space', instanceId: ui.id });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { action: { kind: 'space', instanceId: ui.id } });
  });
});
