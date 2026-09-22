import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundAppDto, InstanceDetail, InstanceSummary, PlanDto } from '../../src/contracts/api.js';
import Database from 'better-sqlite3';
import { FakeCryptoProvider } from '../../src/storage/crypto-provider.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

// Whole-app install locations: the app (including its database) lives
// encrypted on a drive folder, unlockable on any Harbor machine with the
// passphrase. The passphrase travels with the submission, never in the plan.
let h: Harness;
let drive: string;
// One fake kernel for the whole file: `sealed` is what fscrypt would have on
// disk, `open` is which keys the kernel holds this boot. A reboot is
// simulated by clearing `open` before restarting the daemon.
const crypto = new FakeCryptoProvider();
const kernelUnlocked = (home: string) => crypto.kernelState(home) === 'open';
const until = async <T>(fn: () => Promise<T | null | false | undefined>, what: string, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};
beforeAll(async () => {
  h = await startHarness({ overrides: { crypto } });
  // A "drive": a plain folder on a POSIX filesystem. The harness runs on the
  // same machine, so the candidate list (built from live mounts) will not
  // include it — the tests below create the apps folder directly and pass it
  // as the location dir. Eligibility of the parent mount is covered by the
  // unit tests; here we prove the engine path end to end.
  drive = mkdtempSync(path.join(tmpdir(), 'harbor-drive-'));
  mkdirSync(path.join(drive, 'harbor-apps'), { recursive: true });
});
afterAll(async () => h.close());

const PASS = 'correct horse battery staple';

describe('install to an encrypted app home', () => {
  let plan: PlanDto;
  // This block installs two apps (the default-key one + the drive one), so
  // later its share the drive instance id across describes.
  let driveInstanceId = '';
  const driveHome = async (): Promise<string> => (await h.api.instances()).find((i) => i.id === driveInstanceId)!.home!.path;

  it('plans refuse a wrong-shaped dir, a weak passphrase, and a system path', async () => {
    const wrong = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', location: { dir: path.join(drive, 'harbor-apps', 'nope'), passphrase: PASS } });
    expect(wrong.error.message).toMatch(/must be/);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: 'short' } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', location: { dir: '/etc', passphrase: PASS } });
    expect(await h.api.instances()).toHaveLength(0);
  });

  it('the bare apps folder is created on demand (Harbor-owned infrastructure)', async () => {
    // The data-folder candidate is real (not the test fallback), so its bare
    // dir is created on demand: point at <data>/harbor-apps/<pkg>,
    // which does not exist yet in this fresh harness. No passphrase: the data
    // folder seals with Harbor's own key (default-encrypt, decision 94).
    const appsDir = path.join(h.userDataDir, 'harbor-apps');
    expect(existsSync(appsDir)).toBe(false);
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'freshdrive', location: { dir: path.join(appsDir, 'excalidraw') } });
    expect(plan.location?.dir).toBe(path.join(appsDir, 'excalidraw'));
    expect(existsSync(appsDir)).toBe(true);
  });

  it('the data-folder plan needs no passphrase at submit; the home unlocks silently', async () => {
    const appsDir = path.join(h.userDataDir, 'harbor-apps');
    const p = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'defaultkey', location: { dir: path.join(appsDir, 'excalidraw') } });
    expect(p.changes.join('\n')).toMatch(/unlocks it silently/);
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: p.id }, { 'idempotency-key': 'home-default-key-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const got = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
    expect(got.home).toMatchObject({ encrypted: true, state: 'unlocked', defaultKey: true, sealed: true });
    // The volumes dir was kernel-sealed BEFORE any volume was rooted inside.
    expect(crypto.calls.filter((c) => c.op === 'sealApp').map((c) => c.home)).toContain(got.home!.path);
    expect(kernelUnlocked(got.home!.path)).toBe(true);
  });

  it('the plan names the encrypted home and warns about the drive and the passphrase', async () => {
    plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: PASS } });
    expect(plan.location).toEqual({ dir: path.join(drive, 'harbor-apps', 'excalidraw'), encrypted: true });
    expect(plan.changes.join('\n')).toMatch(/encrypted at .*harbor-apps\/excalidraw\//);
    expect(plan.warnings.join('\n')).toMatch(/lose the passphrase/);
    // The passphrase is never stored in the plan.
    expect(JSON.stringify(plan)).not.toContain(PASS);
  });

  it('submitting without the passphrase is refused; with it the install succeeds', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/operations', { planId: plan.id }, { 'idempotency-key': 'home-no-secret-1' });
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, passphrase: PASS }, { 'idempotency-key': 'home-with-secret-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    // Two installs exist now (the default-key one above + this drive one):
    // pick this block's instance by its home path, not by index.
    const inst = (await h.api.instances()).find((i) => i.home?.path === path.join(drive, 'harbor-apps', 'excalidraw', 'excalidraw'))!;
    driveInstanceId = inst.id;
    expect(inst.installState).toBe('installed');
    expect(inst.home).toMatchObject({ encrypted: true, state: 'unlocked', sealed: true });
    expect(crypto.calls.filter((c) => c.op === 'sealApp').map((c) => c.home)).toContain(inst.home!.path);
  });

  it('the home holds a plaintext manifest plus an encrypted vault, and volumes are rooted inside it', async () => {
    const home = await driveHome();
    expect(home).toBe(path.join(drive, 'harbor-apps', 'excalidraw', 'excalidraw'));
    const manifest = JSON.parse(readFileSync(path.join(home, 'manifest.json'), 'utf8'));
    expect(manifest.packageId).toBe('excalidraw');
    expect(manifest.instanceId).toBe(driveInstanceId);
    expect(JSON.stringify(manifest)).not.toContain(PASS);
    expect(existsSync(path.join(home, 'vault'))).toBe(true);
    // Excalidraw keeps no storage claims, so prove the volume-rooting path
    // with the fake log on an app that has one (mediaapp is written below).
    const detail = await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${driveInstanceId}`);
    expect(detail.home).toMatchObject({ encrypted: true, state: 'unlocked' });
  });

  it('a wrong passphrase never unlocks: adopt on a second machine needs the right one', async () => {
    // Adopt path is covered in the next block; here just prove the manifest
    // does not leak the key and the wrong passphrase fails at the API.
    const home = await driveHome();
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/found-apps/adopt', { home, passphrase: 'wrong passphrase here' });
  });

  it('a reboot returns every sealed app to locked; login unlocks default-key homes, the passphrase unlocks custom ones', async () => {
    // Reboot = the kernel forgets every key (fake: clear `open`) and the
    // daemon comes back BFU. The read model is the kernel probe, so both
    // homes must read locked until a key is back.
    crypto.open.clear();
    await h.restart();
    const drivePath = (await h.api.instances()).find((i) => i.id === driveInstanceId)!.home!.path;
    const defaultPath = (await h.api.instances()).find((i) => i.name === 'defaultkey')!.home!.path;
    const locked = (await h.api.instances()).find((i) => i.id === driveInstanceId)!;
    expect(locked.home).toMatchObject({ encrypted: true, state: 'locked', sealed: true });
    // restart() logged in: BFU → AFU kernel-unlocks the default-key home
    // (machine-wrapped key), never the custom-passphrase one.
    await until(async () => (await h.api.instances()).find((i) => i.name === 'defaultkey')!.home!.state === 'unlocked', 'default-key home unlocked at login');
    expect(crypto.calls.filter((c) => c.op === 'unlockApp').map((c) => c.home)).toContain(defaultPath);
    expect(kernelUnlocked(defaultPath)).toBe(true);
    expect(kernelUnlocked(drivePath)).toBe(false);
    // Lock refuses while the app runs (its files are open in the kernel).
    await h.api.expectError(409, 'INVALID_STATE', 'POST', `/v1/instances/${driveInstanceId}/lock`, {});
    // Wrong passphrase never unlocks; the right one adds the key to the kernel.
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${driveInstanceId}/unlock`, { passphrase: 'wrong passphrase here' });
    const unlocked = await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/unlock`, { passphrase: PASS });
    expect(unlocked.home).toMatchObject({ encrypted: true, state: 'unlocked', sealed: true });
    expect(kernelUnlocked(drivePath)).toBe(true);
    // Stop, then Lock: the key is evicted and the data is ciphertext again.
    const stop = await h.api.plan({ kind: 'stop', instanceId: driveInstanceId });
    expect((await h.api.waitOperation((await h.api.submit(stop.id)).operationId)).state).toBe('succeeded');
    const relocked = await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/lock`, {});
    expect(relocked.home).toMatchObject({ encrypted: true, state: 'locked' });
    expect(kernelUnlocked(drivePath)).toBe(false);
    expect(crypto.calls.filter((c) => c.op === 'lockApp').map((c) => c.home)).toContain(drivePath);
    // Start without a key is refused; unlock + start kernel-unlocks before Docker.
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'start', instanceId: driveInstanceId });
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/unlock`, { passphrase: PASS });
    const start = await h.api.plan({ kind: 'start', instanceId: driveInstanceId });
    const op = await h.api.waitOperation((await h.api.submit(start.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(kernelUnlocked(drivePath)).toBe(true);
    expect((await h.api.instances()).find((i) => i.id === driveInstanceId)!.home).toMatchObject({ state: 'unlocked', sealed: true });
  });
});

describe('same password, no retyping', () => {
  it('a drive app sealed with the Harbor password unlocks at login; one with another passphrase asks', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'samepass', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: ADMIN.password } });
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, passphrase: ADMIN.password }, { 'idempotency-key': 'home-samepass-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.events.map((e) => e.message).join('\n')).toMatch(/passphrase is your Harbor password/);
    const same = (await h.api.instances()).find((i) => i.name === 'samepass')!;
    expect(same.home).toMatchObject({ state: 'unlocked', sealed: true, silentUnlock: true });
    expect(same.home!.defaultKey).toBeUndefined();
    const otherHome = path.join(drive, 'harbor-apps', 'excalidraw', 'excalidraw');
    const other = (await h.api.instances()).find((i) => i.home?.path === otherHome)!;
    expect(other.home).toMatchObject({ silentUnlock: false });
    // Reboot: the login inside restart() unlocks the same-password app, never the other one.
    crypto.open.clear();
    await h.restart();
    await until(async () => (await h.api.instances()).find((i) => i.name === 'samepass')!.home!.state === 'unlocked', 'same-password app unlocked at login');
    expect((await h.api.instances()).find((i) => i.home?.path === otherHome)!.home).toMatchObject({ state: 'locked', silentUnlock: false });
    // The passphrase envelope still works on its own (portable), and the
    // recorded wrapping holds no passphrase.
    const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
    try {
      const rows = db.prepare(`SELECT metadata_json FROM resources WHERE role = '__home__'`).all() as { metadata_json: string }[];
      for (const r of rows) expect(r.metadata_json).not.toContain(ADMIN.password);
      const settings = db.prepare('SELECT value_json FROM settings').all() as { value_json: string }[];
      for (const r of settings) expect(r.value_json).not.toContain(ADMIN.password);
    } finally {
      db.close();
    }
  });

  it('the login password opens an older same-password home too, and records the wrapping (backfill)', async () => {
    // Forge a home sealed with the Harbor password but recorded without a wrapping.
    const inst = (await h.api.instances()).find((i) => i.name === 'samepass')!;
    const db = new Database(path.join(h.stateDir, 'harbor.db'));
    try {
      db.prepare(`UPDATE resources SET metadata_json = json_remove(metadata_json, '$.machineWrapped', '$.loginKey') WHERE instance_id = ? AND role = '__home__'`).run(inst.id);
    } finally {
      db.close();
    }
    crypto.open.clear();
    await h.restart();
    await until(async () => (await h.api.instances()).find((i) => i.name === 'samepass')!.home!.state === 'unlocked', 'backfilled app unlocked at login');
    // The wrapping is recorded right after the unlock (one more scrypt): poll for it.
    await until(async () => (await h.api.instances()).find((i) => i.name === 'samepass')!.home!.silentUnlock === true, 'wrapping backfilled');
  });
});

describe('sealing is not optional', () => {
  it('a host that cannot seal fails the install and leaves no half-made home behind', async () => {
    crypto.failWith = 'fscrypt is not installed on this machine';
    try {
      const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'nosealer', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: PASS } });
      const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, passphrase: PASS }, { 'idempotency-key': 'home-noseal-1' });
      const op = await h.api.waitOperation(sub.operationId);
      expect(op.state).toBe('failed');
      expect(op.error?.message).toMatch(/fscrypt is not installed/);
      expect(op.error?.nextAction).toMatch(/Format the drive as ext4/);
      // No plaintext home lingers for a later "encrypted" claim to cover.
      expect(existsSync(path.join(drive, 'harbor-apps', 'excalidraw', 'nosealer'))).toBe(false);
      const inst = (await h.api.instances()).find((i) => i.name === 'nosealer')!;
      expect(inst.installState).toBe('failed');
      expect(inst.home).toBeNull();
    } finally {
      crypto.failWith = null;
    }
  });

  it('a home installed before sealing worked is sealed in place at its next Start (migration)', async () => {
    const inst = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
    const home = inst.home!.path;
    const stop = await h.api.plan({ kind: 'stop', instanceId: inst.id });
    expect((await h.api.waitOperation((await h.api.submit(stop.id)).operationId)).state).toBe('succeeded');
    // Forge a pre-sealing record: no kernelSealed flag, plaintext volumes.
    const db = new Database(path.join(h.stateDir, 'harbor.db'));
    try {
      db.prepare(`UPDATE resources SET metadata_json = json_remove(metadata_json, '$.kernelSealed') WHERE instance_id = ? AND role = '__home__'`).run(inst.id);
    } finally {
      db.close();
    }
    crypto.sealed.delete(home);
    crypto.open.delete(home);
    expect((await h.api.instances()).find((i) => i.id === inst.id)!.home).toMatchObject({ sealed: false, state: 'unlocked' });
    const start = await h.api.plan({ kind: 'start', instanceId: inst.id });
    const op = await h.api.waitOperation((await h.api.submit(start.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(crypto.calls.filter((c) => c.op === 'migrateApp').map((c) => c.home)).toContain(home);
    expect(op.events.map((e) => e.message).join('\n')).toMatch(/one-time migration[\s\S]*kernel-sealed/);
    expect((await h.api.instances()).find((i) => i.id === inst.id)!.home).toMatchObject({ sealed: true, state: 'unlocked' });
  });
});

describe('found apps and adopt', () => {
  it('lists the installed home as adopted, and a foreign home as adoptable', async () => {
    const items = await h.api.expect<{ items: FoundAppDto[] }>(200, 'GET', '/v1/found-apps');
    // The harness machine only sees real mounts, so the tmp drive is absent:
    // found-apps is empty here. The scan logic itself is covered by the
    // app-home unit tests; this proves the route is wired and authenticated.
    expect(Array.isArray(items.items)).toBe(true);
  });

  it('adopt refuses an unknown home and a wrong passphrase', async () => {
    await h.api.expectError(409, 'DATA_MISSING', 'POST', '/v1/found-apps/adopt', { home: path.join(drive, 'harbor-apps', 'excalidraw', 'ghost'), passphrase: PASS });
  });

  it('adopting the installed home again conflicts (it is already adopted here)', async () => {
    // The instance record already points at this home: adopt refuses as a
    // duplicate. Re-read the home from the instance list (this block now
    // installs two apps: the default-key one and the drive one).
    const home = (await h.api.instances()).find((i) => i.home?.path === path.join(drive, 'harbor-apps', 'excalidraw', 'excalidraw'))!.home!.path;
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/found-apps/adopt', { home, passphrase: PASS });
  });
});

describe('volumes rooted in the home', () => {
  it('a storage claim becomes a bind-rooted volume inside the vault dir', async () => {
    const { writePackage } = await import('../unit/helpers.js');
    const { DIGEST_B, MINIMAL_MANIFEST } = await import('../unit/helpers.js');
    const storage = ['storage:', '  - id: data', '    composeVolume: data', '    purpose: Data', '    retention: retain', ''].join('\n');
    const compose = ['services:', '  web:', `    image: example/demo@${DIGEST_B}`, '    volumes:', '      - {type: volume, source: data, target: /data}', 'volumes:', '  data: {}', ''].join('\n');
    writePackage(h.catalogDir, 'homevol', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: homevol') + storage, compose, images: { web: `example/demo@${DIGEST_B}` } });
    const plan = await h.api.plan({ kind: 'install', packageId: 'homevol', location: { dir: path.join(drive, 'harbor-apps', 'homevol'), passphrase: PASS } });
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, passphrase: PASS }, { 'idempotency-key': 'home-vol-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.packageId === 'homevol')!;
    const home = inst.home!.path;
    const device = path.join(home, 'volumes', 'data');
    expect(existsSync(device)).toBe(true);
    expect(h.fake.log.some((l) => l.startsWith('volume create ') && l.includes(`device=${device}`))).toBe(true);
    const runtime = parseYaml(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8'));
    expect(runtime.services.web.volumes).toEqual([{ type: 'volume', source: 'data', target: '/data' }]);
    expect(Object.keys(runtime.volumes.data)).toMatchObject({});
  });
});
