// Decision 122: drives that need the operator. A desktop automount Harbor cannot write ("foreign") and a
// drive plugged in but not mounted surface on GET /v1/host/storage, raise one linked notification after
// a 60 s grace, can be dismissed until the condition changes, and "Let Harbor manage it" takes a foreign
// drive over. Fake hardware: HARBOR_DEVICES_JSON (read when the device service is constructed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostStorageDto, NotificationsDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';

const until = async <T>(fn: () => Promise<T | null | false | undefined>, what: string, ms = 8000): Promise<T> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('drives that need attention', () => {
  let h: Harness;
  const storage = () => h.api.expect<HostStorageDto>(200, 'GET', '/v1/host/storage');
  const dev = async (name: string) => (await storage()).devices.find((d) => d.name === name)!;
  const driveNotes = async () => (await h.api.expect<NotificationsDto>(200, 'GET', '/v1/notifications')).items.filter((n) => n.kind === 'drive-attention');

  beforeAll(async () => {
    process.env['HARBOR_DEVICES_JSON'] = JSON.stringify({
      blockdevices: [
        { name: 'sdb', size: '14.4G', type: 'disk', rm: true, hotplug: true, children: [{ name: 'sdb1', size: '14.4G', type: 'part', mountpoint: null, fstype: 'ext4', label: 'STICK', uuid: 'aaaa-1111', rm: true, hotplug: true }] },
        { name: 'sdc', size: '1T', type: 'disk', rm: true, hotplug: true, children: [{ name: 'sdc1', size: '1T', type: 'part', mountpoint: '/media/someone/PHOTOS', fstype: 'ext4', label: 'PHOTOS', uuid: 'bbbb-2222', rm: true, hotplug: true }] },
      ],
    });
    h = await startHarness();
    process.env['HARBOR_DEVICES_STATE_DIR'] = h.stateDir;
  });
  afterAll(async () => {
    delete process.env['HARBOR_DEVICES_JSON'];
    delete process.env['HARBOR_DEVICES_STATE_DIR'];
    await h.close();
  });

  it('classifies a desktop mount Harbor cannot write as foreign, and an unmounted drive as unmounted', async () => {
    expect(await dev('sdc1')).toMatchObject({ mountedBy: 'other', attention: 'foreign', dismissed: false });
    expect(await dev('sdb1')).toMatchObject({ mountedBy: null, attention: 'unmounted', dismissed: false });
  });

  it('raises one notification per drive only after a 60 s grace, linked to Settings → Storage', async () => {
    await new Promise((r) => setTimeout(r, 1200)); // a couple of observer ticks inside the grace
    expect(await driveNotes()).toEqual([]);
    h.clock.advance(61_000);
    const notes = await until(async () => {
      const n = await driveNotes();
      return n.length === 2 ? n : null;
    }, 'two drive notifications');
    expect(notes.map((n) => n.title).sort()).toEqual(['PHOTOS is mounted by your desktop', 'STICK is plugged in but not mounted']);
    expect(notes.every((n) => n.link === '#/settings/storage' && n.severity === 'warning')).toBe(true);
  });

  it('dismissing hides the card and resolves its notification until the condition changes', async () => {
    const v = await h.api.expect<{ dismissed: boolean }>(200, 'POST', '/v1/host/devices/sdb1/dismiss', {});
    expect(v.dismissed).toBe(true);
    expect(await dev('sdb1')).toMatchObject({ attention: 'unmounted', dismissed: true });
    expect((await driveNotes()).map((n) => n.title)).toEqual(['PHOTOS is mounted by your desktop']);
    await new Promise((r) => setTimeout(r, 1200)); // the observer does not re-raise a dismissed drive
    expect((await driveNotes()).length).toBe(1);
  });

  it('"Let Harbor manage it" takes the foreign drive over; its warning clears', async () => {
    await h.api.expect(202, 'POST', '/v1/host/devices/sdc1/takeover', {});
    const taken = await until(async () => {
      const d = await dev('sdc1');
      return d.mountedBy === 'harbor' ? d : null;
    }, 'takeover to finish');
    expect(taken).toMatchObject({ mounted: true, mountpoint: '/mnt/sdc1', attention: null });
    await until(async () => ((await driveNotes()).length === 0 ? true : null), 'the PHOTOS warning to resolve');
  });

  it('ejecting in Harbor is intentional: no alert; the dismissal re-arms once the condition clears', async () => {
    await h.api.expect(202, 'POST', '/v1/host/devices/sdc1/unmount', {});
    await until(async () => ((await dev('sdc1')).mounted ? null : true), 'eject to finish');
    expect((await dev('sdc1')).attention).toBeNull();
    await h.api.expect(202, 'POST', '/v1/host/devices/sdb1/mount', {});
    await until(async () => ((await dev('sdb1')).mounted ? true : null), 'sdb1 mounted');
    await new Promise((r) => setTimeout(r, 1200));
    const settings = await h.api.expect<HostStorageDto>(200, 'GET', '/v1/host/storage');
    expect(settings.devices.find((d) => d.name === 'sdb1')).toMatchObject({ attention: null, dismissed: false });
  });
});
