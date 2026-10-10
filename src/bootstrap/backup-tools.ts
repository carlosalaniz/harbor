// Root: install the pinned backup tools (restic, rclone) into /usr/local/lib/harbor/bin (decision 149).
// Root-owned 0755 outside every harbor-writable path: the root backup step executes them. Downloads
// are checked against the sha256 pinned in src/backups/restic.ts; a mismatch never installs anything.
// Never fails bootstrap: without the tools, backups refuse with a plain next action.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { BACKUP_TOOLS, BACKUP_TOOLS_DIR, RCLONE_BIN, RESTIC_BIN } from '../backups/restic.js';
import { readZip } from '../packages/zip.js';
import { aptGet, exec } from './exec.js';

type Log = (m: string) => void;

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new HarborError('OPERATION_FAILED', `download of ${url} failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new HarborError('OPERATION_FAILED', `${url} is larger than expected`);
  return buf;
}

async function installedVersion(bin: string, args: string[]): Promise<string> {
  if (!existsSync(bin)) return '';
  const r = await exec(bin, args, { timeoutMs: 20_000, env: { HOME: '/root' } });
  return r.code === 0 ? r.stdout : '';
}

function placeBinary(bytes: Buffer, dest: string): void {
  const tmp = `${dest}.new`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
}

// readZip drops the archive's single top folder (rclone-v<version>-linux-amd64/), so the binary is `rclone`.
export function rcloneBinary(files: Map<string, Buffer>): Buffer | null {
  for (const [name, bytes] of files) if (name === 'rclone' || /^rclone-v[^/]+\/rclone$/.test(name)) return bytes;
  return null;
}

export async function installBackupTools(log: Log): Promise<void> {
  mkdirSync(BACKUP_TOOLS_DIR, { recursive: true, mode: 0o755 });
  try {
    const r = BACKUP_TOOLS.restic;
    if (!(await installedVersion(RESTIC_BIN, ['version'])).includes(`restic ${r.version} `)) {
      log(`installing restic ${r.version} (app backups)`);
      const q = await exec('/usr/bin/dpkg-query', ['-W', '-f=${Status}', 'bzip2'], { timeoutMs: 10_000 });
      if (!q.stdout.includes('install ok installed')) await aptGet(log, ['install', '-y', '-q', 'bzip2'], { timeoutMs: 10 * 60_000 });
      const bz = await download(r.url, 64 * 1024 * 1024);
      if (createHash('sha256').update(bz).digest('hex') !== r.sha256) throw new HarborError('OPERATION_FAILED', 'restic download does not match its pinned checksum; nothing installed');
      const tmp = path.join(BACKUP_TOOLS_DIR, '.restic.bz2');
      writeFileSync(tmp, bz, { mode: 0o600 });
      try {
        // decompress straight into the destination file (exec() caps captured output)
        const fd = openSync(`${RESTIC_BIN}.new`, 'w', 0o755);
        let res;
        try {
          res = spawnSync('/usr/bin/bunzip2', ['-c', tmp], { stdio: ['ignore', fd, 'pipe'], timeout: 120_000 });
        } finally {
          closeSync(fd);
        }
        if (res.status !== 0) throw new HarborError('OPERATION_FAILED', `bunzip2 failed: ${res.stderr?.toString().trim() ?? res.error?.message ?? ''}`);
        chmodSync(`${RESTIC_BIN}.new`, 0o755);
        renameSync(`${RESTIC_BIN}.new`, RESTIC_BIN);
      } finally {
        rmSync(tmp, { force: true });
        rmSync(`${RESTIC_BIN}.new`, { force: true });
      }
      log(`restic ${r.version} installed at ${RESTIC_BIN}`);
    }
  } catch (e) {
    log(`restic install failed (${e instanceof Error ? e.message : String(e)}); app backups will refuse until it is present`);
  }
  try {
    const c = BACKUP_TOOLS.rclone;
    if (!(await installedVersion(RCLONE_BIN, ['version'])).includes(`rclone v${c.version}`)) {
      log(`installing rclone ${c.version} (cloud transport for backups)`);
      const zip = await download(c.url, 128 * 1024 * 1024);
      if (createHash('sha256').update(zip).digest('hex') !== c.sha256) throw new HarborError('OPERATION_FAILED', 'rclone download does not match its pinned checksum; nothing installed');
      const files = readZip(zip, { maxEntries: 64, maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 384 * 1024 * 1024 });
      const bin = rcloneBinary(files);
      if (!bin) throw new HarborError('OPERATION_FAILED', 'the rclone archive has no rclone binary');
      placeBinary(bin, RCLONE_BIN);
      log(`rclone ${c.version} installed at ${RCLONE_BIN}`);
    }
  } catch (e) {
    log(`rclone install failed (${e instanceof Error ? e.message : String(e)}); Proton Drive backups will refuse until it is present`);
  }
}
