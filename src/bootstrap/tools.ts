import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { LABELS, PRODUCT, platformProjectNameFor } from '../naming.js';
import { HarborError } from '../errors.js';
import { ComposeCli } from '../docker/compose-cli.js';
import { DockerodeAdapter } from '../docker/dockerode-adapter.js';
import { loopbackPortFree } from '../docker/ports.js';
import type { PlatformToolRow } from '../state/repo.js';
import { exec, execOk } from './exec.js';
import { cockpitSocketDropIn } from './systemd.js';

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
  await execOk('/usr/bin/apt-get', ['update', '-q'], { timeoutMs: 10 * 60_000 });
  await execOk('/usr/bin/apt-get', ['install', '-y', '-q', '--no-install-recommends', 'cockpit'], { timeoutMs: 20 * 60_000 });
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
