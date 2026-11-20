// The daemon-side half of Access Guard (decision 207). The daemon never runs nft: it writes
// <stateDir>/guard/request.json, blocks on `systemctl start harbor-guard@<action>.service` (polkit lets the harbor user
// start that template only) and reads root's verdict back from status.json. Failures are hard: the switch stays where it
// was. In fake mode (tests, `pnpm dev`) the fake keeps what the kernel would hold in memory.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { systemctlStartBlocking, type UnitStarter } from '../storage/crypto-provider.js';
import { canonicalAddress, validateGuardState, type GuardState, type SeenSource } from './rules.js';

export type GuardAction = 'apply' | 'off' | 'status';
export const GUARD_ACTIONS: readonly GuardAction[] = ['apply', 'off', 'status'];
export const GUARD_UNIT_PREFIX = 'harbor-guard@';
export const GUARD_UNIT_FILE = 'harbor-guard@.service';
export const GUARD_BOOT_UNIT = 'harbor-guard.service';
export const GUARD_NFT_BIN = '/usr/sbin/nft';
// root reports at most this many sources (the busiest first)
export const MAX_REPORTED = 5000;

export function guardUnit(action: GuardAction): string {
  return `${GUARD_UNIT_PREFIX}${action}.service`;
}

export function parseGuardAction(v: string): GuardAction {
  if (!(GUARD_ACTIONS as readonly string[]).includes(v)) throw new HarborError('INVALID_REQUEST', `guard-step expects one of ${GUARD_ACTIONS.join(', ')}, got ${v}`);
  return v as GuardAction;
}

export function guardFiles(stateDir: string): { dir: string; request: string; status: string } {
  const dir = path.join(stateDir, 'guard');
  return { dir, request: path.join(dir, 'request.json'), status: path.join(dir, 'status.json') };
}

export interface GuardRequest {
  action: GuardAction;
  state?: GuardState;
  requestedAt: string;
}

export interface GuardReport {
  // Harbor's table is in the kernel
  loaded: boolean;
  // entries in the loaded allowed list
  allowed: number;
  // dropped sources, busiest first
  seen: SeenSource[];
}

export interface GuardStatusFile {
  action: GuardAction;
  state: 'ok' | 'failed';
  message: string;
  nextAction?: string;
  report?: GuardReport;
  at: string;
}

export function parseGuardStatus(raw: string): GuardStatusFile | null {
  try {
    const d = JSON.parse(raw) as GuardStatusFile;
    if (!d || typeof d !== 'object' || (d.state !== 'ok' && d.state !== 'failed') || typeof d.message !== 'string') return null;
    if (d.report) {
      d.report = {
        loaded: d.report.loaded === true,
        allowed: Number(d.report.allowed) || 0,
        seen: (Array.isArray(d.report.seen) ? d.report.seen : [])
          .slice(0, MAX_REPORTED)
          .filter((s) => s && typeof s.address === 'string' && canonicalAddress(s.address) === s.address && Number.isFinite(s.packets) && Number.isFinite(s.idleSeconds)),
      };
    }
    return d;
  } catch {
    return null;
  }
}

export interface GuardProvider {
  readonly kind: 'fake' | 'root';
  available(): { ok: boolean; reason: string | null };
  apply(state: GuardState): Promise<GuardReport>;
  off(): Promise<GuardReport>;
  status(): Promise<GuardReport>;
}

// ---------------------------------------------------------------- fake

export class FakeGuardProvider implements GuardProvider {
  readonly kind = 'fake' as const;
  calls: GuardAction[] = [];
  state: GuardState | null = null;
  failWith: string | null = null;
  // what the kernel counted: tests (and `pnpm dev`) add drops with drop()
  private counters = new Map<string, { packets: number; at: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  available() {
    return { ok: true, reason: null };
  }
  private fail(): void {
    if (this.failWith) throw new HarborError('OPERATION_FAILED', this.failWith, { nextAction: 'Check the journal of harbor-guard@apply.service, then try again.' });
  }
  // a source hit the guard (only counted while it is loaded, like the kernel)
  drop(address: string, packets = 1): void {
    if (!this.state) return;
    const a = canonicalAddress(address);
    if (!a) throw new Error(`not an address: ${address}`);
    const c = this.counters.get(a) ?? { packets: 0, at: 0 };
    this.counters.set(a, { packets: c.packets + packets, at: this.now() });
  }
  private report(): GuardReport {
    const seen = [...this.counters.entries()].map(([address, c]) => ({ address, packets: c.packets, idleSeconds: Math.max(0, Math.floor((this.now() - c.at) / 1000)) })).sort((a, b) => b.packets - a.packets);
    return { loaded: this.state !== null, allowed: this.state?.allow.length ?? 0, seen };
  }
  async apply(state: GuardState): Promise<GuardReport> {
    this.calls.push('apply');
    this.fail();
    this.state = validateGuardState(state);
    // the kernel's table is recreated: its counters start again
    this.counters.clear();
    return this.report();
  }
  async off(): Promise<GuardReport> {
    this.calls.push('off');
    this.fail();
    this.state = null;
    this.counters.clear();
    return this.report();
  }
  async status(): Promise<GuardReport> {
    this.calls.push('status');
    return this.report();
  }
}

// ---------------------------------------------------------------- live

const TIMEOUTS: Record<GuardAction, number> = { apply: 60_000, off: 60_000, status: 30_000 };

export class RootGuardProvider implements GuardProvider {
  readonly kind = 'root' as const;
  constructor(
    private readonly stateDir: string,
    private readonly startUnit: UnitStarter = systemctlStartBlocking,
  ) {}

  available() {
    if (!existsSync(GUARD_NFT_BIN)) return { ok: false, reason: 'nftables is not installed on this machine. Re-run bootstrap (or update Harbor) so it installs it, or run: sudo apt-get install -y nftables' };
    return { ok: true, reason: null };
  }

  private async run(action: GuardAction, state?: GuardState): Promise<GuardReport> {
    const files = guardFiles(this.stateDir);
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    rmSync(files.status, { force: true });
    const request: GuardRequest = { action, ...(state ? { state } : {}), requestedAt: new Date().toISOString() };
    writeFileSync(files.request, JSON.stringify(request), { mode: 0o600 });
    const unit = guardUnit(action);
    let unitError: string | null = null;
    try {
      await this.startUnit(unit, TIMEOUTS[action]).catch((e: Error) => {
        unitError = e.message;
      });
      let raw: string | null;
      try {
        raw = readFileSync(files.status, 'utf8');
      } catch {
        raw = null;
      }
      const status = raw ? parseGuardStatus(raw) : null;
      if (status?.state === 'ok' && status.report) return status.report;
      if (status?.state === 'failed') throw new HarborError('OPERATION_FAILED', status.message, { nextAction: status.nextAction ?? `On the machine, run: journalctl -u ${unit} --no-pager -n 50` });
      throw new HarborError('OPERATION_FAILED', `${unit} gave no verdict${unitError ? ` (${unitError})` : ''}`, {
        nextAction: `On the machine, run: journalctl -u ${unit} --no-pager -n 50 — and check that Harbor's polkit rule and units are installed (re-run bootstrap or update Harbor if not).`,
      });
    } finally {
      rmSync(files.request, { force: true });
    }
  }

  apply(state: GuardState): Promise<GuardReport> {
    return this.run('apply', state);
  }
  off(): Promise<GuardReport> {
    return this.run('off');
  }
  status(): Promise<GuardReport> {
    return this.run('status');
  }
}
