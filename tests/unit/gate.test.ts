// Decision 194: the app login gate (gate/gate.mjs), against a real upstream on loopback.
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without types (it runs inside the gate container as is)
import * as gate from '../../gate/gate.mjs';

type Res = { status: number; headers: IncomingHttpHeaders; body: string };
const SALT = '00112233445566778899aabbccddeeff';
const KEY = 'ab'.repeat(32);
const PASSWORD = 'gate-FIXTURE-password';

let upstream: Server;
let server: Server;
let base: { port: number };
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const upgraded: Socket[] = [];

function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: base.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const browser = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };
const cookieOf = (r: Res) => String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
async function signIn(): Promise<string> {
  const r = await send('POST', '/.harbor-gate/login', { 'content-type': 'application/x-www-form-urlencoded' }, `password=${encodeURIComponent(PASSWORD)}&next=${encodeURIComponent('/deep?x=1')}`);
  expect(r.status).toBe(303);
  expect(r.headers['location']).toBe('/deep?x=1');
  return cookieOf(r);
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/health') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-app': 'yes' });
    res.end(`app says hi to ${req.url}`);
  });
  upstream.on('upgrade', (req, socket) => {
    upgraded.push(socket as Socket);
    seen.push({ url: req.url ?? '', headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d: Buffer) => socket.write(`echo:${d.toString()}`));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const up = upstream.address() as AddressInfo;
  server = gate.createGate({ GATE_UPSTREAM: `http://127.0.0.1:${up.port}`, GATE_PASSWORD_HASH: gate.hashPassword(PASSWORD, SALT, { N: 1024, r: 8, p: 1 }), GATE_COOKIE_KEY: KEY, GATE_COOKIE: 'harbor_gate_test_web', GATE_APP: 'Android', GATE_HEALTH_PATH: '/health' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = { port: (server.address() as AddressInfo).port };
});
afterAll(async () => {
  for (const s of upgraded) s.destroy();
  server.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
});

describe('the app login gate (decision 194)', () => {
  it('sends a browser to the Harbor login page and keeps where it was going', async () => {
    const r = await send('GET', '/deep?x=1', browser);
    expect(r.status).toBe(303);
    expect(r.headers['location']).toBe('/.harbor-gate/login?next=%2Fdeep%3Fx%3D1');
    const page = await send('GET', String(r.headers['location']), browser);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>Android</h1>');
    expect(page.body).toContain('name="next" value="/deep?x=1"');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('a script gets a basic-auth challenge, a browser fetch a plain 401 (no browser dialog)', async () => {
    const curl = await send('GET', '/api');
    expect(curl.status).toBe(401);
    expect(curl.headers['www-authenticate']).toMatch(/^Basic realm="Android"/);
    const fetchFromPage = await send('GET', '/api', { accept: '*/*', 'sec-fetch-mode': 'cors' });
    expect(fetchFromPage.status).toBe(401);
    expect(fetchFromPage.headers['www-authenticate']).toBeUndefined();
  });

  it('a wrong password shows the page again; the right one signs in and the app never sees the gate cookie', async () => {
    const wrong = await send('POST', '/.harbor-gate/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'password=nope&next=%2F');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('That password is not right.');
    const cookie = await signIn();
    expect(cookie).toMatch(/^harbor_gate_test_web=\d+\./);
    const r = await send('GET', '/deep?x=1', { cookie: `${cookie}; app_session=keep` });
    expect(r.status).toBe(200);
    expect(r.body).toBe('app says hi to /deep?x=1');
    expect(r.headers['x-app']).toBe('yes');
    const last = seen.at(-1)!;
    expect(last.headers['cookie']).toBe('app_session=keep');
    expect(last.headers['x-forwarded-for']).toBeTruthy();
  });

  it('scripts may send the password as basic auth (any user); it is not passed on to the app', async () => {
    const r = await send('GET', '/api', { authorization: `Basic ${Buffer.from(`anyone:${PASSWORD}`).toString('base64')}` });
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.headers['authorization']).toBeUndefined();
  });

  it('answers the readiness path with the status code only, without a login', async () => {
    const r = await send('GET', '/health');
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
    // with a query it is an ordinary request again
    expect((await send('GET', '/health?x=1')).status).toBe(401);
  });

  it('passes WebSockets through once signed in, and refuses them otherwise', async () => {
    const cookie = await signIn();
    const handshake = (headers: string) =>
      new Promise<string>((resolve) => {
        const s = connect(base.port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`));
        let got = '';
        s.on('data', (d: Buffer) => {
          got += d.toString();
          if (got.includes('101') && !got.includes('echo:')) s.write('ping');
          if (got.includes('echo:') || got.includes('401')) {
            s.destroy();
            resolve(got);
          }
        });
      });
    expect(await handshake('')).toContain('401 Unauthorized');
    const ok = await handshake(`Cookie: ${cookie}\r\n`);
    expect(ok).toContain('101 Switching Protocols');
    expect(ok).toContain('echo:ping');
  });

  it('sessions: signed, expiring, bound to the key', () => {
    const v = gate.signSession(KEY, 1000, 60);
    expect(gate.sessionValid(KEY, v, 1001)).toBe(true);
    expect(gate.sessionValid(KEY, v, 1061)).toBe(false);
    expect(gate.sessionValid('cd'.repeat(32), v, 1001)).toBe(false);
    expect(gate.sessionValid(KEY, v.replace(/.$/, 'A'), 1001)).toBe(false);
  });

  it('only same-site paths as the place to go after signing in', () => {
    expect(gate.safeNext('/a?b')).toBe('/a?b');
    for (const bad of ['https://evil', '//evil', '/\\evil', '/.harbor-gate/login', '', null]) expect(gate.safeNext(bad)).toBe('/');
  });

  it('ten wrong passwords from one client stop it for a while', () => {
    let t = 0;
    const l = new gate.FailureLimiter(() => t);
    for (let i = 0; i < 10; i++) l.fail('a');
    expect(l.blocked('a')).toBe(true);
    expect(l.blocked('b')).toBe(false);
    t += 11 * 60_000;
    expect(l.blocked('a')).toBe(false);
  });
});
