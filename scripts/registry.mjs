#!/usr/bin/env node
// Read-only OCI registry helper used during package qualification.
// Resolves tags to immutable digests over the registry HTTP API with anonymous pull tokens.
// No Docker daemon is involved.
//
//   node scripts/registry.mjs tags  docker.io/n8nio/n8n [filterRegex]
//   node scripts/registry.mjs digest docker.io/excalidraw/excalidraw:latest
//   node scripts/registry.mjs config docker.io/postgres:16.10   # image config (Volumes, ExposedPorts) for linux/amd64

import process from 'node:process';

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export function parseRef(ref) {
  let rest = ref;
  let registry = 'registry-1.docker.io';
  const firstSlash = rest.indexOf('/');
  if (firstSlash > 0 && (rest.slice(0, firstSlash).includes('.') || rest.slice(0, firstSlash).includes(':'))) {
    registry = rest.slice(0, firstSlash);
    rest = rest.slice(firstSlash + 1);
    if (registry === 'docker.io') registry = 'registry-1.docker.io';
  }
  let digest = null;
  let tag = null;
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); }
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  let repo = rest;
  if (registry === 'registry-1.docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  return { registry, repo, tag, digest };
}

async function token(registry, repo) {
  const probe = await fetch(`https://${registry}/v2/`);
  if (probe.status !== 401) return null;
  const hdr = probe.headers.get('www-authenticate') ?? '';
  const realm = /realm="([^"]+)"/.exec(hdr)?.[1];
  const service = /service="([^"]+)"/.exec(hdr)?.[1];
  if (!realm) return null;
  const url = new URL(realm);
  if (service) url.searchParams.set('service', service);
  url.searchParams.set('scope', `repository:${repo}:pull`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`token ${res.status} for ${registry}/${repo}`);
  const j = await res.json();
  return j.token ?? j.access_token;
}

async function get(registry, repo, p, tok, accept) {
  const res = await fetch(`https://${registry}/v2/${repo}/${p}`, {
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), Accept: accept ?? ACCEPT },
  });
  if (!res.ok) throw new Error(`GET ${registry}/v2/${repo}/${p} -> ${res.status} ${await res.text()}`);
  return res;
}

export async function listTags(ref) {
  const { registry, repo } = parseRef(ref);
  const tok = await token(registry, repo);
  const tags = [];
  let next = `tags/list?n=1000`;
  while (next) {
    const res = await get(registry, repo, next, tok, 'application/json');
    const j = await res.json();
    tags.push(...(j.tags ?? []));
    const link = res.headers.get('link');
    const m = link && /<[^>]*\/v2\/[^>]*\/(tags\/list\?[^>]*)>;\s*rel="next"/.exec(link);
    next = m ? m[1] : null;
  }
  return tags;
}

export async function resolve(ref, platform = { os: 'linux', architecture: 'amd64' }) {
  const { registry, repo, tag, digest } = parseRef(ref);
  const tok = await token(registry, repo);
  const res = await get(registry, repo, `manifests/${digest ?? tag ?? 'latest'}`, tok);
  const topDigest = res.headers.get('docker-content-digest');
  const body = await res.json();
  const mediaType = body.mediaType ?? res.headers.get('content-type');
  let platformDigest = topDigest;
  let manifest = body;
  if (mediaType?.includes('index') || mediaType?.includes('manifest.list')) {
    const m = body.manifests.find((x) => x.platform?.os === platform.os && x.platform?.architecture === platform.architecture && !x.annotations?.['vnd.docker.reference.type']);
    if (!m) throw new Error(`no ${platform.os}/${platform.architecture} manifest in ${ref}`);
    platformDigest = m.digest;
    manifest = await (await get(registry, repo, `manifests/${m.digest}`, tok)).json();
  }
  const cfg = await (await get(registry, repo, `blobs/${manifest.config.digest}`, tok, '*/*')).json();
  return {
    repository: registry === 'registry-1.docker.io' ? repo.replace(/^library\//, '') : `${registry}/${repo}`,
    tag,
    indexDigest: topDigest,
    platformDigest,
    isIndex: platformDigest !== topDigest,
    platform: `${platform.os}/${platform.architecture}`,
    config: {
      Volumes: cfg.config?.Volumes ?? null,
      ExposedPorts: cfg.config?.ExposedPorts ?? null,
      User: cfg.config?.User ?? '',
      Labels: cfg.config?.Labels ?? null,
      created: cfg.created,
    },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [cmd, ref, extra] = process.argv.slice(2);
  if (cmd === 'tags') {
    const tags = await listTags(ref);
    const re = extra ? new RegExp(extra) : null;
    console.log((re ? tags.filter((t) => re.test(t)) : tags).join('\n'));
  } else if (cmd === 'digest' || cmd === 'config') {
    const r = await resolve(ref);
    if (cmd === 'digest') { delete r.config; }
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error('usage: registry.mjs <tags|digest|config> <ref> [filter]');
    process.exit(2);
  }
}
