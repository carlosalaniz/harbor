import { MANIFEST_SCHEMA } from '../contracts/manifest.schema.js';
import { INTERPOLATION_RE, SECRET_TEMPLATE_SLOT } from '../contracts/patterns.js';
import type { ComposeSource, Manifest } from '../contracts/types.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';
import { declaredMinHarborProblem } from './min-harbor.js';
import { NVIDIA_RESERVED_ENV } from '../planner/gpu.js';
import { settingValueProblem } from '../planner/settings.js';

export function validateManifestShape(value: unknown, label = 'manifest.yaml'): Manifest {
  const validate = compile<Manifest>(MANIFEST_SCHEMA);
  if (!validate(value)) {
    const details = formatErrors(validate.errors);
    throw new HarborError('INVALID_PACKAGE', `${label}: ${details[0] ?? 'invalid'}`, { details });
  }
  const minHarbor = declaredMinHarborProblem(value.release.minHarbor);
  if (minHarbor) throw new HarborError('INVALID_PACKAGE', `${label}: ${minHarbor}`);
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
    // decision 194: an API endpoint is never gated (its clients send their own Authorization header)
    if (ep.login === 'required' && ep.kind === 'api') problems.push(`endpoints.${id}: login: required cannot be used on an api endpoint`);
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
      else if (def.depends_on?.[dep]?.condition === 'service_healthy' && compose.services[dep]?.healthcheck?.disable) problems.push(`service ${svc} waits for ${dep} to be healthy, but ${dep}'s healthcheck is disabled`);
    }
  }
  for (const v of composeVolumes) if (!mounted.has(v)) problems.push(`compose volume ${v} is declared but never mounted`);

  // Generated environment targets: unique across secrets + configuration, and not
  // already set as a literal in the Compose source.
  const targets = new Map<string, string>();
  const secretIds = new Set<string>();
  const claimTarget = (service: string, env: string, who: string, literalHint = '') => {
    if (!(service in manifest.deployment.services)) {
      problems.push(`${who} references unknown service ${service}`);
      return;
    }
    const key = `${service}:${env}`;
    const prior = targets.get(key);
    if (prior) problems.push(`${who} and ${prior} both target ${service}.${env}`);
    targets.set(key, who);
    if (compose.services[service]?.environment && env in compose.services[service].environment) {
      problems.push(`${who} targets ${service}.${env}, which compose.yaml already sets literally${literalHint}`);
    }
  };
  for (const s of manifest.secrets ?? []) {
    if (secretIds.has(s.id)) problems.push(`secret id ${s.id} is duplicated`);
    secretIds.add(s.id);
    for (const b of s.bindings) {
      claimTarget(b.service, b.environment, `secrets.${s.id}`);
      if (b.template !== undefined && b.template.split(SECRET_TEMPLATE_SLOT).length !== 2) problems.push(`secrets.${s.id} binding ${b.service}.${b.environment}: template must contain ${SECRET_TEMPLATE_SLOT} exactly once`);
      if (b.encode !== undefined && b.template === undefined) problems.push(`secrets.${s.id} binding ${b.service}.${b.environment}: encode applies to a template only`);
    }
    if (s.showOnce !== undefined && s.source === 'operator') problems.push(`secrets.${s.id}: showOnce applies to generated secrets only (the operator already knows a value they typed)`);
    // Decision 125: a secret is either generated by Harbor (bytes + encoding) or typed by the operator (prompt).
    if (s.source === 'operator') {
      if (!s.prompt) problems.push(`secrets.${s.id} has source operator and needs a prompt (what to type, e.g. "API token from Settings → Tokens")`);
      if (s.bytes !== undefined || s.encoding !== undefined) problems.push(`secrets.${s.id} has source operator: bytes and encoding apply to generated secrets only`);
      if (s.minLength !== undefined && s.maxLength !== undefined && s.minLength > s.maxLength) problems.push(`secrets.${s.id} minLength is larger than maxLength`);
      if (s.prompt && INTERPOLATION_RE.test(s.prompt)) problems.push(`secrets.${s.id} prompt must not contain interpolation expressions`);
    } else {
      if (s.bytes === undefined || s.encoding === undefined) problems.push(`secrets.${s.id} is generated by Harbor and needs bytes: 32 and encoding: hex (or source: operator with a prompt)`);
      if (s.prompt !== undefined || s.optional !== undefined || s.minLength !== undefined || s.maxLength !== undefined) problems.push(`secrets.${s.id}: prompt, optional, minLength and maxLength apply to source: operator only`);
    }
  }
  // Decision 126: links to another app. Every bound service joins the link network; env targets are unique.
  const linkIds = new Set<string>();
  for (const l of manifest.links ?? []) {
    if (linkIds.has(l.id)) problems.push(`link id ${l.id} is duplicated`);
    linkIds.add(l.id);
    for (const b of l.bindings) claimTarget(b.service, b.environment, `links.${l.id}`);
    if (INTERPOLATION_RE.test(l.purpose)) problems.push(`links.${l.id} purpose must not contain interpolation expressions`);
  }
  // Decision 180: settings the operator can change. Each one's default fits its own rules, and the variables it
  // binds are its alone (not a compose literal, a secret, a link or a configuration binding).
  const settingIds = new Set<string>();
  for (const st of manifest.settings ?? []) {
    const who = `settings.${st.id}`;
    if (settingIds.has(st.id)) problems.push(`setting id ${st.id} is duplicated`);
    settingIds.add(st.id);
    const numeric = st.type === 'integer' || st.type === 'number';
    if (!numeric && (st.min !== undefined || st.max !== undefined)) problems.push(`${who}: min and max apply to integer and number settings only`);
    if (st.type === 'integer' && ((st.min !== undefined && !Number.isInteger(st.min)) || (st.max !== undefined && !Number.isInteger(st.max)))) problems.push(`${who}: min and max of an integer setting must be whole numbers`);
    if (numeric && st.min !== undefined && st.max !== undefined && st.min > st.max) problems.push(`${who}: min is larger than max`);
    if (st.type !== 'string' && st.maxLength !== undefined) problems.push(`${who}: maxLength applies to string settings only`);
    if (st.type !== 'choice' && st.choices !== undefined) problems.push(`${who}: choices apply to choice settings only`);
    if (st.type === 'choice' && !st.choices?.length) problems.push(`${who}: a choice setting needs choices`);
    if (st.type === 'choice' && st.choices && new Set(st.choices.map((c) => c.value)).size !== st.choices.length) problems.push(`${who}: a choice value is listed twice`);
    if (st.type !== 'boolean' && (st.onValue !== undefined || st.offValue !== undefined)) problems.push(`${who}: onValue and offValue apply to boolean settings only`);
    if (st.type === 'boolean' && (st.onValue ?? 'true') === (st.offValue ?? 'false')) problems.push(`${who}: onValue and offValue must differ`);
    const defaultProblem = settingValueProblem(st, st.default);
    if (defaultProblem) problems.push(`${who}: the default ${JSON.stringify(st.default)} does not fit: ${defaultProblem}`);
    for (const text of [st.label, st.help ?? '']) if (INTERPOLATION_RE.test(text)) problems.push(`${who} label/help must not contain interpolation expressions`);
    for (const b of st.bindings) {
      claimTarget(b.service, b.environment, who, ' (move that value into the setting\'s default and drop it from compose.yaml)');
      if (b.template !== undefined && b.template.split(SECRET_TEMPLATE_SLOT).length !== 2) problems.push(`${who} binding ${b.service}.${b.environment}: template must contain ${SECRET_TEMPLATE_SLOT} exactly once`);
    }
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

  // Decision 163: fixed ports belong to a declared service, each host port once; two copies of an app could never
  // share a fixed port, so only single-instance apps may declare one. Permissions name declared services.
  const fixedPorts = new Map<number, string>();
  for (const [id, p] of Object.entries(manifest.ports ?? {})) {
    if (!(p.service in manifest.deployment.services)) problems.push(`ports.${id}.service references unknown service ${p.service}`);
    const key = p.hostPort;
    if (fixedPorts.has(key)) problems.push(`ports.${id}: host port ${p.hostPort}/${p.protocol} is declared twice (also ports.${fixedPorts.get(key)})`);
    fixedPorts.set(key, id);
  }
  if (fixedPorts.size && manifest.deployment.multiInstance) problems.push('ports: an app with fixed host ports must set deployment.multiInstance: false (two copies cannot share a port)');
  for (const svc of Object.keys(manifest.permissions ?? {})) {
    if (!(svc in manifest.deployment.services)) problems.push(`permissions references unknown service ${svc}`);
  }
  // Decision 179: on a service granted gpu, the NVIDIA toolkit's device and capability variables are Harbor's (the
  // renderer's device request decides them), never a compose literal or a secret, link, setting or configuration value
  for (const svc of Object.keys(manifest.permissions ?? {}).filter((x) => manifest.permissions![x]!.includes('gpu'))) {
    for (const env of NVIDIA_RESERVED_ENV) {
      if (compose.services[svc]?.environment && env in compose.services[svc].environment) problems.push(`service ${svc} is granted gpu, so compose.yaml must not set ${env} (Harbor decides which card and driver features it gets)`);
      const who = targets.get(`${svc}:${env}`);
      if (who) problems.push(`${who} targets ${svc}.${env}, which Harbor sets for a service granted gpu`);
    }
  }

  const hook = manifest.hooks?.afterStart;
  if (hook && !(hook.service in manifest.deployment.services)) problems.push(`hooks.afterStart references unknown service ${hook.service}`);

  for (const text of [manifest.metadata.name, manifest.metadata.description, manifest.setup?.instructions ?? '']) {
    if (INTERPOLATION_RE.test(text)) problems.push('metadata/setup text must not contain interpolation expressions');
  }

  if (problems.length) {
    throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]}`, { details: problems });
  }
}
