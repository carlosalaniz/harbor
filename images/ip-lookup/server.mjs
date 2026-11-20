// Harbor IP Lookup: asks online services (ipinfo, AbuseIPDB) about one address.
// Zero dependencies. Harbor's daemon calls GET /v1/lookup?ip=<addr> on loopback; the app reaches the
// internet only through Harbor's VPN, so the services see the VPN's address, never the box's own.
import http from 'node:http';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_STRING = 200;
const MAX_BODY = 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;
const NO_SERVICE_NOTE =
  "No lookup service is turned on. Set an ipinfo token or an AbuseIPDB key in this app's settings.";

const here = fileURLToPath(new URL('.', import.meta.url));
const APP_JS = readFileSync(`${here}app.js`, 'utf8');
const VERSION = JSON.parse(readFileSync(`${here}package.json`, 'utf8')).version;

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'";

function envValue(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function envFlag(env, name, fallback) {
  const v = envValue(env, name);
  if (v === undefined) return fallback;
  return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
}

function str(v) {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  return t.length > MAX_STRING ? t.slice(0, MAX_STRING) : t;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function compact(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

class LookupError extends Error {}

/** Fetches JSON with a timeout; errors are short messages that never carry upstream bodies or keys. */
async function getJson(fetchImpl, url, headers, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: globalThis.AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new LookupError('timed out');
    throw new LookupError('network error');
  }
  if (!res.ok) throw new LookupError(`HTTP ${Number(res.status) || 0}`);
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new LookupError('timed out');
    throw new LookupError('invalid response');
  }
  if (text.length > MAX_BODY) throw new LookupError('invalid response');
  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new LookupError('invalid response');
  }
}

export function mapIpinfo(data) {
  const out = { source: 'ipinfo', ok: true };
  out.country = str(data.country);
  out.region = str(data.region);
  out.city = str(data.city);
  const org = str(data.org);
  if (org) {
    const m = /^(AS\d+)\s+(.+)$/i.exec(org);
    if (m) {
      out.asn = m[1].toUpperCase();
      out.org = m[2];
    } else if (/^AS\d+$/i.test(org)) {
      out.asn = org.toUpperCase();
    } else {
      out.org = org;
    }
  }
  if (data.asn && typeof data.asn === 'object') {
    out.asn ??= str(data.asn.asn);
    out.org ??= str(data.asn.name);
  }
  out.hostname = str(data.hostname);
  const flags = [];
  const privacy = data.privacy && typeof data.privacy === 'object' ? data.privacy : {};
  for (const f of ['vpn', 'proxy', 'tor', 'relay', 'hosting']) if (privacy[f] === true) flags.push(f);
  if (data.bogon === true) flags.push('bogon');
  out.flags = flags;
  return compact(out);
}

export function mapAbuseipdb(body) {
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LookupError('invalid response');
  const out = { source: 'abuseipdb', ok: true };
  out.abuseScore = num(data.abuseConfidenceScore);
  out.reports = num(data.totalReports);
  out.lastReportedAt = str(data.lastReportedAt);
  out.usage = str(data.usageType);
  out.hostname = Array.isArray(data.hostnames) ? str(data.hostnames[0]) : undefined;
  out.country = str(data.countryCode);
  out.flags = data.isTor === true ? ['tor'] : [];
  return compact(out);
}

export function servicesFromEnv(env) {
  const ipinfoToken = envValue(env, 'IPINFO_TOKEN');
  const abuseKey = envValue(env, 'ABUSEIPDB_KEY');
  const services = [];
  if (envFlag(env, 'LOOKUP_IPINFO', true)) {
    services.push({
      source: 'ipinfo',
      authenticated: Boolean(ipinfoToken),
      async lookup(fetchImpl, ip, timeoutMs) {
        let url = `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
        if (ipinfoToken) url += `?token=${encodeURIComponent(ipinfoToken)}`;
        return mapIpinfo(await getJson(fetchImpl, url, { Accept: 'application/json' }, timeoutMs));
      },
    });
  }
  if (envFlag(env, 'LOOKUP_ABUSEIPDB', true) && abuseKey) {
    services.push({
      source: 'abuseipdb',
      authenticated: true,
      async lookup(fetchImpl, ip, timeoutMs) {
        const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`;
        return mapAbuseipdb(
          await getJson(fetchImpl, url, { Key: abuseKey, Accept: 'application/json' }, timeoutMs),
        );
      },
    });
  }
  return services;
}

function pageHtml(services) {
  const ipinfo = services.find((s) => s.source === 'ipinfo');
  const abuse = services.find((s) => s.source === 'abuseipdb');
  const line = (name, s, offText) =>
    `<li><strong>${name}</strong>: ${s ? (s.authenticated ? 'on' : 'on (no token, rate limited)') : offText}</li>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IP Lookup</title>
<style>
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#ffffff; --bad:#b91c1c; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#161514; --fg:#f5f5f4; --muted:#a8a29e; --line:#2e2c2a; --card:#1f1e1c; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:640px; margin:0 auto; padding:32px 16px; }
h1 { font-size:24px; font-weight:600; margin:0 0 8px; }
p, li { color:var(--muted); }
ul.services { padding-left:20px; margin:0 0 24px; }
form { display:flex; gap:8px; margin-bottom:24px; }
input { flex:1; min-width:0; padding:8px 12px; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:8px; }
button { padding:8px 16px; font:inherit; color:var(--bg); background:var(--fg); border:0; border-radius:8px; cursor:pointer; }
button:focus-visible, input:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
section.result { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
section.result h2 { font-size:16px; margin:0 0 8px; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:0; }
dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
.error { color:var(--bad); }
</style>
</head>
<body>
<main>
<h1>IP Lookup</h1>
<p>Looks up an address with online services. The address you type is sent to the services that are on.</p>
<ul class="services">
${line('ipinfo', ipinfo, 'off')}
${line('AbuseIPDB', abuse, 'off (needs a key)')}
</ul>
<form id="lookup" action="/v1/lookup" method="get">
<input id="ip" name="ip" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="203.0.113.5" aria-label="Address to look up" required>
<button type="submit">Look up</button>
</form>
<div id="out" aria-live="polite"></div>
</main>
<script src="/app.js"></script>
</body>
</html>
`;
}

/**
 * Builds the HTTP server. `fetch`, `env`, `now` and `timeoutMs` are injectable for tests.
 * @returns {http.Server}
 */
export function createServer({ fetch: fetchImpl = globalThis.fetch, env = process.env, now = Date.now, timeoutMs = 8000 } = {}) {
  const services = servicesFromEnv(env);
  const page = pageHtml(services);
  const cache = new Map();

  function cacheGet(ip) {
    const hit = cache.get(ip);
    if (!hit) return undefined;
    if (now() - hit.at > CACHE_TTL_MS) {
      cache.delete(ip);
      return undefined;
    }
    return hit.value;
  }

  function cacheSet(ip, value) {
    cache.delete(ip);
    cache.set(ip, { at: now(), value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function lookup(ip) {
    if (services.length === 0) return { format: 1, ip, results: [], note: NO_SERVICE_NOTE };
    const cached = cacheGet(ip);
    if (cached) return { ...cached, cached: true };
    const results = await Promise.all(
      services.map(async (s) => {
        try {
          return await s.lookup(fetchImpl, ip, timeoutMs);
        } catch (err) {
          const error = err instanceof LookupError ? err.message : 'invalid response';
          return { source: s.source, ok: false, error };
        }
      }),
    );
    const value = { format: 1, ip, results, cached: false };
    if (results.some((r) => r.ok)) cacheSet(ip, value);
    return value;
  }

  function send(req, res, status, type, body, extra = {}) {
    const buf = Buffer.from(body);
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const json = (req, res, status, obj, extra) =>
    send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      switch (url.pathname) {
        case '/healthz':
          json(req, res, 200, { ok: true });
          return;
        case '/':
          send(req, res, 200, 'text/html; charset=utf-8', page, {
            'Content-Security-Policy': PAGE_CSP,
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'SAMEORIGIN',
          });
          return;
        case '/app.js':
          send(req, res, 200, 'text/javascript; charset=utf-8', APP_JS);
          return;
        case '/v1/lookup': {
          const raw = (url.searchParams.get('ip') ?? '').trim();
          if (raw.length > 64 || isIP(raw) === 0) {
            json(req, res, 400, { error: 'ip must be an IPv4 or IPv6 address' });
            return;
          }
          const ip = raw.toLowerCase();
          json(req, res, 200, await lookup(ip));
          return;
        }
        default:
          json(req, res, 404, { error: 'not found' });
      }
    } catch {
      if (!res.headersSent) json(req, res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
  server.version = VERSION;
  return server;
}

function main() {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const names = servicesFromEnv(process.env).map((s) => s.source);
    console.log(`harbor-ip-lookup ${VERSION} listening on :${port} (services: ${names.join(', ') || 'none'})`);
  });
  const stop = (signal) => {
    console.log(`${signal}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
