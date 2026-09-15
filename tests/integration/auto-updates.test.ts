import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (id: string, rev: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: A tiny web page
release:
  revision: "${rev}"
  version: "0.${rev}.0"
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
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
presentation:
  tagline: Says hello
  category: developer
`;
const compose = (image: string) => `services:\n  web:\n    image: ${image}\n`;
const upload = (id: string, rev: string, image: string) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev), 'compose.yaml': compose(image) }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name);
const waitFor = async (fn: () => Promise<boolean>, ms = 15000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 300));
  }
};

describe('automatic updates and update-all (decision 78)', () => {
  let a: InstanceSummary; // auto-update on
  let b: InstanceSummary; // manual

  it('per-app toggle and the global default are off by default and settable', async () => {
    expect(await h.api.expect(200, 'GET', '/v1/updates/policy')).toEqual({ autoDefault: false });
    await upload('autoapp', '1', 'nginx:1.27-alpine');
    await upload('manualapp', '1', 'nginx:1.27-alpine');
    expect((await h.api.run({ kind: 'install', packageId: 'autoapp' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'install', packageId: 'manualapp' })).op.state).toBe('succeeded');
    a = (await byName('autoapp'))!;
    b = (await byName('manualapp'))!;
    expect(a.autoUpdate).toBe(false);
    const toggled = await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${a.id}/auto-update`, { enabled: true });
    expect(toggled.autoUpdate).toBe(true);
  });

  it('the observer applies updates only for auto-enabled apps; others just get a notification', async () => {
    await upload('autoapp', '2', 'nginx:1.28-alpine');
    await upload('manualapp', '2', 'nginx:1.28-alpine');
    // the auto app updates itself (observer tick at 500 ms)
    await waitFor(async () => {
      const i = (await byName('autoapp'))!;
      return i.revision === '2' && i.installState === 'installed';
    });
    const auto = (await byName('autoapp'))!;
    expect(auto.installState).toBe('installed');
    expect(auto.updateAvailable).toBeNull();
    // the manual app stays and keeps its update flag
    const manual = (await byName('manualapp'))!;
    expect(manual.revision).toBe('1');
    expect(manual.updateAvailable?.revision).toBe('2');
    // the auto-update ran under the auto-update actor
    const op = await h.api.expect<{ actor?: string; kind: string }>(200, 'GET', `/v1/operations/${auto.operationId}`);
    expect(op.kind).toBe('update');
  });

  it('update-all submits one update per eligible app through the queue', async () => {
    const r = await h.api.expect<{ started: { instanceId: string; name: string; operationId: string }[]; skipped: unknown[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(r.started.map((s) => s.name)).toEqual(['manualapp']);
    await waitFor(async () => (await byName('manualapp'))!.revision === '2');
    expect((await byName('manualapp'))!.updateAvailable).toBeNull();
    // nothing to update now
    const again = await h.api.expect<{ started: unknown[]; skipped: unknown[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(again.started).toEqual([]);
  });

  it('a failed auto-update rolls back and is not retried for the same revision', async () => {
    // revision 3 with an image the fake refuses to start (nginx:alpine resolves to the 3… digest)
    h.fake.behaviour.failUpImage = 'sha256:' + '3'.repeat(64);
    await upload('autoapp', '3', 'nginx:alpine');
    // wait until the auto attempt happened and rolled back (revision stays 2, update flag stays)
    await waitFor(async () => {
      const inst = (await byName('autoapp'))!;
      if (inst.revision !== '2' || inst.installState !== 'installed' || !inst.operationId) return false;
      const op = await h.api.expect<{ state: string; kind: string }>(200, 'GET', `/v1/operations/${inst.operationId}`);
      return op.kind === 'update' && op.state === 'failed';
    });
    const inst = (await byName('autoapp'))!;
    expect(inst.updateAvailable?.revision).toBe('3');
    // give the observer more ticks: no second attempt for the same revision
    const opId = inst.operationId;
    await new Promise((r) => setTimeout(r, 1500));
    expect((await byName('autoapp'))!.operationId).toBe(opId);
    h.fake.behaviour.failUpImage = null;
    // the failure surfaced as a notification
    const n = await h.api.expect<{ items: { kind: string; title: string }[] }>(200, 'GET', '/v1/notifications');
    expect(n.items.some((x) => x.kind === 'operation-failed' && /autoapp/.test(x.title))).toBe(true);
  });

  it('the global default applies to newly installed apps', async () => {
    await h.api.expect(200, 'PUT', '/v1/updates/policy', { autoDefault: true });
    expect((await h.api.run({ kind: 'install', packageId: 'manualapp', name: 'manualapp-2' })).op.state).toBe('succeeded');
    expect((await byName('manualapp-2'))!.autoUpdate).toBe(true);
    expect(b.autoUpdate).toBe(false); // existing apps untouched
  });
});
