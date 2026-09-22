import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newInstallationRecoveryKey, openInstallationRecovery, sealInstallationRecovery, type StoredInstallationRecovery } from '../../src/storage/installation-recovery.js';
import { RECOVERY_WORDS } from '../../src/storage/recovery-words.js';

const machineKey = () => randomBytes(32);
const NOW = new Date('2026-09-22T04:05:06.789Z');

describe('the Harbor recovery key (one card per installation)', () => {
  it('is 12 words from the standard list, and never the same twice', () => {
    const a = newInstallationRecoveryKey();
    const words = a.split(' ');
    expect(words).toHaveLength(12);
    for (const w of words) expect(RECOVERY_WORDS).toContain(w);
    expect(newInstallationRecoveryKey()).not.toBe(a);
  });

  it('round-trips through the machine key and keeps the words out of the stored blob', () => {
    const key = machineKey();
    const words = newInstallationRecoveryKey();
    const stored = sealInstallationRecovery(words, key, NOW);
    expect(stored.createdAt).toBe('2026-09-22T04:05:06Z');
    expect(JSON.stringify(stored)).not.toContain(words);
    for (const w of words.split(' ')) expect(JSON.stringify(stored)).not.toContain(`"${w}"`);
    expect(openInstallationRecovery(stored, key)).toBe(words);
  });

  it('stays shut for a different machine key, a damaged blob or nothing at all', () => {
    const words = newInstallationRecoveryKey();
    const stored = sealInstallationRecovery(words, machineKey(), NOW);
    // Another installation's key: unreadable, and never a throw — the caller
    // degrades to per-app secrets rather than failing an install over a card.
    expect(openInstallationRecovery(stored, machineKey())).toBeNull();
    expect(openInstallationRecovery({ ...stored, wrapped: { ...stored.wrapped, tag: 'ff'.repeat(16) } }, machineKey())).toBeNull();
    expect(openInstallationRecovery(null, machineKey())).toBeNull();
    expect(openInstallationRecovery(undefined, machineKey())).toBeNull();
    expect(openInstallationRecovery({ format: 2 } as unknown as StoredInstallationRecovery, machineKey())).toBeNull();
  });

  it('refuses to seal anything that is not a 12-word card', () => {
    const key = machineKey();
    for (const bad of ['', 'too few words', new Array(13).fill('abandon').join(' ')]) {
      expect(() => sealInstallationRecovery(bad, key, NOW)).toThrowError(/must be 12 words/);
    }
  });
});
