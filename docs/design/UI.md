# Design addendum: the Harbor console

**Status:** approved direction (Carlos, 2026-09-14): "like Umbrel and/or HexOS but better and easier". Implemented 2026-09-14 (web/src/app); Playwright coverage in tests/e2e/ui.spec.ts.
**Extends:** TDD.md section 8 (minimal UI). The API stays the single source of truth; the console is
a nicer client of it, not a second engine.

## 1. What we take from each

| From | Pattern | Harbor version |
|---|---|---|
| umbrelOS | Home is a launcher: app icons in a grid, one tap opens the app; app store cards with icon, name, tagline, category and a gallery; app page with description, developer, website, release notes | **Home** = installed apps as icon tiles with status dots and quick actions; **App Store** = catalog cards from package `presentation` metadata; app **drawer** with details |
| umbrelOS | Command-K palette, right-click menus, "every click feels considered" | Search field that filters both installed and store; keyboard focus everywhere; context actions in a `…` menu per tile |
| HexOS Command Deck | System health cards (processor, memory, network, storage) with drill-down; plain vocabulary ("Apps", "Storage", not "VDEV") | **System** strip on Home: CPU, memory, disk, Docker, with a detail sheet; states in plain words with the technical code one tap away |
| HexOS | Guided wizards, mobile-optimized dialogs | Install and Publish are step dialogs (choose → review plan → progress → done) that work at phone width |
| Both | Dark, calm palette; large touch targets; wallpaper/tinted background | Dark theme by default, light theme via system preference; soft surfaces, one accent |

What we deliberately do **not** copy: a fake desktop (windows, dock), telemetry-driven widgets,
a cloud relay for remote access (Harbor's remote path is the tailnet), hidden "expert modes".

## 2. Information architecture

```
Sidebar (desktop) / bottom tabs (phone)
├── Home        system strip · installed apps grid (tiles) · attention list (needs action / degraded)
├── App Store   search · category chips · cards (icon, name, tagline) · app drawer (gallery, description, developer, website, ports/storage/secrets preview, Install)
├── Publishing  every published address, state, primary marker · Publish/Withdraw · Harbor-on-tailnet toggle
├── Platform    Docker, Cockpit, Portainer, Tailscale, Proxy cards with real state, links and the exact next step
└── Settings    session, version, installation id, access instructions (SSH forward line), theme
Overlay: operation tray (bottom-right) showing the running operation with phase + events; toast on completion (credentials shown once here)
```

Every tile shows: icon, name, one status pill in plain words ("Running", "Stopped", "Needs attention",
"Removed, data kept", "Installing…"), the primary address on hover/focus, and actions
(Open · Publish · Stop/Start · Details · Remove). Technical state (`installState/runtime/readiness`,
error codes, next action) lives in the drawer.

## 3. Package presentation metadata (small, optional schema extension)

`manifest.yaml` gains an optional `presentation` block; packages without it render from
`metadata` alone (name, description) with a generated monogram icon.

```yaml
presentation:
  tagline: Whiteboard for quick sketches          # ≤ 80 chars, plain text
  category: productivity                          # one of: productivity, media, files, automation, network, developer, ai, security, finance, home, other
  icon: icon.svg                                  # file inside the package dir, svg or png, ≤ 256 KiB
  gallery: [shot-1.png, shot-2.png]               # files inside the package dir, ≤ 1 MiB each, ≤ 6
  developer: Excalidraw contributors
  website: https://excalidraw.com
  releaseNotes: Pinned image digest …             # plain text
```

Rules: files are read only from the package directory (contained paths, bounded sizes, hashed in
`release.json` so tampering is detected like the other files); served by the daemon at
`GET /v1/catalog/{id}/asset/{name}` with `Content-Type` fixed by extension, `X-Content-Type-Options:
nosniff` and, for SVG, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`. No
remote images. The UI never renders package text as HTML.

## 4. System strip

`GET /v1/system/metrics`: CPU load (1/5/15 min, cores), memory (total/used), root filesystem
(total/used), Docker (available, version, containers running/total from Harbor's own records), uptime.
Read from `/proc` and `statfs` on Linux; `os` fallbacks elsewhere. Sampled by the observer every tick;
no history stored in this iteration (a sparkline needs a ring buffer; later).

## 5. Implementation notes

- Same stack (React + Vite, plain CSS with design tokens, no UI framework, strict CSP, in-memory
  token). Components split into files; routes handled by a tiny hash router (no router dependency).
- Accessibility: every action has an accessible name; dialogs are `<dialog>`; focus visible; color
  never the only signal (words + icons).
- Phone width: tiles collapse to a two-column grid; sidebar becomes a bottom bar; dialogs go full-screen.
- Playwright coverage: navigation, install wizard, publish wizard, drawer, attention list, phone viewport.

## 6. Settings for self-service (added 2026-09-15)

Umbrel's settings are the reference: one list of sections with plain names and a one-line blurb each.
Harbor's sections and what they call: Account (`PUT /v1/account/password`), Remote access
(`POST /v1/platform-tools/tailscale/login` with an auth key or none → login URL; `…/logout`;
`PUT/DELETE /v1/ui-exposure`), Public addresses (tool state), Storage (`GET /v1/host/storage`,
`GET/POST /v1/host/folders`), Appearance (theme + wallpaper, per browser), Advanced access (SSH line, CLI),
About. Home is a launcher: icon grid with labels and a status dot, "⋯" for the drawer, retained apps folded.
The install page uses a folder picker (places = disks + Harbor data folder; navigate; create folder) with a
"type a path" fallback.

## 7. Personal launcher, rotating wallpapers, the machine (added 2026-09-15, v0.5.0)

macOS is the visual reference for this pass (Apple HIG: clarity, deference, depth): content sits on the
wallpaper, surfaces are translucent (`backdrop-filter`), one accent colour, 8pt spacing, icon corners at
22.5%, spring-like easing kept under 250 ms, a lock-screen clock over the login card.

- **Launcher**: hold (touch) or drag (mouse) an icon to move it; *Arrange* toggles a jiggle mode with keyboard
  moves (arrow keys) and *Done*. Order is saved on the daemon (`PUT /v1/appearance/home`).
- **Customize…** in the app drawer: display name and icon (app's own, emoji/letters on a colour, or a
  picture). Saved per installation (`PUT /v1/instances/{id}/appearance`), shown everywhere (tiles, drawer,
  search, tray).
- **Wallpapers**: presets, your own picture, or rotating pictures fetched by the daemon from Bing,
  Wikimedia Commons or Reddit (with the operator's Reddit app key). Attribution is shown bottom-left on Home.
- **Settings → Overview** (default): device card with a live wallpaper preview, Log out / Restart / Shut down
  (confirmation dialogs; logind via a polkit rule), machine facts, storage/memory/temperature/live usage,
  wallpaper picker, then the section list.

## 8. Out of scope now

Widgets with live app data, multi-user, notifications center, app updates UI (no update engine yet),
folders/pages on the launcher.
