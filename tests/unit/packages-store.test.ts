import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeRegistry, parseImageRef } from '../../src/packages/registry.js';
import { PackageStore, compareRevisions } from '../../src/packages/store.js';
import { readZip, writeZip } from '../../src/packages/zip.js';
import { systemClock } from '../../src/util.js';
import { DIGEST_A, DIGEST_B, REPO_CATALOG } from './helpers.js';

const MANIFEST = (rev: string, extra = '') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: hello
  name: Hello
  description: A tiny web page
release:
  revision: "${rev}"
  version: "1.${rev}.0"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
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
  deadlineSeconds: 60
ui:
  primaryEndpoint: web
${extra}`;
const COMPOSE = (image: string) => `services:
  web:
    image: ${image}
`;

describe('zip reader', () => {
  it('reads stored entries, strips a single top folder, and rejects tricks', () => {
    const z = writeZip({ 'manifest.yaml': 'a: 1', 'compose.yaml': 'b: 2', 'icon.svg': '<svg/>' }, { folder: 'my-app' });
    const files = readZip(z);
    expect([...files.keys()].sort()).toEqual(['compose.yaml', 'icon.svg', 'manifest.yaml']);
    expect(files.get('manifest.yaml')!.toString()).toBe('a: 1');
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow(/end-of-central-directory/);
    expect(() => readZip(writeZip({ '../evil.txt': 'x' }))).toThrow(/unsafe path/);
    expect(() => readZip(writeZip({ '/abs.txt': 'x' }))).toThrow(/unsafe path/);
    // corrupt a byte of the data: CRC catches it
    const bad = Buffer.from(writeZip({ 'manifest.yaml': 'hello world' }));
    const at = 30 + 'manifest.yaml'.length + 2;
    bad.writeUInt8(bad.readUInt8(at) ^ 0xff, at);
    expect(() => readZip(bad)).toThrow(/CRC/);
    expect(() => readZip(writeZip({ 'a.txt': 'x' }), { maxEntries: 0, maxFileBytes: 10, maxTotalBytes: 10 })).toThrow(/too many files/);
  });
});

describe('image references and revisions', () => {
  it('parses docker hub shorthands, registries, tags and digests', () => {
    expect(parseImageRef('nginx')).toMatchObject({ registry: 'registry-1.docker.io', repo: 'library/nginx', tag: null, display: 'nginx' });
    expect(parseImageRef('nginx:1.27-alpine')).toMatchObject({ repo: 'library/nginx', tag: '1.27-alpine', display: 'nginx' });
    expect(parseImageRef('docker.io/excalidraw/excalidraw@sha256:' + 'a'.repeat(64))).toMatchObject({ repo: 'excalidraw/excalidraw', digest: 'sha256:' + 'a'.repeat(64), display: 'excalidraw/excalidraw' });
    expect(parseImageRef('ghcr.io/immich-app/immich-server:v2.0.0')).toMatchObject({ registry: 'ghcr.io', repo: 'immich-app/immich-server', tag: 'v2.0.0', display: 'ghcr.io/immich-app/immich-server' });
    expect(parseImageRef('localhost:5000/team/app:1')).toMatchObject({ registry: 'localhost:5000', repo: 'team/app', tag: '1' });
  });
  it('orders revisions numerically when possible', () => {
    expect(compareRevisions('2', '10')).toBe(-1);
    expect(compareRevisions('10', '2')).toBe(1);
    expect(compareRevisions('1.2', '1.10')).toBe(-1);
    expect(compareRevisions('3', '3')).toBe(0);
    expect(compareRevisions('b', 'a')).toBe(1);
  });
});

describe('package store: your own apps', () => {
  const setup = () => {
    const local = mkdtempSync(path.join(tmpdir(), 'harbor-local-'));
    const registry = new FakeRegistry().add('nginx:1.27-alpine', DIGEST_A, { created: '2026-01-02T00:00:00Z' }).add('nginx:1.28-alpine', DIGEST_B);
    return { store: new PackageStore(REPO_CATALOG, local, registry, systemClock), registry, local };
  };
  it('imports a zip with tag images, pins them by digest, generates release.json, lists it next to the bundled catalog', async () => {
    const { store, registry } = setup();
    const zip = writeZip({ 'manifest.yaml': MANIFEST('1', 'presentation:\n  icon: icon.svg\n  tagline: Says hello\n'), 'compose.yaml': COMPOSE('nginx:1.27-alpine'), 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'notes.txt': 'ignored' }, { folder: 'hello' });
    const r = await store.importZip(zip, { fileName: 'hello.zip', actor: 'admin' });
    expect(r.item).toMatchObject({ id: 'hello', origin: 'local', revision: '1', version: '1.1.0', availability: 'available', qualification: 'pending' });
    expect(r.pinned).toEqual([{ service: 'web', from: 'nginx:1.27-alpine', to: `nginx@${DIGEST_A}` }]);
    expect(r.notes.join(' ')).toMatch(/No README\.md/);
    expect(r.notes.join(' ')).toMatch(/Ignored 1 file/);
    expect(registry.calls).toEqual(['nginx:1.27-alpine']);
    const pkg = store.load('hello');
    expect(pkg.compose.services['web']!.image).toBe(`nginx@${DIGEST_A}`);
    expect(pkg.release.images['web']).toMatchObject({ reference: `nginx@${DIGEST_A}`, repository: 'nginx', tag: '1.27-alpine', imageCreated: '2026-01-02T00:00:00Z' });
    expect(pkg.assets['icon.svg']).toBeDefined();
    expect(store.list().map((i) => i.id)).toContain('hello');
    expect(store.list().find((i) => i.id === 'excalidraw')?.origin).toBe('bundled');
    expect(store.currentRevisions().get('hello')).toEqual({ revision: '1', version: '1.1.0', releaseNotes: null });
  });
  it('refuses built-in ids, unknown images, older or conflicting revisions; accepts a higher revision as an update', async () => {
    const { store } = setup();
    await expect(store.importZip(writeZip({ 'manifest.yaml': MANIFEST('1').replace('id: hello', 'id: excalidraw'), 'compose.yaml': COMPOSE('nginx:1.27-alpine') }), { fileName: 'x.zip', actor: 'admin' })).rejects.toThrow(/belongs to a built-in app/);
    await expect(store.importZip(writeZip({ 'manifest.yaml': MANIFEST('1'), 'compose.yaml': COMPOSE('nginx:does-not-exist') }), { fileName: 'x.zip', actor: 'admin' })).rejects.toThrow(/could not be resolved/);
    await expect(store.importZip(writeZip({ 'compose.yaml': COMPOSE('nginx:1.27-alpine') }), { fileName: 'x.zip', actor: 'admin' })).rejects.toThrow(/no manifest\.yaml/);
    await store.importZip(writeZip({ 'manifest.yaml': MANIFEST('2'), 'compose.yaml': COMPOSE('nginx:1.27-alpine') }), { fileName: 'hello.zip', actor: 'admin' });
    await expect(store.importZip(writeZip({ 'manifest.yaml': MANIFEST('1'), 'compose.yaml': COMPOSE('nginx:1.27-alpine') }), { fileName: 'hello.zip', actor: 'admin' })).rejects.toThrow(/older than the installed package revision 2/);
    await expect(store.importZip(writeZip({ 'manifest.yaml': MANIFEST('2'), 'compose.yaml': COMPOSE('nginx:1.28-alpine') }), { fileName: 'hello.zip', actor: 'admin' })).rejects.toThrow(/already uploaded with different files/);
    const same = await store.importZip(writeZip({ 'manifest.yaml': MANIFEST('2'), 'compose.yaml': COMPOSE('nginx:1.27-alpine') }), { fileName: 'hello.zip', actor: 'admin' });
    expect(same.notes.join(' ')).toMatch(/identical files; nothing changed/);
    const up = await store.importZip(writeZip({ 'manifest.yaml': MANIFEST('3'), 'compose.yaml': COMPOSE('nginx:1.28-alpine') }), { fileName: 'hello-3.zip', actor: 'admin' });
    expect(up.replacedRevision).toBe('2');
    expect(store.load('hello').revision).toBe('3');
    expect(store.load('hello').compose.services['web']!.image).toBe(`nginx@${DIGEST_B}`);
    store.removeLocal('hello');
    expect(store.list().some((i) => i.id === 'hello')).toBe(false);
    expect(() => store.removeLocal('excalidraw')).toThrow(/built-in/);
  });
});
