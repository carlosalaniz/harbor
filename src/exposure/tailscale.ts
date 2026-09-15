import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { HarborError } from '../errors.js';

// Tailscale provider: node status and `tailscale serve` entries. Runs the CLI with an argument array
// and a scrubbed environment; the harbor user is made a tailscale operator at bootstrap so no root
// is needed. Nothing here touches the tailnet admin console.

export interface TailscaleStatus {
  backendState: string; // Running | NeedsLogin | Stopped | ...
  online: boolean;
  dnsName: string | null; // host.tailnet.ts.net (no trailing dot)
  tailnet: string | null;
  magicDnsEnabled: boolean;
  httpsEnabled: boolean; // CertDomains non-empty
  tailscaleIps: string[];
  keyExpiry: string | null; // node key expiry (RFC 3339) from `Self.KeyExpiry`
}

export interface ServeEntry {
  port: number;
  target: string; // http://127.0.0.1:<port>
}

export interface TailscaleProvider {
  readonly description: string;
  installed(): Promise<boolean>;
  status(): Promise<TailscaleStatus | null>;
  serveEntries(): Promise<ServeEntry[]>;
  serve(port: number, target: string): Promise<void>;
  unserve(port: number, target: string): Promise<void>;
  // Log the node in: with an auth key (non-interactive) or by returning the login URL to open in a browser.
  login(authKey: string | null, keyFile: string): Promise<{ loginUrl: string | null }>;
  logout(): Promise<void>;
}

async function run(bin: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

export class TailscaleCli implements TailscaleProvider {
  readonly description: string;
  constructor(private readonly bin = '/usr/bin/tailscale') {
    this.description = `${bin}`;
  }

  async installed(): Promise<boolean> {
    try {
      const r = await run(this.bin, ['version'], 10_000);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  async status(): Promise<TailscaleStatus | null> {
    let r;
    try {
      r = await run(this.bin, ['status', '--json']);
    } catch {
      return null;
    }
    if (!r.stdout.trim()) return null;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return null;
    }
    const self = (j['Self'] as Record<string, unknown> | undefined) ?? {};
    const tailnet = (j['CurrentTailnet'] as Record<string, unknown> | undefined) ?? {};
    const certDomains = (j['CertDomains'] as string[] | null) ?? [];
    const dns = (self['DNSName'] as string | undefined)?.replace(/\.$/, '') ?? null;
    return {
      backendState: String(j['BackendState'] ?? 'unknown'),
      online: Boolean(self['Online']),
      dnsName: dns,
      tailnet: (tailnet['Name'] as string | undefined) ?? null,
      magicDnsEnabled: Boolean(tailnet['MagicDNSEnabled']),
      httpsEnabled: certDomains.length > 0,
      tailscaleIps: (self['TailscaleIPs'] as string[] | undefined) ?? [],
      keyExpiry: (self['KeyExpiry'] as string | undefined) ?? null,
    };
  }

  // `tailscale serve status --json` shape: {"TCP":{"<port>":{"HTTPS":true}},"Web":{"<host>:<port>":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18080"}}}}}
  async serveEntries(): Promise<ServeEntry[]> {
    const r = await run(this.bin, ['serve', 'status', '--json']);
    if (r.code !== 0 || !r.stdout.trim()) return [];
    try {
      const j = JSON.parse(r.stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
      const out: ServeEntry[] = [];
      for (const [hostPort, v] of Object.entries(j.Web ?? {})) {
        const port = Number(hostPort.split(':').pop());
        const proxy = v.Handlers?.['/']?.Proxy;
        if (port && proxy) out.push({ port, target: proxy });
      }
      return out;
    } catch {
      return [];
    }
  }

  async serve(port: number, target: string): Promise<void> {
    const r = await run(this.bin, ['serve', '--bg', '--yes', `--https=${port}`, target], 60_000);
    if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `tailscale serve failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, { nextAction: 'Check `tailscale status` and that HTTPS certificates are enabled for the tailnet.' });
  }

  async login(authKey: string | null, keyFile: string): Promise<{ loginUrl: string | null }> {
    if (authKey) {
      // key via a private file (`--auth-key=file:`), never on the command line
      writeFileSync(keyFile, authKey.trim() + '\n', { mode: 0o600 });
      let r;
      try {
        r = await run(this.bin, ['up', `--auth-key=file:${keyFile}`, '--ssh=false', '--timeout=90s'], 120_000);
      } finally {
        rmSync(keyFile, { force: true });
      }
      if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `tailscale login failed: ${(r.stderr || r.stdout).trim().replace(/tskey-[A-Za-z0-9-]+/g, '<key>').slice(0, 300)}`, { nextAction: 'Check the auth key (not expired, not already used) and try again.' });
      return { loginUrl: null };
    }
    // Interactive path: tailscale prints a login URL and waits; we only need the URL.
    const r = await run(this.bin, ['up', '--ssh=false', '--timeout=8s'], 20_000);
    const url = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
    if (!url && r.code !== 0) throw new HarborError('OPERATION_FAILED', `tailscale up failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return { loginUrl: url };
  }

  async logout(): Promise<void> {
    const r = await run(this.bin, ['logout'], 60_000);
    if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `tailscale logout failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }

  async unserve(port: number, target: string): Promise<void> {
    const r = await run(this.bin, ['serve', '--bg', '--yes', `--https=${port}`, target, 'off'], 60_000);
    if (r.code !== 0 && !/not found|no serve/i.test(r.stderr + r.stdout)) throw new HarborError('OPERATION_FAILED', `tailscale serve off failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
}

export class FakeTailscale implements TailscaleProvider {
  readonly description = 'fake tailscale';
  isInstalled = true;
  statusValue: TailscaleStatus | null = { backendState: 'Running', online: true, dnsName: 'harbor-test.tail1234.ts.net', tailnet: 'example.ts.net', magicDnsEnabled: true, httpsEnabled: true, tailscaleIps: ['100.64.0.10'], keyExpiry: '2027-03-01T00:00:00Z' };
  entries: ServeEntry[] = [];
  async installed(): Promise<boolean> {
    return this.isInstalled;
  }
  async status(): Promise<TailscaleStatus | null> {
    return this.isInstalled ? this.statusValue : null;
  }
  async serveEntries(): Promise<ServeEntry[]> {
    return [...this.entries];
  }
  async serve(port: number, target: string): Promise<void> {
    if (!this.statusValue?.online) throw new HarborError('OPERATION_FAILED', 'tailscale serve failed: not logged in');
    this.entries = this.entries.filter((e) => e.port !== port).concat([{ port, target }]);
  }
  async unserve(port: number): Promise<void> {
    this.entries = this.entries.filter((e) => e.port !== port);
  }
  loginCalls: { authKey: string | null }[] = [];
  async login(authKey: string | null): Promise<{ loginUrl: string | null }> {
    this.loginCalls.push({ authKey });
    if (authKey === 'tskey-fixture-bad') throw new HarborError('OPERATION_FAILED', 'tailscale login failed: invalid key', { nextAction: 'Check the auth key.' });
    if (authKey) {
      this.statusValue = { backendState: 'Running', online: true, dnsName: 'harbor-test.tail1234.ts.net', tailnet: 'example.ts.net', magicDnsEnabled: true, httpsEnabled: true, tailscaleIps: ['100.64.0.10'], keyExpiry: '2027-03-01T00:00:00Z' };
      return { loginUrl: null };
    }
    return { loginUrl: 'https://login.tailscale.com/a/fake123' };
  }
  async logout(): Promise<void> {
    if (this.statusValue) this.statusValue = { ...this.statusValue, backendState: 'NeedsLogin', online: false, dnsName: null };
    this.entries = [];
  }
}
