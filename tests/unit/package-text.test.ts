import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { identityFor } from '../../src/planner/identity.js';
import { renderCompose } from '../../src/planner/render.js';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { validatePackageFolder } from '../../src/packages/validate-folder.js';
import { DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const compose = validateComposeSource(y(MINIMAL_COMPOSE));
const withSecret = (extra: string, binding = '{service: web, environment: DATABASE_URL, template: "postgres://app:{{value}}@db:5432/app"}') =>
  `${MINIMAL_MANIFEST}secrets:\n  - id: dbpass\n    bytes: 32\n    encoding: hex\n    retention: retain\n${extra}    bindings:\n      - ${binding}\n`;
const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
const identity = identityFor('inst', '11111111-1111-4111-8111-111111111111');

describe('package text and secrets (decisions 137–139)', () => {
  it('accepts < and > in text shown to the operator (rendered as text, never HTML)', () => {
    const m = validateManifestShape(y(MINIMAL_MANIFEST + 'setup:\n  endpoint: web\n  instructions: "Send Authorization: Bearer <token> to https://<domain>/mcp"\n'));
    expect(m.setup?.instructions).toContain('<token>');
    expect(() => validateManifestShape(y(MINIMAL_MANIFEST + 'setup:\n  endpoint: web\n  instructions: "bell \\u0007"\n'))).toThrow();
  });

  it('a secret template puts the value inside an environment literal, url-encoded on request', () => {
    const m = validateManifestShape(y(withSecret('')));
    validateManifestReferences(m, compose, 'x');
    const out = parseYaml(renderCompose({ manifest: m, compose, identity, endpoints, secretValues: { dbpass: 'a1b2' } }).yaml);
    expect(out.services.web.environment.DATABASE_URL).toBe('postgres://app:a1b2@db:5432/app');
    const enc = validateManifestShape(y(withSecret('', '{service: web, environment: DATABASE_URL, template: "x://u:{{value}}@h", encode: url}')));
    const out2 = parseYaml(renderCompose({ manifest: enc, compose, identity, endpoints, secretValues: { dbpass: 'p@ss/w$rd' } }).yaml);
    expect(out2.services.web.environment.DATABASE_URL).toBe('x://u:p%40ss%2Fw%24rd@h');
    // the prospective model never carries a value
    expect(parseYaml(renderCompose({ manifest: m, compose, identity, endpoints, secretValues: null }).yaml).services.web.environment.DATABASE_URL).toBe('postgres://app:<<secret:dbpass>>@db:5432/app');
  });

  it('refuses a template without exactly one {{value}}, with $, or encode without a template', () => {
    const refs = (src: string) => validateManifestReferences(validateManifestShape(y(src)), compose, 'x');
    expect(() => refs(withSecret('', '{service: web, environment: URL, template: "no slot here"}'))).toThrow(/exactly once/);
    expect(() => refs(withSecret('', '{service: web, environment: URL, template: "{{value}}:{{value}}"}'))).toThrow(/exactly once/);
    expect(() => refs(withSecret('', '{service: web, environment: URL, encode: url}'))).toThrow(/encode applies to a template only/);
    expect(() => validateManifestShape(y(withSecret('', '{service: web, environment: URL, template: "a${HOME}{{value}}"}')))).toThrow();
  });

  it('showOnce is for generated secrets only', () => {
    const m = validateManifestShape(y(withSecret('    showOnce: JWT secret for the document server\n')));
    expect(m.secrets?.[0]?.showOnce).toBe('JWT secret for the document server');
    const op = `${MINIMAL_MANIFEST}secrets:\n  - id: tok\n    source: operator\n    prompt: Token\n    showOnce: Token\n    retention: retain\n    bindings:\n      - {service: web, environment: TOK}\n`;
    expect(() => validateManifestReferences(validateManifestShape(y(op)), compose, 'x')).toThrow(/showOnce applies to generated secrets only/);
  });
});

describe('compose command', () => {
  it('takes an empty argument (a cache without persistence: redis-server --save "")', () => {
    const c = validateComposeSource(y(`services:\n  web:\n    image: redis@${DIGEST_A}\n    command: [redis-server, --save, "", --appendonly, "no"]\n`));
    expect(c.services['web']!.command).toEqual(['redis-server', '--save', '', '--appendonly', 'no']);
  });
});

describe('harbor packages validate (decision 140)', () => {
  it('passes a bundled package and says what the import will still do', () => {
    const r = validatePackageFolder(path.resolve(import.meta.dirname, '../../catalog/excalidraw'));
    expect(r.id).toBe('excalidraw');
    expect(r.notes.some((n) => /release\.json is replaced/.test(n))).toBe(true);
  });

  it('finds the harbor/ folder of a repository, checks build contexts, and reports the first problem', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'harbor-validate-'));
    mkdirSync(path.join(repo, 'harbor'));
    mkdirSync(path.join(repo, 'app'));
    writeFileSync(path.join(repo, 'harbor', 'manifest.yaml'), MINIMAL_MANIFEST);
    writeFileSync(path.join(repo, 'harbor', 'compose.yaml'), 'services:\n  web:\n    build:\n      context: ../app\n');
    expect(() => validatePackageFolder(repo)).toThrow(/no Dockerfile in build context/);
    writeFileSync(path.join(repo, 'app', 'Dockerfile'), 'FROM scratch\n');
    const r = validatePackageFolder(repo);
    expect(r.dir).toBe(path.join(repo, 'harbor'));
    expect(r.notes.some((n) => /built from source/.test(n))).toBe(true);
    // a zip-style folder may not build
    const flat = mkdtempSync(path.join(tmpdir(), 'harbor-validate-flat-'));
    cpSync(path.join(repo, 'harbor'), flat, { recursive: true });
    expect(() => validatePackageFolder(flat)).toThrow(/only git-sourced packages/);
    writeFileSync(path.join(flat, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n');
    expect(validatePackageFolder(flat).notes).toContain('web: nginx:1.27 is pinned by digest when Harbor imports the package');
    writeFileSync(path.join(flat, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1.27\n    ports: ["80:80"]\n');
    expect(() => validatePackageFolder(flat)).toThrow();
  });
});
