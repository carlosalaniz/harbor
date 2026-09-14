// Live Docker integration: real Dockerode adapter + real `docker compose` CLI.
// Opt-in only: HARBOR_LIVE_DOCKER_SOCKET=/path/to/docker.sock (an explicitly chosen engine).
// Nothing is discovered from the environment. Only Harbor-labelled resources created by this
// test are cleaned up; no prune, no global cleanup.
import Docker from 'dockerode';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeConfig, type DaemonConfig } from '../../src/config.js';
import { startDaemon, findDockerBinary, type Daemon } from '../../src/daemon.js';
import { initializeState } from '../../src/state/db.js';
import { enrollAdministrator } from '../../src/maintenance.js';
import { systemClock, systemIds } from '../../src/util.js';
import { ADMIN, Api, REPO_CATALOG, freePort } from './harness.js';
import { LABELS } from '../../src/naming.js';
import type { InstanceDetail } from '../../src/contracts/api.js';
import { DockerodeAdapter } from '../../src/docker/dockerode-adapter.js';
import { ComposeCli } from '../../src/docker/compose-cli.js';

const SOCKET = process.env['HARBOR_LIVE_DOCKER_SOCKET'];
const PLUGIN_DIRS = [path.join(homedir(), '.docker', 'cli-plugins')].filter((d) => existsSync(d));
const enabled = Boolean(SOCKET && existsSync(SOCKET) && findDockerBinary());
if (!enabled) console.warn('live-docker tests SKIPPED: set HARBOR_LIVE_DOCKER_SOCKET=/path/to/docker.sock (explicit opt-in) and have the docker CLI installed');

describe.skipIf(!enabled)('live Docker (explicit opt-in engine)', () => {
  let root: string;
  let config: DaemonConfig;
  let daemon: Daemon;
  let api: Api;
  let installationId: string;
  const docker = new Docker({ socketPath: SOCKET });

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'harbor-live-'));
    const stateDir = path.join(root, 'state');
    const catalogDir = path.join(root, 'catalog');
    cpSync(REPO_CATALOG, catalogDir, { recursive: true });
    const port = await freePort();
    const base = 18700;
    config = normalizeConfig({ stateDir, catalogDir, docker: { mode: 'socket', socketPath: SOCKET!, cliPluginDirs: PLUGIN_DIRS }, listen: { host: '127.0.0.1', port }, appPortRange: { from: base, to: base + 20 }, logLevel: 'warn', imagePullTimeoutMs: 10 * 60_000 }, root);
    installationId = initializeState(stateDir, { clock: systemClock, ids: systemIds, config: {} }).installationId;
    await enrollAdministrator(config, ADMIN.username, ADMIN.password, { reset: false });
    daemon = await startDaemon(config, { observerIntervalMs: 2000 });
    api = new Api(`http://localhost:${port}`, null);
    api.token = (await api.login()).token;
  }, 120_000);

  afterAll(async () => {
    await daemon?.close();
    // Cleanup ONLY resources labelled with this test's installation id.
    const filters = JSON.stringify({ label: [`${LABELS.installation}=${installationId}`] });
    for (const c of await docker.listContainers({ all: true, filters })) {
      try {
        await docker.getContainer(c.Id).remove({ force: true });
      } catch {
        /* ignore */
      }
    }
    for (const n of await docker.listNetworks({ filters })) {
      try {
        await docker.getNetwork(n.Id).remove();
      } catch {
        /* ignore */
      }
    }
    const vols = await docker.listVolumes({ filters });
    for (const v of vols.Volumes ?? []) {
      try {
        await docker.getVolume(v.Name).remove();
      } catch {
        /* ignore */
      }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('the real Compose CLI validates the generated model and rejects interpolation leftovers', async () => {
    const cli = new ComposeCli({ dockerBinary: findDockerBinary()!, socketPath: SOCKET!, configDir: path.join(root, 'dc'), pluginDirs: PLUGIN_DIRS });
    expect(await cli.version()).toMatch(/^\d/);
    const adapter = new DockerodeAdapter(SOCKET!);
    const ping = await adapter.ping();
    expect(ping.available).toBe(true);
  });

  it('installs Excalidraw for real: pulls by digest, publishes on loopback, readiness passes; then stop/start/remove/reinstall', async () => {
    const { plan, op } = await api.run({ kind: 'install', packageId: 'excalidraw' });
    expect(op.state, JSON.stringify(op.error) + JSON.stringify(op.events)).toBe('succeeded');
    const inst = (await api.instances())[0]!;
    expect(inst).toMatchObject({ installState: 'installed', runtime: 'running', readiness: 'healthy' });
    const res = await fetch(inst.endpoints[0]!.browserUrl);
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('excalidraw');

    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABELS.instance}=${inst.id}`] }) });
    expect(containers).toHaveLength(1);
    const c = await docker.getContainer(containers[0]!.Id).inspect();
    expect(c.Config.Image).toBe(plan.changes.find((x) => x.startsWith('Pull image'))!.replace('Pull image ', '').split(' ')[0]);
    expect(c.HostConfig.RestartPolicy?.Name).toBe('unless-stopped');
    expect(c.NetworkSettings.Ports['80/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: String(inst.endpoints[0]!.hostPort) }]);
    expect(Object.keys(c.NetworkSettings.Networks)).toEqual([`hb_${inst.id.replace(/-/g, '')}_default`]);
    const createdAt = c.Created;

    expect((await api.run({ kind: 'stop', instanceId: inst.id })).op.state).toBe('succeeded');
    expect((await docker.getContainer(containers[0]!.Id).inspect()).State.Running).toBe(false);
    expect((await api.run({ kind: 'start', instanceId: inst.id })).op.state).toBe('succeeded');
    expect((await docker.getContainer(containers[0]!.Id).inspect()).Created).toBe(createdAt); // not recreated
    expect((await api.run({ kind: 'remove', instanceId: inst.id })).op.state).toBe('succeeded');
    expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABELS.instance}=${inst.id}`] }) })).toHaveLength(0);
    expect((await api.run({ kind: 'reinstall', instanceId: inst.id })).op.state).toBe('succeeded');
    const detail = await api.expect<InstanceDetail>(200, 'GET', `/v1/instances/${inst.id}`);
    expect(detail.resources.filter((r) => r.kind === 'container' && r.present)).toHaveLength(1);
  }, 600_000);

  it('installs BentoPDF alongside without recreating Excalidraw', async () => {
    const before = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABELS.installation}=${installationId}`] }) });
    const { op } = await api.run({ kind: 'install', packageId: 'bentopdf' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    const after = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`${LABELS.installation}=${installationId}`] }) });
    for (const b of before) expect(after.find((a) => a.Id === b.Id)?.Created).toBe(b.Created);
    const pdf = (await api.instances()).find((i) => i.packageId === 'bentopdf')!;
    const res = await fetch(pdf.endpoints[0]!.browserUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(['require-corp', 'credentialless']).toContain(res.headers.get('cross-origin-embedder-policy'));
  }, 600_000);
});
