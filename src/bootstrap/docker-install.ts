import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { exec, execOk, aptGet } from './exec.js';
import { HarborError } from '../errors.js';

// Approved Docker Engine installation from Docker's authenticated apt repository. Only runs when
// the administrator passed --install-docker. Never touches an existing Docker installation.
const KEYRINGS: Record<string, string> = {
  ubuntu: 'https://download.docker.com/linux/ubuntu/gpg',
  debian: 'https://download.docker.com/linux/debian/gpg',
};
const KEYRING = '/etc/apt/keyrings/docker.asc';
const SOURCES = '/etc/apt/sources.list.d/docker.list';
const PACKAGES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin'];

// Docker publishes one apt repository per distro family (ubuntu, debian, raspbian), keyed by the
// family's release codename — a derivative must use its BASE's codename (Linux Mint 22 -> noble),
// not its own (xia), which has no Docker suite. Read from /etc/os-release; parseable in tests.
export function dockerAptRepo(osRelease: Record<string, string>): { family: string; codename: string; keyUrl: string } {
  const like = (osRelease['ID_LIKE'] ?? '').toLowerCase().split(/\s+/);
  const family = like.includes('debian') && !like.includes('ubuntu') ? 'debian' : 'ubuntu';
  const codename = osRelease['UBUNTU_CODENAME'] ?? osRelease['VERSION_CODENAME'] ?? (family === 'debian' ? 'bookworm' : 'noble');
  return { family, codename, keyUrl: KEYRINGS[family]! };
}

export function dockerInstallPreview(repo: { family: string; codename: string; keyUrl: string }): string[] {
  return [
    `Download Docker's apt signing key over HTTPS to ${KEYRING} and verify it is an OpenPGP public key`,
    `Add ${SOURCES}: deb [arch=amd64 signed-by=${KEYRING}] https://download.docker.com/linux/${repo.family} ${repo.codename} stable`,
    `apt-get update && apt-get install -y ${PACKAGES.join(' ')}`,
    'systemctl enable --now docker',
  ];
}

export async function installDocker(log: (m: string) => void): Promise<void> {
  const osRelease: Record<string, string> = {};
  try {
    for (const line of readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
      if (m) osRelease[m[1]!] = m[3]!;
    }
  } catch {
    /* keep the defaults */
  }
  const repo = dockerAptRepo(osRelease);
  mkdirSync('/etc/apt/keyrings', { recursive: true, mode: 0o755 });
  if (!existsSync(KEYRING)) {
    log('downloading Docker apt signing key');
    const res = await fetch(repo.keyUrl);
    if (!res.ok) throw new HarborError('OPERATION_FAILED', `cannot download ${repo.keyUrl}: HTTP ${res.status}`);
    const key = await res.text();
    if (!key.includes('BEGIN PGP PUBLIC KEY BLOCK')) throw new HarborError('OPERATION_FAILED', 'downloaded key is not an OpenPGP public key');
    writeFileSync(KEYRING, key, { mode: 0o644 });
  }
  writeFileSync(SOURCES, `deb [arch=amd64 signed-by=${KEYRING}] https://download.docker.com/linux/${repo.family} ${repo.codename} stable\n`, { mode: 0o644 });
  log(`apt repository: download.docker.com/linux/${repo.family} ${repo.codename}`);
  log('apt-get update');
  await aptGet(log, ['update', '-q'], { timeoutMs: 10 * 60_000 });
  log(`apt-get install ${PACKAGES.join(' ')}`);
  await aptGet(log, ['install', '-y', '-q', '--no-install-recommends', ...PACKAGES], { timeoutMs: 20 * 60_000 });
  await execOk('systemctl', ['enable', '--now', 'docker'], { timeoutMs: 120_000 });
  const v = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 60_000 });
  if (v.code !== 0) throw new HarborError('DOCKER_UNAVAILABLE', `Docker installed but the daemon is not answering: ${v.stderr.trim()}`);
  log(`Docker Engine ${v.stdout.trim()} is running`);
}
