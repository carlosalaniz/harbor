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
export const WALLPAPERS = ['harbor', 'dusk', 'forest', 'plain'] as const;
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
