import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkInstallLocation, defaultInstallLocation, installCandidates } from '../../src/storage/install-location.js';

// Pure candidate logic: which folders may hold whole encrypted apps.
describe('install candidates', () => {
  const mounts = (list: { mountpoint: string; fsType: string; writable?: boolean; label?: string }[]) =>
    list.map((m, i) => ({ mountpoint: m.mountpoint, device: `/dev/sd${String.fromCharCode(97 + i)}1`, fsType: m.fsType, totalBytes: 100, usedBytes: 10, writable: m.writable ?? true, label: m.label ?? m.mountpoint }));

  it('offers every mounted drive (the system disk itself is never an app-home candidate)', () => {
    const out = installCandidates(mounts([{ mountpoint: '/', fsType: 'ext4' }, { mountpoint: '/mnt/photos', fsType: 'ext4', label: 'Photos' }]), { path: path.join(tmpdir(), 'harbor-no-data'), exists: false, writable: false });
    expect(out.map((c) => c.dir)).toEqual(['/mnt/photos/harbor-apps']);
    expect(out.every((c) => c.eligible)).toBe(true);
  });

  it('offers the Harbor data folder as the encrypted system-disk option', () => {
    const data = path.join(tmpdir(), 'harbor-data-candidate');
    mkdirSync(data, { recursive: true });
    const out = installCandidates(mounts([{ mountpoint: '/', fsType: 'ext4' }]), { path: data, exists: true, writable: true });
    expect(out.map((c) => c.dir)).toEqual([path.posix.join(data, 'harbor-apps')]);
    expect(out[0]!.eligible).toBe(true);
    expect(out[0]!.label).toMatch(/Harbor data folder/);
  });

  it('refuses non-POSIX filesystems with a plain-words reason', () => {
    const out = installCandidates(mounts([{ mountpoint: '/', fsType: 'ext4' }, { mountpoint: '/mnt/stick', fsType: 'vfat', label: 'Stick' }]), { path: path.join(tmpdir(), 'harbor-no-data'), exists: false, writable: false });
    const stick = out.find((c) => c.dir === '/mnt/stick/harbor-apps')!;
    expect(stick.eligible).toBe(false);
    expect(stick.reason).toMatch(/vfat/);
  });

  it('refuses read-only mounts', () => {
    const out = installCandidates(mounts([{ mountpoint: '/mnt/ro', fsType: 'ext4', writable: false, label: 'RO' }]), { path: path.join(tmpdir(), 'harbor-no-data'), exists: false, writable: false });
    expect(out[0]!.eligible).toBe(false);
    expect(out[0]!.reason).toMatch(/cannot write/i);
  });

  it('dedupes and sorts', () => {
    const data = path.join(tmpdir(), 'harbor-data-dedupe');
    mkdirSync(data, { recursive: true });
    const out = installCandidates(mounts([{ mountpoint: '/', fsType: 'ext4' }]), { path: data, exists: true, writable: true });
    const dirs = out.map((c) => c.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs).toEqual([...dirs].sort());
  });

  it('nested layout: only <candidate>/<package> validates', () => {
    const out = installCandidates(mounts([{ mountpoint: '/mnt/photos', fsType: 'ext4', label: 'Photos' }]), { path: path.join(tmpdir(), 'harbor-no-data'), exists: false, writable: false });
    expect(checkInstallLocation('/mnt/photos/harbor-apps/immich', out, 'immich', 'immich')).toBe('/mnt/photos/harbor-apps/immich');
    expect(() => checkInstallLocation('/mnt/photos/harbor-apps/immich/immich', out, 'immich', 'immich')).toThrowError(/must be/);
    expect(() => checkInstallLocation('/mnt/photos/harbor-apps/other', out, 'immich', 'immich')).toThrowError(/must be/);
    expect(() => checkInstallLocation('/mnt/photos/harbor-apps', out, 'immich', 'immich')).toThrowError(/must be/);
  });
});

// Decision 130: `harbor install` without --location lands where the console's "Local" does.
describe('default install location', () => {
  it('is <data folder>/harbor-apps/<package> when the data folder is a candidate', () => {
    const data = path.join(tmpdir(), 'harbor-data-default');
    mkdirSync(data, { recursive: true });
    const cands = installCandidates([], { path: data, exists: true, writable: true });
    expect(defaultInstallLocation(data, cands, 'excalidraw')).toBe(`${path.posix.join(data, 'harbor-apps')}/excalidraw`);
  });
  it('is null without an eligible data-folder candidate (never a drive)', () => {
    const cands = installCandidates([{ mountpoint: '/mnt/photos', device: '/dev/sdb1', fsType: 'ext4', totalBytes: 1, usedBytes: 0, writable: true, label: 'Photos' }], { path: '/nonexistent-harbor', exists: false, writable: false });
    expect(defaultInstallLocation('/nonexistent-harbor', cands, 'excalidraw')).toBeNull();
  });
});
