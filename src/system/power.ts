import { spawn } from 'node:child_process';
import { HarborError } from '../errors.js';

// Restart / shut down the machine from the console. The daemon runs as the unprivileged `harbor`
// user; bootstrap installs a polkit rule that lets exactly that user ask logind for reboot/power-off,
// so `systemctl` works without root and without widening the unit's hardening.
export interface PowerControl {
  readonly description: string;
  available(): Promise<{ ok: boolean; note: string | null }>;
  reboot(): Promise<void>;
  powerOff(): Promise<void>;
}

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => (clearTimeout(t), reject(e)));
    child.on('close', (code) => (clearTimeout(t), resolve({ code, stdout, stderr })));
  });
}

export class SystemdPower implements PowerControl {
  readonly description = 'systemctl via logind (polkit rule from bootstrap)';
  constructor(private readonly systemctl = '/usr/bin/systemctl') {}
  async available(): Promise<{ ok: boolean; note: string | null }> {
    // `systemctl is-system-running` needs no privilege; the polkit rule is what makes reboot allowed.
    const r = await run(this.systemctl, ['is-system-running']).catch(() => null);
    if (!r) return { ok: false, note: 'systemctl is not available on this machine' };
    return { ok: true, note: null };
  }
  async reboot(): Promise<void> {
    await this.action('reboot');
  }
  async powerOff(): Promise<void> {
    await this.action('poweroff');
  }
  private async action(a: 'reboot' | 'poweroff'): Promise<void> {
    const r = await run(this.systemctl, [a]);
    if (r.code !== 0) {
      const denied = /interactive authentication required|access denied|not authorized|permission/i.test(r.stderr);
      throw new HarborError('OPERATION_FAILED', `${a === 'reboot' ? 'restart' : 'shutdown'} was refused: ${r.stderr.trim() || `exit ${r.code}`}`, {
        nextAction: denied ? 'Harbor is not allowed to power this machine yet. Re-run `sudo /opt/harbor/bin/harbor bootstrap --yes` once; it installs the permission (a polkit rule for the harbor user).' : 'Check `journalctl -u harbor` on the machine.',
      });
    }
  }
}

export class FakePower implements PowerControl {
  readonly description = 'fake power control';
  calls: ('reboot' | 'poweroff')[] = [];
  allowed = true;
  async available() {
    return { ok: this.allowed, note: this.allowed ? null : 'fake: not allowed' };
  }
  async reboot() {
    this.calls.push('reboot');
  }
  async powerOff() {
    this.calls.push('poweroff');
  }
}
