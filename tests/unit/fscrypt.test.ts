import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appCryptoFiles,
  appCryptoUnit,
  fscryptEncryptArgs,
  fscryptGlobalSetupArgs,
  fscryptLockArgs,
  fscryptSetupArgs,
  fscryptUnlockArgs,
  hasEncryptFeature,
  isAllowedHomePath,
  isEnokey,
  isValidProtectorName,
  parseAppCryptoSpec,
  parseAppCryptoStatus,
  parseExt4Features,
  parseFindmnt,
  parseFscryptDirStatus,
  parseFscryptFsStatus,
  protectorNameFor,
  sealedDir,
  tune2fsEnableEncryptArgs,
} from '../../src/storage/fscrypt.js';
import { FakeCryptoProvider, probeKernelState, RootCryptoProvider } from '../../src/storage/crypto-provider.js';
import { appCryptoUnit as unitFile, polkitPowerRule } from '../../src/bootstrap/systemd.js';

const ID = '11111111-1111-4111-8111-111111111111';

// Real outputs captured on the test droplet (fscrypt 0.3.4, Ubuntu 24.04, kernel 6.8).
const STATUS_UNLOCKED = `"/srv/harbor/harbor-apps/x/y/volumes" is encrypted with fscrypt.

Policy:   aef573027eb988f5112a6da605f483a7
Options:  padding:32 contents:AES_256_XTS filenames:AES_256_CTS policy_version:2
Unlocked: Yes

Protected with 1 protector:
PROTECTOR         LINKED  DESCRIPTION
672168b907622cac  No      raw key protector "harbor-probe-12345678"
`;
const STATUS_LOCKED = STATUS_UNLOCKED.replace('Unlocked: Yes', 'Unlocked: No');
const STATUS_PARTIAL = STATUS_UNLOCKED.replace('Unlocked: Yes', 'Unlocked: Partially (incompletely locked)');
const STATUS_NOT_ENCRYPTED_STDERR = '[ERROR] fscrypt status: file or directory\n                        "/srv/harbor/x/volumes" is not\n                        encrypted\n';
const FS_STATUS = 'ext4 filesystem "/" has 1 protector and 1 policy.\nAll users can create fscrypt metadata on this filesystem.\n';
const FS_STATUS_EMPTY = 'ext4 filesystem "/mnt/photos" has 0 protectors and 0 policies.\n';
const TUNE2FS = 'tune2fs 1.47.0 (5-Feb-2023)\nFilesystem volume name:   <none>\nFilesystem features:      has_journal ext_attr resize_inode dir_index filetype needs_recovery extent 64bit flex_bg encrypt sparse_super large_file huge_file dir_nlink extra_isize metadata_csum\nDefault mount options:    user_xattr acl\n';

describe('fscrypt command builders (pure, no spawn)', () => {
  it('setup targets the mountpoint with quiet all-users flags; the global setup writes /etc/fscrypt.conf', () => {
    expect(fscryptSetupArgs('/mnt/photos')).toEqual({ file: '/usr/bin/fscrypt', args: ['setup', '/mnt/photos', '--quiet', '--all-users'] });
    expect(fscryptGlobalSetupArgs().args).toEqual(['setup', '--quiet', '--all-users']);
  });

  it('encrypt uses raw_key with a key file (never inline)', () => {
    const s = fscryptEncryptArgs({ dir: '/mnt/photos/harbor-apps/immich/immich/volumes', protectorName: 'harbor-immich-abc12345' }, '/root/.harbor-fscrypt-KEY.key');
    expect(s.args).toContain('--source=raw_key');
    expect(s.args).toContain('--name=harbor-immich-abc12345');
    expect(s.args.some((a) => a.startsWith('--key=/root/'))).toBe(true);
    expect(s.args.join(' ')).not.toContain('aabbcc');
  });

  it('unlock, lock and tune2fs target the right things', () => {
    expect(fscryptUnlockArgs('/x/volumes', '/k').args).toEqual(['unlock', '/x/volumes', '--quiet', '--key=/k']);
    expect(fscryptLockArgs('/x/volumes').args).toEqual(['lock', '/x/volumes', '--quiet']);
    expect(tune2fsEnableEncryptArgs('/dev/vda1')).toEqual({ file: '/usr/sbin/tune2fs', args: ['-O', 'encrypt', '/dev/vda1'] });
  });

  it('sealedDir is always <home>/volumes; protector names are stable slugs', () => {
    expect(sealedDir('/mnt/x/harbor-apps/immich/immich/')).toBe('/mnt/x/harbor-apps/immich/immich/volumes');
    expect(protectorNameFor('My Photos!', ID)).toBe('harbor-my-photos-11111111');
    expect(isValidProtectorName('harbor-my-photos-11111111')).toBe(true);
    expect(isValidProtectorName('-bad')).toBe(false);
    expect(isValidProtectorName('has space')).toBe(false);
  });
});

describe('fscrypt output parsers (real droplet samples)', () => {
  it('reads unlocked, locked and partially locked directory status', () => {
    expect(parseFscryptDirStatus(STATUS_UNLOCKED)).toEqual({ encrypted: true, unlocked: true, partiallyLocked: false, policyVersion: '2', policyId: 'aef573027eb988f5112a6da605f483a7', protectorIds: ['672168b907622cac'] });
    expect(parseFscryptDirStatus(STATUS_LOCKED)).toMatchObject({ encrypted: true, unlocked: false, partiallyLocked: false });
    expect(parseFscryptDirStatus(STATUS_PARTIAL)).toMatchObject({ encrypted: true, unlocked: false, partiallyLocked: true });
    expect(parseFscryptDirStatus('', STATUS_NOT_ENCRYPTED_STDERR)).toMatchObject({ encrypted: false, unlocked: false, policyVersion: null });
  });

  it('reads filesystem metadata state and ext4 features', () => {
    expect(parseFscryptFsStatus(FS_STATUS)).toEqual({ hasMetadata: true, protectors: 1, policies: 1 });
    expect(parseFscryptFsStatus(FS_STATUS_EMPTY)).toEqual({ hasMetadata: true, protectors: 0, policies: 0 });
    expect(parseFscryptFsStatus('', 'filesystem /mnt/x is not setup for use with fscrypt')).toEqual({ hasMetadata: false, protectors: 0, policies: 0 });
    expect(parseExt4Features(TUNE2FS)).toContain('encrypt');
    expect(hasEncryptFeature(TUNE2FS.replace(' encrypt', ''))).toBe(false);
    expect(parseFindmnt('/ /dev/vda1 ext4\n')).toEqual({ mountpoint: '/', source: '/dev/vda1', fsType: 'ext4' });
    expect(parseFindmnt('')).toBeNull();
  });

  it('recognises ENOKEY however Node spells it', () => {
    expect(isEnokey(Object.assign(new Error('Unknown system error -126'), { errno: -126, code: 'Unknown system error -126' }))).toBe(true);
    expect(isEnokey(Object.assign(new Error('x'), { code: 'ENOKEY' }))).toBe(true);
    expect(isEnokey(Object.assign(new Error('mkdir: Required key not available'), {}))).toBe(true);
    expect(isEnokey(Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 }))).toBe(false);
    expect(isEnokey(null)).toBe(false);
  });
});

describe('unit names, handoff files and the home-path allowlist', () => {
  it('binds the root step to one instance and one action', () => {
    expect(appCryptoUnit(ID, 'seal')).toBe(`harbor-app-crypto@${ID}:seal.service`);
    expect(parseAppCryptoSpec(`${ID}:unlock`)).toEqual({ instanceId: ID, action: 'unlock' });
    expect(() => parseAppCryptoSpec(`${ID}:format`)).toThrow(/app-crypto expects/);
    expect(() => parseAppCryptoSpec('not-a-uuid:seal')).toThrow(/app-crypto expects/);
    expect(() => appCryptoUnit('nope', 'seal')).toThrow(/invalid instance id/);
  });

  it('keeps request, FIFO and status under the instance state dir', () => {
    const f = appCryptoFiles('/var/lib/harbor', ID);
    expect(f).toEqual({ dir: `/var/lib/harbor/instances/${ID}/crypto`, request: `/var/lib/harbor/instances/${ID}/crypto/request.json`, fifo: `/var/lib/harbor/instances/${ID}/crypto/key.fifo`, status: `/var/lib/harbor/instances/${ID}/crypto/status.json` });
    expect(parseAppCryptoStatus('{"action":"seal","state":"ok","message":"seal ok","encrypted":true,"unlocked":true,"at":"x"}')).toMatchObject({ state: 'ok', encrypted: true });
    expect(parseAppCryptoStatus('garbage')).toBeNull();
    expect(parseAppCryptoStatus('{"state":"ok"}')).toBeNull();
  });

  it('allows only nested harbor-apps homes under /mnt, /media or the data folder', () => {
    expect(isAllowedHomePath('/mnt/photos/harbor-apps/immich/immich')).toBe(true);
    expect(isAllowedHomePath('/media/usb/harbor-apps/n8n/n8n-2')).toBe(true);
    expect(isAllowedHomePath('/srv/harbor/harbor-apps/excalidraw/excalidraw')).toBe(true);
    expect(isAllowedHomePath('/srv/harbor/harbor-apps/excalidraw')).toBe(false); // package dir, not a home
    expect(isAllowedHomePath('/mnt/photos/immich')).toBe(false);
    expect(isAllowedHomePath('/etc/harbor-apps/x/y')).toBe(false);
    expect(isAllowedHomePath('/mnt/photos/harbor-apps/immich/../etc')).toBe(false);
    expect(isAllowedHomePath('/mnt/photos/harbor-apps/immich/immich/')).toBe(false);
    expect(isAllowedHomePath('/var/lib/harbor/harbor-apps/x/y')).toBe(false);
  });

  it('bootstrap ships the template unit and the polkit rule allows starting it', () => {
    const unit = unitFile();
    expect(unit).toContain('ExecStart=/opt/harbor/bin/harbor app-crypto %i');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('TimeoutStartSec=0');
    expect(polkitPowerRule()).toContain('indexOf("harbor-app-crypto@") === 0');
  });
});

describe('kernel probe (read model without root)', () => {
  it('reads an ordinary directory as open and leaves nothing behind', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'harbor-home-'));
    mkdirSync(path.join(home, 'volumes'));
    expect(probeKernelState(home)).toBe('open');
    expect(rmSync(path.join(home, 'volumes'), { recursive: true })).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it('reads a missing volumes dir as open (the drive guard reports absence, not the seal)', () => {
    expect(probeKernelState('/nonexistent/harbor-apps/x/y')).toBe('open');
  });
});

describe('fake crypto provider (tests/dev seam)', () => {
  const ref = { instanceId: ID, home: '/mnt/x/harbor-apps/app/app' };
  it('seal leaves the home unlocked; lock evicts; unlock restores; a fresh provider reads as locked (reboot)', async () => {
    const f = new FakeCryptoProvider();
    await f.sealApp(ref, 'ab'.repeat(32), 'harbor-app-12345678');
    expect(f.calls.map((c) => c.op)).toEqual(['sealApp']);
    expect(f.kernelState(ref.home)).toBe('open');
    expect(await f.statusApp(ref)).toEqual({ encrypted: true, unlocked: true });
    await f.lockApp(ref);
    expect(f.kernelState(ref.home)).toBe('locked');
    await f.unlockApp(ref, 'ab'.repeat(32));
    expect(f.kernelState(ref.home)).toBe('open');
    expect(new FakeCryptoProvider().kernelState(ref.home)).toBe('locked');
  });

  it('failWith turns every mutation into a hard failure with a next action', async () => {
    const f = new FakeCryptoProvider();
    f.failWith = 'fscrypt not installed';
    await expect(f.sealApp(ref, 'ab'.repeat(32), 'p')).rejects.toMatchObject({ code: 'OPERATION_FAILED', message: 'fscrypt not installed' });
    expect(f.kernelState(ref.home)).toBe('locked');
  });
});

describe('root crypto provider handoff (unit starter stubbed)', () => {
  it('writes the request without the key, streams the key through the FIFO, and reads the verdict back', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'harbor-state-'));
    const files = appCryptoFiles(stateDir, ID);
    const seen: { unit: string; request: string; key: string } = { unit: '', request: '', key: '' };
    const starter = async (unit: string) => {
      const { readFileSync } = await import('node:fs');
      const { execFile } = await import('node:child_process');
      seen.unit = unit;
      seen.request = readFileSync(files.request, 'utf8');
      // The root step reads the FIFO from its own process (`timeout cat`); a
      // blocking read here would stall the event loop the daemon writes from.
      seen.key = (await new Promise<string>((resolve, reject) => execFile('/bin/cat', [files.fifo], (e, out) => (e ? reject(e) : resolve(out))))).trim();
      writeFileSync(files.status, JSON.stringify({ action: 'seal', state: 'ok', message: 'seal ok', encrypted: true, unlocked: true, at: 'now' }));
    };
    const p = new RootCryptoProvider(stateDir, starter);
    await p.sealApp({ instanceId: ID, home: '/mnt/x/harbor-apps/app/app' }, 'ab'.repeat(32), 'harbor-app-11111111');
    expect(seen.unit).toBe(`harbor-app-crypto@${ID}:seal.service`);
    expect(seen.request).not.toContain('ab'.repeat(32));
    expect(JSON.parse(seen.request)).toMatchObject({ action: 'seal', home: '/mnt/x/harbor-apps/app/app', protectorName: 'harbor-app-11111111' });
    expect(seen.key).toBe('ab'.repeat(32));
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('surfaces the root step failure with its next action, and a missing verdict as a hard error', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'harbor-state-'));
    const files = appCryptoFiles(stateDir, ID);
    const failing = async () => {
      writeFileSync(files.status, JSON.stringify({ action: 'lock', state: 'failed', message: 'some files are still open', nextAction: 'Stop the app first.', at: 'now' }));
      throw new Error('Job for harbor-app-crypto failed');
    };
    const p = new RootCryptoProvider(stateDir, failing);
    await expect(p.lockApp({ instanceId: ID, home: '/mnt/x/harbor-apps/app/app' })).rejects.toMatchObject({ code: 'OPERATION_FAILED', message: expect.stringContaining('some files are still open'), nextAction: 'Stop the app first.' });
    const silent = new RootCryptoProvider(stateDir, async () => {
      throw new Error('polkit refused');
    });
    await expect(silent.lockApp({ instanceId: ID, home: '/mnt/x/harbor-apps/app/app' })).rejects.toMatchObject({ code: 'OPERATION_FAILED', message: expect.stringContaining('polkit refused') });
    rmSync(stateDir, { recursive: true, force: true });
  });
});
