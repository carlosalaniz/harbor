import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFetcher, json } from '../../src/appearance/fetcher.js';
import { readSetupCode, writeSetupCode } from '../../src/auth/setup.js';
import { harborUnit, polkitPowerRule, selfUpdateUnit, toolsInstallUnit } from '../../src/bootstrap/systemd.js';
import { isPrivateIPv4, lanHostAllowed } from '../../src/system/lan.js';
import { GitHubReleaseFeed, compareVersions } from '../../src/system/selfupdate.js';
import { renderCaddyConfig } from '../../src/exposure/caddy.js';

describe('self-update pieces', () => {
  it('orders versions and picks the newest stable GitHub release with its assets', async () => {
    expect(compareVersions('0.7.0', '0.8.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.8.0', '0.8.0')).toBe(0);
    expect(compareVersions('0.1.0-mvp', '0.1.0')).toBe(-1);
    const f = new FakeFetcher().on('https://api.github.com/repos/o/r/releases', json([
      { tag_name: 'v0.9.0', draft: true, assets: [] },
      { tag_name: 'v0.8.1-rc1', prerelease: true, assets: [] },
      { tag_name: 'v0.7.0', published_at: '2026-09-15T00:00:00Z', body: 'older', html_url: 'https://github.com/o/r/releases/tag/v0.7.0', assets: [{ name: 'harbor-0.7.0-linux-x64.tar.gz', browser_download_url: 'https://github.com/o/r/releases/download/v0.7.0/harbor-0.7.0-linux-x64.tar.gz' }, { name: 'SHA256SUMS', browser_download_url: 'https://github.com/o/r/releases/download/v0.7.0/SHA256SUMS' }] },
      { tag_name: 'v0.8.0', published_at: '2026-09-16T00:00:00Z', body: 'newer  ', html_url: 'https://github.com/o/r/releases/tag/v0.8.0', assets: [{ name: 'harbor-0.8.0-linux-x64.tar.gz', browser_download_url: 'https://github.com/o/r/releases/download/v0.8.0/harbor-0.8.0-linux-x64.tar.gz' }, { name: 'SHA256SUMS', browser_download_url: 'https://github.com/o/r/releases/download/v0.8.0/SHA256SUMS' }] },
    ]));
    const latest = await new GitHubReleaseFeed(f, 'o/r').latest();
    expect(latest).toEqual({ version: '0.8.0', tag: 'v0.8.0', publishedAt: '2026-09-16T00:00:00Z', notes: 'newer', url: 'https://github.com/o/r/releases/tag/v0.8.0', archiveUrl: 'https://github.com/o/r/releases/download/v0.8.0/harbor-0.8.0-linux-x64.tar.gz', sumsUrl: 'https://github.com/o/r/releases/download/v0.8.0/SHA256SUMS' });
  });
  it('systemd: template unit for the root apply step, polkit grants only its start; LAN unit binds port 80 without root', () => {
    expect(selfUpdateUnit()).toContain('ExecStart=/opt/harbor/bin/harbor self-update apply --to %i');
    expect(polkitPowerRule()).toContain('indexOf("harbor-self-update@") === 0');
    expect(harborUnit({ lan: true })).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');
    expect(harborUnit()).not.toContain('AmbientCapabilities');
  });
  it('systemd: template unit for one-click tool installs, polkit grants only its start', () => {
    expect(toolsInstallUnit()).toContain('ExecStart=/opt/harbor/bin/harbor tools-install %i');
    expect(polkitPowerRule()).toContain('indexOf("harbor-tools-install@") === 0');
  });
});

describe('LAN mode', () => {
  it('knows private addresses and which Host values name this machine', () => {
    expect(isPrivateIPv4('192.168.1.20')).toBe(true);
    expect(isPrivateIPv4('10.0.0.5')).toBe(true);
    expect(isPrivateIPv4('172.20.0.1')).toBe(true);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    const addrs = ['192.168.1.20', 'fe80::1'];
    expect(lanHostAllowed('harbor.local', 80, 18000, addrs)).toBe(true);
    expect(lanHostAllowed('harbor-2.local', 80, 18000, addrs)).toBe(true); // avahi renamed us
    expect(lanHostAllowed('harbor.local:80', 80, 18000, addrs)).toBe(true);
    expect(lanHostAllowed('192.168.1.20', 80, 18000, addrs)).toBe(true);
    expect(lanHostAllowed('192.168.1.20:18000', 80, 18000, addrs)).toBe(true);
    expect(lanHostAllowed('[fe80::1]:80', 80, 18000, addrs)).toBe(true);
    expect(lanHostAllowed('192.168.1.99', 80, 18000, addrs)).toBe(false);
    expect(lanHostAllowed('evil.example.com', 80, 18000, addrs)).toBe(false);
    expect(lanHostAllowed('harbor.local:8443', 80, 18000, addrs)).toBe(false);
  });
  it('Caddy config gains a :80 server that proxies LAN names to the console; :443 keeps the public routes', () => {
    const cfg = renderCaddyConfig([{ id: 'e1', hostname: 'photos.example.com', upstreamPort: 18089, basicAuth: null }], { lan: { hosts: ['harbor.local', '*.local', '192.168.1.20', 'harbor.local'], consolePort: 18000 } }) as { apps: { http: { servers: Record<string, { listen: string[]; routes: { match: { host: string[] }[]; handle: { handler: string; upstreams?: { dial: string }[] }[] }[] }> } } };
    const lan = cfg.apps.http.servers['harbor_lan']!;
    expect(lan.listen).toEqual([':80']);
    expect(lan.routes[0]!.match[0]!.host).toEqual(['*.local', '192.168.1.20', 'harbor.local']);
    expect(lan.routes[0]!.handle[0]).toMatchObject({ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:18000' }] });
    expect(cfg.apps.http.servers['harbor']!.listen).toEqual([':443']);
    expect(renderCaddyConfig([]).apps).not.toHaveProperty(['http', 'servers', 'harbor_lan']);
  });
  it('Caddy config serves LAN HTTPS on :443 with the Harbor cert when lanHttps is set', () => {
    const cfg = renderCaddyConfig([{ id: 'e1', hostname: 'photos.example.com', upstreamPort: 18089, basicAuth: null }], {
      lan: { hosts: ['harbor.local', '*.local', '192.168.1.20'], consolePort: 18000 },
      lanHttps: { hosts: ['harbor.local', '192.168.1.20'], consolePort: 18000, cert: '/var/lib/harbor/tls/server.crt', key: '/var/lib/harbor/tls/server.key' },
    }) as { apps: { http: { servers: Record<string, { listen: string[]; routes: { match: { host: string[] }[] }[]; tls_connection_policies?: { match: { sni: string[] }; certificate_selection: { any_tag: string[] } }[] }> }; tls: { certificates: { load_files: { certificate: string; key: string; tags: string[] }[] } } } };
    // LAN HTTPS is a route on the SAME :443 `harbor` server as the public routes (Caddy cannot have two servers on one port).
    const harbor = cfg.apps.http.servers['harbor']!;
    expect(harbor.listen).toEqual([':443']);
    expect(harbor.routes[0]!.match[0]!.host).toEqual(['192.168.1.20', 'harbor.local']);
    expect(harbor.tls_connection_policies![0]).toEqual({ match: { sni: ['192.168.1.20', 'harbor.local'] }, certificate_selection: { any_tag: ['harbor-lan'] } });
    expect(cfg.apps.tls.certificates.load_files).toEqual([{ certificate: '/var/lib/harbor/tls/server.crt', key: '/var/lib/harbor/tls/server.key', tags: ['harbor-lan'] }]);
    // public routes still present on the same server
    expect(harbor.routes.some((r) => r.match[0]!.host[0] === 'photos.example.com')).toBe(true);
    expect(renderCaddyConfig([]).apps).not.toHaveProperty(['http', 'servers', 'harbor_lan_https']);
  });
  it('setup code: six digits, written 0600, read back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-setup-'));
    const code = writeSetupCode(dir);
    expect(code).toMatch(/^\d{6}$/);
    expect(readSetupCode(dir)).toBe(code);
    expect(readSetupCode(path.join(dir, 'nope'))).toBeNull();
  });
});
