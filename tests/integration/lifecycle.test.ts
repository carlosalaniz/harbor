import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { DIGEST_A, DIGEST_B, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';
import type { InstanceDetail, InstanceSummary, OperationDto, PlanDto, SystemDto } from '../../src/contracts/api.js';
import { LABELS } from '../../src/naming.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  // A synthetic stateful package (storage + secrets + configuration) exercises the generic engine
  // exactly the way n8n does, with no app-name branch anywhere.
  writePackage(h.catalogDir, 'statefulapp', {
    manifest:
      MINIMAL_MANIFEST.replace('id: demo', 'id: statefulapp')
        .replace('    web: application', '    web: application\n    db: infrastructure') +
      `storage:
  - {id: database, composeVolume: database, purpose: Database, retention: retain}
  - {id: app-state, composeVolume: app-state, purpose: State, retention: retain}
secrets:
  - id: db-password
    bytes: 32
    encoding: hex
    retention: retain
    bindings:
      - {service: db, environment: POSTGRES_PASSWORD}
      - {service: web, environment: DB_PASSWORD}
  - id: enc-key
    bytes: 32
    encoding: hex
    retention: retain
    bindings:
      - {service: web, environment: ENCRYPTION_KEY}
configuration:
  - {service: web, environment: PUBLIC_URL, endpoint: web}
`,
    compose: `services:
  db:
    image: example/db@${DIGEST_B}
    environment: {POSTGRES_USER: app, PRICE: "costs 5$ each"}
    healthcheck:
      test: [CMD, pg_isready, -U, app]
      interval: 5s
      timeout: 3s
      retries: 20
    volumes:
      - {type: volume, source: database, target: /var/lib/postgresql/data}
  web:
    image: example/web@${DIGEST_A}
    depends_on:
      db: {condition: service_healthy}
    volumes:
      - {type: volume, source: app-state, target: /home/app/state}
volumes:
  database: {}
  app-state: {}
`,
    images: { db: `example/db@${DIGEST_B}`, web: `example/web@${DIGEST_A}` },
  });
});
afterAll(async () => {
  await h.close();
});

const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const detail = (id: string) => h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`);
const containersOf = (projectSuffix: string) => [...h.fake.containers.values()].filter((c) => c.labels['com.docker.compose.project'] === projectSuffix);
const snapshot = (inst: InstanceSummary) => containersOf(`hb_${inst.id.replace(/-/g, '')}`).map((c) => ({ id: c.id, createdAt: c.createdAt, startedAt: c.startedAt, state: c.state }));

describe('two apps coexist through one generic path', () => {
  let a: InstanceSummary;
  let b: InstanceSummary;
  let aBefore: ReturnType<typeof snapshot>;
  let sentinel: { id: string; volume: string; network: string };

  it('creates an unrelated sentinel workload, installs A, then B without touching A', async () => {
    // Sentinel: not owned by Harbor (no ownership labels), occupies a project-like name and a volume.
    await h.fake.createVolume('unrelated_data', { owner: 'someone-else' });
    const netId = 'n' + 'f'.repeat(63);
    h.fake.networks.set(netId, { id: netId, name: 'unrelated_default', labels: {}, containerIds: [] });
    const cid = 'c' + 'e'.repeat(63);
    h.fake.containers.set(cid, { id: cid, name: 'unrelated-web-1', image: 'nginx@' + DIGEST_A, state: 'running', labels: { 'com.docker.compose.project': 'unrelated' }, createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', health: 'none', ports: [], networkIds: [netId], project: 'unrelated', service: 'web' });
    sentinel = { id: cid, volume: 'unrelated_data', network: netId };

    const ra = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(ra.op.state, JSON.stringify(ra.op.error)).toBe('succeeded');
    a = await byName('excalidraw');
    aBefore = snapshot(a);
    expect(aBefore).toHaveLength(1);

    const rb = await h.api.run({ kind: 'install', packageId: 'bentopdf' });
    expect(rb.op.state, JSON.stringify(rb.op.error)).toBe('succeeded');
    b = await byName('bentopdf');
    expect(b.endpoints[0]!.hostPort).not.toBe(a.endpoints[0]!.hostPort);
    expect(snapshot(a)).toEqual(aBefore); // A's container IDs and creation times unchanged
    expect((await byName('excalidraw')).readiness).toBe('healthy');
    expect((await fetch(a.endpoints[0]!.browserUrl)).status).toBe(200);
    expect((await fetch(b.endpoints[0]!.browserUrl)).status).toBe(200);
  });

  it('a second Excalidraw gets a distinct instance, project, network and port', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(r.op.state).toBe('succeeded');
    const a2 = await byName('excalidraw-2');
    expect(a2.id).not.toBe(a.id);
    expect(a2.endpoints[0]!.hostPort).not.toBe(a.endpoints[0]!.hostPort);
    const d1 = await detail(a.id);
    const d2 = await detail(a2.id);
    const net = (d: InstanceDetail) => d.resources.find((x) => x.kind === 'network')!.name;
    expect(net(d1)).not.toBe(net(d2));
    expect(net(d1)).toBe(`hb_${a.id.replace(/-/g, '')}_default`);
    expect(snapshot(a)).toEqual(aBefore);
  });

  it('stop/remove B leaves A and the sentinel unchanged and retains B identity', async () => {
    const stop = await h.api.run({ kind: 'stop', instanceId: b.id });
    expect(stop.op.state).toBe('succeeded');
    b = await byName('bentopdf');
    expect(b).toMatchObject({ desired: 'stopped', runtime: 'stopped', readiness: 'unknown', installState: 'installed' });
    expect(snapshot(a)).toEqual(aBefore);

    const rm = await h.api.run({ kind: 'remove', instanceId: b.id });
    expect(rm.op.state).toBe('succeeded');
    b = await byName('bentopdf');
    expect(b).toMatchObject({ desired: 'retained', installState: 'retained', hasRetainedData: true });
    expect(b.endpoints[0]!.hostPort).toBeDefined(); // allocation retained
    expect(containersOf(`hb_${b.id.replace(/-/g, '')}`)).toHaveLength(0);
    // Sentinel untouched
    expect(h.fake.containers.get(sentinel.id)?.state).toBe('running');
    expect(h.fake.volumes.has(sentinel.volume)).toBe(true);
    expect(h.fake.networks.has(sentinel.network)).toBe(true);
    expect(snapshot(a)).toEqual(aBefore);
    // Port stays claimed: a new install does not take B's port
    const p = await h.api.plan({ kind: 'install', packageId: 'bentopdf', name: 'pdf-two' });
    expect(p.endpoints[0]!.hostPort).not.toBe(b.endpoints[0]!.hostPort);
    // Reinstall works for the retained instance (everInstalled=true) and reuses the port.
    const ri = await h.api.run({ kind: 'reinstall', instanceId: b.id });
    expect(ri.op.state, JSON.stringify(ri.op.error)).toBe('succeeded');
    const b2 = await byName('bentopdf');
    expect(b2.endpoints[0]!.hostPort).toBe(b.endpoints[0]!.hostPort);
    expect(b2.installState).toBe('installed');
    expect(snapshot(a)).toEqual(aBefore);
  });

  it('start on a stopped instance verifies and starts only its containers', async () => {
    await h.api.run({ kind: 'stop', instanceId: a.id });
    const r = await h.api.run({ kind: 'start', instanceId: a.id });
    expect(r.op.state).toBe('succeeded');
    const after = snapshot(a);
    expect(after.map((c) => c.id)).toEqual(aBefore.map((c) => c.id)); // same containers, not recreated
    expect((await byName('excalidraw')).readiness).toBe('healthy');
    aBefore = after;
  });

  it('invalid plan kinds for the current state are rejected with INVALID_STATE', async () => {
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'start', instanceId: a.id });
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'reinstall', instanceId: a.id });
    const c = await byName('excalidraw-2');
    await h.api.run({ kind: 'remove', instanceId: c.id });
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'remove', instanceId: c.id });
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'stop', instanceId: c.id });
  });

  it('stale generation: a plan created before another operation completes is rejected', async () => {
    const stale = await h.api.plan({ kind: 'stop', instanceId: a.id });
    const fresh = await h.api.plan({ kind: 'stop', instanceId: a.id });
    const r = await h.api.submit(fresh.id);
    await h.api.waitOperation(r.operationId);
    await h.api.expectError(409, 'STATE_CHANGED', 'POST', '/v1/operations', { planId: stale.id }, { 'idempotency-key': 'stale-generation-key' });
    await h.api.run({ kind: 'start', instanceId: a.id });
  });
});

describe('stateful package: volumes, secrets, retention (generic engine, synthetic package)', () => {
  let s1: InstanceSummary;
  let s2: InstanceSummary;
  const secretsDir = (inst: InstanceSummary) => path.join(h.stateDir, 'instances', inst.id, 'secrets');
  const runtimeCompose = (inst: InstanceSummary) => readFileSync(path.join(h.stateDir, 'instances', inst.id, 'runtime', 'compose.yaml'), 'utf8');

  it('installs with owned external volumes and generated secrets; bindings share values; instances differ', async () => {
    const r1 = await h.api.run({ kind: 'install', packageId: 'statefulapp' });
    expect(r1.op.state, JSON.stringify(r1.op.error)).toBe('succeeded');
    s1 = await byName('statefulapp');
    const r2 = await h.api.run({ kind: 'install', packageId: 'statefulapp' });
    expect(r2.op.state).toBe('succeeded');
    s2 = await byName('statefulapp-2');

    const project = `hb_${s1.id.replace(/-/g, '')}`;
    for (const v of ['database', 'app-state']) {
      const vol = h.fake.volumes.get(`${project}_${v}`)!;
      expect(vol).toBeDefined();
      expect(vol.labels[LABELS.instance]).toBe(s1.id);
      expect(vol.labels[LABELS.token]).toMatch(/^[a-f0-9]{32}$/);
    }
    const yaml1 = runtimeCompose(s1);
    const pw1 = readFileSync(path.join(secretsDir(s1), 'db-password'), 'utf8');
    const key1 = readFileSync(path.join(secretsDir(s1), 'enc-key'), 'utf8');
    expect(pw1).toMatch(/^[a-f0-9]{64}$/);
    expect(yaml1.split(pw1).length - 1).toBe(2); // both bindings, same value
    expect(yaml1.split(key1).length - 1).toBe(1);
    expect(yaml1).toContain('costs 5$$ each'); // literal dollar escaped
    expect(yaml1).toContain(`PUBLIC_URL: "http://localhost:${s1.endpoints[0]!.hostPort}/"`);
    expect(yaml1).toContain('external: true');
    const pw2 = readFileSync(path.join(secretsDir(s2), 'db-password'), 'utf8');
    expect(pw2).not.toBe(pw1);
    expect(r1.plan.storage.map((s) => s.volumeName).sort()).toEqual([`${project}_app-state`, `${project}_database`].sort());
    expect(r1.plan.secrets.map((s) => s.id).sort()).toEqual(['db-password', 'enc-key']);
  });

  it('no secret value appears in plans, DTOs, events or the source catalog', async () => {
    const pw1 = readFileSync(path.join(secretsDir(s1), 'db-password'), 'utf8');
    const key1 = readFileSync(path.join(secretsDir(s1), 'enc-key'), 'utf8');
    const blobs = [
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/instances/${s1.id}`)),
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/instances`)),
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/operations/${s1.operationId}`)),
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/plans/${(await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${s1.operationId}`)).planId}`)),
      readFileSync(path.join(h.catalogDir, 'statefulapp', 'compose.yaml'), 'utf8'),
      readFileSync(path.join(h.stateDir, 'instances', s1.id, 'release', 'compose.yaml'), 'utf8'),
    ];
    for (const b of blobs) {
      expect(b).not.toContain(pw1);
      expect(b).not.toContain(key1);
    }
  });

  it('stop/start and remove/reinstall preserve exact secrets and volume identity', async () => {
    const project = `hb_${s1.id.replace(/-/g, '')}`;
    const volBefore = { ...h.fake.volumes.get(`${project}_database`)! };
    const pw = readFileSync(path.join(secretsDir(s1), 'db-password'), 'utf8');
    expect((await h.api.run({ kind: 'stop', instanceId: s1.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: s1.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'remove', instanceId: s1.id })).op.state).toBe('succeeded');
    expect(h.fake.volumes.get(`${project}_database`)).toEqual(volBefore); // retained, untouched
    expect(existsSync(path.join(secretsDir(s1), 'db-password'))).toBe(true);
    const ri = await h.api.run({ kind: 'reinstall', instanceId: s1.id });
    expect(ri.op.state, JSON.stringify(ri.op.error)).toBe('succeeded');
    expect(readFileSync(path.join(secretsDir(s1), 'db-password'), 'utf8')).toBe(pw);
    expect(h.fake.volumes.get(`${project}_database`)).toEqual(volBefore);
    expect(runtimeCompose(s1).split(pw).length - 1).toBe(2);
    expect(ri.plan.storage.every((s) => s.state === 'existing')).toBe(true);
    expect(ri.plan.secrets.every((s) => s.state === 'existing')).toBe(true);
  });

  it('a pre-existing volume with the owned name blocks a fresh install (OWNERSHIP_CONFLICT) before Compose runs', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'statefulapp', name: 'clash' });
    const volName = plan.storage.find((s) => s.id === 'database')!.volumeName!;
    await h.fake.createVolume(volName, { owner: 'foreign' });
    const sub = await h.api.submit(plan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state).toBe('needs_action');
    expect(op.error?.code).toBe('OWNERSHIP_CONFLICT');
    expect(h.fake.log.filter((l) => l.startsWith('up ') && l.includes(plan.instanceId.replace(/-/g, '')))).toHaveLength(0);
    expect(h.fake.volumes.get(volName)?.labels['owner']).toBe('foreign'); // untouched
  });

  it('volume replaced by another token blocks start and reinstall (DATA_MISSING); nothing is created', async () => {
    const project = `hb_${s2.id.replace(/-/g, '')}`;
    await h.api.run({ kind: 'stop', instanceId: s2.id });
    const real = h.fake.volumes.get(`${project}_database`)!;
    h.fake.volumes.set(`${project}_database`, { ...real, labels: { ...real.labels, [LABELS.token]: 'deadbeef'.repeat(4) } });
    const st = await h.api.run({ kind: 'start', instanceId: s2.id });
    expect(st.op.state).toBe('needs_action');
    expect(st.op.error?.code).toBe('DATA_MISSING');
    // Remove (allowed from needs_action), then reinstall must also block while the volume is foreign.
    expect((await h.api.run({ kind: 'remove', instanceId: s2.id })).op.state).toBe('succeeded');
    h.fake.volumes.delete(`${project}_database`);
    const ri = await h.api.run({ kind: 'reinstall', instanceId: s2.id });
    expect(ri.op.state).toBe('needs_action');
    expect(ri.op.error?.code).toBe('DATA_MISSING');
    expect(h.fake.volumes.has(`${project}_database`)).toBe(false); // no replacement initialized
    expect(containersOf(project)).toHaveLength(0);
    // Restore the exact volume: reinstall proceeds.
    h.fake.volumes.set(`${project}_database`, real);
    const ok = await h.api.run({ kind: 'reinstall', instanceId: s2.id });
    expect(ok.op.state, JSON.stringify(ok.op.error)).toBe('succeeded');
  });

  it('a missing secret blocks reinstall (SECRET_MISSING) rather than regenerating', async () => {
    expect((await h.api.run({ kind: 'remove', instanceId: s2.id })).op.state).toBe('succeeded');
    const file = path.join(secretsDir(s2), 'enc-key');
    const value = readFileSync(file, 'utf8');
    rmSync(file);
    const ri = await h.api.run({ kind: 'reinstall', instanceId: s2.id });
    expect(ri.op.state).toBe('needs_action');
    expect(ri.op.error?.code).toBe('SECRET_MISSING');
    expect(existsSync(file)).toBe(false);
    // Restoring the file from "backup" makes the same instance reinstallable with the same key.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, value, { mode: 0o600 });
    const ok = await h.api.run({ kind: 'reinstall', instanceId: s2.id });
    expect(ok.op.state, JSON.stringify(ok.op.error)).toBe('succeeded');
    expect(runtimeCompose(s2)).toContain(value);
  });
});

describe('daemon restart and Docker unavailability', () => {
  it('an operation in flight during shutdown becomes needs_action on restart and is not replayed', async () => {
    h.fake.behaviour.respond = (service) => (service === 'web' ? 'hang' : 200);
    const plan = await h.api.plan({ kind: 'install', packageId: 'excalidraw', name: 'interrupted' });
    const sub = await h.api.submit(plan.id);
    // Wait until the operation reaches the readiness phase.
    for (let i = 0; i < 100; i++) {
      const op = await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${sub.operationId}`);
      if (op.phase === 'checking') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const upCount = h.fake.log.filter((l) => l.startsWith('up ')).length;
    await h.restart();
    delete h.fake.behaviour.respond;
    const op = await h.api.expect<OperationDto>(200, 'GET', `/v1/operations/${sub.operationId}`);
    expect(op.state).toBe('needs_action');
    expect(op.events.some((e) => e.message.includes('daemon restarted'))).toBe(true);
    const inst = await byName('interrupted');
    expect(inst.installState).toBe('needs_action');
    expect(inst.operationId).toBe(sub.operationId);
    expect(h.fake.log.filter((l) => l.startsWith('up ')).length).toBe(upCount); // no replay
    // Allocations kept; safe remove works after confirming ownership.
    expect(inst.endpoints).toHaveLength(1);
    const rm = await h.api.run({ kind: 'remove', instanceId: inst.id });
    expect(rm.op.state).toBe('succeeded');
  });

  it('a completed instance keeps running across a daemon restart (Docker keeps it), state is re-observed', async () => {
    const a = await byName('excalidraw');
    const before = snapshot(a);
    await h.restart();
    expect(snapshot(a)).toEqual(before);
    await new Promise((r) => setTimeout(r, 700));
    const after = await byName('excalidraw');
    expect(after.runtime).toBe('running');
    expect(after.readiness).toBe('healthy');
  });

  it('Docker unavailable yields unavailable/unknown (never healthy) and mutations fail with 503', async () => {
    h.fake.behaviour.engineDown = true;
    await new Promise((r) => setTimeout(r, 1200));
    const sys = await h.api.expect<SystemDto>(200, 'GET', '/v1/system');
    expect(sys.docker.available).toBe(false);
    const a = await byName('excalidraw');
    expect(a.runtime).toBe('unavailable');
    expect(a.readiness).toBe('unknown');
    await h.api.expectError(503, 'DOCKER_UNAVAILABLE', 'POST', '/v1/plans', { kind: 'install', packageId: 'excalidraw', name: 'while-down' });
    const stopPlan: PlanDto = await h.api.plan({ kind: 'stop', instanceId: a.id });
    const sub = await h.api.submit(stopPlan.id);
    const op = await h.api.waitOperation(sub.operationId);
    expect(op.state).toBe('failed');
    expect(op.error?.code).toBe('DOCKER_UNAVAILABLE');
    h.fake.behaviour.engineDown = false;
    await new Promise((r) => setTimeout(r, 1200));
    expect((await byName('excalidraw')).runtime).toBe('running');
  });
});
