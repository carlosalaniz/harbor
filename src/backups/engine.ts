// Daemon side of the backup engine (decision 153). The daemon never runs restic: every step goes
// through the polkit-allowed root oneshot `harbor-backup@<requestId>` (RootBackupEngine), with the
// same handoff as per-app sealing (request file + secrets FIFO + blocking systemctl start). In fake
// mode (tests, dev, CI on macOS) FakeBackupEngine keeps "remote" repositories in memory and copies
// real files, so schedule → warm → cold → restore runs end to end without restic or root.
import { randomUUID } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HarborError } from '../errors.js';
import { systemctlStartBlocking, type UnitStarter } from '../storage/crypto-provider.js';
import { sealedDir } from '../storage/fscrypt.js';
import { tagValue, type Retention, type RepoKey, type SnapshotInfo, type TargetRuntime } from './restic.js';
import { backupRequestFiles, backupUnit, parseBackupProgress, parseBackupStatus, stageDirFor, type BackupAction, type BackupProgress, type BackupRequest, type BackupResult, type BackupSecrets, type BackupStatus, type StageFile } from './step.js';

export interface TargetCall {
  target: TargetRuntime;
  password: string; // opens the repository (the backup key, or a recovery card)
  secrets: Record<string, string>; // the target's own credentials
}

export type BackupErrorCode = NonNullable<BackupStatus['code']>;
export function backupErrorCode(e: unknown): BackupErrorCode | null {
  return ((e as { backupCode?: BackupErrorCode }).backupCode ?? null) as BackupErrorCode | null;
}
function withCode(e: HarborError, code: BackupErrorCode | undefined): HarborError {
  return code ? Object.assign(e, { backupCode: code }) : e;
}

export interface BackupPass {
  instanceId: string;
  home: string;
  tags: string[];
  stage: StageFile[];
  deadlineSeconds?: number;
}

export interface BackupEngine {
  readonly kind: 'fake' | 'root';
  test(c: TargetCall): Promise<{ repo: 'missing' | 'ours' | 'foreign'; hostKey?: string }>;
  init(c: TargetCall, cardPassword: string, cardLabel: string): Promise<void>;
  keys(c: TargetCall): Promise<RepoKey[]>;
  addKey(c: TargetCall, newPassword: string, label: string): Promise<void>;
  removeKey(c: TargetCall, keyId: string): Promise<void>;
  backup(c: TargetCall, pass: BackupPass, onProgress?: (p: BackupProgress) => void): Promise<BackupResult>;
  snapshots(c: TargetCall, filterTags?: string): Promise<SnapshotInfo[]>;
  restoreMeta(c: TargetCall, snapshotId: string, sourceStage: string): Promise<StageFile[]>;
  restoreData(c: TargetCall, o: { instanceId: string; snapshotId: string; sourceHome: string; destHome: string }, onProgress?: (p: BackupProgress) => void): Promise<void>;
  forget(c: TargetCall, o: { instanceId?: string; snapshotIds?: string[]; retention?: Retention; prune: boolean }): Promise<number>;
  prune(c: TargetCall): Promise<void>;
  check(c: TargetCall, subsetPercent: number): Promise<void>;
  unlock(c: TargetCall): Promise<void>;
  forgetTarget(c: TargetCall, o: { deleteBackups: boolean; filterTags?: string }): Promise<number>;
}

// ---------------------------------------------------------------- live

function mkfifo(p: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/mkfifo', ['-m', '600', p], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `mkfifo exited ${code}`))));
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TIMEOUTS: Partial<Record<BackupAction, number>> = { prune: 24 * 60 * 60_000, test: 5 * 60_000, init: 15 * 60_000, keys: 10 * 60_000, 'add-key': 15 * 60_000, 'remove-key': 15 * 60_000, snapshots: 15 * 60_000, unlock: 10 * 60_000, 'restore-meta': 60 * 60_000 };
const LONG = 7 * 24 * 60 * 60_000;

export class RootBackupEngine implements BackupEngine {
  readonly kind = 'root' as const;
  constructor(
    private readonly stateDir: string,
    private readonly startUnit: UnitStarter = systemctlStartBlocking,
  ) {}

  private async step(req: Omit<BackupRequest, 'requestedAt'>, secrets: BackupSecrets, opts: { out?: boolean; onProgress?: (p: BackupProgress) => void } = {}): Promise<{ result: BackupResult; out: StageFile[] | null }> {
    const id = randomUUID();
    const files = backupRequestFiles(this.stateDir, id);
    mkdirSync(path.dirname(files.dir), { recursive: true, mode: 0o700 });
    mkdirSync(files.dir, { mode: 0o700 });
    const unit = backupUnit(id);
    let unitError: string | null = null;
    let poll: NodeJS.Timeout | null = null;
    try {
      writeFileSync(files.request, JSON.stringify({ ...req, requestedAt: new Date().toISOString() } satisfies BackupRequest), { mode: 0o600 });
      await mkfifo(files.secrets);
      if (opts.out) await mkfifo(files.out);
      let done = false;
      const started = this.startUnit(unit, TIMEOUTS[req.action] ?? LONG)
        .catch((e: Error) => {
          unitError = e.message;
        })
        .finally(() => {
          done = true;
        });
      // the restored state slice comes back through out.fifo (it holds secrets): start reading now
      const outRead = opts.out ? readFile(files.out, 'utf8').catch(() => '') : null;
      if (opts.onProgress) {
        const cb = opts.onProgress;
        poll = setInterval(() => {
          try {
            const p = parseBackupProgress(readFileSync(files.progress, 'utf8'));
            if (p) cb(p);
          } catch {
            /* not written yet */
          }
        }, 2000);
      }
      const payload = JSON.stringify(secrets);
      while (!done) {
        let fd: number | null = null;
        try {
          fd = openSync(files.secrets, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENXIO') {
            unitError ??= `cannot hand over the secrets: ${(e as Error).message}`;
            break;
          }
          await sleep(50);
          continue;
        }
        try {
          // the FIFO buffer is small: write in a loop, waiting while the reader catches up
          const buf = Buffer.from(payload);
          let off = 0;
          while (off < buf.length) {
            try {
              off += writeSync(fd, buf, off, Math.min(64 * 1024, buf.length - off));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
              await sleep(10);
            }
          }
        } finally {
          closeSync(fd);
        }
        break;
      }
      await started;
      let out: StageFile[] | null = null;
      if (outRead) {
        // unblock our own reader if the root step never opened the write side
        try {
          closeSync(openSync(files.out, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
        } catch {
          /* reader already finished */
        }
        const raw = await outRead;
        out = raw ? (JSON.parse(raw) as StageFile[]) : null;
      }
      let raw: string | null = null;
      try {
        raw = readFileSync(files.status, 'utf8');
      } catch {
        raw = null;
      }
      const status = raw ? parseBackupStatus(raw) : null;
      if (status?.state === 'ok') return { result: status.result ?? {}, out };
      if (status?.state === 'failed') throw withCode(new HarborError('OPERATION_FAILED', status.message, { nextAction: status.nextAction ?? 'Check Settings → Backups and try again.' }), status.code);
      throw new HarborError('OPERATION_FAILED', `backup step ${req.action} gave no verdict${unitError ? ` (${unitError})` : ''}`, {
        nextAction: `On the machine, run: journalctl -u ${unit} --no-pager -n 50 — and check that Harbor's units are installed (re-run bootstrap if not).`,
      });
    } finally {
      if (poll) clearInterval(poll);
      rmSync(files.dir, { recursive: true, force: true });
    }
  }

  private base(c: TargetCall): BackupSecrets {
    return { password: c.password, target: c.secrets };
  }

  async test(c: TargetCall) {
    const { result } = await this.step({ action: 'test', target: c.target }, this.base(c));
    return { repo: result.repo ?? 'missing', ...(result.hostKey ? { hostKey: result.hostKey } : {}) };
  }
  async init(c: TargetCall, cardPassword: string, cardLabel: string) {
    await this.step({ action: 'init', target: c.target, keyLabel: cardLabel }, { ...this.base(c), newPassword: cardPassword });
  }
  async keys(c: TargetCall) {
    return (await this.step({ action: 'keys', target: c.target }, this.base(c))).result.keys ?? [];
  }
  async addKey(c: TargetCall, newPassword: string, label: string) {
    await this.step({ action: 'add-key', target: c.target, keyLabel: label }, { ...this.base(c), newPassword });
  }
  async removeKey(c: TargetCall, keyId: string) {
    await this.step({ action: 'remove-key', target: c.target, keyId }, this.base(c));
  }
  async backup(c: TargetCall, pass: BackupPass, onProgress?: (p: BackupProgress) => void) {
    const { result } = await this.step(
      { action: 'backup', target: c.target, instanceId: pass.instanceId, home: pass.home, tags: pass.tags, ...(pass.deadlineSeconds ? { deadlineSeconds: pass.deadlineSeconds } : {}) },
      { ...this.base(c), stage: pass.stage },
      onProgress ? { onProgress } : {},
    );
    return result;
  }
  async snapshots(c: TargetCall, filterTags?: string) {
    return (await this.step({ action: 'snapshots', target: c.target, ...(filterTags ? { filterTags } : {}) }, this.base(c))).result.snapshots ?? [];
  }
  async restoreMeta(c: TargetCall, snapshotId: string, sourceStage: string) {
    const { out } = await this.step({ action: 'restore-meta', target: c.target, snapshotId, sourceStage }, this.base(c), { out: true });
    if (!out) throw new HarborError('OPERATION_FAILED', 'the restore point carries no app state');
    return out;
  }
  async restoreData(c: TargetCall, o: { instanceId: string; snapshotId: string; sourceHome: string; destHome: string }, onProgress?: (p: BackupProgress) => void) {
    await this.step({ action: 'restore-data', target: c.target, ...o }, this.base(c), onProgress ? { onProgress } : {});
  }
  async forget(c: TargetCall, o: { instanceId?: string; snapshotIds?: string[]; retention?: Retention; prune: boolean }) {
    return (await this.step({ action: 'forget', target: c.target, ...o }, this.base(c))).result.removed ?? 0;
  }
  async prune(c: TargetCall) {
    await this.step({ action: 'prune', target: c.target }, this.base(c));
  }
  async check(c: TargetCall, subsetPercent: number) {
    await this.step({ action: 'check', target: c.target, checkSubset: subsetPercent }, this.base(c));
  }
  async unlock(c: TargetCall) {
    await this.step({ action: 'unlock', target: c.target }, this.base(c));
  }
  async forgetTarget(c: TargetCall, o: { deleteBackups: boolean; filterTags?: string }) {
    return (await this.step({ action: 'forget-target', target: c.target, prune: o.deleteBackups, ...(o.filterTags ? { filterTags: o.filterTags } : {}) }, this.base(c))).result.removed ?? 0;
  }
}

// ---------------------------------------------------------------- fake

interface FakeSnapshot extends SnapshotInfo {
  data: Map<string, Buffer>; // <home>/volumes relative path → bytes
  stage: StageFile[];
}
interface FakeRepo {
  passwords: Map<string, string>; // key id → password
  labels: Map<string, string>;
  snapshots: FakeSnapshot[];
}

function readTree(root: string, base = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(root)) return out;
  for (const e of readdirSync(path.join(root, base)).sort()) {
    if (e.startsWith('.harbor-key-probe-')) continue;
    const rel = base ? `${base}/${e}` : e;
    const st = lstatSync(path.join(root, rel));
    if (st.isDirectory()) for (const [k, v] of readTree(root, rel)) out.set(k, v);
    else if (st.isFile()) out.set(rel, readFileSync(path.join(root, rel)));
  }
  return out;
}

// Remote repositories keyed by a stable string from the target's config, so two daemons in one test
// (two "machines") that install the same place see the same backups.
export class FakeBackupEngine implements BackupEngine {
  readonly kind = 'fake' as const;
  readonly repos = new Map<string, FakeRepo>();
  calls: { op: string; target: string }[] = [];
  // test knobs
  failWith: { op: string; message: string; code?: BackupErrorCode } | null = null;
  unreachable = new Set<string>(); // repo keys that cannot be reached
  // simulate data that is still changing: each backup adds this many "new" bytes (warm-pass convergence)
  churnBytes: number[] = [];
  // a pass whose duration exceeds its deadline fails like the root step does
  passSeconds = 0;

  private key(t: TargetRuntime): string {
    return `${t.transport}:${JSON.stringify(Object.entries(t.config).filter(([k]) => k !== 'hostKey').sort())}`;
  }
  private repo(c: TargetCall, op: string): FakeRepo {
    this.calls.push({ op, target: c.target.id });
    const k = this.key(c.target);
    if (this.failWith && (this.failWith.op === op || this.failWith.op === '*')) {
      const f = this.failWith;
      throw withCode(new HarborError('OPERATION_FAILED', f.message, { nextAction: 'Check the place and try again.' }), f.code);
    }
    if (this.unreachable.has(k)) throw withCode(new HarborError('OPERATION_FAILED', `${op}: cannot reach the place`, { nextAction: 'Check the address, the credentials and that the place is online, then test it again.' }), 'unreachable');
    const r = this.repos.get(k);
    if (!r) throw withCode(new HarborError('DATA_MISSING', `${op}: there are no Harbor backups at this place yet`), 'repo-missing');
    if (![...r.passwords.values()].includes(c.password)) throw withCode(new HarborError('INVALID_STATE', `${op}: the backups there do not open with this Harbor's key`), 'wrong-password');
    return r;
  }
  remoteFor(t: TargetRuntime): FakeRepo | undefined {
    return this.repos.get(this.key(t));
  }

  async test(c: TargetCall) {
    try {
      this.repo(c, 'test');
      return { repo: 'ours' as const, ...(c.target.transport === 'sftp' && !c.target.config['hostKey'] ? { hostKey: `${c.target.config['host']} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTUREfixturefixturefixturefixturefixture` } : {}) };
    } catch (e) {
      const code = backupErrorCode(e);
      if (code === 'repo-missing') return { repo: 'missing' as const };
      if (code === 'wrong-password') return { repo: 'foreign' as const };
      throw e;
    }
  }
  async init(c: TargetCall, cardPassword: string, cardLabel: string) {
    this.calls.push({ op: 'init', target: c.target.id });
    const k = this.key(c.target);
    if (this.repos.has(k)) throw new HarborError('OPERATION_FAILED', 'a repository already exists there');
    const r: FakeRepo = { passwords: new Map(), labels: new Map(), snapshots: [] };
    const a = randomUUID().replace(/-/g, '');
    const b = randomUUID().replace(/-/g, '');
    r.passwords.set(a, c.password);
    r.labels.set(a, 'root');
    r.passwords.set(b, cardPassword);
    r.labels.set(b, cardLabel);
    this.repos.set(k, r);
  }
  async keys(c: TargetCall) {
    const r = this.repo(c, 'keys');
    return [...r.passwords.entries()].map(([id, pw]) => ({ id, current: pw === c.password, label: r.labels.get(id) ?? '', created: '' }));
  }
  async addKey(c: TargetCall, newPassword: string, label: string) {
    const r = this.repo(c, 'add-key');
    const id = randomUUID().replace(/-/g, '');
    r.passwords.set(id, newPassword);
    r.labels.set(id, label);
  }
  async removeKey(c: TargetCall, keyId: string) {
    const r = this.repo(c, 'remove-key');
    if (r.passwords.get(keyId) === c.password) throw new HarborError('INVALID_REQUEST', 'refusing to remove the key in use');
    r.passwords.delete(keyId);
    r.labels.delete(keyId);
  }
  async backup(c: TargetCall, pass: BackupPass, onProgress?: (p: BackupProgress) => void) {
    const r = this.repo(c, 'backup');
    if (pass.deadlineSeconds !== undefined && this.passSeconds > pass.deadlineSeconds) {
      throw withCode(new HarborError('OPERATION_FAILED', 'backup did not finish within its time limit', { nextAction: 'Raise the maximum downtime in Settings → Backups, or back this app up when it is less busy.' }), 'deadline');
    }
    const data = readTree(sealedDir(pass.home));
    let total = 0;
    for (const v of data.values()) total += v.length;
    const prev = r.snapshots.filter((s) => tagValue(s.tags, 'app') === pass.instanceId).at(-1);
    let added = 0;
    for (const [k, v] of data) if (!prev || !prev.data.get(k)?.equals(v)) added += v.length;
    if (this.churnBytes.length) added = this.churnBytes.shift()!;
    onProgress?.({ percent: 1, bytesDone: total, totalBytes: total, at: new Date().toISOString() });
    const id = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const stagePath = stageDirFor(pass.instanceId, c.target.id);
    r.snapshots.push({ id, shortId: id.slice(0, 8), time: new Date().toISOString(), paths: [pass.home, stagePath], tags: [...pass.tags], hostname: 'harbor', totalBytes: total, dataAdded: added, data, stage: pass.stage.map((f) => ({ ...f })) });
    return { snapshotId: id, dataAdded: added, totalBytes: total, filesNew: data.size, filesChanged: 0, durationSeconds: this.passSeconds, partial: false };
  }
  async snapshots(c: TargetCall, filterTags?: string) {
    const r = this.repo(c, 'snapshots');
    const want = filterTags ? filterTags.split(',') : [];
    return r.snapshots.filter((s) => want.every((t) => s.tags.includes(t))).map(({ data: _d, stage: _s, ...info }) => ({ ...info }));
  }
  async restoreMeta(c: TargetCall, snapshotId: string, sourceStage: string) {
    const r = this.repo(c, 'restore-meta');
    const s = r.snapshots.find((x) => x.id === snapshotId || x.shortId === snapshotId);
    if (!s || !s.paths.includes(sourceStage)) throw new HarborError('NOT_FOUND', `no snapshot ${snapshotId} with ${sourceStage}`);
    return s.stage.map((f) => ({ ...f }));
  }
  async restoreData(c: TargetCall, o: { instanceId: string; snapshotId: string; sourceHome: string; destHome: string }, onProgress?: (p: BackupProgress) => void) {
    const r = this.repo(c, 'restore-data');
    const s = r.snapshots.find((x) => x.id === o.snapshotId || x.shortId === o.snapshotId);
    if (!s || !s.paths.includes(o.sourceHome)) throw new HarborError('NOT_FOUND', `no snapshot ${o.snapshotId} of ${o.sourceHome}`);
    const dest = sealedDir(o.destHome);
    if (!existsSync(dest) || !statSync(dest).isDirectory()) throw new HarborError('DATA_MISSING', `${dest} does not exist`);
    for (const [rel, bytes] of s.data) {
      const p = path.join(dest, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    }
    onProgress?.({ percent: 1, bytesDone: s.totalBytes ?? 0, totalBytes: s.totalBytes ?? 0, at: new Date().toISOString() });
  }
  async forget(c: TargetCall, o: { instanceId?: string; snapshotIds?: string[]; retention?: Retention; prune: boolean }) {
    const r = this.repo(c, 'forget');
    const before = r.snapshots.length;
    if (o.snapshotIds) r.snapshots = r.snapshots.filter((s) => !o.snapshotIds!.includes(s.id));
    else if (o.instanceId && o.retention) {
      // keep-last N where N = daily (good enough for tests: retention math is restic's job)
      const mine = r.snapshots.filter((s) => s.tags.includes(`app:${o.instanceId}`) && s.tags.includes('kind:cold'));
      const keep = new Set(mine.slice(-Math.max(1, o.retention.daily)).map((s) => s.id));
      r.snapshots = r.snapshots.filter((s) => !mine.includes(s) || keep.has(s.id));
    }
    return before - r.snapshots.length;
  }
  async prune(c: TargetCall) {
    this.repo(c, 'prune');
  }
  async check(c: TargetCall, _subsetPercent: number) {
    this.repo(c, 'check');
  }
  async unlock(c: TargetCall) {
    this.repo(c, 'unlock');
  }
  async forgetTarget(c: TargetCall, o: { deleteBackups: boolean; filterTags?: string }) {
    this.calls.push({ op: 'forget-target', target: c.target.id });
    if (!o.deleteBackups) return 0;
    const r = this.repo(c, 'forget-target');
    const want = o.filterTags ? o.filterTags.split(',') : [];
    const before = r.snapshots.length;
    r.snapshots = r.snapshots.filter((s) => !want.every((t) => s.tags.includes(t)));
    return before - r.snapshots.length;
  }
}
