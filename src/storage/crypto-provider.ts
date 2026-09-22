// Per-app kernel sealing provider: the daemon-side half of fscrypt.
//
// The daemon (harbor user) never runs fscrypt (keyring + policy ioctls need
// root; even `fscrypt status` reads 0600 policy files). Every mutation goes
// through the polkit-allowed `harbor-app-crypto@<instanceId>:<action>`
// oneshot: the daemon writes a request file (never the key), streams the
// master key through a FIFO (never on disk), blocks on `systemctl start`,
// and reads the root step's verdict back. Failures are HARD: the caller's
// operation fails with the root step's message and next action — Harbor
// never logs "sealing skipped" and continues unsealed.
//
// The read model needs no root at all: creating anything inside a locked
// fscrypt directory fails with ENOKEY, so a mkdir probe inside
// <home>/volumes tells locked from open with kernel truth (survives daemon
// restarts, manual locks and reboots alike).
//
// In fake mode (tests, dev, CI on macOS) there is no fscrypt and no systemd:
// the fake keeps the kernel's would-be state in memory (which homes are
// sealed, which are unlocked this "boot") so the engine path — install
// seals, Start unlocks, Lock evicts, a restart returns to locked — is
// exercised end to end without hardware.
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, writeFileSync, writeSync } from 'node:fs';
import { HarborError } from '../errors.js';
import { appCryptoFiles, appCryptoUnit, isEnokey, parseAppCryptoStatus, protectorNameFor, sealedDir, type AppCryptoAction, type AppCryptoRequest } from './fscrypt.js';

export interface AppHomeRef {
  instanceId: string;
  home: string;
}

// What the kernel says about <home>/volumes right now: 'locked' = sealed
// and no key (ENOKEY on any open/create); 'open' = readable (unlocked, or
// never sealed — the caller knows which from the recorded resource).
export type KernelState = 'locked' | 'open';

export interface CryptoProvider {
  // Seal an EMPTY <home>/volumes under the app's master key (install time).
  sealApp(ref: AppHomeRef, masterKeyHex: string, protectorName: string): Promise<void>;
  // Seal a <home>/volumes that already holds plaintext data (installed
  // before sealing worked): seal-empty + copy-back, verified, rolled back on
  // failure. Leaves the dir unlocked.
  migrateApp(ref: AppHomeRef, masterKeyHex: string, protectorName: string): Promise<void>;
  // Add the key to the kernel (idempotent when already unlocked).
  unlockApp(ref: AppHomeRef, masterKeyHex: string): Promise<void>;
  // Evict the key (refuses while files are open — stop the app first).
  lockApp(ref: AppHomeRef): Promise<void>;
  // Root's view of the dir (fscrypt status): used where the recorded state
  // is unknown, e.g. a home adopted from another machine.
  statusApp(ref: AppHomeRef): Promise<{ encrypted: boolean; unlocked: boolean }>;
  // Cheap kernel probe for the read model (no root, no spawn).
  kernelState(home: string): KernelState;
}

export function protectorFor(instanceName: string, instanceId: string): string {
  return protectorNameFor(instanceName, instanceId);
}

// Kernel truth without root: mkdir inside a locked fscrypt dir → ENOKEY.
// Any other outcome (created → removed again, EEXIST, ENOENT because the
// drive is gone, EACCES) reads as 'open': the sealed/unsealed distinction
// comes from the recorded resource, the drive presence from the drive guard.
export function probeKernelState(home: string): KernelState {
  const probe = `${sealedDir(home)}/.harbor-key-probe-${process.pid}`;
  try {
    mkdirSync(probe, { mode: 0o700 });
  } catch (e) {
    if (isEnokey(e)) return 'locked';
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        rmdirSync(probe);
      } catch {
        /* leave it */
      }
    }
    return 'open';
  }
  try {
    rmdirSync(probe);
  } catch {
    /* harmless leftover, retried next probe */
  }
  return 'open';
}

// ---------------------------------------------------------------- fake

export class FakeCryptoProvider implements CryptoProvider {
  calls: { op: string; home: string }[] = [];
  // Homes sealed by this provider (the on-disk truth would persist; the fake
  // forgets on restart, but the daemon's recorded `kernelSealed` flag is what
  // the read model consults, so a restart still reads as locked).
  readonly sealed = new Set<string>();
  // Homes whose key is "in the kernel" this boot.
  readonly open = new Set<string>();
  // Flip to simulate a host that cannot seal (unit tests for the hard failure).
  failWith: string | null = null;
  private fail(): void {
    if (this.failWith) throw new HarborError('OPERATION_FAILED', this.failWith, { nextAction: 'Format the drive as ext4 in Settings → Storage (Harbor enables encryption at format time), then try again.' });
  }
  async sealApp(ref: AppHomeRef, _masterKeyHex: string, _protectorName: string): Promise<void> {
    this.calls.push({ op: 'sealApp', home: ref.home });
    this.fail();
    this.sealed.add(ref.home);
    this.open.add(ref.home);
  }
  async migrateApp(ref: AppHomeRef, _masterKeyHex: string, _protectorName: string): Promise<void> {
    this.calls.push({ op: 'migrateApp', home: ref.home });
    this.fail();
    this.sealed.add(ref.home);
    this.open.add(ref.home);
  }
  async unlockApp(ref: AppHomeRef, _masterKeyHex: string): Promise<void> {
    this.calls.push({ op: 'unlockApp', home: ref.home });
    this.fail();
    this.open.add(ref.home);
  }
  async lockApp(ref: AppHomeRef): Promise<void> {
    this.calls.push({ op: 'lockApp', home: ref.home });
    this.fail();
    this.open.delete(ref.home);
  }
  async statusApp(ref: AppHomeRef): Promise<{ encrypted: boolean; unlocked: boolean }> {
    this.calls.push({ op: 'statusApp', home: ref.home });
    return { encrypted: this.sealed.has(ref.home), unlocked: this.open.has(ref.home) };
  }
  kernelState(home: string): KernelState {
    return this.open.has(home) ? 'open' : 'locked';
  }
}

// ---------------------------------------------------------------- live

// `systemctl start <unit>` WITHOUT --no-block: returns when the oneshot
// finished, non-zero when it failed. polkit allows the harbor user to start
// harbor-app-crypto@* (bootstrap rule); no root, no prompt.
export function systemctlStartBlocking(unit: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/systemctl', ['start', unit], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${unit} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 64 * 1024) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `systemctl start ${unit} exited ${code}`));
    });
  });
}

function mkfifo(p: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/mkfifo', ['-m', '600', p], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `mkfifo exited ${code}`))));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type UnitStarter = (unit: string, timeoutMs: number) => Promise<void>;

const TIMEOUTS: Record<AppCryptoAction, number> = {
  setup: 5 * 60_000,
  seal: 5 * 60_000,
  unlock: 3 * 60_000,
  lock: 3 * 60_000,
  status: 60_000,
  // In-place migration copies the whole app; bounded by the data, not by us.
  migrate: 24 * 60 * 60_000,
};

export class RootCryptoProvider implements CryptoProvider {
  constructor(
    private readonly stateDir: string,
    private readonly startUnit: UnitStarter = systemctlStartBlocking,
  ) {}

  private async run(ref: AppHomeRef, action: AppCryptoAction, extra: { protectorName?: string; keyHex?: string } = {}): Promise<{ encrypted: boolean; unlocked: boolean }> {
    const files = appCryptoFiles(this.stateDir, ref.instanceId);
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    rmSync(files.status, { force: true });
    rmSync(files.fifo, { force: true });
    const request: AppCryptoRequest = { action, home: ref.home, ...(extra.protectorName ? { protectorName: extra.protectorName } : {}), requestedAt: new Date().toISOString() };
    writeFileSync(files.request, JSON.stringify(request), { mode: 0o600 });
    const unit = appCryptoUnit(ref.instanceId, action);
    let unitError: string | null = null;
    try {
      if (extra.keyHex !== undefined) await mkfifo(files.fifo);
      let done = false;
      const started = this.startUnit(unit, TIMEOUTS[action])
        .catch((e: Error) => {
          unitError = e.message;
        })
        .finally(() => {
          done = true;
        });
      if (extra.keyHex !== undefined) {
        // Hand the key over once the root step opens the read side (ENXIO
        // until then). Stop trying the moment the unit ends: a step that
        // failed validation never reads the key, and its status says why.
        const keyHex = extra.keyHex;
        while (!done) {
          let fd: number | null = null;
          try {
            fd = openSync(files.fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENXIO') {
              unitError ??= `cannot hand over the key: ${(e as Error).message}`;
              break;
            }
            await sleep(50);
            continue;
          }
          try {
            writeSync(fd, `${keyHex}\n`);
          } finally {
            closeSync(fd);
          }
          break;
        }
      }
      await started;
      let raw: string | null = null;
      try {
        raw = readFileSync(files.status, 'utf8');
      } catch {
        raw = null;
      }
      const status = raw ? parseAppCryptoStatus(raw) : null;
      if (status && status.state === 'ok') return { encrypted: status.encrypted ?? false, unlocked: status.unlocked ?? false };
      if (status && status.state === 'failed') {
        throw new HarborError('OPERATION_FAILED', `${action} of ${ref.home} failed: ${status.message}`, { nextAction: status.nextAction ?? 'Check the app folder and the drive, then try again.' });
      }
      throw new HarborError('OPERATION_FAILED', `${action} of ${ref.home} gave no verdict${unitError ? ` (${unitError})` : ''}`, {
        nextAction: `On the machine, run: journalctl -u ${unit} --no-pager -n 50 — and check that Harbor's polkit rule and units are installed (re-run bootstrap if not).`,
      });
    } finally {
      rmSync(files.request, { force: true });
      rmSync(files.fifo, { force: true });
    }
  }

  async sealApp(ref: AppHomeRef, masterKeyHex: string, protectorName: string): Promise<void> {
    const r = await this.run(ref, 'seal', { protectorName, keyHex: masterKeyHex });
    if (!r.encrypted || !r.unlocked) throw new HarborError('OPERATION_FAILED', `${ref.home}/volumes is not sealed and unlocked after seal`);
  }
  async migrateApp(ref: AppHomeRef, masterKeyHex: string, protectorName: string): Promise<void> {
    const r = await this.run(ref, 'migrate', { protectorName, keyHex: masterKeyHex });
    if (!r.encrypted || !r.unlocked) throw new HarborError('OPERATION_FAILED', `${ref.home}/volumes is not sealed and unlocked after migration`);
  }
  async unlockApp(ref: AppHomeRef, masterKeyHex: string): Promise<void> {
    const r = await this.run(ref, 'unlock', { keyHex: masterKeyHex });
    if (!r.unlocked) throw new HarborError('OPERATION_FAILED', `${ref.home}/volumes is still locked after unlock`);
  }
  async lockApp(ref: AppHomeRef): Promise<void> {
    const r = await this.run(ref, 'lock');
    if (r.unlocked) throw new HarborError('INVALID_STATE', `${ref.home}/volumes is still readable after lock`, { nextAction: 'Stop the app, then lock again.' });
  }
  async statusApp(ref: AppHomeRef): Promise<{ encrypted: boolean; unlocked: boolean }> {
    return this.run(ref, 'status');
  }
  kernelState(home: string): KernelState {
    return probeKernelState(home);
  }
}
