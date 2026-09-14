import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { allocateEndpoints } from '../../src/planner/ports.js';
import { identityFor, proposeName } from '../../src/planner/identity.js';
import { escapeCompose, renderCompose } from '../../src/planner/render.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { DIGEST_A, DIGEST_B, MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';
import { LABELS } from '../../src/naming.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const manifest = validateManifestShape(y(MINIMAL_MANIFEST));
const compose = validateComposeSource(y(MINIMAL_COMPOSE));
const range = { from: 18080, to: 18999 };

describe('identity', () => {
  it('derives distinct project names from distinct instance ids', () => {
    const a = identityFor('inst', '11111111-1111-4111-8111-111111111111');
    const b = identityFor('inst', '22222222-2222-4222-8222-222222222222');
    expect(a.project).toBe('hb_11111111111141118111111111111111');
    expect(a.project).not.toBe(b.project);
  });
  it('proposes default names', () => {
    expect(proposeName('excalidraw', new Set())).toEqual({ name: 'excalidraw' });
    expect(proposeName('excalidraw', new Set(['excalidraw']))).toEqual({ name: 'excalidraw-2' });
    expect(proposeName('excalidraw', new Set(['excalidraw', 'excalidraw-2']))).toEqual({ name: 'excalidraw-3' });
    expect(proposeName('excalidraw', new Set(['x']), 'Bad_Name').error).toMatch(/must match/);
    expect(proposeName('excalidraw', new Set(['mine']), 'mine').error).toMatch(/already used/);
  });
});

describe('port allocation', () => {
  it('chooses the lowest free port per endpoint, sorted by endpoint id', () => {
    const m = { ...manifest, endpoints: { z: { ...manifest.endpoints['web']!, containerPort: 2 }, a: { ...manifest.endpoints['web']!, containerPort: 1 } } };
    expect(allocateEndpoints(m, range, new Set([18080, 18082]))).toEqual([
      { id: 'a', service: 'web', containerPort: 1, hostPort: 18081 },
      { id: 'z', service: 'web', containerPort: 2, hostPort: 18083 },
    ]);
  });
  it('fails with PORT_CONFLICT when the range is exhausted', () => {
    const all = new Set<number>();
    for (let p = range.from; p <= range.to; p++) all.add(p);
    expect(() => allocateEndpoints(manifest, range, all)).toThrow(/no free loopback port/);
  });
});

describe('render', () => {
  const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  it('is deterministic and adds ports, restart, labels and network; source cannot override them', () => {
    const r1 = renderCompose({ manifest, compose, identity, endpoints, secretValues: null });
    const r2 = renderCompose({ manifest, compose, identity, endpoints, secretValues: null });
    expect(r1.yaml).toBe(r2.yaml);
    const doc = parseYaml(r1.yaml);
    expect(doc.name).toBe(identity.project);
    expect(doc.services.web.image).toBe(`example/demo@${DIGEST_A}`);
    expect(doc.services.web.restart).toBe('unless-stopped');
    expect(doc.services.web.ports).toEqual([{ target: 80, published: '18080', host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host' }]);
    expect(doc.services.web.labels[LABELS.instance]).toBe(identity.instanceId);
    expect(doc.services.web.labels[LABELS.installation]).toBe(identity.installationId);
    expect(doc.networks.default.name).toBe(`${identity.project}_default`);
    expect(doc.volumes).toBeUndefined();
  });
  it('renders different projects/networks for different instances', () => {
    const other = identityFor(identity.installationId, '22222222-2222-4222-8222-222222222222');
    const a = parseYaml(renderCompose({ manifest, compose, identity, endpoints, secretValues: null }).yaml);
    const b = parseYaml(renderCompose({ manifest, compose, identity: other, endpoints: [{ ...endpoints[0]!, hostPort: 18081 }], secretValues: null }).yaml);
    expect(a.name).not.toBe(b.name);
    expect(a.networks.default.name).not.toBe(b.networks.default.name);
  });
  it('escapes literal dollars so Compose does not interpolate them', () => {
    expect(escapeCompose('a$b $$ ${x}')).toBe('a$$b $$$$ $${x}');
    const c = validateComposeSource(y(MINIMAL_COMPOSE + '    environment:\n      PRICE: "5$ each"\n'));
    const r = renderCompose({ manifest, compose: c, identity, endpoints, secretValues: null });
    expect(r.yaml).toContain('5$$ each');
    expect(parseYaml(r.yaml).services.web.environment.PRICE).toBe('5$$ each');
  });
  it('renders secrets as placeholders in the prospective model and values in the final one, plus endpoint URLs and external volumes', () => {
    const m = validateManifestShape(
      y(
        MINIMAL_MANIFEST +
          `storage:\n  - {id: data, composeVolume: data, purpose: Data, retention: retain}\nsecrets:\n  - id: key\n    bytes: 32\n    encoding: hex\n    retention: retain\n    bindings:\n      - {service: web, environment: APP_KEY}\n      - {service: web, environment: APP_KEY_AGAIN}\nconfiguration:\n  - {service: web, environment: PUBLIC_URL, endpoint: web}\n`,
      ),
    );
    const c = validateComposeSource(y(`services:\n  web:\n    image: example/demo@${DIGEST_B}\n    volumes:\n      - {type: volume, source: data, target: /data}\nvolumes:\n  data: {}\n`));
    const prospective = parseYaml(renderCompose({ manifest: m, compose: c, identity, endpoints, secretValues: null }).yaml);
    expect(prospective.services.web.environment.APP_KEY).toBe('<<secret:key>>');
    expect(prospective.services.web.environment.PUBLIC_URL).toBe('http://localhost:18080/');
    expect(prospective.volumes.data).toEqual({ name: `${identity.project}_data`, external: true });
    const final = renderCompose({ manifest: m, compose: c, identity, endpoints, secretValues: { key: 'deadbeef' } });
    const doc = parseYaml(final.yaml);
    expect(doc.services.web.environment.APP_KEY).toBe('deadbeef');
    expect(doc.services.web.environment.APP_KEY_AGAIN).toBe('deadbeef');
    expect(final.generatedEnv['web']).toEqual(['APP_KEY', 'APP_KEY_AGAIN', 'PUBLIC_URL']);
    expect(() => renderCompose({ manifest: m, compose: c, identity, endpoints, secretValues: {} })).toThrow(/missing value/);
  });
});
