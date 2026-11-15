import { INTERNAL_ACTORS, QUEUEABLE_KINDS, type InstanceSummary, type OperationDto, type QueueableKind } from '../../../src/contracts/api.js';

// Decision 183: the words the queue speaks in (tray, Home tiles, the queue-mode review). Pure: no DOM, no relative imports.

export const isFinal = (op: Pick<OperationDto, 'state'>) => op.state === 'succeeded' || op.state === 'failed' || op.state === 'needs_action' || op.state === 'cancelled';

export const isQueueable = (kind: string): kind is QueueableKind => (QUEUEABLE_KINDS as readonly string[]).includes(kind);

// "Installing Immich…"
export const DOING: Record<string, string> = { install: 'Installing', start: 'Starting', stop: 'Stopping', remove: 'Removing', reinstall: 'Reinstalling', purge: 'Uninstalling', update: 'Updating', expose: 'Publishing', unexpose: 'Withdrawing the address of', reconfigure: 'Switching the address of', restart: 'Restarting', configure: 'Applying new settings to', seal: 'Encrypting', move: 'Moving', backup: 'Backing up', restore: 'Restoring', relink: 'Securing the links of', space: 'Changing the space network of' };
// "Immich is ready"
export const DONE: Record<string, string> = { install: 'is ready', start: 'is running again', stop: 'is stopped', remove: 'was removed (data kept)', reinstall: 'is back', purge: 'was uninstalled completely', update: 'is up to date', expose: 'is published', unexpose: 'address withdrawn', reconfigure: 'address switched', restart: 'restarted', configure: 'settings applied', seal: 'is encrypted', move: 'moved', backup: 'is backed up', restore: 'is restored', relink: 'links secured', space: 'space network set' };
export const PHASE: Record<string, string> = { rollback: 'putting the previous version back', purging: 'deleting its data', queued: 'waiting for its turn', preparing: 'preparing', pulling: 'downloading the app', starting: 'starting containers', checking: 'waiting until it answers', stopping: 'stopping', removing: 'cleaning up', reconfiguring: 'applying the new address', verifying: 'checking the result', exposing: 'setting up the address', unexposing: 'removing the address', 'backing-up': 'sending the last changes', restoring: 'restoring its data', copying: 'copying its data', planning: 'planning it now' };
// The bare verb: "Cancel update Immich", "Queue update", "Update Immich"
export const VERB: Record<string, string> = { install: 'install', start: 'start', stop: 'stop', remove: 'remove', reinstall: 'reinstall', purge: 'uninstall', update: 'update', expose: 'publish', unexpose: 'withdraw', reconfigure: 'switch the address of', restart: 'restart', configure: 'apply settings to', seal: 'encrypt', move: 'move', backup: 'back up', restore: 'restore', relink: 'secure the links of', space: 'change the space network of' };
// Tiles: "Updating…" while it runs
const TILE: Record<string, string> = { install: 'Installing…', start: 'Starting…', stop: 'Stopping…', remove: 'Removing…', reinstall: 'Reinstalling…', purge: 'Uninstalling…', update: 'Updating…', expose: 'Publishing…', unexpose: 'Withdrawing…', reconfigure: 'Switching address…', restart: 'Restarting…', configure: 'Applying settings…', seal: 'Encrypting…', move: 'Moving…', backup: 'Backing up…', restore: 'Restoring…', relink: 'Securing links…', space: 'Joining its space…' };

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Running = picked by the runner (it has started); waiting = still queued for its turn.
export const isRunning = (op: Pick<OperationDto, 'state' | 'startedAt'>) => op.state === 'applying' || op.state === 'verifying' || (op.state === 'queued' && op.startedAt !== null);

// A Home tile's line while the app has an operation of its own.
export function tileStatus(op: OperationDto): { label: string; tone: 'busy' } {
  return { label: isRunning(op) ? (TILE[op.kind] ?? 'Working…') : 'Waiting…', tone: 'busy' };
}

// The tray's sentence for one operation.
export function opTitle(op: Pick<OperationDto, 'kind' | 'state' | 'startedAt' | 'error'>, who: string): string {
  if (op.state === 'succeeded') return op.kind === 'unexpose' || op.kind === 'reconfigure' || op.kind === 'configure' || op.kind === 'relink' || op.kind === 'space' ? `${who}: ${DONE[op.kind]}` : `${who} ${DONE[op.kind] ?? 'done'}`;
  if (op.state === 'failed') return op.error?.code === 'REVIEW_NEEDED' ? `${capitalize(VERB[op.kind] ?? op.kind)} ${who} needs your review` : `${DOING[op.kind] ?? op.kind} ${who} failed`;
  if (op.state === 'needs_action') return `${who} needs your attention`;
  if (op.state === 'cancelled') return `${capitalize(VERB[op.kind] ?? op.kind)} ${who} was cancelled`;
  if (isRunning(op)) return `${DOING[op.kind] ?? op.kind} ${who}…`;
  return `${capitalize(VERB[op.kind] ?? op.kind)} ${who}`;
}

// Why a waiting item has no Cancel (decision 183: Harbor queued it to protect something).
export function notCancellableReason(op: Pick<OperationDto, 'actor' | 'kind'>): string {
  switch (op.actor) {
    case 'drive-guard':
      return 'Harbor queued this because a drive went away; it cannot be cancelled.';
    case 'link-guard':
      return 'Harbor queued this to keep a link between apps safe; it cannot be cancelled.';
    case 'lock-guard':
      return 'Harbor queued this to start the app once its key is back; it cannot be cancelled.';
    case 'scheduler':
      // every cold pass runs as the scheduler, a "Back up now" included
      return 'Part of a backup run; it cannot be cancelled.';
    default:
      return op.kind === 'backup' ? 'Part of a backup run; it cannot be cancelled.' : 'Harbor queued this itself; it cannot be cancelled.';
  }
}

// Values a finished operation shows once: the tray keeps such an item until it is dismissed.
export function hasShownOnce(op: Pick<OperationDto, 'result'>): boolean {
  const r = op.result;
  if (!r) return false;
  return Boolean(r['credentials'] || (Array.isArray(r['shownOnce']) && r['shownOnce'].length) || r['recoveryKey'] || r['installationRecoveryKey']);
}

// "Queue · 1 running, 2 waiting"
export function queueSummary(running: number, waiting: number, finished: number): string {
  const parts = [running ? `${running} running` : '', waiting ? `${waiting} waiting` : '', finished ? `${finished} done` : ''].filter(Boolean);
  return `Queue · ${parts.join(', ') || 'empty'}`;
}

// The name the tray and the queue review use for an app ("Immich", "Immich (immich-2)", or its own display name).
export function whoOf(inst: Pick<InstanceSummary, 'displayName' | 'name' | 'packageId' | 'packageName'> | undefined, fallback: string): string {
  if (!inst) return fallback || 'the app';
  return inst.displayName ?? (inst.name === inst.packageId ? inst.packageName : `${inst.packageName} (${inst.name})`);
}

// Background work Harbor queued itself (guards, the backup scheduler, auto-update, git sources, the tailnet policy).
export const byHarbor = (actor: string) => (INTERNAL_ACTORS as readonly string[]).includes(actor.toLowerCase());

// The same action already waits for this app (a second click shows it, with its Cancel, instead of queueing it twice).
// The engine's rule (queueAction), the same here: only the app's LAST not-final item, of the same kind, queued by a
// person (never a guard's or the scheduler's item: those follow their own rules, a guard stop keeps `desired`), and
// still waiting. A running one is no duplicate, except a running Update: a second one would fail at its turn.
export function alreadyQueued(active: OperationDto[], instanceId: string, kind: string): OperationDto | null {
  const mine = active.filter((o) => o.instanceId === instanceId && !isFinal(o));
  // an update: any unfinished one of the app stands for a second (it could only fail), whoever queued it
  if (kind === 'update') return mine.find((o) => o.kind === 'update') ?? null;
  const last = mine[mine.length - 1];
  if (!last || last.kind !== kind || byHarbor(last.actor)) return null;
  return !isRunning(last) ? last : null;
}

// A review the operator gave values in (typed secrets, accepted permissions, changed settings). Approving it while
// the app became busy waits and reviews again (decision 173) instead of queueing an action that would drop them.
export function reviewHasValues(v: { secrets?: Record<string, string>; acceptPermissions: boolean; settings?: Record<string, unknown> }): boolean {
  return v.acceptPermissions || Object.keys(v.secrets ?? {}).length > 0 || Object.keys(v.settings ?? {}).length > 0;
}

// What the tray keeps once an operation finishes: a person's operations (any outcome, until dismissed; decided by the
// actor, so Update all, an adopt, another tab or a reload count too), anything accepted from this console, anything
// with values shown once, and failures of any actor. A background operation (scheduler, auto-update, guards) that
// went well drops out by itself (it stays in the queue's recent list).
export function keepFinished(op: Pick<OperationDto, 'state' | 'result' | 'actor'>, acceptedHere = false): boolean {
  return acceptedHere || !byHarbor(op.actor) || hasShownOnce(op) || op.state === 'failed' || op.state === 'needs_action';
}

// "Clear finished": every finished item goes, except those still showing a value once (they need their own yes).
export function clearFinished<T extends Pick<OperationDto, 'result'>>(list: T[]): T[] {
  return list.filter(hasShownOnce);
}

// The full refresh (system, catalog, apps, addresses, …) runs every 10 s; the queue alone every 2 s while anything
// runs or waits, else with the refresh.
export const REFRESH_MS = 10_000;
export const queuePollMs = (anyActive: boolean) => (anyActive ? 2000 : REFRESH_MS);

// Kinds that leave the app running once they are done; install, reinstall and restart (a repair) also leave it installed.
const LEAVES_RUNNING = new Set(['install', 'reinstall', 'restart', 'start', 'update']);
const LEAVES_INSTALLED = new Set(['install', 'reinstall', 'restart']);

// The app page's queueable actions. A free app keeps its own gating; a busy one (an operation of its own runs or
// waits, its install included) also offers what makes sense after the operations ahead, through queue mode: each
// action is judged against what they leave behind (the engine refuses the rest at its turn). Nothing makes sense
// after a waiting Uninstall completely, and after a Remove only Uninstall completely does.
export function appActionGates(inst: Pick<InstanceSummary, 'installState' | 'runtime' | 'desired'>, ops: Pick<OperationDto, 'kind'>[]): { start: boolean; stop: boolean; restart: boolean; remove: boolean; purge: boolean; update: boolean } {
  const retained = inst.installState === 'retained';
  const canStop = (inst.installState === 'installed' || inst.installState === 'needs_action' || inst.installState === 'failed') && inst.runtime !== 'stopped';
  const purging = ops.some((o) => o.kind === 'purge');
  const removing = ops.some((o) => o.kind === 'remove');
  if (purging || removing) return { start: false, stop: false, restart: false, remove: false, purge: !purging, update: false };
  const after = ops.length > 0 && !retained;
  // The app as the operations ahead leave it. A busy app that should run counts as running: a backup's cold pass or a
  // restart stops it only for a moment.
  let installed = inst.installState === 'installed';
  let running = installed && (inst.runtime === 'running' || (after && inst.desired === 'running'));
  let stopped = installed && inst.desired === 'stopped';
  if (after) {
    for (const o of ops) {
      if (LEAVES_INSTALLED.has(o.kind)) installed = true;
      if (LEAVES_RUNNING.has(o.kind)) {
        running = installed;
        stopped = false;
      } else if (o.kind === 'stop') {
        running = false;
        stopped = installed;
      }
    }
  }
  const updateAhead = ops.some((o) => o.kind === 'update');
  return {
    start: stopped,
    stop: canStop || after,
    restart: running,
    remove: (!retained && inst.installState !== 'installing') || after,
    purge: inst.installState !== 'installing' || after,
    update: (inst.installState === 'installed' || (inst.installState === 'installing' && after)) && !updateAhead,
  };
}

// The app page's quiet line while the app is busy: "Installing… · Update waiting".
export function appQueueLine(ops: OperationDto[]): string {
  return ops.map((op) => (isRunning(op) ? tileStatus(op).label : `${capitalize(VERB[op.kind] ?? op.kind)} waiting`)).join(' · ');
}
