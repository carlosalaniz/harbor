import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, startHarness, type Harness } from './harness.js';
import { openState } from '../../src/state/db.js';
import { request as httpRequest } from 'node:http';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('authentication and request controls', () => {
  it('/healthz is open and reveals only liveness', async () => {
    const r = await fetch(`${h.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('every /v1 route except login requires a valid bearer token', async () => {
    const anon = new Api(h.baseUrl, null);
    for (const [m, u, b] of [['GET', '/v1/system'], ['GET', '/v1/catalog'], ['GET', '/v1/instances'], ['GET', '/v1/platform-tools'], ['POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw' }], ['POST', '/v1/operations', { planId: '11111111-1111-4111-8111-111111111111' }], ['DELETE', '/v1/sessions/current']] as const) {
      const res = await anon.json<{ error: { code: string } }>(m, u, b, m === 'POST' ? { 'idempotency-key': 'anon-key-0001' } : {});
      expect(res.status, `${m} ${u}`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    const bogus = new Api(h.baseUrl, 'not-a-real-token');
    expect((await bogus.json('GET', '/v1/system')).status).toBe(401);
    // Credentials in URL parameters are never accepted.
    expect((await fetch(`${h.baseUrl}/v1/system?token=${h.token}`)).status).toBe(401);
  });

  it('wrong username or password fails identically without disclosing which', async () => {
    const anon = new Api(h.baseUrl, null);
    const a = await anon.json<{ error: { message: string } }>('POST', '/v1/sessions', { username: 'nobody', password: 'wrong-password-xx' });
    const b = await anon.json<{ error: { message: string } }>('POST', '/v1/sessions', { username: ADMIN.username, password: 'wrong-password-xx' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('login failures are rate limited (429) without affecting a valid session', async () => {
    const anon = new Api(h.baseUrl, null);
    let last = 0;
    for (let i = 0; i < 7; i++) {
      last = (await anon.json('POST', '/v1/sessions', { username: ADMIN.username, password: `bad-${i}-xxxxxxxxxx` })).status;
    }
    expect(last).toBe(429);
    // Even the correct password is refused while limited; the existing session still works.
    expect((await anon.json('POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password })).status).toBe(429);
    expect((await h.api.json('GET', '/v1/system')).status).toBe(200);
    h.clock.advance(11 * 60_000);
    const ok = await anon.json<{ token: string }>('POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password });
    expect(ok.status).toBe(201);
    h.clock.advance(-11 * 60_000);
  });

  it('Host, Origin, Sec-Fetch-Site and content-type controls', async () => {
    const good = { authorization: `Bearer ${h.token}` };
    const port = h.config.listen.port;
    // Wrong Host (fetch forbids setting Host, so use http.request)
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/v1/system', method: 'GET', headers: { ...good, host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
    let r: Response;
    // Foreign Origin on a read and on a mutation
    r = await fetch(`${h.baseUrl}/v1/system`, { headers: { ...good, origin: 'http://localhost:9999' } });
    expect(r.status).toBe(403);
    r = await fetch(`${h.baseUrl}/v1/plans`, { method: 'POST', headers: { ...good, origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'install', packageId: 'excalidraw' }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN_ORIGIN');
    // Same-origin allowed; 127.0.0.1 origin allowed
    r = await fetch(`${h.baseUrl}/v1/system`, { headers: { ...good, origin: `http://localhost:${port}` } });
    expect(r.status).toBe(200);
    r = await fetch(`${h.baseUrl}/v1/system`, { headers: { ...good, origin: `http://127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
    // Cross-site fetch metadata
    r = await fetch(`${h.baseUrl}/v1/system`, { headers: { ...good, 'sec-fetch-site': 'cross-site' } });
    expect(r.status).toBe(403);
    // Non-JSON content type on a mutation
    r = await fetch(`${h.baseUrl}/v1/plans`, { method: 'POST', headers: { ...good, 'content-type': 'text/plain' }, body: '{"kind":"install","packageId":"excalidraw"}' });
    expect(r.status).toBe(422);
    r = await fetch(`${h.baseUrl}/v1/plans`, { method: 'POST', headers: { ...good, 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=install' });
    expect(r.status).toBe(422);
    // No CORS headers ever
    r = await fetch(`${h.baseUrl}/v1/system`, { method: 'OPTIONS', headers: { origin: `http://localhost:${port}`, 'access-control-request-method': 'GET' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.status).toBe(404);
  });

  it('malformed JSON, invalid bodies and oversized bodies never reach execution', async () => {
    const r1 = await h.api.raw('POST', '/v1/plans', '{"kind": "install", ', {});
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('MALFORMED_JSON');
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: '../etc' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', extra: true });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'destroy', instanceId: '11111111-1111-4111-8111-111111111111' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { planId: 'not-a-uuid' }, { 'idempotency-key': 'abcdefgh' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { planId: '11111111-1111-4111-8111-111111111111' }, { 'idempotency-key': 'short' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { planId: '11111111-1111-4111-8111-111111111111' });
    await h.api.expectError(404, 'NOT_FOUND', 'POST', '/v1/operations', { planId: '11111111-1111-4111-8111-111111111111' }, { 'idempotency-key': 'unknown-plan-key' });
    await h.api.expectError(404, 'NOT_FOUND', 'GET', '/v1/instances/11111111-1111-4111-8111-111111111111');
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/plans', { kind: 'install', packageId: 'nonexistent' }).catch(async () => h.api.expectError(404, 'NOT_FOUND', 'POST', '/v1/plans', { kind: 'install', packageId: 'nonexistent' }));
    const big = JSON.stringify({ kind: 'install', packageId: 'excalidraw', name: 'x'.repeat(300 * 1024) });
    const r2 = await h.api.raw('POST', '/v1/plans', big);
    expect(r2.status).toBe(413);
    expect(await h.api.instances()).toEqual([]);
  });

  it('remember-me issues a 30-day session; session list marks current; revoke-others keeps only this session', async () => {
    const anon = new Api(h.baseUrl, null);
    const r = await anon.json<{ token: string; expiresAt: string }>('POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password, remember: true });
    expect(r.status).toBe(201);
    const exp = new Date(r.body.expiresAt).getTime() - Date.now();
    expect(exp).toBeGreaterThan(29 * 24 * 3600_000);
    const me = new Api(h.baseUrl, r.body.token);
    const list = await me.expect<{ items: { kind: string; current: boolean }[] }>(200, 'GET', '/v1/sessions');
    expect(list.items.some((s) => s.current && s.kind === 'remember')).toBe(true);
    expect((await me.raw('DELETE', '/v1/sessions/others')).status).toBe(204);
    expect((await me.json('GET', '/v1/system')).status).toBe(200);
    expect((await h.api.json('GET', '/v1/system')).status).toBe(401);
    // re-login the harness session for the tests that follow
    h.api.token = (await anon.login()).token;
  });

  it('logout revokes the token; expired sessions are rejected; sessions store only hashes', async () => {
    const anon = new Api(h.baseUrl, null);
    const s = await anon.login();
    const me = new Api(h.baseUrl, s.token);
    expect((await me.json('GET', '/v1/system')).status).toBe(200);
    expect((await me.raw('DELETE', '/v1/sessions/current')).status).toBe(204);
    expect((await me.json('GET', '/v1/system')).status).toBe(401);
    const s2 = await anon.login();
    const me2 = new Api(h.baseUrl, s2.token);
    h.clock.advance(13 * 3600_000);
    expect((await me2.json('GET', '/v1/system')).status).toBe(401);
    h.clock.advance(-13 * 3600_000);
    const db = openState(h.stateDir, { readonly: true });
    const rows = db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(r.token_hash).not.toBe(s2.token);
    }
  });

  it('DTOs never contain password material or the administrator hash', async () => {
    const db = openState(h.stateDir, { readonly: true });
    const admin = db.prepare('SELECT password_hash, salt FROM administrator').get() as { password_hash: string; salt: string };
    db.close();
    const blobs = [
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/system')),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/catalog')),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/platform-tools')),
    ];
    for (const b of blobs) {
      expect(b).not.toContain(admin.password_hash);
      expect(b).not.toContain(admin.salt);
      expect(b).not.toContain(ADMIN.password);
      expect(b).not.toContain(h.token);
    }
  });
});
