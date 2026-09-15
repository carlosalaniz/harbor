import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, OperationDto, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (opts: { usernameEnv?: boolean; fixedUser?: string } = {}) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: paperlessish
  name: Paperlessish
  description: An app whose admin account Harbor provisions
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
provisionedCredentials:
  service: web
  passwordEnv: ADMIN_PASSWORD
${opts.usernameEnv ? '  usernameEnv: ADMIN_USER\n' : ''}${opts.fixedUser ? `  username: ${opts.fixedUser}\n` : ''}  note: Change it in the app afterwards if you like.
presentation:
  tagline: Provisioned admin
  category: developer
`;
const compose = `services:\n  web:\n    image: nginx:1.27-alpine\n`;
const upload = (m: string) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': m, 'compose.yaml': compose }).toString('base64')}` });

describe('provisioned admin credentials (decision 79)', () => {
  let inst: InstanceSummary;
  let shown: { username: string; password: string };

  it('install generates the credential, injects it via env and shows it once in the result', async () => {
    await upload(manifest({ usernameEnv: true }));
    const r = await h.api.run({ kind: 'install', packageId: 'paperlessish' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    shown = r.op.result?.['credentials'] as typeof shown;
    expect(shown).toBeTruthy();
    expect(shown.username).toBe('admin');
    expect(shown.password).toMatch(/^[a-f0-9]{64}$/);
    expect(r.op.result?.['credentialsNote']).toBe('Change it in the app afterwards if you like.');
    inst = (await h.api.instances()).find((i) => i.name === 'paperlessish')!;
    // the rendered compose carries the values
    const runtime = readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8');
    expect(runtime).toContain(`ADMIN_PASSWORD: "${shown.password}"`);
    expect(runtime).toContain('ADMIN_USER: "admin"');
    // never in DTOs or events
    const detail = await h.api.expect<{ events: { message: string }[]; defaultCredentials: unknown }>(200, 'GET', `/v1/instances/${inst.id}`);
    expect(JSON.stringify(detail)).not.toContain(shown.password);
    expect(detail.defaultCredentials).toBeNull();
  });

  it('the same credential survives remove + reinstall (retained secret)', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    const r = await h.api.run({ kind: 'reinstall', instanceId: inst.id });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    // reinstall does not show the credential again (it was shown once at install)
    expect(r.op.result?.['credentials']).toBeUndefined();
    const runtime = readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8');
    expect(runtime).toContain(`ADMIN_PASSWORD: "${shown.password}"`);
  });

  it('a manifest that provisions and also declares defaultCredentials is refused', async () => {
    const bad = manifest({ usernameEnv: true }) + 'defaultCredentials:\n  username: admin\n  password: fixed-FIXTURE\n';
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/packages', { fileName: 'bad.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': bad.replace('id: paperlessish', 'id: badapp'), 'compose.yaml': compose }).toString('base64')}` });
  });

  it('operation events never contain the generated password', async () => {
    const op = await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${inst.operationId}`);
    expect(JSON.stringify(op.events)).not.toContain(shown.password);
  });
});
