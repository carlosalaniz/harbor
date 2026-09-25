import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { HarborError } from '../errors.js';
import type { Repo } from '../state/repo.js';
import { hashPassword, validatePasswordPolicy } from './password.js';
import { createSealedMachineKey, zeroMachineKey } from './machine-key.js';
import { INSTALLATION_RECOVERY_SETTING, newInstallationRecoveryKey, sealInstallationRecovery } from '../storage/installation-recovery.js';
import type { SessionService } from './sessions.js';

// First-run setup from the browser. While no administrator exists the daemon is "unclaimed": one open
// route creates the account, guarded by a short setup code the installer printed on the machine (so a
// stranger on the same network cannot claim the box first). The code lives in <stateDir>/setup-code.
export const SETUP_CODE_FILE = 'setup-code';

export function writeSetupCode(stateDir: string): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  writeFileSync(path.join(stateDir, SETUP_CODE_FILE), code + '\n', { mode: 0o600 });
  return code;
}
export function readSetupCode(stateDir: string): string | null {
  const f = path.join(stateDir, SETUP_CODE_FILE);
  if (!existsSync(f)) return null;
  const c = readFileSync(f, 'utf8').trim();
  return /^\d{6}$/.test(c) ? c : null;
}

export class SetupService {
  private failures = 0;
  private blockedUntil = 0;
  constructor(
    private readonly repo: Repo,
    private readonly sessions: SessionService,
    private readonly stateDir: string,
  ) {}
  needed(): boolean {
    return this.repo.administrator() === null;
  }
  // Create the administrator, name the machine, log the browser in. One shot: afterwards the route is gone.
  async claim(req: { code: string; username: string; password: string; deviceName?: string; displayName?: string }, client: string): Promise<{ token: string; expiresAt: string; recoveryKey: string }> {
    if (!this.needed()) throw new HarborError('INVALID_STATE', 'this Harbor already has an administrator', { nextAction: 'Log in instead.' });
    const now = Date.now();
    if (now < this.blockedUntil) throw new HarborError('RATE_LIMITED', 'too many wrong setup codes', { nextAction: 'Wait a minute and try again with the code shown by the installer.' });
    const expected = readSetupCode(this.stateDir);
    if (!expected) throw new HarborError('INVALID_STATE', 'no setup code on this machine', { nextAction: 'On the machine run: sudo /opt/harbor/bin/harbor setup-code' });
    const given = req.code.replace(/\D/g, '');
    if (given.length !== 6 || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      this.failures += 1;
      if (this.failures >= 5) {
        this.blockedUntil = now + 60_000;
        this.failures = 0;
      }
      throw new HarborError('UNAUTHENTICATED', 'wrong setup code', { nextAction: 'Type the 6-digit code the installer printed (or run `harbor setup-code` on the machine).' });
    }
    const username = req.username.trim();
    if (!/^[a-z][a-z0-9._-]{1,31}$/i.test(username)) throw new HarborError('INVALID_REQUEST', 'the username must be 2-32 letters, digits, dots, dashes or underscores, starting with a letter');
    const policy = validatePasswordPolicy(req.password);
    if (policy) throw new HarborError('INVALID_REQUEST', policy);
    const deviceName = req.deviceName?.trim().replace(/\s+/g, ' ') ?? '';
    if (deviceName.length > 40) throw new HarborError('INVALID_REQUEST', 'the name can be at most 40 characters');
    const displayName = req.displayName?.trim().replace(/\s+/g, ' ') ?? '';
    if (displayName.length > 40) throw new HarborError('INVALID_REQUEST', 'the name can be at most 40 characters');
    const hashed = await hashPassword(req.password);
    // First claim seals a fresh machine key under the new password, so the
    // login below lands straight in AFU. The live key is held by the session
    // layer's unlock step, not here.
    const { sealed, machineKey } = await createSealedMachineKey(req.password);
    // The Harbor recovery key is issued here, once, and shown once by the
    // wizard. Stored only wrapped under the machine key, so every later app
    // install can stamp its envelope without asking for the card again.
    const recoveryKey = newInstallationRecoveryKey();
    try {
      const storedRecovery = sealInstallationRecovery(recoveryKey, machineKey, new Date());
      this.repo.transaction(() => {
        if (this.repo.administrator()) throw new HarborError('INVALID_STATE', 'this Harbor already has an administrator');
        this.repo.setAdministrator({ username, passwordHash: hashed.hash, salt: hashed.salt, params: hashed.params });
        this.repo.setSetting('security.machineKey', sealed);
        this.repo.setSetting(INSTALLATION_RECOVERY_SETTING, storedRecovery);
        if (deviceName) this.repo.setSetting('device.name', deviceName);
        if (displayName) this.repo.setSetting('account.displayName', displayName);
      });
    } finally {
      zeroMachineKey(machineKey);
    }
    rmSync(path.join(this.stateDir, SETUP_CODE_FILE), { force: true });
    const session = await this.sessions.login(username, req.password, client);
    return { ...session, recoveryKey };
  }
}
