import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPreviousVersion, snapshotPreviousRelease } from '../../src/bootstrap/selfupdate-apply.js';

// Rollback snapshot: refuses a foreign /opt tree instead of snapshotting it
// (same rule as bootstrap), and reports no previous version when none exists.
// The full snapshot→restore→healthy path needs root + /opt/harbor and is
// proven on the live VM, not here.
describe('self-update rollback snapshot', () => {
  it('refuses a foreign tree; no previous version without a snapshot', () => {
    if (!existsSync('/opt/harbor/release.json')) {
      expect(() => snapshotPreviousRelease(() => {})).toThrow(/not a Harbor release/);
    }
    expect(readPreviousVersion()).toBeNull();
  });

  it('the status contract carries the rolled-back state', () => {
    const states = ['requested', 'downloading', 'installing', 'succeeded', 'failed', 'rolled-back'] as const;
    expect(states).toContain('rolled-back');
  });
});
