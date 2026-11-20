// Root half of Access Guard (decision 207, docs/design/ACCESS_GUARD.md), run by harbor-guard@<action>.service via
// `harbor guard-step <action>`.
//
// The daemon writes <stateDir>/guard/request.json. This step re-validates it (validateGuardState), renders the ruleset
// with the pure builder, loads it with `nft -f` (argv only, never a shell) and writes its verdict plus the kernel's
// per-source counters to status.json. Root keeps its own copy under /etc/harbor/guard (0700): state.json and rules.nft
// (the ruleset that loaded last; harbor-guard.service loads it before Caddy at boot).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { readFileNoFollow, writeStatusFile } from './safe-write.js';
import { GUARD_FAMILY, GUARD_TABLE, guardDeleteScript, guardRuleset, parseSeenJson, validateGuardState, type GuardState, type SeenSource } from '../guard/rules.js';
import { GUARD_NFT_BIN, guardFiles, MAX_REPORTED, parseGuardAction, type GuardAction, type GuardReport, type GuardRequest, type GuardStatusFile } from '../guard/provider.js';

type Log = (m: string) => void;

export const GUARD_ROOT_DIR = `${PRODUCT.paths.etc}/guard`;
export const GUARD_ROOT_FILES = {
  state: path.join(GUARD_ROOT_DIR, 'state.json'),
  rules: path.join(GUARD_ROOT_DIR, 'rules.nft'),
} as const;

function requireRoot(what: string): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', `${what} must run as root`);
}

// Root-only folder: nothing the harbor user can write, so plain writes (temp file + rename) are safe here.
function writeRootFile(file: string, data: string, mode: number): void {
  mkdirSync(GUARD_ROOT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(GUARD_ROOT_DIR, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

// nft 1.0.9 refuses `nft -f -` from a pipe (decision 184): the script goes into a root-only file first, and only a
// ruleset that just loaded becomes the boot copy.
async function nftLoad(text: string, keepAs?: string): Promise<void> {
  const candidate = path.join(GUARD_ROOT_DIR, `load-${process.pid}.nft`);
  writeRootFile(candidate, text, 0o600);
  try {
    await execOk(GUARD_NFT_BIN, ['-f', candidate], { timeoutMs: 30_000 });
    if (keepAs) renameSync(candidate, keepAs);
  } finally {
    rmSync(candidate, { force: true });
  }
}

async function tableLoaded(): Promise<boolean> {
  return (await exec(GUARD_NFT_BIN, ['list', 'table', GUARD_FAMILY, GUARD_TABLE], { timeoutMs: 30_000 })).code === 0;
}

function readState(): GuardState | null {
  if (!existsSync(GUARD_ROOT_FILES.state)) return null;
  try {
    return validateGuardState(JSON.parse(readFileSync(GUARD_ROOT_FILES.state, 'utf8')));
  } catch {
    return null;
  }
}

async function seen(): Promise<SeenSource[]> {
  const out: SeenSource[] = [];
  for (const set of ['seen4', 'seen6']) {
    const r = await exec(GUARD_NFT_BIN, ['-j', 'list', 'set', GUARD_FAMILY, GUARD_TABLE, set], { timeoutMs: 30_000 });
    if (r.code === 0) out.push(...parseSeenJson(r.stdout));
  }
  return out.sort((a, b) => b.packets - a.packets).slice(0, MAX_REPORTED);
}

async function report(): Promise<GuardReport> {
  const loaded = existsSync(GUARD_NFT_BIN) && (await tableLoaded());
  return { loaded, allowed: readState()?.allow.length ?? 0, seen: loaded ? await seen() : [] };
}

function readRequest(file: string, expected: GuardAction): GuardRequest {
  let raw: string | null;
  try {
    raw = readFileNoFollow(file, 512 * 1024);
  } catch (e) {
    throw new HarborError('INVALID_REQUEST', `request at ${file} is not readable: ${(e as Error).message}`);
  }
  if (raw === null) throw new HarborError('INVALID_REQUEST', `no request at ${file}`);
  let doc: Partial<GuardRequest>;
  try {
    doc = JSON.parse(raw) as Partial<GuardRequest>;
  } catch {
    throw new HarborError('INVALID_REQUEST', `request at ${file} is not JSON`);
  }
  if (!doc || doc.action !== expected) throw new HarborError('INVALID_REQUEST', `request at ${file} does not match ${expected}`);
  return doc as GuardRequest;
}

function writeStatus(stateDir: string, file: string, status: GuardStatusFile): void {
  try {
    // 0644 in the daemon-owned guard/ dir: root writes, harbor reads and unlinks. Decision 169: never through a link.
    writeStatusFile(stateDir, file, JSON.stringify(status), { mode: 0o644 });
  } catch {
    /* the unit's exit code still carries the verdict */
  }
}

async function turnOff(log: Log): Promise<void> {
  if (existsSync(GUARD_NFT_BIN) && (await tableLoaded())) await nftLoad(guardDeleteScript());
  rmSync(GUARD_ROOT_FILES.rules, { force: true });
  rmSync(GUARD_ROOT_FILES.state, { force: true });
  log('access guard off: Harbor\'s table and its boot copy removed');
}

export async function applyGuardStep(actionArg: string, log: Log): Promise<void> {
  const action = parseGuardAction(actionArg);
  requireRoot('guard-step');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const files = guardFiles(config.stateDir);
  const now = () => new Date().toISOString();
  try {
    const request = readRequest(files.request, action);
    rmSync(files.request, { force: true });
    switch (action) {
      case 'apply': {
        if (!existsSync(GUARD_NFT_BIN)) throw new HarborError('UNSUPPORTED_CAPABILITY', 'nftables is not installed on this machine', { nextAction: 'On the machine, run: sudo apt-get install -y nftables — then try again (Harbor bootstrap installs it normally).' });
        const state = validateGuardState(request.state);
        await nftLoad(guardRuleset(state), GUARD_ROOT_FILES.rules);
        writeRootFile(GUARD_ROOT_FILES.state, JSON.stringify(state) + '\n', 0o600);
        log(`access guard on: ${state.allow.length} allowed entr${state.allow.length === 1 ? 'y' : 'ies'}, ${state.own.length} own address(es) exempt`);
        break;
      }
      case 'off':
        await turnOff(log);
        break;
      case 'status':
        break;
    }
    writeStatus(config.stateDir, files.status, { action, state: 'ok', message: `${action} done`, report: await report(), at: now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(config.stateDir, files.status, { action, state: 'failed', message: msg, ...(e instanceof HarborError && e.nextAction ? { nextAction: e.nextAction } : {}), at: now() });
    throw e;
  }
}

// Uninstall: Harbor's table and its root files.
export async function removeGuard(log: Log): Promise<void> {
  await turnOff(log).catch(() => undefined);
  rmSync(GUARD_ROOT_DIR, { recursive: true, force: true });
}
