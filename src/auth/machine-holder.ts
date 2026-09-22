// In-memory holder for the unsealed per-installation machine key (BFU/AFU).
// BFU: nothing held (daemon just started). The first successful login unseals
// the sealed blob from settings into memory (AFU). Restart returns to BFU.
// The key never touches disk unsealed and never leaves this process.
import type { Logger } from '../lifecycle/context.js';
import { zeroMachineKey } from './machine-key.js';

export class MachineKeyHolder {
  private key: Buffer | null = null;
  private listeners: (() => void)[] = [];

  constructor(private readonly log?: Pick<Logger, 'info' | 'warn'>) {}

  get unlocked(): boolean {
    return this.key !== null;
  }

  // A copy for one wrapping operation. Callers zero the copy when done.
  take(): Buffer | null {
    return this.key ? Buffer.from(this.key) : null;
  }

  hold(key: Buffer): void {
    this.clear();
    this.key = Buffer.from(key);
    this.log?.info('machine key unlocked (AFU)', {});
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* listeners own their errors */
      }
    }
  }

  // BFU → AFU hook: the service kernel-unlocks every default-key app home
  // as soon as the machine key is in memory (first login after boot).
  onHold(listener: () => void): void {
    this.listeners.push(listener);
  }

  clear(): void {
    if (this.key) {
      zeroMachineKey(this.key);
      this.key = null;
    }
  }
}
