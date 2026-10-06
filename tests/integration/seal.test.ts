import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ExposureDto, InstanceSummary } from '../../src/contracts/api.js';
import { FakeCryptoProvider } from '../../src/storage/crypto-provider.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

// Decisions 142–143 (0.24.0): `harbor seal` moves a plain-volume app into a sealed home in place;
// an encrypted app's passphrase can change (or switch to/from Harbor's own key) without re-encrypting.
const crypto = new FakeCryptoProvider();
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { crypto } });
});
afterAll(async () => h.close());

const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const volumesOf = (inst: InstanceSummary) => [...h.fake.volumes.values()].filter((v) => v.labels['io.harbor.preview/instance'] === inst.id).map((v) => v.name).sort();
const composeVolumes = (inst: InstanceSummary) => Object.values((parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8')) as { volumes?: Record<string, { name: string }> }).volumes ?? {}).map((v) => v.name);

describe('harbor seal (decision 142)', () => {
  let app: InstanceSummary;

  it('installs memos on plain volumes and refuses to seal what has nothing to seal', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'memos' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    app = await byName('memos');
    expect(app.home).toBeNull();
    expect(volumesOf(app)).toHaveLength(1);
    expect((await h.api.run({ kind: 'expose', instanceId: app.id, via: 'public', hostname: 'memos.example.com' })).op.state).toBe('succeeded');
  });

  it('a failed copy leaves the app running unencrypted on the same volume, nothing deleted', async () => {
    const before = volumesOf(app);
    const plan = await h.api.plan({ kind: 'seal', instanceId: app.id });
    // fail only the import: sealing the empty home works
    const realImport = crypto.importVolumes.bind(crypto);
    crypto.importVolumes = async () => {
      throw new Error('not enough free space to seal this app');
    };
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    crypto.importVolumes = realImport;
    expect(op.state).toBe('failed');
    expect(op.error?.message).toMatch(/encrypting memos failed: not enough free space/);
    expect(op.error?.nextAction).toMatch(/runs unencrypted as before/);
    const after = await byName('memos');
    expect(after).toMatchObject({ installState: 'installed', runtime: 'running', home: null });
    expect(volumesOf(after)).toEqual(before);
    expect(composeVolumes(after)).toEqual(before);
  });

  it('seals in place: same id, name, ports and address; data copied by root into the sealed home; plain volume deleted last', async () => {
    const plain = volumesOf(app);
    const plan = await h.api.plan({ kind: 'seal', instanceId: app.id });
    expect(plan.location?.dir).toBe(path.join(h.userDataDir, 'harbor-apps', 'memos'));
    expect(plan.changes.at(-1)).toMatch(/^Only then delete the plain volume/);
    expect(plan.warnings.join(' ')).toMatch(/free space for one extra copy/);
    expect(plan.warnings.join(' ')).toMatch(/cannot be scrubbed/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const sealed = await byName('memos');
    expect(sealed.id).toBe(app.id);
    expect(sealed.endpoints[0]!.hostPort).toBe(app.endpoints[0]!.hostPort);
    expect(sealed.home).toMatchObject({ encrypted: true, state: 'unlocked', defaultKey: true, sealed: true, path: path.join(h.userDataDir, 'harbor-apps', 'memos', 'memos') });
    // the root step was asked to copy exactly this app's own volume
    const imp = crypto.imports.at(-1)!;
    expect(imp.home).toBe(sealed.home!.path);
    expect(imp.imports.map((i) => i.from)).toEqual(plain.map((n) => `/var/lib/docker/volumes/${n}/_data`));
    // the plain volume is gone, the app runs on the sealed copy
    expect(volumesOf(sealed)).toEqual(plain.map((n) => `${n}-sealed`));
    expect(composeVolumes(sealed)).toEqual(plain.map((n) => `${n}-sealed`));
    expect(h.fake.log.some((l) => l.includes(`volume create ${plain[0]}-sealed device=${sealed.home!.path}/volumes/`))).toBe(true);
    expect(op.events.map((e) => e.message).join('\n')).toMatch(/old blocks of its plain volumes may stay recoverable/);
    const ex = (await h.api.expect<{ items: ExposureDto[] }>(200, 'GET', '/v1/exposures')).items;
    expect(ex.map((e) => e.hostname)).toEqual(['memos.example.com']);
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'seal', instanceId: app.id });
    app = sealed;
  });

  it('a sealed app survives Stop/Start and Remove/Reinstall on its sealed volumes', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: app.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: app.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'remove', instanceId: app.id })).op.state).toBe('succeeded');
    const re = await h.api.run({ kind: 'reinstall', instanceId: app.id });
    expect(re.op.state, JSON.stringify(re.op.error)).toBe('succeeded');
    expect(composeVolumes(await byName('memos'))).toEqual(volumesOf(app));
  });
});

describe('change an encrypted app\'s passphrase (decision 143)', () => {
  let app: InstanceSummary;
  const PASS = 'a fresh app passphrase';

  it('switches from Harbor\'s own key to an own passphrase without the old one (this machine opens it), issuing its own words once', async () => {
    app = await byName('memos');
    const before = readFileSync(path.join(app.home!.path, 'manifest.json'), 'utf8');
    const r = await h.api.expect<{ instance: InstanceSummary; recoveryKey: string | null }>(200, 'POST', `/v1/instances/${app.id}/passphrase`, { next: PASS });
    expect(r.recoveryKey?.split(' ')).toHaveLength(12);
    expect(r.instance.home).toMatchObject({ silentUnlock: false });
    expect(r.instance.home?.defaultKey).toBeUndefined();
    const m = JSON.parse(readFileSync(path.join(app.home!.path, 'manifest.json'), 'utf8'));
    expect(m.encryption.recovery).toBeDefined();
    expect(m.encryption.installation).toEqual(JSON.parse(before).encryption.installation); // the Harbor card still opens it
    expect(JSON.stringify(m)).not.toContain(PASS);
    // the new passphrase unlocks it; nothing was re-encrypted (no kernel calls besides unlock)
    const calls = crypto.calls.length;
    await h.api.expect(200, 'POST', `/v1/instances/${app.id}/unlock`, { passphrase: PASS });
    expect(crypto.calls.slice(calls).every((c) => c.op === 'unlockApp')).toBe(true);
  });

  it('a custom passphrase change needs the current one; wrong ones are refused; short new ones too', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${app.id}/passphrase`, { next: 'another passphrase' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${app.id}/passphrase`, { current: 'wrong passphrase', next: 'another passphrase' });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${app.id}/passphrase`, { current: PASS, next: 'short' });
    const r = await h.api.expect<{ recoveryKey: string | null }>(200, 'POST', `/v1/instances/${app.id}/passphrase`, { current: PASS, next: 'another passphrase' });
    expect(r.recoveryKey).toBeNull(); // it already has its own words
  });

  it('the Harbor password as passphrase unlocks at login; switching back to Harbor\'s own key drops the app\'s own words', async () => {
    const r = await h.api.expect<{ instance: InstanceSummary }>(200, 'POST', `/v1/instances/${app.id}/passphrase`, { current: 'another passphrase', next: ADMIN.password });
    expect(r.instance.home?.silentUnlock).toBe(true);
    const back = await h.api.expect<{ instance: InstanceSummary; recoveryKey: string | null }>(200, 'POST', `/v1/instances/${app.id}/passphrase`, { next: null });
    expect(back.instance.home).toMatchObject({ defaultKey: true, silentUnlock: true });
    expect(back.recoveryKey).toBeNull();
    const m = JSON.parse(readFileSync(path.join(app.home!.path, 'manifest.json'), 'utf8'));
    expect(m.encryption.recovery).toBeUndefined();
  });

  it('purge deletes the sealed home through the root step (container-owned files; decision 144)', async () => {
    const home = (await byName('memos')).home!.path;
    expect((await h.api.run({ kind: 'purge', instanceId: app.id })).op.state).toBe('succeeded');
    expect(crypto.calls.filter((c) => c.op === 'destroyHome').map((c) => c.home)).toContain(home);
    expect(existsSync(home)).toBe(false);
  });
});

describe('move an encrypted app (decision 145)', () => {
  let app: InstanceSummary;
  let drive = '';

  it('installs memos sealed in the data folder with some data', async () => {
    const { tmpdir } = await import('node:os');
    drive = mkdtempSync(path.join(tmpdir(), 'harbor-move-drive-'));
    mkdirSync(path.join(drive, 'harbor-apps'));
    const r = await h.api.run({ kind: 'install', packageId: 'memos', name: 'mover', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'memos') } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    app = await byName('mover');
    writeFileSync(path.join(app.home!.path, 'volumes', 'data', 'note.txt'), 'keep me');
  });

  it('refuses a plain app, the same place and a missing location', async () => {
    const plain = (await h.api.run({ kind: 'install', packageId: 'excalidraw', name: 'plainone' })).op;
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'move', instanceId: plain.instanceId, location: { dir: path.join(drive, 'harbor-apps', 'excalidraw') } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'move', instanceId: app.id, location: { dir: path.join(h.userDataDir, 'harbor-apps', 'memos') } });
  });

  it('a failed copy puts it back where it was; the half-made target is deleted', async () => {
    const orig = crypto.transferHome.bind(crypto);
    crypto.transferHome = async () => {
      throw new Error('the copy differs from the original');
    };
    const plan = await h.api.plan({ kind: 'move', instanceId: app.id, location: { dir: path.join(drive, 'harbor-apps', 'memos') } });
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    crypto.transferHome = orig;
    expect(op.state).toBe('failed');
    expect(op.error?.nextAction).toMatch(/runs from .* as before/);
    const back = await byName('mover');
    expect(back).toMatchObject({ installState: 'installed', runtime: 'running' });
    expect(back.home!.path).toBe(app.home!.path);
    expect(existsSync(path.join(drive, 'harbor-apps', 'memos', 'mover'))).toBe(false);
    expect(composeVolumes(back)).toEqual(volumesOf(back));
  });

  it('moves to the drive: same id, port and key; data there; old home and volumes gone', async () => {
    const oldVolumes = volumesOf(app);
    const plan = await h.api.plan({ kind: 'move', instanceId: app.id, location: { dir: path.join(drive, 'harbor-apps', 'memos') } });
    expect(plan.changes[1]).toMatch(/same app key/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const moved = await byName('mover');
    const target = path.join(drive, 'harbor-apps', 'memos', 'mover');
    expect(moved.id).toBe(app.id);
    expect(moved.endpoints[0]!.hostPort).toBe(app.endpoints[0]!.hostPort);
    expect(moved.home).toMatchObject({ path: target, state: 'unlocked', sealed: true, defaultKey: true });
    expect(readFileSync(path.join(target, 'volumes', 'data', 'note.txt'), 'utf8')).toBe('keep me');
    expect(JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8')).instanceId).toBe(app.id);
    expect(existsSync(app.home!.path)).toBe(false);
    const now = volumesOf(moved);
    expect(now.some((v) => oldVolumes.includes(v))).toBe(false);
    expect(composeVolumes(moved)).toEqual(now);
    expect(crypto.transfers.at(-1)).toEqual({ from: app.home!.path, to: target });
    // and back again, through the same path
    const back = await h.api.run({ kind: 'move', instanceId: app.id, location: { dir: path.join(h.userDataDir, 'harbor-apps', 'memos') } });
    expect(back.op.state, JSON.stringify(back.op.error)).toBe('succeeded');
    expect(readFileSync(path.join((await byName('mover')).home!.path, 'volumes', 'data', 'note.txt'), 'utf8')).toBe('keep me');
  });
});
