// Decisions 207–209 end to end with the fake engine: Access Guard (the allowed list, what root would load, the drop
// counters folded into the record across reloads, tags, location lookups, expiry, fail closed, the notification), an app
// that requires the VPN (refused without one, never direct) and an app that answers address lookups.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessGuardDto, GuardLookupDto, InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { FakeGuardProvider } from '../../src/guard/provider.js';
import { FakeGeo } from '../../src/guard/geo.js';
import { startHarness, type Harness } from './harness.js';
import { PROVIDER_CONF } from '../fixtures/wireguard.js';

const guard = new FakeGuardProvider();
const geo = new FakeGeo();
const asked: string[] = [];
let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    overrides: {
      guard,
      geo,
      resolver: async () => [],
      guardPollMs: 0,
      lookupFetch: async (url) => {
        asked.push(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              format: 1,
              ip: '192.0.2.140',
              results: [
                { source: 'abuseipdb', ok: true, abuseScore: 87, reports: 412, usage: 'Data Center', flags: ['tor', 'not-a-flag'], secret: 'dropped' },
                { source: 'ipinfo', ok: false, error: 'HTTP 429' },
                { source: '<bad source>', ok: true },
              ],
            }),
        };
      },
    },
  });
});
afterAll(async () => h.close());

const get = () => h.api.expect<AccessGuardDto>(200, 'GET', '/v1/access-guard');
const fail = (method: string, url: string, body?: unknown) => h.api.json<{ error: { code: string; message: string; nextAction?: string } }>(method, url, body);

describe('Access Guard (decision 207)', () => {
  it('starts off, with nothing loaded and nothing asked of root', async () => {
    const g = await get();
    expect(g).toMatchObject({ available: true, enabled: false, state: 'off', entries: [], blocked: [], totals: { addresses: 0, packets: 0, addresses24h: 0 } });
    expect(g.exempt).toEqual(expect.arrayContaining(['192.168.0.0/16', '100.64.0.0/10', 'fc00::/7', 'tailscale0']));
    expect(g.geo.attribution.text).toBe('IP Geolocation by DB-IP');
    expect(guard.calls).toEqual([]);
  });

  it('on with an empty list: root gets an empty list (nobody from the internet gets in)', async () => {
    const g = await h.api.expect<AccessGuardDto>(200, 'PUT', '/v1/access-guard/enabled', { enabled: true });
    expect(g).toMatchObject({ enabled: true, state: 'on' });
    expect(guard.state).toEqual({ format: 1, allow: [], own: [] });
  });

  it('entries are parsed, normalised and loaded; bad ones are refused with a reason', async () => {
    await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/entries', { address: '203.0.113.24', label: 'Home fibre', tags: ['home', 'family'] });
    const g = await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/entries', { address: '2001:DB8:4A10:0:0:0:0:1/64', label: 'Home IPv6' });
    expect(g.entries.map((e) => [e.address, e.family, e.label, e.tags])).toEqual([
      ['203.0.113.24', 4, 'Home fibre', ['home', 'family']],
      ['2001:db8:4a10::/64', 6, 'Home IPv6', []],
    ]);
    expect(guard.state?.allow).toEqual(['2001:db8:4a10::/64', '203.0.113.24/32']);
    const cases: [unknown, RegExp][] = [
      [{ address: 'not-an-ip' }, /./],
      [{ address: '203.0.113.24' }, /on the list already/],
      [{ address: '0.0.0.0/0' }, /too wide/],
      [{ address: '192.168.1.10' }, /own network or the tailnet/],
      [{ address: '100.101.102.103' }, /own network or the tailnet/],
      [{ address: '198.51.100.1', tags: ['ok', '<script>'] }, /not allowed/],
      [{ address: '198.51.100.1', expiresAt: '2001-01-01T00:00:00Z' }, /in the past/],
    ];
    for (const [body, msg] of cases) {
      const r = await fail('POST', '/v1/access-guard/entries', body);
      expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(r.body.error.message).toMatch(msg);
    }
    expect((await get()).entries).toHaveLength(2);
  });

  it('dropped packets are counted per address and survive a reload of the table', async () => {
    guard.drop('192.0.2.140', 40);
    guard.drop('2001:db8:9f::23', 3);
    let g = await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/check', {});
    expect(g.blocked.map((b) => [b.address, b.packets, b.family])).toEqual([
      ['192.0.2.140', 40, 4],
      ['2001:db8:9f::23', 3, 6],
    ]);
    // a change reloads the table (the kernel's counters start again): what it counted is read first
    guard.drop('192.0.2.140', 5);
    await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/entries', { address: '198.51.100.77', label: 'Office' });
    guard.drop('192.0.2.140', 2);
    g = await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/check', {});
    expect(g.blocked.find((b) => b.address === '192.0.2.140')?.packets).toBe(47);
    expect(g.totals).toEqual({ addresses: 2, packets: 50, addresses24h: 2 });
    // the record lives in its own file (no schema change)
    const book = JSON.parse(readFileSync(path.join(h.stateDir, 'guard', 'addresses.json'), 'utf8')) as { format: number };
    expect(book.format).toBe(1);
  });

  it('an address dropped earlier and allowed later shows as allowed', async () => {
    await h.api.expect(200, 'POST', '/v1/access-guard/entries', { address: '2001:db8:9f::/48' });
    expect((await get()).blocked.find((b) => b.address === '2001:db8:9f::23')?.allowed).toBe(true);
  });

  it('tags go on any address; location comes from the local database', async () => {
    let g = await h.api.expect<AccessGuardDto>(200, 'PUT', '/v1/access-guard/tags', { address: '192.0.2.140', tags: ['scanner'] });
    expect(g.blocked.find((b) => b.address === '192.0.2.140')?.tags).toEqual(['scanner']);
    g = await h.api.expect<AccessGuardDto>(200, 'PUT', '/v1/access-guard/tags', { address: '203.0.113.201', tags: ['me on mobile?'] });
    expect(g.blocked.find((b) => b.address === '203.0.113.201')).toMatchObject({ packets: 0, tags: ['me on mobile?'] });
    const r = await h.api.expect<GuardLookupDto>(200, 'POST', '/v1/access-guard/lookup', { address: '192.0.2.140' });
    expect(r).toEqual({ address: '192.0.2.140', geo: { country: 'NL', countryName: 'Netherlands', asn: 'AS64500', org: 'Example Hosting' }, online: null });
    expect((await get()).blocked.find((b) => b.address === '192.0.2.140')?.geo?.country).toBe('NL');
    expect((await fail('POST', '/v1/access-guard/lookup', { address: '192.168.1.5' })).body.error.message).toMatch(/own network/);
    expect((await fail('POST', '/v1/access-guard/lookup', { address: '192.0.2.140', online: true })).body.error.message).toBe('no running app answers address lookups');
  });

  it('a busy untagged address is notified once; tagged addresses never', async () => {
    guard.drop('198.51.100.9', 400);
    guard.drop('192.0.2.140', 900); // tagged "scanner"
    await h.api.expect(200, 'POST', '/v1/access-guard/check', {});
    const items = (await h.api.expect<{ items: { kind: string; title: string; body: string }[] }>(200, 'GET', '/v1/notifications')).items.filter((n) => n.kind === 'guard-busy');
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('198.51.100.9 keeps trying to reach your public apps');
    await h.api.expect(200, 'POST', '/v1/access-guard/check', {});
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'guard-busy')).toBe(false);
  });

  it('an expiring entry is announced, and an expired one leaves the loaded list at the next check', async () => {
    const g0 = await get();
    const office = g0.entries.find((e) => e.label === 'Office')!;
    await h.api.expect(200, 'PATCH', `/v1/access-guard/entries/${office.id}`, { expiresAt: new Date(Date.now() + 1500).toISOString() });
    expect(guard.state?.allow).toContain('198.51.100.77/32');
    await h.api.expect(200, 'POST', '/v1/access-guard/check', {});
    expect((await h.api.expect<{ items: { kind: string; title: string }[] }>(200, 'GET', '/v1/notifications')).items.find((n) => n.kind === 'guard-expiring')?.title).toBe('Office stops being allowed soon');
    await new Promise((r) => setTimeout(r, 1600));
    expect((await get()).entries.find((e) => e.id === office.id)?.expired).toBe(true);
    const g = await h.api.expect<AccessGuardDto>(200, 'POST', '/v1/access-guard/check', {});
    expect(g.entries.some((e) => e.id === office.id)).toBe(false);
    expect(guard.state?.allow).not.toContain('198.51.100.77/32');
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'guard-expiring')).toBe(false);
  });

  it('a label or tag change touches nothing in the kernel', async () => {
    const before = guard.calls.length;
    const home = (await get()).entries.find((e) => e.label === 'Home fibre')!;
    const g = await h.api.expect<AccessGuardDto>(200, 'PATCH', `/v1/access-guard/entries/${home.id}`, { label: 'Home', tags: ['home'] });
    expect(g.entries.find((e) => e.id === home.id)).toMatchObject({ label: 'Home', tags: ['home'] });
    expect(guard.calls.length).toBe(before);
  });

  it('fails closed: a change root cannot load leaves the list and the switch as they were', async () => {
    guard.failWith = 'nft: syntax error';
    const r = await fail('POST', '/v1/access-guard/entries', { address: '198.51.100.200' });
    expect(r.status).toBe(500);
    expect(r.body.error.message).toBe('nft: syntax error');
    let g = await get();
    expect(g.entries.some((e) => e.address === '198.51.100.200')).toBe(false);
    expect(g).toMatchObject({ enabled: true, state: 'failed', message: 'nft: syntax error' });
    expect((await fail('PUT', '/v1/access-guard/enabled', { enabled: false })).status).toBe(500);
    expect((await get()).enabled).toBe(true);
    guard.failWith = null;
    g = await h.api.expect<AccessGuardDto>(200, 'PUT', '/v1/access-guard/enabled', { enabled: false });
    expect(g).toMatchObject({ enabled: false, state: 'off', message: null });
    expect(guard.state).toBeNull();
    // the list stays for the next time
    expect(g.entries.length).toBe(3);
  });

  it('entries can be removed while off without asking root', async () => {
    const before = guard.calls.length;
    const v6 = (await get()).entries.find((e) => e.address === '2001:db8:9f::/48')!;
    await h.api.expect(200, 'DELETE', `/v1/access-guard/entries/${v6.id}`);
    expect(guard.calls.length).toBe(before);
    expect((await fail('DELETE', `/v1/access-guard/entries/${v6.id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------- decisions 208 and 209

const manifest = (id: string, extra: string) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: App ${id}
  description: Looks addresses up
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
    containerPort: 8080
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
${extra}`;
const upload = (id: string, extra: string) =>
  h.api.json<PackageImportResultDto & { error?: { message: string } }>('POST', '/v1/packages', { fileName: `${id}.zip`, dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': manifest(id, extra), 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: id }).toString('base64')}` });

describe('an app that requires the VPN (decision 208) and answers lookups (decision 209)', () => {
  let app: InstanceSummary;

  it('the format refuses requireVpn with internet: direct, and a lookup on an unknown endpoint', async () => {
    const a = await upload('bad-vpn', 'network:\n  internet: direct\n  requireVpn: true\n');
    expect(a.status).toBe(422);
    expect(JSON.stringify(a.body)).toMatch(/requireVpn: true cannot be combined with network.internet: direct/);
    const b = await upload('bad-lookup', 'provides:\n  ipLookup:\n    endpoint: api\n    path: /v1/lookup\n');
    expect(b.status).toBe(422);
    expect(JSON.stringify(b.body)).toMatch(/provides.ipLookup.endpoint references unknown endpoint api/);
  });

  it('is refused while no VPN is set up, and never offered direct', async () => {
    expect((await upload('lookup', 'network:\n  requireVpn: true\nprovides:\n  ipLookup:\n    endpoint: web\n    path: /v1/lookup\n')).status).toBe(201);
    const store = await h.api.expect<{ items: { id: string; internet?: string; requireVpn?: boolean }[] }>(200, 'GET', '/v1/catalog');
    expect(store.items.find((i) => i.id === 'lookup')).toMatchObject({ internet: 'vpn', requireVpn: true });
    const none = await fail('POST', '/v1/plans', { kind: 'install', packageId: 'lookup' });
    expect(none.status).toBe(422);
    expect(none.body.error.message).toBe('lookup only reaches the internet through a VPN, and none is set up');
    expect(none.body.error.nextAction).toBe('Add your VPN in Settings → VPN first, then install it again.');
    await h.api.expect(200, 'PUT', '/v1/vpn', { config: PROVIDER_CONF, name: 'Test VPN' });
    const direct = await fail('POST', '/v1/plans', { kind: 'install', packageId: 'lookup', internet: 'direct' });
    expect(direct.body.error.message).toBe('lookup may only reach the internet through the VPN; it cannot go direct');
    const { plan, op } = await h.api.run({ kind: 'install', packageId: 'lookup' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(plan.internet).toMatchObject({ to: 'vpn', choice: null, packageDefault: 'vpn', vpnReady: true });
    app = (await h.api.instances()).find((i) => i.name === plan.name)!;
    expect(app.internet).toEqual({ mode: 'vpn', choice: null, packageDefault: 'vpn', allApps: false, requireVpn: true });
    const conf = await fail('POST', '/v1/plans', { kind: 'configure', instanceId: app.id, internet: 'direct' });
    expect(conf.body.error.message).toBe(`${app.name} may only reach the internet through the VPN; it cannot go direct`);
    // offline: nothing leaves, so that is allowed
    expect((await h.api.plan({ kind: 'configure', instanceId: app.id, internet: 'offline' })).internet).toMatchObject({ to: 'offline' });
  });

  it('Harbor asks it on loopback and keeps only the fields it knows', async () => {
    const g = await get();
    expect(g.lookupApps).toEqual([{ instanceId: app.id, name: app.name, running: true }]);
    const r = await h.api.expect<GuardLookupDto>(200, 'POST', '/v1/access-guard/lookup', { address: '192.0.2.140', online: true });
    const port = app.endpoints.find((e) => e.id === 'web')!.hostPort;
    expect(asked).toEqual([`http://127.0.0.1:${port}/v1/lookup?ip=192.0.2.140`]);
    expect(r.online).toMatchObject({ instanceId: app.id, app: app.name, note: null });
    expect(r.online!.results).toEqual([
      { source: 'abuseipdb', ok: true, abuseScore: 87, reports: 412, usage: 'Data Center', flags: ['tor'] },
      { source: 'ipinfo', ok: false, error: 'HTTP 429' },
    ]);
    // kept with the address
    expect((await get()).blocked.find((b) => b.address === '192.0.2.140')?.online?.results[0]?.abuseScore).toBe(87);
  });
});
