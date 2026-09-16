import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddSourceResult, InstanceSummary, PackageSourceDto } from '../../src/contracts/api.js';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const REPO = 'https://github.com/carlos/my-notes';
const MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: my-notes
  name: My Notes
  description: A tiny app built from my own repository
release:
  revision: "1"
  version: "0.1.0"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 3000
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
presentation:
  tagline: Notes from my repo
  category: developer
`;
const COMPOSE_BUILD = `services:
  web:
    build:
      context: ../app
`;
const commitFiles = (marker: string): Record<string, string> => ({
  'harbor/manifest.yaml': MANIFEST,
  'harbor/compose.yaml': COMPOSE_BUILD,
  'app/Dockerfile': `FROM scratch\n# ${marker}\n`,
  'app/server.js': `// ${marker}`,
});
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name);
const waitFor = async (fn: () => Promise<boolean>, ms = 20000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 300));
  }
};

describe('git app sources: add, build from source, redeploy on commit (decision 80)', () => {
  let source: PackageSourceDto;
  let inst: InstanceSummary;

  it('adds a repository: fetches the branch, imports harbor/, records the pinned commit', async () => {
    h.git.setRepo(REPO, 'main', [{ commit: 'a'.repeat(40), committerDateUnix: 1_760_000_000, files: commitFiles('v1') }]);
    const r = await h.api.expect<AddSourceResult>(201, 'POST', '/v1/package-sources', { url: REPO, ref: 'main' });
    source = r.source;
    expect(source.packageId).toBe('my-notes');
    expect(source.pinnedCommit).toBe('a'.repeat(40));
    expect(source.autoRedeploy).toBe(false);
    expect(source.updateAvailable).toBe(false);
    // the revision carries the committer date so every commit orders as newer
    expect(r.import.item.revision).toBe('1.1760000000');
    // release.json records the build with the commit, no registry images
    const rel = JSON.parse(readFileSync(path.join(h.stateDir, 'packages', 'my-notes', 'release.json'), 'utf8'));
    expect(rel.builds.web).toMatchObject({ context: '../app', commit: 'a'.repeat(40), tag: `harbor-src/my-notes-web:${'a'.repeat(12)}` });
    expect(rel.images).toEqual({});
    // duplicate source refused
    await h.api.expectError(409, 'NAME_CONFLICT', 'POST', '/v1/package-sources', { url: REPO, ref: 'main' });
  });

  it('installs the app: Harbor builds the image from the snapshot and starts it', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'my-notes' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    inst = (await byName('my-notes'))!;
    expect(inst.revision).toBe('1.1760000000');
    expect(h.fake.builtTags).toContain(`harbor-src/my-notes-web:${'a'.repeat(12)}`);
    const events = (await h.api.expect<{ events: { message: string }[] }>(200, 'GET', `/v1/operations/${inst.operationId}`)).events;
    expect(events.map((e) => e.message).join('\n')).toMatch(/building web from commit aaaaaaaaaaaa/);
    // the build context was snapshotted into the instance release
    expect(readFileSync(path.join(h.stateDir, 'instances', inst.id, 'release', 'build', 'web', 'Dockerfile'), 'utf8')).toContain('v1');
  });

  it('a new commit is noticed by the poller and, without auto-redeploy, only notifies', async () => {
    h.git.push(REPO, { commit: 'b'.repeat(40), committerDateUnix: 1_760_000_500, files: commitFiles('v2') });
    await waitFor(async () => {
      const s = (await h.api.expect<{ items: PackageSourceDto[] }>(200, 'GET', '/v1/package-sources')).items[0]!;
      return s.pinnedCommit === 'b'.repeat(40);
    });
    // imported as a newer revision -> the app shows an update; nothing deployed by itself
    await waitFor(async () => (await byName('my-notes'))!.updateAvailable?.revision === '1.1760000500');
    expect((await byName('my-notes'))!.revision).toBe('1.1760000000');
    const n = await h.api.expect<{ items: { kind: string; body: string }[] }>(200, 'GET', '/v1/notifications');
    expect(n.items.some((x) => x.kind === 'source-commit' && x.body.includes('bbbbbbbbbbbb'))).toBe(true);
  });

  it('manual update deploys the new commit (normal update flow with rollback)', async () => {
    const r = await h.api.run({ kind: 'update', instanceId: inst.id });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    const after = (await byName('my-notes'))!;
    expect(after.revision).toBe('1.1760000500');
    expect(h.fake.builtTags).toContain(`harbor-src/my-notes-web:${'b'.repeat(12)}`);
  });

  it('redeploy-on-commit: with the toggle on, a push deploys itself', async () => {
    const s = await h.api.expect<PackageSourceDto>(200, 'PUT', `/v1/package-sources/${source.id}/auto-redeploy`, { enabled: true });
    expect(s.autoRedeploy).toBe(true);
    h.git.push(REPO, { commit: 'c'.repeat(40), committerDateUnix: 1_760_001_000, files: commitFiles('v3') });
    await waitFor(async () => {
      const i = (await byName('my-notes'))!;
      return i.revision === '1.1760001000' && i.installState === 'installed';
    });
    expect(h.fake.builtTags).toContain(`harbor-src/my-notes-web:${'c'.repeat(12)}`);
    // deployed by the git-source actor
    const i = (await byName('my-notes'))!;
    const op = await h.api.expect<{ kind: string; state: string }>(200, 'GET', `/v1/operations/${i.operationId}`);
    expect(op.kind).toBe('update');
    expect(op.state).toBe('succeeded');
  });

  it('a broken commit is imported nowhere: the app keeps running, the source records the failure', async () => {
    h.git.push(REPO, { commit: 'd'.repeat(40), committerDateUnix: 1_760_002_000, files: { 'harbor/manifest.yaml': 'not: [valid', 'harbor/compose.yaml': COMPOSE_BUILD, 'app/Dockerfile': 'FROM scratch\n' } });
    await waitFor(async () => {
      const s = (await h.api.expect<{ items: PackageSourceDto[] }>(200, 'GET', '/v1/package-sources')).items[0]!;
      return s.note !== null && s.note.includes('dddddddddddd');
    });
    const i = (await byName('my-notes'))!;
    expect(i.revision).toBe('1.1760001000');
    expect(i.installState).toBe('installed');
    const n = await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications');
    expect(n.items.some((x) => x.kind === 'source-broken')).toBe(true);
  });

  it('a build failure during redeploy rolls the app back to the previous commit', async () => {
    // the next commit is valid but the build fails
    h.fake.behaviour.failBuild = 'RUN exited 1 (simulated)';
    h.git.push(REPO, { commit: 'e'.repeat(40), committerDateUnix: 1_760_003_000, files: commitFiles('v5') });
    await waitFor(async () => {
      const i = (await byName('my-notes'))!;
      if (i.revision !== '1.1760001000' || !i.operationId) return false;
      const op = await h.api.expect<{ state: string; kind: string; result?: Record<string, unknown> }>(200, 'GET', `/v1/operations/${i.operationId}`);
      return op.kind === 'update' && op.state === 'failed' && op.result?.['rolledBack'] === true;
    }, 30000);
    h.fake.behaviour.failBuild = null;
    const i = (await byName('my-notes'))!;
    expect(i.installState).toBe('installed');
    expect(i.readiness).toBe('healthy');
  });

  it('zip uploads may not declare build: (git sources only); removing the source keeps the app', async () => {
    const { writeZip } = await import('../../src/packages/zip.js');
    await h.api.expectError(422, 'INVALID_PACKAGE', 'POST', '/v1/packages', {
      fileName: 'x.zip',
      dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': MANIFEST.replace('id: my-notes', 'id: sneaky').replace('name: My Notes', 'name: Sneaky'), 'compose.yaml': COMPOSE_BUILD }).toString('base64')}`,
    });
    await h.api.expect(204, 'DELETE', `/v1/package-sources/${source.id}`);
    expect((await h.api.expect<{ items: PackageSourceDto[] }>(200, 'GET', '/v1/package-sources')).items).toEqual([]);
    expect((await byName('my-notes'))!.installState).toBe('installed');
  });
});
