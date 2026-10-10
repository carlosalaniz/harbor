// The contract between the daemon and the root backup step `harbor-backup@<requestId>` (decision 153).
// PURE: names, paths, request/status shapes and their validation. Mirrors src/storage/fscrypt.ts.
//
// The daemon writes <stateDir>/backup/requests/<id>/request.json (never a secret), streams one JSON
// document of secrets through secrets.fifo (repository password, target credentials, the app's state
// slice), and blocks on `systemctl start harbor-backup@<id>.service`. Root answers in status.json
// (non-secret results), progress.json (long runs) and, for restore-meta only, out.fifo (the restored
// state slice holds secrets, so it never touches disk on the way back).
import { HarborError } from '../errors.js';
import { UUID_RE } from '../contracts/patterns.js';
import type { TargetRuntime, Retention, SnapshotInfo, RepoKey } from './restic.js';

export const BACKUP_UNIT_PREFIX = 'harbor-backup@';
export const BACKUP_UNIT_FILE = 'harbor-backup@.service';
// Root-only places (created by the root step itself, 0700): rclone keeps its Proton session in a
// config file the harbor user must not be able to read or rewrite.
export const BACKUP_ROOT_STATE = '/var/lib/harbor-backup';
// tmpfs: private files for one run (ssh key, known_hosts) and the app's state slice while it is read
export const BACKUP_RUN_DIR = '/run/harbor-backup';

export const BACKUP_ACTIONS = ['test', 'init', 'keys', 'add-key', 'remove-key', 'backup', 'snapshots', 'restore-meta', 'restore-data', 'forget', 'prune', 'check', 'unlock', 'forget-target'] as const;
export type BackupAction = (typeof BACKUP_ACTIONS)[number];

export function backupUnit(requestId: string): string {
  if (!UUID_RE.test(requestId)) throw new HarborError('INVALID_REQUEST', `invalid backup request id ${requestId}`);
  return `${BACKUP_UNIT_PREFIX}${requestId}.service`;
}
export function parseBackupSpec(spec: string): string {
  if (!UUID_RE.test(spec)) throw new HarborError('INVALID_REQUEST', `backup-step expects a request id, got ${spec}`);
  return spec;
}

export function backupRequestFiles(stateDir: string, requestId: string): { dir: string; request: string; secrets: string; status: string; progress: string; out: string } {
  const dir = `${stateDir}/backup/requests/${requestId}`;
  return { dir, request: `${dir}/request.json`, secrets: `${dir}/secrets.fifo`, status: `${dir}/status.json`, progress: `${dir}/progress.json`, out: `${dir}/out.fifo` };
}
export function rcloneConfFor(targetId: string): string {
  if (!UUID_RE.test(targetId)) throw new HarborError('INVALID_REQUEST', `invalid target id ${targetId}`);
  return `${BACKUP_ROOT_STATE}/${targetId}/rclone.conf`;
}
// The state slice of one app, per target: a stable path, so restic finds the previous snapshot of the
// same (host, paths) as parent and only re-reads files that changed.
export function stageDirFor(instanceId: string, targetId: string): string {
  if (!UUID_RE.test(instanceId) || !UUID_RE.test(targetId)) throw new HarborError('INVALID_REQUEST', 'invalid stage ids');
  return `${BACKUP_RUN_DIR}/stage/${instanceId}/${targetId}`;
}
export function isStagePath(p: string): boolean {
  return /^\/run\/harbor-backup\/stage\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(p);
}

// What a snapshot of one app contains besides its home: `harbor-app/` inside the stage dir.
export const STAGE_FOLDER = 'harbor-app';
export interface StageFile {
  path: string; // relative, e.g. instance.json, secrets/db-password, release/manifest.yaml
  base64: string;
}
export interface InstanceRecord {
  format: 1;
  instanceId: string;
  name: string;
  displayName: string | null;
  packageId: string;
  revision: string;
  home: string;
  installationId: string;
  harborVersion: string;
  at: string;
}
export const MAX_STAGE_BYTES = 64 * 1024 * 1024;
export function isSafeStagePath(p: string): boolean {
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,8}$/.test(p) && !p.split('/').some((s) => s === '.' || s === '..');
}

export interface BackupRequest {
  action: BackupAction;
  target: TargetRuntime;
  requestedAt: string;
  // backup
  instanceId?: string;
  home?: string;
  tags?: string[];
  deadlineSeconds?: number; // root stops restic (SIGINT, no snapshot) when it is reached
  // restore
  snapshotId?: string;
  sourceHome?: string;
  sourceStage?: string;
  destHome?: string;
  // forget / check / keys
  retention?: Retention;
  snapshotIds?: string[];
  prune?: boolean;
  checkSubset?: number;
  keyLabel?: string;
  keyId?: string;
  filterTags?: string;
}

// The one secrets document (FIFO). `password` opens the repository; `newPassword` is what add-key adds
// (init adds it as the second key); `stage` is the app's state slice for backup.
export interface BackupSecrets {
  password: string;
  target: Record<string, string>;
  newPassword?: string;
  stage?: StageFile[];
}

export interface BackupResult {
  repo?: 'missing' | 'ours' | 'foreign';
  hostKey?: string; // sftp: the key the server showed (pinned by the daemon)
  snapshotId?: string;
  dataAdded?: number;
  totalBytes?: number;
  filesNew?: number;
  filesChanged?: number;
  durationSeconds?: number;
  partial?: boolean;
  snapshots?: SnapshotInfo[];
  keys?: RepoKey[];
  removed?: number;
  checked?: string;
}
export interface BackupStatus {
  action: BackupAction;
  state: 'working' | 'ok' | 'failed';
  message: string;
  nextAction?: string;
  code?: 'deadline' | 'wrong-password' | 'repo-missing' | 'locked' | 'unreachable';
  result?: BackupResult;
  at: string;
}
export interface BackupProgress {
  percent: number;
  bytesDone: number;
  totalBytes: number;
  at: string;
}

export function parseBackupStatus(raw: string): BackupStatus | null {
  try {
    const d = JSON.parse(raw) as Partial<BackupStatus>;
    if (!d || typeof d !== 'object' || typeof d.state !== 'string' || typeof d.message !== 'string') return null;
    return d as BackupStatus;
  } catch {
    return null;
  }
}
export function parseBackupProgress(raw: string): BackupProgress | null {
  try {
    const d = JSON.parse(raw) as Partial<BackupProgress>;
    if (!d || typeof d.percent !== 'number') return null;
    return { percent: d.percent, bytesDone: d.bytesDone ?? 0, totalBytes: d.totalBytes ?? 0, at: d.at ?? '' };
  } catch {
    return null;
  }
}

// Re-validation the root step applies to every request (the daemon validates too; root trusts nothing).
export function checkRequestShape(r: unknown): BackupRequest {
  const d = r as Partial<BackupRequest>;
  if (!d || typeof d !== 'object' || !BACKUP_ACTIONS.includes(d.action as BackupAction)) throw new HarborError('INVALID_REQUEST', 'backup request has no valid action');
  const t = d.target as TargetRuntime | undefined;
  if (!t || typeof t !== 'object' || !UUID_RE.test(t.id) || typeof t.transport !== 'string' || typeof t.config !== 'object' || !Array.isArray(t.fields)) throw new HarborError('INVALID_REQUEST', 'backup request has no valid target');
  if (d.instanceId !== undefined && !UUID_RE.test(d.instanceId)) throw new HarborError('INVALID_REQUEST', 'invalid instance id');
  if (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.some((x) => typeof x !== 'string' || !/^[a-z]+:[A-Za-z0-9._-]{1,64}$/.test(x)))) throw new HarborError('INVALID_REQUEST', 'invalid snapshot tags');
  if (d.deadlineSeconds !== undefined && (!Number.isInteger(d.deadlineSeconds) || d.deadlineSeconds < 1)) throw new HarborError('INVALID_REQUEST', 'invalid deadline');
  return d as BackupRequest;
}
