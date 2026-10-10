// App backups (decisions 149–154): installed places (targets), the backup key, per-app policy, the
// sequential worker (warm passes outside the queue, the cold pass as a `backup` operation), restore
// points, retention and maintenance. The engine (root step or fake) does the restic work; this file
// decides what runs when and records it.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../lifecycle/context.js';
import { HarborError } from '../errors.js';
import type { AppBackupsDto, BackupActivityDto, BackupAppDto, BackupAppPolicyDto, BackupPolicyDto, BackupRunDto, BackupsOverviewDto, BackupTargetDto, BackupTargetPackageDto, FoundBackupAppDto, RestorePointDto } from '../contracts/api.js';
import type { BackupRunRow, BackupRunTarget, InstanceRow, ResourceRow } from '../state/repo.js';
import { UUID_RE } from '../contracts/patterns.js';
import { unwrapMasterKeyForMachine, unwrapSecretForMachine, wrapSecretForMachine, zeroKey, type MachineWrappedKey } from '../storage/app-home.js';
import { zeroMachineKey } from '../auth/machine-key.js';
import { INSTALLATION_RECOVERY_SETTING } from '../storage/installation-recovery.js';
import { instanceDir } from '../lifecycle/instance-dir.js';
import { backupErrorCode, type BackupEngine, type TargetCall } from './engine.js';
import { cardKeyLabel, cardPassword, KEY_LABEL_BACKUP, snapshotTags, tagValue, type SnapshotInfo, type TargetRuntime } from './restic.js';
import { checkTargetValues, loadTargetPackages, REDACTED, type LoadedTargetPackage } from './targets.js';
import { checkPolicy, DEFAULT_APP_POLICY, DEFAULT_BACKUP_POLICY, effectiveSchedule, fitsCap, isDue, isStale, MAX_WARM_PASSES, nextWindowStart, WINDOW_RE } from './schedule.js';
import { isStagePath, type InstanceRecord, type StageFile } from './step.js';

const S = {
  policy: 'backups.policy',
  apps: 'backups.apps',
  targets: 'backups.targets',
  secrets: 'backups.targetSecrets',
  key: 'backups.key',
  snapshots: 'backups.snapshots',
  previous: 'backups.previous',
} as const;

export interface StoredTarget {
  id: string;
  packageId: string;
  revision: string;
  name: string;
  config: Record<string, string>;
  createdAt: string;
  repo: BackupTargetDto['repo'];
  note: string | null;
  checkedAt: string | null;
  lastPruneAt: string | null;
  lastCheckAt: string | null;
  cardIssuedAt: string | null; // which Harbor card is a key there (rotation re-keys on the next run)
}
interface StoredAppPolicy extends BackupAppPolicyDto {
  enabledAt?: string;
}
type SnapshotCache = Record<string, { at: string; items: SnapshotInfo[] }>;

// One app's run while it is in flight: the key and state slice live in memory only.
interface RunContext {
  runId: string;
  inst: InstanceRow;
  home: string;
  calls: { stored: StoredTarget; call: TargetCall }[];
  stage: StageFile[];
  results: Map<string, BackupRunTarget>;
  warmSnapshots: Map<string, string[]>;
  totalBytes: number;
  capSeconds: number;
}

const PRUNE_EVERY_MS = 7 * 24 * 60 * 60_000;
const CHECK_EVERY_MS = 30 * 24 * 60 * 60_000;

function readStageTree(root: string, prefix: string): StageFile[] {
  const out: StageFile[] = [];
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root).sort()) {
    const p = path.join(root, e);
    const st = lstatSync(p);
    const rel = `${prefix}/${e}`;
    if (st.isDirectory()) out.push(...readStageTree(p, rel));
    else if (st.isFile()) out.push({ path: rel, base64: readFileSync(p).toString('base64') });
  }
  return out;
}

export class BackupService {
  private packagesCache: LoadedTargetPackage[] | null = null;
  private queue: { instanceId: string; trigger: 'schedule' | 'manual'; at: string }[] = [];
  private maintenanceQueued = false;
  private working = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private activity = new Map<string, BackupActivityDto>();
  private runs = new Map<string, RunContext>();
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: Ctx,
    readonly engine: BackupEngine,
    private readonly packagesDir: string,
    private readonly tools: { available: () => { ok: boolean; reason: string | null } } = { available: () => ({ ok: true, reason: null }) },
  ) {}

  // ---------------------------------------------------------------- lifecycle

  start(tickMs = 30_000): void {
    const n = this.ctx.repo.failRunningBackupRuns('the daemon restarted while this run was in flight; it was not resumed');
    if (n) this.ctx.log.warn(`marked ${n} interrupted backup run(s) failed`);
    this.timer = setInterval(() => void this.tick().catch((e: Error) => this.ctx.log.warn(`backup scheduler tick failed: ${e.message}`)), tickMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.runs.values()) zeroKeyFromStage(r.stage);
  }
  // tests: wait until the worker has nothing left
  async drain(): Promise<void> {
    while (this.working || this.queue.length) await this.idle;
  }

  // ---------------------------------------------------------------- packages & settings

  packages(): LoadedTargetPackage[] {
    if (!this.packagesCache) this.packagesCache = loadTargetPackages(this.packagesDir);
    return this.packagesCache;
  }
  private pkg(id: string): LoadedTargetPackage {
    const p = this.packages().find((x) => x.manifest.metadata.id === id);
    if (!p) throw new HarborError('NOT_FOUND', `no backup place type ${id}`);
    return p;
  }
  policy(): BackupPolicyDto {
    const p = this.ctx.repo.setting<BackupPolicyDto>(S.policy);
    return { ...DEFAULT_BACKUP_POLICY, ...(p ?? {}), retention: { ...DEFAULT_BACKUP_POLICY.retention, ...(p?.retention ?? {}) } };
  }
  setPolicy(next: Partial<BackupPolicyDto>): BackupPolicyDto {
    const merged = { ...this.policy(), ...next, retention: { ...this.policy().retention, ...(next.retention ?? {}) } };
    const err = checkPolicy(merged);
    if (err) throw new HarborError('INVALID_REQUEST', err);
    this.ctx.repo.setSetting(S.policy, merged);
    return merged;
  }
  private appPolicies(): Record<string, StoredAppPolicy> {
    return this.ctx.repo.setting<Record<string, StoredAppPolicy>>(S.apps) ?? {};
  }
  appPolicy(instanceId: string): BackupAppPolicyDto {
    const p = this.appPolicies()[instanceId];
    const { enabledAt: _e, ...rest } = { ...DEFAULT_APP_POLICY, ...(p ?? {}) };
    return { ...rest, targets: rest.targets.filter((t) => this.targetsStored().some((x) => x.id === t)) };
  }
  setAppPolicy(instanceId: string, next: Partial<BackupAppPolicyDto>): AppBackupsDto {
    const inst = this.instanceOr404(instanceId);
    const all = this.appPolicies();
    const prev = all[instanceId] ?? { ...DEFAULT_APP_POLICY };
    const merged: StoredAppPolicy = { ...prev, ...next };
    if (merged.window !== null && !WINDOW_RE.test(merged.window)) throw new HarborError('INVALID_REQUEST', 'window must be HH:MM (24-hour)');
    if (merged.weekday !== null && (!Number.isInteger(merged.weekday) || merged.weekday < 0 || merged.weekday > 6)) throw new HarborError('INVALID_REQUEST', 'weekday must be 0 (Sunday) to 6');
    for (const t of merged.targets) if (!this.targetsStored().some((x) => x.id === t)) throw new HarborError('NOT_FOUND', `no backup place ${t}`);
    merged.targets = [...new Set(merged.targets)];
    if (merged.enabled) {
      const reason = this.ineligible(inst);
      if (reason) throw new HarborError('INVALID_STATE', reason.message, { nextAction: reason.next });
      if (!merged.targets.length) throw new HarborError('INVALID_REQUEST', 'pick at least one place to back up to');
      if (!prev.enabled) merged.enabledAt = this.ctx.repo.now();
    }
    all[instanceId] = merged;
    this.ctx.repo.setSetting(S.apps, all);
    if (!merged.enabled) for (const k of [`backup-failed:${instanceId}`, `backup-stale:${instanceId}`, `backup-skipped:${instanceId}`]) this.ctx.notifier.resolve(k);
    return this.appBackupsSync(inst);
  }
  // an app that is purged loses its policy (its restore points stay at the places)
  forgetApp(instanceId: string): void {
    const all = this.appPolicies();
    if (!all[instanceId]) return;
    delete all[instanceId];
    this.ctx.repo.setSetting(S.apps, all);
  }

  private targetsStored(): StoredTarget[] {
    return this.ctx.repo.setting<StoredTarget[]>(S.targets) ?? [];
  }
  private saveTarget(t: StoredTarget): void {
    const all = this.targetsStored().filter((x) => x.id !== t.id);
    all.push(t);
    this.ctx.repo.setSetting(S.targets, all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  private target(id: string): StoredTarget {
    const t = this.targetsStored().find((x) => x.id === id);
    if (!t) throw new HarborError('NOT_FOUND', `no backup place ${id}`);
    return t;
  }
  private secretsFor(id: string): Record<string, string> {
    return (this.ctx.repo.setting<Record<string, Record<string, string>>>(S.secrets) ?? {})[id] ?? {};
  }
  private setSecretsFor(id: string, v: Record<string, string> | null): void {
    const all = this.ctx.repo.setting<Record<string, Record<string, string>>>(S.secrets) ?? {};
    if (v) all[id] = v;
    else delete all[id];
    this.ctx.repo.setSetting(S.secrets, all);
  }

  private runtime(t: StoredTarget): TargetRuntime {
    const m = this.pkg(t.packageId).manifest;
    return { id: t.id, transport: m.transport, ...(m.rclone ? { backend: m.rclone.backend } : {}), config: { ...t.config }, fields: m.fields.map((f) => ({ id: f.id, ...(f.rclone ? { rclone: f.rclone } : {}), ...(f.obscure ? { obscure: true } : {}), ...(f.type === 'secret' ? { secret: true } : {}) })) };
  }

  // ---------------------------------------------------------------- keys

  private machineKeyOrThrow(): Buffer {
    const k = this.ctx.machineKey.take();
    if (!k) throw new HarborError('INVALID_STATE', 'Harbor restarted since your last login, so it cannot reach its backup key', { nextAction: 'Log in again; backups resume on their own.' });
    return k;
  }
  // The backup key: 32 random bytes, stored only wrapped under the machine key (like the recovery card).
  private backupPassword(create: boolean): string {
    const mk = this.machineKeyOrThrow();
    try {
      const wrapped = this.ctx.repo.setting<MachineWrappedKey>(S.key);
      if (wrapped) {
        const k = unwrapSecretForMachine(wrapped, mk);
        try {
          return k.toString('hex');
        } finally {
          zeroKey(k);
        }
      }
      if (!create) throw new HarborError('INVALID_STATE', 'this Harbor has no backup key yet', { nextAction: 'Add a place in Settings → Backups.' });
      const k = randomBytes(32);
      try {
        this.ctx.repo.setSetting(S.key, wrapSecretForMachine(k, mk));
        return k.toString('hex');
      } finally {
        zeroKey(k);
      }
    } finally {
      zeroMachineKey(mk);
    }
  }
  private card(): { words: string; minted: boolean; issuedAt: string } {
    const c = this.ctx.service.ensureInstallationRecoveryKey();
    if (!c) throw new HarborError('INVALID_STATE', 'Harbor cannot reach its recovery key right now', { nextAction: 'Log in again, then try again.' });
    const issuedAt = this.ctx.repo.setting<{ createdAt?: string }>(INSTALLATION_RECOVERY_SETTING)?.createdAt ?? this.ctx.repo.now();
    return { ...c, issuedAt };
  }
  private call(t: StoredTarget, password?: string): TargetCall {
    return { target: this.runtime(t), password: password ?? this.backupPassword(false), secrets: this.secretsFor(t.id) };
  }

  // Rotation (decision 150): the place gets the current card as a key and loses the previous one.
  private async rekeyCard(t: StoredTarget, c: TargetCall): Promise<void> {
    const card = this.card();
    if (t.cardIssuedAt === card.issuedAt) return;
    const label = cardKeyLabel(card.issuedAt);
    const keys = await this.engine.keys(c);
    if (!keys.some((k) => k.label === label)) await this.engine.addKey(c, cardPassword(card.words), label);
    for (const k of keys) if (k.label.startsWith('harbor-card-') && k.label !== label && !k.current) await this.engine.removeKey(c, k.id);
    this.saveTarget({ ...this.target(t.id), cardIssuedAt: card.issuedAt });
    this.ctx.log.info(`backup place ${t.name} now opens with the current Harbor recovery key`, { targetId: t.id });
  }

  // ---------------------------------------------------------------- targets

  async addTarget(packageId: string, name: string, values: Record<string, string>): Promise<{ target: BackupTargetDto; recoveryKey: string | null }> {
    const p = this.pkg(packageId);
    const label = name.trim();
    if (!label || label.length > 64) throw new HarborError('INVALID_REQUEST', 'give the place a name (up to 64 characters)');
    if (this.targetsStored().some((x) => x.name === label)) throw new HarborError('NAME_CONFLICT', `there is already a place called ${label}`);
    const { config, secrets } = checkTargetValues(p.manifest, values);
    const card = this.card();
    const password = this.backupPassword(true);
    // a new place's first prune is in a week and its first check in a month (nothing to clean or verify yet)
    const t: StoredTarget = { id: this.ctx.ids.uuid(), packageId, revision: p.manifest.release.revision, name: label, config, createdAt: this.ctx.repo.now(), repo: 'unknown', note: null, checkedAt: null, lastPruneAt: this.ctx.repo.now(), lastCheckAt: this.ctx.repo.now(), cardIssuedAt: null };
    const call: TargetCall = { target: this.runtime(t), password, secrets };
    const tested = await this.engine.test(call); // unreachable/invalid → throws, nothing is stored
    if (tested.hostKey) t.config['hostKey'] = tested.hostKey;
    if (tested.repo === 'missing') {
      await this.engine.init({ ...call, target: this.runtime(t) }, cardPassword(card.words), cardKeyLabel(card.issuedAt));
      t.repo = 'ready';
      t.cardIssuedAt = card.issuedAt;
    } else if (tested.repo === 'ours') {
      t.repo = 'ready';
    } else {
      t.repo = 'foreign';
      t.note = 'Backups of another Harbor are here. Open them with that Harbor\'s recovery key to restore its apps, or pick an empty folder.';
    }
    t.checkedAt = this.ctx.repo.now();
    this.setSecretsFor(t.id, secrets);
    this.saveTarget(t);
    this.ctx.log.info(`added backup place ${t.name} (${packageId})`, { targetId: t.id, repo: t.repo });
    return { target: this.targetDto(t), recoveryKey: card.minted ? card.words : null };
  }

  async updateTarget(id: string, o: { name?: string; values?: Record<string, string> }): Promise<BackupTargetDto> {
    const t = this.target(id);
    const p = this.pkg(t.packageId);
    let next = { ...t };
    if (o.name !== undefined) {
      const label = o.name.trim();
      if (!label || label.length > 64) throw new HarborError('INVALID_REQUEST', 'give the place a name (up to 64 characters)');
      if (this.targetsStored().some((x) => x.id !== id && x.name === label)) throw new HarborError('NAME_CONFLICT', `there is already a place called ${label}`);
      next.name = label;
    }
    if (o.values) {
      const stored = this.secretsFor(id);
      const { config, secrets } = checkTargetValues(p.manifest, o.values, stored);
      // keep a pinned server key unless the operator replaced it
      if (t.config['hostKey'] && config['hostKey'] === undefined && p.manifest.transport === 'sftp' && config['host'] === t.config['host']) config['hostKey'] = t.config['hostKey'];
      next = { ...next, config };
      const tested = await this.engine.test({ target: this.runtime(next), password: this.backupPassword(false), secrets });
      if (tested.hostKey) next.config['hostKey'] = tested.hostKey;
      next.repo = tested.repo === 'ours' ? 'ready' : tested.repo === 'foreign' ? 'foreign' : 'unknown';
      if (tested.repo === 'missing') {
        const card = this.card();
        await this.engine.init({ target: this.runtime(next), password: this.backupPassword(false), secrets }, cardPassword(card.words), cardKeyLabel(card.issuedAt));
        next.repo = 'ready';
        next.cardIssuedAt = card.issuedAt;
      }
      next.checkedAt = this.ctx.repo.now();
      next.note = next.repo === 'foreign' ? 'Backups of another Harbor are here. Open them with that Harbor\'s recovery key.' : null;
      this.setSecretsFor(id, secrets);
    }
    this.saveTarget(next);
    return this.targetDto(next);
  }

  async testTarget(id: string): Promise<BackupTargetDto> {
    const t = this.target(id);
    const next = { ...t, checkedAt: this.ctx.repo.now() };
    try {
      const r = await this.engine.test(this.call(t));
      next.repo = r.repo === 'ours' ? 'ready' : r.repo === 'foreign' ? 'foreign' : 'unknown';
      next.note = r.repo === 'missing' ? 'The backups that were here are gone (the folder or bucket is empty now). Edit the place to set it up again.' : r.repo === 'foreign' ? t.note : null;
      if (next.repo === 'ready') this.ctx.notifier.resolve(`backup-target:${id}`);
    } catch (e) {
      next.repo = 'unreachable';
      next.note = e instanceof Error ? e.message : String(e);
    }
    this.saveTarget(next);
    return this.targetDto(next);
  }

  // Another Harbor's backups at this place: its recovery card opens them, and this Harbor adds its own
  // key next to it, so it can restore those apps (and back up there from now on).
  async openForeign(id: string, recoveryKey: string): Promise<BackupTargetDto> {
    const t = this.target(id);
    if (t.repo !== 'foreign') throw new HarborError('INVALID_STATE', `${t.name} already opens with this Harbor's key`);
    const words = cardPassword(recoveryKey);
    if (words.split(' ').length !== 12) throw new HarborError('INVALID_REQUEST', 'a Harbor recovery key is 12 words');
    const mine = this.backupPassword(true);
    const call = { ...this.call(t, words) };
    try {
      await this.engine.addKey(call, mine, `${KEY_LABEL_BACKUP}-${this.ctx.installationId.slice(0, 8)}`);
    } catch (e) {
      if (backupErrorCode(e) === 'wrong-password') throw new HarborError('INVALID_REQUEST', 'that recovery key does not open the backups there', { nextAction: 'Check the 12 words (the card of the Harbor that made these backups).' });
      throw e;
    }
    const card = this.card();
    const own = { ...call, password: mine };
    await this.engine.addKey(own, cardPassword(card.words), cardKeyLabel(card.issuedAt));
    const next: StoredTarget = { ...t, repo: 'ready', note: null, checkedAt: this.ctx.repo.now(), cardIssuedAt: card.issuedAt, lastPruneAt: this.ctx.repo.now(), lastCheckAt: this.ctx.repo.now() };
    this.saveTarget(next);
    await this.refreshSnapshots(next).catch(() => undefined);
    this.ctx.log.info(`opened another Harbor's backups at ${t.name}`, { targetId: id });
    return this.targetDto(next);
  }

  async removeTarget(id: string, o: { deleteBackups: boolean; confirmName?: string }): Promise<{ removed: number }> {
    const t = this.target(id);
    if (o.deleteBackups && o.confirmName !== t.name) throw new HarborError('INVALID_REQUEST', `type the place's name (${t.name}) to delete the backups stored there`);
    if ([...this.runs.values()].some((r) => r.calls.some((c) => c.stored.id === id))) throw new HarborError('BUSY', `a backup is writing to ${t.name} right now`, { nextAction: 'Try again when it finishes.' });
    let removed = 0;
    try {
      const pw = t.repo === 'ready' ? this.backupPassword(false) : 'unused';
      removed = await this.engine.forgetTarget(this.call(t, pw), { deleteBackups: o.deleteBackups && t.repo === 'ready', filterTags: `harbor:${this.ctx.installationId}` });
    } catch (e) {
      if (o.deleteBackups) throw e;
      this.ctx.log.warn(`could not clean up after ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const apps = this.appPolicies();
    for (const [k, v] of Object.entries(apps)) {
      v.targets = v.targets.filter((x) => x !== id);
      if (!v.targets.length) v.enabled = false;
      apps[k] = v;
    }
    this.ctx.repo.setSetting(S.apps, apps);
    this.ctx.repo.setSetting(S.targets, this.targetsStored().filter((x) => x.id !== id));
    this.setSecretsFor(id, null);
    const cache = this.snapshotCache();
    delete cache[id];
    this.ctx.repo.setSetting(S.snapshots, cache);
    this.ctx.notifier.resolve(`backup-target:${id}`);
    return { removed };
  }

  async unlockTarget(id: string): Promise<BackupTargetDto> {
    const t = this.target(id);
    await this.engine.unlock(this.call(t));
    return this.targetDto(t);
  }

  private targetDto(t: StoredTarget): BackupTargetDto {
    const p = this.packages().find((x) => x.manifest.metadata.id === t.packageId);
    const secrets = this.secretsFor(t.id);
    const values: Record<string, string> = { ...t.config };
    for (const k of Object.keys(secrets)) values[k] = REDACTED;
    const usedBy = Object.entries(this.appPolicies())
      .filter(([, v]) => v.targets.includes(t.id))
      .map(([instanceId]) => {
        const i = this.ctx.repo.instance(instanceId);
        return i ? { instanceId, name: i.displayName ?? i.name } : null;
      })
      .filter((x): x is { instanceId: string; name: string } => x !== null);
    return { id: t.id, packageId: t.packageId, packageName: p?.manifest.metadata.name ?? t.packageId, status: p?.manifest.metadata.status ?? 'stable', name: t.name, values, createdAt: t.createdAt, repo: t.repo, note: t.note, checkedAt: t.checkedAt, lastPruneAt: t.lastPruneAt, lastCheckAt: t.lastCheckAt, usedBy };
  }

  packageDtos(): BackupTargetPackageDto[] {
    return this.packages().map(({ manifest: m, readme }) => ({
      id: m.metadata.id,
      name: m.metadata.name,
      description: m.metadata.description,
      status: m.metadata.status,
      revision: m.release.revision,
      transport: m.transport,
      fields: m.fields.map((f) => ({ id: f.id, label: f.label, type: f.type, required: f.required === true, default: f.default ?? null, hint: f.hint ?? null })),
      readme,
    }));
  }

  // ---------------------------------------------------------------- snapshots / restore points

  private snapshotCache(): SnapshotCache {
    return this.ctx.repo.setting<SnapshotCache>(S.snapshots) ?? {};
  }
  async refreshSnapshots(t: StoredTarget): Promise<SnapshotInfo[]> {
    const items = await this.engine.snapshots(this.call(t), 'kind:cold');
    const cache = this.snapshotCache();
    cache[t.id] = { at: this.ctx.repo.now(), items };
    this.ctx.repo.setSetting(S.snapshots, cache);
    return items;
  }
  restorePoints(instanceId: string, onlyTarget?: string): RestorePointDto[] {
    const cache = this.snapshotCache();
    const points = new Map<string, RestorePointDto>();
    for (const t of this.targetsStored()) {
      if (onlyTarget && t.id !== onlyTarget) continue;
      for (const s of cache[t.id]?.items ?? []) {
        if (tagValue(s.tags, 'app') !== instanceId || tagValue(s.tags, 'kind') !== 'cold') continue;
        const runId = tagValue(s.tags, 'run') ?? s.id;
        const p = points.get(runId) ?? { runId, time: s.time, instanceId, packageId: tagValue(s.tags, 'pkg') ?? '', totalBytes: s.totalBytes, places: [] };
        p.places.push({ targetId: t.id, name: t.name, snapshotId: s.id });
        if (s.time < p.time) p.time = s.time;
        points.set(runId, p);
      }
    }
    return [...points.values()].sort((a, b) => b.time.localeCompare(a.time));
  }
  // A place's apps, for restoring on this machine (another Harbor's, or ones purged here).
  async foundApps(targetId: string): Promise<FoundBackupAppDto[]> {
    const t = this.target(targetId);
    if (t.repo !== 'ready') throw new HarborError('INVALID_STATE', `${t.name} does not open with this Harbor's key yet`, { nextAction: t.repo === 'foreign' ? 'Open it with the recovery key of the Harbor that made these backups.' : 'Test the place first.' });
    const items = await this.refreshSnapshots(t);
    const ids = [...new Set(items.map((s) => tagValue(s.tags, 'app')).filter((x): x is string => !!x && UUID_RE.test(x)))];
    return ids.map((instanceId) => {
      const points = this.restorePoints(instanceId, targetId);
      const latest = items.filter((s) => tagValue(s.tags, 'app') === instanceId).at(-1);
      const pkg = latest ? (tagValue(latest.tags, 'pkg') ?? '') : '';
      const home = latest?.paths.find((p) => !isStagePath(p)) ?? '';
      const here = this.ctx.repo.instance(instanceId);
      return { instanceId, packageId: pkg, name: home.split('/').pop() ?? pkg, installedHere: here !== null && !here.purgedAt, points };
    });
  }
  // Resolve a restore point to one snapshot at one place (the first that holds it, unless asked).
  resolvePoint(instanceId: string, runId: string, targetId?: string): { target: StoredTarget; snapshot: SnapshotInfo; home: string; stage: string } {
    const cache = this.snapshotCache();
    for (const t of this.targetsStored()) {
      if (targetId && t.id !== targetId) continue;
      if (t.repo !== 'ready') continue;
      const s = (cache[t.id]?.items ?? []).find((x) => tagValue(x.tags, 'app') === instanceId && tagValue(x.tags, 'run') === runId && tagValue(x.tags, 'kind') === 'cold');
      if (!s) continue;
      const stage = s.paths.find((p) => isStagePath(p));
      const home = s.paths.find((p) => !isStagePath(p));
      if (!stage || !home) continue;
      return { target: t, snapshot: s, home, stage };
    }
    throw new HarborError('NOT_FOUND', 'that restore point is not at any place this Harbor can open', { nextAction: 'Refresh the restore points (the place may be offline), then try again.' });
  }
  callFor(targetId: string): TargetCall {
    return this.call(this.target(targetId));
  }

  // ---------------------------------------------------------------- eligibility

  private homeRow(instanceId: string): ResourceRow | undefined {
    return this.ctx.repo.resources(instanceId).find((r) => r.kind === 'volume' && r.role === '__home__');
  }
  ineligible(inst: InstanceRow): { message: string; next: string } | null {
    if (inst.installState !== 'installed') return { message: `${inst.name} is ${inst.installState}`, next: 'Backups resume once it is installed again.' };
    if (!this.homeRow(inst.id)) return { message: `${inst.name} keeps its data in plain Docker volumes, which Harbor does not back up`, next: `Encrypt it first (app drawer → Encrypt, or: harbor seal ${inst.name}); its data then lives in a home Harbor can back up.` };
    return null;
  }
  private instanceOr404(id: string): InstanceRow {
    const i = this.ctx.repo.instance(id);
    if (!i || i.purgedAt) throw new HarborError('NOT_FOUND', `unknown instance ${id}`);
    return i;
  }

  // ---------------------------------------------------------------- DTOs

  private runDto(r: BackupRunRow): BackupRunDto {
    const i = r.instanceId ? this.ctx.repo.instance(r.instanceId) : null;
    return { id: r.id, instanceId: r.instanceId, instanceName: i ? (i.displayName ?? i.name) : null, kind: r.kind, trigger: r.trigger, state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt, downtimeSeconds: r.downtimeMs === null ? null : Math.round(r.downtimeMs / 1000), bytesAdded: r.bytesAdded, totalBytes: r.totalBytes, message: r.message, operationId: r.operationId, targets: r.targets };
  }
  private appDto(inst: InstanceRow): BackupAppDto {
    const policy = this.appPolicy(inst.id);
    const reason = this.ineligible(inst);
    const runs = this.ctx.repo.backupRuns({ instanceId: inst.id, kind: 'backup', limit: 20 });
    const last = runs[0] ?? null;
    const success = runs.find((r) => r.state === 'succeeded' || r.state === 'partial');
    const g = this.policy();
    const nextAt = policy.enabled && !reason && !g.paused ? nextWindowStart(this.ctx.clock.now(), effectiveSchedule(g, policy)).toISOString() : null;
    return { instanceId: inst.id, name: inst.displayName ?? inst.name, packageId: inst.packageId, eligible: !reason, reason: reason ? `${reason.message}. ${reason.next}` : null, policy, nextAt, lastRun: last ? this.runDto(last) : null, lastSuccessAt: success?.finishedAt ?? null };
  }
  overview(): BackupsOverviewDto {
    const tools = this.tools.available();
    const apps = this.ctx.repo.listInstances().filter((i) => !i.purgedAt && i.installState !== 'retained');
    return {
      available: tools.ok,
      reason: tools.reason,
      engine: this.engine.kind,
      keyReady: this.ctx.repo.setting(S.key) !== null,
      policy: this.policy(),
      packages: this.packageDtos(),
      targets: this.targetsStored().map((t) => this.targetDto(t)),
      apps: apps.map((i) => this.appDto(i)),
      activity: [...this.activity.values()],
      recent: this.ctx.repo.backupRuns({ limit: 20 }).map((r) => this.runDto(r)),
    };
  }
  private appBackupsSync(inst: InstanceRow): AppBackupsDto {
    const prev = (this.ctx.repo.setting<Record<string, { path: string; createdAt: string }>>(S.previous) ?? {})[inst.id] ?? null;
    return { ...this.appDto(inst), runs: this.ctx.repo.backupRuns({ instanceId: inst.id, limit: 30 }).map((r) => this.runDto(r)), points: this.restorePoints(inst.id), previous: prev && existsSync(prev.path) ? prev : null };
  }
  async appBackups(instanceId: string, refresh = false): Promise<AppBackupsDto> {
    const inst = this.instanceOr404(instanceId);
    if (refresh) {
      for (const t of this.targetsStored().filter((x) => x.repo === 'ready')) {
        try {
          await this.refreshSnapshots(t);
        } catch (e) {
          this.ctx.log.warn(`could not list restore points at ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return this.appBackupsSync(inst);
  }
  setPrevious(instanceId: string, v: { path: string; createdAt: string } | null): void {
    const all = this.ctx.repo.setting<Record<string, { path: string; createdAt: string }>>(S.previous) ?? {};
    if (v) all[instanceId] = v;
    else delete all[instanceId];
    this.ctx.repo.setSetting(S.previous, all);
  }
  previous(instanceId: string): { path: string; createdAt: string } | null {
    return (this.ctx.repo.setting<Record<string, { path: string; createdAt: string }>>(S.previous) ?? {})[instanceId] ?? null;
  }

  // ---------------------------------------------------------------- scheduling

  async tick(): Promise<void> {
    if (this.stopping) return;
    const g = this.policy();
    if (g.paused) return;
    const now = this.ctx.clock.now();
    const due: InstanceRow[] = [];
    for (const [instanceId, p] of Object.entries(this.appPolicies())) {
      if (!p.enabled || !p.targets.length) continue;
      const inst = this.ctx.repo.instance(instanceId);
      if (!inst || inst.purgedAt) continue;
      if (this.queue.some((q) => q.instanceId === instanceId) || this.activity.has(instanceId)) continue;
      const s = effectiveSchedule(g, p);
      const last = this.ctx.repo.backupRuns({ instanceId, kind: 'backup', limit: 10 }).find((r) => r.trigger === 'schedule');
      if (isDue(now, s, last ? new Date(last.startedAt) : null)) due.push(inst);
      const success = this.ctx.repo.backupRuns({ instanceId, kind: 'backup', limit: 30 }).find((r) => r.state === 'succeeded' || r.state === 'partial');
      if (isStale(now, s, success?.finishedAt ? new Date(success.finishedAt) : null, new Date(p.enabledAt ?? now.toISOString()))) {
        this.ctx.notifier.notify({ kind: 'backup-stale', severity: 'warning', title: `${inst.displayName ?? inst.name} has no recent backup`, body: `No restore point since ${success?.finishedAt ?? 'it was turned on'}. Check Settings → Backups.`, instanceId, dedupeKey: `backup-stale:${instanceId}` });
      }
    }
    // one at a time, by name, so the night is predictable
    due.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of due) this.enqueue(d.id, 'schedule');
    // prune/check go through the same worker as backups (one thing per place at a time), and never next to
    // an operation (a restore reads a place while a prune would rewrite it)
    if (!due.length && !this.working && !this.maintenanceQueued && this.ctx.repo.activeOperations().length === 0 && this.maintenanceDue()) {
      this.maintenanceQueued = true;
      this.kick();
    }
  }

  // "Back up now" and the scheduler both land here; one app at a time.
  enqueue(instanceId: string, trigger: 'schedule' | 'manual'): void {
    if (this.queue.some((q) => q.instanceId === instanceId) || this.activity.has(instanceId)) return;
    this.queue.push({ instanceId, trigger, at: this.ctx.repo.now() });
    const inst = this.ctx.repo.instance(instanceId);
    if (inst) this.activity.set(instanceId, { instanceId, name: inst.displayName ?? inst.name, phase: 'queued', percent: null, since: this.ctx.repo.now() });
    this.kick();
  }
  runNow(instanceId: string): AppBackupsDto {
    const inst = this.instanceOr404(instanceId);
    const reason = this.ineligible(inst);
    if (reason) throw new HarborError('INVALID_STATE', reason.message, { nextAction: reason.next });
    const p = this.appPolicy(instanceId);
    if (!p.targets.length) throw new HarborError('INVALID_REQUEST', `${inst.name} has no place to back up to`, { nextAction: 'Pick one in the app\'s Backups tab.' });
    this.enqueue(instanceId, 'manual');
    return this.appBackupsSync(inst);
  }
  private kick(): void {
    if (this.working || this.stopping) return;
    this.working = true;
    this.idle = (async () => {
      try {
        while (!this.stopping) {
          const next = this.queue.shift();
          if (!next) {
            if (!this.maintenanceQueued) break;
            this.maintenanceQueued = false;
            await this.maintain().catch((e: Error) => this.ctx.log.warn(`backup maintenance failed: ${e.message}`));
            continue;
          }
          try {
            await this.runApp(next.instanceId, next.trigger);
          } catch (e) {
            this.ctx.log.warn(`backup of ${next.instanceId} failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            this.activity.delete(next.instanceId);
          }
        }
      } finally {
        this.working = false;
      }
    })();
  }

  private setActivity(inst: InstanceRow, phase: BackupActivityDto['phase'], percent: number | null = null): void {
    const prev = this.activity.get(inst.id);
    this.activity.set(inst.id, { instanceId: inst.id, name: inst.displayName ?? inst.name, phase, percent, since: prev?.phase === phase ? prev.since : this.ctx.repo.now() });
  }

  // The app's master key, for its state slice: this boot's held copy, or the machine wrapping.
  private masterKeyFor(inst: InstanceRow): Buffer | null {
    const held = this.ctx.service.takeAppUnlockCopy(inst.id);
    if (held) return held;
    const wrapped = this.homeRow(inst.id)?.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
    if (!wrapped) return null;
    const mk = this.ctx.machineKey.take();
    if (!mk) return null;
    try {
      return unwrapMasterKeyForMachine(wrapped, mk);
    } finally {
      zeroMachineKey(mk);
    }
  }

  private buildStage(inst: InstanceRow, home: string, masterKey: Buffer): StageFile[] {
    const dir = instanceDir(this.ctx.config.stateDir, inst.id);
    const record: InstanceRecord = { format: 1, instanceId: inst.id, name: inst.name, displayName: inst.displayName, packageId: inst.packageId, revision: inst.revision, home, installationId: this.ctx.installationId, harborVersion: this.ctx.version, at: this.ctx.repo.now() };
    const files: StageFile[] = [
      { path: 'instance.json', base64: Buffer.from(JSON.stringify(record, null, 2)).toString('base64') },
      { path: 'home-manifest.json', base64: readFileSync(path.join(home, 'manifest.json')).toString('base64') },
      // inside the encrypted repository only: whoever opens it already reads the app's data in clear
      { path: 'app-key', base64: Buffer.from(masterKey.toString('hex')).toString('base64') },
      ...readStageTree(path.join(dir, 'secrets'), 'secrets'),
      ...readStageTree(path.join(dir, 'release'), 'release'),
    ];
    return files;
  }

  private finish(runId: string, inst: InstanceRow, state: 'succeeded' | 'partial' | 'failed' | 'skipped', message: string, extra: { downtimeMs?: number | null; ctx?: RunContext; operationId?: string } = {}): void {
    const r = extra.ctx;
    const targets = r ? [...r.results.values()] : undefined;
    const bytes = targets ? targets.reduce((n, t) => n + (t.bytesAdded ?? 0), 0) : null;
    this.ctx.repo.finishBackupRun(runId, { state, message, downtimeMs: extra.downtimeMs ?? null, bytesAdded: bytes, totalBytes: r?.totalBytes ?? null, ...(extra.operationId ? { operationId: extra.operationId } : {}), ...(targets ? { targets } : {}) });
    const label = inst.displayName ?? inst.name;
    if (state === 'succeeded' || state === 'partial') {
      for (const k of [`backup-failed:${inst.id}`, `backup-stale:${inst.id}`, `backup-skipped:${inst.id}`]) this.ctx.notifier.resolve(k);
      if (state === 'partial') this.ctx.notifier.notify({ kind: 'backup-failed', severity: 'warning', title: `${label} was backed up to some places only`, body: message, instanceId: inst.id, dedupeKey: `backup-failed:${inst.id}` });
    } else if (state === 'failed') {
      this.ctx.notifier.notify({ kind: 'backup-failed', severity: 'error', title: `Backup of ${label} failed`, body: message, instanceId: inst.id, dedupeKey: `backup-failed:${inst.id}` });
    } else {
      this.ctx.notifier.notify({ kind: 'backup-skipped', severity: 'warning', title: `Backup of ${label} was skipped`, body: message, instanceId: inst.id, dedupeKey: `backup-skipped:${inst.id}` });
    }
  }

  private async runApp(instanceId: string, trigger: 'schedule' | 'manual'): Promise<void> {
    const inst = this.ctx.repo.instance(instanceId);
    if (!inst) return;
    const runId = this.ctx.ids.uuid();
    this.ctx.repo.insertBackupRun({ id: runId, instanceId, kind: 'backup', trigger });
    const reason = this.ineligible(inst);
    if (reason) return this.finish(runId, inst, 'skipped', `${reason.message}. ${reason.next}`);
    const home = this.homeRow(inst.id)!.name;
    if (this.ctx.service.needsDrive(inst.id)) return this.finish(runId, inst, 'skipped', `${inst.name} needs its drive; it is backed up again once the drive is back.`);
    if (this.ctx.crypto && this.ctx.crypto.kernelState(home) === 'locked') return this.finish(runId, inst, 'skipped', `${inst.name} is locked (Harbor restarted, or its own passphrase was not typed since). Log in or unlock it; the next window backs it up.`);
    const policy = this.appPolicy(instanceId);
    const stored = policy.targets.map((id) => this.targetsStored().find((t) => t.id === id)).filter((t): t is StoredTarget => !!t && t.repo === 'ready');
    if (!stored.length) return this.finish(runId, inst, 'skipped', 'none of its places is ready (test them in Settings → Backups).');
    let password: string;
    try {
      password = this.backupPassword(false);
    } catch (e) {
      return this.finish(runId, inst, 'skipped', e instanceof Error ? e.message : String(e));
    }
    const masterKey = this.masterKeyFor(inst);
    if (!masterKey) return this.finish(runId, inst, 'skipped', `${inst.name} is locked. Log in or unlock it; the next window backs it up.`);
    let stage: StageFile[];
    try {
      stage = this.buildStage(inst, home, masterKey);
    } finally {
      zeroKey(masterKey);
    }
    const g = this.policy();
    const run: RunContext = {
      runId,
      inst,
      home,
      calls: stored.map((t) => ({ stored: t, call: { target: this.runtime(t), password, secrets: this.secretsFor(t.id) } })),
      stage,
      results: new Map(),
      warmSnapshots: new Map(),
      totalBytes: 0,
      capSeconds: g.maxDowntimeMinutes * 60,
    };
    this.runs.set(runId, run);
    try {
      // keys first: a rotated recovery card is added before anything new is written there
      for (const c of [...run.calls]) {
        try {
          await this.rekeyCard(c.stored, c.call);
        } catch (e) {
          run.results.set(c.stored.id, { targetId: c.stored.id, name: c.stored.name, state: 'failed', snapshotId: null, bytesAdded: null, error: e instanceof Error ? e.message : String(e) });
          run.calls = run.calls.filter((x) => x !== c);
        }
      }
      if (!run.calls.length) return this.finish(runId, inst, 'failed', 'no place could be reached', { ctx: run });
      const running = inst.runtime === 'running' && inst.desired === 'running';
      if (!running) {
        // already stopped: one pass is consistent, nothing to stop or start
        this.setActivity(inst, 'cold');
        await this.pass(run, 'cold');
      } else {
        let converged = false;
        for (let i = 0; i < MAX_WARM_PASSES; i++) {
          this.setActivity(inst, 'warm');
          const r = await this.pass(run, 'warm');
          if (!r.ok) break;
          if (fitsCap(r.maxAdded, r.maxSeconds, run.capSeconds)) {
            converged = true;
            break;
          }
        }
        if (!run.calls.some((c) => run.warmSnapshots.has(c.stored.id))) {
          return this.finish(runId, inst, 'failed', [...run.results.values()].map((t) => `${t.name}: ${t.error}`).join(' · ') || 'no place took the copy', { ctx: run });
        }
        if (!converged) {
          return this.finish(runId, inst, 'skipped', `${inst.name} changes too fast to back up within ${g.maxDowntimeMinutes} min of downtime; it kept running. Raise the maximum downtime, or let its package declare a database export (later).`, { ctx: run });
        }
        // the cold pass is a mutation (stop/start): an operation in the serial queue
        this.setActivity(inst, 'cold');
        const opId = await this.submitCold(inst, runId);
        if (!opId) return this.finish(runId, inst, 'skipped', `${inst.name} was busy with another operation all window; the next window tries again.`, { ctx: run });
        this.ctx.repo.updateBackupRun(runId, { operationId: opId });
        const op = await this.waitOperation(opId);
        const downtimeMs = typeof op.result?.['downtimeMs'] === 'number' ? (op.result['downtimeMs'] as number) : null;
        if (op.state !== 'succeeded' && !run.calls.some((c) => run.results.get(c.stored.id)?.state === 'succeeded')) {
          return this.finish(runId, inst, 'failed', op.error ? `${op.error.message} Next: ${op.error.nextAction}` : 'the backup operation failed', { ctx: run, downtimeMs, operationId: opId });
        }
        await this.afterCold(run);
        const ok = [...run.results.values()].filter((t) => t.state === 'succeeded');
        const state = ok.length === stored.length && op.state === 'succeeded' ? 'succeeded' : ok.length ? 'partial' : 'failed';
        return this.finish(runId, inst, state, this.summary(run, op.state === 'succeeded' ? null : op.error?.message ?? null), { ctx: run, downtimeMs, operationId: opId });
      }
      await this.afterCold(run);
      const ok = [...run.results.values()].filter((t) => t.state === 'succeeded');
      this.finish(runId, inst, ok.length === stored.length ? 'succeeded' : ok.length ? 'partial' : 'failed', this.summary(run, null), { ctx: run, downtimeMs: 0 });
    } catch (e) {
      this.finish(runId, inst, 'failed', e instanceof Error ? e.message : String(e), { ctx: run });
    } finally {
      zeroKeyFromStage(run.stage);
      this.runs.delete(runId);
    }
  }

  private summary(run: RunContext, extra: string | null): string {
    const parts = [...run.results.values()].map((t) => (t.state === 'succeeded' ? `${t.name}: ok` : `${t.name}: ${t.error ?? t.state}`));
    return [parts.join(' · '), extra].filter(Boolean).join(' — ');
  }

  // One pass to every place in parallel. Warm passes never touch the app.
  private async pass(run: RunContext, kind: 'warm' | 'cold', deadlineSeconds?: number): Promise<{ ok: boolean; maxAdded: number; maxSeconds: number }> {
    let maxAdded = 0;
    let maxSeconds = 0;
    const tags = snapshotTags({ instanceId: run.inst.id, runId: run.runId, packageId: run.inst.packageId, installationId: this.ctx.installationId, kind });
    const results = await Promise.allSettled(
      run.calls.map(async (c) => {
        const started = Date.now();
        const r = await this.engine.backup(c.call, { instanceId: run.inst.id, home: run.home, tags, stage: run.stage, ...(deadlineSeconds ? { deadlineSeconds } : {}) }, (p) => this.setActivity(run.inst, kind, Math.round(p.percent * 100)));
        return { c, r, seconds: r.durationSeconds ?? (Date.now() - started) / 1000 };
      }),
    );
    let ok = false;
    results.forEach((res, i) => {
      const c = run.calls[i]!;
      if (res.status === 'fulfilled') {
        ok = true;
        const { r, seconds } = res.value;
        maxAdded = Math.max(maxAdded, r.dataAdded ?? 0);
        maxSeconds = Math.max(maxSeconds, seconds);
        run.totalBytes = Math.max(run.totalBytes, r.totalBytes ?? 0);
        if (kind === 'warm' && r.snapshotId) run.warmSnapshots.set(c.stored.id, [...(run.warmSnapshots.get(c.stored.id) ?? []), r.snapshotId]);
        if (kind === 'cold') run.results.set(c.stored.id, { targetId: c.stored.id, name: c.stored.name, state: 'succeeded', snapshotId: r.snapshotId ?? null, bytesAdded: (run.results.get(c.stored.id)?.bytesAdded ?? 0) + (r.dataAdded ?? 0), error: r.partial ? 'some files could not be read' : null });
        else run.results.set(c.stored.id, { targetId: c.stored.id, name: c.stored.name, state: 'skipped', snapshotId: null, bytesAdded: (run.results.get(c.stored.id)?.bytesAdded ?? 0) + (r.dataAdded ?? 0), error: null });
      } else {
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        run.results.set(c.stored.id, { targetId: c.stored.id, name: c.stored.name, state: 'failed', snapshotId: null, bytesAdded: run.results.get(c.stored.id)?.bytesAdded ?? null, error: msg });
        if (backupErrorCode(res.reason) === 'unreachable') this.ctx.notifier.notify({ kind: 'backup-target', severity: 'warning', title: `Cannot reach ${c.stored.name}`, body: msg, dedupeKey: `backup-target:${c.stored.id}` });
      }
    });
    // a place that failed a warm pass is left out of the cold pass (it would only stretch the downtime)
    if (kind === 'warm') run.calls = run.calls.filter((c) => run.results.get(c.stored.id)?.state !== 'failed');
    return { ok, maxAdded, maxSeconds };
  }

  private async submitCold(inst: InstanceRow, runId: string): Promise<string | null> {
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && !this.stopping) {
      try {
        const fresh = this.ctx.repo.instance(inst.id);
        if (fresh?.activeOperationId) throw new HarborError('BUSY', 'busy');
        const plan = await this.ctx.service.createPlan({ kind: 'backup', instanceId: inst.id, runId }, 'scheduler');
        return this.ctx.service.submit(plan.id, `backup:${runId}`, 'scheduler').operation.id;
      } catch (e) {
        if (!(e instanceof HarborError) || (e.code !== 'BUSY' && e.code !== 'STATE_CHANGED')) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return null;
  }
  private async waitOperation(id: string): Promise<{ state: string; result: Record<string, unknown> | null; error: { message: string; nextAction: string } | null }> {
    for (;;) {
      const op = this.ctx.repo.operation(id);
      if (op && ['succeeded', 'failed', 'needs_action'].includes(op.state)) {
        return { state: op.state, result: op.result, error: op.errorMessage ? { message: op.errorMessage, nextAction: op.nextAction ?? '' } : null };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Called by the runner's `backup` operation while the app is stopped: the cold pass, bounded by the cap.
  async coldPass(runId: string): Promise<{ succeeded: number; failed: string[] }> {
    const run = this.runs.get(runId);
    if (!run) throw new HarborError('STATE_CHANGED', 'this backup run is no longer in flight (the daemon restarted?)', { nextAction: 'The next window backs the app up again.' });
    await this.pass(run, 'cold', run.capSeconds);
    const res = run.calls.map((c) => run.results.get(c.stored.id)).filter((x): x is BackupRunTarget => !!x);
    return { succeeded: res.filter((r) => r.state === 'succeeded').length, failed: res.filter((r) => r.state === 'failed').map((r) => `${r.name}: ${r.error}`) };
  }

  // Warm snapshots were only a way to move the bulk early: forget them, apply retention (no prune).
  private async afterCold(run: RunContext): Promise<void> {
    const g = this.policy();
    for (const c of run.calls) {
      if (run.results.get(c.stored.id)?.state !== 'succeeded') continue;
      try {
        const warm = run.warmSnapshots.get(c.stored.id) ?? [];
        if (warm.length) await this.engine.forget(c.call, { snapshotIds: warm, prune: false });
        await this.engine.forget(c.call, { instanceId: run.inst.id, retention: g.retention, prune: false });
        await this.refreshSnapshots(c.stored);
      } catch (e) {
        this.ctx.log.warn(`retention at ${c.stored.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private maintenanceDue(): boolean {
    const now = this.ctx.clock.now().getTime();
    return this.targetsStored().some((t) => t.repo === 'ready' && (!t.lastPruneAt || now - Date.parse(t.lastPruneAt) > PRUNE_EVERY_MS || !t.lastCheckAt || now - Date.parse(t.lastCheckAt) > CHECK_EVERY_MS));
  }

  // Weekly prune, monthly integrity check, per place, when nothing else runs (called by the worker only).
  private async maintain(): Promise<void> {
    if (this.stopping) return;
    const now = this.ctx.clock.now().getTime();
    for (const t of this.targetsStored()) {
      if (t.repo !== 'ready') continue;
      let next = { ...t };
      try {
        if (!t.lastPruneAt || now - Date.parse(t.lastPruneAt) > PRUNE_EVERY_MS) {
          const id = this.ctx.ids.uuid();
          this.ctx.repo.insertBackupRun({ id, instanceId: null, kind: 'prune', trigger: 'schedule', message: t.name });
          try {
            await this.engine.prune(this.call(t));
            this.ctx.repo.finishBackupRun(id, { state: 'succeeded', message: `pruned ${t.name}` });
          } catch (e) {
            this.ctx.repo.finishBackupRun(id, { state: 'failed', message: e instanceof Error ? e.message : String(e) });
          }
          next = { ...next, lastPruneAt: this.ctx.repo.now() };
        }
        if (!t.lastCheckAt || now - Date.parse(t.lastCheckAt) > CHECK_EVERY_MS) {
          const id = this.ctx.ids.uuid();
          this.ctx.repo.insertBackupRun({ id, instanceId: null, kind: 'check', trigger: 'schedule', message: t.name });
          try {
            await this.engine.check(this.call(t), 2);
            this.ctx.repo.finishBackupRun(id, { state: 'succeeded', message: `checked ${t.name} (2% of the data read back)` });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.ctx.repo.finishBackupRun(id, { state: 'failed', message: msg });
            this.ctx.notifier.notify({ kind: 'backup-target', severity: 'error', title: `The backups at ${t.name} failed their check`, body: msg, dedupeKey: `backup-target:${t.id}` });
          }
          next = { ...next, lastCheckAt: this.ctx.repo.now() };
        }
      } finally {
        this.saveTarget({ ...this.target(t.id), lastPruneAt: next.lastPruneAt, lastCheckAt: next.lastCheckAt });
      }
    }
  }
}

function zeroKeyFromStage(stage: StageFile[]): void {
  for (const f of stage) if (f.path === 'app-key') f.base64 = '';
}
