// Root half of Harbor backups (decision 153), run by harbor-backup@<requestId>.service via
// `harbor backup-step <requestId>`.
//
// The daemon (harbor user) writes <stateDir>/backup/requests/<id>/request.json (never a secret) and
// streams one JSON secrets document through secrets.fifo. This step re-validates everything itself:
// the request dir must belong to the harbor user, app homes must sit in an allowed harbor-apps tree
// with the manifest naming the same instance, stage paths are fixed tmpfs paths, restore targets must
// be a sealed AND unlocked volumes/ dir. restic runs with argv only (secrets in its environment), its
// --json progress goes to progress.json, the verdict to status.json, and a deadline stops it with
// SIGINT (restic then writes no snapshot). Nothing here ever writes a secret to a persistent disk:
// ssh keys and the app's state slice live in /run (tmpfs) for the length of one step.
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec } from './exec.js';
import { describeAppHome } from '../storage/app-home.js';
import { isAllowedHomePath, sealedDir } from '../storage/fscrypt.js';
import { dirStatus } from './app-crypto-apply.js';
import {
  backupArgs,
  catConfigArgs,
  checkArgs,
  classifyExit,
  forgetArgs,
  initArgs,
  keyAddArgs,
  keyListArgs,
  keyRemoveArgs,
  KEY_LABEL_BACKUP,
  parseBackupLine,
  parseKeyList,
  parseSnapshots,
  RCLONE_BIN,
  rcloneConfig,
  repoAccess,
  restoreArgs,
  RESTIC_BIN,
  RESTIC_CACHE_DIR,
  snapshotsArgs,
  unlockArgs,
  pruneArgs,
  withLockWait,
  type BackupSummary,
  type RepoAccess,
} from '../backups/restic.js';
import {
  BACKUP_ROOT_STATE,
  BACKUP_RUN_DIR,
  backupRequestFiles,
  checkRequestShape,
  isSafeStagePath,
  isStagePath,
  MAX_STAGE_BYTES,
  parseBackupSpec,
  rcloneConfFor,
  stageDirFor,
  STAGE_FOLDER,
  type BackupRequest,
  type BackupResult,
  type BackupSecrets,
  type BackupStatus,
  type StageFile,
} from '../backups/step.js';

type Log = (m: string) => void;

function requireRoot(): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', 'backup-step must run as root');
}

function writeJson(file: string, doc: unknown, owner: { uid: number; gid: number }): void {
  try {
    writeFileSync(file, JSON.stringify(doc), { mode: 0o640 });
    chownSync(file, owner.uid, owner.gid);
  } catch {
    /* the unit's exit code still carries the verdict */
  }
}

async function readSecrets(fifo: string): Promise<BackupSecrets> {
  const st = lstatSync(fifo, { throwIfNoEntry: false });
  if (!st || !st.isFIFO()) throw new HarborError('INVALID_REQUEST', 'no secrets were offered for this step (missing secrets.fifo)');
  const read = readFile(fifo, 'utf8');
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new HarborError('OPERATION_FAILED', 'the daemon did not hand over the secrets in time')), 120_000).unref());
  const raw = await Promise.race([read, timer]);
  if (raw.length > MAX_STAGE_BYTES * 2) throw new HarborError('INVALID_REQUEST', 'secrets document too large');
  const d = JSON.parse(raw) as Partial<BackupSecrets>;
  if (!d || typeof d.password !== 'string' || !d.password || typeof d.target !== 'object' || d.target === null) throw new HarborError('INVALID_REQUEST', 'secrets document is incomplete');
  return d as BackupSecrets;
}

// ---------------------------------------------------------------- restic runner

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  deadlineHit: boolean;
  gaveUp: string | null; // the backend error restic kept retrying, when we stopped it
}

// restic retries a failing backend call with growing pauses (13 s, 26 s, 1 min, …) for a long time. Short
// steps give up after 3 retries, long ones after 8 (≈ 15 min), and say what restic kept failing at.
const RETRY_RE = /returned error, retrying after/;
function runRestic(args: string[], access: RepoAccess, password: string, opts: { deadlineMs?: number; onLine?: (l: string) => void; keepStdout?: boolean; onStderr?: (chunk: string, stop: () => void) => void; maxRetries?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(RESTIC_BIN, [...access.options, ...withLockWait(args)], {
      cwd: '/',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/root', ...access.env, RESTIC_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let buf = '';
    let deadlineHit = false;
    let retries = 0;
    let gaveUp: string | null = null;
    const maxRetries = opts.maxRetries ?? 3;
    const timer = opts.deadlineMs
      ? setTimeout(() => {
          deadlineHit = true;
          child.kill('SIGINT');
          setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
        }, opts.deadlineMs)
      : null;
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (opts.keepStdout !== false && stdout.length < 32 * 1024 * 1024) stdout += s;
      if (opts.onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          opts.onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8');
      if (stderr.length < 256 * 1024) stderr += chunk;
      opts.onStderr?.(chunk, () => child.kill('SIGINT'));
      for (const line of chunk.split('\n')) {
        if (!RETRY_RE.test(line) || gaveUp) continue;
        if (++retries >= maxRetries) {
          gaveUp = line.replace(/^.*?returned error, retrying after [^:]*:\s*/, '').trim();
          child.kill('SIGINT');
        }
      }
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new HarborError('UNSUPPORTED_CAPABILITY', `cannot run restic: ${e.message}`, { nextAction: 'Re-run bootstrap so Harbor installs its backup tools (restic, rclone).' }));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (buf && opts.onLine) opts.onLine(buf);
      resolve({ code, stdout, stderr, deadlineHit, gaveUp });
    });
  });
}

const UNREACHABLE_RE = /no such host|connection refused|i\/o timeout|dial tcp|network is unreachable|connection reset|tls: |certificate|Host key verification failed|Permission denied \(publickey|timed out|could not resolve/i;

function failure(r: RunResult, what: string, action: BackupRequest['action']): HarborError {
  const kind = classifyExit(r.code);
  const tail = r.stderr.trim().split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 800);
  if (r.gaveUp) return Object.assign(new HarborError('OPERATION_FAILED', `${what}: the place keeps refusing (${r.gaveUp.slice(0, 400)})`, { nextAction: 'Check the address, the credentials and the place\'s own settings, then test it again.' }), { backupCode: 'unreachable' as const });
  if (r.deadlineHit && action === 'backup') return Object.assign(new HarborError('OPERATION_FAILED', `${what} did not finish within its time limit`, { nextAction: 'Raise the maximum downtime in Settings → Backups, or back this app up when it is less busy.' }), { backupCode: 'deadline' as const });
  // restic keeps retrying a place it cannot reach; any other step that runs out of time is that
  if (r.deadlineHit) return Object.assign(new HarborError('OPERATION_FAILED', `${what}: the place did not answer in time${tail ? ` (${tail})` : ''}`, { nextAction: 'Check the address, the credentials and that the place is online, then test it again.' }), { backupCode: 'unreachable' as const });
  if (kind === 'wrong-password') return Object.assign(new HarborError('INVALID_STATE', `${what}: the backups there do not open with this Harbor's key`, { nextAction: 'They belong to another Harbor: open them with that Harbor\'s recovery key, or pick another folder.' }), { backupCode: 'wrong-password' as const });
  if (kind === 'repo-missing') return Object.assign(new HarborError('DATA_MISSING', `${what}: there are no Harbor backups at this place yet`, { nextAction: 'Test the place again; Harbor sets it up on the first test.' }), { backupCode: 'repo-missing' as const });
  if (kind === 'locked') return Object.assign(new HarborError('BUSY', `${what}: the backups there are locked by another run`, { nextAction: 'Wait for the other run, or clear a stale lock from Settings → Backups (Unlock).' }), { backupCode: 'locked' as const });
  if (UNREACHABLE_RE.test(r.stderr)) return Object.assign(new HarborError('OPERATION_FAILED', `${what}: cannot reach the place (${tail})`, { nextAction: 'Check the address, the credentials and that the place is online, then test it again.' }), { backupCode: 'unreachable' as const });
  return new HarborError('OPERATION_FAILED', `${what} failed (exit ${r.code}): ${tail || 'no output'}`, { nextAction: 'Check the details in Settings → Troubleshoot (journal) and try again.' });
}

// ---------------------------------------------------------------- validation

function checkHome(home: string, instanceId: string): void {
  if (!isAllowedHomePath(home)) throw new HarborError('INVALID_REQUEST', `${home} is not an app home Harbor may back up`);
  const real = realpathSync(home);
  if (real !== home) throw new HarborError('INVALID_REQUEST', `app home ${home} resolves through a symlink; refusing`);
  const { manifest } = describeAppHome(home);
  if (manifest.instanceId !== instanceId) throw new HarborError('INVALID_REQUEST', `app home ${home} belongs to instance ${manifest.instanceId}, not ${instanceId}`);
}

async function checkSealedOpen(home: string): Promise<void> {
  const dir = sealedDir(home);
  if (!existsSync(dir)) throw new HarborError('DATA_MISSING', `${dir} does not exist`);
  const st = await dirStatus(dir);
  if (!st.encrypted || !st.unlocked || st.partiallyLocked) throw new HarborError('INVALID_STATE', `${dir} is not sealed and unlocked; refusing to restore plaintext into it`);
}

// ---------------------------------------------------------------- target access

async function prepareAccess(req: BackupRequest, secrets: BackupSecrets, runDir: string, log: Log): Promise<{ access: RepoAccess; hostKey?: string }> {
  const t = req.target;
  const conf = rcloneConfFor(t.id);
  let hostKey: string | undefined;
  if (t.transport === 'sftp' && !(t.config['hostKey'] ?? '').trim()) {
    const port = t.config['port'] ? Number(t.config['port']) : 22;
    const r = await exec('/usr/bin/ssh-keyscan', ['-T', '10', '-p', String(port), t.config['host'] ?? ''], { timeoutMs: 30_000 });
    hostKey = r.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
    if (!hostKey) throw new HarborError('OPERATION_FAILED', `cannot read the server key of ${t.config['host']}:${port}`, { nextAction: 'Check the server name and port, and that SSH answers there.' });
    t.config['hostKey'] = hostKey;
    log(`pinned the server key of ${t.config['host']} (first contact)`);
  }
  if (t.transport === 'rclone' && (req.action === 'test' || req.action === 'init' || !existsSync(conf))) {
    // (Re)write the remote's config from the operator's answers; rclone adds its session to it later.
    const obscured: Record<string, string> = {};
    for (const f of t.fields) {
      const v = secrets.target[f.id] ?? t.config[f.id];
      if (!f.obscure || !v) continue;
      const r = await exec(RCLONE_BIN, ['obscure', '-'], { input: v, timeoutMs: 30_000, env: { HOME: '/root' } });
      if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `rclone obscure failed: ${r.stderr.trim()}`);
      obscured[f.id] = r.stdout.trim();
    }
    mkdirSync(path.dirname(conf), { recursive: true, mode: 0o700 });
    chmodSync(BACKUP_ROOT_STATE, 0o700);
    writeFileSync(conf, rcloneConfig(t, secrets.target, obscured), { mode: 0o600 });
  }
  const access = repoAccess(t, secrets.target, { run: runDir, rcloneConf: conf });
  for (const f of access.files) writeFileSync(f.path, f.content, { mode: 0o600 });
  mkdirSync(RESTIC_CACHE_DIR, { recursive: true, mode: 0o700 });
  return { access, ...(hostKey ? { hostKey } : {}) };
}

// ---------------------------------------------------------------- stage

function writeStage(dir: string, files: StageFile[]): void {
  rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, STAGE_FOLDER);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let total = 0;
  for (const f of files) {
    if (!isSafeStagePath(f.path)) throw new HarborError('INVALID_REQUEST', `unsafe stage path ${f.path}`);
    const bytes = Buffer.from(f.base64, 'base64');
    total += bytes.length;
    if (total > MAX_STAGE_BYTES) throw new HarborError('INVALID_REQUEST', 'the app state slice is too large');
    const p = path.join(root, f.path);
    mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, bytes, { mode: 0o600 });
  }
}

function readTree(root: string, base = ''): StageFile[] {
  const out: StageFile[] = [];
  for (const e of readdirSync(path.join(root, base)).sort()) {
    const rel = base ? `${base}/${e}` : e;
    const st = lstatSync(path.join(root, rel));
    if (st.isDirectory()) out.push(...readTree(root, rel));
    else if (st.isFile()) out.push({ path: rel, base64: readFileSync(path.join(root, rel)).toString('base64') });
  }
  return out;
}

async function writeOut(fifo: string, doc: unknown): Promise<void> {
  const st = lstatSync(fifo, { throwIfNoEntry: false });
  if (!st || !st.isFIFO()) throw new HarborError('INVALID_REQUEST', 'no out.fifo for this step');
  const fh = await Promise.race([open(fifo, 'w'), new Promise<never>((_, rej) => setTimeout(() => rej(new HarborError('OPERATION_FAILED', 'the daemon did not read the restored state in time')), 120_000).unref())]);
  try {
    await fh.writeFile(JSON.stringify(doc));
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- entry

export async function applyBackupStep(spec: string, log: Log): Promise<void> {
  const requestId = parseBackupSpec(spec);
  requireRoot();
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const owner = statSync(config.stateDir);
  const harbor = { uid: owner.uid, gid: owner.gid };
  const files = backupRequestFiles(config.stateDir, requestId);
  const dirSt = lstatSync(files.dir, { throwIfNoEntry: false });
  if (!dirSt || !dirSt.isDirectory() || dirSt.uid !== harbor.uid) throw new HarborError('INVALID_REQUEST', `${files.dir} is not a request folder of the ${PRODUCT.serviceUser} account`);
  const now = () => new Date().toISOString();
  let req: BackupRequest;
  try {
    req = checkRequestShape(JSON.parse(readFileSync(files.request, 'utf8')));
  } catch (e) {
    writeJson(files.status, { action: 'test', state: 'failed', message: e instanceof Error ? e.message : String(e), at: now() } satisfies BackupStatus, harbor);
    throw e;
  }
  rmSync(files.request, { force: true });
  const status = (s: Omit<BackupStatus, 'action' | 'at'>) => writeJson(files.status, { action: req.action, ...s, at: now() }, harbor);
  status({ state: 'working', message: `${req.action} started` });
  const runDir = `${BACKUP_RUN_DIR}/${requestId}`;
  mkdirSync(BACKUP_RUN_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(runDir, { mode: 0o700 });
  let stage: string | null = null;
  try {
    const secrets = await readSecrets(files.secrets);
    const { access, hostKey } = await prepareAccess(req, secrets, runDir, log);
    const what = `${req.action} at ${req.target.transport}`;
    const result: BackupResult = hostKey ? { hostKey } : {};
    const must = async (args: string[], opts: Parameters<typeof runRestic>[3] = {}, password = secrets.password): Promise<RunResult> => {
      const r = await runRestic(args, access, password, opts);
      const kind = classifyExit(r.code);
      if (r.gaveUp || (kind !== 'ok' && !(kind === 'partial' && req.action === 'backup'))) throw failure(r, what, req.action);
      return r;
    };
    switch (req.action) {
      case 'test': {
        // restic retries a backend error for minutes instead of exiting: watch its retry lines. A bucket that
        // does not exist yet is an empty place (init creates it); anything else retried three times is unreachable.
        let bucketMissing = false;
        const r = await runRestic(catConfigArgs(), access, secrets.password, {
          deadlineMs: 120_000,
          onStderr: (chunk, stop) => {
            if (/specified bucket does not exist|NoSuchBucket/i.test(chunk)) {
              bucketMissing = true;
              stop();
            }
          },
        });
        const kind = classifyExit(r.code);
        if (bucketMissing) result.repo = 'missing';
        else if (r.gaveUp) throw failure(r, what, req.action);
        else if (kind === 'ok') result.repo = 'ours';
        else if (kind === 'wrong-password') result.repo = 'foreign';
        else if (kind === 'repo-missing') result.repo = 'missing';
        else throw failure(r, what, req.action);
        break;
      }
      case 'init': {
        if (!secrets.newPassword) throw new HarborError('INVALID_REQUEST', 'init needs the recovery card as the second key');
        await must(initArgs(), { deadlineMs: 10 * 60_000 });
        const np = `${runDir}/new-password`;
        writeFileSync(np, secrets.newPassword, { mode: 0o600 });
        await must(keyAddArgs(np, req.keyLabel ?? 'harbor-card'), { deadlineMs: 10 * 60_000 });
        result.repo = 'ours';
        break;
      }
      case 'keys': {
        const r = await must(keyListArgs(), { deadlineMs: 5 * 60_000 });
        result.keys = parseKeyList(r.stdout);
        break;
      }
      case 'add-key': {
        if (!secrets.newPassword) throw new HarborError('INVALID_REQUEST', 'add-key needs the new key');
        const np = `${runDir}/new-password`;
        writeFileSync(np, secrets.newPassword, { mode: 0o600 });
        await must(keyAddArgs(np, req.keyLabel ?? KEY_LABEL_BACKUP), { deadlineMs: 10 * 60_000 });
        break;
      }
      case 'remove-key': {
        if (!req.keyId) throw new HarborError('INVALID_REQUEST', 'remove-key needs a key id');
        await must(keyRemoveArgs(req.keyId), { deadlineMs: 10 * 60_000 });
        break;
      }
      case 'backup': {
        if (!req.instanceId || !req.home || !req.tags?.length) throw new HarborError('INVALID_REQUEST', 'backup needs an app, its home and tags');
        checkHome(req.home, req.instanceId);
        stage = stageDirFor(req.instanceId, req.target.id);
        writeStage(stage, secrets.stage ?? []);
        let summary: BackupSummary | null = null;
        const errors: string[] = [];
        let lastProgress = 0;
        const r = await runRestic(backupArgs({ paths: [req.home, stage], tags: req.tags, excludes: [`${sealedDir(req.home)}/.harbor-key-probe-*`] }), access, secrets.password, {
          ...(req.deadlineSeconds ? { deadlineMs: req.deadlineSeconds * 1000 } : {}),
          maxRetries: 8,
          keepStdout: false,
          onLine: (line) => {
            const l = parseBackupLine(line);
            if (!l) return;
            if (l.type === 'summary') summary = l;
            else if (l.type === 'error') errors.push(l.message);
            else if (Date.now() - lastProgress > 2000) {
              lastProgress = Date.now();
              writeJson(files.progress, { percent: l.percent, bytesDone: l.bytesDone, totalBytes: l.totalBytes, at: now() }, harbor);
            }
          },
        });
        const kind = classifyExit(r.code);
        if (r.deadlineHit || r.gaveUp || (kind !== 'ok' && kind !== 'partial')) throw failure(r, what, req.action);
        const s = summary as BackupSummary | null;
        if (!s) throw new HarborError('OPERATION_FAILED', `${what}: restic reported no snapshot`);
        Object.assign(result, { snapshotId: s.snapshotId, dataAdded: s.dataAdded, totalBytes: s.totalBytes, filesNew: s.filesNew, filesChanged: s.filesChanged, durationSeconds: s.durationSeconds, partial: kind === 'partial' });
        if (kind === 'partial') log(`some files could not be read: ${errors.slice(0, 5).join(' | ')}`);
        break;
      }
      case 'snapshots': {
        const r = await must(snapshotsArgs(req.filterTags), { deadlineMs: 10 * 60_000 });
        result.snapshots = parseSnapshots(r.stdout);
        break;
      }
      case 'restore-meta': {
        if (!req.snapshotId || !req.sourceStage || !isStagePath(req.sourceStage)) throw new HarborError('INVALID_REQUEST', 'restore-meta needs a snapshot and its stage path');
        const target = `${runDir}/meta`;
        await must(restoreArgs(req.snapshotId, `${req.sourceStage}/${STAGE_FOLDER}`, target), { deadlineMs: 30 * 60_000 });
        await writeOut(files.out, readTree(target));
        break;
      }
      case 'restore-data': {
        if (!req.snapshotId || !req.sourceHome || !req.destHome || !req.instanceId) throw new HarborError('INVALID_REQUEST', 'restore-data needs a snapshot, the source and the new home');
        if (!isAllowedHomePath(req.sourceHome)) throw new HarborError('INVALID_REQUEST', `${req.sourceHome} is not an app home path`);
        checkHome(req.destHome, req.instanceId);
        await checkSealedOpen(req.destHome);
        let lastProgress = 0;
        await must([...restoreArgs(req.snapshotId, sealedDir(req.sourceHome), sealedDir(req.destHome)), '--json'], {
          keepStdout: false,
          maxRetries: 8,
          onLine: (line) => {
            const l = parseBackupLine(line);
            if (l?.type === 'status' && Date.now() - lastProgress > 2000) {
              lastProgress = Date.now();
              writeJson(files.progress, { percent: l.percent, bytesDone: l.bytesDone, totalBytes: l.totalBytes, at: now() }, harbor);
            }
          },
        });
        break;
      }
      case 'forget': {
        const r = await must(forgetArgs({ ...(req.instanceId ? { instanceId: req.instanceId } : {}), ...(req.snapshotIds ? { snapshotIds: req.snapshotIds } : {}), ...(req.retention ? { retention: req.retention } : {}), prune: req.prune === true }), { deadlineMs: 6 * 60 * 60_000 });
        result.removed = (r.stdout.match(/"remove":\[/g) ?? []).length;
        break;
      }
      case 'prune': {
        await must(pruneArgs(), { deadlineMs: 12 * 60 * 60_000, maxRetries: 8 });
        break;
      }
      case 'check': {
        await must(checkArgs(req.checkSubset ?? 2), { deadlineMs: 12 * 60 * 60_000, maxRetries: 8 });
        result.checked = now();
        break;
      }
      case 'unlock': {
        await must(unlockArgs(), { deadlineMs: 5 * 60_000 });
        break;
      }
      case 'forget-target': {
        if (req.prune) {
          const r = await must(snapshotsArgs(req.filterTags), { deadlineMs: 10 * 60_000 });
          const ids = parseSnapshots(r.stdout).map((s) => s.id);
          if (ids.length) await must(forgetArgs({ snapshotIds: ids, prune: true }), { deadlineMs: 6 * 60 * 60_000 });
          result.removed = ids.length;
        }
        rmSync(path.dirname(rcloneConfFor(req.target.id)), { recursive: true, force: true });
        break;
      }
    }
    status({ state: 'ok', message: `${req.action} ok`, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { backupCode?: BackupStatus['code'] }).backupCode;
    status({ state: 'failed', message: msg, ...(e instanceof HarborError && e.nextAction ? { nextAction: e.nextAction } : {}), ...(code ? { code } : {}) });
    throw e;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}
