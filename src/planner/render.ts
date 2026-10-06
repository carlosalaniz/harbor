import { SECRET_TEMPLATE_SLOT } from '../contracts/patterns.js';
import { stringify as yamlStringify } from 'yaml';
import type { ComposeSource, Manifest } from '../contracts/types.js';
import type { EndpointAllocation } from '../state/repo.js';
import { LABELS } from '../naming.js';
import { browserUrlFor } from '../config.js';
import { defaultNetworkName, instanceLabels, ownedVolumeName, type InstanceIdentity } from './identity.js';
import { linkValue } from './links.js';

// Decision 126: an active link where this instance is the consumer (its bound services join `network`
// and get the provider's address) or the provider (its endpoint `service` joins with `alias`).
export interface ConsumerLink {
  id: string;
  network: string;
  alias: string;
  containerPort: number;
}
export interface ProviderLink {
  network: string;
  service: string;
  alias: string;
}

export interface RenderInput {
  // LAN mode publishes app ports on every interface (0.0.0.0); default loopback only
  bindHost?: string;
  manifest: Manifest;
  compose: ComposeSource;
  identity: InstanceIdentity;
  endpoints: EndpointAllocation[];
  // secret id -> value. When absent, a non-secret placeholder is rendered (prospective model).
  secretValues: Record<string, string> | null;
  // compose volume -> the Docker volume recorded for it (default: the owned name). `harbor seal` gives the
  // sealed copy its own name so the plain volume survives until the sealed app has started (decision 142).
  volumeNames?: Record<string, string>;
  // endpoint id -> URL handed to `configuration` bindings (defaults to the loopback URL)
  endpointUrls?: Record<string, string>;
  // compose volume name -> host directory chosen by the operator (rendered as a bind mount; no Docker volume)
  externalStorage?: Record<string, { hostPath: string; readOnly: boolean }>;
  // decision 79: the admin credential Harbor provisioned for this instance (placeholders when null)
  provisioned?: { username: string; password: string } | null;
  // decision 80: service -> locally built image tag (from release.json builds)
  builtImages?: Record<string, string>;
  // decision 126: only links whose network exists (state active); others render nothing
  consumerLinks?: ConsumerLink[];
  providerLinks?: ProviderLink[];
}

export interface RenderedCompose {
  model: Record<string, unknown>;
  yaml: string;
  // service -> env keys that were generated (for tests/inspection; never values)
  generatedEnv: Record<string, string[]>;
}

// Compose interpolates `$` in every string; the only way to pass a literal is `$$`.
export function escapeCompose(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

export function secretPlaceholder(secretId: string): string {
  return `<<secret:${secretId}>>`;
}

// Which part of an endpoint URL a `configuration` binding receives.
export function formatUrl(url: string, format: 'url' | 'origin' | 'authority' | 'host' | 'scheme'): string {
  if (format === 'url') return url;
  const u = new URL(url);
  switch (format) {
    case 'origin':
      return u.origin;
    case 'authority':
      return u.host;
    case 'host':
      return u.hostname;
    case 'scheme':
      return u.protocol.replace(/:$/, '');
  }
}

export function renderCompose(input: RenderInput): RenderedCompose {
  const { manifest, compose, identity, endpoints, secretValues, endpointUrls } = input;
  const external = input.externalStorage ?? {};
  const labels = instanceLabels(identity);
  const generatedEnv: Record<string, string[]> = {};
  const services: Record<string, unknown> = {};

  const endpointById = new Map(endpoints.map((e) => [e.id, e]));
  const consumerLinks = input.consumerLinks ?? [];
  const providerLinks = input.providerLinks ?? [];
  const linkNetworks = new Set<string>();

  for (const service of Object.keys(compose.services).sort()) {
    const src = compose.services[service]!;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) env[k] = escapeCompose(v);
    const generated: string[] = [];
    for (const s of manifest.secrets ?? []) {
      for (const b of s.bindings) {
        if (b.service !== service) continue;
        const value = secretValues ? secretValues[s.id] : undefined;
        // decision 125: an optional operator secret nobody provided leaves its variable unset
        if (secretValues && value === undefined && s.source === 'operator' && s.optional) continue;
        if (secretValues && value === undefined) throw new Error(`missing value for secret ${s.id}`);
        const v = value ?? secretPlaceholder(s.id);
        env[b.environment] = escapeCompose(b.template ? b.template.split(SECRET_TEMPLATE_SLOT).join(b.encode === 'url' && value !== undefined ? encodeURIComponent(v) : v) : v);
        generated.push(b.environment);
      }
    }
    for (const c of manifest.configuration ?? []) {
      if (c.service !== service) continue;
      const ep = endpointById.get(c.endpoint);
      if (!ep) throw new Error(`configuration references unallocated endpoint ${c.endpoint}`);
      env[c.environment] = escapeCompose(formatUrl(endpointUrls?.[c.endpoint] ?? browserUrlFor(ep.hostPort), c.format ?? 'url'));
      generated.push(c.environment);
    }
    for (const l of manifest.links ?? []) {
      const active = consumerLinks.find((c) => c.id === l.id);
      if (!active) continue; // needs a provider: no network, no variable
      for (const b of l.bindings) {
        if (b.service !== service) continue;
        env[b.environment] = escapeCompose(linkValue(active.alias, active.containerPort, b.format ?? 'url'));
        generated.push(b.environment);
      }
    }
    const pc = manifest.provisionedCredentials;
    if (pc && pc.service === service) {
      env[pc.passwordEnv] = escapeCompose(input.provisioned?.password ?? secretPlaceholder('provisioned-password'));
      generated.push(pc.passwordEnv);
      if (pc.usernameEnv) {
        env[pc.usernameEnv] = escapeCompose(input.provisioned?.username ?? pc.username ?? 'admin');
        generated.push(pc.usernameEnv);
      }
    }
    generatedEnv[service] = generated.sort();

    const ports = endpoints
      .filter((e) => e.service === service)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ target: e.containerPort, published: String(e.hostPort), host_ip: input.bindHost ?? '127.0.0.1', protocol: 'tcp', mode: 'host' }));

    // Built services (git sources, decision 80) reference the locally built tag from release.json.
    const builtTag = input.builtImages?.[service];
    if (!src.image && !builtTag) throw new Error(`service ${service} has no image and no recorded build tag`);
    const def: Record<string, unknown> = {
      image: src.image ?? builtTag,
      restart: 'unless-stopped',
      labels: { ...labels, [LABELS.service]: service, [LABELS.kind]: manifest.deployment.services[service] ?? 'application' },
      networks: ['default'],
    };
    // Link networks (decision 126): consumer services bound by an active link, the provider's endpoint service with its alias.
    const joins: Record<string, Record<string, unknown>> = {};
    for (const l of manifest.links ?? []) {
      const active = consumerLinks.find((c) => c.id === l.id);
      if (active && l.bindings.some((b) => b.service === service)) joins[active.network] = {};
    }
    for (const p of providerLinks) if (p.service === service) joins[p.network] = { aliases: [p.alias] };
    if (Object.keys(joins).length) {
      def['networks'] = { default: {}, ...Object.fromEntries(Object.keys(joins).sort().map((n) => [n, joins[n]])) };
      for (const n of Object.keys(joins)) linkNetworks.add(n);
    }
    if (src.command) def['command'] = src.command.map(escapeCompose);
    if (Object.keys(env).length) def['environment'] = env;
    if (ports.length) def['ports'] = ports;
    if (src.depends_on) def['depends_on'] = src.depends_on;
    if (src.healthcheck) {
      def['healthcheck'] = { ...src.healthcheck, test: src.healthcheck.test.map(escapeCompose) };
    }
    if (src.volumes?.length) {
      def['volumes'] = src.volumes.map((m) => {
        const ext = external[m.source];
        if (ext) return { type: 'bind', source: ext.hostPath, target: m.target, ...(m.read_only || ext.readOnly ? { read_only: true } : {}), bind: { create_host_path: false } };
        return { type: 'volume', source: m.source, target: m.target, ...(m.read_only ? { read_only: true } : {}) };
      });
    }
    services[service] = def;
  }

  const volumes: Record<string, unknown> = {};
  for (const claim of [...(manifest.storage ?? [])].sort((a, b) => a.composeVolume.localeCompare(b.composeVolume))) {
    if (external[claim.composeVolume]) continue; // bound to a host directory: no Docker volume at all
    // Generated `external`: Harbor created this volume explicitly; Compose must never create it.
    volumes[claim.composeVolume] = { name: input.volumeNames?.[claim.composeVolume] ?? ownedVolumeName(identity, claim.composeVolume), external: true };
  }

  const model: Record<string, unknown> = {
    name: identity.project,
    services,
    networks: { default: { name: defaultNetworkName(identity), driver: 'bridge', labels: { ...labels, [LABELS.kind]: 'network' } } },
  };
  // Harbor creates link networks itself (runner); Compose only attaches to them.
  for (const n of [...linkNetworks].sort()) (model['networks'] as Record<string, unknown>)[n] = { name: n, external: true };
  if (Object.keys(volumes).length) model['volumes'] = volumes;

  const yaml = yamlStringify(model, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return { model, yaml, generatedEnv };
}
