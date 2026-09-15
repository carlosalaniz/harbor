export type Theme = 'system' | 'dark' | 'light';

// Theme is a per-browser convenience (localStorage may be unavailable; the page must still render).
export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('harbor.theme');
    return t === 'dark' || t === 'light' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  try {
    if (t === 'system') localStorage.removeItem('harbor.theme');
    else localStorage.setItem('harbor.theme', t);
  } catch {
    /* ignore */
  }
  if (t === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = t;
}

// Wallpaper: a handful of CSS presets, remembered per browser like the theme.
export const WALLPAPERS = ['harbor', 'dusk', 'forest', 'plain', 'photo'] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];
export function readWallpaper(): Wallpaper {
  try {
    const w = localStorage.getItem('harbor.wallpaper');
    return (WALLPAPERS as readonly string[]).includes(w ?? '') ? (w as Wallpaper) : 'harbor';
  } catch {
    return 'harbor';
  }
}
export function applyWallpaper(w: Wallpaper): void {
  try {
    if (w === 'harbor') localStorage.removeItem('harbor.wallpaper');
    else localStorage.setItem('harbor.wallpaper', w);
  } catch {
    /* ignore */
  }
  document.documentElement.dataset['wallpaper'] = w;
}
// The daemon's picture (uploaded, or the rotating one) becomes the 'photo' wallpaper; CSS reads the
// variable. `version` changes whenever the picture does, which busts the browser cache.
let currentVersion: string | null | undefined;
export function syncWallpaperPicture(picture: { present: boolean; version: string | null }): void {
  const version = picture.present ? (picture.version ?? 'x') : null;
  if (version === currentVersion) return;
  currentVersion = version;
  if (picture.present) document.documentElement.style.setProperty('--wallpaper-url', `url(/v1/appearance/wallpaper?v=${encodeURIComponent(version!)})`);
  else document.documentElement.style.removeProperty('--wallpaper-url');
  const pref = readWallpaper();
  if (picture.present && !hasExplicitWallpaper()) applyWallpaperRuntime('photo');
  else if (!picture.present && pref === 'photo') applyWallpaper('harbor');
}
// compatibility for the login screen (no session yet): HEAD tells us whether a picture exists
export function applyWallpaperPhoto(present: boolean): void {
  syncWallpaperPicture({ present, version: present ? `login-${Date.now()}` : null });
}
export function hasExplicitWallpaper(): boolean {
  try {
    return localStorage.getItem('harbor.wallpaper') !== null;
  } catch {
    return false;
  }
}
function applyWallpaperRuntime(w: Wallpaper): void {
  document.documentElement.dataset['wallpaper'] = w;
}
