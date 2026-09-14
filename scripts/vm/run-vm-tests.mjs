#!/usr/bin/env node
// pnpm test:vm — the live acceptance suite (TDD A01–A16) against the designated disposable VM only.
//
//   node scripts/vm/run-vm-tests.mjs [--fresh] [--skip-reboot] [--only A01,A03] [--archive <tar.gz>]
//
// --fresh rebuilds the VM to a clean Ubuntu 24.04 image first (the "vagrant destroy && up" equivalent),
// which is required for valid A01/A16 evidence. Without --fresh the suite runs against the VM as is
// (useful while iterating) and labels A01 accordingly.
//
// Evidence: docs/evidence/vm-<timestamp>/report.json + report.md + screenshots/exports.
// Fixtures create only test-owned resources (names prefixed harbor-test-) and clean them up.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { Evidence, ROOT, cli, cliOk, fail, minimalPdf, resolveTarget, sleep, waitFor } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const FRESH = flag('--fresh');
const SKIP_REBOOT = flag('--skip-reboot');
const ONLY = opt('--only', null)?.split(',').map((s) => s.trim());
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCHIVE = path.resolve(opt('--archive', path.join(ROOT, 'release', `harbor-${pkg.version}-linux-x64.tar.gz`)));
const ARCHIVE_DIR = path.basename(ARCHIVE).replace(/\.tar\.gz$/, '');
const ADMIN = { username: 'admin', password: 'vm-suite-FIXTURE-password' };
const N8N_OWNER = { email: 'harbor-test@example.invalid', firstName: 'Harbor', lastName: 'Tester', password: 'n8n-owner-FIXTURE-password' };
const PORTAINER_ADMIN = { username: 'admin', password: 'portainer-FIXTURE-password' };
const OS_TEST_USER = { name: 'harbor-cockpit-test', password: 'cockpit-FIXTURE-password' };
const PORTS = [18000, 18080, 18081, 18082, 18083, 18084, 18085, 9090, 9443];
const UI = 'http://localhost:18000';

if (!existsSync(ARCHIVE)) fail(`release archive not found: ${ARCHIVE} (run pnpm package)`, 2);
const target = resolveTarget();
const runId = `vm-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const ev = new Evidence(path.join(ROOT, 'docs', 'evidence', runId));
console.log(`target: ${target.name}\nevidence: ${path.relative(ROOT, ev.dir)}\narchive: ${ARCHIVE}\nfresh: ${FRESH} skipReboot: ${SKIP_REBOOT}`);

const should = (id) => !ONLY || ONLY.includes(id);
const ssh = (cmd, o) => target.sshOk(cmd, o);
const sshTry = (cmd, o) => target.ssh(cmd, o);
const dockerPs = () => JSON.parse(`[${ssh(`docker ps -a --no-trunc --format '{{json .}}'`).trim().split('\n').filter(Boolean).join(',')}]`);
const containersOf = (instanceId) => dockerPs().filter((c) => c.Labels.includes(`io.harbor.preview/instance=${instanceId}`)).map((c) => ({ id: c.ID, name: c.Names, created: c.CreatedAt, state: c.State })).sort((a, b) => a.name.localeCompare(b.name));
const listInstances = () => cliOk(target, ['list']);
const byName = (name) => listInstances().find((i) => i.name === name);

let browser;
let tunnel;
const state = { installationId: null, versions: {}, bootstrapLog1: null, bootstrapLog2: null };

async function localPortsFree() {
  for (const p of PORTS) {
    const free = await new Promise((r) => {
      const s = createServer();
      s.once('error', () => r(false));
      s.listen({ port: p, host: '127.0.0.1' }, () => s.close(() => r(true)));
    });
    if (!free) fail(`local port ${p} is busy on this workstation; the suite forwards the same port numbers. Free it (see OPERATOR_GUIDE section 3).`, 4);
  }
}

async function openTunnels() {
  tunnel?.close();
  tunnel = target.tunnel(PORTS);
  await waitFor(async () => (await fetch(`${UI}/healthz`)).ok, { timeoutMs: 60_000, intervalMs: 1000, what: 'tunnel to daemon' });
}

async function newPage(opts = {}) {
  browser ??= await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 }, ...opts });
  // Excalidraw/BentoPDF use the File System Access API when present; remove it so exports are downloads.
  await ctx.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
  });
  return { ctx, page: await ctx.newPage() };
}

async function uiLogin(page) {
  await page.goto(`${UI}/`, { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('heading', { name: 'Installed' }).waitFor({ timeout: 30_000 });
}

async function apiToken() {
  const r = await fetch(`${UI}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
  if (r.status !== 201) throw new Error(`login failed ${r.status}`);
  return (await r.json()).token;
}

function step(id, title, fn) {
  return async () => {
    if (!should(id)) return;
    try {
      const { status = 'pass', details = {}, notes = [] } = (await fn()) ?? {};
      ev.record(id, title, status, details, notes);
    } catch (e) {
      ev.record(id, title, 'fail', { error: e.message, stack: (e.stack ?? '').split('\n').slice(0, 6) }, [String(e.message)]);
      if (id === 'A01') throw e; // nothing else can run without a bootstrapped host
    }
  };
}

// ---------------------------------------------------------------- A01 bootstrap
const A01 = step('A01', 'Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state', async () => {
  const notes = [];
  if (FRESH) {
    console.log('rebuilding VM to a fresh Ubuntu 24.04 image...');
    await target.rebuildFresh();
    notes.push('VM rebuilt to a fresh image before this run');
  } else notes.push('VM NOT rebuilt (--fresh not given); A01 evidence is from a re-used VM');
  const facts = ssh('lsb_release -ds; uname -m; systemctl --version | head -1; command -v docker || echo docker:absent; command -v node || echo node:absent; command -v npm || echo npm:absent; cat /etc/machine-id').trim().split('\n');
  const preinstalled = { docker: !facts.includes('docker:absent'), node: !facts.includes('node:absent'), npm: !facts.includes('npm:absent') };
  if (FRESH && (preinstalled.node || preinstalled.npm || preinstalled.docker)) throw new Error(`fresh VM unexpectedly has ${JSON.stringify(preinstalled)}`);
  // Fixture: pre-installed Cockpit so bootstrap must bind an existing tool without reconfiguring it.
  if (FRESH) {
    ssh('DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends cockpit', { timeoutMs: 900_000 });
    notes.push('fixture: Cockpit pre-installed from Ubuntu repos before bootstrap (tests binding an existing tool)');
  }
  target.scp(ARCHIVE, `/root/${path.basename(ARCHIVE)}`);
  target.scp(path.join(path.dirname(ARCHIVE), 'SHA256SUMS'), '/root/SHA256SUMS');
  ssh(`cd /root && sha256sum -c SHA256SUMS && rm -rf ${ARCHIVE_DIR} && tar -xzf ${path.basename(ARCHIVE)}`);
  // bootstrap #1: without tools (also proves the "absent tools" state), Docker installed with approval
  const b1 = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes --install-docker --admin-username ${ADMIN.username} --password-stdin 2>&1`, { input: ADMIN.password + '\n', timeoutMs: 1800_000 });
  state.bootstrapLog1 = ev.file('bootstrap-1.log', b1.stdout + b1.stderr);
  if (b1.code !== 0) throw new Error(`bootstrap #1 failed (exit ${b1.code}); see ${state.bootstrapLog1}`);
  const listeners1 = ssh("ss -ltnp | awk 'NR>1{print $4}' | sort").trim().split('\n');
  const managementBound = listeners1.filter((l) => l.endsWith(':18000'));
  if (managementBound.length !== 1 || !managementBound[0].startsWith('127.0.0.1')) throw new Error(`management listener not loopback-only: ${managementBound.join(',')}`);
  const cfg = JSON.parse(ssh('cat /etc/harbor/harbor.json'));
  const login1 = cli(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  if (login1.code !== 0) throw new Error(`CLI login after bootstrap failed: ${login1.stderr}`);
  const doctor1 = cliOk(target, ['doctor']);
  state.installationId = doctor1.system.installationId;
  const toolsAbsent = cliOk(target, ['tools']);
  // bootstrap #2: re-run with tools; identity/admin must be preserved
  const b2 = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes --with-tools 2>&1`, { timeoutMs: 1800_000 });
  state.bootstrapLog2 = ev.file('bootstrap-2.log', b2.stdout + b2.stderr);
  if (b2.code !== 0) throw new Error(`bootstrap #2 (re-run, --with-tools) failed (exit ${b2.code}); see ${state.bootstrapLog2}`);
  const doctor2 = cliOk(target, ['doctor']);
  if (doctor2.system.installationId !== state.installationId) throw new Error('installation id changed on bootstrap re-run');
  const login2 = cli(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  if (login2.code !== 0) throw new Error('administrator credentials no longer valid after bootstrap re-run');
  const versions = {
    ubuntu: facts[0],
    arch: facts[1],
    systemd: facts[2],
    docker: ssh("docker version --format '{{.Server.Version}}'").trim(),
    compose: ssh('docker compose version --short').trim(),
    node: ssh('/opt/harbor/node/bin/node --version').trim(),
    harbor: doctor2.system.version,
  };
  state.versions = versions;
  const listeners2 = ssh("ss -ltnp | awk 'NR>1{print $4}' | sort").trim().split('\n');
  await openTunnels();
  return {
    details: { preinstalledBefore: preinstalled, machineId: facts[6], versions, installationId: state.installationId, config: cfg, listenersAfterBootstrap1: listeners1, listenersAfterBootstrap2: listeners2, toolsAfterBootstrap1: toolsAbsent, logs: [state.bootstrapLog1, state.bootstrapLog2] },
    notes: [...notes, `Docker ${versions.docker} / Compose ${versions.compose} installed by bootstrap; Node ${versions.node} bundled`, 'bootstrap re-run kept installation id and administrator'],
  };
});

// ---------------------------------------------------------------- A02 catalog + invalid package
const A02 = step('A02', 'CLI and UI show three real pinned packages; invalid package hash/schema rejected before effects', async () => {
  const catalog = cliOk(target, ['catalog']);
  const ids = catalog.map((c) => c.id).sort();
  if (ids.join(',') !== 'bentopdf,excalidraw,n8n') throw new Error(`catalog ids ${ids}`);
  if (!catalog.every((c) => c.availability === 'available')) throw new Error('not all packages available');
  const digests = JSON.parse(ssh(`for p in bentopdf excalidraw n8n; do jq -c '{id:.package.id, images:[.images[]|.reference]}' /opt/harbor/catalog/$p/release.json; done | jq -s .`));
  for (const d of digests) for (const ref of d.images) if (!/@sha256:[a-f0-9]{64}$/.test(ref)) throw new Error(`unpinned image ${ref}`);
  const { ctx, page } = await newPage();
  await uiLogin(page);
  for (const name of ['Excalidraw', 'BentoPDF', 'n8n']) await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.screenshot({ path: path.join(ev.dir, 'A02-ui-catalog.png') });
  await ctx.close();
  // Tamper a bundled package on the host: hash mismatch must be rejected before any effect.
  const before = dockerPs().length;
  ssh("cp /opt/harbor/catalog/bentopdf/compose.yaml /root/bentopdf.compose.bak && printf '# tampered\\n' >> /opt/harbor/catalog/bentopdf/compose.yaml");
  let tampered;
  try {
    tampered = cliOk(target, ['catalog']).find((c) => c.id === 'bentopdf');
    const plan = cli(target, ['plan', 'install', 'bentopdf']);
    if (plan.code === 0) throw new Error('plan for tampered package unexpectedly succeeded');
    if (plan.json?.error?.code !== 'INVALID_PACKAGE') throw new Error(`expected INVALID_PACKAGE, got ${JSON.stringify(plan.json)}`);
  } finally {
    ssh('mv /root/bentopdf.compose.bak /opt/harbor/catalog/bentopdf/compose.yaml');
  }
  const restored = cliOk(target, ['catalog']).find((c) => c.id === 'bentopdf');
  if (restored.availability !== 'available') throw new Error('package not available after restore');
  if (dockerPs().length !== before) throw new Error('tampered package produced Docker effects');
  return { details: { catalog, digests, tampered: { availability: tampered.availability, reason: tampered.reason } }, notes: ['tampered compose.yaml -> catalog unavailable + plan 422 INVALID_PACKAGE, zero Docker effects'] };
});

// ---------------------------------------------------------------- A03 coexistence + browser actions
let excaBefore;
const A03 = step('A03', 'Excalidraw + BentoPDF coexist; representative browser actions; installing B does not recreate A', async () => {
  const opA = cliOk(target, ['install', 'excalidraw', '--yes']);
  if (opA.state !== 'succeeded') throw new Error(`excalidraw install ${opA.state}: ${JSON.stringify(opA.error)}`);
  const a = byName('excalidraw');
  excaBefore = containersOf(a.id);
  const opB = cliOk(target, ['install', 'bentopdf', '--yes']);
  if (opB.state !== 'succeeded') throw new Error(`bentopdf install ${opB.state}: ${JSON.stringify(opB.error)}`);
  const b = byName('bentopdf');
  const excaAfter = containersOf(a.id);
  if (JSON.stringify(excaAfter) !== JSON.stringify(excaBefore)) throw new Error(`Excalidraw containers changed: ${JSON.stringify({ excaBefore, excaAfter })}`);
  if (a.endpoints[0].hostPort === b.endpoints[0].hostPort) throw new Error('same port');
  // Excalidraw: draw a rectangle and export PNG
  const { ctx, page } = await newPage();
  await page.goto(a.endpoints[0].browserUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.keyboard.press('r');
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(700, 500, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(ev.dir, 'A03-excalidraw-drawing.png') });
  await page.locator('[data-testid="main-menu-trigger"]').click();
  await page.getByText(/Export image/i).first().click();
  const dl = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Export to PNG' }).click();
  const d = await dl;
  const exportPath = path.join(ev.dir, 'A03-excalidraw-export.png');
  await d.saveAs(exportPath);
  const exportBytes = readFileSync(exportPath);
  if (exportBytes.length < 500 || exportBytes.subarray(1, 4).toString() !== 'PNG') throw new Error('Excalidraw export is not a PNG');
  // BentoPDF: merge two generated PDFs
  const pa = path.join(ev.dir, 'fixture-a.pdf');
  const pb = path.join(ev.dir, 'fixture-b.pdf');
  writeFileSync(pa, minimalPdf('Harbor test page A'));
  writeFileSync(pb, minimalPdf('Harbor test page B'));
  const res = await page.goto(`${b.endpoints[0].browserUrl}merge-pdf.html`, { waitUntil: 'networkidle', timeout: 60_000 });
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  await page.locator('input[type=file]').first().setInputFiles([pa, pb]);
  await sleep(2000);
  const dl2 = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: /^Merge PDFs$/ }).click();
  const m = await dl2;
  const mergedPath = path.join(ev.dir, 'A03-bentopdf-merged.pdf');
  await m.saveAs(mergedPath);
  const merged = readFileSync(mergedPath);
  const pages = (merged.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (!merged.subarray(0, 5).equals(Buffer.from('%PDF-')) || pages !== 2) throw new Error(`merged PDF invalid (pages=${pages})`);
  await page.screenshot({ path: path.join(ev.dir, 'A03-bentopdf-merge.png') });
  await ctx.close();
  return {
    details: { excalidraw: { id: a.id, port: a.endpoints[0].hostPort, containers: excaBefore }, bentopdf: { id: b.id, port: b.endpoints[0].hostPort, containers: containersOf(b.id) }, excalidrawExportBytes: exportBytes.length, mergedPdfBytes: merged.length, mergedPages: pages, bentopdfHeaders: { coop: res.headers()['cross-origin-opener-policy'], coep: res.headers()['cross-origin-embedder-policy'], crossOriginIsolated: isolated } },
    notes: ['Excalidraw rectangle drawn and exported as PNG (download)', 'BentoPDF merged two PDFs into a 2-page PDF (download)', 'Excalidraw container ids/creation times unchanged by BentoPDF install'],
  };
});

// ---------------------------------------------------------------- A04 second instance + fourth package
const A04 = step('A04', 'Second Excalidraw has distinct project/network/ports; a fourth supported-profile package needs no engine branch', async () => {
  const op = cliOk(target, ['install', 'excalidraw', '--yes']);
  if (op.state !== 'succeeded') throw new Error(`second excalidraw ${op.state}`);
  const a = byName('excalidraw');
  const a2 = byName('excalidraw-2');
  const d1 = cliOk(target, ['inspect', a.id]);
  const d2 = cliOk(target, ['inspect', a2.id]);
  const net = (d) => d.resources.find((r) => r.kind === 'network').name;
  if (a.id === a2.id || net(d1) === net(d2) || a.endpoints[0].hostPort === a2.endpoints[0].hostPort) throw new Error('second instance not distinct');
  // Fourth package: a copy of the Excalidraw package under a new id, added only as package files + index entry.
  ssh(`set -e; cd /opt/harbor/catalog && rm -rf demo-whiteboard && cp -r excalidraw demo-whiteboard && sed -i 's/^  id: excalidraw$/  id: demo-whiteboard/; s/^  name: Excalidraw$/  name: Demo Whiteboard/' demo-whiteboard/manifest.yaml && sed -i 's/"id": "excalidraw"/"id": "demo-whiteboard"/' demo-whiteboard/release.json && H=$(sha256sum demo-whiteboard/manifest.yaml | cut -d" " -f1) && jq --arg h "$H" '.files["manifest.yaml"].sha256=$h' demo-whiteboard/release.json > demo-whiteboard/release.tmp && mv demo-whiteboard/release.tmp demo-whiteboard/release.json && cp index.json /root/index.json.bak && jq '.packages["demo-whiteboard"]={revision:"1",dir:"demo-whiteboard"}' index.json > index.tmp && mv index.tmp index.json`);
  let fourth;
  try {
    const cat = cliOk(target, ['catalog']);
    fourth = cat.find((c) => c.id === 'demo-whiteboard');
    if (fourth?.availability !== 'available') throw new Error(`fourth package not available: ${JSON.stringify(fourth)}`);
    const op4 = cliOk(target, ['install', 'demo-whiteboard', '--yes']);
    if (op4.state !== 'succeeded') throw new Error(`fourth package install ${op4.state}: ${JSON.stringify(op4.error)}`);
    const inst = byName('demo-whiteboard');
    const r = await fetch(inst.endpoints[0].browserUrl);
    if (r.status !== 200) throw new Error('fourth package not answering');
    const rm = cliOk(target, ['remove', 'demo-whiteboard', '--yes']);
    if (rm.state !== 'succeeded') throw new Error('fourth package remove failed');
  } finally {
    ssh('mv /root/index.json.bak /opt/harbor/catalog/index.json && rm -rf /opt/harbor/catalog/demo-whiteboard');
  }
  return { details: { first: { id: a.id, network: net(d1), port: a.endpoints[0].hostPort }, second: { id: a2.id, network: net(d2), port: a2.endpoints[0].hostPort }, fourthPackage: fourth }, notes: ['second Excalidraw: distinct UUID, project network and host port', 'fourth package (package files + index only) installed and answered; engine untouched'] };
});

// ---------------------------------------------------------------- A05 conflicts + sentinel
let sentinel;
const A05 = step('A05', 'Occupied port/name or conflicting foreign resource fails safely; no foreign listener/container is stopped', async () => {
  const image = ssh("jq -r '.images.web.reference' /opt/harbor/catalog/excalidraw/release.json").trim();
  const used = new Set(listInstances().flatMap((i) => i.endpoints.map((e) => e.hostPort)));
  let port = 18080;
  while (used.has(port)) port += 1;
  ssh(`docker rm -f harbor-test-sentinel >/dev/null 2>&1 || true; docker volume create harbor-test-sentinel-data >/dev/null; docker run -d --name harbor-test-sentinel -p 127.0.0.1:${port}:80 --label harbor.test.fixture=sentinel ${image} >/dev/null`);
  sentinel = { port, id: ssh('docker inspect -f {{.Id}} harbor-test-sentinel').trim(), created: ssh('docker inspect -f {{.Created}} harbor-test-sentinel').trim() };
  const plan = cliOk(target, ['plan', 'install', 'bentopdf', '--name', 'pdf-b']);
  if (plan.endpoints[0].hostPort === port) throw new Error('planned port collides with occupied sentinel port');
  const nameConflict = cli(target, ['plan', 'install', 'excalidraw', '--name', 'excalidraw']);
  if (nameConflict.code === 0 || nameConflict.json?.error?.code !== 'NAME_CONFLICT') throw new Error(`expected NAME_CONFLICT, got ${JSON.stringify(nameConflict.json)}`);
  const after = { state: ssh('docker inspect -f {{.State.Status}} harbor-test-sentinel').trim(), id: ssh('docker inspect -f {{.Id}} harbor-test-sentinel').trim() };
  if (after.state !== 'running' || after.id !== sentinel.id) throw new Error('sentinel disturbed');
  return { details: { sentinel, plannedPortForNextInstall: plan.endpoints[0].hostPort, nameConflict: nameConflict.json?.error }, notes: [`sentinel container occupies 127.0.0.1:${port}; planner skipped it`, 'duplicate name -> 409 NAME_CONFLICT', 'sentinel still running with the same id'] };
});

// ---------------------------------------------------------------- A06 duplicate submission / refresh / disconnect
const A06 = step('A06', 'Refresh, logout, CLI disconnect and duplicate submission do not cancel/duplicate an accepted operation', async () => {
  const plan = cliOk(target, ['plan', 'install', 'bentopdf', '--name', 'pdf-b']);
  const key = `vm-suite-${Date.now()}`;
  const s1 = cliOk(target, ['apply', plan.id, '--idempotency-key', key, '--yes', '--no-wait']);
  const s2 = cliOk(target, ['apply', plan.id, '--idempotency-key', key, '--yes', '--no-wait']);
  if (s1.operationId !== s2.operationId) throw new Error('duplicate submission created a second operation');
  const other = cli(target, ['apply', plan.id, '--idempotency-key', `${key}-other`, '--yes', '--no-wait']);
  if (other.code === 0 || other.json?.error?.code !== 'IDEMPOTENCY_CONFLICT') throw new Error(`expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(other.json)}`);
  // UI: reload mid-operation -> login required -> the accepted operation/instance is found, not recreated
  const { ctx, page } = await newPage();
  await uiLogin(page);
  await page.reload();
  await page.getByRole('heading', { name: 'Log in' }).waitFor();
  await uiLogin(page);
  const op = await waitFor(() => {
    const o = cliOk(target, ['operation', s1.operationId]);
    return ['succeeded', 'failed', 'needs_action'].includes(o.state) ? o : null;
  }, { timeoutMs: 300_000, what: 'pdf-b install' });
  if (op.state !== 'succeeded') throw new Error(`pdf-b install ${op.state}`);
  const count = listInstances().filter((i) => i.name === 'pdf-b').length;
  if (count !== 1) throw new Error(`expected 1 pdf-b instance, found ${count}`);
  await page.reload();
  await uiLogin(page);
  await page.locator('.instance').filter({ hasText: 'pdf-b' }).waitFor();
  await page.screenshot({ path: path.join(ev.dir, 'A06-ui-after-relogin.png') });
  await ctx.close();
  return { details: { operationId: s1.operationId, duplicateReturnedSame: s1.operationId === s2.operationId, otherKey: other.json?.error }, notes: ['same key -> same operation id; different key on consumed plan -> 409 IDEMPOTENCY_CONFLICT', 'UI reload required login, then showed the single accepted instance'] };
});

// ---------------------------------------------------------------- A07 stale plan / key reuse
const A07 = step('A07', 'Expired/stale plan and reused key with different request are rejected; same request returns original', async () => {
  const a2 = byName('excalidraw-2');
  const stale = cliOk(target, ['plan', 'stop', a2.id]);
  const fresh = cliOk(target, ['plan', 'stop', a2.id]);
  const key = `vm-suite-a07-${Date.now()}`;
  const applied = cliOk(target, ['apply', fresh.id, '--idempotency-key', key, '--yes']);
  if (applied.state !== 'succeeded') throw new Error('stop failed');
  const staleRes = cli(target, ['apply', stale.id, '--idempotency-key', `${key}-stale`, '--yes']);
  if (staleRes.code === 0 || staleRes.json?.error?.code !== 'STATE_CHANGED') throw new Error(`expected STATE_CHANGED, got ${JSON.stringify(staleRes.json)}`);
  const again = cliOk(target, ['apply', fresh.id, '--idempotency-key', key, '--yes']);
  if (again.id !== applied.id) throw new Error('same key/same plan did not return the original operation');
  const reuse = cli(target, ['apply', stale.id, '--idempotency-key', key, '--yes']);
  if (reuse.code === 0 || reuse.json?.error?.code !== 'IDEMPOTENCY_CONFLICT') throw new Error(`expected IDEMPOTENCY_CONFLICT, got ${JSON.stringify(reuse.json)}`);
  return { details: { stalePlan: staleRes.json?.error, keyReuse: reuse.json?.error, originalOperation: applied.id }, notes: ['stale plan (generation changed) -> 409 STATE_CHANGED', 'reused key with different plan -> 409 IDEMPOTENCY_CONFLICT; same request -> original operation', 'plan expiry (15 min) is covered by tests/integration/install.test.ts with a controlled clock'] };
});

// ---------------------------------------------------------------- A08 scoped stop/start/remove
const A08 = step('A08', 'Stop/start/remove acts on one instance only; retains persistence; tools and sentinel unchanged', async () => {
  const a = byName('excalidraw');
  const pdfB = byName('pdf-b');
  const portainerBefore = ssh('docker inspect -f "{{.Id}} {{.State.Status}}" hb_platform_portainer-portainer-1').trim();
  const sentinelBefore = ssh('docker inspect -f "{{.Id}} {{.State.Status}}" harbor-test-sentinel').trim();
  const aBefore = containersOf(a.id);
  const stop = cliOk(target, ['stop', pdfB.id, '--yes']);
  const start = cliOk(target, ['start', pdfB.id, '--yes']);
  const rm = cliOk(target, ['remove', pdfB.id, '--yes']);
  if ([stop, start, rm].some((o) => o.state !== 'succeeded')) throw new Error('lifecycle op failed');
  const retained = byName('pdf-b');
  if (retained.installState !== 'retained' || retained.endpoints[0].hostPort !== pdfB.endpoints[0].hostPort) throw new Error('pdf-b not retained with its allocation');
  if (JSON.stringify(containersOf(a.id)) !== JSON.stringify(aBefore)) throw new Error('excalidraw containers changed');
  if (ssh('docker inspect -f "{{.Id}} {{.State.Status}}" hb_platform_portainer-portainer-1').trim() !== portainerBefore) throw new Error('portainer changed');
  if (ssh('docker inspect -f "{{.Id}} {{.State.Status}}" harbor-test-sentinel').trim() !== sentinelBefore) throw new Error('sentinel changed');
  if (!ssh('docker volume ls --format {{.Name}}').includes('harbor-test-sentinel-data')) throw new Error('sentinel volume gone');
  return { details: { target: pdfB.id, retained: { installState: retained.installState, port: retained.endpoints[0].hostPort } }, notes: ['stop/start/remove on pdf-b left Excalidraw, Portainer and the sentinel untouched', 'pdf-b retained with its name and port allocation'] };
});

// ---------------------------------------------------------------- A11 n8n
let n8nGateway;
const A11 = step('A11', 'n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys', async () => {
  const op = cliOk(target, ['install', 'n8n', '--yes'], { timeoutMs: 1800_000 });
  if (op.state !== 'succeeded') throw new Error(`n8n install ${op.state}: ${JSON.stringify(op.error)}`);
  const n = byName('n8n');
  const containers = containersOf(n.id);
  const published = dockerPs().filter((c) => c.Labels.includes(`io.harbor.preview/instance=${n.id}`)).map((c) => c.Ports);
  if (published.some((p) => /5432->/.test(p))) throw new Error('postgres port published');
  n8nGateway = ssh(`docker network inspect hb_${n.id.replace(/-/g, '')}_default --format '{{(index .IPAM.Config 0).Gateway}}'`).trim();
  // fixture endpoint reachable from the n8n container
  target.scp(path.join(ROOT, 'scripts/vm/fixtures/test-endpoint.mjs'), '/root/test-endpoint.mjs');
  ssh(`[ -f /root/endpoint.pid ] && kill $(cat /root/endpoint.pid) 2>/dev/null; nohup /opt/harbor/node/bin/node /root/test-endpoint.mjs ${n8nGateway} 18999 >/root/endpoint.log 2>&1 & echo $! > /root/endpoint.pid; sleep 1; cat /root/endpoint.log`);
  const { ctx, page } = await newPage();
  const url = n.endpoints[0].browserUrl;
  await page.goto(`${url}setup`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.fill('#email', N8N_OWNER.email);
  await page.fill('#firstName', N8N_OWNER.firstName);
  await page.fill('#lastName', N8N_OWNER.lastName);
  await page.fill('#password', N8N_OWNER.password);
  await page.getByRole('button', { name: 'Next' }).click();
  await sleep(3000);
  await page.screenshot({ path: path.join(ev.dir, 'A11-n8n-after-owner-setup.png') });
  const cookies = (await ctx.cookies()).filter((c) => c.name === 'n8n-auth').map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }));
  const result = await n8nWorkflowDemo(page, n8nGateway, true);
  await ctx.close();
  // second instance: different keys/volumes, private database
  const op2 = cliOk(target, ['install', 'n8n', '--yes'], { timeoutMs: 1800_000 });
  if (op2.state !== 'succeeded') throw new Error(`n8n-2 install ${op2.state}`);
  const n2 = byName('n8n-2');
  const vols = ssh('docker volume ls --format {{.Name}}').trim().split('\n');
  const v1 = vols.filter((v) => v.startsWith(`hb_${n.id.replace(/-/g, '')}_`)).sort();
  const v2 = vols.filter((v) => v.startsWith(`hb_${n2.id.replace(/-/g, '')}_`)).sort();
  const keysDiffer = ssh(`cmp -s /var/lib/harbor/instances/${n.id}/secrets/encryption-key /var/lib/harbor/instances/${n2.id}/secrets/encryption-key && echo same || echo different`).trim();
  const pwDiffer = ssh(`cmp -s /var/lib/harbor/instances/${n.id}/secrets/database-password /var/lib/harbor/instances/${n2.id}/secrets/database-password && echo same || echo different`).trim();
  if (v1.length !== 2 || v2.length !== 2 || keysDiffer !== 'different' || pwDiffer !== 'different') throw new Error(`instances share data/keys: ${JSON.stringify({ v1, v2, keysDiffer, pwDiffer })}`);
  const exca = await fetch(byName('excalidraw').endpoints[0].browserUrl);
  if (exca.status !== 200) throw new Error('Excalidraw no longer answers');
  const modes = ssh(`stat -c '%a %n' /var/lib/harbor/instances/${n.id}/secrets/* /var/lib/harbor/instances/${n.id}/runtime/compose.yaml`).trim().split('\n');
  return {
    details: { n8n: { id: n.id, port: n.endpoints[0].hostPort, containers, publishedPorts: published }, n8n2: { id: n2.id, port: n2.endpoints[0].hostPort, volumes: v2 }, volumesInstance1: v1, secretsDiffer: { encryptionKey: keysDiffer, databasePassword: pwDiffer }, authCookie: cookies, workflow: result, secretFileModes: modes },
    notes: ['owner created through the n8n setup form (synthetic credentials)', `credential + workflow created via n8n REST (as the browser does); manual execution status ${result.executionStatus}; fixture saw credentialed call: ${result.fixtureSawCredentialedCall}`, 'second n8n: separate volumes and different generated keys; no PostgreSQL port published', 'Excalidraw still answers'],
  };
});

async function n8nWorkflowDemo(page, gateway, create) {
  const rest = (p, init) => page.evaluate(async ({ p, init }) => {
    const r = await fetch(p, { ...init, headers: { 'content-type': 'application/json' }, credentials: 'same-origin' });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      /* not json */
    }
    return { status: r.status, json: j };
  }, { p, init });
  const login = await rest('/rest/login', { method: 'POST', body: JSON.stringify({ emailOrLdapLoginId: N8N_OWNER.email, password: N8N_OWNER.password }) });
  if (login.status !== 200) throw new Error(`n8n login ${login.status}`);
  let wf;
  let credId;
  if (create) {
    const cred = await rest('/rest/credentials', { method: 'POST', body: JSON.stringify({ name: 'harbor-test-endpoint', type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer harbor-test-token-123' } }) });
    if (cred.status !== 200) throw new Error(`credential create ${cred.status}`);
    credId = cred.json.data.id;
    const created = await rest('/rest/workflows', { method: 'POST', body: JSON.stringify({
      name: 'harbor-demo',
      nodes: [
        { parameters: {}, id: 'a1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        { parameters: { url: `http://${gateway}:18999/n8n-demo`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', options: {} }, id: 'b2', name: 'Call test endpoint', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 0], credentials: { httpHeaderAuth: { id: credId, name: 'harbor-test-endpoint' } } },
      ],
      connections: { 'Manual Trigger': { main: [[{ node: 'Call test endpoint', type: 'main', index: 0 }]] } },
      settings: { executionOrder: 'v1' },
      active: false,
    }) });
    if (created.status !== 200) throw new Error(`workflow create ${created.status}`);
    wf = created.json.data;
  } else {
    const list = await rest('/rest/workflows');
    const meta = (list.json?.data?.data ?? list.json?.data ?? []).find((w) => w.name === 'harbor-demo');
    if (!meta) throw new Error('harbor-demo workflow not found after reinstall');
    wf = (await rest(`/rest/workflows/${meta.id}`)).json.data;
    credId = wf.nodes.find((n) => n.credentials)?.credentials?.httpHeaderAuth?.id;
  }
  const hitsBefore = JSON.parse(ssh(`curl -s http://${gateway}:18999/__hits`)).length;
  const run = await rest(`/rest/workflows/${wf.id}/run?partialExecutionVersion=2`, { method: 'POST', body: JSON.stringify({ workflowData: wf, runData: {}, startNodes: [{ name: 'Manual Trigger', sourceData: null }], triggerToStartFrom: { name: 'Manual Trigger' } }) });
  if (run.status !== 200) throw new Error(`workflow run ${run.status} ${JSON.stringify(run.json)}`);
  const exec = await waitFor(async () => {
    const e = await rest(`/rest/executions/${run.json.data.executionId}`);
    return e.json?.data && ['success', 'error', 'crashed', 'canceled'].includes(e.json.data.status) ? e.json.data : null;
  }, { timeoutMs: 60_000, intervalMs: 1000, what: 'n8n execution' });
  const hits = JSON.parse(ssh(`curl -s http://${gateway}:18999/__hits`));
  const newHits = hits.slice(hitsBefore);
  return { workflowId: wf.id, credentialId: credId, executionId: run.json.data.executionId, executionStatus: exec.status, fixtureSawCredentialedCall: newHits.some((h) => h.ok && h.path === '/n8n-demo'), newFixtureHits: newHits };
}
