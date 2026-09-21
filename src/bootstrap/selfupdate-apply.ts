import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { archiveName } from '../system/selfupdate.js';
import { exec, execOk } from './exec.js';

// The root half of a self-update (run by harbor-self-update@<version>.service). It trusts nothing the
// unprivileged daemon wrote: it downloads the archive and SHA256SUMS from the GitHub release itself,
// verifies, extracts, and runs the new release's own `bootstrap --yes` (the documented in-place upgrade).
// Progress goes to <state>/updates/status.json for the console, which reconnects after the restart.
//
// Rollback (decision 101): before touching /opt/harbor, the current release tree is snapshotted to
// /root/harbor-updates/previous/ (release.json proves it is a Harbor release). After bootstrap, the
// daemon is polled at /healthz; on failure the snapshot is restored and bootstrap re-runs from it,
// so the console comes back on the previous version with state untouched (migrations only ever add
// tables/columns, so a newer-then-older DB open is safe). The outcome lands in updates/status.json
// either way, and `harbor self-update apply --to <previous>` stays the documented manual downgrade.
const WORK = '/root/harbor-updates';
const PREVIOUS_DIR = '/root/harbor-updates/previous';

type State = 'requested' | 'downloading' | 'installing' | 'succeeded' | 'failed' | 'rolled-back';
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

export async function applySelfUpdate(version: string, repo: string, log: (m: string) => void, local?: { archive: string; sums: string }): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HarborError('INVALID_REQUEST', `not a release version: ${version}`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'self-update apply must run as root (it is started by harbor-self-update@.service)');
  const name = archiveName(version);
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  mkdirSync(WORK, { recursive: true, mode: 0o700 });
  const archive = path.join(WORK, name);
  const sums = path.join(WORK, `SHA256SUMS-${version}`);
  try {
    if (local) {
      writeStatus(version, 'downloading', `using local archive ${local.archive}`);
      writeFileSync(archive, readFileSync(local.archive), { mode: 0o600 });
      writeFileSync(sums, readFileSync(local.sums), { mode: 0o600 });
    } else {
      writeStatus(version, 'downloading', `downloading ${name} from GitHub`);
      log(`downloading ${base}/${name}`);
      await download(`${base}/${name}`, archive, 400 * 1024 * 1024);
      await download(`${base}/SHA256SUMS`, sums, 64 * 1024);
    }
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
    // Snapshot the running release before touching it: the rollback source.
    // Only Harbor releases qualify (release.json marker); anything else is
    // refused rather than snapshotted, same as bootstrap's foreign-dir rule.
    snapshotPreviousRelease(log);
    const previousVersion = readPreviousVersion();
    writeStatus(version, 'installing', `installing release ${version} (the daemon restarts)`);
    log(`running ${dir}/bin/harbor bootstrap --yes`);
    const r = await exec(path.join(dir, 'bin', 'harbor'), ['bootstrap', '--yes'], { timeoutMs: 25 * 60_000 });
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ');
      log(`bootstrap of ${version} failed (exit ${r.code}): ${detail}; rolling back to ${previousVersion ?? 'the previous release'}`);
      await rollbackToPrevious(log);
      const healthy = await waitHealthy(60_000, log);
      if (healthy) {
        writeStatus(version, 'rolled-back', `update to ${version} failed (${detail}); restored ${previousVersion ?? 'the previous release'} and the console is back`);
        log(`rolled back to ${previousVersion ?? 'previous release'}; console is back`);
        return;
      }
      writeStatus(version, 'failed', `update to ${version} failed (${detail}) and the rollback did not restore the console; run: sudo /opt/harbor/bin/harbor self-update apply --to ${previousVersion ?? '<previous>'}`);
      throw new HarborError('OPERATION_FAILED', `bootstrap of ${version} failed (exit ${r.code}): ${detail}`, {
        nextAction: `The rollback did not restore the console. On the machine, run: sudo /opt/harbor/bin/harbor self-update apply --to ${previousVersion ?? '<previous version>'}`,
      });
    }
    // Bootstrap exited 0 but the daemon may still be down (bad binary, broken
    // unit): poll /healthz and roll back the same way instead of declaring success.
    const healthy = await waitHealthy(60_000, log);
    if (!healthy) {
      log(`daemon did not become healthy after installing ${version}; rolling back to ${previousVersion ?? 'the previous release'}`);
      await rollbackToPrevious(log);
      const back = await waitHealthy(60_000, log);
      if (back) {
        writeStatus(version, 'rolled-back', `update to ${version} installed but the console never came back; restored ${previousVersion ?? 'the previous release'}`);
        log(`rolled back to ${previousVersion ?? 'previous release'}; console is back`);
        return;
      }
      writeStatus(version, 'failed', `update to ${version} installed but the console never came back, and the rollback did not restore it; run: sudo /opt/harbor/bin/harbor self-update apply --to ${previousVersion ?? '<previous>'}`);
      throw new HarborError('OPERATION_FAILED', `daemon did not become healthy after installing ${version}`, {
        nextAction: `On the machine, run: sudo /opt/harbor/bin/harbor self-update apply --to ${previousVersion ?? '<previous version>'}`,
      });
    }
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

// ---- rollback helpers (pure filesystem + health poll; unit-testable) ----

// Copy the running /opt/harbor tree aside before an update touches it.
// Throws (aborting the update) when /opt/harbor is not a Harbor release —
// rolling back to a foreign tree would be worse than refusing.
export function snapshotPreviousRelease(log: (m: string) => void = () => {}): void {
  const marker = path.join(PRODUCT.paths.opt, 'release.json');
  if (!existsSync(marker)) throw new HarborError('OWNERSHIP_CONFLICT', `${PRODUCT.paths.opt} is not a Harbor release (no release.json)`, { nextAction: 'Move or remove that directory manually; self-update never overwrites unrelated files.' });
  rmSync(PREVIOUS_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(PREVIOUS_DIR), { recursive: true, mode: 0o700 });
  cpSync(PRODUCT.paths.opt, PREVIOUS_DIR, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  log(`snapshotted the running release to ${PREVIOUS_DIR}`);
}

export function readPreviousVersion(): string | null {
  try {
    const m = JSON.parse(readFileSync(path.join(PREVIOUS_DIR, 'release.json'), 'utf8')) as { version?: string };
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

// Restore the snapshot over /opt/harbor and re-run its bootstrap so the unit
// points at the previous release again. State (/var/lib/harbor) is untouched:
// migrations only add tables/columns, so the older binary opens the newer DB.
// Async: re-running bootstrap restarts the daemon from the restored tree.
async function rollbackToPrevious(log: (m: string) => void): Promise<void> {
  if (!existsSync(path.join(PREVIOUS_DIR, 'bin', 'harbor'))) throw new HarborError('OPERATION_FAILED', `no previous release snapshot at ${PREVIOUS_DIR}`, { nextAction: 'Reinstall Harbor from the release archive manually.' });
  rmSync(PRODUCT.paths.opt, { recursive: true, force: true });
  cpSync(PREVIOUS_DIR, PRODUCT.paths.opt, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  log(`restored ${PRODUCT.paths.opt} from the previous release`);
  log(`re-running the previous release's bootstrap`);
  const r = await exec(path.join(PRODUCT.paths.opt, 'bin', 'harbor'), ['bootstrap', '--yes'], { timeoutMs: 25 * 60_000 });
  if (r.code !== 0) log(`previous release bootstrap exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  else log(`previous release bootstrap done`);
}

async function waitHealthy(timeoutMs: number, log: (m: string) => void): Promise<boolean> {
  // The management port lives in /etc/harbor/harbor.json; fall back to the default.
  let port: number = PRODUCT.defaults.managementPort;
  try {
    const raw = JSON.parse(readFileSync(`${PRODUCT.paths.etc}/harbor.json`, 'utf8')) as { listen?: { port?: number } };
    if (typeof raw.listen?.port === 'number') port = raw.listen.port;
  } catch {
    /* default */
  }
  const url = `http://localhost:${port}/healthz`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`daemon did not become healthy at ${url}`);
  return false;
}
