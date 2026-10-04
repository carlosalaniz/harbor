// Removable drives that need the operator (decision 122): mounted by someone else (a desktop's
// /media/<user>/LABEL automount) where Harbor cannot write, or plugged in but not mounted. Pure
// classification; the caller supplies what it observed (Harbor's own mount record, writability).

export type DriveAttention = 'foreign' | 'unmounted' | null;
export type DriveMountedBy = 'harbor' | 'other' | null;

export interface DriveFacts {
  mounted: boolean;
  mountpoint: string | null;
  fsType: string | null;
}

export interface HarborMountRecord {
  // what Harbor's own mount/format oneshot last wrote for this device
  state: string | null;
  mountpoint: string | null;
}

// Filesystems that can hold apps (the same list Settings → Storage offers Mount for).
const APP_FS = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'zfs', 'f2fs']);

// Harbor-side states during which nothing is wrong yet: an operation is still running.
const IN_FLIGHT = new Set(['requested', 'mounting', 'unmounting', 'formatting']);

export function classifyDrive(d: DriveFacts, harbor: HarborMountRecord | null, writable: boolean): { mountedBy: DriveMountedBy; attention: DriveAttention } {
  if (!d.mounted || !d.mountpoint) {
    // A blank drive (no filesystem) is the Format flow's job, not an alert; an eject done in Harbor is
    // intentional; an operation in flight will settle on its own.
    if (!d.fsType) return { mountedBy: null, attention: null };
    // FAT/exFAT/NTFS cannot hold apps: Settings → Storage leads with Format for those, not Mount.
    if (!APP_FS.has(d.fsType.toLowerCase())) return { mountedBy: null, attention: null };
    if (harbor?.state === 'unmounted' || (harbor?.state && IN_FLIGHT.has(harbor.state))) return { mountedBy: null, attention: null };
    return { mountedBy: null, attention: 'unmounted' };
  }
  const mountedBy: DriveMountedBy = harbor?.mountpoint && harbor.mountpoint === d.mountpoint && (harbor.state === 'mounted' || harbor.state === 'formatted') ? 'harbor' : 'other';
  // Mounted elsewhere is fine as long as Harbor can use it (an fstab mount the harbor group may write).
  return { mountedBy, attention: mountedBy === 'other' && !writable ? 'foreign' : null };
}

// Stable across re-plugs (sdb1 today, sdc1 tomorrow): the filesystem UUID when there is one.
export function driveKey(d: { name: string; uuid: string | null }): string {
  return d.uuid ? `uuid-${d.uuid}` : `dev-${d.name}`;
}

export function driveAttentionText(label: string, attention: Exclude<DriveAttention, null>, mountpoint: string | null): { title: string; body: string } {
  return attention === 'foreign'
    ? { title: `${label} is mounted by your desktop`, body: `It is open at ${mountpoint ?? 'another place'}, where Harbor cannot write, so apps cannot use it. Let Harbor manage it (Home or Settings → Storage): Harbor remounts it as its own and your desktop leaves it alone.` }
    : { title: `${label} is plugged in but not mounted`, body: 'Apps cannot use it until it is mounted. Mount it from Home or Settings → Storage.' };
}
