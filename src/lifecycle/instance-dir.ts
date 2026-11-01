import { chmodSync, closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { InternetMode, LoadedPackage, SettingValue } from '../contracts/types.js';
import { UUID_RE } from '../contracts/patterns.js';
import { HarborError } from '../errors.js';
import { loadPackageDir } from '../packages/catalog.js';
import { parse as parseYaml } from 'yaml';
import type { Ids } from '../util.js';

// Layout under <stateDir>/instances/<uuid>/ :
//   release/   immutable snapshot of the four package files (nonsecret)      0700 / 0600
//   runtime/   generated compose.yaml with resolved secrets (private)         0700 / 0600
//   secrets/   one file per secret id, hex, written once                     0700 / 0600
//   settings.json  decision 180: the operator's setting overrides (not secret)   0644, absent = all defaults

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

// The parsed runtime compose.yaml (null = not rendered yet or unreadable). It holds secret values: callers read
// structure only (decision 179: whether it hands a service the graphics card), never pass it on.
export function readRuntimeModel(runtimeDir: string): unknown {
  try {
    return parseYaml(readFileSync(path.join(runtimeDir, 'compose.yaml'), 'utf8')) as unknown;
  } catch {
    return null;
  }
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

// Decision 125: a value the operator typed. Same file, mode and directory as generated secrets; written
// exclusively at install (replace: true only for a configure plan that changes it), never logged.
export function writeOperatorSecret(secretsDir: string, secretId: string, value: string, opts: { replace: boolean }): void {
  const file = secretFile(secretsDir, secretId);
  if (!opts.replace && existsSync(file)) throw new HarborError('OWNERSHIP_CONFLICT', `secret ${secretId} already exists for a fresh instance`, { nextAction: 'Inspect the instance directory manually.' });
  writeDurable(file, value, 0o600, !opts.replace);
}

export function readOperatorSecret(secretsDir: string, secretId: string): string {
  const file = secretFile(secretsDir, secretId);
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new HarborError('SECRET_MISSING', `secret ${secretId} is missing for this instance`, { nextAction: 'Set it again: app page → Settings → Change, or `harbor configure <app> --secret ' + secretId + '=@file`.' });
  const value = readFileSync(file, 'utf8');
  if (!value) throw new HarborError('SECRET_MISSING', `secret ${secretId} is empty for this instance`);
  return value;
}

export function removeSecret(secretsDir: string, secretId: string): void {
  rmSync(secretFile(secretsDir, secretId), { force: true });
}

export function secretExists(secretsDir: string, secretId: string): boolean {
  return statSync(secretFile(secretsDir, secretId), { throwIfNoEntry: false })?.isFile() ?? false;
}

export function writeJsonPrivate(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

// Decision 180: the setting values the operator chose (only overrides; the release's defaults fill the rest).
// Not secret. Kept with the instance directory: across remove/reinstall, gone with a full uninstall.
export const SETTINGS_FILE = 'settings.json';

export function settingsFile(stateDir: string, instanceId: string): string {
  return path.join(instanceDir(stateDir, instanceId), SETTINGS_FILE);
}

function readSettingsDoc(stateDir: string, instanceId: string): { values?: unknown; internet?: unknown; login?: unknown } | null {
  let raw: string;
  try {
    raw = readFileSync(settingsFile(stateDir, instanceId), 'utf8');
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(raw) as { values?: unknown; internet?: unknown; login?: unknown };
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

// The stored overrides; a missing or unreadable file means none (every setting at its default).
export function readSettingOverrides(stateDir: string, instanceId: string): Record<string, SettingValue> {
  const doc = readSettingsDoc(stateDir, instanceId);
  const values = doc?.values && typeof doc.values === 'object' ? (doc.values as Record<string, unknown>) : {};
  const out: Record<string, SettingValue> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  return out;
}

// Decision 184: the operator's internet choice for this app lives in the same file (`internet`), so backups,
// restores and update rollbacks carry it with the setting values. null = follow the package's default.
export function readInternetChoice(stateDir: string, instanceId: string): InternetMode | null {
  const v = readSettingsDoc(stateDir, instanceId)?.internet;
  return v === 'direct' || v === 'vpn' || v === 'offline' ? v : null;
}

// Decision 194: the operator's app-login switches (endpoint -> on) live here too, so backups and restores carry them.
export function readLoginChoices(stateDir: string, instanceId: string): Record<string, boolean> {
  const v = readSettingsDoc(stateDir, instanceId)?.login;
  const out: Record<string, boolean> = {};
  if (v && typeof v === 'object') for (const [k, on] of Object.entries(v as Record<string, unknown>)) if (on === true) out[k] = true;
  return out;
}

function writeSettingsDoc(stateDir: string, instanceId: string, values: Record<string, SettingValue>, internet: InternetMode | null, login: Record<string, boolean> = readLoginChoices(stateDir, instanceId)): void {
  const file = settingsFile(stateDir, instanceId);
  const logins = Object.fromEntries(Object.entries(login).filter(([, on]) => on).sort(([a], [b]) => a.localeCompare(b)));
  if (!Object.keys(values).length && internet === null && !Object.keys(logins).length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  writeDurable(file, JSON.stringify({ format: 1, values: sorted, ...(internet ? { internet } : {}), ...(Object.keys(logins).length ? { login: logins } : {}) }, null, 2) + '\n', 0o644, false);
  chmodSync(file, 0o644); // UMask=0077 masks the open() mode
}

// Written atomically (temp file + rename); no overrides (and no internet choice) = no file.
export function writeSettingOverrides(stateDir: string, instanceId: string, values: Record<string, SettingValue>): void {
  writeSettingsDoc(stateDir, instanceId, values, readInternetChoice(stateDir, instanceId));
}

export function writeInternetChoice(stateDir: string, instanceId: string, choice: InternetMode | null): void {
  writeSettingsDoc(stateDir, instanceId, readSettingOverrides(stateDir, instanceId), choice);
}

export function writeLoginChoices(stateDir: string, instanceId: string, login: Record<string, boolean>): void {
  writeSettingsDoc(stateDir, instanceId, readSettingOverrides(stateDir, instanceId), readInternetChoice(stateDir, instanceId), login);
}

// The raw bytes (backups carry the file as it is; null = no overrides).
export function readSettingsBytes(stateDir: string, instanceId: string): Buffer | null {
  try {
    return readFileSync(settingsFile(stateDir, instanceId));
  } catch {
    return null;
  }
}

export function writeSettingsBytes(stateDir: string, instanceId: string, bytes: Buffer | null): void {
  const file = settingsFile(stateDir, instanceId);
  if (!bytes) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeDurable(file, bytes, 0o644, false);
  chmodSync(file, 0o644);
}
