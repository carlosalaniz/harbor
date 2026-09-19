import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyBindMarker, writeBindMarker } from '../../src/storage/bind-marker.js';

describe('bind marker', () => {
  it('round-trips for the owning app; refuses a different drive at the same path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    writeBindMarker(dir, 'inst-1', 'library');
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).not.toThrow();
    expect(() => verifyBindMarker(dir, 'inst-2', 'library')).toThrowError(/different app/);
    expect(() => verifyBindMarker(dir, 'inst-1', 'other')).toThrowError(/different app/);
  });
  it('an unmarked folder verifies clean (read-only claims carry no marker)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-bind-'));
    mkdirSync(path.join(dir, 'sub'));
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).not.toThrow();
    writeFileSync(path.join(dir, '.harbor-bind.json'), 'not json');
    expect(() => verifyBindMarker(dir, 'inst-1', 'library')).not.toThrow();
  });
});
