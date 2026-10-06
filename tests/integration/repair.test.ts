import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExposureDto, InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { NOT_ENCRYPTED_WARNING } from '../../src/lifecycle/service.js';
import { startHarness, type Harness } from './harness.js';

// Decisions 131–135 (0.23.0): addresses survive remove/reinstall, broken apps have a way out,
// a failed start leaves no half-created containers, installs say plainly when they are not encrypted,
// helpers can be hidden from Home.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const manifest = (rev: string, hide = false) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: fixer
  name: Fixer
  description: A tiny web page
release:
  revision: "${rev}"
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
${hide ? 'presentation:\n  hideFromHome: true\n' : ''}`;
const compose = (image: string) => `services:\n  web:\n    image: ${image}\n`;
const upload = (files: Record<string, string>, fileName = 'fixer.zip') => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName, dataUrl: `data:application/zip;base64,${writeZip(files, { folder: 'fixer' }).toString('base64')}` });
const byId = async (id: string) => (await h.api.instances()).find((i) => i.id === id)!;
const exposures = async () => (await h.api.expect<{ items: ExposureDto[] }>(200, 'GET', '/v1/exposures')).items;

describe('0.23.0 repair paths', () => {
  let inst: InstanceSummary;

  it('an install without a location says it is not encrypted; a package may suggest hiding it from Home', async () => {
    await upload({ 'manifest.yaml': manifest('1', true), 'compose.yaml': compose('nginx:1.27-alpine') });
    const r = await h.api.run({ kind: 'install', packageId: 'fixer' });
    expect(r.plan.warnings).toContain(NOT_ENCRYPTED_WARNING);
    expect(r.op.state).toBe('succeeded');
    inst = await byId(r.op.instanceId);
    expect(inst.home).toBeNull();
    expect(inst.hiddenFromHome).toBe(true); // the package's suggestion
    const shown = await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${inst.id}/appearance`, { hidden: false });
    expect(shown.hiddenFromHome).toBe(false); // the operator's choice wins
    expect((await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${inst.id}/appearance`, { hidden: true })).hiddenFromHome).toBe(true);
    expect((await byId(inst.id)).hiddenFromHome).toBe(true);
  });

  it('remove withdraws the addresses but keeps them; reinstall publishes them again, main address included', async () => {
    expect((await h.api.run({ kind: 'expose', instanceId: inst.id, via: 'public', hostname: 'fix.example.com', makePrimary: true })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'expose', instanceId: inst.id, via: 'tailnet' })).op.state).toBe('succeeded');
    const rm = await h.api.run({ kind: 'remove', instanceId: inst.id });
    expect(rm.plan.changes.some((c) => /Withdraw https:\/\/fix\.example\.com\/ for now.*Reinstall publishes it again/.test(c))).toBe(true);
    expect(rm.op.state).toBe('succeeded');
    expect(await exposures()).toEqual([]);
    expect(h.caddy.routes()).toEqual([]);
    expect(h.tailscale.entries).toEqual([]);
    const re = await h.api.plan({ kind: 'reinstall', instanceId: inst.id });
    expect(re.changes).toContain('Publish https://fix.example.com/ again');
    expect(re.changes.some((c) => /tail1234\.ts\.net.*again \(on a fresh tailnet port\)/.test(c))).toBe(true);
    const op = await h.api.waitOperation((await h.api.submit(re.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const back = await exposures();
    expect(back.map((e) => e.via).sort()).toEqual(['public', 'tailnet']);
    expect(h.caddy.routes()).toEqual(['fix.example.com']);
    expect(h.tailscale.entries).toHaveLength(1);
    inst = await byId(inst.id);
    expect(inst.endpoints[0]!.primary).toBe('public');
    expect(inst.endpoints[0]!.urls.public).toBe('https://fix.example.com/');
  });

  it('on a removed app, unexpose forgets a kept address instead of refusing; purge forgets the rest', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    const forget = await h.api.run({ kind: 'unexpose', instanceId: inst.id, via: 'tailnet' });
    expect(forget.plan.changes[0]).toMatch(/^Forget https:\/\/harbor-test\.tail1234\.ts\.net:\d+\//);
    expect(forget.op.state).toBe('succeeded');
    const re = await h.api.plan({ kind: 'reinstall', instanceId: inst.id });
    expect(re.changes.filter((c) => c.startsWith('Publish '))).toEqual(['Publish https://fix.example.com/ again']);
    await h.api.expectError(404, 'NOT_FOUND', 'POST', '/v1/plans', { kind: 'unexpose', instanceId: inst.id, via: 'tailnet' });
    expect((await h.api.waitOperation((await h.api.submit(re.id)).operationId)).state).toBe('succeeded');
    expect((await exposures()).map((e) => e.via)).toEqual(['public']);
  });

  it('an update whose rollback also fails leaves needs_action: the address can still be withdrawn, and Repair brings the app back', async () => {
    await upload({ 'manifest.yaml': manifest('2'), 'compose.yaml': compose('nginx:alpine') }, 'fixer-2.zip');
    h.fake.behaviour.failUp = 'failed to bind host port for 0.0.0.0:18080: address already in use';
    const op = await h.api.waitOperation((await h.api.submit((await h.api.plan({ kind: 'update', instanceId: inst.id })).id)).operationId);
    expect(op.state).toBe('failed');
    expect(op.error?.message).toMatch(/rollback did not complete/);
    expect(op.error?.nextAction).toMatch(/harbor repair fixer/);
    inst = await byId(inst.id);
    expect(inst.installState).toBe('needs_action');
    // decision 135: the publishing that broke it is removable through Harbor
    const un = await h.api.run({ kind: 'unexpose', instanceId: inst.id, via: 'public', hostname: 'fix.example.com' });
    expect(un.op.state, JSON.stringify(un.op.error)).toBe('succeeded');
    expect(await exposures()).toEqual([]);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'expose', instanceId: inst.id, via: 'tailnet' });
    // Repair = restart from the stored release (the rollback put revision 1 back)
    h.fake.behaviour.failUp = null;
    const fix = await h.api.run({ kind: 'restart', instanceId: inst.id });
    expect(fix.plan.changes[0]).toMatch(/^Repair "fixer"/);
    expect(fix.op.state, JSON.stringify(fix.op.error)).toBe('succeeded');
    inst = await byId(inst.id);
    expect(inst).toMatchObject({ installState: 'installed', runtime: 'running', revision: '1' });
    expect(inst.endpoints[0]!.primary).toBe('loopback');
  });

  it('a running container with no network is not counted as running; a failed start removes such half-created containers', async () => {
    const c = [...h.fake.containers.values()].find((x) => x.labels['io.harbor.preview/instance'] === inst.id)!;
    const net = [...h.fake.networks.values()].find((n) => n.containerIds.includes(c.id))!;
    const detach = () => {
      c.networkIds = [];
      net.containerIds = net.containerIds.filter((x) => x !== c.id);
    };
    const waitRuntime = async (want: (r: string) => boolean) => {
      for (let i = 0; i < 40; i++) {
        const r = (await byId(inst.id)).runtime;
        if (want(r)) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      return (await byId(inst.id)).runtime;
    };
    // the shape seen live: the recreate left a container with no network that crash-loops
    detach();
    expect(await waitRuntime((r) => r !== 'running')).not.toBe('running');
    c.networkIds = [net.id];
    net.containerIds.push(c.id);
    expect(await waitRuntime((r) => r === 'running')).toBe('running');
    const plan = await h.api.plan({ kind: 'restart', instanceId: inst.id });
    detach();
    const before = h.fake.containers.size;
    h.fake.behaviour.failUp = 'failed to bind host port';
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    h.fake.behaviour.failUp = null;
    expect(op.state).not.toBe('succeeded');
    expect(h.fake.containers.size).toBe(before - 1);
    expect(op.events.some((e) => /removed half-created container .* \(no network\)/.test(e.message))).toBe(true);
  });
});

// Decision 136: port 80 taken by someone else is not "taken by Caddy".
describe('LAN console port owner', () => {
  it('says "another program" when Caddy does not answer, and "Caddy" when it does', async () => {
    const { createServer } = await import('node:net');
    const { freePort, startHarness: start } = await import('./harness.js');
    const { FakeCaddyAdmin } = await import('../../src/exposure/caddy.js');
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen({ port, host: '::' }, () => r()));
    const lines: string[] = [];
    const log = { debug: () => {}, info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) };
    try {
      for (const down of [true, false]) {
        const caddy = new FakeCaddyAdmin();
        caddy.down = down;
        const x = await start({ config: { lan: { enabled: true, port } }, overrides: { log, caddy } });
        await x.close();
      }
    } finally {
      squatter.close();
    }
    expect(lines.some((l) => l.startsWith('warn') && l.includes(`port ${port} is taken by another program`))).toBe(true);
    expect(lines.some((l) => l.startsWith('info') && l.includes(`port ${port} is taken by Harbor's public proxy (Caddy)`))).toBe(true);
  });
});
