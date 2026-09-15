import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { identityFor } from '../../src/planner/identity.js';
import { formatUrl, renderCompose } from '../../src/planner/render.js';
import { checkHostDirectory, hostPathsOverlap, normalizeHostPath } from '../../src/storage/host-path.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { DIGEST_B, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');

describe('host paths ("bring your own folder")', () => {
  it('normalizes and rejects unsafe paths', () => {
    expect(normalizeHostPath('/mnt/photos/')).toBe('/mnt/photos');
    expect(normalizeHostPath('/mnt//photos/./2024')).toBe('/mnt/photos/2024');
    for (const bad of ['relative', '', '/', '/etc/passwd', '/var/lib/docker/volumes', '/var/lib/harbor/x', '/usr/local', '/mnt/../etc', '/proc']) {
      expect(() => normalizeHostPath(bad), bad).toThrow();
    }
  });
  it('requires an existing directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-hp-'));
    const dir = path.join(root, 'photos');
    mkdirSync(dir);
    writeFileSync(path.join(root, 'file'), 'x');
    expect(checkHostDirectory(dir + '/').path).toBe(dir);
    expect(() => checkHostDirectory(path.join(root, 'missing'))).toThrow(/does not exist/);
    expect(() => checkHostDirectory(path.join(root, 'file'))).toThrow(/not a directory/);
  });
  it('detects overlapping folders', () => {
    expect(hostPathsOverlap('/mnt/a', '/mnt/a')).toBe(true);
    expect(hostPathsOverlap('/mnt/a', '/mnt/a/b')).toBe(true);
    expect(hostPathsOverlap('/mnt/a/b', '/mnt/a')).toBe(true);
    expect(hostPathsOverlap('/mnt/a', '/mnt/ab')).toBe(false);
  });
});

describe('configuration formats', () => {
  it('derives each part of the endpoint URL', () => {
    const u = 'https://draw.example.com:8443/';
    expect(formatUrl(u, 'url')).toBe(u);
    expect(formatUrl(u, 'origin')).toBe('https://draw.example.com:8443');
    expect(formatUrl(u, 'authority')).toBe('draw.example.com:8443');
    expect(formatUrl(u, 'host')).toBe('draw.example.com');
    expect(formatUrl(u, 'scheme')).toBe('https');
    expect(formatUrl('http://localhost:18080/', 'origin')).toBe('http://localhost:18080');
  });
});

describe('render with external storage', () => {
  const identity = identityFor('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  const endpoints = [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }];
  const storageYaml = [
    'storage:',
    '  - {id: config, composeVolume: config, purpose: Config, retention: retain}',
    '  - id: media',
    '    composeVolume: media',
    '    purpose: Media library',
    '    retention: retain',
    '    external: {hint: A folder with your media, readOnly: true}',
    'configuration:',
    '  - {service: web, environment: PUBLIC_ORIGIN, endpoint: web, format: origin}',
    '  - {service: web, environment: PUBLIC_HOST, endpoint: web, format: host}',
    '',
  ].join('\n');
  const composeYaml = ['services:', '  web:', `    image: example/demo@${DIGEST_B}`, '    volumes:', '      - {type: volume, source: config, target: /config}', '      - {type: volume, source: media, target: /media}', 'volumes:', '  config: {}', '  media: {}', ''].join('\n');
  const m = validateManifestShape(y(MINIMAL_MANIFEST + storageYaml));
  const c = validateComposeSource(y(composeYaml));
  it('manifest accepts external claims and formats', () => {
    expect(m.storage![1]!.external).toEqual({ hint: 'A folder with your media', readOnly: true });
    expect(m.configuration![0]!.format).toBe('origin');
  });
  it('renders a bind mount for the chosen folder and no Docker volume for it', () => {
    const doc = parseYaml(renderCompose({ manifest: m, compose: c, identity, endpoints, secretValues: null, externalStorage: { media: { hostPath: '/mnt/media', readOnly: true } } }).yaml);
    expect(doc.services.web.volumes).toEqual([
      { type: 'volume', source: 'config', target: '/config' },
      { type: 'bind', source: '/mnt/media', target: '/media', read_only: true, bind: { create_host_path: false } },
    ]);
    expect(Object.keys(doc.volumes)).toEqual(['config']);
    expect(doc.services.web.environment.PUBLIC_ORIGIN).toBe('http://localhost:18080');
    expect(doc.services.web.environment.PUBLIC_HOST).toBe('localhost');
  });
  it('without a choice every claim is a managed volume', () => {
    const doc = parseYaml(renderCompose({ manifest: m, compose: c, identity, endpoints, secretValues: null }).yaml);
    expect(Object.keys(doc.volumes).sort()).toEqual(['config', 'media']);
    expect(doc.services.web.volumes[1]).toEqual({ type: 'volume', source: 'media', target: '/media' });
  });
});
