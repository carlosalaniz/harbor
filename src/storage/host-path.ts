import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';

// "Bring your own folder": operators may bind a storage claim to a host directory at install time.
// Harbor never creates, chowns or deletes such folders; it only checks that the choice is sane.
const DENIED_PREFIXES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/lib/docker', '/var/lib/harbor', '/var/run'];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

export function normalizeHostPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) throw new HarborError('INVALID_REQUEST', 'host path must be a non-empty string (max 4096 chars)');
  if (!input.startsWith('/')) throw new HarborError('INVALID_REQUEST', `host path ${input} must be absolute`);
  if (CONTROL_CHARS.test(input)) throw new HarborError('INVALID_REQUEST', 'host path contains control characters');
  const norm = path.posix.normalize(input).replace(/\/+$/, '') || '/';
  if (norm.split('/').includes('..')) throw new HarborError('INVALID_REQUEST', 'host path must not contain ..');
  if (norm === '/') throw new HarborError('INVALID_REQUEST', 'the root filesystem cannot be used as app storage');
  for (const d of DENIED_PREFIXES) {
    if (norm === d || norm.startsWith(d + '/')) throw new HarborError('INVALID_REQUEST', `${norm} is a system location and cannot be used as app storage`, { nextAction: 'Choose a folder under /mnt, /srv, /data or a home directory.' });
  }
  return norm;
}

export interface HostPathCheck {
  path: string;
  realPath: string;
}

// Resolves and checks an existing directory. Symlinks are followed for the existence and denylist
// checks; the *given* (normalized) path is what gets mounted, so the operator sees what they typed.
export function checkHostDirectory(input: string): HostPathCheck {
  const norm = normalizeHostPath(input);
  let st;
  try {
    st = statSync(norm);
  } catch {
    throw new HarborError('INVALID_REQUEST', `host folder ${norm} does not exist`, { nextAction: `Create it first (for example: sudo mkdir -p ${norm}) and make sure the app may write to it, then plan again.` });
  }
  if (!st.isDirectory()) throw new HarborError('INVALID_REQUEST', `${norm} exists but is not a directory`);
  const realPath = realpathSync(norm);
  for (const d of DENIED_PREFIXES) {
    if (realPath === d || realPath.startsWith(d + '/')) throw new HarborError('INVALID_REQUEST', `${norm} resolves to ${realPath}, a system location`);
  }
  return { path: norm, realPath };
}

// Two folders overlap when one is the other or contains the other.
export function hostPathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
