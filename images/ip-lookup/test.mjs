// node --test images/ip-lookup/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

function jsonResponse(status, body) {
  return new globalThis.Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const IPINFO_BODY = {
  ip: '203.0.113.5',
  hostname: 'x.example.net',
  city: 'Ashburn',
  region: 'Virginia',
  country: 'US',
  org: 'AS64500 Example Hosting',
  privacy: { vpn: false, proxy: false, tor: false, relay: false, hosting: true, service: '' },
  extra: 'dropped',
};

const ABUSE_BODY = {
  data: {
    ipAddress: '203.0.113.5',
    abuseConfidenceScore: 87,
    totalReports: 412,
    lastReportedAt: '2026-11-19T10:00:00+00:00',
    usageType: 'Data Center/Web Hosting/Transit',
    hostnames: ['y.example.net'],
    countryCode: 'US',
    isTor: true,
    isp: 'dropped',
  },
};

/** A fake fetch that routes by host and records every call. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const handler = handlers[u.hostname];
    if (!handler) throw new Error(`unexpected host ${u.hostname}`);
    return handler(u, init);
  };
  fn.calls = calls;
  return fn;
}

/** Never answers until its signal aborts, like a slow upstream. */
function hang(_u, init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
}

async function start(opts, t) {
  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path, method = 'GET') {
      const res = await fetch(base + path, { method });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, headers: res.headers, body };
    },
  };
}

const BOTH = { IPINFO_TOKEN: 'ipinfo-FIXTURE-token', ABUSEIPDB_KEY: 'abuse-FIXTURE-key' };

test('healthz answers without calling any upstream', async (t) => {
  const f = fakeFetch({});
  const s = await start({ fetch: f, env: BOTH }, t);
  const r = await s.get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(f.calls.length, 0);
});

test('a bad ip is a 400', async (t) => {
  const s = await start({ fetch: fakeFetch({}), env: BOTH }, t);
  for (const q of ['', '?ip=', '?ip=bad', '?ip=1.2.3', '?ip=8.8.8.8/32', '?ip=example.com']) {
    const r = await s.get(`/v1/lookup${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(typeof r.body.error, 'string');
  }
});

test('no service enabled: empty results and a note', async (t) => {
  const f = fakeFetch({});
  const s = await start({ fetch: f, env: { LOOKUP_IPINFO: 'false', ABUSEIPDB_KEY: '' } }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(r.status, 200);
  assert.equal(r.body.format, 1);
  assert.deepEqual(r.body.results, []);
  assert.match(r.body.note, /No lookup service is turned on/);
  assert.equal(f.calls.length, 0);
});

test('ipinfo mapping (unauthenticated by default)', async (t) => {
  const f = fakeFetch({ 'ipinfo.io': () => jsonResponse(200, IPINFO_BODY) });
  const s = await start({ fetch: f, env: {} }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    format: 1,
    ip: '203.0.113.5',
    results: [
      {
        source: 'ipinfo',
        ok: true,
        country: 'US',
        region: 'Virginia',
        city: 'Ashburn',
        asn: 'AS64500',
        org: 'Example Hosting',
        hostname: 'x.example.net',
        flags: ['hosting'],
      },
    ],
    cached: false,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url.pathname, '/203.0.113.5/json');
  assert.equal(f.calls[0].url.searchParams.get('token'), null);
});

test('ipinfo token, bogon flag and long strings trimmed', async (t) => {
  const f = fakeFetch({
    'ipinfo.io': () => jsonResponse(200, { ip: '10.0.0.1', bogon: true, city: 'x'.repeat(500) }),
  });
  const s = await start({ fetch: f, env: { IPINFO_TOKEN: 'ipinfo-FIXTURE-token' } }, t);
  const r = await s.get('/v1/lookup?ip=10.0.0.1');
  assert.equal(f.calls[0].url.searchParams.get('token'), 'ipinfo-FIXTURE-token');
  assert.deepEqual(r.body.results[0].flags, ['bogon']);
  assert.equal(r.body.results[0].city.length, 200);
  assert.ok(!JSON.stringify(r.body).includes('FIXTURE'));
});

test('abuseipdb mapping', async (t) => {
  const f = fakeFetch({ 'api.abuseipdb.com': () => jsonResponse(200, ABUSE_BODY) });
  const s = await start({ fetch: f, env: { LOOKUP_IPINFO: 'false', ABUSEIPDB_KEY: 'abuse-FIXTURE-key' } }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, [
    {
      source: 'abuseipdb',
      ok: true,
      abuseScore: 87,
      reports: 412,
      lastReportedAt: '2026-11-19T10:00:00+00:00',
      usage: 'Data Center/Web Hosting/Transit',
      hostname: 'y.example.net',
      country: 'US',
      flags: ['tor'],
    },
  ]);
  const call = f.calls[0];
  assert.equal(call.url.pathname, '/api/v2/check');
  assert.equal(call.url.searchParams.get('ipAddress'), '203.0.113.5');
  assert.equal(call.url.searchParams.get('maxAgeInDays'), '90');
  assert.equal(call.init.headers.Key, 'abuse-FIXTURE-key');
  assert.equal(call.init.headers.Accept, 'application/json');
});

test('abuseipdb stays off without a key, or when turned off', async (t) => {
  const f = fakeFetch({ 'ipinfo.io': () => jsonResponse(200, IPINFO_BODY) });
  const s = await start({ fetch: f, env: { LOOKUP_ABUSEIPDB: 'true' } }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.deepEqual(r.body.results.map((x) => x.source), ['ipinfo']);
  const f2 = fakeFetch({ 'ipinfo.io': () => jsonResponse(200, IPINFO_BODY) });
  const s2 = await start({ fetch: f2, env: { LOOKUP_ABUSEIPDB: 'false', ABUSEIPDB_KEY: 'abuse-FIXTURE-key' } }, t);
  const r2 = await s2.get('/v1/lookup?ip=203.0.113.5');
  assert.deepEqual(r2.body.results.map((x) => x.source), ['ipinfo']);
});

test('one upstream failing does not hide the other; errors never echo bodies or keys', async (t) => {
  const f = fakeFetch({
    'ipinfo.io': () => jsonResponse(200, IPINFO_BODY),
    'api.abuseipdb.com': () => jsonResponse(429, { errors: [{ detail: 'key abuse-FIXTURE-key over quota' }] }),
  });
  const s = await start({ fetch: f, env: BOTH }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].ok, true);
  assert.deepEqual(r.body.results[1], { source: 'abuseipdb', ok: false, error: 'HTTP 429' });
  assert.ok(!JSON.stringify(r.body).includes('FIXTURE'));
});

test('invalid upstream JSON is "invalid response"', async (t) => {
  const f = fakeFetch({
    'ipinfo.io': () => jsonResponse(200, '<html>nope</html>'),
    'api.abuseipdb.com': () => jsonResponse(200, { data: 'nope' }),
  });
  const s = await start({ fetch: f, env: BOTH }, t);
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.deepEqual(r.body.results, [
    { source: 'ipinfo', ok: false, error: 'invalid response' },
    { source: 'abuseipdb', ok: false, error: 'invalid response' },
  ]);
});

test('cache: a second lookup is served from memory; all-failed results are not cached', async (t) => {
  const f = fakeFetch({ 'ipinfo.io': () => jsonResponse(200, IPINFO_BODY) });
  let clock = 1_000_000;
  const s = await start({ fetch: f, env: {}, now: () => clock }, t);
  const a = await s.get('/v1/lookup?ip=203.0.113.5');
  const b = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(a.body.cached, false);
  assert.equal(b.body.cached, true);
  assert.deepEqual(b.body.results, a.body.results);
  assert.equal(f.calls.length, 1);
  clock += 24 * 60 * 60 * 1000 + 1;
  const c = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(c.body.cached, false);
  assert.equal(f.calls.length, 2);

  const failing = fakeFetch({ 'ipinfo.io': () => jsonResponse(500, {}) });
  const s2 = await start({ fetch: failing, env: {} }, t);
  await s2.get('/v1/lookup?ip=203.0.113.5');
  const d = await s2.get('/v1/lookup?ip=203.0.113.5');
  assert.equal(d.body.cached, false);
  assert.equal(failing.calls.length, 2);
});

test('timeout: a slow upstream is "timed out", the other still answers', async (t) => {
  const f = fakeFetch({ 'ipinfo.io': () => jsonResponse(200, IPINFO_BODY), 'api.abuseipdb.com': hang });
  const s = await start({ fetch: f, env: BOTH, timeoutMs: 100 }, t);
  const started = Date.now();
  const r = await s.get('/v1/lookup?ip=203.0.113.5');
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.body.results[0].ok, true);
  assert.deepEqual(r.body.results[1], { source: 'abuseipdb', ok: false, error: 'timed out' });
});

test('page, script, methods and unknown paths', async (t) => {
  const s = await start({ fetch: fakeFetch({}), env: { ABUSEIPDB_KEY: 'abuse-FIXTURE-key' } }, t);
  const page = await s.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page.body, /<title>IP Lookup<\/title>/);
  assert.ok(!page.body.includes('FIXTURE'));
  const js = await s.get('/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok(!js.body.includes('innerHTML'));
  assert.equal((await s.get('/healthz', 'HEAD')).status, 200);
  const post = await s.get('/v1/lookup?ip=203.0.113.5', 'POST');
  assert.equal(post.status, 405);
  const missing = await s.get('/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});
