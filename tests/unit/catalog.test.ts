import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCatalog, loadPackage } from '../../src/packages/catalog.js';
import { HarborError } from '../../src/errors.js';
import { cloneCatalog, DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST, REPO_CATALOG, writePackage } from './helpers.js';

describe('bundled catalog', () => {
  it('loads every bundled package with matching hashes and digest-pinned images', () => {
    const items = listCatalog(REPO_CATALOG);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.availability, `${item.id}: ${item.reason}`).toBe('available');
      const pkg = loadPackage(REPO_CATALOG, item.id);
      for (const [svc, def] of Object.entries(pkg.compose.services)) {
        expect(def.image).toMatch(/@sha256:[a-f0-9]{64}$/);
        expect(pkg.release.images[svc]?.reference).toBe(def.image);
      }
    }
  });
  it('rejects a package whose bytes changed after the inventory was written', () => {
    const dir = cloneCatalog();
    const readme = path.join(dir, 'excalidraw', 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8') + '\nchanged\n');
    expect(() => loadPackage(dir, 'excalidraw')).toThrow(/README.md hash mismatch/);
    const items = listCatalog(dir);
    expect(items.find((i) => i.id === 'excalidraw')?.availability).toBe('unavailable');
  });
  it('rejects a compose image that differs from the inventory reference', () => {
    const dir = cloneCatalog();
    const compose = path.join(dir, 'excalidraw', 'compose.yaml');
    const text = readFileSync(compose, 'utf8');
    writeFileSync(compose, text.replace(/sha256:[a-f0-9]{64}/, DIGEST_A));
    // Hash of compose changed too; both errors are INVALID_PACKAGE and nothing is installed.
    try {
      loadPackage(dir, 'excalidraw');
      throw new Error('expected failure');
    } catch (e) {
      expect(HarborError.is(e, 'INVALID_PACKAGE')).toBe(true);
    }
  });
  it('rejects catalog entries whose directory escapes or does not match the id', () => {
    const dir = cloneCatalog();
    const indexPath = path.join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.packages['excalidraw'].dir = '../excalidraw';
    writeFileSync(indexPath, JSON.stringify(index));
    expect(() => loadPackage(dir, 'excalidraw')).toThrow(/invalid|directory/);
  });
  it('rejects a revision mismatch between index and manifest', () => {
    const dir = cloneCatalog();
    const indexPath = path.join(dir, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.packages['excalidraw'].revision = '2';
    writeFileSync(indexPath, JSON.stringify(index));
    expect(() => loadPackage(dir, 'excalidraw')).toThrow(/revision/);
  });
  it('loads a synthetic fourth package with only package files (no engine branch)', () => {
    const dir = cloneCatalog();
    writePackage(dir, 'demo', { manifest: MINIMAL_MANIFEST, compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const pkg = loadPackage(dir, 'demo');
    expect(pkg.manifest.metadata.name).toBe('Demo');
    expect(listCatalog(dir).map((i) => i.id)).toEqual(expect.arrayContaining(['demo', 'excalidraw', 'bentopdf']));
  });
  it('reports an invalid package in the listing without throwing for the others', () => {
    const dir = cloneCatalog();
    writePackage(dir, 'broken', { manifest: MINIMAL_MANIFEST.replace('id: demo', 'id: broken') + 'bogus: true\n', compose: MINIMAL_COMPOSE, images: { web: `example/demo@${DIGEST_A}` } });
    const items = listCatalog(dir);
    expect(items.find((i) => i.id === 'broken')?.availability).toBe('unavailable');
    expect(items.find((i) => i.id === 'broken')?.reason).toMatch(/additional/);
    expect(items.find((i) => i.id === 'excalidraw')?.availability).toBe('available');
  });
});

describe('presentation assets', () => {
  it('bundled icons are hashed in release.json and served bytes match', () => {
    for (const id of ['excalidraw', 'bentopdf', 'n8n']) {
      const pkg = loadPackage(REPO_CATALOG, id);
      expect(pkg.manifest.presentation?.icon).toBe('icon.svg');
      expect(Object.keys(pkg.assets)).toEqual(['icon.svg']);
      expect(pkg.assets['icon.svg']!.toString('utf8')).toContain('<svg');
      expect(pkg.assets['icon.svg']!.toString('utf8')).not.toMatch(/<script|onload=/i);
    }
  });
  it('a tampered or unlisted asset invalidates the package', () => {
    const dir = cloneCatalog();
    const icon = path.join(dir, 'excalidraw', 'icon.svg');
    writeFileSync(icon, readFileSync(icon, 'utf8') + '<!-- x -->');
    expect(() => loadPackage(dir, 'excalidraw')).toThrow(/asset icon.svg hash mismatch/);
    const dir2 = cloneCatalog();
    const rel = path.join(dir2, 'n8n', 'release.json');
    const j = JSON.parse(readFileSync(rel, 'utf8'));
    delete j.assets;
    writeFileSync(rel, JSON.stringify(j));
    expect(() => loadPackage(dir2, 'n8n')).toThrow(/not listed in release.json assets/);
  });
});
