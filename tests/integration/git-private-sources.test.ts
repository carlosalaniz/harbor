import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddSourceResult, InstanceSummary, PackageSourceDto } from '../../src/contracts/api.js';
import { gitAuthHeader } from '../../src/packages/git.js';
import { ADMIN, startHarness, type Harness } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

// Decision 211 (#9): git sources from private repositories, with an access token.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const REPO = 'https://github.com/carlos/private-notes';
const TOKEN = 'tok-FIXTURE-private-notes-0001';
const ROTATED = 'tok-FIXTURE-private-notes-0002';
const WRONG = 'tok-FIXTURE-wrong-token-9999';
const MANIFEST = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: private-notes
  name: Private Notes
  description: Built from a private repository
release:
  revision: "1"
  version: "0.1.0"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 3000
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
presentation:
  tagline: Notes from a private repo
  category: developer
`;
const files = (marker: string): Record<string, string> => ({
  'harbor/manifest.yaml': MANIFEST,
  'harbor/compose.yaml': 'services:\n  web:\n    build:\n      context: ../app\n',
  'app/Dockerfile': `FROM scratch\n# ${marker}\n`,
});
const sources = async () => (await h.api.expect<{ items: PackageSourceDto[] }>(200, 'GET', '/v1/package-sources')).items;
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name);
const waitFor = async (fn: () => Promise<boolean>, ms = 20000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 300));
  }
};
// every form a token could leak in: clear, the Basic header, its base64 payload
const forms = (t: string) => [t, gitAuthHeader(t), gitAuthHeader(t).slice('Basic '.length)];
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    const st = statSync(p);
    return st.isDirectory() ? allFiles(p) : st.isFile() ? [p] : [];
  });

describe('private git sources (decision 211)', () => {
  let source: PackageSourceDto;
  let inst: InstanceSummary;

  it('without a token the repository is a named refusal, and nothing is added', async () => {
    h.git.setRepo(REPO, 'main', [{ commit: 'a'.repeat(40), committerDateUnix: 1_760_100_000, files: files('v1') }], { token: TOKEN });
    const e = await h.api.expectError(422, 'SOURCE_REFUSED', 'POST', '/v1/package-sources', { url: REPO });
    expect(e.error.message).toMatch(/asked for a sign-in/);
    expect(e.error.nextAction).toMatch(/access token/);
    expect(await sources()).toEqual([]);
  });

  it('a wrong token is "the repository refused the token"; it is not stored and not echoed', async () => {
    const e = await h.api.expectError(422, 'SOURCE_REFUSED', 'POST', '/v1/package-sources', { url: REPO, token: WRONG });
    expect(e.error.message).toBe('the repository refused the token');
    expect(e.error.nextAction).toMatch(/Contents: read-only/);
    for (const f of forms(WRONG)) expect(JSON.stringify(e)).not.toContain(f);
    expect(await sources()).toEqual([]);
  });

  it('a URL carrying the token is refused without repeating it', async () => {
    const e = await h.api.expectError(422, 'INVALID_REQUEST', 'POST', '/v1/package-sources', { url: `https://x-access-token:${TOKEN}@github.com/carlos/private-notes`, token: TOKEN });
    expect(JSON.stringify(e)).not.toContain(TOKEN);
  });

  it('adds with the token: the fetch carried it, the source says hasToken and nothing more', async () => {
    const r = await h.api.expect<AddSourceResult>(201, 'POST', '/v1/package-sources', { url: REPO, token: TOKEN });
    source = r.source;
    expect(source.packageId).toBe('private-notes');
    expect(source.hasToken).toBe(true);
    expect(h.git.authSeen.at(-1)).toEqual({ url: REPO, header: gitAuthHeader(TOKEN) });
    for (const f of forms(TOKEN)) expect(JSON.stringify(r)).not.toContain(f);
    // a public source reports hasToken false
    h.git.setRepo('https://github.com/carlos/public-notes', 'main', [{ commit: 'f'.repeat(40), committerDateUnix: 1_760_100_000, files: { ...files('pub'), 'harbor/manifest.yaml': MANIFEST.replace('id: private-notes', 'id: public-notes').replace('name: Private Notes', 'name: Public Notes') } }]);
    const pub = await h.api.expect<AddSourceResult>(201, 'POST', '/v1/package-sources', { url: 'https://github.com/carlos/public-notes' });
    expect(pub.source.hasToken).toBe(false);
    expect(h.git.authSeen.at(-1)).toEqual({ url: 'https://github.com/carlos/public-notes', header: null });
    await h.api.expect(204, 'DELETE', `/v1/package-sources/${pub.source.id}`);
  });

  it('installs, then a new commit is noticed and redeployed on commit, every fetch with the token', async () => {
    const r = await h.api.run({ kind: 'install', packageId: 'private-notes' });
    expect(r.op.state, JSON.stringify(r.op.error)).toBe('succeeded');
    inst = (await byName('private-notes'))!;
    await h.api.expect(200, 'PUT', `/v1/package-sources/${source.id}/auto-redeploy`, { enabled: true });
    const seenBefore = h.git.authSeen.length;
    h.git.push(REPO, { commit: 'b'.repeat(40), committerDateUnix: 1_760_100_500, files: files('v2') });
    await waitFor(async () => {
      const i = (await byName('private-notes'))!;
      return i.revision === '1.1760100500' && i.installState === 'installed';
    });
    expect(h.fake.builtTags).toContain(`harbor-src/private-notes-web:${'b'.repeat(12)}`);
    const calls = h.git.authSeen.slice(seenBefore).filter((c) => c.url === REPO);
    expect(calls.length).toBeGreaterThanOrEqual(2); // ls-remote + clone
    expect(calls.every((c) => c.header === gitAuthHeader(TOKEN))).toBe(true);
  });

  it('an expired token: the check fails by name, the source and the bell say so once, the app keeps running', async () => {
    h.git.setToken(REPO, ROTATED); // the host no longer accepts TOKEN
    const e = await h.api.expectError(422, 'SOURCE_REFUSED', 'POST', `/v1/package-sources/${source.id}/check`, {});
    expect(e.error.message).toBe('the repository refused the token');
    await waitFor(async () => (await h.api.expect<{ items: { kind: string; title: string; body: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'source-refused'));
    const s = (await sources())[0]!;
    expect(s.note).toBe('the repository refused the token');
    expect((await byName('private-notes'))!.installState).toBe('installed');
    const n = (await h.api.expect<{ items: { kind: string; body: string }[] }>(200, 'GET', '/v1/notifications')).items.filter((x) => x.kind === 'source-refused');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toMatch(/harbor sources token private-notes --token-stdin/);
    // dismissed, it stays dismissed while the token stays refused (no new row, nothing re-sent to channels)
    await h.api.expect(200, 'DELETE', `/v1/notifications/${(n[0] as unknown as { id: string }).id}`);
    await h.api.expectError(422, 'SOURCE_REFUSED', 'POST', `/v1/package-sources/${source.id}/check`, {});
    await new Promise((r) => setTimeout(r, 1600)); // two poller passes
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((x) => x.kind === 'source-refused')).toBe(false);
  });

  it('replacing the token: a refused one is not stored; the right one clears the note and the bell', async () => {
    await h.api.expectError(422, 'SOURCE_REFUSED', 'PUT', `/v1/package-sources/${source.id}/token`, { token: WRONG });
    const s = await h.api.expect<PackageSourceDto>(200, 'PUT', `/v1/package-sources/${source.id}/token`, { token: ROTATED });
    expect(s.hasToken).toBe(true);
    expect(s.note).toBeNull();
    expect((await h.api.expect<{ items: { kind: string }[] }>(200, 'GET', '/v1/notifications')).items.some((n) => n.kind === 'source-refused')).toBe(false);
    // later checks use the new token
    await h.api.expect(200, 'POST', `/v1/package-sources/${source.id}/check`, {});
    expect(h.git.authSeen.at(-1)).toEqual({ url: REPO, header: gitAuthHeader(ROTATED) });
    // the log says what happened, never with what
    const logs = JSON.stringify(await h.api.expect(200, 'GET', '/v1/logs/harbor?lines=2000'));
    expect(logs).toMatch(/git source added/);
    expect(logs).toMatch(/git source token replaced/);
    for (const t of [TOKEN, ROTATED, WRONG]) for (const f of forms(t)) expect(logs).not.toContain(f);
  });

  it('after a restart (no login yet) the poller waits quietly; a manual check asks for the unlock; after login it works', async () => {
    await h.restart({ login: false });
    const before = h.git.authSeen.length;
    await new Promise((r) => setTimeout(r, 1800)); // two poller passes (sourceCheckMs 700)
    expect(h.git.authSeen.slice(before).filter((c) => c.url === REPO)).toEqual([]);
    expect((await sources())[0]!.note).toBeNull();
    await h.api.expectError(409, 'MACHINE_KEY_LOCKED', 'POST', `/v1/package-sources/${source.id}/check`, {});
    await h.api.expect(200, 'POST', '/v1/account/unlock', { password: ADMIN.password });
    await h.api.expect(200, 'POST', `/v1/package-sources/${source.id}/check`, {});
    expect(h.git.authSeen.at(-1)).toEqual({ url: REPO, header: gitAuthHeader(ROTATED) });
  });

  it('no form of any token is anywhere: API lists, operations, events, notifications, logs, or the state folder', async () => {
    const texts = [
      JSON.stringify(await sources()),
      JSON.stringify(await h.api.instances()),
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/instances/${inst.id}`)),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/operations')),
      JSON.stringify(await h.api.expect(200, 'GET', `/v1/operations/${(await byName('private-notes'))!.operationId}`)),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/notifications')),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/logs/harbor?lines=2000')),
      JSON.stringify(await h.api.expect(200, 'GET', '/v1/system/diagnostics')),
      ...allFiles(h.stateDir).map((f) => readFileSync(f).toString('latin1')),
    ];
    for (const t of [TOKEN, ROTATED, WRONG]) for (const f of forms(t)) for (const text of texts) expect(text).not.toContain(f);
    // the log buffer (reset by the restart) holds real source lines, so the check above read something
    expect(JSON.stringify(await h.api.expect(200, 'GET', '/v1/logs/harbor?lines=2000'))).toMatch(/waits for a login/);
  });

  it('removing the token, then the source: the wrapped token goes with it', async () => {
    const s = await h.api.expect<PackageSourceDto>(200, 'DELETE', `/v1/package-sources/${source.id}/token`);
    expect(s.hasToken).toBe(false);
    await h.api.expectError(422, 'SOURCE_REFUSED', 'POST', `/v1/package-sources/${source.id}/check`, {});
    await h.api.expect(200, 'PUT', `/v1/package-sources/${source.id}/token`, { token: ROTATED });
    expect(h.daemon.ctx.repo.setting<Record<string, unknown>>('sources.tokens')).toHaveProperty(source.id);
    await h.api.expect(204, 'DELETE', `/v1/package-sources/${source.id}`);
    expect(h.daemon.ctx.repo.setting('sources.tokens')).toBeNull();
    expect(await sources()).toEqual([]);
    expect((await byName('private-notes'))!.installState).toBe('installed');
  });
  it('the CLI takes the token from stdin only, shows that one is stored, replaces and clears it', async () => {
    const cliDir = mkdtempSync(path.join(tmpdir(), 'harbor-cli-'));
    writeFileSync(path.join(cliDir, 'cli.json'), JSON.stringify({ url: h.baseUrl, token: h.api.token }));
    const cli = (args: string[], stdin = '') =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const c = spawn(process.execPath, ['--import', TSX, path.join(ROOT, 'src', 'cli', 'main.ts'), ...args], { cwd: ROOT, env: { ...process.env, HARBOR_CLI_CONFIG_DIR: cliDir, HARBOR_URL: h.baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        c.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        c.on('close', (code) => resolve({ code, stdout, stderr }));
        c.stdin.end(stdin);
      });
    const url = 'https://github.com/carlos/cli-notes';
    h.git.setRepo(url, 'main', [{ commit: 'c'.repeat(40), committerDateUnix: 1_760_200_000, files: { ...files('cli'), 'harbor/manifest.yaml': MANIFEST.replace('id: private-notes', 'id: cli-notes').replace('name: Private Notes', 'name: CLI Notes') } }], { token: TOKEN });
    const refused = await cli(['sources', 'add', url]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toMatch(/asked for a sign-in/);
    const added = await cli(['sources', 'add', url, '--token-stdin'], `${TOKEN}\n`);
    expect(added.code, added.stderr).toBe(0);
    const list = await cli(['sources']);
    expect(list.stdout).toMatch(/cli-notes.*stored/);
    h.git.setToken(url, ROTATED);
    const wrong = await cli(['sources', 'token', 'cli-notes', '--token-stdin'], WRONG);
    expect(wrong.code).toBe(5);
    expect(wrong.stderr).toMatch(/refused the token/);
    const replaced = await cli(['sources', 'token', 'cli-notes', '--token-stdin'], ROTATED);
    expect(replaced.code, replaced.stderr).toBe(0);
    const cleared = await cli(['sources', 'token', 'cli-notes', '--clear']);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect((await sources()).find((x) => x.packageId === 'cli-notes')!.hasToken).toBe(false);
    const removed = await cli(['sources', 'remove', 'cli-notes']);
    expect(removed.code, removed.stderr).toBe(0);
    for (const t of [TOKEN, ROTATED, WRONG]) for (const r of [refused, added, list, wrong, replaced, cleared, removed]) expect(r.stdout + r.stderr).not.toContain(t);
  });
});
