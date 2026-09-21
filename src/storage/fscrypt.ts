// Kernel sealing for app homes (stage 4): per-app fscrypt directory
// encryption on ext4 with the `encrypt` feature.
//
// Model: every app home's <home>/volumes dir is an fscrypt-encrypted
// directory with ONE policy per app, protected by a raw_key protector whose
// 32-byte key file IS the app's master key (the same key the manifest
// envelopes wrap). Unlock = write the key into the kernel keyring
// (`fscrypt unlock` with the key file on stdin); locked = ciphertext names +
// ENOKEY on read (BFU). AFU = unlocked, kernel-transparent, Docker sees
// plaintext (v2 policy — v1 breaks cross-UID access with ENOKEY).
//
// Layout note: fscrypt metadata lives at the FILESYSTEM root
// (<mount>/.fscrypt), not in the home. Portability = unlock here, create a
// fresh encrypted dir there, `cp -a -T` unlocked → new, lock both. The
// manifest + dual-key envelope do not change.
//
// Privilege: fscrypt setup/encrypt/unlock/lock need root (keyring + policy
// ioctls). The daemon (harbor user) never runs them directly: it starts the
// polkit-allowed `harbor-device-mount@<name>:<action>` oneshot (same shape as
// mount/format), and the root step runs `harbor device-fscrypt …`.
//
// This module is pure command builders + status parsing: no spawn, no fs.
// Callers own execution (bootstrap root steps) and key lifetime.
import { HarborError } from '../errors.js';

export const FSCRYPT_POLICY_VERSION = '2';

// `fscrypt setup` state for one mountpoint (parsed from `fscrypt status`).
export interface FscryptFsStatus {
  mountpoint: string;
  // kernel supports encryption here AND the encrypt feature is on
  supported: boolean;
  // <mount>/.fscrypt metadata exists (setup ran)
  hasMetadata: boolean;
}

// Parse `fscrypt status <mount>` output. Never throws: unparseable means
// "not ready" (the caller refuses with a next action, not a stack trace).
export function parseFscryptStatus(mountpoint: string, stdout: string): FscryptFsStatus {
  const text = stdout.toLowerCase();
  // fscrypt prints e.g. 'ext4 filesystem "/mnt/x" has 1 protector and 1
  // policy' once setup ran; 'encryption: supported' / 'not enabled' rows
  // describe kernel + feature state. Be conservative: require positive
  // signals, treat anything else as not-ready.
  const supported = /encryption\s*:\s*supported/.test(text) || (/supported/.test(text) && !/not enabled|not supported/.test(text));
  const hasMetadata = /\.fscrypt/.test(stdout) || /has \d+ protector/.test(text);
  return { mountpoint, supported, hasMetadata };
}

// Parse `fscrypt status <dir>` for one encrypted directory.
export function parseFscryptDirStatus(stdout: string): { encrypted: boolean; unlocked: boolean; policyVersion: string | null } {
  const text = stdout.toLowerCase();
  const encrypted = /is encrypted with fscrypt/.test(text);
  const unlocked = /unlocked:\s*yes/.test(text);
  const m = /policy_version\s*:\s*(\d+)/.exec(text);
  return { encrypted, unlocked, policyVersion: m?.[1] ?? null };
}

export interface FscryptSpec {
  // The directory to seal (must exist and be EMPTY — fscrypt refuses
  // non-empty dirs; the runner creates <home>/volumes before sealing).
  dir: string;
  // Protector name shown in `fscrypt status` (per-app, stable).
  protectorName: string;
}

// Build the argv for each root step. No shell: callers spawn these directly.
// The raw key travels via --key=FILE on a root-only temp file (0600), never
// in argv or logs — same discipline as the Tailscale auth key (decision 45).
export function fscryptSetupArgs(mountpoint: string): { file: string; args: string[] } {
  return { file: '/usr/bin/fscrypt', args: ['setup', mountpoint, '--quiet', '--all-users'] };
}

export function fscryptEncryptArgs(spec: FscryptSpec, keyFile: string): { file: string; args: string[] } {
  return {
    file: '/usr/bin/fscrypt',
    args: ['encrypt', spec.dir, '--quiet', '--source=raw_key', `--name=${spec.protectorName}`, `--key=${keyFile}`],
  };
}

export function fscryptUnlockArgs(dir: string, keyFile: string): { file: string; args: string[] } {
  return { file: '/usr/bin/fscrypt', args: ['unlock', dir, '--quiet', `--key=${keyFile}`] };
}

export function fscryptLockArgs(dir: string): { file: string; args: string[] } {
  return { file: '/usr/bin/fscrypt', args: ['lock', dir, '--quiet'] };
}

export function fscryptStatusArgs(target: string): { file: string; args: string[] } {
  return { file: '/usr/bin/fscrypt', args: ['status', target] };
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

// Refuse early with a plain-words error when the filesystem cannot seal.
export function requireFscryptReady(status: FscryptFsStatus): void {
  if (!status.supported) {
    throw new HarborError('INVALID_REQUEST', `${status.mountpoint} does not support native encryption (needs ext4 with the encrypt feature)`, {
      nextAction: 'Format the drive as ext4 in Settings → Storage (Harbor enables encryption at format time), then try again.',
    });
  }
  if (!status.hasMetadata) {
    throw new HarborError('INVALID_REQUEST', `${status.mountpoint} is not set up for encryption yet`, {
      nextAction: 'Harbor sets this up automatically at install; retry the install. If it persists, re-run bootstrap.',
    });
  }
}
