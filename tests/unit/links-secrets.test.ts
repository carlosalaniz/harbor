import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { identityFor } from '../../src/planner/identity.js';
import { renderCompose } from '../../src/planner/render.js';
import { linkAlias, linkNetworkLabels, linkNetworkName, linkValue } from '../../src/planner/links.js';
import { checkSubmittedSecrets, operatorValueProblem, plannedSecrets } from '../../src/planner/secrets.js';
import { HarborError } from '../../src/errors.js';
import { LABELS } from '../../src/naming.js';
import { DIGEST_A, DIGEST_B, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const COMPOSE = `services:
  web:
    image: example/demo@${DIGEST_A}
  worker:
    image: example/worker@${DIGEST_B}
`;
const withServices = MINIMAL_MANIFEST.replace('    web: application\n', '    web: application\n    worker: infrastructure\n');
const full = (extra: string) => {
  const manifest = validateManifestShape(y(withServices + extra));
  const compose = validateComposeSource(y(COMPOSE));
  validateManifestReferences(manifest, compose);
  return { manifest, compose };
};
function rejects(fn: () => unknown, re: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(HarborError.is(e)).toBe(true);
    expect(`${(e as Error).message} ${(e as HarborError).details.join(' ')}`).toMatch(re);
    return;
  }
  throw new Error('expected rejection');
}

const OPERATOR = `secrets:
  - id: api-token
    source: operator
    prompt: Access token from the other app's settings
    minLength: 8
    retention: retain
    bindings:
      - {service: web, environment: API_TOKEN}
  - id: smtp-pass
    source: operator
    prompt: SMTP password (leave empty to send no mail)
    optional: true
    retention: retain
    bindings:
      - {service: web, environment: SMTP_PASSWORD}
  - id: session-key
    bytes: 32
    encoding: hex
    retention: retain
    bindings:
      - {service: web, environment: SESSION_KEY}
`;
const LINKS = `links:
  - id: docs
    purpose: The documents app this gateway reads
    provider: {packages: [docsapp], endpoint: web}
    bindings:
      - {service: web, environment: DOCS_BASE_URL}
      - {service: web, environment: DOCS_HOST, format: host}
`;

describe('manifest: operator-provided secrets (decision 125)', () => {
  it('accepts source operator with a prompt next to generated secrets', () => {
    const { manifest } = full(OPERATOR);
    expect(manifest.secrets?.map((s) => s.source ?? 'generated')).toEqual(['operator', 'operator', 'generated']);
  });
  it('needs a prompt and refuses bytes/encoding on operator secrets', () => {
    rejects(() => full(`secrets:\n  - {id: t, source: operator, retention: retain, bindings: [{service: web, environment: T}]}\n`), /needs a prompt/);
    rejects(() => full(`secrets:\n  - {id: t, source: operator, prompt: Token, bytes: 32, encoding: hex, retention: retain, bindings: [{service: web, environment: T}]}\n`), /bytes and encoding apply to generated/);
  });
  it('keeps generated secrets strict: bytes/encoding required, no prompt', () => {
    rejects(() => full(`secrets:\n  - {id: t, retention: retain, bindings: [{service: web, environment: T}]}\n`), /needs bytes: 32 and encoding: hex/);
    rejects(() => full(`secrets:\n  - {id: t, bytes: 32, encoding: hex, prompt: Hi, retention: retain, bindings: [{service: web, environment: T}]}\n`), /apply to source: operator only/);
  });
  it('refuses minLength > maxLength', () => {
    rejects(() => full(`secrets:\n  - {id: t, source: operator, prompt: Token, minLength: 9, maxLength: 4, retention: retain, bindings: [{service: web, environment: T}]}\n`), /minLength is larger/);
  });
});

describe('manifest: links (decision 126)', () => {
  it('accepts a link with bindings and a provider hint', () => {
    const { manifest } = full(LINKS);
    expect(manifest.links?.[0]?.id).toBe('docs');
  });
  it('refuses duplicate ids, unknown services, env clashes and long ids', () => {
    rejects(() => full(LINKS + `  - id: docs\n    purpose: Again\n    bindings: [{service: web, environment: OTHER}]\n`), /link id docs is duplicated/);
    rejects(() => full(`links:\n  - {id: docs, purpose: P, bindings: [{service: nope, environment: X}]}\n`), /unknown service nope/);
    rejects(() => full(LINKS + `configuration:\n  - {service: web, environment: DOCS_BASE_URL, endpoint: web}\n`), /both target web.DOCS_BASE_URL/);
    rejects(() => full(`links:\n  - {id: ${'a'.repeat(31)}, purpose: P, bindings: [{service: web, environment: X}]}\n`), /pattern/);
    rejects(() => full(`links:\n  - {id: docs, purpose: P, bindings: [{service: web, environment: X, format: origin}]}\n`), /allowed/);
  });
});

describe('planner: links', () => {
  const consumer = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const provider = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  it('names networks per consumer + link and aliases per link', () => {
    expect(linkNetworkName(consumer, 'docs')).toBe(`${consumer.project}_link_docs`);
    expect(linkAlias('docs')).toBe('docs-link');
    expect(linkValue('docs-link', 3010)).toBe('http://docs-link:3010');
    expect(linkValue('docs-link', 3010, 'authority')).toBe('docs-link:3010');
    expect(linkValue('docs-link', 3010, 'host')).toBe('docs-link');
    expect(linkValue('docs-link', 3010, 'port')).toBe('3010');
    const labels = linkNetworkLabels(consumer, 'docs', provider.instanceId);
    expect(labels[LABELS.instance]).toBe(consumer.instanceId);
    expect(labels[LABELS.kind]).toBe('link');
    expect(labels[LABELS.link]).toBe('docs');
    expect(labels[LABELS.provider]).toBe(provider.instanceId);
  });
  it('consumer: only bound services join the external link network and get the address', () => {
    const { manifest, compose } = full(LINKS);
    const net = linkNetworkName(consumer, 'docs');
    const r = renderCompose({ manifest, compose, identity: consumer, endpoints, secretValues: null, consumerLinks: [{ id: 'docs', network: net, alias: 'docs-link', containerPort: 3010 }] });
    const doc = parseYaml(r.yaml);
    expect(doc.services.web.networks).toEqual({ default: {}, [net]: {} });
    expect(doc.services.worker.networks).toEqual(['default']);
    expect(doc.services.web.environment.DOCS_BASE_URL).toBe('http://docs-link:3010');
    expect(doc.services.web.environment.DOCS_HOST).toBe('docs-link');
    expect(doc.networks[net]).toEqual({ name: net, external: true });
    expect(r.generatedEnv['web']).toContain('DOCS_BASE_URL');
  });
  it('consumer without a provider: no network, no variable', () => {
    const { manifest, compose } = full(LINKS);
    const doc = parseYaml(renderCompose({ manifest, compose, identity: consumer, endpoints, secretValues: null }).yaml);
    expect(doc.services.web.networks).toEqual(['default']);
    expect(doc.services.web.environment?.DOCS_BASE_URL).toBeUndefined();
    expect(Object.keys(doc.networks)).toEqual(['default']);
  });
  it('provider: only the endpoint service joins, with the alias; infrastructure never does', () => {
    const manifest = validateManifestShape(y(withServices));
    const compose = validateComposeSource(y(COMPOSE));
    const net = linkNetworkName(consumer, 'docs');
    const doc = parseYaml(renderCompose({ manifest, compose, identity: provider, endpoints, secretValues: null, providerLinks: [{ network: net, service: 'web', alias: 'docs-link' }] }).yaml);
    expect(doc.services.web.networks).toEqual({ default: {}, [net]: { aliases: ['docs-link'] } });
    expect(doc.services.worker.networks).toEqual(['default']);
    expect(doc.networks[net]).toEqual({ name: net, external: true });
  });
});

describe('planner: operator secrets', () => {
  const { manifest, compose } = full(OPERATOR);
  const identity = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  it('plans ask for operator values only, with their prompt and limits', () => {
    const planned = plannedSecrets(manifest);
    expect(planned).toEqual([
      { id: 'api-token', source: 'operator', prompt: "Access token from the other app's settings", optional: false, maxLength: 4096, minLength: 8, ask: 'required' },
      { id: 'smtp-pass', source: 'operator', prompt: 'SMTP password (leave empty to send no mail)', optional: true, maxLength: 4096, ask: 'optional' },
      { id: 'session-key' },
    ]);
    // update: existing ones are kept (no ask)
    expect(plannedSecrets(manifest, new Set(['api-token', 'smtp-pass', 'session-key'])).some((s) => s.ask)).toBe(false);
  });
  it('checks a submission without echoing the value', () => {
    const planned = plannedSecrets(manifest);
    expect(checkSubmittedSecrets(planned, { 'api-token': 'tok-FIXTURE-123' })).toEqual({ store: { 'api-token': 'tok-FIXTURE-123' }, clear: [] });
    rejects(() => checkSubmittedSecrets(planned, {}), /is needed \(secret api-token\)/);
    rejects(() => checkSubmittedSecrets(planned, { 'api-token': 'short' }), /at least 8 characters/);
    rejects(() => checkSubmittedSecrets(planned, { 'api-token': 'two\nlines-FIXTURE' }), /single line/);
    rejects(() => checkSubmittedSecrets(planned, { 'api-token': 'tok-FIXTURE-123', 'session-key': 'x' }), /does not ask for a value for secret session-key/);
    try {
      checkSubmittedSecrets(planned, { 'api-token': 'sh0rt' });
    } catch (e) {
      expect(JSON.stringify((e as HarborError).toBody())).not.toContain('sh0rt');
    }
    expect(operatorValueProblem({ id: 'x', maxLength: 3 }, 'abcd')).toMatch(/at most 3/);
    // an optional one may be cleared with an empty value
    expect(checkSubmittedSecrets(planned, { 'api-token': 'tok-FIXTURE-123', 'smtp-pass': '' }).clear).toEqual(['smtp-pass']);
  });
  it('renders operator values like generated ones and leaves an unset optional variable out', () => {
    const doc = parseYaml(renderCompose({ manifest, compose, identity, endpoints, secretValues: { 'api-token': 'tok-FIXTURE-$1', 'session-key': 'a'.repeat(64) } }).yaml);
    expect(doc.services.web.environment.API_TOKEN).toBe('tok-FIXTURE-$$1'); // Compose-escaped
    expect(doc.services.web.environment.SESSION_KEY).toBe('a'.repeat(64));
    expect(doc.services.web.environment.SMTP_PASSWORD).toBeUndefined();
    // the prospective model (plan time) only has placeholders
    expect(parseYaml(renderCompose({ manifest, compose, identity, endpoints, secretValues: null }).yaml).services.web.environment.API_TOKEN).toBe('<<secret:api-token>>');
  });
});
