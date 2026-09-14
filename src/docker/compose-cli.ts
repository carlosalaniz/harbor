import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ComposeError, type ComposeInvocation, type ComposeResult, type ComposeRunner } from './adapter.js';

const MAX_OUTPUT = 256 * 1024;

export interface ComposeCliOptions {
  dockerBinary: string; // absolute path, e.g. /usr/bin/docker
  socketPath: string;
  configDir: string; // private DOCKER_CONFIG so no ambient contexts/credentials apply
  // Extra CLI plugin directories (e.g. ~/.docker/cli-plugins on Docker Desktop). Ubuntu's
  // docker-compose-plugin installs system-wide and needs nothing here.
  pluginDirs?: string[];
}

// Spawns `docker compose` with an argument array, fixed cwd, explicit scrubbed environment,
// timeout and bounded output. Never shell: true.
export class ComposeCli implements ComposeRunner {
  readonly description: string;

  constructor(private readonly opts: ComposeCliOptions) {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
    // The private config holds nothing but the explicit plugin search path: no contexts, no credentials.
    writeFileSync(path.join(opts.configDir, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: opts.pluginDirs ?? [] }), { mode: 0o600 });
    this.description = `${opts.dockerBinary} compose (unix://${opts.socketPath})`;
  }

  private env(): NodeJS.ProcessEnv {
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: this.opts.configDir,
      DOCKER_HOST: `unix://${this.opts.socketPath}`,
      DOCKER_CONFIG: this.opts.configDir,
      DOCKER_CLI_HINTS: 'false',
      COMPOSE_PROJECT_NAME: '',
      LANG: 'C.UTF-8',
    };
  }

  private run(args: string[], cwd: string, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<ComposeResult & { exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.dockerBinary, args, {
        cwd,
        env: { ...this.env(), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: false,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ComposeError(`cannot spawn ${this.opts.dockerBinary}: ${e.message}`, { command: args, exitCode: null, stderrTail: '', timedOut: false }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut });
      });
    });
  }

  private async compose(inv: ComposeInvocation, sub: string[], timeoutMs: number): Promise<ComposeResult> {
    const args = ['compose', '--project-directory', inv.projectDir, '--project-name', inv.projectName, '--file', inv.file, ...sub];
    const r = await this.run(args, inv.projectDir, timeoutMs, { COMPOSE_PROJECT_NAME: inv.projectName });
    if (r.timedOut) throw new ComposeError(`docker compose ${sub[0]} timed out after ${Math.round(timeoutMs / 1000)}s`, { command: args, exitCode: r.exitCode, stderrTail: tail(r.stderr), timedOut: true });
    if (r.exitCode !== 0) throw new ComposeError(`docker compose ${sub[0]} failed (exit ${r.exitCode}): ${tail(r.stderr, 400)}`, { command: args, exitCode: r.exitCode, stderrTail: tail(r.stderr), timedOut: false });
    return { stdout: r.stdout, stderr: r.stderr };
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.run(['compose', 'version', '--short'], path.dirname(this.opts.configDir), 15_000);
      return r.exitCode === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async config(inv: ComposeInvocation, timeoutMs: number): Promise<string> {
    // --no-interpolate is deliberately NOT used: we want Compose to apply its real semantics to the
    // file we generated (with `$$` escapes), exactly as `up` will.
    const r = await this.compose(inv, ['config', '--no-path-resolution'], timeoutMs);
    return r.stdout;
  }

  pull(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult> {
    return this.compose(inv, ['pull', '--quiet', '--policy', 'missing'], timeoutMs);
  }

  up(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult> {
    // No --remove-orphans, no --renew-anon-volumes, no --force-recreate: nothing outside this
    // project is touched, and existing data is never discarded.
    return this.compose(inv, ['up', '--detach', '--no-build', '--pull', 'never', '--quiet-pull', '--wait', '--wait-timeout', String(Math.max(1, Math.floor(timeoutMs / 1000) - 5))], timeoutMs);
  }

  start(inv: ComposeInvocation, timeoutMs: number): Promise<ComposeResult> {
    return this.compose(inv, ['start'], timeoutMs);
  }
}

function tail(s: string, n = 2000): string {
  return s.length > n ? s.slice(-n) : s;
}
