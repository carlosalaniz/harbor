import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogItemDto, InstanceSummary, PackageImportResultDto, PlanDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (rev: string, opts: { version?: string; notes?: string; secret?: boolean; volume?: boolean; extraEndpoint?: boolean } = {}) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: hello
  name: Hello
  description: A tiny web page
release:
  revision: "${rev}"
  version: "${opts.version ?? `0.${rev}.0`}"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
${opts.extraEndpoint ? '  admin:\n    service: web\n    containerPort: 8080\n    scheme: http\n    exposure: direct\n    browserContext: ordinary\n' : ''}health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
${opts.volume ? 'storage:\n  - id: data\n    composeVolume: data\n    purpose: Pages\n    retention: retain\n' : ''}${opts.secret ? 'secrets:\n  - id: token\n    bytes: 32\n    encoding: hex\n    retention: retain\n    bindings:\n      - service: web\n        environment: TOKEN\n' : ''}presentation:
  tagline: Says hello
  category: developer
  icon: icon.svg
${opts.notes ? `  releaseNotes: ${JSON.stringify(opts.notes)}\n` : ''}`;
const compose = (image: string, opts: { volume?: boolean } = {}) => `services:
  web:
    image: ${image}
${opts.volume ? '    volumes:\n      - type: volume\n        source: data\n        target: /usr/share/nginx/html\nvolumes:\n  data: {}\n' : ''}`;
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const upload = (files: Record<string, string>, fileName = 'hello.zip') => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName, dataUrl: `data:application/zip;base64,${writeZip(files, { folder: 'hello' }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name);

describe('your own apps: upload, install, update, rollback, remove', () => {
  it('uploads a package with a tag image: pinned by digest, listed as local, installable; the icon is served', async () => {
    const r = await upload({ 'manifest.yaml': manifest('1'), 'compose.yaml': compose('nginx:1.27-alpine'), 'icon.svg': ICON });
    expect(r.item).toMatchObject({ id: 'hello', origin: 'local', revision: '1', version: '0.1.0', qualification: 'pending', availability: 'available' });
    expect(r.pinned).toEqual([{ service: 'web', from: 'nginx:1.27-alpine', to: `nginx@sha256:${'1'.repeat(64)}` }]);
    expect(r.replacedRevision).toBeNull();
    expect(r.updatable).toEqual([]);
    const cat = await h.api.expect<{ items: CatalogItemDto[] }>(200, 'GET', '/v1/catalog');
    expect(cat.items.find((i) => i.id === 'hello')?.origin).toBe('local');
    expect(cat.items.find((i) => i.id === 'excalidraw')?.origin).toBe('bundled');
    const icon = await fetch(`${h.baseUrl}/v1/catalog/hello/asset/icon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    // bad uploads are refused with a reason
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/packages', { fileName: 'x.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest('1').replace('id: hello', 'id: excalidraw'), 'compose.yaml': compose('nginx:1.27-alpine'), 'icon.svg': ICON }).toString('base64')}` });
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/packages', { fileName: 'x.zip', dataUrl: `data:application/zip;base64,${Buffer.from('nope nope nope nope nope nope nope').toString('base64')}` });
    // install like any other app
    const plan = await h.api.plan({ kind: 'install', packageId: 'hello' });
    expect(plan.warnings.join(' ')).toMatch(/your own uploaded app/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    const inst = (await byName('hello'))!;
    expect(inst.revision).toBe('1');
    expect(inst.updateAvailable).toBeNull();
    expect(inst.icon).toBe('icon.svg');
    // an uploaded package in use cannot be removed
    await h.api.expectError(409, 'INVALID_STATE', 'DELETE', '/v1/packages/hello');
  });

  it('a higher revision becomes an update: plan shows the image change, update keeps ports/secrets/data and swaps images; release notes shown', async () => {
    const before = (await byName('hello'))!;
    const port = before.endpoints[0]!.hostPort;
    // publish it on the tailnet first: the address must survive the update
    expect((await h.api.run({ kind: 'expose', instanceId: before.id, via: 'tailnet' })).op.state).toBe('succeeded');
    const r = await upload({ 'manifest.yaml': manifest('2', { notes: 'Faster and shinier', secret: true }), 'compose.yaml': compose('nginx:1.28-alpine'), 'icon.svg': ICON }, 'hello-2.zip');
    expect(r.replacedRevision).toBe('1');
    expect(r.updatable).toEqual([{ instanceId: before.id, name: 'hello', fromRevision: '1' }]);
    const withUpdate = (await byName('hello'))!;
    expect(withUpdate.updateAvailable).toEqual({ revision: '2', version: '0.2.0', releaseNotes: 'Faster and shinier' });
    const plan = await h.api.plan({ kind: 'update', instanceId: before.id });
    expect(plan.kind).toBe('update');
    expect(plan.update).toMatchObject({ fromRevision: '1', toRevision: '2', fromVersion: '0.1.0', toVersion: '0.2.0', images: [{ service: 'web', from: `nginx@sha256:${'1'.repeat(64)}`, to: `nginx@sha256:${'2'.repeat(64)}` }], newSecrets: ['token'], newStorage: [], newEndpoints: [], releaseNotes: 'Faster and shinier' });
    expect(plan.changes.join('\n')).toMatch(/Keep the name, addresses, ports/);
    expect(plan.endpoints[0]!.hostPort).toBe(port);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    expect(op.result).toMatchObject({ fromRevision: '1', toRevision: '2', rolledBack: false });
    const after = (await byName('hello'))!;
    expect(after.revision).toBe('2');
    expect(after.updateAvailable).toBeNull();
    expect(after.endpoints[0]!.hostPort).toBe(port);
    expect(after.runtime).toBe('running');
    expect(after.endpoints[0]!.urls.tailnet).toBeDefined(); // exposure kept
    // the container runs the new image; the previous release is kept for a look
    expect([...h.fake.containers.values()].some((c) => c.image === `nginx@sha256:${'2'.repeat(64)}`)).toBe(true);
    expect([...h.fake.containers.values()].some((c) => c.image === `nginx@sha256:${'1'.repeat(64)}`)).toBe(false);
    expect(existsSync(path.join(h.stateDir, 'instances', before.id, 'release-previous', 'manifest.yaml'))).toBe(true);
    expect(readFileSync(path.join(h.stateDir, 'instances', before.id, 'release', 'manifest.yaml'), 'utf8')).toContain('revision: "2"');
    // new secret generated, stored release snapshot updated
    const detail = await h.api.expect<{ resources: { kind: string; name: string }[] }>(200, 'GET', `/v1/instances/${before.id}`);
    expect(detail.resources.some((x) => x.kind === 'container')).toBe(true);
    // nothing to update now
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'update', instanceId: before.id });
  });

  it('a broken update rolls back: the app keeps running the previous revision and stays updatable', async () => {
    const inst = (await byName('hello'))!;
    await upload({ 'manifest.yaml': manifest('3'), 'compose.yaml': compose('nginx:alpine'), 'icon.svg': ICON }, 'hello-3.zip');
    h.fake.behaviour.failUpImage = '3'.repeat(64); // only the new image fails; the rollback's old image starts fine
    const plan = await h.api.plan({ kind: 'update', instanceId: inst.id });
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    h.fake.behaviour.failUpImage = null;
    expect(op.state).toBe('failed');
    expect(op.error?.message).toMatch(/rolled back to revision 2/);
    expect(op.result).toMatchObject({ rolledBack: true });
    const msgs = op.events.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/putting revision 2 back/);
    expect(msgs).toMatch(/is back on revision 2/);
    const after = (await byName('hello'))!;
    expect(after.revision).toBe('2');
    expect(after.installState).toBe('installed');
    expect(after.runtime).toBe('running');
    expect(after.updateAvailable?.revision).toBe('3');
    expect(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'release', 'manifest.yaml'), 'utf8')).toContain('revision: "2"');
    // retry works once the image is fine
    const again = await h.api.run({ kind: 'update', instanceId: inst.id });
    expect(again.op.state).toBe('succeeded');
    expect((await byName('hello'))!.revision).toBe('3');
  });

  it('an update that adds a volume and an endpoint creates them; removing the package works only once no app uses it', async () => {
    const inst = (await byName('hello'))!;
    await upload({ 'manifest.yaml': manifest('4', { volume: true, extraEndpoint: true }), 'compose.yaml': compose('nginx:alpine', { volume: true }), 'icon.svg': ICON }, 'hello-4.zip');
    const plan = await h.api.plan({ kind: 'update', instanceId: inst.id });
    expect(plan.update?.newStorage).toEqual(['data']);
    expect(plan.update?.newEndpoints).toEqual(['admin']);
    expect(plan.endpoints.map((e) => e.id).sort()).toEqual(['admin', 'web']);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    const after = (await byName('hello'))!;
    expect(after.endpoints.map((e) => e.id).sort()).toEqual(['admin', 'web']);
    expect(after.endpoints.find((e) => e.id === 'web')!.hostPort).toBe(inst.endpoints[0]!.hostPort);
    const detail = await h.api.expect<{ resources: { kind: string; role: string }[] }>(200, 'GET', `/v1/instances/${inst.id}`);
    expect(detail.resources.some((r) => r.kind === 'volume' && r.role === 'data')).toBe(true);
    // remove the package: refused while installed, fine after a full uninstall
    await h.api.expectError(409, 'INVALID_STATE', 'DELETE', '/v1/packages/hello');
    expect((await h.api.run({ kind: 'purge', instanceId: inst.id })).op.state).toBe('succeeded');
    await h.api.expect(204, 'DELETE', '/v1/packages/hello');
    expect((await h.api.expect<{ items: CatalogItemDto[] }>(200, 'GET', '/v1/catalog')).items.some((i) => i.id === 'hello')).toBe(false);
    await h.api.expectError(404, 'NOT_FOUND', 'DELETE', '/v1/packages/hello');
    await h.api.expectError(404, 'NOT_FOUND', 'DELETE', '/v1/packages/excalidraw');
  });

  it('bundled apps: a newer bundled revision (after a Harbor upgrade) shows as an update too', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    // simulate a Harbor upgrade shipping revision 2 of excalidraw in the bundled catalog
    const dir = path.join(h.catalogDir, 'excalidraw');
    const { writeFileSync } = await import('node:fs');
    const m = readFileSync(path.join(dir, 'manifest.yaml'), 'utf8').replace('revision: "1"', 'revision: "2"');
    writeFileSync(path.join(dir, 'manifest.yaml'), m);
    const rel = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')) as { package: { revision: string }; files: Record<string, { sha256: string }> };
    rel.package.revision = '2';
    const { sha256Hex } = await import('../../src/packages/inventory.js');
    rel.files['manifest.yaml'] = { sha256: sha256Hex(Buffer.from(m)) };
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify(rel, null, 2));
    const idx = JSON.parse(readFileSync(path.join(h.catalogDir, 'index.json'), 'utf8')) as { packages: Record<string, { revision: string }> };
    idx.packages['excalidraw']!.revision = '2';
    writeFileSync(path.join(h.catalogDir, 'index.json'), JSON.stringify(idx));
    const inst = (await byName('excalidraw'))!;
    expect(inst.updateAvailable?.revision).toBe('2');
    const plan = await h.api.plan({ kind: 'update', instanceId: inst.id }) as PlanDto;
    expect(plan.update?.images).toEqual([]); // same image, new package revision
    expect((await h.api.waitOperation((await h.api.submit(plan.id)).operationId)).state).toBe('succeeded');
    expect(((await byName('excalidraw')) as InstanceSummary).revision).toBe('2');
  });
});
