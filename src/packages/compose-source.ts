import { COMPOSE_SOURCE_SCHEMA, HEALTHCHECK_BOUNDS } from '../contracts/compose.schema.js';
import { INTERPOLATION_RE, parseDuration } from '../contracts/patterns.js';
import type { ComposeSource } from '../contracts/types.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';

// Keys that are explicitly unsupported get a clearer capability error than a generic schema failure.
const FORBIDDEN_SERVICE_KEYS = new Set([
  'container_name', 'ports', 'restart', 'env_file', 'configs', 'secrets', 'build', 'extends', 'include',
  'command', 'entrypoint', 'network_mode', 'pid', 'ipc', 'uts', 'userns_mode', 'devices', 'cap_add', 'cap_drop',
  'privileged', 'security_opt', 'sysctls', 'networks', 'volumes_from', 'user', 'labels', 'logging', 'deploy',
  'links', 'external_links', 'expose', 'dns', 'extra_hosts', 'tmpfs', 'ulimits', 'cgroup_parent', 'runtime',
  'platform', 'pull_policy', 'profiles', 'develop', 'stdin_open', 'tty', 'working_dir', 'hostname', 'domainname',
  'init', 'stop_signal', 'stop_grace_period', 'shm_size', 'mem_limit', 'cpus', 'oom_kill_disable',
]);
const FORBIDDEN_ROOT_KEYS = new Set(['networks', 'configs', 'secrets', 'include', 'name', 'version', 'x-harbor']);

export function validateComposeSource(value: unknown, label = 'compose.yaml'): ComposeSource {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const root = value as Record<string, unknown>;
    for (const k of Object.keys(root)) {
      if (FORBIDDEN_ROOT_KEYS.has(k)) throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: top-level '${k}' is not supported in packages`);
    }
    const services = root['services'];
    if (services && typeof services === 'object' && !Array.isArray(services)) {
      for (const [svc, def] of Object.entries(services as Record<string, unknown>)) {
        if (def && typeof def === 'object' && !Array.isArray(def)) {
          for (const k of Object.keys(def)) {
            if (FORBIDDEN_SERVICE_KEYS.has(k)) {
              throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: service ${svc} uses unsupported key '${k}'`);
            }
          }
          const vols = (def as Record<string, unknown>)['volumes'];
          if (Array.isArray(vols)) {
            for (const v of vols) {
              if (typeof v === 'string') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: service ${svc} uses short-form volume syntax; use long form with type: volume`);
              const t = (v as { type?: unknown })?.type;
              if (t === 'bind') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: service ${svc} uses a host bind mount`);
              if (t && t !== 'volume') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: service ${svc} uses unsupported mount type ${String(t)}`);
            }
          }
        }
      }
    }
    const volumes = root['volumes'];
    if (volumes && typeof volumes === 'object' && !Array.isArray(volumes)) {
      for (const [name, def] of Object.entries(volumes as Record<string, unknown>)) {
        if (def && typeof def === 'object') {
          for (const k of Object.keys(def as object)) {
            if (k === 'external') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: volume ${name} declares external; Harbor owns volume identity`);
            if (k === 'name') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: volume ${name} declares a custom name`);
            if (k === 'driver' || k === 'driver_opts') throw new HarborError('UNSUPPORTED_CAPABILITY', `${label}: volume ${name} declares a driver`);
          }
        }
      }
    }
  }

  const validate = compile<ComposeSource>(COMPOSE_SOURCE_SCHEMA);
  if (!validate(value)) {
    const details = formatErrors(validate.errors);
    throw new HarborError('INVALID_PACKAGE', `${label}: ${details[0] ?? 'invalid'}`, { details });
  }
  const compose = value;

  const problems: string[] = [];
  for (const [svc, def] of Object.entries(compose.services)) {
    for (const [k, v] of Object.entries(def.environment ?? {})) {
      if (INTERPOLATION_RE.test(v)) problems.push(`service ${svc} environment ${k} contains an interpolation expression`);
    }
    if (INTERPOLATION_RE.test(def.image)) problems.push(`service ${svc} image contains an interpolation expression`);
    const hc = def.healthcheck;
    if (hc) {
      for (const part of hc.test) if (INTERPOLATION_RE.test(part)) problems.push(`service ${svc} healthcheck contains an interpolation expression`);
      const check = (name: string, raw: string | undefined, bounds: { min: number; max: number }) => {
        if (raw === undefined) return;
        const ms = parseDuration(raw);
        if (ms === null || ms < bounds.min || ms > bounds.max) problems.push(`service ${svc} healthcheck ${name} ${raw} is outside ${bounds.min}ms..${bounds.max}ms`);
      };
      check('interval', hc.interval, HEALTHCHECK_BOUNDS.intervalMs);
      check('timeout', hc.timeout, HEALTHCHECK_BOUNDS.timeoutMs);
      check('start_period', hc.start_period, HEALTHCHECK_BOUNDS.startPeriodMs);
    }
    const targets = new Set<string>();
    for (const m of def.volumes ?? []) {
      if (m.target.includes('/../') || m.target.endsWith('/..')) problems.push(`service ${svc} mount target ${m.target} contains traversal`);
      if (targets.has(m.target)) problems.push(`service ${svc} mounts ${m.target} twice`);
      targets.add(m.target);
    }
  }
  if (problems.length) throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]}`, { details: problems });
  return compose;
}
