// Drive formatting for app installs: turn a removable drive into an ext4 home
// for encrypted apps. Root-only (run by harbor-device-mount@<name>:format via
// the same polkit-allowed template unit as mount/unmount), removable-only,
// and refused while any app (bind folder OR app home) lives on the drive.
// Progress goes to <stateDir>/devices/<name>/format-status.json so the console
// can poll it like mount status.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { listDevices } from '../system/host-storage.js';

export type DeviceFormatState = 'requested' | 'formatting' | 'formatted' | 'failed';
export interface DeviceFormatStatus {
  device: string;
  state: DeviceFormatState;
  message: string;
  fsType: string | null;
  mountpoint: string | null;
  at: string;
}

export function deviceFormatStatusFile(stateDir: string, name: string): string {
  return path.join(stateDir, 'devices', name, 'format-status.json');
}

function writeStatus(stateDir: string, name: string, state: DeviceFormatState, message: string, fsType: string | null, mountpoint: string | null): void {
  const file = deviceFormatStatusFile(stateDir, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ device: name, state, message, fsType, mountpoint, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    /* status is best effort */
  }
}

export function readDeviceFormatStatus(stateDir: string, name: string): DeviceFormatStatus | null {
  try {
    const file = deviceFormatStatusFile(stateDir, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as DeviceFormatStatus;
  } catch {
    return null;
  }
}

function validDeviceName(name: string): boolean {
  return /^[a-z]+[0-9]+$/.test(name) && name.length <= 16;
}

// Format one removable partition as ext4 (the only filesystem Harbor trusts
// for app homes) and mount it at /mnt/<label>. Wipes the partition signature
// first so a stale vfat superblock can never shadow the new filesystem.
// The caller (DeviceMountService.format) already refused while apps use the
// drive; this re-checks the allowlist itself because it runs as root.
export async function applyDeviceFormat(device: string, log: (m: string) => void): Promise<void> {
  if (!validDeviceName(device)) throw new HarborError('INVALID_REQUEST', `not a device name: ${device}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'device-format must run as root (it is started by harbor-device-mount@.service)');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const stateDir = config.stateDir;
  const found = listDevices().find((d) => d.name === device);
  if (!found) throw new HarborError('NOT_FOUND', `device ${device} not found`, { nextAction: 'Re-insert the drive and retry.' });
  if (!found.removable) throw new HarborError('INVALID_REQUEST', `device ${device} is not removable media`, { nextAction: 'Harbor only formats removable drives; system disks are never touched.' });
  writeStatus(stateDir, device, 'formatting', `formatting ${found.device} as ext4 (all data on it is being erased)`, null, found.mountpoint ?? null);
  log(`formatting ${found.device} as ext4`);
  try {
    // Unmount first when mounted (a mounted vfat cannot be formatted).
    if (found.mounted && found.mountpoint) {
      await execOk('/usr/bin/umount', [found.mountpoint], { timeoutMs: 60_000 });
    }
    await execOk('/usr/sbin/wipefs', ['-a', found.device], { timeoutMs: 60_000 });
    await execOk('/usr/sbin/mkfs.ext4', ['-F', '-L', (found.label ?? device).slice(0, 16), found.device], { timeoutMs: 300_000 });
    // Re-read the device so the mountpoint suggestion uses the fresh label.
    const fresh = listDevices().find((d) => d.name === device);
    const { suggestedMountpoint } = await import('../system/host-storage.js');
    const mp = suggestedMountpoint({ name: device, label: fresh?.label ?? found.label ?? device });
    mkdirSync(mp, { recursive: true, mode: 0o755 });
    await execOk('/usr/bin/mount', [found.device, mp], { timeoutMs: 60_000 });
    const uid = Number((await exec('/usr/bin/id', ['-u', PRODUCT.serviceUser])).stdout.trim());
    const gid = Number((await exec('/usr/bin/id', ['-g', PRODUCT.serviceUser])).stdout.trim());
    await execOk('/usr/bin/chown', [`${uid}:${gid}`, mp], { timeoutMs: 30_000 });
    writeStatus(stateDir, device, 'formatted', `formatted as ext4 and mounted at ${mp}`, 'ext4', mp);
    log(`formatted as ext4 and mounted at ${mp}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(stateDir, device, 'failed', msg, null, found.mountpoint ?? null);
    throw e;
  }
}
