import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Bounded memory-hard profile (TDD section 8). Parameters are stored with the hash so
// they can change later without breaking existing administrators.
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 } as const;
export type ScryptParams = { N: number; r: number; p: number; keylen: number; maxmem: number };

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// One-at-a-time login computation limit: a single chain serializes all hash work.
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<{ hash: string; salt: string; params: ScryptParams }> {
  const salt = randomBytes(16);
  const key = await serialized(() => scryptAsync(password, salt, params));
  return { hash: key.toString('hex'), salt: salt.toString('hex'), params };
}

export async function verifyPassword(password: string, stored: { hash: string; salt: string; params: Record<string, number> }): Promise<boolean> {
  const params: ScryptParams = {
    N: stored.params['N'] ?? SCRYPT_PARAMS.N,
    r: stored.params['r'] ?? SCRYPT_PARAMS.r,
    p: stored.params['p'] ?? SCRYPT_PARAMS.p,
    keylen: stored.params['keylen'] ?? SCRYPT_PARAMS.keylen,
    maxmem: stored.params['maxmem'] ?? SCRYPT_PARAMS.maxmem,
  };
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = await serialized(() => scryptAsync(password, Buffer.from(stored.salt, 'hex'), params));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 8) return 'password must be at least 8 characters';
  if (password.length > 256) return 'password must be at most 256 characters';
  return null;
}

export function validateUsername(username: string): string | null {
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) return 'username must be 3-32 lowercase letters, digits, _ or -';
  return null;
}
