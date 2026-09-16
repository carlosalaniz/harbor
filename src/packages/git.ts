import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarborError } from '../errors.js';

// Git package sources (decision 80): fetch a repository at a branch head (or exact commit)
// over HTTPS and hand the tree to the package pipeline. Public repos; shallow clones; the
// `git` binary does the transport (installed by bootstrap). No shell — argv arrays only.

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

export interface GitFetcher {
  readonly description: string;
  head(url: string, ref: string): Promise<GitHead>;
  fetch(url: string, ref: string, opts?: { commit?: string }): Promise<GitTree>;
}

const URL_RE = /^https:\/\/[a-z0-9.-]+\/[^\s]{1,300}$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

export function validateGitSourceInput(url: string, ref: string, subpath: string | null): void {
  if (!URL_RE.test(url)) throw new HarborError('INVALID_REQUEST', 'the repository URL must be https://…', { nextAction: 'Use the HTTPS clone URL, for example https://github.com/you/your-app.' });
  if (!REF_RE.test(ref)) throw new HarborError('INVALID_REQUEST', `invalid branch name ${ref}`);
  if (subpath !== null && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(subpath) || subpath.split('/').some((p) => p === '..' || p === ''))) {
    throw new HarborError('INVALID_REQUEST', 'the path inside the repository must be a simple relative folder');
  }
}

function git(args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() },
      },
      (err, stdout, stderr) => {
        if (err) reject(new HarborError('OPERATION_FAILED', `git ${args[0]} failed: ${String(stderr || err.message).slice(0, 400)}`, { nextAction: 'Check the URL and branch, and that this machine can reach the repository (public repositories only).' }));
        else resolve({ stdout: String(stdout) });
      },
    );
  });
}

export class GitCli implements GitFetcher {
  readonly description = 'git (https, shallow)';
  async head(url: string, ref: string): Promise<GitHead> {
    const ls = await git(['ls-remote', url, `refs/heads/${ref}`], { timeoutMs: 30_000 });
    const line = ls.stdout.split('\n').find((l) => l.trim());
    const commit = line?.split(/\s+/)[0];
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    // committer date requires the object: resolved during fetch; head() returns 0 and fetch fills it in
    return { commit, committerDateUnix: 0 };
  }
  async fetch(url: string, ref: string, opts: { commit?: string } = {}): Promise<GitTree> {
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-git-'));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    try {
      await git(['clone', '--depth', '50', '--branch', ref, '--single-branch', '--no-tags', url, 'repo'], { cwd: dir, timeoutMs: 120_000 });
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

// In-memory fake: repositories are maps of file trees per commit on one branch.
export class FakeGit implements GitFetcher {
  readonly description = 'fake git (in-memory)';
  private repos = new Map<string, { ref: string; commits: { commit: string; committerDateUnix: number; files: Record<string, string | Buffer> }[] }>();
  calls: string[] = [];
  setRepo(url: string, ref: string, commits: { commit: string; committerDateUnix: number; files: Record<string, string | Buffer> }[]): void {
    this.repos.set(url, { ref, commits });
  }
  push(url: string, commit: { commit: string; committerDateUnix: number; files: Record<string, string | Buffer> }): void {
    const r = this.repos.get(url);
    if (!r) throw new Error(`fake git: no repo ${url}`);
    r.commits.push(commit);
  }
  async head(url: string, ref: string): Promise<GitHead> {
    this.calls.push(`head ${url} ${ref}`);
    const r = this.repos.get(url);
    if (!r || r.ref !== ref || r.commits.length === 0) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    const last = r.commits[r.commits.length - 1]!;
    return { commit: last.commit, committerDateUnix: last.committerDateUnix };
  }
  async fetch(url: string, ref: string, opts: { commit?: string } = {}): Promise<GitTree> {
    this.calls.push(`fetch ${url} ${ref} ${opts.commit ?? 'HEAD'}`);
    const r = this.repos.get(url);
    if (!r || r.ref !== ref) throw new HarborError('NOT_FOUND', `branch ${ref} not found at ${url}`);
    const c = opts.commit ? r.commits.find((x) => x.commit === opts.commit) : r.commits[r.commits.length - 1];
    if (!c) throw new HarborError('NOT_FOUND', `commit ${opts.commit} not found at ${url}`);
    const dir = mkdtempSync(path.join(tmpdir(), 'harbor-fakegit-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    for (const [file, content] of Object.entries(c.files)) {
      const p = path.join(dir, file);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    return { commit: c.commit, committerDateUnix: c.committerDateUnix, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
}

// Read a fetched tree's package directory (<subpath>/harbor/) into the file map the import pipeline eats.
export function readPackageTree(tree: GitTree, subpath: string | null): Map<string, Buffer> {
  const base = subpath ? path.join(tree.dir, subpath) : tree.dir;
  const pkgDir = path.join(base, 'harbor');
  const st = statSync(pkgDir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new HarborError('INVALID_PACKAGE', `the repository has no harbor/ folder${subpath ? ` under ${subpath}` : ''}`, { nextAction: 'A Harbor app repository keeps manifest.yaml and compose.yaml in a harbor/ folder. See docs/DEVELOPER_PACKAGES.md.' });
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(pkgDir)) {
    const p = path.join(pkgDir, name);
    if (!statSync(p).isFile()) continue;
    if (files.size >= 64) throw new HarborError('INVALID_PACKAGE', 'too many files in harbor/');
    const b = readFileSync(p);
    if (b.length > 4 * 1024 * 1024) throw new HarborError('INVALID_PACKAGE', `${name} is too large`);
    files.set(name, b);
  }
  return files;
}
