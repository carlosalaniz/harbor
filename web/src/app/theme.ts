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
