// Harbor's app login (decision 194): a small reverse proxy Harbor puts in front of one endpoint of an app. It asks for
// the app's password on a Harbor page, keeps the browser signed in with a signed cookie, and passes everything else
// (WebSockets included) to the app unchanged. Scripts may send the password as HTTP basic auth instead (any user name).
//
// It runs from Harbor's own release folder (bind-mounted read-only) on a pinned official `node` image, with no
// dependencies. Configuration comes from the environment Harbor renders:
//   GATE_UPSTREAM       http://<service>:<port> of the app's endpoint
//   GATE_PASSWORD_HASH  scrypt:<N>:<r>:<p>:<salt hex>:<hash hex> (Harbor never hands the gate the password itself)
//   GATE_COOKIE_KEY     hex; signs the session cookie (a new password comes with a new key: everyone signs in again)
//   GATE_COOKIE         the cookie name (one per app and endpoint: apps on one host name share cookies across ports)
//   GATE_APP            the app's name, for the page
//   GATE_HEALTH_PATH    optional: Harbor's readiness path, answered without a login with the app's status code only
//   GATE_PORT           listen port (default 8080)
import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL, URLSearchParams } from 'node:url';

export const PREFIX = '/.harbor-gate';
const SESSION_SECONDS = 30 * 24 * 3600;
const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILURES_PER_CLIENT = 10;
const FAILURES_GLOBAL = 50;
// hop-by-hop headers are never forwarded (RFC 9110 §7.6.1); upgrade requests are handled on the raw socket
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// ---- pure helpers (tests import them)

export function hashPassword(password, salt, params = { N: 16384, r: 8, p: 1 }) {
  const hash = scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hex] = parts;
  const want = Buffer.from(hex, 'hex');
  if (!want.length || typeof password !== 'string' || password.length > 1024) return false;
  const have = scryptSync(password, Buffer.from(salt, 'hex'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return have.length === want.length && timingSafeEqual(have, want);
}

const mac = (key, data) => createHmac('sha256', Buffer.from(key, 'hex')).update(data).digest('base64url');

export function signSession(key, nowSeconds, seconds = SESSION_SECONDS) {
  const exp = String(nowSeconds + seconds);
  return `${exp}.${mac(key, `session:${exp}`)}`;
}

export function sessionValid(key, value, nowSeconds) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''));
  if (!m || Number(m[1]) <= nowSeconds) return false;
  const want = Buffer.from(mac(key, `session:${m[1]}`));
  const have = Buffer.from(m[2]);
  return want.length === have.length && timingSafeEqual(want, have);
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

// the Cookie header the app gets: everything but the gate's own cookie
export function withoutCookie(header, name) {
  if (!header) return header;
  const kept = String(header)
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.slice(0, p.indexOf('=')) !== name);
  return kept.length ? kept.join('; ') : undefined;
}

export function basicPassword(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(header ?? ''));
  if (!m) return null;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const i = text.indexOf(':');
  return i < 0 ? null : text.slice(i + 1);
}

// only a path on this same site: never another host (//evil, /\evil) or the gate's own pages
export function safeNext(next) {
  const v = String(next ?? '');
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.startsWith(PREFIX) || v.length > 2048) return '/';
  return v;
}

// a browser navigation gets the login page; anything else (scripts, fetch from the app's own page) gets a 401
export function wantsPage(req) {
  const accept = String(req.headers['accept'] ?? '');
  const mode = req.headers['sec-fetch-mode'];
  return (req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html') && (mode === undefined || mode === 'navigate');
}

export class FailureLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.byClient = new Map();
    this.all = [];
  }
  #recent(list) {
    const since = this.now() - FAILURE_WINDOW_MS;
    while (list.length && list[0] < since) list.shift();
    return list;
  }
  blocked(client) {
    return this.#recent(this.byClient.get(client) ?? []).length >= FAILURES_PER_CLIENT || this.#recent(this.all).length >= FAILURES_GLOBAL;
  }
  fail(client) {
    const list = this.byClient.get(client) ?? [];
    list.push(this.now());
    this.byClient.set(client, list);
    this.all.push(this.now());
    if (this.byClient.size > 10_000) this.byClient.clear();
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function loginPage({ app, next, error }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(app)} · Harbor</title>
<style>
:root { --bg: #f4f6f9; --card: #ffffff; --fg: #111823; --muted: #5b6878; --line: rgba(17, 24, 35, 0.12); --accent: #1f6feb; --accent-fg: #fff; --bad: #c62828; --focus: #9a6700; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1219; --card: #181f29; --fg: #eef2f7; --muted: #9aa8ba; --line: rgba(255, 255, 255, 0.12); --accent: #3d9cff; --bad: #ff6b6b; --focus: #ffd166; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 360px; }
.mark { width: 40px; height: 40px; color: var(--fg); margin-bottom: 24px; }
h1 { font-size: 26px; font-weight: 600; margin: 0 0 8px; letter-spacing: -0.01em; text-transform: lowercase; overflow-wrap: anywhere; }
p { margin: 0 0 24px; color: var(--muted); }
form { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; display: grid; gap: 16px; }
label { display: grid; gap: 8px; font-weight: 500; }
input { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); width: 100%; }
button { font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.error { color: var(--bad); margin: 0; }
footer { margin-top: 24px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<svg class="mark" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/></svg>
<h1>${esc(app)}</h1>
<p>This app asks for its password first.</p>
<form method="post" action="${PREFIX}/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>Password<input type="password" name="password" autocomplete="current-password" autofocus required></label>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<button type="submit">Open ${esc(app)}</button>
</form>
<footer>Protected by Harbor. The password is in the app's drawer in Harbor (Login).</footer>
</main>
</body>
</html>
`;
}

// ---- the server

export function createGate(env, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const upstream = new URL(env.GATE_UPSTREAM);
  const cookieName = env.GATE_COOKIE || 'harbor_gate';
  const key = env.GATE_COOKIE_KEY;
  const hash = env.GATE_PASSWORD_HASH;
  const app = env.GATE_APP || 'This app';
  const healthPath = env.GATE_HEALTH_PATH || null;
  if (!key || !/^[0-9a-f]{32,}$/i.test(key) || !hash) throw new Error('GATE_COOKIE_KEY and GATE_PASSWORD_HASH are required');
  const limiter = new FailureLimiter(now);
  const nowSeconds = () => Math.floor(now() / 1000);
  const clientOf = (req) => req.socket.remoteAddress ?? 'unknown';
  const secure = (req) => String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

  // signed in through the cookie, or (scripts) basic auth; the result says which, so the credential is not forwarded
  const authed = (req) => {
    if (sessionValid(key, parseCookies(req.headers['cookie']).get(cookieName), nowSeconds())) return 'cookie';
    const pw = basicPassword(req.headers['authorization']);
    if (pw === null) return null;
    if (limiter.blocked(clientOf(req))) return null;
    if (verifyPassword(pw, hash)) return 'basic';
    limiter.fail(clientOf(req));
    return null;
  };

  const forwardHeaders = (req, how) => {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
    const cookie = withoutCookie(req.headers['cookie'], cookieName);
    if (cookie) h['cookie'] = cookie;
    else delete h['cookie'];
    if (how === 'basic') delete h['authorization'];
    const fwd = req.headers['x-forwarded-for'];
    h['x-forwarded-for'] = fwd ? `${fwd}, ${clientOf(req)}` : clientOf(req);
    if (!req.headers['x-forwarded-proto']) h['x-forwarded-proto'] = 'http';
    if (!req.headers['x-forwarded-host'] && req.headers['host']) h['x-forwarded-host'] = req.headers['host'];
    return h;
  };

  const page = (res, status, html, extra = {}) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    });
    res.end(html);
  };

  const readForm = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
        if (body.length > 8192) req.destroy();
      });
      req.on('end', () => resolve(new URLSearchParams(body)));
      req.on('error', () => resolve(new URLSearchParams()));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://gate');

    if (url.pathname === `${PREFIX}/login`) {
      if (req.method === 'POST') {
        const form = await readForm(req);
        const next = safeNext(form.get('next'));
        if (limiter.blocked(clientOf(req))) return page(res, 429, loginPage({ app, next, error: 'Too many wrong passwords. Wait ten minutes, then try again.' }));
        if (!verifyPassword(form.get('password') ?? '', hash)) {
          limiter.fail(clientOf(req));
          return page(res, 401, loginPage({ app, next, error: 'That password is not right.' }));
        }
        const cookie = `${cookieName}=${signSession(key, nowSeconds())}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`;
        res.writeHead(303, { location: next, 'set-cookie': cookie, 'cache-control': 'no-store' });
        return res.end();
      }
      return page(res, 200, loginPage({ app, next: safeNext(url.searchParams.get('next')), error: null }));
    }
    if (url.pathname === `${PREFIX}/logout` && req.method === 'POST') {
      res.writeHead(303, { location: `${PREFIX}/login`, 'set-cookie': `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' });
      return res.end();
    }

    // Harbor's readiness probe: the app's status code, never its body
    if (healthPath && url.pathname === healthPath && !url.search && (req.method === 'GET' || req.method === 'HEAD')) {
      const probe = httpRequest({ host: upstream.hostname, port: upstream.port || 80, path: healthPath, method: 'GET', headers: { host: req.headers['host'] ?? upstream.host, 'user-agent': 'harbor-gate' }, timeout: 10_000 }, (up) => {
        up.resume();
        res.writeHead(up.statusCode ?? 502, { 'cache-control': 'no-store', 'content-length': '0' });
        res.end();
      });
      probe.on('timeout', () => probe.destroy(new Error('timeout')));
      probe.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-length': '0' });
        res.end();
      });
      return probe.end();
    }

    const how = authed(req);
    if (!how) {
      if (wantsPage(req)) {
        res.writeHead(303, { location: `${PREFIX}/login?next=${encodeURIComponent(safeNext(url.pathname + url.search))}`, 'cache-control': 'no-store' });
        return res.end();
      }
      // a browser's fetch gets no challenge (that would pop the browser's own dialog); a script does
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(req.headers['sec-fetch-mode'] ? {} : { 'www-authenticate': `Basic realm="${app.replace(/["\\]/g, '')}", charset="UTF-8"` }) });
      return res.end('This app asks for its password first.\n');
    }

    const up = httpRequest({ host: upstream.hostname, port: upstream.port || 80, method: req.method, path: req.url, headers: forwardHeaders(req, how) }, (ur) => {
      const headers = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) headers[k] = v;
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage, headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${app} is not answering yet.\n`);
    });
    req.pipe(up);
  });

  // WebSockets and other upgrades: the same login, then the raw connection
  server.on('upgrade', (req, socket, head) => {
    const how = authed(req);
    if (!how) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = connect(Number(upstream.port || 80), upstream.hostname, () => {
      const headers = forwardHeaders(req, how);
      headers['connection'] = 'Upgrade';
      headers['upgrade'] = req.headers['upgrade'];
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    const close = () => {
      target.destroy();
      socket.destroy();
    };
    // either side going away ends the other (a closed tab must not leave the app's socket open)
    target.on('error', close);
    socket.on('error', close);
    target.on('close', close);
    socket.on('close', close);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env['GATE_PORT'] || 8080);
  const server = createGate(process.env);
  server.listen(port, '0.0.0.0', () => process.stdout.write(`harbor gate: ${process.env['GATE_APP'] ?? ''} on :${port} -> ${process.env['GATE_UPSTREAM']}\n`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
