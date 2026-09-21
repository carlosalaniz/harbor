import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarborError } from '../../src/errors.js';
import { addAppHomeManifests, collectRecoveryFiles, openRecoveryBundle, restoreRecoveryFiles, sealRecoveryBundle } from '../../src/storage/recovery-bundle.js';
import { tempDir } from './helpers.js';

function makeState(): string {
  const dir = tempDir('harbor-recovery-');
  writeFileSync(path.join(dir, 'harbor.db'), Buffer.from('fake-sqlite-bytes'));
  const inst = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  mkdirSync(path.join(dir, 'instances', inst, 'secrets'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(dir, 'instances', inst, 'release'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'instances', inst, 'secrets', 'basic-auth'), 's3cret', { mode: 0o600 });
  writeFileSync(path.join(dir, 'instances', inst, 'release', 'compose.yaml'), 'services: {}', { mode: 0o600 });
  mkdirSync(path.join(dir, 'packages'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'packages', 'index.json'), '{}', { mode: 0o600 });
  return dir;
}

describe('recovery bundle', () => {
  it('round-trips state through a passphrase-wrapped file', async () => {
    const stateDir = makeState();
    const files = collectRecoveryFiles(stateDir);
    expect(files.has('harbor.db')).toBe(true);
    expect(files.has('instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/secrets/basic-auth')).toBe(true);
    expect(files.has('instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/release/compose.yaml')).toBe(true);
    addAppHomeManifests(files, [{ home: '/mnt/photos/harbor-apps/immich/immich', manifest: Buffer.from('{"instanceId":"x"}') }]);
    const bundle = await sealRecoveryBundle(files, 'correct horse recovery');
    // The sealed file leaks no plaintext.
    expect(bundle.includes(Buffer.from('fake-sqlite-bytes'))).toBe(false);
    expect(bundle.includes(Buffer.from('s3cret'))).toBe(false);
    const opened = await openRecoveryBundle(bundle, 'correct horse recovery');
    expect(opened.get('harbor.db')?.toString()).toBe('fake-sqlite-bytes');
    const fresh = tempDir('harbor-recovery-fresh-');
    const r = restoreRecoveryFiles(path.join(fresh, 'state'), opened);
    expect(r).toEqual({ instances: 1, secrets: 1, appHomes: 1 });
  });

  it('rejects the wrong passphrase and refuses to overwrite state', async () => {
    const files = collectRecoveryFiles(makeState());
    const bundle = await sealRecoveryBundle(files, 'correct horse recovery');
    await expect(openRecoveryBundle(bundle, 'wrong passphrase here')).rejects.toThrowError(/wrong recovery passphrase/);
    await expect(openRecoveryBundle(Buffer.from('not a zip at all....................'), 'correct horse recovery')).rejects.toThrowError(/not a Harbor recovery file/);
    const opened = await openRecoveryBundle(bundle, 'correct horse recovery');
    const occupied = makeState(); // already has harbor.db
    expect(() => restoreRecoveryFiles(occupied, opened)).toThrowError(HarborError);
    try {
      restoreRecoveryFiles(occupied, opened);
    } catch (e) {
      expect((e as HarborError).code).toBe('INVALID_STATE');
    }
  });

  it('refuses a short recovery passphrase', async () => {
    await expect(sealRecoveryBundle(new Map([['harbor.db', Buffer.from('x')]]), 'short')).rejects.toThrowError(/at least 8 characters/);
  });
});
