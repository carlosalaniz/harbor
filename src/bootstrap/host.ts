import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { exec, httpGetStatus, which } from './exec.js';

export interface HostFacts {
  osId: string;
  versionId: string;
  prettyName: string;
  arch: string;
  systemd: boolean;
  root: boolean;
  docker: { binary: string | null; version: string | null; composeVersion: string | null; daemonActive: boolean; socket: string };
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
    prettyName: os['PRETTY_NAME'] ?? platform(),
    arch: arch(),
    systemd: existsSync('/run/systemd/system'),
    root: typeof process.getuid === 'function' && process.getuid() === 0,
    docker: { binary: dockerBin, version: dockerVersion, composeVersion, daemonActive, socket: '/var/run/docker.sock' },
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

export function assertSupportedHost(f: HostFacts): void {
  const problems: string[] = [];
  if (!f.root) problems.push('bootstrap must run as root (sudo)');
  if (f.osId !== 'ubuntu' || !f.versionId.startsWith('24.04')) problems.push(`unsupported OS ${f.prettyName}; Ubuntu 24.04 LTS is required`);
  if (f.arch !== 'x64') problems.push(`unsupported architecture ${f.arch}; x86-64 is required`);
  if (!f.systemd) problems.push('systemd is required');
  if (problems.length) throw new HarborError('UNSUPPORTED_CAPABILITY', problems.join('; '), { nextAction: 'Use a supported host (Ubuntu 24.04 x86-64 with systemd) and run as root.' });
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
