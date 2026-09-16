import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItemDto, InstanceSummary } from '../../../src/contracts/api';
import { AppIcon, InstanceIcon, appLabel, openUrl } from './components';
import { plainStatus } from './format';
import type { Route } from './router';
import type { Console } from './store';

// Spotlight-style search: Cmd/Ctrl+K (or "/" outside a field). Finds installed apps, store apps,
// pages and settings sections; Enter runs the first highlighted action.
export interface PaletteItem {
  id: string;
  kind: 'app' | 'store' | 'page' | 'setting';
  title: string;
  subtitle: string;
  icon?: { packageId: string; icon: string | null; name: string };
  inst?: InstanceSummary;
  run: () => void;
}

const PAGES: { route: Route; title: string; words: string }[] = [
  { route: { page: 'home' }, title: 'Home', words: 'home launcher apps' },
  { route: { page: 'store' }, title: 'App Store', words: 'store install catalog apps' },
  { route: { page: 'publishing' }, title: 'Publishing', words: 'publish addresses tailnet public expose' },
  { route: { page: 'platform' }, title: 'Platform', words: 'docker cockpit portainer tools system' },
  { route: { page: 'settings' }, title: 'Settings', words: 'settings overview restart shut down device machine wallpaper' },
  { route: { page: 'settings', section: 'account' }, title: 'Settings · Account', words: 'password session log out two-factor 2fa authenticator' },
  { route: { page: 'settings', section: 'remote' }, title: 'Settings · Remote access', words: 'tailscale tailnet vpn remote key' },
  { route: { page: 'settings', section: 'public' }, title: 'Settings · Public addresses', words: 'domain dns certificate https letsencrypt caddy public internet' },
  { route: { page: 'settings', section: 'storage' }, title: 'Settings · Storage', words: 'disks folders data volumes' },
  { route: { page: 'settings', section: 'appearance' }, title: 'Settings · Appearance', words: 'theme wallpaper dark light picture rotating reddit bing wikimedia' },
  { route: { page: 'settings', section: 'access' }, title: 'Settings · Advanced access', words: 'ssh cli command line terminal shell console' },
  { route: { page: 'settings', section: 'troubleshoot' }, title: 'Settings · Troubleshoot', words: 'logs errors debug journal docker' },
  { route: { page: 'settings', section: 'about' }, title: 'Settings · About', words: 'version about' },
];

export function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (document.querySelector('dialog[open]')) return; // a modal sheet owns the keyboard
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      } else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

export function Palette({ c, go, onOpenApp, onAbout, onClose }: { c: Console; go: (r: Route) => void; onOpenApp: (i: InstanceSummary) => void; onAbout: (item: CatalogItemDto) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo<PaletteItem[]>(() => {
    const needle = q.trim().toLowerCase();
    const has = (...parts: (string | null | undefined)[]) => !needle || parts.some((p) => (p ?? '').toLowerCase().includes(needle));
    const out: PaletteItem[] = [];
    for (const i of c.data.instances.filter((x) => x.installState !== 'retained')) {
      if (!has(i.name, i.packageName, i.packageId, i.displayName)) continue;
      const url = openUrl(i);
      const canOpen = i.installState === 'installed' && i.runtime === 'running' && url;
      out.push({
        id: `app-${i.id}`,
        kind: 'app',
        title: appLabel(i),
        subtitle: `${plainStatus(i).label}${canOpen ? ' · Enter opens it' : ' · Enter shows details'}`,
        inst: i,
        run: () => {
          if (canOpen) window.open(url!, '_blank', 'noopener');
          else onOpenApp(i);
        },
      });
    }
    for (const item of c.data.catalog) {
      if (!has(item.name, item.presentation.tagline, item.description, item.presentation.category)) continue;
      out.push({ id: `store-${item.id}`, kind: 'store', title: item.name, subtitle: `App Store · ${item.presentation.tagline ?? item.description}`, icon: { packageId: item.id, icon: item.presentation.icon, name: item.name }, run: () => onAbout(item) });
    }
    for (const p of PAGES) {
      if (!has(p.title, p.words)) continue;
      out.push({ id: `page-${p.title}`, kind: p.route.page === 'settings' ? 'setting' : 'page', title: p.title, subtitle: p.route.page === 'settings' ? 'Settings' : 'Page', run: () => go(p.route) });
    }
    return out.slice(0, 12);
  }, [q, c.data.instances, c.data.catalog, go, onOpenApp, onAbout]);
  useEffect(() => setCursor(0), [q]);
  const pick = (it: PaletteItem) => {
    onClose();
    it.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div className="palette" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          value={q}
          placeholder="Search apps, store and settings…"
          aria-label="Search everything"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && items[cursor]) pick(items[cursor]);
            else if (e.key === 'Escape') onClose();
          }}
        />
        <ul className="palette-list" role="listbox" aria-label="Results">
          {items.map((it, i) => (
            <li key={it.id} role="option" aria-selected={i === cursor} className={`palette-item ${i === cursor ? 'active' : ''}`} onMouseEnter={() => setCursor(i)} onClick={() => pick(it)}>
              {it.inst ? (
                <InstanceIcon inst={it.inst} size={28} />
              ) : it.icon ? (
                <AppIcon packageId={it.icon.packageId} icon={it.icon.icon} name={it.icon.name} size={28} />
              ) : (
                <span className="palette-dot" aria-hidden="true" />
              )}
              <span className="palette-text">
                <span className="palette-title">{it.title}</span>
                <span className="muted small">{it.subtitle}</span>
              </span>
              <span className="muted small palette-kind">{it.kind === 'app' ? 'Installed' : it.kind === 'store' ? 'Store' : it.kind === 'setting' ? 'Setting' : 'Page'}</span>
            </li>
          ))}
          {items.length === 0 && <li className="muted small palette-empty">Nothing matches "{q}".</li>}
        </ul>
        <p className="muted small palette-hint">↑↓ to move · Enter to open · Esc to close · Cmd/Ctrl+K or / anywhere</p>
      </div>
    </div>
  );
}
