// LAN HTTPS: `https://harbor.local` with no warning after the operator trusts
// one certificate per device. Nothing phones home.
//
// Shape: Harbor mints its own local CA (EC P-256, openssl) on first enable,
// stores it under <stateDir>/tls (0600 keys), and issues one server cert for
// harbor.local + <hostname>.local + the machine's LAN addresses. The daemon
// terminates TLS itself (Node https): 443 for the console, and one reverse
// proxy per app endpoint on hostPort + OFFSET (deterministic, no DB change,
// no container rebind — Docker keeps its 0.0.0.0 HTTP binds).
//
// The console keeps its plain-HTTP listener on :80 too: that is where the
// first-visit banner lives (browsers show their own scary page for HTTPS
// first, which Harbor cannot style).
//
// Decision 167: the app relays are also the cookie firewall (cookie-firewall.ts), and with HTTPS only on, the
// :80 console redirects to https and apps re-render on 127.0.0.1 (the relay is then their only way in).
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import { hostname } from 'node:os';
import { HarborError } from '../errors.js';
import { HTTP_KEEP_PATHS } from '../exposure/caddy.js';
import { isLanPeer, isPrivateIPv4, machineAddresses } from './lan.js';
import { COOKIE_KEY_FILE, cookieTag, filterCookieHeader, isCrossAppRequest, loadCookieKey, rewriteSetCookies, sharedSetCookies, type CookieMode } from './cookie-firewall.js';
import type { Ctx } from '../lifecycle/context.js';

// Console HTTPS port + deterministic per-app secure ports (no allocation, no
// migration: an app on HTTP hostPort P answers HTTPS on P + OFFSET).
// HARBOR_LAN_HTTPS_PORT / HARBOR_LAN_HTTPS_OFFSET exist for tests only: the
// product address is always https://harbor.local/ (443), which is what makes
// the "no warning, no port in the URL" promise true.
export const LAN_HTTPS_PORT = 443;
export const LAN_HTTPS_PORT_OFFSET = 20000;
export const HTTPS_SETTING = 'network.httpsEnabled';
// Decision 167: HTTPS only — the plain-http console redirects to https and app ports stay on loopback, so the
// relay (and its cookie firewall) is the only way onto the network. Only meaningful while LAN HTTPS is on.
export const HTTPS_ONLY_SETTING = 'network.httpsOnly';

export function httpsOnlyOn(ctx: Pick<Ctx, 'config' | 'repo'>): boolean {
  return ctx.config.lan.enabled && (ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false) && (ctx.repo.setting<boolean>(HTTPS_ONLY_SETTING) ?? false);
}

// The two plain-http requests HTTPS only keeps answering: a new device downloads the CA, and the console's probe.
export const HTTP_KEEPS = HTTP_KEEP_PATHS;

// Where HTTPS only sends a plain-http console request (null = serve it as usual). Same host, same path.
export function httpsRedirectLocation(req: { method?: string | undefined; url?: string | undefined; headers: { host?: string | undefined } }, httpsPort = consoleHttpsPort()): string | null {
  const url = req.url ?? '/';
  if (req.method === 'GET' && HTTP_KEEPS.includes(url.split('?')[0]!)) return null;
  const host = (req.headers.host ?? '').trim();
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::\d+)?$/.exec(host);
  if (!m) return null; // no usable Host: the normal guards answer
  return `https://${m[1]}${httpsPort === 443 ? '' : `:${httpsPort}`}${url.startsWith('/') ? url : '/'}`;
}

export function consoleHttpsPort(): number {
  const raw = Number(process.env['HARBOR_LAN_HTTPS_PORT'] ?? LAN_HTTPS_PORT);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 65535 ? raw : LAN_HTTPS_PORT;
}
export function securePortOffset(): number {
  const raw = Number(process.env['HARBOR_LAN_HTTPS_OFFSET'] ?? LAN_HTTPS_PORT_OFFSET);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 60000 ? raw : LAN_HTTPS_PORT_OFFSET;
}

// Decision 196: tailnet addresses reach an app through a loopback relay on P + OFFSET, so they get the same cookie
// firewall as the secure LAN addresses (`tailscale serve` terminates TLS and forwards here).
export const TAILNET_RELAY_PORT_OFFSET = 10000;
export function tailnetRelayOffset(): number {
  const raw = Number(process.env['HARBOR_TAILNET_RELAY_OFFSET'] ?? TAILNET_RELAY_PORT_OFFSET);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 60000 ? raw : TAILNET_RELAY_PORT_OFFSET;
}
export function tailnetRelayPort(hostPort: number): number {
  const offset = tailnetRelayOffset();
  // a configured port range near the top of the port space counts down instead
  return hostPort + offset <= 65535 ? hostPort + offset : hostPort - offset;
}
export const tailnetServeTarget = (hostPort: number): string => `http://127.0.0.1:${tailnetRelayPort(hostPort)}`;

export function lanHttpsPort(hostPort: number): number {
  const p = hostPort + securePortOffset();
  if (p > 65535) throw new HarborError('INVALID_STATE', `no secure port for ${hostPort} (offset overflows)`);
  return p;
}

export function lanHttpsUrl(lanHost: string, hostPort: number): string {
  return `https://${lanHost}:${lanHttpsPort(hostPort)}/`;
}

export function lanHttpsConsoleUrl(lanHost: string): string {
  return `https://${lanHost}/`;
}

// Names the server cert must cover: harbor.local (the printed address),
// <hostname>.local + bare hostname, and every non-internal address so an IP
// opener gets no warning either.
export function lanHttpsHosts(host = hostname(), addresses: string[] = machineAddresses()): string[] {
  const h = host.toLowerCase().replace(/\.local$/, '');
  const out = new Set<string>(['harbor.local', `${h}.local`, h]);
  for (const a of addresses) {
    if (a.includes(':')) continue; // SAN IP entries below are IPv4 only
    if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) out.add(a);
  }
  return [...out];
}

export function sanExt(hosts: string[]): string {
  const parts = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`));
  return `subjectAltName=${parts.join(',')}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
}

const tlsDir = (stateDir: string) => path.join(stateDir, 'tls');
const P = (stateDir: string) => ({
  caKey: path.join(tlsDir(stateDir), 'ca.key'),
  caCrt: path.join(tlsDir(stateDir), 'ca.crt'),
  caMeta: path.join(tlsDir(stateDir), 'ca.json'),
  key: path.join(tlsDir(stateDir), 'server.key'),
  crt: path.join(tlsDir(stateDir), 'server.crt'),
  meta: path.join(tlsDir(stateDir), 'meta.json'),
});

function run(file: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new HarborError('UNSUPPORTED_CAPABILITY', 'openssl is not installed on this machine', { nextAction: 'Install openssl (sudo apt-get install openssl), then try again.' }));
        return;
      }
      resolve({ code: (err as { code?: number })?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

async function openssl(args: string[], input?: string): Promise<string> {
  const r = await run('/usr/bin/openssl', args, input).catch(() => run('openssl', args, input));
  if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `openssl ${args.slice(0, 3).join(' ')} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || r.stdout.slice(0, 300)}`);
  return r.stdout;
}

export interface TlsState {
  fingerprint: string; // SHA-256 of the CA cert, AA:BB:… (shown so the operator can compare)
  expiresAt: string; // server cert notAfter
  caExpiresAt: string;
  hosts: string[];
  caLimited: boolean; // decision 165: the CA can only sign .local names, its own host name and private addresses
}

// Decision 165: a device that trusts Harbor's CA must not trust it for the whole internet. The CA is minted with
// critical name constraints (`local`, the machine's bare name, private IPv4 ranges) and pathlen:0, so even its
// leaked key could not sign a certificate for a bank or a mail provider that a trusting device would accept.
const PRIVATE_V4 = ['10.0.0.0/255.0.0.0', '172.16.0.0/255.240.0.0', '192.168.0.0/255.255.0.0', '169.254.0.0/255.255.0.0', '100.64.0.0/255.192.0.0'];
export function caConfig(bareHost: string): string {
  const dns = ['local', ...(/^[a-z0-9-]{1,63}$/.test(bareHost) && bareHost !== 'local' ? [bareHost] : [])];
  const permitted = [...dns.map((d) => `permitted;DNS:${d}`), ...PRIVATE_V4.map((r) => `permitted;IP:${r}`)].join(',');
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = v3_ca',
    '[dn]',
    'CN = Harbor Local CA',
    '[v3_ca]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    `nameConstraints = critical,${permitted}`,
    '',
  ].join('\n');
}
// The names a constrained CA may sign: what the server cert then covers (others would void the whole cert).
export function signableHosts(hosts: string[], bareHost: string): string[] {
  return hosts.filter((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? isPrivateIPv4(h) : h === 'local' || h.endsWith('.local') || h === bareHost));
}
interface CaMeta {
  limited: boolean;
  bareHost: string;
}

export function fingerprintOfPem(pem: string): string {
  const cert = new X509Certificate(pem);
  return cert.fingerprint256;
}

export function readTlsState(stateDir: string): TlsState | null {
  const p = P(stateDir);
  try {
    if (!existsSync(p.caCrt) || !existsSync(p.crt)) return null;
    const ca = new X509Certificate(readFileSync(p.caCrt));
    const leaf = new X509Certificate(readFileSync(p.crt));
    let hosts: string[] = [];
    try {
      const meta = JSON.parse(readFileSync(p.meta, 'utf8') as string) as { hosts?: string[]; covered?: string[] };
      hosts = meta.covered ?? meta.hosts ?? [];
    } catch {
      hosts = [];
    }
    return { fingerprint: ca.fingerprint256, expiresAt: leaf.validTo, caExpiresAt: ca.validTo, hosts, caLimited: readCaMeta(stateDir)?.limited === true };
  } catch {
    return null;
  }
}

function readCaMeta(stateDir: string): CaMeta | null {
  try {
    const m = JSON.parse(readFileSync(P(stateDir).caMeta, 'utf8')) as Partial<CaMeta>;
    return typeof m.bareHost === 'string' ? { limited: m.limited === true, bareHost: m.bareHost } : null;
  } catch {
    return null;
  }
}

function daysUntil(iso: string, now = Date.now()): number {
  return (new Date(iso).getTime() - now) / 86400000;
}

// Mint (or renew when expiring/changed): CA 10y self-signed, leaf 825d signed
// by it. Idempotent: returns the current state when it is fresh and covers hosts.
// The tls/ dir is 0750 and the server cert/key 0640 (group-readable): when Caddy
// (the public proxy) is installed it terminates TLS for the LAN hostnames and must
// read the server key. The group is `harbor`; bootstrap adds the caddy user to it.
// The CA key stays 0600 — Caddy never needs it.
export async function ensureTlsCerts(stateDir: string, hosts: string[], opts: { replaceCa?: boolean } = {}): Promise<TlsState> {
  const p = P(stateDir);
  mkdirSync(tlsDir(stateDir), { recursive: true, mode: 0o750 });
  // mkdir's mode is masked by the service's UMask=0077 (the dir came out 0700 and Caddy could not read the
  // cert, which wedged Caddy on a real host): set it explicitly, which also repairs a dir made before.
  chmodSync(tlsDir(stateDir), 0o750);
  const cur = readTlsState(stateDir);
  let requested: string[] = [];
  try {
    requested = (JSON.parse(readFileSync(p.meta, 'utf8')) as { hosts?: string[] }).hosts ?? [];
  } catch {
    requested = [];
  }
  const sameHosts = cur && hosts.length === requested.length && hosts.every((h) => requested.includes(h));
  if (cur && sameHosts && !opts.replaceCa && daysUntil(cur.expiresAt) > 30 && daysUntil(cur.caExpiresAt) > 30) return cur;
  const needCa = !cur || opts.replaceCa === true || daysUntil(cur.caExpiresAt) <= 30;
  const bareHost = hostname().toLowerCase().replace(/\.local$/, '');
  if (needCa) {
    const cnf = path.join(tlsDir(stateDir), 'ca.cnf');
    writeFileSync(cnf, caConfig(bareHost), { mode: 0o600 });
    try {
      await openssl(['req', '-x509', '-newkey', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', p.caKey, '-out', p.caCrt, '-days', '3650', '-sha256', '-config', cnf]);
    } finally {
      rmSync(cnf, { force: true });
    }
    chmodSync(p.caKey, 0o600);
    writeFileSync(p.caMeta, JSON.stringify({ limited: true, bareHost } satisfies CaMeta) + '\n', { mode: 0o600 });
  }
  const ca = readCaMeta(stateDir);
  const covered = ca?.limited ? signableHosts(hosts, ca.bareHost) : hosts;
  await openssl(['ecparam', '-genkey', '-name', 'prime256v1', '-out', p.key]);
  chmodSync(p.key, 0o640);
  const csr = path.join(tlsDir(stateDir), 'server.csr');
  const ext = path.join(tlsDir(stateDir), 'server.ext');
  const srl = path.join(tlsDir(stateDir), 'ca.srl');
  try {
    await openssl(['req', '-new', '-key', p.key, '-out', csr, '-subj', '/CN=harbor.local']);
    writeFileSync(ext, sanExt(covered), { mode: 0o600 });
    await openssl(['x509', '-req', '-in', csr, '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-out', p.crt, '-days', '825', '-sha256', '-extfile', ext]);
  } finally {
    rmSync(csr, { force: true });
    rmSync(ext, { force: true });
    rmSync(srl, { force: true });
  }
  chmodSync(p.crt, 0o640);
  writeFileSync(p.meta, JSON.stringify({ hosts, covered, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const st = readTlsState(stateDir);
  if (!st) throw new HarborError('OPERATION_FAILED', 'certificate generation produced no readable cert');
  return st;
}

export function caPem(stateDir: string): string {
  const pem = readFileSync(P(stateDir).caCrt, 'utf8');
  if (!pem.includes('BEGIN CERTIFICATE')) throw new HarborError('NOT_FOUND', 'no local certificate authority yet');
  return pem;
}

export function tlsKeyPair(stateDir: string): { key: Buffer; cert: Buffer } {
  const p = P(stateDir);
  return { key: readFileSync(p.key), cert: readFileSync(p.crt) };
}

// ---- servers (daemon-owned; closed on disable/shutdown)

// Decision 165: these listeners are for the local network. A peer from anywhere else (a forwarded port, a
// public address) is dropped before TLS or HTTP, whatever Host it would send.
export function refuseNonLanPeers(server: { on(event: 'connection', fn: (s: Socket) => void): unknown }): void {
  server.on('connection', (s: Socket) => {
    if (!isLanPeer(s.remoteAddress)) s.destroy();
  });
}

function listen(server: HttpsServer | HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new HarborError('PORT_CONFLICT', `port ${port} is already in use`, { nextAction: port === LAN_HTTPS_PORT ? 'Another service (for example Caddy with the public proxy) owns port 443. Stop it or turn LAN HTTPS off.' : `Free port ${port}, then turn LAN HTTPS off and on again.` }));
        return;
      }
      reject(e);
    };
    server.once('error', onError);
    refuseNonLanPeers(server);
    server.listen({ host: '::', port }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

// What the app sees: the client's own forwarding headers are dropped (an app trusting loopback would take a
// forged client address), and the relay states the real peer, scheme and host (decision 165).
const CLIENT_FORWARDING = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'proxy-connection', 'keep-alive', 'te', 'trailer'];
export function forwardHeaders(req: Pick<IncomingMessage, 'headers' | 'socket'>, targetPort: number): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  for (const h of CLIENT_FORWARDING) delete headers[h];
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:(?=\d+\.)/, '');
  return { ...headers, host: `127.0.0.1:${targetPort}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '', ...(peer ? { 'x-forwarded-for': peer } : {}) };
}

// Decision 167: what the relay knows about one secure port (the instance's cookie tag and mode) and about every
// Harbor endpoint port on the machine (plain and secure twin -> tag), for the cross-app request guard.
export interface RelayEndpoint {
  tag: string;
  cookies: CookieMode;
  label: string; // for the one-line oversize warning (never a cookie value)
}
export interface RelayPolicy {
  key: Buffer;
  bySecurePort: ReadonlyMap<number, RelayEndpoint>;
  portTags: ReadonlyMap<number, string>;
}
type PortPolicy = { key: Buffer; ep: RelayEndpoint; portTags: ReadonlyMap<number, string> } | null;
interface Relay {
  policy(securePort: number): PortPolicy;
  isolatedNames(tag: string): ReadonlySet<string>;
  learned(ep: RelayEndpoint, r: ReturnType<typeof rewriteSetCookies>): void;
  // decision 196: behind `tailscale serve`, which already states the real peer, scheme and host: headers pass as they are
  readonly passThrough: boolean;
}

const FORBIDDEN_BODY = 'Refused: this request came from another app on this Harbor.\n';

// `untagged`: the untagged cookie names the request carried, so the response can clear an older untagged copy of a
// name the app now holds signed. A `shared` endpoint gets no shadow check: the names its instance's isolated
// endpoints set are not its own (they share the jar's untagged names on purpose).
function filteredHeaders(req: IncomingMessage, targetPort: number, pol: PortPolicy, relay: Relay): { headers: Record<string, string | string[] | undefined>; untagged: ReadonlySet<string> } {
  const headers = relay.passThrough ? { ...req.headers } : forwardHeaders(req, targetPort);
  if (!pol) return { headers, untagged: new Set() };
  const isolated = pol.ep.cookies === 'isolated';
  const f = filterCookieHeader(req.headers.cookie, { tag: isolated ? pol.ep.tag : null, key: pol.key, ...(isolated ? { isolatedNames: relay.isolatedNames(pol.ep.tag) } : {}) });
  if (f.cookie) headers['cookie'] = f.cookie;
  else delete headers['cookie'];
  return { headers, untagged: new Set(f.untagged) };
}

function rewrittenSetCookies(value: string | string[] | undefined, pol: PortPolicy, relay: Relay, untagged: ReadonlySet<string>): string[] | undefined {
  if (value === undefined) return undefined;
  if (!pol) return Array.isArray(value) ? value : [value];
  // a shared endpoint's cookies pass untagged, but never one named like another app's signed cookie
  if (pol.ep.cookies !== 'isolated') return sharedSetCookies(value).headers;
  const r = rewriteSetCookies(value, { tag: pol.ep.tag, key: pol.key, untaggedInRequest: untagged });
  relay.learned(pol.ep, r);
  return r.headers;
}

const secFetchSite = (req: IncomingMessage) => (Array.isArray(req.headers['sec-fetch-site']) ? req.headers['sec-fetch-site'][0] : req.headers['sec-fetch-site']);

// Minimal reverse proxy to one loopback app port (headers + streaming +
// websocket upgrades). Apps stay plain HTTP on 127.0.0.1; only this listener
// speaks TLS, so Docker binds never move. Decision 167: cookies are filtered both ways and a state-changing
// request from another Harbor app's page is refused.
function proxyHandler(targetPort: number, securePort: number, relay: Relay) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pol = relay.policy(securePort);
    if (pol && isCrossAppRequest({ method: req.method, origin: req.headers.origin, host: req.headers.host, secFetchSite: secFetchSite(req) }, pol.ep.tag, pol.portTags)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FORBIDDEN_BODY);
      req.resume();
      return;
    }
    const { headers, untagged } = filteredHeaders(req, targetPort, pol, relay);
    delete headers['connection'];
    const up = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: headers as Record<string, string | string[]> }, (down) => {
      const out = { ...down.headers };
      // Every app shares the machine's name here (harbor.local:<port>), and HSTS pins a whole host, every port:
      // one app's Strict-Transport-Security (Trilium sends a year with includeSubDomains) would turn every plain
      // http:// app address on this machine into a TLS error in that browser. Only the relay knows the host is shared.
      delete out['strict-transport-security'];
      const cookies = rewrittenSetCookies(down.headers['set-cookie'], pol, relay, untagged);
      if (cookies) out['set-cookie'] = cookies;
      res.writeHead(down.statusCode ?? 502, out);
      down.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('app not reachable');
    });
    req.pipe(up);
  };
}

// The app's own 101 goes back verbatim: browsers drop a handshake without its
// Sec-WebSocket-Accept (a hand-written 101 broke Open WebUI over https). Bytes
// that arrived with either handshake (`head`) are forwarded, and a refusal
// (403, 400, …) is relayed instead of leaving the browser hanging.
function rawHead(statusLine: string, rawHeaders: string[], cookies?: (v: string[]) => string[] | undefined): string {
  let out = statusLine + '\r\n';
  const setCookies: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (cookies && rawHeaders[i]!.toLowerCase() === 'set-cookie') setCookies.push(rawHeaders[i + 1]!);
    else out += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  for (const c of (cookies && setCookies.length ? cookies(setCookies) : undefined) ?? setCookies) out += `Set-Cookie: ${c}\r\n`;
  return out + '\r\n';
}

function proxyUpgrade(server: HttpsServer | HttpServer, targetPort: number, securePort: number, relay: Relay): void {
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const sock = socket as Socket;
    sock.on('error', () => sock.destroy());
    const pol = relay.policy(securePort);
    if (pol && isCrossAppRequest({ method: req.method, origin: req.headers.origin, host: req.headers.host, upgrade: true, secFetchSite: secFetchSite(req) }, pol.ep.tag, pol.portTags)) {
      sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(FORBIDDEN_BODY)}\r\nconnection: close\r\n\r\n${FORBIDDEN_BODY}`);
      return;
    }
    const { headers, untagged } = filteredHeaders(req, targetPort, pol, relay);
    const cookies = (v: string[]) => rewrittenSetCookies(v, pol, relay, untagged);
    const up = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: headers as Record<string, string | string[]>, agent: false });
    up.on('upgrade', (down, downSocket, downHead) => {
      const d = downSocket as Socket;
      d.on('error', () => sock.destroy());
      sock.on('close', () => d.destroy());
      d.on('close', () => sock.destroy());
      sock.write(rawHead(`HTTP/1.1 ${down.statusCode ?? 101} ${down.statusMessage ?? 'Switching Protocols'}`, down.rawHeaders, cookies));
      if (downHead.length) sock.write(downHead);
      if (head.length) d.write(head);
      d.pipe(sock).pipe(d);
    });
    up.on('response', (down) => {
      sock.write(rawHead(`HTTP/1.1 ${down.statusCode ?? 502} ${down.statusMessage ?? ''}`, down.rawHeaders, cookies));
      down.pipe(sock);
    });
    up.on('error', () => sock.destroy());
    up.end();
  });
}

// server.close() waits for every socket, upgraded WebSockets included (they
// never finish on their own): track them so close ends them too.
function shut(server: HttpsServer | HttpServer, done?: () => void): void {
  server.close(() => done?.());
  for (const s of (server as (HttpsServer | HttpServer) & { harborSockets?: Set<Socket> }).harborSockets ?? []) s.destroy();
}

function track<S extends HttpsServer | HttpServer>(server: S, event: 'secureConnection' | 'connection' = 'secureConnection'): S {
  const sockets = new Set<Socket>();
  (server as S & { harborSockets?: Set<Socket> }).harborSockets = sockets;
  (server as HttpServer).on(event as 'connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return server;
}

export class LanHttpsServers implements Relay {
  private servers = new Map<number, HttpsServer | HttpServer>();
  constructor(readonly passThrough = false) {}
  private relayPolicy: RelayPolicy | null = null;
  private names = new Map<string, Set<string>>(); // tag -> names the app set HttpOnly since the daemon started
  private warnedOversize = new Set<string>();
  warn: (message: string) => void = () => undefined;
  // Decision 167: set on every reconcile, read per request (a proxy outlives one policy). A port without a policy
  // entry is relayed as before (only tests do that: reconcile always sets the policy first).
  setPolicy(policy: RelayPolicy | null): void {
    this.relayPolicy = policy;
  }
  policy(securePort: number): PortPolicy {
    const p = this.relayPolicy;
    const ep = p?.bySecurePort.get(securePort);
    return p && ep ? { key: p.key, ep, portTags: p.portTags } : null;
  }
  isolatedNames(tag: string): ReadonlySet<string> {
    return this.names.get(tag) ?? new Set();
  }
  learned(ep: RelayEndpoint, r: ReturnType<typeof rewriteSetCookies>): void {
    let set = this.names.get(ep.tag);
    if (!set) this.names.set(ep.tag, (set = new Set()));
    for (const n of r.plainNames) set.delete(n);
    for (const n of r.isolatedNames) if (set.size < 64) set.add(n);
    if (r.oversize.length && !this.warnedOversize.has(ep.tag)) {
      this.warnedOversize.add(ep.tag);
      this.warn(`${ep.label} set a cookie too large to isolate (${r.oversize.join(', ')}); it is passed unchanged, so other apps on this Harbor can receive it`);
    }
  }
  ports(): number[] {
    return [...this.servers.keys()].sort((a, b) => a - b);
  }
  async ensureConsole(appRouting: (req: never, res: never) => void, key: Buffer, cert: Buffer): Promise<void> {
    const port = consoleHttpsPort();
    if (this.servers.has(port)) return;
    const server = track(createHttpsServer({ key, cert }, (req, res) => appRouting(req as never, res as never)));
    server.on('upgrade', (req, socket, head) => {
      const fastify = (appRouting as unknown as { server?: { emit: (e: string, ...a: unknown[]) => void } }).server;
      fastify?.emit('upgrade', req, socket, head);
    });
    await listen(server, port);
    this.servers.set(port, server);
  }
  async ensureAppProxy(securePort: number, targetPort: number, key: Buffer, cert: Buffer): Promise<void> {
    if (this.servers.has(securePort)) return;
    const server = track(createHttpsServer({ key, cert }, proxyHandler(targetPort, securePort, this)));
    proxyUpgrade(server, targetPort, securePort, this);
    await listen(server, securePort);
    this.servers.set(securePort, server);
  }
  // Decision 196: plain http on loopback only; `tailscale serve` is its one client.
  async ensureTailnetProxy(relayPort: number, targetPort: number): Promise<void> {
    if (this.servers.has(relayPort)) return;
    const server = track(createHttpServer(proxyHandler(targetPort, relayPort, this)), 'connection');
    proxyUpgrade(server, targetPort, relayPort, this);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: relayPort }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.servers.set(relayPort, server);
  }
  dropExcept(wanted: Set<number>): void {
    for (const [port, s] of this.servers) {
      if (!wanted.has(port)) {
        shut(s);
        this.servers.delete(port);
      }
    }
  }
  async closeAll(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => new Promise<void>((r) => shut(s, r))));
  }
}

// Decision 165: only an endpoint Docker publishes on every interface gets a LAN HTTPS twin. An app rendered
// while LAN mode was off (decision 71) stays on 127.0.0.1, and the relay must not open it to the network.
// Decision 167: an app rendered while HTTPS only was on is on 127.0.0.1 too, but its runtime file says
// `x-harbor.lanAccess: relay` — the relay is its way onto the network, so its ports are served as well.
export type RuntimeLanAccess = 'lan' | 'relay' | 'loopback';
const boundCache = new Map<string, { mtimeMs: number; ports: Set<number>; access: RuntimeLanAccess }>();
function runtimeBinding(stateDir: string, instanceId: string): { ports: Set<number>; access: RuntimeLanAccess } | null {
  const file = path.join(stateDir, 'instances', instanceId, 'runtime', 'compose.yaml');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = boundCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const ports = new Set<number>();
  let access: RuntimeLanAccess = 'loopback';
  try {
    const doc = parseYaml(readFileSync(file, 'utf8')) as { 'x-harbor'?: { lanAccess?: string }; services?: Record<string, { ports?: { published?: string | number; host_ip?: string; protocol?: string }[] }> };
    const relay = doc['x-harbor']?.lanAccess === 'relay';
    for (const svc of Object.values(doc.services ?? {}))
      for (const p of svc.ports ?? []) {
        if ((p.protocol ?? 'tcp') !== 'tcp') continue;
        if (p.host_ip === '0.0.0.0') {
          ports.add(Number(p.published));
          access = 'lan';
        } else if (relay && p.host_ip === '127.0.0.1') ports.add(Number(p.published));
      }
    if (relay && access === 'loopback') access = 'relay';
  } catch {
    /* unreadable: nothing is LAN-bound */
  }
  const entry = { mtimeMs, ports, access };
  boundCache.set(file, entry);
  return entry;
}
export function lanBoundPorts(stateDir: string, instanceId: string): Set<number> {
  return runtimeBinding(stateDir, instanceId)?.ports ?? new Set();
}
// How a rendered app reaches the network: on every interface, through the relay only, or not at all (null = not rendered).
export function runtimeLanAccess(stateDir: string, instanceId: string): RuntimeLanAccess | null {
  return runtimeBinding(stateDir, instanceId)?.access ?? null;
}

// Decision 167: endpoints.<id>.cookies from the instance's release snapshot (default isolated), cached by mtime.
const cookieModeCache = new Map<string, { mtimeMs: number; modes: Record<string, CookieMode> }>();
export function endpointCookieModes(stateDir: string, instanceId: string): Record<string, CookieMode> {
  const file = path.join(stateDir, 'instances', instanceId, 'release', 'manifest.yaml');
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  const hit = cookieModeCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.modes;
  const modes: Record<string, CookieMode> = {};
  try {
    const doc = parseYaml(readFileSync(file, 'utf8')) as { endpoints?: Record<string, { cookies?: unknown } | null> };
    for (const [id, e] of Object.entries(doc.endpoints ?? {})) modes[id] = e?.cookies === 'shared' ? 'shared' : 'isolated';
  } catch {
    /* unreadable: every endpoint stays isolated */
  }
  cookieModeCache.set(file, { mtimeMs, modes });
  return modes;
}

function securePortOrNull(hostPort: number): number | null {
  try {
    return lanHttpsPort(hostPort);
  } catch {
    return null;
  }
}

// Decision 167: the cookie tag and mode of every secure port, and the tag of every Harbor endpoint port.
export function relayEndpoints(ctx: Pick<Ctx, 'config' | 'repo'>): { bySecurePort: Map<number, RelayEndpoint>; portTags: Map<number, string> } {
  const bySecurePort = new Map<number, RelayEndpoint>();
  const portTags = new Map<number, string>();
  for (const i of ctx.repo.listInstances()) {
    if (i.purgedAt) continue;
    const tag = cookieTag(i.id);
    const modes = endpointCookieModes(ctx.config.stateDir, i.id);
    for (const e of i.endpoints) {
      portTags.set(e.hostPort, tag);
      const sp = securePortOrNull(e.hostPort);
      if (sp === null) continue;
      portTags.set(sp, tag);
      bySecurePort.set(sp, { tag, cookies: modes[e.id] ?? 'isolated', label: i.displayName ?? i.name });
    }
  }
  return { bySecurePort, portTags };
}

// Decision 196: the relay behind each tailnet address: the same cookie tag and mode as the app's secure LAN port, and
// the tailnet ports join the cross-app guard's map (every tailnet address shares the node's one name).
export function tailnetRelayEndpoints(ctx: Pick<Ctx, 'config' | 'repo'>): { byRelayPort: Map<number, { endpoint: RelayEndpoint; target: number }>; portTags: Map<number, string> } {
  const byRelayPort = new Map<number, { endpoint: RelayEndpoint; target: number }>();
  const portTags = new Map(relayEndpoints(ctx).portTags);
  for (const e of ctx.repo.exposures()) {
    if (e.via !== 'tailnet') continue;
    const i = ctx.repo.instance(e.instanceId);
    const alloc = i?.endpoints.find((x) => x.id === e.endpointId);
    if (!i || !alloc || i.purgedAt) continue;
    const tag = cookieTag(i.id);
    portTags.set(e.port, tag);
    let relayPort: number;
    try {
      relayPort = tailnetRelayPort(alloc.hostPort);
    } catch {
      continue;
    }
    const modes = endpointCookieModes(ctx.config.stateDir, i.id);
    byRelayPort.set(relayPort, { endpoint: { tag, cookies: modes[e.endpointId] ?? 'isolated', label: i.displayName ?? i.name }, target: alloc.hostPort });
  }
  return { byRelayPort, portTags };
}

export function tailnetRelaySignature(ctx: Pick<Ctx, 'config' | 'repo'>): string {
  const { byRelayPort, portTags } = tailnetRelayEndpoints(ctx);
  return JSON.stringify({ relays: [...byRelayPort].map(([p, r]) => `${p}:${r.target}:${r.endpoint.tag}:${r.endpoint.cookies}`).sort(), tags: [...portTags].map(([p, t]) => `${p}:${t}`).sort(), key: cookieKeyState(ctx.config.stateDir) });
}

// Decision 196: fail closed like the LAN relays: without the firewall's key a tailnet address answers nothing.
export async function reconcileTailnetRelays(ctx: Ctx): Promise<void> {
  const servers = ctx.tailnetRelays;
  if (!servers) return;
  const { byRelayPort, portTags } = tailnetRelayEndpoints(ctx);
  if (!byRelayPort.size) {
    await servers.closeAll();
    return;
  }
  let key: Buffer;
  try {
    key = loadCookieKey(ctx.config.stateDir);
  } catch (e) {
    ctx.log.warn(`Tailscale app addresses are closed: the cookie firewall key is unusable (${(e as Error).message})`);
    servers.setPolicy(null);
    await servers.closeAll();
    return;
  }
  servers.warn = (m) => ctx.log.warn(m);
  servers.setPolicy({ key, bySecurePort: new Map([...byRelayPort].map(([p, r]) => [p, r.endpoint])), portTags });
  for (const [port, r] of byRelayPort) {
    try {
      await servers.ensureTailnetProxy(port, r.target);
    } catch (err) {
      ctx.log.warn(`Tailscale relay :${port} failed: ${(err as Error).message}`);
    }
  }
  servers.dropExcept(new Set(byRelayPort.keys()));
}

// Desired HTTPS surface from state: console 443 + one proxy per LAN-bound endpoint of
// every non-retained instance. Called at startup, on toggle, and every
// observer tick (cheap no-op when the signature matches).
export function lanHttpsSignature(ctx: Ctx): string {
  const on = ctx.config.lan.enabled && (ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false);
  if (!on) return JSON.stringify({ on: false });
  const ports: number[] = [];
  for (const i of ctx.repo.listInstances()) {
    if (i.purgedAt) continue;
    const bound = lanBoundPorts(ctx.config.stateDir, i.id);
    for (const e of i.endpoints) if (bound.has(e.hostPort)) ports.push(lanHttpsPort(e.hostPort));
  }
  const tls = readTlsState(ctx.config.stateDir);
  // decision 167: a new instance or a changed `cookies:` mode changes the relay's policy, not only its ports
  const relay = [...relayEndpoints(ctx).bySecurePort].map(([p, e]) => `${p}:${e.tag}:${e.cookies}`).sort();
  return JSON.stringify({ on: true, ports: ports.sort((a, b) => a - b), fp: tls?.fingerprint ?? null, relay, key: cookieKeyState(ctx.config.stateDir) });
}

// Part of the signature: a reconcile that closed the app relays over an unusable key is retried once the operator
// fixes or deletes the file (the key file's size and mtime change), not only after a restart.
function cookieKeyState(stateDir: string): string {
  try {
    const st = statSync(path.join(stateDir, COOKIE_KEY_FILE));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

export async function reconcileLanHttps(ctx: Ctx): Promise<void> {
  const servers = ctx.lanHttps;
  if (!servers) return;
  const on = ctx.config.lan.enabled && (ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false);
  if (!on) {
    await servers.closeAll();
    return;
  }
  let pair: { key: Buffer; cert: Buffer };
  try {
    pair = tlsKeyPair(ctx.config.stateDir);
  } catch {
    ctx.log.warn('LAN HTTPS is on but no certificate exists yet; turn it off and on again to mint one');
    return;
  }
  // When Caddy (the public proxy) is installed it owns :443 and terminates TLS for the LAN hostnames
  // itself (see caddyLanHttps in runner.ts) — the daemon must not try to bind 443 too. App proxies on
  // hostPort + OFFSET are still served by the daemon (Caddy only proxies the console, not app endpoints).
  let caddyOwns443 = false;
  try {
    caddyOwns443 = await ctx.caddy.available();
  } catch {
    /* Caddy unreachable: the daemon keeps its own 443 listener */
  }
  const routing = (ctx as { __routing?: (req: never, res: never) => void }).__routing;
  if (routing && !caddyOwns443) {
    try {
      await servers.ensureConsole(routing, pair.key, pair.cert);
    } catch (e) {
      ctx.log.warn(`LAN HTTPS console listener failed: ${(e as Error).message}`);
    }
  }
  const wanted = new Set<number>(caddyOwns443 ? [] : [consoleHttpsPort()]);
  // Decision 167: no app relay without the cookie firewall's key (fail closed; the console keeps working).
  let cookieKey: Buffer;
  try {
    cookieKey = loadCookieKey(ctx.config.stateDir);
  } catch (e) {
    ctx.log.warn(`LAN HTTPS app addresses are closed: the cookie firewall key is unusable (${(e as Error).message})`);
    servers.setPolicy(null);
    servers.dropExcept(wanted);
    return;
  }
  servers.warn = (m) => ctx.log.warn(m);
  servers.setPolicy({ key: cookieKey, ...relayEndpoints(ctx) });
  for (const i of ctx.repo.listInstances()) {
    if (i.purgedAt) continue;
    const bound = lanBoundPorts(ctx.config.stateDir, i.id);
    for (const e of i.endpoints) {
      if (!bound.has(e.hostPort)) continue;
      const sp = lanHttpsPort(e.hostPort);
      wanted.add(sp);
      try {
        await servers.ensureAppProxy(sp, e.hostPort, pair.key, pair.cert);
      } catch (err) {
        ctx.log.warn(`LAN HTTPS proxy :${sp} failed: ${(err as Error).message}`);
      }
    }
  }
  servers.dropExcept(wanted);
}