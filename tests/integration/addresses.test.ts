// Decision 116: every app reachable on LAN, LAN HTTPS, the tailnet and a domain at once. A package
// `afterStart` hook receives the app's current addresses after start / restart / publish / unpublish;
// "this network" resolves to the secure LAN address when LAN HTTPS is on; Restart re-renders and
// recreates; apps that need HTTPS get an HTTPS main address in LAN mode or are refused up front.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AddressOptionsDto, CatalogItemDto, InstanceSummary, NetworkHttpsDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';

const HOOK = `hooks:
  afterStart:
    service: web
    user: www-data
    command: [sh, -c, "echo configured"]
`;

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('app addresses: hook, restart, HTTPS main address', () => {
  let h: Harness;
  let app: InstanceSummary;
  const env = (inst: InstanceSummary) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8')).services.web.environment as Record<string, string>;
  const lastExec = () => h.fake.execs[h.fake.execs.length - 1]!;

  beforeAll(async () => {
    // LAN mode on; low app ports so hostPort + the secure offset stays below 65535.
    h = await startHarness({ portRange: { from: 18200, to: 18240 }, config: { lan: { enabled: true, port: 18997 } } });
    // Like Nextcloud: keeps a host list (hook) and embeds its main address (configuration).
    writePackage(h.catalogDir, 'hostapp', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: hostapp').replace('browserContext: secure', 'browserContext: ordinary') + 'configuration:\n  - {service: web, environment: PUBLIC_URL, endpoint: web}\n' + HOOK,
      compose: `services:\n  web:\n    image: example/hostapp@${DIGEST_A}\n`,
      images: { web: `example/hostapp@${DIGEST_A}` },
    });
    // Needs a secure browser context (like Vaultwarden).
    writePackage(h.catalogDir, 'secureapp', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: secureapp').replace('browserContext: secure', 'browserContext: secure\n    httpsRequired: true'),
      compose: `services:\n  web:\n    image: example/secureapp@${DIGEST_A}\n`,
      images: { web: `example/secureapp@${DIGEST_A}` },
    });
  });
  afterAll(async () => h.close());

  it('runs the after-start hook with every LAN address, the network gateway and the main URL', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'hostapp' });
    expect(r.op.state).toBe('succeeded');
    app = (await h.api.instances()).find((i) => i.packageId === 'hostapp')!;
    const port = app.endpoints[0]!.hostPort;
    const x = lastExec();
    expect(x.user).toBe('www-data');
    expect(x.cmd).toEqual(['sh', '-c', 'echo configured']);
    const addrs = x.env['HARBOR_ADDRESSES']!.split(' ');
    expect(addrs).toContain(`localhost:${port}`);
    expect(addrs).toContain(new URL(app.endpoints[0]!.urls.lan!).host); // <hostname>.local:<port>
    expect(addrs).toContain(`harbor.local:${port}`);
    expect(x.env['HARBOR_PROXIES']).toMatch(/^172\.30\.\d+\.1$/); // the app network's gateway
    expect(x.env['HARBOR_URL']).toBe(app.endpoints[0]!.urls.lan);
    expect(r.op.events.map((e) => e.message)).toContain('after-start hook finished');
  });

  it('a failing hook is reported but the app still runs', async () => {
    h.fake.behaviour.failExec = 'occ: boom';
    const r = await h.api.run({ kind: 'restart', instanceId: app.id });
    h.fake.behaviour.failExec = null;
    expect(r.op.state).toBe('succeeded');
    expect(r.op.events.some((e) => /after-start hook failed \(exit 1\): occ: boom/.test(e.message))).toBe(true);
  });

  it('publishing on the tailnet re-runs the hook with the new address, without a restart', async () => {
    const before = h.fake.execs.length;
    const r = await h.api.run({ kind: 'expose', instanceId: app.id, via: 'tailnet' });
    expect(r.op.state).toBe('succeeded');
    expect(h.fake.execs.length).toBeGreaterThan(before);
    expect(lastExec().env['HARBOR_ADDRESSES']).toContain(new URL(r.plan.exposure!.url).host); // its own port (decision 133)
    const un = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'tailnet' });
    expect(un.op.state).toBe('succeeded');
    expect(lastExec().env['HARBOR_ADDRESSES']).not.toContain('tail1234');
  });

  it('your own proxy (decision 118): records the hostname, trusts only that proxy, runs nothing for it', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'expose', instanceId: app.id, via: 'proxy', hostname: 'cloud.example.com', proxyFrom: '127.0.0.1' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'expose', instanceId: app.id, via: 'proxy', hostname: 'cloud.example.com', proxyFrom: '192.168.0.20', makePrimary: true });
    const plan = await h.api.plan({ kind: 'expose', instanceId: app.id, via: 'proxy', hostname: 'cloud.example.com', proxyFrom: '192.168.0.20' });
    expect(plan.warnings.some((w) => new RegExp(`forward https://cloud\\.example\\.com/ to http://.+:${app.endpoints[0]!.hostPort}`).test(w))).toBe(true);
    const sub = await h.api.submit(plan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state).toBe('succeeded');
    expect(h.tailscale.entries).toEqual([]); // nothing published by Harbor itself
    const x = lastExec();
    expect(x.env['HARBOR_ADDRESSES']!.split(' ')).toContain('cloud.example.com');
    expect(x.env['HARBOR_PROXIES']!.split(' ')).toContain('192.168.0.20');
    const fresh = (await h.api.instances()).find((i) => i.id === app.id)!;
    expect(fresh.endpoints[0]!.urls.proxy).toBe('https://cloud.example.com/');
    expect(fresh.endpoints[0]!.primary).toBe('loopback');
    const un = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'proxy' });
    expect(un.op.state).toBe('succeeded');
    expect(lastExec().env['HARBOR_PROXIES']).not.toContain('192.168.0.20');
  });

  it('refuses an app that needs HTTPS on plain LAN, and the catalog says so first', async () => {
    const { items } = await h.api.expect<{ items: CatalogItemDto[] }>(200, 'GET', '/v1/catalog');
    expect(items.find((i) => i.id === 'secureapp')!.requiresHttps).toBe(true);
    expect(items.find((i) => i.id === 'hostapp')!.requiresHttps).toBe(false);
    const err = await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'install', packageId: 'secureapp' });
    expect(err.error.message).toMatch(/needs HTTPS/);
    expect(err.error.nextAction).toMatch(/Settings → Network/);
  });

  it('offers only the main addresses that exist, and installs with the tailnet as main address in one operation', async () => {
    const opts = await h.api.expect<AddressOptionsDto>(200, 'GET', '/v1/network/addresses');
    expect(opts.local.kind).toBe('http');
    expect(opts.tailnet).toEqual({ hostname: 'harbor-test.tail1234.ts.net' });
    const r = await h.api.run({ kind: 'install', packageId: 'secureapp', main: { via: 'tailnet' } });
    expect(r.plan.changes.some((c) => /Publish it at https:\/\/harbor-test\.tail1234\.ts\.net:\d+\/ and make that its main address/.test(c))).toBe(true);
    expect(r.op.state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'secureapp')!;
    expect(inst.endpoints[0]!.primary).toBe('tailnet');
    expect(inst.endpoints[0]!.urls.tailnet).toMatch(/^https:\/\/harbor-test\.tail1234\.ts\.net:\d+\/$/);
    expect(inst.endpoints[0]!.urls.tailnet).not.toContain(`:${inst.endpoints[0]!.hostPort}/`); // its own port (decision 133)
  });

  it('LAN HTTPS: main address becomes the secure one after Restart; the switch lists who restarts or breaks', async () => {
    if (!hasOpenssl()) {
      console.warn('openssl not installed: skipping the LAN HTTPS part');
      return;
    }
    const on = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true });
    expect(on.restartToApply).toContain('hostapp');
    expect(on.breaksWhenOff).toEqual([]); // secureapp has its tailnet address
    expect(env(app)['PUBLIC_URL']).toMatch(/^http:\/\//); // unchanged until Restart
    const r = await h.api.run({ kind: 'restart', instanceId: app.id });
    expect(r.op.state).toBe('succeeded');
    const fresh = (await h.api.instances()).find((i) => i.id === app.id)!;
    expect(env(fresh)['PUBLIC_URL']).toBe(fresh.endpoints[0]!.urls.lanSecure);
    expect(lastExec().env['HARBOR_URL']).toBe(fresh.endpoints[0]!.urls.lanSecure);
    expect(lastExec().env['HARBOR_ADDRESSES']).toContain(new URL(fresh.endpoints[0]!.urls.lanSecure!).host);
    expect(h.fake.log.some((l) => l.startsWith('up hb_') && l.endsWith(' --force-recreate'))).toBe(true);
    // With HTTPS on, a secure app may use "this network" as its main address.
    const plan = await h.api.plan({ kind: 'install', packageId: 'secureapp', name: 'secureapp-lan' });
    expect(plan.exposure).toBeUndefined();
    await h.api.expect(200, 'DELETE', `/v1/plans/${plan.id}`).catch(() => undefined);
    const off = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: false });
    expect(off.enabled).toBe(false);
  }, 60_000);

  it('restart is refused for a stopped app', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: app.id })).op.state).toBe('succeeded');
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'restart', instanceId: app.id });
  });
});
