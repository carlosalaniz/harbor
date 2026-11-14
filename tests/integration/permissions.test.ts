// Decision 163: fixed UDP ports and the permissions a VPN server needs. The operator accepts the permissions
// when approving; nothing that submits on its own (update-all, auto-update) can accept them.
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceSummary, PackageImportResultDto, PlanDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { BROWSER_SANDBOX_PROFILE } from '../../src/planner/seccomp.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

// a UDP port nothing listens on (outside Harbor's small test app range)
async function freeUdpPort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '0.0.0.0', () => r()));
  const port = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const manifest = (id: string, rev: string, hostPort: number, perms: string[]) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: Tunnel ${id}
  description: A VPN server
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
ports:
  tunnel:
    service: web
    containerPort: 51820
    hostPort: ${hostPort}
    protocol: udp
    purpose: VPN tunnels
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
const upload = (id: string, rev: string, hostPort: number, perms: string[]) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev, hostPort, perms), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const submit = (planId: string, body: Record<string, unknown> = {}) => h.api.json<{ operationId: string; error?: { code: string; message: string } }>('POST', '/v1/operations', { planId, ...body }, { 'idempotency-key': `key-${Math.random().toString(36).slice(2, 12)}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;

describe('fixed UDP ports and permissions (decision 163)', () => {
  let port: number;
  let installed: InstanceSummary;
  it('the install plan lists the port and every permission in plain words', async () => {
    port = await freeUdpPort();
    await upload('tunnel', '1', port, ['net-admin']);
    const plan = await h.api.plan({ kind: 'install', packageId: 'tunnel' });
    expect(plan.ports).toEqual([{ id: 'tunnel', service: 'web', protocol: 'udp', hostPort: port, containerPort: 51820, purpose: 'VPN tunnels' }]);
    expect(plan.permissions.map((p) => [p.service, p.permission])).toEqual([['web', 'net-admin']]);
    expect(plan.permissions[0]!.label).toMatch(/network/i);
    expect(plan.changes.join('\n')).toContain(`UDP port ${port}`);
  });

  it('refuses the approval unless the permissions are accepted, and creates nothing', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'tunnel' });
    const r = await submit(plan.id);
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('PERMISSION_REQUIRED');
    expect(await byName(plan.name)).toBeUndefined();
    const ok = await submit(plan.id, { acceptPermissions: true });
    expect(ok.status).toBe(202);
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
    installed = await byName(plan.name);
    expect(installed.ports).toEqual([{ id: 'tunnel', service: 'web', protocol: 'udp', hostPort: port, containerPort: 51820, purpose: 'VPN tunnels' }]);
    const runtime = parseYaml(readFileSync(path.join(h.stateDir, 'instances', installed.id, 'runtime', 'compose.yaml'), 'utf8'));
    expect(runtime.services.web.cap_add).toEqual(['NET_ADMIN']);
    expect(runtime.services.web.ports).toContainEqual({ target: 51820, published: String(port), host_ip: '0.0.0.0', protocol: 'udp', mode: 'host' });
  });

  it('refuses a second app that wants the same port, and a port something else holds', async () => {
    await upload('tunnel-two', '1', port, ['tun']);
    await h.api.expectError(409, 'PORT_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'tunnel-two' });
    const held = await freeUdpPort();
    const sock: Socket = createSocket('udp4');
    await new Promise<void>((r) => sock.bind(held, '0.0.0.0', () => r()));
    try {
      await upload('tunnel-three', '1', held, ['tun']);
      const e = await h.api.expectError(409, 'PORT_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'tunnel-three' });
      expect(e.error.message).toContain(String(held));
    } finally {
      await new Promise<void>((r) => sock.close(() => r()));
    }
  });

  it('an update that adds a permission asks only for the new one and never applies by itself', async () => {
    await upload('tunnel', '2', port, ['net-admin', 'tun']);
    const plan: PlanDto = await h.api.plan({ kind: 'update', instanceId: installed.id });
    expect(plan.permissions.map((p) => p.permission)).toEqual(['tun']);
    const all = await h.api.expect<{ started: unknown[]; skipped: { name: string; reason: string }[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(all.started).toEqual([]);
    expect(all.skipped.find((s) => s.name === installed.name)?.reason).toMatch(/permission/i);
    const ok = await submit(plan.id, { acceptPermissions: true });
    const op = await h.api.waitOperation(ok.body.operationId);
    expect(op.state, JSON.stringify([op.error, op.events.slice(-4)])).toBe('succeeded');
    const runtime = parseYaml(readFileSync(path.join(h.stateDir, 'instances', installed.id, 'runtime', 'compose.yaml'), 'utf8'));
    expect(runtime.services.web.devices).toEqual(['/dev/net/tun:/dev/net/tun']);
  });

  it('an update with no new permission needs no acceptance', async () => {
    await upload('tunnel', '3', port, ['net-admin', 'tun']);
    const plan = await h.api.plan({ kind: 'update', instanceId: installed.id });
    expect(plan.permissions).toEqual([]);
    const ok = await submit(plan.id);
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
  });

  it('decision 165: an update that opens a new port needs the same explicit yes, and never applies by itself', async () => {
    const second = await freeUdpPort();
    const text = manifest('tunnel', '4', port, ['net-admin', 'tun']).replace('permissions:', `  extra:\n    service: web\n    containerPort: 51821\n    hostPort: ${second}\n    protocol: udp\n    purpose: Second tunnel\npermissions:`);
    await h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'tunnel.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': text, 'compose.yaml': COMPOSE }, { folder: 'tunnel' }).toString('base64')}` });
    const plan: PlanDto = await h.api.plan({ kind: 'update', instanceId: installed.id });
    expect(plan.permissions).toEqual([]);
    expect(plan.opensPorts).toEqual([second]);
    const all = await h.api.expect<{ started: unknown[]; skipped: { name: string; reason: string }[] }>(200, 'POST', '/v1/updates/apply-all', {});
    expect(all.started).toEqual([]);
    expect(all.skipped.find((s) => s.name === installed.name)?.reason).toContain(`open port ${second}`);
    const refused = await submit(plan.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('PERMISSION_REQUIRED');
    const ok = await submit(plan.id, { acceptPermissions: true });
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
  });
});

// Decision 201: browser-sandbox renders Harbor's seccomp profile; any source may ask, a person still accepts it
describe('browser-sandbox permission (decision 201)', () => {
  it('needs acceptance, then the runtime file points at the shipped profile and nothing else changes', async () => {
    const port = await freeUdpPort();
    await upload('sandboxed', '1', port, ['browser-sandbox']);
    const plan = await h.api.plan({ kind: 'install', packageId: 'sandboxed' });
    expect(plan.permissions.map((p) => [p.service, p.permission])).toEqual([['web', 'browser-sandbox']]);
    expect(plan.permissions[0]!.label).toMatch(/browser's own sandbox/);
    const refused = await submit(plan.id);
    expect(refused.body.error?.code).toBe('PERMISSION_REQUIRED');
    const ok = await submit(plan.id, { acceptPermissions: true });
    expect((await h.api.waitOperation(ok.body.operationId)).state).toBe('succeeded');
    const inst = await byName(plan.name);
    const runtime = parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8'));
    expect(runtime.services.web.security_opt).toEqual([`seccomp=${BROWSER_SANDBOX_PROFILE}`]);
    expect(runtime.services.web.cap_add).toBeUndefined();
    expect(runtime.services.web.privileged).toBeUndefined();
  });
});
