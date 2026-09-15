import { stringify as yamlStringify } from 'yaml';
import type { ComposeSource, Manifest } from '../contracts/types.js';
import type { EndpointAllocation } from '../state/repo.js';
import { LABELS } from '../naming.js';
import { browserUrlFor } from '../config.js';
import { defaultNetworkName, instanceLabels, ownedVolumeName, type InstanceIdentity } from './identity.js';

export interface RenderInput {
  manifest: Manifest;
  compose: ComposeSource;
  identity: InstanceIdentity;
  endpoints: EndpointAllocation[];
  // secret id -> value. When absent, a non-secret placeholder is rendered (prospective model).
  secretValues: Record<string, string> | null;
  // endpoint id -> URL handed to `configuration` bindings (defaults to the loopback URL)
  endpointUrls?: Record<string, string>;
  // compose volume name -> host directory chosen by the operator (rendered as a bind mount; no Docker volume)
  externalStorage?: Record<string, { hostPath: string; readOnly: boolean }>;
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

  for (const service of Object.keys(compose.services).sort()) {
    const src = compose.services[service]!;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) env[k] = escapeCompose(v);
    const generated: string[] = [];
    for (const s of manifest.secrets ?? []) {
      for (const b of s.bindings) {
        if (b.service !== service) continue;
        const value = secretValues ? secretValues[s.id] : undefined;
        if (secretValues && value === undefined) throw new Error(`missing value for secret ${s.id}`);
        env[b.environment] = escapeCompose(value ?? secretPlaceholder(s.id));
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
    generatedEnv[service] = generated.sort();

    const ports = endpoints
      .filter((e) => e.service === service)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ target: e.containerPort, published: String(e.hostPort), host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host' }));

    const def: Record<string, unknown> = {
      image: src.image,
      restart: 'unless-stopped',
      labels: { ...labels, [LABELS.service]: service, [LABELS.kind]: manifest.deployment.services[service] ?? 'application' },
      networks: ['default'],
    };
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
    volumes[claim.composeVolume] = { name: ownedVolumeName(identity, claim.composeVolume), external: true };
  }

  const model: Record<string, unknown> = {
    name: identity.project,
    services,
    networks: { default: { name: defaultNetworkName(identity), driver: 'bridge', labels: { ...labels, [LABELS.kind]: 'network' } } },
  };
  if (Object.keys(volumes).length) model['volumes'] = volumes;

  const yaml = yamlStringify(model, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return { model, yaml, generatedEnv };
}
