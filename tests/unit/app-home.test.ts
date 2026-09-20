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
  const { descriptor, masterKey } = await createAppHome({
    parentDir: parent,
    name: 'immich',
    instanceId: INSTANCE,
    packageId: 'immich',
    packageRevision: '3',
    displayName: 'Immich',
    passphrase,
    harborVersion: '0.13.0',
  });
  return { parent, descriptor, masterKey };
}

describe('app homes', () => {
  it('creates a home with a plaintext manifest and an encrypted vault dir', async () => {
    const { descriptor, masterKey } = await makeHome();
    try {
      expect(descriptor.manifest.format).toBe(APP_HOME_FORMAT);
      expect(descriptor.manifest.instanceId).toBe(INSTANCE);
      expect(descriptor.manifest.packageId).toBe('immich');
      expect(descriptor.manifest.vault).toBe('vault');
      expect(descriptor.manifest.encryption.algorithm).toBe('aes-256-gcm');
      // The manifest is plaintext: name, package and revision read while locked.
      const raw = JSON.parse(readFileSync(path.join(descriptor.home, 'manifest.json'), 'utf8'));
      expect(raw.displayName).toBe('Immich');
      expect(raw.packageRevision).toBe('3');
      expect(JSON.stringify(raw)).not.toContain(masterKey.toString('hex'));
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

  it('changing the passphrase re-wraps the same master key', async () => {
    const { descriptor, masterKey } = await makeHome();
    const before = Buffer.from(masterKey);
    zeroKey(masterKey);
    await changeAppHomePassphrase(descriptor.home, 'correct horse passphrase', 'a brand new passphrase');
    expect(await verifyPassphrase(descriptor.home, 'correct horse passphrase')).toBe(false);
    expect(await verifyPassphrase(descriptor.home, 'a brand new passphrase')).toBe(true);
    const after = await unlockAppHome(descriptor.home, 'a brand new passphrase');
    try {
      expect(after.equals(before)).toBe(true);
    } finally {
      zeroKey(after);
    }
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
