import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceDetail, InstanceSummary } from '../../src/contracts/api.js';
import { DIGEST_B, MINIMAL_MANIFEST, writePackage } from '../unit/helpers.js';
import { startHarness, type Harness } from './harness.js';

// "Bring your own folder": a package marks storage claims as external; the operator may bind them to
// host directories at install time. Harbor validates, records and mounts them, and never creates,
// chowns or deletes them.
let h: Harness;
let root: string;
beforeAll(async () => {
  h = await startHarness();
  root = mkdtempSync(path.join(tmpdir(), 'harbor-byof-'));
  for (const d of ['photos', 'music', 'other', 'nested']) mkdirSync(path.join(root, d));
  mkdirSync(path.join(root, 'nested', 'inner'));
  const storage = [
    'storage:',
    '  - {id: config, composeVolume: config, purpose: Configuration, retention: retain}',
    '  - id: library',
    '    composeVolume: library',
    '    purpose: Photo library',
    '    retention: retain',
    '    external: {hint: A folder with room for your photos}',
    '  - id: music',
    '    composeVolume: music',
    '    purpose: Music folder',
    '    retention: retain',
    '    external: {hint: Your music, readOnly: true}',
    '',
  ].join('\n');
  const compose = [
    'services:',
    '  web:',
    `    image: example/demo@${DIGEST_B}`,
    '    volumes:',
    '      - {type: volume, source: config, target: /config}',
    '      - {type: volume, source: library, target: /data}',
    '      - {type: volume, source: music, target: /music}',
    'volumes:',
    '  config: {}',
    '  library: {}',
    '  music: {}',
    '',
  ].join('\n');
  writePackage(h.catalogDir, 'mediaapp', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: mediaapp') + storage, compose, images: { web: `example/demo@${DIGEST_B}` } });
  const required = ['storage:', '  - id: media', '    composeVolume: media', '    purpose: Media', '    retention: retain', '    external: {hint: Required folder, required: true}', ''].join('\n');
  const composeReq = ['services:', '  web:', `    image: example/demo@${DIGEST_B}`, '    volumes:', '      - {type: volume, source: media, target: /media}', 'volumes:', '  media: {}', ''].join('\n');
  writePackage(h.catalogDir, 'needsfolder', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: needsfolder') + required, compose: composeReq, images: { web: `example/demo@${DIGEST_B}` } });
});
afterAll(async () => h.close());

const runtime = (id: string) => parseYaml(readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8'));
const detail = (id: string) => h.api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${id}`);

describe('external storage', () => {
  let inst: InstanceSummary;

  it('catalog exposes the claims so a console can offer the choice', async () => {
    const items = await h.api.expect<{ items: { id: string; claims: { id: string; external: { required: boolean; readOnly: boolean } | null }[] }[] }>(200, 'GET', '/v1/catalog');
    const app = items.items.find((i) => i.id === 'mediaapp')!;
    expect(app.claims.map((c) => [c.id, c.external?.readOnly ?? null])).toEqual([
      ['config', null],
      ['library', false],
      ['music', true],
    ]);
  });

  it('plans reject unknown claims, non-external claims, missing folders, system paths and required omissions', async () => {
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { nope: { hostPath: root } } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { config: { hostPath: root } } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: path.join(root, 'missing') } } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: '/etc' } } });
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: 'relative/path' } } });
    const e = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'needsfolder' });
    expect(e.error.nextAction).toMatch(/--storage media=/);
    await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: path.join(root, 'nested') }, music: { hostPath: path.join(root, 'nested', 'inner') } } });
    expect(await h.api.instances()).toHaveLength(0);
  });

  it('installs with a managed volume for one claim and the chosen folders for the others', async () => {
    const plan = await h.api.plan({ kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: path.join(root, 'photos') + '/' }, music: { hostPath: path.join(root, 'music') } } });
    expect(plan.storage.map((s) => [s.id, s.mode, s.hostPath, s.readOnly])).toEqual([
      ['config', 'managed', null, false],
      ['library', 'external', path.join(root, 'photos'), false],
      ['music', 'external', path.join(root, 'music'), true],
    ]);
    expect(plan.changes.join('\n')).toContain(`Use your folder ${path.join(root, 'photos')} for Photo library; Harbor never deletes it`);
    expect(plan.changes.join('\n')).toContain('(read-only)');
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    inst = (await h.api.instances())[0]!;
    const doc = runtime(inst.id);
    expect(doc.services.web.volumes).toEqual([
      { type: 'volume', source: 'config', target: '/config' },
      { type: 'bind', source: path.join(root, 'photos'), target: '/data', bind: { create_host_path: false } },
      { type: 'bind', source: path.join(root, 'music'), target: '/music', read_only: true, bind: { create_host_path: false } },
    ]);
    expect(Object.keys(doc.volumes)).toEqual(['config']); // only the managed claim is a Docker volume
    expect([...h.fake.volumes.keys()].filter((v) => v.includes(inst.id.replace(/-/g, '')))).toHaveLength(1);
    const d = await detail(inst.id);
    expect(d.resources.filter((r) => r.kind === 'bind').map((r) => [r.role, r.name, r.present])).toEqual([
      ['library', path.join(root, 'photos'), true],
      ['music', path.join(root, 'music'), true],
    ]);
  });

  it('a second install cannot reuse or nest into a folder another instance uses', async () => {
    const e = await h.api.expectError(409, 'OWNERSHIP_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: path.join(root, 'photos') } } });
    expect(e.error.message).toContain(inst.name);
    await h.api.expectError(409, 'OWNERSHIP_CONFLICT', 'POST', '/v1/plans', { kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: root } } });
    // a disjoint folder is fine (plan only; not submitted)
    await h.api.plan({ kind: 'install', packageId: 'mediaapp', storage: { library: { hostPath: path.join(root, 'other') } } });
  });

  it('remove keeps the folder records; reinstall verifies the folders and mounts them again', async () => {
    const rm = await h.api.run({ kind: 'remove', instanceId: inst.id });
    expect(rm.op.state).toBe('succeeded');
    expect(rm.op.events.map((e) => e.message).join('\n')).toContain(`your folder(s) untouched: ${path.join(root, 'photos')}, ${path.join(root, 'music')}`);
    expect(existsSync(path.join(root, 'photos'))).toBe(true);
    const plan = await h.api.plan({ kind: 'reinstall', instanceId: inst.id });
    expect(plan.storage.map((s) => [s.id, s.mode, s.state])).toEqual([
      ['config', 'managed', 'existing'],
      ['library', 'external', 'existing'],
      ['music', 'external', 'existing'],
    ]);
    const op = await h.api.waitOperation((await h.api.submit(plan.id)).operationId);
    expect(op.state).toBe('succeeded');
    expect(runtime(inst.id).services.web.volumes[1].source).toBe(path.join(root, 'photos'));
  });

  it('a folder that disappeared blocks reinstall with DATA_MISSING and nothing starts', async () => {
    const current = (await h.api.instances()).find((i) => i.id === inst.id)!;
    if (current.installState !== 'retained') await h.api.run({ kind: 'remove', instanceId: inst.id });
    renameSync(path.join(root, 'music'), path.join(root, 'music-moved'));
    const upsBefore = h.fake.log.filter((l) => l.startsWith('up ')).length;
    const r = await h.api.run({ kind: 'reinstall', instanceId: inst.id });
    expect(r.op.state).not.toBe('succeeded');
    expect(r.op.error?.code).toBe('DATA_MISSING');
    expect(r.op.error?.nextAction).toMatch(/same path/);
    expect(h.fake.log.filter((l) => l.startsWith('up ')).length).toBe(upsBefore);
    renameSync(path.join(root, 'music-moved'), path.join(root, 'music'));
  });
});
