import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { normalizeHostPath } from '../storage/host-path.js';

// Host storage for humans: which disks exist, what folders are there, and (inside a writable parent)
// creating a new folder. Used by the console's folder picker. Everything is read-only except
// createFolder, which only ever creates one directory the operator asked for by name.

export interface MountInfo {
  mountpoint: string;
  device: string;
  fsType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  writable: boolean; // by the Harbor service account
  label: string; // plain-words name for the console
}

export interface FolderEntry {
  name: string;
  path: string;
  writable: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  writable: boolean;
  entries: FolderEntry[];
}

const REAL_FS = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs', 'smb3', 'apfs', 'hfs']);
// hidden: boot/snap/docker internals, and the paths systemd hardening bind-mounts into the service's namespace
const HIDDEN_PREFIXES = ['/boot', '/snap', '/var/lib/docker', '/var/snap', '/run', '/dev', '/proc', '/sys', '/System', '/private', '/tmp', '/var/tmp', '/var/lib/harbor', '/etc/harbor', '/opt/harbor'];

export function parseMounts(procMountsText: string): { mountpoint: string; device: string; fsType: string }[] {
  const out: { mountpoint: string; device: string; fsType: string }[] = [];
  for (const line of procMountsText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [device, rawMount, fsType] = parts as [string, string, string];
    // /proc/mounts escapes spaces as \040
    const mountpoint = rawMount.replace(/\\040/g, ' ');
    if (!REAL_FS.has(fsType)) continue;
    if (HIDDEN_PREFIXES.some((p) => mountpoint === p || mountpoint.startsWith(p + '/'))) continue;
    out.push({ device, mountpoint, fsType });
  }
  // dedupe: the same device mounted at several places (bind mounts, systemd namespaces) is one disk;
  // keep the shortest mountpoint. Network shares are keyed by device too.
  const byDevice = new Map<string, { mountpoint: string; device: string; fsType: string }>();
  for (const m of out) {
    const key = `${m.device}|${m.fsType}`;
    const prev = byDevice.get(key);
    if (!prev || m.mountpoint.length < prev.mountpoint.length) byDevice.set(key, m);
  }
  return [...byDevice.values()].sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}

function isWritable(p: string): boolean {
  try {
    accessSync(p, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function usage(p: string): { totalBytes: number | null; usedBytes: number | null } {
  try {
    const st = statfsSync(p);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return { totalBytes: total, usedBytes: total - free };
  } catch {
    return { totalBytes: null, usedBytes: null };
  }
}

function labelFor(mountpoint: string, device: string): string {
  if (mountpoint === '/') return 'System disk';
  const base = path.posix.basename(mountpoint);
  if (/^\/media\/|^\/mnt\//.test(mountpoint)) return `Drive "${base}"`;
  if (device.startsWith('//') || device.includes(':/')) return `Network share "${base}"`;
  return base || mountpoint;
}

export interface DeviceInfo {
  name: string; // kernel name, e.g. sdb1
  device: string; // /dev/sdb1
  size: string; // human size from lsblk, e.g. 14.4G
  fsType: string | null;
  label: string | null;
  uuid: string | null;
  removable: boolean;
  mounted: boolean;
  mountpoint: string | null;
}

interface LsblkDevice {
  name?: string;
  size?: string;
  type?: string;
  mountpoint?: string | null;
  fstype?: string | null;
  label?: string | null;
  uuid?: string | null;
  rm?: boolean;
  hotplug?: boolean;
  children?: LsblkDevice[];
}

// Removable block devices (USB sticks, external drives), mounted or not. Partitions
// only: the whole-disk node is skipped when it has children. Internal disks are
// excluded unless hotpluggable. Never throws: an empty list means "no devices seen".
export function parseDevices(lsblkJson: string): DeviceInfo[] {
  let root: { blockdevices?: LsblkDevice[] };
  try {
    root = JSON.parse(lsblkJson) as { blockdevices?: LsblkDevice[] };
  } catch {
    return [];
  }
  const out: DeviceInfo[] = [];
  const walk = (devs: LsblkDevice[] | undefined) => {
    for (const b of devs ?? []) {
      const kids = b.children ?? [];
      const isPart = b.type === 'part';
      const wholeWithParts = b.type === 'disk' && kids.length > 0;
      if ((isPart || !wholeWithParts) && b.type !== 'loop' && b.type !== 'rom') {
        const removable = Boolean(b.rm || b.hotplug);
        // Internal partitions are not removable media; whole disks without
        // partitions (e.g. a freshly inserted stick) are included when removable.
        if (removable || (b.type === 'disk' && kids.length === 0)) {
          const mp = typeof b.mountpoint === 'string' && b.mountpoint.length ? b.mountpoint : null;
          out.push({
            name: b.name ?? '?',
            device: `/dev/${b.name ?? '?'}`,
            size: b.size ?? '?',
            fsType: b.fstype ?? null,
            label: b.label ?? null,
            uuid: b.uuid ?? null,
            removable,
            mounted: mp !== null,
            mountpoint: mp,
          });
        }
      }
      walk(kids);
    }
  };
  walk(root.blockdevices);
  return out.sort((a, b) => a.device.localeCompare(b.device));
}

export function listDevices(run: (args: string[]) => string = defaultLsblk, fixtureJson?: string): DeviceInfo[] {
  try {
    // E2E/dev fixture: HARBOR_DEVICES_JSON injects a fake lsblk document so the
    // removable UI (Mount spinner, Eject, insert/remove poll) can be clicked
    // on machines with no removable hardware (macOS, CI). A simulated mount
    // overlays the fixture: after the fake oneshot completes, the device
    // reports mounted at /mnt/<name> (mirrors DeviceMountService.simulateRoot).
    const doc = fixtureJson ?? process.env['HARBOR_DEVICES_JSON'];
    if (doc) {
      const devices = parseDevices(doc);
      return devices.map((d) => {
        const st = readSimulatedMountState(d.name);
        if (st === 'mounted') return { ...d, mounted: true, mountpoint: `/mnt/${d.name}` };
        return d;
      });
    }
    return parseDevices(run(['--json', '-o', 'NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,LABEL,UUID,RM,HOTPLUG']));
  } catch {
    return [];
  }
}

// Reads the simulated mount state written by DeviceMountService in fixture
// mode (<stateDir>/devices/<name>/mount-status.json is per-daemon; the env
// pointer below tells listDevices which state dir to consult).
function readSimulatedMountState(name: string): 'mounted' | 'unmounted' | null {
  try {
    const stateDir = process.env['HARBOR_DEVICES_STATE_DIR'];
    if (!stateDir || !/^[a-z]+[0-9]+$/.test(name)) return null;
    const file = path.join(stateDir, 'devices', name, 'mount-status.json');
    if (!existsSync(file)) return null;
    const st = JSON.parse(readFileSync(file, 'utf8')) as { state?: string };
    if (st.state === 'mounted') return 'mounted';
    if (st.state === 'unmounted') return 'unmounted';
    return null;
  } catch {
    return null;
  }
}

function defaultLsblk(args: string[]): string {
  return execFileSync('lsblk', args, { encoding: 'utf8', timeout: 10_000 });
}

// Mount-point suggestion for a removable device: /mnt/<label-or-name>, sanitized.
export function suggestedMountpoint(d: Pick<DeviceInfo, 'name' | 'label'>): string {
  const raw = (d.label ?? d.name).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || d.name;
  return `/mnt/${raw}`;
}

export function listMounts(procMountsText = safeRead('/proc/self/mounts'), excludeDevices: Set<string> = new Set()): MountInfo[] {
  return parseMounts(procMountsText)
    .filter((m) => !excludeDevices.has(m.device))
    .map((m) => ({ ...m, ...usage(m.mountpoint), writable: isWritable(m.mountpoint), label: labelFor(m.mountpoint, m.device) }));
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// Lists subdirectories of `dir`. The root is allowed for navigation (its children are filtered by the
// same denylist that governs what may be mounted), everything else must be a permitted host path.
export function listFolders(dir: string): FolderListing {
  const p = dir === '/' ? '/' : normalizeHostPath(dir);
  let names: string[];
  try {
    names = readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    throw new HarborError('INVALID_REQUEST', `cannot read folder ${p}`, { nextAction: 'Check that it exists and that the Harbor service account may read it.' });
  }
  const entries: FolderEntry[] = [];
  for (const name of names) {
    const child = path.posix.join(p, name);
    try {
      normalizeHostPath(child); // hides system locations at the root level
    } catch {
      continue;
    }
    entries.push({ name, path: child, writable: isWritable(child) });
  }
  return { path: p, parent: p === '/' ? null : path.posix.dirname(p), writable: p !== '/' && isWritable(p), entries };
}

// Creates exactly one new directory inside a parent the Harbor service account may write to.
export function createFolder(parent: string, name: string): FolderEntry {
  const base = normalizeHostPath(parent);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name) || name.trim() !== name) throw new HarborError('INVALID_REQUEST', 'folder name may use letters, digits, spaces, dots, dashes and underscores (max 64 chars)');
  let st;
  try {
    st = statSync(base);
  } catch {
    throw new HarborError('INVALID_REQUEST', `parent folder ${base} does not exist`);
  }
  if (!st.isDirectory()) throw new HarborError('INVALID_REQUEST', `${base} is not a folder`);
  if (!isWritable(base)) throw new HarborError('INVALID_REQUEST', `Harbor may not create folders in ${base}`, { nextAction: 'Pick a folder under Harbor\'s data folder or one owned by the harbor account, or create it yourself as root.' });
  const full = path.posix.join(base, name);
  try {
    mkdirSync(full, { mode: 0o775 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new HarborError('NAME_CONFLICT', `${full} already exists`);
    throw new HarborError('OPERATION_FAILED', `cannot create ${full}: ${code ?? String(e)}`);
  }
  return { name, path: full, writable: true };
}
