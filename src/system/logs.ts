import { spawn } from 'node:child_process';

// Logs for the Troubleshoot page. The daemon keeps its own recent log lines in memory (works everywhere,
// including the fake dev loop); on a systemd host the journal has the full history across restarts.
export class LogBuffer {
  private readonly lines: string[] = [];
  constructor(private readonly max = 3000) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
  tail(n: number): string[] {
    return this.lines.slice(-n);
  }
}

export async function journalTail(unit: string, lines: number, bin = '/usr/bin/journalctl'): Promise<string[] | null> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso', '--no-hostname'], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const t = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => (clearTimeout(t), resolve(null)));
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0 || !out.trim()) return resolve(null);
      resolve(out.trimEnd().split('\n').filter((l) => !/^-- (Logs begin|No entries)/.test(l)));
    });
  });
}

// Docker's multiplexed log stream (8-byte frame headers) → plain lines. A TTY container streams raw text.
export function demuxDockerLogs(buf: Buffer): string {
  if (buf.length < 8) return buf.toString('utf8');
  const first = buf[0]!;
  if (!(first === 0 || first === 1 || first === 2) || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) return buf.toString('utf8');
  let p = 0;
  let out = '';
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p + 4);
    out += buf.subarray(p + 8, p + 8 + len).toString('utf8');
    p += 8 + len;
  }
  return out;
}
