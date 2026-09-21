import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DeviceMountService } from '../../src/system/device-mount.js';
import type { HarborError } from '../../src/errors.js';
import { systemClock } from '../../src/util.js';
import type * as HostStorage from '../../src/system/host-storage.js';

vi.mock('../../src/system/host-storage.js', async (importOriginal) => {
  const orig = await importOriginal<typeof HostStorage>();
  return {
    ...orig,
    listDevices: () => [
      { name: 'sdb1', device: '/dev/sdb1', size: '14.4G', fsType: 'vfat', label: 'USB20FD', uuid: 'x', removable: true, mounted: false, mountpoint: null },
      { name: 'sdc1', device: '/dev/sdc1', size: '1.9T', fsType: 'ext4', label: 'backup', uuid: 'y', removable: true, mounted: true, mountpoint: '/mnt/backup' },
    ],
  };
});

function repoWithBinds(paths: string[]) {
  return {
    resourcesByKind: (kind: string) => (kind === 'bind' ? paths.map((p, i) => ({ name: p, instanceId: `inst-${i}` })) : []),
    instance: (id: string) => ({ name: `app-${id}` }),
  } as never;
}

describe('device mount service', () => {
  it('starts the root oneshot for an unmounted removable drive', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const starter = vi.fn(async () => {});
    const svc = new DeviceMountService(repoWithBinds([]), systemClock, dir, starter);
    const st = await svc.mount('sdb1', 'admin');
    expect(st.state).toBe('requested');
    expect(starter).toHaveBeenCalledWith('harbor-device-mount@sdb1:mount.service');
  });
  it('refuses to unmount a drive an app uses, naming the app', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const svc = new DeviceMountService(repoWithBinds(['/mnt/backup/photos']), systemClock, dir, async () => {});
    await expect(svc.unmount('sdc1', 'admin')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    try {
      await svc.unmount('sdc1', 'admin');
    } catch (e) {
      expect((e as HarborError).message).toContain('/mnt/backup');
    }
  });
  it('refuses without systemd, printing the exact root command', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const svc = new DeviceMountService(repoWithBinds([]), systemClock, dir, null);
    await expect(svc.mount('sdb1', 'admin')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    try {
      await svc.mount('sdb1', 'admin');
    } catch (e) {
      expect((e as HarborError).nextAction).toContain('sudo /opt/harbor/bin/harbor device-mount sdb1:mount');
    }
  });
  it('starts the root oneshot to format a removable drive as ext4', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const starter = vi.fn(async () => {});
    const svc = new DeviceMountService(repoWithBinds([]), systemClock, dir, starter);
    const st = await svc.format('sdb1', 'admin');
    expect(st.state).toBe('requested');
    expect(starter).toHaveBeenCalledWith('harbor-device-mount@sdb1:format.service');
  });
  it('refuses to format a drive an app uses, naming the app', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const svc = new DeviceMountService(repoWithBinds(['/mnt/backup/photos']), systemClock, dir, async () => {});
    await expect(svc.format('sdc1', 'admin')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    try {
      await svc.format('sdc1', 'admin');
    } catch (e) {
      expect((e as HarborError).message).toContain('/mnt/backup');
    }
  });
  it('refuses to format the system disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const svc = new DeviceMountService(repoWithBinds([]), systemClock, dir, async () => {});
    await expect(svc.format('sda1', 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('format refuses without systemd, printing the exact root command', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-dev-'));
    const svc = new DeviceMountService(repoWithBinds([]), systemClock, dir, null);
    await expect(svc.format('sdb1', 'admin')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    try {
      await svc.format('sdb1', 'admin');
    } catch (e) {
      expect((e as HarborError).nextAction).toContain('sudo /opt/harbor/bin/harbor device-format sdb1');
    }
  });
});
