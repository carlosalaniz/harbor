// Decision 201: the browser-sandbox permission and the seccomp profile Harbor ships for it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { identityFor } from '../../src/planner/identity.js';
import { newPermissions, PERMISSION_LABEL, permissionsOf, untrustedPermissions } from '../../src/planner/permissions.js';
import { renderCompose } from '../../src/planner/render.js';
import { BROWSER_SANDBOX_PROFILE, BROWSER_SANDBOX_SYSCALLS, BROWSER_SANDBOX_UPSTREAM_SHA256 } from '../../src/planner/seccomp.js';
import { HarborError } from '../../src/errors.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

function expectCode(fn: () => unknown, code: string, re: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(HarborError.is(e) && (e as HarborError).code).toBe(code);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error('expected rejection');
}
const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'test.yaml');
const withPerms = (perms: string) => validateManifestShape(y(`${MINIMAL_MANIFEST}permissions:\n  web: [${perms}]\n`));
const render = (perms: string, seccompProfile?: string) => {
  const manifest = withPerms(perms);
  const compose = validateComposeSource(y(MINIMAL_COMPOSE));
  validateManifestReferences(manifest, compose);
  const id = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555');
  const out = renderCompose({ manifest, compose, identity: id, endpoints: [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }], secretValues: null, ...(seccompProfile ? { seccompProfile } : {}) });
  return parseYaml(out.yaml).services.web as Record<string, unknown>;
};

describe('package format: browser-sandbox (decision 201)', () => {
  it('is accepted next to every other permission, last in the stable order', () => {
    const m = withPerms('browser-sandbox, net-admin, tun, ip-forwarding, gpu, privileged, binder');
    expect(permissionsOf(m).map((p) => p.permission)).toEqual(['net-admin', 'tun', 'ip-forwarding', 'gpu', 'privileged', 'binder', 'browser-sandbox']);
  });

  it('any source may ask for it (it is narrower than privileged), and the review says what it allows', () => {
    expect(untrustedPermissions(withPerms('browser-sandbox, net-admin'), 'local', false)).toEqual([]);
    expect(PERMISSION_LABEL['browser-sandbox']).toMatch(/browser's own sandbox/);
    expect(PERMISSION_LABEL['browser-sandbox']).toMatch(/clone, unshare, setns and chroot/);
  });

  it('an update that adds it needs a person to accept it, like any new permission', () => {
    expect(newPermissions(withPerms('net-admin'), withPerms('net-admin, browser-sandbox'))).toEqual([{ service: 'web', permission: 'browser-sandbox' }]);
  });

  it('stays refused as a compose.yaml key: only the permission renders security_opt', () => {
    expectCode(() => validateComposeSource(y('services:\n  web:\n    image: nginx:1.27-alpine\n    security_opt: ["seccomp=unconfined"]\n')), 'UNSUPPORTED_CAPABILITY', /security_opt/);
  });
});

describe('planner: browser-sandbox renders the shipped seccomp profile (decision 201)', () => {
  it('renders exactly one security_opt, the profile file, and nothing else', () => {
    const web = render('browser-sandbox');
    expect(web['security_opt']).toEqual([`seccomp=${BROWSER_SANDBOX_PROFILE}`]);
    expect(web['cap_add']).toBeUndefined();
    expect(web['privileged']).toBeUndefined();
    // AppArmor stays Docker's default: unconfined breaks the sandbox on Ubuntu 24.04 (see src/planner/seccomp.ts)
    expect(JSON.stringify(web)).not.toMatch(/apparmor/);
  });

  it('a service without the permission gets no security_opt', () => {
    expect(render('net-admin')['security_opt']).toBeUndefined();
  });

  it('takes another profile path when given one (tests, other layouts)', () => {
    expect(render('browser-sandbox', '/elsewhere/p.json')['security_opt']).toEqual(['seccomp=/elsewhere/p.json']);
  });
});

describe('the shipped profile is Docker\'s default plus exactly one rule (decision 201)', () => {
  const profile = JSON.parse(readFileSync(BROWSER_SANDBOX_PROFILE, 'utf8')) as { defaultAction: string; syscalls: { names: string[]; action: string; args?: unknown; includes?: unknown; excludes?: unknown }[] };

  it('lives where the release folder puts it', () => {
    expect(existsSync(BROWSER_SANDBOX_PROFILE)).toBe(true);
    expect(BROWSER_SANDBOX_PROFILE).toMatch(/[/\\]seccomp[/\\]browser-sandbox\.json$/);
  });

  it('denies by default', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it('its last rule allows only the namespace calls and chroot, with no conditions', () => {
    const last = profile.syscalls.at(-1)!;
    expect(last.names).toEqual([...BROWSER_SANDBOX_SYSCALLS]);
    expect(last.action).toBe('SCMP_ACT_ALLOW');
    expect(last.args ?? last.includes ?? last.excludes).toBeUndefined();
  });

  it('everything before it is byte-for-byte the Docker release it names', () => {
    const upstream = { ...profile, syscalls: profile.syscalls.slice(0, -1) };
    expect(createHash('sha256').update(JSON.stringify(upstream)).digest('hex')).toBe(BROWSER_SANDBOX_UPSTREAM_SHA256);
  });
});
