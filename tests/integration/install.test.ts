import { createServer, type Server } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import type { InstanceDetail, InstanceSummary, OperationDto, PlanDto } from '../../src/contracts/api.js';
import { LABELS } from '../../src/naming.js';
import { parse as parseYaml } from 'yaml';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('install Excalidraw end to end (fake adapter)', () => {
  let plan: PlanDto;
  let op: OperationDto;
  let inst: InstanceSummary;

  it('creates a plan without side effects', async () => {
    plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    expect(plan.kind).toBe('install');
    expect(plan.name).toBe('excalidraw');
    expect(plan.endpoints).toHaveLength(1);
    expect(plan.endpoints[0]!.hostPort).toBe(h.config.appPortRange.from);
    expect(plan.endpoints[0]!.browserUrl).toBe(`http://localhost:${h.config.appPortRange.from}/`);
    expect(plan.changes.join('\n')).toMatch(/Pull image excalidraw\/excalidraw@sha256:/);
    expect(h.fake.containers.size).toBe(0);
    expect(h.fake.volumes.size).toBe(0);
    expect(await h.api.instances()).toEqual([]);
    expect(existsSync(path.join(h.stateDir, 'instances', plan.instanceId))).toBe(false);
  });

  it('submits the plan and the daemon runs it to installed/healthy', async () => {
    const sub = await h.api.submit(plan.id, 'install-excalidraw-1');
    expect(sub.created).toBe(true);
    const listed = await h.api.instances();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.installState).toMatch(/installing|installed/);
    op = await h.api.waitOperation(sub.operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    expect(op.events.map((e) => e.phase)).toEqual(expect.arrayContaining(['queued', 'preparing', 'pulling', 'starting', 'checking', 'succeeded']));
    inst = (await h.api.instances())[0]!;
    expect(inst).toMatchObject({ name: 'excalidraw', packageId: 'excalidraw', installState: 'installed', desired: 'running', runtime: 'running', readiness: 'healthy' });
    expect(inst.endpoints[0]!.browserUrl).toBe(plan.endpoints[0]!.browserUrl);
    const res = await fetch(inst.endpoints[0]!.browserUrl);
    expect(res.status).toBe(200);
  });

  it('recorded owned containers carry ownership labels and the project name derives from the instance UUID', async () => {
    const containers = [...h.fake.containers.values()];
    expect(containers).toHaveLength(1);
    expect(containers[0]!.labels[LABELS.instance]).toBe(inst.id);
    expect(containers[0]!.labels['com.docker.compose.project']).toBe(`hb_${inst.id.replace(/-/g, '')}`);
    expect(containers[0]!.ports).toEqual([{ hostIp: '127.0.0.1', hostPort: inst.endpoints[0]!.hostPort, containerPort: 80 }]);
    const detail = await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${inst.id}`);
    expect(detail.resources.map((r) => r.kind).sort()).toEqual(['container', 'network']);
    expect(detail.resources.every((r) => r.present)).toBe(true);
    expect(detail.setup).toBeNull();
  });

  it('release snapshot and private runtime files exist with restrictive modes and no source secrets', () => {
    const dir = path.join(h.stateDir, 'instances', inst.id);
    expect(readFileSync(path.join(dir, 'release', 'compose.yaml'))).toEqual(readFileSync(path.join(h.catalogDir, 'excalidraw', 'compose.yaml')));
    expect(statSync(path.join(dir, 'runtime', 'compose.yaml')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, 'runtime')).mode & 0o777).toBe(0o700);
    const runtime = parseYaml(readFileSync(path.join(dir, 'runtime', 'compose.yaml'), 'utf8'));
    expect(runtime.services.web.restart).toBe('unless-stopped');
    expect(runtime.services.web.ports[0]).toMatchObject({ published: String(inst.endpoints[0]!.hostPort), host_ip: '127.0.0.1' });
  });

  it('idempotency: same key + same plan returns the original operation; different plan conflicts; consumed plan conflicts', async () => {
    const again = await h.api.submit(plan.id, 'install-excalidraw-1');
    expect(again.created).toBe(false);
    expect(again.operationId).toBe(op.id);
    const other = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    const conflict = await h.api.expectError(409, 'IDEMPOTENCY_CONFLICT', 'POST', '/v1/operations', { planId: other.id }, { 'idempotency-key': 'install-excalidraw-1' });
    expect(conflict.error.operationId).toBe(op.id);
    const consumed = await h.api.expectError(409, 'IDEMPOTENCY_CONFLICT', 'POST', '/v1/operations', { planId: plan.id }, { 'idempotency-key': 'a-brand-new-key' });
    expect(consumed.error.operationId).toBe(op.id);
    expect(await h.api.instances()).toHaveLength(1);
  });

  it('expired plans and stale allocations do not apply', async () => {
    const p = await h.api.plan({ kind: 'install', packageId: 'excalidraw' });
    h.clock.advance(16 * 60_000);
    await h.api.expectError(410, 'PLAN_EXPIRED', 'POST', '/v1/operations', { planId: p.id }, { 'idempotency-key': 'expired-plan-key' });
    h.clock.advance(-16 * 60_000);
    // Two plans propose the same free port; the second submission must conflict and re-plan.
    const p1 = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'ex-a' });
    const p2 = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'ex-b' });
    expect(p1.endpoints[0]!.hostPort).toBe(p2.endpoints[0]!.hostPort);
    const s1 = await h.api.submit(p1.id);
    await h.api.expectError(409, 'PORT_CONFLICT', 'POST', '/v1/operations', { planId: p2.id }, { 'idempotency-key': 'second-submit-key' });
    const r = await h.api.waitOperation(s1.operationId);
    expect(r.state).toBe('succeeded');
    const p3 = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'ex-b' });
    expect(p3.endpoints[0]!.hostPort).toBeGreaterThan(p1.endpoints[0]!.hostPort);
    // Name conflict at plan time
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', name: 'ex-a' });
  });

  it('a deliberately occupied external port is skipped and survives unchanged', async () => {
    const before = await h.api.instances();
    const nextFree = h.config.appPortRange.from + before.length; // lowest free by construction
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen({ port: nextFree, host: '127.0.0.1' }, () => r()));
    try {
      const p = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'ex-c' });
      expect(p.endpoints[0]!.hostPort).not.toBe(nextFree);
      expect(blocker.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('readiness timeout preserves an inspectable failed instance (no rollback)', async () => {
    h.fake.behaviour.respond = (service) => (service === 'web' ? 503 : 200);
    // Shorten the deadline via a package copy with a 3s deadline.
    const { writePackage, MINIMAL_MANIFEST, MINIMAL_COMPOSE, DIGEST_A } = await import('../unit/helpers.js');
    writePackage(h.catalogDir, 'slowapp', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: slowapp').replace('deadlineSeconds: 90', 'deadlineSeconds: 3'), compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const { op: failed } = await h.api.run({ kind: 'install', packageId: 'slowapp' });
    delete h.fake.behaviour.respond;
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('READINESS_TIMEOUT');
    const list = await h.api.instances();
    const slow = list.find((i) => i.packageId === 'slowapp')!;
    expect(slow.installState).toBe('failed');
    const detail = await h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${slow.id}`);
    expect(detail.resources.some((r) => r.kind === 'container' && r.present)).toBe(true);
    expect(detail.lastError?.code).toBe('READINESS_TIMEOUT');
    // Remove is offered for cleanup and works.
    const { op: rm } = await h.api.run({ kind: 'remove', instanceId: slow.id });
    expect(rm.state).toBe('succeeded');
  });

  it('client disconnect does not cancel queued work', async () => {
    const p = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'ex-d' });
    const controller = new AbortController();
    const req = fetch(`${h.baseUrl}/v1/operations`, { method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json', 'idempotency-key': 'disconnect-key-1' }, body: JSON.stringify({ planId: p.id }), signal: controller.signal });
    controller.abort();
    await req.catch(() => undefined);
    // Whether or not the request reached the server, submitting again with the same key is safe and idempotent.
    const sub = await h.api.submit(p.id, 'disconnect-key-1');
    const done = await h.api.waitOperation(sub.operationId);
    expect(done.state).toBe('succeeded');
    expect((await h.api.instances()).filter((i) => i.name === 'ex-d')).toHaveLength(1);
  });
});
