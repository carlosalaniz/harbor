import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../../src/packages/inventory.js';

export const REPO_CATALOG = path.resolve(import.meta.dirname, '../../catalog');

export function tempDir(prefix = 'harbor-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// Copy the real catalog into a temp dir so tests can mutate a package without touching the repo.
export function cloneCatalog(): string {
  const dir = tempDir('harbor-catalog-');
  cpSync(REPO_CATALOG, dir, { recursive: true });
  return dir;
}

// Write a package into a catalog dir, computing release.json hashes so only the mutation under test fails.
export function writePackage(catalogDir: string, id: string, files: { manifest: string; compose: string; readme?: string; images: Record<string, string>; revision?: string }): void {
  const dir = path.join(catalogDir, id);
  mkdirSync(dir, { recursive: true });
  const readme = files.readme ?? `# ${id}\n`;
  writeFileSync(path.join(dir, 'manifest.yaml'), files.manifest);
  writeFileSync(path.join(dir, 'compose.yaml'), files.compose);
  writeFileSync(path.join(dir, 'README.md'), readme);
  const images: Record<string, unknown> = {};
  for (const [svc, ref] of Object.entries(files.images)) {
    const [repository] = ref.split('@');
    images[svc] = { reference: ref, repository, tag: 'test', platform: 'linux/amd64', platformDigest: ref.split('@')[1] };
  }
  writeFileSync(
    path.join(dir, 'release.json'),
    JSON.stringify({
      schemaVersion: 1,
      package: { id, revision: files.revision ?? '1' },
      files: {
        'manifest.yaml': { sha256: sha256Hex(Buffer.from(files.manifest)) },
        'compose.yaml': { sha256: sha256Hex(Buffer.from(files.compose)) },
        'README.md': { sha256: sha256Hex(Buffer.from(readme)) },
      },
      images,
      qualification: { status: 'pending', date: '2026-01-01', notes: [] },
    }),
  );
  const indexPath = path.join(catalogDir, 'index.json');
  let index: { schemaVersion: 1; packages: Record<string, { revision: string; dir: string }> };
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    index = { schemaVersion: 1, packages: {} };
  }
  index.packages[id] = { revision: files.revision ?? '1', dir: id };
  writeFileSync(indexPath, JSON.stringify(index));
}

export const DIGEST_A = 'sha256:' + 'a'.repeat(64);
export const DIGEST_B = 'sha256:' + 'b'.repeat(64);

export const MINIMAL_MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: demo
  name: Demo
  description: Demo app
release:
  revision: "1"
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
    browserContext: secure
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 90
ui:
  primaryEndpoint: web
`;

export const MINIMAL_COMPOSE = `services:
  web:
    image: example/demo@${DIGEST_A}
`;
