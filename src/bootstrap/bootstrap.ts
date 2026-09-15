import { chownSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeConfig, type DaemonConfig } from '../config.js';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { enrollAdministrator, initState } from '../maintenance.js';
import { openState } from '../state/db.js';
import { Repo } from '../state/repo.js';
import { acquireLock } from '../state/lock.js';
import { loopbackPortFree } from '../docker/ports.js';
import { rfc3339, systemClock } from '../util.js';
import { dockerInstallPreview, installDocker } from './docker-install.js';
import { exec, execOk } from './exec.js';
import { assertSupportedHost, gatherHostFacts, RELEASE_MARKER, type HostFacts } from './host.js';
import { harborUnit, POLKIT_RULE_PATH, polkitPowerRule, SELF_UPDATE_UNIT_FILE, selfUpdateUnit, TAILSCALE_OPERATOR_UNIT, tailscaleOperatorUnit } from './systemd.js';
import { privateInterfaces, lanUrl as lanUrlFor } from '../system/lan.js';
import { readSetupCode, writeSetupCode } from '../auth/setup.js';
import { hostname as osHostname } from 'node:os';
import { caddyPreview, cockpitPreview, externalToolRecord, portainerPreview, setupCaddy, setupCockpit, setupPortainer, setupTailscale, tailscalePreview, type ToolRecord } from './tools.js';

export interface BootstrapOptions {
  releaseDir: string; // extracted archive root (contains bin/, dist/, node/, ...)
  yes: boolean;
  withTools: boolean;
  installDocker: boolean;
  port: number;
  adminUsername: string | null;
  passwordProvider: (() => Promise<string>) | null; // hidden prompt or stdin; null = keep existing/skip
  bindCockpit: string | null;
  bindPortainer: string | null;
  withTailscale: boolean;
  tailscaleAuthKey: string | null;
  withPublicProxy: boolean;
  // first-run in the browser: no administrator on the terminal; a setup code is printed for the wizard
  setupInBrowser: boolean;
  // LAN mode (home network): console on port 80 + app ports on every interface, mDNS name <hostname>.local
  lan: boolean;
  lanForce: boolean; // allow LAN mode without a private-network interface (cloud VM: everything becomes public)
  hostname: string | null; // set the machine's hostname (mDNS name becomes <hostname>.local)
  log: (m: string) => void;
  confirm: (question: string, preview: string[]) => Promise<boolean>;
}

export interface BootstrapResult {
  facts: HostFacts;
  installationId: string;
  adminCreated: boolean;
  setupCode: string | null; // when the administrator is created in the browser
  lanUrl: string | null;
  managementUrl: string;
  tools: ToolRecord[];
  versions: { harbor: string; node: string; docker: string | null; compose: string | null };
}

const CONFIG_FILE = `${PRODUCT.paths.etc}/harbor.json`;
const lanPort = 80; // LAN mode console port (plain http://<hostname>.local)

// Idempotent, root-only bootstrap. Every mutating step is previewed and approved (or --yes).
export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const log = opts.log;
  const facts = await gatherHostFacts();
  assertSupportedHost(facts);
  log(`host: ${facts.prettyName} ${facts.arch}, systemd ${facts.systemd ? 'yes' : 'no'}`);

  // 1. Conflicts with unrelated installations fail before anything is written.
  if (facts.existing.optDir === 'foreign') throw new HarborError('OWNERSHIP_CONFLICT', `${PRODUCT.paths.opt} exists but is not a Harbor release (no ${RELEASE_MARKER})`, { nextAction: 'Move or remove that directory manually; bootstrap never overwrites unrelated files.' });
  if (facts.existing.unit === 'foreign') throw new HarborError('OWNERSHIP_CONFLICT', `${PRODUCT.paths.systemdUnit} exists and was not written by Harbor bootstrap`, { nextAction: 'Remove or rename the conflicting unit manually.' });
  const release = readReleaseManifest(opts.releaseDir);
  const firstRun = !facts.existing.state;
  if (firstRun && !(await loopbackPortFree(opts.port))) {
    throw new HarborError('PORT_CONFLICT', `127.0.0.1:${opts.port} is already in use`, { nextAction: 'Re-run with --port <free port>.' });
  }
  if (!firstRun && facts.existing.config) {
    const existing = loadConfig(CONFIG_FILE);
    if (existing.listen.port !== opts.port && opts.port !== PRODUCT.defaults.managementPort) log(`keeping configured management port ${existing.listen.port} (existing installation); --port ignored`);
    opts.port = existing.listen.port;
  }

  // 2. Docker
  if (!facts.docker.binary || !facts.docker.daemonActive || !facts.docker.composeVersion) {
    const why = !facts.docker.binary ? 'Docker Engine is not installed' : !facts.docker.daemonActive ? 'Docker daemon is not running' : 'Docker Compose plugin is missing';
    if (!opts.installDocker) {
      throw new HarborError('DOCKER_UNAVAILABLE', why, {
        nextAction: facts.docker.binary
          ? 'Fix the existing Docker installation (systemctl start docker / install docker-compose-plugin). Bootstrap does not modify an existing Docker setup.'
          : 'Re-run with --install-docker to install Docker Engine + Compose from download.docker.com (separately approved), or install Docker yourself first.',
      });
    }
    if (facts.docker.binary) throw new HarborError('DOCKER_UNAVAILABLE', `${why}; --install-docker refuses to modify an existing Docker installation`, { nextAction: 'Repair Docker manually, then re-run bootstrap.' });
    if (!(await opts.confirm('Install Docker Engine and Compose from Docker\'s apt repository?', dockerInstallPreview()))) throw new HarborError('INVALID_REQUEST', 'Docker installation not approved');
    await installDocker(log);
    Object.assign(facts, await gatherHostFacts());
  } else {
    log(`Docker Engine ${facts.docker.version}, Compose ${facts.docker.composeVersion} found; not modified`);
  }

  // 2b. LAN mode sanity: on a cloud VM "every interface" means the public internet
  if (opts.lan && !opts.lanForce && privateInterfaces().length === 0) {
    throw new HarborError('UNSUPPORTED_CAPABILITY', 'LAN mode asked for, but this machine has no private-network address (it looks like a cloud server): its ports would face the internet', { nextAction: 'Leave LAN mode off here (use Tailscale or publishing), or pass --lan-force if you really want that.' });
  }

  // 3. Preview of the Harbor installation itself
  const preview = [
    `${facts.existing.optDir === 'harbor' ? `Replace release files in ${PRODUCT.paths.opt} (current ${facts.existing.optReleaseVersion ?? '?'} -> ${release.version})` : `Install release ${release.version} to ${PRODUCT.paths.opt}`}`,
    facts.existing.user ? `Keep service account ${PRODUCT.serviceUser}` : `Create system user ${PRODUCT.serviceUser} (nologin) and add it to the docker group (root-equivalent authority)`,
    `Ensure ${PRODUCT.paths.etc} (root:${PRODUCT.serviceUser} 0750), ${PRODUCT.paths.var} (${PRODUCT.serviceUser} 0700) and the data folder ${PRODUCT.paths.data} (${PRODUCT.serviceUser} 0755)`,
    facts.existing.config ? `Keep ${CONFIG_FILE}` : `Write ${CONFIG_FILE} (listen 127.0.0.1:${opts.port}, app ports ${PRODUCT.defaults.appPortRange.from}-${PRODUCT.defaults.appPortRange.to}, socket ${facts.docker.socket})`,
    facts.existing.state ? `Keep existing state in ${PRODUCT.paths.var} (apps, keys, administrator untouched)` : `Initialize fresh state in ${PRODUCT.paths.var}`,
    facts.existing.state ? 'Keep the existing administrator' : opts.setupInBrowser ? 'Create the administrator later in the browser (setup wizard with a printed setup code)' : `Enroll the local administrator (${opts.adminUsername ?? 'prompted'})`,
    ...(opts.hostname ? [`Set the machine hostname to ${opts.hostname} (mDNS name ${opts.hostname}.local)`] : []),
    ...(opts.lan ? [`LAN mode: install avahi (mDNS), console on port ${lanPort} and app ports on every interface of this machine`] : []),
    `${facts.existing.unit === 'harbor' ? 'Rewrite' : 'Install'} systemd unit ${PRODUCT.paths.systemdUnit} and (re)start it`,
  ];
  if (!(await opts.confirm('Apply the Harbor installation steps above?', preview))) throw new HarborError('INVALID_REQUEST', 'bootstrap not approved');

  // 4. Runtime files
  const unitActive = (await exec('/usr/bin/systemctl', ['is-active', PRODUCT.paths.systemdUnit], { timeoutMs: 10_000 })).stdout.trim() === 'active';
  if (unitActive) {
    log('stopping running daemon for the release update');
    await execOk('/usr/bin/systemctl', ['stop', PRODUCT.paths.systemdUnit], { timeoutMs: 60_000 });
  }
  try {
    return await bootstrapAfterStop(opts, { facts, release, log, unitActive });
  } catch (e) {
    if (unitActive) {
      // Never leave Harbor down because an upgrade step failed: bring the previous (or new) release back up.
      log(`bootstrap failed (${e instanceof Error ? e.message : String(e)}); restarting the daemon`);
      await exec('/usr/bin/systemctl', ['start', PRODUCT.paths.systemdUnit], { timeoutMs: 60_000 });
    }
    throw e;
  }
}

async function bootstrapAfterStop(opts: BootstrapOptions, s: { facts: Awaited<ReturnType<typeof gatherHostFacts>>; release: ReturnType<typeof readReleaseManifest>; log: (m: string) => void; unitActive: boolean }): Promise<BootstrapResult> {
  const { facts, release, log } = s;
  if (path.resolve(opts.releaseDir) !== PRODUCT.paths.opt) {
    replaceReleaseFiles(opts.releaseDir, PRODUCT.paths.opt);
    log(`installed release ${release.version} to ${PRODUCT.paths.opt}`);
  } else {
    log(`release already at ${PRODUCT.paths.opt}`);
  }
  await execOk('/usr/bin/chown', ['-R', 'root:root', PRODUCT.paths.opt]);

  // 5. Service account
  if (!facts.existing.user) {
    await execOk('/usr/sbin/useradd', ['--system', '--home-dir', PRODUCT.paths.var, '--no-create-home', '--shell', '/usr/sbin/nologin', '--comment', 'Harbor application manager', PRODUCT.serviceUser]);
    log(`created system user ${PRODUCT.serviceUser}`);
  }
  await execOk('/usr/sbin/usermod', ['-aG', 'docker', PRODUCT.serviceUser]);
  const uid = Number((await execOk('/usr/bin/id', ['-u', PRODUCT.serviceUser])).stdout.trim());
  const gid = Number((await execOk('/usr/bin/id', ['-g', PRODUCT.serviceUser])).stdout.trim());

  // 6. Directories (Harbor-owned only)
  mkdirSync(PRODUCT.paths.etc, { recursive: true, mode: 0o750 });
  chownSync(PRODUCT.paths.etc, 0, gid);
  mkdirSync(PRODUCT.paths.var, { recursive: true, mode: 0o700 });
  chownSync(PRODUCT.paths.var, uid, gid);
  // Harbor data folder: where the console lets people create folders for their apps' data.
  mkdirSync(PRODUCT.paths.data, { recursive: true, mode: 0o755 });
  chownSync(PRODUCT.paths.data, uid, gid);

  // 7. Config
  let config: DaemonConfig;
  if (!facts.existing.config) {
    const raw = {
      stateDir: PRODUCT.paths.var,
      catalogDir: `${PRODUCT.paths.opt}/catalog`,
      uiDir: `${PRODUCT.paths.opt}/web`,
      userDataDir: PRODUCT.paths.data,
      listen: { host: '127.0.0.1', port: opts.port },
      docker: { mode: 'socket', socketPath: facts.docker.socket, cliPluginDirs: [] },
      appPortRange: { ...PRODUCT.defaults.appPortRange },
      logLevel: 'info',
      lan: { enabled: opts.lan, port: lanPort },
    };
    config = normalizeConfig(raw, PRODUCT.paths.etc);
    writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', { mode: 0o640 });
    chownSync(CONFIG_FILE, 0, gid);
    log(`wrote ${CONFIG_FILE}`);
  } else {
    config = loadConfig(CONFIG_FILE);
    if (opts.lan && !config.lan.enabled) {
      // turning LAN mode on for an existing installation: rewrite the config, keep everything else
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
      raw['lan'] = { enabled: true, port: lanPort };
      writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n', { mode: 0o640 });
      config = loadConfig(CONFIG_FILE);
      log('LAN mode turned on in the config (apps installed before this keep answering on 127.0.0.1 until they are updated or reinstalled)');
    }
  }
  // hostname + mDNS
  if (opts.hostname && osHostname() !== opts.hostname) {
    await execOk('/usr/bin/hostnamectl', ['set-hostname', opts.hostname], { timeoutMs: 30_000 });
    try {
      const hosts = readFileSync('/etc/hosts', 'utf8');
      if (!new RegExp(`^127\\.0\\.1\\.1\\s+${opts.hostname}\\b`, 'm').test(hosts)) writeFileSync('/etc/hosts', hosts.trimEnd() + `\n127.0.1.1 ${opts.hostname}\n`);
    } catch {
      /* best effort */
    }
    log(`hostname set to ${opts.hostname}`);
  }
  if (config.lan.enabled) {
    const avahi = await exec('/usr/bin/dpkg-query', ['-W', '-f=${Status}', 'avahi-daemon'], { timeoutMs: 10_000 });
    if (!avahi.stdout.includes('install ok installed')) {
      log('installing avahi-daemon (mDNS: this machine answers as <hostname>.local on your network)');
      await execOk('/usr/bin/apt-get', ['install', '-y', '-q', 'avahi-daemon', 'libnss-mdns'], { timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
    }
    await execOk('/usr/bin/systemctl', ['enable', '--now', 'avahi-daemon'], { timeoutMs: 60_000 });
  }

  // 8. State (explicit initialization, never on accidental absence)
  let installationId: string;
  if (!facts.existing.state) {
    installationId = initState(config).installationId;
    log(`initialized state (installation ${installationId})`);
  } else {
    // Read-write on purpose: an older schema is migrated here (the daemon is stopped), a read-only open would refuse it.
    const lock = acquireLock(config.stateDir, 'bootstrap-state');
    try {
      const db = openState(config.stateDir);
      installationId = new Repo(db, systemClock).installation().id;
      db.close();
    } finally {
      lock.release();
    }
    chownTree(config.stateDir, uid, gid);
    log(`existing state found (installation ${installationId}); apps, keys and administrator preserved`);
  }

  // 9. Administrator: on the terminal, or later in the browser (setup wizard guarded by a printed code)
  let adminCreated = false;
  let setupCode: string | null = null;
  {
    const db = openState(config.stateDir);
    const hasAdmin = new Repo(db, systemClock).administrator() !== null;
    db.close();
    if (!hasAdmin) {
      if (opts.setupInBrowser || !opts.passwordProvider) {
        if (!opts.setupInBrowser) throw new HarborError('INVALID_REQUEST', 'no administrator enrolled and no password source', { nextAction: 'Run interactively, pass --password-stdin, or use --setup-in-browser to finish in the setup wizard.' });
        setupCode = readSetupCode(config.stateDir) ?? writeSetupCode(config.stateDir);
        log('administrator will be created in the browser (setup wizard)');
      } else {
        const username = opts.adminUsername ?? 'admin';
        const password = await opts.passwordProvider();
        await enrollAdministrator(config, username, password, { reset: false });
        adminCreated = true;
        log(`enrolled administrator ${username}`);
      }
    }
  }
  chownTree(config.stateDir, uid, gid);

  // 10. Tools (optional, separately approved)
  const tools: ToolRecord[] = [];
  const now = rfc3339(systemClock.now());
  // Optional tools must never leave Harbor itself down: the daemon was stopped above for the release
  // update, so a failing tool step is remembered here and rethrown only after the unit is (re)started.
  let toolFailure: unknown = null;
  try {
  if (opts.bindCockpit) tools.push(externalToolRecord('cockpit', opts.bindCockpit, now));
  if (opts.bindPortainer) tools.push(externalToolRecord('portainer', opts.bindPortainer, now));
  if (opts.withTools) {
    if (!opts.bindCockpit) {
      if (await opts.confirm('Set up Cockpit?', cockpitPreview(facts.existing.cockpit.installed))) tools.push(await setupCockpit(log, facts.existing.cockpit, now));
      else log('Cockpit skipped');
    }
    if (!opts.bindPortainer) {
      if (await opts.confirm('Set up Portainer?', portainerPreview(facts.existing.portainer.containerPresent))) {
        tools.push(await setupPortainer(log, installationId, facts.docker.binary!, facts.docker.socket, config.stateDir, facts.existing.portainer.containerPresent, now));
      } else log('Portainer skipped');
    }
  }
  if (opts.withTailscale) {
    if (await opts.confirm('Set up Tailscale (private-cloud access path)?', tailscalePreview(facts.existing.tailscale, Boolean(opts.tailscaleAuthKey)))) {
      tools.push(await setupTailscale(log, facts.existing.tailscale, opts.tailscaleAuthKey, now));
    } else log('Tailscale skipped');
  }
  if (opts.withPublicProxy) {
    if (await opts.confirm('Set up the public proxy (Caddy, HTTPS with Let\'s Encrypt)?', caddyPreview(facts.existing.caddy))) {
      tools.push(await setupCaddy(log, facts.existing.caddy, now));
    } else log('public proxy skipped');
  }
  if (tools.length) {
    const lock = acquireLock(config.stateDir, 'bootstrap-tools');
    try {
      const db = openState(config.stateDir);
      const repo = new Repo(db, systemClock);
      for (const t of tools) {
        // A re-run must not forget what the daemon recorded on the tool since (e.g. the console's tailnet
        // exposure lives in the tailscale record's resources): merge, bootstrap's facts win on conflict.
        const prev = repo.platformTool(t.id);
        repo.upsertPlatformTool({ ...t, resources: prev?.resources || t.resources ? { ...(prev?.resources ?? {}), ...(t.resources ?? {}) } : null });
      }
      db.close();
    } finally {
      lock.release();
    }
    chownTree(config.stateDir, uid, gid);
  }
  } catch (e) {
    toolFailure = e;
    log(`tool setup failed (${e instanceof Error ? e.message : String(e)}); Harbor itself is still being (re)started`);
  }

  // 11. systemd unit (+ the polkit rule that lets the console restart / shut down the machine)
  try {
    mkdirSync(path.dirname(POLKIT_RULE_PATH), { recursive: true });
    writeFileSync(POLKIT_RULE_PATH, polkitPowerRule(), { mode: 0o644 });
  } catch (e) {
    log(`could not install the polkit power rule (${(e as Error).message}); Restart/Shut down from the console will be refused`);
  }
  writeFileSync(`/etc/systemd/system/${PRODUCT.paths.systemdUnit}`, harborUnit({ lan: config.lan.enabled }), { mode: 0o644 });
  writeFileSync(`/etc/systemd/system/${TAILSCALE_OPERATOR_UNIT}`, tailscaleOperatorUnit(), { mode: 0o644 });
  writeFileSync(`/etc/systemd/system/${SELF_UPDATE_UNIT_FILE}`, selfUpdateUnit(), { mode: 0o644 });
  await execOk('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60_000 });
  await execOk('/usr/bin/systemctl', ['enable', PRODUCT.paths.systemdUnit], { timeoutMs: 60_000 });
  await execOk('/usr/bin/systemctl', ['restart', PRODUCT.paths.systemdUnit], { timeoutMs: 120_000 });
  const managementUrl = `http://localhost:${config.listen.port}`;
  const healthy = await waitHealthy(`${managementUrl}/healthz`, 60_000);
  if (!healthy) {
    const status = await exec('/usr/bin/systemctl', ['status', '--no-pager', '-n', '20', PRODUCT.paths.systemdUnit], { timeoutMs: 20_000 });
    throw new HarborError('OPERATION_FAILED', `daemon did not become healthy at ${managementUrl}/healthz`, { details: status.stdout.split('\n').slice(-20) });
  }
  log(`daemon healthy at ${managementUrl}`);
  if (toolFailure) throw toolFailure;

  const nodeVersion = (await exec(`${PRODUCT.paths.opt}/node/bin/node`, ['--version'], { timeoutMs: 10_000 })).stdout.trim();
  return { facts, installationId, adminCreated, setupCode, lanUrl: config.lan.enabled ? lanUrlFor(config.lan.port) : null, managementUrl, tools, versions: { harbor: release.version, node: nodeVersion, docker: facts.docker.version, compose: facts.docker.composeVersion } };
}

// Release files are replaced wholesale (state lives in /var/lib/harbor, config in /etc/harbor).
// Remove each previous entry first: copying over an existing tree with symlinks (node_modules/.bin) fails.
// Entries that no longer exist in the new release are removed too.
export function replaceReleaseFiles(releaseDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(releaseDir)) {
    const dest = path.join(targetDir, entry);
    rmSync(dest, { recursive: true, force: true });
    cpSync(path.join(releaseDir, entry), dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  for (const stale of readdirSync(targetDir)) {
    if (!existsSync(path.join(releaseDir, stale))) rmSync(path.join(targetDir, stale), { recursive: true, force: true });
  }
}

function readReleaseManifest(releaseDir: string): { version: string } {
  const file = path.join(releaseDir, RELEASE_MARKER);
  if (!existsSync(file)) throw new HarborError('INVALID_REQUEST', `${releaseDir} is not an extracted Harbor release (missing ${RELEASE_MARKER})`);
  const m = JSON.parse(readFileSync(file, 'utf8')) as { product?: string; version?: string };
  if (m.product !== PRODUCT.codename || !m.version) throw new HarborError('INVALID_REQUEST', `${file} is not a Harbor release manifest`);
  for (const required of ['bin/harbor', 'bin/harbor-daemon', 'dist/daemon.js', 'node/bin/node', 'catalog/index.json', 'web/index.html']) {
    if (!existsSync(path.join(releaseDir, required))) throw new HarborError('INVALID_REQUEST', `release is incomplete: missing ${required}`);
  }
  return { version: m.version };
}

// Ownership fix confined to Harbor's own state directory.
function chownTree(dir: string, uid: number, gid: number): void {
  chownSync(dir, uid, gid);
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) chownTree(p, uid, gid);
    else chownSync(p, uid, gid);
  }
}

async function waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function accessInstructions(port: number, toolPorts: number[], appPorts: number[]): string[] {
  const forwards = [port, ...appPorts, ...toolPorts].map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ');
  return [
    `Web UI (on this machine): http://localhost:${port}/`,
    `From another machine, forward the same port numbers over SSH (management, app ports, tools):`,
    `  ssh ${forwards} <user>@<this-host>`,
    'If a local port is busy on your machine, free it or choose a different local port and open http://localhost:<that-port>/ — the remote ports never change.',
    `CLI: ${PRODUCT.paths.opt}/bin/harbor login   (then: catalog, install <package>, list, tools)`,
  ];
}
