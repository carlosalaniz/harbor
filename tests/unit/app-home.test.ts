import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarborError } from '../../src/errors.js';
import {
  APP_HOME_FORMAT,
  changeAppHomePassphrase,
  createAppHome,
  describeAppHome,
  openPayload,
  rotateAppHomeRecoveryKey,
  scanAppHomes,
  sealPayload,
  unlockAppHome,
  unwrapMasterKeyForMachine,
  verifyPassphrase,
  wrapMasterKeyForMachine,
  zeroKey,
} from '../../src/storage/app-home.js';
import { tempDir } from './helpers.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';

async function makeHome(passphrase = 'correct horse passphrase') {
  const parent = tempDir('harbor-apphome-');
  const { descriptor, masterKey, recoveryKey } = await createAppHome({
    parentDir: parent,
    name: 'immich',
    instanceId: INSTANCE,
    packageId: 'immich',
    packageRevision: '3',
    displayName: 'Immich',
    passphrase,
    harborVersion: '0.13.0',
  });
  return { parent, descriptor, masterKey, recoveryKey };
}

describe('app homes', () => {
  it('creates a home with a plaintext manifest and an encrypted vault dir', async () => {
    const { descriptor, masterKey, recoveryKey } = await makeHome();
    try {
      expect(descriptor.manifest.format).toBe(APP_HOME_FORMAT);
      expect(descriptor.manifest.instanceId).toBe(INSTANCE);
      expect(descriptor.manifest.packageId).toBe('immich');
      expect(descriptor.manifest.vault).toBe('vault');
      expect(descriptor.manifest.encryption.algorithm).toBe('aes-256-gcm');
      expect(descriptor.manifest.encryption.recovery).toBeDefined();
      expect(recoveryKey.split(' ')).toHaveLength(12);
      // The manifest is plaintext: name, package and revision read while locked.
      const raw = JSON.parse(readFileSync(path.join(descriptor.home, 'manifest.json'), 'utf8'));
      expect(raw.displayName).toBe('Immich');
      expect(raw.packageRevision).toBe('3');
      expect(JSON.stringify(raw)).not.toContain(masterKey.toString('hex'));
      // …but the recovery key itself is never in the manifest (only its envelope).
      expect(JSON.stringify(raw)).not.toContain(recoveryKey);
    } finally {
      zeroKey(masterKey);
    }
  });

  it('describe works while locked; unlock needs the right passphrase', async () => {
    const { descriptor, masterKey } = await makeHome();
    zeroKey(masterKey);
    const described = describeAppHome(descriptor.home);
    expect(described.manifest.displayName).toBe('Immich');
    const key = await unlockAppHome(descriptor.home, 'correct horse passphrase');
    try {
      expect(key.length).toBe(32);
    } finally {
      zeroKey(key);
    }
    await expect(unlockAppHome(descriptor.home, 'wrong passphrase here')).rejects.toThrowError(/wrong passphrase/);
    expect(await verifyPassphrase(descriptor.home, 'correct horse passphrase')).toBe(true);
    expect(await verifyPassphrase(descriptor.home, 'wrong passphrase here')).toBe(false);
  });

  it('changing the passphrase re-wraps the same master key (recovery key keeps working)', async () => {
    const { descriptor, masterKey, recoveryKey } = await makeHome();
    const before = Buffer.from(masterKey);
    zeroKey(masterKey);
    expect(recoveryKey.split(' ')).toHaveLength(12);
    // The recovery key unwraps from day one…
    const viaRecovery = await unlockAppHome(descriptor.home, recoveryKey);
    try {
      expect(viaRecovery.equals(before)).toBe(true);
    } finally {
      zeroKey(viaRecovery);
    }
    await changeAppHomePassphrase(descriptor.home, 'correct horse passphrase', 'a brand new passphrase');
    expect(await verifyPassphrase(descriptor.home, 'correct horse passphrase')).toBe(false);
    expect(await verifyPassphrase(descriptor.home, 'a brand new passphrase')).toBe(true);
    // …and still unwraps after the passphrase changes (immutable envelope).
    expect(await verifyPassphrase(descriptor.home, recoveryKey)).toBe(true);
    const after = await unlockAppHome(descriptor.home, 'a brand new passphrase');
    try {
      expect(after.equals(before)).toBe(true);
    } finally {
      zeroKey(after);
    }
    const afterRecovery = await unlockAppHome(descriptor.home, recoveryKey);
    try {
      expect(afterRecovery.equals(before)).toBe(true);
    } finally {
      zeroKey(afterRecovery);
    }
  });

  it('rotation needs the old key and retires it; the passphrase survives', async () => {
    const { descriptor, masterKey, recoveryKey } = await makeHome();
    zeroKey(masterKey);
    // Two homes never share a key.
    const other = await makeHome();
    zeroKey(other.masterKey);
    expect(other.recoveryKey).not.toBe(recoveryKey);
    const next = await rotateAppHomeRecoveryKey(descriptor.home, recoveryKey);
    expect(next.split(' ')).toHaveLength(12);
    expect(next).not.toBe(recoveryKey);
    expect(await verifyPassphrase(descriptor.home, next)).toBe(true);
    expect(await verifyPassphrase(descriptor.home, recoveryKey)).toBe(false);
    // The passphrase still unwraps after rotation.
    expect(await verifyPassphrase(descriptor.home, 'correct horse passphrase')).toBe(true);
  });

  it('format 1 homes read fine and gain recovery on first password change', async () => {
    const { descriptor, masterKey } = await makeHome();
    zeroKey(masterKey);
    // Downgrade the manifest to format 1 (no recovery envelope): old homes
    // written by Harbor ≤0.16 keep working.
    const manifestPath = path.join(descriptor.home, 'manifest.json');
    const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
    doc.format = 1;
    delete doc.encryption.recovery;
    writeFileSync(manifestPath, JSON.stringify(doc));
    const described = describeAppHome(descriptor.home);
    expect(described.manifest.format).toBe(1);
    expect(await verifyPassphrase(descriptor.home, 'correct horse passphrase')).toBe(true);
    const { recoveryKey } = await changeAppHomePassphrase(descriptor.home, 'correct horse passphrase', 'a brand new passphrase');
    expect(recoveryKey?.split(' ')).toHaveLength(12);
    expect(await verifyPassphrase(descriptor.home, recoveryKey!)).toBe(true);
    expect(describeAppHome(descriptor.home).manifest.format).toBe(APP_HOME_FORMAT);
  });

  it('seals and opens payload bytes; tampering fails authentication', async () => {
    const { masterKey } = await makeHome();
    try {
      const sealed = sealPayload(masterKey, Buffer.from('hello vault'));
      const opened = openPayload(masterKey, sealed);
      expect(opened.toString('utf8')).toBe('hello vault');
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 1]! ^= 0xff;
      expect(() => openPayload(masterKey, tampered)).toThrowError(/failed authentication/);
      const other = Buffer.alloc(32, 7);
      expect(() => openPayload(other, sealed)).toThrowError(/failed authentication/);
    } finally {
      zeroKey(masterKey);
    }
  });

  it('machine wrapping round-trips; a foreign machine key fails', async () => {
    const { masterKey } = await makeHome();
    const machineKey = Buffer.alloc(32, 1);
    const foreignKey = Buffer.alloc(32, 2);
    try {
      const wrapped = wrapMasterKeyForMachine(masterKey, machineKey);
      const unwrapped = unwrapMasterKeyForMachine(wrapped, machineKey);
      try {
        expect(unwrapped.equals(masterKey)).toBe(true);
      } finally {
        zeroKey(unwrapped);
      }
      expect(() => unwrapMasterKeyForMachine(wrapped, foreignKey)).toThrowError(/failed authentication/);
    } finally {
      zeroKey(masterKey);
    }
  });

  it('refuses weak passphrases, duplicate names and non-homes', async () => {
    const parent = tempDir('harbor-apphome-');
    await expect(
      createAppHome({ parentDir: parent, name: 'x', instanceId: INSTANCE, packageId: 'immich', packageRevision: '1', displayName: 'X', passphrase: 'short', harborVersion: '0.13.0' }),
    ).rejects.toThrowError(/at least 8 characters/);
    await makeHomeIn(parent);
    await expect(
      createAppHome({ parentDir: parent, name: 'immich', instanceId: INSTANCE, packageId: 'immich', packageRevision: '1', displayName: 'X', passphrase: 'another good passphrase', harborVersion: '0.13.0' }),
    ).rejects.toThrowError(/already exists/);
    expect(() => describeAppHome(path.join(parent, 'missing'))).toThrowError(/does not exist/);
    mkdirSync(path.join(parent, 'plain'));
    expect(() => describeAppHome(path.join(parent, 'plain'))).toThrowError(/no Harbor manifest/);
  });

  it('a missing vault or a newer format refuses with a next action', async () => {
    const { descriptor, masterKey } = await makeHome();
    zeroKey(masterKey);
    rmSync(path.join(descriptor.home, 'vault'), { recursive: true });
    expect(() => describeAppHome(descriptor.home)).toThrowError(/missing its encrypted folder/);
    const { parent, descriptor: d2, masterKey: k2 } = await makeHome2();
    zeroKey(k2);
    const manifestPath = path.join(d2.home, 'manifest.json');
    const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
    doc.format = APP_HOME_FORMAT + 1;
    writeFileSync(manifestPath, JSON.stringify(doc));
    expect(() => describeAppHome(d2.home)).toThrowError(/not supported/);
    expect(parent).toBeTypeOf('string');
  });

  it('scan finds homes, skips plain folders, reports corrupt manifests', async () => {
    const parent = tempDir('harbor-apphome-');
    await makeHomeIn(parent);
    mkdirSync(path.join(parent, 'not-an-app'));
    mkdirSync(path.join(parent, 'broken'));
    writeFileSync(path.join(parent, 'broken', 'manifest.json'), 'not json');
    const found = scanAppHomes(parent);
    expect(found.map((e) => e.name)).toEqual(['broken', 'immich', 'not-an-app'].filter((n) => n !== 'not-an-app'));
    const good = found.find((e) => e.name === 'immich')!;
    expect(good.descriptor?.manifest.packageId).toBe('immich');
    expect(good.error).toBeUndefined();
    const bad = found.find((e) => e.name === 'broken')!;
    expect(bad.descriptor).toBeUndefined();
    expect(bad.error).toMatch(/not valid JSON/);
  });
});

async function makeHomeIn(parent: string) {
  const { masterKey } = await createAppHome({
    parentDir: parent,
    name: 'immich',
    instanceId: INSTANCE,
    packageId: 'immich',
    packageRevision: '3',
    displayName: 'Immich',
    passphrase: 'correct horse passphrase',
    harborVersion: '0.13.0',
  });
  zeroKey(masterKey);
}

async function makeHome2() {
  const parent = tempDir('harbor-apphome-');
  const { descriptor, masterKey } = await createAppHome({
    parentDir: parent,
    name: 'memos',
    instanceId: '22222222-2222-4222-8222-222222222222',
    packageId: 'memos',
    packageRevision: '1',
    displayName: 'Memos',
    passphrase: 'correct horse passphrase',
    harborVersion: '0.13.0',
  });
  return { parent, descriptor, masterKey };
}

describe('app home error mapping', () => {
  it('wrong-passphrase errors carry INVALID_REQUEST', async () => {
    const { descriptor, masterKey } = await makeHome();
    zeroKey(masterKey);
    try {
      await unlockAppHome(descriptor.home, 'wrong passphrase here');
      expect.unreachable();
    } catch (e) {
      expect(HarborError.is(e, 'INVALID_REQUEST')).toBe(true);
    }
  });
});

describe('cross-machine portability (non-negotiable)', () => {
  it('a foreign machine unlocks with just the passphrase: machine key never leaves home', async () => {
    // Machine A installs the app: master key + machine-A wrapping in state.
    const { descriptor, masterKey } = await makeHome();
    const machineKeyA = Buffer.alloc(32, 0xa1);
    const wrappedForA = wrapMasterKeyForMachine(masterKey, machineKeyA);
    const sealed = sealPayload(masterKey, Buffer.from('precious app data'));
    zeroKey(masterKey);

    // The drive moves to machine B: different machine key, no shared state.
    // Only the folder travels (manifest.json + vault/).
    const machineKeyB = Buffer.alloc(32, 0xb2);
    // Machine B's key cannot open machine A's wrapping…
    expect(() => unwrapMasterKeyForMachine(wrappedForA, machineKeyB)).toThrowError(/failed authentication/);
    // …but the passphrase alone recovers the SAME master key, and the vault opens.
    const recovered = await unlockAppHome(descriptor.home, 'correct horse passphrase');
    try {
      expect(openPayload(recovered, sealed).toString('utf8')).toBe('precious app data');
      // Machine B now wraps for itself so future launches are silent.
      const wrappedForB = wrapMasterKeyForMachine(recovered, machineKeyB);
      const liveB = unwrapMasterKeyForMachine(wrappedForB, machineKeyB);
      try {
        expect(openPayload(liveB, sealed).toString('utf8')).toBe('precious app data');
      } finally {
        zeroKey(liveB);
      }
    } finally {
      zeroKey(recovered);
    }
  });

  it('passphrase envelope is self-contained: no machine state needed to parse it', async () => {
    const { descriptor, masterKey } = await makeHome();
    zeroKey(masterKey);
    // A stranger's machine reads only the folder: manifest parses, vault exists.
    const foreign = describeAppHome(descriptor.home);
    expect(foreign.manifest.encryption.passphrase.salt).toMatch(/^[a-f0-9]+$/);
    expect(foreign.manifest.encryption.passphrase.wrappedKey).toMatch(/^[a-f0-9]+$/);
    // Wrong passphrase fails closed; right passphrase opens — nothing else involved.
    await expect(unlockAppHome(descriptor.home, 'wrong passphrase here')).rejects.toThrowError(/wrong passphrase/);
    const key = await unlockAppHome(descriptor.home, 'correct horse passphrase');
    zeroKey(key);
  });
});
