import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { LABELS, PRODUCT, platformProjectNameFor } from '../naming.js';
import { HarborError } from '../errors.js';
import { ComposeCli } from '../docker/compose-cli.js';
import { DockerodeAdapter } from '../docker/dockerode-adapter.js';
import { loopbackPortFree } from '../docker/ports.js';
import type { PlatformToolRow } from '../state/repo.js';
import { exec, execOk, aptGet, httpGetStatus } from './exec.js';
import { cockpitSocketDropIn } from './systemd.js';
import { suggestedUpArgs } from '../exposure/tailscale.js';

// Platform tool recipes (host infrastructure; deliberately specialized, unlike app packages).
export const PORTAINER_IMAGE = {
  reference: 'portainer/portainer-ce@sha256:0e3c8bc8c50aa69a21d024bf2822b6c49a107e5591573b93951191c3fcffbe02',
  tag: '2.39.7',
  platformDigest: 'sha256:fa737e6f798da982eda143a01796903b1edf0e7ed465d0bca23df6e903405206',
} as const;
export const COCKPIT_PORT = 9090;
export const PORTAINER_PORT = 9443;

export type ToolRecord = Omit<PlatformToolRow, 'updatedAt'>;

export function cockpitPreview(existing: boolean): string[] {
  return existing
    ? ['Cockpit is already installed: keep its current listener and settings, record its address (bind without taking ownership)']
    : ['apt-get install -y cockpit (Ubuntu repositories)', `restrict cockpit.socket to 127.0.0.1:${COCKPIT_PORT} via a systemd drop-in`, 'systemctl daemon-reload && systemctl restart cockpit.socket', `record https://localhost:${COCKPIT_PORT}/ (self-signed certificate; log in with an OS account)`];
}

export async function setupCockpit(log: (m: string) => void, existing: { installed: boolean; socketActive: boolean }, now: string): Promise<ToolRecord> {
  if (existing.installed) {
    const port = await detectCockpitPort();
    log(`Cockpit already installed (listener ${port ? `port ${port}` : 'unknown'}); not reconfigured`);
    return {
      id: 'cockpit',
      mode: 'external',
      browserUrl: port ? `https://localhost:${port}/` : null,
      installationState: 'installed',
      availability: 'unknown',
      observedAt: now,
      note: `Existing Cockpit installation bound without changes. ${port ? `Listener on port ${port} as configured by the host.` : 'Listener port not detected; set it with `harbor tools bind cockpit --url`.'} Log in with an OS account.`,
      resources: null,
    };
  }
  log('apt-get install cockpit');
  await aptGet(log, ['update', '-q'], { timeoutMs: 10 * 60_000 });
  await aptGet(log, ['install', '-y', '-q', '--no-install-recommends', 'cockpit'], { timeoutMs: 20 * 60_000 });
  const dropDir = '/etc/systemd/system/cockpit.socket.d';
  mkdirSync(dropDir, { recursive: true, mode: 0o755 });
  writeFileSync(path.join(dropDir, 'harbor-loopback.conf'), cockpitSocketDropIn(COCKPIT_PORT), { mode: 0o644 });
  await execOk('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60_000 });
  await execOk('/usr/bin/systemctl', ['enable', '--now', 'cockpit.socket'], { timeoutMs: 60_000 });
  await execOk('/usr/bin/systemctl', ['restart', 'cockpit.socket'], { timeoutMs: 60_000 });
  const listen = await exec('/usr/bin/systemctl', ['show', 'cockpit.socket', '-p', 'Listen'], { timeoutMs: 10_000 });
  if (!listen.stdout.includes(`127.0.0.1:${COCKPIT_PORT}`)) throw new HarborError('OPERATION_FAILED', `cockpit.socket is not bound to 127.0.0.1:${COCKPIT_PORT}: ${listen.stdout.trim()}`);
  log(`Cockpit listening on 127.0.0.1:${COCKPIT_PORT}`);
  return {
    id: 'cockpit',
    mode: 'managed',
    browserUrl: `https://localhost:${COCKPIT_PORT}/`,
    installationState: 'installed',
    availability: 'unknown',
    observedAt: now,
    note: 'Installed from Ubuntu repositories; listener restricted to loopback. Log in with an OS account (not the Harbor administrator). Self-signed certificate.',
    resources: { unitDropIn: '/etc/systemd/system/cockpit.socket.d/harbor-loopback.conf', port: COCKPIT_PORT },
  };
}

async function detectCockpitPort(): Promise<number | null> {
  const r = await exec('/usr/bin/systemctl', ['show', 'cockpit.socket', '-p', 'Listen'], { timeoutMs: 10_000 });
  const m = /:(\d+) \(Stream\)/.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

export function portainerPreview(existing: boolean): string[] {
  return existing
    ? ['Portainer platform project already exists: keep it and record its address']
    : [
        `docker volume create ${platformProjectNameFor('portainer')}_data (labelled platform resource, retained)`,
        `compose project ${platformProjectNameFor('portainer')}: ${PORTAINER_IMAGE.reference} (${PORTAINER_IMAGE.tag}), HTTPS on 127.0.0.1:${PORTAINER_PORT} only, agent/edge ports not published`,
        'mounts /var/run/docker.sock: Portainer gets full Docker (root-equivalent) authority — this is disclosed, not hidden',
        `record https://localhost:${PORTAINER_PORT}/ ; create the Portainer admin in its own first-run form within 5 minutes using the setup token from its container log`,
      ];
}

export async function setupPortainer(log: (m: string) => void, installationId: string, dockerBinary: string, socketPath: string, stateDir: string, existing: boolean, now: string): Promise<ToolRecord> {
  const project = platformProjectNameFor('portainer');
  const volumeName = `${project}_data`;
  const dir = path.join(stateDir, 'platform', 'portainer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const adapter = new DockerodeAdapter(socketPath);
  const compose = new ComposeCli({ dockerBinary, socketPath, configDir: path.join(stateDir, 'platform', 'docker-config') });
  const labels = { [LABELS.installation]: installationId, [LABELS.platformTool]: 'portainer', [LABELS.kind]: 'platform' };
  if (!existing) {
    if (!(await loopbackPortFree(PORTAINER_PORT))) {
      throw new HarborError('PORT_CONFLICT', `127.0.0.1:${PORTAINER_PORT} is already in use; Portainer was not deployed`, { nextAction: 'Free the port or bind an existing Portainer with `harbor tools bind portainer --url`.' });
    }
    const vol = await adapter.inspectVolume(volumeName);
    if (vol && vol.labels[LABELS.platformTool] !== 'portainer') throw new HarborError('OWNERSHIP_CONFLICT', `volume ${volumeName} exists and is not a Harbor platform volume`);
    if (!vol) {
      await adapter.createVolume(volumeName, labels);
      log(`created platform volume ${volumeName}`);
    }
  }
  const model = {
    name: project,
    services: {
      portainer: {
        image: PORTAINER_IMAGE.reference,
        restart: 'unless-stopped',
        labels,
        ports: [{ target: PORTAINER_PORT, published: String(PORTAINER_PORT), host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host' }],
        volumes: [
          { type: 'bind', source: socketPath, target: '/var/run/docker.sock' },
          { type: 'volume', source: 'data', target: '/data' },
        ],
      },
    },
    volumes: { data: { name: volumeName, external: true } },
    networks: { default: { name: `${project}_default`, labels } },
  };
  const file = path.join(dir, 'compose.yaml');
  writeFileSync(file, yamlStringify(model, { lineWidth: 0 }), { mode: 0o600 });
  const inv = { projectDir: dir, projectName: project, file };
  await compose.config(inv, 60_000);
  if (!existing) {
    log(`pulling ${PORTAINER_IMAGE.reference}`);
    await compose.pull(inv, 15 * 60_000);
  }
  log(`starting ${project}`);
  await compose.up(inv, 180_000);
  const containers = await adapter.listContainers({ all: true, labels: { 'com.docker.compose.project': project } });
  return {
    id: 'portainer',
    mode: 'managed',
    browserUrl: `https://localhost:${PORTAINER_PORT}/`,
    installationState: 'setup_required',
    availability: 'unknown',
    observedAt: now,
    note: `Portainer CE ${PORTAINER_IMAGE.tag} with Docker socket access (root-equivalent). First run: create the admin in Portainer's own form within 5 minutes of start; it asks for the one-time setup token printed in the container log (sudo docker logs ${containers[0]?.name ?? `${project}-portainer-1`} 2>&1 | grep setup_token). If the window expired, run: sudo docker restart ${containers[0]?.name ?? `${project}-portainer-1`} (prints a new token). Self-signed certificate.`,
    resources: { project, volume: volumeName, containers: containers.map((c) => ({ id: c.id, name: c.name })), image: PORTAINER_IMAGE.reference },
  };
}

export function externalToolRecord(id: 'cockpit' | 'portainer', url: string, now: string): ToolRecord {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HarborError('INVALID_REQUEST', `invalid URL ${url}`);
  }
  if ((u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') || !['http:', 'https:'].includes(u.protocol)) {
    throw new HarborError('INVALID_REQUEST', 'tool URLs must be http(s) on localhost/127.0.0.1 (loopback only)');
  }
  return {
    id,
    mode: 'external',
    browserUrl: u.toString(),
    installationState: 'installed',
    availability: 'unknown',
    observedAt: now,
    note: `Bound to an existing ${id === 'cockpit' ? 'Cockpit' : 'Portainer'} installation without taking ownership; Harbor does not manage or reconfigure it.`,
    resources: null,
  };
}

export function stateDirHasPlatform(stateDir: string): boolean {
  return existsSync(path.join(stateDir, 'platform', 'portainer', 'compose.yaml'));
}

export { PRODUCT };


// ---------------------------------------------------------------- Tailscale (private cloud path)

const TS_KEYRING = '/usr/share/keyrings/tailscale-archive-keyring.gpg';
const TS_LIST = '/etc/apt/sources.list.d/tailscale.list';

export function tailscalePreview(existing: { installed: boolean; backendState: string | null }, authKey: boolean): string[] {
  return [
    existing.installed ? 'Tailscale already installed: keep it' : `Install tailscale from pkgs.tailscale.com (signed apt repository, noble): keyring ${TS_KEYRING}, list ${TS_LIST}`,
    existing.backendState === 'Running' ? 'Node already logged in: keep its identity' : authKey ? 'Log the node in with the provided auth key (tailscale up --auth-key from stdin; never on the command line)' : 'Run `tailscale up` and print its login URL for you to approve in a browser',
    `Allow the ${PRODUCT.serviceUser} service account to manage serve entries: tailscale set --operator=${PRODUCT.serviceUser}`,
    'Record the node name; Harbor only publishes apps you explicitly expose (tailscale serve, HTTPS with tailnet certificates)',
  ];
}

export async function setupTailscale(log: (m: string) => void, existing: { installed: boolean; backendState: string | null }, authKey: string | null, now: string): Promise<ToolRecord> {
  if (!existing.installed) {
    log('installing tailscale from pkgs.tailscale.com');
    const key = await fetch('https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg');
    if (!key.ok) throw new HarborError('OPERATION_FAILED', `cannot download tailscale keyring: HTTP ${key.status}`);
    writeFileSync(TS_KEYRING, Buffer.from(await key.arrayBuffer()), { mode: 0o644 });
    const list = await fetch('https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list');
    if (!list.ok) throw new HarborError('OPERATION_FAILED', `cannot download tailscale apt list: HTTP ${list.status}`);
    const listText = await list.text();
    if (!listText.includes('pkgs.tailscale.com') || !listText.includes(TS_KEYRING)) throw new HarborError('OPERATION_FAILED', 'unexpected tailscale apt list content');
    writeFileSync(TS_LIST, listText, { mode: 0o644 });
    await aptGet(log, ['update', '-q'], { timeoutMs: 10 * 60_000 });
    await aptGet(log, ['install', '-y', '-q', 'tailscale'], { timeoutMs: 20 * 60_000 });
    await execOk('/usr/bin/systemctl', ['enable', '--now', 'tailscaled'], { timeoutMs: 60_000 });
  }
  // the operator grant first: `tailscale up` below must mention it (the CLI insists on all non-default flags)
  await execOk('/usr/bin/tailscale', ['set', `--operator=${PRODUCT.serviceUser}`], { timeoutMs: 30_000 });
  const upBase = ['--ssh=false', `--operator=${PRODUCT.serviceUser}`];
  let state = existing.backendState;
  if (state !== 'Running') {
    if (authKey) {
      // The key goes through a root-only temporary file (`--auth-key=file:`, the documented non-interactive form),
      // never as a command-line argument (visible in `ps`) and never in logs. Live run 12 showed the CLI does
      // not understand an `env:` prefix: it treated the literal string as the key.
      const keyFile = '/run/harbor-tailscale-authkey';
      writeFileSync(keyFile, authKey.trim() + '\n', { mode: 0o600 });
      let r;
      try {
        r = await exec('/usr/bin/tailscale', ['up', `--auth-key=file:${keyFile}`, ...upBase, '--timeout=120s'], { timeoutMs: 180_000 });
        const again = suggestedUpArgs(r.stderr + r.stdout);
        if (r.code !== 0 && again) r = await exec('/usr/bin/tailscale', ['up', `--auth-key=file:${keyFile}`, ...again, '--timeout=120s'], { timeoutMs: 180_000 });
      } finally {
        rmSync(keyFile, { force: true });
      }
      if (r.code !== 0) throw new HarborError('OPERATION_FAILED', `tailscale up failed: ${(r.stderr || r.stdout).trim().replace(/tskey-[A-Za-z0-9-]+/g, '<key>').slice(0, 300)}`);
      state = 'Running';
      log('tailscale node logged in with the provided auth key');
    } else {
      const r = await exec('/usr/bin/tailscale', ['up', ...upBase, '--timeout=25s'], { timeoutMs: 40_000 });
      const url = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
      log(url ? `tailscale login required: open ${url} in a browser, then re-run bootstrap --with-tailscale (or run: sudo tailscale up)` : 'tailscale login required: run `sudo tailscale up` and approve the URL it prints');
    }
  }
  const st = await exec('/usr/bin/tailscale', ['status', '--json'], { timeoutMs: 15_000 });
  let dnsName: string | null = null;
  let httpsEnabled = false;
  try {
    const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
    state = j.BackendState ?? state;
    dnsName = j.Self?.DNSName?.replace(/\.$/, '') ?? null;
    httpsEnabled = (j.CertDomains ?? []).length > 0;
  } catch {
    /* keep prior */
  }
  const loggedIn = state === 'Running' && Boolean(dnsName);
  return {
    id: 'tailscale',
    mode: existing.installed ? 'external' : 'managed',
    browserUrl: null,
    installationState: loggedIn ? (httpsEnabled ? 'installed' : 'setup_required') : 'setup_required',
    availability: 'unknown',
    observedAt: now,
    note: !loggedIn
      ? 'Installed; log in with `sudo tailscale up` (approve the printed URL), then Harbor can publish apps on your tailnet.'
      : httpsEnabled
        ? `Node ${dnsName} logged in; MagicDNS + HTTPS enabled. Use harbor expose <instance> --via tailnet.`
        : `Node ${dnsName} logged in. Enable MagicDNS and HTTPS certificates in the Tailscale admin console (DNS settings) before publishing.`,
    resources: { dnsName, operator: PRODUCT.serviceUser },
  };
}

// ---------------------------------------------------------------- Caddy (public path)

const CADDY_KEYRING = '/usr/share/keyrings/caddy-stable-archive-keyring.gpg';
const CADDY_LIST = '/etc/apt/sources.list.d/caddy-stable.list';
export const CADDY_CONFIG = '/etc/caddy/harbor.json';

export function caddyPreview(existing: { installed: boolean; harborConfig: boolean }): string[] {
  return [
    existing.installed ? 'Caddy already installed: keep the package' : `Install caddy from dl.cloudsmith.io/public/caddy/stable (signed apt repository): keyring ${CADDY_KEYRING}, list ${CADDY_LIST}`,
    existing.harborConfig ? `Keep the Harbor-owned ${CADDY_CONFIG}` : `Write a Harbor-owned JSON config ${CADDY_CONFIG} (admin API on 127.0.0.1:2019, no sites yet) and run caddy from it via a systemd drop-in (--resume keeps Harbor's changes across restarts)`,
    'Ports 80/443 stay closed until you expose an app; then DNS for each hostname must point at this host',
  ];
}

export async function setupCaddy(log: (m: string) => void, existing: { installed: boolean; harborConfig: boolean }, now: string): Promise<ToolRecord> {
  if (!existing.installed) {
    log('installing caddy from cloudsmith stable repository');
    const key = await fetch('https://dl.cloudsmith.io/public/caddy/stable/gpg.key');
    if (!key.ok) throw new HarborError('OPERATION_FAILED', `cannot download caddy gpg key: HTTP ${key.status}`);
    const armored = await key.text();
    if (!armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) throw new HarborError('OPERATION_FAILED', 'downloaded caddy key is not an OpenPGP public key');
    const tmp = '/tmp/caddy-stable.gpg.asc';
    writeFileSync(tmp, armored, { mode: 0o644 });
    await execOk('/usr/bin/gpg', ['--dearmor', '--yes', '-o', CADDY_KEYRING, tmp], { timeoutMs: 30_000 });
    const list = await fetch('https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt');
    if (!list.ok) throw new HarborError('OPERATION_FAILED', `cannot download caddy apt list: HTTP ${list.status}`);
    writeFileSync(CADDY_LIST, await list.text(), { mode: 0o644 });
    await aptGet(log, ['update', '-q'], { timeoutMs: 10 * 60_000 });
    await aptGet(log, ['install', '-y', '-q', 'caddy'], { timeoutMs: 20 * 60_000 });
  }
  // Caddy terminates TLS for the LAN hostnames using the Harbor-minted cert (decision 109 + Caddy-owns-443
  // fix): the server cert/key are group-readable by the `harbor` group, so the caddy user must be in it.
  // Idempotent: `usermod -aG` is a no-op when the user is already a member.
  await execOk('/usr/bin/usermod', ['-aG', PRODUCT.serviceUser, 'caddy'], { timeoutMs: 30_000 });
  if (!existing.harborConfig) {
    mkdirSync('/etc/caddy', { recursive: true, mode: 0o755 });
    writeFileSync(CADDY_CONFIG, JSON.stringify({ admin: { listen: '127.0.0.1:2019' }, apps: { http: { servers: { harbor: { '@id': 'harbor-managed', listen: [':443'], routes: [] } } } } }, null, 2) + '\n', { mode: 0o644 });
    const dropDir = '/etc/systemd/system/caddy.service.d';
    mkdirSync(dropDir, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(dropDir, 'harbor.conf'), `# managed-by: ${PRODUCT.codename}-bootstrap\n[Service]\nExecStart=\nExecStart=/usr/bin/caddy run --environ --resume --config ${CADDY_CONFIG}\nExecReload=\nExecReload=/usr/bin/caddy reload --config ${CADDY_CONFIG} --force\n`, { mode: 0o644 });
    await execOk('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60_000 });
    log(`wrote ${CADDY_CONFIG} and the caddy unit drop-in`);
  }
  await execOk('/usr/bin/systemctl', ['enable', '--now', 'caddy'], { timeoutMs: 120_000 });
  await execOk('/usr/bin/systemctl', ['restart', 'caddy'], { timeoutMs: 120_000 });
  let reachable = false;
  for (let i = 0; i < 20 && !reachable; i++) {
    reachable = (await httpGetStatus('127.0.0.1', 2019, '/config/')) === 200;
    if (!reachable) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!reachable) throw new HarborError('OPERATION_FAILED', 'caddy admin API did not become reachable on 127.0.0.1:2019', { nextAction: 'Check `systemctl status caddy` and `journalctl -u caddy`.' });
  log('caddy running with the Harbor-owned config; admin API on 127.0.0.1:2019');
  return {
    id: 'proxy',
    mode: existing.installed ? 'external' : 'managed',
    browserUrl: null,
    installationState: 'installed',
    availability: 'reachable',
    observedAt: now,
    note: 'Caddy serves only the routes Harbor publishes (harbor expose --via public --host <fqdn>). Certificates come from Let\'s Encrypt; DNS must point at this host and ports 80/443 must be reachable.',
    resources: { config: CADDY_CONFIG, adminApi: 'http://127.0.0.1:2019' },
  };
}
