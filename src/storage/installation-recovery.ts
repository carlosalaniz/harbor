// The Harbor recovery key: one 12-word card per installation, issued at
// first-run setup and shown once.
//
// It is the third envelope on every app home this Harbor creates, beside the
// app's own passphrase and (for custom-passphrase homes) the app's own words.
// One card therefore restores every app of this Harbor on a new machine,
// which is what an operator actually needs after a dead box: not a shoebox of
// one card per app.
//
// At rest the words exist ONLY wrapped under the machine key, which is itself
// sealed under the login password (BFU/AFU, src/auth/machine-key.ts). That is
// the same trust level the machine-wrapped app keys already live at: state
// directory plus login password opens everything either way. Keeping the
// words there adds no exposure, and it lets later installs stamp their
// envelope without ever asking the operator to retype the card.
//
// What it is NOT: a password. It is 12 words from the 2048-entry list, so
// roughly 132 bits of entropy. A stolen drive cannot be attacked offline for
// it the way a human passphrase can.
//
// This module is pure: wrapping and parsing only. Persistence belongs to the
// caller (the settings table), memory lifetime to the machine-key holder.
import { HarborError } from '../errors.js';
import { generateRecoveryKey, unwrapSecretForMachine, wrapSecretForMachine, type MachineWrappedKey } from './app-home.js';

export const INSTALLATION_RECOVERY_SETTING = 'security.recoveryKey';

export interface StoredInstallationRecovery {
  format: 1;
  createdAt: string; // RFC3339, shown in Settings so the operator knows which card is current
  wrapped: MachineWrappedKey;
}

export function newInstallationRecoveryKey(): string {
  return generateRecoveryKey();
}

export function sealInstallationRecovery(words: string, machineKey: Buffer, now: Date): StoredInstallationRecovery {
  if (typeof words !== 'string' || words.trim().split(/\s+/).length !== 12) {
    throw new HarborError('INVALID_REQUEST', 'the Harbor recovery key must be 12 words');
  }
  const secret = Buffer.from(words, 'utf8');
  try {
    return { format: 1, createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), wrapped: wrapSecretForMachine(secret, machineKey) };
  } finally {
    secret.fill(0);
  }
}

// Returns null when the stored blob is unreadable (damaged, or sealed by a
// different installation): the caller degrades to per-app secrets rather than
// failing an install over a convenience card.
export function openInstallationRecovery(stored: StoredInstallationRecovery | null | undefined, machineKey: Buffer): string | null {
  if (!stored || stored.format !== 1 || !stored.wrapped) return null;
  let secret: Buffer | null = null;
  try {
    secret = unwrapSecretForMachine(stored.wrapped, machineKey);
    const words = secret.toString('utf8');
    return /^(\S+\s){11}\S+$/.test(words) ? words : null;
  } catch {
    return null;
  } finally {
    if (secret) secret.fill(0);
  }
}
