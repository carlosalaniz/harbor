import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';

// Singleton process lock shared by the daemon and local maintenance commands.
// A lock file with the holder's PID; stale locks (dead PID) are reclaimed.
export interface ProcessLock {
  readonly file: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(stateDir: string, purpose: string): ProcessLock {
  const file = path.join(stateDir, 'harbor.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, purpose, at: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return {
        file,
        release() {
          if (released) return;
          released = true;
          try {
            const holder = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
            if (holder.pid === process.pid) unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid?: number; purpose?: string } = {};
      try {
        holder = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: treat as stale below */
      }
      if (holder.pid && pidAlive(holder.pid)) {
        throw new HarborError('STATE_UNAVAILABLE', `state directory is locked by pid ${holder.pid} (${holder.purpose ?? 'unknown'})`, {
          nextAction: 'Stop the other Harbor process (daemon or maintenance command) and retry.',
        });
      }
      try {
        unlinkSync(file);
      } catch {
        /* race: retry once */
      }
    }
  }
  throw new HarborError('STATE_UNAVAILABLE', `could not acquire lock ${file}`);
}
