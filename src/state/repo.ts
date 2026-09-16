import type { Db } from './db.js';
import { rfc3339, type Clock } from '../util.js';

// Thin typed data access. JSON columns hold small immutable nested records.

export type Desired = 'running' | 'stopped' | 'retained';
export type InstallState = 'installing' | 'installed' | 'failed' | 'needs_action' | 'retained';
export type Runtime = 'running' | 'stopped' | 'starting' | 'unavailable' | 'unknown';
export type Readiness = 'healthy' | 'unhealthy' | 'checking' | 'unknown';
export type OperationState = 'queued' | 'applying' | 'verifying' | 'succeeded' | 'failed' | 'needs_action';
export type PlanKind = 'install' | 'start' | 'stop' | 'remove' | 'reinstall' | 'purge' | 'update' | 'expose' | 'unexpose' | 'reconfigure';
export type ExposureVia = 'tailnet' | 'public';
export type PrimaryExposure = 'loopback' | ExposureVia;

export interface EndpointAllocation {
  id: string;
  service: string;
  containerPort: number;
  hostPort: number;
}
export interface SecretReference {
  id: string;
  file: string; // relative to instance dir
}

export interface InstanceRow {
  id: string;
  name: string;
  project: string;
  packageId: string;
  revision: string;
  generation: number;
  desired: Desired;
  installState: InstallState;
  runtime: Runtime;
  readiness: Readiness;
  observedAt: string | null;
  everInstalled: boolean;
  releaseDir: string;
  releaseHashes: Record<string, string>;
  endpoints: EndpointAllocation[];
  secrets: SecretReference[];
  activeOperationId: string | null;
  lastOperationId: string | null;
  createdAt: string;
  updatedAt: string;
  primaryExposure: PrimaryExposure;
  // set by a full uninstall; purged rows are hidden from listings, keep audit history and never reuse ports
  purgedAt: string | null;
  // how the operator wants this app to look on the launcher (null = the package's own name/icon)
  displayName: string | null;
  icon: InstanceIcon | null;
  // opt-in automatic updates (decision 78); the daily check submits the plan itself when set
  autoUpdate: boolean;
}

export interface NotificationRow {
  id: string;
  createdAt: string;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  instanceId: string | null;
  dedupeKey: string;
  readAt: string | null;
  deliveredAt: string | null;
}

export interface PackageSourceRow {
  id: string;
  kind: 'git';
  url: string;
  ref: string;
  subpath: string | null;
  pinnedCommit: string | null;
  lastSeenCommit: string | null;
  autoRedeploy: boolean;
  packageId: string;
  createdAt: string;
  checkedAt: string | null;
  note: string | null;
}

// A custom launcher icon: a glyph on a colour, or a picture stored at <stateDir>/icons/<instanceId>.bin
export type InstanceIcon = { kind: 'glyph'; glyph: string; color: string } | { kind: 'image'; contentType: string; version: string };

export interface ExposureRow {
  id: string;
  instanceId: string;
  endpointId: string;
  via: ExposureVia;
  hostname: string;
  port: number;
  protection: 'none' | 'basic';
  state: 'pending' | 'active' | 'degraded' | 'removing';
  observedAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface PlanRow {
  id: string;
  actor: string;
  kind: PlanKind;
  instanceId: string;
  proposal: PlanProposal;
  expectedGeneration: number;
  createdAt: string;
  expiresAt: string;
  consumedOperationId: string | null;
}

export interface DomainRow {
  hostname: string;
  createdAt: string;
  checkedAt: string | null;
  dnsState: 'points_here' | 'points_elsewhere' | 'no_record' | 'unknown';
  addresses: string[];
  note: string | null;
}
function domainFrom(r: Raw): DomainRow {
  return { hostname: r['hostname'] as string, createdAt: r['created_at'] as string, checkedAt: (r['checked_at'] as string | null) ?? null, dnsState: r['dns_state'] as DomainRow['dnsState'], addresses: pj(r['addresses_json'], [] as string[]), note: (r['note'] as string | null) ?? null };
}

export interface PlanProposal {
  packageId: string;
  revision: string;
  name: string;
  project: string;
  endpoints: EndpointAllocation[];
  // external claims: hostPath set, volumeName null (nothing is created in Docker)
  storage: { id: string; composeVolume: string; volumeName: string | null; purpose: string; hostPath?: string; readOnly?: boolean }[];
  secrets: { id: string }[];
  changes: string[];
  warnings: string[];
  releaseHashes: Record<string, string>;
  // expose/unexpose/reconfigure payloads (absent for lifecycle kinds)
  exposure?: { endpointId: string; via: ExposureVia; hostname: string; port: number; protection: 'none' | 'basic'; makePrimary: boolean };
  primary?: PrimaryExposure;
  // update plans: what changes between the installed release and the new one
  update?: { fromRevision: string; toRevision: string; fromVersion: string | null; toVersion: string | null; images: { service: string; from: string; to: string }[]; newSecrets: string[]; newStorage: string[]; newEndpoints: string[]; releaseNotes: string | null };
}

export interface OperationRow {
  id: string;
  idempotencyKey: string;
  planId: string;
  actor: string;
  kind: PlanKind;
  instanceId: string;
  state: OperationState;
  phase: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextAction: string | null;
  result: Record<string, unknown> | null;
}

export interface ResourceRow {
  id: number;
  instanceId: string;
  kind: 'container' | 'volume' | 'network' | 'bind';
  role: string;
  dockerId: string | null;
  name: string;
  token: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface EventRow {
  cursor: number;
  operationId: string | null;
  instanceId: string | null;
  at: string;
  phase: string;
  message: string;
}

export interface PlatformToolRow {
  id: string;
  mode: 'managed' | 'external' | 'absent';
  browserUrl: string | null;
  installationState: 'installed' | 'not_installed' | 'setup_required' | 'unknown';
  availability: 'reachable' | 'unreachable' | 'unknown';
  observedAt: string | null;
  note: string | null;
  resources: Record<string, unknown> | null;
  updatedAt: string;
}

type Raw = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(s: unknown, fallback: T): T => (typeof s === 'string' ? (JSON.parse(s) as T) : fallback);

function instanceFrom(r: Raw): InstanceRow {
  return {
    id: r['id'] as string,
    name: r['name'] as string,
    project: r['project'] as string,
    packageId: r['package_id'] as string,
    revision: r['revision'] as string,
    generation: r['generation'] as number,
    desired: r['desired'] as Desired,
    installState: r['install_state'] as InstallState,
    runtime: r['runtime'] as Runtime,
    readiness: r['readiness'] as Readiness,
    observedAt: (r['observed_at'] as string | null) ?? null,
    everInstalled: r['ever_installed'] === 1,
    releaseDir: r['release_dir'] as string,
    releaseHashes: pj(r['release_hashes_json'], {}),
    endpoints: pj(r['endpoints_json'], []),
    secrets: pj(r['secrets_json'], []),
    activeOperationId: (r['active_operation_id'] as string | null) ?? null,
    lastOperationId: (r['last_operation_id'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
    primaryExposure: ((r['primary_exposure'] as string | undefined) ?? 'loopback') as PrimaryExposure,
    purgedAt: (r['purged_at'] as string | null) ?? null,
    displayName: (r['display_name'] as string | null) ?? null,
    icon: pj<InstanceIcon | null>(r['icon_json'], null),
    autoUpdate: r['auto_update'] === 1,
  };
}

function notificationFrom(r: Raw): NotificationRow {
  return {
    id: r['id'] as string,
    createdAt: r['created_at'] as string,
    kind: r['kind'] as string,
    severity: r['severity'] as NotificationRow['severity'],
    title: r['title'] as string,
    body: r['body'] as string,
    instanceId: (r['instance_id'] as string | null) ?? null,
    dedupeKey: r['dedupe_key'] as string,
    readAt: (r['read_at'] as string | null) ?? null,
    deliveredAt: (r['delivered_at'] as string | null) ?? null,
  };
}

function packageSourceFrom(r: Raw): PackageSourceRow {
  return {
    id: r['id'] as string,
    kind: r['kind'] as 'git',
    url: r['url'] as string,
    ref: r['ref'] as string,
    subpath: (r['subpath'] as string | null) ?? null,
    pinnedCommit: (r['pinned_commit'] as string | null) ?? null,
    lastSeenCommit: (r['last_seen_commit'] as string | null) ?? null,
    autoRedeploy: r['auto_redeploy'] === 1,
    packageId: r['package_id'] as string,
    createdAt: r['created_at'] as string,
    checkedAt: (r['checked_at'] as string | null) ?? null,
    note: (r['note'] as string | null) ?? null,
  };
}
function exposureFrom(r: Raw): ExposureRow {
  return {
    id: r['id'] as string,
    instanceId: r['instance_id'] as string,
    endpointId: r['endpoint_id'] as string,
    via: r['via'] as ExposureVia,
    hostname: r['hostname'] as string,
    port: r['port'] as number,
    protection: r['protection'] as ExposureRow['protection'],
    state: r['state'] as ExposureRow['state'],
    observedAt: (r['observed_at'] as string | null) ?? null,
    note: (r['note'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  };
}
function planFrom(r: Raw): PlanRow {
  return {
    id: r['id'] as string,
    actor: r['actor'] as string,
    kind: r['kind'] as PlanKind,
    instanceId: r['instance_id'] as string,
    proposal: pj(r['proposal_json'], {} as PlanProposal),
    expectedGeneration: r['expected_generation'] as number,
    createdAt: r['created_at'] as string,
    expiresAt: r['expires_at'] as string,
    consumedOperationId: (r['consumed_operation_id'] as string | null) ?? null,
  };
}
function operationFrom(r: Raw): OperationRow {
  return {
    id: r['id'] as string,
    idempotencyKey: r['idempotency_key'] as string,
    planId: r['plan_id'] as string,
    actor: r['actor'] as string,
    kind: r['kind'] as PlanKind,
    instanceId: r['instance_id'] as string,
    state: r['state'] as OperationState,
    phase: r['phase'] as string,
    createdAt: r['created_at'] as string,
    startedAt: (r['started_at'] as string | null) ?? null,
    finishedAt: (r['finished_at'] as string | null) ?? null,
    errorCode: (r['error_code'] as string | null) ?? null,
    errorMessage: (r['error_message'] as string | null) ?? null,
    nextAction: (r['next_action'] as string | null) ?? null,
    result: pj(r['result_json'], null),
  };
}
function resourceFrom(r: Raw): ResourceRow {
  return {
    id: r['id'] as number,
    instanceId: r['instance_id'] as string,
    kind: r['kind'] as ResourceRow['kind'],
    role: r['role'] as string,
    dockerId: (r['docker_id'] as string | null) ?? null,
    name: r['name'] as string,
    token: (r['token'] as string | null) ?? null,
    metadata: pj(r['metadata_json'], null),
    createdAt: r['created_at'] as string,
  };
}
function eventFrom(r: Raw): EventRow {
  return {
    cursor: r['cursor'] as number,
    operationId: (r['operation_id'] as string | null) ?? null,
    instanceId: (r['instance_id'] as string | null) ?? null,
    at: r['at'] as string,
    phase: r['phase'] as string,
    message: r['message'] as string,
  };
}
function toolFrom(r: Raw): PlatformToolRow {
  return {
    id: r['id'] as string,
    mode: r['mode'] as PlatformToolRow['mode'],
    browserUrl: (r['browser_url'] as string | null) ?? null,
    installationState: r['installation_state'] as PlatformToolRow['installationState'],
    availability: r['availability'] as PlatformToolRow['availability'],
    observedAt: (r['observed_at'] as string | null) ?? null,
    note: (r['note'] as string | null) ?? null,
    resources: pj(r['resources_json'], null),
    updatedAt: r['updated_at'] as string,
  };
}

export class Repo {
  constructor(
    readonly db: Db,
    readonly clock: Clock,
  ) {}

  now(): string {
    return rfc3339(this.clock.now());
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // installation / administrator
  installation(): { id: string; schemaVersion: number; createdAt: string; config: Record<string, unknown> } {
    const r = this.db.prepare('SELECT * FROM installation').get() as Raw;
    return { id: r['id'] as string, schemaVersion: r['schema_version'] as number, createdAt: r['created_at'] as string, config: pj(r['config_json'], {}) };
  }
  administrator(): { username: string; passwordHash: string; salt: string; params: Record<string, number> } | null {
    const r = this.db.prepare('SELECT * FROM administrator WHERE id = 1').get() as Raw | undefined;
    if (!r) return null;
    return { username: r['username'] as string, passwordHash: r['password_hash'] as string, salt: r['salt'] as string, params: pj(r['params_json'], {}) };
  }
  setAdministrator(a: { username: string; passwordHash: string; salt: string; params: Record<string, number> }): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO administrator (id, username, password_hash, salt, params_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, salt = excluded.salt, params_json = excluded.params_json, updated_at = excluded.updated_at`,
      )
      .run(a.username, a.passwordHash, a.salt, j(a.params), now, now);
  }

  // sessions
  insertSession(tokenHash: string, actor: string, expiresAt: string, kind: 'session' | 'remember' = 'session'): void {
    this.db.prepare('INSERT INTO sessions (token_hash, actor, created_at, expires_at, kind, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(tokenHash, actor, this.now(), expiresAt, kind, this.now());
  }
  session(tokenHash: string): { actor: string; expiresAt: string; revokedAt: string | null; kind: 'session' | 'remember' } | null {
    const r = this.db.prepare('SELECT actor, expires_at, revoked_at, kind FROM sessions WHERE token_hash = ?').get(tokenHash) as Raw | undefined;
    return r ? { actor: r['actor'] as string, expiresAt: r['expires_at'] as string, revokedAt: (r['revoked_at'] as string | null) ?? null, kind: ((r['kind'] as string | undefined) ?? 'session') as 'session' | 'remember' } : null;
  }
  touchSession(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(this.now(), tokenHash);
  }
  listSessions(currentHash: string): { createdAt: string; expiresAt: string; lastSeenAt: string | null; kind: 'session' | 'remember'; current: boolean }[] {
    return (this.db.prepare('SELECT token_hash, created_at, expires_at, last_seen_at, kind FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 20').all() as Raw[]).map((r) => ({
      createdAt: r['created_at'] as string,
      expiresAt: r['expires_at'] as string,
      lastSeenAt: (r['last_seen_at'] as string | null) ?? null,
      kind: ((r['kind'] as string | undefined) ?? 'session') as 'session' | 'remember',
      current: (r['token_hash'] as string) === currentHash,
    }));
  }
  revokeSession(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(this.now(), tokenHash);
  }
  // Everything except the caller's own session (after a password change).
  revokeOtherSessions(keepTokenHash: string): number {
    return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND token_hash <> ?').run(this.now(), keepTokenHash).changes;
  }

  revokeAllSessions(): number {
    return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(this.now()).changes;
  }
  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').run(this.now());
  }

  // instances
  listInstances(): InstanceRow[] {
    return (this.db.prepare('SELECT * FROM instances WHERE purged_at IS NULL ORDER BY created_at, name').all() as Raw[]).map(instanceFrom);
  }
  // Full uninstall: the row stays for audit (operations/events reference it) but leaves every namespace.
  purgeInstance(id: string, archivedName: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM port_claims WHERE instance_id = ?').run(id);
      this.db.prepare('DELETE FROM resources WHERE instance_id = ?').run(id);
      this.db.prepare('DELETE FROM exposures WHERE instance_id = ?').run(id);
      this.db
        .prepare(`UPDATE instances SET purged_at = ?, name = ?, desired = 'retained', install_state = 'retained', runtime = 'stopped', readiness = 'unknown', endpoints_json = '[]', secrets_json = '[]', active_operation_id = NULL, display_name = NULL, icon_json = NULL, updated_at = ? WHERE id = ?`)
        .run(now, archivedName, now, id);
    })();
  }
  instance(id: string): InstanceRow | null {
    const r = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as Raw | undefined;
    return r ? instanceFrom(r) : null;
  }
  instanceByName(name: string): InstanceRow | null {
    const r = this.db.prepare('SELECT * FROM instances WHERE name = ? AND purged_at IS NULL').get(name) as Raw | undefined;
    return r ? instanceFrom(r) : null;
  }
  insertInstance(i: Omit<InstanceRow, 'createdAt' | 'updatedAt' | 'observedAt' | 'lastOperationId' | 'primaryExposure' | 'purgedAt' | 'displayName' | 'icon' | 'autoUpdate'> & { autoUpdate?: boolean }): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO instances (id, name, project, package_id, revision, generation, desired, install_state, runtime, readiness, observed_at, ever_installed,
          release_dir, release_hashes_json, endpoints_json, secrets_json, active_operation_id, last_operation_id, created_at, updated_at, auto_update)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        i.id, i.name, i.project, i.packageId, i.revision, i.generation, i.desired, i.installState, i.runtime, i.readiness,
        i.everInstalled ? 1 : 0, i.releaseDir, j(i.releaseHashes), j(i.endpoints), j(i.secrets), i.activeOperationId, now, now, i.autoUpdate ? 1 : 0,
      );
  }
  updateInstance(id: string, patch: Partial<Pick<InstanceRow, 'desired' | 'installState' | 'runtime' | 'readiness' | 'observedAt' | 'everInstalled' | 'activeOperationId' | 'lastOperationId' | 'secrets' | 'generation' | 'primaryExposure'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      desired: 'desired', installState: 'install_state', runtime: 'runtime', readiness: 'readiness', observedAt: 'observed_at',
      everInstalled: 'ever_installed', activeOperationId: 'active_operation_id', lastOperationId: 'last_operation_id', secrets: 'secrets_json', generation: 'generation',
      primaryExposure: 'primary_exposure',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(k === 'everInstalled' ? (v ? 1 : 0) : k === 'secrets' ? j(v) : v);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(this.now(), id);
    this.db.prepare(`UPDATE instances SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  setInstanceAppearance(id: string, patch: { displayName?: string | null; icon?: InstanceIcon | null }): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      vals.push(patch.displayName);
    }
    if (patch.icon !== undefined) {
      sets.push('icon_json = ?');
      vals.push(patch.icon ? j(patch.icon) : null);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    vals.push(this.now(), id);
    this.db.prepare(`UPDATE instances SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  setAutoUpdate(id: string, on: boolean): void {
    this.db.prepare('UPDATE instances SET auto_update = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, this.now(), id);
  }

  // ---- notifications (decision 77): a persisting condition upserts one row by dedupe key.
  // A row that was read stays read while the condition persists; a new condition (new key) is a new row.
  upsertNotification(n: { id: string; kind: string; severity: NotificationRow['severity']; title: string; body: string; instanceId?: string | null; dedupeKey: string }): { created: boolean; row: NotificationRow } {
    const existing = this.db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?').get(n.dedupeKey) as Raw | undefined;
    if (existing) {
      this.db.prepare('UPDATE notifications SET title = ?, body = ?, severity = ? WHERE dedupe_key = ?').run(n.title, n.body, n.severity, n.dedupeKey);
      return { created: false, row: notificationFrom(this.db.prepare('SELECT * FROM notifications WHERE dedupe_key = ?').get(n.dedupeKey) as Raw) };
    }
    this.db
      .prepare('INSERT INTO notifications (id, created_at, kind, severity, title, body, instance_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(n.id, this.now(), n.kind, n.severity, n.title, n.body, n.instanceId ?? null, n.dedupeKey);
    return { created: true, row: notificationFrom(this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(n.id) as Raw) };
  }
  notifications(opts: { unreadOnly?: boolean; limit?: number } = {}): NotificationRow[] {
    const where = opts.unreadOnly ? 'WHERE read_at IS NULL' : '';
    return (this.db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(opts.limit ?? 100) as Raw[]).map(notificationFrom);
  }
  unreadNotificationCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
  }
  markNotificationRead(id: string): boolean {
    return this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(this.now(), id).changes > 0;
  }
  markAllNotificationsRead(): number {
    return this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(this.now()).changes;
  }
  markNotificationDelivered(id: string): void {
    this.db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ?').run(this.now(), id);
  }
  // Resolved conditions disappear from the bell when unread (e.g. an update was applied); read rows stay as history.
  deleteNotificationByKey(dedupeKey: string): void {
    this.db.prepare('DELETE FROM notifications WHERE dedupe_key = ? AND read_at IS NULL').run(dedupeKey);
  }
  pruneNotifications(keep: number): void {
    this.db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?)').run(keep);
  }

  // ---- git package sources (decision 80)
  insertPackageSource(s: Omit<PackageSourceRow, 'createdAt' | 'checkedAt'>): void {
    this.db
      .prepare('INSERT INTO package_sources (id, kind, url, ref, subpath, pinned_commit, last_seen_commit, auto_redeploy, package_id, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.kind, s.url, s.ref, s.subpath, s.pinnedCommit, s.lastSeenCommit, s.autoRedeploy ? 1 : 0, s.packageId, this.now(), s.note);
  }
  packageSources(): PackageSourceRow[] {
    return (this.db.prepare('SELECT * FROM package_sources ORDER BY created_at').all() as Raw[]).map(packageSourceFrom);
  }
  packageSource(id: string): PackageSourceRow | null {
    const r = this.db.prepare('SELECT * FROM package_sources WHERE id = ?').get(id) as Raw | undefined;
    return r ? packageSourceFrom(r) : null;
  }
  packageSourceByPackage(packageId: string): PackageSourceRow | null {
    const r = this.db.prepare('SELECT * FROM package_sources WHERE package_id = ?').get(packageId) as Raw | undefined;
    return r ? packageSourceFrom(r) : null;
  }
  updatePackageSource(id: string, patch: Partial<Pick<PackageSourceRow, 'pinnedCommit' | 'lastSeenCommit' | 'autoRedeploy' | 'checkedAt' | 'note' | 'ref'>>): void {
    const map: Record<string, string> = { pinnedCommit: 'pinned_commit', lastSeenCommit: 'last_seen_commit', autoRedeploy: 'auto_redeploy', checkedAt: 'checked_at', note: 'note', ref: 'ref' };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${map[k]} = ?`);
      vals.push(k === 'autoRedeploy' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE package_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  deletePackageSource(id: string): void {
    this.db.prepare('DELETE FROM package_sources WHERE id = ?').run(id);
  }

  // ---- per-installation settings (small JSON documents; appearance, home layout)
  setting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as Raw | undefined;
    return r ? pj<T | null>(r['value_json'], null) : null;
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').run(key, j(value), this.now());
  }
  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  // update: the instance is bound to a new release (revision, hashes, endpoint allocations)
  updateInstanceRelease(id: string, r: { revision: string; releaseHashes: Record<string, string>; endpoints: EndpointAllocation[] }): void {
    this.db.prepare('UPDATE instances SET revision = ?, release_hashes_json = ?, endpoints_json = ?, updated_at = ? WHERE id = ?').run(r.revision, j(r.releaseHashes), j(r.endpoints), this.now(), id);
  }
  bumpGeneration(id: string): number {
    this.db.prepare('UPDATE instances SET generation = generation + 1, updated_at = ? WHERE id = ?').run(this.now(), id);
    return (this.db.prepare('SELECT generation FROM instances WHERE id = ?').get(id) as { generation: number }).generation;
  }

  // ports
  claimedPorts(): { port: number; instanceId: string; endpointId: string }[] {
    return (this.db.prepare('SELECT port, instance_id, endpoint_id FROM port_claims').all() as Raw[]).map((r) => ({
      port: r['port'] as number,
      instanceId: r['instance_id'] as string,
      endpointId: r['endpoint_id'] as string,
    }));
  }
  claimPort(port: number, instanceId: string, endpointId: string): void {
    this.db.prepare('INSERT INTO port_claims (port, instance_id, endpoint_id) VALUES (?, ?, ?)').run(port, instanceId, endpointId);
  }

  // plans
  insertPlan(p: Omit<PlanRow, 'consumedOperationId'>): void {
    this.db
      .prepare('INSERT INTO plans (id, actor, kind, instance_id, proposal_json, expected_generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.actor, p.kind, p.instanceId, j(p.proposal), p.expectedGeneration, p.createdAt, p.expiresAt);
  }
  plan(id: string): PlanRow | null {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Raw | undefined;
    return r ? planFrom(r) : null;
  }
  consumePlan(id: string, operationId: string): void {
    this.db.prepare('UPDATE plans SET consumed_operation_id = ? WHERE id = ?').run(operationId, id);
  }

  // operations
  insertOperation(o: Pick<OperationRow, 'id' | 'idempotencyKey' | 'planId' | 'actor' | 'kind' | 'instanceId'>): void {
    this.db
      .prepare('INSERT INTO operations (id, idempotency_key, plan_id, actor, kind, instance_id, state, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.id, o.idempotencyKey, o.planId, o.actor, o.kind, o.instanceId, 'queued', 'queued', this.now());
  }
  operation(id: string): OperationRow | null {
    const r = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as Raw | undefined;
    return r ? operationFrom(r) : null;
  }
  operationByIdempotencyKey(key: string): OperationRow | null {
    const r = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(key) as Raw | undefined;
    return r ? operationFrom(r) : null;
  }
  operationByPlan(planId: string): OperationRow | null {
    const r = this.db.prepare('SELECT * FROM operations WHERE plan_id = ?').get(planId) as Raw | undefined;
    return r ? operationFrom(r) : null;
  }
  nextQueuedOperation(): OperationRow | null {
    const r = this.db.prepare("SELECT * FROM operations WHERE state = 'queued' ORDER BY created_at, id LIMIT 1").get() as Raw | undefined;
    return r ? operationFrom(r) : null;
  }
  activeOperations(): OperationRow[] {
    return (this.db.prepare("SELECT * FROM operations WHERE state IN ('queued','applying','verifying') ORDER BY created_at").all() as Raw[]).map(operationFrom);
  }
  listOperations(limit = 100): OperationRow[] {
    return (this.db.prepare('SELECT * FROM operations ORDER BY created_at DESC LIMIT ?').all(limit) as Raw[]).map(operationFrom);
  }
  setOperationPhase(id: string, state: OperationState, phase: string): void {
    const started = state === 'applying' ? ', started_at = COALESCE(started_at, ?)' : '';
    const args: unknown[] = [state, phase];
    if (started) args.push(this.now());
    args.push(id);
    this.db.prepare(`UPDATE operations SET state = ?, phase = ?${started} WHERE id = ?`).run(...args);
  }
  finishOperation(id: string, state: 'succeeded' | 'failed' | 'needs_action', opts: { errorCode?: string; errorMessage?: string; nextAction?: string; result?: Record<string, unknown> } = {}): void {
    this.db
      .prepare('UPDATE operations SET state = ?, phase = ?, finished_at = ?, error_code = ?, error_message = ?, next_action = ?, result_json = ? WHERE id = ?')
      .run(state, state, this.now(), opts.errorCode ?? null, opts.errorMessage ?? null, opts.nextAction ?? null, opts.result ? j(opts.result) : null, id);
  }

  // resources
  resources(instanceId: string): ResourceRow[] {
    return (this.db.prepare('SELECT * FROM resources WHERE instance_id = ? ORDER BY kind, role').all(instanceId) as Raw[]).map(resourceFrom);
  }
  upsertResource(r: Omit<ResourceRow, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO resources (instance_id, kind, role, docker_id, name, token, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, kind, role) DO UPDATE SET docker_id = excluded.docker_id, name = excluded.name, token = COALESCE(excluded.token, resources.token), metadata_json = excluded.metadata_json`,
      )
      .run(r.instanceId, r.kind, r.role, r.dockerId, r.name, r.token, r.metadata ? j(r.metadata) : null, this.now());
  }
  deleteResource(instanceId: string, kind: ResourceRow['kind'], role: string): void {
    this.db.prepare('DELETE FROM resources WHERE instance_id = ? AND kind = ? AND role = ?').run(instanceId, kind, role);
  }

  // events
  addEvent(e: { operationId?: string | null; instanceId?: string | null; phase: string; message: string }): number {
    const info = this.db.prepare('INSERT INTO events (operation_id, instance_id, at, phase, message) VALUES (?, ?, ?, ?, ?)').run(e.operationId ?? null, e.instanceId ?? null, this.now(), e.phase, e.message);
    return Number(info.lastInsertRowid);
  }
  eventsForOperation(operationId: string, limit = 200): EventRow[] {
    return (this.db.prepare('SELECT * FROM events WHERE operation_id = ? ORDER BY cursor LIMIT ?').all(operationId, limit) as Raw[]).map(eventFrom);
  }
  eventsForInstance(instanceId: string, limit = 100): EventRow[] {
    return (this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE instance_id = ? ORDER BY cursor DESC LIMIT ?) ORDER BY cursor').all(instanceId, limit) as Raw[]).map(eventFrom);
  }

  // exposures
  exposures(instanceId?: string): ExposureRow[] {
    const rows = instanceId
      ? (this.db.prepare('SELECT * FROM exposures WHERE instance_id = ? ORDER BY via, endpoint_id').all(instanceId) as Raw[])
      : (this.db.prepare('SELECT * FROM exposures ORDER BY created_at').all() as Raw[]);
    return rows.map(exposureFrom);
  }
  exposure(id: string): ExposureRow | null {
    const r = this.db.prepare('SELECT * FROM exposures WHERE id = ?').get(id) as Raw | undefined;
    return r ? exposureFrom(r) : null;
  }
  exposureFor(instanceId: string, endpointId: string, via: ExposureVia): ExposureRow | null {
    const r = this.db.prepare('SELECT * FROM exposures WHERE instance_id = ? AND endpoint_id = ? AND via = ?').get(instanceId, endpointId, via) as Raw | undefined;
    return r ? exposureFrom(r) : null;
  }
  exposureByAddress(via: ExposureVia, hostname: string, port: number): ExposureRow | null {
    const r = this.db.prepare('SELECT * FROM exposures WHERE via = ? AND hostname = ? AND port = ?').get(via, hostname, port) as Raw | undefined;
    return r ? exposureFrom(r) : null;
  }
  insertExposure(e: Omit<ExposureRow, 'createdAt' | 'observedAt'>): void {
    this.db
      .prepare('INSERT INTO exposures (id, instance_id, endpoint_id, via, hostname, port, protection, state, observed_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(e.id, e.instanceId, e.endpointId, e.via, e.hostname, e.port, e.protection, e.state, e.note, this.now());
  }
  updateExposure(id: string, patch: Partial<Pick<ExposureRow, 'state' | 'note' | 'observedAt'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.state !== undefined) { sets.push('state = ?'); vals.push(patch.state); }
    if (patch.note !== undefined) { sets.push('note = ?'); vals.push(patch.note); }
    if (patch.observedAt !== undefined) { sets.push('observed_at = ?'); vals.push(patch.observedAt); }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE exposures SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  updateExposureHostname(id: string, hostname: string): void {
    this.db.prepare('UPDATE exposures SET hostname = ? WHERE id = ?').run(hostname, id);
  }
  deleteExposure(id: string): void {
    this.db.prepare('DELETE FROM exposures WHERE id = ?').run(id);
  }

  // platform tools
  platformTools(): PlatformToolRow[] {
    return (this.db.prepare('SELECT * FROM platform_tools ORDER BY id').all() as Raw[]).map(toolFrom);
  }
  platformTool(id: string): PlatformToolRow | null {
    const r = this.db.prepare('SELECT * FROM platform_tools WHERE id = ?').get(id) as Raw | undefined;
    return r ? toolFrom(r) : null;
  }
  // ---- registered public domains (docs/design/EXPOSURE.md, domains wizard)
  domains(): DomainRow[] {
    return (this.db.prepare('SELECT * FROM domains ORDER BY hostname').all() as Raw[]).map(domainFrom);
  }
  domain(hostname: string): DomainRow | null {
    const r = this.db.prepare('SELECT * FROM domains WHERE hostname = ?').get(hostname) as Raw | undefined;
    return r ? domainFrom(r) : null;
  }
  insertDomain(hostname: string): void {
    this.db.prepare('INSERT INTO domains (hostname, created_at) VALUES (?, ?)').run(hostname, this.now());
  }
  updateDomainCheck(hostname: string, dnsState: DomainRow['dnsState'], addresses: string[], note: string | null): void {
    this.db.prepare('UPDATE domains SET checked_at = ?, dns_state = ?, addresses_json = ?, note = ? WHERE hostname = ?').run(this.now(), dnsState, j(addresses), note, hostname);
  }
  deleteDomain(hostname: string): void {
    this.db.prepare('DELETE FROM domains WHERE hostname = ?').run(hostname);
  }

  upsertPlatformTool(t: Omit<PlatformToolRow, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO platform_tools (id, mode, browser_url, installation_state, availability, observed_at, note, resources_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, browser_url = excluded.browser_url, installation_state = excluded.installation_state, availability = excluded.availability,
           observed_at = excluded.observed_at, note = excluded.note, resources_json = excluded.resources_json, updated_at = excluded.updated_at`,
      )
      .run(t.id, t.mode, t.browserUrl, t.installationState, t.availability, t.observedAt, t.note, t.resources ? j(t.resources) : null, this.now());
  }
}
