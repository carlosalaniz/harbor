// Decision 193: privileged + binder (trusted-only permissions), the binder read model and the root step's pieces.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { kernelStepUnit, polkitPowerRule } from '../../src/bootstrap/systemd.js';
import { needsReview, HarborError } from '../../src/errors.js';
import { validateComposeSource } from '../../src/packages/compose-source.js';
import { validateManifestReferences, validateManifestShape } from '../../src/packages/manifest.js';
import { parseRestrictedYaml } from '../../src/packages/yaml.js';
import { identityFor } from '../../src/planner/identity.js';
import { needsBinder, PERMISSION_LABEL, permissionsOf, untrustedPermissions } from '../../src/planner/permissions.js';
import { renderCompose } from '../../src/planner/render.js';
import { BINDER, binderInstallHint, binderLoadConf, binderOptionsConf, FakeKernelProvider, kernelUnit, parseKernelModule, readBinderState } from '../../src/system/kernel.js';
import { MINIMAL_COMPOSE, MINIMAL_MANIFEST } from './helpers.js';

const y = (s: string) => parseRestrictedYaml(Buffer.from(s), 'test.yaml');
const withPerms = (perms: string) => validateManifestShape(y(`${MINIMAL_MANIFEST}permissions:\n  web: [${perms}]\n`));

describe('package format: privileged and binder (decision 193)', () => {
  it('accepts both next to the older permissions, in a stable order', () => {
    const m = withPerms('binder, privileged, gpu, tun');
    expect(permissionsOf(m).map((p) => p.permission)).toEqual(['tun', 'gpu', 'privileged', 'binder']);
    expect(needsBinder(m)).toBe(true);
    expect(needsBinder(withPerms('privileged'))).toBe(false);
    expect(() => withPerms('root')).toThrow();
  });

  it('says what privileged means in plain words', () => {
    expect(PERMISSION_LABEL.privileged).toMatch(/^Full control of this machine/);
    expect(PERMISSION_LABEL.binder).toMatch(/binder/);
  });

  it('renders privileged: true and nothing for binder (the root step loads it)', () => {
    const manifest = withPerms('privileged, binder');
    const compose = validateComposeSource(y(MINIMAL_COMPOSE));
    validateManifestReferences(manifest, compose);
    const id = identityFor('0a0a0a0a-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444');
    const doc = parseYaml(renderCompose({ manifest, compose, identity: id, endpoints: [{ id: 'web', service: 'web', containerPort: 80, hostPort: 18080 }], secretValues: null }).yaml);
    expect(doc.services.web.privileged).toBe(true);
    expect(doc.services.web.cap_add).toBeUndefined();
    expect(doc.services.web.devices).toBeUndefined();
  });

  it('a package compose still may not say privileged itself', () => {
    expect(() => validateComposeSource(y('services:\n  web:\n    image: nginx:1.27-alpine\n    privileged: true\n'))).toThrow(/privileged/);
  });
});

describe('trusted sources (decision 193)', () => {
  const m = withPerms('net-admin, privileged, binder');
  it('the official catalog gets everything; an upload or git source only without the trusted-only ones', () => {
    expect(untrustedPermissions(m, 'bundled', false)).toEqual([]);
    expect(untrustedPermissions(m, 'local', false).map((p) => p.permission)).toEqual(['privileged', 'binder']);
    expect(untrustedPermissions(withPerms('net-admin, tun'), 'local', false)).toEqual([]);
  });
  it('developer mode lets any source ask', () => {
    expect(untrustedPermissions(m, 'local', true)).toEqual([]);
  });
  it('a refusal is something only a person can resolve (a queued action waits for review)', () => {
    expect(needsReview(new HarborError('UNTRUSTED_SOURCE', 'x'))).toBe(true);
    expect(new HarborError('UNTRUSTED_SOURCE', 'x').httpStatus).toBe(403);
    expect(new HarborError('KERNEL_MODULE_MISSING', 'x').exitCode).toBe(4);
  });
});

describe('binder driver (decision 193)', () => {
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-binder-'));
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), text);
    }
    return root;
  };
  const REL = '6.8.0-147-generic';
  it('loaded when binderfs is registered or the module is in /sys', () => {
    expect(readBinderState(tree({ '/proc/filesystems': 'nodev\tsysfs\nnodev\tbinder\n' }), REL)).toBe('loaded');
    expect(readBinderState(tree({ '/proc/filesystems': 'nodev\tsysfs\n', '/sys/module/binder_linux/refcnt': '0\n' }), REL)).toBe('loaded');
  });
  it('available when the running kernel ships the module (Ubuntu: linux-modules-extra, zstd)', () => {
    const dep = `kernel/drivers/android/binder_linux.ko.zst:\nkernel/fs/fuse/fuse.ko.zst:\n`;
    expect(readBinderState(tree({ '/proc/filesystems': 'nodev\tsysfs\n', [`/lib/modules/${REL}/modules.dep`]: dep }), REL)).toBe('available');
  });
  it('missing otherwise (another kernel, or no extra modules)', () => {
    expect(readBinderState(tree({ '/proc/filesystems': 'nodev\tsysfs\n', [`/lib/modules/6.8.0-1-other/modules.dep`]: 'kernel/drivers/android/binder_linux.ko.zst:\n' }), REL)).toBe('missing');
    expect(readBinderState(tree({}), REL)).toBe('missing');
    expect(binderInstallHint(REL)).toBe('sudo apt install linux-modules-extra-6.8.0-147-generic');
  });
  it('the root step writes Harbor-marked boot files with the three binder devices', () => {
    expect(binderLoadConf()).toMatch(/^# Harbor:.*\nbinder_linux\n$/);
    expect(binderOptionsConf()).toContain('options binder_linux devices=binder,hwbinder,vndbinder');
    expect(BINDER.loadFile).toBe('/etc/modules-load.d/harbor-binder.conf');
    expect(BINDER.optionsFile).toBe('/etc/modprobe.d/harbor-binder.conf');
  });
  it('one unit template per driver, and the harbor user may start only that template', () => {
    expect(kernelStepUnit()).toContain('ExecStart=/opt/harbor/bin/harbor kernel-step %i');
    expect(kernelUnit('binder')).toBe('harbor-kernel@binder.service');
    expect(() => parseKernelModule('binder;reboot')).toThrow();
    expect(() => parseKernelModule('nvidia')).toThrow();
    expect(polkitPowerRule()).toContain('indexOf("harbor-kernel@") === 0');
  });
  it('the fake loads once and refuses a kernel without it', async () => {
    const k = new FakeKernelProvider();
    await k.loadBinder();
    await k.loadBinder();
    expect(k.loads).toBe(1);
    await expect(new FakeKernelProvider('missing').loadBinder()).rejects.toMatchObject({ code: 'KERNEL_MODULE_MISSING' });
  });
});
