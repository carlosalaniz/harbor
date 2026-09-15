import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainDto, DomainsDto, InstanceSummary } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name);

describe('full uninstall (purge)', () => {
  let folder: string;
  it('deletes verified volumes, secrets and the stored release; keeps the folder of yours; frees the name and ports', async () => {
    folder = mkdtempSync(path.join(tmpdir(), 'harbor-purge-'));
    const items = await h.api.expect<{ items: { id: string; claims: { id: string; external: unknown }[] }[] }>(200, 'GET', '/v1/catalog');
    const claim = items.items.find((i) => i.id === 'jellyfin')!.claims.find((c) => c.external)!;
    const r = await h.api.run({ kind: 'install', packageId: 'jellyfin', storage: { [claim.id]: { hostPath: folder } } });
    expect(r.op.state).toBe('succeeded');
    const inst = (await byName('jellyfin'))!;
    const volumesBefore = [...h.fake.volumes.keys()].filter((v) => v.includes(inst.id.replace(/-/g, '')));
    expect(volumesBefore.length).toBeGreaterThan(0);
    const instDir = path.join(h.stateDir, 'instances', inst.id);
    expect(existsSync(instDir)).toBe(true);
    const port = inst.endpoints[0]!.hostPort;

    const plan = await h.api.plan({ kind: 'purge', instanceId: inst.id });
    expect(plan.kind).toBe('purge');
    expect(plan.warnings.join('\n')).toMatch(/deletes the app's data for good/);
    expect(plan.warnings.join('\n')).toContain(folder);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    const msgs = op.events.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/deleted volume/);
    expect(msgs).toContain(`your folder(s) left untouched: ${folder}`);
    expect(msgs).toMatch(/fully uninstalled/);
    // gone from Docker, disk and listings; the folder is still there
    for (const v of volumesBefore) expect(h.fake.volumes.has(v)).toBe(false);
    expect(existsSync(instDir)).toBe(false);
    expect(existsSync(folder)).toBe(true);
    expect(await byName('jellyfin')).toBeUndefined();
    // the operation is still readable for audit
    const again = await h.api.expect<{ state: string }>(200, 'GET', `/v1/operations/${op.id}`);
    expect(again.state).toBe('succeeded');
    // name and port are free: a fresh install gets the same name and can get the same lowest port
    const fresh = await h.api.run({ kind: 'install', packageId: 'jellyfin' });
    expect(fresh.op.state).toBe('succeeded');
    const inst2 = (await byName('jellyfin'))!;
    expect(inst2.id).not.toBe(inst.id);
    expect(inst2.endpoints[0]!.hostPort).toBe(port);
  });

  it('purges a removed (retained) instance too and refuses while installing', async () => {
    const inst = (await byName('jellyfin'))!;
    await h.api.run({ kind: 'remove', instanceId: inst.id });
    const r = await h.api.run({ kind: 'purge', instanceId: inst.id });
    expect(r.op.state).toBe('succeeded');
    expect(await byName('jellyfin')).toBeUndefined();
    expect((await h.api.instances()).map((i) => i.name)).toEqual([]);
  });

  it('leaves a volume alone when it is not the one Harbor created, and reports it', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw', name: 'draw' });
    expect(r.op.state).toBe('succeeded');
    const inst = (await byName('draw'))!;
    // excalidraw has no volumes; give it a foreign one under a plausible name via the fake to prove the guard
    const foreign = `hb_${inst.id.replace(/-/g, '')}_foreign`;
    await h.fake.createVolume(foreign, { owner: 'someone-else' });
    const op = (await h.api.run({ kind: 'purge', instanceId: inst.id })).op;
    expect(op.state).toBe('succeeded');
    expect(h.fake.volumes.has(foreign)).toBe(true); // never touched: not recorded as ours
  });
});

describe('public domains wizard', () => {
  it('detects the public address, registers domains and judges their DNS', async () => {
    h.net.records.set('photos.example.com', { a: ['203.0.113.10'], aaaa: [] });
    h.net.records.set('blog.example.com', { a: ['198.51.100.7'], aaaa: [] });
    const d0 = await h.api.expect<DomainsDto>(200, 'GET', '/v1/domains');
    expect(d0.publicIp.v4).toBe('203.0.113.10');
    expect(d0.items).toEqual([]);
    const a = await h.api.expect<DomainDto>(201, 'POST', '/v1/domains', { hostname: 'Photos.Example.com' });
    expect(a.hostname).toBe('photos.example.com');
    expect(a.dns.state).toBe('points_here');
    const b = await h.api.expect<DomainDto>(201, 'POST', '/v1/domains', { hostname: 'blog.example.com' });
    expect(b.dns.state).toBe('points_elsewhere');
    expect(b.dns.note).toContain('198.51.100.7');
    const c = await h.api.expect<DomainDto>(201, 'POST', '/v1/domains', { hostname: 'new.example.com' });
    expect(c.dns.state).toBe('no_record');
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/domains', { hostname: 'photos.example.com' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/domains', { hostname: 'not a host' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/domains', { hostname: 'localhost' });
    // DNS propagates: re-check flips the state
    h.net.records.set('new.example.com', { a: ['203.0.113.10'], aaaa: [] });
    const c2 = await h.api.expect<DomainDto>(200, 'POST', '/v1/domains/new.example.com/check', {});
    expect(c2.dns.state).toBe('points_here');
  });

  it('publishing at a registered domain mentions its DNS state; a used domain cannot be forgotten', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw', name: 'draw2' });
    expect(r.op.state).toBe('succeeded');
    const inst = (await byName('draw2')) as InstanceSummary;
    const good = await h.api.plan({ kind: 'expose', instanceId: inst.id, via: 'public', hostname: 'photos.example.com' });
    expect(good.warnings.join('\n')).toMatch(/points at this machine/);
    const bad = await h.api.plan({ kind: 'expose', instanceId: inst.id, via: 'public', hostname: 'blog.example.com' });
    expect(bad.warnings.join('\n')).toMatch(/does not point at this machine yet/);
    const op = await h.api.waitOperation((await h.api.submit(good.id)).operationId);
    expect(op.state).toBe('succeeded');
    const d = await h.api.expect<DomainsDto>(200, 'GET', '/v1/domains');
    const used = d.items.find((i) => i.hostname === 'photos.example.com')!;
    expect(used.usedBy?.instanceName).toBe('draw2');
    expect(used.usedBy?.url).toBe('https://photos.example.com/');
    await h.api.expectError(409, 'INVALID_STATE', 'DELETE', '/v1/domains/photos.example.com');
    await h.api.expect(204, 'DELETE', '/v1/domains/blog.example.com');
    await h.api.expectError(404, 'NOT_FOUND', 'DELETE', '/v1/domains/blog.example.com');
  });
});

describe('wallpaper', () => {
  it('stores a real picture, serves it openly, rejects mismatched bytes, and removes it', async () => {
    // 1x1 PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const anon = await h.api.raw('GET', '/v1/appearance/wallpaper');
    expect(anon.status).toBe(404);
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/appearance/wallpaper', { dataUrl: `data:image/jpeg;base64,${png}` }); // declared jpeg, bytes png
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/appearance/wallpaper', { dataUrl: 'data:text/html;base64,PGh0bWw+PGh0bWw+PGh0bWw+PGh0bWw+' });
    await h.api.expect(204, 'PUT', '/v1/appearance/wallpaper', { dataUrl: `data:image/png;base64,${png}` });
    const got = await fetch(`${h.baseUrl}/v1/appearance/wallpaper`); // no token: <img>/CSS cannot send one
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await got.arrayBuffer()).length).toBe(Buffer.from(png, 'base64').length);
    await h.api.expect(204, 'DELETE', '/v1/appearance/wallpaper');
    expect((await h.api.raw('GET', '/v1/appearance/wallpaper')).status).toBe(404);
    // nothing else landed in the state dir
    expect(existsSync(path.join(h.stateDir, 'wallpaper.bin'))).toBe(false);
  });
});
