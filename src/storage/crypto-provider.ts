// Per-app kernel sealing provider: the daemon-side half of fscrypt.
// The daemon (harbor user) never runs fscrypt itself (needs root keyring +
// policy ioctls). Instead it shells out to the polkit-allowed root helpers
// (`harbor app-seal|app-unlock|app-lock`, `harbor device-crypto-setup`) via
// the same template-unit starter as mount/format, or direct spawn when the
// caller is already root (bootstrap/VM qualification).
//
// In fake mode (tests, dev, CI on macOS) there is no fscrypt and no systemd:
// every method degrades to a recorded no-op so the engine path (manifest,
// dual-key, lock model, volume rooting) stays exercisable without hardware.
// `sealed` in the result marks whether the kernel actually sealed.
import { spawn } from 'node:child_process';
import { HarborError } from '../errors.js';
import { protectorNameFor, sealedDir } from '../storage/fscrypt.js';

export interface SealResult {
  sealed: boolean;
  message: string;
}

export interface CryptoProvider {
  setupDrive(mountpoint: string, deviceName: string): Promise<SealResult>;
  sealApp(home: string, masterKeyHex: string, protectorName: string): Promise<SealResult>;
  unlockApp(home: string, masterKeyHex: string): Promise<SealResult>;
  lockApp(home: string): Promise<SealResult>;
  statusApp(home: string): Promise<{ encrypted: boolean; unlocked: boolean }>;
}

function runRootHelper(file: string, args: string[], opts: { input?: string | undefined; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 512 * 1024) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 512 * 1024) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new HarborError('OPERATION_FAILED', `cannot run ${file}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

// Fake-mode provider: records calls, seals nothing. The engine path above it
// (manifest, envelopes, lock model) is fully exercised; kernel sealing is
// proven only on live hardware (VM qualification).
export class FakeCryptoProvider implements CryptoProvider {
  calls: { op: string; home?: string; mountpoint?: string }[] = [];
  // Flip to simulate a host without fscrypt (unit tests for the fallback).
  failWith: string | null = null;
  private fail(): SealResult | null {
    return this.failWith ? { sealed: false, message: this.failWith } : null;
  }
  async setupDrive(mountpoint: string, _deviceName?: string): Promise<SealResult> {
    this.calls.push({ op: 'setupDrive', mountpoint });
    return this.fail() ?? { sealed: false, message: `encryption setup skipped in fake mode (${mountpoint})` };
  }
  async sealApp(home: string, _masterKeyHex?: string, _protectorName?: string): Promise<SealResult> {
    this.calls.push({ op: 'sealApp', home });
    return this.fail() ?? { sealed: false, message: `seal skipped in fake mode (${sealedDir(home)})` };
  }
  async unlockApp(home: string, _masterKeyHex?: string): Promise<SealResult> {
    this.calls.push({ op: 'unlockApp', home });
    return this.fail() ?? { sealed: false, message: `unlock skipped in fake mode (${sealedDir(home)})` };
  }
  async lockApp(home: string): Promise<SealResult> {
    this.calls.push({ op: 'lockApp', home });
    return this.fail() ?? { sealed: false, message: `lock skipped in fake mode (${sealedDir(home)})` };
  }
  async statusApp(home: string): Promise<{ encrypted: boolean; unlocked: boolean }> {
    this.calls.push({ op: 'statusApp', home });
    return { encrypted: false, unlocked: true };
  }
}

// Live provider: root helpers via the harbor CLI on PATH (release layout:
// /opt/harbor/bin/harbor). Falls back to `sudo -n` refusal semantics — never
// prompts: if the helper cannot run, the install fails with a next action,
// not a hang.
export class RootCryptoProvider implements CryptoProvider {
  constructor(
    private readonly harborBin: string = '/opt/harbor/bin/harbor',
    private readonly unitStarter: ((unit: string) => Promise<void>) | null = null,
  ) {}
  private async helper(args: string[], input?: string): Promise<SealResult> {
    const r = await runRootHelper(this.harborBin, args, { input, timeoutMs: 120_000 });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ') || `exit ${r.code}`;
      throw new HarborError('OPERATION_FAILED', `${this.harborBin} ${args[0]} failed: ${msg}`, {
        nextAction: 'Check that fscrypt is installed and the drive was formatted as ext4 with encryption (Settings → Storage).',
      });
    }
    return { sealed: true, message: (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? 'ok' };
  }
  async setupDrive(_mountpoint: string, deviceName: string): Promise<SealResult> {
    if (this.unitStarter) {
      await this.unitStarter(`harbor-device-mount@${deviceName}:crypto-setup.service`);
      return { sealed: true, message: 'encryption setup started (poll device status)' };
    }
    return this.helper(['device-crypto-setup', deviceName]);
  }
  async sealApp(home: string, masterKeyHex: string, protectorName: string): Promise<SealResult> {
    return this.helper(['app-seal', home, protectorName], masterKeyHex);
  }
  async unlockApp(home: string, masterKeyHex: string): Promise<SealResult> {
    return this.helper(['app-unlock', home], masterKeyHex);
  }
  async lockApp(home: string): Promise<SealResult> {
    return this.helper(['app-lock', home]);
  }
  async statusApp(home: string): Promise<{ encrypted: boolean; unlocked: boolean }> {
    const r = await runRootHelper('/usr/bin/fscrypt', ['status', sealedDir(home)], { timeoutMs: 30_000 });
    if (r.code !== 0) return { encrypted: false, unlocked: true };
    const text = r.stdout.toLowerCase();
    return { encrypted: /is encrypted with fscrypt/.test(text), unlocked: /unlocked:\s*yes/.test(text) };
  }
}

export function protectorFor(instanceName: string, instanceId: string): string {
  return protectorNameFor(instanceName, instanceId);
}
