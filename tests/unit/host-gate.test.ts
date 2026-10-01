import { describe, expect, it } from 'vitest';
import { assertSupportedHost, distroSupport, type HostFacts } from '../../src/bootstrap/host.js';
import { assertRequiredTools, REQUIRED_TOOLS } from '../../src/bootstrap/exec.js';
import { HarborError } from '../../src/errors.js';

function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    osId: 'ubuntu',
    versionId: '24.04',
    osIdLike: '',
    osCodename: 'noble',
    prettyName: 'Ubuntu 24.04 LTS',
    arch: 'x64',
    systemd: true,
    root: true,
    docker: { binary: '/usr/bin/docker', version: '28.0', composeVersion: '2.0', daemonActive: true, socket: '/var/run/docker.sock', aptRepo: { family: 'ubuntu', codename: 'noble', keyUrl: 'https://download.docker.com/linux/ubuntu/gpg' } },
    existing: {
      optDir: 'harbor', optReleaseVersion: '0.10.0', config: true, state: true, unit: 'harbor', user: true,
      cockpit: { installed: false, socketActive: false },
      portainer: { containerPresent: false },
      tailscale: { installed: false, backendState: null, dnsName: null },
      caddy: { installed: false, adminReachable: false, harborConfig: false },
    },
    ...over,
  };
}

describe('distroSupport', () => {
  it('accepts Ubuntu 24.04 and Debian 12/13 as supported', () => {
    expect(distroSupport('ubuntu', '24.04', '')).toBe('supported');
    expect(distroSupport('ubuntu', '24.04.3', '')).toBe('supported');
    expect(distroSupport('debian', '12', 'debian')).toBe('supported');
    expect(distroSupport('debian', '13.1', '')).toBe('supported');
  });

  it('treats Debian/Ubuntu derivatives (ID_LIKE) as derived', () => {
    expect(distroSupport('linuxmint', '22', 'ubuntu debian')).toBe('derived');
    expect(distroSupport('pop', '24.04', 'ubuntu')).toBe('derived');
    expect(distroSupport('raspbian', '12', 'debian')).toBe('derived');
    expect(distroSupport('proxmox', '9', 'debian')).toBe('derived');
  });

  it('rejects other distros and out-of-window releases as unknown', () => {
    expect(distroSupport('ubuntu', '22.04', '')).toBe('unknown');
    expect(distroSupport('debian', '11', '')).toBe('unknown');
    expect(distroSupport('fedora', '41', 'fedora')).toBe('unknown');
    expect(distroSupport('arch', '', '')).toBe('unknown');
  });
});

describe('assertSupportedHost', () => {
  it('passes supported distros without force', () => {
    expect(() => assertSupportedHost(facts())).not.toThrow();
    expect(() => assertSupportedHost(facts({ osId: 'debian', versionId: '12', osIdLike: '', prettyName: 'Debian GNU/Linux 12 (bookworm)' }))).not.toThrow();
  });

  it('refuses derivatives without force and names the escape hatch', () => {
    let err: unknown;
    try {
      assertSupportedHost(facts({ osId: 'linuxmint', versionId: '22', osIdLike: 'ubuntu debian', prettyName: 'Linux Mint 22' }));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HarborError);
    expect((err as HarborError).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((err as HarborError).message).toContain('Linux Mint 22');
    expect((err as HarborError).nextAction).toContain('--force');
  });

  it('lets a derivative through with force', () => {
    expect(() => assertSupportedHost(facts({ osId: 'raspbian', versionId: '12', osIdLike: 'debian', prettyName: 'Raspberry Pi OS 12' }), { force: true })).not.toThrow();
  });

  it('never force-accepts an unknown distro', () => {
    for (const force of [false, true]) {
      expect(() => assertSupportedHost(facts({ osId: 'fedora', versionId: '41', osIdLike: 'fedora', prettyName: 'Fedora Linux 41' }), { force })).toThrowError(/unsupported OS Fedora Linux 41/);
    }
  });

  it('never force-accepts hard failures (root, arch, systemd)', () => {
    expect(() => assertSupportedHost(facts({ root: false }), { force: true })).toThrowError(/run as root/);
    expect(() => assertSupportedHost(facts({ arch: 'arm64' }), { force: true })).toThrowError(/x86-64/);
    expect(() => assertSupportedHost(facts({ systemd: false }), { force: true })).toThrowError(/systemd/);
  });
});

describe('assertRequiredTools', () => {
  it('passes when every required tool resolves', async () => {
    await expect(assertRequiredTools(async () => '/usr/bin/x')).resolves.toBeUndefined();
  });

  it('names the missing tools and their packages', async () => {
    let err: unknown;
    try {
      await assertRequiredTools(async (name) => (name === 'usermod' || name === 'gpg' ? null : '/usr/bin/x'));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HarborError);
    expect((err as HarborError).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((err as HarborError).message).toContain('usermod (package passwd)');
    expect((err as HarborError).message).toContain('gpg (package gpg)');
    expect((err as HarborError).message).not.toContain('systemctl (package');
  });

  it('covers the account tools bootstrap calls directly', () => {
    const names = REQUIRED_TOOLS.map(([n]) => n);
    for (const n of ['useradd', 'usermod', 'groupadd', 'systemctl', 'apt-get', 'dpkg-query']) expect(names).toContain(n);
  });
});
