import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import type { InstanceSummary, StorageUsageDto } from '../../src/contracts/api.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const waitTicks = () => new Promise((r) => setTimeout(r, 1200)); // > 2 observer ticks at 500 ms

describe('per-app resource usage and storage inventory', () => {
  let a: InstanceSummary;

  it('reports live usage for a running app after an observer tick', async () => {
    h.fake.behaviour.stats = { '*': { cpuPercent: 2.5, memoryBytes: 128 * 1024 * 1024, memoryLimitBytes: 8 * 1024 * 1024 * 1024 } };
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    await waitTicks();
    a = await byName('excalidraw');
    expect(a.usage).not.toBeNull();
    expect(a.usage!.cpuPercent).toBe(2.5);
    expect(a.usage!.memoryBytes).toBe(128 * 1024 * 1024);
    expect(a.usage!.sampledAt).toBeTruthy();
  });

  it('clears usage when the app stops', async () => {
    const r = await h.api.run({ kind: 'stop', instanceId: a.id });
    expect(r.op.state).toBe('succeeded');
    await waitTicks();
    const stopped = await byName('excalidraw');
    expect(stopped.usage).toBeNull();
    await h.api.run({ kind: 'start', instanceId: a.id }); // leave it running for the df test
    await waitTicks();
  });

  it('groups volume sizes per app and reports unowned volumes separately', async () => {
    // A stateful app owns volumes; an unrelated volume must not be attributed to any app.
    const r = await h.api.run({ kind: 'install', packageId: 'n8n' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    await h.fake.createVolume('unrelated_data', { owner: 'someone-else' });
    const n8n = await byName('n8n');
    const volumeNames = [...h.fake.volumes.keys()].filter((n) => n.includes(n8n.id.replace(/-/g, '')));
    h.fake.behaviour.volumeSizes = Object.fromEntries([...volumeNames.map((n) => [n, 512 * 1024 * 1024] as const), ['unrelated_data', 99 * 1024 * 1024] as const]);

    const u = await h.api.expect<StorageUsageDto>(200, 'GET', '/v1/system/storage/usage');
    const app = u.apps.find((x) => x.instanceId === n8n.id);
    expect(app, JSON.stringify(u.apps)).toBeTruthy();
    expect(app!.volumes.length).toBeGreaterThan(0);
    expect(app!.totalBytes).toBe(app!.volumes.length * 512 * 1024 * 1024);
    expect(u.unownedBytes).toBeGreaterThanOrEqual(99 * 1024 * 1024);
    for (const other of u.apps) for (const v of other.volumes) expect(v.volumeName).not.toBe('unrelated_data');
  });

  it('caches the df result for 60 s (a size change is not visible immediately)', async () => {
    const before = await h.api.expect<StorageUsageDto>(200, 'GET', '/v1/system/storage/usage');
    h.fake.behaviour.volumeSizes = { ...h.fake.behaviour.volumeSizes, unrelated_data: 1 };
    const cached = await h.api.expect<StorageUsageDto>(200, 'GET', '/v1/system/storage/usage');
    expect(cached.sampledAt).toBe(before.sampledAt);
  });
});
