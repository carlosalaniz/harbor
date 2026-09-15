import { MANIFEST_SCHEMA } from '../contracts/manifest.schema.js';
import { INTERPOLATION_RE } from '../contracts/patterns.js';
import type { ComposeSource, Manifest } from '../contracts/types.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';

export function validateManifestShape(value: unknown, label = 'manifest.yaml'): Manifest {
  const validate = compile<Manifest>(MANIFEST_SCHEMA);
  if (!validate(value)) {
    const details = formatErrors(validate.errors);
    throw new HarborError('INVALID_PACKAGE', `${label}: ${details[0] ?? 'invalid'}`, { details });
  }
  return value;
}

// Cross-reference validation between manifest and its Compose source (TDD 4.2).
export function validateManifestReferences(manifest: Manifest, compose: ComposeSource, label = 'manifest.yaml'): void {
  const problems: string[] = [];
  const services = Object.keys(manifest.deployment.services).sort();
  const composeServices = Object.keys(compose.services).sort();
  if (services.join(',') !== composeServices.join(',')) {
    problems.push(`deployment.services keys [${services.join(', ')}] must equal compose services [${composeServices.join(', ')}]`);
  }
  if (!Object.values(manifest.deployment.services).includes('application')) {
    problems.push('deployment.services must include at least one application service');
  }
  const endpointIds = Object.keys(manifest.endpoints);
  for (const [id, ep] of Object.entries(manifest.endpoints)) {
    if (!(ep.service in manifest.deployment.services)) problems.push(`endpoints.${id}.service references unknown service ${ep.service}`);
  }
  const requireEndpoint = (ref: string, where: string) => {
    if (!endpointIds.includes(ref)) problems.push(`${where} references unknown endpoint ${ref}`);
  };
  requireEndpoint(manifest.health.endpoint, 'health.endpoint');
  requireEndpoint(manifest.ui.primaryEndpoint, 'ui.primaryEndpoint');
  if (manifest.setup) requireEndpoint(manifest.setup.endpoint, 'setup.endpoint');

  // Storage: every compose volume claimed exactly once, every claim points at a declared volume.
  const composeVolumes = Object.keys(compose.volumes ?? {});
  const claimed = new Map<string, number>();
  const storageIds = new Set<string>();
  for (const s of manifest.storage ?? []) {
    if (storageIds.has(s.id)) problems.push(`storage id ${s.id} is duplicated`);
    storageIds.add(s.id);
    if (!composeVolumes.includes(s.composeVolume)) problems.push(`storage.${s.id} references undeclared compose volume ${s.composeVolume}`);
    claimed.set(s.composeVolume, (claimed.get(s.composeVolume) ?? 0) + 1);
  }
  for (const v of composeVolumes) {
    const n = claimed.get(v) ?? 0;
    if (n === 0) problems.push(`compose volume ${v} has no storage claim`);
    if (n > 1) problems.push(`compose volume ${v} is claimed ${n} times`);
  }
  // Every declared volume must be mounted somewhere and every mount source declared.
  const mounted = new Set<string>();
  for (const [svc, def] of Object.entries(compose.services)) {
    for (const m of def.volumes ?? []) {
      if (!composeVolumes.includes(m.source)) problems.push(`service ${svc} mounts undeclared volume ${m.source}`);
      mounted.add(m.source);
    }
    for (const dep of Object.keys(def.depends_on ?? {})) {
      if (dep === svc) problems.push(`service ${svc} depends on itself`);
      else if (!(dep in compose.services)) problems.push(`service ${svc} depends on unknown service ${dep}`);
    }
  }
  for (const v of composeVolumes) if (!mounted.has(v)) problems.push(`compose volume ${v} is declared but never mounted`);

  // Generated environment targets: unique across secrets + configuration, and not
  // already set as a literal in the Compose source.
  const targets = new Map<string, string>();
  const secretIds = new Set<string>();
  const claimTarget = (service: string, env: string, who: string) => {
    if (!(service in manifest.deployment.services)) {
      problems.push(`${who} references unknown service ${service}`);
      return;
    }
    const key = `${service}:${env}`;
    const prior = targets.get(key);
    if (prior) problems.push(`${who} and ${prior} both target ${service}.${env}`);
    targets.set(key, who);
    if (compose.services[service]?.environment && env in compose.services[service].environment) {
      problems.push(`${who} targets ${service}.${env}, which compose.yaml already sets literally`);
    }
  };
  for (const s of manifest.secrets ?? []) {
    if (secretIds.has(s.id)) problems.push(`secret id ${s.id} is duplicated`);
    secretIds.add(s.id);
    for (const b of s.bindings) claimTarget(b.service, b.environment, `secrets.${s.id}`);
  }
  for (const c of manifest.configuration ?? []) {
    requireEndpoint(c.endpoint, `configuration ${c.service}.${c.environment}`);
    claimTarget(c.service, c.environment, `configuration.${c.endpoint}`);
  }
  // Provisioned admin credential (decision 79): same uniqueness rules as other generated env.
  if (manifest.provisionedCredentials) {
    const pc = manifest.provisionedCredentials;
    claimTarget(pc.service, pc.passwordEnv, 'provisionedCredentials.passwordEnv');
    if (pc.usernameEnv) claimTarget(pc.service, pc.usernameEnv, 'provisionedCredentials.usernameEnv');
    if (!pc.usernameEnv && !pc.username) problems.push('provisionedCredentials needs usernameEnv (Harbor injects the name) or username (documented fixed name)');
    if (secretIds.has('provisioned-password')) problems.push('secret id provisioned-password is reserved for provisionedCredentials');
    if (manifest.defaultCredentials) problems.push('defaultCredentials and provisionedCredentials are mutually exclusive');
  }

  for (const text of [manifest.metadata.name, manifest.metadata.description, manifest.setup?.instructions ?? '']) {
    if (INTERPOLATION_RE.test(text)) problems.push('metadata/setup text must not contain interpolation expressions');
  }

  if (problems.length) {
    throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]}`, { details: problems });
  }
}
