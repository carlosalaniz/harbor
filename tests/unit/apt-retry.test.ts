import { describe, expect, it } from 'vitest';
import { aptGet } from '../../src/bootstrap/exec.js';

describe('aptGet lock retry', () => {
  it('retries only on lock contention, throws immediately on real failures', async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    // Real failure (exit 100 without a lock message): no retry, immediate throw.
    await expect(aptGet(log, ['install', '-y', 'definitely-not-a-real-package-xyz'], { timeoutMs: 30_000 })).rejects.toThrow(/apt-get/);
    expect(logs.filter((l) => l.includes('waiting'))).toHaveLength(0);
  });
});
