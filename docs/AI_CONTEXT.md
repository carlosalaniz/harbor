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
| Requirements and original scope | `docs/spec/TDD.md` (spec), `docs/spec/plan.md` (build order). Several exclusions in TDD were later lifted at Carlos's explicit request; each lift is a numbered decision. |
| Every design decision, numbered (1–108 so far) | `docs/DECISIONS.md` — **next number is 109**. Add a row for every non-obvious choice. |
| Phase-by-phase progress, test counts, blockers, exact next step | `docs/dev/PROGRESS.md` (build changelog) |
| What blocks the beta tag (audit 2026-09-21) | `docs/dev/BETA_TODO.md` — tick items as they ship; no LICENSE until 1.0.0 (decision 100) |
| Agent rules of engagement (what/where/why/HOW) | `AGENTS.md` — read it before writing code or packages. |
| What was verified live and how | `docs/VERIFICATION.md` (sections per version) + `docs/evidence/<dir>/` (screenshots/logs; VM IPs redacted as `<ip>`) |
| Operator-facing manual | `docs/OPERATOR_GUIDE.md` (sections 2a one-line install, 4a–4e settings/own apps/updates) |
| How to write a package | `docs/DEVELOPER_PACKAGES.md` |
| Design addenda | `docs/design/UI.md`, `docs/design/CATALOG.md`, `docs/design/EXPOSURE.md`, `docs/design/ROUND9.md` |
| Deliberately not built | `docs/FUTURE.md` |
| Generated API description | `docs/openapi.json` (`pnpm openapi`; unit test asserts the exact route list — update `tests/unit/openapi.test.ts` when adding routes) |
| Persistent memory (Claude Code auto-memory) | `~/.claude/projects/-Users-carlos-Documents-devshit-harbor/memory/` (`harbor-project-context.md`, `user-working-style.md`) |

## 3. Repository layout (TypeScript strict ESM, Node 24.12, pnpm 10.16)

```
src/
  daemon.ts            wiring: adapters, providers, services, listeners (also demo fakes for fake mode)
  config.ts            DaemonConfig (stateDir, catalogDir, userDataDir=/srv/harbor, localPackagesDir, lan{enabled,port}, updates{repo}, listen 127.0.0.1:18000)
  api/server.ts        Fastify routes; Host/Origin guards (loopback, tailnet UI exposure, LAN rules); WebSocket /v1/terminal
  auth/                scrypt passwords, bearer sessions (sessions.ts incl. TOTP), setup.ts (first-run claim with setup code), totp.ts, machine-key.ts (sealed machine keystore BFU/AFU), machine-holder.ts (in-memory holder)
  lifecycle/           service.ts (plans, catalog, instances, logs, self-update passthrough, adopt-drive, storage policy, needsDrive read model, installCandidates/foundApps/adoptApp + location secrets), runner.ts (serial operations incl. update+rollback, purge, expose; Caddy route builder; drive-guard stops keep desired running; app-home creation + volume rooting), observer.ts (readiness, exposure re-checks, tailnet serve reconcile, Caddy reconcile, drive-guard stop, auto-mount on insert, auto-start on return), dto.ts, instance-dir.ts
  packages/            restricted YAML, manifest/compose validators, catalog loader, store.ts (bundled + uploaded packages, zip import, digest pinning via registry.ts), zip.ts (dependency-free reader/writer)
  planner/             identity, port allocation, Compose rendering (bindHost 127.0.0.1 or 0.0.0.0)
  state/               SQLite schema v7 (db.ts migrations v1→v7), repo.ts (settings table = small JSON docs: appearance, home order, device.name, security.totp, security.machineKey, storage.autoMount, storage.autoStart; resolved notifications delete regardless of read state)
  exposure/            tailscale.ts (CLI provider, operator self-heal, URL streaming), caddy.ts (admin API client + renderer incl. LAN console server), urls.ts
  appearance/          wallpaper rotation (fetcher.ts, sources.ts Reddit/Bing/Wikimedia, service.ts)
  system/              metrics, host-storage (lsblk devices, mounts, folders), device-mount.ts (mount/unmount service), net (public IP/DNS), power (systemctl via polkit), terminal (python pty bridge), logs (journal + ring buffer), lan.ts, selfupdate.ts (GitHub feed, unit starter)
  storage/             bind-marker.ts (app-generated driveId identity in `.harbor-bind.json`), host-path.ts (bring-your-own-folder validation), app-home.ts (portable encrypted bundles: manifest.json + vault/, scrypt+AES-256-GCM, dual-key passphrase + 12-word recovery), fscrypt.ts (pure: builders, parsers, unit names, handoff files, home-path allowlist) + crypto-provider.ts (RootCryptoProvider: request.json + key FIFO + blocking `systemctl start harbor-app-crypto@<id>:<action>` + status.json, kernel mkdir probe for the read model; FakeCryptoProvider keeps sealed/open sets), recovery-bundle.ts (passphrase-wrapped state export), install-location.ts (eligible drive folders)
  bootstrap/           root-only installer/upgrader: bootstrap.ts, tools.ts (Cockpit/Portainer/Tailscale/Caddy), systemd.ts (units + polkit rule), selfupdate-apply.ts (root half of self-update, snapshot + rollback), app-crypto-apply.ts (root half of sealing: filesystem readiness via tune2fs/fscrypt setup, seal/unlock/lock/status/migrate-in-place), device-crypto-apply.ts (drive crypto-setup for the format flow)
  cli/main.ts          commander CLI (all console actions incl. install --location, found-apps, adopt, unlock/lock, recovery export/import, diagnostics + bootstrap/self-update/setup-code/totp reset)
web/src/               React 19 + Vite, plain CSS tokens, strict CSP (style-src allows inline for xterm); App.tsx (Umbrel-style login hero, sidebar, bell), app/pages/*, app/dialogs.tsx (InstallWizard location picker + passphrase, PlanDialog Lives-on row, locked drawer banner), app/Setup.tsx (wizard), app/Terminal.tsx, app/reorder.ts (drag-to-arrange), mock/ (fixtures for `pnpm dev:ui`)
catalog/               17 bundled packages (manifest.yaml, compose.yaml, README.md, release.json, icon)
tests/unit (163) tests/integration (139 + 3 live-Docker skipped, files run serially) tests/e2e (Playwright 25, two dev daemons on 18500/18700: normal + setup mode)
scripts/               package.mjs (release archive), catalog-pin/qualify, openapi, vm/ (DigitalOcean controller do-vm.mjs, vm-ssh.sh, vm-scp.sh, run-vm-tests.mjs acceptance suite)
install.sh             curl one-liner (published as a release asset too)
```

Key runtime paths on a host: `/opt/harbor` (release), `/etc/harbor/harbor.json`, `/var/lib/harbor` (state, instances, icons, packages, updates/status.json, setup-code, devices/<name>/mount-status.json), `/srv/harbor` (user data folder). Service user `harbor` (docker + systemd-journal groups, NoNewPrivileges). The unit grants `ReadWritePaths=/var/lib/harbor /srv/harbor /mnt /media` — `/mnt /media` so the drive guard can stamp markers on removable drives (decision 90; `ProtectSystem=strict` otherwise makes `/mnt` read-only for the daemon). Root actions go through polkit-allowed systemd oneshots: `harbor-tailscale-operator.service`, `harbor-self-update@<version>.service`, `harbor-tools-install@<id>.service`, `harbor-device-mount@<name:action>.service` (removable media, mounts at `/mnt/<label>`); reboot/poweroff via logind rule (`/etc/polkit-1/rules.d/49-harbor-power.rules`).

## 4. Versions, tags, releases

Tags on `main`: v0.1.0-mvp, v0.2.0, v0.2.1, v0.3.0, v0.3.1, v0.4.0, v0.5.0, v0.6.0, v0.7.0, v0.8.0, v0.8.1, v0.8.2, v0.9.0, v0.10.0, v0.11.0, v0.12.0 → v0.12.5, v0.13.0, v0.14.0, v0.15.0 → v0.15.2, v0.16.0 → v0.16.2, v0.17.0-beta.1 → beta.5 (to be withdrawn), v0.17.0.
`package.json` version is **0.17.0** (the beta ships as an ordinary `0.17.x` tag, decision 108; release notes in `docs/releases/v<version>.md`). GitHub Releases exist for v0.7.0 → v0.16.2 and v0.17.0 (older ones to be withdrawn; assets:
`harbor-<v>-linux-x64.tar.gz`, `SHA256SUMS`, `install.sh` from 0.8.0). Release archive is built with
`pnpm build && pnpm package` → `release/`; since v0.9.0 CI publishes the release automatically on
push to `main` (`.github/workflows/release.yml`); no manual `gh release create` needed.
Note: `gh release create` creates the remote tag itself; create the local tag afterwards or `git fetch --tags --force`.

Round summary (what each version added): 0.2 publishing+console+catalog+own folders; 0.3 launcher, self-service
Settings, /srv/harbor; 0.4 purge, domains wizard, wallpaper upload, ⌘K palette; 0.5 rotating wallpapers
(Bing/Wikimedia/Reddit-with-key), per-app name+icon, drag-to-arrange, Settings Overview + restart/shutdown,
macOS visual pass; 0.6 uploaded packages (zip, digest pinning) + app updates with rollback; 0.7 terminal,
troubleshoot logs, TOTP 2FA, device name, Tailscale operator self-heal; 0.8 install.sh, setup wizard,
LAN mode + mDNS, Harbor self-update, defaultCredentials; 0.9 round-9 (notifications, usage,
git sources, auto-updates, widgets); 0.10 password-only persistent login (30-day remember) +
Umbrel-style login hero + console craft pass (one Harbor mark, flat icons, logout in Settings);
0.11 `harbor uninstall`, apt-lock retry, keep-existing-admin, removable-media phase 1 (lsblk devices in Places); 0.12 removable media (mount/unmount at `/mnt/<label>`, drive guard with app-generated identity, auto-mount/auto-start, adopt-drive); 0.13 install-location + adopt (whole encrypted apps on drives: location picker + passphrase, volumes rooted in `<dir>/<name>/{manifest.json, vault/}`, found-apps + adopt on any machine, portable via passphrase); 0.14 format-as-ext4 in place (typed confirm, refused while an app uses the drive).

## 5. Latest decision and the last three actions (read this first when resuming)

**Latest decision (107, executed 2026-09-23):** LAN-mode bootstrap pins avahi to the
default-route interface (`allow-interfaces=` in `/etc/avahi/avahi-daemon.conf`, via the new pure
helpers in `src/bootstrap/mdns.ts`) so `harbor.local` is never answered with Docker bridge
addresses, and restarts `avahi-daemon.socket` + `.service` together (a service-only restart left
avahi answering legacy unicast but not standard mDNS queries). Found while chasing "harbor.local
stopped resolving from the Mac" on carlos-desktop; the box itself is fixed live and resolves again.
Shipped as **v0.17.0** (see decision 108 for why not `-beta.6`).

**Last three actions, most recent first:**
1. **Fixed `harbor.local` on carlos-desktop + shipped v0.17.0 (decisions 107–108)** (2026-09-23):
   two-ended packet captures, avahi pinned to `wlp5s0`, socket+service restart, `mdns.ts` +
   unit tests, guide §7 row, gotchas below. Earlier entries follow.
1. **Shipped v0.17.0-beta.5 optional per-app passphrase (decision 106)** (2026-09-22) after
   Carlos hit the wizard's drive-passphrase requirement mid-test on the LAN box. Earlier below.
1. **Shipped v0.17.0-beta.4 two recovery scopes (decision 105)** (2026-09-22): installation card
   + per-app words, `installation-recovery.ts`, setup wizard step, Settings → Account card with
   rotation, awaited machine-key unseal, unit/integration/e2e coverage. Earlier entries follow.
1. **Shipped v0.17.0-beta.3 same-password silent unlock (decision 104)** (2026-09-21) and
   prepared carlos-desktop for Carlos's manual run (stick re-formatted NTFS, `harbor uninstall`,
   public one-liner reinstall). Previous action (beta.2, decision 103) follows.
1. **Shipped v0.17.0-beta.2 true at-rest sealing (decision 103)** (2026-09-21): `harbor-app-crypto@`
   unit + polkit prefix, `src/bootstrap/app-crypto-apply.ts` (tune2fs/fscrypt readiness, seal,
   unlock, lock, status, migrate-in-place with rollback), `RootCryptoProvider` rewrite (FIFO key
   handoff, blocking unit start, kernel probe), hard-failing install seal + Start unlock/migration,
   `AppHomeDto.sealed`, drawer Lock button + truthful wizard copy, lock-guard auto-start, unit/
   integration/e2e coverage, VM steps C01 + A09 reboot re-lock. Previous entries below are older.
1. **Shipped v0.14.0 format-as-ext4 (decision 93)** (2026-09-21): format routes + root step +
   device-dispatch unit, Settings button/dialog/hints, fixture overlay so e2e proves vfat → ext4 →
   mounted, docs (decision 93, guide §4a1, FUTURE, PROGRESS phase 20, VERIFICATION counts, openapi 72).
   Not deployed to carlos-desktop (stick holds live Immich data).
2. **Shipped v0.13.0 install-location + adopt, deployed to carlos-desktop** (2026-09-20):
   wizard location picker + passphrase, Lives-on plan row, Locked tiles/drawer banner,
   Found-apps in Settings → Storage, CLI `install --location / found-apps / adopt`,
   unit 116 + integration 122 + e2e 24 green, decision 92, docs (APP_HOMES stages 2–3,
   operator guide §4a2, openapi 70 paths). Deployed via local `pnpm package` + `scp` +
   `harbor self-update apply --archive`. Pushed to `main` (CI publishes the release).
2. **Shipped and verified v0.12.3 → v0.12.5 on carlos-desktop** (2026-09-20): drive guard
   (app-generated `driveId` in `.harbor-bind.json`, observer stop through the queue, Start refusal,
   adopt-drive, needs-drive UI) → auto-mount/auto-start with `storage.autoMount`/`storage.autoStart`
   policies → sandbox fix (`ReadWritePaths` + `/mnt /media`) + notification-delete fix.
   Live: Immich `running/running`, `needsDrive` null, bell clean.
3. **Shipped v0.12.0 → v0.12.2** (2026-09-19/20): removable-media mount/unmount at `/mnt/<label>`
   via `harbor-device-mount@`, single Removable row, stale-yank hide, picker subfolder/SVI fixes,
   copy trim pass. Decisions 88–89.

## 5a. Live hosts right now

- **carlos-desktop** (physical Kubuntu 24.04 x86_64 on the home LAN; SSH user + address live in
  Carlos's local notes, never in this public repo): the live box. Clean reinstall on 2026-09-22 (`harbor uninstall --yes`, then the
  public one-liner pinned with `HARBOR_VERSION=0.17.0-beta.3` — the plain one-liner and the
  self-update feed only see stable `x.y.z` tags, so betas need the pin). Harbor **0.17.0-beta.3**
  on `:18000`, LAN mode (`http://harbor.local/`), administrator NOT yet created (Carlos finishes the
  wizard himself; `sudo harbor setup-code` prints the code). Root is LUKS → ext4 (`kubuntu_2404`);
  bootstrap enabled the `encrypt` feature online and wrote `/etc/fscrypt.conf` + `/.fscrypt`
  (`per-app encryption ready on /`). PNY USB stick `sdb1` 14.4 GB, **NTFS, empty**, label
  `USB20FD`, unmounted (re-formatted 2026-09-22 for the wizard-rejection + format-as-ext4 test;
  the old Immich bind-folder setup is gone). Carlos's test plan: NTFS rejected in the wizard →
  Format as ext4 from Settings → Local install (no passphrase) → drive install with the Harbor
  password (silent unlock at login) and with another passphrase (asks) → Lock seals → nothing
  at rest. Gotcha: stacked ghost mounts can hide a yank (`/proc` outlives the pull; the next
  insert lands on `sde1` etc.).
- DigitalOcean droplets (`harbor-test*`, each ~$0.07/h; token only in git-ignored
  `.env.vm.local`): see §6. The repo is public since decision 75 (history rewritten with
  `git filter-repo`; old SHAs refer to pre-rewrite history).

## 6. Droplet details (DigitalOcean; token only in git-ignored `.env.vm.local`)

- `harbor-test` (id 600403086, state `.vm.local.json`, known hosts `.vm-known_hosts`): Carlos's own test box. Harbor **0.7.0**, admin `admin` / the VM-suite fixture password (pass it as `HARBOR_VM_ADMIN_PASSWORD`; never commit it), rotating Bing wallpapers on, uploaded example app `hello-nginx` installed, **logged out of the tailnet** (Carlos disconnected; login link works from Settings → Remote access since 0.7.0; the console's tailnet exposure must be re-enabled by him). Tailnet node name was `harbor-test.tail7d0db4.ts.net`. **Never destroy without asking.** Real DNS record `harbor-demo.apein.space` points at it (delete with `node scripts/vm/do-vm.mjs dns-delete harbor-demo.apein.space` when unwanted).
- `harbor-test-2` (id 600732480, state `.vm2.local.json`, known hosts `.vm2-known_hosts`; select with env `HARBOR_VM_NAME=harbor-test-2 HARBOR_VM_STATE=.vm2.local.json HARBOR_VM_KNOWN_HOSTS=.vm2-known_hosts`): created 2026-09-15 with permission for the fresh-install test. Harbor **0.8.1**, LAN mode on, hostname `harbor`, admin `carlos` / same fixture password, Excalidraw installed. Disposable; web firewall (80/443) currently **off** (`firewall-web on|off`). Destroy with `… do-vm.mjs destroy --yes` when Carlos agrees.
- `harbor-test-3` (id 600780190, state `.vm3.local.json`, known hosts `.vm3-known_hosts`; select with env `HARBOR_VM_NAME=harbor-test-3 HARBOR_VM_STATE=.vm3.local.json HARBOR_VM_KNOWN_HOSTS=.vm3-known_hosts`): created 2026-09-15 for the public-path proof. Harbor **0.8.2** (installed 0.8.1 from the public one-liner, self-updated from the console), LAN mode on, hostname `harbor`, device name *Public Proof*, admin `carlos` / a fixture password, no apps installed. Disposable; destroy with `… do-vm.mjs destroy --yes` when Carlos agrees.
- Access: `bash scripts/vm/vm-ssh.sh -- '<cmd>'`, `vm-scp.sh <files> /root/`; console through a tunnel **with identical port numbers** (`-L 18000:127.0.0.1:18000`) because the daemon rejects other Host values.
- Tailscale auth key from Carlos lives in `.env.vm.local` as `HARBOR_TS_AUTHKEY` (likely single-use, consumed).
- Never write VM IPs, tokens or keys into committed files; `scripts/vm/lib.mjs` redacts IPs in evidence.

## 7. Conventions and how to work here

- Carlos's style: questions up front, then autonomous executive decisions; document everything; be pragmatic. He replies tersely ("ok do it", "2", "lets do it"). Confirm before outward-facing/irreversible actions (repo visibility, destroying droplets); routine judgment calls are yours.
- Every round: code + tests (unit/integration/e2e) + live verification on a droplet + docs (DECISIONS row(s), PROGRESS phase + counts, VERIFICATION section + evidence dir with README, OPERATOR_GUIDE, design doc) + commit on `main` + tag + push (+ GitHub Release since 0.7.0) + memory file update.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (use whatever the current session's attribution reminder says).
- Commands: `pnpm typecheck && pnpm lint`, `pnpm test` (unit, 163), `pnpm test:integration` (139 + 3 live-Docker skipped), `pnpm test:e2e` (25, Playwright, ~1.5 min, spins two dev daemons on 18500/18700), `pnpm openapi` after route changes (unit test pins the exact route list), `pnpm build && pnpm package`.
- Dev daemon: `pnpm dev` (fake Docker adapter, fakes for Tailscale/Caddy/net/fetcher/registry/release feed/power/unit starter; `HARBOR_DEV_SETUP=1 HARBOR_DEV_SETUP_CODE=…` starts in setup-wizard mode). `pnpm dev:ui` renders the console from fixtures (no daemon; `?screen=login` previews the login hero) — fastest UI iteration.
- Fake mode conveniences live in `src/daemon.ts` (`demoFetcher`, `demoRegistry`, `demoReleaseFeed`) and are shared by dev and tests.
- Adding a DTO field: `src/contracts/api.ts` → `src/lifecycle/dto.ts` → consumers; web imports the same contract types.
- Adding a setting: use the `settings` table (`repo.setting/setSetting/deleteSetting`), no migration needed. Schema changes: bump `SCHEMA_VERSION`, add `migrateVNtoVN+1`, extend `tests/unit/migration.test.ts`.

## 8. Gotchas learned the hard way (do not rediscover)

- mDNS / `harbor.local` (decision 107): avahi publishes the host name on EVERY up interface, so once an app runs, Docker's `docker0`/`br-*` addresses (172.17.0.1…) ride along in the answer and macOS resolves nothing — pin `allow-interfaces=` to the default-route interface (bootstrap does). `systemctl restart avahi-daemon` alone (socket unit left running) can leave avahi answering legacy unicast queries (`dig @224.0.0.251 -p 5353 name +short` works) but NOT standard port-5353 queries (every real client fails): restart `avahi-daemon.socket avahi-daemon.service` together. Diagnosing from a Mac without sudo: `dig @224.0.0.251 -p 5353` proves the wire, `python3 -c 'import socket; socket.getaddrinfo(...)'` proves the resolver, a plain UDP socket bound to 5353 with SO_REUSEPORT does NOT see external packets (mDNSResponder takes them), a listener on a private group (239.x) proves multicast delivery, and `tcpdump -p` (no promiscuous mode) on the box proves what its kernel really receives. `tcpdump` on the SENDING host shows `bad udp cksum` for its own packets (checksum offload) — not a fault. `avahi-daemon -f` means `--file`, foreground is the default. Tailscale with `Use Tailscale DNS` on does NOT capture `.local` (it only routes `ts.net`) — check `tailscale dns status` before blaming it. macOS's mDNSResponder keeps state for days; a Wi-Fi toggle or `sudo launchctl kickstart -k system/com.apple.mDNSResponder` resets it.
- fscrypt (decision 103): `fscrypt status <dir>` needs ROOT (policy files under `/.fscrypt/policies` are 0600) — the daemon never calls it; it probes the kernel with a mkdir inside `<home>/volumes` (ENOKEY ⇒ locked; Node reports it as `Unknown system error -126`, errno -126, no `ENOKEY` code). `fscrypt encrypt` refuses a non-empty dir (hence seal-empty + `cp -a -T` for migrations); `fscrypt unlock` exits 1 with *already unlocked* when idempotent (check status first); `fscrypt lock` exits 1 with *incompletely locked* while any file is open (stop the app first; status then reads `Unlocked: Partially`). Ubuntu 24.04 cloud roots ship ext4 WITHOUT the `encrypt` feature: `tune2fs -O encrypt` on the mounted root works and takes effect immediately (verified, no reboot). `systemctl start <unit>` WITHOUT `--no-block` blocks until the oneshot finishes and returns its exit code — polkit's `manage-units` rule allows the verb either way, so that is how the daemon gets synchronous hard failures. Pass secrets to a root oneshot through a FIFO the daemon creates (`mkfifo -m 600`; open write side with `O_NONBLOCK`, retry on ENXIO until the root side opens for reading) — never a temp file.
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

Purge (49), app updates and uploaded packages (60–62), MFA/TOTP (67), Harbor self-update and GitHub release publication (69–70), LAN exposure (71), notifications/usage/git-sources/auto-updates/widgets (76–82), persistent login + craft pass (83–84), removable media + drive guard + auto-mount/start (88–90), install-location + adopt (91–92), format-as-ext4 (93). Still not built on purpose: files app, factory reset, external disk partitioning/LUKS/SMART, multi-user/SSO, backups (see `docs/FUTURE.md`).

## 10. Feature map of the console (for UI work)

Home (launcher: icons, status dots, drag-to-arrange, updates card, needs-drive attention, locked tiles, wallpaper credit) · App Store (catalog + *Your apps* filter + upload dialog + git sources, install wizard with location picker + passphrase) · Publishing (tailnet/public addresses) · Platform (Docker, Cockpit, Portainer, Tailscale, proxy) · Settings: Overview (device card, rename, power, machine facts, Harbor update card, wallpaper picker), Account (password, 2FA, sessions, log-out-others, log out), Remote access (Tailscale), Public addresses (domains wizard), Storage (disks, removable drives with mount/eject + auto-mount/auto-start toggles, folders, picker, found-apps + adopt), Appearance (theme, wallpapers, rotation, opacity), Notifications (channels), Advanced access (terminal, SSH lines, CLI), Troubleshoot (journal + app logs), About · ⌘K palette · first-run Setup wizard · app drawer (open/publish/customize/start/stop/remove/update/uninstall completely, needs-drive banner + adopt, locked banner) · notifications bell · Umbrel-style login hero.
