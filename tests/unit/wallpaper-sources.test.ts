import { describe, expect, it } from 'vitest';
import { FakeFetcher, json } from '../../src/appearance/fetcher.js';
import { bingCandidates, chooseCandidate, normalizeSubreddits, redditCandidates, wikimediaCandidates } from '../../src/appearance/sources.js';
import { polkitPowerRule } from '../../src/bootstrap/systemd.js';
import { hostFacts } from '../../src/system/metrics.js';

describe('wallpaper sources', () => {
  it('reddit: two-legged OAuth, then top-of-week listings; skips NSFW, videos and portrait shots', async () => {
    const f = new FakeFetcher()
      .on('https://www.reddit.com/api/v1/access_token', (_u, o) => (o.headers?.['authorization'] === `Basic ${Buffer.from('id:secret').toString('base64')}` && o.body === 'grant_type=client_credentials' ? json({ access_token: 'tok' }) : json({ error: 401 }, 401)))
      .on('https://oauth.reddit.com/r/EarthPorn/top', (_u, o) =>
        o.headers?.['authorization'] === 'bearer tok'
          ? json({
              data: {
                children: [
                  { data: { title: 'Wide [OC]', author: 'ann', url: 'https://i.redd.it/a.jpg', permalink: '/r/EarthPorn/comments/1/wide/', over_18: false, preview: { images: [{ source: { url: 'https://preview.redd.it/a.jpg?x=1', width: 4000, height: 2500 } }] } } },
                  { data: { title: 'Tall', author: 'bob', url: 'https://i.redd.it/b.jpg', over_18: false, preview: { images: [{ source: { url: 'https://preview.redd.it/b.jpg', width: 1000, height: 2000 } }] } } },
                  { data: { title: 'Adult', author: 'x', url: 'https://i.redd.it/c.jpg', over_18: true } },
                  { data: { title: 'Video', author: 'y', url: 'https://v.redd.it/z', is_video: true, over_18: false } },
                  { data: { title: 'Gallery link', author: 'z', url: 'https://www.reddit.com/gallery/abc', over_18: false } },
                ],
              },
            })
          : json({}, 403),
      );
    const c = await redditCandidates(f, { clientId: 'id', clientSecret: 'secret' }, ['EarthPorn']);
    expect(c.map((x) => x.title)).toEqual(['Wide [OC]', 'Tall']);
    expect(c[0]).toMatchObject({ imageUrl: 'https://i.redd.it/a.jpg', author: 'u/ann', sourceName: 'r/EarthPorn', link: 'https://www.reddit.com/r/EarthPorn/comments/1/wide/', width: 4000, height: 2500 });
    expect(chooseCandidate(c, null)?.title).toBe('Wide [OC]'); // the tall one is filtered when choosing
    expect(chooseCandidate(c, 'https://i.redd.it/a.jpg')).toBeNull(); // nothing new left
    await expect(redditCandidates(f, { clientId: 'id', clientSecret: 'wrong' }, ['EarthPorn'])).rejects.toThrow(/refused the app credentials/);
    expect(normalizeSubreddits([' r/EarthPorn', 'wallpapers', 'earthporn', '/r/SpacePorn '])).toEqual(['EarthPorn', 'wallpapers', 'SpacePorn']);
    expect(() => normalizeSubreddits(['not a sub'])).toThrow(/not a subreddit/);
  });

  it('bing: eight days of UHD pictures with photographer credit parsed from the copyright line', async () => {
    const f = new FakeFetcher().on('https://www.bing.com/HPImageArchive.aspx', json({ images: [{ urlbase: '/th?id=OHR.FortUnion_EN-US5138724452', copyright: 'Fort Union National Monument, New Mexico (© zrfphoto/Getty Images)', copyrightlink: 'https://www.bing.com/search?q=x' }] }));
    const c = await bingCandidates(f);
    expect(c).toEqual([{ imageUrl: 'https://www.bing.com/th?id=OHR.FortUnion_EN-US5138724452_UHD.jpg', title: 'Fort Union National Monument, New Mexico', author: 'zrfphoto/Getty Images', sourceName: 'Bing', link: 'https://www.bing.com/search?q=x', width: 3840, height: 2160 }]);
  });

  it('wikimedia: picture of the day for the last days; huge originals are asked for as the standard 1920px rendition', async () => {
    const f = new FakeFetcher()
      .on('https://api.wikimedia.org/feed/v1/wikipedia/en/featured/2026/09/15', json({ image: { title: 'File:Big.jpg', image: { source: 'https://upload.wikimedia.org/wikipedia/commons/e/e8/Big.jpg?utm=x', width: 6000, height: 4000 }, thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e8/Big.jpg/960px-Big.jpg?utm=x' }, artist: { text: 'Diego Delso' }, file_page: 'https://commons.wikimedia.org/wiki/File:Big.jpg', description: { text: 'A church' } } }))
      .on('https://api.wikimedia.org/feed/v1/wikipedia/en/featured/2026/09/14', json({ image: { title: 'File:Small.png', image: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Small.png', width: 2000, height: 1200 } } }))
      .on('https://api.wikimedia.org/feed/v1/wikipedia/en/featured/', json({}, 404));
    const c = await wikimediaCandidates(f, new Date('2026-09-15T12:00:00Z'));
    expect(c.map((x) => x.imageUrl)).toEqual(['https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e8/Big.jpg/1920px-Big.jpg', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Small.png']);
    expect(c[0]).toMatchObject({ title: 'A church', author: 'Diego Delso', sourceName: 'Wikimedia Commons' });
    expect(c[1]!.title).toBe('Small.png');
  });
});

describe('power rule and host facts', () => {
  it('grants only reboot/power-off to the harbor user', () => {
    const r = polkitPowerRule();
    expect(r).toContain(`subject.user !== "harbor"`);
    expect(r).toContain('org.freedesktop.login1.reboot');
    expect(r).toContain('org.freedesktop.login1.power-off');
    // the only systemd unit the harbor user may start is the Tailscale operator oneshot (v0.7)
    expect(r).toContain('org.freedesktop.systemd1.manage-units');
    expect(r).toContain('"harbor-tailscale-operator.service"');
    expect(r).not.toMatch(/stop|restart|manage-unit-files/);
  });
  it('reports hostname, OS, architecture and CPU model', () => {
    const h = hostFacts();
    expect(h.hostname.length).toBeGreaterThan(0);
    expect(h.os.length).toBeGreaterThan(0);
    expect(['x64', 'arm64', 'arm']).toContain(h.arch);
  });
});
