import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CATALOG_INDEX_SCHEMA, RELEASE_FILES } from '../contracts/release.schema.js';
import type { CatalogIndex, LoadedPackage } from '../contracts/types.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';
import { validateComposeSource } from './compose-source.js';
import { parseReleaseInventory, sha256Hex, verifyInventory } from './inventory.js';
import { validateManifestReferences, validateManifestShape } from './manifest.js';
import { parseRestrictedYaml } from './yaml.js';

const MAX_README_BYTES = 256 * 1024;

export function readCatalogIndex(catalogDir: string): CatalogIndex {
  const indexPath = path.join(catalogDir, 'index.json');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    throw new HarborError('INVALID_PACKAGE', `catalog index ${indexPath} unreadable: ${(e as Error).message}`);
  }
  const validate = compile<CatalogIndex>(CATALOG_INDEX_SCHEMA);
  if (!validate(value)) {
    throw new HarborError('INVALID_PACKAGE', `catalog index invalid: ${formatErrors(validate.errors)[0]}`, { details: formatErrors(validate.errors) });
  }
  for (const [id, entry] of Object.entries(value.packages)) {
    if (entry.dir !== id) throw new HarborError('INVALID_PACKAGE', `catalog index: package ${id} must live in directory ${id}`);
  }
  return value;
}

function containedPath(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HarborError('INVALID_PACKAGE', `path escapes package directory: ${segments.join('/')}`);
  return resolved;
}

function readBounded(file: string, max: number): Buffer {
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new HarborError('INVALID_PACKAGE', `missing package file ${path.basename(file)}`);
  if (st.size > max) throw new HarborError('INVALID_PACKAGE', `${path.basename(file)} exceeds ${max} bytes`);
  return readFileSync(file);
}

// Load and fully validate the four fixed package files from one directory (a bundled
// package directory or an instance's immutable release snapshot).
export function loadPackageDir(dir: string, id: string, label = id): LoadedPackage {
  const raw = {
    manifest: readBounded(containedPath(dir, 'manifest.yaml'), 256 * 1024),
    compose: readBounded(containedPath(dir, 'compose.yaml'), 256 * 1024),
    readme: readBounded(containedPath(dir, 'README.md'), MAX_README_BYTES),
    release: readBounded(containedPath(dir, 'release.json'), 256 * 1024),
  };
  const manifest = validateManifestShape(parseRestrictedYaml(raw.manifest, `${label}/manifest.yaml`), `${label}/manifest.yaml`);
  const compose = validateComposeSource(parseRestrictedYaml(raw.compose, `${label}/compose.yaml`), `${label}/compose.yaml`);
  validateManifestReferences(manifest, compose, `${label}/manifest.yaml`);
  if (manifest.metadata.id !== id) throw new HarborError('INVALID_PACKAGE', `${label}: manifest id ${manifest.metadata.id} does not match ${id}`);
  const release = parseReleaseInventory(raw.release, `${label}/release.json`);
  const hashes = verifyInventory(
    release,
    { 'manifest.yaml': raw.manifest, 'compose.yaml': raw.compose, 'README.md': raw.readme },
    manifest,
    compose,
    `${label}/release.json`,
  );
  // Presentation assets: only files named by the manifest, only inside the package dir, hashed in release.json.
  const assets: Record<string, Buffer> = {};
  const wanted = [...(manifest.presentation?.icon ? [manifest.presentation.icon] : []), ...(manifest.presentation?.gallery ?? [])];
  for (const name of wanted) {
    const expected = release.assets?.[name]?.sha256;
    if (!expected) throw new HarborError('INVALID_PACKAGE', `${label}: presentation asset ${name} is not listed in release.json assets`);
    const bytes = readBounded(containedPath(dir, name), name.endsWith('.svg') || name.endsWith('.png') && name === manifest.presentation?.icon ? 256 * 1024 : 1024 * 1024);
    const actual = sha256Hex(bytes);
    if (actual !== expected) throw new HarborError('INVALID_PACKAGE', `${label}: asset ${name} hash mismatch`);
    assets[name] = bytes;
  }
  return { id, revision: manifest.release.revision, dir, manifest, compose, release, readme: raw.readme.toString('utf8'), raw, hashes, assets };
}

// Load one bundled package through the catalog index. Only the index's entry is trusted.
export function loadPackage(catalogDir: string, id: string, expectedRevision?: string): LoadedPackage {
  const index = readCatalogIndex(catalogDir);
  const entry = index.packages[id];
  if (!entry) throw new HarborError('NOT_FOUND', `unknown package ${id}`);
  const dir = containedPath(catalogDir, entry.dir);
  const pkg = loadPackageDir(dir, id);
  if (pkg.revision !== entry.revision) throw new HarborError('INVALID_PACKAGE', `${id}: manifest revision ${pkg.revision} does not match catalog index ${entry.revision}`);
  if (expectedRevision !== undefined && pkg.revision !== expectedRevision) {
    throw new HarborError('STATE_CHANGED', `${id}: bundled revision ${pkg.revision} differs from expected ${expectedRevision}`);
  }
  return pkg;
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  revision: string;
  availability: 'available' | 'unavailable';
  reason: string | null;
  qualification: 'passed' | 'blocked' | 'pending' | 'invalid';
  presentation: { tagline: string | null; category: string; icon: string | null; gallery: string[]; developer: string | null; website: string | null; releaseNotes: string | null };
  setup: boolean;
  storage: number;
}

// Catalog listing never throws for one bad package: it reports it as unavailable with the reason.
export function listCatalog(catalogDir: string): CatalogItem[] {
  const index = readCatalogIndex(catalogDir);
  const items: CatalogItem[] = [];
  for (const id of Object.keys(index.packages).sort()) {
    try {
      const pkg = loadPackage(catalogDir, id);
      items.push({
        id,
        name: pkg.manifest.metadata.name,
        description: pkg.manifest.metadata.description,
        revision: pkg.revision,
        availability: 'available',
        reason: null,
        qualification: pkg.release.qualification.status,
        presentation: presentationOf(pkg),
        setup: Boolean(pkg.manifest.setup),
        storage: (pkg.manifest.storage ?? []).length,
      });
    } catch (e) {
      items.push({
        id,
        name: id,
        description: '',
        revision: index.packages[id]!.revision,
        availability: 'unavailable',
        reason: e instanceof HarborError ? e.message : 'invalid package',
        qualification: 'invalid',
        presentation: { tagline: null, category: 'other', icon: null, gallery: [], developer: null, website: null, releaseNotes: null },
        setup: false,
        storage: 0,
      });
    }
  }
  return items;
}

export { RELEASE_FILES };

export function presentationOf(pkg: LoadedPackage): CatalogItem['presentation'] {
  const p = pkg.manifest.presentation ?? {};
  return { tagline: p.tagline ?? null, category: p.category ?? 'other', icon: p.icon ?? null, gallery: p.gallery ?? [], developer: p.developer ?? null, website: p.website ?? null, releaseNotes: p.releaseNotes ?? null };
}
