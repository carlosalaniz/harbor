import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { exec, httpGetStatus, which } from './exec.js';

export interface HostFacts {
  osId: string;
  versionId: string;
  osIdLike: string;
  // base-distro codename for apt repositories (UBUNTU_CODENAME ?? VERSION_CODENAME ?? '')
  osCodename: string;
  prettyName: string;
  arch: string;
  systemd: boolean;
  root: boolean;
  docker: { binary: string | null; version: string | null; composeVersion: string | null; daemonActive: boolean; socket: string; aptRepo: { family: string; codename: string; keyUrl: string } };
  existing: {
    optDir: 'absent' | 'harbor' | 'foreign';
    optReleaseVersion: string | null;
    config: boolean;
    state: boolean;
    unit: 'absent' | 'harbor' | 'foreign';
    user: boolean;
    cockpit: { installed: boolean; socketActive: boolean };
    portainer: { containerPresent: boolean };
    tailscale: { installed: boolean; backendState: string | null; dnsName: string | null };
    caddy: { installed: boolean; adminReachable: boolean; harborConfig: boolean };
  };
}

export const RELEASE_MARKER = 'release.json';
export const UNIT_MARKER = `# managed-by: ${PRODUCT.codename}-bootstrap`;

function osRelease(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
      if (m) out[m[1]!] = m[3]!;
    }
  } catch {
    /* not linux */
  }
  return out;
}

export async function gatherHostFacts(): Promise<HostFacts> {
  const os = osRelease();
  const dockerBin = await which('docker');
  let dockerVersion: string | null = null;
  let composeVersion: string | null = null;
  let daemonActive = false;
  if (dockerBin) {
    const v = await exec(dockerBin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000, env: { DOCKER_CONFIG: '/nonexistent-harbor-bootstrap' } });
    dockerVersion = v.code === 0 ? v.stdout.trim() : null;
    daemonActive = v.code === 0;
    const c = await exec(dockerBin, ['compose', 'version', '--short'], { timeoutMs: 20_000, env: { DOCKER_CONFIG: '/nonexistent-harbor-bootstrap' } });
    composeVersion = c.code === 0 ? c.stdout.trim() : null;
  }
  const optDir = !existsSync(PRODUCT.paths.opt) ? 'absent' : existsSync(`${PRODUCT.paths.opt}/${RELEASE_MARKER}`) ? 'harbor' : 'foreign';
  let optReleaseVersion: string | null = null;
  if (optDir === 'harbor') {
    try {
      optReleaseVersion = (JSON.parse(readFileSync(`${PRODUCT.paths.opt}/${RELEASE_MARKER}`, 'utf8')) as { version?: string }).version ?? null;
    } catch {
      optReleaseVersion = null;
    }
  }
  const unitPath = `/etc/systemd/system/${PRODUCT.paths.systemdUnit}`;
  const unit = !existsSync(unitPath) ? 'absent' : readFileSync(unitPath, 'utf8').includes(UNIT_MARKER) ? 'harbor' : 'foreign';
  const userExists = (await exec('/usr/bin/id', ['-u', PRODUCT.serviceUser], { timeoutMs: 5000 })).code === 0;
  const cockpitInstalled = (await exec('/usr/bin/dpkg-query', ['-W', '-f=${Status}', 'cockpit-ws'], { timeoutMs: 10_000 })).stdout.includes('install ok installed');
  const cockpitSocket = (await exec('/usr/bin/systemctl', ['is-active', 'cockpit.socket'], { timeoutMs: 10_000 })).stdout.trim() === 'active';
  const tailscaleBin = await which('tailscale');
  let tailscaleState: string | null = null;
  let tailscaleDns: string | null = null;
  if (tailscaleBin) {
    const st = await exec(tailscaleBin, ['status', '--json'], { timeoutMs: 15_000 });
    try {
      const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
      tailscaleState = j.BackendState ?? null;
      tailscaleDns = j.Self?.DNSName?.replace(/\.$/, '') ?? null;
    } catch {
      tailscaleState = null;
    }
  }
  const caddyBin = await which('caddy');
  let caddyAdmin = false;
  if (caddyBin) caddyAdmin = (await httpGetStatus('127.0.0.1', 2019, '/config/')) === 200;
  let portainerPresent = false;
  if (dockerBin && daemonActive) {
    const ps = await exec(dockerBin, ['ps', '-a', '--filter', 'name=hb_platform_portainer', '--format', '{{.Names}}'], { timeoutMs: 20_000, env: { DOCKER_CONFIG: '/nonexistent-harbor-bootstrap' } });
    portainerPresent = ps.stdout.trim().length > 0;
  }
  return {
    osId: os['ID'] ?? platform(),
    versionId: os['VERSION_ID'] ?? '',
    osIdLike: os['ID_LIKE'] ?? '',
    osCodename: os['UBUNTU_CODENAME'] ?? os['VERSION_CODENAME'] ?? '',
    prettyName: os['PRETTY_NAME'] ?? platform(),
    arch: arch(),
    systemd: existsSync('/run/systemd/system'),
    root: typeof process.getuid === 'function' && process.getuid() === 0,
    docker: { binary: dockerBin, version: dockerVersion, composeVersion, daemonActive, socket: '/var/run/docker.sock', aptRepo: dockerAptRepo(os) },
    existing: {
      optDir,
      optReleaseVersion,
      config: existsSync(`${PRODUCT.paths.etc}/harbor.json`),
      state: existsSync(`${PRODUCT.paths.var}/harbor.db`),
      unit,
      user: userExists,
      cockpit: { installed: cockpitInstalled, socketActive: cockpitSocket },
      portainer: { containerPresent: portainerPresent },
      tailscale: { installed: Boolean(tailscaleBin), backendState: tailscaleState, dnsName: tailscaleDns },
      caddy: { installed: Boolean(caddyBin), adminReachable: caddyAdmin, harborConfig: existsSync('/etc/caddy/harbor.json') },
    },
  };
}

// Same family/codename logic as the installer, on the raw os-release record. Local copy keeps the
// import cycle away (host.ts is imported by everything bootstrap; docker-install is a leaf).
function dockerAptRepo(os: Record<string, string>): { family: string; codename: string; keyUrl: string } {
  const id = (os['ID'] ?? '').toLowerCase();
  const like = (os['ID_LIKE'] ?? '').toLowerCase().split(/\s+/);
  const debianFlavoured = id === 'debian' || id === 'raspbian' || (like.includes('debian') && !like.includes('ubuntu'));
  const family = debianFlavoured ? 'debian' : 'ubuntu';
  const codename = os['UBUNTU_CODENAME'] ?? os['VERSION_CODENAME'] ?? (family === 'debian' ? 'bookworm' : 'noble');
  return { family, codename, keyUrl: `https://download.docker.com/linux/${family}/gpg` };
}

// Distros bootstrap knows how to service without --force (decision 113). Compatibility needs
// more than a shared package manager: the apt recipes (Docker's per-distro repository, Caddy's
// cloudsmith list, the universe/archive package names) must actually exist for the release.
export type DistroSupport = 'supported' | 'derived' | 'unknown';

export function distroSupport(osId: string, versionId: string, osIdLike: string): DistroSupport {
  const id = osId.toLowerCase();
  if (id === 'ubuntu') return versionId.startsWith('24.04') ? 'supported' : 'unknown';
  if (id === 'debian') return ['12', '13'].includes(versionId.split('.')[0] ?? '') ? 'supported' : 'unknown';
  // Downstream derivatives (Linux Mint, Pop!_OS, Raspberry Pi OS, Proxmox, ...) declare their
  // family in ID_LIKE; they work when they track a supported base, but Harbor never ran there.
  const like = osIdLike.toLowerCase().split(/\s+/);
  return like.includes('ubuntu') || like.includes('debian') ? 'derived' : 'unknown';
}

export function assertSupportedHost(f: HostFacts, opts: { force?: boolean } = {}): void {
  const hard: string[] = [];
  if (!f.root) hard.push('bootstrap must run as root (sudo)');
  if (f.arch !== 'x64') hard.push(`unsupported architecture ${f.arch}; x86-64 is required`);
  if (!f.systemd) hard.push('systemd is required');
  if (hard.length) throw new HarborError('UNSUPPORTED_CAPABILITY', hard.join('; '), { nextAction: 'Use a supported host (Ubuntu 24.04 or Debian 12/13, x86-64 with systemd) and run as root.' });
  const support = distroSupport(f.osId, f.versionId, f.osIdLike);
  if (support === 'supported') return;
  if (support === 'derived' && opts.force) return;
  if (support === 'derived') {
    throw new HarborError('UNSUPPORTED_CAPABILITY', `unsupported OS ${f.prettyName}; supported hosts are Ubuntu 24.04 LTS and Debian 12/13`, {
      nextAction: 'This distro is Debian/Ubuntu-based, so it will probably work; re-run with --force to install anyway (not a tested configuration — you keep the pieces).',
    });
  }
  throw new HarborError('UNSUPPORTED_CAPABILITY', `unsupported OS ${f.prettyName}; supported hosts are Ubuntu 24.04 LTS and Debian 12/13`, {
    nextAction: 'Use a supported host. If this machine is really Debian/Ubuntu-based, re-run with --force (not a tested configuration — you keep the pieces).',
  });
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
