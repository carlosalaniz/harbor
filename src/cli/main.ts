import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import type { CatalogItemDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, PlanDto, PlatformToolDto, SystemDto, UiExposureDto } from '../contracts/api.js';
import { loadConfig } from '../config.js';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { enrollAdministrator, initState } from '../maintenance.js';
import { productVersion } from '../daemon.js';
import { ApiClient, clearCliState, readCliState, writeCliState } from './client.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm, promptHidden, promptVisible, readStdinAll } from './prompt.js';

interface Globals {
  url: string;
  json: boolean;
}

const program = new Command();
program
  .name(PRODUCT.cliName)
  .description(`${PRODUCT.displayName} — local self-hosted application manager (preview)`)
  .version(productVersion())
  .option('--url <url>', 'daemon URL', process.env['HARBOR_URL'] ?? readCliState()?.url ?? `http://localhost:${PRODUCT.defaults.managementPort}`)
  .option('--json', 'machine-readable output', false)
  .showHelpAfterError();

function globals(): Globals {
  return program.opts<Globals>();
}

function client(requireToken = true): ApiClient {
  const g = globals();
  const state = readCliState();
  const token = state && state.url === g.url ? (state.token ?? null) : null;
  if (requireToken && !token) throw new HarborError('UNAUTHENTICATED', 'not logged in', { nextAction: `Run \`${PRODUCT.cliName} login\`.` });
  return new ApiClient(g.url, token);
}

function out(value: unknown, human: () => string): void {
  if (globals().json) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else process.stdout.write(human() + '\n');
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n');
}

async function resolveInstance(api: ApiClient, ref: string): Promise<InstanceSummary> {
  const { items } = await api.get<{ items: InstanceSummary[] }>('/v1/instances');
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  const byName = items.filter((i) => i.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new HarborError('INVALID_REQUEST', `name ${ref} is ambiguous`);
  throw new HarborError('NOT_FOUND', `no instance named ${ref}`, { nextAction: `Run \`${PRODUCT.cliName} list\`.` });
}

function planSummary(p: PlanDto): string {
  const lines = [`Plan ${p.id} (${p.kind}) for "${p.name}" [${p.packageId} rev ${p.revision}] — expires ${p.expiresAt}`];
  for (const c of p.changes) lines.push(`  - ${c}`);
  if (p.endpoints.length) lines.push('  Endpoints: ' + p.endpoints.map((e) => `${e.id}=${e.browserUrl}`).join(', '));
  if (p.storage.length) lines.push('  Storage:   ' + p.storage.map((s) => `${s.volumeName} (${s.state})`).join(', '));
  if (p.secrets.length) lines.push('  Secrets:   ' + p.secrets.map((s) => `${s.id} (${s.state})`).join(', '));
  if (p.exposure) lines.push(`  Address:   ${p.exposure.url} via ${p.exposure.via}, protection ${p.exposure.protection}${p.exposure.makePrimary ? ', becomes primary' : ''}`);
  for (const w of p.warnings) lines.push(`  ! ${w}`);
  return lines.join('\n');
}

function operationSummary(o: OperationDto): string {
  const lines = [`Operation ${o.id}: ${o.kind} ${o.state} (${o.phase})`];
  const creds = o.result?.['credentials'] as { username: string; password: string } | undefined;
  if (o.result?.['url']) lines.push(`  Address: ${String(o.result['url'])} (${String(o.result['exposureState'] ?? '')})`);
  if (creds) lines.push(`  Basic-auth credentials (shown once, retained as an instance secret): ${creds.username} / ${creds.password}`);
  if (o.error) lines.push(`  ${o.error.code}: ${o.error.message}`, `  Next: ${o.error.nextAction}`);
  for (const e of o.events.slice(-12)) lines.push(`  ${e.at} ${e.phase.padEnd(12)} ${e.message}`);
  return lines.join('\n');
}

async function waitOperation(api: ApiClient, id: string, follow: boolean): Promise<OperationDto> {
  let lastCursor = '';
  while (true) {
    const op = await api.get<OperationDto>(`/v1/operations/${id}`);
    if (follow && !globals().json) {
      for (const e of op.events) {
        if (e.cursor > lastCursor || (e.cursor.length > lastCursor.length)) {
          if (Number(e.cursor) > Number(lastCursor || '0')) process.stderr.write(`  ${e.phase.padEnd(12)} ${e.message}\n`);
        }
      }
      if (op.events.length) lastCursor = op.events[op.events.length - 1]!.cursor;
    }
    if (op.state === 'succeeded' || op.state === 'failed' || op.state === 'needs_action') return op;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function approveAndApply(api: ApiClient, plan: PlanDto, opts: { yes?: boolean; wait?: boolean; idempotencyKey?: string }): Promise<void> {
  if (!globals().json) process.stderr.write(planSummary(plan) + '\n');
  if (!opts.yes) {
    const ok = await confirm('Apply this plan?');
    if (!ok) throw new HarborError('INVALID_REQUEST', 'plan not approved', { nextAction: 'Re-run with --yes to approve non-interactively.' });
  }
  const key = opts.idempotencyKey ?? `cli-${randomUUID()}`;
  let submitted: { operationId: string; created: boolean } | null = null;
  for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
    try {
      submitted = await api.post<{ operationId: string; created: boolean }>('/v1/operations', { planId: plan.id }, { 'idempotency-key': key });
    } catch (e) {
      // Transport failures retry with the same key; API errors do not.
      if (HarborError.is(e, 'STATE_UNAVAILABLE') && attempt < 2) continue;
      throw e;
    }
  }
  if (!submitted) throw new HarborError('STATE_UNAVAILABLE', 'submission failed');
  if (opts.wait === false) {
    out({ operationId: submitted.operationId, planId: plan.id, submitted: true }, () => `Submitted operation ${submitted!.operationId} (not waiting). Check with: ${PRODUCT.cliName} operation ${submitted!.operationId}`);
    return;
  }
  const op = await waitOperation(api, submitted.operationId, true);
  out(op, () => operationSummary(op));
  if (op.state !== 'succeeded') {
    // The operation (with its error) was already printed; exit with the error's category without a second document.
    alreadyReported = true;
    throw new HarborError((op.error?.code as HarborError['code']) ?? 'OPERATION_FAILED', op.error?.message ?? `${op.kind} ${op.state}`, { nextAction: op.error?.nextAction ?? '', operationId: op.id });
  }
}
let alreadyReported = false;

// ---------------- commands

program
  .command('login')
  .description('log in to the local daemon (password prompted without echo)')
  .option('--username <name>')
  .option('--password-stdin', 'read the password from stdin (protected automation pipe only)')
  .action(async (opts: { username?: string; passwordStdin?: boolean }) => {
    const api = client(false);
    const username = opts.username ?? (await promptVisible('Username: '));
    const password = opts.passwordStdin ? await readStdinAll() : await promptHidden('Password: ');
    const session = await api.post<{ token: string; expiresAt: string }>('/v1/sessions', { username, password });
    writeCliState({ url: api.baseUrl, token: session.token, expiresAt: session.expiresAt });
    out({ loggedIn: true, expiresAt: session.expiresAt }, () => `Logged in to ${api.baseUrl} (session expires ${session.expiresAt}).`);
  });

program
  .command('logout')
  .description('revoke the current session and delete the stored token')
  .action(async () => {
    const api = client(false);
    if (api.token) {
      try {
        await api.delete('/v1/sessions/current');
      } catch {
        /* token already invalid */
      }
    }
    clearCliState();
    out({ loggedOut: true }, () => 'Logged out.');
  });

program
  .command('catalog')
  .description('list bundled packages')
  .action(async () => {
    const { items } = await client().get<{ items: CatalogItemDto[] }>('/v1/catalog');
    out(items, () => table([['ID', 'NAME', 'REV', 'AVAILABILITY', 'QUALIFICATION', 'DESCRIPTION'], ...items.map((i) => [i.id, i.name, i.revision, i.availability + (i.reason ? ` (${i.reason})` : ''), i.qualification, i.description])]));
  });

program
  .command('list')
  .description('list instances including retained records')
  .action(async () => {
    const { items } = await client().get<{ items: InstanceSummary[] }>('/v1/instances');
    out(items, () =>
      items.length
        ? table([['NAME', 'PACKAGE', 'INSTALL', 'DESIRED', 'RUNTIME', 'READINESS', 'URL', 'ID'], ...items.map((i) => { const ep = i.endpoints.find((e) => e.id === i.primaryEndpoint); const u = ep ? (ep.urls[ep.primary as keyof typeof ep.urls] ?? ep.urls.loopback) : '-'; return [i.name, `${i.packageId}@${i.revision}`, i.installState, i.desired, i.runtime, i.readiness, u, i.id]; })])
        : 'No instances.',
    );
  });

program
  .command('inspect <instance>')
  .description('show one instance (by name or UUID) with resources, events and setup guidance')
  .action(async (ref: string) => {
    const api = client();
    const inst = await resolveInstance(api, ref);
    const d = await api.get<InstanceDetail>(`/v1/instances/${inst.id}`);
    out(d, () => {
      const lines = [
        `${d.name}  (${d.packageName} ${d.packageId}@${d.revision})  id ${d.id}`,
        `  install ${d.installState}  desired ${d.desired}  runtime ${d.runtime}  readiness ${d.readiness}  observed ${d.observedAt ?? '-'}`,
        ...d.endpoints.map((e) => `  endpoint ${e.id} (container port ${e.containerPort}, primary ${e.primary}): loopback ${e.urls.loopback}${e.urls.tailnet ? `, tailnet ${e.urls.tailnet}` : ''}${e.urls.public ? `, public ${e.urls.public}` : ''}`),
        ...(d.setup ? [`  setup: ${d.setup.instructions} -> ${d.setup.browserUrl}`] : []),
        ...(d.lastError ? [`  last error ${d.lastError.code}: ${d.lastError.message}`, `  next: ${d.lastError.nextAction}`] : []),
        '  resources:',
        ...d.resources.map((r) => `    ${r.kind.padEnd(9)} ${r.role.padEnd(12)} ${r.name} ${r.present === null ? '(unknown)' : r.present ? '' : '(absent)'}`),
        '  recent events:',
        ...d.events.slice(-10).map((e) => `    ${e.at} ${e.phase.padEnd(12)} ${e.message}`),
      ];
      return lines.join('\n');
    });
  });

program
  .command('plan <kind> [target]')
  .description('create a plan without applying it: plan install <package> [--name n] | plan start|stop|remove|reinstall <instance>')
  .option('--name <slug>', 'instance name for install')
  .action(async (kind: string, target: string | undefined, opts: { name?: string }) => {
    const api = client();
    const plan = await createPlan(api, kind, target, opts.name);
    out(plan, () => planSummary(plan) + `\nApply with: ${PRODUCT.cliName} apply ${plan.id} --idempotency-key <key>`);
  });

async function createPlan(api: ApiClient, kind: string, target: string | undefined, name?: string, extra: Record<string, unknown> = {}): Promise<PlanDto> {
  if (!target) throw new HarborError('INVALID_REQUEST', `${kind} requires a target`);
  if (kind === 'install') return api.post<PlanDto>('/v1/plans', { kind, packageId: target, ...(name ? { name } : {}) });
  if (!['start', 'stop', 'remove', 'reinstall', 'expose', 'unexpose', 'reconfigure'].includes(kind)) throw new HarborError('INVALID_REQUEST', `unknown plan kind ${kind}`);
  const inst = await resolveInstance(api, target);
  return api.post<PlanDto>('/v1/plans', { kind, instanceId: inst.id, ...extra });
}

program
  .command('apply <plan-id>')
  .description('submit an existing plan by ID')
  .requiredOption('--idempotency-key <key>', 'client-chosen key (8-128 chars) reused on retries')
  .option('--no-wait', 'return after submission')
  .option('--yes', 'approve without prompting', false)
  .action(async (planId: string, opts: { idempotencyKey: string; wait: boolean; yes: boolean }) => {
    const api = client();
    const plan = await api.get<PlanDto>(`/v1/plans/${planId}`);
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait, idempotencyKey: opts.idempotencyKey });
  });

program
  .command('install <package>')
  .description('plan and install a package (shows the plan and asks for confirmation)')
  .option('--name <slug>', 'instance name')
  .option('--yes', 'approve the shown plan non-interactively', false)
  .option('--no-wait', 'return the operation ID instead of waiting')
  .action(async (pkg: string, opts: { name?: string; yes: boolean; wait: boolean }) => {
    const api = client();
    const plan = await createPlan(api, 'install', pkg, opts.name);
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
  });

for (const kind of ['start', 'stop', 'remove', 'reinstall'] as const) {
  program
    .command(`${kind} <instance>`)
    .description(
      kind === 'remove'
        ? 'stop and delete containers; retain data volumes, secrets, name and ports'
        : kind === 'reinstall'
          ? 'reinstall the exact stored release into a removed (retained) instance'
          : `${kind} an installed instance`,
    )
    .option('--yes', 'approve without prompting', false)
    .option('--no-wait', 'return after submission')
    .action(async (ref: string, opts: { yes: boolean; wait: boolean }) => {
      const api = client();
      const plan = await createPlan(api, kind, ref);
      await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
    });
}

program
  .command('operation <id>')
  .description('show an operation; --follow waits for completion')
  .option('--follow', 'poll until the operation finishes', false)
  .action(async (id: string, opts: { follow: boolean }) => {
    const api = client();
    const op = opts.follow ? await waitOperation(api, id, true) : await api.get<OperationDto>(`/v1/operations/${id}`);
    out(op, () => operationSummary(op));
    if (opts.follow && op.state !== 'succeeded') process.exitCode = op.state === 'failed' ? 1 : 3;
  });

const exposuresTable = (items: ExposureDto[], ui: UiExposureDto | null) =>
  table([
    ['INSTANCE', 'ENDPOINT', 'VIA', 'URL', 'PROTECTION', 'STATE', 'PRIMARY', 'NOTE'],
    ...(ui ? [['(harbor ui)', '-', ui.via, ui.url, '-', ui.state, '-', ui.note ?? '']] : []),
    ...items.map((e) => [e.instanceName, e.endpointId, e.via, e.url, e.protection, e.state, e.isPrimary ? 'yes' : '', e.note ?? '']),
  ]);

program
  .command('exposures')
  .description('list published addresses (tailnet/public) and the UI exposure')
  .action(async () => {
    const r = await client().get<{ items: ExposureDto[]; ui: UiExposureDto | null }>('/v1/exposures');
    out(r, () => (r.items.length || r.ui ? exposuresTable(r.items, r.ui) : 'No exposures. Everything is loopback-only.'));
  });

program
  .command('expose [instance]')
  .description('publish an instance endpoint: --via tailnet (same port on your tailnet) or --via public --host <fqdn> (Caddy, Let\'s Encrypt); --ui exposes the Harbor UI on the tailnet')
  .requiredOption('--via <tailnet|public>')
  .option('--endpoint <id>', 'endpoint id (default: the package primary endpoint)')
  .option('--host <fqdn>', 'public hostname (public only)')
  .option('--protect <none|basic>', 'basic-auth protection (public only; default basic for apps without their own login)')
  .option('--primary', 'make this the primary address (re-renders apps that embed their base URL)', false)
  .option('--ui', 'expose the Harbor UI itself on the tailnet (never public)', false)
  .option('--yes', 'approve without prompting', false)
  .option('--no-wait', 'return after submission')
  .action(async (ref: string | undefined, opts: { via: string; endpoint?: string; host?: string; protect?: string; primary: boolean; ui: boolean; yes: boolean; wait: boolean }) => {
    const api = client();
    if (opts.ui) {
      if (opts.via !== 'tailnet') throw new HarborError('INVALID_REQUEST', 'the Harbor UI can only be exposed on the tailnet');
      const ui = await api.post<UiExposureDto>('/v1/ui-exposure', { via: 'tailnet' }, {}, 'PUT');
      out(ui, () => `Harbor UI exposed on the tailnet: ${ui.url}\nLog in from a device on your tailnet; tailnet ACLs govern access.`);
      return;
    }
    const plan = await createPlan(api, 'expose', ref, undefined, { via: opts.via, ...(opts.endpoint ? { endpointId: opts.endpoint } : {}), ...(opts.host ? { hostname: opts.host } : {}), ...(opts.protect ? { protection: opts.protect } : {}), ...(opts.primary ? { makePrimary: true } : {}) });
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
  });

program
  .command('unexpose [instance]')
  .description('withdraw a published address (--via tailnet|public); --ui withdraws the Harbor UI tailnet exposure')
  .requiredOption('--via <tailnet|public>')
  .option('--endpoint <id>')
  .option('--ui', 'withdraw the Harbor UI exposure', false)
  .option('--yes', 'approve without prompting', false)
  .option('--no-wait', 'return after submission')
  .action(async (ref: string | undefined, opts: { via: string; endpoint?: string; ui: boolean; yes: boolean; wait: boolean }) => {
    const api = client();
    if (opts.ui) {
      await api.delete('/v1/ui-exposure');
      out({ uiExposed: false }, () => 'Harbor UI tailnet exposure withdrawn.');
      return;
    }
    const plan = await createPlan(api, 'unexpose', ref, undefined, { via: opts.via, ...(opts.endpoint ? { endpointId: opts.endpoint } : {}) });
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
  });

program
  .command('primary <instance> <loopback|tailnet|public>')
  .description('choose which address an app treats as its base URL (re-renders and recreates containers if the package embeds it)')
  .option('--yes', 'approve without prompting', false)
  .option('--no-wait', 'return after submission')
  .action(async (ref: string, primary: string, opts: { yes: boolean; wait: boolean }) => {
    const api = client();
    const plan = await createPlan(api, 'reconfigure', ref, undefined, { primary });
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
  });

const toolsTable = (items: PlatformToolDto[]) => table([['TOOL', 'MODE', 'INSTALLED', 'REACHABLE', 'URL', 'OBSERVED', 'NOTE'], ...items.map((t) => [t.name, t.mode, t.installationState, t.availability, t.browserUrl ?? '-', t.observedAt ?? '-', t.note ?? ''])]);
const tools = program.command('tools').description('show Cockpit/Portainer state and links; `tools bind|unbind` manage bindings to existing installations');
tools.action(async () => {
  const { items } = await client().get<{ items: PlatformToolDto[] }>('/v1/platform-tools');
  out(items, () => toolsTable(items));
});
tools
  .command('bind <tool>')
  .description('record an already installed cockpit|portainer by its loopback URL (no ownership taken)')
  .requiredOption('--url <url>', 'e.g. https://localhost:9090/')
  .action(async (tool: string, opts: { url: string }) => {
    const { items } = await client().post<{ items: PlatformToolDto[] }>(`/v1/platform-tools/${tool}`, { browserUrl: opts.url }, {}, 'PUT');
    out(items, () => toolsTable(items));
  });
tools
  .command('unbind <tool>')
  .description('remove an external binding')
  .action(async (tool: string) => {
    await client().delete(`/v1/platform-tools/${tool}`);
    out({ unbound: tool }, () => `Removed binding for ${tool}.`);
  });

program
  .command('doctor')
  .description('check daemon liveness and system status')
  .action(async () => {
    const api = client(false);
    const live = await api.healthz();
    let system: SystemDto | null = null;
    let authError: string | null = null;
    if (live && api.token) {
      try {
        system = await api.get<SystemDto>('/v1/system');
      } catch (e) {
        authError = (e as Error).message;
      }
    }
    out({ url: api.baseUrl, live, loggedIn: Boolean(api.token), system, authError }, () => {
      const lines = [`Daemon ${api.baseUrl}: ${live ? 'live' : 'NOT REACHABLE'}`];
      if (!api.token) lines.push('Not logged in.');
      if (authError) lines.push(`Session check failed: ${authError} (run login)`);
      if (system) {
        lines.push(`Version ${system.version} profile ${system.profile}, installation ${system.installationId}`);
        lines.push(`Docker: ${system.docker.available ? `available (${system.docker.version})` : `unavailable (${system.docker.error ?? 'no observation yet'})`} observed ${system.docker.observedAt ?? '-'}`);
        lines.push(`Busy operation: ${system.busyOperationId ?? 'none'}`);
      }
      return lines.join('\n');
    });
    if (!live) process.exitCode = 4;
  });

// ---------------- bootstrap (root, Linux host)

program
  .command('bootstrap')
  .description('install or update Harbor on this Ubuntu 24.04 x86-64 host (run as root from the extracted release)')
  .option('--yes', 'approve all previewed steps non-interactively', false)
  .option('--with-tools', 'also set up Cockpit and Portainer (each separately approved)', false)
  .option('--install-docker', 'approve installing Docker Engine + Compose from download.docker.com if absent', false)
  .option('--port <n>', 'management port (default 18000; only for a fresh installation)', (v) => Number(v), PRODUCT.defaults.managementPort)
  .option('--admin-username <name>', 'administrator username for a fresh installation (default admin)')
  .option('--password-stdin', 'read the administrator password from stdin (protected pipe only)')
  .option('--bind-cockpit <url>', 'record an existing Cockpit at this loopback URL instead of installing it')
  .option('--bind-portainer <url>', 'record an existing Portainer at this loopback URL instead of installing it')
  .option('--with-tailscale', 'set up Tailscale for private-cloud (tailnet) exposure (separately approved)', false)
  .option('--tailscale-authkey-stdin', 'read a Tailscale auth key from stdin to log the node in non-interactively (protected pipe only; combine with --password-stdin: first line password, second line auth key)')
  .option('--with-public-proxy', 'set up Caddy for public HTTPS exposure (separately approved)', false)
  .option('--release-dir <dir>', 'extracted release directory (default: the one containing this CLI)')
  .action(async (opts: { yes: boolean; withTools: boolean; installDocker: boolean; port: number; adminUsername?: string; passwordStdin?: boolean; bindCockpit?: string; bindPortainer?: string; withTailscale: boolean; tailscaleAuthkeyStdin?: boolean; withPublicProxy: boolean; releaseDir?: string }) => {
    const { bootstrap, accessInstructions } = await import('../bootstrap/bootstrap.js');
    const releaseDir = opts.releaseDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const log = (m: string) => process.stderr.write(`[bootstrap] ${m}\n`);
    const confirmStep = async (question: string, preview: string[]) => {
      process.stderr.write(`\n${question}\n${preview.map((p) => `  - ${p}`).join('\n')}\n`);
      if (opts.yes) {
        process.stderr.write('  (approved with --yes)\n');
        return true;
      }
      return confirm('Proceed?');
    };
    let passwordProvider: (() => Promise<string>) | null = null;
    let tailscaleAuthKey: string | null = null;
    if (opts.passwordStdin || opts.tailscaleAuthkeyStdin) {
      // stdin lines: [password] [tailscale auth key] — only the requested ones are read.
      const lines = (await readStdinAll()).split('\n');
      const pw = opts.passwordStdin ? (lines.shift() ?? '') : null;
      if (pw !== null) passwordProvider = async () => pw;
      if (opts.tailscaleAuthkeyStdin) tailscaleAuthKey = (lines.shift() ?? '').trim() || null;
    }
    else if (process.stdin.isTTY) {
      passwordProvider = async () => {
        const p1 = await promptHidden('Administrator password (min 12 chars): ');
        const p2 = await promptHidden('Repeat password: ');
        if (p1 !== p2) throw new HarborError('INVALID_REQUEST', 'passwords do not match');
        return p1;
      };
    }
    const result = await bootstrap({
      releaseDir,
      yes: opts.yes,
      withTools: opts.withTools,
      installDocker: opts.installDocker,
      port: opts.port,
      adminUsername: opts.adminUsername ?? null,
      passwordProvider,
      bindCockpit: opts.bindCockpit ?? null,
      bindPortainer: opts.bindPortainer ?? null,
      withTailscale: opts.withTailscale,
      tailscaleAuthKey,
      withPublicProxy: opts.withPublicProxy,
      log,
      confirm: confirmStep,
    });
    const toolPorts = result.tools.map((t) => (t.browserUrl ? Number(new URL(t.browserUrl).port || (t.browserUrl.startsWith('https') ? 443 : 80)) : 0)).filter(Boolean);
    const summary = {
      managementUrl: result.managementUrl,
      installationId: result.installationId,
      adminCreated: result.adminCreated,
      versions: result.versions,
      tools: result.tools.map((t) => ({ id: t.id, mode: t.mode, browserUrl: t.browserUrl, installationState: t.installationState, note: t.note })),
    };
    out(summary, () =>
      [
        `Harbor ${result.versions.harbor} installed (node ${result.versions.node}, docker ${result.versions.docker ?? '?'}, compose ${result.versions.compose ?? '?'}).`,
        `Installation ${result.installationId}; administrator ${result.adminCreated ? 'enrolled' : 'kept'}.`,
        ...result.tools.map((t) => `${t.id}: ${t.mode} ${t.installationState} ${t.browserUrl ?? ''}\n    ${t.note ?? ''}`),
        '',
        ...accessInstructions(Number(new URL(result.managementUrl).port), toolPorts, [PRODUCT.defaults.appPortRange.from, PRODUCT.defaults.appPortRange.from + 1, PRODUCT.defaults.appPortRange.from + 2]),
      ].join('\n'),
    );
  });

// ---------------- local maintenance (direct state access, no HTTP)

program
  .command('init')
  .description('explicitly initialize a fresh state directory for the given config (never overwrites)')
  .requiredOption('--config <file>', 'daemon config JSON')
  .action((opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const r = initState(cfg);
    out({ initialized: true, installationId: r.installationId, stateDir: cfg.stateDir }, () => `Initialized state at ${cfg.stateDir} (installation ${r.installationId}).`);
  });

program
  .command('enroll')
  .description('enroll (or with --reset, replace) the single local administrator; requires the daemon to be stopped for --reset')
  .requiredOption('--config <file>', 'daemon config JSON')
  .option('--username <name>')
  .option('--password-stdin', 'read the password from stdin (protected pipe only)')
  .option('--reset', 'replace existing credentials and revoke all sessions', false)
  .action(async (opts: { config: string; username?: string; passwordStdin?: boolean; reset: boolean }) => {
    const cfg = loadConfig(opts.config);
    const username = opts.username ?? (await promptVisible('Administrator username: '));
    let password: string;
    if (opts.passwordStdin) password = await readStdinAll();
    else {
      password = await promptHidden('Password (min 12 chars): ');
      const again = await promptHidden('Repeat password: ');
      if (password !== again) throw new HarborError('INVALID_REQUEST', 'passwords do not match');
    }
    const r = await enrollAdministrator(cfg, username, password, { reset: opts.reset });
    out({ username, created: r.created, revokedSessions: r.revokedSessions }, () => `${r.created ? 'Enrolled' : 'Reset'} administrator ${username}${r.revokedSessions ? ` (revoked ${r.revokedSessions} session(s))` : ''}.`);
  });

program.addOption(new Option('--no-color').hideHelp());

export async function runCli(argv: string[]): Promise<number> {
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (e) {
    if (e instanceof HarborError) {
      if (alreadyReported) return e.exitCode;
      if (globals().json) process.stdout.write(JSON.stringify(e.toBody(), null, 2) + '\n');
      else {
        process.stderr.write(`error ${e.code}: ${e.message}\n`);
        for (const d of e.details.slice(0, 5)) process.stderr.write(`  - ${d}\n`);
        if (e.nextAction) process.stderr.write(`next: ${e.nextAction}\n`);
        if (e.operationId) process.stderr.write(`operation: ${e.operationId}\n`);
      }
      return e.exitCode;
    }
    if ((e as { code?: string }).code === 'commander.helpDisplayed' || (e as { code?: string }).code === 'commander.version') return 0;
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && /cli\/main\.(js|ts)$|\/harbor$/.test(process.argv[1])) {
  runCli(process.argv).then((code) => process.exit(code));
}
