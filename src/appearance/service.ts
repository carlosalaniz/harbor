import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppearanceDto, InstanceAppearancePatch, RotationDto, RotationPatch, WallpaperPictureDto, WallpaperSource } from '../contracts/api.js';
import { HarborError } from '../errors.js';
import type { Logger } from '../lifecycle/context.js';
import type { InstanceIcon, Repo } from '../state/repo.js';
import { rfc3339, type Clock } from '../util.js';
import type { Fetcher } from './fetcher.js';
import { bingCandidates, chooseCandidate, normalizeSubreddits, redditCandidates, wikimediaCandidates, type Candidate } from './sources.js';

// Appearance for the whole installation: the wallpaper (one uploaded picture, or a rotating one fetched
// from a public source on the daemon's schedule), the launcher order, and per-app display name/icon.
// Pictures are stored under the state dir and served by the daemon; the browser never talks to a source.

const MAGIC: [string, number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46]],
];
export function sniffImage(bytes: Buffer): string | null {
  return MAGIC.find(([, magic]) => magic.every((b, i) => bytes[i] === b))?.[0] ?? null;
}
// data:image/<type>;base64,<payload> → verified bytes (declared type must match the magic bytes)
export function decodeImageDataUrl(dataUrl: string, maxBytes: number, what: string): { bytes: Buffer; contentType: string } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HarborError('INVALID_REQUEST', `${what} must be a PNG, JPEG or WebP data URL`);
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > maxBytes) throw new HarborError('INVALID_REQUEST', `${what} must be ${Math.round(maxBytes / (1024 * 1024))} MB or smaller`);
  const sniffed = sniffImage(bytes);
  if (!sniffed || sniffed !== m[1]) throw new HarborError('INVALID_REQUEST', 'the picture bytes do not match the declared image type');
  return { bytes, contentType: sniffed };
}

interface RotationSettings {
  enabled: boolean;
  source: WallpaperSource;
  subreddits: string[];
  everyHours: number;
  reddit: { clientId: string; clientSecret: string } | null;
}
interface RotatingState {
  contentType: string;
  imageUrl: string;
  picture: WallpaperPictureDto;
  nextAt: string | null;
  lastError: string | null;
}
const DEFAULTS: RotationSettings = { enabled: false, source: 'bing', subreddits: ['EarthPorn', 'wallpapers'], everyHours: 24, reddit: null };
const SOURCES: WallpaperSource[] = ['reddit', 'bing', 'wikimedia'];
const GLYPH_RE = /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*$|^[\p{L}\p{N}]{1,2}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

export class AppearanceService {
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(
    private readonly repo: Repo,
    private readonly stateDir: string,
    private readonly fetcher: Fetcher,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  // ---- files
  private get uploadedFile() {
    return path.join(this.stateDir, 'wallpaper.bin');
  }
  private get uploadedMeta() {
    return path.join(this.stateDir, 'wallpaper.json');
  }
  private get rotatingFile() {
    return path.join(this.stateDir, 'wallpaper-rotating.bin');
  }
  private get rotatingMeta() {
    return path.join(this.stateDir, 'wallpaper-rotating.json');
  }
  private iconFile(instanceId: string) {
    return path.join(this.stateDir, 'icons', `${instanceId}.bin`);
  }

  // ---- settings
  private settings(): RotationSettings {
    return { ...DEFAULTS, ...(this.repo.setting<Partial<RotationSettings>>('appearance.rotation') ?? {}) };
  }
  private rotatingState(): RotatingState | null {
    if (!existsSync(this.rotatingFile) || !existsSync(this.rotatingMeta)) {
      // keep schedule/error info even without a picture
      const meta = this.repo.setting<Pick<RotatingState, 'nextAt' | 'lastError'>>('appearance.rotation.state');
      return meta ? { contentType: '', imageUrl: '', picture: { title: '', author: null, sourceName: '', link: null, fetchedAt: '' }, ...meta } : null;
    }
    try {
      return JSON.parse(readFileSync(this.rotatingMeta, 'utf8')) as RotatingState;
    } catch {
      return null;
    }
  }
  private saveRotatingState(s: RotatingState | null): void {
    if (s && s.contentType) writeFileSync(this.rotatingMeta, JSON.stringify(s), { mode: 0o600 });
    this.repo.setSetting('appearance.rotation.state', s ? { nextAt: s.nextAt, lastError: s.lastError } : null);
  }

  status(): AppearanceDto {
    const s = this.settings();
    const rot = this.rotatingState();
    const hasRotating = existsSync(this.rotatingFile) && Boolean(rot?.contentType);
    const hasUploaded = existsSync(this.uploadedFile) && existsSync(this.uploadedMeta);
    let wallpaper: AppearanceDto['wallpaper'] = { kind: 'none', version: null, current: null };
    if (s.enabled && hasRotating && rot) wallpaper = { kind: 'rotating', version: rot.picture.fetchedAt, current: rot.picture };
    else if (hasUploaded) {
      const meta = JSON.parse(readFileSync(this.uploadedMeta, 'utf8')) as { setAt?: string };
      wallpaper = { kind: 'uploaded', version: meta.setAt ?? 'uploaded', current: null };
    }
    const rotation: RotationDto = { enabled: s.enabled, source: s.source, subreddits: s.subreddits, everyHours: s.everyHours, nextAt: s.enabled ? (rot?.nextAt ?? null) : null, lastError: rot?.lastError ?? null, reddit: { clientId: s.reddit?.clientId ?? null, hasSecret: Boolean(s.reddit?.clientSecret) } };
    return { wallpaper, rotation, home: { order: this.repo.setting<string[]>('home.order') ?? [] } };
  }

  // The picture the console should paint right now (open route: <img>/CSS cannot send a token).
  activeWallpaper(): { bytes: Buffer; contentType: string } | null {
    const st = this.status().wallpaper;
    if (st.kind === 'rotating') {
      const rot = this.rotatingState()!;
      return { bytes: readFileSync(this.rotatingFile), contentType: rot.contentType };
    }
    if (st.kind === 'uploaded') {
      const meta = JSON.parse(readFileSync(this.uploadedMeta, 'utf8')) as { contentType: string };
      return { bytes: readFileSync(this.uploadedFile), contentType: meta.contentType };
    }
    return null;
  }
  setUploaded(dataUrl: string): void {
    const { bytes, contentType } = decodeImageDataUrl(dataUrl, 6 * 1024 * 1024, 'wallpaper');
    writeFileSync(this.uploadedFile, bytes, { mode: 0o600 });
    writeFileSync(this.uploadedMeta, JSON.stringify({ contentType, bytes: bytes.length, setAt: rfc3339(this.clock.now()) }), { mode: 0o600 });
  }
  clearUploaded(): void {
    rmSync(this.uploadedFile, { force: true });
    rmSync(this.uploadedMeta, { force: true });
  }

  // ---- rotation
  async updateRotation(patch: RotationPatch): Promise<AppearanceDto> {
    const prev = this.settings();
    const next: RotationSettings = { ...prev };
    if (patch.source !== undefined) {
      if (!SOURCES.includes(patch.source)) throw new HarborError('INVALID_REQUEST', `unknown wallpaper source ${String(patch.source)}`);
      next.source = patch.source;
    }
    if (patch.subreddits !== undefined) {
      try {
        next.subreddits = normalizeSubreddits(patch.subreddits);
      } catch (e) {
        throw new HarborError('INVALID_REQUEST', (e as Error).message);
      }
      if (!next.subreddits.length) throw new HarborError('INVALID_REQUEST', 'give at least one subreddit');
    }
    if (patch.everyHours !== undefined) {
      if (!Number.isInteger(patch.everyHours) || patch.everyHours < 1 || patch.everyHours > 24 * 30) throw new HarborError('INVALID_REQUEST', 'everyHours must be a whole number between 1 and 720');
      next.everyHours = patch.everyHours;
    }
    if (patch.reddit !== undefined) {
      if (patch.reddit === null) next.reddit = null;
      else {
        const clientId = patch.reddit.clientId.trim();
        const secret = patch.reddit.clientSecret?.trim() || (prev.reddit && prev.reddit.clientId === clientId ? prev.reddit.clientSecret : '');
        if (!clientId || !secret) throw new HarborError('INVALID_REQUEST', 'Reddit needs both the client id and the secret of your app (reddit.com/prefs/apps)');
        next.reddit = { clientId, clientSecret: secret };
      }
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (next.enabled && next.source === 'reddit' && !next.reddit) throw new HarborError('INVALID_REQUEST', 'Reddit wallpapers need your Reddit app credentials first', { nextAction: 'Create a "script" app at reddit.com/prefs/apps and paste its client id and secret in Settings → Appearance.' });
    this.repo.setSetting('appearance.rotation', next);
    const changed = next.source !== prev.source || next.subreddits.join() !== prev.subreddits.join() || JSON.stringify(next.reddit) !== JSON.stringify(prev.reddit);
    const rot = this.rotatingState();
    if (next.enabled && (!prev.enabled || changed || !rot?.contentType)) await this.refresh();
    if (!next.enabled) this.saveRotatingState(rot ? { ...rot, nextAt: null } : null);
    return this.status();
  }

  async next(): Promise<AppearanceDto> {
    if (!this.settings().enabled) throw new HarborError('INVALID_STATE', 'rotating wallpapers are turned off', { nextAction: 'Turn them on in Settings → Appearance first.' });
    await this.refresh();
    return this.status();
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) return;
    const rot = this.rotatingState();
    const due = !rot?.contentType || !rot.nextAt || new Date(rot.nextAt).getTime() <= this.clock.now().getTime();
    if (due) await this.refresh();
  }

  // Fetch one new picture now. Errors never throw out of here: they land in lastError with a retry time.
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  private async doRefresh(): Promise<void> {
    const s = this.settings();
    const prev = this.rotatingState();
    const now = this.clock.now();
    try {
      let cands: Candidate[];
      if (s.source === 'reddit') {
        if (!s.reddit) throw new Error('Reddit app credentials are missing');
        cands = await redditCandidates(this.fetcher, s.reddit, s.subreddits);
      } else if (s.source === 'bing') cands = await bingCandidates(this.fetcher);
      else cands = await wikimediaCandidates(this.fetcher, now);
      const pick = chooseCandidate(cands, prev?.imageUrl ?? null) ?? chooseCandidate(cands, null);
      if (!pick) throw new Error(`no wallpaper-sized pictures found at ${s.source === 'reddit' ? s.subreddits.map((x) => `r/${x}`).join(', ') : s.source}`);
      const img = await this.fetcher.fetch(pick.imageUrl, { maxBytes: 16 * 1024 * 1024, timeoutMs: 60_000 });
      if (img.status !== 200) throw new Error(`the picture could not be downloaded (HTTP ${img.status})`);
      const contentType = sniffImage(img.body);
      if (!contentType) throw new Error('the download was not a PNG, JPEG or WebP picture');
      writeFileSync(this.rotatingFile, img.body, { mode: 0o600 });
      const picture: WallpaperPictureDto = { title: pick.title, author: pick.author, sourceName: pick.sourceName, link: pick.link, fetchedAt: rfc3339(now) };
      this.saveRotatingState({ contentType, imageUrl: pick.imageUrl, picture, nextAt: rfc3339(new Date(now.getTime() + s.everyHours * 3_600_000)), lastError: null });
      this.log.info('wallpaper rotated', { source: pick.sourceName, title: pick.title });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`wallpaper rotation failed: ${msg}`);
      const retryAt = rfc3339(new Date(now.getTime() + 30 * 60_000));
      this.saveRotatingState(prev?.contentType ? { ...prev, nextAt: retryAt, lastError: msg } : { contentType: '', imageUrl: '', picture: { title: '', author: null, sourceName: '', link: null, fetchedAt: '' }, nextAt: retryAt, lastError: msg });
    }
  }

  // ---- launcher order
  setHomeOrder(order: string[]): AppearanceDto {
    const known = new Set(this.repo.listInstances().map((i) => i.id));
    const clean = [...new Set(order)].filter((id) => known.has(id));
    this.repo.setSetting('home.order', clean);
    return this.status();
  }

  // ---- per-app look
  setInstanceAppearance(instanceId: string, patch: InstanceAppearancePatch): void {
    const row = this.repo.instance(instanceId);
    if (!row || row.purgedAt) throw new HarborError('NOT_FOUND', `unknown instance ${instanceId}`);
    const update: { displayName?: string | null; icon?: InstanceIcon | null } = {};
    if (patch.displayName !== undefined) {
      const name = patch.displayName?.trim() ?? '';
      if (name.length > 40) throw new HarborError('INVALID_REQUEST', 'the name can be at most 40 characters');
      update.displayName = name ? name : null;
    }
    if (patch.icon !== undefined) {
      if (patch.icon.kind === 'default') {
        rmSync(this.iconFile(instanceId), { force: true });
        update.icon = null;
      } else if (patch.icon.kind === 'glyph') {
        if (!GLYPH_RE.test(patch.icon.glyph)) throw new HarborError('INVALID_REQUEST', 'the icon must be one emoji or up to two letters');
        if (!COLOR_RE.test(patch.icon.color)) throw new HarborError('INVALID_REQUEST', 'the colour must look like #1a2b3c');
        rmSync(this.iconFile(instanceId), { force: true });
        update.icon = { kind: 'glyph', glyph: patch.icon.glyph, color: patch.icon.color.toLowerCase() };
      } else {
        const { bytes, contentType } = decodeImageDataUrl(patch.icon.dataUrl, 1024 * 1024, 'the icon');
        mkdirSync(path.dirname(this.iconFile(instanceId)), { recursive: true, mode: 0o700 });
        writeFileSync(this.iconFile(instanceId), bytes, { mode: 0o600 });
        update.icon = { kind: 'image', contentType, version: rfc3339(this.clock.now()) };
      }
    }
    this.repo.setInstanceAppearance(instanceId, update);
  }
  instanceIcon(instanceId: string): { bytes: Buffer; contentType: string } | null {
    const row = this.repo.instance(instanceId);
    if (!row?.icon || row.icon.kind !== 'image' || !existsSync(this.iconFile(instanceId))) return null;
    return { bytes: readFileSync(this.iconFile(instanceId)), contentType: row.icon.contentType };
  }
  // called by a full uninstall
  forgetInstance(instanceId: string): void {
    rmSync(this.iconFile(instanceId), { force: true });
    const order = this.repo.setting<string[]>('home.order');
    if (order?.includes(instanceId)) this.repo.setSetting('home.order', order.filter((x) => x !== instanceId));
  }
}
