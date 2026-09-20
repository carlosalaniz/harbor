import { accessSync, constants, existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddSourceResult, CatalogItemDto, DomainDto, DomainsDto, FoundAppDto, InstallCandidateDto, InstanceDetail, InstanceLogsDto, InstanceSummary, LogsDto, NotificationChannelDto, NotificationsDto, OperationDto, PackageImportResultDto, PackageSourceDto, PlanDto, PlanRequest, SelfUpdateStatusDto, StorageUsageDto, SystemDto, SystemMetricsDto, WidgetDto } from '../contracts/api.js';
import { journalTail } from '../system/logs.js';
import { lanUrl } from '../system/lan.js';
import { hostname } from 'node:os';
import { defaultCredentialsOf } from '../packages/catalog.js';
import { dnsState } from '../system/net.js';
import { sampleMetrics } from '../system/metrics.js';
import type { LoadedPackage } from '../contracts/types.js';
import { compareRevisions, type PackageStore } from '../packages/store.js';
import { browserUrlFor, managementOrigin } from '../config.js';
import { HarborError } from '../errors.js';
import { identityFor, ownedVolumeName, proposeName, type InstanceIdentity } from '../planner/identity.js';
import { allocateEndpoints } from '../planner/ports.js';
import { renderCompose } from '../planner/render.js';
import { checkHostDirectory, hostPathsOverlap, normalizeHostPath } from '../storage/host-path.js';
import { verifyBindMarker, writeBindMarker } from '../storage/bind-marker.js';
import { installCandidates } from '../storage/install-location.js';
import { describeAppHome, scanAppHomes, unwrapMasterKeyForMachine, unlockAppHome, wrapMasterKeyForMachine, zeroKey, type MachineWrappedKey } from '../storage/app-home.js';
import { zeroMachineKey } from '../auth/machine-key.js';
import { listMounts } from '../system/host-storage.js';
import type { InstanceRow, OperationRow, PackageSourceRow, PlanProposal, PlanRow } from '../state/repo.js';
import { addSeconds, rfc3339 } from '../util.js';
import { validateGitSourceInput } from '../packages/git.js';
import { ComposeError } from '../docker/adapter.js';
import type { Ctx } from './context.js';
import { exposureDto, instanceSummary, operationDto, planDto } from './dto.js';
import type { ExposureDto } from '../contracts/api.js';
import { HOSTNAME_RE, exposureUrl } from '../exposure/urls.js';
import { instanceDir, loadReleaseSnapshot, secretExists } from './instance-dir.js';

export interface SubmitResult {
  operation: OperationRow;
  created: boolean;
}

// Read paths and the plan/submit contract. Mutations of Docker resources live in the runner.
export class ApplicationService {
  private lastDockerObservation: { available: boolean; observedAt: string | null; version: string | null; error: string | null } = { available: false, observedAt: null, version: null, error: null };
  private wake: () => void = () => {};
  // Live usage per instance, written by the observer tick; in-memory only (no history).
  private usageCache = new Map<string, { cpuPercent: number; memoryBytes: number; sampledAt: string }>();
  // docker system df is expensive: cache the grouped result for 60 s.
  private storageUsageCache: { at: number; value: StorageUsageDto } | null = null;

  constructor(readonly ctx: Ctx) {}

  onSubmit(wake: () => void): void {
    this.wake = wake;
  }

  recordDockerObservation(o: { available: boolean; version: string | null; error: string | null }): void {
    this.lastDockerObservation = { ...o, observedAt: rfc3339(this.ctx.clock.now()) };
  }

  recordUsage(instanceId: string, usage: { cpuPercent: number; memoryBytes: number } | null): void {
    if (!usage) this.usageCache.delete(instanceId);
    else this.usageCache.set(instanceId, { ...usage, sampledAt: rfc3339(this.ctx.clock.now()) });
  }

  // ---- git package sources (decision 80)
  private sourceDto(s: PackageSourceRow): PackageSourceDto {
    return {
      id: s.id,
      kind: s.kind,
      url: s.url,
      ref: s.ref,
      subpath: s.subpath,
      packageId: s.packageId,
      pinnedCommit: s.pinnedCommit,
      lastSeenCommit: s.lastSeenCommit,
      autoRedeploy: s.autoRedeploy,
      createdAt: s.createdAt,
      checkedAt: s.checkedAt,
      note: s.note,
      updateAvailable: Boolean(s.lastSeenCommit && s.pinnedCommit && s.lastSeenCommit !== s.pinnedCommit),
    };
  }
  packageSources(): PackageSourceDto[] {
    return this.ctx.repo.packageSources().map((s) => this.sourceDto(s));
  }
  async addPackageSource(req: { url: string; ref?: string; subpath?: string | null; autoRedeploy?: boolean }, actor: string): Promise<AddSourceResult> {
    const url = req.url.trim().replace(/\.git$/, '');
    const ref = req.ref?.trim() || 'main';
    const subpath = req.subpath?.trim() || null;
    validateGitSourceInput(url, ref, subpath);
    if (this.ctx.repo.packageSources().some((s) => s.url === url && s.ref === ref && (s.subpath ?? null) === subpath)) {
      throw new HarborError('NAME_CONFLICT', 'this repository, branch and path are already a source', { nextAction: 'Use "check now" on the existing source, or remove it first.' });
    }
    const tree = await this.ctx.git.fetch(url, ref);
    try {
      const r = await this.ctx.packages.importGitTree(tree, { url, ref, subpath });
      const source: Omit<PackageSourceRow, 'createdAt' | 'checkedAt'> = {
        id: this.ctx.ids.uuid(),
        kind: 'git',
        url,
        ref,
        subpath,
        pinnedCommit: tree.commit,
        lastSeenCommit: tree.commit,
        autoRedeploy: req.autoRedeploy ?? false,
        packageId: r.item.id,
        note: null,
      };
      this.ctx.repo.insertPackageSource(source);
      this.ctx.log.info('git source added', { url, ref, commit: tree.commit, packageId: r.item.id, actor });
      const row = this.ctx.repo.packageSource(source.id)!;
      return { source: this.sourceDto(row), import: { item: r.item, pinned: r.pinned, notes: r.notes, replacedRevision: r.replacedRevision, updatable: [] } };
    } finally {
      tree.cleanup();
    }
  }
  removePackageSource(id: string): void {
    const s = this.ctx.repo.packageSource(id);
    if (!s) throw new HarborError('NOT_FOUND', `unknown source ${id}`);
    // The package (and installed apps) stay; only the link to the repository goes.
    this.ctx.repo.deletePackageSource(id);
  }
  setSourceAutoRedeploy(id: string, on: boolean): PackageSourceDto {
    const s = this.ctx.repo.packageSource(id);
    if (!s) throw new HarborError('NOT_FOUND', `unknown source ${id}`);
    this.ctx.repo.updatePackageSource(id, { autoRedeploy: on });
    return this.sourceDto(this.ctx.repo.packageSource(id)!);
  }
  // Fetch the branch head; import a newer commit as a new revision. Returns the refreshed source.
  // Import + notify only — the update plan flows through the normal update machinery afterwards.
  async checkPackageSource(id: string, actor: string): Promise<PackageSourceDto> {
    const s = this.ctx.repo.packageSource(id);
    if (!s) throw new HarborError('NOT_FOUND', `unknown source ${id}`);
    const head = await this.ctx.git.head(s.url, s.ref);
    this.ctx.repo.updatePackageSource(id, { lastSeenCommit: head.commit, checkedAt: rfc3339(this.ctx.clock.now()) });
    if (head.commit !== s.pinnedCommit) {
      const tree = await this.ctx.git.fetch(s.url, s.ref, { commit: head.commit });
      try {
        await this.ctx.packages.importGitTree(tree, { url: s.url, ref: s.ref, subpath: s.subpath, expectedId: s.packageId });
        this.ctx.repo.updatePackageSource(id, { pinnedCommit: head.commit, note: null });
        this.ctx.log.info('git source updated', { url: s.url, from: s.pinnedCommit, to: head.commit, actor });
        this.ctx.notifier.notify({ kind: 'source-commit', severity: 'info', title: `New commit for ${s.packageId}`, body: `${s.url.replace(/^https:\/\//, '')} ${s.ref} moved to ${head.commit.slice(0, 12)}. ${s.autoRedeploy ? 'Redeploy starts automatically.' : 'Update the app from its drawer or Home.'}`, dedupeKey: `source-commit:${s.id}:${head.commit}` });
      } catch (e) {
        // A broken commit must not wedge the source: record the failure and keep the old revision installed.
        const msg = e instanceof Error ? e.message : String(e);
        this.ctx.repo.updatePackageSource(id, { note: `commit ${head.commit.slice(0, 12)} was not imported: ${msg}` });
        this.ctx.notifier.notify({ kind: 'source-broken', severity: 'warning', title: `Commit ${head.commit.slice(0, 12)} of ${s.packageId} is not installable`, body: msg, dedupeKey: `source-broken:${s.id}:${head.commit}` });
      } finally {
        tree.cleanup();
      }
    }
    return this.sourceDto(this.ctx.repo.packageSource(id)!);
  }
  // Called by the observer on its own cadence: check every source; auto-redeploy rides runAutoUpdates
  // (an imported newer revision makes updateFor() fire; sources with autoRedeploy get the plan below).
  async checkAllSources(): Promise<void> {
    for (const s of this.ctx.repo.packageSources()) {
      try {
        await this.checkPackageSource(s.id, 'git-source');
      } catch (e) {
        this.ctx.log.warn(`source check ${s.url}@${s.ref} failed: ${(e as Error).message}`);
      }
    }
    // Redeploy-on-commit: submit updates for instances of auto-redeploy sources.
    const current = this.currentRevisionsSafe();
    for (const s of this.ctx.repo.packageSources()) {
      if (!s.autoRedeploy) continue;
      for (const i of this.ctx.repo.listInstances()) {
        if (i.packageId !== s.packageId || i.installState !== 'installed' || i.activeOperationId) continue;
        const upd = this.updateFor(i, current);
        if (!upd) continue;
        const attempt = `${i.id}:${upd.revision}`;
        if (this.autoUpdateAttempts.has(attempt)) continue;
        this.autoUpdateAttempts.add(attempt);
        try {
          const plan = await this.createPlan({ kind: 'update', instanceId: i.id }, 'git-source');
          this.submit(plan.id, this.ctx.ids.uuid(), 'git-source');
          this.ctx.log.info('redeploy-on-commit submitted', { instanceId: i.id, to: upd.revision });
        } catch (e) {
          this.ctx.log.warn(`redeploy of ${i.name} could not start: ${(e as Error).message}`);
        }
      }
    }
  }

  // ---- Home widgets (decision 81): the daemon proxies the app's JSON so the browser never
  // talks to the app cross-origin and CSP stays strict. Cached per refreshSeconds; malformed
  // data hides the widget (null) and notifies once at info severity — never an error on Home.
  private widgetCache = new Map<string, { at: number; value: WidgetDto | null }>();
  async widget(id: string): Promise<WidgetDto | null> {
    const row = this.instanceRow(id);
    const meta = this.packageMeta(row);
    const w = meta.widget;
    if (!w || row.installState !== 'installed' || row.runtime !== 'running') return null;
    const cached = this.widgetCache.get(id);
    const ttl = (w.refreshSeconds ?? 30) * 1000;
    if (cached && Date.now() - cached.at < ttl) return cached.value;
    const value = await this.fetchWidget(row, w);
    this.widgetCache.set(id, { at: Date.now(), value });
    return value;
  }
  private async fetchWidget(row: InstanceRow, w: NonNullable<NonNullable<LoadedPackage['manifest']['presentation']>['widget']>): Promise<WidgetDto | null> {
    const alloc = row.endpoints.find((e) => e.id === w!.endpoint);
    if (!alloc) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${alloc.hostPort}${w!.path}`, { signal: AbortSignal.timeout(2000), headers: { accept: 'application/json', connection: 'close' } });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > 64 * 1024) return null;
      const body = JSON.parse(text) as { items?: unknown };
      if (!body || !Array.isArray(body.items)) return null;
      if (w!.kind === 'metrics') {
        const items = body.items.slice(0, 4).map((x) => {
          const o = x as { label?: unknown; value?: unknown; unit?: unknown };
          if (typeof o.label !== 'string' || (typeof o.value !== 'string' && typeof o.value !== 'number')) return null;
          return { label: o.label.slice(0, 40), value: typeof o.value === 'number' ? String(o.value) : o.value.slice(0, 40), ...(typeof o.unit === 'string' ? { unit: o.unit.slice(0, 12) } : {}) };
        });
        if (items.some((x) => x === null)) return null;
        return { kind: 'metrics', items: items as { label: string; value: string; unit?: string }[] };
      }
      const items = body.items.slice(0, 5).map((x) => {
        const o = x as { title?: unknown; subtitle?: unknown };
        if (typeof o.title !== 'string') return null;
        return { title: o.title.slice(0, 80), ...(typeof o.subtitle === 'string' ? { subtitle: o.subtitle.slice(0, 120) } : {}) };
      });
      if (items.some((x) => x === null)) return null;
      return { kind: 'list', items: items as { title: string; subtitle?: string }[] };
    } catch {
      return null;
    }
  }

  // ---- automatic updates (decision 78)
  updatesPolicy(): { autoDefault: boolean } {
    return { autoDefault: this.ctx.repo.setting<boolean>('updates.autoDefault') ?? false };
  }
  setUpdatesPolicy(p: { autoDefault: boolean }): { autoDefault: boolean } {
    this.ctx.repo.setSetting('updates.autoDefault', p.autoDefault);
    return this.updatesPolicy();
  }
  // ---- removable-drive behaviour: auto-mount on insert + auto-start apps
  // whose drive came back. Both on by default; stored as settings (no
  // migration). The drive guard still stops apps on removal either way.
  storagePolicy(): { autoMount: boolean; autoStart: boolean } {
    return { autoMount: this.ctx.repo.setting<boolean>('storage.autoMount') ?? true, autoStart: this.ctx.repo.setting<boolean>('storage.autoStart') ?? true };
  }
  // Install locations: existing folders that may hold whole encrypted apps.
  // Built from the live mount table every call (drives come and go). The
  // Harbor data folder is always a candidate: it is created on first use
  // (the folder picker already creates it), so installs must not wait for it.
  installCandidates(): InstallCandidateDto[] {
    const mounts = listMounts();
    let dataWritable: boolean;
    try {
      if (!existsSync(this.ctx.config.userDataDir)) mkdirSync(this.ctx.config.userDataDir, { recursive: true, mode: 0o755 });
      accessSync(this.ctx.config.userDataDir, constants.W_OK | constants.X_OK);
      dataWritable = true;
    } catch {
      dataWritable = false;
    }
    return installCandidates(mounts, { path: this.ctx.config.userDataDir, exists: true, writable: dataWritable });
  }
  // Resolve an install-location request at plan time. Returns the normalized
  // dir; throws when the dir is not an eligible candidate, does not exist, or
  // overlaps another app's folders or homes. The data-folder candidate is the
  // escape hatch for tests and dev (a tmp "drive" the live mount table does
  // not cover): any dir on the same filesystem as the data folder resolves
  // through it, so the engine path stays exercisable without real hardware.
  private resolveInstallLocation(dir: string, instances: InstanceRow[]): string {
    const candidates = this.installCandidates();
    const norm = normalizeHostPath(dir);
    let parent = candidates.find((c) => norm === c.dir || norm.startsWith(c.dir + '/'));
    if (!parent) {
      const dataCandidate = candidates.find((c) => c.label.startsWith('Harbor data folder'));
      if (dataCandidate?.eligible) {
        try {
          const a = statfsSync(norm === '/' ? '/' : path.posix.dirname(norm)) as unknown as { type?: number; bsize?: number; blocks?: number };
          const b = statfsSync(this.ctx.config.userDataDir) as unknown as { type?: number; bsize?: number; blocks?: number };
          // Same filesystem as the data folder (same fs type + same size):
          // a tmp "drive" in tests/dev that the live mount table misses, or
          // any other folder on the system disk. Point the parent at the
          // dirname (never at norm itself) so the on-demand mkdir below only
          // ever fires for real candidate dirs, and missing nested dirs are
          // refused with the mkdir hint instead of being created.
          if (a.type === b.type && a.bsize === b.bsize && a.blocks === b.blocks) parent = { ...dataCandidate, dir: path.posix.dirname(norm) };
        } catch {
          // statfs unavailable (or dir missing): fall through to the refusal below
        }
      }
    }
    if (!parent) throw new HarborError('INVALID_REQUEST', `${norm} cannot hold apps`, { nextAction: 'Pick one of the install locations from Settings → Storage (or mount a drive first).' });
    if (!parent.eligible) throw new HarborError('INVALID_REQUEST', `${norm} cannot hold apps: ${parent.reason ?? 'filesystem not supported'}`, { nextAction: 'Choose a location on ext4, btrfs, xfs, zfs or apfs.' });
    // The location dir must already exist — except the bare candidate dir
    // itself (<mount>/harbor-apps), which is Harbor-owned infrastructure
    // created on demand so a freshly mounted drive just works. Anything
    // deeper is never created implicitly (a typo would scatter homes across
    // the disk): the console creates it through the folder picker, the CLI
    // prints the mkdir command. The test/dev fallback above points the
    // parent at the dirname, so a bare fallback dir is NOT a candidate dir
    // and is never created here — only real candidate dirs are.
    const realCandidateDirs = new Set(candidates.map((c) => c.dir));
    try {
      if (norm === parent.dir && realCandidateDirs.has(parent.dir) && !existsSync(parent.dir)) mkdirSync(parent.dir, { recursive: true, mode: 0o755 });
    } catch {
      // fall through to the existence check below, which reports it plainly
    }
    let checked: string;
    try {
      checked = checkHostDirectory(norm).path;
    } catch (e) {
      if (HarborError.is(e, 'INVALID_REQUEST') && /does not exist/.test(e.message) && norm !== parent.dir) {
        throw new HarborError('INVALID_REQUEST', `app folder ${norm} does not exist`, { nextAction: `Create it first (for example: sudo mkdir -p ${norm}) and make sure Harbor may write to it, then plan again.` });
      }
      throw e;
    }
    const inUse = instances.flatMap((i) => this.ctx.repo.resources(i.id).filter((r) => r.kind === 'bind').map((r) => ({ path: r.name, instance: i.name })));
    const clash = inUse.find((u) => hostPathsOverlap(u.path, checked));
    if (clash) throw new HarborError('OWNERSHIP_CONFLICT', `${checked} overlaps ${clash.path}, already used by instance ${clash.instance}`, { nextAction: 'Choose a different folder; two apps must not share or nest their storage.' });
    return checked;
  }
  setStoragePolicy(p: { autoMount?: boolean; autoStart?: boolean }): { autoMount: boolean; autoStart: boolean } {
    if (p.autoMount !== undefined) this.ctx.repo.setSetting('storage.autoMount', p.autoMount);
    if (p.autoStart !== undefined) this.ctx.repo.setSetting('storage.autoStart', p.autoStart);
    return this.storagePolicy();
  }
  setInstanceAutoUpdate(id: string, enabled: boolean): InstanceSummary {
    const row = this.instanceRow(id);
    this.ctx.repo.setAutoUpdate(row.id, enabled);
    const meta = this.packageMeta(row);
    const fresh = this.ctx.repo.instance(row.id)!;
    return instanceSummary(fresh, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(fresh.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(fresh, this.currentRevisionsSafe()), lanHost: this.lanHost(), usage: this.usageCache.get(fresh.id) ?? null, needsDrive: this.needsDrive(fresh.id), home: this.homeState(fresh.id) });
  }
  // One update plan per eligible instance, submitted through the normal queue ("Update all").
  // Failures roll back per instance and never stop the rest (the queue is serial anyway).
  async applyAllUpdates(actor: string): Promise<{ started: { instanceId: string; name: string; operationId: string }[]; skipped: { instanceId: string; name: string; reason: string }[] }> {
    const current = this.currentRevisionsSafe();
    const started: { instanceId: string; name: string; operationId: string }[] = [];
    const skipped: { instanceId: string; name: string; reason: string }[] = [];
    for (const i of this.ctx.repo.listInstances()) {
      if (!this.updateFor(i, current)) continue;
      if (i.installState !== 'installed') {
        skipped.push({ instanceId: i.id, name: i.name, reason: `state is ${i.installState}` });
        continue;
      }
      if (i.activeOperationId) {
        skipped.push({ instanceId: i.id, name: i.name, reason: 'another operation is running' });
        continue;
      }
      try {
        const plan = await this.createPlan({ kind: 'update', instanceId: i.id }, actor);
        const r = this.submit(plan.id, this.ctx.ids.uuid(), actor);
        started.push({ instanceId: i.id, name: i.name, operationId: r.operation.id });
      } catch (e) {
        skipped.push({ instanceId: i.id, name: i.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { started, skipped };
  }
  // Called by the observer: submit updates for auto-enabled instances (actor auto-update).
  // Each (instance, revision) is attempted once — a rolled-back update must not loop.
  private autoUpdateAttempts = new Set<string>();
  async runAutoUpdates(): Promise<void> {
    const current = this.currentRevisionsSafe();
    for (const i of this.ctx.repo.listInstances()) {
      if (!i.autoUpdate || i.installState !== 'installed' || i.activeOperationId) continue;
      const upd = this.updateFor(i, current);
      if (!upd) continue;
      const attempt = `${i.id}:${upd.revision}`;
      if (this.autoUpdateAttempts.has(attempt)) continue;
      this.autoUpdateAttempts.add(attempt);
      try {
        const plan = await this.createPlan({ kind: 'update', instanceId: i.id }, 'auto-update');
        this.submit(plan.id, this.ctx.ids.uuid(), 'auto-update');
        this.ctx.log.info('auto-update submitted', { instanceId: i.id, to: upd.revision });
      } catch (e) {
        this.ctx.log.warn(`auto-update of ${i.name} could not start: ${(e as Error).message}`);
      }
    }
  }

  // ---- notifications (decision 77)
  notifications(unreadOnly: boolean): NotificationsDto {
    const items = this.ctx.repo.notifications({ unreadOnly }).map((n) => ({ id: n.id, createdAt: n.createdAt, kind: n.kind, severity: n.severity, title: n.title, body: n.body, instanceId: n.instanceId, read: n.readAt !== null }));
    return { items, unread: this.ctx.repo.unreadNotificationCount() };
  }
  markNotificationRead(id: string): NotificationsDto {
    this.ctx.repo.markNotificationRead(id);
    return this.notifications(false);
  }
  markAllNotificationsRead(): NotificationsDto {
    this.ctx.repo.markAllNotificationsRead();
    return this.notifications(false);
  }
  notificationChannels(): { channels: NotificationChannelDto[] } {
    // Secrets are write-only through the API: redact on read.
    const channels = this.ctx.notifier.channels().map((c) => {
      if (c.kind === 'ntfy') return { ...c, ...(c.token ? { token: '••••' } : {}) };
      if (c.kind === 'webhook') return { ...c, ...(c.secret ? { secret: '••••' } : {}) };
      return { ...c, smtp: { ...c.smtp, ...(c.smtp.pass ? { pass: '••••' } : {}) } };
    });
    return { channels };
  }
  setNotificationChannels(channels: NotificationChannelDto[]): { channels: NotificationChannelDto[] } {
    if (channels.length > 5) throw new HarborError('INVALID_REQUEST', 'at most 5 notification channels');
    // A redacted secret in the payload means "keep the stored one".
    const stored = this.ctx.notifier.channels();
    const merged = channels.map((c, idx) => {
      const prev = stored[idx];
      if (c.kind === 'ntfy' && c.token === '••••' && prev?.kind === 'ntfy') return { ...c, ...(prev.token !== undefined ? { token: prev.token } : {}) };
      if (c.kind === 'webhook' && c.secret === '••••' && prev?.kind === 'webhook') return { ...c, ...(prev.secret !== undefined ? { secret: prev.secret } : {}) };
      if (c.kind === 'email' && c.smtp.pass === '••••' && prev?.kind === 'email') return { ...c, smtp: { ...c.smtp, ...(prev.smtp.pass !== undefined ? { pass: prev.smtp.pass } : {}) } };
      return c;
    });
    this.ctx.notifier.setChannels(merged);
    return this.notificationChannels();
  }
  testNotificationChannels(): Promise<{ kind: string; ok: boolean; error: string | null }[]> {
    return this.ctx.notifier.test();
  }

  // Volume sizes grouped per app. Never called from the observer; the 60 s cache keeps the Storage page cheap.
  async storageUsage(): Promise<StorageUsageDto> {
    const now = this.ctx.clock.now().getTime();
    if (this.storageUsageCache && now - this.storageUsageCache.at < 60_000) return this.storageUsageCache.value;
    const df = await this.ctx.docker.diskUsage();
    const size = new Map(df.volumes.map((v) => [v.name, v.sizeBytes]));
    const apps: StorageUsageDto['apps'] = [];
    const owned = new Set<string>();
    for (const i of this.ctx.repo.listInstances()) {
      const volumes = this.ctx.repo
        .resources(i.id)
        .filter((r) => r.kind === 'volume')
        .map((r) => {
          owned.add(r.name);
          return { id: r.role, volumeName: r.name, sizeBytes: size.get(r.name) ?? 0 };
        });
      if (volumes.length) apps.push({ instanceId: i.id, name: i.name, volumes, totalBytes: volumes.reduce((a, v) => a + v.sizeBytes, 0) });
    }
    const unownedBytes = df.volumes.filter((v) => !owned.has(v.name)).reduce((a, v) => a + v.sizeBytes, 0);
    const value: StorageUsageDto = { sampledAt: rfc3339(this.ctx.clock.now()), apps, unownedBytes };
    this.storageUsageCache = { at: now, value };
    return value;
  }

  system(): SystemDto {
    const active = this.ctx.repo.activeOperations().find((o) => o.state !== 'queued') ?? this.ctx.repo.activeOperations()[0];
    return {
      version: this.ctx.version,
      profile: 'local-preview',
      docker: this.lastDockerObservation,
      busyOperationId: active?.id ?? null,
      installationId: this.ctx.installationId,
      managementOrigin: managementOrigin(this.ctx.config),
      deviceName: this.ctx.repo.setting<string>('device.name'),
      hostname: hostname(),
      lan: { enabled: this.ctx.config.lan.enabled, url: this.ctx.config.lan.enabled ? lanUrl(this.ctx.config.lan.port) : null },
      update: this.ctx.selfUpdate.status(),
    };
  }
  selfUpdateStatus(): SelfUpdateStatusDto {
    return this.ctx.selfUpdate.status();
  }
  selfUpdateCheck(): Promise<SelfUpdateStatusDto> {
    return this.ctx.selfUpdate.check();
  }
  selfUpdateApply(actor: string): Promise<SelfUpdateStatusDto> {
    return this.ctx.selfUpdate.apply(actor);
  }
  // http://<hostname>.local for app addresses in LAN mode (the console swaps in the host it was opened with)
  private lanHost(): string | null {
    return this.ctx.config.lan.enabled ? `${hostname().toLowerCase().replace(/\.local$/, '')}.local` : null;
  }
  setDeviceName(name: string | null): SystemDto {
    const clean = name?.trim().replace(/\s+/g, ' ') ?? '';
    if (clean.length > 40) throw new HarborError('INVALID_REQUEST', 'the name can be at most 40 characters');
    if (clean) this.ctx.repo.setSetting('device.name', clean);
    else this.ctx.repo.deleteSetting('device.name');
    return this.system();
  }
  // Troubleshoot: the daemon's own log (journal on a systemd host, in-memory otherwise) and app container logs.
  async harborLogs(lines: number): Promise<LogsDto> {
    const fromJournal = this.ctx.config.docker.mode === 'socket' ? await journalTail('harbor', lines) : null;
    if (fromJournal) return { source: 'journal', lines: fromJournal };
    return { source: 'memory', lines: this.ctx.logBuffer.tail(lines) };
  }
  async instanceLogs(id: string, lines: number): Promise<InstanceLogsDto> {
    const row = this.instanceRow(id);
    const out: InstanceLogsDto['containers'] = [];
    for (const r of this.ctx.repo.resources(row.id).filter((x) => x.kind === 'container')) {
      let text: string;
      try {
        text = await this.ctx.docker.containerLogs(r.dockerId ?? r.name, lines);
      } catch (e) {
        text = `(logs unavailable: ${e instanceof Error ? e.message : String(e)})`;
      }
      out.push({ name: r.name, service: r.role, lines: text.replace(/\r/g, '').trimEnd().split('\n').filter(Boolean) });
    }
    return { containers: out };
  }

  async metrics(): Promise<SystemMetricsDto> {
    const recorded = this.ctx.repo.listInstances().flatMap((i) => this.ctx.repo.resources(i.id).filter((r) => r.kind === 'container'));
    let running = 0;
    if (this.lastDockerObservation.available) {
      for (const r of recorded) {
        try {
          const c = await this.ctx.docker.inspectContainer(r.dockerId ?? r.name);
          if (c?.state === 'running') running += 1;
        } catch {
          /* skip */
        }
      }
    }
    return sampleMetrics(this.ctx.clock.now(), { available: this.lastDockerObservation.available, version: this.lastDockerObservation.version, containersRunning: running, containersTotal: recorded.length });
  }

  catalog(): CatalogItemDto[] {
    return this.ctx.packages.list();
  }

  private packageMeta(i: InstanceRow): { name: string; primaryEndpoint: string; description: string; setup: { endpoint: string; instructions: string } | null; icon: string | null; category: string; defaultCredentials: CatalogItemDto['defaultCredentials']; widget: NonNullable<LoadedPackage['manifest']['presentation']>['widget'] | null } {
    const from = (pkg: LoadedPackage) => ({ name: pkg.manifest.metadata.name, primaryEndpoint: pkg.manifest.ui.primaryEndpoint, description: pkg.manifest.metadata.description, setup: pkg.manifest.setup ?? null, icon: pkg.manifest.presentation?.icon ?? null, category: pkg.manifest.presentation?.category ?? 'other', defaultCredentials: defaultCredentialsOf(pkg.manifest), widget: pkg.manifest.presentation?.widget ?? null });
    try {
      return from(loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'release'), i.packageId));
    } catch {
      try {
        return from(this.ctx.packages.load(i.packageId));
      } catch {
        return { name: i.packageId, primaryEndpoint: i.endpoints[0]?.id ?? 'web', description: '', setup: null, icon: null, category: 'other', defaultCredentials: null, widget: null };
      }
    }
  }

  // Package asset bytes for the console (icon/gallery), from the bundled or uploaded package.
  asset(packageId: string, name: string): { bytes: Buffer; contentType: string } {
    const pkg = this.ctx.packages.load(packageId);
    const bytes = pkg.assets[name];
    if (!bytes) throw new HarborError('NOT_FOUND', `no asset ${name} in package ${packageId}`);
    const ext = name.split('.').pop();
    const contentType = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { bytes, contentType };
  }

  instances(): InstanceSummary[] {
    const current = this.currentRevisionsSafe();
    return this.ctx.repo.listInstances().map((i) => {
      const meta = this.packageMeta(i);
      return instanceSummary(i, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(i.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(i, current), lanHost: this.lanHost(), usage: this.usageCache.get(i.id) ?? null, needsDrive: this.needsDrive(i.id), home: this.homeState(i.id) });
    });
  }
  // Install-location read model: the encrypted home on the drive (null =
  // system disk). Locked when this machine cannot read the vault (BFU, or a
  // foreign drive); unlocked when the machine key opens it silently.
  // Computed at read time from the 'home' resource — no migration.
  private homeState(instanceId: string): InstanceSummary['home'] {
    try {
      const home = this.ctx.repo.resources(instanceId).find((r) => r.kind === 'volume' && r.role === '__home__');
      if (!home) return null;
      const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
      const machineKey = this.ctx.machineKey.take();
      let state: 'locked' | 'unlocked' = 'locked';
      if (wrapped && machineKey) {
        try {
          const master = unwrapMasterKeyForMachine(wrapped, machineKey);
          master.fill(0);
          state = 'unlocked';
        } catch {
          state = 'locked';
        } finally {
          zeroMachineKey(machineKey);
        }
      }
      return { path: home.name, encrypted: true, state };
    } catch {
      return null;
    }
  }
  private currentRevisionsSafe(): ReturnType<PackageStore['currentRevisions']> {
    try {
      return this.ctx.packages.currentRevisions();
    } catch {
      return new Map();
    }
  }
  // An update exists when the package store holds a newer revision than the one this instance runs.
  private updateFor(i: InstanceRow, current: ReturnType<PackageStore['currentRevisions']>): InstanceSummary['updateAvailable'] {
    if (i.purgedAt || i.installState === 'installing') return null;
    const cur = current.get(i.packageId);
    if (!cur || compareRevisions(cur.revision, i.revision) <= 0) return null;
    return { revision: cur.revision, version: cur.version, releaseNotes: cur.releaseNotes };
  }

  // Drive guard read model: the first external folder whose identity check
  // fails (missing, foreign, or swapped). Null means the app's folders are
  // the ones it was installed with. Computed at read time so the drawer,
  // tiles and Start refusal all see the same state without a migration.
  // Legacy markers (no drive id) and resources (no recorded drive id) are
  // backfilled on sight: the folder is the one the app was installed with,
  // it just predates identities, so stamp and record going forward.
  // Adopting a replacement drive re-stamps the folder with a new identity
  // (the old data is gone; the operator accepts the folder as the new home).
  private needsDrive(instanceId: string): InstanceSummary['needsDrive'] {
    try {
      const inst = this.ctx.repo.instance(instanceId);
      if (!inst || inst.installState !== 'installed') return null;
      for (const r of this.ctx.repo.resources(instanceId).filter((x) => x.kind === 'bind')) {
        try {
          checkHostDirectory(r.name);
          const storageId = (r.metadata?.['storageId'] as string | undefined) ?? r.role;
          let driveId = (r.metadata?.['driveId'] as string | undefined) ?? null;
          if (!driveId) {
            // Pre-guard resource: adopt the folder's marker (or stamp a fresh
            // one) so future comparisons have an id to check against.
            try {
              driveId = writeBindMarker(r.name, inst.id, storageId);
              this.ctx.repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: r.role, dockerId: r.dockerId, name: r.name, token: r.token, metadata: { ...(r.metadata ?? {}), storageId, driveId } });
            } catch {
              /* read-only folders stay unmarked; the verify below still applies */
            }
          }
          verifyBindMarker(r.name, inst.id, storageId, driveId);
        } catch (e) {
          const purpose = (r.metadata?.['storageId'] as string | undefined) ?? r.role;
          return { path: r.name, purpose, detail: e instanceof Error ? e.message : String(e) };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Accept the folder currently at the recorded path as the new home for this
  // claim (replacement drive, or a restore that lost its marker): stamp a
  // fresh app-generated identity into the folder and record it on the
  // resource. Refused while the app is running — stop it first so nothing
  // writes into the new folder mid-adoption.
  adoptDrive(instanceId: string, storageId: string, actor: string): InstanceSummary {
    const inst = this.instanceRow(instanceId);
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `cannot adopt a drive for an app in state ${inst.installState}`);
    if (inst.activeOperationId) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
    // Refused while containers are still running — stop first so nothing
    // writes into the new folder mid-adoption. A drive-guard stop leaves
    // desired running (runtime stopped), which must NOT block adoption:
    // that is exactly when the operator needs to accept a replacement.
    if (inst.runtime === 'running' || inst.runtime === 'starting') throw new HarborError('INVALID_STATE', `${inst.name} is still running`, { nextAction: 'Stop the app first, then adopt the folder.' });
    const bind = this.ctx.repo.resources(instanceId).find((x) => x.kind === 'bind' && ((x.metadata?.['storageId'] as string | undefined) ?? x.role) === storageId);
    if (!bind) throw new HarborError('NOT_FOUND', `no external folder for storage claim ${storageId} on ${inst.name}`);
    const { path: hostPath } = checkHostDirectory(bind.name);
    const driveId = writeBindMarker(hostPath, inst.id, storageId);
    this.ctx.repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: bind.role, dockerId: bind.dockerId, name: hostPath, token: bind.token, metadata: { ...(bind.metadata ?? {}), storageId, driveId } });
    this.ctx.log.info('drive adopted', { instanceId, storageId, path: hostPath, actor });
    const meta = this.packageMeta(this.ctx.repo.instance(instanceId)!);
    const fresh = this.ctx.repo.instance(instanceId)!;
    return instanceSummary(fresh, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(fresh.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(fresh, this.currentRevisionsSafe()), lanHost: this.lanHost(), usage: this.usageCache.get(fresh.id) ?? null, needsDrive: this.needsDrive(fresh.id), home: this.homeState(fresh.id) });
  }

  // ---- your own apps
  async importPackage(zip: Buffer, fileName: string, actor: string): Promise<PackageImportResultDto> {
    const r = await this.ctx.packages.importZip(zip, { fileName, actor });
    const updatable = this.ctx.repo
      .listInstances()
      .filter((i) => i.packageId === r.item.id && i.installState !== 'installing' && compareRevisions(r.item.revision, i.revision) > 0)
      .map((i) => ({ instanceId: i.id, name: i.name, fromRevision: i.revision }));
    this.ctx.log.info('package imported', { id: r.item.id, revision: r.item.revision, actor, pinned: r.pinned.length });
    return { item: r.item, pinned: r.pinned, notes: r.notes, replacedRevision: r.replacedRevision, updatable };
  }
  removePackage(id: string): void {
    const users = this.ctx.repo.listInstances().filter((i) => i.packageId === id);
    if (users.length) throw new HarborError('INVALID_STATE', `${id} is still used by ${users.map((i) => i.name).join(', ')}`, { nextAction: 'Uninstall those apps completely first (their data is deleted only when you choose that).' });
    this.ctx.packages.removeLocal(id);
  }

  exposuresList(): ExposureDto[] {
    const names = new Map(this.ctx.repo.listInstances().map((i) => [i.id, i]));
    return this.ctx.repo.exposures().map((e) => exposureDto(e, names.get(e.instanceId)?.name ?? e.instanceId, names.get(e.instanceId)?.primaryExposure ?? 'loopback'));
  }

  instanceRow(idOrName: string): InstanceRow {
    const row = this.ctx.repo.instance(idOrName) ?? this.ctx.repo.instanceByName(idOrName);
    if (!row) throw new HarborError('NOT_FOUND', `unknown instance ${idOrName}`);
    return row;
  }

  // Portable app homes found on mounted drives but not adopted here.
  // Scans every install candidate dir for manifest.json folders. Adopted
  // homes (an instance already points at the path) are flagged, not hidden —
  // the console needs them to tell "yours, locked" from "someone else's".
  foundApps(): FoundAppDto[] {
    const out: FoundAppDto[] = [];
    const adoptedPaths = new Set(
      this.ctx.repo.listInstances().flatMap((i) => this.ctx.repo.resources(i.id).filter((r) => r.kind === 'volume' && r.role === '__home__').map((r) => r.name)),
    );
    for (const c of this.installCandidates()) {
      if (!c.eligible) continue;
      let entries: FoundAppDto[];
      try {
        entries = scanAppHomes(c.dir).map((e) => {
          if (!e.descriptor) return { home: `${c.dir}/${e.name}`, name: e.name, displayName: e.name, packageId: '', packageRevision: '', instanceId: '', drive: c.dir, adopted: false, error: e.error ?? 'unreadable app home' };
          const m = e.descriptor.manifest;
          return { home: e.descriptor.home, name: e.name, displayName: m.displayName, packageId: m.packageId, packageRevision: m.packageRevision, instanceId: m.instanceId, drive: c.dir, adopted: adoptedPaths.has(e.descriptor.home), error: null };
        });
      } catch {
        continue; // candidate dir missing (drive yanked mid-scan): skip quietly
      }
      out.push(...entries);
    }
    return out.sort((a, b) => a.home.localeCompare(b.home));
  }

  // Adopt a found app home onto this machine with its encryption passphrase:
  // unlock, wrap for this machine (silent future launches), create the
  // instance record + volumes rooted at the existing home, pull, start.
  // Ports re-allocate locally; identity (UUID) travels in the manifest.
  async adoptApp(home: string, passphrase: string, opts: { name?: string } | undefined, actor: string): Promise<InstanceSummary> {
    const { manifest } = describeAppHome(home);
    const masterKey = await unlockAppHome(home, passphrase);
    try {
      if (this.ctx.repo.instance(manifest.instanceId)) throw new HarborError('NAME_CONFLICT', `this machine already has an instance for ${manifest.displayName}`, { nextAction: 'That app is already adopted here.' });
      const pkg = this.ctx.packages.load(manifest.packageId);
      const instances = this.ctx.repo.listInstances();
      const taken = new Set(instances.map((i) => i.name));
      const slug = manifest.displayName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || pkg.id;
      const proposed = proposeName(opts?.name ?? slug, taken, opts?.name);
      if (proposed.error) throw new HarborError(proposed.error.includes('already used') ? 'NAME_CONFLICT' : 'INVALID_REQUEST', proposed.error);
      // Display-name collision: suffix (2), (3) — display only, identity stays the UUID.
      let displayName: string | null = null;
      const baseLabel = manifest.displayName;
      if (instances.some((i) => (i.displayName ?? i.name) === baseLabel)) {
        let n = 2;
        while (instances.some((i) => (i.displayName ?? i.name) === `${baseLabel} (${n})`)) n += 1;
        displayName = `${baseLabel} (${n})`;
      }
      const instanceId = manifest.instanceId;
      const identity = identityFor(this.ctx.installationId, instanceId);
      const endpoints = await this.allocatePorts(pkg);
      const storage = this.resolveStorage(pkg, identity, {}, instances);
      const now = this.ctx.clock.now();
      const expiresAt = rfc3339(addSeconds(now, this.ctx.config.planTtlSeconds));
      const proposal: PlanProposal = {
        packageId: pkg.id,
        revision: pkg.revision,
        name: proposed.name,
        project: identity.project,
        endpoints,
        storage,
        location: { dir: home.replace(/\/[^/]+$/, '') },
        secrets: (pkg.manifest.secrets ?? []).map((s) => ({ id: s.id })),
        changes: [
          `Adopt ${manifest.displayName} (${pkg.id}) from ${home}`,
          `Unlock with the encryption passphrase; wrap for silent unlock on this machine`,
          `Create Compose project ${identity.project} with a private bridge network`,
          ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
          ...storage.map((s) => `Use the drive's data at ${home}/volumes/${s.composeVolume} (${s.purpose})`),
        ],
        warnings: ['Ports are allocated fresh on this machine; addresses differ from the previous one.'],
        releaseHashes: pkg.hashes,
      };
      await this.validateProspective(pkg, identity, endpoints);
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: this.ctx.ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt };
      this.ctx.repo.insertPlan(plan);
      // Adopt reuses the install operation path: the runner sees the home
      // resource marker below and roots volumes at the existing home instead
      // of creating a fresh one. Stash the master key's machine wrapping now
      // (adopt needs a session, and sessions unlock — so AFU holds).
      const machineKey = this.ctx.machineKey.take();
      let wrapped: MachineWrappedKey | null = null;
      if (machineKey) {
        try {
          wrapped = wrapMasterKeyForMachine(masterKey, machineKey);
        } finally {
          zeroMachineKey(machineKey);
        }
      }
      this.ctx.repo.upsertResource({ instanceId, kind: 'volume', role: '__home__', dockerId: null, name: home, token: null, metadata: { home: true, driveId: manifest.driveId, adopted: true, ...(wrapped ? { machineWrapped: wrapped } : {}) } });
      // Adopt plans carry no passphrase (the operator already proved it by
      // unlocking above); pre-seed the secret check so submit() passes.
      this.submitInstallLocationSecret(plan.id, 'adopted');
      const submit = this.submit(plan.id, this.ctx.ids.uuid(), actor);
      if (displayName) this.ctx.repo.setInstanceAppearance(instanceId, { displayName });
      void submit;
      const fresh = this.ctx.repo.instance(instanceId)!;
      const meta = this.packageMeta(fresh);
      return instanceSummary(fresh, meta.name, meta.primaryEndpoint, [], { icon: meta.icon, category: meta.category, lanHost: this.lanHost(), usage: null, needsDrive: null, home: { path: home, encrypted: true, state: wrapped ? 'unlocked' : 'locked' } });
    } finally {
      zeroKey(masterKey);
    }
  }

  async instance(id: string): Promise<InstanceDetail> {
    const row = this.instanceRow(id);
    const meta = this.packageMeta(row);
    const summary = instanceSummary(row, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(row.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(row, this.currentRevisionsSafe()), lanHost: this.lanHost(), usage: this.usageCache.get(row.id) ?? null, needsDrive: this.needsDrive(row.id), home: this.homeState(row.id) });
    const resources = this.ctx.repo.resources(row.id);
    const presence: (boolean | null)[] = [];
    for (const r of resources) {
      if (r.kind === 'volume' && r.role === '__home__') {
        presence.push(existsSync(r.name));
        continue;
      }
      try {
        if (r.kind === 'container') presence.push((await this.ctx.docker.inspectContainer(r.dockerId ?? r.name)) !== null);
        else if (r.kind === 'volume') presence.push((await this.ctx.docker.inspectVolume(r.name)) !== null);
        else if (r.kind === 'bind') presence.push(existsSync(r.name));
        else presence.push((await this.ctx.docker.inspectNetwork(r.dockerId ?? r.name)) !== null);
      } catch {
        presence.push(null);
      }
    }
    const lastOp = row.lastOperationId ? this.ctx.repo.operation(row.lastOperationId) : null;
    const setupEndpoint = meta.setup ? row.endpoints.find((e) => e.id === meta.setup!.endpoint) : undefined;
    return {
      ...summary,
      description: meta.description,
      defaultCredentials: meta.defaultCredentials,
      setup: meta.setup && setupEndpoint ? { endpointId: setupEndpoint.id, browserUrl: browserUrlFor(setupEndpoint.hostPort), instructions: meta.setup.instructions } : null,
      resources: resources.map((r, i) => ({ kind: r.kind, role: r.role, name: r.name, present: presence[i] ?? null })),
      events: this.ctx.repo.eventsForInstance(row.id, 50).map((e) => ({ cursor: String(e.cursor), at: e.at, phase: e.phase, message: e.message })),
      lastError: lastOp?.errorCode ? { code: lastOp.errorCode, message: lastOp.errorMessage ?? '', nextAction: lastOp.nextAction ?? '' } : null,
    };
  }

  plan(id: string): PlanDto {
    const p = this.ctx.repo.plan(id);
    if (!p) throw new HarborError('NOT_FOUND', `unknown plan ${id}`);
    return this.toPlanDto(p);
  }

  private toPlanDto(p: PlanRow): PlanDto {
    const inst = this.ctx.repo.instance(p.instanceId);
    const storageStates: Record<string, 'new' | 'existing'> = {};
    const secretStates: Record<string, 'new' | 'existing'> = {};
    if (inst && p.kind !== 'install') {
      const resources = this.ctx.repo.resources(inst.id);
      for (const s of p.proposal.storage) storageStates[s.id] = resources.some((r) => (r.kind === 'volume' || r.kind === 'bind') && r.role === s.composeVolume) ? 'existing' : 'new';
      const secretsDir = path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'secrets');
      for (const s of p.proposal.secrets) secretStates[s.id] = secretExists(secretsDir, s.id) ? 'existing' : 'new';
    }
    return planDto(p, storageStates, secretStates);
  }

  operation(id: string): OperationDto {
    const o = this.ctx.repo.operation(id);
    if (!o) throw new HarborError('NOT_FOUND', `unknown operation ${id}`);
    return operationDto(o, this.ctx.repo.eventsForOperation(id, 200));
  }

  // Folders bound into apps ("bring your own folder"), for the storage overview.
  foldersInUse(): { path: string; instanceId: string; instanceName: string; purpose: string; readOnly: boolean }[] {
    const out: { path: string; instanceId: string; instanceName: string; purpose: string; readOnly: boolean }[] = [];
    for (const inst of this.ctx.repo.listInstances()) {
      for (const r of this.ctx.repo.resources(inst.id).filter((x) => x.kind === 'bind')) {
        out.push({ path: r.name, instanceId: inst.id, instanceName: inst.name, purpose: (r.metadata?.['storageId'] as string) ?? r.role, readOnly: Boolean(r.metadata?.['readOnly']) });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---- public domains (wizard for public publishing)
  async domains(): Promise<DomainsDto> {
    const ip = await this.ctx.net.publicIp();
    const exposures = this.exposuresList().filter((e) => e.via === 'public');
    const items: DomainDto[] = this.ctx.repo.domains().map((d) => {
      const used = exposures.find((e) => e.hostname === d.hostname);
      return { hostname: d.hostname, dns: { state: d.dnsState, addresses: d.addresses, checkedAt: d.checkedAt, note: d.note }, usedBy: used ? { instanceId: used.instanceId, instanceName: used.instanceName, exposureState: used.state, url: used.url } : null };
    });
    return { publicIp: { v4: ip.v4, v6: ip.v6, detectedAt: rfc3339(this.ctx.clock.now()), error: ip.error }, items };
  }

  async addDomain(hostname: string): Promise<DomainDto> {
    const h = hostname.trim().toLowerCase();
    if (!HOSTNAME_RE.test(h) || !h.includes('.')) throw new HarborError('INVALID_REQUEST', `${hostname} is not a fully qualified hostname (like photos.example.com)`);
    if (this.ctx.repo.domain(h)) throw new HarborError('NAME_CONFLICT', `${h} is already registered`);
    this.ctx.repo.insertDomain(h);
    return this.checkDomain(h);
  }

  async checkDomain(hostname: string): Promise<DomainDto> {
    const d = this.ctx.repo.domain(hostname);
    if (!d) throw new HarborError('NOT_FOUND', `unknown domain ${hostname}`);
    const [ip, rec] = await Promise.all([this.ctx.net.publicIp(), this.ctx.net.resolve(hostname)]);
    const judged = rec.error ? { state: 'unknown' as const, note: `DNS lookup failed: ${rec.error}` } : dnsState(rec, ip);
    this.ctx.repo.updateDomainCheck(hostname, judged.state, [...rec.a, ...rec.aaaa], judged.note);
    return (await this.domains()).items.find((x) => x.hostname === hostname)!;
  }

  removeDomain(hostname: string): void {
    const d = this.ctx.repo.domain(hostname);
    if (!d) throw new HarborError('NOT_FOUND', `unknown domain ${hostname}`);
    if (this.exposuresList().some((e) => e.via === 'public' && e.hostname === hostname)) throw new HarborError('INVALID_STATE', `${hostname} is in use by a published app`, { nextAction: 'Withdraw that address first.' });
    this.ctx.repo.deleteDomain(hostname);
  }

  // ---- planning

  async createPlan(req: PlanRequest, actor: string): Promise<PlanDto> {
    const { repo, clock, ids, config } = this.ctx;
    const now = clock.now();
    const expiresAt = rfc3339(addSeconds(now, config.planTtlSeconds));
    if (req.kind === 'install') {
      const pkg = this.ctx.packages.load(req.packageId);
      const instances = repo.listInstances();
      const taken = new Set(instances.map((i) => i.name));
      if (!pkg.manifest.deployment.multiInstance && instances.some((i) => i.packageId === pkg.id)) {
        throw new HarborError('NAME_CONFLICT', `${pkg.id} does not support multiple instances`, { nextAction: 'Remove the existing instance first.' });
      }
      const proposed = proposeName(pkg.id, taken, req.name);
      if (proposed.error) throw new HarborError(req.name && taken.has(req.name) ? 'NAME_CONFLICT' : 'INVALID_REQUEST', proposed.error);
      const instanceId = ids.uuid();
      const identity = identityFor(this.ctx.installationId, instanceId);
      const endpoints = await this.allocatePorts(pkg);
      // Install location (whole encrypted app on a drive): validated here so a
      // bad dir or weak passphrase never reaches Docker. The passphrase itself
      // is never stored in the plan — only the dir. The runner collects it at
      // apply time from the submitter (see submitInstallLocationSecret).
      let location: PlanProposal['location'] = null;
      if (req.location) {
        const dir = this.resolveInstallLocation(req.location.dir, instances);
        const pass = req.location.passphrase;
        if (typeof pass !== 'string' || pass.length < 8) throw new HarborError('INVALID_REQUEST', 'the app encryption passphrase must be at least 8 characters', { nextAction: 'Choose a passphrase (or a generated recovery key) of 8+ characters.' });
        if (pass.length > 256) throw new HarborError('INVALID_REQUEST', 'the app encryption passphrase must be at most 256 characters');
        location = { dir };
      }
      const storage = this.resolveStorage(pkg, identity, req.storage ?? {}, instances);
      const proposal: PlanProposal = {
        packageId: pkg.id,
        revision: pkg.revision,
        name: proposed.name,
        project: identity.project,
        endpoints,
        storage,
        location,
        secrets: (pkg.manifest.secrets ?? []).map((s) => ({ id: s.id })),
        changes: [
          `Install ${pkg.manifest.metadata.name} (${pkg.id} revision ${pkg.revision}) as instance "${proposed.name}"`,
          `Create Compose project ${identity.project} with a private bridge network`,
          ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
          ...(location ? [`Install the whole app encrypted at ${location.dir}/${proposed.name}/ (manifest.json + vault/); the passphrase unlocks it on any Harbor machine`] : []),
          ...storage.map((s) => (s.hostPath ? `Use your folder ${s.hostPath} for ${s.purpose}${s.readOnly ? ' (read-only)' : ''}; Harbor never deletes it` : `Create retained volume ${s.volumeName} (${s.purpose})`)),
          ...(pkg.manifest.secrets ?? []).map((s) => `Generate retained secret ${s.id} (${s.bytes} bytes)`),
          ...Object.values(pkg.release.images).map((i) => `Pull image ${i.reference} (${i.tag})`),
          ...Object.entries(pkg.release.builds ?? {}).map(([svc, b]) => `Build ${svc} from source at commit ${b.commit.slice(0, 12)} (${b.tag})`),
        ],
        warnings: [
          ...(Object.keys(pkg.release.builds ?? {}).length ? ['Parts of this app are built from source on this machine; their provenance is the git commit, not a registry digest.'] : []),
          ...(pkg.release.qualification.status !== 'passed' ? [pkg.origin === 'local' ? 'This is your own uploaded app; Harbor has not checked it on a real machine the way it checks the built-in catalog.' : `Package qualification is ${pkg.release.qualification.status}`] : []),
          ...(pkg.manifest.setup ? ['This app has its own onboarding after installation; Harbor does not create its accounts.'] : []),
          ...(pkg.manifest.defaultCredentials ? [`This app ships with a default login (${pkg.manifest.defaultCredentials.username}); change it right after the first sign-in.`] : []),
          ...(location ? ['The app (including its database) lives on the drive: unplug it and the app stops; lose the passphrase and the data is gone.'] : []),
        ],
        releaseHashes: pkg.hashes,
      };
      await this.validateProspective(pkg, identity, endpoints);
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }

    const inst = this.instanceRow(req.instanceId);
    if (inst.activeOperationId) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
    const pkgName = this.packageMeta(inst).name;
    if (req.kind === 'expose' || req.kind === 'unexpose' || req.kind === 'reconfigure') return this.exposurePlan(req, inst, pkgName, actor, now, expiresAt);
    if (req.kind === 'update') return this.updatePlan(req, inst, pkgName, actor, now, expiresAt);
    const changes: string[] = [];
    switch (req.kind) {
      case 'start': {
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action') throw new HarborError('INVALID_STATE', `cannot start an instance in state ${inst.installState}`);
        if (inst.runtime === 'running' && inst.desired === 'running') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already running`);
        // Refuse at plan time (not only at apply): starting against a missing
        // or swapped drive must never reach Docker.
        const need = this.needsDrive(inst.id);
        if (need) throw new HarborError('DATA_MISSING', `${inst.name} needs its drive: ${need.path} (${need.purpose}) is not the folder it was using (${need.detail})`, { nextAction: 'Re-insert the drive (or restore the folder with its marker) at the same path, or adopt the new folder from the app drawer.' });
        changes.push(`Verify release, retained volumes and secrets of "${inst.name}"`, `Start existing containers of project ${inst.project}`, 'Check readiness');
        break;
      }
      case 'stop':
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action' && inst.installState !== 'failed') throw new HarborError('INVALID_STATE', `cannot stop an instance in state ${inst.installState}`);
        changes.push(`Stop the recorded containers of "${inst.name}" (project ${inst.project})`, 'Keep volumes, secrets and port allocations');
        break;
      case 'remove':
        if (inst.installState === 'retained') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already removed (retained)`);
        changes.push(`Stop and delete the recorded containers of "${inst.name}"`, `Delete the private network ${inst.project}_default if unused`, 'Retain volumes, secrets, name and port allocations');
        break;
      case 'purge':
        if (inst.installState === 'installing') throw new HarborError('INVALID_STATE', `cannot uninstall ${inst.name} while it is installing`);
        changes.push(
          ...(inst.installState !== 'retained' ? [`Stop and delete the containers of "${inst.name}" and its private network`] : []),
          `Delete the data volume(s) Harbor created for "${inst.name}" (ownership verified first)`,
          'Delete its secrets and stored release',
          `Free the name "${inst.name}" and its ports`,
        );
        break;
      case 'reinstall':
        if (inst.installState !== 'retained') throw new HarborError('INVALID_STATE', `reinstall requires a removed (retained) instance; ${inst.name} is ${inst.installState}`);
        if (!inst.everInstalled) throw new HarborError('INVALID_STATE', `instance ${inst.name} never completed an installation; manual investigation is required`, { nextAction: 'Inspect the instance and its resources manually. Automatic reinstall only applies to previously successful instances.' });
        changes.push(`Reinstall ${pkgName} revision ${inst.revision} into "${inst.name}" using its stored release`, 'Verify retained volumes (ownership tokens) and secrets before starting', `Recreate containers and network for project ${inst.project}`, 'Check readiness');
        break;
    }
    const resources = this.ctx.repo.resources(inst.id);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: resources
        .filter((r) => r.kind === 'volume' || r.kind === 'bind')
        .filter((r) => r.role !== '__home__')
        .sort((a, b) => a.role.localeCompare(b.role))
        .map((r) => (r.kind === 'bind' ? { id: (r.metadata?.['storageId'] as string) ?? r.role, composeVolume: r.role, volumeName: null, purpose: '', hostPath: r.name, readOnly: Boolean(r.metadata?.['readOnly']) } : { id: (r.metadata?.['storageId'] as string) ?? r.role, composeVolume: r.role, volumeName: r.name, purpose: '', ...(typeof r.metadata?.['homePath'] === 'string' ? { homePath: r.metadata['homePath'] as string } : {}) })),
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes,
      warnings:
        req.kind === 'remove'
          ? ['Data volumes and secrets are retained; nothing is deleted except containers and the private network.']
          : req.kind === 'purge'
            ? [`This deletes the app's data for good: ${resources.filter((r) => r.kind === 'volume').map((r) => r.name).join(', ') || 'no managed volumes'}. There is no undo.`, ...(resources.some((r) => r.kind === 'bind') ? [`Your own folder(s) are not touched: ${resources.filter((r) => r.kind === 'bind').map((r) => r.name).join(', ')}.`] : [])]
            : [],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: req.kind, instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Update: same instance (name, ports, volumes, secrets, addresses), new release. New claims get new
  // volumes/secrets/ports; removed claims keep their data (never deleted); images change to the new digests.
  private async updatePlan(req: Extract<PlanRequest, { kind: 'update' }>, inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): Promise<PlanDto> {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `update requires an installed app; ${inst.name} is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? 'Reinstall it first, then update.' : 'Fix the app first (Details shows the last error).' });
    const next = this.ctx.packages.load(inst.packageId);
    if (compareRevisions(next.revision, inst.revision) <= 0) throw new HarborError('INVALID_STATE', `${inst.name} already runs revision ${inst.revision}; the ${next.origin === 'local' ? 'uploaded' : 'built-in'} package is revision ${next.revision}`, { nextAction: next.origin === 'local' ? 'Upload a package with a higher release.revision.' : 'Nothing to do.' });
    const releaseDir = path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release');
    const current = loadReleaseSnapshot(releaseDir, inst.packageId);
    const identity = identityFor(this.ctx.installationId, inst.id);
    const instances = repo.listInstances().filter((i) => i.id !== inst.id);
    const resources = repo.resources(inst.id);
    // storage: existing claims keep their volume/folder; new claims are resolved like an install
    const existingClaims = new Set((current.manifest.storage ?? []).map((c) => c.composeVolume));
    const newClaims = (next.manifest.storage ?? []).filter((c) => !existingClaims.has(c.composeVolume));
    const newStorage = this.resolveStorage({ ...next, manifest: { ...next.manifest, storage: newClaims } }, identity, req.storage ?? {}, instances);
    const keptStorage: PlanProposal['storage'] = resources
      .filter((r) => (r.kind === 'volume' || r.kind === 'bind') && (next.manifest.storage ?? []).some((c) => c.composeVolume === r.role))
      .map((r) => (r.kind === 'bind' ? { id: (r.metadata?.['storageId'] as string) ?? r.role, composeVolume: r.role, volumeName: null, purpose: '', hostPath: r.name, readOnly: Boolean(r.metadata?.['readOnly']) } : { id: (r.metadata?.['storageId'] as string) ?? r.role, composeVolume: r.role, volumeName: r.name, purpose: '' }));
    const droppedVolumes = resources.filter((r) => r.kind === 'volume' && !(next.manifest.storage ?? []).some((c) => c.composeVolume === r.role)).map((r) => r.name);
    // endpoints: keep allocations for ids that still exist (container port may change), allocate the new ones
    const kept = inst.endpoints.filter((e) => next.manifest.endpoints[e.id]).map((e) => ({ ...e, service: next.manifest.endpoints[e.id]!.service, containerPort: next.manifest.endpoints[e.id]!.containerPort }));
    const missing = Object.keys(next.manifest.endpoints).filter((id) => !inst.endpoints.some((e) => e.id === id));
    const fresh = missing.length ? (await this.allocatePorts({ ...next, manifest: { ...next.manifest, endpoints: Object.fromEntries(missing.map((id) => [id, next.manifest.endpoints[id]!])) } }, new Set(kept.map((e) => e.hostPort)))) : [];
    const endpoints = [...kept, ...fresh];
    const newSecrets = (next.manifest.secrets ?? []).filter((s) => !inst.secrets.some((r) => r.id === s.id)).map((s) => s.id);
    const images = [
      ...Object.keys(next.release.images).map((svc) => ({ service: svc, from: current.release.images[svc]?.reference ?? '(new service)', to: next.release.images[svc]!.reference })),
      ...Object.keys(next.release.builds ?? {}).map((svc) => ({ service: svc, from: current.release.builds?.[svc] ? `built from ${current.release.builds[svc]!.commit.slice(0, 12)}` : '(new service)', to: `built from ${next.release.builds![svc]!.commit.slice(0, 12)}` })),
    ].filter((x) => x.from !== x.to);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: next.revision,
      name: inst.name,
      project: inst.project,
      endpoints,
      storage: [...keptStorage, ...newStorage],
      location: null,
      secrets: (next.manifest.secrets ?? []).map((s) => ({ id: s.id })),
      changes: [
        `Update ${pkgName} "${inst.name}" from revision ${inst.revision}${current.manifest.release.version ? ` (${current.manifest.release.version})` : ''} to revision ${next.revision}${next.manifest.release.version ? ` (${next.manifest.release.version})` : ''}`,
        'Keep the name, addresses, ports, data volumes, your folders and secrets',
        'Stop and delete the current containers (the previous release is kept for an automatic rollback)',
        ...images.map((i) => `Image ${i.service}: ${i.from} -> ${i.to}`),
        ...newStorage.map((s) => (s.hostPath ? `Use your folder ${s.hostPath} for ${s.purpose}` : `Create retained volume ${s.volumeName} (${s.purpose})`)),
        ...newSecrets.map((id) => `Generate retained secret ${id}`),
        ...fresh.map((e) => `Publish new endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
        ...droppedVolumes.map((v) => `Volume ${v} is no longer used by this release; it is kept, not deleted`),
        'Pull the new images by digest, start the new containers, check readiness',
        'If the new release does not become healthy, put the previous release back and start it again',
      ],
      warnings: [
        ...(next.origin === 'local' ? ['This is your own uploaded package; Harbor has not checked it on a real machine.'] : []),
        'Apps usually migrate their own data forward on first start. Going back to the old release afterwards is only as safe as the app makes it; Harbor keeps your data as it is.',
        ...(next.manifest.presentation?.releaseNotes ? [`Release notes: ${next.manifest.presentation.releaseNotes}`] : []),
      ],
      releaseHashes: next.hashes,
      update: { fromRevision: inst.revision, toRevision: next.revision, fromVersion: current.manifest.release.version ?? null, toVersion: next.manifest.release.version ?? null, images, newSecrets, newStorage: newStorage.map((s) => s.id), newEndpoints: fresh.map((e) => e.id), releaseNotes: next.manifest.presentation?.releaseNotes ?? null },
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'update', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Storage claims: managed Docker volumes by default; claims the manifest marks `external` may (or must)
  // be bound to an operator-chosen host directory. Validation happens here so a bad folder never reaches Docker.
  private resolveStorage(pkg: LoadedPackage, identity: InstanceIdentity, choices: Record<string, { hostPath: string }>, instances: InstanceRow[]): PlanProposal['storage'] {
    const claims = pkg.manifest.storage ?? [];
    for (const id of Object.keys(choices)) {
      const claim = claims.find((c) => c.id === id);
      if (!claim) throw new HarborError('INVALID_REQUEST', `package ${pkg.id} has no storage claim ${id}`);
      if (!claim.external) throw new HarborError('INVALID_REQUEST', `storage claim ${id} of ${pkg.id} cannot be bound to a host folder`, { nextAction: 'Only claims the package marks as external accept a folder.' });
    }
    const inUse = instances.flatMap((i) => this.ctx.repo.resources(i.id).filter((r) => r.kind === 'bind').map((r) => ({ path: r.name, instance: i.name })));
    const chosen: string[] = [];
    return claims.map((claim) => {
      const choice = choices[claim.id];
      if (!choice) {
        if (claim.external?.required) throw new HarborError('INVALID_REQUEST', `${pkg.manifest.metadata.name} needs a folder for ${claim.purpose} (storage claim ${claim.id})`, { nextAction: `Pass storage.${claim.id}.hostPath (CLI: --storage ${claim.id}=/path). ${claim.external.hint}` });
        return { id: claim.id, composeVolume: claim.composeVolume, volumeName: ownedVolumeName(identity, claim.composeVolume), purpose: claim.purpose };
      }
      const { path: hostPath } = checkHostDirectory(choice.hostPath);
      const clash = inUse.find((u) => hostPathsOverlap(u.path, hostPath));
      if (clash) throw new HarborError('OWNERSHIP_CONFLICT', `${hostPath} overlaps ${clash.path}, already used by instance ${clash.instance}`, { nextAction: 'Choose a different folder; two apps must not share or nest their storage.' });
      if (chosen.some((c) => hostPathsOverlap(c, hostPath))) throw new HarborError('INVALID_REQUEST', `folder ${hostPath} is used by two storage claims of the same install`);
      chosen.push(hostPath);
      return { id: claim.id, composeVolume: claim.composeVolume, volumeName: null, purpose: claim.purpose, hostPath, readOnly: claim.external?.readOnly ?? false };
    });
  }

  private async exposurePlan(req: Extract<PlanRequest, { kind: 'expose' | 'unexpose' | 'reconfigure' }>, inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): Promise<PlanDto> {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `exposure changes require an installed instance; ${inst.name} is ${inst.installState}`);
    const meta = this.packageMeta(inst);
    const pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId);
    const existing = repo.exposures(inst.id);
    const base: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [],
      warnings: [],
      releaseHashes: inst.releaseHashes,
    };
    const hasBaseUrlBindings = (pkg.manifest.configuration ?? []).length > 0;
    if (req.kind === 'reconfigure') {
      if (req.primary !== 'loopback' && !existing.some((e) => e.via === req.primary)) throw new HarborError('INVALID_REQUEST', `instance ${inst.name} has no ${req.primary} exposure to make primary`);
      if (req.primary === inst.primaryExposure) throw new HarborError('INVALID_STATE', `${req.primary} is already the primary address of ${inst.name}`);
      base.primary = req.primary;
      base.changes.push(`Make ${req.primary} the primary address of "${inst.name}"`, hasBaseUrlBindings ? `Re-render the private Compose file with the new base URL and recreate ${pkgName}'s containers (same volumes, secrets and ports), then check readiness` : 'No package configuration depends on the base URL; only Harbor\'s records change');
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'reconfigure', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }
    const endpointId = req.endpointId ?? meta.primaryEndpoint;
    const alloc = inst.endpoints.find((e) => e.id === endpointId);
    if (!alloc) throw new HarborError('INVALID_REQUEST', `instance ${inst.name} has no endpoint ${endpointId}`);
    if (req.kind === 'unexpose') {
      const e = existing.find((x) => x.endpointId === endpointId && x.via === req.via);
      if (!e) throw new HarborError('NOT_FOUND', `${inst.name}/${endpointId} is not exposed via ${req.via}`);
      base.exposure = { endpointId, via: e.via, hostname: e.hostname, port: e.port, protection: e.protection, makePrimary: false };
      base.changes.push(`Remove the ${req.via} address ${exposureUrl(e)} of "${inst.name}" (${req.via === 'public' ? 'Caddy route' : 'tailscale serve entry'})`);
      if (inst.primaryExposure === req.via) {
        base.primary = 'loopback';
        base.changes.push(hasBaseUrlBindings ? 'It is the primary address: switch back to loopback and recreate containers with the loopback base URL' : 'It is the primary address: switch back to loopback');
      }
      if (e.protection === 'basic') base.changes.push('Retain the generated basic-auth credentials (instance secret) for a later re-exposure');
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'unexpose', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }
    // expose
    if (existing.some((x) => x.endpointId === endpointId && x.via === req.via)) throw new HarborError('INVALID_STATE', `${inst.name}/${endpointId} is already exposed via ${req.via}`, { nextAction: 'Unexpose it first to change hostname or protection.' });
    const endpoint = pkg.manifest.endpoints[endpointId]!;
    let hostname: string;
    let port: number;
    let protection: 'none' | 'basic';
    if (req.via === 'tailnet') {
      const st = await this.ctx.tailscale.status();
      if (!st || st.backendState !== 'Running' || !st.dnsName) throw new HarborError('UNSUPPORTED_CAPABILITY', 'Tailscale is not set up on this host', { nextAction: 'Re-run bootstrap with --with-tailscale and complete the login; see the Tailscale tool card.' });
      if (!st.httpsEnabled) throw new HarborError('UNSUPPORTED_CAPABILITY', 'HTTPS certificates are not enabled for this tailnet', { nextAction: 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS settings), then retry.' });
      if (req.hostname && req.hostname !== st.dnsName) throw new HarborError('INVALID_REQUEST', `tailnet exposures use the node name ${st.dnsName}; a custom hostname is not possible`);
      hostname = st.dnsName;
      port = alloc.hostPort; // same port number as loopback: "same port, three addresses"
      protection = 'none'; // tailnet ACLs are the access control; serve has no auth layer
      if (req.protection === 'basic') base.warnings.push('Basic-auth protection is not available on the tailnet path; access is governed by your tailnet ACLs.');
    } else {
      if (!(await this.ctx.caddy.available())) throw new HarborError('UNSUPPORTED_CAPABILITY', 'The public proxy (Caddy) is not set up on this host', { nextAction: 'Re-run bootstrap with --with-public-proxy; see the Public proxy tool card.' });
      if (!req.hostname || !HOSTNAME_RE.test(req.hostname)) throw new HarborError('INVALID_REQUEST', 'public exposure needs a fully qualified hostname you control (e.g. n8n.example.com)');
      hostname = req.hostname;
      port = 443;
      const packageHasOwnAuth = pkg.manifest.setup !== undefined; // packages with their own onboarding manage their own accounts (n8n)
      protection = req.protection ?? (packageHasOwnAuth ? 'none' : 'basic');
      if (protection === 'none' && !packageHasOwnAuth) base.warnings.push(`${pkgName} has no login of its own; without basic-auth protection anyone who reaches ${hostname} can use it.`);
      const known = repo.domain(hostname);
      if (known?.dnsState === 'points_here') base.warnings.push(`${hostname} points at this machine (checked ${known.checkedAt ?? 'recently'}); the certificate is requested from Let's Encrypt automatically once published.`);
      else if (known) base.warnings.push(`${hostname} does not point at this machine yet (${known.dnsState.replace('_', ' ')}${known.note ? `: ${known.note}` : ''}); the certificate cannot be issued until it does.`);
      else base.warnings.push(`DNS: an A/AAAA record for ${hostname} must point at this host's public address, and ports 80/443 must be reachable from the internet, or the certificate cannot be issued. Register the domain under Settings → Public addresses to have Harbor check it.`);
    }
    const taken = repo.exposureByAddress(req.via, hostname, port);
    if (taken) throw new HarborError('NAME_CONFLICT', `${exposureUrl({ via: req.via, hostname, port })} is already used by another exposure`);
    if (endpoint.browserContext === 'ordinary') base.warnings.push('This endpoint is declared for ordinary browser contexts; it will still be served over HTTPS.');
    base.exposure = { endpointId, via: req.via, hostname, port, protection, makePrimary: req.makePrimary ?? false };
    if (req.makePrimary) base.primary = req.via;
    base.changes.push(
      `Publish "${inst.name}" endpoint ${endpointId} at ${exposureUrl(base.exposure)} via ${req.via === 'public' ? 'Caddy (Let\'s Encrypt certificate)' : 'tailscale serve (tailnet certificate)'} -> 127.0.0.1:${alloc.hostPort}`,
      ...(protection === 'basic' ? ['Generate retained basic-auth credentials (shown once when the operation completes)'] : []),
      ...(req.makePrimary ? [hasBaseUrlBindings ? 'Make it the primary address and recreate containers with the new base URL' : 'Make it the primary address'] : []),
      'Verify the address answers over HTTPS before marking it active',
    );
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'expose', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  private async allocatePorts(pkg: LoadedPackage, alsoUnavailable: Set<number> = new Set()) {
    const { repo, docker, ports, config } = this.ctx;
    const unavailable = new Set<number>([config.listen.port, ...repo.claimedPorts().map((c) => c.port), ...alsoUnavailable]);
    try {
      for (const p of await docker.publishedHostPorts()) unavailable.add(p);
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `cannot query Docker port bindings: ${(e as Error).message}`);
    }
    // Lowest candidates first; any port with an actual listener is excluded and allocation retried.
    for (let round = 0; round < 64; round++) {
      const candidates = allocateEndpoints(pkg.manifest, config.appPortRange, unavailable);
      let clean = true;
      for (const c of candidates) {
        if (!(await ports.free(c.hostPort))) {
          unavailable.add(c.hostPort);
          clean = false;
        }
      }
      if (clean) return candidates;
    }
    throw new HarborError('PORT_CONFLICT', 'could not find free loopback ports after repeated attempts');
  }

  // Non-mutating Compose canonical validation of the prospective model, in a scratch directory.
  private async validateProspective(pkg: LoadedPackage, identity: ReturnType<typeof identityFor>, endpoints: PlanProposal['endpoints']): Promise<void> {
    const builtImages = Object.fromEntries(Object.entries(pkg.release.builds ?? {}).map(([svc, b]) => [svc, b.tag]));
    const rendered = renderCompose({ manifest: pkg.manifest, compose: pkg.compose, identity, endpoints, secretValues: null, builtImages });
    const scratch = path.join(this.ctx.config.stateDir, 'scratch', identity.instanceId);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const file = path.join(scratch, 'compose.yaml');
    try {
      writeFileSync(file, rendered.yaml, { mode: 0o600 });
      await this.ctx.compose.config({ projectDir: scratch, projectName: identity.project, file }, 60_000);
    } catch (e) {
      if (e instanceof ComposeError) throw new HarborError('INVALID_PACKAGE', `Compose rejected the generated model: ${e.message}`);
      throw e;
    } finally {
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---- submission (atomic claims + idempotency)

  // The app-home passphrase for an install-location plan. It is never stored
  // in the plan (plans are readable); the submitter hands it over with the
  // submission and the runner consumes it at apply time. Held in memory only,
  // keyed by plan id, single-use.
  private locationSecrets = new Map<string, string>();
  submitInstallLocationSecret(planId: string, passphrase: string): void {
    if (typeof passphrase !== 'string' || !passphrase) throw new HarborError('INVALID_REQUEST', 'the app encryption passphrase is required to submit this plan');
    this.locationSecrets.set(planId, passphrase);
  }
  takeInstallLocationSecret(planId: string): string | null {
    const s = this.locationSecrets.get(planId) ?? null;
    this.locationSecrets.delete(planId);
    return s;
  }

  submit(planId: string, idempotencyKey: string, actor: string): SubmitResult {
    const { repo, ids } = this.ctx;
    const result = repo.transaction((): SubmitResult => {
      const existing = repo.operationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.planId === planId && existing.actor === actor) return { operation: existing, created: false };
        throw new HarborError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request', { operationId: existing.id });
      }
      const plan = repo.plan(planId);
      if (!plan) throw new HarborError('NOT_FOUND', `unknown plan ${planId}`);
      if (plan.actor !== actor) throw new HarborError('NOT_FOUND', `unknown plan ${planId}`);
      if (plan.consumedOperationId) {
        throw new HarborError('IDEMPOTENCY_CONFLICT', `plan ${planId} was already submitted`, { operationId: plan.consumedOperationId, nextAction: 'Poll the existing operation instead of submitting again.' });
      }
      if (new Date(plan.expiresAt).getTime() <= this.ctx.clock.now().getTime()) throw new HarborError('PLAN_EXPIRED', `plan ${planId} expired at ${plan.expiresAt}`);

      const operationId = ids.uuid();
      if (plan.kind === 'install') {
        if (repo.instanceByName(plan.proposal.name)) throw new HarborError('NAME_CONFLICT', `instance name ${plan.proposal.name} is no longer free`);
        if (repo.instance(plan.instanceId)) throw new HarborError('STATE_CHANGED', 'plan instance already exists');
        // Install-location plans need their passphrase at submit time (it is
        // never in the plan itself). Refuse here — not at apply — so a missing
        // secret fails fast with a clear error instead of a stuck operation.
        if (plan.proposal.location && !this.locationSecrets.has(planId)) {
          throw new HarborError('INVALID_REQUEST', 'this plan installs the app encrypted on a drive: submit the encryption passphrase with it', { nextAction: 'Submit again with the passphrase shown at install time.' });
        }
        const claimed = new Set(repo.claimedPorts().map((c) => c.port));
        for (const e of plan.proposal.endpoints) {
          if (claimed.has(e.hostPort)) throw new HarborError('PORT_CONFLICT', `port ${e.hostPort} was claimed by another operation since planning`);
        }
        repo.insertInstance({
          id: plan.instanceId,
          name: plan.proposal.name,
          project: plan.proposal.project,
          packageId: plan.proposal.packageId,
          revision: plan.proposal.revision,
          generation: 0,
          desired: 'running',
          installState: 'installing',
          runtime: 'unknown',
          readiness: 'unknown',
          everInstalled: false,
          releaseDir: path.join('instances', plan.instanceId, 'release'),
          releaseHashes: plan.proposal.releaseHashes,
          endpoints: plan.proposal.endpoints,
          secrets: [],
          activeOperationId: operationId,
          autoUpdate: repo.setting<boolean>('updates.autoDefault') ?? false,
        });
        for (const e of plan.proposal.endpoints) repo.claimPort(e.hostPort, plan.instanceId, e.id);
      } else {
        const inst = repo.instance(plan.instanceId);
        if (!inst) throw new HarborError('NOT_FOUND', `instance ${plan.instanceId} no longer exists`);
        if (inst.generation !== plan.expectedGeneration) throw new HarborError('STATE_CHANGED', `instance ${inst.name} changed since the plan was created (generation ${inst.generation}, expected ${plan.expectedGeneration})`);
        if (inst.activeOperationId) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
        repo.updateInstance(inst.id, { activeOperationId: operationId });
      }
      repo.insertOperation({ id: operationId, idempotencyKey, planId, actor, kind: plan.kind, instanceId: plan.instanceId });
      repo.consumePlan(planId, operationId);
      repo.addEvent({ operationId, instanceId: plan.instanceId, phase: 'queued', message: `${plan.kind} accepted for instance ${plan.proposal.name}` });
      return { operation: repo.operation(operationId)!, created: true };
    });
    if (result.created) this.wake();
    return result;
  }
}
