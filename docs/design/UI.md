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
├── App Store   search · category chips · cards (icon, name, tagline) · install page (screenshot strip with tap-to-enlarge, description, *Source code on GitHub* / *Website* links from `presentation.source`/`website`, developer, storage/access, Install) · sections *Apps / Backup places / Your repositories* · catalog line + refresh icon under the title (decision 164)
├── Publishing  On the internet (per app, problems first) · On your tailnet (compact, console toggle) · Not published (decision 189)
├── Platform    Docker, Cockpit, Portainer, Tailscale, Proxy cards with real state, links and the exact next step
└── Settings    session, version, installation id, access instructions (SSH forward line), theme
Overlay: the queue tray (bottom-right; above the tabs on phones): running item, waiting items with Cancel, finished results (credentials shown once here) — decision 183
```

Every tile shows: icon, name, one status pill in plain words ("Running", "Stopped", "Needs attention",
"Removed, data kept", "Installing…"), the primary address on hover/focus, and actions
(Open · Publish · Stop/Start · Details · Remove). Technical state (`installState/runtime/readiness`,
error codes, next action) lives in the drawer.

**The tray is the queue (decision 183).** One quiet panel, one line on top (*Queue · 1 running, 2 waiting*) that
collapses it. Inside, in run order: the running operation (its sentence, the phase in plain words, a progress
bar); the waiting ones (*Update Immich · waiting*), each with **Cancel** (accessible name *Cancel update Immich*)
or, when Harbor queued it to protect something (drive guard, link guard, lock guard, a backup run), one
quiet line saying why it cannot be cancelled; then the finished operations, each with today's result (Open, next
step, shown-once credentials and recovery cards, error code + next action, *Technical steps*) and its own Dismiss.
The tray keeps every item a person started (by its actor: Update all, adopt, other tabs and reloads included),
anything that shows a value once, and failures of any actor; successes of Harbor's own actors (a nightly backup, an
auto-update) leave on their own.
**Clear finished** clears everything except a password or recovery words, which stay until acknowledged. No button
anywhere is disabled because another operation runs: a Start/Stop/Restart/Update/Remove/Reinstall/Uninstall on a
busy app (installing included) opens the review in *queue mode* (no plan; "Harbor is installing Immich right now.
Harbor will update it as soon as that finishes, planning it then." or "Immich is waiting to restart first. …", and
**Queue update**); the same action already waiting shows *Already queued: Update Immich* with its Cancel and
*Keep it*. A review where you typed values, accepted permissions or changed settings never drops them into queue
mode: it waits for the app and shows the review again (decision 173), as do the other kinds. Home tiles show the
app's own operation (*Updating…*, *Waiting…*, the installing pulse) and the app page adds one quiet line
(*Installing… · Update waiting*).

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
  sizeHint: About 50 MB                           # plain text ≤ 120, shown as "Needs about 50 MB" (decision 156)
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
`GET/POST /v1/host/folders`, device mount/unmount + status, `PUT /v1/host/storage/policy` for the
auto-mount/auto-start toggles), Appearance (theme + wallpaper, per browser), Advanced access (SSH line, CLI),
About. Home is a launcher: icon grid with labels and a status dot, "⋯" for the drawer, retained apps folded.
The install page (decision 156) is summaries, not forms: *Storage* (where the whole app lives, free space, "Encrypted") and *Access* (who can reach it) each show the current choice in plain words with a *Change* button; name, own passphrase, own folders and technical details sit under *Advanced*; the footer says what happens after Install. Own folders use a folder picker (places = disks + removable drives + Harbor data folder; navigate; create folder) with a
"type a path" fallback. An app whose drive left shows "Needs its drive" on Home and a banner with
"Use this folder instead" (adopt) in its drawer.

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

## 7a. Readability and phones (decision 164, v0.30.0)

- Surfaces are nearly solid by default (0.94); the Settings section list sits in a solid card, the active
  row is a solid accent tint with an accent edge. Look = theme *Auto / Light / Dark* + background
  *Picture of the day* (or your own) / flat *Harbor*.
- Settings ≥ 1025 px: two columns that scroll on their own (the page itself does not); Overview starts with
  the Harbor version card (update button when a release is out).
- Phones: Settings is a list; a section opens alone with *‹ Settings*. The dock uses short labels (Home,
  Store, Publish, Platform, Alerts, Settings), carries the unread badge, and hides the duplicate bell.
- Notifications carry their own buttons (`actions[]`, derived from the kind); the first is primary.
- A locked machine key (daemon restarted) asks for the password inside the review dialog and carries on.

## 7b. Installed apps in the Store, and second copies (decision 170, v0.32.0)

| Where | Not installed | Installed, copies allowed | Installed, one copy only |
|---|---|---|---|
| Store card / app page | **Install** | **Open** (primary) + **Add another copy…** (outline, its own row) | **Open** only |
| Install page | as before | notice on top (*You already have X. This installs a separate copy with its own data, address and login; the first one is not touched.*) + required name, prefilled from the catalog's `proposedName` | not reachable |
| Home tiles / drawer title | — | the package name, and the instance name on a second line (drawer: `X · name`) when the operator has not renamed it | — |

- Open opens the first copy's address when it runs, else its drawer (Start, Unlock, Repair live there).
- A removed copy (data kept): a copyable app keeps **Install** with a note and *Show the removed copy*; a
  one-copy app offers **Reinstall…** (its drawer) on the card and on its page, never a plan the daemon would refuse.
- A name typed on the install page (the copy notice, or Advanced on a first install) that is taken or malformed
  says why under the field; Install stays greyed out only with that reason on screen (pure checks in
  `web/src/app/copies.ts`, unit-tested).
- No toggle and no extra confirmation: the install page is the confirmation, the label and button style differ
  (never color alone), and the required name is what keeps the copies apart on Home.

## 8. Advanced access, troubleshoot, security (added 2026-09-15, v0.7.0)

Advanced access hosts a real terminal (xterm.js over a WebSocket, shell of the service account), the SSH
forwarding lines (copyable, per app) and the CLI cheat sheet. Troubleshoot shows Harbor's journal and app
container logs. Account gains two-factor login (QR + live code; password to turn off). Overview lets the
operator name the machine; the name is the tab title and the TOTP issuer. Login shows the code field only
after the password was accepted.

## 9. Out of scope now

Multi-user, factory reset, a files app. (Shipped since: notifications bell + Settings section,
app updates UI with rollback, git-source flow, Home widgets, persistent login with a 30-day
remember session, Umbrel-style login hero, one geometric Harbor mark replacing emoji.)
