import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { exec, execOk, aptGet } from './exec.js';
import { HarborError } from '../errors.js';

// Approved Docker Engine installation from Docker's authenticated apt repository (Ubuntu 24.04
// "noble"). Only runs when the administrator passed --install-docker. Never touches an existing
// Docker installation.
const KEY_URL = 'https://download.docker.com/linux/ubuntu/gpg';
const KEYRING = '/etc/apt/keyrings/docker.asc';
const SOURCES = '/etc/apt/sources.list.d/docker.list';
const PACKAGES = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin'];

export function dockerInstallPreview(): string[] {
  return [
    `Download Docker's apt signing key over HTTPS to ${KEYRING} and verify it is an OpenPGP public key`,
    `Add ${SOURCES}: deb [arch=amd64 signed-by=${KEYRING}] https://download.docker.com/linux/ubuntu noble stable`,
    `apt-get update && apt-get install -y ${PACKAGES.join(' ')}`,
    'systemctl enable --now docker',
  ];
}

export async function installDocker(log: (m: string) => void): Promise<void> {
  mkdirSync('/etc/apt/keyrings', { recursive: true, mode: 0o755 });
  if (!existsSync(KEYRING)) {
    log('downloading Docker apt signing key');
    const res = await fetch(KEY_URL);
    if (!res.ok) throw new HarborError('OPERATION_FAILED', `cannot download ${KEY_URL}: HTTP ${res.status}`);
    const key = await res.text();
    if (!key.includes('BEGIN PGP PUBLIC KEY BLOCK')) throw new HarborError('OPERATION_FAILED', 'downloaded key is not an OpenPGP public key');
    writeFileSync(KEYRING, key, { mode: 0o644 });
  }
  const codename = (await execOk('/usr/bin/lsb_release', ['-cs'])).stdout.trim() || 'noble';
  writeFileSync(SOURCES, `deb [arch=amd64 signed-by=${KEYRING}] https://download.docker.com/linux/ubuntu ${codename} stable\n`, { mode: 0o644 });
  log('apt-get update');
  await aptGet(log, ['update', '-q'], { timeoutMs: 10 * 60_000 });
  log(`apt-get install ${PACKAGES.join(' ')}`);
  await aptGet(log, ['install', '-y', '-q', '--no-install-recommends', ...PACKAGES], { timeoutMs: 20 * 60_000 });
  await execOk('/usr/bin/systemctl', ['enable', '--now', 'docker'], { timeoutMs: 120_000 });
  const v = await exec('/usr/bin/docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 60_000 });
  if (v.code !== 0) throw new HarborError('DOCKER_UNAVAILABLE', `Docker installed but the daemon is not answering: ${v.stderr.trim()}`);
  log(`Docker Engine ${v.stdout.trim()} is running`);
}
