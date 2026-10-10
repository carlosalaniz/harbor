import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLockWait, snapshotsArgs, catConfigArgs, backupArgs, cardPassword, checkArgs, classifyExit, forgetArgs, isAllowedLocalTarget, knownHostsFor, parseBackupLine, parseKeyList, parseSnapshots, rcloneConfig, repoAccess, restoreArgs, snapshotTags, sshCommand, tagValue, type TargetRuntime } from '../../src/backups/restic.js';
import { checkTargetValues, loadTargetPackages, targetsDirFor, validateTargetManifest } from '../../src/backups/targets.js';
import { effectiveSchedule, fitsCap, isDue, isStale, lastWindowStart, nextWindowStart, checkPolicy, DEFAULT_BACKUP_POLICY } from '../../src/backups/schedule.js';
import { rcloneBinary } from '../../src/bootstrap/backup-tools.js';
import { writeZip, readZip } from '../../src/packages/zip.js';
import { backupUnit, checkRequestShape, isSafeStagePath, isStagePath, parseBackupSpec, stageDirFor } from '../../src/backups/step.js';

const T = (transport: TargetRuntime['transport'], config: Record<string, string>, extra: Partial<TargetRuntime> = {}): TargetRuntime => ({ id: '11111111-1111-4111-8111-111111111111', transport, config, fields: [], ...extra });
const dirs = { run: '/run/harbor-backup/r1', rcloneConf: '/var/lib/harbor-backup/t1/rclone.conf' };

describe('restic access per transport (decision 149)', () => {
  it('s3: repository URL from endpoint/bucket/path; keys only in the environment', () => {
    const a = repoAccess(T('s3', { endpoint: 's3.us-west-002.backblazeb2.com', bucket: 'harbor-b', path: '/harbor/', accessKeyId: 'AKIA-FIXTURE', region: 'us-west-002' }), { secretAccessKey: 'secret-FIXTURE' }, dirs);
    expect(a.env).toMatchObject({ RESTIC_REPOSITORY: 's3:https://s3.us-west-002.backblazeb2.com/harbor-b/harbor', AWS_ACCESS_KEY_ID: 'AKIA-FIXTURE', AWS_SECRET_ACCESS_KEY: 'secret-FIXTURE', AWS_DEFAULT_REGION: 'us-west-002' });
    expect(a.options).toEqual([]);
    expect(repoAccess(T('s3', { endpoint: 'http://minio.lan:9000', bucket: 'b1', accessKeyId: 'k' }), { secretAccessKey: 's' }, dirs).env['RESTIC_REPOSITORY']).toBe('s3:http://minio.lan:9000/b1');
    expect(() => repoAccess(T('s3', { endpoint: 'evil host', bucket: 'b1' }), {}, dirs)).toThrow(/host name/);
    expect(() => repoAccess(T('s3', { endpoint: 'x.example', bucket: 'B!' }), {}, dirs)).toThrow(/bucket/);
    expect(() => repoAccess(T('s3', { endpoint: 'x.example', bucket: 'b1', path: 'a/../b' }), {}, dirs)).toThrow(/\.\./);
  });

  it('sftp: Harbor\'s own key and the pinned server key in private files; argv carries no secret', () => {
    const a = repoAccess(T('sftp', { host: 'nas.lan', port: '2222', user: 'backup', path: '/srv/backup/harbor', hostKey: 'nas.lan ssh-ed25519 AAAAFIXTURE' }), { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n-----END OPENSSH PRIVATE KEY-----' }, dirs);
    expect(a.env['RESTIC_REPOSITORY']).toBe('sftp:backup@nas.lan:/srv/backup/harbor');
    expect(a.files.map((f) => f.path)).toEqual(['/run/harbor-backup/r1/id_target', '/run/harbor-backup/r1/known_hosts']);
    expect(a.files[1]!.content).toBe('[nas.lan]:2222 ssh-ed25519 AAAAFIXTURE\n');
    expect(a.options[1]).toBe(`sftp.command=${sshCommand({ host: 'nas.lan', port: 2222, user: 'backup', key: '/run/harbor-backup/r1/id_target', known: '/run/harbor-backup/r1/known_hosts' }).join(' ')}`);
    expect(a.options.join(' ')).toContain('StrictHostKeyChecking=yes');
    expect(a.options.join(' ')).not.toContain('FIXTURE');
    expect(() => repoAccess(T('sftp', { host: 'nas', user: 'root; rm', path: '/x' }), {}, dirs)).toThrow(/user name/);
    expect(() => repoAccess(T('sftp', { host: 'nas', user: 'b', path: 'relative' }), {}, dirs)).toThrow(/absolute/);
  });

  it('known_hosts lines are re-keyed to the host ssh will look up', () => {
    expect(knownHostsFor('h', 22, '# comment\nh ssh-ed25519 AAAA1\nother.name ecdsa-sha2-nistp256 AAAA2\n')).toBe('h ssh-ed25519 AAAA1\nh ecdsa-sha2-nistp256 AAAA2\n');
    expect(knownHostsFor('h', 22, 'garbage')).toBe('');
  });

  it('local: only folders on mounted drives (or Harbor\'s backups folder), never inside an app home tree', () => {
    expect(repoAccess(T('local', { path: '/mnt/usb/harbor' }), {}, dirs).env['RESTIC_REPOSITORY']).toBe('/mnt/usb/harbor');
    for (const ok of ['/mnt/usb/harbor', '/media/carlos/disk/b', '/srv/harbor/backups', '/srv/harbor/backups/x']) expect(isAllowedLocalTarget(ok), ok).toBe(true);
    for (const bad of ['/etc', '/var/lib/harbor', '/srv/harbor', '/mnt/usb/harbor-apps/x', '/mnt/../etc', '/mnt/usb/']) expect(isAllowedLocalTarget(bad), bad).toBe(false);
  });

  it('rclone: a remote named hb from the package\'s field mapping; obscured values where asked', () => {
    const t = T('rclone', { username: 'me@proton.me', path: 'harbor-backups' }, { backend: 'protondrive', fields: [{ id: 'username', rclone: 'username' }, { id: 'password', rclone: 'password', obscure: true, secret: true }, { id: 'twoFactor', rclone: '2fa', secret: true }, { id: 'path' }] });
    const a = repoAccess(t, { password: 'pw' }, dirs);
    expect(a.env).toMatchObject({ RESTIC_REPOSITORY: 'rclone:hb:harbor-backups', RCLONE_CONFIG: dirs.rcloneConf });
    expect(a.options).toEqual(['-o', 'rclone.program=/usr/local/lib/harbor/bin/rclone']);
    expect(rcloneConfig(t, { password: 'pw', twoFactor: '123456' }, { password: 'OBSCURED' })).toBe('[hb]\ntype = protondrive\nusername = me@proton.me\npassword = OBSCURED\n2fa = 123456\n');
    expect(() => rcloneConfig(t, { password: 'pw' }, { password: 'a\nb' })).toThrow(/one line/);
  });

  it('rest: https only, credentials in the environment', () => {
    expect(repoAccess(T('rest', { url: 'https://friend.ts.net:8000/carlos', username: 'carlos' }), { password: 'p' }, dirs).env).toMatchObject({ RESTIC_REPOSITORY: 'rest:https://friend.ts.net:8000/carlos', RESTIC_REST_USERNAME: 'carlos', RESTIC_REST_PASSWORD: 'p' });
    expect(() => repoAccess(T('rest', { url: 'https://u:p@x/y' }), {}, dirs)).toThrow(/without credentials/);
    expect(() => repoAccess(T('rest', { url: 'http://x/y' }), {}, dirs)).toThrow();
  });
});

describe('restic argv and output', () => {
  it('builds the exact argv', () => {
    const tags = snapshotTags({ instanceId: 'i1', runId: 'r1', packageId: 'immich', installationId: 'h1', kind: 'cold' });
    expect(tags).toEqual(['app:i1', 'run:r1', 'pkg:immich', 'harbor:h1', 'kind:cold']);
    expect(tagValue(tags, 'run')).toBe('r1');
    expect(backupArgs({ paths: ['/a', '/b'], tags: ['app:x'], excludes: ['/a/volumes/.harbor-key-probe-*'] })).toEqual(['backup', '--json', '--host', 'harbor', '--tag', 'app:x', '--exclude', '/a/volumes/.harbor-key-probe-*', '/a', '/b']);
    expect(restoreArgs('abcdef12', '/srv/harbor/harbor-apps/memos/memos/volumes', '/x/volumes')).toEqual(['restore', 'abcdef12:/srv/harbor/harbor-apps/memos/memos/volumes', '--target', '/x/volumes']);
    expect(() => restoreArgs('latest', '/a', '/b')).toThrow(/snapshot id/);
    expect(forgetArgs({ instanceId: 'i1', retention: { daily: 7, weekly: 4, monthly: 6 }, prune: false })).toEqual(['forget', '--json', '--tag', 'app:i1,kind:cold', '--group-by', '', '--keep-last', '1', '--keep-daily', '7', '--keep-weekly', '4', '--keep-monthly', '6']);
    expect(forgetArgs({ snapshotIds: ['abcdef12'], prune: true })).toEqual(['forget', '--json', '--prune', 'abcdef12']);
    expect(checkArgs(2)).toEqual(['check', '--read-data-subset=2%']);
    expect(cardPassword('  Apple  BANANA\tcherry ')).toBe('apple banana cherry');
    // listing never takes a lock; steps that do wait for another Harbor's lock instead of failing at once
    expect(snapshotsArgs('kind:cold')).toEqual(['--no-lock', 'snapshots', '--json', '--tag', 'kind:cold']);
    expect(catConfigArgs()).toEqual(['--no-lock', 'cat', 'config']);
    expect(withLockWait(['prune'])).toEqual(['--retry-lock', '5m', 'prune']);
    expect(withLockWait(snapshotsArgs())).toEqual(['--no-lock', 'snapshots', '--json']);
  });

  it('parses restic 0.19 JSON', () => {
    expect(parseBackupLine('{"message_type":"status","percent_done":0.5,"total_files":10,"files_done":5,"total_bytes":100,"bytes_done":50}')).toEqual({ type: 'status', percent: 0.5, bytesDone: 50, totalBytes: 100, filesDone: 5, totalFiles: 10 });
    expect(parseBackupLine('{"message_type":"summary","files_new":3,"files_changed":1,"files_unmodified":0,"data_added":306810,"data_added_packed":305108,"total_files_processed":3,"total_bytes_processed":300008,"total_duration":0.74,"snapshot_id":"12147c25"}')).toMatchObject({ type: 'summary', snapshotId: '12147c25', dataAdded: 306810, totalBytes: 300008 });
    expect(parseBackupLine('{"message_type":"error","error":{"message":"permission denied"},"during":"archival","item":"/x"}')).toEqual({ type: 'error', message: '/x: permission denied' });
    expect(parseBackupLine('not json')).toBeNull();
    const snaps = parseSnapshots('[{"time":"2026-10-10T12:06:12-05:00","paths":["/h","/run/harbor-backup/stage/a/b"],"hostname":"harbor","tags":["app:x","kind:cold"],"id":"aaaa","short_id":"aa","summary":{"total_bytes_processed":9,"data_added":3}},{"time":"2026-10-09T00:00:00Z","paths":[],"tags":null,"id":"bbbb"}]');
    expect(snaps.map((s) => s.id)).toEqual(['bbbb', 'aaaa']);
    expect(snaps[1]).toMatchObject({ totalBytes: 9, dataAdded: 3, tags: ['app:x', 'kind:cold'] });
    expect(parseKeyList('[{"current":true,"id":"k1","userName":"root","created":"x"},{"current":false,"id":"k2","userName":"harbor-card-2026"}]')).toEqual([{ id: 'k1', current: true, label: 'root', created: 'x' }, { id: 'k2', current: false, label: 'harbor-card-2026', created: '' }]);
    expect([0, 3, 10, 11, 12, 130, 1].map(classifyExit)).toEqual(['ok', 'partial', 'repo-missing', 'locked', 'wrong-password', 'interrupted', 'failed']);
  });
});

describe('target packages (decision 152)', () => {
  it('the bundled places validate as the daemon loads them', () => {
    const pkgs = loadTargetPackages(targetsDirFor(path.resolve(import.meta.dirname, '../../catalog')));
    expect(pkgs.map((p) => `${p.manifest.metadata.id}:${p.manifest.transport}`)).toEqual(['folder:local', 'protondrive:rclone', 's3:s3', 'sftp:sftp']);
  });

  it('refuses packages that do not match their transport, or try to carry more than a form', () => {
    const base = { apiVersion: 'harbor/v1alpha1', kind: 'BackupTarget', metadata: { id: 'x', name: 'X', description: 'x', status: 'stable' }, release: { revision: '1' } };
    expect(() => validateTargetManifest({ ...base, transport: 's3', fields: [{ id: 'endpoint', label: 'E', type: 'text' }] })).toThrow(/needs a field bucket/);
    expect(() => validateTargetManifest({ ...base, transport: 'local', fields: [{ id: 'path', label: 'P', type: 'text' }, { id: 'command', label: 'C', type: 'text' }] })).toThrow(/does not read a field command/);
    expect(() => validateTargetManifest({ ...base, transport: 'rclone', fields: [{ id: 'user', label: 'U', type: 'text', rclone: 'user' }] })).toThrow(/rclone.backend/);
    expect(() => validateTargetManifest({ ...base, transport: 'rclone', rclone: { backend: 'mega' }, fields: [{ id: 'user', label: 'U', type: 'text' }] })).toThrow(/maps every field/);
    expect(() => validateTargetManifest({ ...base, transport: 'local', script: 'rm -rf /', fields: [{ id: 'path', label: 'P', type: 'text' }] })).toThrow();
    expect(() => validateTargetManifest({ ...base, transport: 'local', fields: [{ id: 'path', label: 'P', type: 'secret', default: 'x' }] })).toThrow(/secret cannot have a default/);
  });

  it('splits answers into config and secrets; the redacted marker keeps a stored secret', () => {
    const s3 = loadTargetPackages(targetsDirFor(path.resolve(import.meta.dirname, '../../catalog'))).find((p) => p.manifest.metadata.id === 's3')!.manifest;
    const v = checkTargetValues(s3, { endpoint: ' s3.example.com ', bucket: 'b1', accessKeyId: 'k', secretAccessKey: 's' });
    expect(v).toEqual({ config: { endpoint: 's3.example.com', bucket: 'b1', path: 'harbor', accessKeyId: 'k' }, secrets: { secretAccessKey: 's' } });
    expect(checkTargetValues(s3, { endpoint: 'e', bucket: 'b1', accessKeyId: 'k', secretAccessKey: '••••' }, { secretAccessKey: 'kept' }).secrets).toEqual({ secretAccessKey: 'kept' });
    expect(() => checkTargetValues(s3, { endpoint: 'e', bucket: 'b1', accessKeyId: 'k' })).toThrow(/Secret access key is required/);
    expect(() => checkTargetValues(s3, { endpoint: 'e\nx', bucket: 'b1', accessKeyId: 'k', secretAccessKey: 's' })).toThrow(/one line/);
  });
});

describe('backup schedule (decision 151)', () => {
  const daily = { window: '02:00', cadence: 'daily' as const, weekday: 0 };
  it('finds the window around now, in local time', () => {
    const now = new Date(2026, 9, 10, 3, 30);
    expect(lastWindowStart(now, daily)).toEqual(new Date(2026, 9, 10, 2, 0));
    expect(lastWindowStart(new Date(2026, 9, 10, 1, 0), daily)).toEqual(new Date(2026, 9, 9, 2, 0));
    expect(nextWindowStart(now, daily)).toEqual(new Date(2026, 9, 11, 2, 0));
    const weekly = { ...daily, cadence: 'weekly' as const, weekday: 3 }; // Wednesday
    expect(lastWindowStart(now, weekly)).toEqual(new Date(2026, 9, 7, 2, 0)); // 10 Oct 2026 is a Saturday
    expect(nextWindowStart(now, weekly)).toEqual(new Date(2026, 9, 14, 2, 0));
  });
  it('is due once per window, within the grace period', () => {
    const now = new Date(2026, 9, 10, 2, 5);
    expect(isDue(now, daily, null)).toBe(true);
    expect(isDue(now, daily, new Date(2026, 9, 10, 2, 1))).toBe(false);
    expect(isDue(now, daily, new Date(2026, 9, 9, 2, 1))).toBe(true);
    expect(isDue(new Date(2026, 9, 10, 15, 0), daily, new Date(2026, 9, 9, 2, 1))).toBe(false); // missed by more than 12 h: wait for tonight
    expect(isStale(new Date(2026, 9, 13, 3, 0), daily, new Date(2026, 9, 10, 2, 0), new Date(2026, 0, 1))).toBe(true);
    expect(isStale(new Date(2026, 9, 11, 3, 0), daily, new Date(2026, 9, 10, 2, 0), new Date(2026, 0, 1))).toBe(false);
  });
  it('app overrides win over the global policy; the cap estimate converges on small or quick passes', () => {
    expect(effectiveSchedule(DEFAULT_BACKUP_POLICY, { enabled: true, targets: [], window: '04:00', cadence: null, weekday: null })).toEqual({ window: '04:00', cadence: 'daily', weekday: 0 });
    expect(fitsCap(10 * 1024 * 1024, 9999, 300)).toBe(true);
    expect(fitsCap(5e9, 3600, 300)).toBe(false);
    expect(fitsCap(5e9, 100, 300)).toBe(true);
    expect(checkPolicy({ ...DEFAULT_BACKUP_POLICY, window: '25:00' })).toMatch(/HH:MM/);
    expect(checkPolicy({ ...DEFAULT_BACKUP_POLICY, maxDowntimeMinutes: 0 })).toMatch(/downtime/);
    expect(checkPolicy(DEFAULT_BACKUP_POLICY)).toBeNull();
  });
});

describe('backup tools install', () => {
  it('finds rclone in its release zip (the top folder is dropped by the reader)', () => {
    const zip = writeZip({ 'README.txt': 'x', rclone: Buffer.from('ELF-FIXTURE'), 'rclone.1': 'man' }, { folder: 'rclone-v1.75.2-linux-amd64' });
    expect(rcloneBinary(readZip(zip))?.toString()).toBe('ELF-FIXTURE');
    expect(rcloneBinary(new Map([['README.txt', Buffer.from('x')]]))).toBeNull();
  });
});

describe('root step contract (decision 153)', () => {
  it('binds the unit to one request id and validates the request shape', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(backupUnit(id)).toBe(`harbor-backup@${id}.service`);
    expect(() => backupUnit('x;y')).toThrow();
    expect(parseBackupSpec(id)).toBe(id);
    expect(() => parseBackupSpec('../etc')).toThrow();
    const target = { id, transport: 'local', config: { path: '/mnt/x' }, fields: [] };
    expect(checkRequestShape({ action: 'test', target, requestedAt: 'x' }).action).toBe('test');
    expect(() => checkRequestShape({ action: 'rm', target })).toThrow(/action/);
    expect(() => checkRequestShape({ action: 'backup', target, tags: ['app:x', 'evil tag'] })).toThrow(/tags/);
    expect(stageDirFor(id, id)).toBe(`/run/harbor-backup/stage/${id}/${id}`);
    expect(isStagePath(stageDirFor(id, id))).toBe(true);
    expect(isStagePath('/var/lib/harbor/instances')).toBe(false);
    for (const ok of ['instance.json', 'secrets/db-password', 'release/manifest.yaml']) expect(isSafeStagePath(ok)).toBe(true);
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', '.']) expect(isSafeStagePath(bad), bad).toBe(false);
  });
});

// The builders against the real binary, when this machine has restic (macOS brew, a droplet). CI skips it.
const hasRestic = spawnSync('restic', ['version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!hasRestic)('real restic (local repository)', () => {
  it('init → backup → snapshots → restore subfolder → forget with the argv Harbor builds', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'harbor-restic-'));
    const home = path.join(root, 'srv', 'harbor-apps', 'memos', 'memos');
    mkdirSync(path.join(home, 'volumes', 'data'), { recursive: true });
    writeFileSync(path.join(home, 'manifest.json'), '{}');
    writeFileSync(path.join(home, 'volumes', 'data', 'db.bin'), Buffer.alloc(200_000, 7));
    const env = { ...process.env, RESTIC_REPOSITORY: path.join(root, 'repo'), RESTIC_PASSWORD: 'backup-key-FIXTURE', RESTIC_CACHE_DIR: path.join(root, 'cache') };
    const r = (args: string[]) => execFileSync('restic', args, { env, encoding: 'utf8' });
    r(['init', '--json']);
    const out = r(backupArgs({ paths: [home], tags: snapshotTags({ instanceId: 'i1', runId: 'r1', packageId: 'memos', installationId: 'h1', kind: 'cold' }), excludes: [`${home}/volumes/.harbor-key-probe-*`] }));
    const summary = out.split('\n').map(parseBackupLine).find((l) => l?.type === 'summary');
    expect(summary).toMatchObject({ type: 'summary', totalBytes: 200_002 });
    const snaps = parseSnapshots(r(['snapshots', '--json', '--tag', 'app:i1,kind:cold']));
    expect(snaps).toHaveLength(1);
    r(restoreArgs(snaps[0]!.id, `${home}/volumes`, path.join(root, 'out')));
    expect(readFileSync(path.join(root, 'out', 'data', 'db.bin')).equals(Buffer.alloc(200_000, 7))).toBe(true);
    r(forgetArgs({ instanceId: 'i1', retention: { daily: 7, weekly: 4, monthly: 6 }, prune: false }));
    expect(parseSnapshots(r(['snapshots', '--json']))).toHaveLength(1);
  });
});
