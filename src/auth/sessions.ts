import { createHash } from 'node:crypto';
import type { Repo } from '../state/repo.js';
import { HarborError } from '../errors.js';
import { addSeconds, rfc3339, type Clock, type Ids } from '../util.js';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './password.js';
import { INSTALLATION_RECOVERY_SETTING } from '../storage/installation-recovery.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.js';
import { unsealMachineKey, zeroMachineKey, type SealedMachineKey } from './machine-key.js';
import type { MachineKeyHolder } from './machine-holder.js';

export interface Session {
  actor: string;
  expiresAt: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Login failure rate limit: per-client and global windows, never disclosing whether a user exists.
class FailureWindow {
  private readonly hits: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  blocked(now: number): boolean {
    this.trim(now);
    return this.hits.length >= this.limit;
  }
  record(now: number): void {
    this.trim(now);
    this.hits.push(now);
  }
  // Undo one record() (a reserved attempt that turned out right).
  forget(at: number): void {
    const i = this.hits.lastIndexOf(at);
    if (i >= 0) this.hits.splice(i, 1);
  }
  private trim(now: number): void {
    while (this.hits.length && this.hits[0]! < now - this.windowMs) this.hits.shift();
  }
}

export class SessionService {
  private readonly perClient = new Map<string, FailureWindow>();
  private readonly global = new FailureWindow(20, 10 * 60_000);
  // Decision 169: connections that authenticated once (the web terminal) re-check their session when any is revoked.
  private readonly revokeListeners = new Set<() => void>();

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly ttlSeconds: number,
    private readonly machineKey?: MachineKeyHolder,
  ) {}

  // BFU -> AFU: the first successful login after boot unseals the machine key
  // into memory. Best-effort: a missing/corrupt blob (or no app homes yet)
  // never fails the login itself.
  // BFU -> AFU. AWAITED on purpose: a login that returns before the machine
  // key is in memory lets the very next request (an install, say) run without
  // it, so a default-key home would be created with no machine wrapping and
  // would never unlock silently again. One extra scrypt on the login path is
  // the price of that guarantee. A damaged blob never fails the login itself.
  private async unlockMachineKey(password: string): Promise<void> {
    if (!this.machineKey) return;
    if (this.machineKey.unlocked) {
      this.machineKey.announceLogin(password);
      return;
    }
    const sealed = this.repo.setting<SealedMachineKey>('security.machineKey');
    if (!sealed) return;
    try {
      const key = await unsealMachineKey(sealed, password);
      try {
        this.machineKey.hold(key);
      } finally {
        zeroMachineKey(key);
      }
    } catch {
      // Wrong-password logins never reach here (they fail above); a damaged
      // blob stays damaged until the next login retry. Stay BFU.
      return;
    }
    this.machineKey.announceLogin(password);
  }

  private windowFor(client: string): FailureWindow {
    let w = this.perClient.get(client);
    if (!w) {
      w = new FailureWindow(5, 10 * 60_000);
      this.perClient.set(client, w);
      if (this.perClient.size > 1000) this.perClient.delete(this.perClient.keys().next().value!);
    }
    return w;
  }

  // Decision 165: an attempt is counted BEFORE the password hash runs (and given back when it was right), so a
  // burst of parallel guesses cannot all slip past the limit while the first ones are still hashing. A client on
  // this machine itself (`local`: loopback with no proxy in between, e.g. the CLI) is limited per client only,
  // so strangers filling the global window can never lock the administrator out of the box itself.
  private reserve(client: string, local: boolean, nowMs: number, what: string): () => void {
    const w = this.windowFor(client);
    if (w.blocked(nowMs) || (!local && this.global.blocked(nowMs))) throw new HarborError('RATE_LIMITED', what, { nextAction: 'Wait ten minutes and retry.' });
    w.record(nowMs);
    if (!local) this.global.record(nowMs);
    return () => {
      w.forget(nowMs);
      if (!local) this.global.forget(nowMs);
    };
  }

  async login(username: string, password: string, client: string, code?: string, opts: { remember?: boolean; local?: boolean } = {}): Promise<{ token: string; expiresAt: string }> {
    const nowMs = this.clock.now().getTime();
    const giveBack = this.reserve(client, opts.local === true, nowMs, 'too many failed login attempts');
    const admin = this.repo.administrator();
    // Always run the hash, then compare the name: timing never reveals whether the username exists.
    const passwordOk = admin
      ? await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params })
      : (await verifyPassword(password, { hash: '00'.repeat(64), salt: '00'.repeat(16), params: {} }), false);
    const ok = passwordOk && admin !== null && admin.username === username;
    if (!ok) throw new HarborError('UNAUTHENTICATED', 'invalid username or password', { nextAction: 'Check the credentials and retry.' });
    // second factor: only after the password is right, so the code prompt never reveals a valid password
    const totp = this.repo.setting<{ secret: string; enabledAt: string; lastStep?: number }>('security.totp');
    if (totp) {
      if (!code) {
        giveBack(); // the password was right: asking for the code is not a failure
        throw new HarborError('TOTP_REQUIRED', 'a two-factor code is required', { nextAction: 'Enter the 6-digit code from your authenticator app.' });
      }
      const step = verifyTotp(totp.secret, code, nowMs);
      if (step === null || (totp.lastStep !== undefined && step <= totp.lastStep)) {
        throw new HarborError('UNAUTHENTICATED', step === null ? 'invalid two-factor code' : 'that two-factor code was already used', { nextAction: 'Wait for the next code in your authenticator app and retry.' });
      }
      this.repo.setSetting('security.totp', { ...totp, lastStep: step });
    }
    giveBack();
    const token = this.ids.token(32).toString('base64url');
    // "Remember this browser": a 30-day session instead of the configured TTL (default 12 h).
    // Same bearer mechanics, same revocation; only the expiry differs.
    const ttl = opts.remember ? 30 * 24 * 3600 : this.ttlSeconds;
    const expiresAt = rfc3339(addSeconds(this.clock.now(), ttl));
    this.repo.insertSession(hashToken(token), username, expiresAt, opts.remember ? 'remember' : 'session');
    await this.unlockMachineKey(password);
    return { token, expiresAt };
  }

  authenticate(token: string | undefined): Session {
    if (!token) throw new HarborError('UNAUTHENTICATED', 'missing bearer token');
    const h = hashToken(token);
    const s = this.repo.session(h);
    if (!s || s.revokedAt) throw new HarborError('UNAUTHENTICATED', 'session is not valid');
    if (new Date(s.expiresAt).getTime() <= this.clock.now().getTime()) throw new HarborError('UNAUTHENTICATED', 'session expired');
    // best-effort activity stamp for the session list; never fails the request
    try {
      this.repo.touchSession(h);
    } catch {
      /* ignore */
    }
    return { actor: s.actor, expiresAt: s.expiresAt };
  }

  /** Is the session behind this token still usable? Same rules as authenticate(), without the activity stamp. */
  isValid(token: string): boolean {
    const s = this.repo.session(hashToken(token));
    return !!s && !s.revokedAt && new Date(s.expiresAt).getTime() > this.clock.now().getTime();
  }

  /** Called after any session is revoked (logout, log out others, password change). Returns the unsubscribe. */
  onRevoke(listener: () => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
  private announceRevoke(): void {
    for (const l of [...this.revokeListeners]) {
      try {
        l();
      } catch {
        /* a listener never fails the revocation */
      }
    }
  }

  sessions(currentToken: string): { createdAt: string; expiresAt: string; lastSeenAt: string | null; kind: 'session' | 'remember'; current: boolean }[] {
    return this.repo.listSessions(hashToken(currentToken));
  }

  logout(token: string): void {
    this.repo.revokeSession(hashToken(token));
    this.announceRevoke();
  }

  revokeOthers(token: string): number {
    const n = this.repo.revokeOtherSessions(hashToken(token));
    this.announceRevoke();
    return n;
  }

  // Password change by the logged-in administrator: current password required, policy applied,
  // every other session revoked so a stolen token does not outlive the change.
  // ---- two-factor (TOTP): setup creates a pending secret; enable confirms it with a live code; disable needs the password.
  security(): { username: string; displayName: string | null; twoFactor: boolean; pending: boolean; recoveryKey: { createdAt: string } | null } {
    const card = this.repo.setting<{ createdAt?: string }>(INSTALLATION_RECOVERY_SETTING);
    return {
      username: this.repo.administrator()?.username ?? 'admin',
      displayName: this.repo.setting<string>('account.displayName'),
      twoFactor: this.repo.setting('security.totp') !== null,
      pending: this.repo.setting('security.totp.pending') !== null,
      // Only when it was issued, never the words: they were shown once.
      recoveryKey: card?.createdAt ? { createdAt: card.createdAt } : null,
    };
  }
  /** What Home greets ("Carlos"): the chosen display name, else the login name. Never empty. */
  greetingName(): string {
    const display = this.repo.setting<string>('account.displayName')?.trim();
    if (display) return display;
    return this.repo.administrator()?.username ?? 'admin';
  }
  /** Set (or clear with null/empty) the Home greeting name. Login name is untouched. */
  setDisplayName(name: string | null): { username: string; displayName: string | null } {
    const clean = name?.trim().replace(/\s+/g, ' ') ?? '';
    if (!clean) {
      this.repo.deleteSetting('account.displayName');
      return { username: this.repo.administrator()?.username ?? 'admin', displayName: null };
    }
    if (clean.length > 40) throw new HarborError('INVALID_REQUEST', 'the name can be at most 40 characters');
    this.repo.setSetting('account.displayName', clean);
    return { username: this.repo.administrator()?.username ?? 'admin', displayName: clean };
  }
  setupTotp(issuer: string): { secret: string; otpauthUrl: string } {
    if (this.repo.setting('security.totp')) throw new HarborError('INVALID_STATE', 'two-factor authentication is already on', { nextAction: 'Turn it off first to set up a new authenticator.' });
    const admin = this.repo.administrator();
    const secret = newTotpSecret();
    this.repo.setSetting('security.totp.pending', { secret, createdAt: rfc3339(this.clock.now()) });
    return { secret, otpauthUrl: otpauthUrl(secret, admin?.username ?? 'admin', issuer) };
  }
  enableTotp(code: string): void {
    const pending = this.repo.setting<{ secret: string }>('security.totp.pending');
    if (!pending) throw new HarborError('INVALID_STATE', 'no two-factor setup in progress', { nextAction: 'Start the setup again.' });
    const step = verifyTotp(pending.secret, code, this.clock.now().getTime());
    if (step === null) throw new HarborError('INVALID_REQUEST', 'that code does not match the new authenticator', { nextAction: 'Scan the QR code again and type the current 6-digit code.' });
    this.repo.transaction(() => {
      this.repo.setSetting('security.totp', { secret: pending.secret, enabledAt: rfc3339(this.clock.now()), lastStep: step });
      this.repo.deleteSetting('security.totp.pending');
    });
  }
  // Decision 164: a session that outlived a daemon restart types the password once to unseal the
  // machine key (the console asks in place), instead of logging out and in again. Wrong passwords count
  // against the same limits as logins; the error is not a 401, so the console keeps its session.
  async unlock(password: string, client: string, opts: { local?: boolean } = {}): Promise<{ unlocked: boolean }> {
    const nowMs = this.clock.now().getTime();
    const admin = this.repo.administrator();
    if (!admin) throw new HarborError('STATE_UNAVAILABLE', 'no administrator enrolled');
    const giveBack = this.reserve(client, opts.local === true, nowMs, 'too many wrong passwords');
    if (!(await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params }))) {
      throw new HarborError('INVALID_REQUEST', 'password is wrong', { nextAction: 'Type your Harbor password again.' });
    }
    giveBack();
    await this.unlockMachineKey(password);
    return { unlocked: this.machineKey?.unlocked ?? false };
  }
  // Decision 193: a sensitive switch (developer mode) asks for the password again. Like unlock: wrong passwords count
  // against the login limits and the error is not a 401, so the console keeps its session.
  async confirmPassword(password: string, client: string, opts: { local?: boolean } = {}): Promise<void> {
    const nowMs = this.clock.now().getTime();
    const admin = this.repo.administrator();
    if (!admin) throw new HarborError('STATE_UNAVAILABLE', 'no administrator enrolled');
    const giveBack = this.reserve(client, opts.local === true, nowMs, 'too many wrong passwords');
    if (!(await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params }))) {
      throw new HarborError('INVALID_REQUEST', 'password is wrong', { nextAction: 'Type your Harbor password again.' });
    }
    giveBack();
  }
  /** Confirm the operator's password before a sensitive account action. */
  async verifyAdminPassword(password: string): Promise<void> {
    const admin = this.repo.administrator();
    if (!admin) throw new HarborError('STATE_UNAVAILABLE', 'no administrator enrolled');
    const ok = await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params });
    if (!ok) throw new HarborError('UNAUTHENTICATED', 'password is wrong', { nextAction: 'Type your password again.' });
  }
  async disableTotp(password: string): Promise<void> {
    const admin = this.repo.administrator();
    if (!admin) throw new HarborError('STATE_UNAVAILABLE', 'no administrator enrolled');
    const ok = await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params });
    if (!ok) throw new HarborError('UNAUTHENTICATED', 'password is wrong', { nextAction: 'Type your password again.' });
    this.repo.deleteSetting('security.totp');
    this.repo.deleteSetting('security.totp.pending');
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<{ revokedSessions: number }> {
    const admin = this.repo.administrator();
    if (!admin) throw new HarborError('STATE_UNAVAILABLE', 'no administrator enrolled');
    const ok = await verifyPassword(currentPassword, { hash: admin.passwordHash, salt: admin.salt, params: admin.params });
    if (!ok) throw new HarborError('UNAUTHENTICATED', 'current password is wrong', { nextAction: 'Type your current password again.' });
    const policy = validatePasswordPolicy(newPassword);
    if (policy) throw new HarborError('INVALID_REQUEST', policy);
    if (newPassword === currentPassword) throw new HarborError('INVALID_REQUEST', 'the new password must differ from the current one');
    const hashed = await hashPassword(newPassword);
    // Re-seal the machine key under the new password so AFU survives the
    // change. Decision 165: when BFU (the daemon restarted since the session
    // logged in) the key is unsealed here with the current password, which was
    // just verified — otherwise the blob would stay sealed under the OLD
    // password (which then still opens every home) and the new one would not
    // open it at all. A blob the current password cannot open (damaged) is
    // left as it is, exactly as a login would leave it.
    let live = this.machineKey?.take() ?? null;
    const sealed = this.repo.setting<SealedMachineKey>('security.machineKey');
    if (!live && sealed) {
      try {
        live = await unsealMachineKey(sealed, currentPassword);
        this.machineKey?.hold(live);
      } catch {
        live = null;
      }
    }
    try {
      const { resealMachineKey } = await import('./machine-key.js');
      const resealed = live ? await resealMachineKey(live, newPassword) : null;
      this.repo.transaction(() => {
        this.repo.setAdministrator({ username: admin.username, passwordHash: hashed.hash, salt: hashed.salt, params: hashed.params });
        if (resealed) this.repo.setSetting('security.machineKey', resealed);
      });
    } finally {
      if (live) zeroMachineKey(live);
    }
    const revokedSessions = this.repo.revokeOtherSessions(hashToken(token));
    this.announceRevoke();
    return { revokedSessions };
  }
}
