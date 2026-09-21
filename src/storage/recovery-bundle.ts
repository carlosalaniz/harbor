// Recovery bundle: everything needed to rebuild this Harbor on a fresh
// machine, wrapped in one passphrase the operator writes down. Scope is the
// spec's preserved backup boundary: configuration + Harbor-owned recovery
// secrets only — never application databases/photos/workflows/files (those
// stay the app's own backup job; drive apps are portable via passphrase).
//
// Contents (JSON, then scrypt → AES-256-GCM, same profile as app homes):
//   harbor.db            the whole state (instances, ports, exposures, settings
//                        incl. the sealed machine key, appearance, domains…)
//   instances/<id>/secrets/*   per-instance secret files (basic-auth, app keys)
//   instances/<id>/release/    stored release snapshots (reinstall needs them)
//   app-home manifests   <home>/manifest.json per adopted home (the envelopes;
//                        the vault/ payload itself is NOT included — drive apps
//                        travel on their drive, data-folder apps need their
//                        /srv/harbor copy restored alongside)
//   packages/            uploaded ("your own apps") zips, so updates still resolve
//
// Restore = stop daemon, unpack the DB + secrets + releases + packages over a
// fresh state dir, adopt drive apps with their passphrases, start. Managed
// Docker volumes are NOT in the bundle (they live on the engine); the guide
// says so out loud.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarborError } from '../errors.js';
import { APP_HOME_SCRYPT } from './app-home.js';
import { readZip, writeZip } from '../packages/zip.js';

export const RECOVERY_BUNDLE_VERSION = 1;
const BUNDLE_SCRYPT = APP_HOME_SCRYPT;
const NONCE_BYTES = 12;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, BUNDLE_SCRYPT.keylen, { N: BUNDLE_SCRYPT.N, r: BUNDLE_SCRYPT.r, p: BUNDLE_SCRYPT.p, maxmem: BUNDLE_SCRYPT.maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key as Buffer);
    });
  });
}

export interface RecoveryBundleInfo {
  file: string;
  bytes: number;
  instances: number;
  appHomes: number;
  secrets: number;
  at: string;
}

function listFilesRecursive(dir: string, base = ''): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    if (e === 'harbor.lock') continue;
    const abs = path.join(dir, e);
    const rel = base ? `${base}/${e}` : e;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listFilesRecursive(abs, rel));
    else if (st.isFile()) out.push({ rel, abs });
  }
  return out;
}

// Collect the bundle payload from a live state dir. The caller holds the
// state lock (daemon stopped); the DB is copied with its WAL sidecars so a
// checkpoint in progress is not lost. SQLite tolerates a hot copy of the
// three files taken together; restore replays the WAL on first open.
export function collectRecoveryFiles(stateDir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const db = path.join(stateDir, 'harbor.db');
  if (!existsSync(db)) throw new HarborError('DATA_MISSING', `no state database at ${db}`, { nextAction: 'Run this on the Harbor machine (usually /var/lib/harbor).' });
  files.set('harbor.db', readFileSync(db));
  for (const suffix of ['-wal', '-shm']) {
    const f = path.join(stateDir, `harbor.db${suffix}`);
    if (existsSync(f)) files.set(`harbor.db${suffix}`, readFileSync(f));
  }
  // Per-instance secrets + release snapshots (reinstall + retained data need both).
  const instRoot = path.join(stateDir, 'instances');
  for (const { rel, abs } of listFilesRecursive(instRoot)) {
    const parts = rel.split('/');
    if (parts.length < 2) continue;
    const leaf = parts[1]!;
    if (leaf !== 'secrets' && leaf !== 'release') continue;
    if (rel.includes('..') || rel.includes('\\')) continue;
    const data = readFileSync(abs);
    if (data.length > 64 * 1024 * 1024) throw new HarborError('INVALID_REQUEST', `recovery bundle refuses oversized file ${rel}`);
    files.set(`instances/${rel}`, data);
  }
  // Uploaded packages ("your own apps") so updates still resolve after restore.
  const pkgRoot = path.join(stateDir, 'packages');
  for (const { rel, abs } of listFilesRecursive(pkgRoot)) {
    if (rel.includes('..') || rel.includes('\\')) continue;
    const data = readFileSync(abs);
    if (data.length > 64 * 1024 * 1024) continue;
    files.set(`packages/${rel}`, data);
  }
  // App-home manifests (envelopes only — the vault payload travels on the drive).
  // Walked from the DB would need SQL here; instead the caller passes homes.
  return files;
}

export function addAppHomeManifests(files: Map<string, Buffer>, homes: { home: string; manifest: Buffer }[]): void {
  for (const h of homes) {
    const safe = h.home.replace(/[^a-zA-Z0-9-_/.]/g, '_').replace(/^\//, '');
    files.set(`app-homes/${safe}/manifest.json`, h.manifest);
  }
}

export async function sealRecoveryBundle(files: Map<string, Buffer>, passphrase: string): Promise<Buffer> {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new HarborError('INVALID_REQUEST', 'recovery passphrase must be at least 8 characters');
  if (passphrase.length > 256) throw new HarborError('INVALID_REQUEST', 'recovery passphrase must be at most 256 characters');
  const inner = writeZip(Object.fromEntries([...files.entries()].map(([k, v]) => [k, v])));
  const salt = randomBytes(16);
  const kek = await scryptAsync(passphrase, salt);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    const sealed = Buffer.concat([cipher.update(inner), cipher.final()]);
    const envelope = { format: RECOVERY_BUNDLE_VERSION, algorithm: 'aes-256-gcm', scrypt: { N: BUNDLE_SCRYPT.N, r: BUNDLE_SCRYPT.r, p: BUNDLE_SCRYPT.p, keylen: BUNDLE_SCRYPT.keylen }, salt: salt.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    return writeZip({ 'recovery.json': Buffer.from(JSON.stringify(envelope), 'utf8'), 'recovery.bin': sealed });
  } finally {
    kek.fill(0);
  }
}

export async function openRecoveryBundle(bundle: Buffer, passphrase: string): Promise<Map<string, Buffer>> {
  let outer: Map<string, Buffer>;
  try {
    outer = readZip(bundle);
  } catch {
    throw new HarborError('INVALID_PACKAGE', 'this is not a Harbor recovery file', { nextAction: 'Use the .harbor-recovery file written by `harbor recovery export`.' });
  }
  const rawEnv = outer.get('recovery.json');
  const sealed = outer.get('recovery.bin');
  if (!rawEnv || !sealed) throw new HarborError('INVALID_PACKAGE', 'this is not a Harbor recovery file', { nextAction: 'Use the .harbor-recovery file written by `harbor recovery export`.' });
  let env: { format?: unknown; salt?: unknown; nonce?: unknown; tag?: unknown };
  try {
    env = JSON.parse(rawEnv.toString('utf8')) as typeof env;
  } catch {
    throw new HarborError('INVALID_PACKAGE', 'recovery file header is corrupt');
  }
  if (env.format !== RECOVERY_BUNDLE_VERSION || typeof env.salt !== 'string' || typeof env.nonce !== 'string' || typeof env.tag !== 'string') {
    throw new HarborError('INVALID_PACKAGE', 'recovery file uses an unsupported format', { nextAction: 'Update Harbor to a version that understands this file, then try again.' });
  }
  const kek = await scryptAsync(passphrase, Buffer.from(env.salt, 'hex'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(env.nonce, 'hex'));
    decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
    let inner: Buffer;
    try {
      inner = Buffer.concat([decipher.update(sealed), decipher.final()]);
    } catch {
      throw new HarborError('INVALID_REQUEST', 'wrong recovery passphrase', { nextAction: 'Type the passphrase set at export time.' });
    }
    try {
      return readZip(inner);
    } catch {
      throw new HarborError('INVALID_PACKAGE', 'recovery file payload is corrupt');
    }
  } finally {
    kek.fill(0);
  }
}

// Restore the payload over a fresh state dir (daemon stopped, DB absent).
// Refuses to overwrite an existing database — restore targets a fresh machine.
export function restoreRecoveryFiles(stateDir: string, files: Map<string, Buffer>): { instances: number; secrets: number; appHomes: number } {
  if (existsSync(path.join(stateDir, 'harbor.db'))) throw new HarborError('INVALID_STATE', `state already exists at ${stateDir}`, { nextAction: 'Restore onto a fresh machine (or move the existing state aside first). Harbor never overwrites state on import.' });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let secrets = 0;
  const instances = new Set<string>();
  let appHomes = 0;
  for (const [rel, data] of files) {
    if (rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) throw new HarborError('INVALID_PACKAGE', `recovery file carries an unsafe path ${rel}`);
    if (rel === 'harbor.db' || rel === 'harbor.db-wal' || rel === 'harbor.db-shm') {
      writeFileSync(path.join(stateDir, rel), data, { mode: 0o600 });
      continue;
    }
    if (rel.startsWith('instances/')) {
      const rest = rel.slice('instances/'.length).split('/');
      if (rest.length >= 3 && (rest[1] === 'secrets' || rest[1] === 'release')) instances.add(rest[0]!);
      if (rest[1] === 'secrets') secrets += 1;
      const dest = path.join(stateDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, data, { mode: 0o600 });
      continue;
    }
    if (rel.startsWith('packages/')) {
      const dest = path.join(stateDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, data, { mode: 0o600 });
      continue;
    }
    if (rel.startsWith('app-homes/') && rel.endsWith('/manifest.json')) {
      appHomes += 1;
      continue; // informational copy only; the live manifest stays on the drive
    }
    throw new HarborError('INVALID_PACKAGE', `recovery file carries an unknown entry ${rel}`);
  }
  if (!existsSync(path.join(stateDir, 'harbor.db'))) throw new HarborError('INVALID_PACKAGE', 'recovery file has no state database');
  return { instances: instances.size, secrets, appHomes };
}
