// Portable app homes ("Mac-app-like bundles"): one folder per app on removable
// media, self-describing through a plaintext manifest.json plus an encrypted
// payload folder inside. A Harbor machine adopts a home by reading the manifest
// (works while locked), unlocking with its own machine key or the operator's
// passphrase, and binding the payload as the app's storage.
//
// Layout under <parent>/<name>/ :
//   manifest.json   plaintext descriptor: identity, package, encryption envelope  0644
//   vault/          encrypted payload (files + names are ciphertext)              0700
//
// The manifest is deliberately plaintext so a locked app still shows its name,
// icon hint and package in the console ("locked" tile). Secrets never live in
// the manifest: the passphrase-wrapped master key is in the manifest (portable),
// the machine-wrapped master key lives in Harbor state (<stateDir>/keys/,
// never on the drive). Stealing the drive alone unlocks nothing.
//
// Crypto: AES-256-GCM, one random 32-byte master key per app, random 12-byte
// nonce per encryption. Passphrase wrapping uses the same scrypt profile as
// operator passwords (src/auth/password.ts). This module is pure storage + node
// crypto: no Docker, no DB, no network.
import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { UUID_RE } from '../contracts/patterns.js';
import { normalizeHostPath } from './host-path.js';

export const APP_HOME_FORMAT = 1;
export const APP_HOME_MANIFEST = 'manifest.json';
export const APP_HOME_VAULT = 'vault';

// Keep in step with src/auth/password.ts SCRYPT_PARAMS (duplicated, not
// imported, so the on-disk envelope stays stable if login tuning changes).
export const APP_HOME_SCRYPT = { N: 131072, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 } as const;

const GCM_NONCE_BYTES = 12;
const MASTER_KEY_BYTES = 32;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface AppHomeScryptEnvelope {
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string; // hex
  nonce: string; // hex, GCM nonce for the wrapped master key
  wrappedKey: string; // hex, master key encrypted with the scrypt-derived KEK
  tag: string; // hex, GCM auth tag
}

export interface AppHomeManifest {
  format: number;
  instanceId: string;
  packageId: string;
  packageRevision: string;
  displayName: string;
  createdAt: string; // RFC3339
  harborVersion: string;
  // App-generated drive identity (same idea as .harbor-bind.json): random at
  // creation, travels with the folder on restore/replacement.
  driveId: string;
  vault: string; // encrypted payload directory name (relative, single segment)
  encryption: { algorithm: 'aes-256-gcm'; passphrase: AppHomeScryptEnvelope };
}

export interface AppHomeDescriptor {
  home: string; // absolute path of the app folder
  manifest: AppHomeManifest;
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, APP_HOME_SCRYPT.keylen, { N: APP_HOME_SCRYPT.N, r: APP_HOME_SCRYPT.r, p: APP_HOME_SCRYPT.p, maxmem: APP_HOME_SCRYPT.maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

function hex(b: Buffer): string {
  return b.toString('hex');
}

function unhex(s: string, what: string): Buffer {
  if (typeof s !== 'string' || !/^[a-f0-9]+$/i.test(s) || s.length % 2 !== 0) {
    throw new HarborError('INVALID_PACKAGE', `app home manifest has a malformed ${what}`, {
      nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
    });
  }
  return Buffer.from(s, 'hex');
}

function validateName(name: string, what: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new HarborError('INVALID_PACKAGE', `app home manifest has an invalid ${what}`, {
      nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
    });
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new HarborError('INVALID_PACKAGE', `app home manifest has an unsafe ${what}`, {
      nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
    });
  }
  return name;
}

function parseManifest(raw: Buffer): AppHomeManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HarborError('INVALID_PACKAGE', 'app home manifest.json is not valid JSON', {
      nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
    });
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new HarborError('INVALID_PACKAGE', 'app home manifest.json must be an object', {
      nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
    });
  }
  const m = doc as Record<string, unknown>;
  if (m['format'] !== APP_HOME_FORMAT) {
    throw new HarborError('INVALID_PACKAGE', `app home format ${String(m['format'])} is not supported (this Harbor reads format ${APP_HOME_FORMAT})`, {
      nextAction: 'Update Harbor to a version that understands this app home, then try again.',
    });
  }
  for (const f of ['instanceId', 'packageId', 'packageRevision', 'displayName', 'createdAt', 'harborVersion', 'driveId'] as const) {
    if (typeof m[f] !== 'string' || (m[f] as string).length === 0) {
      throw new HarborError('INVALID_PACKAGE', `app home manifest.json is missing ${f}`, {
        nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
      });
    }
  }
  const manifest = m as unknown as AppHomeManifest;
  if (!UUID_RE.test(manifest.instanceId)) throw new HarborError('INVALID_PACKAGE', 'app home manifest.json has an invalid instanceId', {
    nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
  });
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(manifest.packageId)) throw new HarborError('INVALID_PACKAGE', 'app home manifest.json has an invalid packageId', {
    nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
  });
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new HarborError('INVALID_PACKAGE', 'app home manifest.json has an invalid createdAt', {
    nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
  });
  validateName(manifest.vault, 'vault directory');
  const enc = manifest.encryption as unknown as Record<string, unknown> | undefined;
  if (typeof enc !== 'object' || enc === null || enc['algorithm'] !== 'aes-256-gcm' || typeof enc['passphrase'] !== 'object' || enc['passphrase'] === null) {
    throw new HarborError('INVALID_PACKAGE', 'app home manifest.json has an unsupported encryption envelope', {
      nextAction: 'Update Harbor to a version that understands this app home, then try again.',
    });
  }
  const env = enc['passphrase'] as Record<string, unknown>;
  for (const f of ['salt', 'nonce', 'wrappedKey', 'tag'] as const) {
    if (typeof env[f] !== 'string' || (env[f] as string).length === 0) {
      throw new HarborError('INVALID_PACKAGE', `app home manifest.json is missing encryption.${f}`, {
        nextAction: 'This folder is not a Harbor app home Harbor can read. Adopt the drive it came from, or restore the folder from backup.',
      });
    }
  }
  // Touch every envelope field now so malformed hex fails at read time, not unlock time.
  unhex(env['salt'] as string, 'encryption.salt');
  unhex(env['nonce'] as string, 'encryption.nonce');
  unhex(env['wrappedKey'] as string, 'encryption.wrappedKey');
  unhex(env['tag'] as string, 'encryption.tag');
  return manifest;
}

function manifestPath(home: string): string {
  return path.join(home, APP_HOME_MANIFEST);
}

function writeManifest(home: string, manifest: AppHomeManifest): void {
  writeFileSync(manifestPath(home), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
}

// Wrap/unwrap the master key with a passphrase-derived KEK (scrypt → AES-256-GCM).
async function wrapMasterKey(masterKey: Buffer, passphrase: string): Promise<AppHomeScryptEnvelope> {
  if (passphrase.length < 8) throw new HarborError('INVALID_REQUEST', 'app encryption passphrase must be at least 8 characters');
  if (passphrase.length > 256) throw new HarborError('INVALID_REQUEST', 'app encryption passphrase must be at most 256 characters');
  const salt = randomBytes(16);
  const kek = await scryptAsync(passphrase, salt);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const wrappedKey = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  kek.fill(0);
  return { N: APP_HOME_SCRYPT.N, r: APP_HOME_SCRYPT.r, p: APP_HOME_SCRYPT.p, keylen: APP_HOME_SCRYPT.keylen, salt: hex(salt), nonce: hex(nonce), wrappedKey: hex(wrappedKey), tag: hex(tag) };
}

async function unwrapMasterKey(envelope: AppHomeScryptEnvelope, passphrase: string): Promise<Buffer> {
  const kek = await scryptAsync(passphrase, unhex(envelope.salt, 'encryption.salt'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, unhex(envelope.nonce, 'encryption.nonce'));
    decipher.setAuthTag(unhex(envelope.tag, 'encryption.tag'));
    return Buffer.concat([decipher.update(unhex(envelope.wrappedKey, 'encryption.wrappedKey')), decipher.final()]);
  } catch {
    throw new HarborError('INVALID_REQUEST', 'wrong passphrase for this app', {
      nextAction: 'Enter the encryption passphrase shown when the app was installed (or its recovery key).',
    });
  } finally {
    kek.fill(0);
  }
}

export interface CreateAppHomeInput {
  parentDir: string; // existing directory, e.g. /mnt/<label>/harbor-apps
  name: string; // folder name for this app (single segment)
  instanceId: string;
  packageId: string;
  packageRevision: string;
  displayName: string;
  passphrase: string;
  harborVersion: string;
  now?: Date;
}

// Create a new app home: <parentDir>/<name>/{manifest.json, vault/}. Returns
// the descriptor plus the master key (the caller stores the machine wrapping
// in Harbor state; the key buffer is zeroed after the caller copies it).
export async function createAppHome(input: CreateAppHomeInput): Promise<{ descriptor: AppHomeDescriptor; masterKey: Buffer }> {
  const parent = normalizeHostPath(input.parentDir);
  const name = validateName(input.name, 'app folder name');
  if (!UUID_RE.test(input.instanceId)) throw new HarborError('INVALID_REQUEST', `invalid instance id ${input.instanceId}`);
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.packageId)) throw new HarborError('INVALID_REQUEST', `invalid package id ${input.packageId}`);
  let st;
  try {
    st = statSync(parent);
  } catch {
    throw new HarborError('INVALID_REQUEST', `app home parent ${parent} does not exist`, { nextAction: 'Mount the drive and create the apps folder first, then try again.' });
  }
  if (!st.isDirectory()) throw new HarborError('INVALID_REQUEST', `${parent} exists but is not a directory`);
  const home = path.join(parent, name);
  if (existsSync(home)) throw new HarborError('NAME_CONFLICT', `app home ${home} already exists`, { nextAction: 'Choose a different app folder name.' });
  const masterKey = randomBytes(MASTER_KEY_BYTES);
  const envelope = await wrapMasterKey(masterKey, input.passphrase);
  const now = input.now ?? new Date();
  const manifest: AppHomeManifest = {
    format: APP_HOME_FORMAT,
    instanceId: input.instanceId,
    packageId: input.packageId,
    packageRevision: input.packageRevision,
    displayName: input.displayName,
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    harborVersion: input.harborVersion,
    driveId: randomBytes(16).toString('hex'),
    vault: APP_HOME_VAULT,
    encryption: { algorithm: 'aes-256-gcm', passphrase: envelope },
  };
  mkdirSync(home, { recursive: false, mode: 0o700 });
  try {
    mkdirSync(path.join(home, APP_HOME_VAULT), { recursive: false, mode: 0o700 });
    writeManifest(home, manifest);
  } catch (e) {
    throw new HarborError('STATE_UNAVAILABLE', `cannot create app home ${home}: ${(e as Error).message}`);
  }
  return { descriptor: { home, manifest }, masterKey };
}

// Read the plaintext descriptor of an app home. Works while locked: this is
// what the console shows on a locked tile (name, package, revision).
export function describeAppHome(home: string): AppHomeDescriptor {
  const norm = normalizeHostPath(home);
  let st;
  try {
    st = statSync(norm);
  } catch {
    throw new HarborError('DATA_MISSING', `app home ${norm} does not exist`, {
      nextAction: 'Re-insert the drive that holds this app, or restore the folder from backup.',
    });
  }
  if (!st.isDirectory()) throw new HarborError('INVALID_PACKAGE', `app home ${norm} is not a directory`, {
    nextAction: 'Re-insert the drive that holds this app, or restore the folder from backup.',
  });
  let raw: Buffer;
  try {
    raw = readFileSync(manifestPath(norm));
  } catch {
    throw new HarborError('DATA_MISSING', `app home ${norm} carries no Harbor manifest (missing ${APP_HOME_MANIFEST})`, {
      nextAction: 'This folder is not a Harbor app home. Mount the drive that holds the app, or restore the folder from backup.',
    });
  }
  if (raw.length > MAX_MANIFEST_BYTES) throw new HarborError('INVALID_PACKAGE', `app home manifest.json exceeds ${MAX_MANIFEST_BYTES} bytes`, {
    nextAction: 'This folder is not a Harbor app home Harbor can read. Restore the folder from backup.',
  });
  const manifest = parseManifest(raw);
  const vault = path.join(norm, manifest.vault);
  try {
    const vst = statSync(vault);
    if (!vst.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new HarborError('DATA_MISSING', `app home ${norm} is missing its encrypted folder (${manifest.vault}/)`, {
      nextAction: 'The app folder is incomplete. Restore it from backup.',
    });
  }
  return { home: norm, manifest };
}

// Unlock: derive the master key from the operator passphrase. Throws
// INVALID_REQUEST on a wrong passphrase. The caller zeroes the key when done.
export async function unlockAppHome(home: string, passphrase: string): Promise<Buffer> {
  const { manifest } = describeAppHome(home);
  return unwrapMasterKey(manifest.encryption.passphrase, passphrase);
}

// Change the passphrase (re-wrap the same master key). The old passphrase must
// unlock first; the manifest is rewritten atomically in place.
export async function changeAppHomePassphrase(home: string, oldPassphrase: string, newPassphrase: string): Promise<void> {
  const norm = normalizeHostPath(home);
  const { manifest } = describeAppHome(norm);
  const masterKey = await unwrapMasterKey(manifest.encryption.passphrase, oldPassphrase);
  try {
    manifest.encryption.passphrase = await wrapMasterKey(masterKey, newPassphrase);
    writeManifest(norm, manifest);
  } finally {
    masterKey.fill(0);
  }
}

// Encrypt one payload for storage inside the vault: nonce || ciphertext || tag
// (all random per call). Names are encrypted the same way by callers that need
// filename secrecy; this helper only seals bytes.
export function sealPayload(masterKey: Buffer, plaintext: Buffer): Buffer {
  if (masterKey.length !== MASTER_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'app master key has the wrong length');
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function openPayload(masterKey: Buffer, sealed: Buffer): Buffer {
  if (masterKey.length !== MASTER_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'app master key has the wrong length');
  if (sealed.length < GCM_NONCE_BYTES + 16 + 1) throw new HarborError('DATA_MISSING', 'encrypted app data is truncated', {
    nextAction: 'The app folder is damaged. Restore it from backup.',
  });
  const nonce = sealed.subarray(0, GCM_NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(GCM_NONCE_BYTES, sealed.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new HarborError('DATA_MISSING', 'encrypted app data failed authentication', {
      nextAction: 'The app folder is damaged or belongs to a different app. Restore it from backup.',
    });
  }
}

// Constant-time check that a candidate master key matches the home without
// decrypting payload data (used at adopt time before trusting the vault).
export async function verifyPassphrase(home: string, passphrase: string): Promise<boolean> {
  try {
    const key = await unlockAppHome(home, passphrase);
    try {
      return key.length === MASTER_KEY_BYTES;
    } finally {
      key.fill(0);
    }
  } catch (e) {
    if (HarborError.is(e, 'INVALID_REQUEST')) return false;
    throw e;
  }
}

// Scan a parent directory for app homes: every immediate child carrying a
// readable manifest.json. Unreadable children are reported, never thrown — one
// bad folder must not hide the rest of the drive.
export interface AppHomeScanEntry {
  name: string;
  descriptor?: AppHomeDescriptor;
  error?: string;
}

export function scanAppHomes(parentDir: string): AppHomeScanEntry[] {
  const parent = normalizeHostPath(parentDir);
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    throw new HarborError('DATA_MISSING', `app folder ${parent} does not exist`, {
      nextAction: 'Mount the drive that holds the apps, then try again.',
    });
  }
  const out: AppHomeScanEntry[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(parent, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(manifestPath(full))) continue;
    try {
      out.push({ name, descriptor: describeAppHome(full) });
    } catch (e) {
      out.push({ name, error: (e as Error).message });
    }
  }
  return out;
}

// Machine wrapping of the master key for Harbor state (<stateDir>/keys/):
// AES-256-GCM with a per-installation key the caller holds. The wrapped blob
// is JSON-serializable for the settings/state store.
export interface MachineWrappedKey {
  algorithm: 'aes-256-gcm';
  nonce: string;
  wrappedKey: string;
  tag: string;
}

export function wrapMasterKeyForMachine(masterKey: Buffer, machineKey: Buffer): MachineWrappedKey {
  if (masterKey.length !== MASTER_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'app master key has the wrong length');
  if (machineKey.length !== MASTER_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'machine key has the wrong length');
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', machineKey, nonce);
  const wrappedKey = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return { algorithm: 'aes-256-gcm', nonce: hex(nonce), wrappedKey: hex(wrappedKey), tag: hex(cipher.getAuthTag()) };
}

export function unwrapMasterKeyForMachine(wrapped: MachineWrappedKey, machineKey: Buffer): Buffer {
  if (machineKey.length !== MASTER_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'machine key has the wrong length');
  if (wrapped.algorithm !== 'aes-256-gcm') throw new HarborError('INVALID_PACKAGE', 'machine-wrapped app key uses an unsupported algorithm', {
    nextAction: 'Update Harbor to a version that understands this wrapping, then try again.',
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', machineKey, unhex(wrapped.nonce, 'machine key nonce'));
    decipher.setAuthTag(unhex(wrapped.tag, 'machine key tag'));
    return Buffer.concat([decipher.update(unhex(wrapped.wrappedKey, 'machine key')), decipher.final()]);
  } catch {
    throw new HarborError('DATA_MISSING', 'stored app key failed authentication', {
      nextAction: 'The stored key for this app is damaged or belongs to a different installation. Unlock with the encryption passphrase instead.',
    });
  }
}

export function zeroKey(key: Buffer): void {
  key.fill(0);
}

export function timingSafeKeyEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
