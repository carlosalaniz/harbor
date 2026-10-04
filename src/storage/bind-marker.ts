// Marker file inside operator-owned folders claimed by an app ("bring your own
// folder"). Identity is app-generated, never hardware-anchored: at install the
// app writes a random drive id into the folder, and every later check compares
// against that id. A dead drive restored from backup keeps working (the operator
// copies the folder, marker included); a replacement or stranger's drive at the
// same path fails the check, so Harbor refuses to start the app against the
// wrong data instead of writing into a stranger's disk.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarborError } from '../errors.js';

export const BIND_MARKER = '.harbor-bind.json';

export interface BindMarker {
  instanceId: string;
  storageId: string;
  // App-generated drive identity: random at install, copied with the data on
  // restore/replacement. Never a hardware UUID (those change on restore).
  driveId: string;
  writtenAt: string;
}

export function bindMarkerFile(dir: string): string {
  return path.join(dir, BIND_MARKER);
}

// Returns the drive id now authoritative for this folder: the existing one
// when the folder already carries this app's marker (restore keeps identity),
// a fresh random id otherwise (new folder, replacement drive, first claim).
// `required` (install, adopt): the drive guard refuses a folder without this
// app's marker, so a write that fails must fail the operation (decision 121);
// legacy backfills stay best effort.
export function writeBindMarker(dir: string, instanceId: string, storageId: string, opts: { required?: boolean } = {}): string {
  const keep = readDriveId(dir, instanceId, storageId);
  const driveId = keep ?? randomUUID();
  try {
    // 0644: ids only, no secrets — any machine's harbor user (different uid) can read it (decision 122).
    writeFileSync(bindMarkerFile(dir), JSON.stringify({ instanceId, storageId, driveId, writtenAt: new Date().toISOString() }), { mode: 0o644 });
  } catch (e) {
    if (opts.required) throw unwritableFolder(dir, e);
  }
  return driveId;
}

// Decision 121: can Harbor write its identity marker here? Checked at plan time so an unwritable
// folder (outside the service's writable paths, a read-only mount) is refused before anything runs.
export function assertMarkerWritable(dir: string): void {
  const probe = path.join(dir, `.harbor-write-probe-${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(probe, '', { mode: 0o600 });
    unlinkSync(probe);
  } catch (e) {
    throw unwritableFolder(dir, e);
  }
}

function unwritableFolder(dir: string, e: unknown): HarborError {
  const code = (e as NodeJS.ErrnoException)?.code ?? 'EACCES';
  return new HarborError('INVALID_REQUEST', `Harbor cannot write in ${dir} (${code}): it keeps a small identity file there so a swapped or missing drive is never mistaken for this app's data`, {
    nextAction: 'Choose a folder under /srv/harbor, /mnt or /media (where Harbor may write), or make this one writable for the harbor service user.',
  });
}

// The drive id this folder claims for this app, or null when the folder
// carries no marker for this app (unmarked, foreign, or unreadable).
export function readDriveId(dir: string, instanceId: string, storageId: string): string | null {
  const marker = readMarker(dir);
  if (!marker) return null;
  if (marker.instanceId !== instanceId || marker.storageId !== storageId) return null;
  return typeof marker.driveId === 'string' && marker.driveId.length > 0 ? marker.driveId : null;
}

function readMarker(dir: string): BindMarker | null {
  let raw: string;
  try {
    if (!existsSync(bindMarkerFile(dir))) return null;
    raw = readFileSync(bindMarkerFile(dir), 'utf8');
  } catch {
    return null;
  }
  try {
    const marker = JSON.parse(raw) as BindMarker;
    if (typeof marker.instanceId !== 'string' || typeof marker.storageId !== 'string') return null;
    return marker;
  } catch {
    return null; // not ours, not our problem
  }
}

// Throws when the folder carries no usable identity for this app (missing,
// unreadable, or a different app's marker): the folder at this path is not
// the one this app claimed. A legacy marker (no drive id, written before the
// drive guard) verifies by instance + claim alone: the folder is the one the
// app was installed with, it just predates identities. The next install or
// adopt stamps a drive id into it going forward.
export function verifyBindMarker(dir: string, instanceId: string, storageId: string, expectedDriveId?: string | null): void {
  const marker = readMarker(dir);
  if (!marker) {
    throw new HarborError('DATA_MISSING', `folder ${dir} carries no Harbor identity for this app`, {
      nextAction: 'Re-insert the drive that holds this app\u2019s data (with its .harbor-bind.json marker), restore the folder from backup, or point the app at a new folder.',
    });
  }
  if (marker.instanceId !== instanceId || marker.storageId !== storageId) {
    throw new HarborError('DATA_MISSING', `folder ${dir} belongs to a different app (claimed by ${marker.instanceId}/${marker.storageId})`, {
      nextAction: 'A different drive may be mounted at this path. Mount the right drive at the same path, or point the app at a new folder.',
    });
  }
  if (typeof marker.driveId !== 'string' || marker.driveId.length === 0) {
    // Legacy marker: the right folder, predates drive ids. Accept it; the
    // resource backfill records an id for future comparisons.
    return;
  }
  if (expectedDriveId && marker.driveId !== expectedDriveId) {
    throw new HarborError('DATA_MISSING', `folder ${dir} is not the drive this app was using`, {
      nextAction: 'A replacement or stranger\u2019s drive is mounted at this path. Mount the drive that holds this app\u2019s data, restore from backup (marker included), or adopt this folder to accept it.',
    });
  }
}
