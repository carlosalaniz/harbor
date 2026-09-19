// `harbor uninstall`: remove Harbor itself from this host (root only).
// Every step is previewed and approved (or --yes). Only Harbor-owned things are
// touched: the systemd unit, Docker objects carrying the installation label,
// the four Harbor paths, the polkit rule, and the service account. Operator
// folders ("bind" resources), Docker itself, and optional tools installed from
// OS packages (Cockpit, Tailscale, Caddy) are left alone.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { DockerodeAdapter } from '../docker/dockerode-adapter.js';
import { HarborError } from '../errors.js';
import { LABELS, PRODUCT } from '../naming.js';
import { exec } from './exec.js';
import { gatherHostFacts, UNIT_MARKER, type HostFacts } from './host.js';
import { POLKIT_RULE_PATH, SELF_UPDATE_UNIT_FILE, TAILSCALE_OPERATOR_UNIT, TOOLS_INSTALL_UNIT } from './systemd.js';

export interface UninstallOptions {
  yes: boolean;
  keepData: boolean; // keep /var/lib/harbor (state, secrets, release snapshots)
  log: (m: string) => void;
  confirm: (question: string, preview: string[]) => Promise<boolean>;
}

export interface UninstallResult {
  removed: string[];
  kept: string[];
}

function unitIsOurs(unitPath: string): boolean {
  try {
    return readFileSync(unitPath, 'utf8').includes(UNIT_MARKER);
  } catch {
    return false;
  }
}

export function uninstallPreview(facts: HostFacts, opts: { keepData: boolean }): string[] {
  const lines = [
    `Stop and disable systemd unit ${PRODUCT.paths.systemdUnit} (only if written by Harbor bootstrap)`,
    `Remove Harbor-labelled Docker objects (label ${LABELS.installation}=<this installation>): containers (stop + remove), volumes, networks — including platform projects ${PRODUCT.platformProjectPrefix}*`,
    `Remove ${PRODUCT.paths.opt} (release files)`,
    `Remove ${PRODUCT.paths.etc} (daemon config)`,
    opts.keepData ? `Keep ${PRODUCT.paths.var} (state, secrets, release snapshots)` : `Remove ${PRODUCT.paths.var} (state, secrets, release snapshots — apps' data volumes are already gone above)`,
    `Remove ${PRODUCT.paths.data} only if empty (your folders inside it are never deleted)`,
    `Remove Harbor-owned systemd units (${TAILSCALE_OPERATOR_UNIT}, ${SELF_UPDATE_UNIT_FILE}, ${TOOLS_INSTALL_UNIT.replace('.service', '@.service')}) and ${POLKIT_RULE_PATH}`,
    `Delete service user ${PRODUCT.serviceUser}`,
    'Leave untouched: Docker Engine, Cockpit/Tailscale/Caddy packages, your own folders, non-Harbor Docker objects',
  ];
  if (facts.existing.unit === 'foreign') lines[0] = `Keep foreign systemd unit ${PRODUCT.paths.systemdUnit} (not written by Harbor bootstrap)`;
  if (facts.existing.optDir === 'foreign') lines[2] = `Keep foreign ${PRODUCT.paths.opt} (no Harbor release marker)`;
  return lines;
}

export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const log = opts.log;
  const facts = await gatherHostFacts();
  if (!facts.root) throw new HarborError('INVALID_REQUEST', 'uninstall must run as root (sudo)', { nextAction: 'Re-run with sudo.' });
  if (!facts.existing.config && !facts.existing.state && facts.existing.optDir === 'absent' && facts.existing.unit === 'absent' && !facts.existing.user) {
    throw new HarborError('NOT_FOUND', 'no Harbor installation found on this host', { nextAction: 'Nothing to remove.' });
  }

  const preview = uninstallPreview(facts, opts);
  if (!(await opts.confirm('Remove Harbor from this machine?', preview))) throw new HarborError('INVALID_REQUEST', 'uninstall not approved');

  const removed: string[] = [];
  const kept: string[] = [];

  // 1. Stop the daemon first so nothing recreates Docker objects while we delete them.
  // This also frees the management port, the LAN port, and every app port.
  const unitPath = `/etc/systemd/system/${PRODUCT.paths.systemdUnit}`;
  if (facts.existing.unit === 'harbor') {
    await exec('/usr/bin/systemctl', ['disable', '--now', PRODUCT.paths.systemdUnit], { timeoutMs: 120_000 });
    log(`stopped and disabled ${PRODUCT.paths.systemdUnit}`);
    removed.push(`systemd unit ${PRODUCT.paths.systemdUnit}`);
  } else if (facts.existing.unit === 'foreign') {
    kept.push(`foreign systemd unit ${PRODUCT.paths.systemdUnit}`);
  }

  // 2. Docker objects owned by this installation. The installation id comes from
  // state when present; otherwise fall back to sweeping every Harbor-labelled object.
  let installationId: string | null = null;
  if (facts.existing.state) {
    try {
      const { openState } = await import('../state/db.js');
      const { Repo } = await import('../state/repo.js');
      const { systemClock } = await import('../util.js');
      const db = openState(PRODUCT.paths.var, { readonly: true });
      try {
        installationId = new Repo(db, systemClock).installation().id;
      } finally {
        db.close();
      }
    } catch (e) {
      log(`could not read installation id from state (${(e as Error).message}); sweeping all Harbor-labelled objects`);
    }
  }
  if (facts.docker.binary && facts.docker.daemonActive) {
    const adapter = new DockerodeAdapter(facts.docker.socket);
    const labelFilter = installationId ? { [LABELS.installation]: installationId } : undefined;
    // Containers: stop then remove. Without an installation id, match the Harbor label prefix instead.
    const containers = labelFilter
      ? await adapter.listContainers({ all: true, labels: labelFilter })
      : (await adapter.listContainers({ all: true })).filter((c) => Object.keys(c.labels).some((k) => k.startsWith(PRODUCT.labelPrefix)));
    for (const c of containers) {
      if (c.state !== 'exited' && c.state !== 'created' && c.state !== 'dead') {
        try {
          await adapter.stopContainer(c.id, 15);
        } catch {
          /* already stopping */
        }
      }
      await adapter.removeContainer(c.id);
      log(`removed container ${c.name}`);
    }
    if (containers.length) removed.push(`${containers.length} container(s)`);
    // Volumes: only those carrying this installation's label (never by name).
    const volumes = labelFilter
      ? await adapter.listVolumes(labelFilter)
      : (await adapter.listVolumes()).filter((v) => Object.keys(v.labels).some((k) => k.startsWith(PRODUCT.labelPrefix)));
    for (const v of volumes) {
      await adapter.removeVolume(v.name);
      log(`removed volume ${v.name}`);
    }
    if (volumes.length) removed.push(`${volumes.length} volume(s)`);
    // Networks: only Harbor-labelled ones with no attached containers left.
    const networks = labelFilter
      ? await adapter.listNetworks(labelFilter)
      : (await adapter.listNetworks()).filter((n) => Object.keys(n.labels).some((k) => k.startsWith(PRODUCT.labelPrefix)));
    let networksRemoved = 0;
    for (const n of networks) {
      const fresh = await adapter.inspectNetwork(n.id);
      if (fresh && fresh.containerIds.length) {
        kept.push(`network ${n.name} (still has attached containers)`);
        continue;
      }
      await adapter.removeNetwork(n.id);
      log(`removed network ${n.name}`);
      networksRemoved += 1;
    }
    if (networksRemoved) removed.push(`${networksRemoved} network(s)`);
  } else {
    kept.push('Docker objects (Docker daemon not running; re-run uninstall once it is)');
  }

  // 3. Filesystem: Harbor-owned paths only. Foreign directories are never deleted.
  if (facts.existing.optDir === 'harbor') {
    rmSync(PRODUCT.paths.opt, { recursive: true, force: true });
    removed.push(PRODUCT.paths.opt);
  } else if (facts.existing.optDir === 'foreign') {
    kept.push(`foreign ${PRODUCT.paths.opt}`);
  }
  if (existsSync(PRODUCT.paths.etc)) {
    rmSync(PRODUCT.paths.etc, { recursive: true, force: true });
    removed.push(PRODUCT.paths.etc);
  }
  if (!opts.keepData && existsSync(PRODUCT.paths.var)) {
    rmSync(PRODUCT.paths.var, { recursive: true, force: true });
    removed.push(PRODUCT.paths.var);
  } else if (opts.keepData && existsSync(PRODUCT.paths.var)) {
    kept.push(`${PRODUCT.paths.var} (--keep-data)`);
  }
  // The data folder may hold the operator's own folders: remove only when empty.
  if (existsSync(PRODUCT.paths.data)) {
    const { readdirSync, rmdirSync } = await import('node:fs');
    try {
      if (readdirSync(PRODUCT.paths.data).length === 0) {
        rmdirSync(PRODUCT.paths.data);
        removed.push(`${PRODUCT.paths.data} (empty)`);
      } else {
        kept.push(`${PRODUCT.paths.data} (not empty; your folders left alone)`);
      }
    } catch {
      kept.push(`${PRODUCT.paths.data} (could not inspect; left alone)`);
    }
  }

  // 4. Harbor-owned systemd extras + polkit rule.
  for (const unit of [TAILSCALE_OPERATOR_UNIT, SELF_UPDATE_UNIT_FILE, TOOLS_INSTALL_UNIT.replace('.service', '@.service')]) {
    const p = `/etc/systemd/system/${unit}`;
    if (unitIsOurs(p)) {
      rmSync(p, { force: true });
      removed.push(`systemd unit ${unit}`);
    }
  }
  if (facts.existing.unit === 'harbor') rmSync(unitPath, { force: true });
  if (existsSync(POLKIT_RULE_PATH)) {
    try {
      if (readFileSync(POLKIT_RULE_PATH, 'utf8').includes(PRODUCT.serviceUser)) {
        rmSync(POLKIT_RULE_PATH, { force: true });
        removed.push(POLKIT_RULE_PATH);
      } else {
        kept.push(`foreign ${POLKIT_RULE_PATH}`);
      }
    } catch {
      kept.push(`unreadable ${POLKIT_RULE_PATH}`);
    }
  }
  await exec('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60_000 });

  // 5. Service account.
  if (facts.existing.user) {
    const r = await exec('/usr/sbin/userdel', [PRODUCT.serviceUser], { timeoutMs: 30_000 });
    if (r.code === 0) {
      removed.push(`user ${PRODUCT.serviceUser}`);
    } else {
      kept.push(`user ${PRODUCT.serviceUser} (userdel failed: ${(r.stderr || r.stdout).trim().slice(0, 200)})`);
    }
  }

  // 6. Optional tool packages stay installed (they are useful without Harbor).
  // The ports are free because the unit is stopped and every Harbor container is gone.
  log(`Harbor removed (${removed.length} item(s)); ${kept.length ? `kept: ${kept.join('; ')}` : 'nothing kept'}`);
  return { removed, kept };
}
