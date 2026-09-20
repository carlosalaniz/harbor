import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDriveId, verifyBindMarker, writeBindMarker } from '../../src/storage/bind-marker.js';

describe('bind marker', () => {
  it('round-trips for the owning app; refuses a different drive at the same path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    const driveId = writeBindMarker(dir, 'inst-1', 'library');
    expect(typeof driveId).toBe('string');
    expect(() => verifyBindMarker(dir, 'inst-1', 'library', driveId)).not.toThrow();
    expect(() => verifyBindMarker(dir, 'inst-2', 'library')).toThrowError(/different app/);
    expect(() => verifyBindMarker(dir, 'inst-1', 'other')).toThrowError(/different app/);
    expect(() => verifyBindMarker(dir, 'inst-1', 'library', 'some-other-drive')).toThrowError(/not the drive/);
  });
  it('a restore keeps its identity; a replacement gets a new one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    const first = writeBindMarker(dir, 'inst-1', 'library');
    // restoring the same folder (marker included) keeps the drive id
    expect(writeBindMarker(dir, 'inst-1', 'library')).toBe(first);
    expect(readDriveId(dir, 'inst-1', 'library')).toBe(first);
    // a replacement drive (empty folder) gets a fresh identity
    const other = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    const second = writeBindMarker(other, 'inst-1', 'library');
    expect(second).not.toBe(first);
    expect(() => verifyBindMarker(other, 'inst-1', 'library', first)).toThrowError(/not the drive/);
  });
  it('a missing or foreign marker refuses; a legacy marker verifies by app', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    mkdirSync(path.join(dir, 'sub'));
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).toThrowError(/no Harbor identity/);
    writeFileSync(path.join(dir, '.harbor-bind.json'), 'not json');
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).toThrowError(/no Harbor identity/);
    // legacy marker (no drive id, written before the drive guard): the right
    // folder verifies; a recorded id backfills on the next read.
    writeFileSync(path.join(dir, '.harbor-bind.json'), JSON.stringify({ instanceId: 'inst-1', storageId: 'library' }));
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).not.toThrow();
    expect(() => verifyBindMarker(dir, 'inst-1', 'library', 'recorded-id')).not.toThrow();
    expect(writeBindMarker(dir, 'inst-1', 'library')).toMatch(/^[0-9a-f-]{36}$/);
    const stamped = readDriveId(dir, 'inst-1', 'library')!;
    expect(() => verifyBindMarker(dir, 'inst-1', 'library', stamped)).not.toThrow();
    expect(() => verifyBindMarker(dir, 'inst-1', 'library', 'some-other-drive')).toThrowError(/not the drive/);
  });
});
