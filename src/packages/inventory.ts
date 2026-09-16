import { createHash } from 'node:crypto';
import { RELEASE_FILES, RELEASE_SCHEMA } from '../contracts/release.schema.js';
import type { ComposeSource, Manifest, ReleaseInventory } from '../contracts/types.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';

export type ReleaseFile = (typeof RELEASE_FILES)[number];

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function parseReleaseInventory(bytes: Buffer, label = 'release.json'): ReleaseInventory {
  if (bytes.byteLength > 256 * 1024) throw new HarborError('INVALID_PACKAGE', `${label}: too large`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new HarborError('INVALID_PACKAGE', `${label}: not valid JSON (${(e as Error).message})`);
  }
  const validate = compile<ReleaseInventory>(RELEASE_SCHEMA);
  if (!validate(value)) {
    const details = formatErrors(validate.errors);
    throw new HarborError('INVALID_PACKAGE', `${label}: ${details[0] ?? 'invalid'}`, { details });
  }
  return value;
}

// Verify the inventory against the exact bytes of the other files and the manifest/compose content.
export function verifyInventory(
  release: ReleaseInventory,
  files: Record<ReleaseFile, Buffer>,
  manifest: Manifest,
  compose: ComposeSource,
  label = 'release.json',
): Record<ReleaseFile, string> {
  const problems: string[] = [];
  const hashes = {} as Record<ReleaseFile, string>;
  for (const f of RELEASE_FILES) {
    hashes[f] = sha256Hex(files[f]);
    if (hashes[f] !== release.files[f].sha256) problems.push(`${f} hash mismatch (expected ${release.files[f].sha256}, actual ${hashes[f]})`);
  }
  if (release.package.id !== manifest.metadata.id) problems.push(`package id ${release.package.id} does not match manifest ${manifest.metadata.id}`);
  if (release.package.revision !== manifest.release.revision) problems.push(`revision ${release.package.revision} does not match manifest ${manifest.release.revision}`);
  // Every compose service is either a registry image (pinned by digest) or a git-source build
  // (pinned by commit, decision 80); the inventory must cover each exactly once.
  const services = Object.keys(compose.services).sort();
  const covered = [...Object.keys(release.images), ...Object.keys(release.builds ?? {})].sort();
  if (services.join(',') !== covered.join(',')) problems.push(`images [${Object.keys(release.images).sort().join(', ')}] and builds [${Object.keys(release.builds ?? {}).sort().join(', ')}] must cover exactly the compose services [${services.join(', ')}]`);
  for (const svc of services) {
    const img = release.images[svc];
    const build = release.builds?.[svc];
    const def = compose.services[svc]!;
    if (img && build) problems.push(`service ${svc} appears in both images and builds`);
    if (img && def.build) problems.push(`service ${svc} declares build: but the inventory records a registry image`);
    if (build && def.image) problems.push(`service ${svc} declares image: but the inventory records a build`);
    const ref = def.image;
    if (img && img.reference !== ref) problems.push(`service ${svc} image ${ref} does not equal inventory reference ${img.reference}`);
    if (img && !img.reference.startsWith(`${img.repository}@`)) problems.push(`service ${svc} inventory repository ${img.repository} does not match reference`);
    if (img && /(^|:)latest$/.test(img.reference)) problems.push(`service ${svc} uses a floating tag`);
    if (build && (def.build?.context ?? '.') !== build.context) problems.push(`service ${svc} build context ${def.build?.context} does not equal inventory context ${build.context}`);
  }
  if (problems.length) throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]}`, { details: problems });
  return hashes;
}
