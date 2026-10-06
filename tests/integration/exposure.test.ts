import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';
import type { ExposureDto, InstanceSummary, OperationDto, PlanDto, PlatformToolDto, UiExposureDto } from '../../src/contracts/api.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  // A package that embeds its base URL (like n8n) so reconfigure has visible effect.
  writePackage(h.catalogDir, 'urlapp', {
    manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: urlapp') + 'configuration:\n  - {service: web, environment: PUBLIC_URL, endpoint: web}\n',
    compose: `services:\n  web:\n    image: example/urlapp@${DIGEST_A}\n`,
    images: { web: `example/urlapp@${DIGEST_A}` },
  });
});
afterAll(async () => {
  await h.close();
});

const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const exposures = async () => h.api.expect<{ items: ExposureDto[]; ui: UiExposureDto | null }>(200, 'GET', '/v1/exposures');
const runtimeEnv = (inst: InstanceSummary) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8')).services.web.environment as Record<string, string>;

describe('exposure: tailnet and public paths on the generic engine', () => {
  let app: InstanceSummary;
  let exca: InstanceSummary;

  it('installs two apps on loopback only', async () => {
    expect((await h.api.run({ kind: 'install', packageId: 'urlapp' })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    app = await byName('urlapp');
    exca = await byName('excalidraw');
    expect(app.endpoints[0]!.urls).toEqual({ loopback: app.endpoints[0]!.browserUrl });
    expect(app.endpoints[0]!.primary).toBe('loopback');
    expect(runtimeEnv(app)['PUBLIC_URL']).toBe(app.endpoints[0]!.browserUrl);
  });

  it('tool cards report Tailscale and the proxy honestly, including setup_required states', async () => {
    const { items } = await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools');
    const ts = items.find((t) => t.id === 'tailscale')!;
    const px = items.find((t) => t.id === 'proxy')!;
    expect(ts).toMatchObject({ installationState: 'installed', availability: 'reachable' });
    expect(ts.facts?.['dnsName']).toBe('harbor-test.tail1234.ts.net');
    expect(px).toMatchObject({ installationState: 'installed', availability: 'reachable' });
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: false };
    await new Promise((r) => setTimeout(r, 5100)); // tool cache
    const again = (await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools')).items.find((t) => t.id === 'tailscale')!;
    expect(again.installationState).toBe('setup_required');
    expect(again.note).toMatch(/HTTPS certificates are not enabled/);
    await h.api.expectError(422, 'UNSUPPORTED_CAPABILITY', 'POST', '/v1/plans', { kind: 'expose', instanceId: exca.id, via: 'tailnet' });
    h.tailscale.statusValue = { ...h.tailscale.statusValue!, httpsEnabled: true };
  });

  it('exposes Excalidraw on the tailnet on its OWN port (decision 133); verifies; unexposes cleanly', async () => {
    const plan = await h.api.plan({ kind: 'expose', instanceId: exca.id, via: 'tailnet' });
    const hostPort = exca.endpoints[0]!.hostPort;
    const port = Number(new URL(plan.exposure!.url).port);
    expect(port).not.toBe(hostPort);
    expect(port).toBeGreaterThanOrEqual(h.config.appPortRange.from);
    expect(port).toBeLessThanOrEqual(h.config.appPortRange.to);
    expect(plan.exposure).toMatchObject({ via: 'tailnet', url: `https://harbor-test.tail1234.ts.net:${port}/`, protection: 'none' });
    const sub = await h.api.submit(plan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.result?.['exposureState']).toBe('active');
    expect(h.tailscale.entries).toEqual([{ port, target: `http://127.0.0.1:${hostPort}` }]);
    const list = await exposures();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ instanceName: 'excalidraw', via: 'tailnet', state: 'active', isPrimary: false, port });
    exca = await byName('excalidraw');
    expect(exca.endpoints[0]!.urls.tailnet).toBe(`https://harbor-test.tail1234.ts.net:${port}/`);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'expose', instanceId: exca.id, via: 'tailnet' });
    // a later install never gets the tailnet address's port for its own endpoint
    const app2 = (await h.api.plan({ kind: 'install', packageId: 'urlapp', name: 'urlapp-probe' })).endpoints.map((e) => e.hostPort);
    expect(app2).not.toContain(port);
    const un = await h.api.run({ kind: 'unexpose', instanceId: exca.id, via: 'tailnet' });
    expect(un.op.state).toBe('succeeded');
    expect(h.tailscale.entries).toEqual([]);
    expect((await exposures()).items).toEqual([]);
  });

  it('moves an address published before 0.23.0 (same port as the app) to its own port, new entry first', async () => {
    const hostPort = exca.endpoints[0]!.hostPort;
    const target = `http://127.0.0.1:${hostPort}`;
    // the old shape: row and serve entry on the app's own port
    h.daemon.ctx.repo.insertExposure({ id: '0a0a0a0a-0000-4000-8000-000000000133', instanceId: exca.id, endpointId: exca.endpoints[0]!.id, via: 'tailnet', hostname: 'harbor-test.tail1234.ts.net', port: hostPort, protection: 'none', state: 'active', note: null });
    await h.tailscale.serve(hostPort, target);
    let moved: ExposureDto | undefined;
    for (let i = 0; i < 60 && !moved; i++) {
      await new Promise((r) => setTimeout(r, 100));
      moved = (await exposures()).items.find((e) => e.via === 'tailnet' && e.port !== hostPort);
    }
    expect(moved, 'observer moved the address').toBeDefined();
    expect(h.tailscale.entries).toEqual([{ port: moved!.port, target }]);
    const { items } = await h.api.expect<{ items: { kind: string; body: string }[] }>(200, 'GET', '/v1/notifications');
    expect(items.some((n) => n.kind === 'tailnet-moved' && n.body.includes(`was port ${hostPort}`))).toBe(true);
    expect((await h.api.run({ kind: 'unexpose', instanceId: exca.id, via: 'tailnet' })).op.state).toBe('succeeded');
    expect(h.tailscale.entries).toEqual([]);
  });

  it('public exposure: hostname validation, default basic protection for apps without their own login, one-time credentials, Caddy reconcile', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'expose', instanceId: exca.id, via: 'public' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'expose', instanceId: exca.id, via: 'public', hostname: 'not a host' });
    const plan = await h.api.plan({ kind: 'expose', instanceId: exca.id, via: 'public', hostname: 'draw.example.com' });
    expect(plan.exposure).toMatchObject({ via: 'public', url: 'https://draw.example.com/', protection: 'basic' });
    expect(plan.warnings.join(' ')).toMatch(/DNS/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const creds = op.result?.['credentials'] as { username: string; password: string };
    expect(creds.username).toBe('harbor');
    expect(creds.password).toMatch(/^[a-f0-9]{64}$/);
    expect(h.caddy.routes()).toEqual(['draw.example.com']);
    const cfg = JSON.stringify(h.caddy.config);
    expect(cfg).toContain('"handler":"authentication"');
    expect(cfg).toContain(`127.0.0.1:${exca.endpoints[0]!.hostPort}`);
    expect(cfg).not.toContain(creds.password); // only the bcrypt hash goes to Caddy
    // credentials never appear in later DTOs
    const detail = JSON.stringify(await h.api.expect(200, 'GET', `/v1/instances/${exca.id}`));
    expect(detail).not.toContain(creds.password);
    // same hostname cannot be used twice
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/plans', { kind: 'expose', instanceId: app.id, via: 'public', hostname: 'draw.example.com' });
  });

  it('a package with its own onboarding defaults to no basic auth; making a public address primary re-renders the base URL', async () => {
    writePackage(h.catalogDir, 'ownauth', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: ownauth') + 'setup:\n  endpoint: web\n  instructions: Create the owner.\nconfiguration:\n  - {service: web, environment: BASE_URL, endpoint: web}\n',
      compose: `services:\n  web:\n    image: example/ownauth@${DIGEST_A}\n`,
      images: { web: `example/ownauth@${DIGEST_A}` },
    });
    expect((await h.api.run({ kind: 'install', packageId: 'ownauth' })).op.state).toBe('succeeded');
    let own = await byName('ownauth');
    const before = [...h.fake.containers.values()].find((c) => c.labels['io.harbor.preview/instance'] === own.id)!;
    const plan = await h.api.plan({ kind: 'expose', instanceId: own.id, via: 'public', hostname: 'flow.example.com', makePrimary: true });
    expect(plan.exposure?.protection).toBe('none');
    expect(plan.changes.join(' ')).toMatch(/primary address and recreate/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    own = await byName('ownauth');
    expect(own.endpoints[0]!.primary).toBe('public');
    expect(own.endpoints[0]!.urls.public).toBe('https://flow.example.com/');
    expect(runtimeEnv(own)['BASE_URL']).toBe('https://flow.example.com/');
    expect(own.readiness).toBe('healthy');
    expect(h.fake.containers.get(before.id)).toBeDefined(); // fake `up` keeps the container; real Compose recreates it
    // back to loopback
    const back = await h.api.run({ kind: 'reconfigure', instanceId: own.id, primary: 'loopback' });
    expect(back.op.state).toBe('succeeded');
    own = await byName('ownauth');
    expect(own.endpoints[0]!.primary).toBe('loopback');
    expect(runtimeEnv(own)['BASE_URL']).toBe(own.endpoints[0]!.browserUrl);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: own.id, primary: 'loopback' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'reconfigure', instanceId: own.id, primary: 'tailnet' });
  });

  it('unreachable published address is recorded as degraded and recovers through observation', async () => {
    h.verifier.results.set('https://slow.example.com/', { ok: false, status: null, error: 'ECONNREFUSED' });
    const op = await h.api.waitOperation((await h.api.submit((await h.api.plan({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'slow.example.com', protection: 'none' })).id)).operationId, 130_000);
    expect(op.state).toBe('succeeded');
    expect(op.result?.['exposureState']).toBe('degraded');
    let e = (await exposures()).items.find((x) => x.hostname === 'slow.example.com')!;
    expect(e.state).toBe('degraded');
    expect(e.note).toMatch(/DNS|not reachable/);
    h.verifier.results.delete('https://slow.example.com/');
    await new Promise((r) => setTimeout(r, 1500));
    e = (await exposures()).items.find((x) => x.hostname === 'slow.example.com')!;
    expect(e.state).toBe('active');
  }, 150_000);

  it('removing an instance withdraws its exposures and Caddy routes; provider down fails safely', async () => {
    expect(h.caddy.routes().sort()).toEqual(['draw.example.com', 'flow.example.com', 'slow.example.com']);
    const rm = await h.api.run({ kind: 'remove', instanceId: exca.id });
    expect(rm.op.state).toBe('succeeded');
    expect(h.caddy.routes().sort()).toEqual(['flow.example.com', 'slow.example.com']);
    expect((await exposures()).items.map((x) => x.hostname).sort()).toEqual(['flow.example.com', 'slow.example.com']);
    expect((await h.api.run({ kind: 'install', packageId: 'excalidraw' })).op.state).toBe('succeeded');
    const fresh = await byName('excalidraw-2');
    h.caddy.down = true;
    await h.api.expectError(422, 'UNSUPPORTED_CAPABILITY', 'POST', '/v1/plans', { kind: 'expose', instanceId: fresh.id, via: 'public', hostname: 'x.example.com' });
    const un = await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'public' });
    expect(un.op.state).toBe('failed');
    expect(un.op.error?.code).toBe('DOCKER_UNAVAILABLE');
    h.caddy.down = false;
    expect((await h.api.run({ kind: 'unexpose', instanceId: app.id, via: 'public' })).op.state).toBe('succeeded');
  });

  it('Harbor UI can be exposed on the tailnet (never publicly) and the daemon then accepts that origin', async () => {
    const ui = await h.api.expect<UiExposureDto>(201, 'PUT', '/v1/ui-exposure', { via: 'tailnet' });
    expect(ui.url).toBe('https://harbor-test.tail1234.ts.net/');
    expect(h.tailscale.entries).toContainEqual({ port: 443, target: `http://127.0.0.1:${h.config.listen.port}` });
    expect((await exposures()).ui?.url).toBe(ui.url);
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/ui-exposure', { via: 'public' });
    const ok = await fetch(`${h.baseUrl}/v1/system`, { headers: { authorization: `Bearer ${h.token}`, origin: 'https://harbor-test.tail1234.ts.net' } });
    expect(ok.status).toBe(200);
    expect((await h.api.raw('DELETE', '/v1/ui-exposure')).status).toBe(204);
    const denied = await fetch(`${h.baseUrl}/v1/system`, { headers: { authorization: `Bearer ${h.token}`, origin: 'https://harbor-test.tail1234.ts.net' } });
    expect(denied.status).toBe(403);
  });

  it('plan DTOs for exposure kinds match the OpenAPI schema (regenerated)', async () => {
    const p = await h.api.plan({ kind: 'expose', instanceId: app.id, via: 'tailnet' });
    expect(p.kind).toBe('expose');
    const op = await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${(await h.api.submit(p.id)).operationId}`);
    expect(['queued', 'applying', 'verifying', 'succeeded']).toContain(op.state);
    await h.api.waitOperation(op.id);
    const plans: PlanDto = await h.api.expect(200, 'GET', `/v1/plans/${p.id}`);
    expect(plans.exposure?.via).toBe('tailnet');
  });

  it('an API-only app (404 at /) is checked at its declared health path, at publish and on re-check (decision 128)', async () => {
    writePackage(h.catalogDir, 'apionly', {
      manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: apionly').replace('  path: /\n', '  path: /healthz\n').replace('expectedStatus: [200]', 'expectedStatus: [200, 204]'),
      compose: `services:\n  web:\n    image: example/apionly@${DIGEST_A}\n`,
      images: { web: `example/apionly@${DIGEST_A}` },
    });
    expect((await h.api.run({ kind: 'install', packageId: 'apionly' })).op.state).toBe('succeeded');
    const api = await byName('apionly');
    h.verifier.results.set('https://mcp.example.com/', { ok: false, status: 404, error: null });
    const before = h.verifier.calls.length;
    const op = await h.api.waitOperation((await h.api.submit((await h.api.plan({ kind: 'expose', instanceId: api.id, via: 'public', hostname: 'mcp.example.com', protection: 'none' })).id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.result?.['exposureState']).toBe('active');
    expect(op.result?.['url']).toBe('https://mcp.example.com/'); // the address shown stays the root
    const asked = h.verifier.calls.slice(before);
    expect(asked).toContain('https://mcp.example.com/healthz');
    expect(asked).not.toContain('https://mcp.example.com/');
    const i = h.verifier.calls.indexOf('https://mcp.example.com/healthz', before);
    expect(h.verifier.opts[i]?.expectStatus).toEqual(expect.arrayContaining([200, 204, 401]));
    // the periodic re-check probes the same path
    const mark = h.verifier.calls.length;
    await new Promise((r) => setTimeout(r, 1500));
    const later = h.verifier.calls.slice(mark).filter((u) => u.startsWith('https://mcp.example.com'));
    expect(later.length).toBeGreaterThan(0);
    expect(new Set(later)).toEqual(new Set(['https://mcp.example.com/healthz']));
    expect((await exposures()).items.find((x) => x.hostname === 'mcp.example.com')?.state).toBe('active');
    h.verifier.results.delete('https://mcp.example.com/');
    expect((await h.api.run({ kind: 'remove', instanceId: api.id })).op.state).toBe('succeeded');
  });
});
