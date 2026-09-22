// Root half of "prepare this removable drive for per-app sealing" (run by
// harbor-device-mount@<name>:crypto-setup.service via `harbor device-dispatch`).
// Validates the removable-only allowlist itself, then reuses the same
// filesystem-readiness helper the app sealing step runs (encrypt feature,
// /etc/fscrypt.conf, per-mount metadata). Progress goes to
// <stateDir>/devices/<name>/crypto-status.json so the console can poll it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { listDevices } from '../system/host-storage.js';
import { prepareFilesystemForSealing } from './app-crypto-apply.js';

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

// Ensure the filesystem on a mounted removable drive is ready for fscrypt:
// encrypt feature + metadata dirs. Idempotent (setup re-runs harmlessly).
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
  try {
    const mnt = await prepareFilesystemForSealing(mp, log);
    writeStatus(stateDir, device, 'ready', `encryption ready on ${mnt.mountpoint}`, mp);
    log(`encryption ready on ${mnt.mountpoint}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(stateDir, device, 'failed', msg, mp);
    throw e;
  }
}
