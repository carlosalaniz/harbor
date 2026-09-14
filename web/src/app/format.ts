import type { InstanceSummary } from '../../../src/contracts/api';

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// Plain-words status for a tile; the technical states live in the drawer.
export function plainStatus(i: InstanceSummary): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'busy' } {
  if (i.installState === 'installing') return { label: 'Installing…', tone: 'busy' };
  if (i.installState === 'retained') return { label: 'Removed · data kept', tone: 'muted' };
  if (i.installState === 'failed') return { label: 'Failed', tone: 'bad' };
  if (i.installState === 'needs_action') return { label: 'Needs attention', tone: 'bad' };
  if (i.runtime === 'unavailable') return { label: 'Docker unavailable', tone: 'warn' };
  if (i.desired === 'stopped' && i.runtime === 'stopped') return { label: 'Stopped', tone: 'muted' };
  if (i.runtime === 'starting' || i.readiness === 'checking') return { label: 'Starting…', tone: 'busy' };
  if (i.runtime === 'running' && i.readiness === 'healthy') return { label: 'Running', tone: 'ok' };
  if (i.runtime === 'running' && i.readiness === 'unhealthy') return { label: 'Running · not answering', tone: 'warn' };
  if (i.runtime === 'running') return { label: 'Running · checking', tone: 'busy' };
  if (i.runtime === 'stopped') return { label: 'Stopped unexpectedly', tone: 'warn' };
  return { label: 'Unknown', tone: 'muted' };
}

export function monogram(name: string): string {
  const parts = name.replace(/[^a-z0-9 ]/gi, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function categoryLabel(c: string): string {
  return { productivity: 'Productivity', media: 'Media', files: 'Files', automation: 'Automation', network: 'Network', developer: 'Developer', other: 'Other' }[c] ?? 'Other';
}
