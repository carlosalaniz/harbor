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
// Decision 195: one password per app. Secret file names: dots never occur in a package's secret ids, so these cannot
// collide with them.
export const LOGIN_PASSWORD_SECRET = 'harbor.login';
export const LOGIN_KEY_SECRET = 'harbor.login.key';
// 0.41's one password per endpoint: read until the app's next render adopts them (instance-dir.adoptLegacyLogin)
export const legacyLoginPasswordSecret = (endpointId: string): string => `harbor.login.${endpointId}`;
export const legacyLoginKeySecret = (endpointId: string): string => `harbor.login.${endpointId}.key`;
// one cookie per app (its pages share a host name, so signing in once covers them); apps on one host name share
// cookies across ports, so the name carries the instance
export const gateCookieName = (instanceId: string): string => `harbor_gate_${instanceId.replace(/-/g, '').slice(0, 12)}`;

export type LoginLock = 'required' | 'never' | null;
// Decision 195: the app's one login. `endpoints` are the web endpoints behind it, `open` the ones the package rules out
// (`login: never`: their own clients send their own Authorization header).
export interface AppLogin {
  on: boolean;
  // the package decides: required = always on, never = no endpoint can have it; null = the operator's switch
  locked: LoginLock;
  endpoints: string[];
  open: string[];
}

// Pure. API endpoints are never gated (their clients send their own Authorization headers) and are left out; null =
// the app has no web endpoint at all. One endpoint marked required puts the login in front of every endpoint that
// allows it. `choices` is the stored switch doc: any endpoint switched on (0.41 stored one per endpoint) means on.
export function appLoginOf(manifest: Manifest, choices: Record<string, boolean>): AppLogin | null {
  const web = Object.entries(manifest.endpoints)
    .filter(([, e]) => e.kind !== 'api')
    .sort(([a], [b]) => a.localeCompare(b));
  if (!web.length) return null;
  const endpoints = web.filter(([, e]) => e.login !== 'never').map(([id]) => id);
  const open = web.filter(([, e]) => e.login === 'never').map(([id]) => id);
  if (!endpoints.length) return { on: false, locked: 'never', endpoints, open };
  if (web.some(([, e]) => e.login === 'required')) return { on: true, locked: 'required', endpoints, open };
  return { on: Object.values(choices).some(Boolean), locked: null, endpoints, open };
}
export function gatedEndpoints(manifest: Manifest, choices: Record<string, boolean>): string[] {
  const login = appLoginOf(manifest, choices);
  return login?.on ? login.endpoints : [];
}
// the stored form of the switch
export function loginChoices(login: AppLogin, on: boolean): Record<string, boolean> {
  return on ? Object.fromEntries(login.endpoints.map((e) => [e, true])) : {};
}

// Packages with their own onboarding or a Harbor-provisioned admin manage their own accounts (n8n, Nextcloud)
export function packageHasOwnLogin(manifest: Manifest): boolean {
  return manifest.setup !== undefined || manifest.provisionedCredentials !== undefined;
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
