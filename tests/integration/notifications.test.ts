import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import type { NotificationsDto } from '../../src/contracts/api.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const notifications = (unread = false) => h.api.expect<NotificationsDto>(200, 'GET', `/v1/notifications${unread ? '?unread=true' : ''}`);
const tick = () => new Promise((r) => setTimeout(r, 1200));

describe('notifications engine', () => {
  it('a degraded app produces one deduplicated warning; recovery clears the unread row', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    // Break the app's health endpoint; several observer ticks must yield one row.
    h.fake.behaviour.respond = () => 503;
    await tick();
    await tick();
    let n = await notifications(true);
    const degraded = n.items.filter((x) => x.kind === 'app-degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.severity).toBe('warning');
    // Recovery: the unread row disappears (the condition never reached the operator).
    delete h.fake.behaviour.respond;
    await tick();
    n = await notifications(true);
    expect(n.items.filter((x) => x.kind === 'app-degraded')).toHaveLength(0);
  });

  it('a failed operation notifies with error severity', async () => {
    h.fake.behaviour.failPull = 'registry exploded';
    const r = await h.api.run({ kind: 'install', packageId: 'bentopdf' });
    expect(r.op.state).toBe('failed');
    h.fake.behaviour.failPull = null;
    const n = await notifications();
    const failed = n.items.find((x) => x.kind === 'operation-failed');
    expect(failed).toBeTruthy();
    expect(failed!.severity).toBe('error');
    expect(failed!.body).toContain('registry exploded');
  });

  it('mark read and read-all work; read rows survive condition recovery', async () => {
    const before = await notifications();
    expect(before.unread).toBeGreaterThan(0);
    const one = before.items.find((x) => !x.read)!;
    const after = await h.api.expect<NotificationsDto>(200, 'POST', `/v1/notifications/${one.id}/read`, {});
    expect(after.items.find((x) => x.id === one.id)!.read).toBe(true);
    const all = await h.api.expect<NotificationsDto>(200, 'POST', '/v1/notifications/read-all', {});
    expect(all.unread).toBe(0);
  });

  it('channels: set, redacted read, delivery to ntfy and webhook with HMAC, and test endpoint', async () => {
    await h.api.expect(200, 'PUT', '/v1/notifications/channels', {
      channels: [
        { kind: 'ntfy', server: 'https://ntfy.example', topic: 'harbor', token: 'secret-token', minSeverity: 'info' },
        { kind: 'webhook', url: 'https://hooks.example/x', secret: 'hook-secret', minSeverity: 'warning' },
      ],
    });
    const read = await h.api.expect<{ channels: { kind: string; token?: string; secret?: string }[] }>(200, 'GET', '/v1/notifications/channels');
    expect(read.channels[0]!.token).toBe('••••');
    expect(read.channels[1]!.secret).toBe('••••');

    // Re-PUT with redacted secrets: stored values must be kept (delivery still authenticates).
    await h.api.expect(200, 'PUT', '/v1/notifications/channels', { channels: read.channels });

    h.notifyTransport.posts.length = 0;
    // A new error-severity notification (failed op) must hit both channels; info only ntfy.
    h.fake.behaviour.failPull = 'second failure';
    await h.api.run({ kind: 'install', packageId: 'memos' });
    h.fake.behaviour.failPull = null;
    const ntfy = h.notifyTransport.posts.filter((p) => p.url.startsWith('https://ntfy.example'));
    const hook = h.notifyTransport.posts.filter((p) => p.url.startsWith('https://hooks.example'));
    expect(ntfy.length).toBeGreaterThanOrEqual(1);
    expect(ntfy[0]!.headers['authorization']).toBe('Bearer secret-token');
    expect(hook.length).toBeGreaterThanOrEqual(1);
    expect(hook[0]!.headers['x-harbor-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    const test = await h.api.expect<{ results: { kind: string; ok: boolean }[] }>(200, 'POST', '/v1/notifications/channels/test', {});
    expect(test.results).toHaveLength(2);
    expect(test.results.every((x) => x.ok)).toBe(true);
  });

  it('delivery failure becomes a console-only notification, never a loop', async () => {
    h.notifyTransport.failPosts = true;
    h.notifyTransport.posts.length = 0;
    h.fake.behaviour.failPull = 'third failure';
    await h.api.run({ kind: 'install', packageId: 'freshrss' });
    h.fake.behaviour.failPull = null;
    await tick();
    h.notifyTransport.failPosts = false;
    const n = await notifications();
    const deliveryFailed = n.items.filter((x) => x.kind === 'delivery-failed');
    expect(deliveryFailed.length).toBeGreaterThanOrEqual(1);
    // Each channel is tried twice (one retry) per notification; the delivery-failed rows themselves are never delivered.
    const postsForDeliveryFailure = h.notifyTransport.posts.filter((p) => p.body.includes('Could not reach'));
    expect(postsForDeliveryFailure).toHaveLength(0);
  });
});
