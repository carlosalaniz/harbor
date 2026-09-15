import { describe, expect, it } from 'vitest';
import { renderCaddyConfig } from '../../src/exposure/caddy.js';
import { endpointUrls, exposureUrl, HOSTNAME_RE, primaryUrlFor } from '../../src/exposure/urls.js';
import type { ExposureRow } from '../../src/state/repo.js';

const alloc = { id: 'web', service: 'web', containerPort: 80, hostPort: 18080 };
const row = (over: Partial<ExposureRow>): ExposureRow => ({ id: 'e1', instanceId: 'i1', endpointId: 'web', via: 'public', hostname: 'app.example.com', port: 443, protection: 'none', state: 'active', observedAt: null, note: null, createdAt: 't', ...over });

describe('exposure URLs', () => {
  it('renders loopback, tailnet (same port) and public (443) addresses', () => {
    const tail = row({ via: 'tailnet', hostname: 'node.tail1.ts.net', port: 18080 });
    const pub = row({});
    expect(exposureUrl(tail)).toBe('https://node.tail1.ts.net:18080/');
    expect(exposureUrl(row({ via: 'tailnet', hostname: 'node.tail1.ts.net', port: 443 }))).toBe('https://node.tail1.ts.net/');
    expect(exposureUrl(pub)).toBe('https://app.example.com/');
    expect(endpointUrls(alloc, [tail, pub])).toEqual({ loopback: 'http://localhost:18080/', tailnet: 'https://node.tail1.ts.net:18080/', public: 'https://app.example.com/' });
    expect(primaryUrlFor(alloc, [tail, pub], 'public')).toBe('https://app.example.com/');
    expect(primaryUrlFor(alloc, [tail], 'public')).toBe('http://localhost:18080/'); // falls back when that exposure is absent
    expect(primaryUrlFor(alloc, [], 'loopback')).toBe('http://localhost:18080/');
  });
  it('validates hostnames', () => {
    for (const ok of ['n8n.apein.space', 'a.b.example.com', 'x1-y.example.io']) expect(HOSTNAME_RE.test(ok), ok).toBe(true);
    for (const bad of ['localhost', 'example', 'Upper.Case.com', '-bad.example.com', 'a b.example.com', 'http://x.example.com', 'x.example.com/']) expect(HOSTNAME_RE.test(bad), bad).toBe(false);
  });
});

describe('Caddy config renderer', () => {
  it('produces one terminal host route per exposure with optional basic auth and no other routes', () => {
    const cfg = renderCaddyConfig([
      { id: 'b', hostname: 'pdf.example.com', upstreamPort: 18081, basicAuth: { username: 'harbor', bcryptHash: '$2b$10$hash' } },
      { id: 'a', hostname: 'draw.example.com', upstreamPort: 18080, basicAuth: null },
    ]) as { admin: { listen: string }; apps: { http: { servers: { harbor: { listen: string[]; routes: Record<string, unknown>[] } } } } };
    expect(cfg.admin.listen).toBe('127.0.0.1:2019');
    const server = cfg.apps.http.servers.harbor;
    expect(server.listen).toEqual([':443']);
    expect(server.routes.map((r) => (r['match'] as { host: string[] }[])[0]!.host[0])).toEqual(['draw.example.com', 'pdf.example.com']); // sorted
    const text = JSON.stringify(cfg);
    expect(text).toContain('"dial":"127.0.0.1:18081"');
    expect(text).toContain('"@id":"exposure-a"');
    expect((text.match(/"handler":"authentication"/g) ?? []).length).toBe(1);
    expect(text).toContain('"password":"$2b$10$hash"');
    expect(text).toContain('"terminal":true');
    expect(JSON.stringify(renderCaddyConfig([]))).toContain('"routes":[]');
  });
});
