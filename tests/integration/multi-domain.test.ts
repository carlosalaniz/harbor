// Decision 127: one endpoint published under several public hostnames — each its own exposure row,
// Caddy route, certificate and protection; withdraw one by name; the main one is explicit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ExposureDto, InstanceSummary, UiExposureDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';

const HOOK = `hooks:
  afterStart:
    service: web
    command: [sh, -c, "echo configured"]
`;

describe('several public hostnames per endpoint (decision 127)', () => {
  let h: Harness;
  let app: InstanceSummary;
  const fresh = async () => (await h.api.instances()).find((i) => i.id === app.id)!;
  const pubs = async () => (await h.api.expect<{ items: ExposureDto[]; ui: UiExposureDto | null }>(200, 'GET', '/v1/exposures')).items.filter((e) => e.instanceId === app.id && e.via === 'public');
  const env = (inst: InstanceSummary) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8')).services.web.environment as Record<string, string>;
  const lastExec = () => h.fake.execs[h.fake.execs.length - 1]!;

  beforeAll(async () => {
    h = await startHarness();
    // Like an ERP: has its own login, embeds its main address and keeps a host list (hook).
    writePackage(h.catalogDir, 'erpapp', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: erpapp') + 'setup:\n  endpoint: web\n  instructions: Create the owner.\nconfiguration:\n  - {service: web, environment: BASE_URL, endpoint: web}\n' + HOOK,
      compose: `services:\n  web:\n    image: example/erpapp@${DIGEST_A}\n`,
      images: { web: `example/erpapp@${DIGEST_A}` },
    });
    expect((await h.api.run({ kind: 'install', packageId: 'erpapp' })).op.state).toBe('succeeded');
    app = (await h.api.instances()).find((i) => i.packageId === 'erpapp')!;
  });
  afterAll(async () => h.close());

  it('publishes a second public name next to the first: two rows, two Caddy routes to the same port, hook lists both', async () => {
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'erp.example.com', makePrimary: true })).op.state).toBe('succeeded');
    const plan = await h.api.plan({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'customers.example.org', protection: 'basic' });
    expect(plan.changes.join(' ')).toMatch(/Keep https:\/\/erp\.example\.com\/; the new name gets its own Caddy route and certificate/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect((op.result?.['credentials'] as { username: string } | undefined)?.username).toBe('harbor'); // its own protection
    expect(h.caddy.routes().sort()).toEqual(['customers.example.org', 'erp.example.com']);
    const cfg = JSON.stringify(h.caddy.config);
    expect(cfg.match(new RegExp(`127\\.0\\.0\\.1:${app.endpoints[0]!.hostPort}`, 'g'))?.length).toBe(2);
    expect((cfg.match(/"handler":"authentication"/g) ?? []).length).toBe(1); // only the protected name
    const list = await pubs();
    expect(list.map((e) => [e.hostname, e.protection, e.isPrimary])).toEqual([
      ['erp.example.com', 'none', true],
      ['customers.example.org', 'basic', false],
    ]);
    const addrs = lastExec().env['HARBOR_ADDRESSES']!.split(' ');
    expect(addrs).toContain('erp.example.com');
    expect(addrs).toContain('customers.example.org');
    expect(lastExec().env['HARBOR_URL']).toBe('https://erp.example.com/');
    const inst = await fresh();
    expect(inst.endpoints[0]!.urls.public).toBe('https://erp.example.com/'); // the main one
    expect(env(inst)['BASE_URL']).toBe('https://erp.example.com/');
  });

  it('refuses the same name twice, a name another app uses, and a guessed withdrawal', async () => {
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'expose', instanceId: app.id, via: 'public', hostname: 'erp.example.com' });
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    const other = (await h.api.instances()).find((i) => i.packageId === 'excalidraw')!;
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/plans', { kind: 'expose', instanceId: other.id, via: 'public', hostname: 'customers.example.org' });
    const err = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'unexpose', instanceId: app.id, via: 'public' });
    expect(err.error.message).toMatch(/2 public hostnames \(erp\.example\.com, customers\.example\.org\)/);
    expect(err.error.nextAction).toMatch(/--host <hostname>/);
    await h.api.expectError(404, 'NOT_FOUND', 'POST', '/v1/plans', { kind: 'unexpose', instanceId: app.id, via: 'public', hostname: 'nope.example.net' });
    // tailnet stays one per endpoint
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'tailnet' })).op.state).toBe('succeeded');
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'expose', instanceId: app.id, via: 'tailnet' });
    expect((await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'tailnet' })).op.state).toBe('succeeded');
  });

  it('primary --host picks the named public host: base URL, hook URL and isPrimary follow', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: app.id, primary: 'public', hostname: 'nope.example.net' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: app.id, primary: 'loopback', hostname: 'erp.example.com' });
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: app.id, primary: 'public', hostname: 'erp.example.com' });
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: app.id, primary: 'public' }); // already public (the first name)
    const r = await h.api.run({ kind: 'reconfigure', instanceId: app.id, primary: 'public', hostname: 'customers.example.org' });
    expect(r.plan.changes[0]).toBe('Make https://customers.example.org/ the primary address of "erpapp"');
    expect(r.op.state).toBe('succeeded');
    const inst = await fresh();
    expect(inst.endpoints[0]!.primary).toBe('public');
    expect(inst.endpoints[0]!.urls.public).toBe('https://customers.example.org/');
    expect(env(inst)['BASE_URL']).toBe('https://customers.example.org/');
    expect(lastExec().env['HARBOR_URL']).toBe('https://customers.example.org/');
    expect((await pubs()).filter((e) => e.isPrimary).map((e) => e.hostname)).toEqual(['customers.example.org']);
  });

  it('withdrawing one name keeps the other; withdrawing the main name hands the main address to the one left', async () => {
    const un = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'public', hostname: 'customers.example.org' });
    expect(un.plan.changes.join(' ')).toMatch(/https:\/\/erp\.example\.com\/ becomes the primary address/);
    expect(un.op.state).toBe('succeeded');
    expect(h.caddy.routes()).toEqual(['erp.example.com']);
    let inst = await fresh();
    expect(inst.endpoints[0]!.primary).toBe('public');
    expect(inst.endpoints[0]!.urls.public).toBe('https://erp.example.com/');
    expect(env(inst)['BASE_URL']).toBe('https://erp.example.com/');
    expect(lastExec().env['HARBOR_ADDRESSES']).not.toContain('customers.example.org');
    expect((await pubs()).map((e) => [e.hostname, e.isPrimary])).toEqual([['erp.example.com', true]]);
    // one name left: --host is optional again; it was the main one, so loopback takes over
    const last = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'public' });
    expect(last.op.state).toBe('succeeded');
    expect(h.caddy.routes()).toEqual([]);
    inst = await fresh();
    expect(inst.endpoints[0]!.primary).toBe('loopback');
    expect(env(inst)['BASE_URL']).toBe(inst.endpoints[0]!.browserUrl);
  });

  it('withdrawing a name that is not the main one leaves the base URL alone; remove withdraws every name', async () => {
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'erp.example.com', makePrimary: true })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'customers.example.org' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'portal.example.org' })).op.state).toBe('succeeded');
    const un = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'public', hostname: 'customers.example.org' });
    expect(un.plan.changes.join(' ')).not.toMatch(/primary address/);
    expect(un.op.state).toBe('succeeded');
    expect(env(await fresh())['BASE_URL']).toBe('https://erp.example.com/');
    expect(h.caddy.routes().sort()).toEqual(['erp.example.com', 'portal.example.org']);
    expect((await h.api.run({ kind: 'remove', instanceId: app.id })).op.state).toBe('succeeded');
    expect(h.caddy.routes()).toEqual([]);
    expect(await pubs()).toEqual([]);
  });
});
