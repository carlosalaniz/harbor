// Decision 199: a generated secret the package marks revealable comes back on the app page, only after the Harbor password.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceDetail } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (id: string, flag: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Reveal ${id}
  description: A revealable secret test app
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
health:
  endpoint: web
  path: /healthz
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
secrets:
  - id: admin-password
    bytes: 32
    encoding: hex
    retention: retain
    showOnce: Admin password
${flag}    bindings:
      - {service: web, environment: ADMIN_PASSWORD}
  - id: other-key
    bytes: 32
    encoding: hex
    retention: retain
    showOnce: Other key
    bindings:
      - {service: web, environment: OTHER_KEY}
`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
async function install(id: string, flag: string): Promise<string> {
  const up = await h.api.json('POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, flag), 'compose.yaml': COMPOSE }).toString('base64')}` });
  expect(up.status).toBe(201);
  const { op } = await h.api.run({ kind: 'install', packageId: id });
  expect(op.state).toBe('succeeded');
  return op.instanceId!;
}
const reveal = (id: string, password = ADMIN.password) => h.api.json<{ secrets: { id: string; label: string; value: string }[] }>('POST', `/v1/instances/${id}/secrets/reveal`, { password });

describe('revealable generated secrets (decision 199)', () => {
  it('lists only the marked secret, returns its stored value after the Harbor password, and keeps the value out of the summary', async () => {
    const id = await install('marked', '    revealable: true\n');
    const detail = await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`);
    expect(detail.revealableSecrets).toEqual([{ id: 'admin-password', label: 'Admin password' }]);
    const r = await reveal(id);
    expect(r.status).toBe(200);
    const stored = readFileSync(path.join(h.stateDir, 'instances', id, 'secrets', 'admin-password'), 'utf8').trim();
    expect(r.body.secrets).toEqual([{ id: 'admin-password', label: 'Admin password', value: stored }]);
    expect(JSON.stringify(detail)).not.toContain(stored);
  });
  it('refuses a wrong Harbor password', async () => {
    const items = (await h.api.expect<{ items: { id: string; packageId: string }[] }>(200, 'GET', '/v1/instances')).items;
    const r = await reveal(items.find((i) => i.packageId === 'marked')!.id, 'not-the-password');
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toMatch(/[a-f0-9]{64}/);
  });
  it('a showOnce secret without the flag stays shown-once', async () => {
    const id = await install('unmarked', '');
    expect((await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`)).revealableSecrets).toEqual([]);
    expect((await reveal(id)).body.secrets).toEqual([]);
  });
});
