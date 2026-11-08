// Decision 196: the loopback relay behind a tailnet address: the cookie firewall of the secure LAN addresses, with the
// headers `tailscale serve` set left alone.
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LanHttpsServers } from '../../src/system/lan-https.js';

let upstream: Server;
let upstreamPort = 0;
let seen: IncomingHttpHeaders = {};
const relays = new LanHttpsServers(true);
const RELAY = 28731;
const KEY = Buffer.alloc(32, 7);
const TAG = 'aaaaaaaa';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'set-cookie': ['session=abc; HttpOnly; Path=/'], 'strict-transport-security': 'max-age=31536000' });
    res.end('ok');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  relays.setPolicy({ key: KEY, bySecurePort: new Map([[RELAY, { tag: TAG, cookies: 'isolated', label: 'one' }]]), portTags: new Map([[18999, TAG], [18998, 'bbbbbbbb']]) });
  await relays.ensureTailnetProxy(RELAY, upstreamPort);
});
afterAll(async () => {
  await relays.closeAll();
  await new Promise((r) => upstream.close(r));
});

const send = (method: string, headers: Record<string, string>) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: RELAY, method, path: '/', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

const NODE = 'harbor-test.tail1234.ts.net';

describe('tailnet relay (decision 196)', () => {
  it('tags the app\'s HttpOnly cookies and drops one app\'s HSTS for the shared host name', async () => {
    const r = await send('GET', { host: `${NODE}:18999` });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']![0]).toMatch(new RegExp(`^hb_${TAG}__session=abc\\.`));
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });

  it('leaves what tailscale serve states alone, so an app sees its real address', async () => {
    await send('GET', { host: `${NODE}:18999`, 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https' });
    expect(seen.host).toBe(`${NODE}:18999`);
    expect(seen['x-forwarded-for']).toBe('100.64.0.9');
    expect(seen['x-forwarded-proto']).toBe('https');
  });

  it('gives an app its own signed cookie back and never another app\'s', async () => {
    const own = (await send('GET', { host: `${NODE}:18999` })).headers['set-cookie']![0]!.split(';')[0]!;
    await send('GET', { host: `${NODE}:18999`, cookie: `${own}; hb_bbbbbbbb__other=x.sig` });
    expect(seen.cookie).toBe('session=abc');
  });

  it('refuses a form sent from another app\'s tailnet page, and allows its own', async () => {
    expect((await send('POST', { host: `${NODE}:18999`, origin: `https://${NODE}:18998` })).status).toBe(403);
    expect((await send('POST', { host: `${NODE}:18999`, origin: `https://${NODE}:18999` })).status).toBe(200);
  });
});
