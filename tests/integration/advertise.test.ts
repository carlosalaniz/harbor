// Decision 200: an endpoint with `advertise:` is announced on the LAN while the app runs in LAN mode, and withdrawn
// when it stops or is removed. The fake publisher keeps what avahi-publish would be running.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { FakeAdvertPublisher } from '../../src/advertise/publisher.js';
import { freePort, startHarness, type Harness } from './harness.js';

const MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: panel
  name: Panel browser
  description: Renders a page for small displays
release:
  revision: "1"
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
  stream:
    service: web
    containerPort: 8080
    scheme: http
    exposure: direct
    browserContext: ordinary
    kind: api
    login: never
    advertise:
      type: _desk-panel._tcp
      name: Desk panel
      txt:
        path: /panel
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

describe('LAN announcements (decision 200)', () => {
  let h: Harness;
  const pub = new FakeAdvertPublisher();
  let first: InstanceSummary;
  beforeAll(async () => {
    h = await startHarness({ portRange: { from: 18400, to: 18430 }, config: { lan: { enabled: true, port: await freePort() } }, overrides: { advertise: pub } });
    await h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'panel.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': MANIFEST, 'compose.yaml': COMPOSE }, { folder: 'panel' }).toString('base64')}` });
  });
  afterAll(async () => h.close());

  const summary = async (id: string) => (await h.api.instances()).find((i) => i.id === id)!;

  it('install: the endpoint is announced on its plain LAN port with the package TXT records and Harbor\'s own', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'panel' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    first = (await h.api.instances()).find((i) => i.packageId === 'panel')!;
    const stream = first.endpoints.find((e) => e.id === 'stream')!;
    expect([...pub.current.values()]).toEqual([
      { key: `${first.id}/stream`, instanceId: first.id, endpointId: 'stream', name: 'Desk panel', type: '_desk-panel._tcp', port: stream.hostPort, txt: [['path', '/panel'], ['app', 'panel'], ['harbor', '1'], ['scheme', 'http']] },
    ]);
    expect(first.announce).toEqual([{ endpointId: 'stream', type: '_desk-panel._tcp', name: 'Desk panel', state: 'announced' }]);
    expect(first.endpoints.find((e) => e.id === 'web')).toBeDefined(); // the web endpoint asks for nothing
  });

  it('a second copy of the app gets its own name (avahi refuses a local duplicate)', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'panel' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    expect([...pub.current.values()].map((a) => a.name).sort()).toEqual(['Desk panel', 'Desk panel #2']);
    const second = (await h.api.instances()).find((i) => i.packageId === 'panel' && i.id !== first.id)!;
    expect((await h.api.run({ kind: 'remove', instanceId: second.id })).op.state).toBe('succeeded');
    expect([...pub.current.keys()]).toEqual([`${first.id}/stream`]);
  });

  it('stop withdraws it and says why; start announces it again', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: first.id })).op.state).toBe('succeeded');
    expect(pub.current.size).toBe(0);
    expect((await summary(first.id)).announce).toEqual([{ endpointId: 'stream', type: '_desk-panel._tcp', name: 'Desk panel', state: 'off', reason: 'the app is not running' }]);
    const started = await h.api.run({ kind: "start", instanceId: first.id });
    expect(started.op.state, JSON.stringify(started.op.error)).toBe("succeeded");
    expect([...pub.current.keys()]).toEqual([`${first.id}/stream`]);
  });

  it('remove withdraws it', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: first.id })).op.state).toBe('succeeded');
    expect(pub.current.size).toBe(0);
  });
});
