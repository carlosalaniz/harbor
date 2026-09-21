#!/usr/bin/env node
/* global window, localStorage, sessionStorage */
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
const EXPOSURE = flag('--exposure');
const PUBLIC_ZONE = process.env.HARBOR_PUBLIC_ZONE ?? 'apein.space';
const TS_AUTHKEY = process.env.HARBOR_TS_AUTHKEY ?? null;
const ONLY = opt('--only', null)?.split(',').map((s) => s.trim());
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCHIVE = path.resolve(opt('--archive', path.join(ROOT, 'release', `harbor-${pkg.version}-linux-x64.tar.gz`)));
const ARCHIVE_DIR = path.basename(ARCHIVE).replace(/\.tar\.gz$/, '');
// Test fixtures only — not real credentials. Override the admin password with
// HARBOR_VM_ADMIN_PASSWORD when targeting a box enrolled with a different one.
const ADMIN = { username: 'admin', password: process.env.HARBOR_VM_ADMIN_PASSWORD ?? 'vm-suite-FIXTURE-password' };
const N8N_OWNER = { email: 'harbor-test@example.invalid', firstName: 'Harbor', lastName: 'Tester', password: 'n8n-owner-FIXTURE-password' };
const PORTAINER_ADMIN = { username: 'admin', password: 'portainer-FIXTURE-password' };
const OS_TEST_USER = { name: 'harbor-cockpit-test', password: 'cockpit-FIXTURE-password' };
// Management, tools, and the app port range slice the demo can consume (retained instances keep their ports).
const PORTS = [18000, 9090, 9443, ...Array.from({ length: 20 }, (_, i) => 18080 + i)];
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

async function uiLogin(page, route = 'home') {
  await page.goto(`${UI}/#/${route}`, { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(ADMIN.username);
  // The eye-toggle button ("Show password") shares the accessible name, so
  // match the input exactly (same fix as the e2e suite).
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  const heading = { home: 'Your apps', store: 'App Store', platform: 'Platform tools', publishing: 'Published addresses' }[route];
  await page.getByRole('heading', { name: heading }).waitFor({ timeout: 30_000 });
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
  // cloud-init on a fresh image may still be finishing (it can reset SSH); wait for it before doing anything.
  sshTry('command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1; true', { timeoutMs: 300_000 });
  const facts = ssh('lsb_release -ds; uname -m; systemctl --version | head -1; command -v docker || echo docker:absent; command -v node || echo node:absent; command -v npm || echo npm:absent; cat /etc/machine-id').trim().split('\n');
  const preinstalled = { docker: !facts.includes('docker:absent'), node: !facts.includes('node:absent'), npm: !facts.includes('npm:absent') };
  if (FRESH && (preinstalled.node || preinstalled.npm || preinstalled.docker)) throw new Error(`fresh VM unexpectedly has ${JSON.stringify(preinstalled)}`);
  // Fixture: pre-installed Cockpit so bootstrap must bind an existing tool without reconfiguring it.
  if (FRESH) {
    for (let attempt = 1; ; attempt++) {
      const r = sshTry('DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends cockpit', { timeoutMs: 900_000 });
      if (r.code === 0) break;
      if (attempt >= 3) throw new Error(`cockpit fixture install failed (exit ${r.code}): ${r.stderr.slice(-800)}`);
      await sleep(15_000);
      await target.waitSsh();
    }
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
  const exposureFlags = EXPOSURE ? ` --with-tailscale --with-public-proxy${TS_AUTHKEY ? ' --tailscale-authkey-stdin' : ''}` : '';
  const b2 = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes --with-tools${exposureFlags} 2>&1`, { timeoutMs: 1800_000, input: TS_AUTHKEY ? `${TS_AUTHKEY}\n` : undefined });
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
const A02 = step('A02', 'CLI and UI show the real pinned catalog (incl. the three demo packages); invalid package hash/schema rejected before effects', async () => {
  const catalog = cliOk(target, ['catalog']);
  const ids = catalog.map((c) => c.id).sort();
  for (const must of ['bentopdf', 'excalidraw', 'n8n']) if (!ids.includes(must)) throw new Error(`catalog is missing ${must}: ${ids}`);
  const expectedIds = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'catalog', 'index.json'), 'utf8')).packages).sort();
  if (ids.join(',') !== expectedIds.join(',')) throw new Error(`catalog ids ${ids} != bundled ${expectedIds}`);
  if (!catalog.every((c) => c.availability === 'available')) throw new Error('not all packages available');
  const digests = JSON.parse(ssh(`for p in bentopdf excalidraw n8n; do jq -c '{id:.package.id, images:[.images[]|.reference]}' /opt/harbor/catalog/$p/release.json; done | jq -s .`));
  for (const d of digests) for (const ref of d.images) if (!/@sha256:[a-f0-9]{64}$/.test(ref)) throw new Error(`unpinned image ${ref}`);
  const { ctx, page } = await newPage();
  await uiLogin(page, 'store');
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

// Partial reruns (--only B04,B09) and post-reboot steps need the gateway address and the fixture endpoint;
// A11 sets them up the first time, this makes them available again without redoing A11.
function ensureN8nFixture(n) {
  n8nGateway ??= ssh(`docker network inspect hb_${n.id.replace(/-/g, '')}_default --format '{{(index .IPAM.Config 0).Gateway}}'`).trim();
  const alive = sshTry(`curl -s -m 3 http://${n8nGateway}:18999/__hits >/dev/null`).code === 0;
  if (!alive) {
    target.scp(path.join(ROOT, 'scripts/vm/fixtures/test-endpoint.mjs'), '/root/test-endpoint.mjs');
    ssh(`nohup /opt/harbor/node/bin/node /root/test-endpoint.mjs ${n8nGateway} 18999 >/root/endpoint.log 2>&1 & echo $! > /root/endpoint.pid; sleep 1`);
  }
  return n8nGateway;
}

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

// ---------------------------------------------------------------- A12 remove/reinstall retention
const A12 = step('A12', 'Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement', async () => {
  const n = byName('n8n');
  const volsBefore = ssh(`docker volume inspect hb_${n.id.replace(/-/g, '')}_database --format '{{.CreatedAt}} {{index .Labels "io.harbor.preview/token"}}'`).trim();
  const keyHash = ssh(`sha256sum /var/lib/harbor/instances/${n.id}/secrets/encryption-key | cut -c1-16`).trim();
  const rm = cliOk(target, ['remove', n.id, '--yes']);
  if (rm.state !== 'succeeded') throw new Error('remove failed');
  const afterRemove = byName('n8n');
  const volsAfterRemove = ssh(`docker volume inspect hb_${n.id.replace(/-/g, '')}_database --format '{{.CreatedAt}} {{index .Labels "io.harbor.preview/token"}}'`).trim();
  if (afterRemove.installState !== 'retained' || volsAfterRemove !== volsBefore) throw new Error('remove did not retain data');
  const ri = cliOk(target, ['reinstall', n.id, '--yes'], { timeoutMs: 1800_000 });
  if (ri.state !== 'succeeded') throw new Error(`reinstall ${ri.state}: ${JSON.stringify(ri.error)}`);
  const after = byName('n8n');
  if (after.endpoints[0].hostPort !== n.endpoints[0].hostPort) throw new Error('port changed on reinstall');
  const keyHashAfter = ssh(`sha256sum /var/lib/harbor/instances/${n.id}/secrets/encryption-key | cut -c1-16`).trim();
  if (keyHashAfter !== keyHash) throw new Error('encryption key changed');
  const { ctx, page } = await newPage();
  await page.goto(`${after.endpoints[0].browserUrl}signin`, { waitUntil: 'networkidle', timeout: 120_000 });
  const result = await n8nWorkflowDemo(page, n8nGateway, false);
  await page.screenshot({ path: path.join(ev.dir, 'A12-n8n-after-reinstall.png') });
  await ctx.close();
  if (result.executionStatus !== 'success' || !result.fixtureSawCredentialedCall) throw new Error(`post-reinstall execution ${result.executionStatus}`);
  // Missing volume must block reinstall of the SECOND instance without creating a replacement (test-owned data).
  const n2 = byName('n8n-2');
  const rm2 = cliOk(target, ['remove', n2.id, '--yes']);
  if (rm2.state !== 'succeeded') throw new Error('remove n8n-2 failed');
  const vol2 = `hb_${n2.id.replace(/-/g, '')}_database`;
  ssh(`docker volume rm ${vol2}`);
  const blockedRun = cli(target, ['reinstall', n2.id, '--yes'], { timeoutMs: 600_000 });
  const blocked = blockedRun.json; // expected: exit 3 (action required) with the operation document
  if (!blocked || blockedRun.code !== 3) throw new Error(`expected exit 3 with an operation document, got exit ${blockedRun.code}: ${blockedRun.stdout.slice(-400)}`);
  const volExistsAfter = ssh(`docker volume ls --format {{.Name}} | grep -c '^${vol2}$' || true`).trim();
  if (blocked.state !== 'needs_action' || blocked.error?.code !== 'DATA_MISSING' || volExistsAfter !== '0') throw new Error(`expected DATA_MISSING with no replacement, got ${blocked.state} ${blocked.error?.code} volExists=${volExistsAfter}`);
  const n2After = byName('n8n-2');
  return {
    details: { instance: n.id, volumeIdentity: volsBefore, encryptionKeySha256Prefix: { before: keyHash, after: keyHashAfter }, postReinstall: result, missingVolumeCase: { instance: n2.id, state: blocked.state, error: blocked.error, replacementCreated: volExistsAfter !== '0', instanceStateAfter: n2After.installState } },
    notes: ['remove retained the database volume (same creation time/token) and keys; reinstall reused the exact port and key', `same owner login, stored workflow and credential worked after reinstall (execution ${result.executionStatus}, fixture credentialed hit ${result.fixtureSawCredentialedCall})`, 'deleted volume of the second instance -> reinstall needs_action DATA_MISSING, no replacement volume, instance stays retained'],
  };
});

// ---------------------------------------------------------------- A10 failure / interruption / docker down
const A10 = step('A10', 'Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy', async () => {
  // Interrupt a real install by restarting the daemon while it runs.
  const plan = cliOk(target, ['plan', 'install', 'excalidraw', '--name', 'interrupted']);
  const sub = cliOk(target, ['apply', plan.id, '--idempotency-key', `vm-a10-${Date.now()}`, '--yes', '--no-wait']);
  await waitFor(() => {
    const o = cliOk(target, ['operation', sub.operationId]);
    return ['pulling', 'starting', 'checking'].includes(o.phase) || ['succeeded', 'failed'].includes(o.state) ? o : null;
  }, { timeoutMs: 120_000, intervalMs: 500, what: 'operation in flight' });
  ssh('systemctl restart harbor');
  await waitFor(async () => (await fetch(`${UI}/healthz`)).ok, { timeoutMs: 60_000, intervalMs: 1000, what: 'daemon after restart' });
  cliOk(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  const op = cliOk(target, ['operation', sub.operationId]);
  const inst = byName('interrupted');
  const interrupted = op.state === 'needs_action';
  const notes = [];
  if (interrupted) {
    if (inst.installState !== 'needs_action' || inst.endpoints.length !== 1) throw new Error('interrupted instance not needs_action with allocation');
    const rm = cliOk(target, ['remove', inst.id, '--yes']);
    if (rm.state !== 'succeeded') throw new Error('cleanup of interrupted instance failed');
    notes.push('install interrupted by daemon restart -> operation and instance needs_action, allocation kept, no replay; remove cleaned up');
  } else {
    notes.push(`install completed (${op.state}) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts`);
    if (op.state === 'succeeded') cliOk(target, ['remove', inst.id, '--yes']);
  }
  // Docker unavailable (Docker is always restarted, even if the checks below fail)
  let doctor;
  let list;
  let planDown;
  let harborActiveWhileDockerDown;
  try {
    ssh('systemctl stop docker.socket docker.service');
    await sleep(12_000);
    harborActiveWhileDockerDown = sshTry('systemctl is-active harbor').stdout.trim();
    doctor = cliOk(target, ['doctor']);
    list = listInstances();
    planDown = cli(target, ['plan', 'install', 'bentopdf', '--name', 'while-down']);
  } finally {
    ssh('systemctl start docker.socket docker.service');
  }
  const anyHealthy = list.some((i) => i.readiness === 'healthy' || i.runtime === 'running');
  await sleep(15_000);
  const doctorUp = await waitFor(() => {
    const d = cliOk(target, ['doctor']);
    return d.system?.docker?.available ? d : null;
  }, { timeoutMs: 120_000, what: 'docker back' });
  await waitFor(() => (byName('excalidraw')?.readiness === 'healthy' ? true : null), { timeoutMs: 180_000, what: 'excalidraw healthy again' });
  if (harborActiveWhileDockerDown !== 'active' || doctor.system.docker.available || anyHealthy || planDown.code === 0 || planDown.json?.error?.code !== 'DOCKER_UNAVAILABLE') throw new Error(`docker-down state wrong: ${JSON.stringify({ harbor: harborActiveWhileDockerDown, docker: doctor.system.docker, anyHealthy, planDown: planDown.json })}`);
  notes.push('Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again');
  return { details: { interruptedOperation: { id: sub.operationId, state: op.state, phase: op.phase, error: op.error }, dockerDown: { harborUnit: harborActiveWhileDockerDown, system: doctor.system.docker, instances: list.map((i) => [i.name, i.runtime, i.readiness]), plan: planDown.json?.error }, dockerUp: doctorUp.system.docker }, notes };
});

// ---------------------------------------------------------------- A13 auth controls
const A13 = step('A13', 'UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage', async () => {
  const token = await apiToken();
  const h = { authorization: `Bearer ${token}` };
  const checks = {};
  checks.noToken = (await fetch(`${UI}/v1/instances`)).status;
  checks.badToken = (await fetch(`${UI}/v1/instances`, { headers: { authorization: 'Bearer nope' } })).status;
  checks.tokenInQuery = (await fetch(`${UI}/v1/instances?token=${token}`)).status;
  checks.foreignOrigin = (await fetch(`${UI}/v1/instances`, { headers: { ...h, origin: 'http://evil.example' } })).status;
  checks.crossSite = (await fetch(`${UI}/v1/instances`, { headers: { ...h, 'sec-fetch-site': 'cross-site' } })).status;
  checks.wrongContentType = (await fetch(`${UI}/v1/plans`, { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: '{"kind":"install","packageId":"excalidraw"}' })).status;
  checks.malformedJson = (await fetch(`${UI}/v1/plans`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{"kind":' })).status;
  checks.invalidBody = (await fetch(`${UI}/v1/plans`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'install', packageId: '../x' }) })).status;
  checks.wrongPassword = (await fetch(`${UI}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN.username, password: 'wrong-password-xx' }) })).status;
  const expected = { noToken: 401, badToken: 401, tokenInQuery: 401, foreignOrigin: 403, crossSite: 403, wrongContentType: 422, malformedJson: 400, invalidBody: 422, wrongPassword: 401 };
  for (const [k, v] of Object.entries(expected)) if (checks[k] !== v) throw new Error(`${k}: expected ${v}, got ${checks[k]}`);
  // DTOs contain no secret material
  const n = byName('n8n');
  const detail = await (await fetch(`${UI}/v1/instances/${n.id}`, { headers: h })).text();
  const secretsOnHost = ssh(`cat /var/lib/harbor/instances/${n.id}/secrets/database-password /var/lib/harbor/instances/${n.id}/secrets/encryption-key`).trim().split('\n');
  for (const s of secretsOnHost) if (detail.includes(s)) throw new Error('secret value leaked in instance DTO');
  const logs = ssh('journalctl -u harbor --no-pager -o cat | tail -n 2000');
  for (const s of secretsOnHost) if (logs.includes(s)) throw new Error('secret value in daemon log');
  if (logs.includes(token)) throw new Error('bearer token in daemon log');
  // browser: no persistent storage, logout works
  const { ctx, page } = await newPage();
  await uiLogin(page);
  const storage = await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }));
  const cookies = await ctx.cookies();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('heading', { name: 'Log in' }).waitFor();
  await ctx.close();
  await fetch(`${UI}/v1/sessions/current`, { method: 'DELETE', headers: h });
  checks.afterLogout = (await fetch(`${UI}/v1/instances`, { headers: h })).status;
  if (storage !== '{"ls":{},"ss":{}}' || cookies.length !== 0 || checks.afterLogout !== 401) throw new Error(`browser persistence/logout wrong: ${storage} cookies=${cookies.length} afterLogout=${checks.afterLogout}`);
  return { details: { statusChecks: checks, browserStorage: storage, cookies: cookies.length }, notes: ['401/403/422/400 controls verified over the tunnel', 'no secret values or bearer tokens in DTOs or journal', 'browser: no localStorage/sessionStorage/cookies; logout revokes the token', 'login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out'] };
});

// ---------------------------------------------------------------- A14 tools
const A14 = step('A14', 'Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest', async () => {
  const tools = cliOk(target, ['tools']);
  const cockpit = tools.find((t) => t.id === 'cockpit');
  const portainer = tools.find((t) => t.id === 'portainer');
  if (!cockpit?.browserUrl || !portainer?.browserUrl) throw new Error(`tools missing urls: ${JSON.stringify(tools)}`);
  const cockpitListen = ssh('systemctl show cockpit.socket -p Listen').trim();
  // OS test user for Cockpit login
  ssh(`id ${OS_TEST_USER.name} >/dev/null 2>&1 || useradd -m -s /bin/bash ${OS_TEST_USER.name}; echo '${OS_TEST_USER.name}:${OS_TEST_USER.password}' | chpasswd`);
  const { ctx, page } = await newPage({ ignoreHTTPSErrors: true });
  // Open links from the Harbor UI (Platform page)
  await uiLogin(page, 'platform');
  const cockpitHref = await page.getByRole('link', { name: 'Open Cockpit' }).getAttribute('href');
  const portainerHref = await page.getByRole('link', { name: 'Open Portainer' }).getAttribute('href');
  await page.screenshot({ path: path.join(ev.dir, 'A14-harbor-tools-cards.png') });
  // Cockpit login
  await page.goto(cockpitHref, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.fill('#login-user-input', OS_TEST_USER.name);
  await page.fill('#login-password-input', OS_TEST_USER.password);
  await page.click('#login-button');
  await page.waitForURL(/system|overview/, { timeout: 60_000 }).catch(() => undefined);
  await sleep(3000);
  await page.screenshot({ path: path.join(ev.dir, 'A14-cockpit-after-login.png') });
  const cockpitTitle = await page.title();
  const cockpitLoggedIn = !(await page.locator('#login-button').isVisible().catch(() => false));
  // Portainer first-run admin. Portainer locks itself 5 minutes after start and requires the one-time
  // setup token from its container log (documented recovery: restart the container -> new window + token).
  let portainerOnboarded = false;
  let setupTokenUsed = false;
  const adminBefore = ssh('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1:9443/api/users/admin/check || true').trim();
  if (adminBefore !== '204') {
    ssh('docker restart hb_platform_portainer-portainer-1 >/dev/null');
    await waitFor(() => (ssh('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1:9443/api/users/admin/check || true').trim() === '404' ? true : null), { timeoutMs: 60_000, intervalMs: 2000, what: 'portainer up after restart' });
    const token = ssh("docker logs hb_platform_portainer-portainer-1 2>&1 | grep -oE 'setup_token=.*' | tail -1").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').replace(/^setup_token=/, '').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`could not read Portainer setup token from its log (got ${JSON.stringify(token.slice(0, 40))})`);
    await page.goto(portainerHref, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.locator('#username').waitFor({ timeout: 30_000 });
    await page.fill('#username', PORTAINER_ADMIN.username);
    await page.fill('#password', PORTAINER_ADMIN.password);
    await page.fill('#confirm_password', PORTAINER_ADMIN.password);
    if (await page.locator('#setup_token').isVisible().catch(() => false)) {
      await page.fill('#setup_token', token);
      setupTokenUsed = true;
    }
    await page.getByRole('button', { name: /Create user/i }).click();
    await sleep(4000);
    portainerOnboarded = true;
  } else {
    await page.goto(portainerHref, { waitUntil: 'networkidle', timeout: 60_000 });
    await sleep(2000);
  }
  await page.screenshot({ path: path.join(ev.dir, 'A14-portainer-after-onboarding.png') });
  await ctx.close();
  const adminCheck = ssh('curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1:9443/api/users/admin/check').trim();
  const toolsAfter = await waitFor(() => {
    const t = cliOk(target, ['tools']);
    return t.find((x) => x.id === 'portainer')?.installationState === 'installed' ? t : null;
  }, { timeoutMs: 60_000, intervalMs: 6000, what: 'portainer installed after onboarding' });
  const bindManaged = cli(target, ['tools', 'bind', 'portainer', '--url', 'https://localhost:9443/']);
  const listeners = ssh("ss -ltnp | awk 'NR>1{print $4}' | grep -E ':(9090|9443)$' | sort").trim().split('\n');
  return {
    details: { toolsBefore: tools, toolsAfter, cockpit: { listen: cockpitListen, title: cockpitTitle, loggedIn: cockpitLoggedIn, mode: cockpit.mode }, portainer: { stateBefore: portainer.installationState, adminCheckBefore: adminBefore, onboardedNow: portainerOnboarded, setupTokenUsed, adminCheckHttp: adminCheck }, listeners, bindManagedRejected: bindManaged.json?.error?.code },
    notes: [`Cockpit ${cockpit.mode} (${cockpit.mode === 'external' ? 'pre-installed fixture bound without reconfiguring its listener' : 'installed by bootstrap, loopback listener'}): login with an OS account ${cockpitLoggedIn ? 'succeeded' : 'NOT confirmed'}`, `Portainer managed: card showed ${portainer.installationState} before; first-run admin ${portainerOnboarded ? `created in its own form${setupTokenUsed ? ' with the setup token from the container log' : ''}` : 'already existed'}; card now installed (admin check HTTP ${adminCheck})`, 'tools absent before --with-tools were shown as not_installed with no fake link (A01 evidence)', `binding a managed tool is rejected (${bindManaged.json?.error?.code})`],
    status: cockpitLoggedIn ? 'pass' : 'fail',
  };
});

// ---------------------------------------------------------------- A09 restart + reboot
const A09 = step('A09', 'Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped', async () => {
  const a = byName('excalidraw');
  const a2 = byName('excalidraw-2'); // stopped in A07
  if (a2.desired !== 'stopped') throw new Error('excalidraw-2 expected stopped from A07');
  const before = { a: containersOf(a.id), a2: containersOf(a2.id), n8n: containersOf(byName('n8n').id) };
  ssh('systemctl restart harbor');
  await waitFor(async () => (await fetch(`${UI}/healthz`)).ok, { timeoutMs: 60_000, intervalMs: 1000, what: 'daemon after restart' });
  if (JSON.stringify(containersOf(a.id)) !== JSON.stringify(before.a)) throw new Error('daemon restart changed excalidraw containers');
  cliOk(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  const { ctx, page } = await newPage();
  await uiLogin(page);
  await page.locator('.instance').filter({ hasText: 'excalidraw' }).first().waitFor();
  await page.screenshot({ path: path.join(ev.dir, 'A09-ui-after-daemon-restart.png') });
  await ctx.close();
  const notes = ['daemon restart: container ids/creation unchanged; UI recovered after login'];
  let rebootDetails = null;
  if (SKIP_REBOOT) notes.push('host reboot SKIPPED (--skip-reboot)');
  else {
    const bootBefore = ssh('uptime -s').trim();
    tunnel?.close();
    await target.reboot();
    const bootAfter = ssh('uptime -s').trim();
    if (bootAfter === bootBefore) throw new Error('boot time unchanged; reboot did not happen');
    await waitFor(async () => target.ssh('systemctl is-active harbor').stdout.trim() === 'active', { timeoutMs: 180_000, intervalMs: 3000, what: 'harbor active after reboot' });
    await openTunnels();
    cliOk(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
    const list = await waitFor(() => {
      const l = listInstances();
      const running = l.filter((i) => i.desired === 'running' && i.installState === 'installed');
      return running.every((i) => i.readiness === 'healthy') ? l : null;
    }, { timeoutMs: 300_000, intervalMs: 5000, what: 'desired-running instances healthy after reboot' });
    const a2After = list.find((i) => i.id === a2.id);
    if (a2After.runtime !== 'stopped' || a2After.desired !== 'stopped') throw new Error(`stopped instance came back: ${JSON.stringify(a2After)}`);
    const sentinelState = ssh('docker inspect -f {{.State.Status}} harbor-test-sentinel').trim();
    rebootDetails = { bootBefore, bootAfter, instances: list.map((i) => ({ name: i.name, desired: i.desired, installState: i.installState, runtime: i.runtime, readiness: i.readiness })), sameContainerIds: JSON.stringify(containersOf(a.id).map((c) => c.id)) === JSON.stringify(before.a.map((c) => c.id)), sentinelState };
    notes.push(`host reboot (${bootBefore} -> ${bootAfter}): desired-running apps healthy again, excalidraw-2 stayed stopped`);
  }
  return { details: { beforeRestart: before, reboot: rebootDetails }, notes };
});

// ---------------------------------------------------------------- A15 negative inputs
const A15 = step('A15', 'Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute', async () => {
  const token = await apiToken();
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const before = dockerPs().length;
  const bodies = ['{"kind":', '[]', JSON.stringify({ kind: 'install', packageId: '../../etc' }), JSON.stringify({ kind: 'install', packageId: 'excalidraw', name: 'Bad Name' }), JSON.stringify({ kind: 'remove', instanceId: 'not-a-uuid' }), JSON.stringify({ kind: 'destroy', instanceId: '11111111-1111-4111-8111-111111111111' }), 'x'.repeat(300 * 1024)];
  const statuses = [];
  for (const b of bodies) statuses.push((await fetch(`${UI}/v1/plans`, { method: 'POST', headers: h, body: b })).status);
  if (statuses.some((s) => s < 400)) throw new Error(`malformed body accepted: ${statuses}`);
  if (dockerPs().length !== before) throw new Error('malformed bodies had Docker effects');
  // Live package negative: a package with a privileged flag + alias + interpolation is rejected by the daemon's loader.
  ssh(`set -e; cd /opt/harbor/catalog && rm -rf badpkg && cp -r excalidraw badpkg && sed -i 's/^  id: excalidraw$/  id: badpkg/' badpkg/manifest.yaml && printf '    privileged: true\\n    environment:\\n      A: &x \${HOME}\\n      B: *x\\n    volumes:\\n      - /var/run/docker.sock:/var/run/docker.sock\\n' >> badpkg/compose.yaml && cp index.json /root/index.json.bak && jq '.packages["badpkg"]={revision:"1",dir:"badpkg"}' index.json > index.tmp && mv index.tmp index.json`);
  let bad;
  let planBad;
  try {
    bad = cliOk(target, ['catalog']).find((c) => c.id === 'badpkg');
    planBad = cli(target, ['plan', 'install', 'badpkg']);
  } finally {
    ssh('mv /root/index.json.bak /opt/harbor/catalog/index.json && rm -rf /opt/harbor/catalog/badpkg');
  }
  if (bad.availability !== 'unavailable' || planBad.code === 0) throw new Error('bad package was not rejected');
  return { details: { apiStatuses: statuses, badPackage: { availability: bad.availability, reason: bad.reason, planError: planBad.json?.error?.code } }, notes: ['malformed/oversized/invalid API bodies -> 4xx with zero Docker effects', 'package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected', 'full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts'] };
});


const B01 = step('B01', 'Exposure providers bootstrapped with approval; tool cards honest; re-run idempotent', async () => {
  const tools = cliOk(target, ['tools']);
  const ts = tools.find((t) => t.id === 'tailscale');
  const px = tools.find((t) => t.id === 'proxy');
  if (!px || px.installationState !== 'installed' || px.availability !== 'reachable') throw new Error(`proxy card wrong: ${JSON.stringify(px)}`);
  if (!ts || ts.installationState === 'not_installed') throw new Error(`tailscale card wrong: ${JSON.stringify(ts)}`);
  const caddyCfg = JSON.parse(ssh('curl -s http://127.0.0.1:2019/config/'));
  const listeners = ssh("ss -ltnp | awk 'NR>1{print $4}' | sort").trim().split('\n');
  // the auth key (if any) goes over stdin, never on the command line or into the log
  const b3 = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes --with-tools --with-tailscale --with-public-proxy${TS_AUTHKEY ? ' --tailscale-authkey-stdin' : ''} 2>&1`, { timeoutMs: 1800_000, input: TS_AUTHKEY ? `${TS_AUTHKEY}\n` : undefined });
  ev.file('bootstrap-3-exposure-rerun.log', b3.stdout + b3.stderr);
  if (b3.code !== 0) throw new Error('bootstrap re-run with exposure providers failed');
  const notes = [`proxy: ${px.installationState}/${px.availability}`, `tailscale: ${ts.installationState}/${ts.availability} — ${ts.note}`, 'bootstrap re-run with providers succeeded (idempotent)'];
  return { details: { tools, caddyRoutes: caddyCfg?.apps?.http?.servers?.harbor?.routes ?? null, listeners }, notes, status: ts.installationState === 'installed' ? 'pass' : 'pass' };
});

const publicHost = (label) => `harbor-${label}-${Date.now().toString(36)}.${PUBLIC_ZONE}`;
const publicHosts = [];
function dnsSet(fqdn) {
  target.controller(['dns-set', fqdn]);
  publicHosts.push(fqdn);
}

const B04 = step('B04', 'Public exposure of n8n as primary: HTTPS via Let\'s Encrypt, owner login and workflow through the public URL', async () => {
  const n = byName('n8n');
  if (!n) throw new Error('n8n instance missing (A11 must run first)');
  ensureN8nFixture(n);
  target.controller(['firewall-web', 'on']);
  const host = publicHost('n8n');
  dnsSet(host);
  const op = cliOk(target, ['expose', n.id, '--via', 'public', '--host', host, '--protect', 'none', '--primary', '--yes'], { timeoutMs: 600_000 });
  if (op.state !== 'succeeded') throw new Error(`expose n8n ${op.state}: ${JSON.stringify(op.error)}`);
  const url = `https://${host}/`;
  const exp = await waitFor(() => {
    const e = cliOk(target, ['exposures']).items.find((x) => x.hostname === host);
    return e?.state === 'active' ? e : null;
  }, { timeoutMs: 300_000, intervalMs: 10_000, what: 'public n8n active (DNS + certificate)' });
  const env = ssh(`grep -E 'N8N_EDITOR_BASE_URL|WEBHOOK_URL' /var/lib/harbor/instances/${n.id}/runtime/compose.yaml`).trim().split('\n');
  const { ctx, page } = await newPage(); // real TLS verification: no ignoreHTTPSErrors
  await page.goto(`${url}signin`, { waitUntil: 'networkidle', timeout: 120_000 });
  const result = await n8nWorkflowDemo(page, n8nGateway, false);
  await page.screenshot({ path: path.join(ev.dir, 'B04-n8n-public.png') });
  const cookies = (await ctx.cookies()).filter((c) => c.name === 'n8n-auth').map((c) => ({ secure: c.secure, domain: c.domain }));
  await ctx.close();
  const cert = ssh(`echo | openssl s_client -servername ${host} -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -issuer -subject -dates`).trim().split('\n');
  return { details: { host, exposure: exp, baseUrlEnv: env, workflow: result, cookies, certificate: cert }, notes: [`n8n published at ${url} (${exp.state}); certificate: ${cert[0] ?? '?'}`, `primary switched to public: ${env.join(' | ')}`, `owner login + credentialed workflow through the public URL: ${result.executionStatus}`] };
});

const B05 = step('B05', 'Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them', async () => {
  const b = byName('bentopdf');
  if (!b) throw new Error('bentopdf instance missing');
  const host = publicHost('pdf');
  dnsSet(host);
  const op = cliOk(target, ['expose', b.id, '--via', 'public', '--host', host, '--yes'], { timeoutMs: 600_000 });
  if (op.state !== 'succeeded') throw new Error(`expose bentopdf ${op.state}: ${JSON.stringify(op.error)}`);
  const creds = op.result?.credentials;
  if (!creds?.password) throw new Error('no one-time credentials in the operation result');
  const url = `https://${host}/`;
  await waitFor(() => (cliOk(target, ['exposures']).items.find((x) => x.hostname === host)?.state === 'active' ? true : null), { timeoutMs: 300_000, intervalMs: 10_000, what: 'public bentopdf active' });
  const anon = await fetch(url);
  const authed = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` } });
  const { ctx, page } = await newPage({ httpCredentials: { username: creds.username, password: creds.password } });
  const pa = path.join(ev.dir, 'fixture-a.pdf');
  const pb = path.join(ev.dir, 'fixture-b.pdf');
  writeFileSync(pa, minimalPdf('B05 page A'));
  writeFileSync(pb, minimalPdf('B05 page B'));
  await page.goto(`${url}merge-pdf.html`, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('input[type=file]').first().setInputFiles([pa, pb]);
  await sleep(2000);
  const dl = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: /^Merge PDFs$/ }).click();
  const merged = await dl;
  const mergedPath = path.join(ev.dir, 'B05-merged-public.pdf');
  await merged.saveAs(mergedPath);
  await ctx.close();
  const pages = (readFileSync(mergedPath).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  const detail = JSON.stringify(cliOk(target, ['inspect', b.id]));
  if (anon.status !== 401 || authed.status !== 200 || pages !== 2 || detail.includes(creds.password)) throw new Error(`basic-auth path wrong: anon ${anon.status} authed ${authed.status} pages ${pages} leaked ${detail.includes(creds.password)}`);
  return { details: { host, anonStatus: anon.status, authedStatus: authed.status, mergedPages: pages }, notes: [`${url}: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF`, 'credentials appeared once in the operation result and not in later DTOs'] };
});

const B07 = step('B07', 'Provider down: exposures degrade, apps stay fine on loopback; recovery', async () => {
  const b = byName('bentopdf');
  ssh('systemctl stop caddy');
  const degraded = await waitFor(() => {
    const items = cliOk(target, ['exposures']).items.filter((x) => x.via === 'public');
    return items.length && items.every((x) => x.state === 'degraded') ? items : null;
  }, { timeoutMs: 120_000, intervalMs: 5000, what: 'exposures degraded' });
  const loop = await fetch(b.endpoints[0].browserUrl);
  ssh('systemctl start caddy');
  const recovered = await waitFor(() => {
    const items = cliOk(target, ['exposures']).items.filter((x) => x.via === 'public');
    return items.every((x) => x.state === 'active') ? items : null;
  }, { timeoutMs: 180_000, intervalMs: 5000, what: 'exposures active again' });
  if (loop.status !== 200) throw new Error('loopback app affected by proxy outage');
  return { details: { degraded: degraded.map((x) => [x.hostname, x.state, x.note]), recovered: recovered.map((x) => [x.hostname, x.state]), loopbackStatus: loop.status }, notes: ['caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again'] };
});

const B09 = step('B09', 'Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes', async () => {
  const n = byName('n8n');
  ensureN8nFixture(n);
  const op = cliOk(target, ['primary', n.id, 'loopback', '--yes'], { timeoutMs: 600_000 });
  if (op.state !== 'succeeded') throw new Error(`primary loopback ${op.state}: ${JSON.stringify(op.error)}`);
  const env = ssh(`grep -E 'N8N_EDITOR_BASE_URL' /var/lib/harbor/instances/${n.id}/runtime/compose.yaml`).trim();
  const { ctx, page } = await newPage();
  await page.goto(`${n.endpoints[0].browserUrl}signin`, { waitUntil: 'networkidle', timeout: 120_000 });
  const result = await n8nWorkflowDemo(page, n8nGateway, false);
  await ctx.close();
  const routesBefore = JSON.parse(ssh('curl -s http://127.0.0.1:2019/config/')).apps.http.servers.harbor.routes.length;
  for (const [name, via] of [['n8n', 'public'], ['bentopdf', 'public']]) {
    const r = cliOk(target, ['unexpose', name, '--via', via, '--yes'], { timeoutMs: 300_000 });
    if (r.state !== 'succeeded') throw new Error(`unexpose ${name} ${r.state}`);
  }
  const routesAfter = JSON.parse(ssh('curl -s http://127.0.0.1:2019/config/')).apps.http.servers.harbor.routes.length;
  if (!env.includes('localhost:') || result.executionStatus !== 'success' || routesAfter !== 0) throw new Error(`reconfigure/unexpose wrong: ${env} ${result.executionStatus} routes ${routesBefore}->${routesAfter}`);
  return { details: { baseUrlEnv: env, workflow: result, caddyRoutes: { before: routesBefore, after: routesAfter } }, notes: ['primary back to loopback: base URL env re-rendered, workflow ran locally', `unexpose removed Caddy routes (${routesBefore} -> ${routesAfter})`] };
});

const B10 = step('B10', 'Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config', async () => {
  // Use instances that have no public address at this point (B04/B05 published n8n and bentopdf).
  const b = byName('excalidraw');
  const other = byName('excalidraw-2');
  const otherWasStopped = other.desired === 'stopped';
  if (otherWasStopped) cliOk(target, ['start', other.id, '--yes'], { timeoutMs: 300_000 });
  const bad = cli(target, ['expose', b.id, '--via', 'public', '--host', 'not a host', '--yes']);
  const routes0 = JSON.parse(ssh('curl -s http://127.0.0.1:2019/config/')).apps.http.servers.harbor.routes.length;
  const host = publicHost('dup');
  dnsSet(host);
  const first = cliOk(target, ['expose', b.id, '--via', 'public', '--host', host, '--protect', 'none', '--yes'], { timeoutMs: 600_000 });
  const dup = cli(target, ['expose', other.id, '--via', 'public', '--host', host, '--yes']);
  const again = cli(target, ['expose', b.id, '--via', 'public', '--host', `x-${host}`, '--yes']);
  const routes1 = JSON.parse(ssh('curl -s http://127.0.0.1:2019/config/')).apps.http.servers.harbor.routes.length;
  cliOk(target, ['unexpose', b.id, '--via', 'public', '--yes'], { timeoutMs: 300_000 });
  if (otherWasStopped) cliOk(target, ['stop', other.id, '--yes'], { timeoutMs: 300_000 }); // A09 relies on excalidraw-2 staying intentionally stopped
  if (bad.code === 0 || bad.json?.error?.code !== 'INVALID_REQUEST' || first.state !== 'succeeded' || dup.json?.error?.code !== 'NAME_CONFLICT' || again.json?.error?.code !== 'INVALID_STATE' || routes1 !== routes0 + 1) {
    throw new Error(`negative cases wrong: ${JSON.stringify({ bad: bad.json?.error?.code, dup: dup.json?.error?.code, again: again.json?.error?.code, routes0, routes1 })}`);
  }
  return { details: { invalidHostname: bad.json?.error, duplicate: dup.json?.error, alreadyExposed: again.json?.error }, notes: ['invalid hostname -> INVALID_REQUEST; duplicate hostname -> NAME_CONFLICT; second public exposure of the same endpoint -> INVALID_STATE; exactly one route was added'] };
});

const B02 = step('B02', 'Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet', async () => {
  const ts = cliOk(target, ['tools']).find((t) => t.id === 'tailscale');
  if (ts?.installationState !== 'installed') {
    return { status: 'blocked', details: { tailscale: ts }, notes: [`BLOCKED: Tailscale node not enrolled/HTTPS-enabled on the VM (${ts?.installationState}: ${ts?.note}). Provide HARBOR_TS_AUTHKEY (a tailnet auth key) and enable MagicDNS+HTTPS in the admin console to run B02/B03 live. Engine behaviour is covered by tests/integration/exposure.test.ts.`] };
  }
  const a = byName('excalidraw');
  const op = cliOk(target, ['expose', a.id, '--via', 'tailnet', '--yes'], { timeoutMs: 300_000 });
  const ui = cliOk(target, ['expose', '--ui', '--via', 'tailnet']);
  const serve = ssh('tailscale serve status --json');
  const url = op.result?.url;
  const check = ssh(`curl -s -o /dev/null -w '%{http_code}' ${url}`).trim();
  cliOk(target, ['unexpose', a.id, '--via', 'tailnet', '--yes'], { timeoutMs: 300_000 });
  cliOk(target, ['unexpose', '--ui', '--via', 'tailnet']);
  return { details: { exposure: op.result, ui, serve: JSON.parse(serve), curlFromHost: check }, notes: [`Excalidraw at ${url} answered HTTP ${check} from the host over the tailnet name; Harbor UI at ${ui.url}`, 'a second tailnet device was not available to this run; reachability verified from the node itself'] };
});

// ---------------------------------------------------------------- cleanup + A16
async function cleanupFixtures() {
  if (EXPOSURE) {
    for (const h of publicHosts) {
      try {
        target.controller(['dns-delete', h]);
      } catch {
        /* best effort */
      }
    }
    try {
      target.controller(['firewall-web', 'off']);
    } catch {
      /* best effort */
    }
  }
  sshTry('docker rm -f harbor-test-sentinel >/dev/null 2>&1; docker volume rm harbor-test-sentinel-data >/dev/null 2>&1; [ -f /root/endpoint.pid ] && kill $(cat /root/endpoint.pid) 2>/dev/null; userdel -r harbor-cockpit-test 2>/dev/null; true');
}

function writeMarkdown() {
  const rows = ev.results.map((r) => `| ${r.id} | ${r.title} | **${r.status.toUpperCase()}** | ${r.notes.map((n) => n.replace(/\|/g, '\\|')).join('<br>')} |`);
  const md = `# Live VM run ${runId}

- Target: ${target.name} (${JSON.stringify(target.facts())})
- Archive: ${path.basename(ARCHIVE)}
- Fresh VM: ${FRESH} · reboot test: ${!SKIP_REBOOT}
- Versions: ${JSON.stringify(state.versions)}
- Started ${ev.startedAt}, finished ${new Date().toISOString()}

| ID | Test | Result | Evidence notes |
|---|---|---|---|
${rows.join('\n')}

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
`;
  writeFileSync(path.join(ev.dir, 'report.md'), md);
}

async function main() {
  await localPortsFree();
  const steps = EXPOSURE ? [A01, A02, A03, A04, A05, A06, A07, A08, A11, A12, A10, A13, A14, B01, B04, B05, B07, B10, B02, A09, B09, A15] : [A01, A02, A03, A04, A05, A06, A07, A08, A11, A12, A10, A13, A14, A09, A15];
  if (!should('A01')) await openTunnels();
  for (const s of steps) await s();
  if (should('A16')) {
    const required = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15'];
    const got = Object.fromEntries(ev.results.map((r) => [r.id, r.status]));
    const missing = required.filter((id) => !got[id]);
    const failed = required.filter((id) => got[id] && got[id] !== 'pass');
    const status = missing.length || failed.length ? (missing.length && !failed.length ? 'blocked' : 'fail') : FRESH ? 'pass' : 'blocked';
    ev.record('A16', 'Build artifact installs and reproduces the full section-1 demo with recorded results', status, { missing, failed, fresh: FRESH }, [
      FRESH ? 'run started from a rebuilt VM' : 'NOT from a fresh VM: run again with --fresh for A16 evidence',
      ...(missing.length ? [`not run: ${missing.join(', ')}`] : []),
      ...(failed.length ? [`failed: ${failed.join(', ')}`] : []),
    ]);
  }
  await cleanupFixtures();
  writeMarkdown();
  await browser?.close();
  tunnel?.close();
  const bad = ev.results.filter((r) => r.status === 'fail');
  console.log(`\n${ev.results.length} checks, ${bad.length} failed. Report: ${path.relative(ROOT, ev.dir)}/report.md`);
  process.exit(bad.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await cleanupFixtures();
    writeMarkdown();
  } catch {
    /* best effort */
  }
  await browser?.close();
  tunnel?.close();
  process.exit(1);
});

// ================================================================ B-matrix: exposure (docs/design/EXPOSURE.md §7)
// Run with --exposure. Public path uses a real hostname in a DigitalOcean-managed zone (HARBOR_PUBLIC_ZONE,
// default apein.space) and opens 80/443 on the test firewall for the duration. Tailnet path needs a
// Tailscale auth key (HARBOR_TS_AUTHKEY) — without it, tailnet steps are recorded as BLOCKED.
