import { request as httpRequest } from 'node:http';
import { HarborError } from '../errors.js';

// Caddy admin API client (127.0.0.1:2019) plus the pure renderer that turns Harbor's exposure
// records into one complete Caddy JSON config. Harbor owns the whole config (POST /load); nothing is
// edited by hand. Shape verified with `caddy adapt` (v2.11) — see docs/design/EXPOSURE.md.

export interface CaddyRoute {
  id: string; // exposure id → "@id"
  hostname: string;
  upstreamPort: number; // 127.0.0.1:<port>
  basicAuth: { username: string; bcryptHash: string } | null;
}

export const CADDY_MARKER = 'harbor-managed';

export function renderCaddyConfig(routes: CaddyRoute[], opts: { adminListen?: string; email?: string | null } = {}): Record<string, unknown> {
  const sorted = [...routes].sort((a, b) => a.hostname.localeCompare(b.hostname));
  return {
    admin: { listen: opts.adminListen ?? '127.0.0.1:2019' },
    logging: { logs: { default: { level: 'INFO' } } },
    apps: {
      http: {
        servers: {
          harbor: {
            '@id': CADDY_MARKER,
            listen: [':443'],
            routes: sorted.map((r) => ({
              '@id': `exposure-${r.id}`,
              match: [{ host: [r.hostname] }],
              handle: [
                {
                  handler: 'subroute',
                  routes: [
                    {
                      handle: [
                        { handler: 'headers', response: { set: { 'X-Content-Type-Options': ['nosniff'], 'Referrer-Policy': ['no-referrer'] } } },
                        { handler: 'request_body', max_size: 256 * 1024 * 1024 },
                        ...(r.basicAuth
                          ? [{ handler: 'authentication', providers: { http_basic: { accounts: [{ username: r.basicAuth.username, password: r.basicAuth.bcryptHash }], hash: { algorithm: 'bcrypt' }, hash_cache: {}, realm: 'Harbor' } } }]
                          : []),
                        { handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${r.upstreamPort}` }] },
                      ],
                    },
                  ],
                },
              ],
              terminal: true,
            })),
          },
        },
      },
      tls: opts.email ? { automation: { policies: [{ issuers: [{ module: 'acme', email: opts.email }] }] } } : {},
    },
  };
}

export interface CaddyAdmin {
  readonly description: string;
  available(): Promise<boolean>;
  currentConfig(): Promise<Record<string, unknown> | null>;
  load(config: Record<string, unknown>): Promise<void>;
}

export class CaddyAdminClient implements CaddyAdmin {
  readonly description: string;
  constructor(
    private readonly host = '127.0.0.1',
    private readonly port = 2019,
  ) {
    this.description = `caddy admin http://${host}:${port}`;
  }

  private call(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: this.host, port: this.port, path, method, timeout: 15_000, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async available(): Promise<boolean> {
    try {
      return (await this.call('GET', '/config/')).status === 200;
    } catch {
      return false;
    }
  }

  async currentConfig(): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.call('GET', '/config/');
      return r.status === 200 && r.body.trim() && r.body.trim() !== 'null' ? (JSON.parse(r.body) as Record<string, unknown>) : null;
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `Caddy admin API not reachable: ${(e as Error).message}`, { nextAction: 'Check `systemctl status caddy` on the host.' });
    }
  }

  async load(config: Record<string, unknown>): Promise<void> {
    let r: { status: number; body: string };
    try {
      r = await this.call('POST', '/load', JSON.stringify(config));
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `Caddy admin API not reachable: ${(e as Error).message}`, { nextAction: 'Check `systemctl status caddy` on the host.' });
    }
    if (r.status !== 200) throw new HarborError('OPERATION_FAILED', `Caddy rejected the configuration (HTTP ${r.status}): ${r.body.slice(0, 300)}`);
  }
}

export class FakeCaddyAdmin implements CaddyAdmin {
  readonly description = 'fake caddy admin';
  config: Record<string, unknown> | null = null;
  down = false;
  async available(): Promise<boolean> {
    return !this.down;
  }
  async currentConfig(): Promise<Record<string, unknown> | null> {
    if (this.down) throw new HarborError('DOCKER_UNAVAILABLE', 'Caddy admin API not reachable: fake down');
    return this.config;
  }
  async load(config: Record<string, unknown>): Promise<void> {
    if (this.down) throw new HarborError('DOCKER_UNAVAILABLE', 'Caddy admin API not reachable: fake down');
    this.config = config;
  }
  routes(): string[] {
    const servers = ((this.config?.['apps'] as Record<string, unknown> | undefined)?.['http'] as Record<string, unknown> | undefined)?.['servers'] as Record<string, { routes?: { match?: { host?: string[] }[] }[] }> | undefined;
    return Object.values(servers ?? {}).flatMap((s) => (s.routes ?? []).flatMap((r) => r.match?.[0]?.host ?? []));
  }
}
