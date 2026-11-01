// Decision 194: Harbor's app login. A small proxy (gate/gate.mjs, shipped in Harbor's release folder) runs in front
// of an endpoint and asks for the app's password on a Harbor page. Pure: which endpoints are gated, the names and the
// service Harbor renders; the runner reads the stored choice and secrets.
import { createHash, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../contracts/types.js';
import { LABELS } from '../naming.js';

// the official node image the gate runs on (node:24-alpine, multi-arch index; no Harbor-built image to trust)
export const GATE_IMAGE = 'node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85';
export const GATE_IMAGE_TAG = '24-alpine';
export const GATE_PORT = 8080;
// <release>/gate (dist/planner/gate.js and src/planner/gate.ts are both two levels down)
export const GATE_DIR = fileURLToPath(new URL('../../gate/', import.meta.url));

// underscores never occur in a package's service ids (ID_PATTERN), so this name is always free
export const gateService = (endpointId: string): string => `harbor_gate_${endpointId.replace(/-/g, '_')}`;
// secret file names: dots never occur in a package's secret ids, so these cannot collide with them
export const loginPasswordSecret = (endpointId: string): string => `harbor.login.${endpointId}`;
export const loginKeySecret = (endpointId: string): string => `harbor.login.${endpointId}.key`;
// one cookie per app and endpoint: apps on one host name share cookies across ports
export const gateCookieName = (instanceId: string, endpointId: string): string => `harbor_gate_${instanceId.replace(/-/g, '').slice(0, 12)}_${endpointId.replace(/-/g, '_')}`;

export type LoginLock = 'required' | 'never' | null;
export interface EndpointLogin {
  endpoint: string;
  on: boolean;
  // the package decides: required = always on, never = cannot be turned on; null = the operator's switch
  locked: LoginLock;
}

// Pure: every web endpoint and whether it asks for a login. API endpoints are never gated (their clients send their
// own Authorization headers) and are left out.
export function loginsOf(manifest: Manifest, choices: Record<string, boolean>): EndpointLogin[] {
  return Object.entries(manifest.endpoints)
    .filter(([, e]) => e.kind !== 'api')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, e]) => {
      const locked: LoginLock = e.login === 'required' ? 'required' : e.login === 'never' ? 'never' : null;
      return { endpoint: id, on: locked === 'required' ? true : locked === 'never' ? false : choices[id] === true, locked };
    });
}
export function gatedEndpoints(manifest: Manifest, choices: Record<string, boolean>): string[] {
  return loginsOf(manifest, choices)
    .filter((l) => l.on)
    .map((l) => l.endpoint);
}

// The hash handed to the gate (format gate/gate.mjs verifies). The salt comes from the cookie key, so the same
// password and key render the same file (no container is recreated by a re-render), and a new password (which gets
// a new key) gets a new salt.
export function gatePasswordHash(password: string, cookieKey: string): string {
  const salt = createHash('sha256').update(`harbor-gate-salt:${cookieKey}`).digest('hex').slice(0, 32);
  const N = 16384;
  const hash = scryptSync(password, Buffer.from(salt, 'hex'), 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${N}:8:1:${salt}:${hash.toString('hex')}`;
}

export interface GateRender {
  endpointId: string;
  service: string; // the app service the endpoint belongs to
  containerPort: number;
  cookieName: string;
  passwordHash: string;
  cookieKey: string;
  healthPath: string | null;
}

// The Compose service of one gate. Its port mapping is the endpoint's (the app service no longer publishes it).
export function gateServiceDef(g: GateRender, opts: { appName: string; labels: Record<string, string>; ports: Record<string, unknown>[]; gateDir: string }): Record<string, unknown> {
  return {
    image: GATE_IMAGE,
    restart: 'unless-stopped',
    labels: { ...opts.labels, [LABELS.service]: gateService(g.endpointId), [LABELS.kind]: 'infrastructure' },
    networks: ['default'],
    user: 'node',
    read_only: true,
    command: ['node', '/harbor-gate/gate.mjs'],
    environment: {
      GATE_UPSTREAM: `http://${g.service}:${g.containerPort}`,
      GATE_PASSWORD_HASH: g.passwordHash,
      GATE_COOKIE_KEY: g.cookieKey,
      GATE_COOKIE: g.cookieName,
      GATE_APP: opts.appName.replace(/\$/g, '$$$$'),
      GATE_PORT: String(GATE_PORT),
      ...(g.healthPath ? { GATE_HEALTH_PATH: g.healthPath.replace(/\$/g, '$$$$') } : {}),
    },
    ports: opts.ports,
    volumes: [{ type: 'bind', source: opts.gateDir, target: '/harbor-gate', read_only: true, bind: { create_host_path: false } }],
    depends_on: { [g.service]: { condition: 'service_started' } },
  };
}
