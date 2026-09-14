import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PlatformToolDto } from '../contracts/api.js';
import type { Repo, PlatformToolRow } from '../state/repo.js';
import type { Clock } from '../util.js';
import { rfc3339 } from '../util.js';
import { HarborError } from '../errors.js';

export const TOOL_NAMES: Record<string, string> = { cockpit: 'Cockpit', portainer: 'Portainer' };
export const TOOL_IDS = ['cockpit', 'portainer'] as const;

// Reads platform tool records written by bootstrap (`--with-tools` or `tools bind`) and
// observes reachability of their recorded loopback addresses. A login page is "reachable",
// never "authenticated healthy". Absent tools are a visible state, not a hardcoded card.
export class PlatformToolsService {
  private cache: { at: number; items: PlatformToolDto[] } | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly probe: (url: string) => Promise<{ reachable: boolean; note: string | null }> = probeLoginPage,
  ) {}

  async list(): Promise<PlatformToolDto[]> {
    const nowMs = this.clock.now().getTime();
    if (this.cache && nowMs - this.cache.at < 5000) return this.cache.items;
    const rows = new Map(this.repo.platformTools().map((t) => [t.id, t]));
    const items: PlatformToolDto[] = [];
    for (const id of TOOL_IDS) {
      const row = rows.get(id);
      if (!row || row.mode === 'absent') {
        items.push({ id, name: TOOL_NAMES[id]!, installationState: row?.installationState ?? 'not_installed', availability: 'unknown', browserUrl: null, observedAt: row?.observedAt ?? null, note: row?.note ?? 'Not set up. Re-run bootstrap with --with-tools or bind an existing installation with `harbor tools bind`.', mode: row?.mode ?? 'absent' });
        continue;
      }
      let availability: PlatformToolDto['availability'] = 'unknown';
      let installationState = row.installationState;
      let note = row.note;
      if (row.browserUrl) {
        const r = await this.probe(row.browserUrl);
        availability = r.reachable ? 'reachable' : 'unreachable';
        if (r.note) note = note ? `${note} ${r.note}` : r.note;
        if (id === 'portainer' && r.reachable) {
          // Portainer reports whether its first admin exists; that decides setup_required vs installed.
          const admin = await this.probe(new URL('/api/users/admin/check', row.browserUrl).toString());
          installationState = admin.reachable && /HTTP 20\d/.test(admin.note ?? '') ? 'installed' : /HTTP 404/.test(admin.note ?? '') ? 'setup_required' : installationState;
        }
        this.repo.upsertPlatformTool({ ...row, availability, installationState, observedAt: rfc3339(this.clock.now()) });
      }
      items.push(this.dto({ ...row, availability, installationState, note, observedAt: rfc3339(this.clock.now()) }));
    }
    this.cache = { at: nowMs, items };
    return items;
  }

  // Explicit binding to an already installed tool: recorded, never reconfigured or owned.
  bind(id: string, browserUrl: string): void {
    if (!(TOOL_IDS as readonly string[]).includes(id)) throw new HarborError('NOT_FOUND', `unknown platform tool ${id}`);
    let u: URL;
    try {
      u = new URL(browserUrl);
    } catch {
      throw new HarborError('INVALID_REQUEST', 'browserUrl must be a valid URL');
    }
    if ((u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') || !['http:', 'https:'].includes(u.protocol)) {
      throw new HarborError('INVALID_REQUEST', 'tool URLs must be http(s) on localhost/127.0.0.1 (loopback only)');
    }
    const existing = this.repo.platformTool(id);
    if (existing?.mode === 'managed') throw new HarborError('INVALID_STATE', `${id} is managed by Harbor bootstrap; unbinding is not supported for managed tools`);
    this.repo.upsertPlatformTool({
      id,
      mode: 'external',
      browserUrl: u.toString(),
      installationState: 'installed',
      availability: 'unknown',
      observedAt: null,
      note: `Bound to an existing ${TOOL_NAMES[id]} installation without taking ownership; Harbor does not manage or reconfigure it.`,
      resources: null,
    });
    this.cache = null;
  }

  unbind(id: string): void {
    const existing = this.repo.platformTool(id);
    if (!existing) throw new HarborError('NOT_FOUND', `no binding for ${id}`);
    if (existing.mode === 'managed') throw new HarborError('INVALID_STATE', `${id} is managed by Harbor bootstrap and cannot be unbound here`);
    this.repo.upsertPlatformTool({ id, mode: 'absent', browserUrl: null, installationState: 'not_installed', availability: 'unknown', observedAt: null, note: 'Binding removed.', resources: null });
    this.cache = null;
  }

  private dto(t: PlatformToolRow): PlatformToolDto {
    return { id: t.id, name: TOOL_NAMES[t.id] ?? t.id, installationState: t.installationState, availability: t.availability, browserUrl: t.browserUrl, observedAt: t.observedAt, note: t.note, mode: t.mode };
  }
}

// GET the recorded browser URL on loopback. Self-signed TLS (Portainer) counts as reachable but
// is disclosed; verification is only relaxed for this single loopback probe, never globally.
export function probeLoginPage(url: string): Promise<{ reachable: boolean; note: string | null }> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ reachable: false, note: 'invalid recorded URL' });
      return;
    }
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      resolve({ reachable: false, note: 'recorded URL is not on loopback' });
      return;
    }
    const isHttps = u.protocol === 'https:';
    const fn = isHttps ? httpsRequest : httpRequest;
    const req = fn(
      { host: '127.0.0.1', port: Number(u.port || (isHttps ? 443 : 80)), path: u.pathname || '/', method: 'GET', timeout: 4000, headers: { host: u.host, accept: 'text/html' }, ...(isHttps ? { rejectUnauthorized: false, servername: u.hostname } : {}) },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 500;
        const tls = isHttps ? ' Uses a self-signed certificate; your browser will ask you to trust it.' : '';
        resolve({ reachable: ok, note: ok ? `Login page reachable (HTTP ${status}).${tls}` : `HTTP ${status}` });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ reachable: false, note: `not reachable: ${e.message}` }));
    req.end();
  });
}
