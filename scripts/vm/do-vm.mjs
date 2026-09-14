#!/usr/bin/env node
// Harbor designated test VM controller (DigitalOcean).
//
// This is the ONLY code in the repository that reads `.env.vm.local`. It manages exactly
// one disposable droplet named `harbor-test` (tag `harbor-test`) and refuses to act on
// anything else in the account. The Harbor daemon, CLI, and unit tests never import it.
//
// Usage:
//   node scripts/vm/do-vm.mjs create            # create droplet + firewall (idempotent)
//   node scripts/vm/do-vm.mjs status
//   node scripts/vm/do-vm.mjs rebuild           # fresh Ubuntu 24.04 (the "vagrant destroy && up" equivalent)
//   node scripts/vm/do-vm.mjs reboot            # hard power cycle, wait for SSH
//   node scripts/vm/do-vm.mjs snapshot <name>   # create snapshot
//   node scripts/vm/do-vm.mjs wait-ssh
//   node scripts/vm/do-vm.mjs ssh -- <command>  # run a command on the VM
//   node scripts/vm/do-vm.mjs destroy --yes
//
// Files (all git-ignored): .env.vm.local (token), .vm.local.json (droplet id/ip),
// .vm-known_hosts (host keys; cleared on rebuild).

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ENV_FILE = path.join(ROOT, '.env.vm.local');
const STATE_FILE = path.join(ROOT, '.vm.local.json');
const KNOWN_HOSTS = path.join(ROOT, '.vm-known_hosts');
const KEY_FILE = process.env.HARBOR_VM_SSH_KEY ?? path.join(homedir(), '.ssh', 'harbor-test-vm_ed25519');

const VM_NAME = 'harbor-test';
const VM_TAG = 'harbor-test';
const IMAGE = 'ubuntu-24-04-x64';
const SIZE = process.env.HARBOR_VM_SIZE ?? 's-4vcpu-8gb';
const REGION = process.env.HARBOR_VM_REGION ?? 'sfo3';
const API = 'https://api.digitalocean.com/v2';

function loadToken() {
  if (process.env.DIGITALOCEAN_TOKEN) return process.env.DIGITALOCEAN_TOKEN;
  if (!existsSync(ENV_FILE)) fail(`Missing ${ENV_FILE}. Copy .env.example and set DIGITALOCEAN_TOKEN.`);
  const m = readFileSync(ENV_FILE, 'utf8').match(/^DIGITALOCEAN_TOKEN=(.+)$/m);
  if (!m) fail(`DIGITALOCEAN_TOKEN not set in ${ENV_FILE}`);
  return m[1].trim();
}

function fail(msg, code = 2) {
  console.error(`do-vm: ${msg}`);
  process.exit(code);
}

async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${loadToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) fail(`${method} ${p} -> ${res.status}: ${json?.message ?? text.slice(0, 300)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
}
function writeState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

async function findDroplet() {
  const { droplets } = await api('GET', `/droplets?tag_name=${VM_TAG}&per_page=10`);
  const mine = droplets.filter((d) => d.name === VM_NAME);
  if (mine.length > 1) fail(`More than one droplet named ${VM_NAME} with tag ${VM_TAG}; refusing to guess.`);
  return mine[0] ?? null;
}

function publicIp(d) {
  return d.networks?.v4?.find((n) => n.type === 'public')?.ip_address ?? null;
}

async function ensureSshKey() {
  const pub = readFileSync(`${KEY_FILE}.pub`, 'utf8').trim();
  const { ssh_keys } = await api('GET', '/account/keys?per_page=200');
  const existing = ssh_keys.find((k) => k.public_key.trim() === pub);
  if (existing) return existing.id;
  const { ssh_key } = await api('POST', '/account/keys', { name: 'harbor-test-vm', public_key: pub });
  return ssh_key.id;
}

async function ensureFirewall(dropletId) {
  const { firewalls } = await api('GET', '/firewalls?per_page=200');
  let fw = firewalls.find((f) => f.name === 'harbor-test-ssh-only');
  const spec = {
    name: 'harbor-test-ssh-only',
    inbound_rules: [{ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0', '::/0'] } }],
    outbound_rules: [
      { protocol: 'tcp', ports: '0', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
      { protocol: 'udp', ports: '0', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
      { protocol: 'icmp', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
    ],
    tags: [VM_TAG],
  };
  if (!fw) {
    ({ firewall: fw } = await api('POST', '/firewalls', spec));
  }
  if (!fw.droplet_ids?.includes(dropletId) && !fw.tags?.includes(VM_TAG)) {
    await api('POST', `/firewalls/${fw.id}/droplets`, { droplet_ids: [dropletId] });
  }
  return fw.id;
}

async function waitDroplet(id, want = 'active', timeoutMs = 5 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { droplet } = await api('GET', `/droplets/${id}`);
    if (droplet.status === want && (want !== 'active' || publicIp(droplet))) return droplet;
    await sleep(5000);
  }
  fail(`Droplet ${id} did not reach ${want} within ${timeoutMs / 1000}s`, 4);
}

async function waitAction(dropletId, actionId, timeoutMs = 10 * 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { action } = await api('GET', `/droplets/${dropletId}/actions/${actionId}`);
    if (action.status === 'completed') return action;
    if (action.status === 'errored') fail(`Action ${action.type} errored`, 4);
    await sleep(5000);
  }
  fail(`Action ${actionId} did not complete within ${timeoutMs / 1000}s`, 4);
}

function sshArgs(ip, extra = []) {
  return [
    '-i', KEY_FILE,
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15',
    ...extra,
    `root@${ip}`,
  ];
}

function sshRun(ip, command, opts = {}) {
  const r = spawnSync('ssh', [...sshArgs(ip, opts.sshExtra ?? []), command], {
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    timeout: opts.timeoutMs,
  });
  return r;
}

async function waitSsh(ip, timeoutMs = 5 * 60_000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    const r = sshRun(ip, 'echo harbor-ssh-ok && cat /etc/machine-id && uptime -s', { capture: true, timeoutMs: 20_000 });
    if (r.status === 0 && r.stdout.includes('harbor-ssh-ok')) {
      const [, machineId, bootedAt] = r.stdout.trim().split('\n');
      // A fresh droplet still runs cloud-init, which can reset SSH sessions; wait for it to finish.
      sshRun(ip, 'command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1; true', { capture: true, timeoutMs: 300_000 });
      return { attempt, machineId, bootedAt, elapsedMs: Date.now() - start };
    }
    await sleep(5000);
  }
  fail(`SSH to ${ip} not reachable within ${timeoutMs / 1000}s`, 4);
}

async function cmdCreate() {
  let droplet = await findDroplet();
  if (droplet) {
    console.log(`Droplet ${VM_NAME} already exists (id ${droplet.id}, ${droplet.status}).`);
  } else {
    const keyId = await ensureSshKey();
    ({ droplet } = await api('POST', '/droplets', {
      name: VM_NAME,
      region: REGION,
      size: SIZE,
      image: IMAGE,
      ssh_keys: [keyId],
      backups: false,
      ipv6: false,
      monitoring: false,
      tags: [VM_TAG],
    }));
    console.log(`Created droplet ${VM_NAME} id ${droplet.id} (${SIZE}, ${IMAGE}, ${REGION}). Waiting for active...`);
  }
  droplet = await waitDroplet(droplet.id);
  const ip = publicIp(droplet);
  await ensureFirewall(droplet.id);
  writeState({ dropletId: droplet.id, ip, image: IMAGE, size: SIZE, region: REGION, createdAt: droplet.created_at });
  console.log(`Droplet active at ${ip}. Waiting for SSH...`);
  const info = await waitSsh(ip);
  console.log(`SSH ok after ${info.attempt} attempt(s), machine-id ${info.machineId}, booted ${info.bootedAt}`);
  console.log(`\nConnect: ssh -i ${KEY_FILE} -o UserKnownHostsFile=${KNOWN_HOSTS} root@${ip}`);
}

async function cmdStatus() {
  const d = await findDroplet();
  if (!d) { console.log('No harbor-test droplet.'); return; }
  console.log(JSON.stringify({ id: d.id, status: d.status, ip: publicIp(d), image: d.image?.slug, size: d.size_slug, region: d.region?.slug, created: d.created_at }, null, 2));
}

async function cmdRebuild() {
  const d = await findDroplet();
  if (!d) fail('No harbor-test droplet to rebuild; run create.');
  console.log(`Rebuilding droplet ${d.id} to fresh ${IMAGE}...`);
  const { action } = await api('POST', `/droplets/${d.id}/actions`, { type: 'rebuild', image: IMAGE });
  await waitAction(d.id, action.id);
  const fresh = await waitDroplet(d.id);
  if (existsSync(KNOWN_HOSTS)) rmSync(KNOWN_HOSTS);
  const ip = publicIp(fresh);
  writeState({ ...(readState() ?? {}), dropletId: d.id, ip, rebuiltAt: new Date().toISOString() });
  const info = await waitSsh(ip);
  console.log(`Rebuilt. SSH ok after ${info.attempt} attempt(s), machine-id ${info.machineId}, booted ${info.bootedAt}`);
}

async function cmdReboot() {
  const d = await findDroplet();
  if (!d) fail('No harbor-test droplet.');
  const ip = publicIp(d);
  const before = sshRun(ip, 'uptime -s', { capture: true, timeoutMs: 20_000 }).stdout?.trim();
  console.log(`Power-cycling droplet ${d.id} (booted ${before})...`);
  const { action } = await api('POST', `/droplets/${d.id}/actions`, { type: 'power_cycle' });
  await waitAction(d.id, action.id);
  await sleep(5000);
  const info = await waitSsh(ip);
  if (info.bootedAt === before) fail('Boot time unchanged after power cycle; reboot did not happen.', 4);
  console.log(`Rebooted. SSH ok after ${info.attempt} attempt(s), now booted ${info.bootedAt}`);
}

async function cmdSnapshot(name) {
  const d = await findDroplet();
  if (!d) fail('No harbor-test droplet.');
  const { action } = await api('POST', `/droplets/${d.id}/actions`, { type: 'snapshot', name: name ?? `harbor-test-${Date.now()}` });
  await waitAction(d.id, action.id, 30 * 60_000);
  console.log('Snapshot complete.');
}

async function cmdDestroy(yes) {
  const d = await findDroplet();
  if (!d) { console.log('Nothing to destroy.'); return; }
  if (!yes) fail('Refusing to destroy without --yes');
  await api('DELETE', `/droplets/${d.id}`);
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE);
  if (existsSync(KNOWN_HOSTS)) rmSync(KNOWN_HOSTS);
  console.log(`Destroyed droplet ${d.id}.`);
}

async function cmdWaitSsh() {
  const s = readState();
  if (!s?.ip) fail('No .vm.local.json; run create.');
  const info = await waitSsh(s.ip);
  console.log(JSON.stringify(info));
}

async function cmdSsh(args) {
  const s = readState();
  if (!s?.ip) fail('No .vm.local.json; run create.');
  const r = sshRun(s.ip, args.join(' '));
  process.exit(r.status ?? 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const dashdash = rest.indexOf('--');
const args = dashdash >= 0 ? rest.slice(dashdash + 1) : rest;
switch (cmd) {
  case 'create': await cmdCreate(); break;
  case 'status': await cmdStatus(); break;
  case 'rebuild': await cmdRebuild(); break;
  case 'reboot': await cmdReboot(); break;
  case 'snapshot': await cmdSnapshot(args[0]); break;
  case 'destroy': await cmdDestroy(rest.includes('--yes')); break;
  case 'wait-ssh': await cmdWaitSsh(); break;
  case 'ssh': await cmdSsh(args); break;
  default:
    console.error('usage: do-vm.mjs <create|status|rebuild|reboot|snapshot [name]|wait-ssh|ssh -- cmd|destroy --yes>');
    process.exit(2);
}
