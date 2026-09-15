import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import type { PlatformToolDto } from '../../src/contracts/api.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { toolsProbe: async (url) => (url.includes('9090') ? { reachable: true, note: 'Login page reachable (HTTP 200).' } : { reachable: false, note: 'not reachable: ECONNREFUSED' }) } });
});
afterAll(async () => {
  await h.close();
});

describe('platform tools state and binding', () => {
  it('absent tools are reported as not_installed with no link', async () => {
    const all = (await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools')).items;
    expect(all.map((t) => t.id).sort()).toEqual(['cockpit', 'portainer', 'proxy', 'tailscale']);
    const items = all.filter((t) => t.id === 'cockpit' || t.id === 'portainer');
    for (const t of items) {
      expect(t.installationState).toBe('not_installed');
      expect(t.browserUrl).toBeNull();
      expect(t.mode).toBe('absent');
    }
  });
  it('binds an existing tool by loopback URL only, reports reachability honestly, and unbinds', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/platform-tools/cockpit', { browserUrl: 'https://192.168.1.5:9090/' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/platform-tools/cockpit', { browserUrl: 'ftp://localhost/' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/platform-tools/grafana', { browserUrl: 'https://localhost:3000/' });
    const bound = await h.api.expect<{ items: PlatformToolDto[] }>(200, 'PUT', '/v1/platform-tools/cockpit', { browserUrl: 'https://localhost:9090/' });
    const cockpit = bound.items.find((t) => t.id === 'cockpit')!;
    expect(cockpit).toMatchObject({ mode: 'external', installationState: 'installed', availability: 'reachable', browserUrl: 'https://localhost:9090/' });
    expect(cockpit.note).toMatch(/without taking ownership/);
    const portainer = await h.api.expect<{ items: PlatformToolDto[] }>(200, 'PUT', '/v1/platform-tools/portainer', { browserUrl: 'https://localhost:9443/' });
    expect(portainer.items.find((t) => t.id === 'portainer')).toMatchObject({ mode: 'external', availability: 'unreachable' });
    expect((await h.api.raw('DELETE', '/v1/platform-tools/portainer')).status).toBe(204);
    const after = await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools');
    expect(after.items.find((t) => t.id === 'portainer')).toMatchObject({ installationState: 'not_installed', browserUrl: null });
    await h.api.expectError(404, 'NOT_FOUND', 'DELETE', '/v1/platform-tools/portainer');
  });
});
