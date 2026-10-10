// Backup target packages (decision 152): bundled under <release>/targets/<id>/manifest.yaml.
// PURE apart from reading the package folder: no Docker, no DB, no network.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_TARGET_SCHEMA, TRANSPORT_FIELDS, type BackupTargetManifest } from '../contracts/backup-target.schema.js';
import { compile, formatErrors } from '../contracts/validate.js';
import { HarborError } from '../errors.js';
import { parseRestrictedYaml } from '../packages/yaml.js';

const MAX_README_BYTES = 64 * 1024;

export interface LoadedTargetPackage {
  manifest: BackupTargetManifest;
  readme: string | null;
}

export function validateTargetManifest(value: unknown, label = 'manifest.yaml'): BackupTargetManifest {
  const validate = compile<BackupTargetManifest>(BACKUP_TARGET_SCHEMA);
  if (!validate(value)) {
    const details = formatErrors(validate.errors);
    throw new HarborError('INVALID_PACKAGE', `${label}: ${details[0] ?? 'invalid'}`, { details });
  }
  const m = value;
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const f of m.fields) {
    if (ids.has(f.id)) problems.push(`field ${f.id} is duplicated`);
    ids.add(f.id);
    if (f.obscure && m.transport !== 'rclone') problems.push(`field ${f.id}: obscure only applies to rclone targets`);
    if (f.rclone && m.transport !== 'rclone') problems.push(`field ${f.id}: rclone only applies to rclone targets`);
    if (f.default !== undefined && f.type === 'secret') problems.push(`field ${f.id}: a secret cannot have a default`);
  }
  if (m.transport === 'rclone') {
    if (!m.rclone) problems.push('transport rclone needs rclone.backend');
    for (const f of m.fields) if (!f.rclone && f.id !== 'path') problems.push(`field ${f.id}: an rclone target maps every field to an rclone option (only "path" names the folder)`);
  } else {
    if (m.rclone) problems.push(`rclone.backend only applies to transport rclone, not ${m.transport}`);
    const known = TRANSPORT_FIELDS[m.transport];
    for (const id of known.required) if (!ids.has(id)) problems.push(`transport ${m.transport} needs a field ${id}`);
    for (const id of ids) if (!known.required.includes(id) && !known.optional.includes(id)) problems.push(`transport ${m.transport} does not read a field ${id}`);
  }
  if (problems.length) throw new HarborError('INVALID_PACKAGE', `${label}: ${problems[0]}`, { details: problems });
  return m;
}

// <release>/targets next to <release>/catalog; a copied catalog (tests, a custom catalog dir) falls back
// to the targets shipped with this build (src/backups → repo root, dist/backups → release root).
export function targetsDirFor(catalogDir: string): string {
  const beside = path.join(path.dirname(path.resolve(catalogDir)), 'targets');
  return existsSync(beside) ? beside : path.resolve(import.meta.dirname, '../../targets');
}

export function loadTargetPackages(dir: string): LoadedTargetPackage[] {
  if (!existsSync(dir)) return [];
  const out: LoadedTargetPackage[] = [];
  for (const id of readdirSync(dir).sort()) {
    const pkgDir = path.join(dir, id);
    if (!statSync(pkgDir).isDirectory()) continue;
    const file = path.join(pkgDir, 'manifest.yaml');
    const manifest = validateTargetManifest(parseRestrictedYaml(readFileSync(file), `${id}/manifest.yaml`), `${id}/manifest.yaml`);
    if (manifest.metadata.id !== id) throw new HarborError('INVALID_PACKAGE', `${id}/manifest.yaml: metadata.id ${manifest.metadata.id} must match its folder`);
    const readmeFile = path.join(pkgDir, 'README.md');
    let readme: string | null = null;
    if (existsSync(readmeFile) && statSync(readmeFile).size <= MAX_README_BYTES) readme = readFileSync(readmeFile, 'utf8');
    out.push({ manifest, readme });
  }
  return out;
}

// Split an operator's answers into the stored (non-secret) config and the secrets, checking the form.
// `keep` = the secret ids whose stored value stays (the console sent the redacted marker back).
export const REDACTED = '••••';
export function checkTargetValues(m: BackupTargetManifest, values: Record<string, string>, stored: Record<string, string> = {}): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const key of Object.keys(values)) if (!m.fields.some((f) => f.id === key)) throw new HarborError('INVALID_REQUEST', `${m.metadata.name} has no field ${key}`);
  for (const f of m.fields) {
    let v = values[f.id];
    if (f.type === 'secret' && v === REDACTED) v = stored[f.id];
    v = v === undefined || v === '' ? f.default : v;
    if (v !== undefined && f.type !== 'textarea' && f.type !== 'secret') v = v.trim();
    if (v === undefined || v === '') {
      if (f.required) throw new HarborError('INVALID_REQUEST', `${f.label} is required`);
      continue;
    }
    if (v.length > 16 * 1024) throw new HarborError('INVALID_REQUEST', `${f.label} is too long`);
    if (/\0/.test(v)) throw new HarborError('INVALID_REQUEST', `${f.label} contains a NUL character`);
    if (f.type === 'number' && !/^[0-9]{1,6}$/.test(v)) throw new HarborError('INVALID_REQUEST', `${f.label} must be a number`);
    if (f.type !== 'textarea' && f.type !== 'secret' && /[\r\n]/.test(v)) throw new HarborError('INVALID_REQUEST', `${f.label} must be one line`);
    if (f.type === 'secret') secrets[f.id] = v;
    else config[f.id] = v;
  }
  return { config, secrets };
}
