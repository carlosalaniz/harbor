// Local maintenance commands that touch state directly (never over HTTP):
// explicit initialization and administrator enrollment/reset.
import { hashPassword, validatePasswordPolicy, validateUsername } from './auth/password.js';
import type { DaemonConfig } from './config.js';
import { HarborError } from './errors.js';
import { acquireLock } from './state/lock.js';
import { initializeState, openState } from './state/db.js';
import { Repo } from './state/repo.js';
import { systemClock, systemIds } from './util.js';

export function initState(config: DaemonConfig): { installationId: string } {
  const result = initializeState(config.stateDir, {
    clock: systemClock,
    ids: systemIds,
    config: { managementPort: config.listen.port, appPortRange: config.appPortRange, docker: config.docker.mode },
  });
  return result;
}

export async function enrollAdministrator(config: DaemonConfig, username: string, password: string, opts: { reset: boolean }): Promise<{ created: boolean; revokedSessions: number }> {
  const u = validateUsername(username);
  if (u) throw new HarborError('INVALID_REQUEST', u);
  const p = validatePasswordPolicy(password);
  if (p) throw new HarborError('INVALID_REQUEST', p);
  const lock = acquireLock(config.stateDir, 'enroll');
  try {
    const db = openState(config.stateDir);
    try {
      const repo = new Repo(db, systemClock);
      const existing = repo.administrator();
      if (existing && !opts.reset) {
        throw new HarborError('INVALID_STATE', `administrator ${existing.username} is already enrolled`, { nextAction: 'Use --reset (daemon stopped) to replace the credentials.' });
      }
      const hashed = await hashPassword(password);
      let revoked = 0;
      repo.transaction(() => {
        repo.setAdministrator({ username, passwordHash: hashed.hash, salt: hashed.salt, params: hashed.params });
        if (existing) revoked = repo.revokeAllSessions();
      });
      return { created: !existing, revokedSessions: revoked };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}

// Recovery when the authenticator is lost: run on the machine itself; removes the second factor.
export function resetTwoFactor(config: DaemonConfig): { wasEnabled: boolean } {
  const lock = acquireLock(config.stateDir, 'enroll');
  try {
    const db = openState(config.stateDir);
    try {
      const repo = new Repo(db, systemClock);
      const was = repo.setting('security.totp') !== null;
      repo.deleteSetting('security.totp');
      repo.deleteSetting('security.totp.pending');
      return { wasEnabled: was };
    } finally {
      db.close();
    }
  } finally {
    lock.release();
  }
}
