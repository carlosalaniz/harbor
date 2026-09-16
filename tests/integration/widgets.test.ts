import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, WidgetDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (id: string, widget: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: widget test app
release:
  revision: "1"
  version: "0.1.0"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 3000
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
  tagline: Widget demo
  category: developer
${widget}`;
const COMPOSE = `services:
  web:
    image: nginx:1.27-alpine
`;
const WIDGET = `  widget:
    endpoint: web
    path: /api/stats
    kind: metrics
`;
const upload = (id: string, widgetYaml: string) =>
  h.api.expect<{ item: { id: string } }>(201, 'POST', '/v1/packages', {
    fileName: `${id}.zip`,
    dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, widgetYaml), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}`,
  });
const install = async (packageId: string): Promise<InstanceSummary> => {
  const r = await h.api.run({ kind: 'install', packageId });
  expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
  return (await h.api.instances()).find((i: InstanceSummary) => i.packageId === packageId)!;
};
const widgetOf = (id: string) => h.api.expect<WidgetDto | null>(200, 'GET', `/v1/instances/${id}/widget`);

// Widgets: the daemon proxies the app's JSON (decision 81). Malformed data hides the widget.
describe('home widgets', () => {
  it('proxies metrics JSON from the app', async () => {
    await upload('widgetapp', WIDGET);
    const inst = await install('widgetapp');
    h.fake.behaviour.respond = (_svc, path) =>
      path === '/api/stats' ? { status: 200, body: JSON.stringify({ items: [{ label: 'Notes', value: 42 }, { label: 'Size', value: '3', unit: 'MB' }] }) } : 200;
    try {
      expect(await widgetOf(inst.id)).toEqual({ kind: 'metrics', items: [{ label: 'Notes', value: '42' }, { label: 'Size', value: '3', unit: 'MB' }] });
    } finally {
      delete h.fake.behaviour.respond;
    }
  });

  it('hides malformed widget data (null, never an error)', async () => {
    await upload('widgetbad', WIDGET);
    const inst = await install('widgetbad');
    h.fake.behaviour.respond = (_svc, path) => (path === '/api/stats' ? { status: 200, body: JSON.stringify({ items: 'not-an-array' }) } : 200);
    try {
      expect(await widgetOf(inst.id)).toBeNull();
    } finally {
      delete h.fake.behaviour.respond;
    }
  });

  it('rejects widget declarations that break the contract', async () => {
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/packages', {
      fileName: 'bad.zip',
      dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest('badwidget', WIDGET.replace('path: /api/stats', 'path: nope')), 'compose.yaml': COMPOSE }, { folder: 'badwidget' }).toString('base64')}`,
    });
  });

  it('returns null for apps without a widget', async () => {
    await upload('plainapp', '');
    const inst = await install('plainapp');
    expect(await widgetOf(inst.id)).toBeNull();
  });
});
