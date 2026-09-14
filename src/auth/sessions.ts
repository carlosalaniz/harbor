import { createHash } from 'node:crypto';
import type { Repo } from '../state/repo.js';
import { HarborError } from '../errors.js';
import { addSeconds, rfc3339, type Clock, type Ids } from '../util.js';
import { verifyPassword } from './password.js';

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
  private trim(now: number): void {
    while (this.hits.length && this.hits[0]! < now - this.windowMs) this.hits.shift();
  }
}

export class SessionService {
  private readonly perClient = new Map<string, FailureWindow>();
  private readonly global = new FailureWindow(20, 10 * 60_000);

  constructor(
    private readonly repo: Repo,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly ttlSeconds: number,
  ) {}

  private windowFor(client: string): FailureWindow {
    let w = this.perClient.get(client);
    if (!w) {
      w = new FailureWindow(5, 10 * 60_000);
      this.perClient.set(client, w);
      if (this.perClient.size > 1000) this.perClient.delete(this.perClient.keys().next().value!);
    }
    return w;
  }

  async login(username: string, password: string, client: string): Promise<{ token: string; expiresAt: string }> {
    const nowMs = this.clock.now().getTime();
    const w = this.windowFor(client);
    if (w.blocked(nowMs) || this.global.blocked(nowMs)) {
      throw new HarborError('RATE_LIMITED', 'too many failed login attempts', { nextAction: 'Wait ten minutes and retry.' });
    }
    const admin = this.repo.administrator();
    // Always run a hash computation so timing does not reveal whether the username exists.
    const ok = admin
      ? admin.username === username && (await verifyPassword(password, { hash: admin.passwordHash, salt: admin.salt, params: admin.params }))
      : (await verifyPassword(password, { hash: '00'.repeat(64), salt: '00'.repeat(16), params: {} }), false);
    if (!ok) {
      w.record(nowMs);
      this.global.record(nowMs);
      throw new HarborError('UNAUTHENTICATED', 'invalid username or password', { nextAction: 'Check the credentials and retry.' });
    }
    const token = this.ids.token(32).toString('base64url');
    const expiresAt = rfc3339(addSeconds(this.clock.now(), this.ttlSeconds));
    this.repo.insertSession(hashToken(token), username, expiresAt);
    return { token, expiresAt };
  }

  authenticate(token: string | undefined): Session {
    if (!token) throw new HarborError('UNAUTHENTICATED', 'missing bearer token');
    const s = this.repo.session(hashToken(token));
    if (!s || s.revokedAt) throw new HarborError('UNAUTHENTICATED', 'session is not valid');
    if (new Date(s.expiresAt).getTime() <= this.clock.now().getTime()) throw new HarborError('UNAUTHENTICATED', 'session expired');
    return { actor: s.actor, expiresAt: s.expiresAt };
  }

  logout(token: string): void {
    this.repo.revokeSession(hashToken(token));
  }
}
