import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { renderCompose } from '../../src/planner/render.js';
import { allocateEndpoints } from '../../src/planner/ports.js';
import { identityFor } from '../../src/planner/identity.js';
import { validateManifestShape } from '../../src/packages/manifest.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { appliesLive, effectiveResources, nextChoice, packageResources, parseMemLimit, priorityOf, readChoice, renderedResourceKeys, resourceChangeLines } from '../../src/planner/resources.js';
import { DIGEST_A, MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'x');
const host = { cpus: 8, memoryMiB: 16384 };
const svc = (extra: string) => `services:\n  web:\n    image: example/demo@${DIGEST_A}\n${extra}`;

describe('decision 205: package-declared CPU and memory limits', () => {
  it('accepts cpu_shares up to normal, cpus and mem_limit within bounds', () => {
    const c = validateComposeSource(y(svc('    cpu_shares: 256\n    cpus: 2.5\n    mem_limit: 1g\n')));
    expect(c.services['web']).toMatchObject({ cpu_shares: 256, cpus: 2.5, mem_limit: '1g' });
  });

  it('refuses a package that raises its own priority, and values that cannot work', () => {
    expect(() => validateComposeSource(y(svc('    cpu_shares: 2048\n')))).toThrow(/cpu_shares 2048 is outside 2\.\.1024/);
    expect(() => validateComposeSource(y(svc('    cpu_shares: 1\n')))).toThrow(/cpu_shares 1 is outside/);
    expect(() => validateComposeSource(y(svc('    cpus: 0\n')))).toThrow(/cpus 0 is outside/);
    expect(() => validateComposeSource(y(svc('    mem_limit: 8m\n')))).toThrow(/mem_limit 8m is outside 32m/);
    expect(() => validateComposeSource(y(svc('    mem_limit: lots\n')))).toThrow(/not a size like 512m or 2g/);
  });

  it('keeps the other resource keys refused', () => {
    for (const k of ['cpuset: "0-1"', 'cpu_quota: 50000', 'memswap_limit: 1g', 'mem_reservation: 1g', 'pids_limit: 100', 'deploy: {}']) {
      expect(() => validateComposeSource(y(svc(`    ${k}\n`))), k).toThrow(/unsupported key/);
    }
  });

  it('reads Compose sizes', () => {
    expect(parseMemLimit('512m')).toBe(512);
    expect(parseMemLimit('2g')).toBe(2048);
    expect(parseMemLimit('1.5G')).toBe(1536);
    expect(parseMemLimit('2048k')).toBe(2);
    expect(parseMemLimit('512mb')).toBe(512);
    expect(parseMemLimit('512')).toBeNull();
  });
});

describe('decision 205: effective limits', () => {
  it('renders nothing for normal priority: an explicit 1024 lowers an app on runc before 1.3', () => {
    expect(packageResources({ cpu_shares: 1024 }, host)).toEqual({ cpuShares: null, cpus: null, memoryMiB: null });
    expect(renderedResourceKeys(effectiveResources({}, {}, host))).toEqual({});
    expect(renderedResourceKeys(effectiveResources({ cpu_shares: 256 }, { priority: 'normal' }, host))).toEqual({});
  });

  it('drops a package cap at or above this machine', () => {
    expect(packageResources({ cpus: 16, mem_limit: '32g' }, host)).toEqual({ cpuShares: null, cpus: null, memoryMiB: null });
    expect(packageResources({ cpus: 2, mem_limit: '2g' }, host)).toEqual({ cpuShares: null, cpus: 2, memoryMiB: 2048 });
  });

  it('puts the operator choice over the package; null removes a limit, absent follows the package', () => {
    const pkg = { cpu_shares: 512, cpus: 2, mem_limit: '2g' };
    expect(effectiveResources(pkg, {}, host)).toEqual({ cpuShares: 512, cpus: 2, memoryMiB: 2048 });
    expect(effectiveResources(pkg, { priority: 'background', cpus: null, memoryMiB: 4096 }, host)).toEqual({ cpuShares: 128, cpus: null, memoryMiB: 4096 });
    expect(renderedResourceKeys(effectiveResources(pkg, { priority: 'low', cpus: 1.5, memoryMiB: 512 }, host))).toEqual({ cpu_shares: 512, cpus: 1.5, mem_limit: '512m', memswap_limit: '512m' });
  });

  it('names a package priority', () => {
    expect([priorityOf(null), priorityOf(1024), priorityOf(700), priorityOf(512), priorityOf(128), priorityOf(2)]).toEqual(['normal', 'normal', 'low', 'low', 'background', 'background']);
  });

  it('applies live only when no value is removed', () => {
    const none = { cpuShares: null, cpus: null, memoryMiB: null };
    expect(appliesLive(none, { cpuShares: 128, cpus: 2, memoryMiB: 512 })).toBe(true);
    expect(appliesLive({ cpuShares: 512, cpus: 4, memoryMiB: 2048 }, { cpuShares: 128, cpus: 2, memoryMiB: 4096 })).toBe(true);
    expect(appliesLive({ cpuShares: 128, cpus: null, memoryMiB: null }, none)).toBe(false); // back to normal
    expect(appliesLive({ cpuShares: null, cpus: 2, memoryMiB: null }, none)).toBe(false);
    expect(appliesLive({ cpuShares: null, cpus: null, memoryMiB: 512 }, none)).toBe(false);
  });

  it('checks a change against this machine', () => {
    expect(nextChoice({}, { priority: 'low', cpus: 2, memoryMiB: 1024 }, host)).toEqual({ priority: 'low', cpus: 2, memoryMiB: 1024 });
    expect(nextChoice({ priority: 'low', cpus: 2 }, { priority: 'default', cpus: null }, host)).toEqual({ cpus: null });
    expect(() => nextChoice({}, { cpus: 9 }, host)).toThrow(/between 0\.1 and 8 cores/);
    expect(() => nextChoice({}, { memoryMiB: 32 }, host)).toThrow(/between 64 and 16384/);
    expect(() => nextChoice({}, { memoryMiB: 20000 }, host)).toThrow(/between 64 and 16384/);
  });

  it('reads a stored choice defensively', () => {
    expect(readChoice({ priority: 'low', cpus: 2, memoryMiB: null })).toEqual({ priority: 'low', cpus: 2, memoryMiB: null });
    expect(readChoice({ priority: 'urgent', cpus: -1, memoryMiB: 1.5 })).toEqual({});
    expect(readChoice('nonsense')).toEqual({});
  });

  it('says how the change reaches the containers', () => {
    const none = { cpuShares: null, cpus: null, memoryMiB: null };
    expect(resourceChangeLines('kt', none, { cpuShares: 128, cpus: null, memoryMiB: null }, 'live')).toEqual([expect.stringMatching(/^CPU priority: normal → background/), 'Applied to the running containers at once (no restart)']);
    expect(resourceChangeLines('kt', { cpuShares: null, cpus: 2, memoryMiB: null }, none, 'restart').at(-1)).toMatch(/restarts once/);
    expect(resourceChangeLines('kt', none, none, 'live')).toEqual([expect.stringMatching(/keeps the same limits/)]);
  });
});

describe('decision 205: render', () => {
  const manifest = validateManifestShape(y(MINIMAL_MANIFEST));
  const identity = identityFor('inst', '11111111-1111-4111-8111-111111111111');
  const endpoints = allocateEndpoints(manifest, { from: 18080, to: 18999 }, new Set());
  const services = (yaml: string) => (parseYaml(yaml) as { services: Record<string, Record<string, unknown>> }).services;

  it('leaves an app that uses none of this exactly as before', () => {
    const r = renderCompose({ manifest, compose: validateComposeSource(y(MINIMAL_COMPOSE)), identity, endpoints, secretValues: null, host });
    for (const k of ['cpu_shares', 'cpus', 'mem_limit', 'memswap_limit']) expect(services(r.yaml)['web']).not.toHaveProperty(k);
  });

  it('renders the package values with the operator choice on top, clamped to the host', () => {
    const compose = validateComposeSource(y(svc('    cpu_shares: 512\n    cpus: 12\n    mem_limit: 1g\n')));
    expect(services(renderCompose({ manifest, compose, identity, endpoints, secretValues: null, host }).yaml)['web']).toMatchObject({ cpu_shares: 512, mem_limit: '1024m', memswap_limit: '1024m' });
    expect(services(renderCompose({ manifest, compose, identity, endpoints, secretValues: null, host }).yaml)['web']).not.toHaveProperty('cpus');
    const chosen = services(renderCompose({ manifest, compose, identity, endpoints, secretValues: null, host, resources: { priority: 'background', cpus: 2, memoryMiB: null } }).yaml)['web']!;
    expect(chosen).toMatchObject({ cpu_shares: 128, cpus: 2 });
    expect(chosen).not.toHaveProperty('mem_limit');
  });
});
