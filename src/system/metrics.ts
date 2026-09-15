import { readFileSync, statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import type { SystemMetricsDto } from '../contracts/api.js';

// Host metrics for the console's system strip. /proc on Linux for accurate "used" memory; os fallbacks
// elsewhere. No history is kept in this iteration.
export function sampleMetrics(now: Date, docker: { available: boolean; version: string | null; containersRunning: number; containersTotal: number }, diskPath = '/'): SystemMetricsDto {
  const [load1, load5, load15] = loadavg();
  let total = totalmem();
  let used = total - freemem();
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) * 1024;
    const t = get('MemTotal');
    const avail = get('MemAvailable');
    if (t > 0 && avail > 0) {
      total = t;
      used = t - avail;
    }
  } catch {
    /* not linux */
  }
  let disk: SystemMetricsDto['disk'];
  try {
    const st = statfsSync(diskPath);
    const totalBytes = Number(st.blocks) * Number(st.bsize);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    disk = { path: diskPath, totalBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    disk = null;
  }
  return {
    sampledAt: now.toISOString(),
    uptimeSeconds: Math.round(uptime()),
    cpu: { cores: cpus().length, load1: round(load1 ?? 0), load5: round(load5 ?? 0), load15: round(load15 ?? 0) },
    memory: { totalBytes: total, usedBytes: Math.max(0, used) },
    disk,
    docker,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
