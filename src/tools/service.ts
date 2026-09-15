import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PlatformToolDto, UiExposureDto } from '../contracts/api.js';
import type { Repo, PlatformToolRow } from '../state/repo.js';
import type { Clock } from '../util.js';
import { rfc3339 } from '../util.js';
import { HarborError } from '../errors.js';

export const TOOL_NAMES: Record<string, string> = { cockpit: 'Cockpit', portainer: 'Portainer', tailscale: 'Tailscale', proxy: 'Public proxy (Caddy)' };
export const TOOL_IDS = ['cockpit', 'portainer', 'tailscale', 'proxy'] as const;
export const BINDABLE_TOOL_IDS = ['cockpit', 'portainer'] as const;

export interface ExposureProviders {
  tailscale: {
    status(): Promise<{ backendState: string; online: boolean; dnsName: string | null; tailnet: string | null; magicDnsEnabled: boolean; httpsEnabled: boolean } | null>;
    installed(): Promise<boolean>;
    serve(port: number, target: string): Promise<void>;
    unserve(port: number, target: string): Promise<void>;
    login(authKey: string | null, keyFile: string): Promise<{ loginUrl: string | null }>;
    logout(): Promise<void>;
  };
  caddy: { available(): Promise<boolean> };
}
export const UI_TAILNET_PORT = 443;

// Reads platform tool records written by bootstrap (`--with-tools` or `tools bind`) and
// observes reachability of their recorded loopback addresses. A login page is "reachable",
// never "authenticated healthy". Absent tools are a visible state, not a hardcoded card.
export class PlatformToolsService {
  private cache: { at: number; items: PlatformToolDto[] } | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly probe: (url: string) => Promise<{ reachable: boolean; note: string | null }> = probeLoginPage,
    private readonly providers: ExposureProviders | null = null,
  ) {}

  // Exposure providers are observed live (CLI/admin API), not only from bootstrap records.
  private async providerTool(id: 'tailscale' | 'proxy', row: PlatformToolRow | undefined): Promise<PlatformToolDto> {
    const now = rfc3339(this.clock.now());
    const base = { id, name: TOOL_NAMES[id]!, browserUrl: null, observedAt: now, mode: row?.mode ?? 'absent' } as const;
    if (!this.providers) return { ...base, installationState: 'unknown', availability: 'unknown', note: 'provider observation not available' };
    if (id === 'tailscale') {
      const installed = await this.providers.tailscale.installed();
      if (!installed) return { ...base, installationState: 'not_installed', availability: 'unknown', note: 'Not set up. Re-run bootstrap with --with-tailscale.' };
      const st = await this.providers.tailscale.status();
      if (!st || st.backendState !== 'Running' || !st.dnsName) return { ...base, mode: row?.mode ?? 'managed', installationState: 'setup_required', availability: 'unreachable', note: `Installed but not logged in (state ${st?.backendState ?? 'unknown'}). Run: sudo tailscale up  (then approve the printed login URL).`, facts: { backendState: st?.backendState ?? null } };
      const facts = { dnsName: st.dnsName, tailnet: st.tailnet, magicDnsEnabled: st.magicDnsEnabled, httpsEnabled: st.httpsEnabled, online: st.online };
      if (!st.httpsEnabled) return { ...base, mode: row?.mode ?? 'managed', installationState: 'setup_required', availability: st.online ? 'reachable' : 'unreachable', note: `Node ${st.dnsName} is logged in, but HTTPS certificates are not enabled for the tailnet. Enable MagicDNS and HTTPS in the Tailscale admin console (DNS settings).`, facts };
      return { ...base, mode: row?.mode ?? 'managed', installationState: 'installed', availability: st.online ? 'reachable' : 'unreachable', note: `Node ${st.dnsName} on tailnet ${st.tailnet ?? '?'}; MagicDNS and HTTPS enabled. Apps can be published with harbor expose --via tailnet.`, facts };
    }
    const ok = await this.providers.caddy.available();
    if (!row && !ok) return { ...base, installationState: 'not_installed', availability: 'unknown', note: 'Not set up. Re-run bootstrap with --with-public-proxy.' };
    return { ...base, mode: row?.mode ?? 'managed', installationState: 'installed', availability: ok ? 'reachable' : 'unreachable', note: ok ? 'Caddy admin API answering on 127.0.0.1:2019; routes are reconciled from Harbor state. Public exposure needs DNS records pointing at this host and ports 80/443 reachable.' : 'Caddy admin API not answering; check `systemctl status caddy`.', facts: { adminApi: ok } };
  }

  async list(): Promise<PlatformToolDto[]> {
    const nowMs = this.clock.now().getTime();
    if (this.cache && nowMs - this.cache.at < 5000) return this.cache.items;
    const rows = new Map(this.repo.platformTools().map((t) => [t.id, t]));
    const items: PlatformToolDto[] = [];
    for (const id of TOOL_IDS) {
      const row = rows.get(id);
      if (id === 'tailscale' || id === 'proxy') {
        items.push(await this.providerTool(id, row));
        continue;
      }
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

  // Remote access setup from the console: log the node in (auth key or browser URL) or out.
  async tailscaleLogin(authKey: string | null, keyFile: string): Promise<{ loginUrl: string | null }> {
    if (!this.providers) throw new HarborError('UNSUPPORTED_CAPABILITY', 'exposure providers unavailable');
    if (!(await this.providers.tailscale.installed())) throw new HarborError('UNSUPPORTED_CAPABILITY', 'Tailscale is not installed on this host', { nextAction: 'Run the bootstrap once more with --with-tailscale (as root).' });
    const r = await this.providers.tailscale.login(authKey, keyFile);
    this.cache = null;
    return r;
  }

  async tailscaleLogout(): Promise<void> {
    if (!this.providers) throw new HarborError('UNSUPPORTED_CAPABILITY', 'exposure providers unavailable');
    await this.providers.tailscale.logout();
    const row = this.repo.platformTool('tailscale');
    if (row) {
      const rest = { ...(row.resources ?? {}) };
      delete rest['uiExposure'];
      this.repo.upsertPlatformTool({ ...row, installationState: 'setup_required', availability: 'unknown', note: 'Logged out of the tailnet.', observedAt: rfc3339(this.clock.now()), resources: rest });
    }
    this.cache = null;
  }

  // Harbor UI on the tailnet: `tailscale serve --https=443 -> 127.0.0.1:<management port>`.
  // Never public. The daemon's Host/Origin allow-list follows this record (see extraOrigins()).
  async exposeUi(managementPort: number): Promise<UiExposureDto> {
    if (!this.providers) throw new HarborError('UNSUPPORTED_CAPABILITY', 'exposure providers unavailable');
    const st = await this.providers.tailscale.status();
    if (!st || st.backendState !== 'Running' || !st.dnsName) throw new HarborError('UNSUPPORTED_CAPABILITY', 'Tailscale is not set up on this host', { nextAction: 'Re-run bootstrap with --with-tailscale and log in.' });
    if (!st.httpsEnabled) throw new HarborError('UNSUPPORTED_CAPABILITY', 'HTTPS certificates are not enabled for this tailnet', { nextAction: 'Enable MagicDNS and HTTPS in the Tailscale admin console.' });
    await this.providers.tailscale.serve(UI_TAILNET_PORT, `http://127.0.0.1:${managementPort}`);
    const row = this.repo.platformTool('tailscale');
    this.repo.upsertPlatformTool({ id: 'tailscale', mode: row?.mode ?? 'managed', browserUrl: null, installationState: 'installed', availability: 'reachable', observedAt: rfc3339(this.clock.now()), note: row?.note ?? null, resources: { ...(row?.resources ?? {}), uiExposure: { hostname: st.dnsName, port: UI_TAILNET_PORT } } });
    this.cache = null;
    return { via: 'tailnet', url: `https://${st.dnsName}/`, state: 'pending', note: 'served by tailscale; open it from a device on your tailnet' };
  }

  async unexposeUi(managementPort: number): Promise<void> {
    if (!this.providers) throw new HarborError('UNSUPPORTED_CAPABILITY', 'exposure providers unavailable');
    const row = this.repo.platformTool('tailscale');
    const ui = (row?.resources?.['uiExposure'] as { hostname: string; port: number } | undefined) ?? null;
    if (!ui) throw new HarborError('NOT_FOUND', 'the Harbor UI is not exposed on the tailnet');
    await this.providers.tailscale.unserve(ui.port, `http://127.0.0.1:${managementPort}`);
    const rest = { ...(row?.resources ?? {}) };
    delete rest['uiExposure'];
    this.repo.upsertPlatformTool({ id: 'tailscale', mode: row?.mode ?? 'managed', browserUrl: null, installationState: row?.installationState ?? 'installed', availability: row?.availability ?? 'unknown', observedAt: rfc3339(this.clock.now()), note: row?.note ?? null, resources: rest });
    this.cache = null;
  }

  uiExposure(): UiExposureDto | null {
    const row = this.repo.platformTool('tailscale');
    const ui = (row?.resources?.['uiExposure'] as { hostname: string; port: number } | undefined) ?? null;
    return ui ? { via: 'tailnet', url: ui.port === 443 ? `https://${ui.hostname}/` : `https://${ui.hostname}:${ui.port}/`, state: 'active', note: null } : null;
  }

  // Extra accepted Host/Origin values while the UI is exposed on the tailnet.
  extraOrigins(): { hosts: string[]; origins: string[] } {
    const ui = this.uiExposure();
    if (!ui) return { hosts: [], origins: [] };
    const u = new URL(ui.url);
    return { hosts: [u.host], origins: [u.origin] };
  }

  // Explicit binding to an already installed tool: recorded, never reconfigured or owned.
  bind(id: string, browserUrl: string): void {
    if (!(BINDABLE_TOOL_IDS as readonly string[]).includes(id)) throw new HarborError('NOT_FOUND', `unknown or non-bindable platform tool ${id}`);
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
    if (!existing || existing.mode === 'absent') throw new HarborError('NOT_FOUND', `no binding for ${id}`);
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
