#!/usr/bin/env node
// Editorial helper: pin a package's images to immutable digests and write release.json.
//   node scripts/catalog-pin.mjs <packageId> [--check]
// Authoring form: compose.yaml may reference `image: repo:tag` (or an already pinned `repo@sha256:...`
// together with `# tag: <tag>` on the same line). The script resolves each tag through the registry
// HTTP API (scripts/registry.mjs, no Docker daemon), rewrites the image reference to `repo@<index digest>`,
// records repository/tag/platform digest/creation time in release.json and recomputes file hashes.
// Qualification is left as-is (or set to `pending` for a new release.json); the live suite records results.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolve } from './registry.mjs';

const [id, flag] = process.argv.slice(2);
if (!id) { console.error('usage: catalog-pin.mjs <packageId> [--check]'); process.exit(2); }
const dir = path.resolve('catalog', id);
const composePath = path.join(dir, 'compose.yaml');
const releasePath = path.join(dir, 'release.json');
let compose = readFileSync(composePath, 'utf8');
const manifest = readFileSync(path.join(dir, 'manifest.yaml'), 'utf8');
const revision = /^\s*revision:\s*"?(\d+)"?\s*$/m.exec(manifest)?.[1] ?? '1';

const release = existsSync(releasePath)
  ? JSON.parse(readFileSync(releasePath, 'utf8'))
  : { schemaVersion: 1, package: { id, revision }, files: {}, images: {}, qualification: { status: 'pending', date: new Date().toISOString().slice(0, 10), notes: [] } };
release.package = { id, revision };

// service -> image line
const lines = compose.split('\n');
let service = null;
const images = {};
for (let i = 0; i < lines.length; i++) {
  const svc = /^ {2}([a-z0-9-]+):\s*$/.exec(lines[i]);
  if (svc) service = svc[1];
  const img = /^(\s+image:\s*)([^\s#]+)(\s*#\s*tag:\s*(\S+))?\s*$/.exec(lines[i]);
  if (img && service) images[service] = { line: i, prefix: img[1], ref: img[2], tagComment: img[4] ?? null };
}
if (!Object.keys(images).length) { console.error(`${id}: no images found in compose.yaml`); process.exit(1); }

const sourceFor = (repository) => {
  if (repository.startsWith('ghcr.io/')) return `https://${repository}`;
  if (repository.startsWith('codeberg.org/')) return `https://${repository}`;
  if (repository.includes('.')) return `https://${repository}`;
  return `https://hub.docker.com/${repository.includes('/') ? 'r/' + repository : '_/' + repository}`;
};

let changed = false;
for (const [svc, img] of Object.entries(images)) {
  const pinned = img.ref.includes('@sha256:');
  const tag = pinned ? (img.tagComment ?? release.images?.[svc]?.tag) : img.ref.slice(img.ref.lastIndexOf(':') + 1);
  const repo = pinned ? img.ref.slice(0, img.ref.indexOf('@')) : img.ref.slice(0, img.ref.lastIndexOf(':'));
  if (!tag) { console.error(`${id}/${svc}: pinned image without a known tag; add "# tag: <tag>" after the image`); process.exit(1); }
  const lookup = `${repo}:${tag}`;
  const r = await resolve(lookup);
  const reference = `${r.repository}@${r.indexDigest}`;
  const existing = release.images?.[svc];
  if (flag === '--check') {
    if (!existing || existing.reference !== reference || existing.platformDigest !== r.platformDigest) { console.error(`${id}/${svc}: ${lookup} now resolves to ${reference} (release.json has ${existing?.reference ?? 'nothing'})`); changed = true; }
    continue;
  }
  if (img.ref !== reference) {
    lines[img.line] = `${img.prefix}${reference} # tag: ${tag}`;
    changed = true;
  } else if (!img.tagComment) {
    lines[img.line] = `${img.prefix}${reference} # tag: ${tag}`;
    changed = true;
  }
  release.images[svc] = {
    reference,
    repository: r.repository,
    tag,
    platform: r.platform,
    platformDigest: r.platformDigest,
    ...(existing?.appVersion ? { appVersion: existing.appVersion } : { appVersion: tag.replace(/^v/, '') }),
    ...(r.config?.created ? { imageCreated: r.config.created.replace(/\.\d+Z$/, 'Z') } : {}),
    source: sourceFor(r.repository),
  };
  const note = `Digest of ${svc} resolved ${new Date().toISOString().slice(0, 10)} via registry API (scripts/catalog-pin.mjs; ${lookup}); image config: ExposedPorts ${Object.keys(r.config?.ExposedPorts ?? {}).join(',') || 'none'}, Volumes ${Object.keys(r.config?.Volumes ?? {}).join(',') || 'none'}, User ${r.config?.User || 'root'}.`;
  release.qualification.notes = [...(release.qualification.notes ?? []).filter((n) => !n.startsWith(`Digest of ${svc} `)), note];
  console.log(`${id}/${svc}: ${lookup} -> ${reference} (linux/amd64 ${r.platformDigest})`);
}
if (flag === '--check') process.exit(changed ? 1 : 0);
for (const svc of Object.keys(release.images)) if (!images[svc]) delete release.images[svc];
compose = lines.join('\n');
writeFileSync(composePath, compose);
writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n');
execFileSync('pnpm', ['tsx', 'scripts/catalog-hash.ts', id], { stdio: 'inherit' });
