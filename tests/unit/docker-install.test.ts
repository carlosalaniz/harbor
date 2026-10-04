import { describe, expect, it } from 'vitest';
import { dockerAptRepo, dockerInstallPreview } from '../../src/bootstrap/docker-install.js';

describe('dockerAptRepo', () => {
  it('uses the ubuntu repo with the release codename on Ubuntu', () => {
    const repo = dockerAptRepo({ ID: 'ubuntu', VERSION_ID: '24.04', VERSION_CODENAME: 'noble' });
    expect(repo.family).toBe('ubuntu');
    expect(repo.codename).toBe('noble');
    expect(repo.keyUrl).toBe('https://download.docker.com/linux/ubuntu/gpg');
  });

  it('uses the debian repo on Debian', () => {
    const repo = dockerAptRepo({ ID: 'debian', VERSION_ID: '12', VERSION_CODENAME: 'bookworm', ID_LIKE: 'debian' });
    expect(repo.family).toBe('debian');
    expect(repo.codename).toBe('bookworm');
    expect(repo.keyUrl).toBe('https://download.docker.com/linux/debian/gpg');
  });

  it('uses the ubuntu repo on REAL Ubuntu 24.04, whose ID_LIKE is "debian" (live-found bug, fresh droplet)', () => {
    // DigitalOcean ubuntu-24-04-x64: ID=ubuntu, ID_LIKE=debian, VERSION_CODENAME=noble, UBUNTU_CODENAME=noble.
    // 0.17.5–0.18.0 read ID_LIKE=debian as Debian and wrote linux/debian noble (no Release file).
    const repo = dockerAptRepo({ ID: 'ubuntu', VERSION_ID: '24.04', ID_LIKE: 'debian', VERSION_CODENAME: 'noble', UBUNTU_CODENAME: 'noble' });
    expect(repo.family).toBe('ubuntu');
    expect(repo.codename).toBe('noble');
    expect(repo.keyUrl).toBe('https://download.docker.com/linux/ubuntu/gpg');
  });
  it('uses the debian repo on REAL Debian 13, where ID_LIKE is empty (live-found bug)', () => {
    // DigitalOcean debian-13-x64: ID=debian, VERSION_ID=13, ID_LIKE unset, VERSION_CODENAME=trixie.
    // The old ID_LIKE-only check fell through to ubuntu+trixie, which has no Docker Release file.
    const repo = dockerAptRepo({ ID: 'debian', VERSION_ID: '13', VERSION_CODENAME: 'trixie' });
    expect(repo.family).toBe('debian');
    expect(repo.codename).toBe('trixie');
    expect(repo.keyUrl).toBe('https://download.docker.com/linux/debian/gpg');
  });

  it('maps a derivative to its BASE codename, never its own (Linux Mint 22 "xia" has no Docker suite)', () => {
    const repo = dockerAptRepo({ ID: 'linuxmint', VERSION_ID: '22', VERSION_CODENAME: 'xia', UBUNTU_CODENAME: 'noble', ID_LIKE: 'ubuntu debian' });
    expect(repo.family).toBe('ubuntu');
    expect(repo.codename).toBe('noble');
  });

  it('maps a debian derivative to the debian repo (Raspberry Pi OS)', () => {
    const repo = dockerAptRepo({ ID: 'raspbian', VERSION_ID: '12', VERSION_CODENAME: 'bookworm', ID_LIKE: 'debian' });
    expect(repo.family).toBe('debian');
    expect(repo.codename).toBe('bookworm');
  });

  it('falls back to a sensible default when the os-release codename is absent', () => {
    expect(dockerAptRepo({ ID: 'ubuntu' }).codename).toBe('noble');
    expect(dockerAptRepo({ ID: 'proxmox', ID_LIKE: 'debian' }).codename).toBe('bookworm');
  });
});

describe('dockerInstallPreview', () => {
  it('names the exact repository line that will be written', () => {
    const lines = dockerInstallPreview({ family: 'debian', codename: 'trixie', keyUrl: 'https://download.docker.com/linux/debian/gpg' });
    expect(lines.join('\n')).toContain('https://download.docker.com/linux/debian trixie stable');
    expect(lines.join('\n')).toContain('docker-ce');
  });
});
