// When an app's backup is due (decision 151). PURE: dates in, dates out, local time of the machine.
import type { BackupAppPolicyDto, BackupCadence, BackupPolicyDto } from '../contracts/api.js';

export const DEFAULT_BACKUP_POLICY: BackupPolicyDto = { window: '02:00', cadence: 'daily', weekday: 0, maxDowntimeMinutes: 5, retention: { daily: 7, weekly: 4, monthly: 6 }, paused: false };
export const DEFAULT_APP_POLICY: BackupAppPolicyDto = { enabled: false, targets: [], window: null, cadence: null, weekday: null };
// A window that was missed (machine off, daemon restarting) still runs within this long after it opened.
export const WINDOW_GRACE_MS = 12 * 60 * 60_000;

export const WINDOW_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export interface EffectiveSchedule {
  window: string;
  cadence: BackupCadence;
  weekday: number;
}
export function effectiveSchedule(global: BackupPolicyDto, app: BackupAppPolicyDto): EffectiveSchedule {
  return { window: app.window ?? global.window, cadence: app.cadence ?? global.cadence, weekday: app.weekday ?? global.weekday };
}

function at(day: Date, window: string): Date {
  const m = WINDOW_RE.exec(window);
  const d = new Date(day);
  d.setHours(m ? Number(m[1]) : 2, m ? Number(m[2]) : 0, 0, 0);
  return d;
}

// The most recent window start at or before `now`.
export function lastWindowStart(now: Date, s: EffectiveSchedule): Date {
  let d = at(now, s.window);
  if (d.getTime() > now.getTime()) d = at(new Date(d.getTime() - 24 * 60 * 60_000), s.window);
  if (s.cadence === 'weekly') {
    while (d.getDay() !== s.weekday) d = at(new Date(d.getTime() - 24 * 60 * 60_000), s.window);
  }
  return d;
}

export function nextWindowStart(now: Date, s: EffectiveSchedule): Date {
  const step = s.cadence === 'weekly' ? 7 : 1;
  let d = lastWindowStart(now, s);
  // add whole days through setDate so a DST switch keeps the wall-clock time
  while (d.getTime() <= now.getTime()) {
    const n = new Date(d);
    n.setDate(n.getDate() + step);
    d = at(n, s.window);
  }
  return d;
}

// Due = the current window opened, nothing was attempted since it opened, and it is not too late.
export function isDue(now: Date, s: EffectiveSchedule, lastAttemptAt: Date | null): boolean {
  const w = lastWindowStart(now, s);
  if (now.getTime() - w.getTime() > WINDOW_GRACE_MS) return false;
  return !lastAttemptAt || lastAttemptAt.getTime() < w.getTime();
}

export function cadenceMs(c: BackupCadence): number {
  return (c === 'weekly' ? 7 : 1) * 24 * 60 * 60_000;
}

// Stale = no restore point for more than two periods (the app is enabled and has places).
export function isStale(now: Date, s: EffectiveSchedule, lastSuccessAt: Date | null, enabledSince: Date): boolean {
  const since = lastSuccessAt ?? enabledSince;
  return now.getTime() - since.getTime() > 2 * cadenceMs(s.cadence) + WINDOW_GRACE_MS;
}

// Warm passes repeat until what is left would fit the cap (decision 151). The cold pass re-reads what
// changed since the last warm pass; that pass's own length is the best estimate (it covered the churn
// since the pass before it). Small deltas always fit.
export function fitsCap(lastAddedBytes: number, lastDurationSeconds: number, capSeconds: number): boolean {
  if (lastAddedBytes <= 64 * 1024 * 1024) return true;
  return lastDurationSeconds <= capSeconds * 0.5;
}
export const MAX_WARM_PASSES = 3;

export function checkPolicy(p: BackupPolicyDto): string | null {
  if (!WINDOW_RE.test(p.window)) return 'window must be HH:MM (24-hour)';
  if (!Number.isInteger(p.weekday) || p.weekday < 0 || p.weekday > 6) return 'weekday must be 0 (Sunday) to 6';
  if (!Number.isInteger(p.maxDowntimeMinutes) || p.maxDowntimeMinutes < 1 || p.maxDowntimeMinutes > 120) return 'maximum downtime must be 1 to 120 minutes';
  for (const [k, v] of Object.entries(p.retention)) if (!Number.isInteger(v) || v < 0 || v > 400) return `retention ${k} must be 0 to 400`;
  if (p.retention.daily + p.retention.weekly + p.retention.monthly < 1) return 'keep at least one restore point';
  return null;
}
