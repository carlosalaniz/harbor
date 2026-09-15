#!/usr/bin/env node
// Live catalog qualification on the designated disposable VM:
//   node scripts/vm/qualify-catalog.mjs [--fresh] [--only immich,jellyfin] [--archive <tar.gz>] [--no-record]
// For every bundled package (or --only): install with the CLI, wait for readiness, open the UI in a real
// browser (screenshot + title + health probe), then remove. Packages with external storage claims are
// additionally installed once with a host folder ("bring your own folder"). Results are written to
// docs/evidence/catalog-<timestamp>/ and, unless --no-record, into each package's release.json qualification.
// --fresh rebuilds the VM and bootstraps Harbor from the release archive first (recommended: clean host).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Evidence, ROOT, cli, cliOk, fail, resolveTarget, sleep, waitFor } from './lib.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const FRESH = has('--fresh');
const RECORD = !has('--no-record');
const ONLY = opt('--only', null)?.split(',').map((s) => s.trim());
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCHIVE = path.resolve(opt('--archive', path.join(ROOT, 'release', `harbor-${pkg.version}-linux-x64.tar.gz`)));
const ARCHIVE_DIR = path.basename(ARCHIVE).replace(/\.tar\.gz$/, '');
const ADMIN = { username: 'admin', password: 'harbor-test-Admin-Passw0rd' };
// retained instances keep their ports, so a full catalog pass needs more than the acceptance suite's 20
const PORTS = [18000, ...Array.from({ length: 60 }, (_, i) => 18080 + i)];
const UI = 'http://localhost:18000';
const EXT_ROOT = '/srv/harbor-test-storage';

if (!existsSync(ARCHIVE)) fail(`release archive not found: ${ARCHIVE} (run pnpm package)`, 2);
const target = resolveTarget();
const runId = `catalog-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const ev = new Evidence(path.join(ROOT, 'docs', 'evidence', runId));
const ssh = (cmd, o) => target.sshOk(cmd, o);
const sshTry = (cmd, o) => target.ssh(cmd, o);
console.log(`target: ${target.name}\nevidence: ${path.relative(ROOT, ev.dir)}\nfresh: ${FRESH}`);

const index = JSON.parse(readFileSync(path.join(ROOT, 'catalog', 'index.json'), 'utf8'));
const ids = Object.keys(index.packages).filter((id) => !ONLY || ONLY.includes(id));
const manifests = Object.fromEntries(ids.map((id) => [id, readFileSync(path.join(ROOT, 'catalog', id, 'manifest.yaml'), 'utf8')]));
const healthPathOf = (m) => /^\s*path:\s*(\S+)\s*$/m.exec(m.split('health:')[1] ?? '')?.[1] ?? '/';
const expectedOf = (m) => (/expectedStatus:\s*\[([^\]]+)\]/.exec(m)?.[1] ?? '200').split(',').map((s) => Number(s.trim()));
const externalClaims = (m) => [...m.matchAll(/^\s+- id: ([a-z0-9-]+)\n(?:.*\n){0,3}?\s+external:/gm)].map((x) => x[1]);

let browser;
let tunnel;
async function openTunnels() {
  tunnel?.close();
  tunnel = target.tunnel(PORTS);
  await waitFor(async () => (await fetch(`${UI}/healthz`)).ok, { timeoutMs: 60_000, intervalMs: 1000, what: 'tunnel to daemon' });
}
async function newPage() {
  browser ??= await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return { ctx, page: await ctx.newPage() };
}

async function prepareHost() {
  if (FRESH) {
    console.log('rebuilding VM to a fresh Ubuntu 24.04 image...');
    await target.rebuildFresh();
    sshTry('command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1; true', { timeoutMs: 300_000 });
  }
  target.scp(ARCHIVE, `/root/${path.basename(ARCHIVE)}`);
  target.scp(path.join(path.dirname(ARCHIVE), 'SHA256SUMS'), '/root/SHA256SUMS');
  ssh(`cd /root && sha256sum -c SHA256SUMS && rm -rf ${ARCHIVE_DIR} && tar -xzf ${path.basename(ARCHIVE)}`);
  const fresh = sshTry('test -f /etc/harbor/harbor.json').code !== 0;
  const flags = fresh ? `--install-docker --admin-username ${ADMIN.username} --password-stdin` : '';
  const b = target.ssh(`cd /root && ./${ARCHIVE_DIR}/bin/harbor bootstrap --yes ${flags} 2>&1`, { input: fresh ? ADMIN.password + '\n' : undefined, timeoutMs: 1800_000 });
  ev.file('bootstrap.log', b.stdout + b.stderr);
  if (b.code !== 0) throw new Error(`bootstrap failed (exit ${b.code}); see bootstrap.log`);
  await openTunnels();
  const login = cli(target, ['login', '--username', ADMIN.username, '--password-stdin'], { input: ADMIN.password + '\n' });
  if (login.code !== 0) throw new Error(`CLI login failed: ${login.stderr} ${login.stdout}`);
  const doctor = cliOk(target, ['doctor']);
  const versions = {
    node: ssh('/opt/harbor/node/bin/node --version').trim(),
    docker: ssh("docker version --format '{{.Server.Version}}'").trim(),
    compose: ssh("docker compose version --short").trim(),
    ubuntu: ssh('lsb_release -ds').trim(),
    arch: ssh('uname -m').trim(),
  };
  ev.record('HOST', 'Host prepared: Harbor bootstrapped from the release archive', 'pass', { versions, installationId: doctor.system.installationId, fresh, rebuilt: FRESH }, [`Docker ${versions.docker}, Compose ${versions.compose}, Node ${versions.node}, ${versions.ubuntu} ${versions.arch}`]);
  return versions;
}

async function waitHealthy(name, timeoutMs) {
  return waitFor(() => {
    const i = cliOk(target, ['list']).find((x) => x.name === name);
    if (!i) return null;
    if (i.installState === 'installed' && i.readiness === 'healthy') return i;
    return null;
  }, { timeoutMs, intervalMs: 5000, what: `${name} healthy` });
}

async function qualifyOne(id, variant, storageArgs) {
  const m = manifests[id];
  const name = variant ? `${id}-ext` : id;
  const t0 = Date.now();
  const op = cliOk(target, ['install', id, '--name', name, ...storageArgs, '--yes'], { timeoutMs: 2400_000 });
  if (op.state !== 'succeeded') throw new Error(`install ${op.state}: ${JSON.stringify(op.error)} | ${op.events.slice(-3).map((e) => e.message).join(' | ')}`);
  const inst = await waitHealthy(name, 600_000);
  const url = inst.endpoints[0].browserUrl;
  const probe = await fetch(new URL(healthPathOf(m), url), { redirect: 'manual' });
  const expected = expectedOf(m);
  const { ctx, page } = await newPage();
  let title;
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
  try {
    // 'load', not 'networkidle': most of these apps hold a websocket open, so the network is never idle
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await sleep(4000);
    title = await page.title();
    await page.screenshot({ path: path.join(ev.dir, `${name}.png`) });
  } finally {
    await ctx.close();
  }
  const detail = cliOk(target, ['inspect', inst.id]);
  const containers = ssh(`docker ps --filter label=io.harbor.preview/instance=${inst.id} --format '{{.Names}} {{.Status}}'`).trim().split('\n');
  const mounts = ssh(`docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(docker ps -q --filter label=io.harbor.preview/instance=${inst.id})`).trim().split('\n');
  const rm = cliOk(target, ['remove', inst.id, '--yes'], { timeoutMs: 600_000 });
  if (rm.state !== 'succeeded') throw new Error(`remove ${rm.state}: ${JSON.stringify(rm.error)}`);
  if (!expected.includes(probe.status)) throw new Error(`health probe ${probe.status} not in ${expected} at ${url}`);
  return {
    details: { name, instanceId: inst.id, url, title, healthStatus: probe.status, containers, mounts, resources: detail.resources, secondsToHealthy: Math.round((Date.now() - t0) / 1000), consoleErrors: consoleErrors.slice(0, 10) },
    notes: [`healthy after ${Math.round((Date.now() - t0) / 1000)}s; page title "${title}"; health ${probe.status}`, ...(variant ? [`external storage: ${storageArgs.join(' ')} mounted as bind`] : []), 'removed after the check; volumes and folders retained'],
  };
}

async function main() {
  const versions = await prepareHost();
  ssh(`mkdir -p ${EXT_ROOT} && chmod 777 ${EXT_ROOT}`);
  const results = {};
  for (const id of ids) {
    const m = manifests[id];
    const ext = externalClaims(m);
    for (const variant of [false, ...(ext.length ? [true] : [])]) {
      const step = `${id}${variant ? ' (external storage)' : ''}`;
      let storageArgs = [];
      if (variant) {
        for (const c of ext) {
          const dir = `${EXT_ROOT}/${id}-${c}`;
          ssh(`mkdir -p ${dir} && chmod 777 ${dir} && touch ${dir}/.harbor-test-marker`);
          storageArgs.push('--storage', `${c}=${dir}`);
        }
      }
      try {
        const r = await qualifyOne(id, variant, storageArgs);
        r.details.title ??= '';
        ev.record(step, `Install, readiness, browser check and remove of ${step}`, 'pass', r.details, r.notes);
        if (variant) {
          const mountsOk = r.details.mounts.some((l) => l.includes(`bind:${EXT_ROOT}/${id}-`));
          if (!mountsOk) throw new Error(`no bind mount of ${EXT_ROOT} observed: ${r.details.mounts.join(' ')}`);
          const marker = sshTry(`ls ${EXT_ROOT}/${id}-${ext[0]}/.harbor-test-marker`).code === 0;
          if (!marker) throw new Error('external folder marker disappeared');
        }
        results[id] = results[id] ?? 'passed';
        console.log(`[PASS] ${step}: ${r.notes[0]}`);
      } catch (e) {
        ev.record(step, `Install, readiness, browser check and remove of ${step}`, 'fail', { error: e.message }, [String(e.message)]);
        results[id] = 'blocked';
        console.log(`[FAIL] ${step}: ${e.message}`);
        // leave nothing running for the next package
        const left = cliOk(target, ['list']).filter((i) => i.name.startsWith(id) && i.installState !== 'retained');
        for (const i of left) cli(target, ['remove', i.id, '--yes'], { timeoutMs: 600_000 });
      }
    }
  }
  ev.file('report.json', JSON.stringify({ runId, target: target.name, versions, results, results_detail: ev.results }, null, 2));
  const md = [`# Catalog qualification ${runId}`, '', `Host: ${versions.ubuntu} ${versions.arch}, Docker ${versions.docker}, Compose ${versions.compose}, Node ${versions.node}${FRESH ? ' (fresh VM)' : ''}`, '', '| Package | Result | Notes |', '|---|---|---|', ...ev.results.filter((r) => r.id !== 'HOST').map((r) => `| ${r.id} | ${r.status} | ${r.notes.join('; ').replace(/\|/g, '/')} |`), ''].join('\n');
  writeFileSync(path.join(ev.dir, 'report.md'), md);
  if (RECORD) {
    for (const [id, status] of Object.entries(results)) {
      const file = path.join(ROOT, 'catalog', id, 'release.json');
      const rel = JSON.parse(readFileSync(file, 'utf8'));
      const appVersions = Object.fromEntries(Object.entries(rel.images).map(([svc, img]) => [svc, img.appVersion ?? img.tag]));
      const r = ev.results.find((x) => x.id === id);
      rel.qualification = {
        status,
        date: new Date().toISOString().slice(0, 10),
        node: versions.node,
        dockerEngine: versions.docker,
        dockerCompose: versions.compose,
        hostOs: `${versions.ubuntu} ${versions.arch}`,
        appVersions,
        notes: [...(rel.qualification.notes ?? []).filter((n) => !n.startsWith('Live catalog run ')), `Live catalog run ${runId}: ${status}${r ? ` (${r.notes[0]})` : ''}`],
      };
      writeFileSync(file, JSON.stringify(rel, null, 2) + '\n');
      execFileSync('pnpm', ['tsx', 'scripts/catalog-hash.ts', id], { stdio: 'ignore' });
    }
  }
  await browser?.close();
  tunnel?.close();
  const failed = Object.values(results).filter((s) => s !== 'passed').length;
  console.log(`\n${Object.keys(results).length} packages, ${failed} blocked. Report: ${path.relative(ROOT, ev.dir)}/report.md`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await browser?.close();
  tunnel?.close();
  process.exit(1);
});
