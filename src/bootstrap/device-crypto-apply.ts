// Root half of per-app kernel sealing (run by
// harbor-device-mount@<name>:<action>.service via `harbor device-dispatch`).
// Validates the removable-only allowlist itself, writes the master key to a
// root-only temp file (0600, zeroed + unlinked after use), and shells out to
// fscrypt with argv only (never shell: true). Progress goes to
// <stateDir>/devices/<name>/crypto-status.json so the console can poll it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { listDevices } from '../system/host-storage.js';
import { fscryptEncryptArgs, fscryptLockArgs, fscryptSetupArgs, fscryptUnlockArgs, parseFscryptDirStatus, parseFscryptStatus } from '../storage/fscrypt.js';

export type DeviceCryptoState = 'requested' | 'working' | 'ready' | 'failed';
export interface DeviceCryptoStatus {
  device: string;
  state: DeviceCryptoState;
  message: string;
  mountpoint: string | null;
  at: string;
}

export function deviceCryptoStatusFile(stateDir: string, name: string): string {
  return path.join(stateDir, 'devices', name, 'crypto-status.json');
}

function writeStatus(stateDir: string, name: string, state: DeviceCryptoState, message: string, mountpoint: string | null): void {
  const file = deviceCryptoStatusFile(stateDir, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ device: name, state, message, mountpoint, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    /* status is best effort */
  }
}

export function readDeviceCryptoStatus(stateDir: string, name: string): DeviceCryptoStatus | null {
  try {
    const file = deviceCryptoStatusFile(stateDir, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as DeviceCryptoStatus;
  } catch {
    return null;
  }
}

function validDeviceName(name: string): boolean {
  return /^[a-z]+[0-9]+$/.test(name) && name.length <= 16;
}

function validHomePath(home: string): string {
  if (typeof home !== 'string' || !home.startsWith('/mnt/') || home.includes('\0') || home.includes('..')) {
    throw new HarborError('INVALID_REQUEST', `not an app home path: ${home}`);
  }
  return home;
}

// Write the master key (hex) to a root-only temp file for --key=FILE.
// Returns the path; the caller unlinks it in a finally.
function writeKeyFile(masterKeyHex: string): string {
  if (!/^[a-f0-9]{64}$/i.test(masterKeyHex)) throw new HarborError('INVALID_REQUEST', 'master key must be 32 bytes as hex');
  const p = `/root/.harbor-fscrypt-${randomBytes(8).toString('hex')}.key`;
  writeFileSync(p, Buffer.from(masterKeyHex, 'hex'), { mode: 0o600 });
  return p;
}

// Ensure the filesystem at <mountpoint> is ready for fscrypt: kernel support
// + encrypt feature + metadata dirs. Idempotent (setup re-runs harmlessly).
export async function applyDeviceCryptoSetup(device: string, log: (m: string) => void): Promise<void> {
  if (!validDeviceName(device)) throw new HarborError('INVALID_REQUEST', `not a device name: ${device}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'device crypto setup must run as root');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const stateDir = config.stateDir;
  const found = listDevices().find((d) => d.name === device);
  if (!found) throw new HarborError('NOT_FOUND', `device ${device} not found`, { nextAction: 'Re-insert the drive and retry.' });
  if (!found.removable) throw new HarborError('INVALID_REQUEST', `device ${device} is not removable media`);
  const mp = found.mountpoint;
  if (!mp) throw new HarborError('INVALID_STATE', `device ${device} is not mounted`, { nextAction: 'Mount the drive first, then try again.' });
  writeStatus(stateDir, device, 'working', `setting up encryption on ${mp}`, mp);
  log(`fscrypt setup ${mp}`);
  try {
    const s = fscryptSetupArgs(mp);
    await execOk(s.file, s.args, { timeoutMs: 60_000 });
    const st = await exec(s.file === '/usr/bin/fscrypt' ? '/usr/bin/fscrypt' : s.file, ['status', mp], { timeoutMs: 30_000 });
    const parsed = parseFscryptStatus(mp, st.stdout);
    if (!parsed.supported) throw new HarborError('OPERATION_FAILED', `${mp} does not support native encryption (needs ext4 with the encrypt feature)`, { nextAction: 'Format the drive as ext4 in Settings → Storage, then try again.' });
    writeStatus(stateDir, device, 'ready', `encryption ready on ${mp}`, mp);
    log(`encryption ready on ${mp}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(stateDir, device, 'failed', msg, mp);
    throw e;
  }
}

// Seal one app's volumes dir (must exist and be EMPTY) with its master key.
export async function applyAppSeal(home: string, masterKeyHex: string, protectorName: string, log: (m: string) => void): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'app seal must run as root');
  const dir = validHomePath(home).replace(/\/+$/, '') + '/volumes';
  const keyFile = writeKeyFile(masterKeyHex);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s = fscryptEncryptArgs({ dir, protectorName }, keyFile);
    await execOk(s.file, s.args, { timeoutMs: 120_000 });
    log(`sealed ${dir}`);
  } finally {
    try {
      writeFileSync(keyFile, Buffer.alloc(32, 0));
    } catch {
      /* best effort */
    }
    rmSync(keyFile, { force: true });
  }
}

// Unlock one app's volumes dir with its master key (idempotent when already unlocked).
export async function applyAppUnlock(home: string, masterKeyHex: string, log: (m: string) => void): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'app unlock must run as root');
  const dir = validHomePath(home).replace(/\/+$/, '') + '/volumes';
  // Already unlocked: skip (fscrypt unlock would prompt).
  try {
    const st = await exec('/usr/bin/fscrypt', ['status', dir], { timeoutMs: 30_000 });
    const parsed = parseFscryptDirStatus(st.stdout);
    if (parsed.encrypted && parsed.unlocked) {
      log(`${dir} already unlocked`);
      return;
    }
  } catch {
    /* fall through to unlock */
  }
  const keyFile = writeKeyFile(masterKeyHex);
  try {
    const s = fscryptUnlockArgs(dir, keyFile);
    await execOk(s.file, s.args, { timeoutMs: 120_000 });
    log(`unlocked ${dir}`);
  } finally {
    try {
      writeFileSync(keyFile, Buffer.alloc(32, 0));
    } catch {
      /* best effort */
    }
    rmSync(keyFile, { force: true });
  }
}

// Lock one app's volumes dir (ciphertext names + ENOKEY until next unlock).
export async function applyAppLock(home: string, log: (m: string) => void): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'app lock must run as root');
  const dir = validHomePath(home).replace(/\/+$/, '') + '/volumes';
  const s = fscryptLockArgs(dir);
  await execOk(s.file, s.args, { timeoutMs: 60_000 });
  log(`locked ${dir}`);
}
