import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppBackupsDto, BackupsOverviewDto, BackupTargetDto, FoundBackupAppDto, InstanceSummary, PlanDto } from '../../src/contracts/api.js';
import { FakeBackupEngine } from '../../src/backups/engine.js';
import { startHarness, type Harness } from './harness.js';

// Decisions 149–154 (0.26.0): app backups end to end on the fake engine — places, policy, warm passes,
// the cold pass as a `backup` operation, the downtime cap, restore in place, restore on another machine.
const engine = new FakeBackupEngine();
let h: Harness;
let h2: Harness | null = null;
beforeAll(async () => {
  h = await startHarness({ overrides: { backupEngine: engine } });
});
afterAll(async () => {
  await h.close();
  if (h2) await h2.close();
});

const byName = async (hh: Harness, name: string) => (await hh.api.instances()).find((i) => i.name === name)!;
const dataFile = (inst: InstanceSummary) => {
  const home = inst.home!.path;
  const claim = readdirSync(path.join(home, 'volumes')).find((d) => !d.startsWith('.'))!;
  return path.join(home, 'volumes', claim, 'notes.txt');
};
const backups = (hh: Harness, id: string, refresh = false) => hh.api.expect<AppBackupsDto>(200, 'GET', `/v1/instances/${id}/backups${refresh ? '?refresh=true' : ''}`);
const drain = async (hh: Harness) => hh.daemon.ctx.backups!.drain();

describe('backup places (decision 152)', () => {
  let target: BackupTargetDto;
  let memos: InstanceSummary;
  let card: string;

  it('lists the bundled place types; nothing is installed yet', async () => {
    const o = await h.api.expect<BackupsOverviewDto>(200, 'GET', '/v1/backups');
    expect(o.engine).toBe('fake');
    expect(o.available).toBe(true);
    expect(o.packages.map((p) => p.id)).toEqual(['folder', 'protondrive', 's3', 'sftp']);
    expect(o.packages.find((p) => p.id === 'protondrive')!.status).toBe('beta');
    expect(o.targets).toEqual([]);
    expect(o.keyReady).toBe(false);
    expect(o.policy).toMatchObject({ window: '02:00', cadence: 'daily', maxDowntimeMinutes: 5 });
  });

  it('refuses incomplete answers and unknown fields before testing anything', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/backups/targets', { packageId: 's3', name: 'B2', values: { endpoint: 's3.example.com', bucket: 'b' } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'USB', values: { path: '/mnt/x', colour: 'red' } });
    expect(engine.calls).toEqual([]);
  });

  it('installs a place: an empty one is set up with the backup key and the Harbor card (issued once here)', async () => {
    const r = await h.api.expect<{ target: BackupTargetDto; recoveryKey: string | null }>(200, 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'USB backup', values: { path: '/mnt/backup/harbor' } });
    target = r.target;
    expect(target).toMatchObject({ packageId: 'folder', name: 'USB backup', repo: 'ready', values: { path: '/mnt/backup/harbor' } });
    expect(r.recoveryKey?.split(' ')).toHaveLength(12);
    card = r.recoveryKey!;
    // two keys at the place: the backup key and the card
    const remote = engine.remoteFor({ id: target.id, transport: 'local', config: { path: '/mnt/backup/harbor' }, fields: [] })!;
    expect([...remote.labels.values()].sort()).toEqual([expect.stringMatching(/^harbor-card-\d+/), 'root'].sort());
    expect([...remote.passwords.values()]).toContain(card);
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'USB backup', values: { path: '/mnt/other' } });
    // a secret field comes back redacted
    const s3 = await h.api.expect<{ target: BackupTargetDto }>(200, 'POST', '/v1/backups/targets', { packageId: 's3', name: 'B2', values: { endpoint: 's3.example.com', bucket: 'harbor-b', accessKeyId: 'AKIA-FIXTURE', secretAccessKey: 'secret-FIXTURE-value' } });
    expect(s3.target.values).toMatchObject({ secretAccessKey: '••••', accessKeyId: 'AKIA-FIXTURE', path: 'harbor' });
    expect(JSON.stringify(await h.api.expect(200, 'GET', '/v1/backups'))).not.toContain('secret-FIXTURE-value');
    await h.api.expect(200, 'POST', `/v1/backups/targets/${s3.target.id}/remove`, { deleteBackups: false });
  });

  it('only encrypted apps can be backed up', async () => {
    const plain = await h.api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(plain.op.state).toBe('succeeded');
    const ex = await byName(h, 'excalidraw');
    const e = await h.api.expectError(409, 'INVALID_STATE', 'PUT', `/v1/instances/${ex.id}/backups`, { enabled: true, targets: [target.id] });
    expect(e.error.nextAction).toMatch(/harbor seal excalidraw/);
  });

  it('backs an app up: warm pass while it runs, then the cold pass as a backup operation, one restore point', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'memos', location: { dir: path.join(h.userDataDir, 'harbor-apps', 'memos') } });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    memos = await byName(h, 'memos');
    mkdirSync(path.dirname(dataFile(memos)), { recursive: true });
    writeFileSync(dataFile(memos), 'version one');
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', `/v1/instances/${memos.id}/backups`, { enabled: true, targets: [] });
    const p = await h.api.expect<AppBackupsDto>(200, 'PUT', `/v1/instances/${memos.id}/backups`, { enabled: true, targets: [target.id] });
    expect(p.policy).toMatchObject({ enabled: true, targets: [target.id] });
    expect(p.nextAt).not.toBeNull();
    await h.api.expect(202, 'POST', `/v1/instances/${memos.id}/backups/run`, {});
    await drain(h);
    const b = await backups(h, memos.id);
    expect(b.runs[0], JSON.stringify(b.runs[0])).toMatchObject({ kind: 'backup', trigger: 'manual', state: 'succeeded' });
    expect(b.runs[0]!.downtimeSeconds).not.toBeNull();
    expect(b.points).toHaveLength(1);
    expect(b.points[0]!.places.map((x) => x.name)).toEqual(['USB backup']);
    const op = await h.api.expect<{ kind: string; state: string; result: Record<string, unknown> }>(200, 'GET', `/v1/operations/${b.runs[0]!.operationId}`);
    expect(op).toMatchObject({ kind: 'backup', state: 'succeeded' });
    // the warm snapshot was forgotten; the cold one holds the data and the state slice
    const remote = engine.remoteFor({ id: target.id, transport: 'local', config: { path: '/mnt/backup/harbor' }, fields: [] })!;
    const mine = remote.snapshots.filter((s) => s.tags.includes(`app:${memos.id}`));
    expect(mine.map((s) => s.tags.find((t) => t.startsWith('kind:')))).toEqual(['kind:cold']);
    expect([...mine[0]!.data.values()].map((v) => v.toString())).toContain('version one');
    expect(mine[0]!.stage.map((f) => f.path)).toEqual(expect.arrayContaining(['instance.json', 'home-manifest.json', 'app-key']));
    expect(mine[0]!.stage.some((f) => f.path.startsWith('release/'))).toBe(true);
    // the app is running again
    expect(await byName(h, 'memos')).toMatchObject({ runtime: 'running', installState: 'installed', desired: 'running' });
  });

  it('restores in place: the data of the restore point comes back, the current copy is kept aside', async () => {
    writeFileSync(dataFile(memos), 'version two');
    const point = (await backups(h, memos.id)).points[0]!;
    const plan = await h.api.plan({ kind: 'restore', instanceId: memos.id, runId: point.runId });
    expect(plan.kind).toBe('restore');
    expect(plan.warnings.join(' ')).toMatch(/only in the copy kept aside/);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const after = await byName(h, 'memos');
    expect(after).toMatchObject({ id: memos.id, runtime: 'running' });
    expect(readFileSync(dataFile(after), 'utf8')).toBe('version one');
    const b = await backups(h, memos.id);
    expect(b.previous?.path).toMatch(/\.before-restore-/);
    const kept = b.previous!.path;
    expect(readdirSync(path.join(kept, 'volumes')).length).toBeGreaterThan(0);
    // a second restore waits until the kept copy is dealt with
    await h.api.expectError(409, 'INVALID_STATE', 'POST', '/v1/plans', { kind: 'restore', instanceId: memos.id, runId: point.runId });
    await h.api.expect(200, 'DELETE', `/v1/instances/${memos.id}/backups/previous`);
    expect(existsSync(kept)).toBe(false);
    expect((await backups(h, memos.id)).previous).toBeNull();
  });

  it('a cold pass longer than the cap is stopped: the app starts again and the run fails loudly', async () => {
    engine.passSeconds = 10_000; // longer than 5 min, and too slow for warm passes to converge
    engine.churnBytes = [10 * 1024 * 1024]; // but the first warm pass moves little: it "fits"
    await h.api.expect(202, 'POST', `/v1/instances/${memos.id}/backups/run`, {});
    await drain(h);
    engine.passSeconds = 0;
    const b = await backups(h, memos.id);
    expect(b.runs[0], JSON.stringify(b.runs[0])).toMatchObject({ state: 'failed' });
    expect(b.runs[0]!.message).toMatch(/time limit|no backup place/);
    expect(await byName(h, 'memos')).toMatchObject({ runtime: 'running', installState: 'installed' });
    const n = (await h.api.expect<{ items: { kind: string; severity: string; instanceId: string | null; link: string | null }[] }>(200, 'GET', '/v1/notifications')).items;
    expect(n.find((x) => x.kind === 'backup-failed' && x.instanceId === memos.id)).toMatchObject({ severity: 'error', link: '#/settings/backups' });
  });

  it('an app that changes too fast is skipped without ever being stopped', async () => {
    engine.passSeconds = 1_000;
    engine.churnBytes = [2e9, 2e9, 2e9];
    await h.api.expect(202, 'POST', `/v1/instances/${memos.id}/backups/run`, {});
    await drain(h);
    engine.passSeconds = 0;
    engine.churnBytes = [];
    const b = await backups(h, memos.id);
    expect(b.runs[0]).toMatchObject({ state: 'skipped' });
    expect(b.runs[0]!.message).toMatch(/changes too fast/);
    expect(b.runs[0]!.operationId).toBeNull();
  });

  it('the schedule runs an app once per window', async () => {
    const now = new Date(h.clock.now().getTime() - 60_000);
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    await h.api.expect(200, 'PUT', '/v1/backups/policy', { window: hhmm });
    await h.daemon.ctx.backups!.tick();
    await drain(h);
    await h.daemon.ctx.backups!.tick();
    await drain(h);
    const runs = (await backups(h, memos.id)).runs.filter((r) => r.trigger === 'schedule');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state, JSON.stringify(runs[0])).toBe('succeeded');
    await h.api.expectError(422, 'INVALID_REQUEST', 'PUT', '/v1/backups/policy', { retention: { daily: 0, weekly: 0, monthly: 0 } });
  });

  it('restores the app on another machine with the first Harbor\'s recovery key', async () => {
    h2 = await startHarness({ overrides: { backupEngine: engine } });
    const r = await h2.api.expect<{ target: BackupTargetDto }>(200, 'POST', '/v1/backups/targets', { packageId: 'folder', name: 'Old USB', values: { path: '/mnt/backup/harbor' } });
    expect(r.target.repo).toBe('foreign');
    await h2.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/backups/targets/${r.target.id}/open`, { recoveryKey: 'one two three' });
    const opened = await h2.api.expect<BackupTargetDto>(200, 'POST', `/v1/backups/targets/${r.target.id}/open`, { recoveryKey: card.toUpperCase() });
    expect(opened.repo).toBe('ready');
    const found = (await h2.api.expect<{ items: FoundBackupAppDto[] }>(200, 'GET', `/v1/backups/targets/${r.target.id}/apps`)).items;
    const app = found.find((a) => a.instanceId === memos.id)!;
    expect(app).toMatchObject({ packageId: 'memos', installedHere: false });
    const point = app.points[0]!;
    const plan = await h2.api.expect<PlanDto>(201, 'POST', '/v1/backups/restore', { targetId: r.target.id, instanceId: memos.id, runId: point.runId, location: { dir: path.join(h2.userDataDir, 'harbor-apps', 'memos') } });
    expect(plan.kind).toBe('install');
    const op = await h2.api.waitOperation((await h2.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const restored = await byName(h2, 'memos');
    expect(restored.id).toBe(memos.id);
    expect(restored.home).toMatchObject({ encrypted: true, state: 'unlocked', defaultKey: true });
    expect(readFileSync(dataFile(restored), 'utf8')).toBe('version one');
    // the database password is the one the data was created with
    const secretsOf = (hh: Harness) => readdirSync(path.join(hh.stateDir, 'instances', memos.id, 'secrets')).sort().map((f) => readFileSync(path.join(hh.stateDir, 'instances', memos.id, 'secrets', f), 'utf8'));
    expect(secretsOf(h2)).toEqual(secretsOf(h));
    // the restored app can be backed up from here, to the same place
    await h2.api.expect(200, 'PUT', `/v1/instances/${memos.id}/backups`, { enabled: true, targets: [r.target.id] });
    await h2.api.expect(202, 'POST', `/v1/instances/${memos.id}/backups/run`, {});
    await drain(h2);
    expect((await backups(h2, memos.id)).runs[0]).toMatchObject({ state: 'succeeded' });
  });

  it('a locked app is skipped after a restart, not stopped', async () => {
    await h.restart({ login: false });
    await h.api.expect(202, 'POST', `/v1/instances/${memos.id}/backups/run`, {});
    await drain(h);
    const b = await backups(h, memos.id);
    expect(b.runs[0]).toMatchObject({ state: 'skipped' });
    expect(b.runs[0]!.message).toMatch(/locked|log in/i);
    await h.restart();
  });

  it('an app uninstalled completely comes back from its place under a fresh identity', async () => {
    const r = await h.api.run({ kind: 'purge', instanceId: memos.id });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    const found = (await h.api.expect<{ items: FoundBackupAppDto[] }>(200, 'GET', `/v1/backups/targets/${target.id}/apps`)).items.find((a) => a.instanceId === memos.id)!;
    expect(found.installedHere).toBe(false);
    const plan = await h.api.expect<PlanDto>(201, 'POST', '/v1/backups/restore', { targetId: target.id, instanceId: memos.id, runId: found.points[0]!.runId, location: { dir: path.join(h.userDataDir, 'harbor-apps', 'memos') } });
    expect(plan.instanceId).not.toBe(memos.id);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const back = await byName(h, 'memos');
    expect(back.id).toBe(plan.instanceId);
    expect(readFileSync(dataFile(back), 'utf8')).toBe('version one');
    expect(JSON.parse(readFileSync(path.join(back.home!.path, 'manifest.json'), 'utf8')).instanceId).toBe(back.id);
    memos = back;
    await h.api.expect(200, 'PUT', `/v1/instances/${memos.id}/backups`, { enabled: true, targets: [target.id] });
  });

  it('uninstalling a place keeps its backups unless asked, by name', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', `/v1/backups/targets/${target.id}/remove`, { deleteBackups: true, confirmName: 'usb' });
    const remote = engine.remoteFor({ id: target.id, transport: 'local', config: { path: '/mnt/backup/harbor' }, fields: [] })!;
    const before = remote.snapshots.length;
    await h.api.expect(200, 'POST', `/v1/backups/targets/${target.id}/remove`, { deleteBackups: false });
    expect(remote.snapshots.length).toBe(before);
    const o = await h.api.expect<BackupsOverviewDto>(200, 'GET', '/v1/backups');
    expect(o.targets).toEqual([]);
    expect(o.apps.find((a) => a.instanceId === memos.id)!.policy).toMatchObject({ enabled: false, targets: [] });
  });
});
