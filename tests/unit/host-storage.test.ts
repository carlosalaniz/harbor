import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFolder, listBlockDeviceNodes, listFolders, listMounts, parseDevices, parseMounts } from '../../src/system/host-storage.js';

describe('host storage', () => {
  it('parses /proc/mounts down to real disks and hides system and Docker mounts', () => {
    const text = [
      'sysfs /sys sysfs rw 0 0',
      'proc /proc proc rw 0 0',
      '/dev/vda1 / ext4 rw,relatime 0 0',
      '/dev/vda15 /boot/efi vfat rw 0 0',
      'overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0',
      '/dev/sdb1 /mnt/photos ext4 rw 0 0',
      '/dev/sdb1 /mnt/photos ext4 rw 0 0',
      '/dev/vda1 /tmp ext4 rw 0 0',
      '/dev/vda1 /var/lib/harbor ext4 rw 0 0',
      '/dev/vda1 /home/data ext4 rw 0 0',
      '//nas/media /media/nas cifs rw 0 0',
      '/dev/loop3 /snap/core/1 squashfs ro 0 0',
      'tmpfs /run tmpfs rw 0 0',
      '/dev/sdc1 /mnt/with\\040space exfat rw 0 0',
    ].join('\n');
    expect(parseMounts(text)).toEqual([
      { device: '/dev/vda1', mountpoint: '/', fsType: 'ext4' },
      { device: '//nas/media', mountpoint: '/media/nas', fsType: 'cifs' },
      { device: '/dev/sdb1', mountpoint: '/mnt/photos', fsType: 'ext4' },
      { device: '/dev/sdc1', mountpoint: '/mnt/with space', fsType: 'exfat' },
    ]);
  });

  it('parses lsblk JSON down to removable partitions, mounted or not', () => {
    const json = JSON.stringify({
      blockdevices: [
        { name: 'sda', size: '931.5G', type: 'disk', rm: false, hotplug: false, children: [{ name: 'sda1', size: '1M', type: 'part', rm: false }] },
        { name: 'sdb', size: '14.4G', type: 'disk', rm: true, hotplug: true, children: [{ name: 'sdb1', size: '14.4G', type: 'part', mountpoint: null, fstype: 'vfat', label: 'USB20FD', uuid: 'ABCD-1234', rm: true, hotplug: true }] },
        { name: 'sdc', size: '1.9T', type: 'disk', rm: true, hotplug: false, children: [{ name: 'sdc1', size: '1.9T', type: 'part', mountpoint: '/mnt/backup', fstype: 'ext4', label: 'backup', uuid: 'uuid-1', rm: true, hotplug: false }] },
        { name: 'loop0', size: '4K', type: 'loop', mountpoint: '/snap/bare/5' },
        { name: 'nvme1n1', size: '931.5G', type: 'disk', rm: false, children: [{ name: 'nvme1n1p3', size: '926.5G', type: 'part', fstype: 'crypto_LUKS', rm: false }] },
      ],
    });
    expect(parseDevices(json)).toEqual([
      { name: 'sdb1', device: '/dev/sdb1', size: '14.4G', fsType: 'vfat', label: 'USB20FD', uuid: 'ABCD-1234', removable: true, mounted: false, mountpoint: null },
      { name: 'sdc1', device: '/dev/sdc1', size: '1.9T', fsType: 'ext4', label: 'backup', uuid: 'uuid-1', removable: true, mounted: true, mountpoint: '/mnt/backup' },
    ]);
    expect(parseDevices('not json')).toEqual([]);
  });

  it('hides a mounted removable device from the generic disk list (it lives in Removable only)', () => {
    const text = ['/dev/vda1 / ext4 rw 0 0', '/dev/sdb1 /mnt/usb20fd vfat rw 0 0'].join('\n');
    expect(listMounts(text).map((m) => m.mountpoint)).toEqual(['/', '/mnt/usb20fd']);
    expect(listMounts(text, new Set(['/dev/sdb1'])).map((m) => m.mountpoint)).toEqual(['/']);
  });

  it('lists every /dev node so a yanked drive with a stale mount row can be spotted', () => {
    const json = JSON.stringify({ blockdevices: [{ name: 'sda', children: [{ name: 'sda1' }] }, { name: 'sdb', children: [{ name: 'sdb1' }] }] });
    expect(listBlockDeviceNodes(() => json)).toEqual(new Set(['/dev/sda', '/dev/sda1', '/dev/sdb', '/dev/sdb1']));
    expect(listBlockDeviceNodes(() => 'not json')).toBeNull();
  });

  it('lists only directories, hides dot folders and system locations, creates one named folder', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-hs-'));
    mkdirSync(path.join(root, 'Music'));
    mkdirSync(path.join(root, '.cache'));
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    const l = listFolders(root);
    expect(l.entries.map((e) => e.name)).toEqual(['Music']);
    expect(l.writable).toBe(true);
    expect(l.parent).toBe(path.dirname(root));
    const created = createFolder(root, 'Photos 2026');
    expect(created.path).toBe(path.join(root, 'Photos 2026'));
    expect(listFolders(root).entries.map((e) => e.name)).toEqual(['Music', 'Photos 2026']);
    expect(() => createFolder(root, 'Photos 2026')).toThrow(/already exists/);
    expect(() => createFolder(root, 'bad/name')).toThrow(/folder name/);
    expect(() => createFolder(root, ' lead')).toThrow(/folder name/);
    expect(() => createFolder('/etc', 'x')).toThrow(/system location/);
    expect(() => listFolders('/proc')).toThrow(/system location/);
    const top = listFolders('/');
    expect(top.parent).toBeNull();
    expect(top.entries.map((e) => e.name)).not.toContain('etc');
  });
});
