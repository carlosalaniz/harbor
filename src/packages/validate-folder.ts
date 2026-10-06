// Decision 140: `harbor packages validate <dir>` — the daemon's own package validators, run on a local
// folder before it is zipped or pushed as a git source. Offline: images are not resolved (the daemon pins
// tags at import), so a typo in an image name only shows up then.
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { validateComposeSource } from './compose-source.js';
import { validateManifestReferences, validateManifestShape } from './manifest.js';
import { parseRestrictedYaml } from './yaml.js';

const ASSET_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(svg|png|jpg|jpeg|webp)$/;
const DIGEST_REF_RE = /@sha256:[a-f0-9]{64}$/;

export interface FolderValidation {
  dir: string; // the folder that holds manifest.yaml (the given one, or its harbor/ subfolder)
  id: string;
  name: string;
  revision: string;
  notes: string[];
}

function readFile(dir: string, name: string, max: number, required: boolean): Buffer | null {
  const file = path.join(dir, name);
  const st = existsSync(file) ? lstatSync(file) : null;
  if (!st) {
    if (required) throw new HarborError('INVALID_PACKAGE', `${name} is missing in ${dir}`);
    return null;
  }
  if (st.isSymbolicLink()) throw new HarborError('INVALID_PACKAGE', `${name} is a symbolic link; packages contain plain files only`);
  if (!st.isFile()) throw new HarborError('INVALID_PACKAGE', `${name} is not a file`);
  if (st.size > max) throw new HarborError('INVALID_PACKAGE', `${name} is larger than ${max} bytes`);
  return readFileSync(file);
}

export function validatePackageFolder(input: string): FolderValidation {
  const given = path.resolve(input);
  if (!existsSync(given) || !statSync(given).isDirectory()) throw new HarborError('INVALID_REQUEST', `${input} is not a folder`);
  // A git source keeps the package in harbor/ (build contexts are relative to it).
  const dir = !existsSync(path.join(given, 'manifest.yaml')) && existsSync(path.join(given, 'harbor', 'manifest.yaml')) ? path.join(given, 'harbor') : given;
  const gitLayout = path.basename(dir) === 'harbor';
  const notes: string[] = [];
  const manifest = validateManifestShape(parseRestrictedYaml(readFile(dir, 'manifest.yaml', 256 * 1024, true)!, 'manifest.yaml'), 'manifest.yaml');
  const composeRaw = readFile(dir, 'compose.yaml', 256 * 1024, true)!;
  // The import pins tag images before validating; stand in a digest so the subset rules see the same shape.
  const composeDoc = parseRestrictedYaml(composeRaw, 'compose.yaml') as { services?: Record<string, { image?: unknown }> };
  const tagged: Record<string, string> = {};
  for (const [svc, def] of Object.entries(composeDoc?.services ?? {})) {
    if (typeof def?.image === 'string' && !DIGEST_REF_RE.test(def.image)) {
      tagged[svc] = def.image;
      def.image = `${def.image.replace(/:[^/:@]+$/, '')}@sha256:${'0'.repeat(64)}`;
    }
  }
  const compose = validateComposeSource(composeDoc, 'compose.yaml');
  validateManifestReferences(manifest, compose, 'manifest.yaml');
  for (const [svc, def] of Object.entries(compose.services)) {
    const build = (def as { build?: { context: string; dockerfile?: string } }).build;
    if (build) {
      if (!gitLayout) throw new HarborError('INVALID_PACKAGE', `service ${svc} declares build:, which only git-sourced packages (a harbor/ folder in a repository) may use`);
      const repo = path.dirname(dir);
      const ctx = path.resolve(dir, build.context);
      if (ctx !== repo && !ctx.startsWith(repo + path.sep)) throw new HarborError('INVALID_PACKAGE', `service ${svc}: build context ${build.context} escapes the repository`);
      if (!existsSync(path.join(ctx, build.dockerfile ?? 'Dockerfile'))) throw new HarborError('INVALID_PACKAGE', `service ${svc}: no ${build.dockerfile ?? 'Dockerfile'} in build context ${build.context}`);
      notes.push(`${svc} is built from source on the machine (context ${build.context})`);
    } else if (tagged[svc]) notes.push(`${svc}: ${tagged[svc]} is pinned by digest when Harbor imports the package`);
  }
  if (!readFile(dir, 'README.md', 256 * 1024, false)) notes.push('No README.md: Harbor writes a short one from the manifest.');
  for (const name of [...(manifest.presentation?.icon ? [manifest.presentation.icon] : []), ...(manifest.presentation?.gallery ?? [])]) {
    if (!ASSET_RE.test(name)) throw new HarborError('INVALID_PACKAGE', `presentation asset ${name} must be a lowercase svg/png/jpg/webp file name at the package root`);
    readFile(dir, name, name === manifest.presentation?.icon ? 256 * 1024 : 1024 * 1024, true);
  }
  if (existsSync(path.join(dir, 'release.json'))) notes.push('release.json is replaced by the one Harbor generates at import (hashes and pinned digests).');
  notes.push(`The id "${manifest.metadata.id}" must not be a built-in app's id, and release.revision must rise with every upload (checked by the daemon at import).`);
  return { dir, id: manifest.metadata.id, name: manifest.metadata.name, revision: manifest.release.revision, notes };
}
