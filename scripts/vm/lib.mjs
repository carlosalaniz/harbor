// Shared helpers for the live VM suite: the designated target (DigitalOcean droplet or Vagrant VM),
// SSH execution, loopback port tunnels, the Harbor CLI over SSH, and evidence recording.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function fail(msg, code = 2) {
  console.error(`test:vm: ${msg}`);
  process.exit(code);
}

// ---------------- targets

export function resolveTarget() {
  const mode = process.env.HARBOR_VM_TARGET ?? (existsSync(path.join(ROOT, '.vm.local.json')) ? 'digitalocean' : null);
  if (mode === 'digitalocean') return new DigitalOceanTarget();
  if (mode === 'vagrant') return new VagrantTarget();
  fail(
    [
      'no designated test VM.',
      'Prerequisites: either',
      '  (a) DigitalOcean: cp .env.example .env.vm.local, set DIGITALOCEAN_TOKEN, then `node scripts/vm/do-vm.mjs create`; or',
      '  (b) Vagrant: `vagrant up` in this directory and HARBOR_VM_TARGET=vagrant.',
      'The live suite never runs against an unspecified "current Docker host".',
    ].join('\n'),
    4,
  );
}

class SshTarget {
  constructor(name, sshBase, hostForTunnels) {
    this.name = name;
    this.sshBase = sshBase; // argv prefix up to (not including) the remote command
    this.hostForTunnels = hostForTunnels;
  }
  ssh(command, opts = {}) {
    // A failure *before* the remote command starts (banner exchange / TCP connect) is safe to retry
    // even for mutating commands; DigitalOcean droplets occasionally drop the first SSH attempt.
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(this.sshBase[0], [...this.sshBase.slice(1), command], { encoding: 'utf8', timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024, input: opts.input });
      const stderr = (r.stderr ?? '').replace(/^tar: Ignoring unknown extended header keyword.*\n/gm, '');
      const preCommandFailure = r.status === 255 && /timed out during banner exchange|Connection timed out|Connection refused|kex_exchange_identification/.test(stderr);
      if (preCommandFailure && attempt < 4) {
        spawnSync('sleep', [String(5 * attempt)]);
        continue;
      }
      return { code: r.status, stdout: r.stdout ?? '', stderr };
    }
  }
  sshOk(command, opts = {}) {
    const r = this.ssh(command, opts);
    if (r.code !== 0) throw new Error(`ssh command failed (exit ${r.code}): ${command}\n${r.stderr.slice(-2000)}\n${r.stdout.slice(-2000)}`);
    return r.stdout;
  }
  // For idempotent long-running steps (apt installs): survive an SSH connection loss (exit 255)
  // by waiting for SSH to come back and running the command again, a bounded number of times.
  async sshRetry(command, opts = {}, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      last = this.ssh(command, opts);
      if (last.code === 0) return last.stdout;
      if (last.code !== 255) break;
      await this.waitSsh();
    }
    throw new Error(`ssh command failed (exit ${last.code}) after ${attempts} attempt(s): ${command}\n${last.stderr.slice(-2000)}\n${last.stdout.slice(-2000)}`);
  }
  // Fresh cloud images run cloud-init on first boot; wait for it so later apt/systemd steps are not disrupted.
  async waitCloudInit(timeoutMs = 10 * 60_000) {
    const r = this.ssh('command -v cloud-init >/dev/null && cloud-init status --wait --long 2>&1 | tail -3 || echo no-cloud-init', { timeoutMs });
    return r.stdout.trim();
  }
  // Open `ssh -N -L p:127.0.0.1:p` tunnels for the given ports; returns a closer.
  tunnel(ports) {
    const args = [...this.sshBase.slice(1, -1), '-N', ...ports.flatMap((p) => ['-L', `${p}:127.0.0.1:${p}`]), this.sshBase[this.sshBase.length - 1]];
    const child = spawn(this.sshBase[0], args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    return {
      pid: child.pid,
      close: () => child.kill('SIGTERM'),
      error: () => err,
    };
  }
  async waitSsh(timeoutMs = 5 * 60_000) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt += 1;
      const r = this.ssh('echo ok && uptime -s', { timeoutMs: 20_000 });
      if (r.code === 0 && r.stdout.startsWith('ok')) return { attempt, bootedAt: r.stdout.trim().split('\n')[1], elapsedMs: Date.now() - start };
      await sleep(5000);
    }
    throw new Error(`SSH not reachable within ${timeoutMs / 1000}s`);
  }
}

class DigitalOceanTarget extends SshTarget {
  constructor() {
    const state = JSON.parse(readFileSync(path.join(ROOT, '.vm.local.json'), 'utf8'));
    const key = process.env.HARBOR_VM_SSH_KEY ?? path.join(homedir(), '.ssh', 'harbor-test-vm_ed25519');
    super(`digitalocean droplet ${state.dropletId}`, ['ssh', '-i', key, '-o', `UserKnownHostsFile=${path.join(ROOT, '.vm-known_hosts')}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=15', `root@${state.ip}`], state.ip);
    this.state = state;
  }
  scp(local, remote) {
    const key = process.env.HARBOR_VM_SSH_KEY ?? path.join(homedir(), '.ssh', 'harbor-test-vm_ed25519');
    const r = spawnSync('scp', ['-q', '-i', key, '-o', `UserKnownHostsFile=${path.join(ROOT, '.vm-known_hosts')}`, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', local, `root@${this.state.ip}:${remote}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`scp failed: ${r.stderr}`);
  }
  controller(args) {
    const r = spawnSync('node', [path.join(ROOT, 'scripts/vm/do-vm.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 20 * 60_000 });
    if (r.status !== 0) throw new Error(`do-vm ${args.join(' ')} failed`);
    return r.stdout;
  }
  async rebuildFresh() {
    this.controller(['rebuild']);
    await this.waitCloudInit();
  }
  async reboot() {
    this.controller(['reboot']); // hard power cycle via the cloud API, waits for SSH
  }
  facts() {
    return { kind: 'digitalocean', dropletId: this.state.dropletId, size: this.state.size, image: this.state.image, region: this.state.region };
  }
}

class VagrantTarget extends SshTarget {
  constructor() {
    const cfg = spawnSync('vagrant', ['ssh-config', 'harbor-test'], { encoding: 'utf8', cwd: ROOT });
    if (cfg.status !== 0) fail('vagrant ssh-config failed; is the harbor-test VM up? (vagrant up)', 4);
    const get = (k) => new RegExp(`^\\s*${k}\\s+(.+)$`, 'm').exec(cfg.stdout)?.[1]?.trim();
    const host = get('HostName');
    const port = get('Port');
    const key = get('IdentityFile').replace(/"/g, '');
    super(`vagrant harbor-test (${host}:${port})`, ['ssh', '-i', key, '-p', port, '-o', 'UserKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', `vagrant@${host}`], host);
    this.sudo = true;
  }
  ssh(command, opts = {}) {
    return super.ssh(`sudo -n bash -c ${JSON.stringify(command)}`, opts);
  }
  scp(local, remote) {
    const r = spawnSync('vagrant', ['upload', local, remote, 'harbor-test'], { encoding: 'utf8', cwd: ROOT });
    if (r.status !== 0) throw new Error(`vagrant upload failed: ${r.stderr}`);
  }
  async rebuildFresh() {
    spawnSync('vagrant', ['destroy', '-f', 'harbor-test'], { stdio: 'inherit', cwd: ROOT });
    const r = spawnSync('vagrant', ['up', 'harbor-test'], { stdio: 'inherit', cwd: ROOT });
    if (r.status !== 0) throw new Error('vagrant up failed');
  }
  async reboot() {
    spawnSync('vagrant', ['halt', 'harbor-test'], { stdio: 'inherit', cwd: ROOT });
    const r = spawnSync('vagrant', ['up', 'harbor-test'], { stdio: 'inherit', cwd: ROOT });
    if (r.status !== 0) throw new Error('vagrant up failed');
    await this.waitSsh();
  }
  facts() {
    return { kind: 'vagrant', box: 'bento/ubuntu-24.04' };
  }
}

// ---------------- Harbor CLI over SSH (root on the VM; token in root's config dir)

export const REMOTE_CLI = '/opt/harbor/bin/harbor';
export function cli(target, args, opts = {}) {
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const cmd = `export HARBOR_CLI_CONFIG_DIR=/root/.config/harbor; ${REMOTE_CLI} --json ${quoted}`;
  const r = target.ssh(cmd, { input: opts.input, timeoutMs: opts.timeoutMs ?? 900_000 });
  let json;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    json = null;
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
}
export function cliOk(target, args, opts = {}) {
  const r = cli(target, args, opts);
  if (r.code !== 0) throw new Error(`harbor ${args.join(' ')} exited ${r.code}: ${r.stderr.slice(-1500)} ${r.stdout.slice(-1500)}`);
  return r.json;
}

// ---------------- evidence

export class Evidence {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.results = [];
    this.startedAt = new Date().toISOString();
  }
  record(id, title, status, details = {}, notes = []) {
    const entry = { id, title, status, at: new Date().toISOString(), details, notes };
    this.results.push(entry);
    const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status.toUpperCase();
    console.log(`\n[${mark}] ${id} ${title}`);
    for (const n of notes) console.log(`       ${n}`);
    this.flush();
    return entry;
  }
  file(name, data) {
    const p = path.join(this.dir, name);
    writeFileSync(p, data);
    return path.relative(ROOT, p);
  }
  flush() {
    writeFileSync(path.join(this.dir, 'report.json'), JSON.stringify({ startedAt: this.startedAt, updatedAt: new Date().toISOString(), results: this.results }, null, 2));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 2000, what = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

// A minimal valid single-page PDF (for BentoPDF fixtures). `label` becomes the page text.
export function minimalPdf(label) {
  const objs = [];
  const text = `BT /F1 24 Tf 72 720 Td (${label.replace(/[()\\]/g, '')}) Tj ET`;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
