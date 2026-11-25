import { execFile } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarborError } from '../errors.js';

// Git package sources (decision 80): fetch a repository at a branch head (or exact commit)
// over HTTPS and hand the tree to the package pipeline. Shallow clones; the `git` binary does
// the transport (installed by bootstrap). No shell — argv arrays only.
//
// Private repositories (decision 211): an optional access token rides each git command as an HTTP
// Authorization header set through GIT_CONFIG_COUNT/KEY/VALUE environment variables — never argv
// (/proc/<pid>/cmdline is world-readable), never the URL, never a config file on disk. The header is
// scoped to the repository's origin (`http.<origin>/.extraHeader`). Failures that mean "the repository
// wants a sign-in" or "refused this token" become SOURCE_REFUSED with a next action, and the token
// (and its encoded header form) is scrubbed from every message git produces.

export interface GitHead {
  commit: string;
  committerDateUnix: number;
}

export interface GitTree {
  commit: string;
  committerDateUnix: number;
  // repository root on disk; valid until cleanup() — callers copy what they keep
  dir: string;
  cleanup: () => void;
}

// An access token for one command. Basic auth with the conventional `x-access-token` user: GitHub (classic and
// fine-grained tokens), GitLab and Gitea accept a token as the password with any user name.
export interface GitAuth {
  token: string;
}

export interface GitFetcher {
  readonly description: string;
  head(url: string, ref: string, auth?: GitAuth): Promise<GitHead>;
  fetch(url: string, ref: string, opts?: { commit?: string; auth?: GitAuth }): Promise<GitTree>;
}

const URL_RE = /^https:\/\/[a-z0-9.-]+\/[^\s]{1,300}$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
// Printable ASCII without spaces: every real token format (GitHub ghp_/github_pat_, GitLab glpat-, Gitea hex).
// Also what keeps the header line from carrying a CR/LF.
const TOKEN_RE = /^[\x21-\x7e]{8,1024}$/;
export const GIT_TOKEN_USER = 'x-access-token';

export function validateGitSourceInput(url: string, ref: string, subpath: string | null): void {
  // a URL with user:token@ is refused WITHOUT echoing it: that is exactly the text that must not reach a log
  if (/^https?:\/\/[^/]*@/i.test(url)) {
    throw new HarborError('INVALID_REQUEST', 'the repository URL carries a user name or token', { nextAction: 'Use the plain HTTPS clone URL and give the token separately (harbor sources add <url> --token-stdin, or the Access token field).' });
  }
  if (!URL_RE.test(url)) throw new HarborError('INVALID_REQUEST', 'the repository URL must be https://…', { nextAction: 'Use the HTTPS clone URL, for example https://github.com/you/your-app.' });
  if (!REF_RE.test(ref)) throw new HarborError('INVALID_REQUEST', `invalid branch name ${ref}`);
  if (subpath !== null && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(subpath) || subpath.split('/').some((p) => p === '..' || p === ''))) {
    throw new HarborError('INVALID_REQUEST', 'the path inside the repository must be a simple relative folder');
  }
}

export function validateGitToken(token: string): void {
  if (!TOKEN_RE.test(token)) throw new HarborError('INVALID_REQUEST', 'the access token must be 8–1024 printable characters without spaces', { nextAction: 'Paste the token exactly as the Git host shows it.' });
}

/** The header value git sends: `Basic base64(x-access-token:<token>)`. */
export function gitAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`${GIT_TOKEN_USER}:${token}`, 'utf8').toString('base64')}`;
}

/**
 * The environment one git command runs with. Config entries come through GIT_CONFIG_COUNT (git ≥ 2.31):
 * the credential helper list is emptied (no keychain, no stored login answers for Harbor), and with a token
 * the Authorization header is set for the repository's origin only.
 */
export function gitEnv(url: string | null, auth: GitAuth | undefined, base: { PATH?: string; HOME: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: base.PATH ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: base.HOME, GIT_ASKPASS: '', SSH_ASKPASS: '' };
  const config: [string, string][] = [['credential.helper', '']];
  if (auth && url) config.push([`http.${new URL(url).origin}/.extraHeader`, `Authorization: ${gitAuthHeader(auth.token)}`]);
  env['GIT_CONFIG_COUNT'] = String(config.length);
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Remove the token, its header form and any user:secret@ from text git (or Node) produced. */
export function redactGitText(text: string, auth: GitAuth | undefined): string {
  let out = text.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1');
  if (auth?.token) {
    const header = gitAuthHeader(auth.token);
    for (const secret of [header, header.slice('Basic '.length), auth.token]) out = out.split(secret).join('[redacted]');
  }
  return out;
}

// What a refused sign-in looks like on stderr: GitHub/GitLab/Gitea/Bitbucket over smart HTTP, with prompts off.
const AUTH_FAILED_RE = /could not read (Username|Password)|terminal prompts disabled|Authentication failed|HTTP Basic: Access denied|Invalid username or (password|token)|returned error: 40[13]|\b40[13]\b.*(Unauthorized|Forbidden)/i;
// GitHub answers "Repository not found" (404) when an authenticated caller cannot see a private repository.
const NOT_VISIBLE_RE = /Repository not found|returned error: 404|repository '.*' not found/i;

/** A failed git command as a Harbor error: a named refusal when the repository wanted a sign-in, else the (redacted) stderr. */
export function gitFailure(command: string, stderr: string, auth: GitAuth | undefined): HarborError {
  const clean = redactGitText(stderr, auth);
  if (auth && (AUTH_FAILED_RE.test(clean) || NOT_VISIBLE_RE.test(clean))) return sourceRefused(true);
  if (!auth && AUTH_FAILED_RE.test(clean)) return sourceRefused(false);
  if (!auth && NOT_VISIBLE_RE.test(clean)) return new HarborError('NOT_FOUND', 'the repository was not found', { nextAction: 'Check the URL. If the repository is private, add it with an access token (harbor sources add <url> --token-stdin, or the Access token field).' });
  return new HarborError('OPERATION_FAILED', `git ${command} failed: ${clean.slice(0, 400)}`, { nextAction: 'Check the URL and branch, and that this machine can reach the repository.' });
}

export function sourceRefused(withToken: boolean): HarborError {
  return withToken
    ? new HarborError('SOURCE_REFUSED', 'the repository refused the token', { nextAction: 'The token may have expired, been revoked, or not cover this repository. Make a new one that can read it (GitHub: a fine-grained token for this one repository with Contents: read-only), then replace it: harbor sources token <app> --token-stdin, or App Store → Your repositories → Token.' })
    : new HarborError('SOURCE_REFUSED', 'the repository asked for a sign-in: it is private, or it does not exist', { nextAction: 'Check the URL. For a private repository, add an access token that can read it (harbor sources add <url> --token-stdin, or the Access token field; GitHub: a fine-grained token for this one repository with Contents: read-only).' });
}

function git(args: string[], opts: { cwd?: string; timeoutMs: number; url?: string; auth?: GitAuth }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: gitEnv(opts.url ?? null, opts.auth, { ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}), HOME: tmpdir() }),
      },
      (err, stdout, stderr) => {
        if (err) reject(gitFailure(args[0]!, String(stderr || err.message), opts.auth));
        else resolve({ stdout: String(stdout) });
      },
    );
  });
}

export class GitCli implements GitFetcher {
  readonly description = 'git (https, shallow)';
  async head(url: string, ref: string, auth?: GitAuth): Promise<GitHead> {
    const ls = await git(['ls-remote', url, `refs/heads/${ref}`], { timeoutMs: 30_000, url, ...(auth ? { auth } : {}) });
    const line = ls.stdout.split('\n').find((l) => l.trim());
    const commit = line?.split(/\s+/)[0];
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    // committer date requires the object: resolved during fetch; head() returns 0 and fetch fills it in
    return { commit, committerDateUnix: 0 };
  }
  async fetch(url: string, ref: string, opts: { commit?: string; auth?: GitAuth } = {}): Promise<GitTree> {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-git-'));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      await git(['clone', '--depth', '50', '--branch', ref, '--single-branch', '--no-tags', url, 'repo'], { cwd: dir, timeoutMs: 120_000, url, ...(opts.auth ? { auth: opts.auth } : {}) });
      const repo = path.join(dir, 'repo');
      let commit = opts.commit;
      if (commit) {
        await git(['checkout', '--detach', commit], { cwd: repo, timeoutMs: 30_000 });
      } else {
        commit = (await git(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
      }
      const dateOut = (await git(['show', '-s', '--format=%ct', commit], { cwd: repo, timeoutMs: 10_000 })).stdout.trim();
      const committerDateUnix = Number(dateOut);
      if (!Number.isFinite(committerDateUnix) || committerDateUnix <= 0) throw new HarborError('OPERATION_FAILED', 'could not read the commit date');
      rmSync(path.join(repo, '.git'), { recursive: true, force: true });
      return { commit, committerDateUnix, dir: repo, cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }
}

// In-memory fake: repositories are maps of file trees per commit on one branch. A repository set up with a
// `token` is private: it answers like a Git host would (sign-in wanted, or the token refused) unless that token comes.
type FakeCommit = { commit: string; committerDateUnix: number; files: Record<string, string | Buffer> };
export class FakeGit implements GitFetcher {
  readonly description = 'fake git (in-memory)';
  private repos = new Map<string, { ref: string; commits: FakeCommit[]; token?: string }>();
  calls: string[] = [];
  // the header each call would have sent (null = none): tests check the token went where it should, and only there
  authSeen: { url: string; header: string | null }[] = [];
  setRepo(url: string, ref: string, commits: FakeCommit[], opts: { token?: string } = {}): void {
    this.repos.set(url, { ref, commits, ...(opts.token ? { token: opts.token } : {}) });
  }
  setToken(url: string, token: string | null): void {
    const r = this.repos.get(url);
    if (!r) throw new Error(`fake git: no repo ${url}`);
    if (token) r.token = token;
    else delete r.token;
  }
  push(url: string, commit: FakeCommit): void {
    const r = this.repos.get(url);
    if (!r) throw new Error(`fake git: no repo ${url}`);
    r.commits.push(commit);
  }
  private open(url: string, auth: GitAuth | undefined) {
    this.authSeen.push({ url, header: auth ? gitAuthHeader(auth.token) : null });
    const r = this.repos.get(url);
    if (r?.token && auth?.token !== r.token) throw auth ? sourceRefused(true) : sourceRefused(false);
    return r;
  }
  async head(url: string, ref: string, auth?: GitAuth): Promise<GitHead> {
    this.calls.push(`head ${url} ${ref}`);
    const r = this.open(url, auth);
    if (!r || r.ref !== ref || r.commits.length === 0) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    const last = r.commits[r.commits.length - 1]!;
    return { commit: last.commit, committerDateUnix: last.committerDateUnix };
  }
  async fetch(url: string, ref: string, opts: { commit?: string; auth?: GitAuth } = {}): Promise<GitTree> {
    this.calls.push(`fetch ${url} ${ref} ${opts.commit ?? 'HEAD'}`);
    const r = this.open(url, opts.auth);
    if (!r || r.ref !== ref) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    const c = opts.commit ? r.commits.find((x) => x.commit === opts.commit) : r.commits[r.commits.length - 1];
    if (!c) throw new HarborError('NOT_FOUND', `commit ${opts.commit} not found at ${url}`);
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-fakegit-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    for (const [file, content] of Object.entries(c.files)) {
      const p = path.join(dir, file);
      // like the real daemon (UMask=0077): the clone is owner-only until the import normalises it
      mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, content, { mode: 0o600 });
    }
    return { commit: c.commit, committerDateUnix: c.committerDateUnix, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
}

// Read a fetched tree's package directory (<subpath>/harbor/) into the file map the import pipeline eats.
export function readPackageTree(tree: GitTree, subpath: string | null): Map<string, Buffer> {
  const base = subpath ? path.join(tree.dir, subpath) : tree.dir;
  const pkgDir = path.join(base, 'harbor');
  // lstat (decision 165): neither harbor/ nor a file in it may be a link (it could read any host file into the package).
  const st = lstatSync(pkgDir, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) throw new HarborError('INVALID_PACKAGE', 'harbor/ is a symbolic link', { nextAction: 'Keep manifest.yaml and compose.yaml in a real harbor/ folder.' });
  if (!st?.isDirectory()) throw new HarborError('INVALID_PACKAGE', `the repository has no harbor/ folder${subpath ? ` under ${subpath}` : ''}`, { nextAction: 'A Harbor app repository keeps manifest.yaml and compose.yaml in a harbor/ folder. See docs/DEVELOPER_PACKAGES.md.' });
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(pkgDir)) {
    const p = path.join(pkgDir, name);
    const fst = lstatSync(p);
    if (fst.isSymbolicLink()) throw new HarborError('INVALID_PACKAGE', `harbor/${name} is a symbolic link`, { nextAction: 'Package files must be real files.' });
    if (!fst.isFile()) continue;
    if (files.size >= 64) throw new HarborError('INVALID_PACKAGE', 'too many files in harbor/');
    const b = readFileSync(p);
    if (b.length > 4 * 1024 * 1024) throw new HarborError('INVALID_PACKAGE', `${name} is too large`);
    files.set(name, b);
  }
  return files;
}
