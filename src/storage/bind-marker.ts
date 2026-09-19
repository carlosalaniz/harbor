// Marker file inside operator-owned folders claimed by an app ("bring your own
// folder"). A different drive mounted at the same path — or a folder the
// operator swapped out — fails the check, so Harbor refuses to start the app
// against the wrong data instead of writing into a stranger's disk.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';

export const BIND_MARKER = '.harbor-bind.json';

export interface BindMarker {
  instanceId: string;
  storageId: string;
  writtenAt: string;
}

export function bindMarkerFile(dir: string): string {
  return path.join(dir, BIND_MARKER);
}

// Best effort: a read-only claim cannot carry a marker, and a folder Harbor
// cannot write to is still usable — the marker only guards what it can.
export function writeBindMarker(dir: string, instanceId: string, storageId: string): void {
  try {
    writeFileSync(bindMarkerFile(dir), JSON.stringify({ instanceId, storageId, writtenAt: new Date().toISOString() }), { mode: 0o600 });
  } catch {
    /* read-only or unwritable folders simply go unmarked */
  }
}

// Throws when a marker exists for a different instance or claim: the folder at
// this path is not the one this app claimed.
export function verifyBindMarker(dir: string, instanceId: string, storageId: string): void {
  let raw: string;
  try {
    if (!existsSync(bindMarkerFile(dir))) return;
    raw = readFileSync(bindMarkerFile(dir), 'utf8');
  } catch {
    return;
  }
  let marker: BindMarker;
  try {
    marker = JSON.parse(raw) as BindMarker;
  } catch {
    return; // not ours, not our problem
  }
  if (typeof marker.instanceId !== 'string' || typeof marker.storageId !== 'string') return;
  if (marker.instanceId !== instanceId || marker.storageId !== storageId) {
    throw new HarborError('DATA_MISSING', `folder ${dir} belongs to a different app (claimed by ${marker.instanceId}/${marker.storageId})`, {
      nextAction: 'A different drive may be mounted at this path. Mount the right drive at the same path, or point the app at a new folder.',
    });
  }
}
