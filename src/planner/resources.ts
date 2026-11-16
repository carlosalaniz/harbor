// Decision 205 (issue #7): how much of the machine an app may take. PURE: no Docker, no files.
//
// Three knobs per service, from two layers:
//   package   compose.yaml `cpu_shares` (relative CPU priority, Docker's scale: 1024 = normal; a package may only go
//             lower), `cpus` (hard cap in cores) and `mem_limit` ("512m", "2g"); bounded here and at render;
//   operator  one choice per app, applied to each of its services: priority (normal / low / background), a CPU
//             limit and a memory limit. A key the operator never set follows the package; null removes a limit.
//
// Priority is a cgroup weight: an app at low priority runs at full speed while the machine is idle and gives way as
// soon as something else wants the CPU. "Normal" renders NOTHING: Docker leaves cpu.weight at the kernel default
// (100) only when cpu_shares is unset. runc before 1.3 maps cpu_shares 1024 to weight 39 (linear), newer runc to 100,
// so an explicit 1024 would quietly lower an app on older engines.
import type { ComposeSourceService } from '../contracts/types.js';

export type Priority = 'normal' | 'low' | 'background';
export const PRIORITIES: readonly Priority[] = ['normal', 'low', 'background'];

// Docker's scale (1024 = normal). On runc >= 1.3 (cgroup v2): 512 -> weight 59, 128 -> 20; on older runc 20 and 5.
export const PRIORITY_SHARES: Record<Exclude<Priority, 'normal'>, number> = { low: 512, background: 128 };

export const BOUNDS = {
  cpuShares: { min: 2, max: 1024 },
  cpus: { min: 0.01, max: 1024 },
  memoryMiB: { min: 32, max: 1024 * 1024 },
} as const;

// The operator's choice for one app, as stored in the instance's settings.json (`resources`). An absent key = follow
// the package; null = no limit (also when the package sets one).
export interface ResourceChoice {
  priority?: Priority;
  cpus?: number | null;
  memoryMiB?: number | null;
}

export interface HostCapacity {
  cpus: number;
  memoryMiB: number;
}

// What one service gets (null = nothing rendered: normal priority, no cap, no memory limit).
export interface ServiceResources {
  cpuShares: number | null;
  cpus: number | null;
  memoryMiB: number | null;
}

// "512m", "2g", "1.5g" (Compose's byte units, k/m/g, any case) -> MiB, rounded up; null when unreadable.
export function parseMemLimit(raw: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)([kmg])b?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mib = unit === 'k' ? n / 1024 : unit === 'm' ? n : n * 1024;
  return Number.isFinite(mib) && mib > 0 ? Math.ceil(mib) : null;
}

// Package values that cannot work anywhere (validation; the host clamp comes at render).
export function packageResourceProblems(svc: string, def: Pick<ComposeSourceService, 'cpu_shares' | 'cpus' | 'mem_limit'>): string[] {
  const out: string[] = [];
  if (def.cpu_shares !== undefined && (!Number.isInteger(def.cpu_shares) || def.cpu_shares < BOUNDS.cpuShares.min || def.cpu_shares > BOUNDS.cpuShares.max)) {
    out.push(`service ${svc} cpu_shares ${def.cpu_shares} is outside ${BOUNDS.cpuShares.min}..${BOUNDS.cpuShares.max} (1024 = normal; a package may only lower its priority)`);
  }
  if (def.cpus !== undefined && !(def.cpus >= BOUNDS.cpus.min && def.cpus <= BOUNDS.cpus.max)) out.push(`service ${svc} cpus ${def.cpus} is outside ${BOUNDS.cpus.min}..${BOUNDS.cpus.max}`);
  if (def.mem_limit !== undefined) {
    const mib = parseMemLimit(def.mem_limit);
    if (mib === null) out.push(`service ${svc} mem_limit ${def.mem_limit} is not a size like 512m or 2g`);
    else if (mib < BOUNDS.memoryMiB.min || mib > BOUNDS.memoryMiB.max) out.push(`service ${svc} mem_limit ${def.mem_limit} is outside ${BOUNDS.memoryMiB.min}m..${BOUNDS.memoryMiB.max / 1024}g`);
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// The package's own values for one service, clamped to this machine (a cap above the host's cores or memory means
// nothing, so it is dropped rather than rendered).
export function packageResources(def: Pick<ComposeSourceService, 'cpu_shares' | 'cpus' | 'mem_limit'>, host: HostCapacity): ServiceResources {
  const shares = def.cpu_shares !== undefined && def.cpu_shares < 1024 ? Math.max(BOUNDS.cpuShares.min, def.cpu_shares) : null;
  const cpus = def.cpus !== undefined && def.cpus < host.cpus ? round2(def.cpus) : null;
  const mem = def.mem_limit !== undefined ? parseMemLimit(def.mem_limit) : null;
  return { cpuShares: shares, cpus, memoryMiB: mem !== null && mem < host.memoryMiB ? Math.max(BOUNDS.memoryMiB.min, mem) : null };
}

// Package values with the operator's choice on top.
export function effectiveResources(def: Pick<ComposeSourceService, 'cpu_shares' | 'cpus' | 'mem_limit'>, choice: ResourceChoice, host: HostCapacity): ServiceResources {
  const pkg = packageResources(def, host);
  const shares = choice.priority === undefined ? pkg.cpuShares : choice.priority === 'normal' ? null : PRIORITY_SHARES[choice.priority];
  const cpus = choice.cpus === undefined ? pkg.cpus : choice.cpus === null || choice.cpus >= host.cpus ? null : round2(choice.cpus);
  const mem = choice.memoryMiB === undefined ? pkg.memoryMiB : choice.memoryMiB === null || choice.memoryMiB >= host.memoryMiB ? null : choice.memoryMiB;
  return { cpuShares: shares, cpus, memoryMiB: mem };
}

// The label people see for a cpu_shares value (a package may pick any number from 2 to 1024).
export function priorityOf(shares: number | null): Priority {
  if (shares === null || shares >= 1024) return 'normal';
  return shares > PRIORITY_SHARES.background ? 'low' : 'background';
}

// The Compose keys rendered for one service (nothing at all for a service with no limits, so apps that never use
// this render exactly as before). memswap_limit = mem_limit: no swap beyond the limit, the same on every host.
export function renderedResourceKeys(r: ServiceResources): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.cpuShares !== null) out['cpu_shares'] = r.cpuShares;
  if (r.cpus !== null) out['cpus'] = r.cpus;
  if (r.memoryMiB !== null) {
    out['mem_limit'] = `${r.memoryMiB}m`;
    out['memswap_limit'] = `${r.memoryMiB}m`;
  }
  return out;
}

// `docker update` can set and tighten every value on a running container but cannot remove one (--cpus 0 is
// ignored, --memory -1 refused), and a priority back to normal must be unset, not 1024 (see the top). So a change
// that removes something re-creates the containers; anything else is applied live.
export function appliesLive(before: ServiceResources, after: ServiceResources): boolean {
  const kept = (a: number | null, b: number | null) => b !== null || a === null;
  return kept(before.cpuShares, after.cpuShares) && kept(before.cpus, after.cpus) && kept(before.memoryMiB, after.memoryMiB);
}

export const sameResources = (a: ServiceResources, b: ServiceResources): boolean => a.cpuShares === b.cpuShares && a.cpus === b.cpus && a.memoryMiB === b.memoryMiB;

// What the operator asks for in a configure plan: a value, null (none), or 'default' (follow the package again).
export interface ResourceChange {
  priority?: Priority | 'default';
  cpus?: number | null | 'default';
  memoryMiB?: number | null | 'default';
}

// The stored choice after a change, with the request's values checked against this machine.
export function nextChoice(current: ResourceChoice, change: ResourceChange, host: HostCapacity): ResourceChoice {
  const next: ResourceChoice = { ...current };
  if (change.priority !== undefined) {
    if (change.priority === 'default') delete next.priority;
    else if (PRIORITIES.includes(change.priority)) next.priority = change.priority;
    else throw new RangeError(`priority must be normal, low, background or default`);
  }
  if (change.cpus !== undefined) {
    if (change.cpus === 'default') delete next.cpus;
    else if (change.cpus === null) next.cpus = null;
    else if (typeof change.cpus === 'number' && change.cpus >= 0.1 && change.cpus <= host.cpus) next.cpus = round2(change.cpus);
    else throw new RangeError(`a CPU limit must be between 0.1 and ${host.cpus} cores (this machine's count)`);
  }
  if (change.memoryMiB !== undefined) {
    if (change.memoryMiB === 'default') delete next.memoryMiB;
    else if (change.memoryMiB === null) next.memoryMiB = null;
    else if (typeof change.memoryMiB === 'number' && Number.isInteger(change.memoryMiB) && change.memoryMiB >= 64 && change.memoryMiB <= host.memoryMiB) next.memoryMiB = change.memoryMiB;
    else throw new RangeError(`a memory limit must be a whole number of MiB between 64 and ${host.memoryMiB} (this machine's memory)`);
  }
  return next;
}

export const sameChoice = (a: ResourceChoice, b: ResourceChoice): boolean => a.priority === b.priority && a.cpus === b.cpus && a.memoryMiB === b.memoryMiB;

// A stored choice read back defensively (a hand-edited or older file never breaks a render).
export function readChoice(raw: unknown): ResourceChoice {
  const out: ResourceChoice = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r['priority'] === 'string' && (PRIORITIES as readonly string[]).includes(r['priority'])) out.priority = r['priority'] as Priority;
  if (r['cpus'] === null) out.cpus = null;
  else if (typeof r['cpus'] === 'number' && r['cpus'] > 0) out.cpus = r['cpus'];
  if (r['memoryMiB'] === null) out.memoryMiB = null;
  else if (typeof r['memoryMiB'] === 'number' && Number.isInteger(r['memoryMiB']) && r['memoryMiB'] > 0) out.memoryMiB = r['memoryMiB'];
  return out;
}

const label = (p: Priority): string => (p === 'normal' ? 'normal' : p === 'low' ? 'low' : 'background');
const cpuText = (c: number | null): string => (c === null ? 'no CPU limit' : `at most ${c} ${c === 1 ? 'core' : 'cores'}`);
const memText = (m: number | null): string => (m === null ? 'no memory limit' : m % 1024 === 0 ? `at most ${m / 1024} GiB of memory` : `at most ${m} MiB of memory`);

// The review lines of a configure plan, from the app's main service (each service gets the same choice on top of
// its own package values) and whether the change applies live.
// apply: how it reaches the containers (null = another change in the same plan re-creates them anyway).
export function resourceChangeLines(name: string, before: ServiceResources, after: ServiceResources, apply: 'live' | 'restart' | 'next-start' | null): string[] {
  const lines: string[] = [];
  const pb = priorityOf(before.cpuShares);
  const pa = priorityOf(after.cpuShares);
  if (pb !== pa) lines.push(`CPU priority: ${label(pb)} → ${label(pa)}${pa === 'normal' ? '' : ` (${name} runs at full speed while the machine is idle and gives way when other apps need the CPU)`}`);
  if (before.cpus !== after.cpus) lines.push(`CPU: ${cpuText(before.cpus)} → ${cpuText(after.cpus)} for each of ${name}'s services`);
  if (before.memoryMiB !== after.memoryMiB) lines.push(`Memory: ${memText(before.memoryMiB)} → ${memText(after.memoryMiB)} for each of ${name}'s services${after.memoryMiB !== null ? ' (a service that needs more is stopped by the kernel and restarted)' : ''}`);
  if (!lines.length) return [`${name} keeps the same limits; only the stored choice changes (nothing is restarted)`];
  if (apply === 'next-start') lines.push(`It applies when ${name} next starts`);
  else if (apply === 'live') lines.push('Applied to the running containers at once (no restart)');
  else if (apply === 'restart') lines.push(`${name} restarts once (removing a limit or going back to normal priority needs new containers; same data, ports and addresses)`);
  return lines;
}

// The service whose limits the app page shows: the one behind the main endpoint, else the first one.
export function mainServiceOf(manifest: { ui: { primaryEndpoint: string }; endpoints: Record<string, { service: string }> }, compose: { services: Record<string, ComposeSourceService> }): ComposeSourceService | null {
  const svc = manifest.endpoints[manifest.ui.primaryEndpoint]?.service;
  return (svc ? compose.services[svc] : undefined) ?? Object.values(compose.services)[0] ?? null;
}

export const limitsOf = (r: ServiceResources): { priority: Priority; cpus: number | null; memoryMiB: number | null } => ({ priority: priorityOf(r.cpuShares), cpus: r.cpus, memoryMiB: r.memoryMiB });
