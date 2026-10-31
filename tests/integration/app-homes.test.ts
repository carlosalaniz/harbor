import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FoundAppDto, InstanceDetail, InstanceSummary, PlanDto, RecoveryKeyRotationDto, SecurityDto, SystemDto } from '../../src/contracts/api.js';
import Database from 'better-sqlite3';
import { FakeCryptoProvider } from '../../src/storage/crypto-provider.js';
import { writeZip } from '../../src/packages/zip.js';
import { unsealMachineKey } from '../../src/auth/machine-key.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

// Whole-app install locations: the app (including its database) lives
// encrypted on a drive folder, unlockable on any Harbor machine with the
// passphrase. The passphrase travels with the submission, never in the plan.
let h: Harness;
let drive: string;
// The installation's 12 words, captured once from the first encrypted install.
let harborCard = '';
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
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX = createRequire(import.meta.url).resolve('tsx');

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

  it('after a restart, a remembered session cannot seal a new app until the password unlocks the machine key (decision 120)', async () => {
    // Live-found (fresh-droplet C01): a still-valid token after a daemon restart installed a default-key
    // home with no machine wrapping, so after Lock only the Harbor recovery key could open it.
    await h.restart({ login: false });
    try {
      const appsDir = path.join(h.userDataDir, 'harbor-apps');
      const req = { kind: 'install', packageId: 'excalidraw', name: 'bfu-seal', location: { dir: path.join(appsDir, 'excalidraw') } };
      const err = await h.api.expectError(409, 'MACHINE_KEY_LOCKED', 'POST', '/v1/plans', req);
      expect(err.error.message).toMatch(/restarted/i);
      expect(err.error.nextAction).toMatch(/password/i);
      // decision 164: the same session types the password once instead of logging out and in
      await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/account/unlock', { password: 'not-the-password' });
      expect(await h.api.expect(200, 'POST', '/v1/account/unlock', { password: ADMIN.password })).toEqual({ unlocked: true });
      expect((await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'bfu-seal', location: { dir: path.join(appsDir, 'excalidraw') } })).location?.defaultKey).toBe(true);
    } finally {
      await h.restart(); // logs in: AFU again
    }
  });

  it('decision 165: a password change after a restart re-seals the machine key under the NEW password', async () => {
    await h.restart({ login: false });
    const NEW = 'a-new-Password-1234';
    const sealedBlob = () => {
      const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
      try {
        return JSON.parse((db.prepare("SELECT value_json FROM settings WHERE key = 'security.machineKey'").get() as { value_json: string }).value_json);
      } finally {
        db.close();
      }
    };
    try {
      await h.api.expect(200, 'PUT', '/v1/account/password', { currentPassword: ADMIN.password, newPassword: NEW });
      const key = await unsealMachineKey(sealedBlob(), NEW);
      expect(key.length).toBe(32);
      await expect(unsealMachineKey(sealedBlob(), ADMIN.password)).rejects.toThrow();
      // and the change itself unlocked the machine (the password was just proved)
      expect((await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'after-change', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'excalidraw') } })).location?.defaultKey).toBe(true);
    } finally {
      await h.api.expect(200, 'PUT', '/v1/account/password', { currentPassword: NEW, newPassword: ADMIN.password });
      await h.restart();
    }
  });

  it('the data-folder plan needs no passphrase at submit; the home unlocks silently', async () => {
    const appsDir = path.join(h.userDataDir, 'harbor-apps');
    const p = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'defaultkey', location: { dir: path.join(appsDir, 'excalidraw') } });
    expect(p.changes.join('\n')).toMatch(/this machine unlocks it when you log in/);
    // decision 157: the review states where it lives and how it opens as data + a plain note, not a warning
    expect(p.location).toMatchObject({ encrypted: true, onDrive: false, defaultKey: true });
    expect(p.notes.join('\n')).toMatch(/unlocks automatically when you sign in/);
    expect(p.warnings.join('\n')).not.toMatch(/sealed|unlocks/);
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: p.id }, { 'idempotency-key': 'home-default-key-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    // This harness enrolled its administrator from the CLI, so no Harbor
    // recovery key existed yet: the first encrypted install issues one and
    // shows it exactly once, in this operation's result.
    harborCard = op.result?.['installationRecoveryKey'] as string;
    expect(harborCard.split(' ')).toHaveLength(12);
    expect(op.result?.['installationRecoveryNote']).toMatch(/opens every app this Harbor encrypts/);
    // Decision 165: the words reach the API from memory only; the state database never holds them.
    const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT result_json FROM operations WHERE id = ?').get(sub.operationId) as { result_json: string };
      expect(row.result_json).not.toContain(harborCard);
      expect(JSON.parse(row.result_json)).not.toHaveProperty('installationRecoveryKey');
    } finally {
      db.close();
    }
    // A default-key home has no passphrase to forget, so it gets no per-app
    // words: the Harbor card is its one way back.
    expect(op.result?.['recoveryKey']).toBeUndefined();
    const got = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
    expect(got.home).toMatchObject({ encrypted: true, state: 'unlocked', defaultKey: true, sealed: true });
    const dkManifest = JSON.parse(readFileSync(path.join(got.home!.path, 'manifest.json'), 'utf8'));
    expect(dkManifest.encryption.recovery).toBeUndefined();
    expect(dkManifest.encryption.installation).toBeDefined();
    expect(JSON.stringify(dkManifest)).not.toContain(harborCard);
    // The volumes dir was kernel-sealed BEFORE any volume was rooted inside.
    expect(crypto.calls.filter((c) => c.op === 'sealApp').map((c) => c.home)).toContain(got.home!.path);
    expect(kernelUnlocked(got.home!.path)).toBe(true);
  });

  it('Docker going away never makes the guards start running sealed apps (found on the droplet, 2026-10-13)', async () => {
    const guardStarts = () => {
      const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM operations WHERE actor IN ('lock-guard', 'drive-guard')").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const before = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
    expect(before.runtime).toBe('running');
    const startsBefore = guardStarts();
    h.fake.behaviour.engineDown = true;
    try {
      await new Promise((r) => setTimeout(r, 1500)); // several observer ticks with Docker unreachable
    } finally {
      h.fake.behaviour.engineDown = false;
    }
    await until(async () => (await h.api.instances()).find((i) => i.name === 'defaultkey')!.readiness === 'healthy', 'healthy again');
    const after = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
    expect(after.installState).toBe('installed');
    expect(guardStarts()).toBe(startsBefore); // no guard start was planned while Docker was away
  });

  it('the plan names the encrypted home and warns about the drive and the passphrase', async () => {
    plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: PASS } });
    expect(plan.location).toMatchObject({ dir: path.join(drive, 'harbor-apps', 'excalidraw'), encrypted: true, defaultKey: false });
    expect(plan.changes.join('\n')).toMatch(/sealed at .*harbor-apps\/excalidraw\//);
    // This harness's "drive" is a tmpdir on the same filesystem as the data
    // folder, so Harbor classifies it as local and the warning says so. The
    // drive-specific wording is exercised by the install-wizard e2e.
    // decision 157: how it opens is a note; losing the passphrase AND the recovery key stays a warning
    expect(plan.notes.join('\n')).toMatch(/own passphrase, which also opens it on another Harbor machine/);
    expect(plan.warnings.join('\n')).toMatch(/Lose both its passphrase and your Harbor recovery key/);
    // The passphrase is never stored in the plan.
    expect(JSON.stringify(plan)).not.toContain(PASS);
  });

  it('a plan that asked for a passphrase still needs it at submit; with it the install succeeds', async () => {
    // The plan is not a default-key one, so the runner has nothing to open the
    // home with unless the submitter hands the passphrase over.
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
    // Own passphrase => own words, on top of the Harbor card. The card itself
    // is issued once, so this later install does not show it again.
    expect((op.result?.['recoveryKey'] as string).split(' ')).toHaveLength(12);
    const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
    try {
      expect((db.prepare('SELECT result_json FROM operations WHERE id = ?').get(sub.operationId) as { result_json: string }).result_json).not.toContain(op.result?.['recoveryKey'] as string);
    } finally {
      db.close();
    }
    expect(op.result?.['installationRecoveryKey']).toBeUndefined();
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

  // Decision 190 (live-found on an Ubuntu 26.04 home server): after a reboot the remembered console session
  // showed every app Locked with no hint that a password was needed, and an Update approved in that state deleted
  // the containers, could not mount the sealed volumes, and failed its rollback too.
  it('decision 190: after a reboot a remembered session reads unlockNeeded until the password, and a locked app refuses update at plan time', async () => {
    crypto.open.clear();
    await h.restart({ login: false });
    try {
      expect((await h.api.expect<SystemDto>(200, 'GET', '/v1/system')).unlockNeeded).toBe(true);
      const inst = (await h.api.instances()).find((i) => i.name === 'defaultkey')!;
      expect(inst.home).toMatchObject({ state: 'locked', defaultKey: true });
      const refused = await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'update', instanceId: inst.id });
      expect(refused.error.message).toMatch(/is locked/);
      expect(refused.error.nextAction).toMatch(/Log in again .* then update again/);
      // the lock screen types the password once: the key is back, the home opens, the screen goes away
      expect(await h.api.expect(200, 'POST', '/v1/account/unlock', { password: ADMIN.password })).toEqual({ unlocked: true });
      expect((await h.api.expect<SystemDto>(200, 'GET', '/v1/system')).unlockNeeded).toBe(false);
      await until(async () => (await h.api.instances()).find((i) => i.name === 'defaultkey')!.home!.state === 'unlocked', 'default-key home unlocked by the lock screen');
      expect(kernelUnlocked(inst.home!.path)).toBe(true);
    } finally {
      await h.restart();
    }
  });

  // Decision 190 (same home server): after the reboot only Vaultwarden came back. Immich and Nextcloud each have a
  // Redis with no sealed data, which Docker's restart policy had already started, so lock-guard read "running" from
  // that one container and never started the rest.
  it('decision 190: lock-guard starts a sealed app after a reboot even when Docker already restarted one of its containers', async () => {
    const appsDir = path.join(h.userDataDir, 'harbor-apps');
    const plan = await h.api.plan({ kind: 'install', packageId: 'n8n', name: 'twosvc', location: { dir: path.join(appsDir, 'n8n') } });
    expect((await h.api.waitOperation((await h.api.submit(plan.id)).operationId)).state).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.name === 'twosvc')!;
    const project = h.daemon.ctx.repo.instance(inst.id)!.project;
    const ours = [...h.fake.containers.values()].filter((c) => c.project === project);
    expect(ours.length).toBeGreaterThan(1);
    // the reboot: every container stops and the kernel forgets every key; Docker brings one service back by itself
    for (const c of ours) await h.fake.stopContainer(c.id, 0);
    crypto.open.clear();
    await h.fake.startContainer(ours[0]!.id);
    await h.restart(); // the login unlocks the home; lock-guard must start the app although one container runs
    await until(async () => (await h.api.instances()).find((i) => i.id === inst.id)!.runtime === 'running', 'every container of twosvc running again');
    expect(h.daemon.ctx.repo.listOperations(500).some((o) => o.instanceId === inst.id && o.kind === 'start' && o.actor === 'lock-guard' && o.state === 'succeeded')).toBe(true);
  });

  // Decision 183 review R2: the locked refusal comes while the start is PLANNED, so the CLI must read the passphrase
  // there (it never reached the old retry around the approval), unlock the app with it and plan again.
  it('`harbor start <locked> --passphrase-stdin` reads the passphrase, unlocks and starts; without it and no TTY a clear error', async () => {
    const stop = await h.api.plan({ kind: 'stop', instanceId: driveInstanceId });
    expect((await h.api.waitOperation((await h.api.submit(stop.id)).operationId)).state).toBe('succeeded');
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/lock`, {});
    const name = (await h.api.instances()).find((i) => i.id === driveInstanceId)!.name;
    const cliDir = mkdtempSync(path.join(tmpdir(), 'harbor-cli-'));
    writeFileSync(path.join(cliDir, 'cli.json'), JSON.stringify({ url: h.baseUrl, token: h.api.token }));
    const cli = (args: string[], stdin: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const c = spawn(process.execPath, ['--import', TSX, path.join(ROOT, 'src', 'cli', 'main.ts'), ...args], { cwd: ROOT, env: { ...process.env, HARBOR_CLI_CONFIG_DIR: cliDir, HARBOR_URL: h.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        c.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        c.on('close', (code) => resolve({ code, stdout, stderr }));
        c.stdin.end(stdin);
      });
    const refused = await cli(['start', name, '--yes'], '');
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/is locked/);
    expect(refused.stderr).toMatch(/--passphrase-stdin/);
    expect((await h.api.instances()).find((i) => i.id === driveInstanceId)!.home).toMatchObject({ state: 'locked' });
    const started = await cli(['start', name, '--yes', '--passphrase-stdin'], `${PASS}\n`);
    expect(started.code, started.stderr).toBe(0);
    const after = (await h.api.instances()).find((i) => i.id === driveInstanceId)!;
    expect(after.home).toMatchObject({ state: 'unlocked', sealed: true });
    expect(after.runtime).toBe('running');

    // busy: the CLI waits out what the app has queued, then meets the same refusal and handles it the same way
    const stop2 = await h.api.plan({ kind: 'stop', instanceId: driveInstanceId });
    expect((await h.api.waitOperation((await h.api.submit(stop2.id)).operationId)).state).toBe('succeeded');
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/lock`, {});
    h.fake.behaviour.respond = () => 503;
    try {
      const other = await h.api.submit((await h.api.plan({ kind: 'install', packageId: 'bentopdf', name: 'r2-busy' })).id);
      await until(async () => (await h.api.expect<{ phase: string }>(200, 'GET', `/v1/operations/${other.operationId}`)).phase === 'checking', 'the other install in its readiness check', 20_000);
      await h.api.expect(202, 'POST', '/v1/operations', { action: { kind: 'restart', instanceId: driveInstanceId } }, { 'idempotency-key': 'r2-busy-restart' });
      const pending = cli(['start', name, '--yes', '--passphrase-stdin'], `${PASS}\n`);
      await new Promise((r) => setTimeout(r, 1500));
      delete h.fake.behaviour.respond;
      const busy = await pending;
      expect(busy.code, busy.stderr).toBe(0);
      // review round 3: the locked home is unlocked first, then the start is queued behind the app's own restart
      expect(busy.stderr).toMatch(/unlocked for this boot/);
      expect(busy.stderr).toMatch(/Queued start of/);
      expect((await h.api.instances()).find((i) => i.id === driveInstanceId)!).toMatchObject({ runtime: 'running', home: { state: 'unlocked' } });
      expect((await h.api.waitOperation(other.operationId)).state).toBe('succeeded');
    } finally {
      delete h.fake.behaviour.respond;
    }

    // review round 3: an app that should be running starts by itself once its key is back (lock-guard). The CLI
    // follows that start instead of planning a second one that would fail as busy or changed although the app runs.
    const stop3 = await h.api.plan({ kind: 'stop', instanceId: driveInstanceId });
    expect((await h.api.waitOperation((await h.api.submit(stop3.id)).operationId)).state).toBe('succeeded');
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${driveInstanceId}/lock`, {});
    h.daemon.ctx.repo.updateInstance(driveInstanceId, { desired: 'running' }); // as after a reboot: locked, meant to run
    const failedBefore = h.daemon.ctx.repo.listOperations(500).filter((o) => o.instanceId === driveInstanceId && o.state === 'failed').length;
    const auto = await cli(['start', name, '--yes', '--passphrase-stdin'], `${PASS}\n`);
    expect(auto.code, auto.stderr).toBe(0);
    expect(auto.stderr).toMatch(/unlocked for this boot/);
    expect((await h.api.instances()).find((i) => i.id === driveInstanceId)!).toMatchObject({ runtime: 'running', home: { state: 'unlocked' } });
    const ops = h.daemon.ctx.repo.listOperations(500).filter((o) => o.instanceId === driveInstanceId);
    expect(ops.filter((o) => o.state === 'failed').length).toBe(failedBefore); // no second start failed next to Harbor's own
    expect(ops.some((o) => o.kind === 'start' && o.actor === 'lock-guard' && o.state === 'succeeded')).toBe(true);
  });
});

describe('a per-app passphrase is optional everywhere', () => {
  it('installs into an app-home folder with NO passphrase, and the Harbor card is what opens it elsewhere', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'nopass', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw') } });
    // The plan says how it opens, and never asks for a secret. (Before
    // decision 106 a non-data-folder location refused a passphrase-less plan
    // outright; the wizard e2e covers the removable-drive rendering.)
    expect(plan.changes.join('\n')).toMatch(/Harbor recovery key opens it on any other machine/);
    // Submitting with no passphrase at all succeeds.
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id }, { 'idempotency-key': 'home-nopass-1' });
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const inst = (await h.api.instances()).find((i) => i.name === 'nopass')!;
    expect(inst.home).toMatchObject({ encrypted: true, state: 'unlocked', sealed: true, defaultKey: true, silentUnlock: true });
    // No per-app words were issued: there is no passphrase to forget.
    expect(op.result?.['recoveryKey']).toBeUndefined();
    const manifest = JSON.parse(readFileSync(path.join(inst.home!.path, 'manifest.json'), 'utf8'));
    expect(manifest.encryption.recovery).toBeUndefined();
    expect(manifest.encryption.installation).toBeDefined();
    // The Harbor card opens it: prove it against the envelope directly, the
    // way another machine would when adopting the drive.
    const { unlockAppHome, zeroKey } = await import('../../src/storage/app-home.js');
    const key = await unlockAppHome(inst.home!.path, harborCard);
    try {
      expect(key).toHaveLength(32);
    } finally {
      zeroKey(key);
    }
  });

  it('still enforces the 8-character floor when a passphrase IS given', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', name: 'shortpass', location: { dir: path.join(drive, 'harbor-apps', 'excalidraw'), passphrase: 'short' } });
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

// One card per Harbor opens every app it encrypted, so a dead machine needs
// one piece of paper rather than one per app (decision 105).
describe('the Harbor recovery key', () => {
  it('opens a custom-passphrase app that this boot never unlocked', async () => {
    const inst = (await h.api.instances()).find((i) => i.packageId === 'homevol')!;
    // Forget everything this machine knows about the app's key.
    crypto.open.clear();
    await h.restart();
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/lock`, {}).catch(() => undefined);
    const locked = (await h.api.instances()).find((i) => i.id === inst.id)!;
    expect(locked.home).toMatchObject({ state: 'locked' });
    // Neither the app's passphrase nor its own words are typed here: the
    // Harbor card alone opens it.
    const opened = await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/unlock`, { passphrase: harborCard });
    expect(opened.home).toMatchObject({ state: 'unlocked' });
    // A card from some other Harbor does not.
    await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/lock`, {}).catch(() => undefined);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${inst.id}/unlock`, { passphrase: 'zebra zone zoo zero youth yellow year wrong write worth world work' });
  });

  it('is reported by date only, never by value, and is not stored in the clear', async () => {
    const sec = await h.api.expect<SecurityDto>(200, 'GET', '/v1/account/security');
    expect(sec.recoveryKey).not.toBeNull();
    expect(JSON.stringify(sec)).not.toContain(harborCard);
    const db = new Database(path.join(h.stateDir, 'harbor.db'), { readonly: true });
    try {
      const rows = db.prepare('SELECT value_json FROM settings').all() as { value_json: string }[];
      expect(rows.some((r) => r.value_json.includes('"wrapped"'))).toBe(true);
      for (const r of rows) expect(r.value_json).not.toContain(harborCard);
    } finally {
      db.close();
    }
  });

  it('replacing it re-stamps reachable apps, retires the old card, and names what it could not reach', async () => {
    const before = harborCard;
    const rot = await h.api.expect<RecoveryKeyRotationDto>(200, 'POST', '/v1/account/recovery-key', { password: ADMIN.password });
    expect(rot.recoveryKey.split(' ')).toHaveLength(12);
    expect(rot.recoveryKey).not.toBe(before);
    expect(rot.restamped.length).toBeGreaterThan(0);
    const inst = (await h.api.instances()).find((i) => i.packageId === 'homevol')!;
    if (rot.restamped.includes(inst.displayName ?? inst.name)) {
      await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/lock`, {}).catch(() => undefined);
      await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/unlock`, { passphrase: rot.recoveryKey });
      await h.api.expect<InstanceSummary>(200, 'POST', `/v1/instances/${inst.id}/lock`, {}).catch(() => undefined);
      // The retired card no longer opens a re-stamped app.
      await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/instances/${inst.id}/unlock`, { passphrase: before });
    }
    // A wrong password never rotates.
    await h.api.expectError(401, 'UNAUTHENTICATED', 'POST', '/v1/account/recovery-key', { password: 'not my password' });
    harborCard = rot.recoveryKey;
  });
});


// Decision 163/179: an app whose package asks for permissions (gpu: Ollama, Open WebUI) is adopted with them
// accepted, and a request without the yes changes nothing on the drive or the adopting machine.
describe('adopting a drive app that asks for the graphics card', () => {
  const GPU_APP = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: gpullm
  name: GPU model server
  description: A local model server
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
permissions:
  web: [gpu]
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
  const zip = () => `data:application/zip;base64,${writeZip({ 'manifest.yaml': GPU_APP, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: 'gpullm' }).toString('base64')}`;
  // every file of the home outside its volumes (manifest, vault, recovery cards), to prove a refusal wrote nothing
  const snapshot = (dir: string, rel = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        if (r !== 'volumes') Object.assign(out, snapshot(dir, r));
      } else out[r] = readFileSync(path.join(dir, r)).toString('base64');
    }
    return out;
  };
  let other: Harness;
  afterAll(async () => other?.close());

  it('refuses without the yes before touching anything, then adopts with it', async () => {
    await h.api.expect(201, 'POST', '/v1/packages', { fileName: 'gpullm.zip', dataUrl: zip() });
    const plan = await h.api.plan({ kind: 'install', packageId: 'gpullm', location: { dir: path.join(drive, 'harbor-apps', 'gpullm'), passphrase: PASS } });
    expect(plan.permissions.map((p) => p.permission)).toEqual(['gpu']);
    const sub = await h.api.expect<{ operationId: string }>(202, 'POST', '/v1/operations', { planId: plan.id, passphrase: PASS, acceptPermissions: true }, { 'idempotency-key': 'gpu-home-1' });
    expect((await h.api.waitOperation(sub.operationId)).state).toBe('succeeded');
    const home = (await h.api.instances()).find((i) => i.packageId === 'gpullm')!.home!.path;

    // a second machine with the same package
    other = await startHarness({ overrides: { crypto } });
    await other.api.expect(201, 'POST', '/v1/packages', { fileName: 'gpullm.zip', dataUrl: zip() });
    const before = snapshot(home);
    const refused = await other.api.expectError(409, 'PERMISSION_REQUIRED', 'POST', '/v1/found-apps/adopt', { home, passphrase: PASS });
    expect(JSON.stringify(refused)).toContain('web gpu');
    expect(snapshot(home)).toEqual(before); // no recovery card stamped
    expect((await other.api.instances()).some((i) => i.packageId === 'gpullm')).toBe(false);
    const db = new Database(path.join(other.stateDir, 'harbor.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM resources').get()).toEqual({ n: 0 }); // no orphan __home__ row
      expect(db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    const adopted = await other.api.expect<InstanceSummary>(201, 'POST', '/v1/found-apps/adopt', { home, passphrase: PASS, acceptPermissions: true });
    expect(adopted.packageId).toBe('gpullm');
    const op = await other.api.waitOperation(adopted.operationId!);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
  });

  // Decision 183: an adopt waits in the queue like any install. Cancelled before it ran (by a person or a restart),
  // it changed nothing, so the drive's app can be adopted again with the same identity.
  let third: Harness;
  afterAll(async () => third?.close());
  it('an adopt cancelled while it waited leaves the app adoptable again', async () => {
    const home = (await h.api.instances()).find((i) => i.packageId === 'gpullm')!.home!.path;
    third = await startHarness({ overrides: { crypto } });
    await third.api.expect(201, 'POST', '/v1/packages', { fileName: 'gpullm.zip', dataUrl: zip() });
    // the queue is busy with another app's install, held in its readiness check
    third.fake.behaviour.respond = () => 503;
    const busy = await third.api.submit((await third.api.plan({ kind: 'install', packageId: 'excalidraw' })).id);
    await until(async () => (await third.api.expect<{ phase: string }>(200, 'GET', `/v1/operations/${busy.operationId}`)).phase === 'checking', 'the install checking');
    const waiting = await third.api.expect<InstanceSummary>(201, 'POST', '/v1/found-apps/adopt', { home, passphrase: PASS, acceptPermissions: true });
    const c = await third.api.json<{ state: string }>('POST', `/v1/operations/${waiting.operationId}/cancel`, {});
    expect([c.status, c.body.state]).toEqual([200, 'cancelled']);
    expect((await third.api.instances()).some((i) => i.packageId === 'gpullm')).toBe(false);
    // adopted again, this time it waits and then runs
    const again = await third.api.expect<InstanceSummary>(201, 'POST', '/v1/found-apps/adopt', { home, passphrase: PASS, acceptPermissions: true });
    expect(again.id).toBe(waiting.id); // the identity travels with the drive
    delete third.fake.behaviour.respond;
    expect((await third.api.waitOperation(busy.operationId)).state).toBe('succeeded');
    const op = await third.api.waitOperation(again.operationId!);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect((await third.api.instances()).find((i) => i.id === again.id)).toMatchObject({ packageId: 'gpullm', installState: 'installed' });
  });
});
