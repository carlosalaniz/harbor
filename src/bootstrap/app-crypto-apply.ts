// Root half of per-app kernel sealing, run by
// harbor-app-crypto@<instanceId>:<action>.service via `harbor app-crypto <spec>`.
//
// The daemon (harbor user) writes <stateDir>/instances/<id>/crypto/request.json
// (action, home, protector — never the key), streams the app's master key
// through key.fifo (a FIFO: the key never touches disk), and blocks on
// `systemctl start`. This step re-validates everything itself — the unit
// name binds it to ONE recorded instance, the home path must sit in an
// allowed harbor-apps tree with no symlinks, and the home's manifest must
// carry the same instance id — then runs fscrypt with argv only (never
// shell) and writes its verdict to status.json for the daemon to read.
//
// Filesystem readiness is handled here too (idempotent): `encrypt` feature
// via tune2fs (safe on a mounted ext4, effective immediately), /etc/fscrypt.conf
// + per-mount metadata via `fscrypt setup`. Bootstrap calls the same helper
// for the Harbor data folder so the first local install seals without a
// detour.
import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HarborError } from '../errors.js';
import { PRODUCT } from '../naming.js';
import { loadConfig } from '../config.js';
import { exec, execOk } from './exec.js';
import { describeAppHome } from '../storage/app-home.js';
import {
  appCryptoFiles,
  findmntArgs,
  fscryptEncryptArgs,
  fscryptGlobalSetupArgs,
  fscryptLockArgs,
  fscryptSetupArgs,
  fscryptStatusArgs,
  fscryptUnlockArgs,
  FSCRYPT_BIN,
  FSCRYPT_POLICY_VERSION,
  hasEncryptFeature,
  isAllowedHomePath,
  isValidProtectorName,
  parseAppCryptoSpec,
  parseFindmnt,
  parseFscryptDirStatus,
  parseFscryptFsStatus,
  SEALABLE_FS,
  sealedDir,
  tune2fsEnableEncryptArgs,
  tune2fsListArgs,
  type AppCryptoAction,
  type AppCryptoRequest,
  type AppCryptoStatus,
  type FscryptDirStatus,
} from '../storage/fscrypt.js';

type Log = (m: string) => void;

function requireRoot(what: string): void {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) throw new HarborError('INVALID_REQUEST', `${what} must run as root`);
}

// ---------------------------------------------------------------- filesystem readiness

export interface SealableFs {
  mountpoint: string;
  source: string;
  fsType: string;
}

// Make the filesystem holding <target> ready for per-app sealing. Idempotent.
// Throws a plain-words HarborError (with next action) when it cannot.
export async function prepareFilesystemForSealing(target: string, log: Log): Promise<SealableFs> {
  if (!existsSync(FSCRYPT_BIN)) {
    throw new HarborError('UNSUPPORTED_CAPABILITY', 'fscrypt is not installed on this machine', {
      nextAction: 'On the machine, run: sudo apt-get install -y fscrypt — then try again (Harbor bootstrap installs it normally).',
    });
  }
  const fm = findmntArgs(target);
  const mnt = parseFindmnt((await exec(fm.file, fm.args, { timeoutMs: 15_000 })).stdout);
  if (!mnt) throw new HarborError('OPERATION_FAILED', `cannot resolve the filesystem holding ${target}`, { nextAction: 'Mount the drive (or check the Harbor data folder exists), then try again.' });
  if (!SEALABLE_FS.has(mnt.fsType)) {
    throw new HarborError('INVALID_REQUEST', `${mnt.mountpoint} is ${mnt.fsType}: only ext4 (or f2fs) can seal apps natively`, {
      nextAction: 'Format the drive as ext4 in Settings → Storage (Harbor enables encryption at format time), or install the app locally.',
    });
  }
  if (mnt.fsType === 'ext4') {
    const list = tune2fsListArgs(mnt.source);
    let features = (await exec(list.file, list.args, { timeoutMs: 15_000 })).stdout;
    if (!hasEncryptFeature(features)) {
      log(`enabling the ext4 encrypt feature on ${mnt.source} (${mnt.mountpoint})`);
      const en = tune2fsEnableEncryptArgs(mnt.source);
      await execOk(en.file, en.args, { timeoutMs: 60_000 });
      features = (await exec(list.file, list.args, { timeoutMs: 15_000 })).stdout;
      if (!hasEncryptFeature(features)) {
        throw new HarborError('OPERATION_FAILED', `could not enable the encrypt feature on ${mnt.source}`, {
          nextAction: `On the machine, run: sudo tune2fs -O encrypt ${mnt.source} — then reboot and try again.`,
        });
      }
    }
  }
  if (!existsSync('/etc/fscrypt.conf')) {
    log('writing /etc/fscrypt.conf (fscrypt setup)');
    const g = fscryptGlobalSetupArgs();
    await execOk(g.file, g.args, { timeoutMs: 60_000 });
  }
  const st = fscryptStatusArgs(mnt.mountpoint);
  let fsStatus = parseFscryptFsStatus((await exec(st.file, st.args, { timeoutMs: 15_000 })).stdout);
  if (!fsStatus.hasMetadata) {
    log(`fscrypt setup ${mnt.mountpoint}`);
    const s = fscryptSetupArgs(mnt.mountpoint);
    const r = await exec(s.file, s.args, { timeoutMs: 60_000 });
    if (r.code !== 0 && !/already setup/i.test(r.stderr + r.stdout)) {
      throw new HarborError('OPERATION_FAILED', `fscrypt setup ${mnt.mountpoint} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`, {
        nextAction: `On the machine, run: sudo fscrypt setup ${mnt.mountpoint} --all-users — then try again.`,
      });
    }
    fsStatus = parseFscryptFsStatus((await exec(st.file, st.args, { timeoutMs: 15_000 })).stdout);
    if (!fsStatus.hasMetadata) {
      throw new HarborError('OPERATION_FAILED', `${mnt.mountpoint} still has no fscrypt metadata after setup`, {
        nextAction: `On the machine, run: sudo fscrypt status ${mnt.mountpoint} — and report the output.`,
      });
    }
  }
  return mnt;
}

// Bootstrap hook: prepare the filesystem under the Harbor data folder so the
// first "Local" install seals right away. Never fails bootstrap: a host that
// cannot seal refuses at install time with the same plain-words error.
export async function prepareDataFolderForSealing(log: Log): Promise<boolean> {
  try {
    const mnt = await prepareFilesystemForSealing(PRODUCT.paths.data, log);
    log(`per-app encryption ready on ${mnt.mountpoint} (${mnt.fsType}, ${mnt.source})`);
    return true;
  } catch (e) {
    log(`per-app encryption is not ready for ${PRODUCT.paths.data}: ${e instanceof Error ? e.message : String(e)}${e instanceof HarborError && e.nextAction ? ` — ${e.nextAction}` : ''}`);
    return false;
  }
}

// ---------------------------------------------------------------- key handling

// The daemon streams the master key (hex) through a FIFO it created. Read
// it with a bounded wait (`timeout cat`): if the daemon never opens the
// write side, this step fails instead of hanging the unit forever.
async function readKeyFromFifo(fifo: string): Promise<string> {
  let st;
  try {
    st = lstatSync(fifo);
  } catch {
    throw new HarborError('INVALID_REQUEST', 'no key was offered for this step (missing key.fifo)');
  }
  if (!st.isFIFO()) throw new HarborError('INVALID_REQUEST', 'key.fifo is not a FIFO');
  const r = await exec('/usr/bin/timeout', ['120', '/usr/bin/cat', fifo], { timeoutMs: 130_000 });
  if (r.code !== 0) throw new HarborError('OPERATION_FAILED', 'the daemon did not hand over the app key in time');
  const hex = r.stdout.trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new HarborError('INVALID_REQUEST', 'app key must be 32 bytes as hex');
  return hex.toLowerCase();
}

// Root-only temp file for --key=FILE, zeroed + unlinked by the caller.
function writeKeyFile(masterKeyHex: string): string {
  const p = `/root/.harbor-fscrypt-${randomBytes(8).toString('hex')}.key`;
  writeFileSync(p, Buffer.from(masterKeyHex, 'hex'), { mode: 0o600 });
  return p;
}

function shredKeyFile(p: string): void {
  try {
    writeFileSync(p, Buffer.alloc(32, 0));
  } catch {
    /* best effort */
  }
  rmSync(p, { force: true });
}

async function withKeyFile<T>(masterKeyHex: string, fn: (keyFile: string) => Promise<T>): Promise<T> {
  const keyFile = writeKeyFile(masterKeyHex);
  try {
    return await fn(keyFile);
  } finally {
    shredKeyFile(keyFile);
  }
}

// ---------------------------------------------------------------- fscrypt steps

async function dirStatus(dir: string): Promise<FscryptDirStatus> {
  const s = fscryptStatusArgs(dir);
  const r = await exec(s.file, s.args, { timeoutMs: 30_000 });
  if (r.code !== 0) {
    if (/is not\s+encrypted/i.test((r.stderr + r.stdout).replace(/\s+/g, ' '))) return { encrypted: false, unlocked: true, partiallyLocked: false, policyVersion: null, policyId: null, protectorIds: [] };
    throw new HarborError('OPERATION_FAILED', `fscrypt status ${dir} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  return parseFscryptDirStatus(r.stdout, r.stderr);
}

async function encryptEmptyDir(dir: string, protectorName: string, masterKeyHex: string, log: Log): Promise<void> {
  if (readdirSync(dir).length) throw new HarborError('INVALID_STATE', `${dir} is not empty; fscrypt can only seal an empty directory`, { nextAction: 'Start the app once: Harbor migrates existing data into a sealed folder.' });
  await withKeyFile(masterKeyHex, async (keyFile) => {
    const e = fscryptEncryptArgs({ dir, protectorName }, keyFile);
    await execOk(e.file, e.args, { timeoutMs: 120_000 });
  });
  const st = await dirStatus(dir);
  if (!st.encrypted || !st.unlocked) throw new HarborError('OPERATION_FAILED', `${dir} did not come back encrypted and unlocked after fscrypt encrypt`);
  if (st.policyVersion !== FSCRYPT_POLICY_VERSION) {
    throw new HarborError('OPERATION_FAILED', `${dir} got fscrypt policy version ${st.policyVersion ?? '?'}, Harbor requires ${FSCRYPT_POLICY_VERSION}`, {
      nextAction: 'Set "policy_version": "2" in /etc/fscrypt.conf, remove the sealed folder, and reinstall the app.',
    });
  }
  log(`sealed ${dir} (policy ${st.policyId ?? '?'}, v${st.policyVersion})`);
}

async function unlockDir(dir: string, masterKeyHex: string, log: Log): Promise<void> {
  let st = await dirStatus(dir);
  if (!st.encrypted) throw new HarborError('INVALID_STATE', `${dir} is not sealed yet`, { nextAction: 'Start the app once: Harbor seals existing data on the way.' });
  if (st.unlocked && !st.partiallyLocked) {
    log(`${dir} already unlocked`);
    return;
  }
  if (st.partiallyLocked) {
    // Evict the leftover key first; fscrypt unlock refuses a half-locked dir.
    const l = fscryptLockArgs(dir);
    await exec(l.file, l.args, { timeoutMs: 60_000 });
  }
  await withKeyFile(masterKeyHex, async (keyFile) => {
    const u = fscryptUnlockArgs(dir, keyFile);
    const r = await exec(u.file, u.args, { timeoutMs: 120_000 });
    if (r.code !== 0) {
      const msg = (r.stderr + r.stdout).replace(/\s+/g, ' ').trim();
      if (/incorrect key/i.test(msg)) throw new HarborError('INVALID_REQUEST', 'the app key does not open this sealed folder', { nextAction: 'The folder was sealed with a different key. Unlock with the passphrase or recovery key of the app that created it.' });
      if (/already unlocked/i.test(msg)) return;
      throw new HarborError('OPERATION_FAILED', `fscrypt unlock ${dir} failed: ${msg.slice(-300)}`);
    }
  });
  st = await dirStatus(dir);
  if (!st.unlocked) throw new HarborError('OPERATION_FAILED', `${dir} is still locked after fscrypt unlock`);
  log(`unlocked ${dir}`);
}

async function lockDir(dir: string, log: Log): Promise<void> {
  let st = await dirStatus(dir);
  if (!st.encrypted) throw new HarborError('INVALID_STATE', `${dir} is not sealed`, { nextAction: 'Start the app once to seal it; then Lock works.' });
  if (!st.unlocked && !st.partiallyLocked) {
    log(`${dir} already locked`);
    return;
  }
  const l = fscryptLockArgs(dir);
  const r = await exec(l.file, l.args, { timeoutMs: 60_000 });
  if (r.code !== 0) {
    const msg = (r.stderr + r.stdout).replace(/\s+/g, ' ').trim();
    if (/incompletely locked|still open|still busy/i.test(msg)) {
      throw new HarborError('INVALID_STATE', `some files under ${dir} are still open, so the key cannot be evicted`, {
        nextAction: 'Stop the app (and anything else reading its folder), then lock again.',
      });
    }
    throw new HarborError('OPERATION_FAILED', `fscrypt lock ${dir} failed: ${msg.slice(-300)}`);
  }
  st = await dirStatus(dir);
  if (st.unlocked || st.partiallyLocked) throw new HarborError('INVALID_STATE', `${dir} is still readable after lock (files open?)`, { nextAction: 'Stop the app, then lock again.' });
  log(`locked ${dir}`);
}

// Count entries and sum regular-file bytes: a cheap, metadata-only proof
// that `cp -a -T` moved everything before the plaintext copy is deleted.
function treeSummary(root: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      entries += 1;
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) bytes += st.size;
    }
  };
  walk(root);
  return { entries, bytes };
}

// Seal a home whose volumes dir already holds plaintext data (installed
// before sealing worked, or on a host that could not seal at the time):
// move the plaintext aside, seal a fresh empty dir under the same path,
// copy everything back (root: preserves the uids containers wrote with),
// verify, delete the plaintext copy. Docker's bind devices point at
// <home>/volumes/<claim>, which is unchanged. Any failure rolls the
// original dir back into place — the app keeps working unsealed and the
// error says why.
async function migrateDir(home: string, dir: string, protectorName: string, masterKeyHex: string, log: Log): Promise<void> {
  const st = await dirStatus(dir);
  if (st.encrypted) {
    log(`${dir} is already sealed; unlocking`);
    await unlockDir(dir, masterKeyHex, log);
    return;
  }
  if (!readdirSync(dir).length) {
    await encryptEmptyDir(dir, protectorName, masterKeyHex, log);
    return;
  }
  const before = treeSummary(dir);
  const fs = statfsSync(home);
  const free = Number(fs.bavail) * Number(fs.bsize);
  const need = before.bytes + 64 * 1024 * 1024;
  if (free < need) {
    throw new HarborError('INVALID_STATE', `not enough free space to seal ${dir} in place (needs ${Math.ceil(need / 1024 / 1024)} MiB free for the copy, ${Math.floor(free / 1024 / 1024)} MiB available)`, {
      nextAction: 'Free up space on the drive (or move the app to a larger one), then Start again.',
    });
  }
  const plain = `${dir}.plain-${Date.now()}`;
  const dst = statSync(dir);
  log(`sealing ${dir} in place: ${before.entries} entries, ${before.bytes} bytes (plaintext copy at ${plain} until verified)`);
  renameSync(dir, plain);
  const rollback = (why: string) => {
    log(`rolling back: ${why}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(plain, dir);
  };
  try {
    mkdirSync(dir, { mode: dst.mode & 0o7777 });
    // Restore Harbor's own ownership on the dir it created (root made the new
    // one); this never touches operator folders or file contents.
    chownSync(dir, dst.uid, dst.gid);
    await encryptEmptyDir(dir, protectorName, masterKeyHex, log);
  } catch (e) {
    rollback(`could not seal a fresh folder (${e instanceof Error ? e.message : String(e)})`);
    throw e;
  }
  try {
    await execOk('/usr/bin/cp', ['-a', '-T', plain, dir], { timeoutMs: 24 * 60 * 60_000 });
    const after = treeSummary(dir);
    if (after.entries !== before.entries || after.bytes !== before.bytes) {
      throw new HarborError('OPERATION_FAILED', `copied tree differs from the original (${after.entries}/${before.entries} entries, ${after.bytes}/${before.bytes} bytes)`);
    }
  } catch (e) {
    rollback(`copy-back failed (${e instanceof Error ? e.message : String(e)})`);
    throw e;
  }
  rmSync(plain, { recursive: true, force: true });
  log(`sealed ${dir} with its existing data; deleted the plaintext copy (old blocks may linger on the device until overwritten)`);
}

// ---------------------------------------------------------------- entry point

function writeStatus(file: string, status: AppCryptoStatus): void {
  try {
    // 0644 in the daemon-owned crypto/ dir: root writes, harbor reads and unlinks.
    writeFileSync(file, JSON.stringify(status), { mode: 0o644 });
  } catch {
    /* the unit's exit code still carries the verdict */
  }
}

function readRequest(file: string, expected: AppCryptoAction): AppCryptoRequest {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new HarborError('INVALID_REQUEST', `no readable request at ${file}`);
  }
  const r = doc as Partial<AppCryptoRequest>;
  if (!r || typeof r !== 'object' || r.action !== expected || typeof r.home !== 'string') throw new HarborError('INVALID_REQUEST', `request at ${file} does not match ${expected}`);
  if (r.protectorName !== undefined && (typeof r.protectorName !== 'string' || !isValidProtectorName(r.protectorName))) throw new HarborError('INVALID_REQUEST', 'invalid protector name');
  return r as AppCryptoRequest;
}

function checkHome(home: string, instanceId: string): string {
  if (!isAllowedHomePath(home)) throw new HarborError('INVALID_REQUEST', `${home} is not an app home path Harbor may seal (expected <drive>/harbor-apps/<package>/<instance> under /mnt, /media or ${PRODUCT.paths.data})`);
  let real: string;
  try {
    real = realpathSync(home);
  } catch {
    throw new HarborError('DATA_MISSING', `app home ${home} does not exist`, { nextAction: 'Re-insert the drive that holds this app, then try again.' });
  }
  if (real !== home) throw new HarborError('INVALID_REQUEST', `app home ${home} resolves through a symlink (${real}); refusing`);
  const { manifest } = describeAppHome(home);
  if (manifest.instanceId !== instanceId) throw new HarborError('INVALID_REQUEST', `app home ${home} belongs to instance ${manifest.instanceId}, not ${instanceId}`);
  return home;
}

export async function applyAppCrypto(spec: string, log: Log): Promise<void> {
  const { instanceId, action } = parseAppCryptoSpec(spec);
  requireRoot('app-crypto');
  const config = loadConfig(`${PRODUCT.paths.etc}/harbor.json`);
  const files = appCryptoFiles(config.stateDir, instanceId);
  const now = () => new Date().toISOString();
  let request: AppCryptoRequest;
  try {
    request = readRequest(files.request, action);
    rmSync(files.request, { force: true });
    checkHome(request.home, instanceId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(files.status, { action, state: 'failed', message: msg, ...(e instanceof HarborError && e.nextAction ? { nextAction: e.nextAction } : {}), at: now() });
    throw e;
  }
  const home = request.home;
  const dir = sealedDir(home);
  writeStatus(files.status, { action, state: 'working', message: `${action} ${dir}`, at: now() });
  try {
    let st: FscryptDirStatus | null = null;
    switch (action) {
      case 'setup': {
        const mnt = await prepareFilesystemForSealing(home, log);
        log(`filesystem ready: ${mnt.mountpoint} (${mnt.fsType})`);
        break;
      }
      case 'seal': {
        if (!request.protectorName) throw new HarborError('INVALID_REQUEST', 'seal needs a protector name');
        const key = await readKeyFromFifo(files.fifo);
        await prepareFilesystemForSealing(home, log);
        if (!existsSync(dir)) {
          const hs = statSync(home);
          mkdirSync(dir, { mode: 0o700 });
          chownSync(dir, hs.uid, hs.gid);
        }
        await encryptEmptyDir(dir, request.protectorName, key, log);
        st = await dirStatus(dir);
        break;
      }
      case 'migrate': {
        if (!request.protectorName) throw new HarborError('INVALID_REQUEST', 'migrate needs a protector name');
        const key = await readKeyFromFifo(files.fifo);
        await prepareFilesystemForSealing(home, log);
        if (!existsSync(dir)) {
          const hs = statSync(home);
          mkdirSync(dir, { mode: 0o700 });
          chownSync(dir, hs.uid, hs.gid);
        }
        await migrateDir(home, dir, request.protectorName, key, log);
        st = await dirStatus(dir);
        break;
      }
      case 'unlock': {
        const key = await readKeyFromFifo(files.fifo);
        await unlockDir(dir, key, log);
        st = await dirStatus(dir);
        break;
      }
      case 'lock': {
        await lockDir(dir, log);
        st = await dirStatus(dir);
        break;
      }
      case 'status': {
        st = existsSync(dir) ? await dirStatus(dir) : { encrypted: false, unlocked: true, partiallyLocked: false, policyVersion: null, policyId: null, protectorIds: [] };
        log(`${dir}: ${st.encrypted ? (st.unlocked ? 'sealed, unlocked' : 'sealed, locked') : 'not sealed'}`);
        break;
      }
    }
    writeStatus(files.status, { action, state: 'ok', message: `${action} ok`, ...(st ? { encrypted: st.encrypted, unlocked: st.unlocked && !st.partiallyLocked } : {}), at: now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeStatus(files.status, { action, state: 'failed', message: msg, ...(e instanceof HarborError && e.nextAction ? { nextAction: e.nextAction } : {}), at: now() });
    throw e;
  }
}
