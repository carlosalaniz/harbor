import { randomUUID, randomBytes } from 'node:crypto';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface Ids {
  uuid(): string;
  token(bytes: number): Buffer;
}
export const systemIds: Ids = { uuid: () => randomUUID(), token: (n) => randomBytes(n) };

export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} out of safe range: ${n}`);
}
