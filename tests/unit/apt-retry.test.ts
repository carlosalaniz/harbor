import { describe, expect, it, vi } from 'vitest';
import { aptGet, type ExecResult } from '../../src/bootstrap/exec.js';

const locked: ExecResult = { code: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1 (unattended-upgr)' };
const ok: ExecResult = { code: 0, stdout: '', stderr: '' };
const missing: ExecResult = { code: 100, stdout: '', stderr: 'E: Unable to locate package nope-xyz' };

describe('aptGet lock retry', () => {
  it('retries on lock contention then succeeds', async () => {
    const run = vi.fn().mockResolvedValueOnce(locked).mockResolvedValueOnce(locked).mockResolvedValueOnce(ok);
    const logs: string[] = [];
    const r = await aptGet((m) => logs.push(m), ['install', '-y', 'caddy'], { waits: [1, 1], run });
    expect(r.code).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(logs.filter((l) => l.includes('waiting'))).toHaveLength(2);
  });
  it('throws immediately on real failures without retrying', async () => {
    const run = vi.fn().mockResolvedValue(missing);
    const logs: string[] = [];
    await expect(aptGet((m) => logs.push(m), ['install', '-y', 'nope-xyz'], { waits: [1, 1], run })).rejects.toThrow(/apt-get/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(0);
  });
  it('gives up after exhausting retries', async () => {
    const run = vi.fn().mockResolvedValue(locked);
    await expect(aptGet(() => {}, ['install', '-y', 'caddy'], { waits: [1, 1], run })).rejects.toThrow(/apt-get/);
    expect(run).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
