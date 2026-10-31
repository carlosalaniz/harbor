import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UUID_RE } from '../contracts/patterns.js';
import { tagValue } from '../backups/restic.js';
import { INTERNAL_ACTORS, QUEUEABLE_KINDS, type AppLinkDto, type FixedPortDto, type LinkChoice, type LinkDto, type QueueableKind } from '../contracts/api.js';
import type { LinkClaim, Manifest, ManifestPermission, ManifestSetting, SecretClaim, SettingValue } from '../contracts/types.js';
import { fixedPortClaim, fixedPortsOf, newPermissions, PERMISSION_LABEL, permissionDto, permissionsOf } from '../planner/permissions.js';
import { gpuChanges, gpuDto, gpuFromRendered, gpuServicesOf } from '../planner/gpu.js';
import { linkAlias, linkNetworkName, linkValue } from '../planner/links.js';
import { checkSubmittedSecrets, plannedSecrets } from '../planner/secrets.js';
import { checkSubmittedSettings, formatSettingValue, installSettingChanges, plannedConfigureSettings, plannedInstallSettings, plannedUpdateSettings, settingDtos } from '../planner/settings.js';
import { plannedConfigureInternet, plannedInstallInternet, plannedUpdateInternet, packageInternet } from '../planner/internet.js';
import type { LinkRow, PlannedLink, PlannedSecret } from '../state/repo.js';
import type { AddSourceResult, CatalogItemDto, CatalogStatusDto, GpuDto, DiagnosticsDto, DomainDto, DomainsDto, FoundAppDto, PermissionDto, InstallCandidateDto, InstanceDetail, InstanceLogsDto, InstanceSummary, LogsDto, AddressOptionsDto, NetworkHttpsDto, NotificationActionDto, NotificationChannelDto, NotificationsDto, OperationDto, OperationQueueDto, PackageImportResultDto, PackageSourceDto, PlanDto, PlanRequest, SelfUpdateStatusDto, StorageUsageDto, SystemDto, SystemMetricsDto, WidgetDto } from '../contracts/api.js';
import { journalTail } from '../system/logs.js';
import { lanAppHost, lanNames, lanUrl } from '../system/lan.js';
import { caPem, ensureTlsCerts, HTTPS_ONLY_SETTING, httpsOnlyOn, lanHttpsHosts, readTlsState, reconcileLanHttps, runtimeLanAccess } from '../system/lan-https.js';
import { hostname } from 'node:os';
import { defaultCredentialsOf } from '../packages/catalog.js';
import { dnsState } from '../system/net.js';
import { sampleMetrics } from '../system/metrics.js';
import type { LoadedPackage } from '../contracts/types.js';
import { compareRevisions, type PackageStore } from '../packages/store.js';
import { browserUrlFor, managementOrigin } from '../config.js';
import { HarborError, personCanResolve } from '../errors.js';
import { copyNote, identityFor, oneCopyNextAction, ownedVolumeName, proposeName, type InstanceIdentity } from '../planner/identity.js';
import { allocateEndpoints } from '../planner/ports.js';
import { renderCompose } from '../planner/render.js';
import { checkHostDirectory, hostPathsOverlap, normalizeHostPath } from '../storage/host-path.js';
import { assertMarkerWritable, verifyBindMarker, writeBindMarker } from '../storage/bind-marker.js';
import { installCandidates } from '../storage/install-location.js';
import { describeAppHome, rewrapAppHome, scanAppHomes, unwrapMasterKeyForMachine, unlockAppHome, wrapMasterKeyForMachine, zeroKey, type MachineWrappedKey } from '../storage/app-home.js';
import { verifyPassword } from '../auth/password.js';
import { zeroMachineKey } from '../auth/machine-key.js';
import { protectorFor, type AppHomeRef } from '../storage/crypto-provider.js';
import { INSTALLATION_RECOVERY_SETTING, newInstallationRecoveryKey, openInstallationRecovery, sealInstallationRecovery, type StoredInstallationRecovery } from '../storage/installation-recovery.js';
import { stampInstallationRecovery } from '../storage/app-home.js';
import type { ResourceRow } from '../state/repo.js';
import { listMounts } from '../system/host-storage.js';
import { FINAL_OPERATION_STATES, type EndpointAllocation, type FinalOperationState, type InstanceRow, type OperationRow, type PackageSourceRow, type PlanProposal, type PlanRow } from '../state/repo.js';
import { addSeconds, rfc3339 } from '../util.js';
import { validateGitSourceInput } from '../packages/git.js';
import { ComposeError } from '../docker/adapter.js';
import type { Ctx } from './context.js';
import { exposureDto, instanceSummary, operationDto, operationInstanceName, planDto, protectedReason } from './dto.js';
import { ONE_TIME_TTL_MS } from '../state/one-time.js';
import type { ExposureDto, ExposureVia } from '../contracts/api.js';
import { HOSTNAME_RE, exposureUrl, mainPublicExposure } from '../exposure/urls.js';
import { retainedExposures } from './retained-exposures.js';
import { instanceDir, loadReleaseSnapshot, readRuntimeModel, readSettingOverrides, secretExists } from './instance-dir.js';
import { packageVersionOf } from '../packages/version.js';

// Decision 176: an automatic update waits for its backup this long, and after a failed backup tries again this much later.
const AUTO_UPDATE_BACKUP_DEADLINE_MS = 6 * 60 * 60_000;
const AUTO_UPDATE_BACKUP_RETRY_MS = 4 * 60 * 60_000;
import { TAILNET_POLICY_ACTOR, TailnetAllPolicy } from './tailnet-all.js';

export interface SubmitResult {
  operation: OperationRow;
  created: boolean;
}

export interface SubmitOptions {
  secrets?: Record<string, string>;
  settings?: Record<string, SettingValue>;
  acceptPermissions?: boolean;
  adoptedHome?: { name: string; metadata: Record<string, unknown> };
}

// Read paths and the plan/submit contract. Mutations of Docker resources live in the runner.
// Decision 130: an install without a location is said plainly, wherever it comes from.
export const NOT_ENCRYPTED_WARNING = 'Not encrypted: the app keeps its data on plain Docker volumes, readable on disk, and starts on its own after a reboot before anyone logs in.';

export class ApplicationService {
  private lastDockerObservation: { available: boolean; observedAt: string | null; version: string | null; error: string | null } = { available: false, observedAt: null, version: null, error: null };
  private wake: () => void = () => {};
  // Live usage per instance, written by the observer tick; in-memory only (no history).
  private usageCache = new Map<string, { cpuPercent: number; memoryBytes: number; sampledAt: string }>();
  // docker system df is expensive: cache the grouped result for 60 s.
  private storageUsageCache: { at: number; value: StorageUsageDto } | null = null;

  // decision 177: "every app gets a Tailscale address" (the observer drives it; routes read and set it)
  readonly tailnetAll: TailnetAllPolicy;

  constructor(readonly ctx: Ctx) {
    this.tailnetAll = new TailnetAllPolicy(ctx, this);
  }

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
        if (this.autoTried()[i.id] === upd.revision) continue;
        this.setAutoTried(i.id, upd.revision);
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
  // The Harbor data folder (system disk, not portable) is the default-encrypt
  // location (decision 94): apps there seal with Harbor's own key, need no
  // passphrase, and unlock silently. Everything else (removable drives) needs
  // a custom passphrase for portability. The data-folder candidate is also
  // the test/dev escape hatch (statfs fallback), so match it by label — plus
  // the same-filesystem fallback below (tmp "drives" the mount table misses).
  private isDataFolderLocation(dir: string): boolean {
    const candidates = this.installCandidates();
    const parent = candidates.find((c) => dir === c.dir || dir.startsWith(c.dir + '/'));
    if (parent?.label.startsWith('Harbor data folder')) return true;
    // Tmp "drive" the mount table misses (tests/dev): same filesystem as the
    // data folder means system disk means default-key.
    try {
      const a = statfsSync(dir === '/' ? '/' : path.posix.dirname(dir)) as unknown as { type?: number; bsize?: number; blocks?: number };
      const b = statfsSync(this.ctx.config.userDataDir) as unknown as { type?: number; bsize?: number; blocks?: number };
      return a.type === b.type && a.bsize === b.bsize && a.blocks === b.blocks;
    } catch {
      return false;
    }
  }
  // Resolve an install-location request at plan time. Returns the normalized
  // dir; throws when the dir is not an eligible candidate, does not exist, or
  // overlaps another app's folders or homes. The data-folder candidate is the
  // escape hatch for tests and dev (a tmp "drive" the live mount table does
  // not cover): any dir on the same filesystem as the data folder resolves
  // through it, so the engine path stays exercisable without real hardware.
  private resolveInstallLocation(dir: string, instances: InstanceRow[], packageId?: string): string {
    const candidates = this.installCandidates();
    const norm = normalizeHostPath(dir);
    // Nested layout (decision 97): the dir must be exactly
    // <candidate>/<packageId> — the package dir that will hold this app's
    // home. The home itself (<dir>/<instanceName>) is created at apply time,
    // so the instance name is NOT part of the dir: the wizard cannot know the
    // unique -2 suffix before planning (proposeName runs here, after the
    // request). Match the parent candidate first (a plain startsWith would
    // match the wrong parent for deeper paths), then enforce the exact
    // package-dir shape below.
    let parent: InstallCandidateDto | undefined;
    if (packageId !== undefined) {
      const candidateDir = norm.replace(/\/[^/]+$/, '');
      parent = candidates.find((c) => candidateDir === c.dir);
      if (!parent) {
        // The data-folder candidate itself: <data>/harbor-apps is the parent
        // (the common case — Local installs). No statfs needed.
        const dataCandidate = candidates.find((c) => c.label.startsWith('Harbor data folder'));
        if (dataCandidate?.eligible && candidateDir === dataCandidate.dir) {
          parent = dataCandidate;
        } else if (dataCandidate?.eligible) {
          // Tmp "drive" the mount table misses (tests/dev): the parent dir
          // is on the same filesystem as the data folder. Point the parent
          // at it so the nested-shape check below passes and the on-demand
          // mkdir creates the package dir.
          try {
            const a = statfsSync(candidateDir) as unknown as { type?: number; bsize?: number; blocks?: number };
            const b = statfsSync(this.ctx.config.userDataDir) as unknown as { type?: number; bsize?: number; blocks?: number };
            if (a.type === b.type && a.bsize === b.bsize && a.blocks === b.blocks) parent = { ...dataCandidate, dir: candidateDir };
          } catch {
            // statfs unavailable (or dir missing): fall through to the refusal below
          }
        }
      }
    } else {
      parent = candidates.find((c) => norm === c.dir || norm.startsWith(c.dir + '/'));
    }
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
    // Nested layout (decision 97): the dir must be exactly
    // <candidate>/<packageId> — the package dir that will hold this app's
    // home. The home itself (<dir>/<instanceName>) is created at apply time
    // from the planned name, so the instance name is not part of the dir.
    // The parent above is the candidate dir, so compare directly against it.
    if (packageId !== undefined) {
      const expected = `${parent.dir}/${packageId}`;
      if (norm !== expected) throw new HarborError('INVALID_REQUEST', `app folder must be ${expected}`, { nextAction: 'Pick the location in the install wizard instead of typing a path.' });
    }
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
    // Nested layout: create the package dir on demand (Harbor-owned). The
    // home dir itself is created by createAppHome at apply time — mkdirSync
    // with recursive is idempotent, so this only ensures the parent.
    if (packageId !== undefined && norm !== parent.dir) {
      try {
        mkdirSync(norm, { recursive: true, mode: 0o755 });
      } catch {
        // fall through to the existence check below, which reports it plainly
      }
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
    return instanceSummary(fresh, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(fresh.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(fresh, this.currentRevisionsSafe()), lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: this.usageCache.get(fresh.id) ?? null, needsDrive: this.needsDrive(fresh.id), home: this.homeState(fresh.id), ...this.extraLook(fresh, meta) });
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
      try {
        // decision 183: a busy app gets its update queued behind what it is doing, planned when its turn comes
        if (i.activeOperationId) {
          if (this.ctx.repo.activeOperationsOf(i.id).some((o) => o.kind === 'update')) {
            skipped.push({ instanceId: i.id, name: i.name, reason: 'an update is already queued' });
            continue;
          }
          const r = this.queueAction(i.id, 'update', actor, this.ctx.ids.uuid());
          started.push({ instanceId: i.id, name: i.name, operationId: r.operation.id });
          continue;
        }
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
  // Each (instance, revision) is attempted once — a rolled-back update must not loop. Decision 176: the
  // attempt is remembered in the `updates.autoTried` setting, so a restart does not retry it either; and an
  // app that backs up somewhere gets a fresh restore point first (an update can migrate data in a way the
  // image rollback cannot undo). A backup that fails holds the update and says so; it is tried again later.
  private autoBackups = new Map<string, { revision: string; since: string; heldUntil: number | null }>();
  async runAutoUpdates(): Promise<void> {
    const current = this.currentRevisionsSafe();
    for (const i of this.ctx.repo.listInstances()) {
      if (!i.autoUpdate || i.installState !== 'installed' || i.activeOperationId) continue;
      const upd = this.updateFor(i, current);
      if (!upd) continue;
      if (this.autoTried()[i.id] === upd.revision) continue;
      if (this.preUpdateBackup(i, upd.revision) !== 'go') continue;
      this.setAutoTried(i.id, upd.revision);
      try {
        const plan = await this.createPlan({ kind: 'update', instanceId: i.id }, 'auto-update');
        this.submit(plan.id, this.ctx.ids.uuid(), 'auto-update');
        this.ctx.log.info('auto-update submitted', { instanceId: i.id, to: upd.revision });
      } catch (e) {
        this.ctx.log.warn(`auto-update of ${i.name} could not start: ${(e as Error).message}`);
      }
    }
  }
  private autoTried(): Record<string, string> {
    return this.ctx.repo.setting<Record<string, string>>('updates.autoTried') ?? {};
  }
  private setAutoTried(instanceId: string, revision: string | null): void {
    const all = this.autoTried();
    if (revision === null) delete all[instanceId];
    else all[instanceId] = revision;
    this.ctx.repo.setSetting('updates.autoTried', all);
  }
  // 'go' when the app does not back up, or a backup that started after the update was seen finished well.
  private preUpdateBackup(i: InstanceRow, revision: string): 'go' | 'wait' {
    const backups = this.ctx.backups;
    if (!backups || !backups.appPolicy(i.id).enabled) return 'go';
    const label = i.displayName ?? i.name;
    const now = Date.now();
    const held = (why: string): 'wait' => {
      this.autoBackups.set(i.id, { revision, since: this.ctx.repo.now(), heldUntil: now + AUTO_UPDATE_BACKUP_RETRY_MS });
      this.ctx.notifier.notify({ kind: 'auto-update-held', severity: 'warning', title: `${label} was not updated automatically`, body: `Harbor backs ${label} up before an automatic update, and that backup did not succeed: ${why} It tries again in a few hours; Update from the app page skips the backup.`, instanceId: i.id, dedupeKey: `auto-update-held:${i.id}` });
      return 'wait';
    };
    const pending = this.autoBackups.get(i.id);
    if (pending && pending.revision === revision && pending.heldUntil !== null && now < pending.heldUntil) return 'wait';
    if (!pending || pending.revision !== revision || pending.heldUntil !== null) {
      try {
        backups.runNow(i.id);
      } catch (e) {
        return held(e instanceof HarborError && e.nextAction ? `${e.message}. ${e.nextAction}` : e instanceof Error ? e.message : String(e));
      }
      this.autoBackups.set(i.id, { revision, since: this.ctx.repo.now(), heldUntil: null });
      this.ctx.log.info(`auto-update of ${i.name}: backing it up first`, { instanceId: i.id, to: revision });
      return 'wait';
    }
    const run = this.ctx.repo.backupRuns({ instanceId: i.id, kind: 'backup', limit: 5 }).find((r) => r.startedAt >= pending.since);
    if (!run || run.state === 'running') {
      if (now - Date.parse(pending.since) > AUTO_UPDATE_BACKUP_DEADLINE_MS) return held('it did not finish within six hours.');
      return 'wait';
    }
    if (run.state === 'failed' || run.state === 'skipped') return held(run.message ?? `the backup ${run.state === 'failed' ? 'failed' : 'was skipped'}.`);
    this.autoBackups.delete(i.id);
    this.ctx.notifier.resolve(`auto-update-held:${i.id}`);
    return 'go';
  }

  // ---- notifications (decision 77)
  // Decision 122: a dismissed drive's notification goes with its card.
  resolveDriveNotification(key: string): void {
    this.ctx.notifier.resolve(`drive-attention:${key}`);
  }

  notifications(unreadOnly: boolean): NotificationsDto {
    const items = this.ctx.repo.notifications({ unreadOnly }).map((n) => ({ id: n.id, createdAt: n.createdAt, kind: n.kind, severity: n.severity, title: n.title, body: n.body, instanceId: n.instanceId, read: n.readAt !== null, link: notificationLink(n.kind), actions: notificationActions(n.kind, n.instanceId) }));
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
  dismissNotification(id: string): NotificationsDto {
    this.ctx.repo.deleteNotification(id);
    return this.notifications(false);
  }
  dismissAllNotifications(): NotificationsDto {
    this.ctx.repo.deleteAllNotifications();
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
    // decision 169: a line break in an address would inject SMTP commands
    for (const c of channels) if (c.kind === 'email' && (/[\r\n\0]/.test(c.from ?? '') || /[\r\n\0]/.test(c.to ?? ''))) throw new HarborError('INVALID_REQUEST', 'the from and to addresses must be one line each');
    // A redacted secret in the payload means "keep the stored one" — decision 165: only while it still goes to the
    // same place. A session that repoints a channel must type the secret again, or "Test" would hand it to the new host.
    const stored = this.ctx.notifier.channels();
    const kept = (what: string) => new HarborError('INVALID_REQUEST', `type the ${what} again: the address changed, and a stored secret only goes where it went before`);
    const merged = channels.map((c, idx) => {
      const prev = stored[idx];
      if (c.kind === 'ntfy' && c.token === '••••') {
        if (prev?.kind !== 'ntfy' || prev.server !== c.server) throw kept('ntfy token');
        return { ...c, ...(prev.token !== undefined ? { token: prev.token } : {}) };
      }
      if (c.kind === 'webhook' && c.secret === '••••') {
        if (prev?.kind !== 'webhook' || prev.url !== c.url) throw kept('webhook secret');
        return { ...c, ...(prev.secret !== undefined ? { secret: prev.secret } : {}) };
      }
      if (c.kind === 'email' && c.smtp.pass === '••••') {
        if (prev?.kind !== 'email' || prev.smtp.host !== c.smtp.host || prev.smtp.port !== c.smtp.port || prev.smtp.user !== c.smtp.user) throw kept('mail password');
        return { ...c, smtp: { ...c.smtp, ...(prev.smtp.pass !== undefined ? { pass: prev.smtp.pass } : {}) } };
      }
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
    const active = this.ctx.repo.activeOperations().find((o) => o.state !== 'queued' || o.startedAt !== null) ?? this.ctx.repo.activeOperations()[0];
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
      network: { https: this.networkHttps() },
      update: this.ctx.selfUpdate.status(),
      unlockNeeded: this.unlockNeeded(),
    };
  }
  // Decision 190: the machine key is sealed but not in memory (the daemon restarted since the last password),
  // and something waits on it: an app home that unlocks with it, or a backup place (nightly runs need it).
  private unlockNeeded(): boolean {
    const { repo, machineKey } = this.ctx;
    if (machineKey.unlocked || !repo.setting('security.machineKey')) return false;
    if (this.ctx.backups?.hasTargets()) return true;
    return repo.listInstances().some((i) => !i.purgedAt && this.homeRow(i.id)?.metadata?.['machineWrapped'] !== undefined);
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
  // ---- the official app catalog (decision 158): no Docker, so a direct call, not a plan
  catalogStatus(): CatalogStatusDto {
    return this.ctx.catalogUpdates.status();
  }
  catalogRefresh(): Promise<CatalogStatusDto> {
    return this.ctx.catalogUpdates.refresh();
  }
  // http://<hostname>.local for app addresses in LAN mode (the console swaps in the host it was opened with)
  private lanHost(): string | null {
    return this.ctx.config.lan.enabled ? lanAppHost() : null;
  }
  // Decision 167: with HTTPS only on, apps have no plain-http LAN address (their ports stay on loopback).
  private lanPlainHost(): string | null {
    return httpsOnlyOn(this.ctx) ? null : this.lanHost();
  }
  // https://<hostname>.local for app addresses when LAN HTTPS is on (same swap as lanHost)
  private lanSecureHost(): string | null {
    return this.httpsEnabled() ? (this.lanHost() ?? 'harbor.local') : null;
  }
  // ---- LAN HTTPS (decision 109): local CA + secure addresses. Off by
  // default; stored as a setting (no migration). Enabling mints the CA +
  // server cert (openssl) and starts the 443 console listener + one proxy
  // per app endpoint; disabling closes them. The CA cert is public key
  // material (trusting it is the point); the key never leaves tls/ (0600).
  httpsEnabled(): boolean {
    return this.ctx.config.lan.enabled && (this.ctx.repo.setting<boolean>('network.httpsEnabled') ?? false);
  }
  // Decision 164: names the Harbor certificate covers while LAN HTTPS is on (the console's https probe targets).
  httpsHosts(): string[] {
    if (!this.httpsEnabled()) return [];
    return readTlsState(this.ctx.config.stateDir)?.hosts ?? [];
  }
  networkHttps(): NetworkHttpsDto {
    const enabled = this.httpsEnabled();
    const tls = readTlsState(this.ctx.config.stateDir);
    return { enabled, httpsOnly: httpsOnlyOn(this.ctx), url: enabled ? 'https://harbor.local/' : null, fingerprint: tls?.fingerprint ?? null, expiresAt: tls?.expiresAt ?? null, hosts: tls?.hosts ?? [], ...(tls ? { caLimited: tls.caLimited } : {}), ...this.addressDependents(), rebindToApply: this.rebindDependents() };
  }

  // Decision 167: running apps whose ports are not bound the way the current setting wants until they restart:
  // with HTTPS only on, apps still open on plain http on the network; with it off, apps that only the relay
  // carries (no plain-http LAN address yet). Apps rendered while LAN mode was off are not counted (decision 165).
  private rebindDependents(): string[] {
    if (!this.ctx.config.lan.enabled) return [];
    const relayOnly = httpsOnlyOn(this.ctx);
    const out: string[] = [];
    for (const inst of this.ctx.repo.listInstances()) {
      if (inst.installState !== 'installed' || inst.runtime !== 'running') continue;
      const access = runtimeLanAccess(this.ctx.config.stateDir, inst.id);
      if ((relayOnly && access === 'lan') || (!relayOnly && access === 'relay')) out.push(inst.displayName ?? inst.name);
    }
    return out.sort();
  }

  // Decision 116: who a LAN HTTPS switch affects. breaksWhenOff = apps that need HTTPS whose main address
  // is "this network" and that have no tailnet/public address; restartToApply = running apps that embed
  // their address or keep a host list (configuration bindings / afterStart hook).
  private addressDependents(): { breaksWhenOff: string[]; restartToApply: string[] } {
    const breaksWhenOff: string[] = [];
    const restartToApply: string[] = [];
    for (const inst of this.ctx.repo.listInstances()) {
      if (inst.installState !== 'installed') continue;
      let pkg: LoadedPackage;
      try {
        pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId);
      } catch {
        continue;
      }
      const label = inst.displayName ?? inst.name;
      const published = this.ctx.repo.exposures(inst.id).length > 0;
      if (requiresHttps(pkg) && inst.primaryExposure === 'loopback' && !published) breaksWhenOff.push(label);
      if (inst.runtime === 'running' && ((pkg.manifest.configuration ?? []).length > 0 || pkg.manifest.hooks?.afterStart)) restartToApply.push(label);
    }
    return { breaksWhenOff: breaksWhenOff.sort(), restartToApply: restartToApply.sort() };
  }

  // Decision 116: the main-address choices that exist right now (the install page shows only these).
  async addressOptions(): Promise<AddressOptionsDto> {
    const lanHost = this.lanHost();
    const local: AddressOptionsDto['local'] = this.httpsEnabled() && lanHost ? { kind: 'https', host: lanHost } : lanHost ? { kind: 'http', host: lanHost } : { kind: 'loopback', host: 'localhost' };
    let tailnet: AddressOptionsDto['tailnet'] = null;
    try {
      const st = await this.ctx.tailscale.status();
      if (st && st.backendState === 'Running' && st.dnsName && st.httpsEnabled) tailnet = { hostname: st.dnsName };
    } catch {
      tailnet = null;
    }
    // decision 157: a domain another app already uses is not a choice (it would take that app's address)
    const used = new Set(this.exposuresList().filter((e) => e.via === 'public').map((e) => e.hostname));
    const domains = (await this.caddyReady()) ? this.ctx.repo.domains().filter((d) => d.dnsState === 'points_here' && !used.has(d.hostname)).map((d) => d.hostname).sort() : [];
    return { local, tailnet, domains };
  }

  private async caddyReady(): Promise<boolean> {
    try {
      return await this.ctx.caddy.available();
    } catch {
      return false;
    }
  }
  // Decision 167: `httpsOnly` (optional) switches HTTPS only. Turning it on needs secure addresses on and a request
  // that itself arrived over https or from this machine (`overHttps`), so nobody locks themselves out from a
  // browser that never reached the https console. Turning secure addresses off turns HTTPS only off too.
  async setNetworkHttps(enabled: boolean, opts: { httpsOnly?: boolean; overHttps?: boolean } = {}): Promise<NetworkHttpsDto> {
    if (enabled && !this.ctx.config.lan.enabled) throw new HarborError('INVALID_STATE', 'LAN mode is off', { nextAction: 'Turn on LAN mode first (bootstrap --lan): HTTPS secures the LAN addresses.' });
    if (!enabled && opts.httpsOnly === true) throw new HarborError('INVALID_STATE', 'HTTPS only needs secure addresses on', { nextAction: 'Turn on secure addresses as well (enabled: true).' });
    if (opts.httpsOnly === true && !opts.overHttps) {
      throw new HarborError('INVALID_STATE', 'HTTPS only can only be turned on from a page opened over https', { nextAction: 'Open the console at its https address (trust the certificate on this device first), then turn it on there.' });
    }
    if (enabled) {
      const hosts = lanHttpsHosts();
      await ensureTlsCerts(this.ctx.config.stateDir, hosts);
      this.ctx.repo.setSetting('network.httpsEnabled', true);
      this.ctx.log.info('LAN HTTPS enabled', { hosts: hosts.join(',') });
    } else {
      this.ctx.repo.setSetting('network.httpsEnabled', false);
      this.ctx.log.info('LAN HTTPS disabled', {});
    }
    const only = enabled ? (opts.httpsOnly ?? this.ctx.repo.setting<boolean>(HTTPS_ONLY_SETTING) ?? false) : false;
    if (only !== (this.ctx.repo.setting<boolean>(HTTPS_ONLY_SETTING) ?? false)) {
      this.ctx.repo.setSetting(HTTPS_ONLY_SETTING, only);
      this.ctx.log.info(only ? 'HTTPS only on: plain-http console requests redirect to https, apps re-bind to loopback on restart' : 'HTTPS only off', {});
    }
    await reconcileLanHttps(this.ctx);
    return this.networkHttps();
  }
  // Decision 165: a new local CA (name-constrained) and server cert. Every device has to trust the new one;
  // the old CA key is deleted, so nothing can be signed with it any more.
  async replaceLanCa(): Promise<NetworkHttpsDto> {
    if (!this.httpsEnabled()) throw new HarborError('INVALID_STATE', 'secure addresses are off', { nextAction: 'Turn them on first; that mints a new certificate authority anyway.' });
    await ensureTlsCerts(this.ctx.config.stateDir, lanHttpsHosts(), { replaceCa: true });
    this.ctx.log.info('LAN HTTPS certificate authority replaced', {});
    await reconcileLanHttps(this.ctx);
    return this.networkHttps();
  }
  caPem(): string {
    return caPem(this.ctx.config.stateDir);
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
  // Diagnostics bundle for beta testers: versions, host facts, redacted
  // instance summary, disk/mounts, log tail. No secrets, tokens, passphrases,
  // credentials or provider responses — safe to paste into a bug report.
  async diagnostics(): Promise<DiagnosticsDto> {
    const sys = this.system();
    const { hostFacts, sampleDisk } = await import('../system/metrics.js');
    const { listDevices, listMounts } = await import('../system/host-storage.js');
    const host = hostFacts();
    const disk = sampleDisk('/');
    const instances = this.ctx.repo.listInstances();
    const exposures = this.exposuresList();
    const logTail = await this.harborLogs(100);
    return {
      sampledAt: rfc3339(this.ctx.clock.now()),
      version: sys.version,
      installationId: sys.installationId,
      host,
      lan: sys.lan,
      docker: sys.docker,
      update: { current: sys.update.current, available: sys.update.available, latest: sys.update.latest?.version ?? null, checkedAt: sys.update.checkedAt, error: sys.update.error },
      storagePolicy: this.storagePolicy(),
      counts: { instances: instances.length, exposures: exposures.length, domains: this.ctx.repo.domains().length, packageSources: this.ctx.repo.packageSources().length, notificationsUnread: this.ctx.repo.unreadNotificationCount() },
      instances: instances.map((i) => ({
        name: i.name,
        packageId: i.packageId,
        revision: i.revision,
        installState: i.installState,
        desired: i.desired,
        runtime: i.runtime,
        readiness: i.readiness,
        needsDrive: this.needsDrive(i.id)?.path ?? null,
        home: this.ctx.repo.resources(i.id).find((r) => r.kind === 'volume' && r.role === '__home__')?.name ?? null,
        updateAvailable: this.updateFor(i, this.currentRevisionsSafe())?.revision ?? null,
      })),
      exposures: exposures.map((e) => ({ instanceName: e.instanceName, endpointId: e.endpointId, via: e.via, state: e.state, isPrimary: e.isPrimary })),
      mounts: [...listMounts().map((m) => ({ mountpoint: m.mountpoint, fsType: m.fsType, totalBytes: m.totalBytes, usedBytes: m.usedBytes })), ...(disk && !listMounts().some((m) => m.mountpoint === '/') ? [{ mountpoint: disk.path, fsType: 'unknown', totalBytes: disk.totalBytes, usedBytes: disk.usedBytes }] : [])],
      devices: listDevices().map((d) => ({ name: d.name, mounted: d.mounted, mountpoint: d.mountpoint, fsType: d.fsType, size: d.size })),
      logTail: { source: logTail.source, lines: logTail.lines.slice(-100) },
    };
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
    // decision 170: each item carries the name its next install gets by default (the planner's own rule)
    const taken = new Set(this.ctx.repo.listInstances().map((i) => i.name));
    return this.ctx.packages.list().map((item) => ({ ...item, proposedName: proposeName(item.id, taken).name }));
  }

  // The endpoint an app opens at (its manifest's ui.primaryEndpoint), for the tailnet policy (decision 177).
  primaryEndpointOf(i: InstanceRow): string {
    return this.packageMeta(i).primaryEndpoint;
  }

  private packageMeta(i: InstanceRow): { version: string | null; name: string; primaryEndpoint: string; description: string; setup: { endpoint: string; instructions: string } | null; icon: string | null; category: string; defaultCredentials: CatalogItemDto['defaultCredentials']; widget: NonNullable<LoadedPackage['manifest']['presentation']>['widget'] | null; operatorSecrets: SecretClaim[]; links: LinkClaim[]; settings: ManifestSetting[]; hideFromHome: boolean; apiOnly: boolean; ports: FixedPortDto[] } {
    const from = (pkg: LoadedPackage) => ({ settings: pkg.manifest.settings ?? [], version: pkg.revision === i.revision ? packageVersionOf(pkg) : null, ports: fixedPortsOf(pkg.manifest), hideFromHome: pkg.manifest.presentation?.hideFromHome === true, apiOnly: pkg.manifest.endpoints[pkg.manifest.ui.primaryEndpoint]?.kind === 'api', name: pkg.manifest.metadata.name, primaryEndpoint: pkg.manifest.ui.primaryEndpoint, description: pkg.manifest.metadata.description, setup: pkg.manifest.setup ?? null, icon: pkg.manifest.presentation?.icon ?? null, category: pkg.manifest.presentation?.category ?? 'other', defaultCredentials: defaultCredentialsOf(pkg.manifest), widget: pkg.manifest.presentation?.widget ?? null, operatorSecrets: (pkg.manifest.secrets ?? []).filter((x) => x.source === 'operator'), links: pkg.manifest.links ?? [] });
    try {
      return from(loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'release'), i.packageId));
    } catch {
      try {
        return from(this.ctx.packages.load(i.packageId));
      } catch {
        return { version: null, name: i.packageId, primaryEndpoint: i.endpoints[0]?.id ?? 'web', description: '', setup: null, icon: null, category: 'other', defaultCredentials: null, widget: null, operatorSecrets: [], links: [], settings: [], hideFromHome: false, apiOnly: false, ports: [] };
      }
    }
  }

  // Package asset bytes for the console (icon/gallery), from the bundled or uploaded package, without its
  // minHarbor gate. When the current revision cannot be read or no longer names the asset, an installed
  // copy's release snapshot answers (the icon of an app that runs here never breaks with a catalog update).
  asset(packageId: string, name: string): { bytes: Buffer; contentType: string } {
    let bytes: Buffer | null = null;
    let failure: unknown = null;
    try {
      bytes = this.ctx.packages.loadAsset(packageId, name);
    } catch (e) {
      failure = e;
    }
    for (const i of bytes ? [] : this.ctx.repo.listInstances().filter((x) => x.packageId === packageId)) {
      try {
        bytes = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'release'), packageId).assets[name] ?? null;
      } catch {
        /* a missing or damaged snapshot: try the next copy */
      }
      if (bytes) break;
    }
    if (!bytes) {
      if (failure && !HarborError.is(failure, 'NOT_FOUND')) throw failure;
      throw new HarborError('NOT_FOUND', `no asset ${name} in package ${packageId}`);
    }
    const ext = name.split('.').pop();
    const contentType = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { bytes, contentType };
  }

  // ---- app links (decision 126) and operator secrets (decision 125): read models

  // Read-time look that is not a column: links, operator secrets and Hide from Home (decision 131: the
  // operator's per-app choice in the `home.hidden` setting wins over the package's suggestion).
  private extraLook(i: InstanceRow, meta: { version: string | null; operatorSecrets: SecretClaim[]; links: LinkClaim[]; settings: ManifestSetting[]; hideFromHome: boolean; apiOnly: boolean; ports: FixedPortDto[] }): ReturnType<ApplicationService['linkLook']> & { version: string | null; hiddenFromHome: boolean; apiOnly: boolean; ports: FixedPortDto[]; settings: NonNullable<InstanceSummary['settings']>; internet?: InstanceSummary['internet'] } {
    const choice = this.ctx.repo.setting<Record<string, boolean>>('home.hidden')?.[i.id];
    // decision 180: effective values (the operator's overrides, else the installed release's defaults)
    const settings = meta.settings.length ? settingDtos({ settings: meta.settings }, readSettingOverrides(this.ctx.config.stateDir, i.id)) : [];
    return { ...this.linkLook(i, meta), version: meta.version, hiddenFromHome: choice ?? meta.hideFromHome, apiOnly: meta.apiOnly, ports: meta.ports, settings, ...(this.ctx.egress ? { internet: this.ctx.egress.internetDto(i) } : {}) };
  }

  private linkLook(i: InstanceRow, meta: { operatorSecrets: SecretClaim[]; links: LinkClaim[] }): { links: AppLinkDto[]; linkedBy: InstanceSummary['linkedBy']; operatorSecrets: InstanceSummary['operatorSecrets'] } {
    const secretsDir = path.join(instanceDir(this.ctx.config.stateDir, i.id), 'secrets');
    return {
      links: this.appLinks(i, meta.links),
      linkedBy: this.ctx.repo.linksOfProvider(i.id).map((l) => ({ instanceId: l.consumerInstanceId, name: this.ctx.repo.instance(l.consumerInstanceId)?.name ?? l.consumerInstanceId, linkId: l.linkId, state: l.state })),
      operatorSecrets: meta.operatorSecrets.map((s) => ({ id: s.id, prompt: s.prompt ?? s.id, optional: s.optional ?? false, set: secretExists(secretsDir, s.id) })),
    };
  }

  private appLinks(i: InstanceRow, claims: LinkClaim[]): AppLinkDto[] {
    const rows = this.ctx.repo.linksOfConsumer(i.id);
    const identity = identityFor(this.ctx.installationId, i.id);
    return claims.map((c) => {
      const row = rows.find((r) => r.linkId === c.id);
      const prov = row?.providerInstanceId ? this.ctx.repo.instance(row.providerInstanceId) : null;
      const alloc = prov && row?.providerEndpoint ? prov.endpoints.find((e) => e.id === row.providerEndpoint) : undefined;
      const alias = linkAlias(c.id);
      return {
        id: c.id,
        purpose: c.purpose,
        optional: c.optional ?? false,
        state: row?.state ?? 'needs_provider',
        provider: prov && row?.providerEndpoint ? { instanceId: prov.id, name: prov.name, endpointId: row.providerEndpoint } : null,
        alias,
        network: row?.networkName ?? linkNetworkName(identity, c.id),
        url: alloc ? linkValue(alias, alloc.containerPort) : null,
        note: row?.note ?? null,
      };
    });
  }

  // Settings → Internal networks: every link of every app on this machine.
  linksList(): LinkDto[] {
    const out: LinkDto[] = [];
    for (const i of this.ctx.repo.listInstances()) {
      const meta = this.packageMeta(i);
      for (const l of this.appLinks(i, meta.links)) out.push({ ...l, consumer: { instanceId: i.id, name: i.name } });
    }
    return out;
  }

  // Apps that can satisfy one link: installed, not the consumer itself, of an allowed package, with the endpoint.
  private linkCandidates(claim: LinkClaim, selfId: string | null): { inst: InstanceRow; alloc: EndpointAllocation }[] {
    const out: { inst: InstanceRow; alloc: EndpointAllocation }[] = [];
    for (const i of this.ctx.repo.listInstances()) {
      if (i.id === selfId || i.installState !== 'installed') continue;
      if (claim.provider?.packages && !claim.provider.packages.includes(i.packageId)) continue;
      const alloc = this.providerEndpointFor(i, claim.provider?.endpoint);
      if (alloc) out.push({ inst: i, alloc });
    }
    return out;
  }

  private providerEndpointFor(i: InstanceRow, wanted?: string): EndpointAllocation | null {
    if (wanted) return i.endpoints.find((e) => e.id === wanted) ?? null;
    const primary = this.packageMeta(i).primaryEndpoint;
    return i.endpoints.find((e) => e.id === primary) ?? i.endpoints[0] ?? null;
  }

  // Resolve every link of `manifest` for a plan: an explicit choice, the existing provider (update/configure),
  // the only candidate there is (required links), or none (optional links). Refuses with a next action otherwise.
  private resolveLinks(manifest: Manifest, consumer: InstanceIdentity, choices: Record<string, LinkChoice | null>, opts: { selfId: string | null; existing?: LinkRow[]; allowClear?: boolean; explicitOnly?: boolean }): PlannedLink[] {
    const claims = manifest.links ?? [];
    for (const id of Object.keys(choices)) if (!claims.some((c) => c.id === id)) throw new HarborError('INVALID_REQUEST', `${manifest.metadata.name} has no link ${id}`, { nextAction: claims.length ? `Its links: ${claims.map((c) => c.id).join(', ')}.` : 'This app does not link to other apps.' });
    return claims.map((c): PlannedLink => {
      const base = { id: c.id, purpose: c.purpose, optional: c.optional ?? false, network: linkNetworkName(consumer, c.id), alias: linkAlias(c.id) };
      const toProvider = (inst: InstanceRow, alloc: EndpointAllocation) => ({ instanceId: inst.id, name: inst.name, endpointId: alloc.id, service: alloc.service, containerPort: alloc.containerPort });
      if (c.id in choices) {
        const choice = choices[c.id];
        if (choice === null || choice === undefined) {
          if (!opts.allowClear) throw new HarborError('INVALID_REQUEST', `link ${c.id} needs a provider`);
          if (!c.optional) throw new HarborError('INVALID_REQUEST', `${manifest.metadata.name} cannot work without its link ${c.id} (${c.purpose})`, { nextAction: 'Pick another provider instead of unlinking.' });
          return { ...base, provider: null, change: 'clear' };
        }
        const inst = this.instanceRow(choice.instanceId);
        if (inst.id === opts.selfId) throw new HarborError('INVALID_REQUEST', 'an app cannot link to itself');
        if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `${inst.name} is ${inst.installState}; only installed apps can be linked`, { nextAction: `Install or reinstall ${inst.name} first.` });
        if (c.provider?.packages && !c.provider.packages.includes(inst.packageId)) throw new HarborError('INVALID_REQUEST', `link ${c.id} needs ${c.provider.packages.join(' or ')}, and ${inst.name} is ${inst.packageId}`, { nextAction: `Choose an app installed from ${c.provider.packages.join(' or ')}.` });
        const alloc = this.providerEndpointFor(inst, choice.endpointId ?? c.provider?.endpoint);
        if (!alloc) throw new HarborError('INVALID_REQUEST', `${inst.name} has no endpoint ${choice.endpointId ?? c.provider?.endpoint ?? ''}`.trim(), { nextAction: `Its endpoints: ${inst.endpoints.map((e) => e.id).join(', ') || 'none'}.` });
        return { ...base, provider: toProvider(inst, alloc), change: 'set' };
      }
      const row = opts.existing?.find((r) => r.linkId === c.id);
      if (row) {
        const prov = row.providerInstanceId ? this.ctx.repo.instance(row.providerInstanceId) : null;
        const alloc = prov && row.providerEndpoint ? prov.endpoints.find((e) => e.id === row.providerEndpoint) : undefined;
        if (prov && alloc) return { ...base, provider: toProvider(prov, alloc), change: 'keep' };
        if (opts.explicitOnly || c.optional) return { ...base, provider: null, change: 'keep' };
      }
      if (opts.explicitOnly) return { ...base, provider: null, change: 'keep' };
      const candidates = this.linkCandidates(c, opts.selfId);
      if (!c.optional && candidates.length === 1) return { ...base, provider: toProvider(candidates[0]!.inst, candidates[0]!.alloc), change: 'set' };
      if (c.optional) return { ...base, provider: null, change: row ? 'keep' : 'set' };
      throw new HarborError('INVALID_REQUEST', `${manifest.metadata.name} needs ${c.purpose} (link ${c.id})`, {
        nextAction: candidates.length ? `Choose which app it uses: --link ${c.id}=<${candidates.map((x) => x.inst.name).join('|')}> (console: the picker in the install dialog).` : `Install ${c.provider?.packages ? c.provider.packages.join(' or ') : 'the app it talks to'} first, then this one.`,
      });
    });
  }

  private linkChanges(links: PlannedLink[], appName: string): string[] {
    return links.flatMap((l) => {
      if (l.change === 'keep') return [];
      if (l.change === 'clear') return [`Unlink ${l.id}: delete its private network ${l.network}; ${appName} no longer gets the address`];
      if (!l.provider) return [`Leave the optional link ${l.id} (${l.purpose}) without a provider for now`];
      return [`Link ${l.id}: create the private network ${l.network} joining only ${appName}'s linked service(s) and ${l.provider.name}'s ${l.provider.service} service, which answers there as ${l.alias}; ${appName} gets ${linkValue(l.alias, l.provider.containerPort)}`];
    });
  }

  // Remove/purge plans: what happens to links on either side.
  private linkRemovalNotes(inst: InstanceRow): { changes: string[]; warnings: string[] } {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const l of this.ctx.repo.linksOfConsumer(inst.id).filter((x) => x.state === 'active')) changes.push(`Delete the private link network ${l.networkName} (link ${l.linkId}); Reinstall re-creates it`);
    for (const l of this.ctx.repo.linksOfProvider(inst.id)) {
      const consumer = this.ctx.repo.instance(l.consumerInstanceId);
      if (!consumer) continue;
      changes.push(`Unlink ${consumer.name} (its link ${l.linkId} uses ${inst.name}) and delete the network ${l.networkName}`);
      warnings.push(`${consumer.name} reaches ${inst.name} through its link "${l.linkId}"; afterwards it needs a provider (pick one on its page).`);
    }
    return { changes, warnings };
  }

  instances(): InstanceSummary[] {
    const current = this.currentRevisionsSafe();
    return this.ctx.repo.listInstances().map((i) => {
      const meta = this.packageMeta(i);
      return instanceSummary(i, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(i.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(i, current), lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: this.usageCache.get(i.id) ?? null, needsDrive: this.needsDrive(i.id), home: this.homeState(i.id), ...this.extraLook(i, meta) });
    });
  }
  // Install-location read model: the encrypted home on the drive (null =
  // system disk). Default-key homes (data folder) unlock silently via the
  // machine wrapping while AFU; custom-passphrase homes stay locked until
  // the operator unlocks them per-app at Start (ephemeral in-memory unlock,
  // cleared on reboot). Computed at read time from the 'home' resource plus
  // the ephemeral unlock cache — no migration.
  // Default-key homes are never "locked" in the UX sense: the operator chose
  // no passphrase, so there is nothing to type. They still report locked
  // while BFU (the machine key is not in memory yet) — the drawer then says
  // "log in again", never "type the passphrase".
  // Ephemeral per-app unlocks (custom passphrase, verified at Start/unlock).
  // In-memory only: a reboot returns every custom app to locked. Keyed by
  // instance id, single master-key copy each, zeroed on lock/clear.
  private unlockedApps = new Map<string, Buffer>();
  /** Stash a verified master key for one app until lock/reboot. Caller hands over ownership. */
  holdAppUnlock(instanceId: string, masterKey: Buffer): void {
    this.lockApp(instanceId);
    this.unlockedApps.set(instanceId, masterKey);
  }
  /** Drop one app's ephemeral unlock (explicit Lock). */
  lockApp(instanceId: string): void {
    const k = this.unlockedApps.get(instanceId);
    if (k) {
      zeroKey(k);
      this.unlockedApps.delete(instanceId);
    }
  }
  /** True while this boot holds the app's key (Start may proceed without a passphrase). */
  isAppUnlocked(instanceId: string): boolean {
    return this.unlockedApps.has(instanceId);
  }
  /** A copy of this boot's held key (the runner kernel-unlocks with it). The caller zeroes it. */
  takeAppUnlockCopy(instanceId: string): Buffer | null {
    const k = this.unlockedApps.get(instanceId);
    return k ? Buffer.from(k) : null;
  }
  private homeRow(instanceId: string): ResourceRow | undefined {
    return this.ctx.repo.resources(instanceId).find((r) => r.kind === 'volume' && r.role === '__home__');
  }
  /** Record whether <home>/volumes is kernel-sealed (set by the runner after seal/migrate/adopt-status). */
  markHomeSealed(instanceId: string, sealed = true): void {
    const home = this.homeRow(instanceId);
    if (!home) return;
    this.ctx.repo.upsertResource({ instanceId: home.instanceId, kind: home.kind, role: home.role, dockerId: home.dockerId, name: home.name, token: home.token, metadata: { ...(home.metadata ?? {}), kernelSealed: sealed } });
  }
  // Read model for the encrypted home. Sealed homes report KERNEL truth: a
  // mkdir probe inside <home>/volumes answers ENOKEY while locked, for Docker
  // as much as for us — so the tile says Locked exactly when the data on disk
  // is unreadable, across daemon restarts, manual locks and reboots. Homes
  // installed before sealing worked (`sealed: false`) keep the old memory
  // model until their next Start seals them in place.
  private homeState(instanceId: string): InstanceSummary['home'] {
    try {
      const home = this.homeRow(instanceId);
      if (!home) return null;
      const defaultKey = home.metadata?.['defaultKey'] === true;
      const sealed = home.metadata?.['kernelSealed'] === true;
      const crypto = this.ctx.crypto;
      let state: 'locked' | 'unlocked';
      if (sealed && crypto) {
        state = crypto.kernelState(home.name) === 'locked' ? 'locked' : 'unlocked';
      } else if (!defaultKey) {
        state = this.unlockedApps.has(instanceId) ? 'unlocked' : 'locked';
      } else {
        const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
        const machineKey = this.ctx.machineKey.take();
        state = 'locked';
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
      }
      const silentUnlock = home.metadata?.['machineWrapped'] !== undefined;
      return { path: home.name, encrypted: true, state, sealed, silentUnlock, ...(defaultKey ? { defaultKey: true as const } : {}) };
    } catch {
      return null;
    }
  }
  /** True when the given app passphrase is the administrator's login password. */
  async matchesAdminPassword(passphrase: string): Promise<boolean> {
    const admin = this.ctx.repo.administrator();
    if (!admin) return false;
    try {
      return await verifyPassword(passphrase, { hash: admin.passwordHash, salt: admin.salt, params: admin.params });
    } catch {
      return false;
    }
  }
  // "Same password, no retyping": a custom-passphrase home whose passphrase
  // is the Harbor password gains a machine wrapping of its key (like a
  // default-key home), so this machine unlocks it at login. The passphrase
  // envelope on the drive is untouched — it still travels. Nothing is stored
  // that the login password alone would not already open.
  async backfillLoginKey(instanceId: string, masterKey: Buffer, passphrase: string): Promise<boolean> {
    const home = this.homeRow(instanceId);
    if (!home || home.metadata?.['machineWrapped'] !== undefined) return false;
    const wrapped = await this.loginWrapping(masterKey, passphrase);
    if (!wrapped) return false;
    this.ctx.repo.upsertResource({ instanceId: home.instanceId, kind: home.kind, role: home.role, dockerId: home.dockerId, name: home.name, token: home.token, metadata: { ...(home.metadata ?? {}), machineWrapped: wrapped, loginKey: true } });
    this.ctx.log.info('app home now unlocks with the Harbor login on this machine (passphrase matches)', { instanceId });
    return true;
  }
  // The machine wrapping of an app's key when its passphrase is the Harbor login password (null otherwise)
  private async loginWrapping(masterKey: Buffer, passphrase: string): Promise<MachineWrappedKey | null> {
    if (!(await this.matchesAdminPassword(passphrase))) return null;
    const machineKey = this.ctx.machineKey.take();
    if (!machineKey) return null;
    try {
      return wrapMasterKeyForMachine(masterKey, machineKey);
    } finally {
      zeroMachineKey(machineKey);
    }
  }
  /** Unlock one custom-passphrase app for this boot: verify, hold the key, add it to the kernel. Hard: a kernel failure drops the hold and surfaces. */
  async unlockApp(instanceId: string, passphrase: string): Promise<InstanceSummary> {
    const inst = this.instanceRow(instanceId);
    const home = this.homeRow(inst.id);
    if (!home) throw new HarborError('INVALID_STATE', `${inst.name} has no encrypted home`, { nextAction: 'This app lives on the system disk; there is nothing to unlock.' });
    const defaultKey = home.metadata?.['defaultKey'] === true;
    const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
    if (defaultKey && wrapped) throw new HarborError('INVALID_STATE', `${inst.name} unlocks silently at login`, { nextAction: 'Log in again if it shows locked.' });
    const masterKey = await unlockAppHome(home.name, passphrase);
    this.holdAppUnlock(inst.id, masterKey);
    const sealed = home.metadata?.['kernelSealed'] === true;
    const crypto = this.ctx.crypto;
    if (sealed && crypto) {
      try {
        await crypto.unlockApp({ instanceId: inst.id, home: home.name }, masterKey.toString('hex'));
      } catch (e) {
        this.lockApp(inst.id);
        throw e;
      }
    }
    await this.backfillLoginKey(inst.id, masterKey, passphrase);
    this.ctx.log.info(sealed ? 'app unlocked for this boot (kernel key added)' : 'app unlocked for this boot (not sealed yet; Start seals it)', { instanceId: inst.id });
    return this.summaryOf(inst.id);
  }
  // Decision 143: change how an encrypted app opens without touching its data. `current` is its passphrase,
  // its own 12 words or the Harbor card; without it the machine wrapping is used (Harbor's own key, or a
  // passphrase equal to the Harbor password) while this machine's key is in memory. `next` null = Harbor's
  // own key (unlocks at login on this machine). Values never reach a plan, a log or a DTO.
  async changeAppPassphrase(instanceId: string, current: string | undefined, next: string | null): Promise<{ instance: InstanceSummary; recoveryKey: string | null }> {
    const inst = this.instanceRow(instanceId);
    const home = this.homeRow(inst.id);
    if (!home) throw new HarborError('INVALID_STATE', `${inst.name} is not encrypted`, { nextAction: `Encrypt it first: harbor seal ${inst.name}` });
    if (inst.activeOperationId) throw new HarborError('BUSY', `${inst.name} has an active operation`, { operationId: inst.activeOperationId });
    if (next !== null && (typeof next !== 'string' || next.length < 8)) throw new HarborError('INVALID_REQUEST', 'the new passphrase must be at least 8 characters');
    if (next !== null && next.length > 256) throw new HarborError('INVALID_REQUEST', 'the new passphrase must be at most 256 characters');
    const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
    let masterKey: Buffer | null = null;
    if (current) masterKey = await unlockAppHome(home.name, current);
    else if (wrapped) {
      const machineKey = this.ctx.machineKey.take();
      if (machineKey) {
        try {
          masterKey = unwrapMasterKeyForMachine(wrapped, machineKey);
        } finally {
          zeroMachineKey(machineKey);
        }
      }
    }
    if (!masterKey) throw new HarborError('INVALID_REQUEST', `type the current passphrase of ${inst.name} (or its 12 words, or your Harbor recovery key)`, { nextAction: wrapped ? 'Or log in again so this machine can open it by itself, then retry.' : 'Its passphrase is what you typed at install.' });
    try {
      const loginKey = next !== null && (await this.matchesAdminPassword(next));
      // Harbor's own key and a passphrase equal to the Harbor password open at login: those keep (or get) the machine wrapping.
      let machineWrapped: MachineWrappedKey | undefined;
      if (next === null || loginKey) {
        const machineKey = this.ctx.machineKey.take();
        if (!machineKey) throw new HarborError('MACHINE_KEY_LOCKED', 'Harbor restarted since your last login, so its key for encrypted apps is locked', { nextAction: 'Type your password to unlock this machine\'s key (the console asks; or run harbor account unlock), then retry.' });
        try {
          machineWrapped = wrapMasterKeyForMachine(masterKey, machineKey);
        } finally {
          zeroMachineKey(machineKey);
        }
      }
      const { recoveryKey } = await rewrapAppHome(home.name, masterKey, next);
      const meta: Record<string, unknown> = { ...(home.metadata ?? {}) };
      delete meta['machineWrapped'];
      delete meta['defaultKey'];
      delete meta['loginKey'];
      if (machineWrapped) meta['machineWrapped'] = machineWrapped;
      if (next === null) meta['defaultKey'] = true;
      if (loginKey) meta['loginKey'] = true;
      this.ctx.repo.upsertResource({ ...home, metadata: meta });
      this.ctx.repo.addEvent({ instanceId: inst.id, phase: 'encryption', message: next === null ? `${inst.name} now opens with Harbor's own key (unlocks when you log in)` : `${inst.name} has a new passphrase${loginKey ? ' (your Harbor password: it unlocks when you log in)' : ''}${recoveryKey ? '; its own 12 words were issued' : ''}` });
      this.ctx.log.info('app passphrase changed', { instanceId: inst.id, mode: next === null ? 'harbor-key' : loginKey ? 'login-password' : 'own-passphrase' });
      return { instance: this.summaryOf(inst.id), recoveryKey };
    } finally {
      zeroKey(masterKey);
    }
  }
  /** Lock one encrypted app: evict its key from the kernel (refused while it runs) and drop this boot's copy. */
  async lockAppApi(instanceId: string): Promise<InstanceSummary> {
    const inst = this.instanceRow(instanceId);
    const home = this.homeRow(inst.id);
    if (!home) throw new HarborError('INVALID_STATE', `${inst.name} has no encrypted home`, { nextAction: 'This app lives on the system disk; there is nothing to lock.' });
    if (inst.runtime === 'running' || inst.runtime === 'starting') {
      throw new HarborError('INVALID_STATE', `${inst.name} is running; its files are open`, { nextAction: 'Stop the app first, then lock it.' });
    }
    const sealed = home.metadata?.['kernelSealed'] === true;
    const crypto = this.ctx.crypto;
    if (sealed && crypto) await crypto.lockApp({ instanceId: inst.id, home: home.name });
    this.lockApp(inst.id);
    this.ctx.log.info('app locked', { instanceId: inst.id, sealed });
    return this.summaryOf(inst.id);
  }
  // Every login: (1) add the machine-wrapped key of every sealed home that
  // has one (data-folder apps, and drive apps sealed with the Harbor
  // password) to the kernel; (2) try the login password itself on locked
  // custom homes without a wrapping — when it opens the envelope, hold the
  // key, unlock the kernel and record the wrapping for next time. The
  // password is used for this call only and never stored. Failures are
  // logged and notified; the tile stays Locked and Start says why.
  async onLogin(password: string): Promise<void> {
    const crypto = this.ctx.crypto;
    if (!crypto) return;
    let instances: InstanceRow[];
    try {
      instances = this.ctx.repo.listInstances();
    } catch (e) {
      // Login raced a shutdown (tests close the daemon right after logging in).
      this.ctx.log.warn(`login-time app unlock skipped: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const inst of instances) {
      const home = this.homeRow(inst.id);
      if (!home) continue;
      const sealed = home.metadata?.['kernelSealed'] === true;
      const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
      const defaultKey = home.metadata?.['defaultKey'] === true;
      if (wrapped) {
        if (!sealed || crypto.kernelState(home.name) !== 'locked') continue;
        const machineKey = this.ctx.machineKey.take();
        if (!machineKey) return;
        let master: Buffer | null = null;
        try {
          master = unwrapMasterKeyForMachine(wrapped, machineKey);
          await crypto.unlockApp({ instanceId: inst.id, home: home.name }, master.toString('hex'));
          this.ctx.log.info('kernel-unlocked app home at login (machine key)', { instanceId: inst.id });
          this.ctx.notifier.resolve(`home-locked:${inst.id}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.ctx.log.warn(`could not unlock ${inst.name} at login: ${msg}`, { instanceId: inst.id });
          this.ctx.notifier.notify({ kind: 'home-locked', severity: 'warning', title: `${inst.displayName ?? inst.name} is still locked`, body: `${msg}${e instanceof HarborError ? ` ${e.nextAction}` : ''}`, instanceId: inst.id, dedupeKey: `home-locked:${inst.id}` });
        } finally {
          zeroMachineKey(machineKey);
          if (master) zeroKey(master);
        }
        continue;
      }
      if (defaultKey || this.unlockedApps.has(inst.id)) continue;
      // Custom home with no wrapping: does the login password open it?
      let master: Buffer;
      try {
        master = await unlockAppHome(home.name, password);
      } catch {
        continue; // a different passphrase: stays locked until the operator types it
      }
      try {
        if (sealed && crypto.kernelState(home.name) === 'locked') await crypto.unlockApp({ instanceId: inst.id, home: home.name }, master.toString('hex'));
        this.holdAppUnlock(inst.id, Buffer.from(master));
        await this.backfillLoginKey(inst.id, master, password);
        this.ctx.log.info('app home unlocked at login (passphrase is the Harbor password)', { instanceId: inst.id });
        this.ctx.notifier.resolve(`home-locked:${inst.id}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.ctx.log.warn(`could not unlock ${inst.name} at login: ${msg}`, { instanceId: inst.id });
      } finally {
        zeroKey(master);
      }
    }
  }
  // ---- the Harbor recovery key (one card per installation, decision 105)
  /** The installation's 12 words, or null while BFU or before one was issued. */
  installationRecoveryKey(): string | null {
    const stored = this.ctx.repo.setting<StoredInstallationRecovery>(INSTALLATION_RECOVERY_SETTING);
    if (!stored) return null;
    const machineKey = this.ctx.machineKey.take();
    if (!machineKey) return null;
    try {
      return openInstallationRecovery(stored, machineKey);
    } finally {
      zeroMachineKey(machineKey);
    }
  }
  // Issue the card if this installation has none yet (it predates decision
  // 105). Returns the words plus whether they were minted just now, so the
  // caller can show them once. Null when BFU: the caller then creates the
  // home without the envelope and the next install stamps one.
  ensureInstallationRecoveryKey(): { words: string; minted: boolean } | null {
    const existing = this.installationRecoveryKey();
    if (existing) return { words: existing, minted: false };
    if (this.ctx.repo.setting(INSTALLATION_RECOVERY_SETTING)) return null; // present but unreadable (BFU or damaged)
    const machineKey = this.ctx.machineKey.take();
    if (!machineKey) return null;
    try {
      const words = newInstallationRecoveryKey();
      this.ctx.repo.setSetting(INSTALLATION_RECOVERY_SETTING, sealInstallationRecovery(words, machineKey, this.ctx.clock.now()));
      this.ctx.log.info('issued the Harbor recovery key for this installation', {});
      return { words, minted: true };
    } finally {
      zeroMachineKey(machineKey);
    }
  }
  // Replace the card (lost or leaked paper): mint new words, re-stamp every
  // app home Harbor can reach right now, and name the ones it could not.
  // An unreachable home keeps opening with the OLD card, so the operator is
  // told rather than left with a silent gap.
  async rotateInstallationRecoveryKey(): Promise<{ recoveryKey: string; restamped: string[]; unreachable: string[] }> {
    const machineKey = this.ctx.machineKey.take();
    if (!machineKey) throw new HarborError('INVALID_STATE', 'Harbor cannot reach its own keys right now', { nextAction: 'Log in again, then replace the recovery key.' });
    const words = newInstallationRecoveryKey();
    const restamped: string[] = [];
    const unreachable: string[] = [];
    try {
      for (const inst of this.ctx.repo.listInstances()) {
        const home = this.homeRow(inst.id);
        if (!home) continue;
        const label = inst.displayName ?? inst.name;
        const wrapped = home.metadata?.['machineWrapped'] as MachineWrappedKey | undefined;
        // The master key has to come from somewhere without asking: this
        // boot's held key, or the machine wrapping. Otherwise the home is a
        // custom-passphrase app nobody unlocked this boot.
        let master: Buffer | null = this.takeAppUnlockCopy(inst.id);
        if (!master && wrapped) {
          try {
            master = unwrapMasterKeyForMachine(wrapped, machineKey);
          } catch {
            master = null;
          }
        }
        if (!master) {
          unreachable.push(label);
          continue;
        }
        try {
          await stampInstallationRecovery(home.name, master, words);
          restamped.push(label);
        } catch {
          unreachable.push(label);
        } finally {
          zeroKey(master);
        }
      }
      this.ctx.repo.setSetting(INSTALLATION_RECOVERY_SETTING, sealInstallationRecovery(words, machineKey, this.ctx.clock.now()));
    } finally {
      zeroMachineKey(machineKey);
    }
    this.ctx.log.info('replaced the Harbor recovery key', { restamped: restamped.length, unreachable: unreachable.length });
    return { recoveryKey: words, restamped, unreachable };
  }
  /** Protector name for one app (stable per instance; shown by `fscrypt status`). */
  protectorNameFor(inst: InstanceRow): string {
    return protectorFor(inst.name, inst.id);
  }
  /** Ref for the crypto provider. */
  homeRefOf(instanceId: string): AppHomeRef | null {
    const home = this.homeRow(instanceId);
    return home ? { instanceId, home: home.name } : null;
  }
  private summaryOf(instanceId: string): InstanceSummary {
    const fresh = this.ctx.repo.instance(instanceId)!;
    const meta = this.packageMeta(fresh);
    return instanceSummary(fresh, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(fresh.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(fresh, this.currentRevisionsSafe()), lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: this.usageCache.get(fresh.id) ?? null, needsDrive: this.needsDrive(fresh.id), home: this.homeState(fresh.id), ...this.extraLook(fresh, meta) });
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
  needsDrive(instanceId: string): InstanceSummary['needsDrive'] {
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
    const driveId = writeBindMarker(hostPath, inst.id, storageId, { required: true });
    this.ctx.repo.upsertResource({ instanceId: inst.id, kind: 'bind', role: bind.role, dockerId: bind.dockerId, name: hostPath, token: bind.token, metadata: { ...(bind.metadata ?? {}), storageId, driveId } });
    this.ctx.log.info('drive adopted', { instanceId, storageId, path: hostPath, actor });
    const meta = this.packageMeta(this.ctx.repo.instance(instanceId)!);
    const fresh = this.ctx.repo.instance(instanceId)!;
    return instanceSummary(fresh, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(fresh.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(fresh, this.currentRevisionsSafe()), lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: this.usageCache.get(fresh.id) ?? null, needsDrive: this.needsDrive(fresh.id), home: this.homeState(fresh.id), ...this.extraLook(fresh, meta) });
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
    const all = this.ctx.repo.exposures();
    return all.map((e) => exposureDto(e, names.get(e.instanceId)?.name ?? e.instanceId, names.get(e.instanceId)?.primaryExposure ?? 'loopback', names.get(e.instanceId)?.primaryHost ?? null, all.filter((x) => x.instanceId === e.instanceId)));
  }

  instanceRow(idOrName: string): InstanceRow {
    const row = this.ctx.repo.instance(idOrName) ?? this.ctx.repo.instanceByName(idOrName);
    if (!row) throw new HarborError('NOT_FOUND', `unknown instance ${idOrName}`);
    return row;
  }

  // Portable app homes found on mounted drives but not adopted here.
  // Scans every install candidate dir for manifest.json folders, one package
  // level down (decision 97: <candidate>/<packageId>/<instanceName>).
  // Adopted homes (an instance already points at the path) are flagged, not
  // hidden — the console needs them to tell "yours, locked" from "someone
  // else's".
  foundApps(): FoundAppDto[] {
    const out: FoundAppDto[] = [];
    const adoptedPaths = new Set(
      this.ctx.repo.listInstances().flatMap((i) => this.ctx.repo.resources(i.id).filter((r) => r.kind === 'volume' && r.role === '__home__').map((r) => r.name)),
    );
    for (const c of this.installCandidates()) {
      if (!c.eligible) continue;
      // One package level down: each immediate child of the candidate is a
      // package dir; homes live inside those.
      let packageDirs: string[];
      try {
        packageDirs = readdirSync(c.dir).filter((n) => {
          if (n.startsWith('.')) return false;
          try {
            return statSync(path.join(c.dir, n)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        continue; // candidate dir missing (drive yanked mid-scan): skip quietly
      }
      for (const pkgDir of packageDirs) {
        const pkgPath = path.join(c.dir, pkgDir);
        let entries: FoundAppDto[];
        try {
          entries = scanAppHomes(pkgPath).map((e) => {
            if (!e.descriptor) return { home: `${pkgPath}/${e.name}`, name: e.name, displayName: e.name, packageId: '', packageRevision: '', instanceId: '', drive: c.dir, adopted: false, error: e.error ?? 'unreadable app home' };
            const m = e.descriptor.manifest;
            const adopted = adoptedPaths.has(e.descriptor.home);
            const permissions = adopted ? null : this.adoptPermissions(m.packageId);
            return { home: e.descriptor.home, name: e.name, displayName: m.displayName, packageId: m.packageId, packageRevision: m.packageRevision, instanceId: m.instanceId, drive: c.dir, adopted, error: null, ...(permissions?.length ? { permissions } : {}) };
          });
        } catch {
          continue; // package dir missing mid-scan: skip quietly
        }
        out.push(...entries);
      }
    }
    return out.sort((a, b) => a.home.localeCompare(b.home));
  }

  // What adopting a found app asks the operator to accept (decision 163/179); null when its package is not here
  private adoptPermissions(packageId: string): PermissionDto[] | null {
    try {
      return permissionsOf(this.ctx.packages.load(packageId).manifest).map(permissionDto);
    } catch {
      return null;
    }
  }

  // Adopt a found app home onto this machine with its encryption passphrase
  // (or recovery key): verify once, then LEAVE LOCKED. The adopted instance
  // records the home with no machine wrapping, so it shows locked until the
  // operator Starts it with the passphrase — one by one, like every custom
  // app. Ports re-allocate locally; identity (UUID) travels in the manifest.
  async adoptApp(home: string, passphrase: string, opts: { name?: string; acceptPermissions?: boolean } | undefined, actor: string): Promise<InstanceSummary> {
    const { manifest } = describeAppHome(home);
    const masterKey = await unlockAppHome(home, passphrase);
    try {
      // decision 183: a row freed by an adopt cancelled before it ran is not "adopted here" (acceptPlan brings it back)
      const here = this.ctx.repo.instance(manifest.instanceId);
      if (here && !(here.purgedAt && !here.everInstalled)) throw new HarborError('NAME_CONFLICT', `this machine already has an instance for ${manifest.displayName}`, { nextAction: 'That app is already adopted here.' });
      const pkg = this.ctx.packages.load(manifest.packageId);
      // Decision 163/179: the person adopting accepts the package's permissions (gpu included) up front, before
      // anything touches the drive or this machine's records (adopt submits its own plan)
      const asked = permissionsOf(pkg.manifest);
      if (asked.length && opts?.acceptPermissions !== true) {
        throw new HarborError('PERMISSION_REQUIRED', `${manifest.displayName} asks for permissions you have not accepted: ${asked.map((p) => `${p.service} ${p.permission}`).join(', ')}`, { nextAction: 'Adopt it with them accepted (console: tick the box under Adopt; CLI: harbor adopt --accept-permissions).' });
      }
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
      const fixedPorts = await this.checkFixedPorts(pkg.manifest, null);
      const permissions = permissionsOf(pkg.manifest);
      const gpu = await this.planGpu(pkg.manifest);
      const storage = this.resolveStorage(pkg, identity, {}, instances);
      const now = this.ctx.clock.now();
      const expiresAt = rfc3339(addSeconds(now, this.ctx.config.planTtlSeconds));
      const proposal: PlanProposal = {
        packageId: pkg.id,
        revision: pkg.revision,
        name: proposed.name,
        project: identity.project,
        endpoints,
        ports: fixedPorts,
        permissions,
        ...(gpu ? { gpu } : {}),
        storage,
        // Nested layout: the home is <candidate>/<packageId>/<instanceName>;
        // the location dir is the package dir (strip one segment).
        location: { dir: home.replace(/\/[^/]+$/, '') },
        secrets: (pkg.manifest.secrets ?? []).map((s) => ({ id: s.id })),
        changes: [
          `Adopt ${manifest.displayName} (${pkg.id}) from ${home}`,
          `Verify the encryption passphrase once; the app stays locked until you Start it with the passphrase`,
          `Create Compose project ${identity.project} with a private bridge network`,
          ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
          ...this.fixedPortChanges(fixedPorts, permissions),
          ...(gpu ? gpuChanges(pkg.manifest, gpu) : []),
          ...storage.map((s) => `Use the drive's data at ${home}/volumes/${s.composeVolume} (${s.purpose})`),
          // decision 180: settings stay with the instance on its old machine, not on the drive
          ...(pkg.manifest.settings?.length ? ['Start its settings at the defaults (the values chosen on the other machine stay there); change them on the app page'] : []),
        ],
        warnings: ['Ports are allocated fresh on this machine; addresses differ from the previous one.'],
        releaseHashes: pkg.hashes,
      };
      await this.validateProspective(pkg, identity, endpoints);
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: this.ctx.ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt };
      this.ctx.repo.insertPlan(plan);
      // Adopt reuses the install operation path: the runner sees the home
      // resource marker (recorded by submit, with the instance it belongs to)
      // and roots volumes at the existing home instead of creating a fresh one.
      // The passphrase was verified above (unlock succeeded) and is NOT stored;
      // the key is held for THIS boot only so the install can unlock the kernel
      // seal and start the app — a reboot locks it again. No machine wrapping —
      // adopted apps unlock per-app with their own passphrase, never silently
      // (unless it is the Harbor login password: then the login opens it).
      const loginWrapped = await this.loginWrapping(masterKey, passphrase);
      if (loginWrapped) this.ctx.log.info('app home now unlocks with the Harbor login on this machine (passphrase matches)', { instanceId });
      const homeResource = { name: home, metadata: { home: true, driveId: manifest.driveId, adopted: true, ...(loginWrapped ? { machineWrapped: loginWrapped, loginKey: true } : {}) } };
      this.holdAppUnlock(instanceId, Buffer.from(masterKey));
      // The adopting Harbor stamps its own card: from now on THIS machine's
      // recovery key opens the app. The previous machine's card stops working
      // for it; the app's own passphrase and words are untouched.
      const card = this.ensureInstallationRecoveryKey();
      if (card) {
        try {
          await stampInstallationRecovery(home, masterKey, card.words);
        } catch (e) {
          this.ctx.log.warn(`could not stamp the Harbor recovery key onto ${home}: ${e instanceof Error ? e.message : String(e)}`, { instanceId });
        }
      }
      // Adopt plans carry no passphrase (the operator already proved it by
      // unlocking above); pre-seed the secret check so submit() passes.
      this.submitInstallLocationSecret(plan.id, 'adopted');
      try {
        this.submit(plan.id, this.ctx.ids.uuid(), actor, { acceptPermissions: opts?.acceptPermissions === true, adoptedHome: homeResource });
      } catch (e) {
        this.lockApp(instanceId); // no instance: drop the held key
        throw e;
      }
      if (displayName) this.ctx.repo.setInstanceAppearance(instanceId, { displayName });
      const fresh = this.ctx.repo.instance(instanceId)!;
      const meta = this.packageMeta(fresh);
      return instanceSummary(fresh, meta.name, meta.primaryEndpoint, [], { icon: meta.icon, category: meta.category, lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: null, needsDrive: null, home: this.homeState(instanceId), hiddenFromHome: this.extraLook(fresh, meta).hiddenFromHome, apiOnly: meta.apiOnly });
    } finally {
      zeroKey(masterKey);
    }
  }

  async instance(id: string): Promise<InstanceDetail> {
    const row = this.instanceRow(id);
    const meta = this.packageMeta(row);
    const summary = instanceSummary(row, meta.name, meta.primaryEndpoint, this.ctx.repo.exposures(row.id), { icon: meta.icon, category: meta.category, updateAvailable: this.updateFor(row, this.currentRevisionsSafe()), lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), usage: this.usageCache.get(row.id) ?? null, needsDrive: this.needsDrive(row.id), home: this.homeState(row.id), ...this.extraLook(row, meta) });
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
    const gpu = row.installState === 'retained' ? undefined : await this.instanceGpu(row);
    const setupEndpoint = meta.setup ? row.endpoints.find((e) => e.id === meta.setup!.endpoint) : undefined;
    return {
      ...summary,
      description: meta.description,
      defaultCredentials: meta.defaultCredentials,
      setup: meta.setup && setupEndpoint ? { endpointId: setupEndpoint.id, browserUrl: browserUrlFor(setupEndpoint.hostPort), instructions: meta.setup.instructions } : null,
      resources: resources.map((r, i) => ({ kind: r.kind, role: r.role, name: r.name, present: presence[i] ?? null })),
      events: this.ctx.repo.eventsForInstance(row.id, 50).map((e) => ({ cursor: String(e.cursor), at: e.at, phase: e.phase, message: e.message })),
      lastError: lastOp?.errorCode ? { code: lastOp.errorCode, message: lastOp.errorMessage ?? '', nextAction: lastOp.nextAction ?? '' } : null,
      ...(gpu ? { gpu } : {}),
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
    return planDto(p, storageStates, secretStates, { lanHost: this.lanPlainHost(), lanSecureHost: this.lanSecureHost(), onDrive: p.proposal.location ? !this.isDataFolderLocation(p.proposal.location.dir) : false });
  }

  operation(id: string): OperationDto {
    const o = this.ctx.repo.operation(id);
    if (!o) throw new HarborError('NOT_FOUND', `unknown operation ${id}`);
    const dto = operationDto(o, this.ctx.repo.eventsForOperation(id, 200), this.operationName(o));
    const once = this.oneTimeResult(id);
    return once && dto.result ? { ...dto, result: { ...dto.result, ...once } } : dto;
  }

  // The app's name as an operation shows it (decision 183): a cancelled install's freed row still names its app.
  private operationName(o: OperationRow): string {
    const inst = this.ctx.repo.instance(o.instanceId);
    const planned = o.planId ? this.ctx.repo.plan(o.planId)?.proposal.name : undefined;
    return operationInstanceName(inst, planned ?? o.instanceId);
  }

  // GET /v1/operations (decision 183): the queue in run order and the newest finished items (events left out).
  queue(recent = 10): OperationQueueDto {
    const q = this.ctx.repo.listQueue(Math.max(0, Math.min(50, recent)));
    const dto = (o: OperationRow) => operationDto(o, [], this.operationName(o));
    return { active: q.active.map(dto), recent: q.recent.map(dto) };
  }

  // Decision 183: queue an action of a queueable kind for an existing app, busy or not, without a plan. Harbor plans
  // it when its turn comes (OperationRunner → planQueuedAction). Idempotent like submit: same key, same request → same operation.
  queueAction(instanceId: string, kind: string, actor: string, idempotencyKey: string): SubmitResult {
    const { repo, ids } = this.ctx;
    if (!(QUEUEABLE_KINDS as readonly string[]).includes(kind)) throw new HarborError('INVALID_REQUEST', `${kind} cannot be queued without a review`, { nextAction: `Queueable actions: ${QUEUEABLE_KINDS.join(', ')}. Make a plan for anything else.` });
    const k = kind as QueueableKind;
    const result = repo.transaction((): SubmitResult => {
      const existing = repo.operationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.actor === actor && existing.request?.kind === k && existing.request.instanceId === instanceId) return { operation: existing, created: false };
        throw new HarborError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request', { operationId: existing.id });
      }
      // a key that an earlier request resolved to an existing item (the dedupe below) stays that item
      const alias = this.queueKeyAliases.get(idempotencyKey);
      if (alias) {
        const aliased = repo.operation(alias.operationId);
        if (aliased && alias.actor === actor && alias.kind === k && alias.instanceId === instanceId) return { operation: aliased, created: false };
        throw new HarborError('IDEMPOTENCY_CONFLICT', 'this idempotency key was already used for a different request', { operationId: alias.operationId });
      }
      const inst = repo.instance(instanceId);
      if (!inst || inst.purgedAt) throw new HarborError('NOT_FOUND', `unknown instance ${instanceId}`);
      const label = inst.displayName ?? inst.name;
      // The same action as the app's last item (a second click, another tab) is that item, not a duplicate that would
      // only fail at its turn ("already runs revision N"). Only a true duplicate: the app's LAST not-final item, of the
      // same kind, not Harbor's own (a guard's stop leaves desired running; a person's stop must flip it), and still
      // waiting, except that an update already running counts too (a second one could only fail).
      const same = sameQueuedAction(repo.activeOperationsOf(inst.id), k);
      if (same) {
        this.rememberQueueKey(idempotencyKey, { operationId: same.id, actor, kind: k, instanceId: inst.id });
        return { operation: same, created: false };
      }
      if (repo.activeOperationsOf(inst.id).some((o) => o.kind === 'purge')) throw new HarborError('INVALID_STATE', `${label} is being removed completely`, { nextAction: 'Wait for it to finish; there is nothing left to act on afterwards.' });
      const operationId = ids.uuid();
      repo.insertQueuedAction({ id: operationId, idempotencyKey, actor, kind: k, instanceId: inst.id });
      repo.syncActiveOperation(inst.id);
      repo.addEvent({ operationId, instanceId: inst.id, phase: 'queued', message: `${k} queued for ${label}; planned when its turn comes` });
      return { operation: repo.operation(operationId)!, created: true };
    });
    if (result.created) this.wake();
    return result;
  }

  // Decision 183: the runner plans a queued action at its turn, against the app as it is then, and accepts it the
  // way submit does with no typed values and no permissions accepted. Throws when it cannot be accepted; nothing is
  // changed then (the plan made here is recorded on the operation and consumed, so it never shows as an open plan).
  async planQueuedAction(op: OperationRow): Promise<OperationRow> {
    const { repo } = this.ctx;
    const req = op.request;
    if (!req) throw new HarborError('STATE_CHANGED', 'this queued item has no action to plan');
    const target = repo.instance(req.instanceId);
    if (!target || target.purgedAt) throw new HarborError('NOT_FOUND', 'the app was removed completely before this item\'s turn', { nextAction: 'Nothing to do: the app is gone.' });
    const dto = await this.createPlan({ kind: req.kind, instanceId: req.instanceId } as PlanRequest, op.actor, { forOperation: op.id });
    const plan = repo.plan(dto.id)!;
    const record = () =>
      repo.transaction(() => {
        repo.attachPlan(op.id, plan.id);
        repo.consumePlan(plan.id, op.id);
      });
    try {
      const required = ((plan.proposal.secrets ?? []) as PlannedSecret[]).filter((s) => s.ask === 'required');
      if (required.length) throw new HarborError('REVIEW_NEEDED', `it needs a value only you can give: ${required.map((s) => s.prompt ?? s.id).join(', ')}`);
      repo.transaction(() => {
        const cur = repo.operation(op.id);
        if (!cur || cur.state !== 'queued' || cur.planId !== null) throw new HarborError('STATE_CHANGED', 'this queued item changed while it was planned');
        this.acceptPlan(plan, op.id, {}, op.id);
        repo.attachPlan(op.id, plan.id);
        repo.consumePlan(plan.id, op.id);
        repo.addEvent({ operationId: op.id, instanceId: op.instanceId, phase: 'queued', message: `${op.kind} planned at its turn for ${plan.proposal.name}: ${plan.proposal.changes.join('; ')}` });
      });
    } catch (e) {
      record();
      throw e;
    }
    return repo.operation(op.id)!;
  }

  // Decision 183: cancel a waiting item (never one that started: a running step cannot be stopped safely).
  // Nothing was done for it, so nothing is undone; what accepting reserved is released.
  private cancelListeners: ((instanceId: string) => void)[] = [];
  // Background actors with one-attempt memories (observer guards) forget them for an app whose item was cancelled.
  onOperationCancelled(fn: (instanceId: string) => void): void {
    this.cancelListeners.push(fn);
  }
  cancelOperation(id: string, actor: string): OperationDto {
    const op = this.ctx.repo.operation(id);
    if (!op) throw new HarborError('NOT_FOUND', `unknown operation ${id}`);
    const what = `${op.kind} of ${this.operationName(op)}`;
    if (FINAL_OPERATION_STATES.includes(op.state as FinalOperationState)) throw new HarborError('NOT_CANCELLABLE', `the ${what} has finished`, { nextAction: 'Nothing to cancel.' });
    const protectedWhy = protectedReason(op.actor);
    if (protectedWhy) throw new HarborError('NOT_CANCELLABLE', `the ${what} cannot be cancelled: ${protectedWhy}`, { nextAction: 'Let it run; it was queued to protect the app.' });
    const running = () => new HarborError('NOT_CANCELLABLE', `the ${what} is already running; a running step cannot be stopped safely`, { nextAction: 'Let it finish; harbor queue shows its progress.' });
    if (op.state !== 'queued' || op.startedAt !== null) throw running();
    const done = this.cancelNeverRun(op, { message: 'Cancelled by you before it started; nothing was changed.', nextAction: '', event: `${op.kind} cancelled by ${actor} before it started; nothing was changed` });
    if (!done) throw running();
    return this.operation(id);
  }

  // Decision 183: end an item that never ran as cancelled and give back what accepting it reserved. The one path for a
  // person's cancel, a restart (OperationRunner.recoverOnStartup, `picked`: also an item the runner had picked but that
  // never reached its first step) and a shutdown that caught a picked item before its first step (`picked` too).
  // Released: a queued install's row, name and ports (as a stale plan does; its waiting follow-ups are cancelled),
  // fixed ports a non-install claimed that the app's current release does not publish, the in-memory handovers (typed
  // values, settings, passphrases, an adopt's held key), the app's active operation; background actors' one-attempt
  // memories for that app are reset. No generation bump: nothing changed. False when it was not cancellable any more.
  cancelNeverRun(op: OperationRow, why: { message: string; nextAction: string; event: string; picked?: boolean; wake?: boolean }): boolean {
    const { repo } = this.ctx;
    const plans: string[] = [];
    const done = repo.transaction(() => {
      if (!repo.cancelOperation(op.id, { message: why.message, nextAction: why.nextAction }, why.picked === true)) return false;
      repo.addEvent({ operationId: op.id, instanceId: op.instanceId, phase: 'cancelled', message: why.event });
      const planId = repo.operation(op.id)?.planId ?? null; // a queued action may have been planned since `op` was read
      if (planId) plans.push(planId);
      const inst = repo.instance(op.instanceId);
      if (!inst) return true;
      const plan = planId ? repo.plan(planId) : null;
      if (op.kind === 'install' && inst.installState === 'installing' && !inst.purgedAt && repo.resources(inst.id).filter((r) => r.role !== '__home__').length === 0) {
        // a queued install created nothing: free its row, name and ports (as a stale plan does) and its waiting follow-ups
        for (const f of repo.activeOperationsOf(inst.id)) {
          if (f.id === op.id || f.startedAt !== null) continue;
          if (repo.cancelOperation(f.id, { message: `Cancelled with the install of ${inst.name} it was waiting for; nothing was changed.`, nextAction: '' })) {
            repo.addEvent({ operationId: f.id, instanceId: inst.id, phase: 'cancelled', message: `${f.kind} cancelled: the install it waited for was cancelled` });
            if (f.planId) plans.push(f.planId);
          }
        }
        repo.updateInstance(inst.id, { lastOperationId: op.id });
        repo.purgeInstance(inst.id, `${inst.name}~cancelled~${inst.id.slice(0, 8)}`);
        return true;
      }
      if (plan && plan.kind !== 'install') this.releaseClaimedPorts(plan, inst);
      repo.syncActiveOperation(inst.id);
      return true;
    });
    if (!done) return false;
    for (const planId of plans) this.dropHandovers(planId);
    if (op.kind === 'install') this.lockApp(op.instanceId); // an adopt's held key
    for (const fn of this.cancelListeners) {
      try {
        fn(op.instanceId);
      } catch (e) {
        this.ctx.log.warn(`a cancel listener failed: ${(e as Error).message}`);
      }
    }
    if (why.wake !== false) this.wake();
    return true;
  }

  // Fixed ports a reviewed non-install plan claimed at accept (decision 163) that the app's current release does not
  // publish go back when its item ends without running (inside the caller's transaction).
  releaseClaimedPorts(plan: PlanRow, inst: InstanceRow): void {
    if (!plan.proposal.ports?.length) return;
    let current: Set<number>;
    try {
      current = new Set(fixedPortsOf(loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId).manifest).map((p) => p.hostPort));
    } catch {
      current = new Set(plan.proposal.ports.map((p) => p.hostPort)); // no readable release: keep every claim
    }
    for (const p of plan.proposal.ports) if (!current.has(p.hostPort)) this.ctx.repo.releasePort(p.hostPort, inst.id);
  }

  // Every in-memory value handed over with a submission, by plan id (decision 183: a cancelled item drops them).
  private dropHandovers(planId: string): void {
    this.operatorValues.delete(planId);
    this.submittedSettings.delete(planId);
    this.locationSecrets.delete(planId);
  }

  // Recovery words an operation minted (decision 165): never written to the operations table (a copy of
  // harbor.db would otherwise open every sealed app without the password). Held in memory for a day so the
  // tray and the CLI can show them; a daemon restart loses them (the card can be replaced in Settings).
  private oneTime = new Map<string, { values: Record<string, unknown>; until: number }>();
  keepOneTimeResult(operationId: string, values: Record<string, unknown>): void {
    const now = this.ctx.clock.now().getTime();
    for (const [k, v] of this.oneTime) if (v.until <= now) this.oneTime.delete(k);
    if (Object.keys(values).length) this.oneTime.set(operationId, { values, until: now + ONE_TIME_TTL_MS });
  }
  private oneTimeResult(operationId: string): Record<string, unknown> | null {
    const v = this.oneTime.get(operationId);
    if (!v) return null;
    if (v.until <= this.ctx.clock.now().getTime()) {
      this.oneTime.delete(operationId);
      return null;
    }
    return v.values;
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

  // opts.forOperation (decision 183): the runner plans a queued action at its turn; that operation is the app's active one.
  async createPlan(req: PlanRequest, actor: string, opts: { forOperation?: string } = {}): Promise<PlanDto> {
    const { repo, clock, ids, config } = this.ctx;
    const now = clock.now();
    const expiresAt = rfc3339(addSeconds(now, config.planTtlSeconds));
    if (req.kind === 'install') {
      const pkg = this.ctx.packages.load(req.packageId);
      const instances = repo.listInstances();
      const taken = new Set(instances.map((i) => i.name));
      const copies = instances.filter((i) => i.packageId === pkg.id);
      if (!pkg.manifest.deployment.multiInstance && copies.length) {
        throw new HarborError('NAME_CONFLICT', `${pkg.id} does not support multiple instances`, { nextAction: oneCopyNextAction(copies, 'install') });
      }
      const proposed = proposeName(pkg.id, taken, req.name);
      if (proposed.error) throw new HarborError(req.name && taken.has(req.name) ? 'NAME_CONFLICT' : 'INVALID_REQUEST', proposed.error);
      const instanceId = ids.uuid();
      const identity = identityFor(this.ctx.installationId, instanceId);
      const endpoints = await this.allocatePorts(pkg);
      const fixedPorts = await this.checkFixedPorts(pkg.manifest, null);
      const permissions = permissionsOf(pkg.manifest);
      const gpu = await this.planGpu(pkg.manifest);
      // Install location (whole encrypted app on a drive): validated here so a
      // bad dir or weak passphrase never reaches Docker. The passphrase itself
      // is never stored in the plan — only the dir. The runner collects it at
      // apply time from the submitter (see submitInstallLocationSecret).
      // Default-encrypt (decision 94): the Harbor data folder (system disk,
      // not portable) encrypts with Harbor's own key — no passphrase needed,
      // silent unlock, nothing to remember. Removable drives are portable, so
      // A per-app passphrase is ALWAYS optional, on the data folder and on a
      // drive alike (decision 106). Every sealed home is already opened by the
      // Harbor recovery key, so portability never depended on the operator
      // inventing a second secret. Without one the home takes the same shape
      // as a data-folder home: a Harbor-generated secret nobody ever types,
      // the machine wrapping for silent unlock here, and the Harbor card for
      // anywhere else. A passphrase is what you choose when you want to open
      // ONE app on a machine that does not hold this Harbor's card, or to hand
      // a single app over along with its drive.
      let location: PlanProposal['location'] = null;
      if (req.location) {
        const dir = this.resolveInstallLocation(req.location.dir, instances, pkg.id);
        const pass = req.location.passphrase;
        if (pass === undefined || pass === '') {
          // Decision 120: a default-key home must get this machine's wrapping or it would open only with
          // the recovery key after its next lock. The key is in memory only after a password login since
          // the daemon started; a remembered session after a restart/self-update does not unseal it.
          if (!this.ctx.machineKey.unlocked) throw new HarborError('MACHINE_KEY_LOCKED', 'Harbor restarted since your last login, so its key for encrypted apps is locked', { nextAction: 'Type your password to unlock this machine\'s key (the console asks; or run harbor account unlock), then install again.' });
          location = { dir, defaultKey: true };
        } else {
          if (typeof pass !== 'string' || pass.length < 8) throw new HarborError('INVALID_REQUEST', 'the app encryption passphrase must be at least 8 characters', { nextAction: 'Choose a passphrase (or a generated recovery key) of 8+ characters, or install without one and rely on your Harbor recovery key.' });
          if (pass.length > 256) throw new HarborError('INVALID_REQUEST', 'the app encryption passphrase must be at most 256 characters');
          location = { dir };
        }
      }
      const locationOnDrive = location !== null && !this.isDataFolderLocation(location.dir);
      const storage = this.resolveStorage(pkg, identity, req.storage ?? {}, instances);
      const links = this.resolveLinks(pkg.manifest, identity, req.links ?? {}, { selfId: null });
      // Main address (decision 116): apps that need a secure browser context get an HTTPS one in LAN
      // mode — HTTPS LAN, the tailnet or a domain. Refused here, before anything is pulled.
      const mainEndpoint = endpoints.find((e) => e.id === pkg.manifest.ui.primaryEndpoint) ?? endpoints[0]!;
      const mainWarnings: string[] = [];
      let mainExposure: PlanProposal['exposure'];
      if (req.main) {
        const t = await this.exposureTarget(req.main.via, mainEndpoint, pkg, pkg.manifest.metadata.name, req.main.via === 'public' ? { hostname: req.main.hostname } : {}, mainWarnings, endpoints.map((e) => e.hostPort));
        if (repo.exposureByAddress(req.main.via, t.hostname, t.port)) throw new HarborError('NAME_CONFLICT', `${exposureUrl({ via: req.main.via, hostname: t.hostname, port: t.port })} is already used by another app`);
        mainExposure = { endpointId: mainEndpoint.id, via: req.main.via, hostname: t.hostname, port: t.port, protection: t.protection, makePrimary: true };
      } else if (requiresHttps(pkg) && this.ctx.config.lan.enabled && !this.httpsEnabled()) {
        throw new HarborError('INVALID_STATE', `${pkg.manifest.metadata.name} needs HTTPS: browsers block what it needs on a plain http:// address`, { nextAction: 'Turn on secure addresses in Settings → Network, or install it with Tailscale or one of your domains as its main address.' });
      }
      // decision 186: Also on Tailscale; a tailnet main address already is one
      const alsoTailnet = mainExposure?.via === 'tailnet' ? undefined : req.tailnet;
      const tailnet = await this.tailnetAll.installNote(alsoTailnet);
      const internetPlan = plannedInstallInternet(pkg.manifest, proposed.name, req.internet, this.internetContext());
      const proposal: PlanProposal = {
        packageId: pkg.id,
        revision: pkg.revision,
        name: proposed.name,
        project: identity.project,
        endpoints,
        ports: fixedPorts,
        permissions,
        ...(gpu ? { gpu } : {}),
        storage,
        location,
        secrets: plannedSecrets(pkg.manifest),
        links,
        ...(pkg.manifest.settings?.length ? { settings: plannedInstallSettings(pkg.manifest) } : {}),
        internet: internetPlan.internet,
        ...(alsoTailnet !== undefined ? { tailnet: alsoTailnet } : {}),
        changes: [
          `Install ${pkg.manifest.metadata.name} (${pkg.id} revision ${pkg.revision}) as instance "${proposed.name}"`,
          `Create Compose project ${identity.project} with a private bridge network`,
          ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
          ...this.fixedPortChanges(fixedPorts, permissions),
          ...(gpu ? gpuChanges(pkg.manifest, gpu) : []),
          ...(location
            ? [
                location.defaultKey
                  ? `Install the whole app sealed at ${location.dir}/ (manifest.json + vault/ + volumes/); this machine unlocks it when you log in, and your Harbor recovery key opens it on any other machine`
                  : `Install the whole app sealed at ${location.dir}/ (manifest.json + vault/ + volumes/); its own passphrase opens it on any Harbor machine, and your Harbor recovery key does too`,
              ]
            : []),
          ...storage.map((s) => (s.hostPath ? `Use your folder ${s.hostPath} for ${s.purpose}${s.readOnly ? ' (read-only)' : ''}; Harbor never deletes it` : `Create retained volume ${s.volumeName} (${s.purpose})`)),
          ...(pkg.manifest.secrets ?? []).map((s) => (s.source === 'operator' ? `Store the value you provide for ${s.id} (${s.prompt ?? s.id}) as a retained secret${s.optional ? ' (optional)' : ''}` : `Generate retained secret ${s.id} (${s.bytes ?? 32} bytes)`)),
          ...this.linkChanges(links, pkg.manifest.metadata.name),
          ...installSettingChanges(pkg.manifest),
          ...internetPlan.changes,
          ...(mainExposure ? [`Publish it at ${exposureUrl(mainExposure)} and make that its main address`] : []),
          ...Object.values(pkg.release.images).map((i) => `Pull image ${i.reference} (${i.tag})`),
          ...Object.entries(pkg.release.builds ?? {}).map(([svc, b]) => `Build ${svc} from source at commit ${b.commit.slice(0, 12)} (${b.tag})`),
        ],
        warnings: [
          ...mainWarnings,
          ...internetPlan.warnings,
          ...(Object.keys(pkg.release.builds ?? {}).length ? ['Parts of this app are built from source on this machine; their provenance is the git commit, not a registry digest.'] : []),
          ...(pkg.release.qualification.status !== 'passed' ? [pkg.origin === 'local' ? 'This is your own uploaded app; Harbor has not checked it on a real machine the way it checks the built-in catalog.' : `Package qualification is ${pkg.release.qualification.status}`] : []),
          ...(pkg.manifest.defaultCredentials ? [`This app ships with a default login (${pkg.manifest.defaultCredentials.username}); change it right after the first sign-in.`] : []),
          // a passphrase of its own is the one way the data can be lost for good: that stays a warning
          ...(location && !location.defaultKey ? ['Lose both its passphrase and your Harbor recovery key and the data is gone.'] : []),
          ...(location ? [] : [NOT_ENCRYPTED_WARNING]),
          // decision 177: the policy publishes it as soon as it answers, before anyone has created its account
          ...(tailnet.publishes && mainExposure?.via !== 'tailnet' && (pkg.manifest.setup || pkg.manifest.defaultCredentials) ? [`${alsoTailnet ? 'Also on Tailscale' : 'Every app on Tailscale is on'}: ${pkg.manifest.metadata.name}'s ${pkg.manifest.setup ? 'first-run page (the first visitor creates the account)' : 'default login'} is reachable from every device on your tailnet once it runs. ${pkg.manifest.setup ? 'Create its account' : 'Change that login'} right after install, or switch its On Tailscale off in its drawer while it installs.`] : []),
        ],
        // decision 157: the plain facts (how it opens, what happens next) read as notes, not amber warnings
        notes: [
          // decision 170: a second copy says so first, in the install page's words
          ...[copyNote(pkg.manifest.metadata.name, proposed.name, { active: copies.filter((i) => i.installState !== 'retained').length, removed: copies.filter((i) => i.installState === 'retained').length })].filter((n): n is string => n !== null),
          ...(location
            ? [
                location.defaultKey ? 'Encrypted — unlocks automatically when you sign in. Your Harbor recovery key opens it on another machine.' : 'Encrypted with its own passphrase, which also opens it on another Harbor machine.',
                ...(locationOnDrive ? ['Unplug the drive and the app pauses until it is back.'] : []),
              ]
            : []),
          ...(pkg.manifest.setup ? [`After install you'll create your ${pkg.manifest.metadata.name} account; Harbor does not create it.`] : []),
          // decision 177: the every-app Tailscale policy publishes it after it starts (through its own plan)
          ...(mainExposure?.via === 'tailnet' ? [] : [tailnet.note].filter((n): n is string => n !== null)),
        ],
        releaseHashes: pkg.hashes,
        ...(mainExposure ? { exposure: mainExposure } : {}),
      };
      await this.validateProspective(pkg, identity, endpoints);
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }

    const inst = this.instanceRow(req.instanceId);
    if (inst.activeOperationId && inst.activeOperationId !== opts.forOperation) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
    const pkgName = this.packageMeta(inst).name;
    if (req.kind === 'expose' || req.kind === 'unexpose' || req.kind === 'reconfigure') return this.exposurePlan(req, inst, pkgName, actor, now, expiresAt);
    if (req.kind === 'seal') return this.sealPlan(inst, pkgName, actor, now, expiresAt);
    if (req.kind === 'relink') return this.relinkPlan(inst, pkgName, actor, now, expiresAt);
    if (req.kind === 'move') return this.movePlan(inst, req.location.dir, pkgName, actor, now, expiresAt);
    if (req.kind === 'backup') return this.backupPlan(inst, req.runId, pkgName, actor, now, expiresAt);
    if (req.kind === 'restore') return this.restorePlan(inst, req.runId, req.targetId, pkgName, actor, now, expiresAt);
    if (req.kind === 'update') return this.updatePlan(req, inst, pkgName, actor, now, expiresAt);
    if (req.kind === 'configure') return this.configurePlan(req, inst, pkgName, actor, now, expiresAt);
    const changes: string[] = [];
    switch (req.kind) {
      case 'start': {
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action') throw new HarborError('INVALID_STATE', `cannot start an instance in state ${inst.installState}`);
        if (inst.runtime === 'running' && inst.desired === 'running') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already running`);
        // Refuse at plan time (not only at apply): starting against a missing
        // or swapped drive must never reach Docker.
        const need = this.needsDrive(inst.id);
        if (need) throw new HarborError('DATA_MISSING', `${inst.name} needs its drive: ${need.path} (${need.purpose}) is not the folder it was using (${need.detail})`, { nextAction: 'Re-insert the drive (or restore the folder with its marker) at the same path, or adopt the new folder from the app drawer.' });
        // Custom-passphrase apps stay locked until the operator unlocks them
        // per-app (Start carries the passphrase, or unlock first). Refuse a
        // locked start here so the drawer can prompt instead of failing deep
        // in the runner.
        this.refuseUnreachableHome(inst, 'Start');
        changes.push(`Verify release, retained volumes and secrets of "${inst.name}"`, `Start existing containers of project ${inst.project}`, 'Check readiness');
        break;
      }
      case 'restart': {
        // Decision 116: re-render with today's addresses (LAN HTTPS, rename) and recreate, then the hook.
        // Decision 135: Restart is also the repair of an app left in needs_action/failed by an operation
        // that could not finish (e.g. an update whose rollback failed): re-render, recreate, check readiness.
        const repair = (inst.installState === 'needs_action' || inst.installState === 'failed') && inst.everInstalled;
        if (inst.installState !== 'installed' && !repair) throw new HarborError('INVALID_STATE', `cannot restart an instance in state ${inst.installState}`);
        if (!repair && inst.runtime !== 'running') throw new HarborError('INVALID_STATE', `${inst.name} is not running`, { nextAction: 'Start it instead.' });
        const need = this.needsDrive(inst.id);
        if (repair && need) throw new HarborError('DATA_MISSING', `${inst.name} needs its drive: ${need.path} (${need.purpose}) is not the folder it was using (${need.detail})`, { nextAction: 'Re-insert the drive first.' });
        if (repair) this.refuseUnreachableHome(inst, 'Repair');
        const pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId);
        if (repair) changes.push(`Repair "${inst.name}": it is ${inst.installState.replace('_', ' ')} after its last operation; run revision ${inst.revision} again from its stored release`);
        changes.push(
          `Re-render the private Compose file of "${inst.name}" with its current addresses`,
          `Recreate the containers of project ${inst.project} (same volumes, secrets and ports)`,
          'Check readiness',
          ...(pkg.manifest.hooks?.afterStart ? [`Run ${pkgName}'s after-start step so it accepts every current address`] : []),
        );
        break;
      }
      case 'stop':
        if (inst.installState !== 'installed' && inst.installState !== 'needs_action' && inst.installState !== 'failed') throw new HarborError('INVALID_STATE', `cannot stop an instance in state ${inst.installState}`);
        changes.push(`Stop the recorded containers of "${inst.name}" (project ${inst.project})`, 'Keep volumes, secrets and port allocations');
        break;
      case 'remove':
        if (inst.installState === 'retained') throw new HarborError('INVALID_STATE', `instance ${inst.name} is already removed (retained)`);
        changes.push(
          `Stop and delete the recorded containers of "${inst.name}"`,
          `Delete the private network ${inst.project}_default if unused`,
          ...this.ctx.repo.exposures(inst.id).map((e) => `Withdraw ${exposureUrl(e)} for now (${e.via === 'proxy' ? 'your proxy keeps its own entry' : e.via === 'public' ? 'Caddy route' : 'tailscale serve entry'}); Reinstall publishes it again`),
          ...this.linkRemovalNotes(inst).changes,
          'Retain volumes, secrets, settings, name and port allocations',
        );
        break;
      case 'purge':
        if (inst.installState === 'installing') throw new HarborError('INVALID_STATE', `cannot uninstall ${inst.name} while it is installing`);
        changes.push(
          ...(inst.installState !== 'retained' ? [`Stop and delete the containers of "${inst.name}" and its private network`] : []),
          ...this.linkRemovalNotes(inst).changes,
          `Delete the data volume(s) Harbor created for "${inst.name}" (ownership verified first)`,
          'Delete its secrets, settings and stored release',
          `Free the name "${inst.name}" and its ports`,
        );
        break;
      case 'reinstall':
        if (inst.installState !== 'retained') throw new HarborError('INVALID_STATE', `reinstall requires a removed (retained) instance; ${inst.name} is ${inst.installState}`);
        if (!inst.everInstalled) throw new HarborError('INVALID_STATE', `instance ${inst.name} never completed an installation; manual investigation is required`, { nextAction: 'Inspect the instance and its resources manually. Automatic reinstall only applies to previously successful instances.' });
        this.refuseUnreachableHome(inst, 'reinstall');
        changes.push(`Reinstall ${pkgName} revision ${inst.revision} into "${inst.name}" using its stored release`, 'Verify retained volumes (ownership tokens) and secrets before starting', ...(retainedExposures(this.ctx.repo, inst.id)?.items ?? []).map((x) => `Publish ${exposureUrl(x)} again${x.via === 'tailnet' ? ' (on a fresh tailnet port)' : ''}`), `Recreate containers and network for project ${inst.project}`, ...this.ctx.repo.linksOfConsumer(inst.id).filter((l) => l.state === 'dormant').map((l) => `Re-create link ${l.linkId} (network ${l.networkName}) if its provider is still installed`), 'Check readiness');
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
          ? ['Data volumes and secrets are retained; nothing is deleted except containers and the private network.', ...this.linkRemovalNotes(inst).warnings]
          : req.kind === 'purge'
            ? [`This deletes the app's data for good: ${resources.filter((r) => r.kind === 'volume').map((r) => r.name).join(', ') || 'no managed volumes'}. There is no undo.`, ...(resources.some((r) => r.kind === 'bind') ? [`Your own folder(s) are not touched: ${resources.filter((r) => r.kind === 'bind').map((r) => r.name).join(', ')}.`] : []), ...this.linkRemovalNotes(inst).warnings]
            : [],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: req.kind, instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Update: same instance (name, ports, volumes, secrets, addresses), new release. New claims get new
  // volumes/secrets/ports; removed claims keep their data (never deleted); images change to the new digests.
  // A locked encrypted app (kernel-locked, or never unlocked this boot) can only be touched when the runner can
  // reach a key: this boot's held key, or the machine wrapping while AFU. Otherwise refuse at plan time, so the
  // console prompts and a queued action waits for a person (decision 183) instead of failing deep in the runner.
  private refuseUnreachableHome(inst: InstanceRow, verb: string): void {
    const hs = this.homeState(inst.id);
    if (hs?.state !== 'locked') return;
    if (this.unlockedApps.has(inst.id) || (hs.silentUnlock && this.ctx.machineKey.unlocked)) return;
    throw personCanResolve(new HarborError('INVALID_STATE', `${inst.name} is locked`, {
      nextAction: hs.defaultKey ? `Log in again to unlock apps on this machine, then ${verb} again.` : hs.silentUnlock ? `Log in again (it unlocks with your Harbor password), or unlock it with its passphrase, then ${verb} again.` : `Unlock it with its encryption passphrase (or recovery key), then ${verb} again.`,
    }));
  }

  private async updatePlan(req: Extract<PlanRequest, { kind: 'update' }>, inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): Promise<PlanDto> {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `update requires an installed app; ${inst.name} is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? 'Reinstall it first, then update.' : 'Fix the app first (Details shows the last error).' });
    // decision 190: an update deletes the containers first, so a locked app must never get that far
    this.refuseUnreachableHome(inst, 'update');
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
    const fixedPorts = await this.checkFixedPorts(next.manifest, inst.id);
    const heldPorts = new Set(fixedPortsOf(current.manifest).map((p) => p.hostPort));
    const addedPermissions = newPermissions(current.manifest, next.manifest);
    const gpu = await this.planGpu(next.manifest);
    // kept: every secret the instance has, plus optional operator secrets the current release already declared (left empty on purpose)
    const keptSecrets = new Set([...inst.secrets.map((r) => r.id), ...(current.manifest.secrets ?? []).map((s) => s.id)]);
    const newSecrets = (next.manifest.secrets ?? []).filter((s) => !keptSecrets.has(s.id)).map((s) => s.id);
    // Decision 126: kept links keep their provider; links the new release adds are resolved like an install.
    const existingLinks = repo.linksOfConsumer(inst.id);
    const links = this.resolveLinks(next.manifest, identity, req.links ?? {}, { selfId: inst.id, existing: existingLinks });
    const droppedLinks = existingLinks.filter((l) => !(next.manifest.links ?? []).some((c) => c.id === l.linkId));
    const images = [
      ...Object.keys(next.release.images).map((svc) => ({ service: svc, from: current.release.images[svc]?.reference ?? '(new service)', to: next.release.images[svc]!.reference })),
      ...Object.keys(next.release.builds ?? {}).map((svc) => ({ service: svc, from: current.release.builds?.[svc] ? `built from ${current.release.builds[svc]!.commit.slice(0, 12)}` : '(new service)', to: `built from ${next.release.builds![svc]!.commit.slice(0, 12)}` })),
    ].filter((x) => x.from !== x.to);
    const fromVersion = packageVersionOf(current);
    const toVersion = packageVersionOf(next);
    // decision 180: new settings start at their default (the submission may choose); dropped and no longer allowed ones say so
    const settingPlan = plannedUpdateSettings(current.manifest, next.manifest, readSettingOverrides(this.ctx.config.stateDir, inst.id));
    // decision 184: an app that follows its package's default moves with it
    const internetPlan = plannedUpdateInternet(current.manifest, next.manifest, this.ctx.egress?.choice(inst.id) ?? null, inst.name, this.internetContext());
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: next.revision,
      name: inst.name,
      project: inst.project,
      endpoints,
      ports: fixedPorts,
      permissions: addedPermissions,
      ...(gpu ? { gpu } : {}),
      opensPorts: fixedPorts.filter((p) => !heldPorts.has(p.hostPort)).map((p) => p.hostPort),
      storage: [...keptStorage, ...newStorage],
      location: null,
      secrets: plannedSecrets(next.manifest, keptSecrets),
      links,
      ...(settingPlan.settings.length ? { settings: settingPlan.settings } : {}),
      ...(internetPlan ? { internet: internetPlan.internet } : {}),
      changes: [
        `Update ${pkgName} "${inst.name}" from revision ${inst.revision}${fromVersion ? ` (${fromVersion})` : ''} to revision ${next.revision}${toVersion ? ` (${toVersion})` : ''}`,
        'Keep the name, addresses, ports, data volumes, your folders and secrets',
        'Stop and delete the current containers (the previous release is kept for an automatic rollback)',
        ...images.map((i) => `Image ${i.service}: ${i.from} -> ${i.to}`),
        ...newStorage.map((s) => (s.hostPath ? `Use your folder ${s.hostPath} for ${s.purpose}` : `Create retained volume ${s.volumeName} (${s.purpose})`)),
        ...newSecrets.map((id) => ((next.manifest.secrets ?? []).find((s) => s.id === id)?.source === 'operator' ? `Store the value you provide for the new secret ${id}` : `Generate retained secret ${id}`)),
        ...this.linkChanges(links, pkgName),
        ...droppedLinks.map((l) => `Remove link ${l.linkId} (this release no longer uses it) and its network ${l.networkName}`),
        ...settingPlan.changes,
        ...(internetPlan?.changes ?? []),
        ...fresh.map((e) => `Publish new endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
        ...this.fixedPortChanges(fixedPorts.filter((p) => !heldPorts.has(p.hostPort)), addedPermissions),
        ...(gpu ? gpuChanges(next.manifest, gpu) : []),
        ...droppedVolumes.map((v) => `Volume ${v} is no longer used by this release; it is kept, not deleted`),
        'Pull the new images by digest, start the new containers, check readiness',
        'If the new release does not become healthy, put the previous release back and start it again',
      ],
      warnings: [
        ...(next.origin === 'local' ? ['This is your own uploaded package; Harbor has not checked it on a real machine.'] : []),
        ...(internetPlan?.warnings ?? []),
        'Apps usually migrate their own data forward on first start. Going back to the old release afterwards is only as safe as the app makes it; Harbor keeps your data as it is.',
        ...(next.manifest.presentation?.releaseNotes ? [`Release notes: ${next.manifest.presentation.releaseNotes}`] : []),
      ],
      releaseHashes: next.hashes,
      update: { fromRevision: inst.revision, toRevision: next.revision, fromVersion, toVersion, images, newSecrets, newStorage: newStorage.map((s) => s.id), newEndpoints: fresh.map((e) => e.id), releaseNotes: next.manifest.presentation?.releaseNotes ?? null },
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'update', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // decision 184: what the internet plans need to know about this machine
  private internetContext(): { allApps: boolean; vpnReady: boolean } {
    const s = this.ctx.egress?.setting();
    return { allApps: s?.allApps ?? false, vpnReady: Boolean(s?.tunnel) };
  }

  // Configure (decisions 125/126): replace operator-provided secrets (values arrive with the submission)
  // and/or change link providers of an installed app; the runner re-renders and recreates what changed.
  private async configurePlan(req: Extract<PlanRequest, { kind: 'configure' }>, inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): Promise<PlanDto> {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `configure requires an installed app; ${inst.name} is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? 'Reinstall it first.' : 'Fix the app first (Details shows the last error).' });
    const pkg = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, inst.id), 'release'), inst.packageId);
    const wanted = [...new Set(req.secrets ?? [])];
    for (const id of wanted) {
      const claim = (pkg.manifest.secrets ?? []).find((s) => s.id === id);
      if (!claim) throw new HarborError('INVALID_REQUEST', `${pkgName} has no secret ${id}`);
      if (claim.source !== 'operator') throw new HarborError('INVALID_REQUEST', `secret ${id} is generated by Harbor and cannot be typed in`, { nextAction: 'Only secrets the package asks you for (source: operator) can be changed.' });
    }
    // decision 180: setting values are checked here (they are not secret: the plan lists them as changes)
    const settingPlan = req.settings ? plannedConfigureSettings(pkg.manifest, readSettingOverrides(this.ctx.config.stateDir, inst.id), req.settings) : null;
    // decision 184: internet access (rules + the resolver rendered into its containers: a running app is re-created)
    const internetPlan = req.internet !== undefined ? plannedConfigureInternet(packageInternet(pkg.manifest), this.ctx.egress?.choice(inst.id) ?? null, req.internet, inst.name, { ...this.internetContext(), running: inst.desired === 'running' }) : null;
    const othersChange = wanted.length > 0 || Object.keys(req.links ?? {}).length > 0 || Boolean(settingPlan?.changes.length);
    if (!othersChange && !internetPlan) {
      if (req.internet !== undefined) throw new HarborError('INVALID_REQUEST', 'nothing to change: the app already uses that internet access', { nextAction: 'Choose a different one.' });
      if (req.settings && Object.keys(req.settings).length) throw new HarborError('INVALID_REQUEST', `nothing to change: ${Object.keys(req.settings).length === 1 ? 'that setting already has this value' : 'those settings already have these values'}`, { nextAction: 'Choose a different value.' });
      throw new HarborError('INVALID_REQUEST', 'nothing to change', { nextAction: 'Name a secret to replace (--secret id=@file), a link provider (--link id=<app>), a setting (--set id=value) and/or internet access (--internet direct|vpn|offline|default).' });
    }
    const identity = identityFor(this.ctx.installationId, inst.id);
    const keep = new Set((pkg.manifest.secrets ?? []).filter((s) => !wanted.includes(s.id)).map((s) => s.id));
    const secrets = plannedSecrets(pkg.manifest, keep);
    const links = this.resolveLinks(pkg.manifest, identity, req.links ?? {}, { selfId: inst.id, existing: repo.linksOfConsumer(inst.id), allowClear: true, explicitOnly: true });
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets,
      links,
      ...(settingPlan?.settings.length ? { settings: settingPlan.settings, settingValues: settingPlan.values } : {}),
      ...(internetPlan ? { internet: internetPlan.internet, internetOnly: !othersChange } : {}),
      changes: [
        ...wanted.map((id) => `Replace the stored value of ${id} with the one you provide (kept as a retained secret, never shown)`),
        ...this.linkChanges(links, pkgName),
        ...(settingPlan?.changes ?? []),
        ...(internetPlan?.changes ?? []),
        ...(othersChange ? [`Re-render the private Compose file of "${inst.name}" and recreate the containers whose configuration changed (same volumes and ports), then check readiness`] : []),
      ],
      warnings: [...(internetPlan?.warnings ?? [])],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'configure', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
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
      assertMarkerWritable(hostPath); // decision 121: the drive guard needs this app's marker in it
      const clash = inUse.find((u) => hostPathsOverlap(u.path, hostPath));
      if (clash) throw new HarborError('OWNERSHIP_CONFLICT', `${hostPath} overlaps ${clash.path}, already used by instance ${clash.instance}`, { nextAction: 'Choose a different folder; two apps must not share or nest their storage.' });
      if (chosen.some((c) => hostPathsOverlap(c, hostPath))) throw new HarborError('INVALID_REQUEST', `folder ${hostPath} is used by two storage claims of the same install`);
      chosen.push(hostPath);
      return { id: claim.id, composeVolume: claim.composeVolume, volumeName: null, purpose: claim.purpose, hostPath, readOnly: claim.external?.readOnly ?? false };
    });
  }

  // Where a tailnet / public exposure of `alloc` would live, after checking the provider is ready
  // (shared by Publish and by install with a chosen main address, decision 116). Pushes plan warnings.
  private async exposureTarget(via: ExposureVia, alloc: EndpointAllocation, pkg: LoadedPackage, pkgName: string, req: { hostname?: string; protection?: 'none' | 'basic'; proxyFrom?: string }, warnings: string[], reserved: number[] = []): Promise<{ hostname: string; port: number; protection: 'none' | 'basic' }> {
    const { repo } = this.ctx;
    let hostname: string;
    let port: number;
    let protection: 'none' | 'basic';
    if (via === 'proxy') {
      // Decision 118: your own reverse proxy (Nginx Proxy Manager, Traefik, …) terminates TLS and forwards to
      // this machine's LAN port. Harbor only records the hostname and which address may forward headers.
      if (!this.ctx.config.lan.enabled) throw new HarborError('INVALID_STATE', 'your proxy reaches apps over the LAN, and LAN mode is off', { nextAction: 'Turn on LAN mode (bootstrap --lan), or publish with Harbor\'s own public proxy.' });
      if (!req.hostname || !HOSTNAME_RE.test(req.hostname)) throw new HarborError('INVALID_REQUEST', 'needs the fully qualified hostname your proxy serves (e.g. cloud.example.com)');
      const from = (req as { proxyFrom?: string }).proxyFrom?.trim() ?? '';
      if (!isProxyAddress(from)) throw new HarborError('INVALID_REQUEST', 'needs the LAN address your proxy connects from (an IPv4/IPv6 address, e.g. 192.168.0.20)', { nextAction: 'Use the IP of the machine running your proxy, not a hostname or 127.0.0.1.' });
      const lanIp = lanNames().find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)) ?? '<this machine>';
      warnings.push(`In your proxy, forward https://${req.hostname}/ to http://${lanIp}:${alloc.hostPort} (WebSockets on). Harbor runs nothing for this address: the certificate and the DNS record are your proxy's.`);
      return { hostname: req.hostname, port: 443, protection: 'none' };
    }
    if (via === 'tailnet') {
      const st = await this.ctx.tailscale.status();
      if (!st || st.backendState !== 'Running' || !st.dnsName) throw new HarborError('UNSUPPORTED_CAPABILITY', 'Tailscale is not set up on this host', { nextAction: 'Re-run bootstrap with --with-tailscale and complete the login; see the Tailscale tool card.' });
      if (!st.httpsEnabled) throw new HarborError('UNSUPPORTED_CAPABILITY', 'HTTPS certificates are not enabled for this tailnet', { nextAction: 'Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS settings), then retry.' });
      if (req.hostname && req.hostname !== st.dnsName) throw new HarborError('INVALID_REQUEST', `tailnet exposures use the node name ${st.dnsName}; a custom hostname is not possible`);
      hostname = st.dnsName;
      // Decision 133: its own port, never the app's. In LAN mode the app port is published on every
      // interface (0.0.0.0), so tailscaled on the same number shares it with the app's plain-HTTP listener
      // and later blocks the app's own container recreate ("failed to bind host port").
      port = await this.tailnetPort([alloc.hostPort, ...reserved]);
      protection = 'none'; // tailnet ACLs are the access control; serve has no auth layer
      if (req.protection === 'basic') warnings.push('Basic-auth protection is not available on the tailnet path; access is governed by your tailnet ACLs.');
    } else {
      if (!(await this.ctx.caddy.available())) throw new HarborError('UNSUPPORTED_CAPABILITY', 'The public proxy (Caddy) is not set up on this host', { nextAction: 'Re-run bootstrap with --with-public-proxy; see the Public proxy tool card.' });
      if (!req.hostname || !HOSTNAME_RE.test(req.hostname)) throw new HarborError('INVALID_REQUEST', 'public exposure needs a fully qualified hostname you control (e.g. n8n.example.com)');
      hostname = req.hostname;
      port = 443;
      // packages with their own onboarding or a Harbor-provisioned admin manage their own accounts (n8n, Nextcloud)
      const packageHasOwnAuth = pkg.manifest.setup !== undefined || pkg.manifest.provisionedCredentials !== undefined;
      protection = req.protection ?? (packageHasOwnAuth ? 'none' : 'basic');
      if (protection === 'none' && !packageHasOwnAuth) warnings.push(`${pkgName} has no login of its own; without basic-auth protection anyone who reaches ${hostname} can use it.`);
      const known = repo.domain(hostname);
      if (known?.dnsState === 'points_here') warnings.push(`${hostname} points at this machine (checked ${known.checkedAt ?? 'recently'}); the certificate is requested from Let's Encrypt automatically once published.`);
      else if (known) warnings.push(`${hostname} does not point at this machine yet (${known.dnsState.replace('_', ' ')}${known.note ? `: ${known.note}` : ''}); the certificate cannot be issued until it does.`);
      else warnings.push(`DNS: an A/AAAA record for ${hostname} must point at this host's public address, and ports 80/443 must be reachable from the internet, or the certificate cannot be issued. Register the domain under Settings → Public addresses to have Harbor check it.`);
    }
    return { hostname, port, protection };
  }

  // Decision 145: move an encrypted app between install locations (data folder ↔ drive, drive ↔ drive).
  // Same instance and same app key (passphrase, own words and Harbor card keep working); the target must
  // be able to seal. A plain-volume app is sealed first (decision 142).
  private movePlan(inst: InstanceRow, dirReq: string, pkgName: string, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `moving needs an installed app; ${inst.name} is ${inst.installState}`);
    const home = this.homeRow(inst.id);
    if (!home) throw new HarborError('INVALID_STATE', `${inst.name} is not encrypted; only an encrypted app can move as a whole`, { nextAction: `Encrypt it first: harbor seal ${inst.name}` });
    const hs = this.homeState(inst.id);
    const reachable = this.unlockedApps.has(inst.id) || Boolean(hs?.silentUnlock && this.ctx.machineKey.unlocked);
    if (!reachable) throw new HarborError('INVALID_STATE', `${inst.name} is locked`, { nextAction: hs?.defaultKey ? 'Log in again so this machine can open it, then retry.' : 'Unlock it with its passphrase first, then retry.' });
    if (this.needsDrive(inst.id)) throw new HarborError('DATA_MISSING', `${inst.name} needs its drive back before it can move`);
    const dir = this.resolveInstallLocation(dirReq, repo.listInstances().filter((i) => i.id !== inst.id), inst.packageId);
    const target = path.posix.join(dir, inst.name);
    if (target === home.name) throw new HarborError('INVALID_REQUEST', `${inst.name} already lives at ${home.name}`);
    if (existsSync(target)) throw new HarborError('NAME_CONFLICT', `${target} already exists`, { nextAction: 'Pick another place, or remove that folder first.' });
    const cand = this.installCandidates().find((c) => dir.startsWith(c.dir + '/'));
    if (cand && cand.fsType !== 'unknown' && !['ext4', 'f2fs'].includes(cand.fsType.toLowerCase())) throw new HarborError('INVALID_STATE', `${cand.label} uses ${cand.fsType}, which cannot seal apps (needs ext4)`, { nextAction: 'Format the drive as ext4 in Settings → Storage, then move the app.' });
    const toDrive = !this.isDataFolderLocation(dir);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: { dir },
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [
        `Stop ${pkgName} ("${inst.name}") and delete its containers (data stays)`,
        `Create a sealed home at ${target}/ with the same app key (its passphrase, own words and your Harbor recovery key keep working)`,
        `Copy its data from ${home.name} as root: decrypted only inside the kernel, written sealed at the target, verified by entry counts and bytes`,
        `Start ${pkgName} from the new place and check it answers (same name, ports, addresses, links and secrets)`,
        `Only then delete the old home ${home.name}; any failure before that puts the app back where it was`,
      ],
      warnings: [
        `${pkgName} is down while its data is copied.`,
        `Needs free space for a full copy at ${dir}.`,
        ...(toDrive ? ['On a drive the app stops when the drive is unplugged and starts again when it is back.'] : []),
      ],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'move', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 151: the cold pass of a backup run. Submitted by the backup worker (actor `scheduler`) once
  // the warm passes converged; the app is down only while what changed since the last pass is sent.
  private backupPlan(inst: InstanceRow, runId: string, pkgName: string, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    if (!UUID_RE.test(runId)) throw new HarborError('INVALID_REQUEST', 'invalid backup run id');
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `backing up needs an installed app; ${inst.name} is ${inst.installState}`);
    if (!this.homeRow(inst.id)) throw new HarborError('INVALID_STATE', `${inst.name} is not encrypted`, { nextAction: `Encrypt it first: harbor seal ${inst.name}` });
    const cap = this.ctx.backups?.policy().maxDowntimeMinutes ?? 5;
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [`Stop ${pkgName} ("${inst.name}"); its containers and data stay`, `Send what changed since the last pass to every backup place (at most ${cap} min)`, `Start ${pkgName} again and check it answers`],
      warnings: [`${pkgName} is down while the last changes are sent (at most ${cap} min; it starts again either way).`],
      releaseHashes: inst.releaseHashes,
      backup: { runId },
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'backup', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 153: put an app back as it was at a restore point. The current home is kept aside until the
  // operator deletes it; any failure puts it back and starts the app as it was.
  private restorePlan(inst: InstanceRow, runId: string, targetId: string | undefined, pkgName: string, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    const backups = this.ctx.backups;
    if (!backups) throw new HarborError('UNSUPPORTED_CAPABILITY', 'backups are not available on this machine');
    if (!['installed', 'needs_action', 'failed'].includes(inst.installState)) throw new HarborError('INVALID_STATE', `cannot restore ${inst.name} while it is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? `Reinstall it first: harbor reinstall ${inst.name}` : 'Wait for it to settle, then try again.' });
    const home = this.homeRow(inst.id);
    if (!home) throw new HarborError('INVALID_STATE', `${inst.name} is not encrypted, so it has no backups`);
    if (this.needsDrive(inst.id)) throw new HarborError('DATA_MISSING', `${inst.name} needs its drive back before it can be restored`);
    if (backups.previous(inst.id) && existsSync(backups.previous(inst.id)!.path)) throw new HarborError('INVALID_STATE', `${inst.name} still keeps the copy from before its last restore`, { nextAction: 'Delete that copy from the app\'s Backups tab first (or keep it by moving it elsewhere yourself).' });
    const point = backups.resolvePoint(inst.id, runId, targetId);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [
        `Stop ${pkgName} ("${inst.name}") and delete its containers`,
        `Keep its current data aside at ${home.name}.before-restore-… (delete it later from the Backups tab)`,
        `Create a fresh sealed home at ${home.name} with the same key and restore the data of ${point.snapshot.time} from ${point.target.name} into it`,
        `Put back its secrets, settings and release as they were then, start it and check it answers (same name, ports, addresses and links)`,
      ],
      warnings: [`Everything ${pkgName} saved after ${point.snapshot.time} is only in the copy kept aside.`, `${pkgName} is down while the data is restored.`, 'Needs free space for a second copy of the app at the same place.'],
      releaseHashes: inst.releaseHashes,
      restore: { runId, targetId: point.target.id, snapshotId: point.snapshot.id, sourceHome: point.home, sourceStage: point.stage, time: point.snapshot.time },
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'restore', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 153: delete the copy of an app a restore kept aside. Not Docker, not the app's live data: the
  // folder named in the setting, deleted by root after it re-checks the manifest names this instance.
  async deletePreviousCopy(instanceId: string): Promise<{ deleted: string }> {
    const inst = this.instanceRow(instanceId);
    const prev = this.ctx.backups?.previous(inst.id);
    if (!prev) throw new HarborError('NOT_FOUND', `${inst.name} keeps no copy from before a restore`);
    if (prev.path === this.homeRow(inst.id)?.name) throw new HarborError('INVALID_STATE', 'that folder is the app\'s live home; refusing');
    if (existsSync(prev.path)) {
      if (this.ctx.crypto) await this.ctx.crypto.destroyHome({ instanceId: inst.id, home: prev.path });
      else rmSync(prev.path, { recursive: true, force: true });
    }
    this.ctx.backups!.setPrevious(inst.id, null);
    this.ctx.log.info(`deleted the copy of ${inst.name} kept by its last restore`, { instanceId, path: prev.path });
    return { deleted: prev.path };
  }

  // Decision 153: restore an app from a backup place onto THIS machine (a new machine, or an app purged
  // here). Same identity (the instance id travels in the backup), fresh ports, an install plan whose
  // home is created from the restore point instead of empty.
  async restoreAppPlan(req: { targetId: string; instanceId: string; runId: string; location: { dir: string }; name?: string }, actor: string): Promise<PlanDto> {
    const { repo, ids, clock, config } = this.ctx;
    const backups = this.ctx.backups;
    if (!backups) throw new HarborError('UNSUPPORTED_CAPABILITY', 'backups are not available on this machine');
    const existing = repo.instance(req.instanceId);
    if (existing && !existing.purgedAt) throw new HarborError('NAME_CONFLICT', 'that app is already on this machine', { nextAction: 'Restore it from its own Backups tab instead.' });
    // An app fully uninstalled here keeps its row for history: the restored copy gets a fresh identity.
    const instanceId = existing ? ids.uuid() : req.instanceId;
    if (!this.ctx.machineKey.unlocked) throw new HarborError('MACHINE_KEY_LOCKED', 'Harbor restarted since your last login, so its key for encrypted apps is locked', { nextAction: 'Type your password to unlock this machine\'s key (the console asks; or run harbor account unlock), then try again.' });
    const point = backups.resolvePoint(req.instanceId, req.runId, req.targetId);
    const pkgId = tagValue(point.snapshot.tags, 'pkg') ?? '';
    let pkg: LoadedPackage;
    try {
      pkg = this.ctx.packages.load(pkgId);
    } catch (e) {
      // only a missing package is "add it first"; "needs Harbor x.y.z" (or a broken package) says what it is
      if (!HarborError.is(e, 'NOT_FOUND')) throw e;
      throw new HarborError('NOT_FOUND', `this Harbor has no package ${pkgId}`, { nextAction: 'Add that app\'s package first (App Store → Your apps → Upload, or its git source), then restore again.' });
    }
    const instances = repo.listInstances();
    const copies = instances.filter((i) => i.packageId === pkg.id);
    if (!pkg.manifest.deployment.multiInstance && copies.length) throw new HarborError('NAME_CONFLICT', `${pkg.id} does not support multiple instances`, { nextAction: oneCopyNextAction(copies, 'restore') });
    const taken = new Set(instances.map((i) => i.name));
    const slug = point.home.split('/').pop() ?? pkg.id;
    const proposed = proposeName(req.name ?? slug, taken, req.name);
    if (proposed.error) throw new HarborError(proposed.error.includes('already used') ? 'NAME_CONFLICT' : 'INVALID_REQUEST', proposed.error);
    const identity = identityFor(this.ctx.installationId, instanceId);
    const endpoints = await this.allocatePorts(pkg);
    const fixedPorts = await this.checkFixedPorts(pkg.manifest, null);
    const permissions = permissionsOf(pkg.manifest);
    const gpu = await this.planGpu(pkg.manifest);
    const storage = this.resolveStorage(pkg, identity, {}, instances);
    const dir = this.resolveInstallLocation(req.location.dir, instances, pkg.id);
    const target = path.posix.join(dir, proposed.name);
    if (existsSync(target)) throw new HarborError('NAME_CONFLICT', `${target} already exists`, { nextAction: 'Pick another name or place.' });
    const now = clock.now();
    const proposal: PlanProposal = {
      packageId: pkg.id,
      revision: pkg.revision,
      name: proposed.name,
      project: identity.project,
      endpoints,
      ports: fixedPorts,
      permissions,
      ...(gpu ? { gpu } : {}),
      storage,
      location: { dir, defaultKey: true },
      secrets: (pkg.manifest.secrets ?? []).map((s) => ({ id: s.id })),
      changes: [
        `Restore ${pkg.manifest.metadata.name} as it was at ${point.snapshot.time}, from ${point.target.name}`,
        `Create a sealed home at ${target}/ with the app's own key; this machine unlocks it when you log in, and your Harbor recovery key opens it anywhere`,
        `Put back its secrets, then create Compose project ${identity.project}`,
        // decision 180: the restore point carries the settings the app had (none stored = the defaults)
        ...(pkg.manifest.settings?.length ? ['Put back the settings it had at the restore point (any it never changed follow this release\'s defaults)'] : []),
        ...endpoints.map((e) => `Publish endpoint ${e.id}: 127.0.0.1:${e.hostPort} -> ${e.service}:${e.containerPort}`),
        ...this.fixedPortChanges(fixedPorts, permissions),
        ...(gpu ? gpuChanges(pkg.manifest, gpu) : []),
      ],
      warnings: ['Ports are allocated fresh on this machine; addresses differ from the previous one.', ...(tagValue(point.snapshot.tags, 'pkg') && pkg.revision ? [`It runs package revision ${pkg.revision} here; the app updates its own data if that is newer than the one it was backed up with.`] : [])],
      releaseHashes: pkg.hashes,
      restore: { runId: req.runId, targetId: point.target.id, snapshotId: point.snapshot.id, sourceHome: point.home, sourceStage: point.stage, time: point.snapshot.time, ...(instanceId !== req.instanceId ? { fromInstanceId: req.instanceId } : {}) },
    };
    await this.validateProspective(pkg, identity, endpoints);
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'install', instanceId, proposal, expectedGeneration: 0, createdAt: rfc3339(now), expiresAt: rfc3339(addSeconds(now, config.planTtlSeconds)) };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 142: `harbor seal` — an app on plain Docker volumes moves into a sealed home in the Harbor
  // data folder (Harbor's own key), same instance: id, name, ports, links, addresses and secrets stay.
  private sealPlan(inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `sealing needs an installed app; ${inst.name} is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? `Reinstall it first: harbor reinstall ${inst.name}` : 'Repair it first (harbor repair).' });
    const resources = repo.resources(inst.id);
    if (resources.some((r) => r.kind === 'volume' && r.role === '__home__')) throw new HarborError('INVALID_STATE', `${inst.name} is already encrypted`);
    const plain = resources.filter((r) => r.kind === 'volume' && !r.metadata?.['homePath']).sort((a, b) => a.role.localeCompare(b.role));
    const folders = resources.filter((r) => r.kind === 'bind');
    if (!plain.length) throw new HarborError('INVALID_STATE', `${inst.name} keeps no data in Harbor volumes${folders.length ? ' (only in your own folders, which Harbor never moves)' : ''}; there is nothing to seal`);
    if (!this.ctx.machineKey.unlocked) throw new HarborError('MACHINE_KEY_LOCKED', 'Harbor restarted since your last login, so its key for encrypted apps is locked', { nextAction: 'Type your password to unlock this machine\'s key (the console asks; or run harbor account unlock), then try again.' });
    const dir = this.resolveInstallLocation(path.posix.join(this.ctx.config.userDataDir, 'harbor-apps', inst.packageId), repo.listInstances(), inst.packageId);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: { dir, defaultKey: true },
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [
        `Stop ${pkgName} ("${inst.name}") and delete its containers (data stays)`,
        `Create a sealed home at ${dir}/${inst.name}/ with Harbor's own key; this machine unlocks it when you log in`,
        ...plain.map((r) => `Copy volume ${r.name} into the sealed home as root and verify entry counts and bytes`),
        `Start ${pkgName} on the sealed copies and check it answers (same name, ports, addresses, links and secrets)`,
        `Only then delete the plain volume${plain.length === 1 ? '' : 's'} ${plain.map((r) => r.name).join(', ')}; any failure before that puts the app back on them`,
      ],
      warnings: [
        `${pkgName} is down while its data is copied.`,
        'Needs free space for one extra copy of the data on the system disk.',
        'Old blocks of the plain volumes cannot be scrubbed from the disk: they may stay recoverable until overwritten.',
        ...(folders.length ? [`Your own folder${folders.length === 1 ? '' : 's'} ${folders.map((f) => f.name).join(', ')} stay${folders.length === 1 ? 's' : ''} as ${folders.length === 1 ? 'it is' : 'they are'} (not encrypted).`] : []),
      ],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'seal', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 171: put an app's links back with only the names Harbor gives. Queued once after an upgrade by
  // the daemon (actor `link-guard`) for links Compose attached before 0.32.0; no container is recreated.
  private relinkPlan(inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    if (inst.installState !== 'installed') throw new HarborError('INVALID_STATE', `${inst.name} is ${inst.installState}; its links are attached again when it starts`);
    const links = [...repo.linksOfConsumer(inst.id), ...repo.linksOfProvider(inst.id)].filter((l) => l.state === 'active' && l.providerInstanceId);
    if (!links.length) throw new HarborError('INVALID_STATE', `${inst.name} has no active link`);
    const others = [...new Set(links.map((l) => (l.consumerInstanceId === inst.id ? l.providerInstanceId! : l.consumerInstanceId)))].map((id) => repo.instance(id)?.name ?? id);
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [
        `Attach the private link${links.length === 1 ? '' : 's'} of ${pkgName} ("${inst.name}") with ${others.join(', ')} again, with only the names Harbor gives (no app answers there to its service names any more)`,
        'Same containers, data, ports and addresses; nothing is recreated',
      ],
      warnings: [`The link${links.length === 1 ? '' : 's'} drop${links.length === 1 ? 's' : ''} for a moment while ${links.length === 1 ? 'it is' : 'they are'} attached again.`],
      releaseHashes: inst.releaseHashes,
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'relink', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 135: `unexpose` on a removed app forgets an address Remove kept for Reinstall (nothing is
  // served for it right now, so no provider is touched).
  private forgetRetainedPlan(req: Extract<PlanRequest, { kind: 'unexpose' }>, inst: InstanceRow, actor: string, now: Date, expiresAt: string): PlanDto {
    const { repo, ids } = this.ctx;
    const endpointId = req.endpointId ?? this.packageMeta(inst).primaryEndpoint;
    const kept = (retainedExposures(repo, inst.id)?.items ?? []).filter((x) => x.endpointId === endpointId && x.via === req.via && (req.hostname === undefined || x.hostname === req.hostname));
    if (!kept.length) throw new HarborError('NOT_FOUND', `${inst.name} is removed and keeps no ${req.via} address${req.hostname ? ` at ${req.hostname}` : ''} for Reinstall`);
    if (kept.length > 1) throw new HarborError('INVALID_REQUEST', `${inst.name} keeps ${kept.length} ${req.via} addresses (${kept.map((x) => x.hostname).join(', ')})`, { nextAction: `Name the one to forget: harbor unexpose ${inst.name} --via ${req.via} --host <hostname>` });
    const x = kept[0]!;
    const proposal: PlanProposal = {
      packageId: inst.packageId,
      revision: inst.revision,
      name: inst.name,
      project: inst.project,
      endpoints: inst.endpoints,
      storage: [],
      location: null,
      secrets: inst.secrets.map((s) => ({ id: s.id })),
      changes: [`Forget ${exposureUrl(x)}: ${inst.name} is removed, so nothing serves it now, and Reinstall will not publish it again`],
      warnings: [],
      releaseHashes: inst.releaseHashes,
      exposure: { endpointId, via: x.via, hostname: x.hostname, port: x.port, protection: x.protection, makePrimary: false, forget: true },
    };
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'unexpose', instanceId: inst.id, proposal, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  private async exposurePlan(req: Extract<PlanRequest, { kind: 'expose' | 'unexpose' | 'reconfigure' }>, inst: InstanceRow, pkgName: string, actor: string, now: Date, expiresAt: string): Promise<PlanDto> {
    const { repo, ids } = this.ctx;
    // Decision 135: withdrawing an address is also the way out of a broken state (needs_action/failed:
    // the address that broke an update must be removable through Harbor), and on a removed app it
    // forgets an address kept for Reinstall. Publishing and switching still need an installed app.
    const repairable = inst.installState === 'needs_action' || inst.installState === 'failed';
    if (req.kind === 'unexpose' && inst.installState === 'retained') return this.forgetRetainedPlan(req, inst, actor, now, expiresAt);
    if (inst.installState !== 'installed' && !(req.kind === 'unexpose' && repairable)) {
      throw new HarborError('INVALID_STATE', `${req.kind === 'unexpose' ? 'withdrawing an address' : 'exposure changes'} require${req.kind === 'unexpose' ? 's' : ''} an installed app; ${inst.name} is ${inst.installState}`, { nextAction: inst.installState === 'retained' ? `Reinstall it first: harbor reinstall ${inst.name}` : repairable ? `Withdraw the address that is in the way (harbor unexpose ${inst.name} --via <via>), then retry: harbor retry ${inst.name}` : 'Wait for the current operation to finish.' });
    }
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
      // Decision 127: with several public hostnames, `hostname` names the main one (default: the first published).
      let label: string = req.primary;
      if (req.hostname !== undefined) {
        if (req.primary !== 'public') throw new HarborError('INVALID_REQUEST', 'a hostname picks the main address only among public addresses');
        if (!existing.some((e) => e.via === 'public' && e.endpointId === meta.primaryEndpoint && e.hostname === req.hostname)) throw new HarborError('INVALID_REQUEST', `${inst.name} is not published at ${req.hostname}`, { nextAction: `Publish it there first: harbor expose ${inst.name} --via public --host ${req.hostname}` });
      }
      if (req.primary === 'public') {
        const current = inst.primaryExposure === 'public' ? mainPublicExposure(existing, meta.primaryEndpoint, inst.primaryHost) : null;
        const target = req.hostname ?? (current ? current.hostname : mainPublicExposure(existing, meta.primaryEndpoint, null)?.hostname ?? null);
        if (current && current.hostname === target) throw new HarborError('INVALID_STATE', `https://${target}/ is already the primary address of ${inst.name}`);
        base.primaryHost = target;
        if (target) label = `https://${target}/`;
      } else if (req.primary === inst.primaryExposure) throw new HarborError('INVALID_STATE', `${req.primary} is already the primary address of ${inst.name}`);
      base.primary = req.primary;
      base.changes.push(`Make ${label} the primary address of "${inst.name}"`, hasBaseUrlBindings ? `Re-render the private Compose file with the new base URL and recreate ${pkgName}'s containers (same volumes, secrets and ports), then check readiness` : 'No package configuration depends on the base URL; only Harbor\'s records change');
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'reconfigure', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }
    const endpointId = req.endpointId ?? meta.primaryEndpoint;
    const alloc = inst.endpoints.find((e) => e.id === endpointId);
    if (!alloc) throw new HarborError('INVALID_REQUEST', `instance ${inst.name} has no endpoint ${endpointId}`);
    if (req.kind === 'unexpose') {
      const candidates = existing.filter((x) => x.endpointId === endpointId && x.via === req.via && (req.hostname === undefined || x.hostname === req.hostname));
      if (!candidates.length) throw new HarborError('NOT_FOUND', req.hostname ? `${inst.name}/${endpointId} is not exposed via ${req.via} at ${req.hostname}` : `${inst.name}/${endpointId} is not exposed via ${req.via}`);
      // Decision 127: several public hostnames — never guess which one to withdraw.
      if (candidates.length > 1) throw new HarborError('INVALID_REQUEST', `${inst.name}/${endpointId} is published under ${candidates.length} ${req.via} hostnames (${candidates.map((x) => x.hostname).join(', ')})`, { nextAction: `Name the one to withdraw: harbor unexpose ${inst.name} --via ${req.via} --host <hostname>` });
      const e = candidates[0]!;
      base.exposure = { endpointId, via: e.via, hostname: e.hostname, port: e.port, protection: e.protection, makePrimary: false };
      base.changes.push(req.via === 'proxy' ? `Forget the address ${exposureUrl(e)} of "${inst.name}" (remove it from your proxy yourself)` : `Remove the ${req.via} address ${exposureUrl(e)} of "${inst.name}" (${req.via === 'public' ? 'Caddy route and its certificate' : 'tailscale serve entry'})`);
      const isMain = inst.primaryExposure === req.via && (req.via !== 'public' || (endpointId === meta.primaryEndpoint && mainPublicExposure(existing, endpointId, inst.primaryHost)?.id === e.id));
      const next = req.via === 'public' && isMain ? existing.find((x) => x.via === 'public' && x.endpointId === endpointId && x.id !== e.id) : undefined;
      if (isMain && next) {
        // Another public hostname stays: it becomes the main address instead of falling back to loopback.
        base.primary = 'public';
        base.primaryHost = next.hostname;
        base.changes.push(hasBaseUrlBindings ? `It is the primary address: ${exposureUrl(next)} becomes the primary address and containers are recreated with that base URL` : `It is the primary address: ${exposureUrl(next)} becomes the primary address`);
      } else if (isMain) {
        base.primary = 'loopback';
        base.changes.push(hasBaseUrlBindings ? 'It is the primary address: switch back to loopback and recreate containers with the loopback base URL' : 'It is the primary address: switch back to loopback');
      }
      if (e.protection === 'basic') base.changes.push('Retain the generated basic-auth credentials (instance secret) for a later re-exposure');
      // decision 177: withdrawing it by hand keeps the every-app policy from publishing it again
      // (on or off: a withdrawal by hand is remembered, so turning the policy on later does not undo it)
      if (e.via === 'tailnet' && endpointId === meta.primaryEndpoint && actor !== TAILNET_POLICY_ACTOR) {
        base.notes = [this.tailnetAll.setting().enabled ? 'Every app on Tailscale is on: withdrawing this one keeps it off the tailnet from now on (turn its "On Tailscale" switch back on in its drawer to undo).' : 'Withdrawing it by hand also keeps it off the tailnet if you turn on Every app on Tailscale later (its "On Tailscale" switch in its drawer undoes that).'];
      }
      const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'unexpose', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
      repo.insertPlan(plan);
      return this.plan(plan.id);
    }
    // expose
    // Decision 127: a public endpoint may carry several hostnames (one row, route and certificate each);
    // the tailnet has one node name and your own proxy one record, so those stay one per endpoint.
    const sameVia = existing.filter((x) => x.endpointId === endpointId && x.via === req.via);
    if (req.via === 'public') {
      if (req.hostname && sameVia.some((x) => x.hostname === req.hostname)) throw new HarborError('INVALID_STATE', `${inst.name}/${endpointId} is already published at https://${req.hostname}/`, { nextAction: `To change its protection, withdraw it first: harbor unexpose ${inst.name} --via public --host ${req.hostname}` });
    } else if (sameVia.length) throw new HarborError('INVALID_STATE', `${inst.name}/${endpointId} is already exposed via ${req.via}`, { nextAction: 'Unexpose it first to change hostname or protection.' });
    if (req.via === 'public' && req.hostname && repo.exposures().some((x) => x.via === 'proxy' && x.hostname === req.hostname)) throw new HarborError('NAME_CONFLICT', `https://${req.hostname}/ is already recorded as an address on your own proxy`);
    const endpoint = pkg.manifest.endpoints[endpointId]!;
    const { hostname, port, protection } = await this.exposureTarget(req.via, alloc, pkg, pkgName, req, base.warnings);
    const taken = repo.exposureByAddress(req.via, hostname, port);
    if (taken) throw new HarborError('NAME_CONFLICT', `${exposureUrl({ via: req.via, hostname, port })} is already used by another exposure`);
    if (endpoint.browserContext === 'ordinary') base.warnings.push('This endpoint is declared for ordinary browser contexts; it will still be served over HTTPS.');
    if (req.via === 'proxy' && req.makePrimary) throw new HarborError('INVALID_REQUEST', 'an address on your own proxy cannot be the main address (Harbor does not control its certificate)');
    base.exposure = { endpointId, via: req.via, hostname, port, protection, makePrimary: req.makePrimary ?? false, ...(req.via === 'proxy' ? { proxyFrom: req.proxyFrom! } : {}) };
    if (req.makePrimary && req.via !== 'proxy') {
      base.primary = req.via;
      if (req.via === 'public') base.primaryHost = hostname;
    }
    base.changes.push(
      ...(req.via === 'public' && sameVia.length ? [`Keep ${sameVia.map((x) => exposureUrl(x)).join(', ')}; the new name gets its own Caddy route and certificate`] : []),
      req.via === 'proxy'
        ? `Record https://${hostname}/ as an address of "${inst.name}" served by your proxy at ${req.proxyFrom}; trust forwarded headers from that address only`
        : `Publish "${inst.name}" endpoint ${endpointId} at ${exposureUrl(base.exposure)} via ${req.via === 'public' ? 'Caddy (Let\'s Encrypt certificate)' : 'tailscale serve (tailnet certificate)'} -> 127.0.0.1:${alloc.hostPort}`,
      ...(protection === 'basic' ? ['Generate retained basic-auth credentials (shown once when the operation completes)'] : []),
      ...(req.makePrimary ? [hasBaseUrlBindings ? 'Make it the primary address and recreate containers with the new base URL' : 'Make it the primary address'] : []),
      'Verify the address answers over HTTPS before marking it active',
    );
    const plan: Omit<PlanRow, 'consumedOperationId'> = { id: ids.uuid(), actor, kind: 'expose', instanceId: inst.id, proposal: base, expectedGeneration: inst.generation, createdAt: rfc3339(now), expiresAt };
    repo.insertPlan(plan);
    return this.plan(plan.id);
  }

  // Decision 133: a tailnet address's own port, from the top of the app range down (app ports grow from
  // the bottom up), never a claimed app port, another tailnet address, a Docker-published port or a port
  // with any listener on it right now (the probe also sees wildcard 0.0.0.0 listeners).
  async tailnetPort(reserved: number[] = []): Promise<number> {
    const { repo, docker, ports, config } = this.ctx;
    // decision 177: also the ports of plans still open for review (a tailnet address or an install's app ports),
    // or a background plan (the every-app policy) could take the number a reviewed plan was shown
    const taken = new Set<number>([config.listen.port, ...repo.claimedPorts().map((c) => c.port), ...repo.exposures().filter((e) => e.via === 'tailnet').map((e) => e.port), ...this.openPlanPorts(true), ...reserved]);
    try {
      for (const p of await docker.publishedHostPorts()) taken.add(p);
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `cannot query Docker port bindings: ${(e as Error).message}`);
    }
    for (let p = config.appPortRange.to; p >= config.appPortRange.from; p--) {
      if (taken.has(p)) continue;
      if (await ports.free(p)) return p;
    }
    throw new HarborError('PORT_CONFLICT', `no free port left in ${config.appPortRange.from}-${config.appPortRange.to} for a tailnet address`, { nextAction: 'Withdraw an address or remove an app you no longer use, then try again.' });
  }

  // Ports held by plans still open for review: their tailnet address (decision 133), plus, with endpoints, the app
  // ports an install plan allocated (not claimed until it is submitted).
  private openPlanPorts(endpoints: boolean): number[] {
    const out: number[] = [];
    for (const p of this.ctx.repo.openPlans(rfc3339(this.ctx.clock.now()))) {
      if (p.proposal.exposure?.via === 'tailnet') out.push(p.proposal.exposure.port);
      if (endpoints && p.kind === 'install') out.push(...(p.proposal.endpoints ?? []).map((e) => e.hostPort));
    }
    return out;
  }

  private async allocatePorts(pkg: LoadedPackage, alsoUnavailable: Set<number> = new Set()) {
    const { repo, docker, ports, config } = this.ctx;
    // tailnet addresses hold their own ports (decision 133): an app port there would clash again (so do the
    // tailnet ports of plans still open for review, decision 177)
    const unavailable = new Set<number>([config.listen.port, ...repo.claimedPorts().map((c) => c.port), ...repo.exposures().filter((e) => e.via === 'tailnet').map((e) => e.port), ...this.openPlanPorts(false), ...alsoUnavailable]);
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
  // Decision 163: fixed ports are not allocated, so check them: outside Harbor's own ports, not claimed by another
  // app (retained ones keep theirs), not published by Docker, and free on every interface right now. Ports this
  // instance already holds (an update) are its own.
  private async checkFixedPorts(manifest: Manifest, selfId: string | null): Promise<FixedPortDto[]> {
    const { repo, docker, ports, config } = this.ctx;
    const wanted = fixedPortsOf(manifest);
    if (!wanted.length) return wanted;
    const claims = repo.claimedPorts();
    let published: number[];
    try {
      published = await docker.publishedHostPorts();
    } catch (e) {
      throw new HarborError('DOCKER_UNAVAILABLE', `cannot query Docker port bindings: ${(e as Error).message}`);
    }
    for (const p of wanted) {
      const where = `${manifest.metadata.name} needs ${p.protocol.toUpperCase()} port ${p.hostPort}`;
      if (p.hostPort === config.listen.port || (p.hostPort >= config.appPortRange.from && p.hostPort <= config.appPortRange.to)) {
        throw new HarborError('PORT_CONFLICT', `${where}, which is one of Harbor's own ports`, { nextAction: 'Change Harbor\'s app port range in its configuration, or use a package with another port.' });
      }
      const claim = claims.find((c) => c.port === p.hostPort);
      if (claim && claim.instanceId === selfId) continue;
      if (claim) {
        const holder = repo.instance(claim.instanceId);
        throw new HarborError('PORT_CONFLICT', `${where}, which ${holder ? `${holder.name}${holder.installState === 'retained' ? ' (removed, data kept)' : ''}` : 'another app'} holds`, { nextAction: holder?.installState === 'retained' ? `Purge ${holder.name} to free the port, or reinstall it instead.` : 'Remove the app that holds it first.' });
      }
      if (published.includes(p.hostPort) || (ports.udpFree && !(await ports.udpFree(p.hostPort)))) {
        throw new HarborError('PORT_CONFLICT', `${where}, which something else on this machine already uses`, { nextAction: `Stop whatever listens on ${p.protocol.toUpperCase()} ${p.hostPort} (another VPN server?), then plan again.` });
      }
    }
    return wanted;
  }

  // Decision 179: the graphics card apps granted gpu get on this machine (Settings overview, `harbor gpu`)
  async hostGpu(): Promise<GpuDto> {
    return gpuDto(await this.ctx.gpu.detect());
  }

  // Decision 179: the graphics card found now, recorded in plans of packages that grant gpu (undefined otherwise)
  private async planGpu(manifest: Manifest): Promise<PlanProposal['gpu']> {
    if (!gpuServicesOf(manifest).length) return undefined;
    return gpuDto(await this.ctx.gpu.detect());
  }

  // What the machine offers an installed app granted gpu, and whether its current Compose file hands it over
  private async instanceGpu(i: InstanceRow): Promise<InstanceDetail['gpu']> {
    let manifest: Manifest;
    try {
      manifest = loadReleaseSnapshot(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'release'), i.packageId).manifest;
    } catch {
      return undefined;
    }
    const services = gpuServicesOf(manifest);
    if (!services.length) return undefined;
    const model = readRuntimeModel(path.join(instanceDir(this.ctx.config.stateDir, i.id), 'runtime'));
    const found = await this.ctx.gpu.detect();
    // in use = the containers have the card found NOW (one rendered with another kind needs a Restart to switch).
    // Decision 181: a driver update waiting for a reboot leaves containers created before it on the NVIDIA card (the
    // old module still runs, their libraries stay mounted), so with kind none they still count as using it.
    const rendered = gpuFromRendered(model, services).kind;
    const keepsNvidia = found.kind === 'none' && found.problem === 'NVIDIA_REBOOT_NEEDED' && rendered === 'nvidia';
    return { ...gpuDto(found), inUse: (found.kind !== 'none' && rendered === found.kind) || keepsNvidia };
  }

  // plan lines for fixed ports and permissions (decision 163)
  private fixedPortChanges(ports: FixedPortDto[], perms: { service: string; permission: ManifestPermission }[]): string[] {
    return [
      ...ports.map((p) => `Open ${p.protocol.toUpperCase()} port ${p.hostPort} on every network of this machine for ${p.purpose} (-> ${p.service}:${p.containerPort}); to reach it from the internet, forward ${p.protocol.toUpperCase()} ${p.hostPort} on your router to this machine`),
      ...perms.map((p) => `Allow ${p.service}: ${PERMISSION_LABEL[p.permission]}`),
    ];
  }

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

  // The app-home passphrase for an install-location plan AND for Start
  // plans of locked custom-passphrase apps. It is never stored in the plan
  // (plans are readable); the submitter hands it over with the submission
  // and the runner consumes it at apply time. Held in memory only, keyed by
  // plan id, single-use.
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

  // Operator-provided secret values (decision 125): like the location passphrase, never in the plan.
  // Checked at submit (before the operation exists), held in memory keyed by plan id, consumed once by
  // the runner at the start of the operation. A daemon restart loses them; the queued operation is then
  // marked needs_action (no replay) and a new plan asks again.
  private operatorValues = new Map<string, { store: Record<string, string>; clear: string[] }>();
  takeOperatorSecrets(planId: string): { store: Record<string, string>; clear: string[] } {
    const v = this.operatorValues.get(planId) ?? { store: {}, clear: [] };
    this.operatorValues.delete(planId);
    return v;
  }

  // Decision 180: setting values chosen at submission (install review → Options, an update's new settings, CLI
  // --set). Not secret, but like the values above they belong to this one submission: held by plan id, taken by
  // the runner when the operation starts (a daemon restart marks a queued operation needs_action anyway).
  // Idempotency keys a queued action resolved to an existing item (decision 183 dedupe): the key is not stored on any
  // row, so a retry with it (a lost reply) must still find that item after it started or finished. In memory only: a
  // restart cancels every waiting item anyway, and a retry after one gets a fresh answer. Bounded, oldest dropped.
  private queueKeyAliases = new Map<string, { operationId: string; actor: string; kind: QueueableKind; instanceId: string }>();
  private rememberQueueKey(key: string, alias: { operationId: string; actor: string; kind: QueueableKind; instanceId: string }): void {
    this.queueKeyAliases.set(key, alias);
    while (this.queueKeyAliases.size > 1000) this.queueKeyAliases.delete(this.queueKeyAliases.keys().next().value!);
  }
  private submittedSettings = new Map<string, Record<string, SettingValue>>();
  takeSubmittedSettings(planId: string): Record<string, SettingValue> {
    const v = this.submittedSettings.get(planId) ?? {};
    this.submittedSettings.delete(planId);
    return v;
  }

  submit(planId: string, idempotencyKey: string, actor: string, opts: SubmitOptions = {}): SubmitResult {
    const { repo, ids } = this.ctx;
    let checked: { store: Record<string, string>; clear: string[] } | null = null;
    let chosen: Record<string, SettingValue> = {};
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
      ({ checked, chosen } = this.acceptPlan(plan, operationId, opts));
      repo.insertOperation({ id: operationId, idempotencyKey, planId, actor, kind: plan.kind, instanceId: plan.instanceId });
      repo.consumePlan(planId, operationId);
      repo.syncActiveOperation(plan.instanceId);
      repo.addEvent({ operationId, instanceId: plan.instanceId, phase: 'queued', message: `${plan.kind} accepted for instance ${plan.proposal.name}` });
      const chosenLines = Object.entries(chosen).map(([id, v]) => {
        const def = (plan.proposal.settings ?? []).find((x) => x.id === id)!;
        return `${def.label}: ${formatSettingValue(def, v)}`;
      });
      if (chosenLines.length) repo.addEvent({ operationId, instanceId: plan.instanceId, phase: 'queued', message: `with the settings you chose: ${chosenLines.join(', ')}` });
      return { operation: repo.operation(operationId)!, created: true };
    });
    if (result.created && checked) this.operatorValues.set(planId, checked);
    if (result.created && Object.keys(chosen).length) this.submittedSettings.set(planId, chosen);
    if (result.created) this.wake();
    return result;
  }

  // Decision 177: the operator withdrew an app's main tailnet address: the every-app policy leaves it off (now or later).
  // Decision 183: noted by the runner when the unexpose runs, not when it is accepted, so an item cancelled while it
  // waited (by a person or a restart) leaves the policy as it was.
  noteTailnetWithdrawal(plan: PlanRow): void {
    if (plan.kind !== 'unexpose' || plan.proposal.exposure?.via !== 'tailnet' || plan.actor === TAILNET_POLICY_ACTOR) return;
    const inst = this.ctx.repo.instance(plan.instanceId);
    let primary: string | null;
    try {
      primary = inst ? this.primaryEndpointOf(inst) : null;
    } catch {
      primary = null;
    }
    if (plan.proposal.exposure.endpointId === primary) this.tailnetAll.operatorWithdrew(plan.instanceId);
  }

  // The accept half of submit, inside its transaction: the submitted values checked, permissions accepted or refused,
  // ports claimed, an install's row created. Decision 183: also accepts a queued action planned at its turn
  // (`queuedOperation` = that operation, already the app's active one).
  private acceptPlan(plan: PlanRow, operationId: string, opts: SubmitOptions, queuedOperation?: string): { checked: { store: Record<string, string>; clear: string[] }; chosen: Record<string, SettingValue> } {
    const { repo } = this.ctx;
    const planId = plan.id;
    const checked = checkSubmittedSecrets((plan.proposal.secrets ?? []) as PlannedSecret[], opts.secrets);
    const chosen = checkSubmittedSettings(plan.proposal.settings ?? [], opts.settings);
    // Decision 163: permissions are accepted by the person approving, never by default. Update-all, auto-update
    // and git redeploys submit without it, so an update that asks for more stops here and waits for a person.
    // Decision 165: so does an update that opens fixed ports the current release does not publish (a release from
    // a compromised catalog or git source would otherwise open a port to the internet with nobody asked).
    const asked = plan.proposal.permissions ?? [];
    const opened = plan.proposal.opensPorts ?? [];
    if ((asked.length || opened.length) && opts.acceptPermissions !== true) {
      const what = [...asked.map((p) => `${p.service} ${p.permission}`), ...opened.map((p) => `open port ${p}`)].join(', ');
      throw new HarborError('PERMISSION_REQUIRED', `${plan.proposal.name} asks for permissions you have not accepted: ${what}`, { nextAction: 'Review them in the plan and approve with them accepted (console: tick the box; CLI: --accept-permissions).' });
    }
    // fixed ports (decision 163): the planner checked them; claim them now, unless this instance already holds one
    const fixedClaims = (instanceId: string) => {
      const claims = repo.claimedPorts();
      for (const p of plan.proposal.ports ?? []) {
        const held = claims.find((c) => c.port === p.hostPort);
        if (held && held.instanceId === instanceId) continue;
        if (held) throw new HarborError('PORT_CONFLICT', `port ${p.hostPort} was claimed by another app since planning`);
        repo.claimPort(p.hostPort, instanceId, fixedPortClaim(p.id));
      }
    };

    if (plan.kind === 'install') {
      if (repo.instanceByName(plan.proposal.name)) throw new HarborError('NAME_CONFLICT', `instance name ${plan.proposal.name} is no longer free`);
      // decision 183: an adopt's id comes from the drive; a row an earlier adopt left when it was cancelled before it
      // ran is brought back for it (purged, never installed), any other existing row is a conflict
      const prior = repo.instance(plan.instanceId);
      const revive = prior !== null && opts.adoptedHome !== undefined && prior.purgedAt !== null && !prior.everInstalled;
      if (prior && !revive) throw new HarborError('STATE_CHANGED', 'plan instance already exists');
      // Install-location plans need their passphrase at submit time (it is
      // never in the plan itself). Refuse here — not at apply — so a missing
      // secret fails fast with a clear error instead of a stuck operation.
      // Default-key plans (data folder) carry no passphrase: pre-seed the
      // marker so the single-use check passes without operator input.
      if (plan.proposal.location && !this.locationSecrets.has(planId)) {
        if (plan.proposal.location.defaultKey === true) this.locationSecrets.set(planId, 'default-key');
        else throw new HarborError('INVALID_REQUEST', 'this plan installs the app encrypted on a drive: submit the encryption passphrase with it', { nextAction: 'Submit again with the passphrase shown at install time.' });
      }
      const claimed = new Set(repo.claimedPorts().map((c) => c.port));
      for (const e of plan.proposal.endpoints) {
        if (claimed.has(e.hostPort)) throw new HarborError('PORT_CONFLICT', `port ${e.hostPort} was claimed by another operation since planning`);
      }
      const row: Parameters<typeof repo.insertInstance>[0] = {
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
      };
      if (revive) {
        if (!repo.reviveInstance(row)) throw new HarborError('STATE_CHANGED', 'plan instance already exists');
      } else repo.insertInstance(row);
      for (const e of plan.proposal.endpoints) repo.claimPort(e.hostPort, plan.instanceId, e.id);
      fixedClaims(plan.instanceId);
      // adopt (adoptApp): the drive's home, recorded with the instance it belongs to, before the runner looks for it
      if (opts.adoptedHome) repo.upsertResource({ instanceId: plan.instanceId, kind: 'volume', role: '__home__', dockerId: null, name: opts.adoptedHome.name, token: null, metadata: opts.adoptedHome.metadata });
    } else {
      const inst = repo.instance(plan.instanceId);
      if (!inst) throw new HarborError('NOT_FOUND', `instance ${plan.instanceId} no longer exists`);
      if (inst.generation !== plan.expectedGeneration) throw new HarborError('STATE_CHANGED', `instance ${inst.name} changed since the plan was created (generation ${inst.generation}, expected ${plan.expectedGeneration})`);
      // a reviewed plan for a busy app waits for it (decision 173); only a queued action joins its queue (decision 183)
      if (inst.activeOperationId && inst.activeOperationId !== queuedOperation) throw new HarborError('BUSY', `instance ${inst.name} has an active operation`, { operationId: inst.activeOperationId });
      fixedClaims(inst.id);
    }
    return { checked, chosen };
  }
}

// Decision 116: an app whose main endpoint does not work at all over plain http (n8n's secure-only
// login cookie, Vaultwarden's WebCrypto vault). `browserContext: secure` alone only means "better on HTTPS".
export function requiresHttps(pkg: LoadedPackage): boolean {
  return pkg.manifest.endpoints[pkg.manifest.ui.primaryEndpoint]?.httpsRequired === true;
}

// Decision 118: the address an operator's own proxy connects from — a literal IP that is not loopback.
export function isProxyAddress(s: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) return s.split('.').every((n) => Number(n) <= 255) && !s.startsWith('127.') && s !== '0.0.0.0';
  return /^[0-9a-f:]+$/i.test(s) && s.includes(':') && s !== '::1' && s !== '::';
}

// Decision 122: where a notification is fixed, by kind (no stored column: derived, so old rows link too).
export function notificationLink(kind: string): string | null {
  if (kind === 'drive-attention' || kind.startsWith('device-') || kind === 'storage-missing') return '#/settings/storage';
  if (kind.startsWith('backup-')) return '#/settings/backups';
  if (kind === 'disk-pressure') return '#/settings/storage';
  if (kind === 'exposure-degraded') return '#/publishing';
  if (kind === 'tailnet-all-failed') return '#/settings/remote';
  if (kind === 'delivery-failed') return '#/settings/notifications';
  if (kind === 'harbor-update') return '#/settings';
  return null;
}

// Decision 183 dedupe (the console's alreadyQueued applies the same rule): a queued action of kind `kind` is the
// existing item X only when X is the app's LAST not-final item (nothing waits after it), X has that kind, X is not
// Harbor's own (an internal actor: a guard's stop, a scheduler's backup, an auto-update), and X still waits. An update
// is different: order and actor do not matter (a second update after any unfinished one, running or waiting, an
// auto-update's included, could only fail with "already runs revision N"), so the first one stands for it.
// `active` = the app's not-final operations in run order.
export function sameQueuedAction<T extends { kind: string; actor: string; state: string; startedAt: string | null }>(active: readonly T[], kind: QueueableKind): T | null {
  if (kind === 'update') return active.find((o) => o.kind === 'update') ?? null;
  const last = active[active.length - 1];
  if (!last || last.kind !== kind) return null;
  if ((INTERNAL_ACTORS as readonly string[]).includes(last.actor.toLowerCase())) return null;
  return last.state === 'queued' && last.startedAt === null ? last : null;
}

// Decision 164: each kind of notification brings its own call to action (first = primary). Derived, not
// stored, like the link; an action that needs an app only appears when the row names one.
export function notificationActions(kind: string, instanceId: string | null): NotificationActionDto[] {
  const route = (label: string, to: string): NotificationActionDto => ({ label, do: 'route', route: to });
  const app = (label: string, d: NotificationActionDto['do']): NotificationActionDto[] => (instanceId ? [{ label, do: d, route: null }] : []);
  switch (kind) {
    case 'harbor-update':
      return [{ label: 'Install now', do: 'update-harbor', route: null }];
    case 'update-available':
      return app('Update now', 'update-app');
    case 'source-commit':
      return app('Update now', 'update-app');
    case 'auto-update-held':
      return [...app('Update now', 'update-app'), route('Open Backups', '#/settings/backups')];
    case 'app-updated':
    case 'app-degraded':
    case 'tailnet-moved':
    case 'link-needs-provider':
    case 'operation-failed':
      return app('Open app', 'open-app');
    case 'home-locked':
      return app('Unlock', 'open-app');
    case 'backup-failed':
    case 'backup-skipped':
    case 'backup-stale':
      return [...app('Back up now', 'back-up-now'), route('Open Backups', '#/settings/backups')];
    case 'backup-target':
      return [route('Open Backups', '#/settings/backups')];
    case 'exposure-degraded':
      return [...app('Open app', 'open-app'), route('Open Publishing', '#/publishing')];
    case 'tailnet-all-failed':
      return [route('Open Remote access', '#/settings/remote'), ...app('Open app', 'open-app')];
    case 'delivery-failed':
      return [route('Check channels', '#/settings/notifications')];
    case 'disk-pressure':
      return [route('See storage', '#/settings/storage')];
    case 'storage-missing':
      return [...app('Open app', 'open-app'), route('Open Storage', '#/settings/storage')];
    default:
      return kind === 'drive-attention' || kind.startsWith('device-') ? [route('Open Storage', '#/settings/storage')] : [];
  }
}
