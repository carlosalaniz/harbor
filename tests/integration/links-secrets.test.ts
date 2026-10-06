import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceDetail, InstanceSummary, LinkDto, NotificationsDto, OperationDto, PackageImportResultDto, PlanDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { LABELS, projectNameFor } from '../../src/naming.js';
import { startHarness, type Harness } from './harness.js';

// Decisions 125 (operator-provided secrets) and 126 (app links), end to end against the fake engine.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const TOKEN = 'tok-FIXTURE-7d1f0c2a9b';
const TOKEN2 = 'tok-FIXTURE-second-4e8a';

const head = (id: string, name: string, services: string, port = 80) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${name}
  description: ${name} for the links and secrets tests
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
${services}
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
const tokenApp = head('tokenapp', 'Tokenapp', '    web: application') + `secrets:
  - id: api-token
    source: operator
    prompt: Access token of the service this app talks to
    minLength: 8
    retention: retain
    bindings:
      - {service: web, environment: API_TOKEN}
  - id: smtp-pass
    source: operator
    prompt: SMTP password (optional)
    optional: true
    retention: retain
    bindings:
      - {service: web, environment: SMTP_PASSWORD}
`;
const docsApp = head('docsapp', 'Docsapp', '    web: application\n    db: infrastructure', 3010);
const gateway = head('gatewayish', 'Gatewayish', '    web: application\n    sidecar: application') + `links:
  - id: docs
    purpose: The documents app it reads and writes
    provider: {packages: [docsapp]}
    bindings:
      - {service: web, environment: DOCS_BASE_URL}
`;
const composeOf = (services: string[]) => `services:\n${services.map((s) => `  ${s}:\n    image: nginx:1.27-alpine\n`).join('')}`;
const upload = (m: string, services: string[]) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': m, 'compose.yaml': composeOf(services) }).toString('base64')}` });
const submit = (planId: string, body: Record<string, unknown> = {}) => h.api.json<{ operationId: string; operation: OperationDto; error?: { code: string; message: string; nextAction: string } }>('POST', '/v1/operations', { planId, ...body }, { 'idempotency-key': `key-${Math.random().toString(36).slice(2, 12)}` });
const runtime = (id: string) => readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8');
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const networkNamed = (name: string) => [...h.fake.networks.values()].find((n) => n.name === name);
const containerId = (project: string, svc: string) => [...h.fake.containers.values()].find((c) => c.name === `${project}-${svc}-1`)?.id;

describe('operator-provided secrets (decision 125)', () => {
  let inst: InstanceSummary;
  let plan: PlanDto;

  it('the install plan asks for the value with its prompt, and a submission without it is refused before anything exists', async () => {
    await upload(tokenApp, ['web']);
    plan = await h.api.plan({ kind: 'install', packageId: 'tokenapp' });
    const s = plan.secrets.find((x) => x.id === 'api-token')!;
    expect(s).toMatchObject({ source: 'operator', prompt: 'Access token of the service this app talks to', optional: false, minLength: 8, ask: 'required' });
    expect(plan.secrets.find((x) => x.id === 'smtp-pass')).toMatchObject({ ask: 'optional', optional: true });
    expect(plan.changes.join('\n')).toMatch(/Store the value you provide for api-token/);
    const missing = await submit(plan.id);
    expect(missing.status).toBe(422);
    expect(missing.body.error?.message).toMatch(/is needed \(secret api-token\)/);
    expect(missing.body.error?.nextAction).toMatch(/--secret api-token=@file/);
    const bad = await submit(plan.id, { secrets: { 'api-token': 'short' } });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).not.toContain('"short"');
    const unknown = await submit(plan.id, { secrets: { 'api-token': TOKEN, nope: 'x' } });
    expect(unknown.status).toBe(422);
    expect((await h.api.instances()).some((i) => i.packageId === 'tokenapp')).toBe(false);
  });

  it('install with the value: bound like a generated secret (0600 file, env), absent from every DTO, plan and event', async () => {
    const r = await submit(plan.id, { secrets: { 'api-token': TOKEN } });
    expect(r.status).toBe(202);
    const op = await h.api.waitOperation(r.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    inst = await byName('tokenapp');
    expect(runtime(inst.id)).toContain(`API_TOKEN: "${TOKEN}"`);
    expect(runtime(inst.id)).not.toContain('SMTP_PASSWORD');
    const file = path.join(h.stateDir, 'instances', inst.id, 'secrets', 'api-token');
    expect(readFileSync(file, 'utf8')).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(h.stateDir, 'instances', inst.id, 'secrets', 'smtp-pass'))).toBe(false);
    expect(h.fake.envOf(`${projectNameFor(inst.id)}-web-1`)?.['API_TOKEN']).toBe(TOKEN);
    // nowhere in what the API returns
    const everything = JSON.stringify([
      await h.api.expect<PlanDto>(200, 'GET', `/v1/plans/${plan.id}`),
      await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${op.id}`),
      await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${inst.id}`),
      await h.api.instances(),
      await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications'),
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(inst.operatorSecrets).toEqual([
      { id: 'api-token', prompt: 'Access token of the service this app talks to', optional: false, set: true },
      { id: 'smtp-pass', prompt: 'SMTP password (optional)', optional: true, set: false },
    ]);
    // nor in the plan row or the event log in the database
    const db = readFileSync(path.join(h.stateDir, 'harbor.db')).toString('latin1') + (existsSync(path.join(h.stateDir, 'harbor.db-wal')) ? readFileSync(path.join(h.stateDir, 'harbor.db-wal')).toString('latin1') : '');
    expect(db).not.toContain(TOKEN);
  });

  it('remove + reinstall keeps the value; configure replaces it (and only when asked)', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'reinstall', instanceId: inst.id })).op.state).toBe('succeeded');
    expect(runtime(inst.id)).toContain(`API_TOKEN: "${TOKEN}"`);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: inst.id });
    const p = await h.api.plan({ kind: 'configure', instanceId: inst.id, secrets: ['api-token', 'smtp-pass'] });
    expect(p.secrets.find((s) => s.id === 'api-token')?.ask).toBe('required');
    const r = await submit(p.id, { secrets: { 'api-token': TOKEN2, 'smtp-pass': 'smtp-FIXTURE-pw' } });
    expect(r.status).toBe(202);
    const op = await h.api.waitOperation(r.body.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(runtime(inst.id)).toContain(`API_TOKEN: "${TOKEN2}"`);
    expect(runtime(inst.id)).toContain('SMTP_PASSWORD: "smtp-FIXTURE-pw"');
    expect(runtime(inst.id)).not.toContain(TOKEN);
    expect(JSON.stringify(await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${op.id}`))).not.toContain(TOKEN2);
    // generated secrets cannot be typed in
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: inst.id, secrets: ['nope'] });
  });

  it('a full uninstall deletes the stored value with the other secrets', async () => {
    expect((await h.api.run({ kind: 'purge', instanceId: inst.id })).op.state).toBe('succeeded');
    expect(existsSync(path.join(h.stateDir, 'instances', inst.id, 'secrets', 'api-token'))).toBe(false);
  });
});

describe('app links (decision 126)', () => {
  let docs: InstanceSummary;
  let gw: InstanceSummary;
  let net: string;

  it('install picks the only provider, creates an internal Harbor-owned network joining only the consumer service and the provider endpoint service', async () => {
    await upload(docsApp, ['web', 'db']);
    await upload(gateway, ['web', 'sidecar']);
    // nothing to link to yet
    const none = await h.api.json<{ error: { code: string; nextAction: string } }>('POST', '/v1/plans', { kind: 'install', packageId: 'gatewayish' });
    expect(none.status).toBe(422);
    expect(none.body.error.nextAction).toMatch(/Install docsapp first/);
    expect((await h.api.run({ kind: 'install', packageId: 'docsapp' })).op.state).toBe('succeeded');
    docs = await byName('docsapp');
    const { plan, op } = await h.api.run({ kind: 'install', packageId: 'gatewayish' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(plan.links).toEqual([expect.objectContaining({ id: 'docs', change: 'set', alias: 'docs-link', provider: { instanceId: docs.id, name: 'docsapp', endpointId: 'web', url: 'http://docs-link:3010' } })]);
    gw = await byName('gatewayish');
    net = plan.links[0]!.network;
    expect(net).toBe(`${projectNameFor(gw.id)}_link_docs`);
    const n = networkNamed(net)!;
    expect(n).toBeTruthy();
    expect(h.fake.internal.has(n.id)).toBe(true);
    expect(n.labels[LABELS.instance]).toBe(gw.id);
    expect(n.labels[LABELS.kind]).toBe('link');
    expect(n.labels[LABELS.provider]).toBe(docs.id);
    expect(new Set(n.containerIds)).toEqual(new Set([containerId(projectNameFor(gw.id), 'web'), containerId(projectNameFor(docs.id), 'web')]));
    expect(n.containerIds).not.toContain(containerId(projectNameFor(docs.id), 'db'));
    expect(n.containerIds).not.toContain(containerId(projectNameFor(gw.id), 'sidecar'));
    expect(h.fake.aliasesOn(`${projectNameFor(docs.id)}-web-1`, net)).toEqual(['docs-link']);
    expect(h.fake.envOf(`${projectNameFor(gw.id)}-web-1`)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    expect(h.fake.envOf(`${projectNameFor(gw.id)}-sidecar-1`)?.['DOCS_BASE_URL']).toBeUndefined();
    // the provider's own Compose file carries the link so every later `up` keeps it
    expect(runtime(docs.id)).toContain(net);
    expect(runtime(docs.id)).toContain('docs-link');
    const links = (await h.api.expect<{ items: LinkDto[] }>(200, 'GET', '/v1/links')).items;
    expect(links).toEqual([expect.objectContaining({ id: 'docs', state: 'active', consumer: { instanceId: gw.id, name: 'gatewayish' }, provider: { instanceId: docs.id, name: 'docsapp', endpointId: 'web' }, network: net, url: 'http://docs-link:3010' })]);
    expect((await byName('docsapp')).linkedBy).toEqual([{ instanceId: gw.id, name: 'gatewayish', linkId: 'docs', state: 'active' }]);
  });

  it('a required link with several candidates must be chosen', async () => {
    expect((await h.api.run({ kind: 'install', packageId: 'docsapp', name: 'docs2' })).op.state).toBe('succeeded');
    const r = await h.api.json<{ error: { code: string; nextAction: string } }>('POST', '/v1/plans', { kind: 'install', packageId: 'gatewayish', name: 'gw2' });
    expect(r.status).toBe(422);
    expect(r.body.error.nextAction).toMatch(/--link docs=<(docsapp\|docs2|docs2\|docsapp)>/);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'gatewayish', name: 'gw2', links: { docs: { instanceId: gw.id } } });
  });

  it('Restart re-applies a link whose network vanished', async () => {
    const n = networkNamed(net)!;
    for (const c of h.fake.containers.values()) c.networkIds = c.networkIds.filter((x) => x !== n.id);
    h.fake.networks.delete(n.id);
    const { op } = await h.api.run({ kind: 'restart', instanceId: gw.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const again = networkNamed(net)!;
    expect(new Set(again.containerIds)).toEqual(new Set([containerId(projectNameFor(gw.id), 'web'), containerId(projectNameFor(docs.id), 'web')]));
    expect(h.fake.aliasesOn(`${projectNameFor(docs.id)}-web-1`, net)).toEqual(['docs-link']);
  });

  it('removing the provider drops the network and flags the consumer; configure links it to another provider', async () => {
    const { plan, op } = await h.api.run({ kind: 'remove', instanceId: docs.id });
    expect(plan.warnings.join(' ')).toMatch(/gatewayish reaches docsapp through its link "docs"/);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(networkNamed(net)).toBeUndefined();
    const flagged = (await byName('gatewayish')).links[0]!;
    expect(flagged).toMatchObject({ state: 'needs_provider', provider: null, note: 'docsapp was removed' });
    expect(runtime(gw.id)).not.toContain(net);
    expect(runtime(gw.id)).not.toContain('DOCS_BASE_URL');
    const notes = await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications');
    expect(notes.items.some((x) => x.kind === 'link-needs-provider' && x.instanceId === gw.id)).toBe(true);
    // the consumer keeps running (a Restart now renders it without the link)
    expect((await h.api.run({ kind: 'restart', instanceId: gw.id })).op.state).toBe('succeeded');
    const docs2 = await byName('docs2');
    const c = await h.api.run({ kind: 'configure', instanceId: gw.id, links: { docs: { instanceId: docs2.id } } });
    expect(c.op.state, JSON.stringify(c.op.error)).toBe('succeeded');
    const relinked = (await byName('gatewayish')).links[0]!;
    expect(relinked).toMatchObject({ state: 'active', provider: { instanceId: docs2.id, name: 'docs2', endpointId: 'web' } });
    expect(new Set(networkNamed(net)!.containerIds)).toEqual(new Set([containerId(projectNameFor(gw.id), 'web'), containerId(projectNameFor(docs2.id), 'web')]));
    expect(h.fake.envOf(`${projectNameFor(gw.id)}-web-1`)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    const after = await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications');
    expect(after.items.some((x) => x.kind === 'link-needs-provider' && x.instanceId === gw.id)).toBe(false);
  });

  it('removing the consumer drops the link (dormant) and Reinstall brings it back; purge forgets it', async () => {
    const docs2 = await byName('docs2');
    expect((await h.api.run({ kind: 'remove', instanceId: gw.id })).op.state).toBe('succeeded');
    expect(networkNamed(net)).toBeUndefined();
    expect(runtime(docs2.id)).not.toContain(net);
    expect((await byName('gatewayish')).links[0]?.state).toBe('dormant');
    expect((await h.api.run({ kind: 'reinstall', instanceId: gw.id })).op.state).toBe('succeeded');
    expect((await byName('gatewayish')).links[0]?.state).toBe('active');
    expect(new Set(networkNamed(net)!.containerIds)).toEqual(new Set([containerId(projectNameFor(gw.id), 'web'), containerId(projectNameFor(docs2.id), 'web')]));
    expect((await h.api.run({ kind: 'purge', instanceId: gw.id })).op.state).toBe('succeeded');
    expect(networkNamed(net)).toBeUndefined();
    expect((await h.api.expect<{ items: LinkDto[] }>(200, 'GET', '/v1/links')).items).toEqual([]);
    expect((await byName('docs2')).linkedBy).toEqual([]);
  });

  it('never adopts a network it did not create (ownership check before use)', async () => {
    const docs2 = await byName('docs2');
    const plan = await h.api.plan({ kind: 'install', packageId: 'gatewayish', name: 'gw3', links: { docs: { instanceId: docs2.id } } });
    await h.fake.createNetwork(plan.links[0]!.network, { owner: 'someone-else' }, { internal: false });
    const sub = await h.api.submit(plan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.error?.code).toBe('OWNERSHIP_CONFLICT');
    expect(networkNamed(plan.links[0]!.network)?.labels).toEqual({ owner: 'someone-else' });
  });
});
