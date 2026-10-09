// LAN HTTPS routes (decision 109): off by default, refuses without LAN,
// mints the local CA on enable (openssl), serves the cert openly, reports
// the secure address + fingerprint, and adds lanSecure to app endpoints.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstanceSummary, NetworkHttpsDto, SystemDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('LAN HTTPS (local CA + secure addresses)', () => {
  let h: Harness;
  beforeAll(async () => {
    // LAN on (port 80 would need root; the harness config takes any port).
    // App ports stay low so hostPort + the 20000 secure offset never
    // overflows 65535 (the harness otherwise picks random ephemeral ports).
    h = await startHarness({ portRange: { from: 18100, to: 18140 }, config: { lan: { enabled: true, port: 18998 } } });
    // A package that embeds its own address (like Nextcloud's OVERWRITEHOST).
    writePackage(h.catalogDir, 'urlapp', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: urlapp') + 'configuration:\n  - {service: web, environment: PUBLIC_URL, endpoint: web}\n',
      compose: `services:\n  web:\n    image: example/urlapp@${DIGEST_A}\n`,
      images: { web: `example/urlapp@${DIGEST_A}` },
    });
  });
  afterAll(async () => h.close());

  it('is off by default: no url, no fingerprint, no lanSecure on apps', async () => {
    const st = await h.api.expect<NetworkHttpsDto>(200, 'GET', '/v1/network/https');
    expect(st).toMatchObject({ enabled: false, url: null, fingerprint: null });
    const sys = await h.api.expect<SystemDto>(200, 'GET', '/v1/system');
    expect(sys.network.https.enabled).toBe(false);
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'excalidraw') as InstanceSummary;
    expect(inst.endpoints[0]!.urls.lan).toMatch(/^http:\/\//);
    expect(inst.endpoints[0]!.urls.lanSecure).toBeUndefined();
  });

  it('in LAN mode an app that embeds its address gets the LAN address, not localhost', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'urlapp' });
    expect(r.op.state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'urlapp') as InstanceSummary;
    const env = parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8')).services.web.environment as Record<string, string>;
    expect(inst.endpoints[0]!.urls.lan).toMatch(/^http:\/\/[a-z0-9-]+\.local:\d+\/$/);
    expect(env['PUBLIC_URL']).toBe(inst.endpoints[0]!.urls.lan);
  });

  it('refuses to enable when LAN mode is off', async () => {
    const plain = await startHarness();
    try {
      await plain.api.expectError(409, 'INVALID_STATE', 'PUT', '/v1/network/https', { enabled: true });
    } finally {
      await plain.close();
    }
  });

  it('enabling mints the CA, serves it openly, and adds lanSecure everywhere', async () => {
    if (!hasOpenssl()) {
      console.warn('openssl not installed: skipping LAN HTTPS mint test');
      return;
    }
    // harbor.service runs with UMask=0077, so mkdir alone left tls/ at 0700 and Caddy could not open the
    // cert (it wedged Caddy on a real host). A dir left 0700 by an older version is repaired on enable.
    const tlsDir = path.join(h.stateDir, 'tls');
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
    chmodSync(tlsDir, 0o700);
    const on = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.url).toBe('https://harbor.local/');
    expect(on.fingerprint).toMatch(/:/); // AA:BB:… SHA-256 of the CA
    expect(on.hosts).toContain('harbor.local');
    // The server cert/key are group-readable (0640) so Caddy (added to the
    // harbor group) can terminate TLS for the LAN hostnames; the CA key stays 0600.
    expect(statSync(tlsDir).mode & 0o777).toBe(0o750);
    expect(statSync(path.join(tlsDir, 'server.crt')).mode & 0o777).toBe(0o640);
    expect(statSync(path.join(tlsDir, 'server.key')).mode & 0o777).toBe(0o640);
    expect(statSync(path.join(tlsDir, 'ca.key')).mode & 0o777).toBe(0o600);
    // The CA cert is public key material: downloadable without a token.
    const raw = await h.api.raw('GET', '/v1/network/https/ca.crt', undefined, { authorization: '' });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toContain('pem');
    expect(raw.headers.get('content-disposition')).toContain('harbor-local-ca.crt');
    expect(await raw.text()).toContain('BEGIN CERTIFICATE');
    // System + app endpoints carry the secure addresses.
    const sys = await h.api.expect<SystemDto>(200, 'GET', '/v1/system');
    expect(sys.network.https.url).toBe('https://harbor.local/');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'excalidraw') as InstanceSummary;
    expect(inst.endpoints[0]!.urls.lanSecure).toMatch(/^https:\/\/[a-z0-9-]+\.local:\d+\/$/);
    // Disabling closes the surface again (plain HTTP stays).
    const off = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: false });
    expect(off).toMatchObject({ enabled: false, url: null });
    const inst2 = (await h.api.instances()).find((i) => i.packageId === 'excalidraw') as InstanceSummary;
    expect(inst2.endpoints[0]!.urls.lanSecure).toBeUndefined();
    expect(inst2.endpoints[0]!.urls.lan).toMatch(/^http:\/\//);
  }, 60_000);

  it('a config Caddy rejects is sent once, not re-pushed every tick (repeated rejects wedged a real Caddy)', async () => {
    if (!hasOpenssl()) return;
    h.caddy.reject = 'loading certificates: open server.crt: permission denied';
    h.caddy.loadAttempts = 0;
    await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true });
    await new Promise((r) => setTimeout(r, 2_000)); // four observer ticks
    expect(h.caddy.loadAttempts).toBe(1);
    // Caddy kept its last good config (a rejected load rolls back), so turning HTTPS off sends nothing.
    h.caddy.reject = null;
    await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: false });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.caddy.loadAttempts).toBe(1);
    expect(JSON.stringify(h.caddy.config)).not.toContain('server.crt');
  }, 30_000);
});
