import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { archiveName } from '../system/selfupdate.js';
import { exec, execOk } from './exec.js';

// The root half of a self-update (run by harbor-self-update@<version>.service). It trusts nothing the
// unprivileged daemon wrote: it downloads the archive and SHA256SUMS from the GitHub release itself,
// verifies, extracts, and runs the new release's own `bootstrap --yes` (the documented in-place upgrade).
// Progress goes to <state>/updates/status.json for the console, which reconnects after the restart.
const WORK = '/root/harbor-updates';

type State = 'requested' | 'downloading' | 'installing' | 'succeeded' | 'failed';
function writeStatus(version: string, state: State, message: string): void {
  const file = path.join(PRODUCT.paths.var, 'updates', 'status.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    writeFileSync(file, JSON.stringify({ version, state, message, at: new Date().toISOString() }), { mode: 0o644 });
  } catch {
    /* status is best effort */
  }
}

async function download(url: string, dest: string, maxBytes: number): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'harbor-self-update' }, redirect: 'follow' });
  if (!res.ok) throw new HarborError('OPERATION_FAILED', `download of ${url} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new HarborError('OPERATION_FAILED', `${url} is larger than ${maxBytes} bytes`);
  writeFileSync(dest, bytes, { mode: 0o600 });
}

export async function applySelfUpdate(version: string, repo: string, log: (m: string) => void): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HarborError('INVALID_REQUEST', `not a release version: ${version}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'self-update apply must run as root (it is started by harbor-self-update@.service)');
  const name = archiveName(version);
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  mkdirSync(WORK, { recursive: true, mode: 0o700 });
  const archive = path.join(WORK, name);
  const sums = path.join(WORK, `SHA256SUMS-${version}`);
  try {
    writeStatus(version, 'downloading', `downloading ${name} from GitHub`);
    log(`downloading ${base}/${name}`);
    await download(`${base}/${name}`, archive, 400 * 1024 * 1024);
    await download(`${base}/SHA256SUMS`, sums, 64 * 1024);
    const expected = readFileSync(sums, 'utf8')
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === name)?.[0];
    if (!expected) throw new HarborError('OPERATION_FAILED', `SHA256SUMS of release ${version} does not list ${name}`);
    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (actual !== expected) throw new HarborError('OPERATION_FAILED', `checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    log(`checksum verified (${actual.slice(0, 16)}…)`);
    const dir = path.join(WORK, name.replace(/\.tar\.gz$/, ''));
    rmSync(dir, { recursive: true, force: true });
    await execOk('/usr/bin/tar', ['-xzf', archive, '-C', WORK], { timeoutMs: 300_000 });
    if (!existsSync(path.join(dir, 'bin', 'harbor'))) throw new HarborError('OPERATION_FAILED', `archive did not extract to ${dir}`);
    writeStatus(version, 'installing', `installing release ${version} (the daemon restarts)`);
    log(`running ${dir}/bin/harbor bootstrap --yes`);
    const r = await exec(path.join(dir, 'bin', 'harbor'), ['bootstrap', '--yes'], { timeoutMs: 25 * 60_000 });
    if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `bootstrap of ${version} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ')}`);
    writeStatus(version, 'succeeded', `Harbor ${version} installed`);
    log(`done: Harbor ${version}`);
    rmSync(archive, { force: true });
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(version, 'failed', msg);
    log(`failed: ${msg}`);
    throw e;
  }
}
