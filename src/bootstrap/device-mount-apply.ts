// The root half of a removable-device mount/unmount from the console
// (run by harbor-device-mount@<escaped-device>.service). Reuses the same shape as
// tools-install-apply: must run as root (started by the template unit), validates
// the allowlist itself, and writes progress to <stateDir>/devices/<name>/mount-status.json.
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { listDevices, suggestedMountpoint } from '../system/host-storage.js';

export type DeviceMountState = 'requested' | 'mounting' | 'mounted' | 'unmounting' | 'unmounted' | 'failed';
export interface DeviceMountStatus {
  device: string;
  state: DeviceMountState;
  message: string;
  mountpoint: string | null;
  at: string;
}

export function deviceMountStatusFile(stateDir: string, name: string): string {
  return path.join(stateDir, 'devices', name, 'mount-status.json');
}

function writeStatus(stateDir: string, name: string, state: DeviceMountState, message: string, mountpoint: string | null): void {
  const file = deviceMountStatusFile(stateDir, name);
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ device: name, state, message, mountpoint, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    /* status is best effort */
  }
}

export function readDeviceMountStatus(stateDir: string, name: string): DeviceMountStatus | null {
  try {
    const file = deviceMountStatusFile(stateDir, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as DeviceMountStatus;
  } catch {
    return null;
  }
}

function validDeviceName(name: string): boolean {
  return /^[a-z]+[0-9]+$/.test(name) && name.length <= 16;
}

// Transient kernel lock contention (the PNY-stick class of failure): a
// just-finished format, an auto-mount racing a manual one, or a ghost mount
// layer still holding /dev/<name>. mount(8)/ntfs-3g report it as exit 18 +
// "Failed to write lock … Resource temporarily unavailable", or "Device or
// resource busy". A human just waits a beat and clicks again — so the root
// step retries itself instead of surfacing a raw exit code.
export function isDriveBusyError(msg: string): boolean {
  return /resource temporarily unavailable|failed to write lock|device or resource busy|target is busy|resource busy/i.test(msg);
}

export function friendlyBusyMessage(action: 'mount' | 'unmount' | 'takeover', raw: string): string {
  if (action === 'takeover') return `Something still has files open on the drive (your file manager, a terminal, a program). Close it, then try Let Harbor manage it again. (${raw})`;
  if (action === 'unmount') return `The drive is in use right now (a file or app still holds it). Close anything using it, wait a few seconds, then try Eject again. (${raw})`;
  return `The drive was busy just now, so the mount did not go through. Wait a few seconds and try Mount again. (${raw})`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Decision 122: tell udisks (the desktop automounter) to leave this filesystem alone from now on, so a
// drive Harbor took over is not grabbed again at the next plug-in. Keyed by filesystem UUID.
export function desktopIgnoreRule(uuid: string): { file: string; content: string } | null {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(uuid)) return null;
  return { file: `/etc/udev/rules.d/90-harbor-drive-${uuid}.rules`, content: `# Written by Harbor (Let Harbor manage this drive): the desktop must not automount it.\nENV{ID_FS_UUID}=="${uuid}", ENV{UDISKS_AUTO}="0"\n` };
}

// Decision 122: Harbor's own identity files on a drive (.harbor-bind.json) become this machine's
// harbor user's and world-readable, so a drive moved between machines (different harbor uids) still
// verifies. Only those files: user data is never re-owned. Bounded walk, no symlinks, sealed homes skipped.
export function reownMarkers(root: string, uid: number, gid: number, log: (m: string) => void): number {
  let visited = 0;
  let fixed = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || visited > 20_000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === 'harbor-apps' || e.name === 'lost+found') continue;
        walk(p, depth + 1);
      } else if (e.isFile() && e.name === '.harbor-bind.json') {
        try {
          if (!lstatSync(p).isFile()) continue;
          chownSync(p, uid, gid);
          chmodSync(p, 0o644);
          fixed += 1;
        } catch {
          /* best effort per file */
        }
      }
    }
  };
  walk(root, 0);
  if (fixed) log(`re-owned ${fixed} Harbor identity file(s) for this machine`);
  return fixed;
}

export async function applyDeviceMount(device: string, action: 'mount' | 'unmount' | 'takeover', log: (m: string) => void): Promise<void> {
  if (!validDeviceName(device)) throw new HarborError('INVALID_REQUEST', `not a device name: ${device}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'device-mount must run as root (it is started by harbor-device-mount@.service)');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const stateDir = config.stateDir;
  const found = listDevices().find((d) => d.name === device);
  if (!found) throw new HarborError('NOT_FOUND', `device ${device} not found`, { nextAction: 'Re-insert the drive and retry.' });
  if (!found.removable) throw new HarborError('INVALID_REQUEST', `device ${device} is not removable media`, { nextAction: 'Harbor only mounts removable drives; system disks are never touched.' });
  if (action === 'takeover') {
    // Decision 122: off the desktop's mountpoint (fails while files are open), then the normal mount.
    if (found.mounted && found.mountpoint && found.mountpoint !== suggestedMountpoint(found)) {
      writeStatus(stateDir, device, 'unmounting', `taking over: unmounting ${found.mountpoint}`, found.mountpoint);
      log(`taking over: unmounting ${found.mountpoint}`);
      try {
        await execOk('/usr/bin/umount', [found.mountpoint], { timeoutMs: 60_000 });
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        writeStatus(stateDir, device, 'failed', isDriveBusyError(raw) ? friendlyBusyMessage('takeover', raw) : raw, found.mountpoint);
        throw e;
      }
      found.mounted = false;
      found.mountpoint = null;
    }
    const rule = found.uuid ? desktopIgnoreRule(found.uuid) : null;
    if (rule) {
      try {
        writeFileSync(rule.file, rule.content, { mode: 0o644 });
        await exec('/usr/bin/udevadm', ['control', '--reload-rules'], { timeoutMs: 30_000 });
        log(`the desktop will no longer automount this drive (${rule.file})`);
      } catch (e) {
        log(`could not write the desktop rule (${e instanceof Error ? e.message : String(e)}); the desktop may mount it again next time`);
      }
    }
  }
  if (action === 'mount' || action === 'takeover') {
    if (found.mounted && found.mountpoint) {
      writeStatus(stateDir, device, 'mounted', `already mounted at ${found.mountpoint}`, found.mountpoint);
      return;
    }
    const mp = suggestedMountpoint(found);
    writeStatus(stateDir, device, 'mounting', `mounting ${found.device} at ${mp}`, mp);
    log(`mounting ${found.device} at ${mp}`);
    try {
      mkdirSync(mp, { recursive: true, mode: 0o755 });
      // vfat/exfat/ntfs have no Unix owners: mount with harbor ownership. Native
      // filesystems are chowned after mount instead.
      const fat = found.fsType === 'vfat' || found.fsType === 'exfat' || found.fsType === 'ntfs' || found.fsType === 'ntfs3' || found.fsType === 'fuseblk';
      const uid = Number((await exec('/usr/bin/id', ['-u', PRODUCT.serviceUser])).stdout.trim());
      const gid = Number((await exec('/usr/bin/id', ['-g', PRODUCT.serviceUser])).stdout.trim());
      const mountArgs = fat ? ['-o', `uid=${uid},gid=${gid},utf8`, found.device, mp] : [found.device, mp];
      // One self-retry on transient lock contention (see isDriveBusyError):
      // the first attempt often races a just-finished format or a ghost
      // mount layer; the second, a few seconds later, lands.
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await execOk('/usr/bin/mount', mountArgs, { timeoutMs: 60_000 });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt === 0 && isDriveBusyError(msg)) {
            log(`drive busy on first mount attempt, waiting 5s and retrying once`);
            await sleep(5000);
            continue;
          }
          throw e;
        }
      }
      if (lastErr) throw lastErr;
      if (!fat) {
        await execOk('/usr/bin/chown', [`${uid}:${gid}`, mp], { timeoutMs: 30_000 });
        reownMarkers(mp, uid, gid, log); // decision 122: drives moved between machines keep verifying
      }
      writeStatus(stateDir, device, 'mounted', `mounted at ${mp}`, mp);
      log(`mounted at ${mp}`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = isDriveBusyError(raw) ? friendlyBusyMessage('mount', raw) : raw;
      writeStatus(stateDir, device, 'failed', msg, null);
      throw e;
    }
  } else {
    if (!found.mounted || !found.mountpoint) {
      writeStatus(stateDir, device, 'unmounted', 'not mounted', null);
      return;
    }
    writeStatus(stateDir, device, 'unmounting', `unmounting ${found.mountpoint}`, found.mountpoint);
    log(`unmounting ${found.mountpoint}`);
    try {
      await execOk('/usr/bin/umount', [found.mountpoint], { timeoutMs: 60_000 });
      writeStatus(stateDir, device, 'unmounted', 'unmounted', null);
      log('unmounted');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = isDriveBusyError(raw) ? friendlyBusyMessage('unmount', raw) : raw;
      writeStatus(stateDir, device, 'failed', msg, found.mountpoint);
      throw e;
    }
  }
}
