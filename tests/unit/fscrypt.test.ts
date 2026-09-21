import { describe, expect, it } from 'vitest';
import { fscryptEncryptArgs, fscryptLockArgs, fscryptSetupArgs, fscryptUnlockArgs, parseFscryptDirStatus, parseFscryptStatus, protectorNameFor, sealedDir } from '../../src/storage/fscrypt.js';
import { FakeCryptoProvider } from '../../src/storage/crypto-provider.js';

describe('fscrypt command builders (pure, no spawn)', () => {
  it('setup targets the mountpoint with quiet all-users flags', () => {
    const s = fscryptSetupArgs('/mnt/photos');
    expect(s.file).toBe('/usr/bin/fscrypt');
    expect(s.args).toEqual(['setup', '/mnt/photos', '--quiet', '--all-users']);
  });

  it('encrypt uses raw_key with a key file (never inline)', () => {
    const s = fscryptEncryptArgs({ dir: '/mnt/photos/harbor-apps/immich/volumes', protectorName: 'harbor-immich-abc12345' }, '/root/.harbor-fscrypt-KEY.key');
    expect(s.args).toContain('--source=raw_key');
    expect(s.args).toContain('--name=harbor-immich-abc12345');
    expect(s.args.some((a) => a.startsWith('--key=/root/'))).toBe(true);
    // The raw key itself is never in argv.
    expect(s.args.join(' ')).not.toContain('aabbcc');
  });

  it('unlock and lock target the sealed dir', () => {
    expect(fscryptUnlockArgs('/x/volumes', '/k').args).toEqual(['unlock', '/x/volumes', '--quiet', '--key=/k']);
    expect(fscryptLockArgs('/x/volumes').args).toEqual(['lock', '/x/volumes', '--quiet']);
  });

  it('sealedDir is always <home>/volumes; protector names are stable slugs', () => {
    expect(sealedDir('/mnt/x/harbor-apps/immich/')).toBe('/mnt/x/harbor-apps/immich/volumes');
    expect(protectorNameFor('My Photos!', '11111111-1111-4111-8111-111111111111')).toBe('harbor-my-photos-11111111');
  });

  it('parses fscrypt status conservatively (unparseable = not ready)', () => {
    expect(parseFscryptStatus('/mnt/x', 'garbage output').supported).toBe(false);
    const dir = parseFscryptDirStatus('"/mnt/x" is encrypted with fscrypt.\nUnlocked: Yes\npolicy_version:2');
    expect(dir).toEqual({ encrypted: true, unlocked: true, policyVersion: '2' });
    const locked = parseFscryptDirStatus('"/mnt/x" is encrypted with fscrypt.\nUnlocked: No');
    expect(locked).toEqual({ encrypted: true, unlocked: false, policyVersion: null });
  });
});

describe('fake crypto provider (tests/dev seam)', () => {
  it('records calls and seals nothing', async () => {
    const f = new FakeCryptoProvider();
    const r = await f.sealApp('/mnt/x/app', 'ab'.repeat(32), 'harbor-app-12345678');
    expect(r.sealed).toBe(false);
    expect(f.calls.map((c) => c.op)).toEqual(['sealApp']);
    const st = await f.statusApp('/mnt/x/app');
    expect(st).toEqual({ encrypted: false, unlocked: true });
  });

  it('failWith simulates a host without fscrypt', async () => {
    const f = new FakeCryptoProvider();
    f.failWith = 'fscrypt not installed';
    const r = await f.sealApp('/mnt/x/app', 'ab'.repeat(32), 'p');
    expect(r).toEqual({ sealed: false, message: 'fscrypt not installed' });
  });
});
