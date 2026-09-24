// LAN HTTPS routes (decision 109): off by default, refuses without LAN,
// mints the local CA on enable (openssl), serves the cert openly, reports
// the secure address + fingerprint, and adds lanSecure to app endpoints.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, NetworkHttpsDto, SystemDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';

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
    const on = await h.api.expect<NetworkHttpsDto>(200, 'PUT', '/v1/network/https', { enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.url).toBe('https://harbor.local/');
    expect(on.fingerprint).toMatch(/:/); // AA:BB:… SHA-256 of the CA
    expect(on.hosts).toContain('harbor.local');
    // The server cert/key are group-readable (0640) so Caddy (added to the
    // harbor group) can terminate TLS for the LAN hostnames; the CA key stays 0600.
    const tlsDir = path.join(h.stateDir, 'tls');
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
});
