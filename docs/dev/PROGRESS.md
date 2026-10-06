# Harbor — build progress

Generated during the autonomous build. Authoritative requirements: [TDD.md](../spec/TDD.md); order: [plan.md](../spec/plan.md).
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

## Phase 15 — round 9: notifications, usage, git sources, auto-updates, widgets (2026-09-15, v0.9.0) ✅
- [x] Notifications engine (schema v6 `notifications` + dedupe, ntfy/webhook/email channels, bell + Settings section), per-app usage + storage inventory, git-based app sources with redeploy-on-commit (`build:` trust extension), opt-in auto-updates, Home widgets proxy; decisions 76–82; docs/design/ROUND9.md
- [x] Release automation: push to `main` publishes the GitHub Release via `.github/workflows/release.yml` (no manual `gh release create`)

## Phase 16 — persistent login + console craft pass (2026-09-16, v0.10.0) ✅
- [x] Password-only persistent login: `POST /v1/sessions {remember:true}` → 30-day session, `GET /v1/sessions` + `DELETE /v1/sessions/others`; schema v7; localStorage remember; Umbrel-style login hero; decisions 83–84
- [x] Craft pass: one geometric Harbor mark (`web/src/app/icons.tsx`), palette dots, flat glyphs/monograms/wallpapers, logout only in Settings → Account, `pnpm dev:ui` fixture mode for fast UI iteration
- [x] CI fix: visible Log in button + exact label matches in e2e (eye-toggle aria-label and log-out-others collisions)

## Phase 17 — uninstall, apt resilience, removable media (2026-09-19/20, v0.11.0 → v0.12.0) ✅
- [x] `harbor uninstall` (root, label-only Docker sweep, frees ports), apt-lock retry + keep-existing-admin; decisions 86–87
- [x] Removable media OS-feel (decision 88): lsblk `devices[]` in Places + Settings → Storage, `POST /v1/host/devices/:name/mount|unmount` via `harbor-device-mount@` root oneshot (`/mnt/<label>`, harbor-owned FAT mounts), unmount refused while a `bind` resource lives underneath, observer insert/remove + per-app `storage-missing` notifications (apps keep running, restarts blocked by `DATA_MISSING`), `.harbor-bind.json` marker against wrong-drive-at-same-path, picker 5 s poll + fallback
- [x] Catalog audit: big-data claims already external (Immich library, Nextcloud data, Jellyfin media, Navidrome music, Audiobookshelf audiobooks/podcasts, Open WebUI models); databases stay managed — no manifest changes needed

## Phase 18 — drive guard + auto-mount/auto-start (2026-09-20, v0.12.1 → v0.12.5) ✅
- [x] Drive guard (decisions 89–90): app-generated `driveId` in `.harbor-bind.json` (random at install, kept on restore, fresh on replacement — never a hardware UUID); missing markers refuse; observer verifies folder + marker per tick and submits a `stop` plan through the queue (actor `drive-guard`, one attempt per folder state) with `storage-missing` at error severity; `InstanceSummary.needsDrive {path, purpose, detail}` read-time model (no migration); Start refused with `DATA_MISSING`; `POST /v1/instances/:id/adopt-drive` re-stamps (refused only while containers run); Home "Needs its drive" + drawer banner with "Use this folder instead"
- [x] Auto-mount on insert + auto-start on return (decision 90): one mount attempt per device name (failure notifies once), one start attempt per folder when it verifies clean; `storage.autoMount` / `storage.autoStart` settings (both default true) via `PUT /v1/host/storage/policy` + Settings → Storage toggles; guard stops leave `desired` running (operator stops flip it); resolved notifications delete fully (read rows no longer linger); unit grants `/mnt /media` writes (`ProtectSystem=strict` had silently blocked marker backfills on vfat)
- [x] Fixes along the way: single Removable row (no duplicates), stale-yank hide, picker keeps subfolders, quiet System Volume Information, mount spinner lock, stay-logged-in default, legacy markers verify + backfill, copy trim pass
- [x] Verified live on home-server (physical Ubuntu 24.04.3, PNY USB20FD at `/mnt/usb20fd`, Immich library): 0.12.5 running/healthy, `needsDrive` null, bell clean; see `docs/VERIFICATION.md` §3b

## Phase 19 — install-location + adopt (2026-09-20, v0.13.0) ✅
- [x] Install-location (decision 92): wizard asks where the app lives (system disk vs eligible drive folders from `installCandidates`); drive choice requires an 8+ char passphrase (Generate button) that travels with the submission only (single-use in-memory secret, never in the plan; submit without it fails fast). Runner creates `<dir>/<name>/{manifest.json, vault/}` then roots every managed volume inside as a local-driver bind (`device: <home>/volumes/<claim>`); bare `<mount>/harbor-apps` created on demand, deeper dirs must exist (picker or `mkdir -p`). Plan names the encrypted home + warns about drive/passphrase; review shows a Lives-on row; data folder always eligible (created on first use)
- [x] Adopt-from-drive (decision 92): `GET /v1/found-apps` scans candidates (adopted flagged, not hidden); `POST /v1/found-apps/adopt` unlocks with the passphrase, wraps for this machine, reuses the manifest UUID, allocates ports fresh, starts; display collisions get ` (2)`/` (3)`. Console: Locked tiles/drawer banner, Found-apps section in Settings → Storage. CLI: `install --location --passphrase-stdin`, `plan --location`, `apply --passphrase-stdin`, `found-apps`, `adopt`
- [x] Tests: unit `install-location.test.ts` (4: candidates, non-POSIX refusal, read-only refusal, dedupe/sort) + `openapi.test.ts` route pin (+2 routes); integration `app-homes.test.ts` (10: plan refusals, encrypted plan wording, submit-secret gate, manifest+vault layout, wrong-passphrase refusal, found-apps wiring, adopt conflicts, volume-rooting with fake `device=` log, on-demand apps-folder creation); e2e picker → passphrase → encrypted review → install on the data-folder candidate
- [x] Docs: decision 92, `docs/design/APP_HOMES.md` stages 2–3 marked built, operator guide §4a2, openapi regenerated (70 paths)

## Phase 20 — format a drive as ext4 in place (2026-09-21, v0.14.0) ✅
- [x] Format-as-ext4 (decision 93): `POST /v1/host/devices/:name/format` + `GET …/format-status` reuse the mount oneshot shape (removable-only, `INVALID_STATE` while any app holds the drive — bind folders AND app homes via shared `driveHolders()` — `BUSY` while one runs); template unit now runs `harbor device-dispatch %i` (`TimeoutStartSec=600`) instead of shell `case` text; root step `umount → wipefs -a → mkfs.ext4 -F -L <label≤16> → mkdir + mount at /mnt/<label> → chown harbor`, progress in `format-status.json`. Console: per-drive *Format as ext4…* with erase warning + typed device-name confirm, `Formatting…` spinner lock, `cannot hold apps as-is` row hint, ineligible install-location rows point at Settings → Storage. Fixture mode overlays the format result so e2e proves vfat → ext4 → mounted
- [x] Tests: unit `device-mount.test.ts` (+4: oneshot start, in-use refusal, system-disk refusal, no-systemd hint) + `openapi.test.ts` route pin (+2 routes, 72 paths); e2e typed-confirm → spinner → ext4 + Eject
- [x] Docs: decision 93, operator guide §4a1 format paragraph, FUTURE format half marked built, openapi regenerated (72 paths)

## Phase 21 — default-encrypt + folder-management UX (2026-09-21, v0.15.0) ✅
- [x] Folder management (decision 94): the redundant system-disk `/harbor-apps` candidate is gone (unwritable, polluted `/`); system-disk apps are managed volumes (wizard default, no passphrase) or encrypted in the Harbor data folder. Ineligible install-location rows only suggest Format when the drive is writable; unwritable rows show the reason alone
- [x] Default-encrypt (decision 94): the Harbor data folder seals with Harbor's own key (machine key, already sealed by the login password — no new secrets) — no passphrase to type, silent unlock at login, nothing to remember. Custom passphrase opt-in there (`Use my own passphrase instead…`, portability needs it), required on removable drives. Engine: optional `location.passphrase`, `PlanProposal.location.defaultKey`, `AppHomeDto.defaultKey`, `createAppHome` wraps a Harbor-generated secret when omitted (same envelope, unlock/adopt unchanged), submit pre-seeds `default-key`, runner records it on the home resource, locked default-key drawer says "log in again" (never "type the passphrase"). CLI: passphrase omitted for the data folder
- [x] Inline mount/format where pertinent: install wizard shows unmounted drives (*Mount it*, polled to eligible) + one-click *Format as ext4…* on wrong-filesystem rows (typed confirm); folder picker gains Eject + Format on mounted rows; Found-apps lists unmounted drives with *Mount to see its apps*
- [x] Lock contention (decision 94): exit-18 "Resource temporarily unavailable" / "Device or resource busy" self-retries once in the root step (mount + wipe-after-unmount) and otherwise surfaces a plain-words "wait a few seconds and try again" message instead of a raw exit code
- [x] Tests: unit `install-location.test.ts` (data-folder candidate, no `/harbor-apps`) + `device-mount.test.ts` (+2: busy recognition, friendly message) + `openapi.test.ts` (passphrase optional, 72 paths); integration `app-homes.test.ts` (+1: no-passphrase submit → `defaultKey` unlocked home); e2e silent data-folder install + opt-in passphrase + exact Mount/Eject selectors (25 passed)
- [x] Docs: decision 94, operator guide §4a2 rewritten (default-encrypt, inline mount/format, locked tiles), openapi regenerated (72 paths)

## Phase 22 — format-first on wrong filesystems + FUSE-safe mount unit (2026-09-21, v0.15.1) ✅
- [x] Format-first (decision 95): wrong-filesystem drives (ntfs/vfat/exfat, anything outside the app-capable list) never offer Mount or a passphrase — Settings shows "Mounting won't help" + Format as ext4…, the folder picker shows Format… instead of Mount, the install wizard shows a "needs formatting as ext4" warning with Format + Install disabled until ext4. Mount/format completions auto-select `<mount>/harbor-apps` so the wizard continues straight to the passphrase
- [x] FUSE-safe unit (decision 95): device-mount template unit gains `KillMode=none` — ntfs-3g forks a userspace daemon that the default control-group kill SIGTERMed when the oneshot exited (live on home-server: "mounted at /mnt/usb20fd" → "Unmounting /dev/sdb1"); kernel mounts (ext4) unaffected. Unit text pinned in `systemd.test.ts`
- [x] Fixture order-independence: simulated unmount clears the format overlay so serial e2e tests always start from the vfat shape; storage/install tests reset via Eject first
- [x] Tests: unit 123, integration 123, e2e 25 (wizard Format-first + Settings Format-first + typed-confirm flows)
- [x] Docs: decision 95, operator guide §4a1/§4a2 format-first wording

## Phase 23 — wizard blocks Install on an unmounted-drive folder pick (2026-09-21, v0.15.2) ✅
- [x] Unmounted-drive guard (decision 96): drive matching falls back to the expected `/mnt/<label>` mountpoint when unmounted (a stale empty dir like `/mnt/usb20fd` is still the NTFS drive, not a usable folder). A folder on an unmounted drive shows "plugged in but not mounted — mount it before installing" with *Mount it* and Install disabled until mounted; the wrong-filesystem Format warning takes precedence when both apply
- [x] Tests: unit 123, integration 123, e2e 25 green
- [x] Docs: decision 96

## Phase 24 — two-choice install location with enforced package nesting (2026-09-21, v0.16.0) ✅
- [x] Two radios only (decision 97): Local (Harbor data folder, silent unlock) vs External drive (passphrase, portable); every store install goes through the wizard (no direct-install bypass). The request dir is the package dir (`<candidate>/<packageId>`); the home (`<dir>/<instanceName>/{manifest.json, vault/}`) is created at apply time from the planned name so the unique `-2` suffix never dead-ends planning. Engine enforces the exact package-dir shape, creates it on demand, scans one package level down in found-apps, deletes the home folder on purge (manifest instanceId proves ownership). macOS dev resolves `/var` → `/private/var` once so the wizard spelling matches the daemon
- [x] Tests: unit 124, integration 123, e2e 25 green (Local default, External Format-first + passphrase-after-format, purge-reinstall, upload flow via wizard)
- [x] Docs: decision 97, operator guide §4a2 rewritten (Local vs External, enforced path)

## Phase 25 — gray-out NTFS drives; backfill blank lsblk fstype (2026-09-21, v0.16.1) ✅
- [x] Wizard gray-out (decision 98): wrong-filesystem drive rows are disabled/unselectable with an inline Format-as-ext4 button (offered whenever the drive is known — writability of the wrong FS is irrelevant); the passphrase + enabled Install only appear for the eligible drive. Any ineligible candidate blocks Install, not just "wrong FS but writable"
- [x] lsblk backfill (decision 98): `parseDevices` fills a blank lsblk FSTYPE from /proc/self/mounts by device node — live, the in-place ext4 format left the partition typed W95 FAT32 so lsblk reports null while the kernel says ext4
- [x] Tests: unit 125 (+1 backfill test), e2e 25 green
- [x] Docs: decision 98

## Phase 26 — plain-words drive state, no "Mounting won't help" (2026-09-21, v0.16.2) ✅
- [x] Wording (decision 99): Disks row `Not mounted · 14.4G · ntfs · needs formatting as ext4 before it can hold apps` + action `This drive is ntfs, which can't hold apps — format it as ext4 first.`; wizard hints `Format it as ext4 to use it for apps.` / `This drive is ntfs — apps need ext4 (…)`. Mount state always stated first, never ambiguous
- [x] Tests: unit 125, e2e 25 green
- [x] Docs: decision 99

## Phase 27 — beta Musts + Shoulds (2026-09-21, v0.17.0-beta.1) ✅
- [x] Encryption truth (BETA_TODO Must): per-app fscrypt sealing (v2 policy, raw_key protector = vault master key via root oneshot `harbor app-seal|app-unlock|app-lock` + `device-dispatch crypto-setup`; format `-O encrypt` + `fscrypt setup` in bootstrap; `FakeCryptoProvider` no-op in tests/dev; unlock before `compose up`, lock on reboot/explicit lock). Dual-key homes (format v2: changeable passphrase + immutable 12-word recovery, shown once with write-it-down gate, server returns once). Custom apps stay locked BFU+AFU until explicit Start/unlock; adopt verifies once then leaves locked; unlock/lock routes + drawer form + CLI retry
- [x] Self-update rollback (BETA_TODO Must): snapshot previous release, poll `/healthz` after restart, restore + re-bootstrap on failure, `rolled-back` state in status + guide §4e manual downgrade
- [x] Recovery story (BETA_TODO Must): `harbor recovery export` (state DB + WAL, secrets, releases, uploaded packages, home envelopes; scrypt → AES-256-GCM, passphrase 8+) + `harbor recovery import` (refuses to overwrite); `enroll --reset` requires `--i-understand-data-loss` and destroys the sealed key loudly; guide §4f "If this machine dies" (managed volumes not backed up, data-folder apps need the bundle, drive apps portable via passphrase/adopt)
- [x] Tester plumbing (BETA_TODO Should): `SECURITY.md` (trust boundary, private report path), `.github/ISSUE_TEMPLATE/bug.md` (diagnostics-first), `harbor diagnostics` + `GET /v1/system/diagnostics` (redacted by design: versions, host facts, app states, disks, log tail; no secrets), guide §7 "Report a problem" line
- [x] Docs accuracy + hardware + headless (BETA_TODO Should): README status → beta + headless line, guide §1 RAM/disk floor + heavy-app notes (Immich, Open WebUI+Ollama, Nextcloud), §4a2/§5 headless-reboot plain words (locked until first login; keyfile/TPM = 1.0), §8 format line fixed, AI_CONTEXT versions/counts/next-103
- [x] Tests: unit 139 (fscrypt builders, recovery round-trip, rollback, openapi 75 paths), integration 127 + 3 skipped (app-homes lock/reboot, recovery round-trip onto fresh DB, diagnostics redaction), e2e 25 green
- [x] Docs: decision 101, BETA_TODO ticked, openapi regenerated (75 paths)

## Phase 28 — true at-rest sealing: per-app fscrypt, root-only, mandatory (2026-09-21, v0.17.0-beta.2) ✅
- [x] Root cause of the beta.1 lie: `RootCryptoProvider` spawned `harbor app-seal` as the harbor user → root refusal → `app-home sealing skipped`, install continued unsealed (live: Immich `volumes/` plaintext, Docker-bypass write/read succeeded)
- [x] Root path: polkit-allowed `harbor-app-crypto@<instanceId>:<setup|seal|unlock|lock|status|migrate>` oneshot → `harbor app-crypto` (`src/bootstrap/app-crypto-apply.ts`); daemon writes `request.json` (never the key), streams the key through `key.fifo`, blocks on `systemctl start`, reads `status.json`; root re-validates path allowlist / no symlinks / manifest instance id
- [x] Filesystem: `tune2fs -O encrypt` (mounted ext4, immediate), `/etc/fscrypt.conf`, `fscrypt setup <mount>`, verified via `tune2fs -l` + `fscrypt status`; bootstrap prepares the data folder's filesystem (`per-app encryption ready on / (ext4, /dev/vda1)` in bootstrap-1.log); ext4/f2fs only
- [x] Engine: `createAppHome` creates an empty `volumes/`; install seals it BEFORE rooting volumes and fails hard (home deleted) otherwise; Start kernel-unlocks (machine key / held key) or migrates never-sealed homes in place (rename → seal → `cp -a -T` → verify → delete; rollback); Lock refuses while running; adopt records root `status`; read model = mkdir probe (ENOKEY ⇒ locked); login kernel-unlocks default-key homes; lock-guard auto-starts sealed apps once their key is back
- [x] UX: `AppHomeDto.sealed`, truthful wizard copy ("sealed here with the kernel's own encryption"), Locked banner says ciphertext, drawer Lock button (stopped apps), *Not sealed yet* hint for legacy homes
- [x] Tests: unit 149 (parsers from real droplet output, unit names, allowlist, kernel probe, fake provider, root provider FIFO handoff + failure surfacing), integration 129 + 3 skipped (seal at install, reboot → locked, login unlocks default-key, lock refused while running, stop → lock → start, hard install failure leaves no home, in-place migration at Start), e2e 25 (wizard copy)
- [x] Live (droplet, run vm-2026-09-22T03-30-37): A01 bootstrap re-run, **C01** memos Local install sealed (fscrypt v2, protector `harbor-sealed-demo-…`); Docker bind of the locked dir: ciphertext names, `cat` → `Required key not available`, write fails; Stop → Lock → Start restores; **A09** reboot → app reads Locked with ciphertext names before login, unlocked + healthy after the CLI login
- [x] Docs: decision 103, guide §4a2/§5, APP_HOMES stage 4 built, README status, BETA_TODO correction, AI_CONTEXT map + gotchas, VERIFICATION §3d

## Phase 29 — same password, no retyping (2026-09-21, v0.17.0-beta.3) ✅
- [x] `service.matchesAdminPassword` (scrypt check against the admin hash); install with a custom passphrase, the unlock endpoint, adopt and every login record a machine wrapping (`machineWrapped` + `loginKey`) when the passphrase is the Harbor password — the drive envelope is untouched
- [x] `MachineKeyHolder.onLogin/announceLogin` (every login, not only BFU → AFU) → `service.onLogin(password)`: kernel-unlock machine-wrapped homes, try the login password on locked custom homes, backfill the wrapping; the password is dropped after the call
- [x] `AppHomeDto.silentUnlock`; drawer copy for same-password homes; Lock button visible but disabled (with reason) while the app runs; plan-time Start check + runner accept a machine wrapping as a reachable key
- [x] Tests: integration 131 (+2: same-password install unlocks at login while the other passphrase stays locked, DB rows never contain the password; backfill on login for a pre-existing same-password home), unit 149, e2e 25
- [x] Docs: decision 104, guide §4a2, AI_CONTEXT

## Phase 30 — two recovery scopes: one card per Harbor, plus per-app words (2026-09-22, v0.17.0-beta.4) ✅
- [x] `encryption.installation`: every app home's master key wrapped a third way under the installation's 12-word card, so ONE paper restores every app on a new machine (`src/storage/installation-recovery.ts`, stored only wrapped under the machine key)
- [x] Per-app words now only for homes given a custom passphrase (the hand-over-one-app card); default-key homes carry none. `unlockAppHome` tries passphrase → per-app → Harbor card with one error shape
- [x] Minted at first-run setup (new wizard step, gated on "I wrote it down") or lazily at the first encrypted install for CLI/bootstrap enrollments, shown once in the operation result
- [x] Adopt re-stamps the envelope with the adopting Harbor's card; `POST /v1/account/recovery-key` (password required) replaces it, re-stamps every reachable home and names the unreachable ones; `SecurityDto.recoveryKey` reports the date only
- [x] Fixed a real race: `login` now AWAITS the machine-key unseal, so an install right after login can no longer be created without its machine wrapping
- [x] Tests: unit 157 (installation-recovery round-trip + refusals, three-envelope unlock, adopt re-stamp), integration 137 (card issued once, default-key home has no per-app words, card opens a never-unlocked app, rotation retires the old card, nothing in the clear in the DB), e2e 25 (wizard step + Settings card)
- [x] Docs: decision 105, guide §4a2, AI_CONTEXT, openapi 76 paths

## Phase 31 — a per-app passphrase is always optional (2026-09-22, v0.17.0-beta.5) ✅
- [x] Plan-time validation drops the data-folder condition: an absent or empty `location.passphrase` yields `defaultKey: true` at ANY location, so a removable drive installs with no secret to invent
- [x] Wizard: the External branch gets the same *Use my own passphrase instead…* opt-in as Local, Install enabled without one, 8-character floor still gating once opted in; copy on both branches names the Harbor recovery key as the portable way in
- [x] Plan changes + warnings branch on drive-versus-data-folder AND passphrase-versus-card, so the review step always states how the app opens
- [x] Tests: integration 139 (+2: passphrase-less plan installs and the card opens the home, 8-character floor still enforced), e2e 25 (External offers the opt-in, Install enabled without a passphrase, disabled at 5 characters once opted in), unit 157
- [x] Docs: decision 106, guide §4a2 rewritten, AI_CONTEXT

## Phase 32 — `harbor.local` must survive Harbor's own Docker bridges; the beta ships as 0.17.0 (2026-09-23, v0.17.0) ✅
- [x] Live fault on home-server: `http://harbor.local/` stopped resolving from the Mac while `http://<ip>/` served 200; `avahi-resolve -n harbor.local` on the box returned `172.17.0.1` (Docker bridge) — avahi publishes on every up interface
- [x] `src/bootstrap/mdns.ts`: `defaultRouteInterfaces()` + `avahiConfWithAllowInterfaces()` (pure, idempotent, never empty) + `configureAvahiForLan()` run by LAN-mode bootstrap; always restarts `avahi-daemon.socket` + `.service` together (service-only restart left avahi answering legacy unicast but not standard queries)
- [x] Box fixed live (pinned to `wlp5s0`, full restart): Mac resolves `harbor.local` → 192.168.0.10, HTTP 200
- [x] Tests: unit 163 (+6 mdns: route parsing, rewrite/idempotence/insert/create/empty-list/section-scoped); integration 139, e2e 25 unchanged
- [x] Docs: decision 107, guide §7 troubleshooting row, AI_CONTEXT gotchas (two-ended mDNS diagnosis without Mac sudo)
- [x] Release model (decision 108): version `0.17.0`, no `-beta.N`; the installer and self-update now pick it as newest; `docs/releases/v0.17.0.md` is the release body via `body_path`; pre-0.17.0 and beta.N releases to be withdrawn on Carlos's confirmation

## Phase 33 — LAN HTTPS: `https://harbor.local` with no warning (2026-09-24, v0.17.1) ✅
- [x] Local CA + daemon TLS (decision 109): `src/system/lan-https.ts` (EC P-256 via openssl, CA 10y + server 825d for harbor.local + hostname.local + LAN IPv4, `<stateDir>/tls` 0600, idempotent renew <30d); console on 443 + one reverse proxy per app endpoint on hostPort + 20000 (deterministic, no migration, Docker keeps HTTP binds); plain HTTP :80 kept for the banner; `network.httpsEnabled` setting; observer signature-gated reconcile; routes `GET/PUT /v1/network/https` + open `GET /v1/network/https/ca.crt`; `lanSecure` on every endpoint; `SystemDto.network.https`
- [x] Console: Settings → Network card (toggle, secure address, live trust probe, fingerprint) + trust sheet (Download primary, macOS/iOS/Windows/Android/Linux steps with iOS two-stage, Firefox note) + plain-HTTP banner; app tiles prefer `lanSecure`
- [x] Tests: unit `lan-https.test.ts` (ports/hosts/SAN/endpoint urls) + `openapi.test.ts` route pin (+2 routes, 78 paths); integration `lan-https.test.ts` (off-by-default, LAN-off refusal, mint + open CA + lanSecure + disable); e2e Network card off-by-default + LAN-off note; unit 169, integration 139 + 3 skipped, e2e 26
- [x] Docs: decision 109, operator guide §2a LAN paragraph + §4b Network row, openapi regenerated (78 paths)

## Phase 34 — LAN HTTPS through Caddy when it owns :443 (2026-09-24, v0.17.1) ✅
- [x] Caddy-owns-443 fix (decision 110): `renderCaddyConfig` `lanHttps` option adds the LAN hostnames as a route on the SAME :443 `harbor` server as the public routes (Caddy cannot have two servers on one port), pinned to the Harbor cert (`tls_connection_policies` SNI → `any_tag: harbor-lan` + `apps.tls.certificates.load_files`); ACME coexists with the static cert. `caddyLanHttps` helper + signature in `runner.ts`; observer passes it to the renderer. `reconcileLanHttps` skips the daemon's own 443 console listener when `ctx.caddy.available()` (app proxies on hostPort + 20000 stay daemon-served). Cert access: `tls/` 0750, server cert/key 0640 (group-readable by `harbor`), CA key stays 0600; bootstrap adds the `caddy` user to the `harbor` group (`usermod -aG`) and makes the state dir group-traversable (0710).
- [x] Tests: unit `selfupdate-lan.test.ts` (lanHttps route + cert load_files + public routes intact); integration `lan-https.test.ts` (server cert/key 0640, CA key 0600)
- [x] Docs: decision 110, AI_CONTEXT gotcha + latest-decision, PROGRESS row

## Phase 35 — greeting name, dialog fix, centered wide layout (2026-09-25, v0.17.3) ✅
- [x] Display name (decision 111): optional `account.displayName` setting (settings table, no migration; trim/collapse, 40 chars); `SecurityDto.displayName`, `SetupRequest.displayName`, `PUT /v1/account/name` (set/clear), `harbor account name [name]`; setup wizard asks `What should Home call you?`; Settings → Account card shows greeting vs login name with Set/Change/Clear; Home greets the display name as-is, else the capitalized login name
- [x] Dialog fix: shared `<dialog>` wrapper no longer `close()`s in effect cleanup (StrictMode remount fired it after the second `showModal` and instantly unmounted every dialog); listens for the native `close` event via ref — the Network trust sheet opens again
- [x] Wide layout: `.content` centered (`margin-inline: auto`) with wider caps (1440px ≥1600px, 1600px ≥2000px) instead of pinning left
- [x] Tests: unit `openapi.test.ts` route pin (+1 route, 79 paths); integration `security-terminal.test.ts` (displayName null default, set/clear/validation); unit 170, integration 139 + 3 skipped, e2e 26
- [x] Docs: decision 111, operator guide setup/Account/CLI rows, openapi regenerated (79 paths)

## Phase 36 — supported-distro whitelist + `--force`, tool preflight (2026-09-30, unreleased) ✅
- [x] Distro gate (decision 113): `assertSupportedHost` classifies `/etc/os-release` into supported (Ubuntu 24.04, Debian 12/13) / derived (`ID_LIKE` ubuntu|debian — refuses without `--force`, names it in `nextAction`) / unknown (always refuses); root/x86-64/systemd stay hard, never force-able. `harbor bootstrap --force`; one-line installer `HARBOR_FORCE=1` (mirrors the same whitelist in bash and forwards `--force`)
- [x] Tool preflight (decision 113): `assertRequiredTools` resolves the 15 binaries bootstrap calls that its apt steps do not install (systemctl, useradd/usermod/groupadd, id, getent, chown, dpkg-query, apt-get, hostnamectl, lsb_release, gpg, tar, timeout, cp) via `which()` and fails BEFORE any mutation, naming each missing tool + package
- [x] Bare-name account tools (decision 113): `useradd`/`usermod`/`getent`/`deluser`/`userdel`/`groupdel` resolve through exec's pinned PATH (no shell) — the bin/sbin split stops mattering; bootstrap runs `groupadd --system` before `useradd --gid` so the decision-112 leftover-group reinstall failure cannot recur
- [x] Docker apt repo by distro family (decision 113): `--install-docker` writes `download.docker.com/linux/<ubuntu|debian> <BASE codename>` (`UBUNTU_CODENAME ?? VERSION_CODENAME` — a derivative's own codename has no Docker suite); `HostFacts.docker.aptRepo` carries the computed line into the preview
- [x] Tests: unit `host-gate.test.ts` (distroSupport matrix, force semantics, hard-gate refusals, tool preflight) + `docker-install.test.ts` (family/codename mapping incl. Mint→noble, preview line); unit 187
- [x] Docs: decisions 112 (backfilled) + 113, OPERATOR_GUIDE requirements/bootstrap rows, AI_CONTEXT platform line, install.sh header

## Phase 37 — dismissible notifications (2026-09-30, unreleased) ✅
- [x] Dismiss one / all (decision 114): `DELETE /v1/notifications/:id` and `DELETE /v1/notifications` (both idempotent, both return the fresh `NotificationsDto`); `repo.deleteNotification` + `deleteAllNotifications` DELETE the row (same end state as a resolved condition — a still-true persisting condition re-creates its row on the next observer tick)
- [x] Bell UI (decision 114): each row is body-button + a separate × (fades in on hover/focus, accessible name, focus ring); panel header gains **Dismiss all** next to **Mark all read**; past the 30-row cap a **View all** button opens the full history in the shared StrictMode-safe `<Dialog>`
- [x] Tests: integration `notifications.test.ts` (dismiss one deletes row + drops unread + idempotent; dismiss-all clears + zeroes + idempotent); openapi route pin (`/v1/notifications/{id}`); unit 187, integration 141 + 3 skipped
- [x] Docs: decision 114, OPERATOR_GUIDE "The notification bell" section, openapi regenerated (80 paths)

## Phase 38 — LAN apps know their LAN address (2026-10-03, 0.17.6) ✅
- [x] Found live on the home server: Nextcloud over LAN never loaded — the setup hint's Open link was `http://localhost:18080` (DTO `setup.browserUrl`), and the rendered `OVERWRITEHOST`/`OVERWRITECLIURL` were `localhost:18080`, so even a hand-typed IP would bounce to `localhost` after the web installer
- [x] Engine (decision 115): `primaryUrlFor(..., lanHost)` falls back to the LAN address before loopback; the runner passes `lanAppHost()` (`<hostname>.local`, shared with the DTO's `urls.lan`) when LAN mode is on
- [x] Console (decision 115): the "Finish setup inside the app → Open" link goes through `openUrl()` like the Open button
- [x] Tests: unit `exposure.test.ts` (LAN fallback, published primary still wins); integration `lan-https.test.ts` (LAN-mode install renders `PUBLIC_URL` = `urls.lan`); e2e memos drawer (setup link and Open button agree); unit 189, integration 142 + 3 skipped, e2e 27
- [x] Docs: decision 115, OPERATOR_GUIDE LAN-mode paragraph (incl. `harbor primary <app> loopback` repair for older installs), Nextcloud package README

## Phase 39 — every address at once (2026-10-03, 0.17.7) ✅
- [x] Prototype first (decision 116): nextcloud:34-apache in Docker Desktop with `occ`-set trusted_domains + trusted_proxies and no overwritehost — correct links per path (secure LAN / tailnet / domain via proxy, LAN direct), forged forwarded headers from a LAN device ignored, unknown Host refused
- [x] Engine: Docker `exec` + network gateways; manifest `hooks.afterStart` (schema, validation) run after readiness and after publish/unpublish/main-address change; "this network" main address = secure LAN when on; plan kind `restart` (`compose up --force-recreate`); install `main` (tailnet/public published as primary in one operation); `httpsRequired` gate; `GET /v1/network/addresses`; HTTPS switch `restartToApply` / `breaksWhenOff`; update provisions a newly required admin credential
- [x] Console/CLI: install-wizard "Main address" (only available choices; HTTPS-only apps blocked with the fix named), drawer **Restart**, Network-card restart note + turn-off confirm; `harbor restart <app>`
- [x] Packages: Nextcloud revision 2 (provisioned admin, occ hook, no OVERWRITE*/TRUSTED_* env; qualification pending); n8n and Vaultwarden `httpsRequired: true` (hash refresh only)
- [x] Tests: unit `exposure` (secure main URL, appAuthorities), `manifest` (hooks, httpsRequired); integration `addresses.test.ts` (hook env, failing hook, publish re-runs hook, HTTPS gate + catalog flag, install with tailnet main, LAN HTTPS + Restart re-render, restart refused when stopped); e2e main-address picker + Restart; unit 194, integration 149 + 3 skipped, e2e 27
- [x] Docs: decision 116, OPERATOR_GUIDE "Every address at once" / Restart, DEVELOPER_PACKAGES hooks + httpsRequired, CATALOG design note, Nextcloud README

## Phase 40 — Nextcloud sets itself up from the hook (2026-10-03, 0.17.8) ✅
- [x] Found live (decision 117): a never-set-up revision-1 instance updated to revision 2 skipped the image's auto-install, the hook exited "not installed yet", the web setup page then kept the `localhost` pin. Revision 3's hook runs `occ maintenance:install` with the provisioned admin first; prototyped on nextcloud:34-apache + postgres:17

## Phase 41 — publish through your own proxy (2026-10-03, 0.18.0) ✅
- [x] Decision 118: `via: proxy` exposures (hostname + `proxyFrom`); schema v8 (exposures rebuild); hook gets the hostname and the proxy's IP as a trusted proxy; never primary; LAN mode required; Publish dialog "Your own proxy", `harbor expose --via proxy --host --proxy-from`
- [x] Tests: migration v8 (proxy row, CHECK), integration proxy path (validation, warning with the forward target, hook env, urls.proxy, unexpose)
- [x] DNS: `nextcloud.apein.space` A → the home IP (DigitalOcean)

## Phase 42 — fresh Ubuntu installs Docker again (2026-10-04, 0.18.1) ✅
- [x] Decision 119: fresh-droplet one-liner (0.18.0) failed at `apt-get update` — Ubuntu's `ID_LIKE=debian` picked Docker's Debian repo. `ID=ubuntu` now wins; single `dockerAptRepo`; unit test with the real Ubuntu os-release. Regression window 0.17.5–0.18.0 (only machines without Docker)

## Phase 43 — fresh-droplet acceptance findings (2026-10-04, 0.18.2) ✅
- [x] Fresh droplet, public one-liner: 0.18.0 failed (decision 119, fixed in 0.18.1); 0.18.1 installed cleanly
- [x] `pnpm test:vm -- --fresh --exposure` on 0.18.1 (run vm-2026-10-04T00-56-30): 18 passed, 5 failed, 1 blocked (B02/B03: no tailnet key). C01/A09 = real bug (decision 120: BFU default-key seal, fixed); B09 = runner bug (B05 cleanup withdrew n8n, fixed); B05 = one-off (merge reproduced fine over the public basic-auth address)
- [x] Integration test: remembered session after restart cannot seal (app-homes.test.ts)

## Phase 44 — bring-your-own folders must take the marker (2026-10-04, 0.18.3) ✅
- [x] Decision 121: fresh-droplet qualification — every "external storage" variant was stopped by the drive guard right after install (marker write silently failed outside `ReadWritePaths`). Plan probes writability; install/adopt write the marker or fail; qualifier folders under `/mnt`
- [x] Qualify script: log in before polling `doctor` on a fresh host (it hung 30 min on `system: null`)
- [x] Nextcloud data folder: its hint promised "takes ownership on first start"; with Harbor's automatic setup (revision 2+) Nextcloud instead refuses a world-readable or root-owned folder (503). Hint + README now give `sudo chown 33:harbor … && sudo chmod 0770 …` (uid 33 for Nextcloud, group harbor for the identity marker; Harbor never chowns); the qualifier prepares the folder that way. `33:33` was tried live first and refused by decision 121's probe — the harbor user could not write the marker
- [x] Integration: unwritable folder refused at plan (storage.test.ts)

## Phase 45 — drives that need you (2026-10-04, 0.19.0) ✅
- [x] Decision 122: per-drive `mountedBy` / `attention` / `dismissed` on `GET /v1/host/storage`; `POST /v1/host/devices/:name/takeover` and `/dismiss` (openapi 83 paths); observer bell warning `drive-attention` after 60 s, resolved when fixed/dismissed/unplugged; `NotificationDto.link`
- [x] Root oneshot `takeover` (umount → Harbor mount → udev `UDISKS_AUTO=0` rule); every native-fs mount re-owns Harbor's `.harbor-bind.json` files; markers written 0644
- [x] Console: Home "A drive needs attention" card (Let Harbor manage it / Mount it, ×, Manage drives link); Settings → Storage warning + Let Harbor manage it; bell/notifications follow `link`
- [x] Tests: unit `drive-attention`, `drive-takeover` (udev rule, marker re-own, 0644); integration `drives.test.ts` (classification, 60 s grace, dismiss, takeover, eject); e2e desktop-mounted PHOTOS card → dismiss → Storage takeover; unit 203, integration 156 + 3 skipped, e2e 28
- [x] Live on the Kubuntu home box (0.19.0, 2026-10-04): ext4 stick plugged in unmounted → "USB20FD is plugged in but not mounted" bell after the 60 s grace; KDE mounted it from Dolphin → Let Harbor manage it → mounted at /mnt/usb20fd (harbor-owned), udev rule `90-harbor-drive-<uuid>.rules` written, warning resolved; re-plugged as sdd1 → KDE left it alone, Harbor auto-mounted it at /mnt/usb20fd

## Phase 46 — beta for testers (2026-10-05, 0.19.1) ✅
- [x] Acceptance on 0.19.0, run vm-2026-10-05T01-36-24: 23 pass, 0 fail, 1 blocked (tailnet)
- [x] `docs/releases/v0.19.1.md`: beta notes for testers (what to expect, verified, what not to trust yet)

## Phase 47 — packages may set `command:` (2026-10-04, 0.20.0) ✅
- [x] Decision 123: `command` in the Compose subset as a literal argument array (1–64 strings, string form refused); dollars escaped at render so only a shell inside the container expands them; `entrypoint` stays forbidden
- [x] Tests: unit `manifest` (accept array + shell text, refuse string/empty/non-string, entrypoint still refused), `planner` (rendered with `$$`); integration `packages` (uploaded package with `command` installs, runtime Compose carries it); unit 205, integration 157 + 3 skipped, e2e 28
- [x] Docs: DEVELOPER_PACKAGES §3, AGENTS.md subset, CATALOG.md criteria, release notes `docs/releases/v0.20.0.md`
- [x] First user: the custom ERPNext (git source `carlosalaniz/harbor-erpnext2`) installed on the droplet and the home server, data copied 1:1 — VERIFICATION §3g

## Phase 48 — git build contexts keep git's modes (2026-10-04, 0.20.1) ✅
- [x] Decision 124: the import snapshots a build context with 0644/0755 instead of the daemon's 0077 umask (Docker `COPY` keeps modes; a non-root `USER` could not read copied files)
- [x] Tests: unit `packages-store` (normalisation), integration `git-sources` (fake git now writes owner-only like the daemon; snapshot and instance release are 0644/0755); unit 206, integration 157 + 3 skipped, e2e 28

## Phase 49 — operator-provided secrets + app links (2026-10-05, 0.21.0) ✅ (fake adapter; live run pending)
- [x] Decision 125: `secrets[].source: operator` + `prompt` (`optional`, `minLength`, `maxLength`); plans list what they ask, values ride `POST /v1/operations` `secrets`, checked before the operation exists, held in memory per plan, taken first by the runner; stored/bound/retained like generated secrets; `configure` plan replaces them; CLI `--secret id=@file|id=-` (command-line values refused)
- [x] Decision 126: `links[]` in the consumer manifest; per-link internal network `<project>_link_<id>` created by the runner with Harbor labels (ownership checked), joined only by bound consumer services + the provider's endpoint service (alias `<id>-link`); `links` table (schema v9); provider removal flags the consumer *needs a provider*, consumer removal → dormant → Reinstall revives, Restart re-creates; `configure` plan changes/clears providers; `GET /v1/links`; console picker, review fact, app-page Links, Settings → Internal networks; CLI `--link`, `configure`, `links`
- [x] Tests: unit `links-secrets` (manifest rules, rendering of networks/aliases/env, submission checks, no echo) + `migration` (v9), integration `links-secrets` (value absent from every DTO, plan, event and the SQLite file; reinstall keeps it; configure replaces it; auto-picked provider; only the two services join; restart re-applies; provider removal flags + configure relinks; consumer remove/reinstall/purge; ownership conflict), e2e (link picker, password field, drawer, Internal networks); unit 219, integration 167 + 3 skipped, e2e 29

## Phase 50 — several public hostnames per endpoint (2026-10-05, 0.22.0) ✅ (fake adapter; live run pending)
- [x] Decision 127: `expose --via public` again with another `--host` adds a name (own row, Caddy route, certificate, protection); schema v10 drops `UNIQUE (instance_id, endpoint_id, via)` and adds `instances.primary_host`; `reconfigure {primary, hostname?}` / `harbor primary <app> public --host` picks the main name (default the first published); `unexpose {hostname?}` / `--host` withdraws one, refused without it when there are several; withdrawing the main name hands the main address to the next one; `HARBOR_ADDRESSES` lists all names
- [x] Console: Publish… lists each public name with its own Withdraw / Make primary, **Add another domain**; the drawer lists every name
- [x] Tests: unit `exposure` (main-name selection, urls, authorities, two Caddy routes to one upstream) + `migration` (v9 → v10 keeps rows and order, allows a second public row, keeps addresses unique), integration `multi-domain` (expose twice, both Caddy routes, hook env lists both, refusals, primary `--host`, withdraw one keeps the other, main hand-over, remove withdraws all), e2e publish wizard (Add another domain, withdraw one by name); unit 222, integration 172 + 3 skipped, e2e 29

## Test results (latest local run)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (unit) | 222 passed (2026-10-05, 0.22.0) |
| `pnpm test:integration` (fake adapter) | 172 passed (several public hostnames per endpoint, links + operator secrets, install, lifecycle, auth incl. remember/sessions, tools, exposure, storage incl. drive guard + auto-start + policy, app-homes install-location + adopt, settings, purge/domains, appearance, packages/updates, git sources, notifications, security/terminal, setup/LAN/self-update, lan-https); 3 live-Docker tests skipped without opt-in |
| `HARBOR_LIVE_DOCKER_SOCKET=… pnpm test:integration` (Docker Desktop, opt-in) | 3 passed (real Compose/Dockerode path) |
| `pnpm test:e2e` (Playwright, fake adapter) | 29 passed (publish wizard incl. Add another domain + withdraw one by name, app links + typed-in secret, console: login, store, install wizard incl. Local default + External Format-first + passphrase-after-format, drawer lifecycle, publish wizard, phone width, own folder, settings incl. storage Format-first + format-as-ext4, network secure-addresses card, uninstall incl. purge-reinstall, domains + palette, customize, arrange, rotating wallpapers, upload + update via wizard, terminal/troubleshoot/rename, two-factor, Harbor update card + default login; first-run wizard against a setup-mode daemon) |
| CLI smoke (`pnpm dev` + CLI, fake adapter) | login, catalog, install, stop, start, remove, reinstall, second instance, logout — exit codes as documented |
| Live VM (manual, 2026-09-14) | bootstrap with Docker install + tools; Excalidraw/BentoPDF/n8n installed; browser demos (draw+export, merge, n8n owner+workflow) — docs/evidence/manual-2026-09-14 |
| `pnpm test:vm -- --fresh` (2026-09-14, run vm-2026-09-14T18-40-00) | **A01–A16: 16 passed, 0 failed** on a freshly rebuilt Ubuntu 24.04.4 x86-64 droplet, including host reboot |
| `pnpm test:vm -- --fresh --exposure` (2026-09-15, run vm-2026-09-15T01-01-08) | **23 checks: 22 passed, 1 blocked (tailnet), 0 failed** with the console and the 17-package catalog |
| `node scripts/vm/qualify-catalog.mjs --fresh` (2026-09-15) | **17/17 packages passed**, incl. 6 bring-your-own-folder variants (23/23 steps) |
| `pnpm test:vm -- --only A01,C01,A09` (2026-09-21, run vm-2026-09-22T03-30-37) | **3 passed**: per-app sealing proven with a Docker bypass (ciphertext + ENOKEY while locked), reboot re-locks, login unlocks |

## Blockers
None. The repository is public since 2026-09-15 (decision 75), after a `git filter-repo` history rewrite purged the credential-looking test fixtures that secret scanning had flagged. Unauthenticated `install.sh` and release downloads verified.

## Status
**Delivered and merged.** MVP tagged `v0.1.0-mvp`; `v0.2.0` adds publishing, the console, external storage and the 17-package catalog; `v0.3.0` adds the launcher, the self-service Settings (password, Tailscale, storage with a folder picker, appearance) and the Harbor data folder; `v0.4.0` adds full uninstall, the public-domains wizard, connected-service details, wallpaper upload and the ⌘K palette; `v0.5.0` adds rotating wallpapers (Bing / Wikimedia / Reddit with the operator's key), per-app names and icons, drag-to-arrange, the Settings Overview with Restart/Shut down, and the macOS-style visual pass; `v0.6.0` adds your own apps (package zip upload with digest pinning) and app updates with automatic rollback (both verified live on the droplet against Docker Hub); `v0.7.0` adds a terminal, troubleshoot logs, two-factor login, the device name and the Tailscale re-login self-heal; `v0.8.x` adds the one-line installer, the browser setup wizard, LAN mode with mDNS, Harbor self-update from GitHub Releases and the default-login field (verified on a brand-new droplet); `v0.9.0` adds notifications, per-app usage, git sources, auto-updates and Home widgets with automatic release publishing on merge; `v0.10.0` adds password-only persistent login (30-day remember), the Umbrel-style login hero and the console craft pass; `v0.11.0` adds `harbor uninstall`, apt-lock retry and keep-existing-admin; `v0.12.0` adds removable-media mount/unmount with insert/remove + storage-missing notifications and the bind marker; `v0.12.1–v0.12.2` fix duplicates, stale mounts, picker subfolders, mount spinner; `v0.12.3–v0.12.5` add the drive guard (app-generated identity, auto-stop, adopt, needs-drive UI), auto-mount/auto-start with policy toggles, and the `/mnt /media` sandbox fix; `v0.13.0` adds install-location + adopt (whole encrypted apps on drives, portable via passphrase); `v0.14.0` adds format-as-ext4 in place (typed confirm, refused while an app uses the drive). Automated suites green (unit 120, integration 122, e2e 25); every catalog package qualified live.

## Exact next step
None pending. The public paths are proven live on `harbor-test-3` (public one-liner install of 0.8.1, wizard, console self-update 0.8.1 → 0.8.2 from the GitHub feed; evidence `docs/evidence/install-2026-09-15-public/`). Droplets (~$0.07/h each): `harbor-test` (Carlos's, Harbor 0.7.0, logged out of the tailnet), `harbor-test-2` (0.8.1, LAN mode, admin `carlos`), `harbor-test-3` (0.8.2, public-path proof, admin `carlos`); destroy the disposable ones with `HARBOR_VM_NAME=<name> HARBOR_VM_STATE=.vmN.local.json node scripts/vm/do-vm.mjs destroy --yes` when done.
