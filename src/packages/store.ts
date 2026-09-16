import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogIndex, LoadedPackage, Manifest, ReleaseInventory } from '../contracts/types.js';
import { HarborError } from '../errors.js';
import { rfc3339, type Clock } from '../util.js';
import { listCatalog, loadPackage, loadPackageDir, readCatalogIndex, type CatalogItem, type PackageOrigin } from './catalog.js';
import { validateComposeSource } from './compose-source.js';
import { sha256Hex } from './inventory.js';
import { validateManifestReferences, validateManifestShape } from './manifest.js';
import { parseImageRef, type ImageResolver } from './registry.js';
import { parseRestrictedYaml } from './yaml.js';
import { readZip } from './zip.js';
import { readPackageTree, type GitTree } from './git.js';

// Every package Harbor can install: the bundled, hash-verified catalog plus packages the operator uploaded
// ("your own apps"). Uploaded packages go through the same validation as bundled ones; Harbor pins their
// images by digest at upload and writes their release.json itself, so the engine never sees a second kind
// of package. A newer revision of an id (bundled after a Harbor upgrade, or uploaded) is an update.

export interface ImportResult {
  item: CatalogItem;
  pinned: { service: string; from: string; to: string }[];
  notes: string[];
  replacedRevision: string | null;
}

export interface LoadedPackageWithOrigin extends LoadedPackage {
  origin: PackageOrigin;
}

const ASSET_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(svg|png|jpg|jpeg|webp)$/;
const DIGEST_REF_RE = /@sha256:[a-f0-9]{64}$/;

// Revisions order numerically when they look like numbers ("2" > "10" is false), segment by segment otherwise.
export function compareRevisions(a: string, b: string): number {
  const pa = a.split(/[._-]/);
  const pb = b.split(/[._-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export class PackageStore {
  constructor(
    readonly bundledDir: string,
    readonly localDir: string,
    private readonly registry: ImageResolver,
    private readonly clock: Clock,
  ) {}

  private localIndex(): CatalogIndex {
    if (!existsSync(path.join(this.localDir, 'index.json'))) return { schemaVersion: 1, packages: {} };
    return readCatalogIndex(this.localDir);
  }
  private writeLocalIndex(index: CatalogIndex): void {
    mkdirSync(this.localDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.localDir, 'index.json.tmp');
    writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    renameSync(tmp, path.join(this.localDir, 'index.json'));
  }

  list(): CatalogItem[] {
    const bundled = listCatalog(this.bundledDir, 'bundled');
    const local = existsSync(path.join(this.localDir, 'index.json')) ? listCatalog(this.localDir, 'local') : [];
    return [...bundled, ...local].sort((a, b) => a.name.localeCompare(b.name));
  }
  originOf(id: string): PackageOrigin | null {
    if (readCatalogIndex(this.bundledDir).packages[id]) return 'bundled';
    if (this.localIndex().packages[id]) return 'local';
    return null;
  }
  // Current revision of every known package id (for "update available" checks).
  currentRevisions(): Map<string, { revision: string; version: string | null; releaseNotes: string | null }> {
    const out = new Map<string, { revision: string; version: string | null; releaseNotes: string | null }>();
    for (const i of this.list()) if (i.availability === 'available') out.set(i.id, { revision: i.revision, version: i.version, releaseNotes: i.presentation.releaseNotes });
    return out;
  }
  load(id: string, expectedRevision?: string): LoadedPackageWithOrigin {
    const origin = this.originOf(id);
    if (!origin) throw new HarborError('NOT_FOUND', `unknown package ${id}`);
    const pkg = loadPackage(origin === 'bundled' ? this.bundledDir : this.localDir, id, expectedRevision);
    return { ...pkg, origin };
  }

  // ---- uploads
  async importZip(zip: Buffer, opts: { fileName: string; actor: string }): Promise<ImportResult> {
    return this.importFiles(readZip(zip), { source: `upload ${opts.fileName} by ${opts.actor}`, allowBuilds: null });
  }

  // Git source (decision 80): the harbor/ folder of a fetched repository. Services may declare
  // `build:` (built locally at apply time, pinned by the commit); the revision gets the committer
  // date as a numeric suffix so every commit orders as a newer revision.
  async importGitTree(tree: GitTree, opts: { url: string; ref: string; subpath: string | null; expectedId?: string }): Promise<ImportResult & { revision: string }> {
    const files = readPackageTree(tree, opts.subpath);
    const manifestRaw = files.get('manifest.yaml');
    if (manifestRaw) {
      // Suffix the revision before validation so hashes and stored files agree with it.
      const text = manifestRaw.toString('utf8');
      const m = text.match(/^(\s*revision:\s*["']?)([A-Za-z0-9._-]+)(["']?\s*)$/m);
      if (m) files.set('manifest.yaml', Buffer.from(text.replace(m[0], `${m[1]}${m[2]}.${tree.committerDateUnix}${m[3]}`), 'utf8'));
    }
    const base = opts.subpath ? path.join(tree.dir, opts.subpath) : tree.dir;
    const r = await this.importFiles(files, {
      source: `git ${opts.url}@${tree.commit.slice(0, 12)} (${opts.ref}${opts.subpath ? `, ${opts.subpath}` : ''})`,
      // contexts are written relative to harbor/; they may step up but never out of the fetched tree
      allowBuilds: { commit: tree.commit, contextRoot: path.join(base, 'harbor'), boundary: tree.dir },
      expectedId: opts.expectedId ?? null,
    });
    return { ...r, revision: r.item.id ? r.item.revision : '' };
  }

  private async importFiles(files: Map<string, Buffer>, ctx: { source: string; allowBuilds: { commit: string; contextRoot: string; boundary: string } | null; expectedId?: string | null }): Promise<ImportResult> {
    const notes: string[] = [];
    const need = (name: string) => {
      const b = files.get(name);
      if (!b) throw new HarborError('INVALID_PACKAGE', `the package has no ${name}`, { nextAction: 'A package is a zip (or a harbor/ folder in a git repository) with manifest.yaml, compose.yaml, optionally README.md and the icon/screenshots the manifest names. See docs/DEVELOPER_PACKAGES.md.' });
      return b;
    };
    const manifestRaw = need('manifest.yaml');
    const composeRaw0 = need('compose.yaml');
    if (manifestRaw.length > 256 * 1024 || composeRaw0.length > 256 * 1024) throw new HarborError('INVALID_PACKAGE', 'manifest.yaml and compose.yaml must each be under 256 KiB');
    const manifest = validateManifestShape(parseRestrictedYaml(manifestRaw, 'manifest.yaml'), 'manifest.yaml');
    const id = manifest.metadata.id;
    if (readCatalogIndex(this.bundledDir).packages[id]) throw new HarborError('INVALID_PACKAGE', `the id "${id}" belongs to a built-in app`, { nextAction: 'Choose another metadata.id for your package.' });
    if (ctx.expectedId && id !== ctx.expectedId) throw new HarborError('INVALID_PACKAGE', `the repository now declares metadata.id ${id}, but this source was added for ${ctx.expectedId}`, { nextAction: 'A source is bound to one app id. Add the repository again as a new source if the id really changed.' });

    // Pin images: any service image that is not already repository@sha256 is resolved at the registry.
    // `build:` services (git sources only) are recorded with the commit instead.
    const composeText0 = composeRaw0.toString('utf8');
    const composeAny = parseRestrictedYaml(composeRaw0, 'compose.yaml') as { services?: Record<string, { image?: unknown; build?: { context?: unknown; dockerfile?: unknown } }> };
    if (!composeAny || typeof composeAny !== 'object' || !composeAny.services || typeof composeAny.services !== 'object') throw new HarborError('INVALID_PACKAGE', 'compose.yaml must declare services');
    const pinned: ImportResult['pinned'] = [];
    const images: ReleaseInventory['images'] = {};
    const builds: NonNullable<ReleaseInventory['builds']> = {};
    let composeText = composeText0;
    for (const [service, def] of Object.entries(composeAny.services)) {
      const ref = def?.image;
      if (typeof ref !== 'string' || !ref.trim()) {
        const build = def?.build;
        if (build && typeof build === 'object' && typeof build.context === 'string') {
          if (!ctx.allowBuilds) throw new HarborError('INVALID_PACKAGE', `service ${service} declares build:, which only git-sourced packages may use`, { nextAction: 'Point Harbor at the git repository instead of uploading a zip, or reference a published image.' });
          const context = build.context;
          const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile';
          const abs = path.resolve(ctx.allowBuilds.contextRoot, context);
          if (abs !== path.resolve(ctx.allowBuilds.boundary) && !abs.startsWith(path.resolve(ctx.allowBuilds.boundary) + path.sep)) throw new HarborError('INVALID_PACKAGE', `service ${service}: build context escapes the repository`);
          if (!existsSync(path.join(abs, dockerfile))) throw new HarborError('INVALID_PACKAGE', `service ${service}: no ${dockerfile} in build context ${context}`);
          builds[service] = { context, ...(dockerfile !== 'Dockerfile' ? { dockerfile } : {}), commit: ctx.allowBuilds.commit, tag: `harbor-src/${id}-${service}:${ctx.allowBuilds.commit.slice(0, 12)}` };
          continue;
        }
        throw new HarborError('INVALID_PACKAGE', `service ${service} has no image`);
      }
      let resolved;
      try {
        resolved = await this.registry.resolve(ref);
      } catch (e) {
        throw new HarborError('INVALID_PACKAGE', `service ${service}: image ${ref} could not be resolved (${e instanceof Error ? e.message : String(e)})`, { nextAction: 'Check the image name and tag, and that this machine can reach the registry. Private images are not supported.' });
      }
      if (!DIGEST_REF_RE.test(ref)) {
        composeText = replaceImage(composeText, ref, resolved.reference);
        pinned.push({ service, from: ref, to: resolved.reference });
      } else if (ref !== resolved.reference) {
        // digest given with a different repository spelling (e.g. docker.io/ prefix): normalise it
        composeText = replaceImage(composeText, ref, resolved.reference);
        pinned.push({ service, from: ref, to: resolved.reference });
      }
      const { tag } = parseImageRef(ref);
      images[service] = { reference: resolved.reference, repository: resolved.repository, tag: tag ?? resolved.tag, platform: 'linux/amd64', platformDigest: resolved.platformDigest, ...(resolved.imageCreated ? { imageCreated: resolved.imageCreated } : {}), ...(resolved.source ? { source: resolved.source } : {}) };
    }
    const composeRaw = Buffer.from(composeText, 'utf8');
    const compose = validateComposeSource(parseRestrictedYaml(composeRaw, 'compose.yaml'), 'compose.yaml');
    validateManifestReferences(manifest, compose, 'manifest.yaml');

    const readmeRaw = files.get('README.md') ?? Buffer.from(`# ${manifest.metadata.name}\n\n${manifest.metadata.description}\n\nAdded to Harbor (${ctx.source}) on ${rfc3339(this.clock.now()).slice(0, 10)}.\n`, 'utf8');
    if (!files.has('README.md')) notes.push('No README.md in the package: Harbor wrote a short one from the manifest.');
    const assets: Record<string, Buffer> = {};
    for (const name of [...(manifest.presentation?.icon ? [manifest.presentation.icon] : []), ...(manifest.presentation?.gallery ?? [])]) {
      if (!ASSET_RE.test(name)) throw new HarborError('INVALID_PACKAGE', `presentation asset ${name} must be a lowercase svg/png/jpg/webp file name at the package root`);
      const b = files.get(name);
      if (!b) throw new HarborError('INVALID_PACKAGE', `the manifest names ${name} but the zip does not contain it`);
      if (b.length > (name === manifest.presentation?.icon ? 256 * 1024 : 1024 * 1024)) throw new HarborError('INVALID_PACKAGE', `${name} is too large (icons ≤ 256 KiB, screenshots ≤ 1 MiB)`);
      assets[name] = b;
    }
    const ignored = [...files.keys()].filter((n) => !['manifest.yaml', 'compose.yaml', 'README.md', 'release.json'].includes(n) && !(n in assets));
    if (ignored.length) notes.push(`Ignored ${ignored.length} file(s) the manifest does not reference: ${ignored.slice(0, 8).join(', ')}${ignored.length > 8 ? ', …' : ''}.`);
    if (files.has('release.json')) notes.push('The release.json in the zip was replaced by one Harbor generated (hashes and pinned digests).');

    // Revision rules against what is already installed locally
    const index = this.localIndex();
    const prev = index.packages[id];
    let replacedRevision: string | null = null;
    if (prev) {
      const cmp = compareRevisions(manifest.release.revision, prev.revision);
      if (cmp < 0) throw new HarborError('INVALID_PACKAGE', `revision ${manifest.release.revision} is older than the installed package revision ${prev.revision}`, { nextAction: 'Raise release.revision in manifest.yaml (for example to ' + bump(prev.revision) + ').' });
      if (cmp === 0) {
        const old = loadPackageDir(path.join(this.localDir, prev.dir), id);
        const same = old.hashes['manifest.yaml'] === sha256Hex(manifestRaw) && old.hashes['compose.yaml'] === sha256Hex(composeRaw) && old.hashes['README.md'] === sha256Hex(readmeRaw);
        if (same) {
          notes.push(`Revision ${prev.revision} of ${id} was already uploaded with identical files; nothing changed.`);
          return { item: this.list().find((i) => i.id === id)!, pinned, notes, replacedRevision: null };
        }
        throw new HarborError('INVALID_PACKAGE', `revision ${prev.revision} of ${id} is already uploaded with different files`, { nextAction: 'Raise release.revision in manifest.yaml (for example to ' + bump(prev.revision) + ') so installed apps can be updated to it.' });
      }
      replacedRevision = prev.revision;
    }

    const release: ReleaseInventory = {
      schemaVersion: 1,
      package: { id, revision: manifest.release.revision },
      files: { 'manifest.yaml': { sha256: sha256Hex(manifestRaw) }, 'compose.yaml': { sha256: sha256Hex(composeRaw) }, 'README.md': { sha256: sha256Hex(readmeRaw) } },
      ...(Object.keys(assets).length ? { assets: Object.fromEntries(Object.entries(assets).map(([n, b]) => [n, { sha256: sha256Hex(b) }])) } : {}),
      images,
      ...(Object.keys(builds).length ? { builds } : {}),
      qualification: {
        status: 'pending',
        date: rfc3339(this.clock.now()).slice(0, 10),
        notes: [
          `Added from ${ctx.source}; not qualified by the Harbor project.`,
          ...(pinned.length ? [`Images pinned by Harbor at import: ${pinned.map((p) => `${p.from} -> ${p.to.slice(p.to.indexOf('@') + 1, p.to.indexOf('@') + 20)}…`).join('; ')}`] : []),
          ...(Object.keys(builds).length ? [`Built from source at commit ${ctx.allowBuilds!.commit}: ${Object.keys(builds).join(', ')} (provenance is the commit, not a registry digest).`] : []),
        ],
      },
    };
    // Stage, validate the way the engine will load it, then swap into place.
    mkdirSync(this.localDir, { recursive: true, mode: 0o700 });
    const staging = path.join(this.localDir, `.staging-${id}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, 'manifest.yaml'), manifestRaw, { mode: 0o600 });
    writeFileSync(path.join(staging, 'compose.yaml'), composeRaw, { mode: 0o600 });
    writeFileSync(path.join(staging, 'README.md'), readmeRaw, { mode: 0o600 });
    writeFileSync(path.join(staging, 'release.json'), JSON.stringify(release, null, 2), { mode: 0o600 });
    for (const [n, b] of Object.entries(assets)) writeFileSync(path.join(staging, n), b, { mode: 0o600 });
    // Built services: snapshot each build context into the package so the exact bytes that were
    // imported are what `docker build` sees at apply time (and reinstalls stay reproducible).
    for (const [service, b] of Object.entries(builds)) {
      const src = path.resolve(ctx.allowBuilds!.contextRoot, b.context);
      const dst = path.join(staging, 'build', service);
      mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      cpSync(src, dst, { recursive: true, verbatimSymlinks: false, filter: (p) => !p.includes(`${path.sep}.git`) });
    }
    try {
      loadPackageDir(staging, id, `upload:${id}`);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    const target = path.join(this.localDir, id);
    const old = path.join(this.localDir, `.old-${id}`);
    rmSync(old, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, old);
    renameSync(staging, target);
    rmSync(old, { recursive: true, force: true });
    index.packages[id] = { revision: manifest.release.revision, dir: id };
    this.writeLocalIndex(index);
    const item = this.list().find((i) => i.id === id)!;
    return { item, pinned, notes, replacedRevision };
  }

  // Remove an uploaded package (the caller refuses when instances still use it).
  removeLocal(id: string): void {
    const index = this.localIndex();
    if (!index.packages[id]) throw new HarborError('NOT_FOUND', this.originOf(id) === 'bundled' ? `${id} is a built-in app and cannot be removed` : `no uploaded package ${id}`);
    delete index.packages[id];
    this.writeLocalIndex(index);
    rmSync(path.join(this.localDir, id), { recursive: true, force: true });
  }
}

function bump(revision: string): string {
  return /^\d+$/.test(revision) ? String(Number(revision) + 1) : `${revision}.1`;
}

// Replace one `image:` value in the Compose text (quoted or bare) without touching anything else.
function replaceImage(text: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s*image:\\s*)(["']?)${esc}\\2(\\s*(#.*)?)$`, 'm');
  if (!re.test(text)) throw new HarborError('INVALID_PACKAGE', `could not locate "image: ${from}" in compose.yaml to pin it; write the image on its own line`);
  return text.replace(re, (_m, pre: string, q: string, post: string) => `${pre}${q}${to}${q}${post}`);
}

export type { Manifest };
