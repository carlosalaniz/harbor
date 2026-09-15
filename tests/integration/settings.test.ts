import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FolderListingDto, HostStorageDto, PlatformToolDto, TailscaleLoginDto } from '../../src/contracts/api.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

// The console's Settings page, end to end against the daemon: password change, host storage and the
// folder picker, remote access (Tailscale login/logout) with the fake provider.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe('account', () => {
  it('changes the password with the current one, revokes other sessions, and rejects weak or wrong input', async () => {
    const other = await h.api.login(); // a second session that must be revoked
    await h.api.expectError(401, 'UNAUTHENTICATED', 'PUT', '/v1/account/password', { currentPassword: 'nope', newPassword: 'a-new-Password-1234' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/account/password', { currentPassword: ADMIN.password, newPassword: 'short' });
    const r = await h.api.expect<{ revokedSessions: number }>(200, 'PUT', '/v1/account/password', { currentPassword: ADMIN.password, newPassword: 'a-new-Password-1234' });
    expect(r.revokedSessions).toBeGreaterThanOrEqual(1);
    // the caller keeps working; the other session is gone
    await h.api.expect(200, 'GET', '/v1/system');
    const res = await h.api.raw('GET', '/v1/system', undefined, { authorization: `Bearer ${other.token}` });
    expect(res.status).toBe(401);
    // old password no longer logs in, new one does; then restore for the other tests
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/sessions', { username: ADMIN.username, password: ADMIN.password });
    await h.api.login(ADMIN.username, 'a-new-Password-1234');
    await h.api.expect(200, 'PUT', '/v1/account/password', { currentPassword: 'a-new-Password-1234', newPassword: ADMIN.password });
  });
});

describe('host storage and the folder picker', () => {
  it('lists the data folder and mounts, browses folders with system locations hidden, and creates folders only where allowed', async () => {
    const s = await h.api.expect<HostStorageDto>(200, 'GET', '/v1/host/storage');
    expect(s.dataFolder.path).toBe(h.userDataDir);
    expect(Array.isArray(s.mounts)).toBe(true);
    expect(s.inUse).toEqual([]);
    // browse the root: /etc, /proc, /usr … are hidden
    const root = await h.api.expect<FolderListingDto>(200, 'GET', `/v1/host/folders?path=${encodeURIComponent('/')}`);
    expect(root.parent).toBeNull();
    expect(root.entries.map((e) => e.name)).not.toContain('etc');
    expect(root.entries.map((e) => e.name)).not.toContain('proc');
    // create inside the data folder
    const created = await h.api.expect<{ path: string; writable: boolean }>(201, 'POST', '/v1/host/folders', { parent: h.userDataDir, name: 'Photos 2026' });
    expect(created.path).toBe(path.join(h.userDataDir, 'Photos 2026'));
    expect(existsSync(created.path)).toBe(true);
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/host/folders', { parent: h.userDataDir, name: 'Photos 2026' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/host/folders', { parent: h.userDataDir, name: '../escape' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/host/folders', { parent: '/etc', name: 'harbor' });
    const listing = await h.api.expect<FolderListingDto>(200, 'GET', `/v1/host/folders?path=${encodeURIComponent(h.userDataDir)}`);
    expect(listing.entries.map((e) => e.name)).toContain('Photos 2026');
    expect(listing.writable).toBe(true);
    // hidden folders are not shown; files are not shown
    mkdirSync(path.join(h.userDataDir, '.hidden'));
    writeFileSync(path.join(h.userDataDir, 'file.txt'), 'x');
    const again = await h.api.expect<FolderListingDto>(200, 'GET', `/v1/host/folders?path=${encodeURIComponent(h.userDataDir)}`);
    expect(again.entries.map((e) => e.name)).toEqual(['Photos 2026']);
    await h.api.expectError(422, 'INVALID_REQUEST', 'GET', `/v1/host/folders?path=${encodeURIComponent('/proc')}`);
  });

  it('a folder created in the picker can be used for an install and then shows up as in use', async () => {
    const folder = path.join(h.userDataDir, 'Photos 2026');
    const items = await h.api.expect<{ items: { id: string; claims: { id: string; external: unknown }[] }[] }>(200, 'GET', '/v1/catalog');
    const jelly = items.items.find((i) => i.id === 'jellyfin')!;
    const claim = jelly.claims.find((c) => c.external)!;
    const r = await h.api.run({ kind: 'install', packageId: 'jellyfin', storage: { [claim.id]: { hostPath: folder } } });
    expect(r.op.state).toBe('succeeded');
    const s = await h.api.expect<HostStorageDto>(200, 'GET', '/v1/host/storage');
    expect(s.inUse.map((f) => [f.path, f.instanceName, f.purpose])).toEqual([[folder, 'jellyfin', claim.id]]);
  });
});

describe('remote access (Tailscale) from the console', () => {
  it('logs out, offers a login URL, logs in with a key, and reports the fake key as invalid', async () => {
    await h.api.expect(204, 'POST', '/v1/platform-tools/tailscale/logout', {});
    let ts = (await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools')).items.find((t) => t.id === 'tailscale')!;
    expect(ts.installationState).toBe('setup_required');
    const url = await h.api.expect<TailscaleLoginDto>(200, 'POST', '/v1/platform-tools/tailscale/login', {});
    expect(url.status).toBe('login_url');
    expect(url.loginUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    await h.api.expectError(500, 'OPERATION_FAILED', 'POST', '/v1/platform-tools/tailscale/login', { authKey: 'tskey-fixture-bad' });
    const ok = await h.api.expect<TailscaleLoginDto>(200, 'POST', '/v1/platform-tools/tailscale/login', { authKey: 'tskey-fixture-good-1234' });
    expect(ok.status).toBe('logged_in');
    expect(h.tailscale.loginCalls.map((c) => c.authKey)).toEqual([null, 'tskey-fixture-bad', 'tskey-fixture-good-1234']);
    ts = (await h.api.expect<{ items: PlatformToolDto[] }>(200, 'GET', '/v1/platform-tools')).items.find((t) => t.id === 'tailscale')!;
    expect(ts.installationState).toBe('installed');
  });
});
