import { describe, expect, it } from 'vitest';
import { validateManifestShape, validateManifestReferences } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { HarborError } from '../../src/errors.js';
import { DIGEST_A, DIGEST_B, MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const manifestOf = (s: string) => validateManifestShape(y(s));
const composeOf = (s: string) => validateComposeSource(y(s));
const full = (m: string, c: string) => {
  const manifest = manifestOf(m);
  const compose = composeOf(c);
  validateManifestReferences(manifest, compose);
  return { manifest, compose };
};
function expectCode(fn: () => unknown, code: 'INVALID_PACKAGE' | 'UNSUPPORTED_CAPABILITY', re?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(HarborError.is(e), `expected HarborError, got ${String(e)}`).toBe(true);
    expect((e as HarborError).code).toBe(code);
    if (re) expect((e as Error).message + ' ' + (e as HarborError).details.join(' ')).toMatch(re);
    return;
  }
  throw new Error('expected rejection');
}

const N8N_LIKE_MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata: {id: flow, name: Flow, description: Flow app}
release: {revision: "1"}
deployment:
  compose: compose.yaml
  multiInstance: true
  services: {web: application, postgres: infrastructure}
endpoints:
  web: {service: web, containerPort: 5678, scheme: http, exposure: direct, browserContext: secure}
health: {endpoint: web, path: /healthz/readiness, expectedStatus: [200], timeoutSeconds: 5, deadlineSeconds: 180}
ui: {primaryEndpoint: web}
setup: {endpoint: web, instructions: Finish owner setup.}
storage:
  - {id: database, composeVolume: database, purpose: DB, retention: retain}
  - {id: app-state, composeVolume: app-state, purpose: State, retention: retain}
secrets:
  - id: database-password
    bytes: 32
    encoding: hex
    retention: retain
    bindings:
      - {service: postgres, environment: POSTGRES_PASSWORD}
      - {service: web, environment: DB_POSTGRESDB_PASSWORD}
  - id: encryption-key
    bytes: 32
    encoding: hex
    retention: retain
    bindings:
      - {service: web, environment: N8N_ENCRYPTION_KEY}
configuration:
  - {service: web, environment: N8N_EDITOR_BASE_URL, endpoint: web}
  - {service: web, environment: WEBHOOK_URL, endpoint: web}
`;
const N8N_LIKE_COMPOSE = `services:
  postgres:
    image: postgres@${DIGEST_A}
    environment: {POSTGRES_USER: n8n, POSTGRES_DB: n8n}
    healthcheck:
      test: [CMD, pg_isready, -U, n8n, -d, n8n]
      interval: 5s
      timeout: 3s
      retries: 20
    volumes:
      - {type: volume, source: database, target: /var/lib/postgresql/data}
  web:
    image: n8nio/n8n@${DIGEST_B}
    environment: {DB_TYPE: postgresdb, DB_POSTGRESDB_PORT: "5432", TZ: UTC}
    depends_on:
      postgres: {condition: service_healthy}
    volumes:
      - {type: volume, source: app-state, target: /home/node/.n8n}
volumes:
  database: {}
  app-state: {}
`;

describe('manifest schema', () => {
  it('accepts the minimal manifest and the multi-service manifest', () => {
    expect(full(MINIMAL_MANIFEST, MINIMAL_COMPOSE).manifest.metadata.id).toBe('demo');
    expect(full(N8N_LIKE_MANIFEST, N8N_LIKE_COMPOSE).manifest.secrets?.length).toBe(2);
  });
  it('rejects unknown fields anywhere', () => {
    expectCode(() => manifestOf(MINIMAL_MANIFEST + 'extra: 1\n'), 'INVALID_PACKAGE', /additional/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('  primaryEndpoint: web', '  primaryEndpoint: web\n  theme: dark')), 'INVALID_PACKAGE', /additional/);
  });
  it('rejects wrong apiVersion/kind and missing required fields', () => {
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('harbor/v1alpha1', 'harbor/v1')), 'INVALID_PACKAGE', /apiVersion/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('kind: Application', 'kind: App')), 'INVALID_PACKAGE', /kind/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace(/ui:\n {2}primaryEndpoint: web\n/, '')), 'INVALID_PACKAGE', /ui/);
  });
  it('does not coerce types', () => {
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('containerPort: 80', 'containerPort: "80"')), 'INVALID_PACKAGE', /containerPort/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('multiInstance: true', 'multiInstance: "true"')), 'INVALID_PACKAGE', /multiInstance/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('revision: "1"', 'revision: 1')), 'INVALID_PACKAGE', /revision/);
  });
  it('rejects bad ids, html in text, and out-of-range bounds', () => {
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('id: demo', 'id: Demo_App')), 'INVALID_PACKAGE', /id/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('name: Demo', 'name: <b>Demo</b>')), 'INVALID_PACKAGE', /name/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('timeoutSeconds: 5', 'timeoutSeconds: 31')), 'INVALID_PACKAGE', /timeoutSeconds/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('deadlineSeconds: 90', 'deadlineSeconds: 601')), 'INVALID_PACKAGE', /deadlineSeconds/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('path: /', 'path: ../etc')), 'INVALID_PACKAGE', /path/);
    expectCode(() => manifestOf(MINIMAL_MANIFEST.replace('expectedStatus: [200]', 'expectedStatus: []')), 'INVALID_PACKAGE', /expectedStatus/);
  });
  it('rejects invalid references', () => {
    expectCode(() => full(MINIMAL_MANIFEST.replace('endpoint: web', 'endpoint: api'), MINIMAL_COMPOSE), 'INVALID_PACKAGE', /unknown endpoint api/);
    expectCode(() => full(MINIMAL_MANIFEST.replace('primaryEndpoint: web', 'primaryEndpoint: nope'), MINIMAL_COMPOSE), 'INVALID_PACKAGE', /unknown endpoint nope/);
    expectCode(() => full(MINIMAL_MANIFEST.replace('    service: web', '    service: app'), MINIMAL_COMPOSE), 'INVALID_PACKAGE', /unknown service app/);
    expectCode(() => full(MINIMAL_MANIFEST.replace('    web: application', '    web: application\n    db: infrastructure'), MINIMAL_COMPOSE), 'INVALID_PACKAGE', /must equal compose services/);
    expectCode(() => full(MINIMAL_MANIFEST.replace('    web: application', '    web: infrastructure'), MINIMAL_COMPOSE), 'INVALID_PACKAGE', /at least one application/);
  });
  it('requires every compose volume to be claimed exactly once and mounted', () => {
    expectCode(() => full(N8N_LIKE_MANIFEST.replace(/ {2}- \{id: app-state.*\n/, ''), N8N_LIKE_COMPOSE), 'INVALID_PACKAGE', /app-state has no storage claim/);
    expectCode(() => full(N8N_LIKE_MANIFEST.replace('composeVolume: app-state', 'composeVolume: database'), N8N_LIKE_COMPOSE), 'INVALID_PACKAGE', /claimed 2 times|no storage claim/);
    expectCode(() => full(N8N_LIKE_MANIFEST, N8N_LIKE_COMPOSE + '  extra: {}\n'), 'INVALID_PACKAGE', /extra/);
    expectCode(() => full(N8N_LIKE_MANIFEST, N8N_LIKE_COMPOSE.replace('source: app-state', 'source: other')), 'INVALID_PACKAGE', /undeclared volume other/);
  });
  it('rejects duplicate or conflicting generated environment targets', () => {
    expectCode(() => full(N8N_LIKE_MANIFEST.replace('environment: WEBHOOK_URL', 'environment: N8N_ENCRYPTION_KEY'), N8N_LIKE_COMPOSE), 'INVALID_PACKAGE', /both target web.N8N_ENCRYPTION_KEY/);
    expectCode(() => full(N8N_LIKE_MANIFEST, N8N_LIKE_COMPOSE.replace('TZ: UTC', 'TZ: UTC, N8N_ENCRYPTION_KEY: x')), 'INVALID_PACKAGE', /already sets literally/);
    expectCode(() => full(N8N_LIKE_MANIFEST.replace('id: encryption-key', 'id: database-password'), N8N_LIKE_COMPOSE), 'INVALID_PACKAGE', /duplicated/);
  });
});

describe('compose source subset', () => {
  it('accepts the supported subset', () => {
    expect(Object.keys(composeOf(N8N_LIKE_COMPOSE).services)).toEqual(['postgres', 'web']);
  });
  it('requires digest-pinned images and rejects tags/latest/interpolation', () => {
    expectCode(() => composeOf('services:\n  web:\n    image: nginx:latest\n'), 'INVALID_PACKAGE', /image/);
    expectCode(() => composeOf('services:\n  web:\n    image: nginx\n'), 'INVALID_PACKAGE', /image/);
    expectCode(() => composeOf(`services:\n  web:\n    image: nginx@sha256:${'A'.repeat(64)}\n`), 'INVALID_PACKAGE', /image/);
    expectCode(() => composeOf('services:\n  web:\n    image: ${IMAGE}\n'), 'INVALID_PACKAGE', /image/);
  });
  it('rejects forbidden service keys with UNSUPPORTED_CAPABILITY', () => {
    for (const k of ['container_name: x', 'ports: ["80:80"]', 'restart: always', 'privileged: true', 'env_file: .env', 'build: .', 'command: sh', 'entrypoint: sh', 'network_mode: host', 'pid: host', 'cap_add: [SYS_ADMIN]', 'devices: [/dev/sda]', 'extends: {service: a}', 'user: root', 'networks: [foo]']) {
      expectCode(() => composeOf(MINIMAL_COMPOSE + '    ' + k + '\n'), 'UNSUPPORTED_CAPABILITY', /unsupported key/);
    }
  });
  it('rejects bind mounts, short-form volumes, external/global volume names and root networks', () => {
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - {type: bind, source: /etc, target: /x}\n'), 'UNSUPPORTED_CAPABILITY', /bind/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'), 'UNSUPPORTED_CAPABILITY', /short-form/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - {type: volume, source: data, target: /x}\nvolumes:\n  data: {external: true}\n'), 'UNSUPPORTED_CAPABILITY', /external/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - {type: volume, source: data, target: /x}\nvolumes:\n  data: {name: shared}\n'), 'UNSUPPORTED_CAPABILITY', /custom name/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + 'networks:\n  default: {}\n'), 'UNSUPPORTED_CAPABILITY', /networks/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - {type: volume, source: data, target: relative}\nvolumes:\n  data: {}\n'), 'INVALID_PACKAGE', /target/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    volumes:\n      - {type: volume, source: data, target: /a/../b}\nvolumes:\n  data: {}\n'), 'INVALID_PACKAGE', /traversal/);
  });
  it('rejects interpolation in environment but allows harmless literal dollars', () => {
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    environment:\n      A: ${HOME}\n'), 'INVALID_PACKAGE', /interpolation/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    environment:\n      A: $HOME\n'), 'INVALID_PACKAGE', /interpolation/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    environment:\n      A: "$$HOME"\n'), 'INVALID_PACKAGE', /interpolation/);
    expect(composeOf(MINIMAL_COMPOSE + '    environment:\n      PRICE: "5$ or $ 5"\n').services['web']?.environment?.['PRICE']).toBe('5$ or $ 5');
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    environment:\n      A: 1\n'), 'INVALID_PACKAGE', /string/);
    expectCode(() => composeOf(MINIMAL_COMPOSE + '    environment:\n      lower: x\n'), 'INVALID_PACKAGE', /lower|propertyNames|pattern/);
  });
  it('bounds healthcheck values and requires CMD arrays', () => {
    const hc = (body: string) => composeOf(MINIMAL_COMPOSE + '    healthcheck:\n' + body);
    expectCode(() => hc('      test: curl -f http://localhost\n'), 'INVALID_PACKAGE', /test/);
    expectCode(() => hc('      test: [CMD-SHELL, "curl -f http://localhost"]\n'), 'INVALID_PACKAGE', /test/);
    expectCode(() => hc('      test: [CMD, "true"]\n      interval: 500ms\n'), 'INVALID_PACKAGE', /interval/);
    expectCode(() => hc('      test: [CMD, "true"]\n      retries: 0\n'), 'INVALID_PACKAGE', /retries/);
    expectCode(() => hc('      test: [CMD, "true"]\n      timeout: 10m\n'), 'INVALID_PACKAGE', /timeout/);
    expect(hc('      test: [CMD, "true"]\n      interval: 5s\n      timeout: 3s\n      retries: 3\n      start_period: 10s\n').services['web']?.healthcheck?.retries).toBe(3);
  });
});
