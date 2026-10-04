import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopIgnoreRule, friendlyBusyMessage, reownMarkers } from '../../src/bootstrap/device-mount-apply.js';
import { writeBindMarker } from '../../src/storage/bind-marker.js';

describe('drive takeover + portability (decision 122)', () => {
  it('writes a udev rule that stops the desktop automounting this filesystem, and rejects odd UUIDs', () => {
    const r = desktopIgnoreRule('ABCD-1234');
    expect(r?.file).toBe('/etc/udev/rules.d/90-harbor-drive-ABCD-1234.rules');
    expect(r?.content).toContain('ENV{ID_FS_UUID}=="ABCD-1234", ENV{UDISKS_AUTO}="0"');
    expect(desktopIgnoreRule('x"; rm -rf /')).toBeNull();
    expect(desktopIgnoreRule('../etc')).toBeNull();
  });

  it('identity files are world-readable: another machine\'s harbor uid can verify them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-marker-'));
    writeBindMarker(dir, 'inst-1', 'data');
    expect(statSync(path.join(dir, '.harbor-bind.json')).mode & 0o777).toBe(0o644);
  });

  it('re-owns only Harbor identity files, skipping symlinks and sealed app homes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-drive-'));
    mkdirSync(path.join(root, 'photos', 'library'), { recursive: true });
    writeFileSync(path.join(root, 'photos', 'library', '.harbor-bind.json'), '{}', { mode: 0o600 });
    writeFileSync(path.join(root, 'photos', 'holiday.jpg'), 'x', { mode: 0o600 });
    mkdirSync(path.join(root, 'harbor-apps', 'immich'), { recursive: true });
    writeFileSync(path.join(root, 'harbor-apps', 'immich', '.harbor-bind.json'), '{}', { mode: 0o600 });
    symlinkSync(path.join(root, 'photos'), path.join(root, 'loop'));
    const uid = process.getuid!();
    const gid = process.getgid!();
    expect(reownMarkers(root, uid, gid, () => {})).toBe(1);
    expect(statSync(path.join(root, 'photos', 'library', '.harbor-bind.json')).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(root, 'photos', 'holiday.jpg')).mode & 0o777).toBe(0o600); // user data untouched
    expect(statSync(path.join(root, 'harbor-apps', 'immich', '.harbor-bind.json')).mode & 0o777).toBe(0o600);
    chmodSync(path.join(root, 'photos'), 0o755);
  });

  it('a busy takeover says what to close', () => {
    expect(friendlyBusyMessage('takeover', 'umount: target is busy')).toMatch(/files open .* Let Harbor manage it again/);
  });
});
