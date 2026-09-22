// Kernel sealing for app homes: per-app fscrypt directory encryption on ext4
// with the `encrypt` feature (v2 policies).
//
// Model: every app home's <home>/volumes dir is an fscrypt-encrypted
// directory with ONE policy per app, protected by a raw_key protector whose
// 32-byte key IS the app's master key (the same key the manifest envelopes
// wrap). Unlock = add the key to the filesystem keyring (`fscrypt unlock`
// with the key on a root-only file); locked = ciphertext names + ENOKEY on
// every open/create (BFU). Unlocked = kernel-transparent, Docker sees
// plaintext (v2 policy: keys added by root serve every uid, so containers
// running as any user read fine — v1 would break cross-uid access).
//
// Layout note: fscrypt metadata lives at the FILESYSTEM root
// (<mount>/.fscrypt, 0600 root), not in the home. It travels with a
// removable drive; the data folder's metadata sits at /.fscrypt.
//
// Privilege: setup/encrypt/unlock/lock need root (keyring + policy ioctls),
// and even `fscrypt status` needs root (the policy files are 0600). The
// daemon (harbor user) never runs fscrypt: it starts the polkit-allowed
// `harbor-app-crypto@<instanceId>:<action>` oneshot (same shape as
// mount/format) and the root step runs `harbor app-crypto <spec>`. The
// daemon's own read model is a kernel probe: mkdir inside the sealed dir
// fails with ENOKEY while locked (see crypto-provider.ts).
//
// This module is pure: command builders, output parsers, name/path helpers.
// No spawn, no fs. Callers own execution and key lifetime.
import { HarborError } from '../errors.js';
import { UUID_RE } from '../contracts/patterns.js';
import { PRODUCT } from '../naming.js';

export const FSCRYPT_POLICY_VERSION = '2';
export const FSCRYPT_BIN = '/usr/bin/fscrypt';
export const TUNE2FS_BIN = '/usr/sbin/tune2fs';
export const FINDMNT_BIN = '/usr/bin/findmnt';

// Filesystems whose native encryption Harbor drives (ext4 is what the format
// flow produces; f2fs works the same way).
export const SEALABLE_FS = new Set(['ext4', 'f2fs']);

export type AppCryptoAction = 'setup' | 'seal' | 'unlock' | 'lock' | 'status' | 'migrate';
export const APP_CRYPTO_ACTIONS: readonly AppCryptoAction[] = ['setup', 'seal', 'unlock', 'lock', 'status', 'migrate'];
export const APP_CRYPTO_UNIT_PREFIX = 'harbor-app-crypto@';
export const APP_CRYPTO_UNIT_FILE = 'harbor-app-crypto@.service';

// `harbor-app-crypto@<instanceId>:<action>.service` — the instance id keeps
// the root step bound to ONE recorded app (it re-reads the manifest and
// refuses a mismatch), the action selects the step.
export function appCryptoUnit(instanceId: string, action: AppCryptoAction): string {
  if (!UUID_RE.test(instanceId)) throw new HarborError('INVALID_REQUEST', `invalid instance id ${instanceId}`);
  return `${APP_CRYPTO_UNIT_PREFIX}${instanceId}:${action}.service`;
}

export function parseAppCryptoSpec(spec: string): { instanceId: string; action: AppCryptoAction } {
  const m = /^([0-9a-f-]{36}):([a-z]+)$/.exec(spec);
  if (!m || !UUID_RE.test(m[1]!) || !APP_CRYPTO_ACTIONS.includes(m[2] as AppCryptoAction)) {
    throw new HarborError('INVALID_REQUEST', `app-crypto expects <instanceId>:<${APP_CRYPTO_ACTIONS.join('|')}>, got ${spec}`);
  }
  return { instanceId: m[1]!, action: m[2] as AppCryptoAction };
}

// Where an app home may live for the root step to touch it: removable media
// under /mnt or /media, or the Harbor data folder — always inside a
// harbor-apps tree. Anything else (system dirs, operator folders) is refused
// before a single ioctl.
export function isAllowedHomePath(home: string): boolean {
  if (typeof home !== 'string' || !home.startsWith('/') || home.includes('\0') || home.includes('..') || home.endsWith('/')) return false;
  if (home.split('/').some((seg) => seg === '.' )) return false;
  const roots = ['/mnt/', '/media/', `${PRODUCT.paths.data}/`];
  if (!roots.some((r) => home.startsWith(r))) return false;
  // <root>/harbor-apps/<package>/<instance> (nested layout, decision 97)
  const m = /\/harbor-apps\/([a-z][a-z0-9-]{0,62})\/([^/]+)$/.exec(home);
  return m !== null;
}

// The sealed dir inside every app home. Volumes root here; sealing THIS dir
// (not the home itself) keeps manifest.json readable while locked — the
// console still shows the locked tile without unlocking.
export function sealedDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/volumes`;
}

export function protectorNameFor(instanceName: string, instanceId: string): string {
  const slug = instanceName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'app';
  return `harbor-${slug}-${instanceId.slice(0, 8)}`;
}

export function isValidProtectorName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

// ---------------------------------------------------------------- parsers

// `fscrypt status <dir>` for one directory. Real outputs (fscrypt 0.3.4,
// Ubuntu 24.04):
//   "/x/volumes" is encrypted with fscrypt.
//   Policy:   aef573027eb988f5112a6da605f483a7
//   Options:  padding:32 contents:AES_256_XTS filenames:AES_256_CTS policy_version:2
//   Unlocked: Yes | No | Partially (incompletely locked)
//   Protected with 1 protector:
//   PROTECTOR         LINKED  DESCRIPTION
//   672168b907622cac  No      raw key protector "harbor-probe-12345678"
// Not encrypted (exit 1, stderr): [ERROR] fscrypt status: file or directory "/x" is not encrypted
export interface FscryptDirStatus {
  encrypted: boolean;
  unlocked: boolean;
  // Some files still open when the last lock ran: the key is evicted for new
  // opens but the old handles keep working. Lock again once nothing holds it.
  partiallyLocked: boolean;
  policyVersion: string | null;
  policyId: string | null;
  protectorIds: string[];
}

export function parseFscryptDirStatus(stdout: string, stderr = ''): FscryptDirStatus {
  const text = stdout.toLowerCase();
  const encrypted = /is encrypted with fscrypt/.test(text);
  const unlocked = /unlocked:\s*yes/.test(text);
  const partiallyLocked = /unlocked:\s*partially/.test(text);
  const v = /policy_version:\s*(\d+)/.exec(text);
  const p = /^policy:\s*([0-9a-f]{32})/m.exec(text);
  const protectorIds: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{16})\s+(?:yes|no)\s+/i.exec(line.trim());
    if (m) protectorIds.push(m[1]!.toLowerCase());
  }
  void stderr;
  return { encrypted, unlocked, partiallyLocked, policyVersion: v?.[1] ?? null, policyId: p?.[1] ?? null, protectorIds };
}

// `fscrypt status <mountpoint>`:
//   ext4 filesystem "/" has 1 protector and 1 policy.
//   All users can create fscrypt metadata on this filesystem.
// Without metadata (exit 1): filesystem / is not setup for use with fscrypt
export function parseFscryptFsStatus(stdout: string, stderr = ''): { hasMetadata: boolean; protectors: number; policies: number } {
  const m = /has (\d+) protectors? and (\d+) polic(?:y|ies)/i.exec(stdout);
  if (m) return { hasMetadata: true, protectors: Number(m[1]), policies: Number(m[2]) };
  void stderr;
  return { hasMetadata: false, protectors: 0, policies: 0 };
}

// `tune2fs -l <device>` → "Filesystem features:      has_journal ext_attr ... encrypt ..."
export function parseExt4Features(stdout: string): string[] {
  const m = /^Filesystem features:\s*(.*)$/m.exec(stdout);
  if (!m) return [];
  return m[1]!.trim().split(/\s+/).filter(Boolean);
}

export function hasEncryptFeature(stdout: string): boolean {
  return parseExt4Features(stdout).includes('encrypt');
}

// `findmnt -n -o TARGET,SOURCE,FSTYPE --target <path>` → "/ /dev/vda1 ext4"
export function parseFindmnt(stdout: string): { mountpoint: string; source: string; fsType: string } | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  return { mountpoint: parts[0]!, source: parts[1]!, fsType: parts[2]!.toLowerCase() };
}

// The kernel answers ENOKEY (errno 126) to any open/create inside a locked
// encrypted directory. Node has no symbolic name for it: the error surfaces
// as code 'Unknown system error -126' with errno -126 (verified on Ubuntu
// 24.04 / Node 24). glibc's strerror text is "Required key not available".
export function isEnokey(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errno?: number; code?: string; message?: string };
  return e.errno === -126 || e.code === 'ENOKEY' || /required key not available/i.test(e.message ?? '') || /-126/.test(e.code ?? '');
}

// ---------------------------------------------------------------- argv builders
// No shell: callers spawn these directly. The raw key travels via --key=FILE
// on a root-only temp file (0600, shredded after use), never in argv or logs.
export function fscryptGlobalSetupArgs(): { file: string; args: string[] } {
  // Writes /etc/fscrypt.conf (policy_version 2 by default in fscrypt ≥ 0.3)
  // and sets up "/" in the same call.
  return { file: FSCRYPT_BIN, args: ['setup', '--quiet', '--all-users'] };
}

export function fscryptSetupArgs(mountpoint: string): { file: string; args: string[] } {
  return { file: FSCRYPT_BIN, args: ['setup', mountpoint, '--quiet', '--all-users'] };
}

export function fscryptEncryptArgs(spec: { dir: string; protectorName: string }, keyFile: string): { file: string; args: string[] } {
  return {
    file: FSCRYPT_BIN,
    args: ['encrypt', spec.dir, '--quiet', '--source=raw_key', `--name=${spec.protectorName}`, `--key=${keyFile}`],
  };
}

export function fscryptUnlockArgs(dir: string, keyFile: string): { file: string; args: string[] } {
  return { file: FSCRYPT_BIN, args: ['unlock', dir, '--quiet', `--key=${keyFile}`] };
}

export function fscryptLockArgs(dir: string): { file: string; args: string[] } {
  return { file: FSCRYPT_BIN, args: ['lock', dir, '--quiet'] };
}

export function fscryptStatusArgs(target: string): { file: string; args: string[] } {
  return { file: FSCRYPT_BIN, args: ['status', target] };
}

export function tune2fsListArgs(device: string): { file: string; args: string[] } {
  return { file: TUNE2FS_BIN, args: ['-l', device] };
}

// Enabling `encrypt` is a superblock flag flip: safe on a mounted filesystem
// and effective immediately (verified live on a mounted Ubuntu 24.04 root,
// kernel 6.8: `fscrypt encrypt` worked right after, no reboot).
export function tune2fsEnableEncryptArgs(device: string): { file: string; args: string[] } {
  return { file: TUNE2FS_BIN, args: ['-O', 'encrypt', device] };
}

export function findmntArgs(target: string): { file: string; args: string[] } {
  return { file: FINDMNT_BIN, args: ['-n', '-o', 'TARGET,SOURCE,FSTYPE', '--target', target] };
}

// ---------------------------------------------------------------- handoff files
// The daemon and the root step meet under <stateDir>/instances/<id>/crypto/:
//   request.json  what to do (action, home, protector) — never the key
//   key.fifo      the master key, hex, streamed through a FIFO (never on disk)
//   status.json   the root step's verdict, read back by the daemon
export interface AppCryptoRequest {
  action: AppCryptoAction;
  home: string;
  protectorName?: string;
  requestedAt: string;
}

export interface AppCryptoStatus {
  action: AppCryptoAction;
  state: 'working' | 'ok' | 'failed';
  message: string;
  nextAction?: string;
  // present after status/seal/unlock/lock/migrate
  encrypted?: boolean;
  unlocked?: boolean;
  at: string;
}

export function appCryptoDir(stateDir: string, instanceId: string): string {
  if (!UUID_RE.test(instanceId)) throw new HarborError('INVALID_REQUEST', `invalid instance id ${instanceId}`);
  return `${stateDir.replace(/\/+$/, '')}/instances/${instanceId}/crypto`;
}

export function appCryptoFiles(stateDir: string, instanceId: string): { dir: string; request: string; fifo: string; status: string } {
  const dir = appCryptoDir(stateDir, instanceId);
  return { dir, request: `${dir}/request.json`, fifo: `${dir}/key.fifo`, status: `${dir}/status.json` };
}

export function parseAppCryptoStatus(raw: string): AppCryptoStatus | null {
  try {
    const doc = JSON.parse(raw) as Partial<AppCryptoStatus>;
    if (!doc || typeof doc !== 'object' || typeof doc.state !== 'string' || typeof doc.message !== 'string') return null;
    return doc as AppCryptoStatus;
  } catch {
    return null;
  }
}
