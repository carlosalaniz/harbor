import { describe, expect, it } from 'vitest';
import { classifyDrive, driveKey } from '../../src/system/drive-attention.js';

describe('drive attention (decision 122)', () => {
  const ext4 = (mountpoint: string | null) => ({ mounted: mountpoint !== null, mountpoint, fsType: 'ext4' });

  it('a desktop automount Harbor cannot write is "foreign"; one it can write is fine', () => {
    expect(classifyDrive(ext4('/media/carlos/PHOTOS'), null, false)).toEqual({ mountedBy: 'other', attention: 'foreign' });
    expect(classifyDrive(ext4('/mnt/data'), null, true)).toEqual({ mountedBy: 'other', attention: null }); // e.g. an fstab mount the harbor group may write
  });

  it('a drive Harbor mounted is Harbor\'s, even before it is written to', () => {
    expect(classifyDrive(ext4('/mnt/photos'), { state: 'mounted', mountpoint: '/mnt/photos' }, false)).toEqual({ mountedBy: 'harbor', attention: null });
    expect(classifyDrive(ext4('/mnt/photos'), { state: 'formatted', mountpoint: '/mnt/photos' }, true)).toEqual({ mountedBy: 'harbor', attention: null });
    // Harbor once mounted it at /mnt/photos; now the desktop has it elsewhere
    expect(classifyDrive(ext4('/media/carlos/PHOTOS'), { state: 'mounted', mountpoint: '/mnt/photos' }, false).attention).toBe('foreign');
  });

  it('plugged in but not mounted needs attention, unless ejected in Harbor, busy, or blank', () => {
    expect(classifyDrive(ext4(null), null, false)).toEqual({ mountedBy: null, attention: 'unmounted' });
    expect(classifyDrive(ext4(null), { state: 'unmounted', mountpoint: null }, false).attention).toBeNull();
    expect(classifyDrive(ext4(null), { state: 'mounting', mountpoint: null }, false).attention).toBeNull();
    expect(classifyDrive(ext4(null), { state: 'failed', mountpoint: null }, false).attention).toBe('unmounted');
    expect(classifyDrive({ mounted: false, mountpoint: null, fsType: null }, null, false).attention).toBeNull();
    expect(classifyDrive({ mounted: false, mountpoint: null, fsType: 'vfat' }, null, false).attention).toBeNull(); // Format, not Mount, is its fix
  });

  it('keys by filesystem UUID so a re-plug under another device name keeps a dismissal', () => {
    expect(driveKey({ name: 'sdb1', uuid: 'ABCD-1234' })).toBe(driveKey({ name: 'sdc1', uuid: 'ABCD-1234' }));
    expect(driveKey({ name: 'sdb1', uuid: null })).toBe('dev-sdb1');
  });
});
