import { spawn } from 'node:child_process';
import { HarborError } from '../errors.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 512 * 1024;

// Spawn an approved executable with an argument array, explicit environment, timeout and bounded
// output. Never shell: true. Used only by bootstrap (root) for OS/package/systemd actions.
export function exec(file: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd ?? '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive', ...(opts.env ?? {}) },
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new HarborError('OPERATION_FAILED', `cannot run ${file}: ${e.message}`));
    });
    // A kill by our own timeout surfaces as code null (SIGTERM/SIGKILL): report
    // it as a timeout with the command name, not a bare "(exit null)" — the
    // device-format status row is the only UI for a wedged USB stick.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === null) {
        reject(new HarborError('OPERATION_FAILED', `${file} ${args.join(' ')} timed out${signal ? ` (${signal})` : ''} after ${opts.timeoutMs ?? 120_000}ms`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin!.end(opts.input);
    }
  });
}

export async function execOk(file: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<ExecResult> {
  const r = await exec(file, args, opts);
  if (r.code !== 0) {
    throw new HarborError('OPERATION_FAILED', `${file} ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-5).join(' | ') || r.stdout.trim().slice(-400)}`);
  }
  return r;
}

// apt-get with retries around the dpkg frontend lock: Ubuntu's unattended-upgrades
// routinely holds it on a fresh boot, and failing the whole bootstrap for that is wrong.
// Only lock contention (exit 100 + lock message) is retried; real failures throw immediately.
// `waits` is injectable for tests (unit default keeps CI fast).
export async function aptGet(log: (m: string) => void, args: string[], opts: { timeoutMs?: number; waits?: number[]; run?: typeof exec } = {}): Promise<ExecResult> {
  const waits = opts.waits ?? [15_000, 30_000, 60_000, 120_000];
  const run = opts.run ?? exec;
  for (let attempt = 0; ; attempt++) {
    const r = await run('/usr/bin/apt-get', args, { timeoutMs: opts.timeoutMs ?? 20 * 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
    if (r.code === 0) return r;
    const locked = r.code === 100 && /lock|unattended-upgr|dpkg.*busy|another process/i.test(r.stderr + r.stdout);
    if (!locked || attempt >= waits.length) {
      throw new HarborError('OPERATION_FAILED', `/usr/bin/apt-get ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim().split('\n').slice(-5).join(' | ') || r.stdout.trim().slice(-400)}`);
    }
    const waitMs = waits[attempt]!;
    log(`apt is locked by another process (unattended upgrades?); waiting ${Math.round(waitMs / 1000)}s and retrying (${attempt + 1}/${waits.length})`);
    await new Promise((r2) => setTimeout(r2, waitMs));
  }
}

export async function which(name: string): Promise<string | null> {
  for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    const p = `${dir}/${name}`;
    try {
      const { accessSync, constants } = await import('node:fs');
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

// Plain GET without fetch's Sec-Fetch-* headers (Caddy's admin API rejects those without an Origin).
export function httpGetStatus(host: string, port: number, path: string, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(0));
      req.end();
    });
  });
}
