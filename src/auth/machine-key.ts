// Machine keystore: the per-installation key that wraps every app-home master
// key (src/storage/app-home.ts `wrapMasterKeyForMachine`). The machine key
// itself never sits on disk in the clear: it is sealed with a KEK derived from
// the administrator's login password (scrypt, same profile as operator
// passwords), and only the sealed blob is stored.
//
// Phone model (BFU/AFU):
//   BFU (before first unlock): daemon starts, the sealed blob is on disk, the
//     machine key is NOT in memory. App homes show as locked; nothing
//     auto-unlocks. The first successful login derives the KEK, unseals the
//     machine key, and holds it in memory only.
//   AFU (after first unlock): the machine key lives in memory. Logins verify
//     against the stored password hash as usual (no re-derive needed); app
//     homes auto-adopt silently. A daemon restart returns to BFU.
//   Password change: the machine key is re-sealed under the new password
//     (needs the current password, which the change flow already requires).
//     A password reset without the old password destroys the sealed blob —
//     app homes stay recoverable through their own passphrases.
//
// The sealed blob lives in the settings table (`security.machineKey`, JSON),
// so no schema migration is needed. This module is pure key handling: callers
// own persistence (repo settings) and memory lifetime (daemon/session layer).
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { HarborError } from '../errors.js';
import { APP_HOME_SCRYPT } from '../storage/app-home.js';

export const MACHINE_KEY_BYTES = 32;
const SEAL_NONCE_BYTES = 12;
const SEAL_SALT_BYTES = 16;

export interface SealedMachineKey {
  format: 1;
  algorithm: 'aes-256-gcm';
  scrypt: { N: number; r: number; p: number; keylen: number };
  salt: string; // hex
  nonce: string; // hex
  sealedKey: string; // hex
  tag: string; // hex
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

function unhex(s: unknown, what: string): Buffer {
  if (typeof s !== 'string' || !/^[a-f0-9]+$/i.test(s) || s.length % 2 !== 0 || s.length === 0) {
    throw new HarborError('INVALID_PACKAGE', `sealed machine key has a malformed ${what}`, {
      nextAction: 'The stored machine key is damaged. App homes stay recoverable through their own encryption passphrases.',
    });
  }
  return Buffer.from(s, 'hex');
}

function checkPassword(password: string): void {
  if (typeof password !== 'string' || password.length === 0) throw new HarborError('INVALID_REQUEST', 'password must be a non-empty string');
  if (password.length > 256) throw new HarborError('INVALID_REQUEST', 'password must be at most 256 characters');
}

// Create a fresh machine key and seal it under the administrator password.
// Returns the sealed blob for storage plus the key itself (caller keeps it in
// memory for this boot; the buffer is the caller's to zero when done).
export async function createSealedMachineKey(password: string): Promise<{ sealed: SealedMachineKey; machineKey: Buffer }> {
  checkPassword(password);
  const machineKey = randomBytes(MACHINE_KEY_BYTES);
  const salt = randomBytes(SEAL_SALT_BYTES);
  const kek = await scryptAsync(password, salt);
  try {
    const nonce = randomBytes(SEAL_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    const sealedKey = Buffer.concat([cipher.update(machineKey), cipher.final()]);
    const sealed: SealedMachineKey = {
      format: 1,
      algorithm: 'aes-256-gcm',
      scrypt: { N: APP_HOME_SCRYPT.N, r: APP_HOME_SCRYPT.r, p: APP_HOME_SCRYPT.p, keylen: APP_HOME_SCRYPT.keylen },
      salt: hex(salt),
      nonce: hex(nonce),
      sealedKey: hex(sealedKey),
      tag: hex(cipher.getAuthTag()),
    };
    return { sealed, machineKey };
  } finally {
    kek.fill(0);
  }
}

// BFU -> AFU: unseal the stored blob with the password just used to log in.
// Throws UNAUTHENTICATED on a wrong password (same code as a bad login, so the
// unlock step never reveals more than the login itself).
export async function unsealMachineKey(sealed: SealedMachineKey, password: string): Promise<Buffer> {
  checkPassword(password);
  if (!sealed || sealed.format !== 1 || sealed.algorithm !== 'aes-256-gcm' || !sealed.scrypt) {
    throw new HarborError('INVALID_PACKAGE', 'sealed machine key uses an unsupported format', {
      nextAction: 'Update Harbor to a version that understands this key, then try again.',
    });
  }
  const kek = await scryptAsync(password, unhex(sealed.salt, 'salt'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, unhex(sealed.nonce, 'nonce'));
    decipher.setAuthTag(unhex(sealed.tag, 'tag'));
    const key = Buffer.concat([decipher.update(unhex(sealed.sealedKey, 'sealedKey')), decipher.final()]);
    if (key.length !== MACHINE_KEY_BYTES) throw new Error('bad length');
    return key;
  } catch (e) {
    if (e instanceof HarborError) throw e;
    throw new HarborError('UNAUTHENTICATED', 'password does not unlock the machine key', {
      nextAction: 'Type your password again. App homes stay recoverable through their own encryption passphrases.',
    });
  } finally {
    kek.fill(0);
  }
}

// Password change: re-seal the live machine key under the new password. The
// caller proves the old password by handing over the already-unsealed key
// (AFU state); this function never sees either password's plaintext beyond
// deriving the new KEK.
export async function resealMachineKey(machineKey: Buffer, newPassword: string): Promise<SealedMachineKey> {
  checkPassword(newPassword);
  if (machineKey.length !== MACHINE_KEY_BYTES) throw new HarborError('INVALID_REQUEST', 'machine key has the wrong length');
  const salt = randomBytes(SEAL_SALT_BYTES);
  const kek = await scryptAsync(newPassword, salt);
  try {
    const nonce = randomBytes(SEAL_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    const sealedKey = Buffer.concat([cipher.update(machineKey), cipher.final()]);
    return {
      format: 1,
      algorithm: 'aes-256-gcm',
      scrypt: { N: APP_HOME_SCRYPT.N, r: APP_HOME_SCRYPT.r, p: APP_HOME_SCRYPT.p, keylen: APP_HOME_SCRYPT.keylen },
      salt: hex(salt),
      nonce: hex(nonce),
      sealedKey: hex(sealedKey),
      tag: hex(cipher.getAuthTag()),
    };
  } finally {
    kek.fill(0);
  }
}

export function zeroMachineKey(key: Buffer): void {
  key.fill(0);
}
