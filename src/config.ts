import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PRODUCT } from './naming.js';
import { compile, formatErrors } from './contracts/validate.js';
import { HarborError } from './errors.js';

export type DockerConfig =
  | { mode: 'fake' }
  | { mode: 'socket'; socketPath: string; cliPluginDirs: string[] };

export interface DaemonConfig {
  stateDir: string;
  catalogDir: string;
  uiDir: string | null;
  listen: { host: '127.0.0.1'; port: number };
  docker: DockerConfig;
  appPortRange: { from: number; to: number };
  imagePullTimeoutMs: number;
  startTimeoutMs: number;
  sessionTtlSeconds: number;
  planTtlSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stateDir', 'catalogDir', 'docker'],
  properties: {
    stateDir: { type: 'string', minLength: 1 },
    catalogDir: { type: 'string', minLength: 1 },
    uiDir: { type: ['string', 'null'] },
    listen: {
      type: 'object',
      additionalProperties: false,
      properties: { host: { const: '127.0.0.1' }, port: { type: 'integer', minimum: 1024, maximum: 65535 } },
    },
    docker: {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'fake' } } },
        { type: 'object', additionalProperties: false, required: ['mode', 'socketPath'], properties: { mode: { const: 'socket' }, socketPath: { type: 'string', minLength: 1 }, cliPluginDirs: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 } } },
      ],
    },
    appPortRange: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: { from: { type: 'integer', minimum: 1024, maximum: 65535 }, to: { type: 'integer', minimum: 1024, maximum: 65535 } },
    },
    imagePullTimeoutMs: { type: 'integer', minimum: 1000 },
    startTimeoutMs: { type: 'integer', minimum: 1000 },
    sessionTtlSeconds: { type: 'integer', minimum: 60 },
    planTtlSeconds: { type: 'integer', minimum: 60 },
    logLevel: { enum: ['debug', 'info', 'warn', 'error'] },
  },
} as const;

export const CONFIG_DEFAULTS = {
  listen: { host: '127.0.0.1', port: PRODUCT.defaults.managementPort },
  appPortRange: { ...PRODUCT.defaults.appPortRange },
  imagePullTimeoutMs: 15 * 60_000,
  startTimeoutMs: 180_000,
  sessionTtlSeconds: 12 * 3600,
  planTtlSeconds: 15 * 60,
  logLevel: 'info',
  uiDir: null,
} as const;

// Configuration is always explicit: a JSON file path. No dotenv, no cwd discovery, no
// implicit Docker socket detection.
export function loadConfig(file: string): DaemonConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new HarborError('STATE_UNAVAILABLE', `cannot read config ${file}: ${(e as Error).message}`);
  }
  return normalizeConfig(raw, path.dirname(path.resolve(file)));
}

export function normalizeConfig(raw: unknown, baseDir: string): DaemonConfig {
  const validate = compile<Partial<DaemonConfig> & Pick<DaemonConfig, 'stateDir' | 'catalogDir' | 'docker'>>(CONFIG_SCHEMA);
  if (!validate(raw)) {
    throw new HarborError('STATE_UNAVAILABLE', `invalid config: ${formatErrors(validate.errors).join('; ')}`);
  }
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p));
  const cfg: DaemonConfig = {
    stateDir: abs(raw.stateDir),
    catalogDir: abs(raw.catalogDir),
    uiDir: raw.uiDir ? abs(raw.uiDir) : null,
    listen: { host: '127.0.0.1', port: raw.listen?.port ?? CONFIG_DEFAULTS.listen.port },
    docker: raw.docker.mode === 'socket' ? { mode: 'socket', socketPath: raw.docker.socketPath, cliPluginDirs: (raw.docker as { cliPluginDirs?: string[] }).cliPluginDirs ?? [] } : { mode: 'fake' },
    appPortRange: raw.appPortRange ?? { ...CONFIG_DEFAULTS.appPortRange },
    imagePullTimeoutMs: raw.imagePullTimeoutMs ?? CONFIG_DEFAULTS.imagePullTimeoutMs,
    startTimeoutMs: raw.startTimeoutMs ?? CONFIG_DEFAULTS.startTimeoutMs,
    sessionTtlSeconds: raw.sessionTtlSeconds ?? CONFIG_DEFAULTS.sessionTtlSeconds,
    planTtlSeconds: raw.planTtlSeconds ?? CONFIG_DEFAULTS.planTtlSeconds,
    logLevel: raw.logLevel ?? CONFIG_DEFAULTS.logLevel,
  };
  if (cfg.appPortRange.from > cfg.appPortRange.to) throw new HarborError('STATE_UNAVAILABLE', 'invalid config: appPortRange.from > to');
  if (cfg.listen.port >= cfg.appPortRange.from && cfg.listen.port <= cfg.appPortRange.to) {
    throw new HarborError('STATE_UNAVAILABLE', 'invalid config: management port lies inside the app port range');
  }
  return cfg;
}

export function managementOrigin(cfg: DaemonConfig): string {
  return `http://localhost:${cfg.listen.port}`;
}

export function browserUrlFor(hostPort: number, pathname = '/'): string {
  // Browser URLs are rendered here only; the domain model stores host ports, not URLs.
  return `http://localhost:${hostPort}${pathname}`;
}
