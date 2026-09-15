import { spawn, type ChildProcess } from 'node:child_process';
import { HarborError } from '../errors.js';
import type { Logger } from '../lifecycle/context.js';

// A terminal on the machine, for the console's Advanced access page. The shell runs as the Harbor
// service account (Docker access, harbor CLI), inside the daemon's own sandbox. A tiny Python bridge
// owns the pseudo-terminal so no native module is needed: stdin/stdout carry bytes, fd 3 carries resizes.
const BRIDGE = String.raw`
import os, pty, sys, fcntl, termios, struct, select, signal, shlex
shell = sys.argv[1:] or ["/bin/bash", "-il"]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell[0], shell)
ctl = 3
def resize(cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
buf = b""
try:
    while True:
        r, _, _ = select.select([fd, 0, ctl], [], [])
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
        if ctl in r:
            data = os.read(ctl, 4096)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                parts = line.decode().split()
                if len(parts) == 3 and parts[0] == "resize":
                    resize(int(parts[1]), int(parts[2]))
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
`;

export interface TerminalOptions {
  shell?: string[];
  env?: Record<string, string>;
  cwd?: string;
  cols?: number;
  rows?: number;
  idleMs?: number;
}

export class TerminalSession {
  private readonly child: ChildProcess;
  private idle: NodeJS.Timeout | null = null;
  closed = false;
  constructor(
    opts: TerminalOptions,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onExit: (code: number | null, reason: string) => void,
    private readonly log: Logger,
  ) {
    const shell = opts.shell ?? ['/bin/bash', '-il'];
    this.child = spawn('python3', ['-c', BRIDGE, ...shell], { cwd: opts.cwd, env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: '/opt/harbor/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...(opts.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.touch(opts.idleMs);
      onData(d);
    });
    this.child.stderr!.on('data', (d: Buffer) => onData(d));
    this.child.on('error', (e) => this.finish(null, `could not start the terminal: ${e.message}`));
    this.child.on('close', (code) => this.finish(code, 'the shell exited'));
    if (opts.cols && opts.rows) this.resize(opts.cols, opts.rows);
    this.touch(opts.idleMs);
  }
  private touch(idleMs = 30 * 60_000): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close('closed after 30 minutes without activity'), idleMs);
    this.idle.unref?.();
  }
  write(data: string | Buffer): void {
    if (this.closed) return;
    this.touch();
    this.child.stdin!.write(data);
  }
  resize(cols: number, rows: number): void {
    if (this.closed) return;
    const c = Math.max(2, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(200, Math.floor(rows)));
    (this.child.stdio[3] as NodeJS.WritableStream | null)?.write(`resize ${c} ${r}\n`);
  }
  close(reason = 'closed'): void {
    if (this.closed) return;
    this.child.kill('SIGHUP');
    setTimeout(() => this.child.kill('SIGKILL'), 3000).unref?.();
    this.finish(null, reason);
  }
  private finish(code: number | null, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    this.log.info('terminal closed', { reason, code });
    this.onExit(code, reason);
  }
}

export class TerminalService {
  private readonly open = new Set<TerminalSession>();
  constructor(
    private readonly log: Logger,
    private readonly defaults: TerminalOptions,
    private readonly max = 4,
  ) {}
  start(opts: { cols: number; rows: number }, onData: (chunk: Buffer) => void, onExit: (code: number | null, reason: string) => void): TerminalSession {
    if (this.open.size >= this.max) throw new HarborError('BUSY', `at most ${this.max} terminals may be open at once`, { nextAction: 'Close another terminal tab first.' });
    const s = new TerminalSession({ ...this.defaults, ...opts }, onData, (code, reason) => {
      this.open.delete(s);
      onExit(code, reason);
    }, this.log);
    this.open.add(s);
    this.log.info('terminal opened', { open: this.open.size });
    return s;
  }
  count(): number {
    return this.open.size;
  }
  closeAll(): void {
    for (const s of [...this.open]) s.close('daemon stopping');
  }
}
