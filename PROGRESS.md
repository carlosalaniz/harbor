# Harbor — build progress

Generated during the autonomous build. Authoritative requirements: [TDD.md](TDD.md); order: [plan.md](plan.md).
Decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Live evidence: [docs/VERIFICATION.md](docs/VERIFICATION.md) (written in Phase 5).

## Environment facts (recorded 2026-09-14)

| Item | Value |
|---|---|
| Build host | macOS 26.2, Apple Silicon (arm64), Node v24.12.0, pnpm 10.16.1, TypeScript 5.9.3, Docker Desktop 29.2.1 / Compose v5.1.0 (dev-loop only) |
| Designated live test VM | DigitalOcean droplet `harbor-test` (tag `harbor-test`), `s-4vcpu-8gb`, image `ubuntu-24-04-x64`, region sfo3, **Ubuntu 24.04.4 LTS x86_64, systemd 255, no Docker/Node/npm preinstalled**. Controlled by `scripts/vm/do-vm.mjs` (create/rebuild/reboot/destroy). Authorized by the user on 2026-09-14. |
| Why not Vagrant on the build host | No hypervisor for x86-64 guests on Apple Silicon (only slow QEMU emulation). The required `Vagrantfile` is still generated for x86-64 hosts; `pnpm test:vm` accepts either target. |
| Secrets handling | DO token only in `.env.vm.local` (git-ignored, 0600). Never in logs/docs. Droplet costs ~$0.07/h while it exists; destroy with `node scripts/vm/do-vm.mjs destroy --yes`. |

## Phase checklist

### Phase 0 — buildable skeleton ✅ (2026-09-14)
- [x] Node 24 / pnpm pinned (`packageManager`, `engines`), strict TS ESM, lockfile, ESLint, Vitest (unit + integration projects), typecheck, build scripts
- [x] Strict contracts: manifest JSON Schema 2020-12, Compose source subset schema, release inventory, catalog index
- [x] Restricted YAML parser (256 KiB, depth 32, one document, no aliases/anchors/tags/merge keys, unique keys, plain decimals only, string keys)
- [x] Excalidraw package with **real digest** `excalidraw/excalidraw@sha256:f7ee194a…` (tag `latest` at 2026-09-14; upstream publishes no version tags) — qualification `pending` until live VM run
- [x] SQLite state (WAL, synchronous=FULL, FK, schema v1), explicit `init`, corrupt/missing state = error, singleton lock
- [x] scrypt (N=131072,r=8,p=1, maxmem 256 MiB, serialized), bearer sessions (sha256 hashes, 12 h), login rate limit
- [x] `/healthz`, sessions, system, catalog; Host/Origin/Sec-Fetch-Site/content-type guards, 256 KiB body limit
- [x] CLI `login/logout/catalog/doctor/init/enroll` (hidden prompts, `--password-stdin`, token 0600)
- [x] `Vagrantfile` (bento/ubuntu-24.04 202510.26.0, 2 CPU/4 GiB, loopback forwards 18000, 18080-18085)
- Exit: build/typecheck/unit pass; CLI connects, authenticates and lists bundled packages. Nothing pretends to be installed.

### Phase 1 — one real app end-to-end ✅ engine (fake adapter) / ⏳ live checkpoint
- [x] Package loader + hash verification before plan and apply; release snapshot per instance
- [x] Stable UUID identity, `hb_<uuid>` project, lowest-free loopback ports (stored claims + Docker bindings + real bind probe), name proposal
- [x] Immutable plans (15 min), atomic submission with name/port claims, idempotency key semantics (same→same op, different→409, consumed plan→409 with operationId)
- [x] Serial daemon queue, phases `preparing→pulling→starting→checking`, events, recorded owned container/network IDs, labels `io.harbor.preview/*`
- [x] Readiness: verifies the container publishes 127.0.0.1:<port>→containerPort before probing; 2 s retry until manifest deadline; failure keeps resources (`READINESS_TIMEOUT`, Remove offered)
- [x] CLI `plan/apply/install/list/inspect/operation/start/stop/remove/reinstall/tools`
- [x] Tests: expired plan, stale port claim, occupied external port untouched, readiness timeout, client disconnect, idempotency (tests/integration/install.test.ts)
- [ ] **Live checkpoint on the VM** (install Excalidraw, draw, export) — after Phase 4 bootstrap exists (needs Docker on the VM, which bootstrap installs)

### Phase 2 — two apps + minimal UI ✅ (2026-09-14)
- [x] BentoPDF package with real digest `ghcr.io/alam00000/bentopdf-simple@sha256:3d62b8f8…` (v2.8.8)
- [x] start/stop/remove/reinstall generic; coexistence, second instance, sentinel non-interference, restart→needs_action, Docker-down tests (tests/integration/lifecycle.test.ts)
- [x] Auth/request-control tests (tests/integration/auth.test.ts)
- [x] React UI (login, Installed, Available, System, Platform tools; in-memory token; strict CSP) + 7 Playwright e2e tests
- [x] OpenAPI generated from route schemas (docs/openapi.json) and tested
- [x] Live checkpoint (dev loop, authorized Docker Desktop): real install/stop/start/remove/reinstall of Excalidraw + BentoPDF coexistence (tests/integration/live-docker.test.ts)

### Phase 3 — n8n + PostgreSQL ✅ (2026-09-14)
- [x] Package with real digests: n8n 2.38.7 (= `stable` tag) `sha256:a8c95f75…`, postgres 16.15 `sha256:f1c3376c…`; telemetry disabled
- [x] Generic volumes/secrets/configuration engine proven with a synthetic stateful package (same values across bindings, different across instances, no leakage, DATA_MISSING/SECRET_MISSING block without replacement, retention across stop/start/remove/reinstall)
- [x] Live on the VM: n8n installed, readiness via /healthz/readiness, owner created in the browser, credential + workflow via REST, credentialed execution succeeded against a fixture endpoint

### Phase 4 — bootstrap + tools ✅ (2026-09-14)
- [x] Release archive (`pnpm package`): bundled Node 24.12.0 (checksum-verified), hoisted prod deps, shipped better-sqlite3 linux-x64 prebuild, launchers, SHA256SUMS
- [x] Root bootstrap: host checks, approved Docker install, /opt /etc /var/lib layout, `harbor` user in docker group, explicit state init, hidden/stdin enrollment, hardened systemd unit, idempotent re-run, conflict detection
- [x] Cockpit (loopback socket drop-in or bind existing) and Portainer CE 2.39.7 (loopback HTTPS, retained volume) recipes; tools bind/unbind API + CLI; Portainer admin check
- [x] Live on the VM: bootstrap from the archive on a fresh Ubuntu 24.04 x86-64 host installed Docker 29.8.0 / Compose 5.5.1, Harbor, Cockpit (127.0.0.1:9090) and Portainer (127.0.0.1:9443); all listeners loopback-only

### Phase 5 — full demo + report ✅ (2026-09-14)
- [x] `pnpm test:vm` runner (scripts/vm/run-vm-tests.mjs): A01–A16 with evidence directory, DigitalOcean or Vagrant target, fresh rebuild, reboot via cloud API, browser steps (Excalidraw export, BentoPDF merge, n8n owner/workflow, Cockpit login, Portainer onboarding)
- [x] Full `--fresh` run **vm-2026-09-14T18-40-00: 16/16 passed** — recorded in docs/VERIFICATION.md and docs/evidence/vm-2026-09-14T18-40-00/
- [x] Package qualification set to `passed` (Docker 29.8.0, Compose 5.5.1, Node v24.12.0, Ubuntu 24.04.4 x86_64); archive rebuilt with the qualified inventories
- [x] Context-only architecture check (plan §11) documented in docs/FUTURE.md; no code change needed
- Bugs found only by the live suite and fixed: bootstrap re-run over existing release (EEXIST on symlinks); `harbor.service` `Requires=docker` stopped Harbor with Docker (now `Wants=`); CLI `--json` printed two documents on failed operations; Portainer 2.39 setup-token onboarding documented and automated

## Phase 6 — exposure (branch `exposure`, 2026-09-14) ✅
- [x] Design addendum docs/design/EXPOSURE.md (tailnet via Tailscale serve, public via Caddy; no package hooks)
- [x] Schema v2 + migration; `expose`/`unexpose`/`reconfigure` plan kinds through the same queue; primary address per instance re-renders `configuration` bindings
- [x] Providers: Tailscale CLI + Caddy admin API clients with fakes; HTTPS verifier; observer re-checks exposures
- [x] Bootstrap `--with-tailscale [--tailscale-authkey-stdin]`, `--with-public-proxy`; tool cards for both
- [x] CLI `expose/unexpose/exposures/primary`, `expose --ui --via tailnet`; console Publishing page and publish wizard
- [x] Tests: 9 exposure integration tests, unit tests (renderer, URLs, migration), Playwright publish flow
- [x] Live B-matrix: run vm-2026-09-14T23-19-02 (fresh, `--exposure`): A01–A16 all passed again; B01, B05, B07 passed; B04/B09/B10 failed for runner reasons (a stray placeholder call, a cascaded state, an SSH banner timeout). Run vm-2026-09-14T23-36-24 (`--only B04,B05,B07,B10,B09` after the fixes): B04 public n8n as primary over Let's Encrypt, B05 basic-auth BentoPDF, B07 provider outage/recovery, B09 back to loopback and route withdrawal all **passed**; B10 fixed afterwards (it must use instances that are not yet published) and re-runs with the final fresh run
- [x] Tailnet enrollment live with Carlos's auth key (run vm-2026-09-15T03-57-13, B01 passed; two bootstrap bugs fixed on the way, decision 45)
- [x] B02/B03 (tailnet exposure) **passed live** (run vm-2026-09-15T04-20-57) after Carlos enabled MagicDNS + HTTPS: Excalidraw and the Harbor console reachable over the tailnet name with tailnet certificates

## Phase 7 — console (2026-09-14) ✅
- [x] docs/design/UI.md: Umbrel/HexOS-inspired information architecture
- [x] Package `presentation` metadata (tagline, category, icon, gallery, developer, website, release notes) with hashed assets; `GET /v1/catalog/{id}/asset/{name}` (open, sandboxed SVG CSP); `GET /v1/system/metrics`
- [x] New console: Home (system strip, app tiles, attention list), App Store (cards, categories, search, app page), Publishing, Platform, Settings; app drawer; install/publish wizards over the same plan → approve → operation flow; operation tray with one-time credentials; phone layout (bottom tabs); dark by default
- [x] Playwright suite rewritten (10 tests incl. phone viewport and own-folder flow); VM runner selectors updated
- [x] Polish pass for humans (decision 44): greeting + status line, popular picks on first run, app names on tiles, pressure-coloured meters, human-first plan review with collapsed steps, tray with Open + next step, theme choice

## Phase 8 — one-click catalog + bring your own folder (2026-09-14/15) ✅
- [x] docs/design/CATALOG.md; decisions 39–43
- [x] External storage: manifest `storage[].external`, install request `storage`, plan-time validation (denylist, existence, overlap), bind-mount rendering, `bind` resources, reinstall/start verification, schema v3 migration, CLI `--storage claim=/path`, console choice per claim; 6 integration + 8 unit tests
- [x] `configuration[].format` (url/origin/authority/host/scheme); mixed-case env keys
- [x] 14 new packages pinned by digest with `scripts/catalog-pin.mjs` (Open WebUI+Ollama, AnythingLLM, Jellyfin, Immich, Nextcloud, Vaultwarden, Uptime Kuma, Forgejo, FreshRSS, Actual, Audiobookshelf, Navidrome, Memos, Mealie); all 17 load and validate (`pnpm tsx scripts/catalog-verify.ts`)
- [x] Live qualification of all 17 on a fresh droplet (`scripts/vm/qualify-catalog.mjs --fresh`): runs catalog-2026-09-15T00-13-13 (15/17 + all folder variants), 00-40-44 and 00-42-58 (Jellyfin and Uptime Kuma after fixes: Uptime Kuma redirects to /setup on first run; the script needed probe retries and per-run folder names) → **17/17 passed**, recorded in every release.json and docs/VERIFICATION.md
- [x] Final fresh acceptance run with the console and the enlarged catalog: **vm-2026-09-15T01-01-08 — A01–A16 all passed, exposure B-matrix passed (public path), B02/B03 blocked without a Tailscale key**
- [x] Merged `exposure` → `main` via pull request #1 (2026-09-14); tagged `v0.2.0`

## Phase 9 — settings for humans, launcher, folder picker (2026-09-15) ✅
- [x] API: change password, host storage (disks, data folder, folders in use), folder listing/creation, Tailscale login (browser URL or key) and logout; CLI `account set-password`, `tailscale login|logout`, `storage`
- [x] Bootstrap creates the Harbor data folder `/srv/harbor` (service account); config `userDataDir`
- [x] Console: Home is a launcher (icons, status dots, "⋯"), Settings with Account / Remote access / Public addresses / Storage / Appearance (theme + wallpaper) / Advanced access / About, folder picker in the install page
- [x] Tests: unit (mounts parsing, folder listing/creation), integration (password change + session revocation, storage endpoints + picker-created folder used by an install, Tailscale login/logout with the fake), Playwright (picker flow, settings flows)
- [x] Live: droplet re-bootstrapped with the new build (`v0.3.0`); `harbor storage` shows the data folder ready and one system disk; Settings shows the enrolled tailnet node (a systemd `ReadWritePaths` gap for `/srv/harbor` was found and fixed on the way)

## Phase 10 — full uninstall, domains wizard, palette, wallpapers (2026-09-15) ✅
- [x] `purge` plan kind (schema v4: `instances.purged_at`), volume ownership verified before deletion, folders untouched, name/ports freed, audit rows kept; console typed confirmation; CLI `harbor purge`
- [x] Domains: `/v1/domains` (public IP detection, DNS judgement, used-by), publish wizard offers registered domains, plan warnings reflect DNS state; Settings → Public addresses is a 3-step wizard; CLI `harbor domains`
- [x] Tailscale card: tailnet IPs, key expiry, admin console link; auth key explained as single-use
- [x] Wallpaper upload (`/v1/appearance/wallpaper`), presets, 'My picture'; Spotlight palette (⌘K, `/`); Launchpad-style Home; Settings sections addressable (`#/settings/<section>`)
- [x] Tests: unit (DNS judgement, migration to v4), integration (purge incl. foreign volume guard, domains lifecycle, wallpaper), Playwright (uninstall flow, domains wizard + publish dropdown, palette)

## Phase 11 — personal launcher, rotating wallpapers, the machine (2026-09-15, v0.5.0) ✅
- [x] Schema v5: `settings` table, `instances.display_name` / `icon_json`; in-place migration
- [x] Rotating wallpapers fetched by the daemon (`src/appearance`): Bing (default, keyless), Wikimedia Commons (keyless), Reddit (operator's app key; anonymous JSON is 403 since May 2026), schedule + skip, attribution on Home; served at the open wallpaper route with cache-busting versions
- [x] Per-app look: display name + icon (default / emoji-on-colour / picture), `PUT /v1/instances/{id}/appearance`, `GET /v1/instances/{id}/icon`; launcher order `PUT /v1/appearance/home`
- [x] Drag-to-arrange (mouse, touch hold, Arrange mode with keyboard), FLIP transitions, slot-based hit testing
- [x] Settings → Overview (device card, power, machine facts, vitals, wallpaper picker); Restart/Shut down via logind + polkit rule installed by bootstrap; `GET /v1/system/host`, `POST /v1/system/power`
- [x] Visual pass (macOS cues): translucent materials, tokens, segmented controls, switches, lock-screen clock
- [x] CLI: `harbor wallpaper [set|next]`, `harbor look`, `harbor power restart|shutdown`
- [x] Tests: unit (sources, polkit rule, host facts, migration v5, OpenAPI routes), integration (rotation lifecycle, Reddit credentials, order/look/purge cleanup, power), Playwright (customize, drag + keyboard arrange, rotation + Reddit key, overview + restart confirm)

## Phase 12 — your own apps and updates (2026-09-15, v0.6.0) ✅
- [x] `PackageStore` (bundled + uploaded), strict zip reader, registry resolver (tag → digest at upload), generated release.json, revision rules; `POST/DELETE /v1/packages`; App Store upload dialog with pin report; *Your apps* filter and badge; CLI `harbor packages [add|remove]`
- [x] `update` plan kind: identity kept, new claims created, images swapped, `release-previous/` + automatic rollback; `updateAvailable` on instances; Home updates card, tile ↑ badge, drawer banner, plan review facts; CLI `harbor update`, `harbor list` UPDATE column
- [x] Manifest `release.version`; catalog `origin`/`version`
- [x] Tests: unit (zip incl. zip-slip/CRC, image refs, revisions, store import rules), integration (upload → install → update with kept port/exposure → failed update rolls back → added volume/endpoint → remove; bundled revision bump shows an update), Playwright (upload + update from the console)
- [x] docs/DEVELOPER_PACKAGES.md (template + rules), operator guide 4d, decisions 60–63

## Phase 13 — advanced access, troubleshoot, two-factor, Tailscale self-heal (2026-09-15, v0.7.0) ✅
- [x] Tailscale: `harbor-tailscale-operator.service` oneshot + polkit start grant; daemon restores the operator before login / after logout; clear next action on old installs
- [x] Terminal: `/v1/terminal` WebSocket (first-message auth), Python pty bridge, xterm.js UI, idle timeout, 4 sessions max
- [x] Troubleshoot: `GET /v1/logs/harbor` (journal or memory), `GET /v1/instances/{id}/logs` (docker), unit joins `systemd-journal`
- [x] Two-factor login: TOTP setup/enable/disable, `TOTP_REQUIRED` on login, replay refusal, CLI `login --code`, `account totp …`, local `totp reset`
- [x] Device name: `PUT /v1/system/name`, Overview rename, tab title, `harbor name`
- [x] Advanced access page redesigned (no overflow, copy buttons, per-app ports, CLI list); CLI `harbor logs [app]`
- [x] Tests: unit (RFC 6238 vectors, base32, systemd/polkit text, docker log demux), integration (2FA lifecycle, logs, terminal echo + resize over WebSocket), Playwright (terminal, troubleshoot, rename, 2FA login)

## Phase 14 — one-line install, browser setup wizard, LAN mode, Harbor self-update, default logins (2026-09-15, v0.8.0) ✅
- [x] GitHub Releases published (v0.7.0 first); `install.sh` at the repo root (`curl … | sudo bash`): checks, Docker, checksum-verified download, hostname `harbor`, avahi/mDNS, `bootstrap --setup-in-browser`
- [x] First-run wizard: `GET/POST /v1/setup` guarded by a printed setup code; console shows name → account → look; `harbor setup-code`
- [x] LAN mode (`config.lan`, `bootstrap --lan/--lan-force/--hostname`): second listener on every interface (port 80, ambient cap), app ports on 0.0.0.0, `urls.lan`, LAN-aware Host/Origin checks, console swaps in the host it was opened with; refused on cloud servers without `--lan-force`
- [x] Harbor self-update: GitHub feed (6 h + Check now), `POST /v1/system/update/apply` → `harbor-self-update@<version>.service` (polkit) → root `harbor self-update apply` (download, SHA256SUMS, bootstrap --yes), progress file survives the restart; Overview card with release notes; CLI `harbor self-update [check|start]`
- [x] Manifest `defaultCredentials` → Store page, drawer and plan warning
- [x] Tests: unit (release feed, version order, LAN host rules, setup code, systemd/polkit text), integration (setup flow, LAN mode Host/Origin + 0.0.0.0 render, self-update lifecycle), Playwright (first-run wizard in a second daemon, update card, default login)

## Test results (latest local run)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (unit) | 80 passed |
| `pnpm test:integration` (fake adapter) | 76 passed (install, lifecycle, auth, tools, exposure, storage, settings, purge/domains, appearance, packages/updates, security/terminal, setup/LAN/self-update); 3 live-Docker tests skipped without opt-in |
| `HARBOR_LIVE_DOCKER_SOCKET=… pnpm test:integration` (Docker Desktop, opt-in) | 3 passed (real Compose/Dockerode path) |
| `pnpm test:e2e` (Playwright, fake adapter) | 21 passed (console: login, store, install wizard, drawer lifecycle, publish wizard, phone width, own folder, settings, uninstall, domains + palette, customize, arrange, rotating wallpapers, upload + update, terminal/troubleshoot/rename, two-factor, Harbor update card + default login; first-run wizard against a setup-mode daemon) |
| CLI smoke (`pnpm dev` + CLI, fake adapter) | login, catalog, install, stop, start, remove, reinstall, second instance, logout — exit codes as documented |
| Live VM (manual, 2026-09-14) | bootstrap with Docker install + tools; Excalidraw/BentoPDF/n8n installed; browser demos (draw+export, merge, n8n owner+workflow) — docs/evidence/manual-2026-09-14 |
| `pnpm test:vm -- --fresh` (2026-09-14, run vm-2026-09-14T18-40-00) | **A01–A16: 16 passed, 0 failed** on a freshly rebuilt Ubuntu 24.04.4 x86-64 droplet, including host reboot |
| `pnpm test:vm -- --fresh --exposure` (2026-09-15, run vm-2026-09-15T01-01-08) | **23 checks: 22 passed, 1 blocked (tailnet), 0 failed** with the console and the 17-package catalog |
| `node scripts/vm/qualify-catalog.mjs --fresh` (2026-09-15) | **17/17 packages passed**, incl. 6 bring-your-own-folder variants (23/23 steps) |

## Blockers
None. The repository is public since 2026-09-15 (decision 75), after a `git filter-repo` history rewrite purged the credential-looking test fixtures that secret scanning had flagged. Unauthenticated `install.sh` and release downloads verified.

## Status
**Delivered and merged.** MVP tagged `v0.1.0-mvp`; `v0.2.0` adds publishing, the console, external storage and the 17-package catalog; `v0.3.0` adds the launcher, the self-service Settings (password, Tailscale, storage with a folder picker, appearance) and the Harbor data folder; `v0.4.0` adds full uninstall, the public-domains wizard, connected-service details, wallpaper upload and the ⌘K palette; `v0.5.0` adds rotating wallpapers (Bing / Wikimedia / Reddit with the operator's key), per-app names and icons, drag-to-arrange, the Settings Overview with Restart/Shut down, and the macOS-style visual pass; `v0.6.0` adds your own apps (package zip upload with digest pinning) and app updates with automatic rollback (both verified live on the droplet against Docker Hub); `v0.7.0` adds a terminal, troubleshoot logs, two-factor login, the device name and the Tailscale re-login self-heal; `v0.8.x` adds the one-line installer, the browser setup wizard, LAN mode with mDNS, Harbor self-update from GitHub Releases and the default-login field (verified on a brand-new droplet). `main` holds publishing (tailnet/public), the console, external storage and the 17-package catalog. Automated suites green; final fresh live run passed everything that can run without a Tailscale key; every catalog package qualified live.

## Exact next step
Re-run `install.sh` from the public URL on a fresh droplet and the console self-update 0.8.1 → next release (publish v0.8.2 first). Two droplets exist (~$0.07/h each): `harbor-test` (Carlos's, Harbor 0.7.0, logged out of the tailnet) and `harbor-test-2` (fresh install test, Harbor 0.8.1, LAN mode, admin `carlos`); destroy the second with `HARBOR_VM_NAME=harbor-test-2 HARBOR_VM_STATE=.vm2.local.json node scripts/vm/do-vm.mjs destroy --yes` when done.
