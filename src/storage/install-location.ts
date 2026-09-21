// Install locations: which existing folders may hold whole encrypted apps.
// A candidate is a mount (or the Harbor data folder) that is writable and on a
// POSIX filesystem. exFAT/NTFS/vfat/fuseblk are refused with a reason: a
// database on a non-POSIX filesystem is corruption, not portability.
//
// Layout (decision 97): every app home nests as
//   <candidate>/<packageId>/<instanceName>/{manifest.json, vault/}
// so one drive holds many apps without name collisions across packages. The
// candidate dir itself (<mount>/harbor-apps) is Harbor-owned infrastructure;
// the package dir is created on demand alongside it.
import path from 'node:path';
import { normalizeHostPath } from './host-path.js';
import type { InstallCandidateDto } from '../contracts/api.js';

export const APP_HOME_DIR_NAME = 'harbor-apps';

// Filesystems whose semantics Harbor trusts for app homes (permissions,
// fsync durability, case sensitivity). Everything else is shown but refused.
const ELIGIBLE_FS = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs', 'apfs', 'hfs']);

export interface CandidateMount {
  mountpoint: string;
  device: string;
  fsType: string;
  totalBytes: number | null;
  usedBytes: number | null;
  writable: boolean;
  label: string;
}

export function installCandidates(mounts: CandidateMount[], dataFolder: { path: string; exists: boolean; writable: boolean }): InstallCandidateDto[] {
  const out: InstallCandidateDto[] = [];
  const seen = new Set<string>();
  const push = (dir: string, label: string, fsType: string, totalBytes: number | null, usedBytes: number | null, writable: boolean) => {
    const norm = normalizeHostPath(dir);
    if (seen.has(norm)) return;
    seen.add(norm);
    const eligibleFs = ELIGIBLE_FS.has(fsType.toLowerCase());
    const eligible = writable && eligibleFs;
    out.push({
      dir: norm,
      label,
      fsType,
      totalBytes,
      usedBytes,
      writable,
      eligible,
      reason: eligible ? null : !writable ? 'Harbor cannot write here' : `the ${fsType} filesystem cannot hold apps (needs ext4, btrfs, xfs, zfs or apfs)`,
    });
  };
  for (const m of mounts) {
    // The system disk (mountpoint /) is never an encrypted-home candidate:
    // system-disk apps live either as managed volumes (the wizard's default
    // "System disk" choice, no passphrase) or encrypted in the Harbor data
    // folder (<dataDir>/harbor-apps below). Emitting /harbor-apps as well
    // only confuses — it is unwritable for the harbor user and pollutes /.
    if (m.mountpoint === '/') continue;
    push(path.posix.join(m.mountpoint, APP_HOME_DIR_NAME), `${m.label} (${m.mountpoint}/${APP_HOME_DIR_NAME})`, m.fsType, m.totalBytes, m.usedBytes, m.writable);
  }
  if (dataFolder.exists && dataFolder.writable) {
    // The Harbor data folder lives on the system disk Harbor itself runs on:
    // trust it when writable even though its filesystem is not probed here
    // (the mount table may not cover it, e.g. macOS dev or a bind mount).
    const dir = path.posix.join(dataFolder.path, APP_HOME_DIR_NAME);
    const norm = normalizeHostPath(dir);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push({ dir: norm, label: `Harbor data folder (${dataFolder.path}/${APP_HOME_DIR_NAME})`, fsType: 'unknown', totalBytes: null, usedBytes: null, writable: true, eligible: true, reason: null });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

// Validate an install-location dir at plan time: it must be one of the
// candidates (or a subfolder of one — the operator may nest), on an eligible
// filesystem, writable, and not overlapping another app's folders or homes.
// Nested layout (decision 97): the dir must be exactly
// <candidate>/<packageId> — the package dir that will hold this app's home.
// The home itself (<dir>/<instanceName>/{manifest.json, vault/}) is created
// at apply time, so the instance name is not part of the dir (the wizard
// cannot know the unique -2 suffix before planning).
export function checkInstallLocation(dir: string, candidates: InstallCandidateDto[], packageId?: string, _instanceName?: string): string {
  const norm = normalizeHostPath(dir);
  const parent = candidates.find((c) => norm === c.dir || norm.startsWith(c.dir + '/'));
  if (!parent) throw new Error(`no install candidate covers ${norm}`);
  if (!parent.eligible) throw new Error(parent.reason ?? `${parent.dir} cannot hold apps`);
  if (packageId !== undefined) {
    const expected = `${parent.dir}/${packageId}`;
    if (norm !== expected) throw new Error(`install location must be ${expected}`);
  }
  return norm;
}
