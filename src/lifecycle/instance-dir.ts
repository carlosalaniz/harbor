import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { LoadedPackage } from '../contracts/types.js';
import { UUID_RE } from '../contracts/patterns.js';
import { HarborError } from '../errors.js';
import { loadPackageDir } from '../packages/catalog.js';
import type { Ids } from '../util.js';

// Layout under <stateDir>/instances/<uuid>/ :
//   release/   immutable snapshot of the four package files (nonsecret)      0700 / 0600
//   runtime/   generated compose.yaml with resolved secrets (private)         0700 / 0600
//   secrets/   one file per secret id, hex, written once                     0700 / 0600

export function instanceDir(stateDir: string, instanceId: string): string {
  if (!UUID_RE.test(instanceId)) throw new HarborError('INVALID_REQUEST', `invalid instance id ${instanceId}`);
  const dir = path.resolve(stateDir, 'instances', instanceId);
  const rel = path.relative(path.resolve(stateDir, 'instances'), dir);
  if (rel !== instanceId) throw new HarborError('INVALID_REQUEST', 'instance path escapes state directory');
  return dir;
}

export function ensureInstanceDirs(stateDir: string, instanceId: string): { root: string; release: string; runtime: string; secrets: string } {
  const root = instanceDir(stateDir, instanceId);
  const dirs = { root, release: path.join(root, 'release'), runtime: path.join(root, 'runtime'), secrets: path.join(root, 'secrets') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
}

function writeDurable(file: string, data: Buffer | string, mode: number, exclusive: boolean): void {
  const tmp = exclusive ? file : `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, exclusive ? 'wx' : 'w', mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(tmp, file);
  const dfd = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(dfd);
  } catch {
    /* directory fsync unsupported on some platforms */
  } finally {
    closeSync(dfd);
  }
}

// Snapshot the exact package bytes. Idempotent when the same bytes already exist; a different
// existing snapshot is a conflict (the instance is bound to exactly one release).
export function writeReleaseSnapshot(releaseDir: string, pkg: LoadedPackage): void {
  const files: [string, Buffer][] = [
    ['manifest.yaml', pkg.raw.manifest],
    ['compose.yaml', pkg.raw.compose],
    ['README.md', pkg.raw.readme],
    ['release.json', pkg.raw.release],
    ...Object.entries(pkg.assets),
  ];
  for (const [name, bytes] of files) {
    const target = path.join(releaseDir, name);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(bytes)) throw new HarborError('STATE_CHANGED', `release snapshot ${name} differs from the package being applied`);
      continue;
    }
    writeDurable(target, bytes, 0o600, false);
  }
  // Git-sourced packages: snapshot the build contexts too (decision 80); reinstalls rebuild the same bytes.
  const buildSrc = path.join(pkg.dir, 'build');
  const buildDst = path.join(releaseDir, 'build');
  if (existsSync(buildSrc) && !existsSync(buildDst)) cpSync(buildSrc, buildDst, { recursive: true });
}

export function loadReleaseSnapshot(releaseDir: string, packageId: string): LoadedPackage {
  if (!existsSync(releaseDir)) throw new HarborError('DATA_MISSING', `release snapshot ${releaseDir} is missing`);
  return loadPackageDir(releaseDir, packageId, `snapshot:${packageId}`);
}

export function writeRuntimeCompose(runtimeDir: string, yaml: string): string {
  const file = path.join(runtimeDir, 'compose.yaml');
  writeDurable(file, yaml, 0o600, false);
  return file;
}

export function secretFile(secretsDir: string, secretId: string): string {
  return path.join(secretsDir, secretId);
}

// Generate once, exclusively and durably. Returns false when the file already existed.
export function generateSecretOnce(secretsDir: string, secretId: string, ids: Ids): boolean {
  const file = secretFile(secretsDir, secretId);
  if (existsSync(file)) return false;
  writeDurable(file, ids.token(32).toString('hex'), 0o600, true);
  return true;
}

export function readSecret(secretsDir: string, secretId: string): string {
  const file = secretFile(secretsDir, secretId);
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    throw new HarborError('SECRET_MISSING', `secret ${secretId} is missing for this instance`);
  }
  const value = readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new HarborError('SECRET_MISSING', `secret ${secretId} is unreadable or corrupt`);
  return value;
}

export function secretExists(secretsDir: string, secretId: string): boolean {
  return statSync(secretFile(secretsDir, secretId), { throwIfNoEntry: false })?.isFile() ?? false;
}

export function writeJsonPrivate(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
