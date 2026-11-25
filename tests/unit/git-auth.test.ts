import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HarborError } from '../../src/errors.js';
import { FakeGit, GitCli, gitAuthHeader, gitEnv, gitFailure, redactGitText, validateGitSourceInput, validateGitToken } from '../../src/packages/git.js';

// Decision 211: private git sources. The token rides an Authorization header set through GIT_CONFIG_* env vars.
const TOKEN = 'tok-FIXTURE-private-0123456789';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('git env (decision 211)', () => {
  it('without a token: prompts off, no credential helper, no header', () => {
    const env = gitEnv('https://github.com/me/app', undefined, { HOME: '/tmp/x' });
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: '/tmp/x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
    expect(JSON.stringify(env)).not.toMatch(/Authorization/);
  });

  it('with a token: a Basic header scoped to the repository origin, in env values only', () => {
    const env = gitEnv('https://github.com/me/app', { token: TOKEN }, { HOME: '/tmp/x' });
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
    expect(env['GIT_CONFIG_KEY_1']).toBe('http.https://github.com/.extraHeader');
    expect(env['GIT_CONFIG_VALUE_1']).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
    // the clear token appears nowhere: not in a key, not in a value
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });
});

describe('git text and failures (decision 211)', () => {
  it('redacts the token, its header form and URL credentials', () => {
    const header = gitAuthHeader(TOKEN);
    const text = `token ${TOKEN} header ${header} b64 ${header.slice(6)} url https://x-access-token:${TOKEN}@github.com/me/app and https://user:pw@host/x`;
    const out = redactGitText(text, { token: TOKEN });
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(header.slice(6));
    expect(out).not.toContain('user:pw');
    expect(out).toContain('https://github.com/me/app');
  });

  it('a refused sign-in is SOURCE_REFUSED, named by whether a token was sent', () => {
    const prompt = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    const withToken = gitFailure('ls-remote', prompt, { token: TOKEN });
    expect(withToken).toBeInstanceOf(HarborError);
    expect(withToken.code).toBe('SOURCE_REFUSED');
    expect(withToken.message).toBe('the repository refused the token');
    expect(withToken.nextAction).toMatch(/Contents: read-only/);
    const without = gitFailure('ls-remote', prompt, undefined);
    expect(without.code).toBe('SOURCE_REFUSED');
    expect(without.message).toMatch(/asked for a sign-in/);
    // GitHub answers "not found" when a token cannot see a private repository
    expect(gitFailure('clone', "remote: Repository not found.\nfatal: repository 'https://github.com/me/app/' not found", { token: TOKEN }).message).toBe('the repository refused the token');
    expect(gitFailure('clone', "remote: Repository not found.\nfatal: repository 'https://github.com/me/app/' not found", undefined).code).toBe('NOT_FOUND');
    expect(gitFailure('clone', 'remote: HTTP Basic: Access denied', { token: TOKEN }).code).toBe('SOURCE_REFUSED');
  });

  it('any other failure keeps git stderr, scrubbed', () => {
    const e = gitFailure('clone', `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/me/app/': Could not resolve host: github.com`, { token: TOKEN });
    expect(e.code).toBe('OPERATION_FAILED');
    expect(e.message).toMatch(/Could not resolve host/);
    expect(e.message).not.toContain(TOKEN);
  });

  it('a URL that carries credentials is refused without echoing them', () => {
    const fn = () => validateGitSourceInput(`https://x-access-token:${TOKEN}@github.com/me/app`, 'main', null);
    expect(fn).toThrow(/carries a user name or token/);
    try {
      fn();
    } catch (e) {
      expect(JSON.stringify({ m: (e as HarborError).message, n: (e as HarborError).nextAction })).not.toContain(TOKEN);
    }
  });

  it('tokens are printable, no spaces or line breaks (the header line stays one line)', () => {
    expect(() => validateGitToken(TOKEN)).not.toThrow();
    expect(() => validateGitToken('short')).toThrow(/8–1024/);
    expect(() => validateGitToken(`${TOKEN}\r\nX-Evil: 1`)).toThrow();
    expect(() => validateGitToken(`${TOKEN} x`)).toThrow();
  });
});

describe('FakeGit private repositories', () => {
  it('answers like a Git host: sign-in wanted without a token, refused with the wrong one', async () => {
    const g = new FakeGit();
    g.setRepo('https://github.com/me/private', 'main', [{ commit: COMMIT, committerDateUnix: 1_760_000_000, files: {} }], { token: TOKEN });
    await expect(g.head('https://github.com/me/private', 'main')).rejects.toMatchObject({ code: 'SOURCE_REFUSED', message: expect.stringMatching(/sign-in/) });
    await expect(g.head('https://github.com/me/private', 'main', { token: 'tok-FIXTURE-wrong-000' })).rejects.toMatchObject({ code: 'SOURCE_REFUSED', message: 'the repository refused the token' });
    expect((await g.head('https://github.com/me/private', 'main', { token: TOKEN })).commit).toBe(COMMIT);
    expect(g.authSeen.at(-1)).toEqual({ url: 'https://github.com/me/private', header: gitAuthHeader(TOKEN) });
  });
});

// The real git binary: proves the env-config header reaches the server, and that failures are named and scrubbed.
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

describe.skipIf(!gitAvailable)('GitCli against a local HTTP server (real git)', () => {
  let server: Server;
  let base: string;
  const seen: (string | undefined)[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (req.headers.authorization !== gitAuthHeader(TOKEN)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
        return res.end('auth required');
      }
      if (req.url?.startsWith('/me/private/info/refs')) {
        // dumb-protocol ref list: enough for ls-remote
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${COMMIT}\trefs/heads/main\n`);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise<void>((r) => server.close(() => r())));

  it('ls-remote with the token reads the branch; the server saw the Basic header', async () => {
    const head = await new GitCli().head(`${base}/me/private`, 'main', { token: TOKEN });
    expect(head.commit).toBe(COMMIT);
    expect(seen).toContain(gitAuthHeader(TOKEN));
  });

  it('a wrong token is "the repository refused the token", and no form of it is in the error', async () => {
    const wrong = 'tok-FIXTURE-expired-9876543210';
    const e = await new GitCli().head(`${base}/me/private`, 'main', { token: wrong }).catch((x: unknown) => x as HarborError);
    expect(e).toBeInstanceOf(HarborError);
    expect((e as HarborError).code).toBe('SOURCE_REFUSED');
    expect((e as HarborError).message).toBe('the repository refused the token');
    const all = JSON.stringify({ m: (e as HarborError).message, n: (e as HarborError).nextAction, d: (e as HarborError).details });
    expect(all).not.toContain(wrong);
    expect(all).not.toContain(gitAuthHeader(wrong).slice(6));
  });

  it('no token on a private repository is "asked for a sign-in", sent without any header', async () => {
    const before = seen.length;
    const e = await new GitCli().head(`${base}/me/private`, 'main').catch((x: unknown) => x as HarborError);
    expect((e as HarborError).code).toBe('SOURCE_REFUSED');
    expect((e as HarborError).message).toMatch(/asked for a sign-in/);
    expect(seen.slice(before).every((h) => h === undefined)).toBe(true);
  });
});
