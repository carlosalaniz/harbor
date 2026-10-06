import { describe, expect, it } from 'vitest';
import { renderCaddyConfig } from '../../src/exposure/caddy.js';
import { appAuthorities, endpointUrls, exposureCheck, exposureUrl, HOSTNAME_RE, REACHABLE_STATUS, mainPublicExposure, primaryUrlFor } from '../../src/exposure/urls.js';
import type { ExposureRow } from '../../src/state/repo.js';

const alloc = { id: 'web', service: 'web', containerPort: 80, hostPort: 18080 };
const row = (over: Partial<ExposureRow>): ExposureRow => ({ id: 'e1', instanceId: 'i1', endpointId: 'web', via: 'public', hostname: 'app.example.com', port: 443, protection: 'none', state: 'active', observedAt: null, note: null, createdAt: 't', proxyFrom: null, ...over });

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
  it('hands configuration the LAN address in LAN mode, never localhost (a LAN browser cannot reach it)', () => {
    const pub = row({});
    expect(primaryUrlFor(alloc, [], 'loopback', 'harbor.local')).toBe('http://harbor.local:18080/');
    expect(primaryUrlFor(alloc, [pub], 'public', 'harbor.local')).toBe('https://app.example.com/'); // a published primary still wins
    expect(primaryUrlFor(alloc, [], 'public', 'harbor.local')).toBe('http://harbor.local:18080/'); // fallback is LAN, not loopback
  });
  it('"this network" is the secure LAN address when LAN HTTPS is on (decision 116)', () => {
    expect(primaryUrlFor(alloc, [], 'loopback', 'harbor.local', 'harbor.local')).toBe('https://harbor.local:38080/');
    expect(primaryUrlFor(alloc, [row({})], 'public', 'harbor.local', 'harbor.local')).toBe('https://app.example.com/');
  });
  it('lists every host an app answers on: loopback, LAN names on both ports, tailnet and public', () => {
    const tail = row({ id: 't', via: 'tailnet', hostname: 'node.tail1.ts.net', port: 18080 });
    const all = appAuthorities([alloc], [tail, row({})], { names: ['harbor.local', '192.168.0.146'], secure: true });
    expect(all).toEqual(['127.0.0.1:18080', '192.168.0.146:18080', '192.168.0.146:38080', 'app.example.com', 'harbor.local:18080', 'harbor.local:38080', 'localhost:18080', 'node.tail1.ts.net:18080']);
    expect(appAuthorities([alloc], [], null)).toEqual(['127.0.0.1:18080', 'localhost:18080']);
    expect(appAuthorities([{ ...alloc, hostPort: 50000 }], [], { names: ['harbor.local'], secure: true })).toEqual(['127.0.0.1:50000', 'harbor.local:50000', 'localhost:50000']); // offset overflow: no secure port
  });
  it('several public hostnames on one endpoint: the main one is primaryHost, else the first published; all are authorities (decision 127)', () => {
    const a = row({ id: 'a', hostname: 'erp.example.com' });
    const b = row({ id: 'b', hostname: 'customers.example.org' });
    const other = row({ id: 'c', endpointId: 'admin', hostname: 'admin.example.com' });
    expect(mainPublicExposure([a, b, other], 'web', null)?.id).toBe('a');
    expect(mainPublicExposure([a, b, other], 'web', 'customers.example.org')?.id).toBe('b');
    expect(mainPublicExposure([a, b], 'web', 'gone.example.net')?.id).toBe('a'); // a withdrawn main name falls back to the first
    expect(mainPublicExposure([other], 'web', null)).toBeNull();
    expect(endpointUrls(alloc, [a, b]).public).toBe('https://erp.example.com/');
    expect(endpointUrls(alloc, [a, b], null, null, 'customers.example.org').public).toBe('https://customers.example.org/');
    expect(primaryUrlFor(alloc, [a, b], 'public', null, null, 'customers.example.org')).toBe('https://customers.example.org/');
    expect(primaryUrlFor(alloc, [a, b], 'public')).toBe('https://erp.example.com/');
    expect(primaryUrlFor(alloc, [a, b], 'loopback', null, null, 'customers.example.org')).toBe('http://localhost:18080/'); // primaryHost only matters when public is primary
    expect(appAuthorities([alloc], [a, b], null)).toEqual(['127.0.0.1:18080', 'customers.example.org', 'erp.example.com', 'localhost:18080']);
  });
  it('validates hostnames', () => {
    for (const ok of ['n8n.apein.space', 'a.b.example.com', 'x1-y.example.io']) expect(HOSTNAME_RE.test(ok), ok).toBe(true);
    for (const bad of ['localhost', 'example', 'Upper.Case.com', '-bad.example.com', 'a b.example.com', 'http://x.example.com', 'x.example.com/']) expect(HOSTNAME_RE.test(bad), bad).toBe(false);
  });
});

describe('exposure reachability check target (decision 128)', () => {
  const health = { endpoint: 'web', path: '/healthz', expectedStatus: [200, 204], timeoutSeconds: 5, deadlineSeconds: 90 };
  it('probes the declared health path when the exposed endpoint is the health endpoint', () => {
    expect(exposureCheck(row({}), health)).toEqual({ url: 'https://app.example.com/healthz', expectStatus: [...REACHABLE_STATUS, 204] });
    expect(exposureCheck(row({ via: 'tailnet', hostname: 'node.tail1.ts.net', port: 18080 }), health).url).toBe('https://node.tail1.ts.net:18080/healthz');
    expect(exposureCheck(row({}), { ...health, path: '/api/health?full=1' }).url).toBe('https://app.example.com/api/health?full=1');
  });
  it('falls back to / for other endpoints or when no manifest is known; keeps the expected-status list', () => {
    expect(exposureCheck(row({ endpointId: 'admin' }), health)).toEqual({ url: 'https://app.example.com/', expectStatus: REACHABLE_STATUS });
    expect(exposureCheck(row({}), null)).toEqual({ url: 'https://app.example.com/', expectStatus: REACHABLE_STATUS });
    expect(REACHABLE_STATUS).toContain(401); // basic-auth protection still proves the route is served
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
  it('two public names of one endpoint become two routes to the same upstream, each with its own protection (decision 127)', () => {
    const cfg = renderCaddyConfig([
      { id: 'a', hostname: 'erp.example.com', upstreamPort: 18080, basicAuth: null },
      { id: 'b', hostname: 'customers.example.org', upstreamPort: 18080, basicAuth: { username: 'harbor', bcryptHash: '$2b$10$hash' } },
    ]) as { apps: { http: { servers: { harbor: { routes: Record<string, unknown>[] } } } } };
    const routes = cfg.apps.http.servers.harbor.routes;
    expect(routes.map((r) => (r['match'] as { host: string[] }[])[0]!.host)).toEqual([['customers.example.org'], ['erp.example.com']]);
    for (const r of routes) expect(JSON.stringify(r)).toContain('"dial":"127.0.0.1:18080"');
    expect(JSON.stringify(routes[0])).toContain('"handler":"authentication"');
    expect(JSON.stringify(routes[1])).not.toContain('"handler":"authentication"');
  });
});
