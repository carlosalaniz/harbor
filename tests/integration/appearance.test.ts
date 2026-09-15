import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppearanceDto, InstanceSummary, SystemHostDto, SystemMetricsDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==';

describe('rotating wallpapers', () => {
  it('is off by default with keyless Bing as the suggested source; turning on fetches a picture at once and serves it openly', async () => {
    const a0 = await h.api.expect<AppearanceDto>(200, 'GET', '/v1/appearance');
    expect(a0.rotation).toMatchObject({ enabled: false, source: 'bing', everyHours: 24, nextAt: null, reddit: { clientId: null, hasSecret: false } });
    expect(a0.wallpaper.kind).toBe('none');
    const a1 = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/rotation', { enabled: true, everyHours: 6 });
    expect(a1.wallpaper.kind).toBe('rotating');
    expect(a1.wallpaper.current).toMatchObject({ sourceName: 'Bing', author: expect.stringContaining('Demo') as string });
    expect(a1.rotation.lastError).toBeNull();
    expect(a1.rotation.nextAt).not.toBeNull();
    expect(new Date(a1.rotation.nextAt!).getTime() - h.clock.now().getTime()).toBeGreaterThan(5 * 3600_000);
    const img = await fetch(`${h.baseUrl}/v1/appearance/wallpaper`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-security-policy')).toContain('sandbox');
    // the daemon fetched from the source, the browser never did
    expect(h.fetcher.requests.some((r) => r.url.startsWith('https://www.bing.com/th?id='))).toBe(true);
    expect(h.fetcher.requests.every((r) => r.headers['user-agent'] === undefined)).toBe(true); // UA is added by the real fetcher only
  });

  it('skips to another picture on demand and on schedule; a failing source keeps the last picture and reports the error', async () => {
    const before = (await h.api.expect<AppearanceDto>(200, 'GET', '/v1/appearance')).wallpaper.current!;
    const a = await h.api.expect<AppearanceDto>(200, 'POST', '/v1/appearance/rotation/next', {});
    expect(a.wallpaper.current!.title).not.toBe(before.title);
    // schedule: advance past nextAt, tick → refreshed
    const n = h.fetcher.requests.length;
    h.clock.advance(7 * 3600_000);
    await h.daemon.appearance.tick();
    expect(h.fetcher.requests.length).toBeGreaterThan(n);
    h.api.token = (await h.api.login()).token; // the clock jump expired the session
    // source failure
    h.fetcher.routes.unshift({ match: (u) => u.startsWith('https://www.bing.com/HPImageArchive'), reply: () => ({ status: 503, contentType: 'text/plain', body: Buffer.from('down') }) });
    const bad = await h.api.expect<AppearanceDto>(200, 'POST', '/v1/appearance/rotation/next', {});
    expect(bad.rotation.lastError).toMatch(/Bing answered HTTP 503/);
    expect(bad.wallpaper.kind).toBe('rotating'); // last good picture still shown
    h.fetcher.routes.shift();
  });

  it('reddit needs app credentials; the secret is stored but never returned; subreddits are validated', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/appearance/rotation', { source: 'reddit' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/appearance/rotation', { subreddits: ['not valid!'] });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/appearance/rotation', { reddit: { clientId: 'abc' } }); // no secret yet
    const a = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/rotation', { source: 'reddit', subreddits: ['EarthPorn', 'r/SpacePorn'], reddit: { clientId: 'abc', clientSecret: 'shh' } });
    expect(a.rotation).toMatchObject({ source: 'reddit', subreddits: ['EarthPorn', 'SpacePorn'], reddit: { clientId: 'abc', hasSecret: true } });
    expect(JSON.stringify(a)).not.toContain('shh');
    expect(a.wallpaper.current).toMatchObject({ sourceName: expect.stringMatching(/^r\//) as string, author: 'u/demo_user', link: expect.stringContaining('reddit.com/r/') as string });
    // updating the client id alone keeps the stored secret
    const b = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/rotation', { reddit: { clientId: 'abc' } });
    expect(b.rotation.reddit.hasSecret).toBe(true);
    // bad credentials surface as a clear error, nothing crashes
    const c = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/rotation', { reddit: { clientId: 'bad', clientSecret: 'bad' } });
    expect(c.rotation.lastError).toMatch(/refused the app credentials/);
    // off: the uploaded picture (if any) or presets take over; next is refused
    await h.api.expect(204, 'PUT', '/v1/appearance/wallpaper', { dataUrl: `data:image/png;base64,${png}` });
    const off = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/rotation', { enabled: false });
    expect(off.wallpaper.kind).toBe('uploaded');
    expect(off.rotation.nextAt).toBeNull();
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/appearance/rotation/next', {});
    await h.api.expect(204, 'DELETE', '/v1/appearance/wallpaper');
    expect((await h.api.expect<AppearanceDto>(200, 'GET', '/v1/appearance')).wallpaper.kind).toBe('none');
  });
});

describe('launcher: order and per-app look', () => {
  it('stores the order (unknown ids dropped), display name and icon; the icon picture is served openly; purge cleans up', async () => {
    const a = await h.api.run({ kind: 'install', packageId: 'excalidraw', name: 'draw' });
    const b = await h.api.run({ kind: 'install', packageId: 'memos' });
    expect(a.op.state).toBe('succeeded');
    expect(b.op.state).toBe('succeeded');
    const [draw, memos] = [a.plan.instanceId, b.plan.instanceId];
    const o = await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/home', { order: [memos, draw, '00000000-0000-4000-8000-000000000000', memos] });
    expect(o.home.order).toEqual([memos, draw]);
    // glyph icon + name
    const s1 = await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${draw}/appearance`, { displayName: '  Whiteboard ', icon: { kind: 'glyph', glyph: '🎨', color: '#FF8800' } });
    expect(s1.displayName).toBe('Whiteboard');
    expect(s1.customIcon).toEqual({ kind: 'glyph', glyph: '🎨', color: '#ff8800' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', `/v1/instances/${draw}/appearance`, { icon: { kind: 'glyph', glyph: 'toolong', color: '#ff8800' } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', `/v1/instances/${draw}/appearance`, { displayName: 'x'.repeat(41) });
    // picture icon
    const s2 = await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${draw}/appearance`, { icon: { kind: 'image', dataUrl: `data:image/png;base64,${png}` } });
    expect(s2.customIcon?.kind).toBe('image');
    const url = (s2.customIcon as { url: string }).url;
    expect(url).toMatch(new RegExp(`^/v1/instances/${draw}/icon\\?v=`));
    const img = await fetch(`${h.baseUrl}${url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(existsSync(path.join(h.stateDir, 'icons', `${draw}.bin`))).toBe(true);
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', `/v1/instances/${draw}/appearance`, { icon: { kind: 'image', dataUrl: `data:image/jpeg;base64,${png}` } });
    // listing carries the look; default resets it
    expect((await h.api.instances()).find((i) => i.id === draw)).toMatchObject({ displayName: 'Whiteboard', customIcon: { kind: 'image' } });
    const s3 = await h.api.expect<InstanceSummary>(200, 'PUT', `/v1/instances/${draw}/appearance`, { displayName: null, icon: { kind: 'default' } });
    expect(s3.displayName).toBeNull();
    expect(s3.customIcon).toBeNull();
    expect(existsSync(path.join(h.stateDir, 'icons', `${draw}.bin`))).toBe(false);
    expect((await fetch(`${h.baseUrl}${url}`)).status).toBe(404);
    // purge removes the icon file and the id from the order
    await h.api.expect(200, 'PUT', `/v1/instances/${memos}/appearance`, { icon: { kind: 'image', dataUrl: `data:image/png;base64,${png}` } });
    expect((await h.api.run({ kind: 'purge', instanceId: memos })).op.state).toBe('succeeded');
    expect(existsSync(path.join(h.stateDir, 'icons', `${memos}.bin`))).toBe(false);
    await h.api.expectError(404, 'NOT_FOUND', 'PUT', `/v1/instances/${memos}/appearance`, { displayName: 'gone' });
    // the order entry is dropped lazily: re-saving keeps only known ids
    expect((await h.api.expect<AppearanceDto>(200, 'PUT', '/v1/appearance/home', { order: [memos, draw] })).home.order).toEqual([draw]);
  });
});

describe('the machine', () => {
  it('reports host facts and temperature slot; restart and shutdown go through the power control', async () => {
    const m = await h.api.expect<SystemMetricsDto>(200, 'GET', '/v1/system/metrics');
    expect(m.host.hostname.length).toBeGreaterThan(0);
    expect(m.temperatureC === null || typeof m.temperatureC === 'number').toBe(true);
    const host = await h.api.expect<SystemHostDto>(200, 'GET', '/v1/system/host');
    expect(host.power.available).toBe(true);
    await h.api.expect(202, 'POST', '/v1/system/power', { action: 'reboot' });
    await h.api.expect(202, 'POST', '/v1/system/power', { action: 'poweroff' });
    expect(h.power.calls).toEqual(['reboot', 'poweroff']);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/system/power', { action: 'explode' });
  });
});
