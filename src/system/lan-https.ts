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
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { HarborError } from '../errors.js';
import { machineAddresses } from './lan.js';
import type { Ctx } from '../lifecycle/context.js';

// Console HTTPS port + deterministic per-app secure ports (no allocation, no
// migration: an app on HTTP hostPort P answers HTTPS on P + OFFSET).
// HARBOR_LAN_HTTPS_PORT / HARBOR_LAN_HTTPS_OFFSET exist for tests only: the
// product address is always https://harbor.local/ (443), which is what makes
// the "no warning, no port in the URL" promise true.
export const LAN_HTTPS_PORT = 443;
export const LAN_HTTPS_PORT_OFFSET = 20000;
export const HTTPS_SETTING = 'network.httpsEnabled';

export function consoleHttpsPort(): number {
  const raw = Number(process.env['HARBOR_LAN_HTTPS_PORT'] ?? LAN_HTTPS_PORT);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 65535 ? raw : LAN_HTTPS_PORT;
}
export function securePortOffset(): number {
  const raw = Number(process.env['HARBOR_LAN_HTTPS_OFFSET'] ?? LAN_HTTPS_PORT_OFFSET);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 60000 ? raw : LAN_HTTPS_PORT_OFFSET;
}

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
      hosts = JSON.parse(readFileSync(p.meta, 'utf8') as string).hosts ?? [];
    } catch {
      hosts = [];
    }
    return { fingerprint: ca.fingerprint256, expiresAt: leaf.validTo, caExpiresAt: ca.validTo, hosts };
  } catch {
    return null;
  }
}

function daysUntil(iso: string, now = Date.now()): number {
  return (new Date(iso).getTime() - now) / 86400000;
}

// Mint (or renew when expiring/changed): CA 10y self-signed, leaf 825d signed
// by it. Idempotent: returns the current state when it is fresh and covers hosts.
export async function ensureTlsCerts(stateDir: string, hosts: string[]): Promise<TlsState> {
  const p = P(stateDir);
  mkdirSync(tlsDir(stateDir), { recursive: true, mode: 0o700 });
  const cur = readTlsState(stateDir);
  const sameHosts = cur && hosts.length === cur.hosts.length && hosts.every((h) => cur.hosts.includes(h));
  if (cur && sameHosts && daysUntil(cur.expiresAt) > 30 && daysUntil(cur.caExpiresAt) > 30) return cur;
  const needCa = !cur || daysUntil(cur.caExpiresAt) <= 30;
  if (needCa) {
    await openssl(['req', '-x509', '-newkey', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', p.caKey, '-out', p.caCrt, '-days', '3650', '-sha256', '-subj', '/CN=Harbor Local CA']);
    chmodSync(p.caKey, 0o600);
  }
  await openssl(['ecparam', '-genkey', '-name', 'prime256v1', '-out', p.key]);
  chmodSync(p.key, 0o600);
  const csr = path.join(tlsDir(stateDir), 'server.csr');
  const ext = path.join(tlsDir(stateDir), 'server.ext');
  const srl = path.join(tlsDir(stateDir), 'ca.srl');
  try {
    await openssl(['req', '-new', '-key', p.key, '-out', csr, '-subj', '/CN=harbor.local']);
    writeFileSync(ext, sanExt(hosts), { mode: 0o600 });
    await openssl(['x509', '-req', '-in', csr, '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-out', p.crt, '-days', '825', '-sha256', '-extfile', ext]);
  } finally {
    rmSync(csr, { force: true });
    rmSync(ext, { force: true });
    rmSync(srl, { force: true });
  }
  writeFileSync(p.meta, JSON.stringify({ hosts, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
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
    server.listen({ host: '::', port }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

// Minimal reverse proxy to one loopback app port (headers + streaming +
// websocket upgrades). Apps stay plain HTTP on 127.0.0.1; only this listener
// speaks TLS, so Docker binds never move.
function proxyHandler(targetPort: number) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${targetPort}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' };
    delete headers['connection'];
    const up = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: headers as Record<string, string | string[]> }, (down) => {
      res.writeHead(down.statusCode ?? 502, down.headers);
      down.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('app not reachable');
    });
    req.pipe(up);
  };
}

function proxyUpgrade(server: HttpsServer, targetPort: number): void {
  server.on('upgrade', (req, socket) => {
    const sock = socket as Socket;
    const up = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } });
    up.on('upgrade', (_down, downSocket) => {
      const down = downSocket as Socket;
      sock.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      down.pipe(sock).pipe(down);
    });
    up.on('error', () => sock.destroy());
    up.end();
  });
}

export class LanHttpsServers {
  private servers = new Map<number, HttpsServer>();
  ports(): number[] {
    return [...this.servers.keys()].sort((a, b) => a - b);
  }
  async ensureConsole(appRouting: (req: never, res: never) => void, key: Buffer, cert: Buffer): Promise<void> {
    const port = consoleHttpsPort();
    if (this.servers.has(port)) return;
    const server = createHttpsServer({ key, cert }, (req, res) => appRouting(req as never, res as never));
    server.on('upgrade', (req, socket, head) => {
      const fastify = (appRouting as unknown as { server?: { emit: (e: string, ...a: unknown[]) => void } }).server;
      fastify?.emit('upgrade', req, socket, head);
    });
    await listen(server, port);
    this.servers.set(port, server);
  }
  async ensureAppProxy(securePort: number, targetPort: number, key: Buffer, cert: Buffer): Promise<void> {
    if (this.servers.has(securePort)) return;
    const server = createHttpsServer({ key, cert }, proxyHandler(targetPort));
    proxyUpgrade(server, targetPort);
    await listen(server, securePort);
    this.servers.set(securePort, server);
  }
  dropExcept(wanted: Set<number>): void {
    for (const [port, s] of this.servers) {
      if (!wanted.has(port)) {
        s.close();
        this.servers.delete(port);
      }
    }
  }
  async closeAll(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}

// Desired HTTPS surface from state: console 443 + one proxy per endpoint of
// every non-retained instance. Called at startup, on toggle, and every
// observer tick (cheap no-op when the signature matches).
export function lanHttpsSignature(ctx: Ctx): string {
  const on = ctx.config.lan.enabled && (ctx.repo.setting<boolean>(HTTPS_SETTING) ?? false);
  if (!on) return JSON.stringify({ on: false });
  const ports: number[] = [];
  for (const i of ctx.repo.listInstances()) {
    if (i.purgedAt) continue;
    for (const e of i.endpoints) ports.push(lanHttpsPort(e.hostPort));
  }
  const tls = readTlsState(ctx.config.stateDir);
  return JSON.stringify({ on: true, ports: ports.sort((a, b) => a - b), fp: tls?.fingerprint ?? null });
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
  const routing = (ctx as { __routing?: (req: never, res: never) => void }).__routing;
  if (routing) {
    try {
      await servers.ensureConsole(routing, pair.key, pair.cert);
    } catch (e) {
      ctx.log.warn(`LAN HTTPS console listener failed: ${(e as Error).message}`);
    }
  }
  const wanted = new Set<number>([consoleHttpsPort()]);
  for (const i of ctx.repo.listInstances()) {
    if (i.purgedAt) continue;
    for (const e of i.endpoints) {
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