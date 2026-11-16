// Decision 205 (issue #7): CPU priority, CPU limit and memory limit per app. A package may declare cpu_shares (only
// lower), cpus and mem_limit; the operator's choice goes on top, applies live when it only sets or tightens values,
// re-creates the containers when it removes one, survives Restart, and a stopped app gets it at its next start.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { LABELS } from '../../src/naming.js';
import { writeZip } from '../../src/packages/zip.js';
import { startHarness, type Harness } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
const MiB = 1024 * 1024;

const MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: busy
  name: Busy
  description: A web page and a background worker that reads documents
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
    worker: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
// the worker asks for background priority and a memory limit itself; the web page asks for nothing
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27-alpine\n  worker:\n    image: nginx:1.27-alpine\n    cpu_shares: 128\n    mem_limit: 256m\n';

describe('CPU and memory limits (decision 205)', () => {
  let h: Harness;
  let app: InstanceSummary;
  const container = (svc: string) => [...h.fake.containers.values()].find((c) => c.labels[LABELS.instance] === app.id && c.labels[LABELS.service] === svc)!;
  const summary = async () => (await h.api.instances()).find((i) => i.id === app.id)!;
  const runtime = () => readFileSync(path.join(h.stateDir, 'instances', app.id, 'runtime', 'compose.yaml'), 'utf8');

  beforeAll(async () => {
    h = await startHarness({ portRange: { from: 18440, to: 18470 } });
    await h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'busy.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': MANIFEST, 'compose.yaml': COMPOSE }, { folder: 'busy' }).toString('base64')}` });
    const r = await h.api.run({ kind: 'install', packageId: 'busy' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    app = (await h.api.instances()).find((i) => i.packageId === 'busy')!;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('renders what the package declares and nothing for a service that declares nothing', async () => {
    expect(container('worker').resources).toEqual({ cpuShares: 128, nanoCpus: 0, memoryBytes: 256 * MiB });
    expect(container('web').resources).toEqual({ cpuShares: 0, nanoCpus: 0, memoryBytes: 0 });
    const l = (await summary()).limits!;
    expect(l).toMatchObject({ priority: 'normal', cpus: null, memoryMiB: null, package: { priority: 'normal', cpus: null, memoryMiB: null }, chosen: { priority: false, cpus: false, memoryMiB: false } });
    expect(l.host.cpus).toBeGreaterThan(0);
  });

  it('applies a new priority and limits to the running containers without re-creating them', async () => {
    const before = { web: container('web').startedAt, worker: container('worker').startedAt, updates: h.fake.updates.length };
    const r = await h.api.run({ kind: 'configure', instanceId: app.id, resources: { priority: 'low', cpus: 1, memoryMiB: 512 } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    expect(r.plan.resources).toEqual({ from: { priority: 'normal', cpus: null, memoryMiB: null }, to: { priority: 'low', cpus: 1, memoryMiB: 512 }, live: true });
    expect(r.plan.changes).toEqual(expect.arrayContaining([expect.stringMatching(/^CPU priority: normal → low/), expect.stringMatching(/^CPU: no CPU limit → at most 1 core/), expect.stringMatching(/^Memory: no memory limit → at most 512 MiB/), 'Applied to the running containers at once (no restart)']));
    expect(h.fake.updates.length - before.updates).toBe(2);
    for (const svc of ['web', 'worker']) {
      expect(container(svc).resources, svc).toEqual({ cpuShares: 512, nanoCpus: 1e9, memoryBytes: 512 * MiB });
      expect(container(svc).startedAt, svc).toBe(before[svc as 'web' | 'worker']);
    }
    expect((await summary()).limits).toMatchObject({ priority: 'low', cpus: 1, memoryMiB: 512, chosen: { priority: true, cpus: true, memoryMiB: true } });
    // the rendered file carries them, so the next re-creation keeps them
    expect(runtime()).toMatch(/cpu_shares: 512/);
    expect(runtime()).toMatch(/mem_limit: "?512m"?/);
    const settings = JSON.parse(readFileSync(path.join(h.stateDir, 'instances', app.id, 'settings.json'), 'utf8')) as { resources: unknown };
    expect(settings.resources).toEqual({ priority: 'low', cpus: 1, memoryMiB: 512 });
  });

  it('keeps the limits across a Restart', async () => {
    expect((await h.api.run({ kind: 'restart', instanceId: app.id })).op.state).toBe('succeeded');
    expect(container('web').resources).toEqual({ cpuShares: 512, nanoCpus: 1e9, memoryBytes: 512 * MiB });
  });

  it('re-creates the containers to remove a limit (docker update cannot)', async () => {
    const r = await h.api.run({ kind: 'configure', instanceId: app.id, resources: { cpus: null } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    expect(r.plan.resources?.live).toBe(false);
    expect(r.plan.changes.at(-1)).toMatch(/restarts once/);
    expect(container('web').resources).toEqual({ cpuShares: 512, nanoCpus: 0, memoryBytes: 512 * MiB });
  });

  it('gives a stopped app its new limits when it next starts', async () => {
    expect((await h.api.run({ kind: 'stop', instanceId: app.id })).op.state).toBe('succeeded');
    const r = await h.api.run({ kind: 'configure', instanceId: app.id, resources: { priority: 'default', memoryMiB: 'default' } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    expect(r.plan.changes.at(-1)).toBe('It applies when Busy next starts'.replace('Busy', app.name));
    expect(container('worker').resources).toEqual({ cpuShares: 512, nanoCpus: 0, memoryBytes: 512 * MiB }); // untouched while stopped
    const start = await h.api.run({ kind: 'start', instanceId: app.id });
    expect(start.op.state, JSON.stringify(start.op.error)).toBe('succeeded');
    expect(start.op.events.map((e) => e.message).join('\n')).toMatch(/CPU or memory limits changed while it was stopped/);
    // back to the package: the worker's own background priority and 256m, nothing on the web page
    expect(container('worker').resources).toEqual({ cpuShares: 128, nanoCpus: 0, memoryBytes: 256 * MiB });
    expect(container('web').resources).toEqual({ cpuShares: 0, nanoCpus: 0, memoryBytes: 0 });
    expect((await summary()).limits).toMatchObject({ priority: 'normal', cpus: null, memoryMiB: null, chosen: { priority: false, cpus: true, memoryMiB: false } });
  });

  it('refuses limits this machine cannot honour, and a change that changes nothing', async () => {
    const host = (await summary()).limits!.host;
    const tooMany = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: app.id, resources: { cpus: Math.min(1024, host.cpus + 1) } });
    expect(tooMany.error.message).toMatch(/between 0\.1 and/);
    expect((await h.api.json('POST', '/v1/plans', { kind: 'configure', instanceId: app.id, resources: { memoryMiB: 32 } })).status).toBe(422); // under the schema's 64 MiB
    const same = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'configure', instanceId: app.id, resources: { cpus: null } });
    expect(same.error.message).toMatch(/already has these limits/);
  });

  it('the CLI shows and changes them', async () => {
    const cliDir = mkdtempSync(path.join(tmpdir(), 'harbor-cli-'));
    writeFileSync(path.join(cliDir, 'cli.json'), JSON.stringify({ url: h.baseUrl, token: h.api.token }));
    const cli = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const c = spawn(process.execPath, ['--import', TSX, path.join(ROOT, 'src', 'cli', 'main.ts'), ...args], { cwd: ROOT, env: { ...process.env, HARBOR_CLI_CONFIG_DIR: cliDir, HARBOR_URL: h.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        c.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        c.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    const changed = await cli(['limits', app.name, '--priority', 'background', '--memory', '1g', '--yes']);
    expect(changed.code, changed.stderr).toBe(0);
    expect(container('web').resources).toEqual({ cpuShares: 128, nanoCpus: 0, memoryBytes: 1024 * MiB });
    const shown = await cli(['limits', app.name]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toMatch(/priority background \(your choice\), CPU limit none \(your choice\), memory limit 1 GiB \(your choice\)/);
  });
});
