import { SECRET_TEMPLATE_SLOT } from '../contracts/patterns.js';
import { stringify as yamlStringify } from 'yaml';
import type { ComposeSource, HostGpu, Manifest, SettingValue } from '../contracts/types.js';
import type { EndpointAllocation } from '../state/repo.js';
import { LABELS } from '../naming.js';
import { browserUrlFor } from '../config.js';
import { defaultNetworkName, instanceLabels, ownedVolumeName, type InstanceIdentity } from './identity.js';
import { linkValue } from './links.js';
import { driDevice, NVIDIA_DEVICE_REQUEST } from './gpu.js';
import { effectiveSettings, settingBindingValue } from './settings.js';
import { renderedDns } from '../egress/rules.js';
import { GATE_DIR, GATE_PORT, gateService, gateServiceDef, type GateRender } from './gate.js';

// Decision 126: an active link where this instance is the consumer: its bound services get the provider's
// address. Decision 171: link networks never appear in a Compose file (Compose would add every service
// name as a name on them); the runner attaches both sides with only the names Harbor chooses.
export interface ConsumerLink {
  id: string;
  alias: string;
  containerPort: number;
}

export interface RenderInput {
  // decision 184: the app's internet access; vpn/offline get a resolver Harbor controls (see renderedDns)
  internet?: 'direct' | 'vpn' | 'offline';
  // LAN mode publishes app ports on every interface (0.0.0.0); default loopback only
  bindHost?: string;
  // Decision 167: HTTPS-only — ports stay on loopback and the LAN HTTPS relay is the app's only way onto the
  // network. Recorded in the runtime file (`x-harbor.lanAccess: relay`) so the relay knows to serve it.
  lanRelay?: boolean;
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
  // decision 179: this machine's graphics card, for services granted `gpu` (absent = none: they run on the CPU)
  gpu?: HostGpu;
  // decision 180: the operator's stored setting overrides (absent/empty = every setting at the release default;
  // an override the release does not allow falls back to the default)
  settingOverrides?: Record<string, SettingValue>;
  // decision 191: the /24 Harbor chose for the app's network (absent = a network made before 0.39.0, which keeps
  // the subnet Docker gave it, or a prospective model)
  subnet?: string;
  // decision 194: Harbor's app login in front of these endpoints (the gate publishes their ports instead)
  gates?: GateRender[];
  gateDir?: string;
}

export interface RenderedCompose {
  model: Record<string, unknown>;
  yaml: string;
  // service -> env keys that were generated (for tests/inspection; never values)
  generatedEnv: Record<string, string[]>;
}

// Decision 163: what `ip-forwarding` means, exactly (namespaced to the container's own network stack)
export const IP_FORWARDING_SYSCTLS: Readonly<Record<string, string>> = {
  'net.ipv4.ip_forward': '1',
  'net.ipv4.conf.all.src_valid_mark': '1',
  'net.ipv6.conf.all.disable_ipv6': '0',
  'net.ipv6.conf.all.forwarding': '1',
  'net.ipv6.conf.default.forwarding': '1',
};

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
  const gated = new Map((input.gates ?? []).map((g) => [g.endpointId, g]));
  const consumerLinks = input.consumerLinks ?? [];
  const settingValues = effectiveSettings(manifest, input.settingOverrides ?? {});

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
    // decision 180: settings are visible values, written as literals ($ escaped like every other literal)
    for (const st of manifest.settings ?? []) {
      for (const b of st.bindings) {
        if (b.service !== service) continue;
        env[b.environment] = escapeCompose(settingBindingValue(st, b, settingValues[st.id]!));
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

    const ports: Record<string, unknown>[] = endpoints
      .filter((e) => e.service === service && !gated.has(e.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({ target: e.containerPort, published: String(e.hostPort), host_ip: input.bindHost ?? '127.0.0.1', protocol: 'tcp', mode: 'host' }));
    // decision 163: fixed ports go on every interface whatever the LAN setting (a tunnel port is useless on loopback)
    for (const [, p] of Object.entries(manifest.ports ?? {}).filter(([, p]) => p.service === service).sort(([a], [b]) => a.localeCompare(b))) {
      ports.push({ target: p.containerPort, published: String(p.hostPort), host_ip: '0.0.0.0', protocol: p.protocol, mode: 'host' });
    }

    // Built services (git sources, decision 80) reference the locally built tag from release.json.
    const builtTag = input.builtImages?.[service];
    if (!src.image && !builtTag) throw new Error(`service ${service} has no image and no recorded build tag`);
    const def: Record<string, unknown> = {
      image: src.image ?? builtTag,
      restart: 'unless-stopped',
      labels: { ...labels, [LABELS.service]: service, [LABELS.kind]: manifest.deployment.services[service] ?? 'application' },
      networks: ['default'],
    };
    if (src.command) def['command'] = src.command.map(escapeCompose);
    const dns = renderedDns(input.internet ?? 'direct');
    if (dns) def['dns'] = dns;
    // decision 163: the only privileges a package can ask for, rendered from Harbor's fixed table
    const perms = manifest.permissions?.[service] ?? [];
    if (perms.includes('net-admin')) def['cap_add'] = ['NET_ADMIN'];
    if (perms.includes('tun')) def['devices'] = ['/dev/net/tun:/dev/net/tun'];
    if (perms.includes('ip-forwarding')) def['sysctls'] = { ...IP_FORWARDING_SYSCTLS };
    // decision 193: everything at once (all devices, every capability, no seccomp/AppArmor); trusted sources only
    if (perms.includes('privileged')) def['privileged'] = true;
    // decision 179: the graphics card, from host facts (none: nothing, the app runs on the CPU)
    if (perms.includes('gpu') && input.gpu?.kind === 'nvidia') {
      def['deploy'] = { resources: { reservations: { devices: [{ ...NVIDIA_DEVICE_REQUEST, capabilities: [...NVIDIA_DEVICE_REQUEST.capabilities] }] } } };
    } else if (perms.includes('gpu') && input.gpu?.kind === 'dri' && input.gpu.renderNode) {
      // only the render node and its group: compute and media work, no display or modesetting (card<N>)
      def['devices'] = [...((def['devices'] as string[] | undefined) ?? []), driDevice(input.gpu.renderNode)];
      if (input.gpu.renderGid !== undefined) def['group_add'] = [String(input.gpu.renderGid)];
    }
    if (Object.keys(env).length) def['environment'] = env;
    if (ports.length) def['ports'] = ports;
    if (src.depends_on) def['depends_on'] = src.depends_on;
    if (src.healthcheck?.disable) def['healthcheck'] = { disable: true };
    else if (src.healthcheck?.test) def['healthcheck'] = { ...src.healthcheck, test: src.healthcheck.test.map(escapeCompose) };
    if (src.volumes?.length) {
      def['volumes'] = src.volumes.map((m) => {
        const ext = external[m.source];
        if (ext) return { type: 'bind', source: ext.hostPath, target: m.target, ...(m.read_only || ext.readOnly ? { read_only: true } : {}), bind: { create_host_path: false } };
        return { type: 'volume', source: m.source, target: m.target, ...(m.read_only ? { read_only: true } : {}) };
      });
    }
    services[service] = def;
  }

  // decision 194: one gate per gated endpoint, publishing that endpoint's port; the app service keeps only its network
  for (const g of [...gated.values()].sort((a, b) => a.endpointId.localeCompare(b.endpointId))) {
    const ep = endpointById.get(g.endpointId);
    if (!ep) throw new Error(`login gate for unallocated endpoint ${g.endpointId}`);
    const def = gateServiceDef(g, {
      appName: manifest.metadata.name,
      labels,
      ports: [{ target: GATE_PORT, published: String(ep.hostPort), host_ip: input.bindHost ?? '127.0.0.1', protocol: 'tcp', mode: 'host' }],
      gateDir: input.gateDir ?? GATE_DIR,
    });
    services[gateService(g.endpointId)] = def;
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
    networks: { default: { name: defaultNetworkName(identity), driver: 'bridge', labels: { ...labels, [LABELS.kind]: 'network' }, ...(input.subnet ? { ipam: { config: [{ subnet: input.subnet }] } } : {}) } },
  };
  if (Object.keys(volumes).length) model['volumes'] = volumes;
  if (input.lanRelay) model['x-harbor'] = { lanAccess: 'relay' };

  const yaml = yamlStringify(model, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  return { model, yaml, generatedEnv };
}
