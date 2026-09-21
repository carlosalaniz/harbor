import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagnosticsDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from '../integration/harness.js';

// Diagnostics: the redacted bundle testers paste into bug reports. Proves the
// route is wired, authenticated, and carries no secret material.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe('diagnostics', () => {
  it('returns a redacted bundle with versions, host facts and app states', async () => {
    const d = await h.api.expect<DiagnosticsDto>(200, 'GET', '/v1/system/diagnostics');
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.installationId).toBeTruthy();
    expect(d.host.hostname).toBeTruthy();
    expect(d.host.os).toBeTruthy();
    expect(d.counts.instances).toBe(0);
    expect(Array.isArray(d.mounts)).toBe(true);
    expect(Array.isArray(d.devices)).toBe(true);
    expect(Array.isArray(d.logTail.lines)).toBe(true);
    // No secret material anywhere in the bundle.
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/bearer|token|password|secret|passphrase|recovery|credential|authkey/i);
  });

  it('reflects an installed app without leaking its home key material', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'diagapp' });
    const sub = await h.api.submit(plan.id, 'diagnostics-install-1');
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const d = await h.api.expect<DiagnosticsDto>(200, 'GET', '/v1/system/diagnostics');
    expect(d.counts.instances).toBe(1);
    expect(d.instances.map((i) => i.name)).toContain('diagapp');
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/bearer|token|password|secret|passphrase|recovery|credential|authkey/i);
  });
});
