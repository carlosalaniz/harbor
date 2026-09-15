# Harbor — working context for an AI continuing this project

Written 2026-09-15 at the end of a long build session so the next session (or a fresh model context) can
pick up without re-reading the transcript. Facts here were true when written; verify anything with a
date or a version before relying on it. Authoritative documents are linked; this file is the map.

## 1. What Harbor is, in one paragraph

A self-hosted application manager ("a private cloud for humans", Umbrel/HexOS-like but simpler): one
Ubuntu 24.04 x86-64 machine, one administrator, apps installed from a catalog of data-only packages
(manifest + Compose subset pinned by image digest), a React console with a launcher home screen, and
three ways to reach apps: loopback (always), LAN mode (`http://harbor.local`, opt-in at install),
Tailscale tailnet, and public HTTPS via Caddy + Let's Encrypt. Everything a user can do in the console
is also a `harbor` CLI command against the same local API. Owner/user: Carlos (carlos.alaniz@playlist.com).

## 2. Where things are

| Need | Look at |
|---|---|
| Requirements and original scope | `TDD.md` (spec), `plan.md` (build order). Several exclusions in TDD were later lifted at Carlos's explicit request; each lift is a numbered decision. |
| Every design decision, numbered (1–75 so far) | `docs/DECISIONS.md` — **next number is 76**. Add a row for every non-obvious choice. |
| Phase-by-phase progress, test counts, blockers, exact next step | `PROGRESS.md` (phases 0–14) |
| What was verified live and how | `docs/VERIFICATION.md` (sections per version) + `docs/evidence/<dir>/` (screenshots/logs; VM IPs redacted as `<ip>`) |
| Operator-facing manual | `docs/OPERATOR_GUIDE.md` (sections 2a one-line install, 4a–4e settings/own apps/updates) |
| How to write a package | `docs/DEVELOPER_PACKAGES.md` |
| Design addenda | `docs/design/UI.md`, `docs/design/CATALOG.md`, `docs/design/EXPOSURE.md` |
| Deliberately not built | `docs/FUTURE.md` |
| Generated API description | `docs/openapi.json` (`pnpm openapi`; unit test asserts the exact route list — update `tests/unit/openapi.test.ts` when adding routes) |
| Persistent memory (Claude Code auto-memory) | `~/.claude/projects/-Users-carlos-Documents-devshit-harbor/memory/` (`harbor-project-context.md`, `user-working-style.md`) |

## 3. Repository layout (TypeScript strict ESM, Node 24.12, pnpm 10.16)

```
src/
  daemon.ts            wiring: adapters, providers, services, listeners (also demo fakes for fake mode)
  config.ts            DaemonConfig (stateDir, catalogDir, userDataDir=/srv/harbor, localPackagesDir, lan{enabled,port}, updates{repo}, listen 127.0.0.1:18000)
  api/server.ts        Fastify routes; Host/Origin guards (loopback, tailnet UI exposure, LAN rules); WebSocket /v1/terminal
  auth/                scrypt passwords, bearer sessions (sessions.ts incl. TOTP), setup.ts (first-run claim with setup code), totp.ts
  lifecycle/           service.ts (plans, catalog, instances, logs, self-update passthrough), runner.ts (serial operations incl. update+rollback, purge, expose; Caddy route builder), observer.ts (readiness, exposure re-checks, tailnet serve reconcile, Caddy reconcile), dto.ts, instance-dir.ts
  packages/            restricted YAML, manifest/compose validators, catalog loader, store.ts (bundled + uploaded packages, zip import, digest pinning via registry.ts), zip.ts (dependency-free reader/writer)
  planner/             identity, port allocation, Compose rendering (bindHost 127.0.0.1 or 0.0.0.0)
  state/               SQLite schema v5 (db.ts migrations v1→v5), repo.ts (settings table = small JSON docs: appearance, home order, device.name, security.totp)
  exposure/            tailscale.ts (CLI provider, operator self-heal, URL streaming), caddy.ts (admin API client + renderer incl. LAN console server), urls.ts
  appearance/          wallpaper rotation (fetcher.ts, sources.ts Reddit/Bing/Wikimedia, service.ts)
  system/              metrics, host-storage, net (public IP/DNS), power (systemctl via polkit), terminal (python pty bridge), logs (journal + ring buffer), lan.ts, selfupdate.ts (GitHub feed, unit starter)
  bootstrap/           root-only installer/upgrader: bootstrap.ts, tools.ts (Cockpit/Portainer/Tailscale/Caddy), systemd.ts (units + polkit rule), selfupdate-apply.ts (root half of self-update)
  cli/main.ts          commander CLI (all console actions + bootstrap/self-update/setup-code/totp reset)
web/src/               React 19 + Vite, plain CSS tokens (macOS-inspired), strict CSP (style-src allows inline for xterm); App.tsx, app/pages/*, app/dialogs.tsx, app/Setup.tsx (wizard), app/Terminal.tsx, app/reorder.ts (drag-to-arrange)
catalog/               17 bundled packages (manifest.yaml, compose.yaml, README.md, release.json, icon)
tests/unit tests/integration (fake Docker adapter, real HTTP) tests/e2e (Playwright, two dev daemons: normal + setup mode)
scripts/               package.mjs (release archive), catalog-pin/qualify, openapi, vm/ (DigitalOcean controller do-vm.mjs, vm-ssh.sh, vm-scp.sh, run-vm-tests.mjs acceptance suite)
install.sh             curl one-liner (published as a release asset too)
```

Key runtime paths on a host: `/opt/harbor` (release), `/etc/harbor/harbor.json`, `/var/lib/harbor` (state, instances, icons, packages, updates/status.json, setup-code), `/srv/harbor` (user data folder). Service user `harbor` (docker + systemd-journal groups, NoNewPrivileges). Root actions go through polkit-allowed systemd oneshots: `harbor-tailscale-operator.service`, `harbor-self-update@<version>.service`; reboot/poweroff via logind rule (`/etc/polkit-1/rules.d/49-harbor-power.rules`).

## 4. Versions, tags, releases

Tags on `main`: v0.1.0-mvp, v0.2.0, v0.2.1, v0.3.0, v0.3.1, v0.4.0, v0.5.0, v0.6.0, v0.7.0, v0.8.0, v0.8.1.
`package.json` version is **0.8.1**. GitHub Releases exist for v0.7.0, v0.8.0, v0.8.1 (assets:
`harbor-<v>-linux-x64.tar.gz`, `SHA256SUMS`, `install.sh` from 0.8.0). Release archive is built with
`pnpm build && pnpm package` → `release/`; publish with `gh release create v<v> release/harbor-<v>-linux-x64.tar.gz release/SHA256SUMS install.sh`.
Note: `gh release create` creates the remote tag itself; create the local tag afterwards or `git fetch --tags --force`.

Round summary (what each version added): 0.2 publishing+console+catalog+own folders; 0.3 launcher, self-service
Settings, /srv/harbor; 0.4 purge, domains wizard, wallpaper upload, ⌘K palette; 0.5 rotating wallpapers
(Bing/Wikimedia/Reddit-with-key), per-app name+icon, drag-to-arrange, Settings Overview + restart/shutdown,
macOS visual pass; 0.6 uploaded packages (zip, digest pinning) + app updates with rollback; 0.7 terminal,
troubleshoot logs, TOTP 2FA, device name, Tailscale operator self-heal; 0.8 install.sh, setup wizard,
LAN mode + mDNS, Harbor self-update, defaultCredentials.

## 5. Latest decision and the last three actions (read this first when resuming)

**Latest decision (75, executed 2026-09-15):** the GitHub repository `carlosalaniz/harbor` is now
**public**. Before flipping the visibility, the whole history was rewritten with
`git filter-repo --replace-text` and force-pushed (tags included) to purge credential-looking **test
fixtures** that GitHub secret scanning had flagged (the VM-suite admin password literal, e2e form-fill
passwords, `tskey-auth-*` fake keys — all fixtures; no real credentials were ever committed). The
replacements are scanner-safe (`*-FIXTURE-*`, `tskey-fixture-*`); the VM-suite admin password is
overridable via `HARBOR_VM_ADMIN_PASSWORD`. Unauthenticated `install.sh` (200) and the releases API
verified. **All commit SHAs changed** in the rewrite — SHAs mentioned in older docs/evidence refer to
the pre-rewrite history.

**Last three actions, most recent first:**
1. **Purged flagged fixtures, rewrote history, made the repo public** (2026-09-15): replaced the
   fixture strings in 7 files, `git filter-repo --replace-text` over all 59 commits, force-pushed
   `main` + all 11 tags, flipped visibility, verified unauthenticated access. Decision 75 recorded;
   `PROGRESS.md` blockers cleared; `docs/VERIFICATION.md` v0.8.x section updated.
2. **Shipped and verified v0.8.0 → v0.8.1** (GitHub Releases v0.8.0, v0.8.1
   with `install.sh` attached): one-line installer, first-run setup wizard with a printed setup code, LAN
   mode + mDNS (`http://harbor.local`, Caddy LAN route), Harbor self-update via `harbor-self-update@<v>.service`,
   `defaultCredentials` manifest field. Verified on a brand-new droplet `harbor-test-2`: install from a
   local archive (1 min 52 s), wizard over the machine's address, app install from the LAN console,
   in-place self-update 0.8.0→0.8.1 from an archive, polkit-started unit failing cleanly on GitHub's 404.
   Four bugs found on the real box were fixed in 0.8.1 (see §8).
3. **Shipped v0.7.0**: terminal in the console (WebSocket + Python pty
   bridge), Troubleshoot logs, TOTP two-factor login, device name, Tailscale re-login self-heal (the bug
   Carlos hit after disconnecting from the tailnet), Advanced access page redesign. Verified live on
   `harbor-test`, which is still logged out of the tailnet until Carlos approves a login link.

## 5a. THE OPEN ITEM — fresh-box proof of the public paths

The repo is public and the URLs answer unauthenticated. What remains is the **live** proof on a fresh
box (only the local-archive paths have been proven so far):
1. Rebuild `harbor-test-2` (`HARBOR_VM_NAME=harbor-test-2 HARBOR_VM_STATE=.vm2.local.json HARBOR_VM_KNOWN_HOSTS=.vm2-known_hosts node scripts/vm/do-vm.mjs rebuild`), then run the real one-liner over SSH (`curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash`) and drive the wizard.
2. Publish a newer release (bump to 0.8.2, `pnpm build && pnpm package`, `gh release create v0.8.2 …`) and press *Update* in Settings → Overview to prove the GitHub-feed self-update path.
3. Record results in `docs/VERIFICATION.md` (v0.8.x section) and `PROGRESS.md`.

## 6. Live environments (DigitalOcean; each ~$0.07/h; token only in git-ignored `.env.vm.local`)

- `harbor-test` (id 600403086, state `.vm.local.json`, known hosts `.vm-known_hosts`): Carlos's own test box. Harbor **0.7.0**, admin `admin` / the VM-suite fixture password (pass it as `HARBOR_VM_ADMIN_PASSWORD`; never commit it), rotating Bing wallpapers on, uploaded example app `hello-nginx` installed, **logged out of the tailnet** (Carlos disconnected; login link works from Settings → Remote access since 0.7.0; the console's tailnet exposure must be re-enabled by him). Tailnet node name was `harbor-test.tail7d0db4.ts.net`. **Never destroy without asking.** Real DNS record `harbor-demo.apein.space` points at it (delete with `node scripts/vm/do-vm.mjs dns-delete harbor-demo.apein.space` when unwanted).
- `harbor-test-2` (id 600732480, state `.vm2.local.json`, known hosts `.vm2-known_hosts`; select with env `HARBOR_VM_NAME=harbor-test-2 HARBOR_VM_STATE=.vm2.local.json HARBOR_VM_KNOWN_HOSTS=.vm2-known_hosts`): created 2026-09-15 with permission for the fresh-install test. Harbor **0.8.1**, LAN mode on, hostname `harbor`, admin `carlos` / same fixture password, Excalidraw installed. Disposable; web firewall (80/443) currently **off** (`firewall-web on|off`). Destroy with `… do-vm.mjs destroy --yes` when Carlos agrees.
- Access: `bash scripts/vm/vm-ssh.sh -- '<cmd>'`, `vm-scp.sh <files> /root/`; console through a tunnel **with identical port numbers** (`-L 18000:127.0.0.1:18000`) because the daemon rejects other Host values.
- Tailscale auth key from Carlos lives in `.env.vm.local` as `HARBOR_TS_AUTHKEY` (likely single-use, consumed).
- Never write VM IPs, tokens or keys into committed files; `scripts/vm/lib.mjs` redacts IPs in evidence.

## 7. Conventions and how to work here

- Carlos's style: questions up front, then autonomous executive decisions; document everything; be pragmatic. He replies tersely ("ok do it", "2", "lets do it"). Confirm before outward-facing/irreversible actions (repo visibility, destroying droplets); routine judgment calls are yours.
- Every round: code + tests (unit/integration/e2e) + live verification on a droplet + docs (DECISIONS row(s), PROGRESS phase + counts, VERIFICATION section + evidence dir with README, OPERATOR_GUIDE, design doc) + commit on `main` + tag + push (+ GitHub Release since 0.7.0) + memory file update.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (use whatever the current session's attribution reminder says).
- Commands: `pnpm typecheck && pnpm lint`, `pnpm test` (unit, 80), `pnpm test:integration` (76 + 3 live-Docker skipped; one file occasionally flakes at start in the full run, passes alone), `pnpm test:e2e` (21, Playwright, ~1.5 min, spins two dev daemons on 18500/18700), `pnpm openapi` after route changes, `pnpm build && pnpm package`.
- Dev daemon: `pnpm dev` (fake Docker adapter, fakes for Tailscale/Caddy/net/fetcher/registry/release feed/power/unit starter; `HARBOR_DEV_SETUP=1 HARBOR_DEV_SETUP_CODE=…` starts in setup-wizard mode).
- Fake mode conveniences live in `src/daemon.ts` (`demoFetcher`, `demoRegistry`, `demoReleaseFeed`) and are shared by dev and tests.
- Adding a DTO field: `src/contracts/api.ts` → `src/lifecycle/dto.ts` → consumers; web imports the same contract types.
- Adding a setting: use the `settings` table (`repo.setting/setSetting/deleteSetting`), no migration needed. Schema changes: bump `SCHEMA_VERSION`, add `migrateVNtoVN+1`, extend `tests/unit/migration.test.ts`.

## 8. Gotchas learned the hard way (do not rediscover)

- `tailscale logout` wipes tailscaled prefs including `--operator=harbor`; fixed via root oneshot + polkit (decision 64). `tailscale up` demands all non-default flags be mentioned → pass `--ssh=false --operator=harbor` and retry with the CLI's suggested flags; the login URL can take seconds → stream output, fall back to `status --json`'s `AuthURL`.
- Reddit blocks anonymous `.json` (403) since May 2026 → Reddit source needs the user's own "script" app credentials; Bing and Wikimedia work keyless. Wikimedia only serves standard thumbnail widths (use 1920px).
- Node `fetch()` drops a custom `Host` header; use `node:http` in tests that need one.
- Plain-http LAN origins are not secure contexts: no `crypto.randomUUID`, no `navigator.clipboard` (fallbacks exist in `web/src/api.ts`, `components.tsx`).
- Caddy (public proxy) owns port 80 → the LAN console is a Caddy route (`harbor_lan` server) reconciled by the observer; the daemon's direct :80 listener is a fallback when free. Caddy's stock config used to squat :80 until the first exposure; the observer now reconciles at startup.
- Commander: an option named `--version` collides with the global version flag (that is why the root apply step uses `--to`).
- `pnpm package | head` SIGPIPE leaves a stale archive; always `| tail`.
- xterm.js needs `style-src 'unsafe-inline'`; the WebSocket terminal authenticates by first message, never URL.
- macOS has no `timeout`; use `curl --max-time` or `gtimeout`.
- The e2e drag test needed slot-based hit testing (rapid pointer events outrun React renders) and synchronous order tracking.
- Upgrading an unclaimed machine (no admin) must not demand a password: bootstrap keeps setup mode.
- DigitalOcean droplets do not share a broadcast domain: mDNS cross-host resolution cannot be tested there (only local `getent hosts harbor.local`).

## 9. Scope decisions that override TDD exclusions (all at Carlos's request)

Purge (49), app updates and uploaded packages (60–62), MFA/TOTP (67), Harbor self-update and GitHub release publication (69–70), LAN exposure (71). Still not built on purpose: home widgets with live app data, files app, factory reset, external disk formatting, multi-user/SSO, backups (see `docs/FUTURE.md`).

## 10. Feature map of the console (for UI work)

Home (launcher: icons, status dots, drag-to-arrange, updates card, wallpaper credit) · App Store (catalog + *Your apps* filter + upload dialog) · Publishing (tailnet/public addresses) · Platform (Docker, Cockpit, Portainer, Tailscale, proxy) · Settings: Overview (device card, rename, power, machine facts, Harbor update card, wallpaper picker), Account (password, 2FA), Remote access (Tailscale), Public addresses (domains wizard), Storage (disks, folders, picker), Appearance (theme, wallpapers, rotation), Advanced access (terminal, SSH lines, CLI), Troubleshoot (journal + app logs), About · ⌘K palette · first-run Setup wizard · app drawer (open/publish/customize/start/stop/remove/update/uninstall completely).
