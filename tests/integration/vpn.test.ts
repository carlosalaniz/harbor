// Decision 184: VPN and offline apps end to end with the fake engine and the fake egress provider (what root would
// load). The package default, the operator's choice at install and later, the rules going in before an app starts
// (fail closed), the VPN routes (the private key never comes back or lands in Harbor's state), every app through the
// VPN, the kill-switch notification, remove/uninstall and an update that moves the default.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto, VpnDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { FakeEgressProvider } from '../../src/egress/provider.js';
import { OFFLINE_DNS_ADDRESS, VPN_DNS_ADDRESS, type EgressState } from '../../src/egress/rules.js';
import { parse as parseYaml } from 'yaml';
import { startHarness, type Harness } from './harness.js';
import { fixtureKey, PROVIDER_CONF } from '../fixtures/wireguard.js';

class RecordingEgress extends FakeEgressProvider {
  log: string[] | null = null;
  override async apply(state: EgressState) {
    this.log?.push(`egress apply ${state.apps.map((a) => `${a.instanceId}:${a.mode}`).join(',')}`);
    return super.apply(state);
  }
}

const egress = new RecordingEgress();
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { egress } });
  egress.log = h.fake.log;
});
afterAll(async () => h.close());

const manifest = (id: string, rev: string, internet: string | null) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: App ${id}
  description: A small web app
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
${internet ? `network:\n  internet: ${internet}\n` : ''}`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n';
const upload = (id: string, rev: string, internet: string | null) =>
  h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, rev, internet), 'compose.yaml': COMPOSE }, { folder: id }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name) as InstanceSummary;
const modes = () => Object.fromEntries((egress.state?.apps ?? []).map((a) => [a.instanceId, a.mode]));
const settingsDoc = (id: string) => {
  const f = path.join(h.stateDir, 'instances', id, 'settings.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { values: Record<string, unknown>; internet?: string }) : null;
};
const vpn = () => h.api.expect<VpnDto>(200, 'GET', '/v1/vpn');
// the resolver rendered into the app's runtime Compose file (null = Docker's default, as for every direct app)
const dnsOf = (id: string) => (parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8')) as { services: Record<string, { dns?: string[] }> }).services['web']!.dns ?? null;
async function waitQueue(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const q = await h.api.expect<{ active: unknown[] }>(200, 'GET', '/v1/operations');
    if (!q.active.length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the queue did not drain');
}
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(path.join(dir, d.name)) : d.isFile() ? [path.join(dir, d.name)] : []));
}

describe('VPN and offline apps (decision 184)', () => {
  let plain: InstanceSummary;
  let quiet: InstanceSummary;
  let tunneled: InstanceSummary;

  it('a direct app on a machine that never used any of it: no root step at all', async () => {
    await upload('plain', '1', null);
    const { plan, op } = await h.api.run({ kind: 'install', packageId: 'plain' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(plan.internet).toEqual({ from: null, to: 'direct', choice: null, packageDefault: 'direct', vpnReady: false });
    expect(plan.changes.some((c) => c.startsWith('Internet access'))).toBe(false);
    plain = await byName(plan.name);
    expect(plain.internet).toEqual({ mode: 'direct', choice: null, packageDefault: 'direct', allApps: false });
    expect(egress.calls).toEqual([]);
    expect(settingsDoc(plain.id)).toBeNull();
    expect((await vpn()).rules.state).toBe('none');
  });

  it('a package that asks to be offline: the plan says so, and its rules are loaded before it starts', async () => {
    await upload('quiet', '1', 'offline');
    const plan = await h.api.plan({ kind: 'install', packageId: 'quiet' });
    expect(plan.internet).toMatchObject({ to: 'offline', choice: null, packageDefault: 'offline' });
    expect(plan.changes).toContain('Internet access: Offline (the app\'s default); it can be reached, but opens no connection to the internet, your network or other apps');
    const mark = h.fake.log.length;
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    quiet = await byName(plan.name);
    const project = `hb_${quiet.id.replace(/-/g, '')}`;
    const lines = h.fake.log.slice(mark).filter((l) => l.startsWith(`up ${project}`) || l.startsWith('egress apply'));
    expect(lines).toEqual([`up ${project} --no-start`, `egress apply ${quiet.id}:offline`, `up ${project}`]);
    expect(egress.state?.apps).toEqual([{ instanceId: quiet.id, mode: 'offline', subnets: [expect.stringMatching(/^10\.20[0-7]\.\d+\.0\/24$/)] }]);
    expect(op.events.map((e) => e.message)).toContain(`${plan.name} is offline: it can be reached, but it opens no connection to the internet, your network or other apps`);
    expect(quiet.internet).toEqual({ mode: 'offline', choice: null, packageDefault: 'offline', allApps: false });
    expect(settingsDoc(quiet.id)).toBeNull(); // follows the package: nothing stored
  });

  it('the operator picks the VPN at install with no VPN set up: a warning, the choice is stored, the kill switch holds', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'plain', internet: 'vpn' });
    expect(plan.internet).toMatchObject({ to: 'vpn', choice: 'vpn', packageDefault: 'direct', vpnReady: false });
    expect(plan.warnings).toContain(`No VPN is set up: ${plan.name} has no internet until you add one in Settings → VPN.`);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    tunneled = await byName(plan.name);
    expect(settingsDoc(tunneled.id)).toEqual({ format: 1, values: {}, internet: 'vpn' });
    expect(statSync(path.join(h.stateDir, 'instances', tunneled.id, 'settings.json')).mode & 0o777).toBe(0o644);
    expect(modes()).toEqual({ [quiet.id]: 'offline', [tunneled.id]: 'vpn' });
    expect(tunneled.internet).toEqual({ mode: 'vpn', choice: 'vpn', packageDefault: 'direct', allApps: false });
    const v = await vpn();
    expect(v.tunnel).toBeNull();
    expect(v.status.state).toBe('off');
    expect(v.apps.map((a) => [a.name, a.mode])).toEqual(
      [
        [quiet.name, 'offline'],
        [tunneled.name, 'vpn'],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    expect(v.rules.state).toBe('ok');
  });

  it('picking the package\'s own default at install stores nothing', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'quiet', internet: 'offline' });
    expect(plan.internet).toMatchObject({ choice: null, to: 'offline' });
  });

  it('configure the internet of a running app: rules between create and start, its resolver re-rendered; "default" goes back', async () => {
    const project = `hb_${quiet.id.replace(/-/g, '')}`;
    expect(dnsOf(quiet.id)).toEqual([OFFLINE_DNS_ADDRESS]);
    const before = h.fake.log.length;
    const { plan, op } = await h.api.run({ kind: 'configure', instanceId: quiet.id, internet: 'direct' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(plan.changes).toEqual([`Internet access: Offline → Direct (your choice). ${quiet.name} restarts so its lookups follow too (same data, ports and addresses)`]);
    expect(plan.internet).toMatchObject({ from: 'offline', to: 'direct', choice: 'direct' });
    // leaving offline: the containers are created, the rules drop the app, then it starts without Harbor's resolver
    expect(h.fake.log.slice(before).filter((l) => l.startsWith(`up ${project}`) || l.startsWith('egress apply'))).toEqual([`up ${project} --no-start`, `egress apply ${tunneled.id}:vpn`, `up ${project}`]);
    expect(dnsOf(quiet.id)).toBeNull();
    expect(modes()).toEqual({ [tunneled.id]: 'vpn' });
    expect(settingsDoc(quiet.id)?.internet).toBe('direct');
    expect((await byName(quiet.name)).internet).toMatchObject({ mode: 'direct', choice: 'direct' });
    const same = await h.api.json<{ error: { message: string } }>('POST', '/v1/plans', { kind: 'configure', instanceId: quiet.id, internet: 'direct' });
    expect(same.status).toBe(422);
    expect(same.body.error.message).toBe('nothing to change: the app already uses that internet access');
    const back = await h.api.run({ kind: 'configure', instanceId: quiet.id, internet: 'default' });
    expect(back.op.state).toBe('succeeded');
    expect(back.plan.changes[0]).toBe(`Internet access: Direct → Offline (the app's default). ${quiet.name} restarts so its lookups follow too (same data, ports and addresses)`);
    expect(settingsDoc(quiet.id)).toBeNull();
    expect(dnsOf(quiet.id)).toEqual([OFFLINE_DNS_ADDRESS]);
    expect(modes()).toEqual({ [quiet.id]: 'offline', [tunneled.id]: 'vpn' });
    const bad = await h.api.json<{ error: { code: string } }>('POST', '/v1/plans', { kind: 'configure', instanceId: quiet.id, internet: 'tor' });
    expect(bad.status).toBe(422);
  });

  it('a stopped app only gets its rules; its next start re-creates it with the new resolver', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: plain.id })).op.state).toBe('succeeded');
    const cfg = await h.api.run({ kind: 'configure', instanceId: plain.id, internet: 'vpn' });
    expect(cfg.op.state, JSON.stringify(cfg.op.error)).toBe('succeeded');
    expect(cfg.plan.changes[0]).toBe(`Internet access: Direct → Through the VPN (your choice). It applies when ${plain.name} next starts`);
    expect((await byName(plain.name)).runtime).toBe('stopped');
    expect(dnsOf(plain.id)).toBeNull();
    expect(modes()[plain.id]).toBe('vpn');
    const start = await h.api.run({ kind: 'start', instanceId: plain.id });
    expect(start.op.state, JSON.stringify(start.op.error)).toBe('succeeded');
    expect(start.op.events.map((e) => e.message)).toContain(`${plain.name}'s internet access changed while it was stopped: re-creating its containers (same data and addresses)`);
    expect(dnsOf(plain.id)).toEqual([VPN_DNS_ADDRESS]);
    await h.api.run({ kind: 'configure', instanceId: plain.id, internet: 'default' });
    expect(dnsOf(plain.id)).toBeNull();
  });

  it('settings and the internet choice share settings.json without losing each other', async () => {
    const { op } = await h.api.run({ kind: 'configure', instanceId: plain.id, internet: 'offline' });
    expect(op.state).toBe('succeeded');
    expect(settingsDoc(plain.id)).toEqual({ format: 1, values: {}, internet: 'offline' });
    await h.api.run({ kind: 'configure', instanceId: plain.id, internet: 'default' });
    expect(settingsDoc(plain.id)).toBeNull();
  });

  it('setting the VPN: refused files say why; a good one comes back without its keys and is never stored by the daemon', async () => {
    const bad = await h.api.json<{ error: { code: string; message: string; nextAction: string } }>('PUT', '/v1/vpn', { config: PROVIDER_CONF.replace('DNS = 10.64.0.1', 'DNS = 10.64.0.1\nPostUp = curl evil') });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain('PostUp is not accepted');
    expect(egress.calls).not.toContain('tunnel-set');
    const v = await h.api.expect<VpnDto>(200, 'PUT', '/v1/vpn', { config: PROVIDER_CONF, name: 'Mullvad Stockholm' });
    expect(v.tunnel).toMatchObject({ name: 'Mullvad Stockholm', endpoint: '185.65.134.82:51820', addresses: ['10.66.12.34/32', 'fc00:bbbb:bbbb:bb01::3:c21/128'], dns: ['10.64.0.1'], dnsFallback: false, mtu: 1420, peerPublicKey: fixtureKey('wgSERVER') });
    expect(v.status.state).toBe('connected');
    expect(JSON.stringify(v)).not.toContain(fixtureKey('wgPRIVATE'));
    // the rules were loaded again with the tunnel (its DNS is part of them)
    expect(egress.calls.slice(-2)).toEqual(['tunnel-set', 'apply']);
    for (const f of filesUnder(h.stateDir)) expect(readFileSync(f).includes(fixtureKey('wgPRIVATE')), f).toBe(false);
    const review = await h.api.plan({ kind: 'install', packageId: 'plain', internet: 'vpn' });
    expect(review.internet?.vpnReady).toBe(true);
    expect(review.warnings.some((w) => w.startsWith('No VPN is set up'))).toBe(false);
  });

  it('every app through the VPN: direct apps go through it, offline ones stay offline, and it comes back off', async () => {
    const on = await h.api.expect<VpnDto>(200, 'PUT', '/v1/vpn/all-apps', { enabled: true });
    expect(on.allApps).toBe(true);
    expect(modes()).toEqual({ [plain.id]: 'vpn', [quiet.id]: 'offline', [tunneled.id]: 'vpn' });
    expect((await byName(plain.name)).internet).toEqual({ mode: 'vpn', choice: null, packageDefault: 'direct', allApps: true });
    const plan = await h.api.plan({ kind: 'install', packageId: 'plain' });
    expect(plan.internet).toMatchObject({ to: 'vpn', choice: null });
    expect(plan.changes.some((c) => c.startsWith('Internet access: Through the VPN (every app goes through the VPN)'))).toBe(true);
    // the running app that moved is restarted by Harbor (actor vpn-policy) so its resolver follows
    await waitQueue();
    const restarts = (await h.api.expect<{ recent: { kind: string; actor: string; instanceId: string; state: string }[] }>(200, 'GET', '/v1/operations')).recent.filter((o) => o.actor === 'vpn-policy');
    expect(restarts.map((o) => [o.kind, o.instanceId, o.state])).toEqual([['restart', plain.id, 'succeeded']]);
    expect(dnsOf(plain.id)).toEqual([VPN_DNS_ADDRESS]);
    const off = await h.api.expect<VpnDto>(200, 'PUT', '/v1/vpn/all-apps', { enabled: false });
    expect(off.allApps).toBe(false);
    expect(modes()).toEqual({ [quiet.id]: 'offline', [tunneled.id]: 'vpn' });
    await waitQueue();
    expect(dnsOf(plain.id)).toBeNull();
  });

  it('the tunnel stops answering: a notification while an app needs it, gone once it is back', async () => {
    const svc = h.daemon.ctx.egress!;
    const t0 = Date.now();
    svc.observe(t0);
    egress.connected = false;
    svc.observe(t0 + 60_000);
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'vpn-down')).toBe(false);
    svc.observe(t0 + 6 * 60_000);
    const down = (await h.api.expect<{ items: { kind: string; title: string; body: string }[] }>(200, 'GET', '/v1/notifications')).items.find((n) => n.kind === 'vpn-down');
    expect(down?.title).toBe('The VPN is not connected');
    expect(down?.body).toBe(`${tunneled.name} goes through the VPN and has no internet until it is back. Check Settings → VPN.`);
    egress.connected = true;
    svc.observe(t0 + 7 * 60_000);
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'vpn-down')).toBe(false);
  });

  it('fail closed: when the rules cannot be loaded, the app does not start and a choice is put back', async () => {
    egress.failWith = 'nft: could not process rule';
    const plan = await h.api.plan({ kind: 'install', packageId: 'quiet' });
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('failed');
    expect(op.error?.message).toContain('nft: could not process rule');
    const project = `hb_${plan.instanceId.replace(/-/g, '')}`;
    expect((await h.fake.listContainers({ all: true, labels: { 'com.docker.compose.project': project } })).filter((c) => c.state === 'running')).toEqual([]);
    const cfg = await h.api.run({ kind: 'configure', instanceId: plain.id, internet: 'offline' });
    expect(cfg.op.state).toBe('failed');
    expect(settingsDoc(plain.id)).toBeNull();
    expect((await byName(plain.name)).internet.mode).toBe('direct');
    const all = await h.api.json<{ error: { code: string; message: string } }>('PUT', '/v1/vpn/all-apps', { enabled: true });
    expect(all.body.error).toMatchObject({ code: 'OPERATION_FAILED', message: 'nft: could not process rule' });
    expect((await vpn()).allApps).toBe(false);
    expect((await vpn()).rules).toMatchObject({ state: 'failed', message: 'nft: could not process rule' });
    egress.failWith = null;
    await h.api.run({ kind: 'purge', instanceId: plan.instanceId });
  });

  it('the daemon loads the rules at startup; when that failed, a start loads them before any container runs', async () => {
    const stop = await h.api.run({ kind: 'stop', instanceId: quiet.id });
    expect(stop.op.state).toBe('succeeded');
    let before = egress.calls.length;
    await h.restart();
    egress.log = h.fake.log;
    expect(egress.calls.slice(before)).toEqual(['apply']);
    // a startup apply that fails leaves nothing marked as loaded
    egress.failWith = 'nft: busy';
    await h.restart();
    egress.log = h.fake.log;
    egress.failWith = null;
    before = egress.calls.length;
    const mark = h.fake.log.length;
    const start = await h.api.run({ kind: 'start', instanceId: quiet.id });
    expect(start.op.state, JSON.stringify(start.op.error)).toBe('succeeded');
    expect(egress.calls.slice(before)).toEqual(['apply']);
    const project = `hb_${quiet.id.replace(/-/g, '')}`;
    const seq = h.fake.log.slice(mark).filter((l) => l.startsWith('egress apply') || l.startsWith(`start ${project}`));
    expect(seq[0]).toMatch(/^egress apply /);
    expect(seq.length).toBeGreaterThan(1);
  });

  it('an update that changes the package default moves an app that follows it, not one with a choice', async () => {
    await upload('quiet', '2', 'vpn');
    const plan = await h.api.plan({ kind: 'update', instanceId: quiet.id });
    expect(plan.internet).toMatchObject({ from: 'offline', to: 'vpn', choice: null, packageDefault: 'vpn' });
    expect(plan.changes).toContain('Internet access: Offline → Through the VPN, the new release\'s default (you have not chosen one for this app; change it in its drawer)');
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(modes()[quiet.id]).toBe('vpn');
    expect((await byName(quiet.name)).internet).toMatchObject({ mode: 'vpn', packageDefault: 'vpn', choice: null });
    expect(dnsOf(quiet.id)).toEqual([VPN_DNS_ADDRESS]);
  });

  it('remove and uninstall drop the app from the rules; removing the VPN keeps the kill switch for the rest', async () => {
    const rm = await h.api.run({ kind: 'remove', instanceId: tunneled.id });
    expect(rm.op.state).toBe('succeeded');
    expect(modes()[tunneled.id]).toBeUndefined();
    // removed with its data kept: its choice stays (Reinstall brings it back) but the VPN page does not list it
    expect(settingsDoc(tunneled.id)?.internet).toBe('vpn');
    expect((await vpn()).apps.map((a) => a.instanceId)).not.toContain(tunneled.id);
    const purge = await h.api.run({ kind: 'purge', instanceId: quiet.id });
    expect(purge.op.state).toBe('succeeded');
    expect(modes()).toEqual({});
    const gone = await h.api.expect<VpnDto>(200, 'DELETE', '/v1/vpn');
    expect(gone.tunnel).toBeNull();
    expect(gone.status.state).toBe('off');
    expect(egress.tunnel).toBeNull();
  });
});
