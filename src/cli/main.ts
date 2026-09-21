import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import type { AddSourceResult, CatalogItemDto, DomainDto, DomainsDto, ExposureDto, InstanceDetail, InstanceSummary, OperationDto, PackageSourceDto, PlanDto, PlatformToolDto, SystemDto, UiExposureDto, AppearanceDto, PackageImportResultDto, SelfUpdateStatusDto } from '../contracts/api.js';
import { loadConfig } from '../config.js';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { enrollAdministrator, initState, resetTwoFactor } from '../maintenance.js';
import { readSetupCode } from '../auth/setup.js';
import { productVersion } from '../daemon.js';
import { ApiClient, clearCliState, readCliState, writeCliState } from './client.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
  if (p.location) lines.push(`  Lives on:  ${p.location.dir} (whole app, encrypted)`);
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

async function approveAndApply(api: ApiClient, plan: PlanDto, opts: { yes?: boolean; wait?: boolean; idempotencyKey?: string; passphrase?: string | undefined }): Promise<void> {
  if (!globals().json) process.stderr.write(planSummary(plan) + '\n');
  if (!opts.yes) {
    const ok = await confirm('Apply this plan?');
    if (!ok) throw new HarborError('INVALID_REQUEST', 'plan not approved', { nextAction: 'Re-run with --yes to approve non-interactively.' });
  }
  const key = opts.idempotencyKey ?? `cli-${randomUUID()}`;
  let submitted: { operationId: string; created: boolean } | null = null;
  for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
    try {
      submitted = await api.post<{ operationId: string; created: boolean }>('/v1/operations', opts.passphrase ? { planId: plan.id, passphrase: opts.passphrase } : { planId: plan.id }, { 'idempotency-key': key });
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
  .option('--password-stdin', 'read the password from stdin (protected automation pipe only; a second line may carry the two-factor code)')
  .option('--code <digits>', 'two-factor code when it is turned on')
  .action(async (opts: { username?: string; passwordStdin?: boolean; code?: string }) => {
    const api = client(false);
    const username = opts.username ?? (await promptVisible('Username: '));
    const stdinLines = opts.passwordStdin ? (await readStdinAll()).split('\n') : null;
    const password = stdinLines ? (stdinLines[0] ?? '') : await promptHidden('Password: ');
    let code = opts.code ?? (stdinLines?.[1]?.trim() || undefined);
    let session: { token: string; expiresAt: string };
    try {
      session = await api.post<{ token: string; expiresAt: string }>('/v1/sessions', { username, password, ...(code ? { code } : {}) });
    } catch (e) {
      if (!(e instanceof HarborError) || e.code !== 'TOTP_REQUIRED' || stdinLines) throw e;
      code = (await promptVisible('Two-factor code: ')).trim();
      session = await api.post<{ token: string; expiresAt: string }>('/v1/sessions', { username, password, code });
    }
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
    const folders = (i: CatalogItemDto) => i.claims.filter((c) => c.external).map((c) => `${c.id}${c.external?.required ? ' (required)' : ''}${c.external?.readOnly ? ' (ro)' : ''}`).join(', ') || '-';
    out(items, () => table([['ID', 'NAME', 'REV', 'VERSION', 'ORIGIN', 'AVAILABILITY', 'QUALIFICATION', 'OWN-FOLDER CLAIMS', 'DESCRIPTION'], ...items.map((i) => [i.id, i.name, i.revision, i.version ?? '-', i.origin === 'local' ? 'yours' : 'built-in', i.availability + (i.reason ? ` (${i.reason})` : ''), i.qualification, folders(i), i.description])]));
  });

program
  .command('list')
  .description('list instances including retained records')
  .action(async () => {
    const { items } = await client().get<{ items: InstanceSummary[] }>('/v1/instances');
    out(items, () =>
      items.length
        ? table([['NAME', 'PACKAGE', 'UPDATE', 'INSTALL', 'DESIRED', 'RUNTIME', 'READINESS', 'URL', 'ID'], ...items.map((i) => { const ep = i.endpoints.find((e) => e.id === i.primaryEndpoint); const u = ep ? (ep.urls[ep.primary as keyof typeof ep.urls] ?? ep.urls.loopback) : '-'; return [i.name, `${i.packageId}@${i.revision}`, i.updateAvailable ? `-> ${i.updateAvailable.revision}${i.updateAvailable.version ? ` (${i.updateAvailable.version})` : ''}` : '-', i.installState, i.desired, i.runtime, i.readiness, u, i.id]; })])
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
  .option('--location <dir>', 'install the whole app encrypted in this folder (on a drive)')
  .option('--passphrase-stdin', 'read the app encryption passphrase from stdin (with --location)', false)
  .action(async (kind: string, target: string | undefined, opts: { name?: string; location?: string; passphraseStdin?: boolean }) => {
    const api = client();
    const extra: Record<string, unknown> = {};
    if (opts.location) {
      if (kind !== 'install') throw new HarborError('INVALID_REQUEST', '--location only applies to install');
      const passphrase = opts.passphraseStdin ? await readStdinAll() : await promptHidden('App encryption passphrase (8+ characters): ');
      extra['location'] = { dir: opts.location, passphrase: passphrase.trim() };
    }
    const plan = await createPlan(api, kind, target, opts.name, extra);
    out(plan, () => planSummary(plan) + `\nApply with: ${PRODUCT.cliName} apply ${plan.id} --idempotency-key <key>${opts.location ? ' --passphrase-stdin < passphrase.txt' : ''}`);
  });

async function createPlan(api: ApiClient, kind: string, target: string | undefined, name?: string, extra: Record<string, unknown> = {}): Promise<PlanDto> {
  if (!target) throw new HarborError('INVALID_REQUEST', `${kind} requires a target`);
  if (kind === 'install') return api.post<PlanDto>('/v1/plans', { kind, packageId: target, ...(name ? { name } : {}), ...extra });
  if (!['start', 'stop', 'remove', 'reinstall', 'purge', 'update', 'expose', 'unexpose', 'reconfigure'].includes(kind)) throw new HarborError('INVALID_REQUEST', `unknown plan kind ${kind}`);
  const inst = await resolveInstance(api, target);
  return api.post<PlanDto>('/v1/plans', { kind, instanceId: inst.id, ...extra });
}

program
  .command('apply <plan-id>')
  .description('submit an existing plan by ID')
  .requiredOption('--idempotency-key <key>', 'client-chosen key (8-128 chars) reused on retries')
  .option('--no-wait', 'return after submission')
  .option('--yes', 'approve without prompting', false)
  .option('--passphrase-stdin', 'read the app encryption passphrase from stdin (for plans with an install location)', false)
  .action(async (planId: string, opts: { idempotencyKey: string; wait: boolean; yes: boolean; passphraseStdin?: boolean }) => {
    const api = client();
    const plan = await api.get<PlanDto>(`/v1/plans/${planId}`);
    const passphrase = plan.location && opts.passphraseStdin ? (await readStdinAll()).trim() : plan.location ? await promptHidden('App encryption passphrase: ') : undefined;
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait, idempotencyKey: opts.idempotencyKey, passphrase });
  });

program
  .command('install <package>')
  .description('plan and install a package (shows the plan and asks for confirmation)')
  .option('--name <slug>', 'instance name')
  .option('--storage <claim=/host/path>', 'use your own folder for a storage claim the package marks as external (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--location <dir>', 'install the whole app encrypted in this folder (on a drive)')
  .option('--passphrase-stdin', 'read the app encryption passphrase from stdin (with --location)', false)
  .option('--yes', 'approve the shown plan non-interactively', false)
  .option('--no-wait', 'return the operation ID instead of waiting')
  .action(async (pkg: string, opts: { name?: string; storage: string[]; location?: string; passphraseStdin?: boolean; yes: boolean; wait: boolean }) => {
    const api = client();
    const storage: Record<string, { hostPath: string }> = {};
    for (const s of opts.storage) {
      const eq = s.indexOf('=');
      if (eq <= 0) throw new HarborError('INVALID_REQUEST', `--storage expects <claim>=<path>, got ${s}`);
      storage[s.slice(0, eq)] = { hostPath: s.slice(eq + 1) };
    }
    const extra: Record<string, unknown> = Object.keys(storage).length ? { storage } : {};
    let passphrase: string | undefined;
    if (opts.location) {
      passphrase = opts.passphraseStdin ? (await readStdinAll()).trim() : await promptHidden('App encryption passphrase (8+ characters): ');
      extra['location'] = { dir: opts.location, passphrase };
    }
    const plan = await createPlan(api, 'install', pkg, opts.name, extra);
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait, passphrase });
  });

program
  .command('update <instance>')
  .description('update an installed app to the newest revision of its package (bundled after a Harbor upgrade, or uploaded); keeps data, ports and addresses; rolls back automatically if the new release does not start')
  .option('--storage <claim=/host/path>', 'folder for a storage claim the new release adds (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--yes', 'approve the shown plan non-interactively', false)
  .option('--no-wait', 'return after submission')
  .action(async (ref: string, opts: { storage: string[]; yes: boolean; wait: boolean }) => {
    const api = client();
    const storage: Record<string, { hostPath: string }> = {};
    for (const s of opts.storage) {
      const eq = s.indexOf('=');
      if (eq <= 0) throw new HarborError('INVALID_REQUEST', `--storage expects <claim>=<path>, got ${s}`);
      storage[s.slice(0, eq)] = { hostPath: s.slice(eq + 1) };
    }
    const plan = await createPlan(api, 'update', ref, undefined, Object.keys(storage).length ? { storage } : {});
    await approveAndApply(api, plan, { yes: opts.yes, wait: opts.wait });
  });

const packagesCmd = program.command('packages').description('your own apps: list, add a package zip, remove one');
packagesCmd.action(async () => {
  const { items } = await client().get<{ items: CatalogItemDto[] }>('/v1/catalog');
  const mine = items.filter((i) => i.origin === 'local');
  out(mine, () => (mine.length ? table([['ID', 'NAME', 'REV', 'VERSION', 'AVAILABILITY'], ...mine.map((i) => [i.id, i.name, i.revision, i.version ?? '-', i.availability + (i.reason ? ` (${i.reason})` : '')])]) : 'No uploaded packages. Add one with: harbor packages add <file.zip>'));
});
packagesCmd
  .command('add <zip>')
  .description('upload a package zip (manifest.yaml, compose.yaml, README.md, icon…); tag images are pinned by digest for you')
  .action(async (file: string) => {
    const bytes = readFileSync(file);
    const r = await client().post<PackageImportResultDto>('/v1/packages', { fileName: path.basename(file), dataUrl: `data:application/zip;base64,${bytes.toString('base64')}` });
    out(r, () =>
      [
        `${r.item.name} (${r.item.id}) revision ${r.item.revision}${r.item.version ? ` version ${r.item.version}` : ''} is in your App Store${r.replacedRevision ? ` (replaces revision ${r.replacedRevision})` : ''}.`,
        ...r.pinned.map((p) => `  pinned ${p.service}: ${p.from} -> ${p.to}`),
        ...r.notes.map((n) => `  note: ${n}`),
        ...(r.updatable.length ? [`  updates available for: ${r.updatable.map((u) => `${u.name} (rev ${u.fromRevision})`).join(', ')} — run: harbor update <name>`] : []),
        `Install with: harbor install ${r.item.id}`,
      ].join('\n'),
    );
  });
packagesCmd
  .command('remove <id>')
  .description('remove an uploaded package (refused while an app installed from it exists)')
  .action(async (id: string) => {
    await client().delete(`/v1/packages/${encodeURIComponent(id)}`);
    out({ removed: id }, () => `Removed uploaded package ${id}.`);
  });

// Git app sources (decision 80): point Harbor at a repository, pin to a branch, optionally redeploy on commit.
const sourcesCmd = program.command('sources').description('git app sources: add a repository, check for commits, toggle redeploy-on-commit');
sourcesCmd.action(async () => {
  const { items } = await client().get<{ items: PackageSourceDto[] }>('/v1/package-sources');
  out(items, () =>
    items.length
      ? table([
          ['APP', 'REPOSITORY', 'BRANCH', 'COMMIT', 'REDEPLOY', 'STATE'],
          ...items.map((s) => [s.packageId, s.url.replace(/^https:\/\//, ''), s.ref + (s.subpath ? ` (${s.subpath})` : ''), s.pinnedCommit?.slice(0, 12) ?? '-', s.autoRedeploy ? 'on commit' : 'manual', s.note ? `⚠ ${s.note}` : s.updateAvailable ? 'new commit seen' : 'up to date']),
        ])
      : 'No git sources. Add one with: harbor sources add https://github.com/you/your-app',
  );
});
sourcesCmd
  .command('add <url>')
  .description('fetch the repository, import its harbor/ folder as a package (services may build from source)')
  .option('--branch <ref>', 'branch to follow', 'main')
  .option('--path <subpath>', 'folder inside the repository that holds the app')
  .option('--auto-redeploy', 'deploy new commits automatically (failed deployments roll back)', false)
  .action(async (url: string, opts: { branch: string; path?: string; autoRedeploy: boolean }) => {
    const r = await client().post<AddSourceResult>('/v1/package-sources', { url, ref: opts.branch, ...(opts.path ? { subpath: opts.path } : {}), autoRedeploy: opts.autoRedeploy });
    out(r, () =>
      [
        `${r.import.item.name} (${r.import.item.id}) revision ${r.import.item.revision} imported from ${r.source.url}@${r.source.pinnedCommit?.slice(0, 12)}.`,
        ...r.import.pinned.map((p) => `  pinned ${p.service}: ${p.from} -> ${p.to}`),
        ...r.import.notes.map((n) => `  note: ${n}`),
        r.source.autoRedeploy ? '  new commits deploy automatically (a failed deployment rolls back).' : `  new commits only notify; redeploy with: harbor update <instance> after a check.`,
        `Install with: harbor install ${r.import.item.id}`,
      ].join('\n'),
    );
  });
sourcesCmd
  .command('check <app-id>')
  .description('fetch the branch head now; a newer commit becomes an update for installed apps')
  .action(async (appId: string) => {
    const { items } = await client().get<{ items: PackageSourceDto[] }>('/v1/package-sources');
    const s = items.find((x) => x.packageId === appId);
    if (!s) throw new HarborError('NOT_FOUND', `no source for app ${appId}`);
    const r = await client().post<PackageSourceDto>(`/v1/package-sources/${s.id}/check`, {});
    out(r, () => (r.note ? `Checked: ${r.note}` : r.pinnedCommit === s.pinnedCommit ? `Up to date at ${r.pinnedCommit?.slice(0, 12)}.` : `Imported commit ${r.pinnedCommit?.slice(0, 12)} as a new revision; installed apps now show an update.`));
  });
sourcesCmd
  .command('redeploy <app-id> <on|off>')
  .description('toggle redeploy-on-commit for the source of this app')
  .action(async (appId: string, mode: string) => {
    if (mode !== 'on' && mode !== 'off') throw new HarborError('INVALID_REQUEST', 'use on or off');
    const { items } = await client().get<{ items: PackageSourceDto[] }>('/v1/package-sources');
    const s = items.find((x) => x.packageId === appId);
    if (!s) throw new HarborError('NOT_FOUND', `no source for app ${appId}`);
    const r = await client().post<PackageSourceDto>(`/v1/package-sources/${s.id}/auto-redeploy`, { enabled: mode === 'on' }, {}, 'PUT');
    out(r, () => `Redeploy-on-commit is ${r.autoRedeploy ? 'on' : 'off'} for ${appId}.`);
  });
sourcesCmd
  .command('remove <app-id>')
  .description('forget the repository link (the package and installed apps stay)')
  .action(async (appId: string) => {
    const { items } = await client().get<{ items: PackageSourceDto[] }>('/v1/package-sources');
    const s = items.find((x) => x.packageId === appId);
    if (!s) throw new HarborError('NOT_FOUND', `no source for app ${appId}`);
    await client().delete(`/v1/package-sources/${s.id}`);
    out({ removed: appId }, () => `Removed the source of ${appId}; the package and installed apps stay.`);
  });

program
  .command('purge <instance>')
  .description('full uninstall: remove the app AND delete its data volumes, secrets and stored release (your own folders are untouched); frees the name and ports')
  .option('--yes', 'skip the typed confirmation', false)
  .option('--no-wait', 'return after submission')
  .action(async (ref: string, opts: { yes: boolean; wait: boolean }) => {
    const api = client();
    const plan = await createPlan(api, 'purge', ref);
    if (!opts.yes) {
      const typed = await promptVisible(`This deletes the data of "${plan.name}" for good. Type the instance name to confirm: `);
      if (typed.trim() !== plan.name) throw new HarborError('INVALID_REQUEST', 'confirmation did not match; nothing was done');
    }
    await approveAndApply(api, plan, { yes: true, wait: opts.wait });
  });

const domainsCmd = program.command('domains').description('public domains for publishing: register, check DNS, forget');
domainsCmd.action(async () => {
  const d = await client().get<DomainsDto>('/v1/domains');
  out(d, () => [`This machine's public address: ${d.publicIp.v4 ?? '?'}${d.publicIp.v6 ? ` / ${d.publicIp.v6}` : ''}${d.publicIp.error ? ` (${d.publicIp.error})` : ''}`, table([['DOMAIN', 'DNS', 'RESOLVES TO', 'USED BY', 'CHECKED'], ...d.items.map((i) => [i.hostname, i.dns.state.replace('_', ' '), i.dns.addresses.join(', ') || '-', i.usedBy ? `${i.usedBy.instanceName} (${i.usedBy.exposureState})` : '-', i.dns.checkedAt ?? '-'])])].join('\n'));
});
domainsCmd
  .command('add <hostname>')
  .description('register a domain you own and check that it points at this machine')
  .action(async (hostname: string) => {
    const d = await client().post<DomainDto>('/v1/domains', { hostname });
    out(d, () => `${d.hostname}: ${d.dns.state.replace('_', ' ')}${d.dns.note ? ` — ${d.dns.note}` : ''}`);
  });
domainsCmd
  .command('check <hostname>')
  .description('re-check a registered domain')
  .action(async (hostname: string) => {
    const d = await client().post<DomainDto>(`/v1/domains/${hostname}/check`, {});
    out(d, () => `${d.hostname}: ${d.dns.state.replace('_', ' ')}${d.dns.note ? ` — ${d.dns.note}` : ''}`);
  });
domainsCmd
  .command('forget <hostname>')
  .description('forget a registered domain (refused while an app is published at it)')
  .action(async (hostname: string) => {
    await client().delete(`/v1/domains/${hostname}`);
    out({ hostname, forgotten: true }, () => `${hostname} forgotten.`);
  });

program
  .command('found-apps')
  .description('list encrypted apps found on attached drives that are not installed here yet')
  .action(async () => {
    const { items } = await client().get<{ items: Array<{ home: string; displayName: string; packageId: string; drive: string; adopted: boolean; error: string | null }> }>('/v1/found-apps');
    const fresh = items.filter((i) => !i.adopted);
    out(items, () => (fresh.length ? table([['APP', 'PACKAGE', 'DRIVE', 'HOME'], ...fresh.map((i) => [i.displayName, i.packageId, i.drive, i.home])]) : 'No apps waiting on your drives.'));
  });

program
  .command('adopt <home>')
  .description('adopt an encrypted app from a drive with its passphrase (works on any Harbor machine)')
  .option('--name <slug>', 'instance name')
  .option('--passphrase-stdin', 'read the app passphrase from stdin', false)
  .option('--no-wait', 'return the operation ID instead of waiting')
  .action(async (home: string, opts: { name?: string; passphraseStdin?: boolean; wait: boolean }) => {
    const api = client();
    const passphrase = opts.passphraseStdin ? (await readStdinAll()).trim() : await promptHidden('App passphrase: ');
    const inst = await api.post<InstanceSummary>('/v1/found-apps/adopt', opts.name ? { home, passphrase, name: opts.name } : { home, passphrase });
    out(inst, () => `Adopted ${inst.displayName ?? inst.name} (${inst.packageId}) from ${home}.`);
    if (opts.wait !== false && inst.operationId) await waitOperation(api, inst.operationId, true);
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

// --- account, remote access, storage (the console's Settings page, from the terminal)
const account = program.command('account').description('administrator account');
account
  .command('set-password')
  .description('change the administrator password (asks for the current and the new one; --stdin reads two lines)')
  .option('--stdin', 'read current and new password from stdin (two lines)', false)
  .action(async (opts: { stdin: boolean }) => {
    const api = client();
    let current: string;
    let next: string;
    if (opts.stdin) {
      const lines = (await readStdinAll()).split('\n');
      current = lines[0] ?? '';
      next = lines[1] ?? '';
    } else {
      current = await promptHidden('Current password: ');
      next = await promptHidden('New password: ');
      const again = await promptHidden('New password (again): ');
      if (next !== again) throw new HarborError('INVALID_REQUEST', 'the two new passwords differ');
    }
    const r = await api.post<{ revokedSessions: number }>('/v1/account/password', { currentPassword: current, newPassword: next }, {}, 'PUT');
    out(r, () => `Password changed. ${r.revokedSessions} other session(s) logged out.`);
  });

const totp = account.command('totp').description('two-factor login (authenticator app)');
totp
  .command('status')
  .action(async () => {
    const s = await client().get<{ twoFactor: boolean; pending: boolean }>('/v1/account/security');
    out(s, () => (s.twoFactor ? 'Two-factor login is ON.' : s.pending ? 'Setup started but not confirmed; run: harbor account totp enable <code>' : 'Two-factor login is off.'));
  });
totp
  .command('setup')
  .description('start: prints the secret and otpauth URL to add to your authenticator, then confirm with `enable <code>`')
  .action(async () => {
    const r = await client().post<{ secret: string; otpauthUrl: string }>('/v1/account/totp/setup', {});
    out(r, () => `Add this to your authenticator app (or scan it in the console):\n  secret: ${r.secret}\n  ${r.otpauthUrl}\nThen confirm with the current code: harbor account totp enable <code>`);
  });
totp
  .command('enable <code>')
  .action(async (code: string) => {
    await client().post('/v1/account/totp/enable', { code });
    out({ twoFactor: true }, () => 'Two-factor login is on. Every login now needs the current code from your authenticator.');
  });
totp
  .command('off')
  .description('turn two-factor login off (asks for the password)')
  .option('--password-stdin', 'read the password from stdin', false)
  .action(async (opts: { passwordStdin: boolean }) => {
    const password = opts.passwordStdin ? (await readStdinAll()).trim() : await promptHidden('Password: ');
    await client().post('/v1/account/totp/disable', { password });
    out({ twoFactor: false }, () => 'Two-factor login is off.');
  });
totp
  .command('reset')
  .description('LOST YOUR AUTHENTICATOR? Run on the machine itself (root): removes the second factor without a session')
  .requiredOption('--local', 'confirm this is a local recovery on the machine')
  .requiredOption('--config <file>', 'daemon config JSON (usually /etc/harbor/harbor.json)')
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const r = resetTwoFactor(config);
    out(r, () => (r.wasEnabled ? 'Two-factor login removed. Log in with your password and set it up again when ready.' : 'Two-factor login was not on.'));
  });

program
  .command('name [name]')
  .description('show or set this machine\'s name in Harbor (empty string resets to the hostname)')
  .action(async (name?: string) => {
    const api = client();
    const s = name === undefined ? await api.get<SystemDto>('/v1/system') : await api.post<SystemDto>('/v1/system/name', { name }, {}, 'PUT');
    out({ deviceName: s.deviceName }, () => (s.deviceName ? `This machine is called "${s.deviceName}" in Harbor.` : 'No name set; Harbor shows the hostname.'));
  });

program
  .command('logs [instance]')
  .description('recent Harbor logs, or the container logs of one app')
  .option('-n, --lines <n>', 'how many lines', '200')
  .action(async (ref: string | undefined, opts: { lines: string }) => {
    const api = client();
    const n = Math.max(10, Math.min(2000, Number(opts.lines) || 200));
    if (!ref) {
      const r = await api.get<{ source: string; lines: string[] }>(`/v1/logs/harbor?lines=${n}`);
      out(r, () => (r.lines.length ? r.lines.join('\n') : '(no log lines)') + `\n-- source: ${r.source}`);
      return;
    }
    const inst = await resolveInstance(api, ref);
    const r = await api.get<{ containers: { name: string; service: string; lines: string[] }[] }>(`/v1/instances/${inst.id}/logs?lines=${n}`);
    out(r, () => r.containers.map((c) => `== ${c.service} (${c.name})\n${c.lines.join('\n') || '(no output)'}`).join('\n\n') || 'No containers recorded for this app.');
  });

const tailscaleCmd = program.command('tailscale').description('remote access: log this host into or out of your tailnet');
tailscaleCmd
  .command('login')
  .description('log in with an auth key from stdin (--authkey-stdin) or print a login URL to open in a browser')
  .option('--authkey-stdin', 'read a tailnet auth key from stdin', false)
  .action(async (opts: { authkeyStdin: boolean }) => {
    const api = client();
    const authKey = opts.authkeyStdin ? (await readStdinAll()).trim() : null;
    const r = await api.post<{ loginUrl: string | null; status: string }>('/v1/platform-tools/tailscale/login', authKey ? { authKey } : {});
    out(r, () => (r.loginUrl ? `Open this URL in a browser to approve the host, then run \`harbor tools\`: ${r.loginUrl}` : 'Logged in. Run `harbor tools` to see the node name.'));
  });
tailscaleCmd
  .command('logout')
  .description('log this host out of the tailnet')
  .action(async () => {
    await client().post('/v1/platform-tools/tailscale/logout', {});
    out({ loggedOut: true }, () => 'Logged out of the tailnet.');
  });

// --- appearance: rotating wallpapers and the look of an app, from the terminal
const wallpaperCmd = program.command('wallpaper').description('rotating wallpapers: status, turn on/off, choose the source (bing, wikimedia, or reddit with your app credentials), skip to the next one');
wallpaperCmd.action(async () => {
  const a = await client().get<AppearanceDto>('/v1/appearance');
  const r = a.rotation;
  out(a, () =>
    [
      `Wallpaper: ${a.wallpaper.kind === 'none' ? 'presets only' : a.wallpaper.kind === 'uploaded' ? 'your uploaded picture' : `rotating — ${a.wallpaper.current?.title ?? ''} (${a.wallpaper.current?.sourceName ?? ''}${a.wallpaper.current?.author ? `, ${a.wallpaper.current.author}` : ''})`}`,
      `Rotation: ${r.enabled ? 'on' : 'off'} · source ${r.source}${r.source === 'reddit' ? ` (${r.subreddits.map((x) => `r/${x}`).join(', ')}; credentials ${r.reddit.hasSecret ? 'set' : 'missing'})` : ''} · every ${r.everyHours}h${r.nextAt ? ` · next ${r.nextAt}` : ''}${r.lastError ? `\nLast error: ${r.lastError}` : ''}`,
    ].join('\n'),
  );
});
wallpaperCmd
  .command('set')
  .description('change rotation settings; e.g. `harbor wallpaper set --on --source bing`, `--source reddit --subreddits EarthPorn,wallpapers --reddit-client-id ID --reddit-secret-stdin`')
  .option('--on', 'turn rotating wallpapers on')
  .option('--off', 'turn rotating wallpapers off')
  .option('--source <source>', 'bing | wikimedia | reddit')
  .option('--subreddits <list>', 'comma-separated subreddits (reddit source)')
  .option('--every <hours>', 'hours between pictures (1-720)')
  .option('--reddit-client-id <id>', 'client id of your Reddit "script" app (reddit.com/prefs/apps)')
  .option('--reddit-secret-stdin', 'read the Reddit app secret from stdin', false)
  .action(async (opts: { on?: boolean; off?: boolean; source?: string; subreddits?: string; every?: string; redditClientId?: string; redditSecretStdin: boolean }) => {
    const patch: Record<string, unknown> = {};
    if (opts.on) patch['enabled'] = true;
    if (opts.off) patch['enabled'] = false;
    if (opts.source) patch['source'] = opts.source;
    if (opts.subreddits) patch['subreddits'] = opts.subreddits.split(',');
    if (opts.every) patch['everyHours'] = Number(opts.every);
    if (opts.redditClientId) patch['reddit'] = { clientId: opts.redditClientId, ...(opts.redditSecretStdin ? { clientSecret: (await readStdinAll()).trim() } : {}) };
    const a = await client().post<AppearanceDto>('/v1/appearance/rotation', patch, {}, 'PUT');
    out(a, () => `Rotation ${a.rotation.enabled ? 'on' : 'off'} (${a.rotation.source}).${a.rotation.lastError ? ` Last error: ${a.rotation.lastError}` : a.wallpaper.current ? ` Now showing: ${a.wallpaper.current.title}` : ''}`);
  });
wallpaperCmd
  .command('next')
  .description('skip to the next picture now')
  .action(async () => {
    const a = await client().post<AppearanceDto>('/v1/appearance/rotation/next', {});
    out(a, () => (a.rotation.lastError ? `Could not fetch a picture: ${a.rotation.lastError}` : `Now showing: ${a.wallpaper.current?.title ?? '?'} (${a.wallpaper.current?.sourceName ?? ''})`));
  });

program
  .command('look <instance>')
  .description('customise how an app appears on the launcher: --name "Photos", --glyph 📷 --color #3366ff, or --reset')
  .option('--name <name>', 'display name (empty string resets)')
  .option('--glyph <glyph>', 'one emoji or up to two letters for the icon')
  .option('--color <hex>', 'icon colour, e.g. #3366ff (with --glyph)')
  .option('--reset', 'back to the package name and icon', false)
  .action(async (ref: string, opts: { name?: string; glyph?: string; color?: string; reset: boolean }) => {
    const api = client();
    const inst = await resolveInstance(api, ref);
    const patch: Record<string, unknown> = {};
    if (opts.reset) Object.assign(patch, { displayName: null, icon: { kind: 'default' } });
    if (opts.name !== undefined) patch['displayName'] = opts.name || null;
    if (opts.glyph) patch['icon'] = { kind: 'glyph', glyph: opts.glyph, color: opts.color ?? '#4fb3ff' };
    const r = await api.post<InstanceSummary>(`/v1/instances/${inst.id}/appearance`, patch, {}, 'PUT');
    out(r, () => `${r.name}: shown as "${r.displayName ?? r.packageName}"${r.customIcon ? ` with a custom ${r.customIcon.kind} icon` : ''}.`);
  });

const powerCmd = program.command('power').description('restart or shut down this machine through Harbor (needs the polkit rule installed by bootstrap)');
powerCmd
  .command('restart')
  .option('--yes', 'do not ask', false)
  .action(async (opts: { yes: boolean }) => {
    if (!opts.yes && (await promptVisible('Restart this machine now? Apps come back after the reboot. [y/N] ')).trim().toLowerCase() !== 'y') return;
    await client().post('/v1/system/power', { action: 'reboot' });
    out({ action: 'reboot' }, () => 'Restarting…');
  });
powerCmd
  .command('shutdown')
  .option('--yes', 'do not ask', false)
  .action(async (opts: { yes: boolean }) => {
    if (!opts.yes && (await promptVisible('Shut this machine down now? You will need physical access (or your provider console) to turn it back on. [y/N] ')).trim().toLowerCase() !== 'y') return;
    await client().post('/v1/system/power', { action: 'poweroff' });
    out({ action: 'poweroff' }, () => 'Shutting down…');
  });

program
  .command('storage')
  .description('disks, the Harbor data folder and folders in use by apps')
  .action(async () => {
    const s = await client().get<{ dataFolder: { path: string; exists: boolean; writable: boolean }; mounts: { mountpoint: string; label: string; fsType: string; totalBytes: number | null; usedBytes: number | null; writable: boolean }[]; inUse: { path: string; instanceName: string; purpose: string; readOnly: boolean }[] }>('/v1/host/storage');
    const gib = (n: number | null) => (n === null ? '-' : `${(n / 1024 ** 3).toFixed(1)} GiB`);
    out(s, () =>
      [
        `Harbor data folder: ${s.dataFolder.path} (${s.dataFolder.exists ? (s.dataFolder.writable ? 'ready' : 'exists, not writable by harbor') : 'missing'})`,
        table([['DISK', 'MOUNT', 'FS', 'USED', 'TOTAL', 'HARBOR CAN WRITE'], ...s.mounts.map((m) => [m.label, m.mountpoint, m.fsType, gib(m.usedBytes), gib(m.totalBytes), m.writable ? 'yes' : 'no'])]),
        s.inUse.length ? table([['FOLDER', 'APP', 'PURPOSE', 'MODE'], ...s.inUse.map((f) => [f.path, f.instanceName, f.purpose, f.readOnly ? 'read-only' : 'read-write'])]) : 'No folders in use by apps yet.',
      ].join('\n'),
    );
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
  .option('--setup-in-browser', 'do not ask for an administrator here; print a setup code and finish in the browser wizard', false)
  .option('--lan', 'LAN mode (home network): console on port 80 and app ports on every interface, mDNS name <hostname>.local', false)
  .option('--lan-force', 'allow --lan on a machine without a private-network address (cloud server: everything faces the internet)', false)
  .option('--hostname <name>', 'set the machine hostname (the mDNS name becomes <name>.local)')
  .action(async (opts: { yes: boolean; withTools: boolean; installDocker: boolean; port: number; adminUsername?: string; passwordStdin?: boolean; bindCockpit?: string; bindPortainer?: string; withTailscale: boolean; tailscaleAuthkeyStdin?: boolean; withPublicProxy: boolean; releaseDir?: string; setupInBrowser: boolean; lan: boolean; lanForce: boolean; hostname?: string }) => {
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
    else if (process.stdin.isTTY && !opts.setupInBrowser) {
      // Only prompt for a password on a fresh installation: a re-run that only
      // adds a tool must never touch the existing administrator.
      const { existsSync: exists } = await import('node:fs');
      if (!exists(`${PRODUCT.paths.var}/harbor.db`)) {
        passwordProvider = async () => {
          const p1 = await promptHidden('Administrator password (min 8 chars): ');
          const p2 = await promptHidden('Repeat password: ');
          if (p1 !== p2) throw new HarborError('INVALID_REQUEST', 'passwords do not match');
          return p1;
        };
      }
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
      setupInBrowser: opts.setupInBrowser,
      lan: opts.lan,
      lanForce: opts.lanForce,
      hostname: opts.hostname ?? null,
      log,
      confirm: confirmStep,
    });
    const toolPorts = result.tools.map((t) => (t.browserUrl ? Number(new URL(t.browserUrl).port || (t.browserUrl.startsWith('https') ? 443 : 80)) : 0)).filter(Boolean);
    const summary = {
      managementUrl: result.managementUrl,
      lanUrl: result.lanUrl,
      setupCode: result.setupCode,
      installationId: result.installationId,
      adminCreated: result.adminCreated,
      versions: result.versions,
      tools: result.tools.map((t) => ({ id: t.id, mode: t.mode, browserUrl: t.browserUrl, installationState: t.installationState, note: t.note })),
    };
    out(summary, () =>
      [
        `Harbor ${result.versions.harbor} installed (node ${result.versions.node}, docker ${result.versions.docker ?? '?'}, compose ${result.versions.compose ?? '?'}).`,
        `Installation ${result.installationId}; administrator ${result.adminCreated ? 'enrolled' : result.setupCode ? 'to be created in the browser' : 'kept'}.`,
        ...result.tools.map((t) => `${t.id}: ${t.mode} ${t.installationState} ${t.browserUrl ?? ''}\n    ${t.note ?? ''}`),
        ...(result.setupCode
          ? ['', '========================================', `  Finish setup in a browser: ${result.lanUrl ?? result.managementUrl}`, `  Setup code: ${result.setupCode}`, '========================================', '  (from another computer without LAN mode: forward the port over SSH first, see below; `harbor setup-code` prints the code again)']
          : result.lanUrl
            ? ['', `On your network: ${result.lanUrl}`]
            : []),
        '',
        ...accessInstructions(Number(new URL(result.managementUrl).port), toolPorts, [PRODUCT.defaults.appPortRange.from, PRODUCT.defaults.appPortRange.from + 1, PRODUCT.defaults.appPortRange.from + 2]),
      ].join('\n'),
    );
  });

// ---------------- local maintenance (direct state access, no HTTP)

program
  .command('uninstall')
  .description('remove Harbor itself from this Ubuntu host (run as root): stop the daemon, delete Harbor-labelled Docker objects, release/config/state, units and the service account')
  .option('--yes', 'approve all previewed steps non-interactively', false)
  .option('--keep-data', 'keep /var/lib/harbor (state, secrets, release snapshots)', false)
  .action(async (opts: { yes: boolean; keepData: boolean }) => {
    const { uninstall } = await import('../bootstrap/uninstall.js');
    const log = (m: string) => process.stderr.write(`[uninstall] ${m}\n`);
    const confirmStep = async (question: string, preview: string[]) => {
      process.stderr.write(`\n${question}\n${preview.map((p) => `  - ${p}`).join('\n')}\n`);
      if (opts.yes) {
        process.stderr.write('  (approved with --yes)\n');
        return true;
      }
      return confirm('Proceed?');
    };
    const result = await uninstall({ yes: opts.yes, keepData: opts.keepData, log, confirm: confirmStep });
    out(result, () =>
      [`Harbor removed from this machine.`, ...result.removed.map((r) => `  - removed ${r}`), ...result.kept.map((k) => `  - kept ${k}`), 'Your own folders were left alone.'].join('\n'),
    );
  });

program
  .command('setup-code')
  .description('print the setup code for the browser wizard (root, on the machine; only while no administrator exists)')
  .requiredOption('--config <file>', 'daemon config JSON (usually /etc/harbor/harbor.json)')
  .action((opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const code = readSetupCode(cfg.stateDir);
    if (!code) throw new HarborError('INVALID_STATE', 'no setup code on this machine (the administrator already exists, or bootstrap ran without --setup-in-browser)');
    out({ setupCode: code }, () => `Setup code: ${code}`);
  });

const selfUpdateCmd = program.command('self-update').description('Harbor updating itself from GitHub Releases: status, check, apply');
selfUpdateCmd.action(async () => {
  const s = await client().get<SelfUpdateStatusDto>('/v1/system/update');
  out(s, () => selfUpdateText(s));
});
selfUpdateCmd
  .command('check')
  .action(async () => {
    const s = await client().post<SelfUpdateStatusDto>('/v1/system/update/check', {});
    out(s, () => selfUpdateText(s));
  });
selfUpdateCmd
  .command('start')
  .description('ask the daemon to update Harbor to the newest release (it restarts; run `harbor self-update` afterwards)')
  .option('--yes', 'do not ask', false)
  .action(async (opts: { yes: boolean }) => {
    const api = client();
    const s = await api.get<SelfUpdateStatusDto>('/v1/system/update');
    if (!s.available || !s.latest) throw new HarborError('INVALID_STATE', `Harbor ${s.current} is the newest known release`, { nextAction: 'Run `harbor self-update check` first.' });
    if (!opts.yes && (await promptVisible(`Update Harbor ${s.current} -> ${s.latest.version}? The daemon restarts for a minute. [y/N] `)).trim().toLowerCase() !== 'y') return;
    const r = await api.post<SelfUpdateStatusDto>('/v1/system/update/apply', {});
    out(r, () => `Update to ${s.latest!.version} started. Watch it with: harbor self-update`);
  });
selfUpdateCmd
  .command('apply')
  .description('ROOT, run by harbor-self-update@<version>.service: download the release, verify SHA256SUMS, install it in place (bootstrap --yes)')
  .requiredOption('--to <version>', 'release version, e.g. 0.8.0')
  .option('--repo <owner/name>', 'GitHub repository', 'carlosalaniz/harbor')
  .option('--archive <file>', 'use a local archive instead of downloading (SHA256SUMS must sit next to it)')
  .action(async (opts: { to: string; repo: string; archive?: string }) => {
    const { applySelfUpdate } = await import('../bootstrap/selfupdate-apply.js');
    await applySelfUpdate(opts.to, opts.repo, (m) => process.stderr.write(`[self-update] ${m}\n`), opts.archive ? { archive: opts.archive, sums: path.join(path.dirname(opts.archive), 'SHA256SUMS') } : undefined);
  });

program
  .command('tools-install <tool>')
  .description('ROOT, run by harbor-tools-install@<tool>.service: install cockpit|portainer with the bootstrap recipe and record it in state')
  .action(async (tool: string) => {
    const { applyToolInstall } = await import('../bootstrap/tools-install-apply.js');
    await applyToolInstall(tool, (m) => process.stderr.write(`[tools-install] ${m}\n`));
  });

program
  .command('device-mount <spec>')
  .description('ROOT, run by harbor-device-mount@<name:action>.service: mount or unmount removable media (spec is "<name>:mount" or "<name>:unmount")')
  .action(async (spec: string) => {
    const m = /^([a-z]+[0-9]+):(mount|unmount)$/.exec(spec);
    if (!m) throw new HarborError('INVALID_REQUEST', `device-mount expects <name>:<mount|unmount>, got ${spec}`);
    const { applyDeviceMount } = await import('../bootstrap/device-mount-apply.js');
    await applyDeviceMount(m[1]!, m[2] as 'mount' | 'unmount', (msg) => process.stderr.write(`[device-mount] ${msg}\n`));
  });

program
  .command('device-format <name>')
  .description('ROOT, run by harbor-device-mount@<name>:format.service: format a removable drive as ext4 (erases everything)')
  .action(async (name: string) => {
    if (!/^[a-z]+[0-9]+$/.test(name)) throw new HarborError('INVALID_REQUEST', `device-format expects a device name like sdb1, got ${name}`);
    const { applyDeviceFormat } = await import('../bootstrap/device-format-apply.js');
    await applyDeviceFormat(name, (msg) => process.stderr.write(`[device-format] ${msg}\n`));
  });

program
  .command('device-dispatch <spec>')
  .description('ROOT, run by harbor-device-mount@.service: dispatch "<name>:mount", "<name>:unmount" or "<name>:format" to the right root step')
  .action(async (spec: string) => {
    const m = /^([a-z]+[0-9]+):(mount|unmount|format)$/.exec(spec);
    if (!m) throw new HarborError('INVALID_REQUEST', `device-dispatch expects <name>:<mount|unmount|format>, got ${spec}`);
    const name = m[1]!;
    const action = m[2]!;
    const log = (msg: string) => process.stderr.write(`[device-${action}] ${msg}\n`);
    if (action === 'format') {
      const { applyDeviceFormat } = await import('../bootstrap/device-format-apply.js');
      await applyDeviceFormat(name, log);
      return;
    }
    const { applyDeviceMount } = await import('../bootstrap/device-mount-apply.js');
    await applyDeviceMount(name, action as 'mount' | 'unmount', log);
  });

function selfUpdateText(s: SelfUpdateStatusDto): string {
  const lines = [`Installed: Harbor ${s.current}`];
  if (s.latest) lines.push(`Newest release: ${s.latest.version}${s.latest.publishedAt ? ` (${s.latest.publishedAt.slice(0, 10)})` : ''}${s.available ? ' — UPDATE AVAILABLE (harbor self-update start)' : ' — up to date'}`);
  else lines.push(s.error ? `Could not check: ${s.error}` : 'Not checked yet (harbor self-update check)');
  if (s.applying) lines.push(`Update ${s.applying.version}: ${s.applying.state} — ${s.applying.message} (${s.applying.at})`);
  return lines.join('\n');
}

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
      password = await promptHidden('Password (min 8 chars): ');
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
