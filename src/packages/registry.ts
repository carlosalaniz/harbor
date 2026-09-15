import { HarborError } from '../errors.js';

// Resolve image tags to immutable digests over the OCI registry HTTP API (anonymous pull tokens, no
// Docker daemon). Uploaded packages may name images by tag; Harbor pins them at upload time so the
// stored package obeys the same "digest only" rule as the bundled catalog.
export interface ResolvedImage {
  reference: string; // repository@sha256:... (what compose gets)
  repository: string;
  tag: string;
  indexDigest: string;
  platformDigest: string; // linux/amd64 manifest digest
  imageCreated: string | null;
  source: string | null;
}
export interface ImageResolver {
  resolve(ref: string): Promise<ResolvedImage>;
}

export interface ParsedRef {
  registry: string;
  repo: string;
  tag: string | null;
  digest: string | null;
  display: string; // repository as it appears in compose (no registry-1 rewrite, no library/ prefix)
}
export function parseImageRef(ref: string): ParsedRef {
  let rest = ref.trim();
  let registry = 'registry-1.docker.io';
  const firstSlash = rest.indexOf('/');
  if (firstSlash > 0 && (rest.slice(0, firstSlash).includes('.') || rest.slice(0, firstSlash).includes(':') || rest.slice(0, firstSlash) === 'localhost')) {
    registry = rest.slice(0, firstSlash);
    rest = rest.slice(firstSlash + 1);
    if (registry === 'docker.io' || registry === 'index.docker.io') registry = 'registry-1.docker.io';
  }
  let digest: string | null = null;
  let tag: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(':');
  if (colon >= 0 && !rest.slice(colon + 1).includes('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  let repo = rest;
  if (registry === 'registry-1.docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  const display = registry === 'registry-1.docker.io' ? repo.replace(/^library\//, '') : `${registry}/${repo}`;
  return { registry, repo, tag, digest, display };
}

const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

export class RegistryResolver implements ImageResolver {
  constructor(private readonly timeoutMs = 30_000) {}
  private async fetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await fetch(url, { headers: { 'user-agent': 'harbor-registry/0.6', ...headers }, signal: ctl.signal, redirect: 'follow' });
    } finally {
      clearTimeout(t);
    }
  }
  private async token(registry: string, repo: string): Promise<string | null> {
    const probe = await this.fetch(`https://${registry}/v2/`);
    if (probe.status !== 401) return null;
    const hdr = probe.headers.get('www-authenticate') ?? '';
    const realm = /realm="([^"]+)"/.exec(hdr)?.[1];
    const service = /service="([^"]+)"/.exec(hdr)?.[1];
    if (!realm) return null;
    const url = new URL(realm);
    if (service) url.searchParams.set('service', service);
    url.searchParams.set('scope', `repository:${repo}:pull`);
    const res = await this.fetch(url.toString());
    if (!res.ok) throw new HarborError('INVALID_PACKAGE', `registry ${registry} refused an anonymous pull token for ${repo} (HTTP ${res.status}); private images are not supported`);
    const j = (await res.json()) as { token?: string; access_token?: string };
    return j.token ?? j.access_token ?? null;
  }
  private async get(registry: string, repo: string, p: string, tok: string | null, accept = ACCEPT): Promise<Response> {
    const res = await this.fetch(`https://${registry}/v2/${repo}/${p}`, { ...(tok ? { authorization: `Bearer ${tok}` } : {}), accept });
    if (!res.ok) throw new HarborError('INVALID_PACKAGE', `registry ${registry}: GET ${repo}/${p} answered HTTP ${res.status}${res.status === 404 ? ' (no such image or tag)' : ''}`);
    return res;
  }
  async resolve(ref: string): Promise<ResolvedImage> {
    const { registry, repo, tag, digest, display } = parseImageRef(ref);
    const tok = await this.token(registry, repo);
    const res = await this.get(registry, repo, `manifests/${digest ?? tag ?? 'latest'}`, tok);
    const topDigest = res.headers.get('docker-content-digest');
    const body = (await res.json()) as { mediaType?: string; manifests?: { digest: string; platform?: { os?: string; architecture?: string }; annotations?: Record<string, string> }[]; config?: { digest: string } };
    const mediaType = body.mediaType ?? res.headers.get('content-type') ?? '';
    let platformDigest = topDigest;
    let manifest = body;
    if (mediaType.includes('index') || mediaType.includes('manifest.list')) {
      const m = body.manifests?.find((x) => x.platform?.os === 'linux' && x.platform?.architecture === 'amd64' && !x.annotations?.['vnd.docker.reference.type']);
      if (!m) throw new HarborError('INVALID_PACKAGE', `${ref} has no linux/amd64 image`);
      platformDigest = m.digest;
      manifest = (await (await this.get(registry, repo, `manifests/${m.digest}`, tok)).json()) as typeof body;
    }
    if (!topDigest || !/^sha256:[a-f0-9]{64}$/.test(topDigest)) throw new HarborError('INVALID_PACKAGE', `registry did not return a digest for ${ref}`);
    let created: string | null = null;
    if (manifest.config?.digest) {
      try {
        const cfg = (await (await this.get(registry, repo, `blobs/${manifest.config.digest}`, tok, '*/*')).json()) as { created?: string };
        created = cfg.created ?? null;
      } catch {
        created = null;
      }
    }
    return { reference: `${display}@${topDigest}`, repository: display, tag: tag ?? (digest ? 'digest' : 'latest'), indexDigest: topDigest, platformDigest: platformDigest ?? topDigest, imageCreated: created, source: registry === 'registry-1.docker.io' ? `https://hub.docker.com/r/${repo.startsWith('library/') ? '_/' + repo.slice(8) : repo}` : `https://${registry}/${repo}` };
  }
}

// Tests and `pnpm dev`: answers from a table; anything unknown "does not exist".
export class FakeRegistry implements ImageResolver {
  readonly images = new Map<string, { digest: string; platformDigest?: string; created?: string }>();
  calls: string[] = [];
  add(repoAndTag: string, digest: string, extra: { platformDigest?: string; created?: string } = {}): this {
    this.images.set(repoAndTag, { digest, ...extra });
    return this;
  }
  async resolve(ref: string): Promise<ResolvedImage> {
    this.calls.push(ref);
    const { display, tag, digest } = parseImageRef(ref);
    const key = digest ? `${display}@${digest}` : `${display}:${tag ?? 'latest'}`;
    const hit = this.images.get(key) ?? (digest ? { digest } : undefined);
    if (!hit) throw new HarborError('INVALID_PACKAGE', `registry: no such image or tag ${ref}`);
    return { reference: `${display}@${hit.digest}`, repository: display, tag: tag ?? (digest ? 'digest' : 'latest'), indexDigest: hit.digest, platformDigest: hit.platformDigest ?? hit.digest, imageCreated: hit.created ?? null, source: null };
  }
}
