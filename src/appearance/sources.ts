import type { Fetcher } from './fetcher.js';

// Where rotating wallpapers come from. Each source turns a listing into candidate pictures; the
// rotation service picks one, downloads it and stores it locally. Nothing is fetched by the browser.
export interface Candidate {
  imageUrl: string;
  title: string;
  author: string | null;
  sourceName: string;
  link: string | null;
  width: number | null;
  height: number | null;
}

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
}

const IMAGE_RE = /\.(jpe?g|png|webp)(\?.*)?$/i;
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
export function normalizeSubreddits(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const s = raw.trim().replace(/^\/?r\//i, '');
    if (!s) continue;
    if (!SUBREDDIT_RE.test(s)) throw new Error(`"${raw}" is not a subreddit name (letters, digits and underscores only)`);
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

// Reddit closed anonymous JSON listings in May 2026 (verified: 403 from both a laptop and the droplet),
// so the operator registers a "script" app at reddit.com/prefs/apps and Harbor uses the two-legged
// OAuth flow (client_credentials) that Reddit documents for read-only access.
export async function redditCandidates(f: Fetcher, creds: RedditCredentials, subreddits: string[]): Promise<Candidate[]> {
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const tok = await f.fetch('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', maxBytes: 64 * 1024 });
  if (tok.status !== 200) throw new Error(`Reddit refused the app credentials (HTTP ${tok.status}). Check the client id and secret in Settings.`);
  const token = (JSON.parse(tok.body.toString('utf8')) as { access_token?: string }).access_token;
  if (!token) throw new Error('Reddit returned no access token for the app credentials');
  const out: Candidate[] = [];
  for (const sub of subreddits) {
    const r = await f.fetch(`https://oauth.reddit.com/r/${encodeURIComponent(sub)}/top?t=week&limit=50&raw_json=1`, { headers: { authorization: `bearer ${token}` }, maxBytes: 4 * 1024 * 1024 });
    if (r.status !== 200) throw new Error(`Reddit answered HTTP ${r.status} for r/${sub}`);
    const listing = JSON.parse(r.body.toString('utf8')) as { data?: { children?: { data: RedditPost }[] } };
    for (const { data: p } of listing.data?.children ?? []) {
      if (p.over_18 || p.is_video || p.stickied) continue;
      const src = p.preview?.images?.[0]?.source;
      const direct = typeof p.url === 'string' && IMAGE_RE.test(p.url) ? p.url : null;
      const url = direct ?? (src?.url && IMAGE_RE.test(src.url.split('?')[0] ?? '') ? src.url : null);
      if (!url) continue;
      out.push({ imageUrl: url, title: p.title, author: p.author ? `u/${p.author}` : null, sourceName: `r/${sub}`, link: p.permalink ? `https://www.reddit.com${p.permalink}` : null, width: src?.width ?? null, height: src?.height ?? null });
    }
  }
  return out;
}
interface RedditPost {
  title: string;
  author?: string;
  url?: string;
  permalink?: string;
  over_18?: boolean;
  is_video?: boolean;
  stickied?: boolean;
  preview?: { images?: { source?: { url: string; width: number; height: number } }[] };
}

// Bing's homepage pictures: eight recent days, 1920x1080, no key needed. Verified reachable from the droplet.
export async function bingCandidates(f: Fetcher): Promise<Candidate[]> {
  const r = await f.fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US', { maxBytes: 1024 * 1024 });
  if (r.status !== 200) throw new Error(`Bing answered HTTP ${r.status}`);
  const j = JSON.parse(r.body.toString('utf8')) as { images?: { urlbase?: string; url?: string; copyright?: string; copyrightlink?: string; title?: string }[] };
  return (j.images ?? [])
    .filter((i) => i.urlbase)
    .map((i) => {
      const m = /^(.*?)\s*\(©\s*(.*?)\)\s*$/.exec(i.copyright ?? '');
      return { imageUrl: `https://www.bing.com${i.urlbase}_UHD.jpg`, title: (m?.[1] ?? i.title ?? i.copyright ?? 'Bing picture of the day').trim(), author: m?.[2]?.trim() ?? null, sourceName: 'Bing', link: i.copyrightlink ?? null, width: 3840, height: 2160 };
    });
}

// Wikimedia Commons picture of the day (open licences), via the Wikimedia feed API; last few days.
export async function wikimediaCandidates(f: Fetcher, now: Date): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let back = 0; back < 5; back++) {
    const d = new Date(now.getTime() - back * 86_400_000);
    const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const r = await f.fetch(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${ymd}`, { maxBytes: 2 * 1024 * 1024 });
    if (r.status !== 200) continue;
    const j = JSON.parse(r.body.toString('utf8')) as { image?: { title?: string; image?: { source?: string; width?: number; height?: number }; thumbnail?: { source?: string }; artist?: { text?: string }; file_page?: string; description?: { text?: string } } };
    const img = j.image;
    const src = img?.image?.source;
    if (!src) continue;
    const width = img?.image?.width ?? null;
    const height = img?.image?.height ?? null;
    // Originals are often 10-20 MB. Wikimedia serves direct thumbnail requests only at its standard widths
    // (20…960, 1280, 1920, 3840; verified from the droplet: 2560 → 400, 1920 → 200), so ask for the 1920px
    // rendition by rewriting the feed's own thumbnail URL (which already has the right host and file naming).
    const thumb = img?.thumbnail?.source?.split('?')[0] ?? null;
    const url = width && width > 1920 && thumb && /\/\d+px-/.test(thumb) ? thumb.replace(/\/\d+px-/, '/1920px-') : src.split('?')[0]!;
    out.push({ imageUrl: url, title: (img?.description?.text ?? img?.title ?? 'Wikimedia picture of the day').replace(/^File:/, '').slice(0, 140), author: img?.artist?.text ?? null, sourceName: 'Wikimedia Commons', link: img?.file_page ?? null, width, height });
  }
  return out;
}

// Wallpaper-worthy: landscape (or unknown), reasonably large, an image URL we can fetch.
export function chooseCandidate(cands: Candidate[], exclude: string | null, random: () => number = Math.random): Candidate | null {
  const good = cands.filter((c) => (c.width === null || c.height === null ? true : c.width >= 1600 && c.width >= c.height) && c.imageUrl !== exclude && /^https:\/\//.test(c.imageUrl));
  if (!good.length) return null;
  return good[Math.floor(random() * good.length)] ?? null;
}
