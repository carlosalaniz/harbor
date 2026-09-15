import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SelfUpdateStatusDto } from '../contracts/api.js';
import { HarborError } from '../errors.js';
import type { Logger } from '../lifecycle/context.js';
import { rfc3339, type Clock } from '../util.js';
import type { Fetcher } from '../appearance/fetcher.js';
import { spawn } from 'node:child_process';

// Harbor updating itself. The daemon (unprivileged) only checks GitHub Releases and asks systemd to start
// a root oneshot (`harbor-self-update@<version>.service`, allowed by the polkit rule bootstrap installs);
// that unit runs `harbor self-update apply`, which downloads the release itself, verifies SHA256SUMS,
// extracts it and runs the new release's `bootstrap --yes` (the same in-place upgrade an operator would do).
// Progress is written to <stateDir>/updates/status.json by the root step so it survives the daemon restart.

export interface ReleaseInfo {
  version: string; // "0.8.0"
  tag: string; // "v0.8.0"
  publishedAt: string | null;
  notes: string | null;
  url: string | null; // release page
  archiveUrl: string | null;
  sumsUrl: string | null;
}
export interface ReleaseFeed {
  latest(): Promise<ReleaseInfo | null>;
}

// "1.2.3" style; suffixes like "-mvp" sort before the plain version.
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('-');
  const pb = b.replace(/^v/, '').split('-');
  const na = pa[0]!.split('.').map(Number);
  const nb = pb[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if ((pa[1] ?? '') === (pb[1] ?? '')) return 0;
  if (!pa[1]) return 1;
  if (!pb[1]) return -1;
  return pa[1]! < pb[1]! ? -1 : 1;
}

export function archiveName(version: string): string {
  return `harbor-${version}-linux-x64.tar.gz`;
}

export class GitHubReleaseFeed implements ReleaseFeed {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly repo: string,
  ) {}
  async latest(): Promise<ReleaseInfo | null> {
    const r = await this.fetcher.fetch(`https://api.github.com/repos/${this.repo}/releases?per_page=10`, { headers: { accept: 'application/vnd.github+json' }, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 });
    if (r.status !== 200) throw new Error(`GitHub answered HTTP ${r.status} for ${this.repo} releases`);
    const list = JSON.parse(r.body.toString('utf8')) as { tag_name?: string; draft?: boolean; prerelease?: boolean; published_at?: string; body?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] }[];
    const candidates = list.filter((x) => x.tag_name && !x.draft && !x.prerelease && /^v\d+\.\d+\.\d+$/.test(x.tag_name)).sort((a, b) => compareVersions(b.tag_name!, a.tag_name!));
    const top = candidates[0];
    if (!top) return null;
    const version = top.tag_name!.slice(1);
    const asset = (n: string) => top.assets?.find((a) => a.name === n)?.browser_download_url ?? null;
    return { version, tag: top.tag_name!, publishedAt: top.published_at ?? null, notes: top.body?.trim() || null, url: top.html_url ?? null, archiveUrl: asset(archiveName(version)), sumsUrl: asset('SHA256SUMS') };
  }
}

export class FakeReleaseFeed implements ReleaseFeed {
  info: ReleaseInfo | null = null;
  error: string | null = null;
  calls = 0;
  async latest(): Promise<ReleaseInfo | null> {
    this.calls += 1;
    if (this.error) throw new Error(this.error);
    return this.info;
  }
}

// Starting the root oneshot: `systemctl start harbor-self-update@<version>.service` (no root needed: polkit).
export interface UnitStarter {
  start(unit: string): Promise<void>;
}
export class SystemctlStarter implements UnitStarter {
  async start(unit: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/systemctl', ['start', '--no-block', unit], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `systemctl exited ${code}`))));
    });
  }
}
export class FakeUnitStarter implements UnitStarter {
  started: string[] = [];
  fail: string | null = null;
  onStart: ((unit: string) => void) | null = null;
  async start(unit: string): Promise<void> {
    if (this.fail) throw new Error(this.fail);
    this.started.push(unit);
    this.onStart?.(unit);
  }
}

export type ApplyStatus = NonNullable<SelfUpdateStatusDto['applying']>;

export class SelfUpdateService {
  private latestInfo: ReleaseInfo | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly current: string,
    private readonly feed: ReleaseFeed | null,
    private readonly starter: UnitStarter,
    private readonly stateDir: string,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}
  private get statusFile() {
    return path.join(this.stateDir, 'updates', 'status.json');
  }
  readApplying(): ApplyStatus | null {
    try {
      if (!existsSync(this.statusFile)) return null;
      const s = JSON.parse(readFileSync(this.statusFile, 'utf8')) as ApplyStatus;
      // an update that finished with the version we now run is history, not news
      if (s.state === 'succeeded' && s.version === this.current) return { ...s, message: `Updated to ${s.version}` };
      return s;
    } catch {
      return null;
    }
  }
  private writeApplying(s: ApplyStatus): void {
    mkdirSync(path.dirname(this.statusFile), { recursive: true, mode: 0o755 });
    writeFileSync(this.statusFile, JSON.stringify(s), { mode: 0o644 });
  }
  status(): SelfUpdateStatusDto {
    const latest = this.latestInfo;
    return {
      current: this.current,
      latest: latest ? { version: latest.version, publishedAt: latest.publishedAt, notes: latest.notes, url: latest.url } : null,
      available: Boolean(latest && compareVersions(latest.version, this.current) > 0),
      checkedAt: this.checkedAt,
      error: this.error,
      applying: this.readApplying(),
    };
  }
  async check(): Promise<SelfUpdateStatusDto> {
    if (!this.feed) return this.status();
    try {
      this.latestInfo = await this.feed.latest();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.log.warn(`update check failed: ${this.error}`);
    }
    this.checkedAt = rfc3339(this.clock.now());
    return this.status();
  }
  start(intervalMs = 6 * 3600_000): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
    void this.check();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async apply(actor: string): Promise<SelfUpdateStatusDto> {
    const st = this.status();
    if (!st.available || !this.latestInfo) throw new HarborError('INVALID_STATE', 'no newer Harbor release is known', { nextAction: 'Check for updates first.' });
    if (st.applying && (st.applying.state === 'requested' || st.applying.state === 'downloading' || st.applying.state === 'installing') && st.applying.version === this.latestInfo.version) {
      throw new HarborError('BUSY', `an update to ${st.applying.version} is already running`);
    }
    if (!this.latestInfo.archiveUrl || !this.latestInfo.sumsUrl) throw new HarborError('INVALID_STATE', `release ${this.latestInfo.version} has no archive for this platform yet`, { nextAction: 'Try again later; the release assets may still be uploading.' });
    const version = this.latestInfo.version;
    this.writeApplying({ version, state: 'requested', message: `requested by ${actor}; downloading ${archiveName(version)}`, at: rfc3339(this.clock.now()) });
    this.log.warn(`self-update to ${version} requested by ${actor}`);
    try {
      await this.starter.start(`harbor-self-update@${version}.service`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeApplying({ version, state: 'failed', message: `could not start the update: ${msg}`, at: rfc3339(this.clock.now()) });
      throw new HarborError('OPERATION_FAILED', `Harbor could not start the update (${msg})`, { nextAction: 'On the machine, run: sudo /opt/harbor/bin/harbor self-update apply --version ' + version });
    }
    return this.status();
  }
}
