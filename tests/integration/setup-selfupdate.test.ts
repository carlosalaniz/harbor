import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, SelfUpdateStatusDto, SetupStatusDto, SystemDto } from '../../src/contracts/api.js';
import { writeSetupCode } from '../../src/auth/setup.js';
import { request as httpRequest } from 'node:http';

// fetch() drops a custom Host header (forbidden by the fetch spec); raw http lets us pretend to be a LAN visitor
function rawGet(base: string, pathname: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: Number(u.port), path: pathname, method: 'GET', headers, setHost: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}
import { startHarness, type Harness } from './harness.js';

describe('first-run setup in the browser (no administrator yet)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ noAdmin: true, config: { lan: { enabled: true, port: 18999 } } });
  });
  afterAll(async () => h.close());

  it('reports setup needed, refuses login and wrong codes, creates the administrator once, then closes the door', async () => {
    const st = await h.api.expect<SetupStatusDto>(200, 'GET', '/v1/setup', undefined, { authorization: '' });
    expect(st.needed).toBe(true);
    expect(st.lan!.enabled).toBe(true);
    expect(st.lan!.url).toMatch(/^http:\/\/[a-z0-9-]+\.local:18999\/$/);
    expect(st.tailscale!.installed).toBe(true);
    expect(st.version).toBeTruthy();
    // the console's data routes are still closed
    await h.api.expectError(401, 'UNAUTHENTICATED', 'GET', '/v1/instances', undefined, { authorization: '' });
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: 'admin', password: 'whatever-it-is-12' }, { authorization: '' });
    // no code on disk yet: the installer writes one
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/setup', { code: '123456', username: 'admin', password: 'a-good-password-123' }, { authorization: '' });
    const code = writeSetupCode(h.stateDir);
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/setup', { code: code === '000000' ? '000001' : '000000', username: 'admin', password: 'a-good-password-123' }, { authorization: '' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/setup', { code, username: 'admin', password: 'short' }, { authorization: '' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/setup', { code, username: '1bad name', password: 'a-good-password-123' }, { authorization: '' });
    const s = await h.api.expect<{ token: string }>(201, 'POST', '/v1/setup', { code: `${code.slice(0, 3)} ${code.slice(3)}`, username: 'carlos', password: 'a-good-password-123', everyAppOnTailscale: true, deviceName: '  Kitchen  server ' }, { authorization: '' });
    expect(s.token).toBeTruthy();
    h.api.token = s.token;
    expect(existsSync(path.join(h.stateDir, 'setup-code'))).toBe(false);
    // decision 197: a new Harbor starts with every app on Tailscale when the wizard says so
    expect((await h.api.expect<{ enabled: boolean }>(200, 'GET', '/v1/exposures/tailnet-all')).enabled).toBe(true);
    const sys = await h.api.expect<SystemDto>(200, 'GET', '/v1/system');
    expect(sys.deviceName).toBe('Kitchen server');
    expect(sys.lan).toEqual({ enabled: true, url: st.lan!.url });
    // Decision 169: once an administrator exists, the open route says only what the login page needs.
    const after = await h.api.expect<SetupStatusDto>(200, 'GET', '/v1/setup', undefined, { authorization: '' });
    expect(Object.keys(after).sort()).toEqual(['https', 'needed']);
    expect(after.needed).toBe(false);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/setup', { code, username: 'x', password: 'a-good-password-123' }, { authorization: '' });
    // the normal login works with the chosen credentials
    await h.api.expect(201, 'POST', '/v1/sessions', { username: 'carlos', password: 'a-good-password-123' }, { authorization: '' });
  });

  it('LAN mode: apps publish on every interface and get a .local address; LAN Host values are accepted, strangers are not', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'excalidraw') as InstanceSummary;
    const port = inst.endpoints[0]!.hostPort;
    expect(inst.endpoints[0]!.urls.lan).toMatch(new RegExp(`^http://[a-z0-9-]+\\.local:${port}/$`));
    const rendered = readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8');
    expect(rendered).toMatch(/host_ip: ['"]?0\.0\.0\.0/);
    // the same daemon answers requests that arrive with a LAN Host header
    expect(await rawGet(h.baseUrl, '/healthz', { host: 'harbor.local' })).toBe(200);
    expect(await rawGet(h.baseUrl, '/v1/setup', { host: 'kitchen-2.local:18999' })).toBe(200);
    expect(await rawGet(h.baseUrl, '/healthz', { host: 'evil.example.com' })).toBe(403);
    expect(await rawGet(h.baseUrl, '/v1/setup', { host: 'harbor.local', origin: 'http://harbor.local' })).toBe(200);
    expect(await rawGet(h.baseUrl, '/v1/setup', { host: 'harbor.local', origin: 'http://evil.example.com' })).toBe(403);
    // the observer put a LAN console server into Caddy at startup (Caddy owns :80 when the proxy is installed)
    const until = Date.now() + 5000;
    while (Date.now() < until && !h.caddy.routes().includes('harbor.local')) await new Promise((r) => setTimeout(r, 200));
    expect(h.caddy.routes()).toEqual(expect.arrayContaining(['harbor.local', '*.local']));
  });
});

describe('Harbor self-update', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h.close());

  it('reports the newest release, refuses to apply when up to date, starts the root oneshot for a newer one and shows the progress file', async () => {
    const st0 = await h.api.expect<SelfUpdateStatusDto>(200, 'GET', '/v1/system/update');
    expect(st0.current).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    // the harness feed starts empty: "not checked / nothing known"
    expect(st0.latest).toBeNull();
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/system/update/apply', {});
    h.releaseFeed.info = { version: st0.current, tag: `v${st0.current}`, publishedAt: null, notes: null, url: null, archiveUrl: 'x', sumsUrl: 'y', sigUrl: 'z' };
    const same = await h.api.expect<SelfUpdateStatusDto>(200, 'POST', '/v1/system/update/check', {});
    expect(same.available).toBe(false);
    expect(same.checkedAt).not.toBeNull();
    // decision 168: an older release is never offered or applied from the console
    const older = '0.0.1';
    h.releaseFeed.info = { version: older, tag: `v${older}`, publishedAt: null, notes: null, url: null, archiveUrl: 'x', sumsUrl: 'y', sigUrl: 'z' };
    expect((await h.api.expect<SelfUpdateStatusDto>(200, 'POST', '/v1/system/update/check', {})).available).toBe(false);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/system/update/apply', {});
    const next = st0.current.replace(/\d+$/, (n) => String(Number(n) + 1));
    // decision 168: a newer release without SHA256SUMS.sig (still uploading) is not offered, and never started
    h.releaseFeed.info = { version: next, tag: `v${next}`, publishedAt: null, notes: null, url: null, archiveUrl: `https://example.com/harbor-${next}-linux-x64.tar.gz`, sumsUrl: 'https://example.com/SHA256SUMS', sigUrl: null };
    expect(await h.api.expect<SelfUpdateStatusDto>(200, 'POST', '/v1/system/update/check', {})).toMatchObject({ available: false, pending: `Harbor ${next} is still being published (SHA256SUMS.sig not uploaded yet); Harbor offers it once its signed files are all there` });
    const unsigned = await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/system/update/apply', {});
    expect(JSON.stringify(unsigned)).toContain('is still being published');
    expect(h.unitStarter.started).toEqual([]);
    h.releaseFeed.info = { version: next, tag: `v${next}`, publishedAt: '2026-09-16T00:00:00Z', notes: 'Shiny', url: 'https://example.com/r', archiveUrl: `https://example.com/harbor-${next}-linux-x64.tar.gz`, sumsUrl: 'https://example.com/SHA256SUMS', sigUrl: 'https://example.com/SHA256SUMS.sig' };
    const avail = await h.api.expect<SelfUpdateStatusDto>(200, 'POST', '/v1/system/update/check', {});
    expect(avail.available).toBe(true);
    expect(avail.latest).toMatchObject({ version: next, notes: 'Shiny' });
    // a failing feed keeps the last good answer and reports the error
    h.releaseFeed.error = 'GitHub answered HTTP 503';
    const err = await h.api.expect<SelfUpdateStatusDto>(200, 'POST', '/v1/system/update/check', {});
    expect(err.error).toContain('503');
    expect(err.available).toBe(true);
    h.releaseFeed.error = null;
    // apply: the daemon writes the request and starts harbor-self-update@<version>.service
    h.unitStarter.onStart = (unit) => {
      const v = unit.replace(/^harbor-self-update@/, '').replace(/\.service$/, '');
      writeFileSync(path.join(h.stateDir, 'updates', 'status.json'), JSON.stringify({ version: v, state: 'downloading', message: 'downloading (simulated root step)', at: new Date().toISOString() }));
    };
    const applied = await h.api.expect<SelfUpdateStatusDto>(202, 'POST', '/v1/system/update/apply', {});
    expect(h.unitStarter.started).toEqual([`harbor-self-update@${next}.service`]);
    expect(applied.applying).toMatchObject({ version: next, state: 'downloading' });
    // a second click while it runs is refused
    await h.api.expectError(409, 'BUSY', 'POST', '/v1/system/update/apply', {});
    // the root step failing leaves a clear message; the next apply may retry
    writeFileSync(path.join(h.stateDir, 'updates', 'status.json'), JSON.stringify({ version: next, state: 'failed', message: 'checksum mismatch', at: new Date().toISOString() }));
    expect((await h.api.expect<SelfUpdateStatusDto>(200, 'GET', '/v1/system/update')).applying).toMatchObject({ state: 'failed', message: 'checksum mismatch' });
    h.unitStarter.fail = 'Interactive authentication required';
    await h.api.expectError(500, 'OPERATION_FAILED', 'POST', '/v1/system/update/apply', {});
    expect((await h.api.expect<SelfUpdateStatusDto>(200, 'GET', '/v1/system/update')).applying?.message).toContain('could not start the update');
  });
});
