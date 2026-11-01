# Verification report

Harbor local preview, now at 0.30.0; each section names the version it checked. This report lists what actually ran, where, with which versions,
and the outcome. Nothing here is asserted without a recorded run. Live runs are stored under
`docs/evidence/<run-id>/` (report.md, report.json, bootstrap logs, screenshots, exported files).

## 1. Environments

| Role | Details |
|---|---|
| Build/dev host | macOS 26.2, Apple Silicon (arm64), Node v24.12.0, pnpm 10.16.1, TypeScript 5.9.3, Playwright 1.63 (Chromium headless shell 153), Docker Desktop 29.2.1 / Compose v5.1.0 (dev loop only) |
| Designated live VM | DigitalOcean droplet `harbor-test`, `s-4vcpu-8gb` (4 vCPU, 8 GB, 160 GB), image `ubuntu-24-04-x64` = Ubuntu 24.04.4 LTS x86_64, systemd 255. Rebuilt to a fresh image before each recorded `--fresh` run (`node scripts/vm/do-vm.mjs rebuild`). No Docker/Node/npm preinstalled (verified by the suite). |
| Why not Vagrant | The build host cannot run x86-64 guests with hardware acceleration. The `Vagrantfile` is delivered as required and `pnpm test:vm` supports `HARBOR_VM_TARGET=vagrant`; that path is implemented but was **not exercised** in this build. |

## 2. Automated suites (developer host)

| Command | Scope | Result |
|---|---|---|
| `pnpm typecheck` | server + web strict TS | pass |
| `pnpm lint` | ESLint (ts, tsx, mjs) | pass |
| `pnpm test` | unit: YAML restrictions, manifest/Compose schemas and cross-references, catalog/hash verification (incl. presentation assets), planner and renderer (bind mounts, configuration formats), host-path rules, exposure config/URLs, schema migrations v1→v7, OpenAPI (79 paths), systemd/release files (incl. `/mnt /media` writes), device mount/format + bind marker (round-trip, restore keeps id, replacement fresh, legacy verifies; format oneshot start, in-use/system-disk refusals, no-systemd hint), install candidates (eligibility, non-POSIX/read-only refusal), app homes (manifest+vault, passphrase unlock, cross-machine portability), LAN HTTPS pure surface (secure ports, host coverage, SAN rendering, lanSecure urls) | 170 passed |
| `pnpm test:integration` | daemon in-process with the fake Docker adapter: install flow, idempotency, port claims, readiness timeout, coexistence, sentinel non-interference, restart→needs_action, Docker-down, volumes/secrets retention (synthetic stateful package), auth controls (incl. 30-day remember sessions, session list, revoke-others), tool binding, exposure (tailnet/public/primary/degraded/withdraw, UI exposure), external storage (validation, bind mounts, overlap, reinstall verification, DATA_MISSING, drive guard: swap→stop+refuse+adopt, restore→auto-start, policy toggles), app homes (install-location plan wording, submit-secret gate, manifest+vault layout, wrong-passphrase refusal, found-apps wiring, adopt conflicts, volume-rooting with `device=` log, on-demand apps-folder creation), purge/domains, appearance/rotation, packages/updates, git sources, notifications (resolved rows delete), security/terminal, setup/LAN/self-update, LAN HTTPS (off by default, LAN-off refusal, CA mint + open download + lanSecure + disable) | 139 passed (+3 live-Docker skipped without opt-in) |
| `HARBOR_LIVE_DOCKER_SOCKET=~/.docker/run/docker.sock pnpm test:integration` | real Dockerode + `docker compose` against the authorized Docker Desktop engine: Excalidraw install/stop/start/remove/reinstall, BentoPDF coexistence, COOP/COEP headers | 3 passed (plus the 49 above) |
| `pnpm build && pnpm test:e2e` | Playwright against the built console with the fake adapter: Umbrel-style login hero (incl. bad-credentials, reload→re-login→resume, logout revokes), Home/App Store/Platform/Publishing pages (icons served with sandboxed CSP, category filter, search), app page + plan review + double-click safety, drawer stop/start/remove/reinstall, coexistence + owned resources, publish wizard (tailnet, public with one-time credentials, withdraw), phone width, install-location picker + passphrase + encrypted review (BentoPDF to the data-folder candidate), bring-your-own-folder validation and mount, settings (password, Tailscale, storage incl. mount spinner + format-as-ext4 + auto-mount/auto-start toggles + found-apps, network secure-addresses card, appearance, opacity slider, rotation, terminal, logs, rename, 2FA), first-run wizard, Harbor update card | 26 passed |

Fake-adapter results prove the engine, API and UI contracts. They are not evidence for A03/A09/A11/A14/A16; those come from section 3.

## 3a. Removable media on physical hardware (2026-09-19, Harbor 0.11.0 → 0.12.0 via console self-update)

Physical Ubuntu 24.04.3 x86_64 box (`harbor`, 94 GB RAM), PNY USB stick `sdb1` 14.4 GB vfat label `USB20FD`, unmounted. All calls loopback `http://127.0.0.1:18000` over SSH with the administrator password.

| Step | Result |
|---|---|
| `GET /v1/host/storage` on 0.12.0 | `devices: [(sdb1, USB20FD, 14.4G, unmounted)]`, `mounts: [(/, System disk)]` — the stick is visible before any mount |
| `POST /v1/host/devices/sdb1/mount` → `GET …/status` | `requested` → `mounted at /mnt/usb20fd` (< 10 s); `lsblk` confirms `sdb1 → /mnt/usb20fd`; mountpoint owned `harbor:harbor`, stick contents listed |
| `GET /v1/host/storage` while mounted | `devices: [(sdb1, mounted, /mnt/usb20fd)]`, `mounts` gains `(/mnt/usb20fd, Drive "usb20fd")`; `GET /v1/host/folders?path=/mnt/usb20fd` lists entries, `writable: true` |
| `POST /v1/host/devices/sdb1/unmount` → `GET …/status` | `requested` → `unmounted`; `lsblk` shows `sdb1` with no mountpoint — clean round-trip |
| Self-update 0.11.0 → 0.12.0 | `POST /v1/system/update/check` finds 0.12.0, `POST …/apply` → `succeeded` in ~8 s; console back on 0.12.0 |

Unit/integration cover the rest: unmount refused while a `bind` resource lives underneath (names the apps), insert/remove + per-app `storage-missing` notifications, `.harbor-bind.json` marker round-trip and wrong-drive refusal.

## 3b. Drive guard + auto-mount/auto-start on physical hardware (2026-09-20, Harbor 0.12.3 → 0.12.5 via local archive self-update)

Same box and stick as §3a, now with Immich installed and its `library` claim at `/mnt/usb20fd/immich`. Deployed with `pnpm package` → `scp` tarball + `SHA256SUMS` to `/tmp/` → `sudo /opt/harbor/bin/harbor self-update apply --to <ver> --archive /tmp/harbor-<ver>-linux-x64.tar.gz` (the `--archive` path reads `SHA256SUMS` from the archive's directory — it must be copied next to the tarball).

| Step | Result |
|---|---|
| Yank with 0.12.3 guard | observer stops Immich through the queue (actor `drive-guard`, `desired` stays running), `storage-missing` error row, `needsDrive {path, purpose, detail}` set, Start refused `DATA_MISSING` |
| Legacy marker gap | pre-guard marker had no `driveId`; resource backfilled one, but the daemon could not write it back — `ProtectSystem=strict` made `/mnt` read-only for the service. Fixed in 0.12.5 (`ReadWritePaths` + `/mnt /media`); marker on disk now carries the same `driveId` as the resource |
| Ghost mounts | `/proc` outlived the pull: four stacked mounts (`sdb1`–`sde1` on `/mnt/usb20fd`) hid the yank with an empty top layer. Marker check (not mount presence) is what catches this |
| 0.12.5 steady state | Immich `desired`/`runtime` running, `readiness` healthy, `needsDrive` null; `storage-missing` row deleted on resolve (read rows no longer linger); `storagePolicy {autoMount: true, autoStart: true}` |
| Auto paths | covered by integration tests (swap→stop+refuse+adopt, restore→auto-start, policy toggles persist); live reinsert exercises the same observer code (auto-mount one attempt per device, auto-start one attempt per folder) |

## 3c. Format-first + FUSE-safe mount unit on physical hardware (2026-09-21, Harbor 0.15.0 → 0.15.1 via local archive self-update)

Same box as §3a (`home-server`, Ubuntu 24.04.3 x86_64), USB stick `sdb1` 14.4 GB **ntfs** label `USB20FD`, unmounted, no apps installed. Deployed with `pnpm package` → `scp` tarball + `SHA256SUMS` to `/tmp/` → `sudo /opt/harbor/bin/harbor self-update apply --to 0.15.1` (checksum verified, bootstrap re-run, daemon back `ok`).

| Step | Result |
|---|---|
| FUSE root cause (0.15.0) | UI Mount wrote `mounted at /mnt/usb20fd` but `mount \| grep usb20fd` empty; journal showed ntfs-3g `Mounted /dev/sdb1` then `Unmounting /dev/sdb1` ~1 s later with `mnt-usb20fd.mount Deactivated`. Manual `mount -t ntfs3` and direct `harbor device-dispatch sdb1:mount` both persisted — the template unit's default `KillMode=control-group` SIGTERMed the forked FUSE daemon when the oneshot exited |
| Fix (0.15.1) | template unit gains `KillMode=none` (kernel mounts unaffected); live unit file confirms `KillMode=none` after self-update |
| Format-first UI (0.15.1, live browser) | Settings → Storage row: `Not mounted · 14.4G · ntfs · cannot hold apps as-is — format it first` + `Mounting won't help — this filesystem can't hold apps.` + `Format as ext4…` (no Mount button). Found-apps row: `needs formatting as ext4 before it can hold apps — see Disks above` (no Mount prompt). Immich install wizard: `USB20FD (14.4G, ntfs) is plugged in but not mounted. It needs formatting as ext4 before it can hold apps.` + `Format as ext4…`, no Mount, no passphrase |
| Suites | unit 123, integration 123 (+3 live-Docker skipped), e2e 25, `catalog:verify` 17 ok, `openapi --check` current |

## 3d. True at-rest sealing on the droplet (2026-09-21, Harbor 0.17.0-beta.2, run `vm-2026-09-22T03-30-37`)

Existing `harbor-test` droplet (Ubuntu 24.04 x86-64, root ext4 on `/dev/vda1` — the cloud image
ships WITHOUT the `encrypt` feature; bootstrap enabled it online with `tune2fs -O encrypt`, no
reboot). `pnpm test:vm -- --only A01,C01,A09` with the 0.17.0-beta.2 archive; evidence in
`docs/evidence/vm-2026-09-22T03-30-37/` (report.json holds the raw `fscrypt status`, `ls` and
Docker-bypass output).

| Step | Result |
|---|---|
| A01 bootstrap re-run | identity/admin kept; bootstrap-1.log: `per-app encryption ready on / (ext4, /dev/vda1)`; unit `harbor-app-crypto@.service` + polkit prefix installed |
| C01 install | `harbor install memos --name sealed-demo --location /srv/harbor/harbor-apps/memos` → operation events `kernel-sealed …/volumes (fscrypt v2, per-app key)` BEFORE `created retained volume … (…/volumes/data)`; `fscrypt status` = `policy_version:2`, `Unlocked: Yes`, `raw key protector "harbor-sealed-demo-3ea499e1"`; DTO `home.sealed=true, state=unlocked, defaultKey=true` |
| C01 bypass while unlocked | `docker run --rm -v <home>/volumes/data:/d alpine sh -c 'echo … > /d/.harbor-probe && cat …'` → plaintext round-trip |
| C01 lock | `harbor lock` while running → refused (*is running; its files are open — Stop the app first*); after `harbor stop`: `harbor lock` → `home.state=locked`, `fscrypt status` → `Unlocked: No`; `ls <home>/volumes` → `FAo3Rb73Ja_z429busZAm8pR1f1cwEDVDagJJltBS6PXon1iLJ09KA` (no `data`) |
| C01 bypass while locked | `docker run --rm -v <home>/volumes:/d alpine …` → ciphertext names only; `cat` → `Required key not available` (×2); `echo > /d/write-probe` → `can't create /d/write-probe: Required key not available` |
| C01 unlock | `harbor start` (default-key home, machine key AFU after the CLI login) → `home.state=unlocked`, healthy; the probe file read back through Docker |
| A09 reboot | after `reboot`, BEFORE any login: `sealed-demo` reads `home.state=locked`, `ls <home>/volumes` shows the ciphertext name; after `harbor login`: `unlocked`, `running/healthy` (lock-guard auto-start); excalidraw-2 stayed stopped, sentinel untouched |
| Suites | unit 149, integration 129 (+3 live-Docker skipped), e2e 25, `catalog:verify` 17 ok, `openapi --check` current |

## 3e. Fresh-machine beta check (2026-10-04, Harbor 0.18.1 → 0.18.3, new droplets)

- **Public one-liner on a brand-new Ubuntu 24.04.5 droplet:** 0.18.0 failed at `apt-get update`
  (Docker's Debian repo chosen for Ubuntu — decision 119); **0.18.1 installed cleanly** (Docker, Caddy,
  Tailscale awaiting login, setup code printed).
- **Acceptance suite on 0.19.0** (the beta build), run `vm-2026-10-05T01-36-24`: **24 checks — 23 pass,
  0 fail, 1 blocked** (tailnet, no auth key), after decisions 121–122.
- **Acceptance suite** `pnpm test:vm -- --fresh --exposure`, run `vm-2026-10-04T01-32-52` on 0.18.2:
  **24 checks — 23 pass, 0 fail, 1 blocked** (B02/B03 tailnet: no auth key). The 0.18.1 run before it
  (`vm-2026-10-04T00-56-30`, not kept) found decision 120 (sealing without the machine key) and two
  runner bugs.
- **Catalog qualification**, full pass on 0.18.2 (stopped before the last three packages, not kept): every
  plain install passed (15/15, Nextcloud revision 3 included); every bring-your-own-folder variant failed —
  decision 121. **Small-app pass on 0.18.3**, run `catalog-2026-10-04T03-29-24` on a new droplet:
  Audiobookshelf + Navidrome (plain and own folder), Excalidraw, Memos — **6/6 pass in under 7 minutes**
  including droplet creation. Large packages (Immich, Open WebUI, Nextcloud with its own folder) still need
  a re-run on 0.18.3.
- **Nextcloud with its own folder, by hand on the same droplet (0.18.3):** a folder outside the writable
  paths (`/opt/…`) is refused at plan time with the fix named, nothing created; `/mnt/nextcloud-data`
  prepared `33:33 0770` (the first hint) is refused too — the `harbor` user cannot write the identity file —
  so the hint became `33:harbor 0770` (0.18.4); with it Nextcloud installed in about 2 minutes, the hook set
  it up (`installed: true`, admin + data in the folder) and four minutes later it still ran healthy with
  zero drive-guard stops.

## 3f. Drives that need you on physical hardware (2026-10-04, Harbor 0.19.0, Kubuntu home box)

- ext4 USB stick plugged in but not mounted: Home card + bell "USB20FD is plugged in but not mounted" after the
  60 s grace.
- KDE mounted it from Dolphin at `/media/carlos/USB20FD` → card turned into "mounted by your desktop";
  **Let Harbor manage it** remounted it at `/mnt/usb20fd` (harbor:harbor), wrote
  `/etc/udev/rules.d/90-harbor-drive-<uuid>.rules` (`UDISKS_AUTO=0`), and the warning resolved.
- Re-plugged (came back as `sdd1`): KDE no longer automounted it; Harbor auto-mounted it at `/mnt/usb20fd`.


## 3g. A real app moved into Harbor: custom ERPNext from a git source (2026-10-04, Harbor 0.20.0 → 0.20.1)

Carlos's ERPNext (Compose stack on another home server: custom image, 10 services, site `erp2.local`)
packaged as a public git source (`carlosalaniz/harbor-erpnext2`) using `command:` (decision 123).

- Disposable droplet (0.20.0): the first install failed in 11 s — `Permission denied` on a file the
  Dockerfile `COPY`s for `USER frappe` → **decision 124** (build contexts keep git's modes, 0.20.1).
  Package fixes found the same way: the base image's `sites/` is a `VOLUME` (the classic builder drops
  writes to it between steps), nginx must wait for both upstreams, and workers/websocket wait for the
  backend's config instead of crash-looping (a restarted websocket came back on a new IP that nginx had
  already resolved → socket.io 502).
- Final commit on the droplet: fresh install **206 s** (build cached; first build ~4 min), Administrator
  login with the provisioned password, scheduler active, socket.io 200, zero container restarts;
  `harbor update` to a new commit 131 s with data kept.
- Home server (LAN mode, Nextcloud with real data untouched): self-update 0.19.0 → 0.20.0 → 0.20.1,
  git source added, install **204 s**, stopped; the old stack stopped for **2 min 41 s** while its four
  volumes streamed in with numeric owners (`tar --numeric-owner` through `alpine`): mariadb 343 MB 49 s,
  sites 100 MB 15 s, assets 410 MB 56 s, logs 2 MB 1 s; old stack started again (rollback intact).
- Start on the copied data: **12 s**, readiness 200 on the third attempt, hook set `host_name` to the main
  address, assets refreshed from the image, the existing site kept (no new site, theme left as the site
  had it). Same counts on both: 237 Sales Invoices, 40 Customers, 37 Items, 768 Files (203 public +
  428 private on disk), 8 enabled users, 35 Print Formats, same last invoice timestamp, website theme
  `Standard`. LAN address and `harbor.local:<port>` answer; socket.io 200; 6 workers online; no restarts.
- MariaDB root moved to Harbor's generated secret (`ALTER USER`, the old password piped box-to-box through
  an environment variable, never printed).

## 3h. Operator-provided secrets and app links (2026-10-05, Harbor 0.21.0, decisions 125–126)

Fake-adapter evidence (contracts), then a first real-Docker run (below):

- `pnpm test` 219 passed (`tests/unit/links-secrets.test.ts`: manifest rules, rendered networks and
  aliases, submission checks that never echo a value; `migration.test.ts`: schema v9 `links`).
- `pnpm test:integration` 167 passed + 3 live-Docker skipped (`tests/integration/links-secrets.test.ts`:
  the typed-in value is bound into the runtime Compose file and the container env, its file is 0600,
  and it appears in no plan, operation, instance, notification response nor in the SQLite file; a
  link joins exactly the consumer's bound service and the provider's endpoint service on an internal,
  Harbor-labelled network, the provider answers as `docs-link`, Restart re-creates a deleted network,
  provider removal flags the consumer and `configure` relinks it, consumer remove/reinstall/purge,
  an unlabelled network with the planned name is refused with `OWNERSHIP_CONFLICT`).
- `pnpm test:e2e` 29 passed (install wizard link picker, review-dialog password field gating Install,
  app page Links and *Values you provided*, Settings → Internal networks).

**Real Docker, 2026-10-06** (a home-LAN host, Docker 29.3.1, self-updated 0.20.1 → 0.21.0; consumer
`carlosalaniz/harbor-affine-mcp`, provider `carlosalaniz/harbor-affine` already running):
`harbor install affine-mcp --link affine=affine --secret <3 ids>=@file` created
`hb_<consumer>_link_affine` with `Internal=true` and the five Harbor labels (kind `link`, link id,
provider, instance, installation); its only members were the provider's `affine` service and the
consumer's `affine-mcp` service; the running provider got alias `affine-link` without a restart.
From the consumer: `affine-link` resolved and port 3010 answered; the provider's `postgres`, `redis` and
`affine` names did NOT resolve (`EAI_AGAIN`). The gateway's `/readyz` was 200 against the linked
GraphQL, `/mcp` 401 without the operator-provided bearer token and 200 with it, and an MCP
`list_workspaces` call signed in with the operator-provided account and returned the provider's
workspaces. `harbor links` showed the link `active`. Stop of both apps succeeded. Not yet observed live:
a `compose up` of both projects after the rewrite (next start), provider removal flagging the consumer.

## 3i. Several public hostnames per endpoint (2026-10-05, Harbor 0.22.0, decision 127)

Fake-adapter evidence only (contracts; no live Caddy/Let's Encrypt run yet):

- `pnpm test` 222 passed (`tests/unit/exposure.test.ts`: the main public name is `primaryHost`, else
  the first published; a withdrawn main name falls back; `urls.public`, `primaryUrlFor` and
  `appAuthorities` follow; two names of one endpoint render as two Caddy routes to the same upstream,
  each with its own basic-auth handler or none. `migration.test.ts`: v9 → v10 keeps every exposure
  in publication order, accepts a second public row for an endpoint, still refuses the same address twice).
- `pnpm test:integration` 172 passed + 3 live-Docker skipped (`tests/integration/multi-domain.test.ts`:
  expose `erp.example.com` (main) then `customers.example.org` (basic auth, credentials once) → two
  rows, two Caddy routes to the same port, one authentication handler, the after-start hook's
  `HARBOR_ADDRESSES` lists both and `HARBOR_URL`/`BASE_URL` stay on the main one; the same name twice
  and another app's name are refused; a bare `unexpose` with two names is refused with both names and
  the `--host` command; the tailnet stays one per endpoint; `reconfigure public --host
  customers.example.org` moves the base URL, hook URL and `isPrimary`; withdrawing the main name hands
  the main address to the remaining one; withdrawing a non-main name leaves the base URL alone;
  `remove` withdraws every name).
- `pnpm test:e2e` 29 passed (publish wizard: **Add another domain** with protection none, both names on
  the Publishing page and in the drawer, *Withdraw draw.example.com* keeps `draw.example.org`, then
  withdraw that one too).

**Real host, 2026-10-06** (home-LAN host, self-updated 0.21.0 → 0.22.0, schema v9 → v10 with the live
state DB of five running apps): a second `harbor expose erpnext2 --via public --host <second domain>` on an
endpoint already public succeeded; `harbor exposures` listed both names `active`, the first still main.
From the internet both answered `/api/method/ping` 200, each with its own Let's Encrypt certificate
(CN = each name; issuers YE2 and YE1), and the other four apps' public names stayed 200.

## 3j. Three fixes from a real host (2026-10-05, Harbor 0.22.1, decisions 128–129)

Fake-adapter and unit evidence only (no live run of these fixes yet):

- `pnpm test` 230 passed. `tests/unit/exposure.test.ts`: `exposureCheck` returns
  `https://<host>/healthz` (tailnet keeps its port, a query string survives) when the exposed endpoint is
  `health.endpoint`, `/` for any other endpoint or without a manifest, and the expected statuses are the
  usual list (incl. 401) plus the manifest's. `tests/unit/mdns.test.ts`: an uncommented `host-name=` in
  `[server]` is commented out (spacing kept), the stock file and other sections are untouched, the rewrite
  is idempotent. `tests/unit/nextcloud-hook.test.ts`: the bundled Nextcloud hook, run by `sh` against a
  stub `php occ`, calls `richdocuments:activate-config` after `overwrite.cli.url` when `wopi_url` is empty
  or the CODE proxy, never for `https://office.example.com` or with CODE disabled, and exits 0 with one
  line when activation fails.
- `pnpm test:integration` 173 passed + 3 live-Docker skipped (`tests/integration/exposure.test.ts`: an
  API-only package with health `/healthz`, the fake verifier answering 404 at `/`; publishing
  `mcp.example.com` succeeds `active`, the operation result URL stays `https://mcp.example.com/`, the
  verifier was asked only for `/healthz` with 200/204/401 accepted, and the observer's re-check asks the
  same path).
- `pnpm test:e2e` 29 passed (unchanged console).
- `pnpm catalog:verify`: nextcloud revision 4 (hashes refreshed, qualification `pending` until a
  droplet run).

## 3w. WebSockets over the LAN HTTPS app ports (2026-10-12, Harbor 0.30.2)

**Local gate only** (fake adapter):

- **Found live (Carlos's box):** Open WebUI worked on `http://…:<port>` but its WebSocket failed on
  `https://…:<port + 20000>`. The daemon's app proxy answered every upgrade with a hand-written
  `101 Switching Protocols` without `Sec-WebSocket-Accept`, so browsers dropped the handshake; it also lost bytes sent
  with the handshake, never relayed a refusal (the browser hung), and left out `X-Forwarded-Proto/Host`.
- **Fix:** the proxy relays the app's own 101 (all its headers, incl. the accept key and subprotocol), forwards the
  `head` bytes both ways, passes a non-101 answer back as is, adds the forwarded headers, and uses no connection pool
  for upgrades. Closing a secure port (HTTPS off, shutdown) now also ends its open WebSockets — `server.close()`
  otherwise waited on them forever.
- **Gate:** new `tests/integration/lan-https-ws.test.ts` (real TLS listener with a minted cert + a raw upgrade
  stub): 101 with the app's `Sec-WebSocket-Accept` and `Sec-WebSocket-Protocol`, `X-Forwarded-*` seen by the app,
  frames echo both ways, a 403 reaches the browser. Against 0.30.1's proxy both tests fail (accept header missing;
  the refusal hangs). `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 341 passed; `pnpm test:integration` 222 passed + 3 live-Docker skipped; `pnpm build && pnpm test:e2e` 35 passed; `pnpm openapi -- --check` current.
- **Not yet live:** Open WebUI over https on a real box after the release.

## 3v. Console round: notification buttons, unlock in place, https by itself, Store/Settings layout (2026-10-12, Harbor 0.30.0, decision 164)

**Local gate only** (fake adapter; no live run yet — see the last bullet):

- **Gate:** `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 341 passed (new: `notification-actions.test.ts` —
  harbor-update → *Install now*, app actions only with an instance, backup failures retry then link, drives and
  disks → Storage, unknown kinds → none; `ui-csp.test.ts` — CSP unchanged with LAN HTTPS off, `img-src` gains
  exactly the certificate hosts incl. an IPv6 literal, a name with `;` is dropped; `https-redirect.test.ts` — the
  target keeps path/query/route and drops `skiphttps`, never moves a host the certificate does not cover or a page
  already on https, `?skiphttps` sticks per tab and `=false` clears it); `pnpm test:integration` 220 passed + 3
  live-Docker skipped (`app-homes.test.ts`: after a restart the plan answers 409 `MACHINE_KEY_LOCKED`, a wrong
  password on `POST /v1/account/unlock` is 422, the right one returns `{unlocked: true}` and the same plan then
  succeeds with `defaultKey`; `lan-https.test.ts`: the open `GET /v1/setup` names the https hosts while HTTPS is on
  and `{enabled: false, hosts: []}` after, the open probe answers `image/png`, `no-store`); `pnpm build && pnpm
  test:e2e` 35 passed (new: the review dialog asks for the password on `MACHINE_KEY_LOCKED`, says *password is
  wrong*, then carries on to *Review install*; Store sections + catalog line with refresh icon under the title +
  Backup places tab; desktop Settings columns `overflow-y: auto`; phone Settings list → section → *‹ Settings*,
  no bell in the dock, no horizontal scroll; a harbor-update row's *Install now* lands on `#/settings/overview`
  with the update confirm open; the install page's *Source code on GitHub* link from `presentation.source`);
  `catalog:verify` fixtures 9 ok; `catalog:hash --check` ok (fixtures, and all 139 apps of the harbor-apps
  screenshots branch); `pnpm openapi -- --check` current (102 paths).
- Screenshots in design mode (`pnpm dev:ui`, 1370 px and 390 px) checked by eye: Settings, Store, install page,
  Notifications, Appearance, phone list and section.
- The probe PNG decodes (1x1, IHDR/IDAT/IEND CRCs valid).
- **Live-found on 0.30.0 (Carlos's box, read-only checks from the Mac):** `http://harbor.local/` did not move.
  Server side was right (0.30.0, `/v1/setup` `https.enabled`, CSP listing the cert hosts, bundle with the probe
  code, `curl https://harbor.local/v1/network/https/probe` → 200 `image/png`), but headless Chromium showed
  `ERR_BLOCKED_BY_ORB` on the probe: with the browser's `Sec-Fetch-Site: same-site` the request guard answered 403
  `FORBIDDEN_ORIGIN` JSON, which ORB blocks as an image. **0.30.1** exempts exactly `GET /v1/network/https/probe`
  from the Sec-Fetch-Site check; `lan-https.test.ts` now sends the browser's headers (probe 200, `/v1/setup` and
  another path still 403).
- **Not yet live:** the unlock prompt after a real daemon restart.

## 3u. Fixed UDP ports and permissions: the VPN pack (2026-10-12, Harbor 0.29.0, decision 163)

**Local gate + live droplets** (two disposable DigitalOcean droplets, Ubuntu 24.04, archive 0.29.0 with the
WireGuard package in its seed):

- **Gate:** `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 331 passed (new: `manifest.test.ts` — a fixed UDP port +
  the three permissions accepted on a single-instance app; refused on `multiInstance: true`, for an unknown service,
  protocol `sctp`, permission `privileged`, a permission for an unknown service, the same host port twice;
  `links-secrets.test.ts` — render publishes `0.0.0.0:<port>/udp` beside the loopback TCP endpoint and renders exactly
  `cap_add: [NET_ADMIN]`, `devices: [/dev/net/tun:/dev/net/tun]` and the five `net.*` sysctls); `pnpm
  test:integration` 220 passed + 3 live-Docker skipped (new `tests/integration/permissions.test.ts`: the install plan
  lists the port and permissions in plain words; submit without `acceptPermissions` → 409 `PERMISSION_REQUIRED` and
  no instance; with it the app runs with `NET_ADMIN` and the UDP port; a second app wanting the same port and a port
  bound on the host are refused `PORT_CONFLICT` naming it; an update adding `tun` asks only for `tun`, update-all
  skips it with a reason, the accepted update renders the device; an update with nothing new needs no acceptance);
  `pnpm build && pnpm test:e2e` 31 passed (new: the review shows `UDP <port> on every network` and the permission
  group, Install stays disabled until "Allow Tunnel E2E to do this" is ticked, the drawer's Ports section says which
  port to forward); `catalog:verify` fixtures 9 ok; `catalog:hash --check` ok; `pnpm openapi -- --check` current
  (`acceptPermissions` on `POST /v1/operations`).
- **Live:** `qualify-catalog.mjs --only wireguard` passed (healthy after 93 s, page title "WireGuard", health 302).
  `harbor install wireguard --yes` refused with `PERMISSION_REQUIRED`; `harbor --accept-permissions install
  wireguard --yes` succeeded, Docker published `0.0.0.0:51820->51820/udp` and `127.0.0.1:18080->51821/tcp`. wg-easy
  set up through its API (admin, host = the droplet's public IP), one client created; on a second droplet
  `wg-quick up` with that config (AllowedIPs narrowed to 10.8.0.0/24 so SSH stayed up) → `ping 10.8.0.1` 3/3, both
  ends showed a handshake seconds old and bytes both ways. Kernel WireGuard loaded on demand without `SYS_MODULE`.
  With IPv6 left on (as Umbrel ships wg-easy) `wg-quick up` failed: `modprobe: FATAL: Module ip6_tables not found`,
  `can't initialize ip6tables table 'nat'` — hence the package's `DISABLE_IPV6: "true"`. UDP 51820 was opened on the
  test firewall for the run only (`do-vm.mjs firewall-udp`), both droplets destroyed after.

## 3t. Fixes from porting the Umbrel store (2026-10-12, Harbor 0.28.4, decision 162)

**Local gate + live droplets** (not yet a published release; harbor-apps branch `umbrel-import` is local):

- **Gate:** `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 327 passed (new: `tests/unit/cli-exit.test.ts` — a child
  writes 300,000 bytes into a pipe and exits through `exitAfterFlush`, all arrive; plain `process.exit` delivered
  65,536 on the same host; `bind-marker.test.ts` — under `umask 077` the marker is `0644`; `manifest.test.ts` —
  `healthcheck: {disable: true}` accepted alone, refused with `test`, timings or `false`, a `test`-less check
  refused, `service_healthy` on a disabled service refused; `links-secrets.test.ts` — render keeps
  `{disable: true}`); `pnpm test:integration` 215 passed + 3 live-Docker skipped; `pnpm build && pnpm test:e2e`
  30 passed; `pnpm catalog:verify tests/fixtures/catalog --quiet` 9 ok; `catalog:hash --check` ok; `pnpm openapi
  -- --check` current.
- **Live (15 disposable DigitalOcean droplets in parallel, Ubuntu 24.04, archive 0.28.4 with the drafts as its
  seed, `qualify-catalog.mjs` in SOCKS mode):** 121 of 124 Umbrel-converted apps qualified `passed` (install,
  readiness, Chromium page load, removal; external-storage variant where a claim exists); blocked: bitboard and
  trilium-notes (`EACCES mkdir /data`, need an initial volume owner), kokoro (UI at `/web/`, needs a UI path).
  Before the fixes: `harbor --json catalog` over SSH returned exactly 65,536 bytes (qualify crashed on the drift
  check); metube with a bound folder was stopped by the drive guard 10 s after start ("carries no Harbor identity":
  the image chowns `/downloads` incl. the `0600` marker); after the fix both metube variants passed. Evidence:
  `docs/evidence/catalog-2026-10-12T18-2*` (not committed: iteration runs).

## 3s. Apps declare their minimum Harbor (2026-10-12, Harbor 0.28.2, decision 161)

**Local only** (developer host, fake adapter). No published app declares `release.minHarbor` yet, and the
harbor-apps CI that proves declarations against real releases needs 0.28.2 to be released first (the
published 0.28.1, 598c7f2, is the ufw change of decision 160 and has neither the field nor `catalog:plan`).

- **Gate (re-run after the 0.28.2 renumbering):** `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 316 passed (43 files; `package-features` and its
  table removed, new cases in `catalog-bundle-build` and `packages-store-official`); `pnpm test:integration`
  215 passed + 3 live-Docker skipped (new: an upload declaring `minHarbor: "99.0.0"` plus an unknown field is
  refused 409 `INVALID_STATE` "needs Harbor 99.0.0 or newer" and is not listed; a git source declaring it is
  refused the same way and not recorded); `pnpm build && pnpm test:e2e` 30 passed; `pnpm catalog:verify
  tests/fixtures/catalog --quiet` 9 ok; `pnpm catalog:hash --catalog tests/fixtures/catalog --check` ok;
  `pnpm openapi -- --check` current (no route change).
- **Unit proofs:** a manifest `release.minHarbor` must be canonical `x.y.z` and ≥ 0.28.2 (`0.28.1` refused
  with "Harbor 0.28.0 and 0.28.1 do not know the field", also `0.28.0`, `0.9.99`, `0.29`, `v0.29.0`, and
  leading zeros `0.028.2`, `00.28.2`, `0.28.02`, `1.0.00`, `01.0.0`; `0.100.0` accepted); the manifest value gates listing/load on its own (index without it) and before the
  schema check (a manifest with an unknown field says "needs Harbor 0.29.0 or newer" on 0.28.2, the schema
  error on 0.29.0); the bundle copies the manifest value into the index entry (sorted keys, deterministic) and a
  0.28.0-style index-only read lists the app as unavailable; an index value that differs from the manifest's
  (or names one the manifest lacks) fails bundle, verify and plan; `planCatalog` groups by version in numeric
  order (`0.100.0` after `0.30.0`) with sorted ids; the plan CLI prints JSON on stdout and exits 1 with the
  reason on stderr.
- **Real catalog checkout:** `pnpm catalog:verify ../harbor-apps/apps` 17 packages ok, every line
  `minHarbor=0.28.0(default)`; `pnpm -s catalog:plan ../harbor-apps/apps` →
  `{"groups":[{"minHarbor":"0.28.0","ids":[<the 17 apps>]}]}`, exit 0. Plain `pnpm catalog:plan` also prints
  pnpm's `> harbor@0.28.2 catalog:plan` header on stdout: CI must use `pnpm -s` (the JSON is the last line).
- **`catalog:bundle --summary`:** unit test writes `{serial, commit, packages}` sorted by id with
  `version`/`minHarbor` as string or null; an app whose free-text version is `1) minHarbor=0.30.0 (x` comes out
  as that exact string with `minHarbor: null` (the human log line, unchanged, would mislead a parser);
  `--sumary` (typo) or a valueless `--summary` exit 2. On `../harbor-apps/apps`: 17 entries, all
  `version: null, minHarbor: null`.
- **Release guard (`scripts/release-tag-guard.sh`, read-only `git ls-remote` against the real origin):**
  `v0.28.1` with 598c7f2 → exit 0 (a re-run); `v0.28.1` with any other commit → exit 1 "already released from
  598c7f2…: bump the version"; `v0.28.2` → "is new", exit 0. Annotated tag in a scratch repo: the `^{}` commit
  is compared (match 0, other commit 1, missing argument 1).
- **harbor-apps CI (local only, not run on GitHub):** YAML parses (4 jobs: plan, check, bundle with
  `contents: read`, publish with `contents: write` + concurrency, GH_TOKEN only on Decide and Publish);
  `bash -n` on all 15 run blocks; the plan step refuses 598c7f2's `package.json` with "the latest Harbor
  release (v0.28.1) has no catalog:plan; release Harbor 0.28.2 or newer first" and passes this one; the plan
  shape check refuses `0.028.2`; publish's artifact check refuses a wrong commit, serial, id, an empty or
  missing summary, a leading-zero minHarbor; the jq notes on a sample with a hostile version
  (`1) minHarbor=0.30.0 (x` → no "needs Harbor") and shell metacharacters print them literally; the same on a
  real bundle of the 17 apps.

**Live, GitHub + harbor-old (2026-10-12), 0.28.2 / 0.28.3:**
- GitHub: Harbor v0.28.2 released (release + CI green, `official-catalog` job green). harbor-apps' new
  CI ran for the first time: plan → *check with Harbor 0.28.0 (17 apps)* + *check with Harbor 0.28.2
  (all 17 apps)* → bundle → publish, release `c1791820303`. Two throwaway PRs (closed, branches deleted):
  memos declaring `minHarbor: "9.9.9"` failed plan with "memos declares release.minHarbor 9.9.9, but
  Harbor 9.9.9 is newer than the latest Harbor release (0.28.2)…" on `apps/memos/manifest.yaml`;
  memos declaring `"0.28.2"` passed (*check with Harbor 0.28.0 (16 apps)*, *check with Harbor 0.28.2
  (all 17 apps)*; bundle/publish skipped on a PR).
- harbor-old: `sudo harbor self-update apply --to 0.28.2`; the 12 containers stayed up. 60 s after start
  the daemon itself downloaded `c1791820303` (published after the 0.28.2 tarball was built) and switched
  to it (`harbor catalog status`: downloaded, serial 1791820303); `harbor catalog refresh` → "Up to date".
- Update through a catalog, end to end: Excalidraw installed as `catalogtest` (unencrypted; an encrypted
  install is refused until the operator logs in after a restart, as designed) at revision 1; a test
  catalog (Excalidraw revision 1.9, serial newer than the official one) served on the box's
  `127.0.0.1:8099` with `catalog.url` pointed at it; `harbor catalog refresh` → "New apps and updates
  loaded"; `harbor list` → `-> 1.9`; an `update-available` notification "Revision 1 → 1.9" appeared 17 s
  after the swap; `harbor update catalogtest --yes` → "catalogtest now runs revision 1.9", healthy, HTTP
  200; the notification was gone afterwards. Cleanup: `harbor purge catalogtest`, the config restored
  byte for byte, `/var/lib/harbor/catalog` removed; the next check downloaded `c1791820303` again; the
  owner's three apps and 12 containers untouched, no error lines.
- Found live: 0.28.2's `/usr/local/bin/harbor` link failed ("exec: /usr/local/node/bin/node: not found"):
  the launchers resolved their runtime next to the link. Fixed in 0.28.3 (both launchers follow the link;
  `tests/unit/launcher.test.ts` runs them through a symlink and fails on the old launcher).
- 0.28.3 on harbor-old (self-update from the GitHub release): plain `harbor --version` → 0.28.3 and
  `harbor catalog status` work through `/usr/local/bin/harbor`; the archive's seed is `c1791820303`; the 12
  containers stayed up.
- Not exercised live: the Store's *Check for new apps* button in a browser (the same route the CLI
  refresh uses), and the 6-hour timer.

## 3r. LAN mode opens its ports in ufw (2026-10-12, Harbor 0.28.1, decision 160)

- **Found live on the home server (0.27.1):** an app's secure LAN address (`https://<hostname>.local:38085`)
  timed out from another device while its plain LAN address (`:18085`) answered 200. On the box the daemon
  was listening on 38080–38087 and a loopback `curl` to 38085 returned 200; ufw was active with default deny
  incoming. Docker-published ports skip ufw's INPUT chain, the daemon's LAN HTTPS listeners do not.
- Fixed there by hand with a ufw allow rule for the home subnet on 38000:38999; the secure addresses then
  answered 200 from the LAN.
- **Code:** `src/bootstrap/firewall.ts` + the LAN step of bootstrap; `harbor uninstall` deletes the rules.
- **Tests:** unit `firewall.test.ts` (port list incl. custom LAN port/range, private sources only, delete
  args, `ufw status` parsing). **Not yet run live:** the bootstrap step itself on a box with ufw.

## 3q. The app catalog moves to harbor-apps (2026-10-11, Harbor 0.28.0, decision 158)

**No live run yet.** Nothing is pushed, no harbor-apps release exists, and no box has downloaded a
catalog. Everything below ran on the developer host.

**Signing was removed before release** (decision 158). The signing proofs below no longer apply, because
that code is gone: wrong key, bad signature and edited metadata refused by the signature, `sign.mjs`,
`check-bundle.mjs`, the four-job CI with its `catalog-signing` Environment, the re-verification of stored
folders against the configured keys, and the `HARBOR_CATALOG_PUBLIC_KEY` override of `pnpm package`. The
integrity proofs still hold and were re-run (see *Signing removed* at the end of this section): zip
checksum and size against `catalog.json`, no index.json, serial ordering (no rollback), the 24 h future
refusal, the retry on a mixed release, the 240 s deadline, `PLAN_STALE`, `minHarbor`, `url: null`.

Local, fake adapter:
- `pnpm lint`, `pnpm typecheck` pass. `pnpm test` 290 passed (new: bundle open/refuse — wrong key,
  bad signature, tampered metadata, checksum or size mismatch, no index.json; the update service — swap
  without restart, equal or older serial never downloads the zip, prune, a newer seed wins, a corrupt
  pointer falls back to the seed, failures leave the active catalog alone, single-flight, off, timer;
  config validation; `minHarbor`; an uploaded id keeps winning; the bundle builder and
  `catalog:hash --check`).
- `pnpm test:integration` 213 passed + 3 live-Docker skipped (new `catalog-updates`: an installed app
  gets the update-available notification and an auto-update app updates itself after a newer
  catalog swaps in, without a restart; a replay is a no-op and the download survives a daemon restart;
  a foreign key is refused; `minHarbor` lists as unavailable; `url: null` never fetches).
- `pnpm test:e2e` 30 passed (the Store shows the catalog line and "Catalog updates are off", no button).
- `pnpm catalog:verify tests/fixtures/catalog --quiet` (9 ok), `pnpm catalog:hash --catalog
  tests/fixtures/catalog --check`, `pnpm openapi -- --check`.
- Store catalog line viewed in `pnpm dev:ui` at 1280 and 400 px (no horizontal scroll), including the
  off state.

Bundle, sign and verify end to end, with a **throwaway** ed25519 key made outside both repositories and
deleted afterwards (not the official key):
- `pnpm catalog:bundle` on harbor-apps `apps/` (17 apps loaded; 85 files in the zip).
- `scripts/sign.mjs`: with the throwaway key against the pinned `keys/harbor-apps.pub` it exits 1 and
  leaves no signature; an empty or garbage secret exits 1; with `CATALOG_PUBLIC_KEY_FILE` set to the
  throwaway public key it signs and verifies.
- `openBundle` accepts the bundle with the throwaway key and refuses it with the official key, with one
  flipped zip byte (checksum) and with edited metadata.
- `pnpm package --skip-build` with `HARBOR_CATALOG_BUNDLE` + `HARBOR_CATALOG_PUBLIC_KEY=<throwaway>`
  built an archive whose `catalog/` is byte-identical to harbor-apps `apps/` plus `catalog.json` and
  `.sig`; `catalog:verify` on it: 17 ok. Without the key override it refuses ("the app catalog
  signature does not verify; no release archive was built"); with no bundle it tries the official URL
  and fails with HTTP 404 (no catalog release published yet).

harbor-apps CI hardening (review fixes; local only): the workflow is split into verify → bundle → sign
→ publish. The YAML parses; every `run:` block passes `bash -n` and none interpolates `${{ }}`. The
publish job's decision script, run against a stubbed `gh`, publishes when no release exists or the
latest is older; skips a re-run of a released commit and an older commit after `main` moved on; and fails
on a different commit with an existing serial, an incomplete release, clock skew, and a `catalog.json`
that is not the signed one. `scripts/check-bundle.mjs` on a real bundle of `apps/` passes, and refuses a
wrong serial, a wrong commit, a short sha, one appended zip byte, a mismatched `build.txt` and a missing
`catalog.json`. `scripts/sign.mjs` on a missing `catalog.json` exits 1 with "did the bundle step fail?".
actionlint was not available.

Review fixes (daemon), local, fake adapter (`pnpm lint`, `pnpm typecheck` pass; `pnpm test` 296 passed;
`pnpm test:integration` 214 passed + 3 live-Docker skipped; e2e not re-run):
- catalog-updates unit (16): a folder signed by a key no longer configured falls back to the
  seed (warned once) and a new-key bundle with a lower serial replaces it; a folder whose `catalog.json`
  names another serial, a tampered stored `catalog.json` and a missing signature all fall back to the
  seed; a serial two days ahead of the clock is refused without fetching the zip (an hour ahead is
  fine); mixed releases (old `catalog.json` + new signature, signed meta + another archive) are checked
  again once and succeed, a bundle that stays wrong is fetched twice then reported; one 240 s deadline
  caps each step's timeout and stops before `catalog.zip` when it runs out.
- integration `catalog-updates` + `backups`: an update planned for revision 3 and approved
  after the catalog moved to 4 fails `PLAN_STALE`, the app stays installed/running/healthy, no
  operation-failed notification; a stale install leaves no instance row or port claim (re-planning gets
  the same name and port); with a `minHarbor: 99.0.0` catalog the installed app's icon is still served;
  restore of a package gated by `minHarbor` answers 409 `INVALID_STATE` "needs Harbor 99.0.0 or newer".

Review fixes (surface + tooling), local:
- `pnpm test` 292 passed (new: release-tag helpers — `releases/latest` Location → `c<serial>`, refusing
  another repo, a `v` tag, extra path segments; `pnpm package` now fetches both files from
  `releases/download/c<serial>/` and requires the serial in `catalog.json` to match the tag).
- `pnpm test:e2e` 30 passed: the main e2e daemon now has catalog checks on (`HARBOR_DEV_CATALOG_URL`,
  closed loopback port; fake mode answers 404). *Check for new apps* is visible and clickable, shows
  *Checking…*, then the error in role=status; after a reload the line says "Last check failed: …" and
  "· checked just now". The setup daemon (url null) covers "Catalog updates are off".
- `pnpm dev:ui` `?catalog=error|new|off` viewed in Chromium: each state renders as described.
- `scripts/vm/run-vm-tests.mjs`, `qualify-catalog.mjs`, `lib.mjs`: `node --check` only (they pin the
  box to the seed and assert it; not run — they need the droplet).

Signing removed (local, fake adapter):
- `pnpm lint`, `pnpm typecheck` pass. `pnpm test` 299 passed: bundle tests now cover a zip that does not
  match `catalog.json` (another zip, one flipped byte, one byte short, the `catalog.json` of another
  release) and metadata that is not JSON or breaks the schema; catalog-updates (16) — a stored
  `catalog.json` that no longer parses falls back to the seed (warned once as "damaged") and a bundle
  with a lower serial than that folder replaces it; truncated, another serial, a broken schema or a
  missing `catalog.json` all fall back to the seed and the original bytes back make the folder count
  again; an edit that keeps it valid and naming the same serial still counts (integrity, not trust); a
  bundle whose zip stays wrong is fetched twice and reported as "the app catalog archive does not match
  its catalog.json checksum"; the deadline test now has two steps (`catalog.json` 30 s, `catalog.zip`
  the rest); config — a leftover `catalog.publicKeys` loads and is ignored with a notice.
- `pnpm test:integration` 214 passed + 3 live-Docker skipped (`catalog-updates` starts the daemon with
  a leftover `publicKeys` in its config; a zip with one flipped byte is refused with the checksum
  message, the catalog stays and no folder is written).
- `pnpm catalog:verify tests/fixtures/catalog --quiet` (9 ok), `pnpm catalog:hash --catalog
  tests/fixtures/catalog --check`. `pnpm package` was not re-run here: `scripts/package.mjs` (it still
  fetched and verified the `.sig`) is changed in the same release by a separate edit.
- `pnpm build && pnpm test:e2e` 30 passed. `pnpm openapi -- --check` current (two route descriptions
  regenerated: "newer signed" → "newer").
- harbor-apps (branch `nosign`): `scripts/sign.mjs`, `scripts/check-bundle.mjs` and `keys/` deleted;
  `.github/workflows/ci.yml` is two jobs (verify, release) and parses as YAML; not run on GitHub Actions.

Not verified at that point: the harbor-apps workflow on GitHub Actions, a download from GitHub on a
real box, and an upgrade from 0.27.x picking up the seed — all done live afterwards (see "Live, GitHub +
harbor-old (2026-10-12)" below); the 6-hour timer is still unexercised.

Catalog compatibility (decision 159), local only (no UI, route or schema change; e2e not re-run):
- `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 311 passed (new `package-features`: the walk finds 189
  schema paths and values, all baseline; an unrecorded or removed one fails with the "add it to FEATURES"
  / "the format only grows" message; field, `value` and `when` entries and max-over-used; with an injected
  table where `command` arrived in 0.29.0 the bundle stamps `minHarbor: 0.29.0` on that app only, a higher
  declared value wins, `verifyCatalog` fails a declared 0.28.0, and the stamped bundle extracted as a box
  catalog lists the app for Harbor 0.28.0 as unavailable "needs Harbor 0.29.0 or newer" and available for
  0.29.0; `catalog-fetch` extracts a local bundle; that test then used a test key and refused another key, and since
  signing was removed it refuses a zip with one flipped byte with the `catalog.json` checksum message instead);
  `pnpm test:integration` 214 passed + 3 live-Docker skipped; `pnpm openapi -- --check` current.
- `pnpm catalog:verify` on `tests/fixtures/catalog` (9 ok) and on harbor-apps `apps/` (17 ok), every app
  `minHarbor declared=none computed=none`. `pnpm catalog:bundle` on harbor-apps `apps/` (17 apps,
  into a scratch dir): the bundled index.json equals `apps/index.json` as JSON.
- `pnpm catalog:fetch --out <dir>` against GitHub: fails with "could not resolve the latest catalog
  release … (is there a published catalog release on carlosalaniz/harbor-apps?)" — no release exists yet.
  With `HARBOR_CATALOG_BUNDLE` (then with a throwaway key; signing is gone now): 17 packages extracted, `catalog:verify` on them 17 ok, a
  non-empty `--out` refused. `pnpm package --skip-build` the same way (now through `catalog-fetch.mjs`)
  built an archive with the 17-app seed; the archive was deleted afterwards.

The `official-catalog` CI job ran on GitHub Actions after the first harbor-apps release (passed; see the live entry below).

No-signing merged onto the compat-hardened main (decisions 158 + 159), local, fake adapter:
- `pnpm lint`, `pnpm typecheck` pass; `pnpm test` 321 passed (43 files; `catalog-fetch` extracts a local
  bundle without any key, writes no `.sig`, and refuses a zip with one flipped byte: "does not match its
  catalog.json checksum"); `pnpm test:integration` 214 passed + 3 live-Docker skipped; `pnpm build &&
  pnpm test:e2e` 30 passed; `pnpm catalog:verify tests/fixtures/catalog --quiet` (9 ok), `pnpm
  catalog:hash --catalog tests/fixtures/catalog --check`, `pnpm openapi -- --check` current.
- harbor-apps `apps/` (main with the no-signing CI): `catalog:verify` 17 ok; `catalog:bundle` 17 apps
  (no `.sig` written); `HARBOR_CATALOG_BUNDLE=<that dir> pnpm package --skip-build` built the archive with
  `catalog/index.json` (equal to `apps/index.json`) + `catalog.json` (byte-identical to the bundle's), no
  `.sig` anywhere, and `release.json` `catalog` = `{serial, commit, createdAt, source, official: false}`
  (no `publicKey`); the archive was deleted afterwards.
- harbor-apps release notes: the awk that reads `bundle.log` takes the version only from a field that
  starts with `(` and prints "needs Harbor x.y.z+" for `minHarbor=`; checked on sample lines with and
  without version/minHarbor (BSD awk; POSIX only) and on the real bundle log.


Console + presentation only; no engine, route or schema change. Local, fake adapter:
- `pnpm test:e2e` 30 passed: the Excalidraw spec checks the Storage/Access summaries, *How?*, the
  Advanced details (path, website) and the Main address behind *Change* with full URLs; the BentoPDF
  spec formats the vfat stick from the single *Where to keep* list and sees the summary switch to the
  drive; the Jellyfin spec binds its own folder from Advanced and the summary marks it "(not encrypted)".
- `pnpm test` 262 passed (data-folder free space, `sizeHint` through import); `pnpm catalog:verify`
  with 17 `sizeHint`s (hashes refreshed; qualification unchanged — presentation only).
- Viewed in `pnpm dev:ui` at 1280 and 390 px wide.
**Live, GitHub + harbor-old (2026-10-12), 0.28.0:** harbor-apps CI ran on GitHub Actions for the first
time (verify 18 s, release 22 s) and published `c1791783123` (17 apps, `catalog.zip` 151844 bytes +
`catalog.json`, no signature). Harbor's own release job then built v0.28.0 with that catalog as the seed
(the `official-catalog` CI job failed once before the first catalog existed, as expected, and passed on
re-run). `pnpm catalog:fetch` on a laptop resolved the tag, checked the zip against `catalog.json`, and
`catalog:verify` loaded all 17. On harbor-old: `sudo harbor self-update apply --to 0.28.0` from the
GitHub release; the same 12 containers stayed up throughout ("Up 37 hours" before and after); the seed
in `/opt/harbor/catalog` is `c1791783123` (17 apps + `index.json` + `catalog.json`, no `.sig`) and
`release.json` records it as official. 61 s after start the daemon asked GitHub and logged "app catalog
is up to date" (serial 1791783123). Real download path: the seed's serial was set to 1 by hand and the
daemon restarted; 61 s later it logged "app catalog updated … from 1", wrote
`/var/lib/harbor/catalog/1791783123/` (byte-identical to the seed apart from that serial) and
`current.json`, without a restart. The seed was restored and the download removed; the next check said
up to date again; no error lines; console `/healthz` 200. Not exercised live: the Store's *Check for new
apps* button and `harbor catalog status|refresh` (the box's CLI session had expired and the admin
password is the owner's), an app update arriving through a downloaded catalog (covered by the
integration test), and the 6-hour timer.

**Live, harbor-old (2026-10-11):** self-update 0.26.0 → 0.27.0 → 0.27.1 from the GitHub releases,
the same 12 containers running throughout. Driven with Playwright at 1280 and 390 px: with the ext4
USB stick mounted from the page, 0.27.0 made the 14 GB stick Immich's default; 0.27.1 keeps *This
machine* (234 GB free) and lists the stick as a choice. A real Excalidraw install from the page (review
→ operation → ready; HTTP 200; `volumes/` fscrypt v2 AES-256) and a full uninstall, once per version.
0.27.1's review reads "Devices on your home network · http://harbor-old.local:18083/" and "This
machine" (0.27.0 said "localhost … this machine only, until you publish"); Immich is no longer
offered the domain Nextcloud uses. Three independent review passes over the 0.27.0 screenshots
produced the nine fixes of decision 157. Not kept in the repo (screenshots show a private LAN).
Left over: Immich's long storage purpose doubles the brackets in "Encrypted, except … (your folder)".

## 3p. Install page fixes (2026-10-11, Harbor 0.27.1, decision 157)

Local: `pnpm test` 262, `pnpm test:integration` 206 (+3 live skipped; new: plan `location.onDrive/
defaultKey` + `notes` vs `warnings`, LAN URL in plans, used domain left out of address options),
`pnpm test:e2e` 30 (review copy, single-place text, drive lines, "Encrypted, except"), catalog and
openapi checks. Live: see 3o.

## 3n. App backups (2026-10-10, Harbor 0.26.0, decisions 149–154)

**Live, harbor-old (physical test box) + droplet `harbor-test`** ([evidence](evidence/live-2026-10-10-backups/README.md)):
0.20.1 → 0.26.0 and 0.25.0 → 0.26.0 self-updates (existing apps untouched, restic 0.19.1 + rclone 1.75.2
installed by bootstrap). Places Another disk, S3 (SeaweedFS, bucket created at init) and SFTP all ready; a
backup to all three paused the app **2 s**, the next one sent 156 kB; no plaintext marker anywhere at the
places; restore in place brought the marker back and kept the previous copy until deleted. **Cross-machine:**
an app backed up on the droplet was restored on harbor-old from the same SFTP place after opening it with the
droplet's recovery key — same SHA-256 of a 3 MB random blob, healthy, kernel-sealed; after a purge it restored
again under a fresh identity. Six defects were found live and fixed before release (evidence README).
**Not verified live:** Proton Drive (needs a real account and a 2FA code), a real cloud S3 provider (SeaweedFS
stood in), the nightly window firing on its own (the schedule math is unit-tested; manual runs exercised the
same worker).

Fake adapter: unit `backups.test.ts` (17, incl. a real-restic round trip when restic is installed), migration v11;
integration `backups.test.ts` (13); e2e 30 (Settings → Backups → place, drawer → back up → restore → delete kept
copy). Counts in PROGRESS.

## 3m. Move between locations (2026-10-06, Harbor 0.25.0, decisions 145–146)

**Live, droplet `harbor-test`** ([evidence](evidence/vm-2026-10-06-move/README.md)): 0.24.0 → 0.25.0
self-update; a CLI install landed sealed by default (decision 130, live); data folder → loop ext4 drive →
back → drive with the same SHA-256 each time, ciphertext names on the drive while locked, old homes
deleted, purge clean. The first build's move back failed on an fscrypt protector name clash and rolled
back correctly (decision 146 fixed it).

Fake adapter: integration `seal.test.ts` (12 tests incl. 4 for move), unit `fscrypt`, e2e 29. Counts in PROGRESS.

## 3m. LAN HTTPS wedged Caddy on the home server (2026-10-09, Harbor 0.25.1, decision 148)

What was seen and measured on the box (loopback, logged in):

| Check | Before | After `systemctl restart caddy` |
|---|---|---|
| `GET /v1/platform-tools` | 15.04 s | 0.04 s |
| `GET /v1/network/addresses` | 15.02 s | 0.02 s |
| `GET /v1/instances` | 0.05 s | 0.04 s |
| Caddy admin `GET /config/` | no answer in 20 s | 200 in 1 ms |
| A public site through Caddy (`--resolve …:443:127.0.0.1`) | no answer in 10 s | 302 in 0.06 s |

Cause chain from the journals: turning secure addresses on minted the cert into a `tls/` dir that came out
0700 (service `UMask=0077`), Caddy rejected the config (`open …/server.crt: permission denied`), Harbor re-sent it
every minute, and after the fifth reject Caddy's certificate maintenance panicked and the admin endpoint hung.
Fixes (0.25.2) are proved by the fake adapter only (`tests/integration/lan-https.test.ts`); turning secure
addresses on again with Caddy on the real box is still to do after the update.

## 3l. Seal in place, passphrase change, sealed purge (2026-10-06, Harbor 0.24.0, decisions 142–144)

**Live, droplet `harbor-test`** ([evidence](evidence/vm-2026-10-06-seal/README.md)): self-update
0.20.1 → 0.24.0 from a local archive; `harbor install memos --unencrypted`, a 5 MB random marker file,
`harbor seal` → same SHA-256 inside the container, only `…_data-sealed` left, `fscrypt status` sealed +
unlocked, after Stop + Lock the home lists only ciphertext names, Start reopens it; `harbor passphrase`
to an own passphrase (own words once), Lock, unlock with it, back to Harbor's key; remove + reinstall keep
the data; purge failed with EACCES on the first build (container-owned files) and succeeded after
decision 144.

Fake adapter: `pnpm test` (unit) incl. `fscrypt` import-source checks and `rewrapAppHome`;
`pnpm test:integration` incl. `tests/integration/seal.test.ts` (8 tests); `pnpm test:e2e` 29 (drawer
*Change passphrase…* round trip). Counts in PROGRESS.

## 3k. Real-host TODOs, batch 1 (2026-10-06, Harbor 0.23.0, decisions 130–141)

Fake-adapter and unit evidence (live droplet run of the tailnet port and remove/reinstall paths: pending,
see the 0.24.0 section once it exists):

- `pnpm test` 240 passed. `install-location`: `defaultInstallLocation` is `<data>/harbor-apps/<pkg>` only
  for an eligible data-folder candidate, never a drive. `migration`: `initializeState` with
  `FRESH_INSTALL_SETTINGS` writes `appearance.rotation {enabled: true, source: bing, everyHours: 24}`;
  without it the settings table stays empty. `package-text`: `<token>` accepted, control characters
  refused; a `template` renders `postgres://app:<value>@db…`, `encode: url` percent-encodes, the
  prospective model keeps `<<secret:id>>`; zero/two slots, `$`, or `encode` without a template refused;
  `showOnce` refused on operator secrets; `[redis-server, --save, "", …]` accepted (`[""]` still
  refused); `validatePackageFolder` passes `catalog/excalidraw`, finds a repo's `harbor/`, checks the
  Dockerfile in a build context, refuses `build:` in a flat folder and `ports:`.
- `pnpm test:integration` 180 passed + 3 live-Docker skipped. `repair.test.ts`: an install without a
  location carries the "Not encrypted" warning and `home: null`; `presentation.hideFromHome` is the
  default and the operator's `hidden` wins both ways; remove lists "Withdraw … Reinstall publishes it
  again", leaves no rows/Caddy routes/serve entries, reinstall re-publishes the public name (main again)
  and the tailnet one on a fresh port; on the removed app `unexpose --via tailnet` forgets it (a second
  one is NOT_FOUND) and the next reinstall publishes only the domain; an update with `failUp` leaves
  `needs_action` with the "harbor repair" next action, `unexpose` of the domain succeeds in that state,
  `expose` is still refused, Restart plans "Repair …" and brings revision 1 back `installed/running`;
  a container with no network flips runtime away from running and back; a failed restart removes it
  ("removed half-created container … (no network)"); port 80 taken: warn "another program" with Caddy
  down, info "Harbor's public proxy (Caddy)" with it up. `exposure.test.ts`: the tailnet port is in
  range and ≠ the app port, serve targets the app port, a later install never gets that port; a
  pre-0.23 row on the app port is moved by the observer with a `tailnet-moved` notification.
- `pnpm test:e2e` 29 passed (Hide from Home → "1 hidden app" → Show; wallpaper switch on at first start;
  "Basic-auth login for https://draw.example.com/, shown once").
- `pnpm catalog:verify`, `pnpm openapi -- --check` (84 paths, no new route): pass.

## 3l. Security round (2026-10-12, Harbor 0.31.0, decision 165)

A read-only audit by five reviewers (auth/guards, root boundary, packages, secrets/crypto, console/proxies); every
high and medium finding was confirmed against the code before it was fixed. **Developer host only — no live run yet.**

| Fix | Evidence |
|---|---|
| LAN names only from local peers | unit `selfupdate-lan.test.ts` (`isLanPeer`, Caddy `remote_ip` on both LAN routes, `refuseNonLanPeers` drops a public peer) |
| Drives `nosuid,nodev`, no stacking, system disk never removable | unit `device-mount.test.ts` (`mountArgsFor`, `mountedAt`), `host-storage.test.ts` (hotplug SATA system disk, USB swap disk) |
| Git build context on disk | unit `packages-store.test.ts`: a `loot -> <state>` link is refused and the target's 0700/0600 modes stay; inner links out (relative and absolute) refused; integration `git-sources.test.ts` unchanged |
| Recovery words never in `harbor.db` | integration `app-homes.test.ts` reads `operations.result_json` after the install (words absent, API still shows them); unit `migration.test.ts` v11→v12 strips them, `secure_delete` on |
| Login limits | integration `auth.test.ts`: 12 parallel guesses → exactly 5 evaluated; a full global window refuses a fifth stranger while a local client still logs in |
| Password change after a restart | integration `app-homes.test.ts`: the sealed blob opens with the new password, not the old one, and the change unlocks the machine |
| Local CA | integration `lan-ca.test.ts` (real openssl): critical name constraints + pathlen:0, a public address dropped from the leaf, a `bank.example.com` cert signed with the CA's own key fails `openssl verify` (*permitted subtree violation*); an older CA reads `caLimited: false` and replacing it changes fingerprint and key |
| New fixed port on update | integration `permissions.test.ts`: `opensPorts`, Update all skips it, submit without acceptance 409 `PERMISSION_REQUIRED` |
| Stored secrets keep their destination | integration `notifications.test.ts` (ntfy server / webhook url moved → 422), unit `backups.test.ts` (S3 endpoint moved → refused) |
| Relay scope and headers | unit `lan-https.test.ts` (`lanBoundPorts`, `forwardHeaders`); integration `lan-https-ws.test.ts` unchanged |

Gate: lint, typecheck, unit 351, integration 228 + 3 skipped, e2e 35, catalog verify/hash, openapi (103 paths) — all green.
**Not verified live yet:** Caddy's `remote_ip` match from a real public address, a real `nosuid` mount, the CA
replacement with a trusting browser, the fscrypt key file on `/run`.

## 3m. Fresh droplet acceptance + the 0.32.0 round (2026-10-13, Harbor 0.31.0 → 0.32.0, decisions 165–172)

**Live, fresh droplet** (`pnpm test:vm -- --fresh --exposure`, Ubuntu 24.04, archive 0.31.0 built from main):

| Run | Result |
|---|---|
| `vm-2026-10-13T03-57-37` | 16 pass / 8 fail / 1 blocked. **Found a real bug:** while A10 restarted Docker, the observer saw no containers and the lock-guard planned starts for every running sealed app; each failed on the dead socket and left the apps `needs_action` for good (readiness never probed), so B04/B05/B07/B09/B10 refused every exposure. Fixed in `d7dcedc` (guards only act on a tick that sees Docker; a start/stop/restart failing with `DOCKER_UNAVAILABLE` keeps the install state) with tests that fail without it. |
| `vm-2026-10-13T04-22-12` | **22 pass / 2 fail / 1 blocked** (B02/B03 tailnet: no auth key). New **B11 passed**: with LAN mode + Caddy on, a request from this Mac (a public client) with `Host: harbor.local` never reached the console, the box itself still did, and Caddy accepted the `remote_ip` matcher (decision 165). B10/B09 failed on stale runner expectations (decision 127 allows a second public name), fixed in the runner. |
| `vm-2026-10-13T04-44-26` (`--only B04,B05,B10,B09`) | B04, B05 (Let's Encrypt, basic auth) and B10 pass; B09's only complaint was the LAN-mode base URL left by B11 (runner now accepts it). |

**0.32.0 round (developer host, fake adapter):** six items built in separate worktrees, each reviewed by two
adversarial reviewers (correctness, security/regressions) and fixed: 50 review findings, all addressed or rejected
with reasons (details in decisions 167–172). Merged gate: lint, typecheck, unit 476 (+2 skipped), integration 285 +
3 skipped, e2e 38, catalog verify/hash, openapi current. Real-Docker evidence for decision 171 (Docker Desktop
29.2.1, throwaway `hbtest-linkalias-*` resources): a provider resolving `db` reached the consumer's `db` on the link
network while its own was stopped; after re-attaching without the alias, nothing answered. Signing: the real key
signed a local package, and OpenSSL 3 verified it with install.sh's own command. Upgrade jump: state written by
v0.19.1 (schema 8) and v0.22.1 (schema 10) with those releases' own code opens, migrates and works.

**Not verified live yet:** anything of 0.32.0 on a box (it needs the signing rollout first), cookie firewall with
real browsers, HTTPS only through Caddy, SFTP/SMTP against real servers, an old link switching over.

## 3n. App versions, the upstream update bot, safer automatic updates (2026-10-13, Harbor 0.33.0, decisions 174–176)

| What | Evidence |
|---|---|
| Version shown (174) | unit `package-version.test.ts` (manifest wins, main image's appVersion, variant dropped, prerelease kept, null when nothing says); integration `packages.test.ts` (`InstanceSummary.version` before/after an update); e2e: BentoPDF card shows `v2.8.8`, an uploaded app's card `v1.1`, its update review "from v1.1 to v1.2" |
| Tag choice (175) | unit `upstream-tags.test.ts`: same shape only, numeric compare, 0.x levels, databases keep their major, version→date switch refused, lockstep groups, text rewrite, strict `updates.json` |
| Registry reads (175) | `pnpm catalog:upstream check` against the real registries for all 139 harbor-apps packages (read-only, ~100 s): 40 moves, among them **immich 3.2.1 → 3.3.1 (minor, server + machine-learning together, database held)** and **open-webui 0.11.3 → 0.12.0 (major; ollama 0.34.0 → 0.34.4, kept within 0.34)**. A first pass without the guards proposed old date tags (heimdall 2.8.3 → 2021.11.28, tautulli, overseerr) and a Postgres major (librephotos 17 → 18); the guards removed them |
| Smoke on real Docker (175) | Docker Desktop 29.2.1 arm64 (dev loop, not an x86 box): `catalog:upstream apply` FreshRSS 1.30.0 → 1.30.1 on a copy, then `catalog:smoke --base`: install rev 1 healthy, update to rev 2 healthy, fresh install healthy (85 s, nothing left behind). With a broken health path the update rolled back and the result carried Harbor's events and the container log |
| land job (175) | its script, extracted from `updates.yml`, run against a throwaway clone with a stub `gh`: a patch touching another app refused; a patch update committed to main with index.json's revision raised (the result verifies and hashes clean); a major went to `updates/memos`, the refused PR fell back to an issue; a failed smoke opened an issue; ci.yml dispatched on main and on the branch |
| Auto-update gate (176) | integration `auto-update-backup.test.ts`: a failed backup holds the update (notice, not marked tried, no "update available" row); with a working place: backup first, then the update, `app-updated` notice, `updates.autoTried` stored; `auto-updates.test.ts` keeps rollback-not-retried and gains the notices |

Gate: lint, typecheck, unit 491 (+2 skipped), integration 288 + 3 skipped, e2e 38, catalog verify/hash, openapi current.
**On GitHub, after the 0.33.0 release** (harbor-apps `updates.yml`, dry runs: find + try, nothing landed), on
`ubuntu-24.04` runners (Ubuntu 24.04.5 LTS x86_64, Docker 28.0.4):

| Run | App | Result |
|---|---|---|
| 38426325250 | Open WebUI 0.11.3 → 0.12.0 (major; ollama 0.34.0 → 0.34.4) | **passed**: install rev 2 healthy after 102 s; update healthy after 101 s, no rollback; fresh install healthy after 32 s; each still healthy 60 s later |
| 38426325250 | Immich 3.2.1 → 3.3.1 (minor) | failed before Immich ran: ghcr.io answered `toomanyrequests` to Harbor's pull of four images → the try job now pulls each image by digest with retries (logged in to ghcr.io with the job's read-only token) |
| 38427932336 | Immich 3.2.1 → 3.3.1 (minor; database held) | **passed**: install healthy after 37 s; update healthy after 38 s, no rollback; fresh install healthy after 37 s; each still healthy 60 s later |

The first dispatch (38426002364) found a jq scope bug in the find job; fixed in harbor-apps before these runs.
**Not verified yet:** a non-dry run (land: commit, PR, issue, catalog dispatch on GitHub), an automatic update on a box.

## 3o. Local AI: the gpu permission (2026-10-13, Harbor 0.34.0, decision 179)

| What | Evidence |
|---|---|
| Format | unit `gpu.test.ts`: `gpu` accepted with all three decision-163 permissions, unknown values refused; package compose refuses `devices`, `deploy`, `runtime`, `group_add` |
| Render (pure) | unit: NVIDIA device request only; `/dev/dri` + render/video groups (merged after `/dev/net/tun`, deduplicated); nothing for none / toolkit missing / no facts / a service without the grant; a no-restart re-render reproduces the running file |
| Detection | unit, fake host roots: NVIDIA + `nvidia` runtime; NVIDIA + executable hook only (a non-executable one does not count); NVIDIA without toolkit + an nvidia-drm render node (harbor-old's layout) = none + `NVIDIA_TOOLKIT_MISSING`; `docker info` failing falls back to the hook; i915 → dri with gids; AMD next to NVIDIA-without-toolkit; nothing; unreadable root; 30 s cache |
| Plans, runtime, DTOs | integration `gpu.test.ts` (fake engine + injected FakeGpu): review lists gpu, `PERMISSION_REQUIRED` until accepted, CPU line; toolkit problem in `InstanceDetail.gpu` and `/v1/system/host`; NVIDIA after the toolkit: Restart writes the device request, `inUse` flips; update adding gpu skipped by update-all and refused without acceptance; dri render |
| Console | e2e decision 179 (fake NVIDIA machine): the review names the card, Install waits for the box, the drawer shows *Graphics card … (in use)*, Settings → Overview shows the card |

Review fixes (2026-10-14, before the release):

| What | Evidence |
|---|---|
| Hook newer than dockerd | unit: a hook installed after dockerd started (ctime vs `/run/docker.pid` + `/proc/<pid>/stat` + btime) is `NVIDIA_DOCKER_RESTART_NEEDED`, also with an unknown start time; one installed before is `nvidia`; the registered runtime wins; with Intel graphics too = dri + the problem. Integration: that problem renders no device request, the event names "Restart Docker" |
| `inUse` = the kind found now | integration: Intel graphics in use, then NVIDIA found → `inUse: false` until Restart switches the file; the toolkit removed again → `inUse: false` |
| Render node only | unit + integration: dri renders `/dev/dri/renderD128:/dev/dri/renderD128` + the node's gid (no `video`, no `card<N>`); the node name survives a no-restart re-render; no node, nothing |
| NVIDIA capabilities and variables | unit: the device request names `compute, utility`; a gpu service refuses `NVIDIA_VISIBLE_DEVICES` / `NVIDIA_DRIVER_CAPABILITIES` / `NVIDIA_MIG_CONFIG_DEVICES` literals and a setting bound to one; other services and `NVIDIA_DISABLE_REQUIRE` stay accepted (all 140 harbor-apps-local-ai packages verify) |
| Adopt with gpu | integration `app-homes.test.ts`: a second harness refuses the adopt with `PERMISSION_REQUIRED` and the home's files, its `resources` and `plans` stay untouched; with `acceptPermissions` it adopts and the install operation succeeds (first end-to-end adopt test: it found the `__home__` row hitting the foreign key before its instance existed; submit now records it with the instance) |
| Wording | unit: `gpuStatusLine` (harbor inspect) and `gpuFact` name the NVIDIA card next to Intel graphics; the console's `gpu-text.ts` for nvidia, dri, dri + toolkit missing, toolkit missing, restart needed, none and a failed check, asking and not |

**Verified live on harbor-old** (2026-10-14, RTX 3090, driver 595.99.02, Docker 29.8.1, Harbor 0.34.0 from the signed
release; [docs/evidence/live-gpu-2026-10-14](evidence/live-gpu-2026-10-14/README.md)). Each machine state
gave the expected result:

| Machine state | Result |
|---|---|
| No toolkit | `NVIDIA_TOOLKIT_MISSING`; the CPU install has no device request. The NVIDIA-owned `/dev/dri` node is ignored. |
| Toolkit installed, Docker not restarted | `NVIDIA_DOCKER_RESTART_NEEDED` (the dockerd start-time check works for the service user). |
| Docker restarted | The app showed *found; restart the app*. Restart gave a device request `nvidia` / all / `gpu,compute,utility`, `nvidia-smi` worked in the container, and Ollama ran on `library=CUDA`. |
| Linked Open WebUI | Ollama kept the GPU after the link re-render. A prompt over `http://ollama-link:11434` ran **100% GPU**, 29/29 layers, 255 tokens/s. |

Not covered live: the Intel/AMD path (no such host).

## 3p. App settings (2026-10-14, Harbor 0.34.0, decision 180)

| What | Evidence |
|---|---|
| Format | unit `app-settings.test.ts`: every type accepted; unknown keys, bad types, empty bindings, multi-line strings, bad ids and `$` templates refused by the schema; the validator refuses a default that does not fit (range, integer, type, choice), rules of another type (`min` on boolean, `maxLength` on integer, `choices` on string, `onValue` on string), equal on/off values, duplicate ids, unknown services, a template without `{{value}}`, and a variable already set by compose (with "move that value into the setting's default"), a secret, a link or another setting |
| Render (pure) | unit: defaults when nothing is stored; overrides win; a disallowed override falls back to the default; boolean onValue/offValue and true/false; templates; `$HOME${X}` rendered as `$$HOME$${X}` |
| Plans and submissions | unit: install plan asks every setting + one change line; submissions checked (range, type, choice, one line, ids the plan does not ask about) with `SETTING_INVALID`; configure lines "old -> new" and "(back to the default)", unchanged values skipped; update plan: reset (no longer allowed), new (asked), dropped, default change line; merge/prune for the runner; CLI `--set` parsing; console form helpers |
| End to end (fake engine) | integration `app-settings.test.ts`: install with defaults (no file, defaults in env, DTO); 400 `SETTING_INVALID` for out of range / unknown id / wrong type before any instance exists; install with chosen values (event lines, `settings.json` 0644 with overrides only, env, DTO); configure one value (re-render, change line, file); back to the default removes the override; same value = nothing to change; bad / unknown value refused; Restart keeps values; remove + reinstall keeps them; update resets the narrowed value, drops the removed setting, asks only for the new one and stores it; an unattended update gives the new one its default; purge deletes the file; a package without settings carries none. `backups.test.ts`: `settings.json` is in the cold stage, restore in place puts the backed-up file back, restore on another machine brings it along |
| Override equal to a new default | unit: an update whose default moves onto the operator's value keeps the override (no plan line), the next default change leaves the app at that value; choosing the default on the app page then follows it ("stays 8192, now as the default") |
| Console | e2e decision 180: the review's Options (collapsed, defaults, out-of-range blocks Install with "1 to fix" in the summary, an alert next to the buttons and the section kept open, "2 changed"); the app page lists values with *(default)*; Change… → form (Review disabled until a change, Reset to default) → *Review new settings* shows "Full → Half" and "16384 → 8192 (default)" → Apply → the page shows the new values |

Gate: lint, typecheck, unit 552 (+2 skipped), integration 328 + 3 skipped, e2e 41, `catalog:verify` (fixtures and the
140 harbor-apps-local-ai packages), `catalog:hash --check` (fixtures and harbor-apps-local-ai), `openapi --check`.
**Verified live on harbor-old** (same run): six Ollama settings reached the container env at install; `configure --set context-length=16384 --set keep-alive=30m` stored overrides only, re-rendered with the GPU and the link alias kept, `ollama ps` showed context 16384 / 29 min; out-of-choice and out-of-range values refused with `SETTING_INVALID`. Not covered live: the console forms (e2e only).


## 3q. Read-only NVIDIA driver checks (2026-10-14, Harbor 0.34.1, decision 181)

| What | Evidence |
|---|---|
| Card without a driver | unit `gpu.test.ts`, fake host roots: an NVIDIA VGA controller (class 0x030000) or 3D controller (0x030200) under `/sys/bus/pci/devices` with no `/proc/driver/nvidia/version` = none + `NVIDIA_DRIVER_MISSING`, "NVIDIA graphics card", also with the toolkit registered, bound to nouveau, and with the libraries installed (never "reboot"; worded "installed but not running" with the restart / Secure Boot step, never the install advice); a card bound to `vfio-pci` or `pci-stub` (handed to a VM) = no card, a second unbound one still counts; the HDMI audio function (0x0403) and other vendors alone = no card |
| Versions | unit: `parseNvidiaDriverVersion` reads the proprietary ("Kernel Module  550.163.01"), open x86_64 ("Open Kernel Module for x86_64  595.99.02") and aarch64 wording; every installed `libnvidia-ml.so.<v>` is read (numeric order: 595.100.1 > 595.99.02), also from /usr/lib64; `libraryVersion` = the running one's when installed, else the newest |
| Reboot / too old | unit: running 550 with only 595 installed = `NVIDIA_REBOOT_NEEDED`; running 595.99.02 with its library next to 610.1.1 or 550 = usable, no reboot claim; installed version unknown = no reboot claim (usable with the toolkit); 470 with the toolkit = `kind: nvidia` + the `NVIDIA_DRIVER_TOO_OLD` note (still handed over); 525.60.13 usable with no note |
| Order | unit: no driver before reboot; reboot before too old (470 running, 595 installed); too old without the toolkit = `NVIDIA_TOOLKIT_MISSING`; a working driver then `NVIDIA_TOOLKIT_MISSING` with both versions; Intel graphics next to a blocking driver problem = dri + that problem, next to a too-old usable card = nvidia + the note |
| Wording | unit: plan lines, `harbor gpu`/plan GPU fact ("(driver 595.99.02, ready for apps)"), `harbor inspect` ("(driver 595.99.02, in use)"), console machine/app/review text for each new problem and with unknown versions; no version next to a working card, the reboot problem names both versions; a pending reboot with the device request still rendered = "(in use), but the machine has not restarted…" |
| End to end (fake engine) | integration `gpu.test.ts`: each blocking driver problem (missing, installed but not loaded, reboot) reaches `InstanceDetail.gpu` and `GET /v1/system/host` with its versions, a Restart renders no device request and its event names the step; a usable card with a driver version renders the NVIDIA device request, `inUse: true`, and the install plan's `gpu` carries the versions; a reboot pending after the card was handed over = `inUse: true` until a Restart re-renders without it; a 470 driver keeps the device request, with the note in the Restart event |
| Console | e2e decision 179 (fake NVIDIA machine, driver 595.99.02): the drawer shows *NVIDIA GeForce RTX 3090 (driver 595.99.02, in use)*, Settings → Overview *… (driver 595.99.02)*; the review still reads *This machine has an NVIDIA GeForce RTX 3090: the app uses it.* |

Gate: lint, typecheck, unit 568 (+2 skipped), integration 331 + 3 skipped, e2e 41, catalog verify/hash (fixtures), openapi current (no new route).
**Live on harbor-old** (2026-10-14, self-updated 0.34.0 → 0.34.1 from the signed release, RTX 3090, driver 595.99.02
open, toolkit 1.20.1). The `harbor` service user reads `/sys/bus/pci/devices/*` (it found `0000:0a:00.0` class
0x030000 and ignored the audio function 0x040300), `libnvidia-ml.so.595.99.02` and `/proc/driver/nvidia/version`.

| Check | Output |
|---|---|
| `harbor gpu` | *NVIDIA GeForce RTX 3090 (driver 595.99.02, ready for apps)* |
| `harbor gpu --json` | `driverVersion` = `libraryVersion` = `595.99.02`, no problem |
| `harbor inspect ollama-gpu` | *NVIDIA GeForce RTX 3090 (driver 595.99.02, in use)*; the running app was not re-rendered by the update |

The three problem states are not reproduced live. They need a driver removed, an unrebooted update or a pre-525 driver.

## 3r. ComfyUI: image generation on the graphics card, linked from Open WebUI (2026-10-14, harbor-apps, decision 182)

No Harbor change: the harbor-apps packages `comfyui` revision 1, `open-webui` revision 5 and `open-webui-shared`
revision 2 (branch `comfyui`). `pnpm catalog:verify` passes on all 141 packages, and `catalog:hash --check` and
`catalog:plan` (comfyui and open-webui at 0.34.0, open-webui-shared at the 0.28.0 default, which already accepts
optional links) also pass.

**Verified live on harbor-old** (RTX 3090, driver 595.99.02, Harbor 0.34.1; uploaded under test ids;
[docs/evidence/live-comfyui-2026-10-14](evidence/live-comfyui-2026-10-14/README.md)):

| What | Result |
|---|---|
| Install with gpu | device request for the RTX 3090; `Device: cuda:0 NVIDIA GeForce RTX 3090`, ComfyUI 0.40.0, healthy at `/system_stats` after 10 attempts |
| No card (same image, no `--gpus`) | the image's own start exits (`Found no NVIDIA driver`); the package's command starts it on `Device: cpu`, healthy in about 20 s |
| Model download | the Manager's install queue put SDXL base (6.94 GB) in `models/checkpoints/SDXL` |
| Link added later | `configure --link comfyui=…` on an Open WebUI that already ran: the network was created and ComfyUI was attached live (not restarted); the address answers from Open WebUI |
| Link at install | a fresh Open WebUI starts with the ComfyUI address, the node map, 1024x1024 and 25 steps; after the three README steps, `POST /api/v1/images/generations` returned a 1024 x 1024 PNG in 16.2 s (14.2 s warm) at 100 % GPU |
| Update | revision 1 → 2 kept models and outputs, re-attached both link networks, ran the new image's ComfyUI |

Not covered live: the chat's Image button in a browser (it calls the same route), FLUX workflows.

### Run vm-2026-09-14T17-27-18 (fresh VM) — FAILED at A01, fixed

Bootstrap #1 on the fresh VM passed (Docker 29.8.0 / Compose 5.5.1 installed, all listeners loopback-only, CLI login).
Bootstrap #2 (re-run with `--with-tools`) failed: `EEXIST /opt/harbor/node_modules/.bin` because Node's `cpSync`
cannot overwrite existing symlinks. Fixed in `replaceReleaseFiles` (remove each release entry before copying;
unit test `tests/unit/bootstrap-files.test.ts`). Evidence: `docs/evidence/vm-2026-09-14T17-27-18/`.

Run **vm-2026-09-14T18-40-00** (2026-09-14T18:40:00.762Z → 2026-09-14T18:54:00.303Z). Full table with notes: `docs/evidence/vm-2026-09-14T18-40-00/report.md`; details: `report.json`.
Result counts: 16 pass.

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **PASS** | VM rebuilt to a fresh image before this run<br>fixture: Cockpit pre-installed from Ubuntu repos before bootstrap (tests binding an existing tool)<br>Docker 29.8.0 / Compose 5.5.1 installed by bootstrap; Node v24.12.0 bundled<br>bootstrap re-run kept installation id and administrator |
| A02 | CLI and UI show three real pinned packages; invalid package hash/schema rejected before effects | **PASS** | tampered compose.yaml -> catalog unavailable + plan 422 INVALID_PACKAGE, zero Docker effects |
| A03 | Excalidraw + BentoPDF coexist; representative browser actions; installing B does not recreate A | **PASS** | Excalidraw rectangle drawn and exported as PNG (download)<br>BentoPDF merged two PDFs into a 2-page PDF (download)<br>Excalidraw container ids/creation times unchanged by BentoPDF install |
| A04 | Second Excalidraw has distinct project/network/ports; a fourth supported-profile package needs no engine branch | **PASS** | second Excalidraw: distinct UUID, project network and host port<br>fourth package (package files + index only) installed and answered; engine untouched |
| A05 | Occupied port/name or conflicting foreign resource fails safely; no foreign listener/container is stopped | **PASS** | sentinel container occupies 127.0.0.1:18084; planner skipped it<br>duplicate name -> 409 NAME_CONFLICT<br>sentinel still running with the same id |
| A06 | Refresh, logout, CLI disconnect and duplicate submission do not cancel/duplicate an accepted operation | **PASS** | same key -> same operation id; different key on consumed plan -> 409 IDEMPOTENCY_CONFLICT<br>UI reload required login, then showed the single accepted instance |
| A07 | Expired/stale plan and reused key with different request are rejected; same request returns original | **PASS** | stale plan (generation changed) -> 409 STATE_CHANGED<br>reused key with different plan -> 409 IDEMPOTENCY_CONFLICT; same request -> original operation<br>plan expiry (15 min) is covered by tests/integration/install.test.ts with a controlled clock |
| A08 | Stop/start/remove acts on one instance only; retains persistence; tools and sentinel unchanged | **PASS** | stop/start/remove on pdf-b left Excalidraw, Portainer and the sentinel untouched<br>pdf-b retained with its name and port allocation |
| A11 | n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys | **PASS** | owner created through the n8n setup form (synthetic credentials)<br>credential + workflow created via n8n REST (as the browser does); manual execution status success; fixture saw credentialed call: true<br>second n8n: separate volumes and different generated keys; no PostgreSQL port published<br>Excalidraw still answers |
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **PASS** | remove retained the database volume (same creation time/token) and keys; reinstall reused the exact port and key<br>same owner login, stored workflow and credential worked after reinstall (execution success, fixture credentialed hit true)<br>deleted volume of the second instance -> reinstall needs_action DATA_MISSING, no replacement volume, instance stays retained |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **PASS** | install completed (failed) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts<br>Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: short sessions live in memory only; a remembered browser keeps its 30-day token in localStorage (revoked on logout); logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **PASS** | Cockpit external (pre-installed fixture bound without reconfiguring its listener): login with an OS account succeeded<br>Portainer managed: card showed setup_required before; first-run admin created in its own form with the setup token from the container log; card now installed (admin check HTTP 204)<br>tools absent before --with-tools were shown as not_installed with no fake link (A01 evidence)<br>binding a managed tool is rejected (undefined) |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>host reboot (2026-09-14 18:40:29 -> 2026-09-14 18:53:02): desired-running apps healthy again, excalidraw-2 stayed stopped |
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **PASS** | malformed/oversized/invalid API bodies -> 4xx with zero Docker effects<br>package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected<br>full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **PASS** | run started from a rebuilt VM |

Evidence files: `A02-ui-catalog.png`, `A03-bentopdf-merge.png`, `A03-bentopdf-merged.pdf`, `A03-excalidraw-drawing.png`, `A03-excalidraw-export.png`, `A06-ui-after-relogin.png`, `A09-ui-after-daemon-restart.png`, `A11-n8n-after-owner-setup.png`, `A12-n8n-after-reinstall.png`, `A14-cockpit-after-login.png`, `A14-harbor-tools-cards.png`, `A14-portainer-after-onboarding.png`, `bootstrap-1.log`, `bootstrap-2.log`, `fixture-a.pdf`, `fixture-b.pdf`.

### Exposure runs (branch `exposure`)

Run **vm-2026-09-14T23-19-02** (fresh VM, `--fresh --exposure`): 23 checks, A01–A16 all passed again (with the console groundwork), B01/B05/B07 passed; B04, B09 and B10 failed for runner reasons only (a leftover placeholder call before the real `expose`, a state cascade from B04, an SSH banner-exchange timeout). B02/B03 (tailnet) blocked: no Tailscale auth key available. Report: `docs/evidence/vm-2026-09-14T23-19-02/report.md`.

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **PASS** | VM rebuilt to a fresh image before this run<br>fixture: Cockpit pre-installed from Ubuntu repos before bootstrap (tests binding an existing tool)<br>Docker 29.8.0 / Compose 5.5.1 installed by bootstrap; Node v24.12.0 bundled<br>bootstrap re-run kept installation id and administrator |
| A02 | CLI and UI show three real pinned packages; invalid package hash/schema rejected before effects | **PASS** | tampered compose.yaml -> catalog unavailable + plan 422 INVALID_PACKAGE, zero Docker effects |
| A03 | Excalidraw + BentoPDF coexist; representative browser actions; installing B does not recreate A | **PASS** | Excalidraw rectangle drawn and exported as PNG (download)<br>BentoPDF merged two PDFs into a 2-page PDF (download)<br>Excalidraw container ids/creation times unchanged by BentoPDF install |
| A04 | Second Excalidraw has distinct project/network/ports; a fourth supported-profile package needs no engine branch | **PASS** | second Excalidraw: distinct UUID, project network and host port<br>fourth package (package files + index only) installed and answered; engine untouched |
| A05 | Occupied port/name or conflicting foreign resource fails safely; no foreign listener/container is stopped | **PASS** | sentinel container occupies 127.0.0.1:18084; planner skipped it<br>duplicate name -> 409 NAME_CONFLICT<br>sentinel still running with the same id |
| A06 | Refresh, logout, CLI disconnect and duplicate submission do not cancel/duplicate an accepted operation | **PASS** | same key -> same operation id; different key on consumed plan -> 409 IDEMPOTENCY_CONFLICT<br>UI reload required login, then showed the single accepted instance |
| A07 | Expired/stale plan and reused key with different request are rejected; same request returns original | **PASS** | stale plan (generation changed) -> 409 STATE_CHANGED<br>reused key with different plan -> 409 IDEMPOTENCY_CONFLICT; same request -> original operation<br>plan expiry (15 min) is covered by tests/integration/install.test.ts with a controlled clock |
| A08 | Stop/start/remove acts on one instance only; retains persistence; tools and sentinel unchanged | **PASS** | stop/start/remove on pdf-b left Excalidraw, Portainer and the sentinel untouched<br>pdf-b retained with its name and port allocation |
| A11 | n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys | **PASS** | owner created through the n8n setup form (synthetic credentials)<br>credential + workflow created via n8n REST (as the browser does); manual execution status success; fixture saw credentialed call: true<br>second n8n: separate volumes and different generated keys; no PostgreSQL port published<br>Excalidraw still answers |
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **PASS** | remove retained the database volume (same creation time/token) and keys; reinstall reused the exact port and key<br>same owner login, stored workflow and credential worked after reinstall (execution success, fixture credentialed hit true)<br>deleted volume of the second instance -> reinstall needs_action DATA_MISSING, no replacement volume, instance stays retained |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **PASS** | install completed (failed) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts<br>Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: short sessions live in memory only; a remembered browser keeps its 30-day token in localStorage (revoked on logout); logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **PASS** | Cockpit external (pre-installed fixture bound without reconfiguring its listener): login with an OS account succeeded<br>Portainer managed: card showed setup_required before; first-run admin created in its own form with the setup token from the container log; card now installed (admin check HTTP 204)<br>tools absent before --with-tools were shown as not_installed with no fake link (A01 evidence)<br>binding a managed tool is rejected (undefined) |
| B01 | Exposure providers bootstrapped with approval; tool cards honest; re-run idempotent | **PASS** | proxy: installed/reachable<br>tailscale: setup_required/unreachable — Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).<br>bootstrap re-run with providers succeeded (idempotent) |
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **FAIL** | harbor plan expose 2ebfc7c8-21c1-4973-9170-6fc33b4b9e8b exited 2:  {
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mu1vmmc3.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B07 | Provider down: exposures degrade, apps stay fine on loopback; recovery | **PASS** | caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again |
| B10 | Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config | **FAIL** | harbor list exited 255: Connection timed out during banner exchange
| B02 | Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet | **BLOCKED** | BLOCKED: Tailscale node not enrolled/HTTPS-enabled on the VM (setup_required: Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).). Provide HARBOR_TS_AUTHKEY (a tailnet auth key) and enable MagicDNS+HTTPS in the admin console to run B02/B03 live. Engine behaviour is covered by tests/integration/exposure.test.ts. |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>host reboot (2026-09-14 23:19:26 -> 2026-09-14 23:32:53): desired-running apps healthy again, excalidraw-2 stayed stopped |
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **FAIL** | harbor primary 2ebfc7c8-21c1-4973-9170-6fc33b4b9e8b loopback --yes exited 3:  {
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **PASS** | malformed/oversized/invalid API bodies -> 4xx with zero Docker effects<br>package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected<br>full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **PASS** | run started from a rebuilt VM |

Run **vm-2026-09-14T23-36-24** (`--only B04,B05,B07,B10,B09` on the same host after the runner fixes): B04 (public n8n as primary over a real Let's Encrypt certificate, owner login and workflow through the public URL), B05 (BentoPDF behind basic auth), B07 (Caddy stopped → degraded, loopback fine → recovered) and B09 (primary back to loopback, routes withdrawn) **passed**. B10 failed because BentoPDF was still published from B05; the step now uses unpublished instances and re-runs with the final fresh run. Report: `docs/evidence/vm-2026-09-14T23-36-24/report.md`.

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **PASS** | n8n published at https://harbor-n8n-mu1vtjer.apein.space/ (active); certificate: issuer=C = US, O = Let's Encrypt, CN = YE2<br>primary switched to public: N8N_EDITOR_BASE_URL: "https://harbor-n8n-mu1vtjer.apein.space/" \|       WEBHOOK_URL: "https://harbor-n8n-mu1vtjer.apein.space/"<br>owner login + credentialed workflow through the public URL: success |
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mu1vu790.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B07 | Provider down: exposures degrade, apps stay fine on loopback; recovery | **PASS** | caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again |
| B10 | Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config | **FAIL** | harbor expose 546ed117-61b5-47fc-8d22-d6d517e042d5 --via public --host harbor-dup-mu1vv2c4.apein.space --protect none --yes exited 3:  {
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **PASS** | primary back to loopback: base URL env re-rendered, workflow ran locally<br>unexpose removed Caddy routes (2 -> 0) |

### Final run vm-2026-09-15T01-01-08 (fresh VM, console + 17-package catalog + exposure) — 22 pass, 1 blocked, 0 fail

`pnpm test:vm -- --fresh --exposure` on a freshly rebuilt Ubuntu 24.04.4 x86-64 droplet with the delivered archive: **A01–A16 all passed**, B01/B04/B05/B07/B09/B10 passed (public path over real DNS and Let's Encrypt, provider outage and recovery, primary switching, negative cases), B02/B03 blocked (tailnet: no Tailscale auth key). Report: `docs/evidence/vm-2026-09-15T01-01-08/report.md`; details: `report.json`.

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| A01 | Clean VM bootstrap without Node/npm; re-run preserves identity/admin/app state | **PASS** | VM rebuilt to a fresh image before this run<br>fixture: Cockpit pre-installed from Ubuntu repos before bootstrap (tests binding an existing tool)<br>Docker 29.8.0 / Compose 5.5.1 installed by bootstrap; Node v24.12.0 bundled<br>bootstrap re-run kept installation id and administrator |
| A02 | CLI and UI show the real pinned catalog (incl. the three demo packages); invalid package hash/schema rejected before effects | **PASS** | tampered compose.yaml -> catalog unavailable + plan 422 INVALID_PACKAGE, zero Docker effects |
| A03 | Excalidraw + BentoPDF coexist; representative browser actions; installing B does not recreate A | **PASS** | Excalidraw rectangle drawn and exported as PNG (download)<br>BentoPDF merged two PDFs into a 2-page PDF (download)<br>Excalidraw container ids/creation times unchanged by BentoPDF install |
| A04 | Second Excalidraw has distinct project/network/ports; a fourth supported-profile package needs no engine branch | **PASS** | second Excalidraw: distinct UUID, project network and host port<br>fourth package (package files + index only) installed and answered; engine untouched |
| A05 | Occupied port/name or conflicting foreign resource fails safely; no foreign listener/container is stopped | **PASS** | sentinel container occupies 127.0.0.1:18084; planner skipped it<br>duplicate name -> 409 NAME_CONFLICT<br>sentinel still running with the same id |
| A06 | Refresh, logout, CLI disconnect and duplicate submission do not cancel/duplicate an accepted operation | **PASS** | same key -> same operation id; different key on consumed plan -> 409 IDEMPOTENCY_CONFLICT<br>UI reload required login, then showed the single accepted instance |
| A07 | Expired/stale plan and reused key with different request are rejected; same request returns original | **PASS** | stale plan (generation changed) -> 409 STATE_CHANGED<br>reused key with different plan -> 409 IDEMPOTENCY_CONFLICT; same request -> original operation<br>plan expiry (15 min) is covered by tests/integration/install.test.ts with a controlled clock |
| A08 | Stop/start/remove acts on one instance only; retains persistence; tools and sentinel unchanged | **PASS** | stop/start/remove on pdf-b left Excalidraw, Portainer and the sentinel untouched<br>pdf-b retained with its name and port allocation |
| A11 | n8n/PostgreSQL installs; owner setup and credentialed workflow execution; two copies have separate volumes/keys | **PASS** | owner created through the n8n setup form (synthetic credentials)<br>credential + workflow created via n8n REST (as the browser does); manual execution status success; fixture saw credentialed call: true<br>second n8n: separate volumes and different generated keys; no PostgreSQL port published<br>Excalidraw still answers |
| A12 | Remove/reinstall the exact n8n instance preserves workflow and credential; missing volume blocks without replacement | **PASS** | remove retained the database volume (same creation time/token) and keys; reinstall reused the exact port and key<br>same owner login, stored workflow and credential worked after reinstall (execution success, fixture credentialed hit true)<br>deleted volume of the second instance -> reinstall needs_action DATA_MISSING, no replacement volume, instance stays retained |
| A10 | Failed/interrupted install shows needs_action, retains scope, no blind replay; Docker unavailable is not healthy | **PASS** | install completed (failed) before the restart took effect; interruption semantics are covered by tests/integration/lifecycle.test.ts<br>Docker stopped -> Harbor stayed active, system docker.available=false, instances unavailable/unknown (none healthy), plan -> 503 DOCKER_UNAVAILABLE; Docker started -> healthy again |
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: short sessions live in memory only; a remembered browser keeps its 30-day token in localStorage (revoked on logout); logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
| A14 | Cockpit and Portainer bootstrapped with approval; onboarding works; real Open links; absent/external tools honest | **PASS** | Cockpit external (pre-installed fixture bound without reconfiguring its listener): login with an OS account succeeded<br>Portainer managed: card showed setup_required before; first-run admin created in its own form with the setup token from the container log; card now installed (admin check HTTP 204)<br>tools absent before --with-tools were shown as not_installed with no fake link (A01 evidence)<br>binding a managed tool is rejected (undefined) |
| B01 | Exposure providers bootstrapped with approval; tool cards honest; re-run idempotent | **PASS** | proxy: installed/reachable<br>tailscale: setup_required/unreachable — Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).<br>bootstrap re-run with providers succeeded (idempotent) |
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **PASS** | n8n published at https://harbor-n8n-mu1zalzb.apein.space/ (active); certificate: issuer=C = US, O = Let's Encrypt, CN = YE1<br>primary switched to public: N8N_EDITOR_BASE_URL: "https://harbor-n8n-mu1zalzb.apein.space/" \|       WEBHOOK_URL: "https://harbor-n8n-mu1zalzb.apein.space/"<br>owner login + credentialed workflow through the public URL: success |
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mu1zbf9a.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B07 | Provider down: exposures degrade, apps stay fine on loopback; recovery | **PASS** | caddy stopped -> public addresses degraded with a reason, loopback app still 200; caddy started -> active again |
| B10 | Negative: invalid hostname, duplicate hostname, unknown provider state → clear errors, no partial config | **PASS** | invalid hostname -> INVALID_REQUEST; duplicate hostname -> NAME_CONFLICT; second public exposure of the same endpoint -> INVALID_STATE; exactly one route was added |
| B02 | Tailnet exposure of Excalidraw (same port) and B03 Harbor UI on the tailnet | **BLOCKED** | BLOCKED: Tailscale node not enrolled/HTTPS-enabled on the VM (setup_required: Installed but not logged in (state NeedsLogin). Run: sudo tailscale up  (then approve the printed login URL).). Provide HARBOR_TS_AUTHKEY (a tailnet auth key) and enable MagicDNS+HTTPS in the admin console to run B02/B03 live. Engine behaviour is covered by tests/integration/exposure.test.ts. |
| A09 | Daemon restart leaves apps running; host reboot returns desired-running apps; intentional stop stays stopped | **PASS** | daemon restart: container ids/creation unchanged; UI recovered after login<br>host reboot (2026-09-15 01:01:38 -> 2026-09-15 01:16:29): desired-running apps healthy again, excalidraw-2 stayed stopped |
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **PASS** | primary back to loopback: base URL env re-rendered, workflow ran locally<br>unexpose removed Caddy routes (2 -> 0) |
| A15 | Package traversal/aliases/duplicate keys/interpolation/undeclared mounts/privileges rejected; malformed API bodies never execute | **PASS** | malformed/oversized/invalid API bodies -> 4xx with zero Docker effects<br>package with privileged/alias/interpolation/bind mount -> unavailable in catalog, plan rejected<br>full parser/schema negative matrix: tests/unit/yaml.test.ts, manifest.test.ts |
| A16 | Build artifact installs and reproduces the full section-1 demo with recorded results | **PASS** | run started from a rebuilt VM |

Evidence files: `A02-ui-catalog.png`, `A03-bentopdf-merge.png`, `A03-bentopdf-merged.pdf`, `A03-excalidraw-drawing.png`, `A03-excalidraw-export.png`, `A06-ui-after-relogin.png`, `A09-ui-after-daemon-restart.png`, `A11-n8n-after-owner-setup.png`, `A12-n8n-after-reinstall.png`, `A14-cockpit-after-login.png`, `A14-harbor-tools-cards.png`, `A14-portainer-after-onboarding.png`, `B04-n8n-public.png`, `B05-merged-public.pdf`, `bootstrap-1.log`, `bootstrap-2.log`, `bootstrap-3-exposure-rerun.log`, `fixture-a.pdf`, `fixture-b.pdf`.

### Tailnet enrollment with a real auth key (runs vm-2026-09-15T03-53-52 and vm-2026-09-15T03-57-13)

Carlos provided a tailnet auth key on 2026-09-15 (kept only in the git-ignored `.env.vm.local`, fed to bootstrap over stdin). Run 12 found two bootstrap bugs (decision 45): the key was handed to the Tailscale CLI as `--auth-key=env:TS_AUTHKEY`, which the CLI took literally ("invalid key: unable to validate API key"), and the failed tool step left the daemon stopped after the release update. Both fixed; run 13 (`--only B01,B02` on the same host): **B01 passed** and the node is enrolled as `harbor-test.<tailnet>.ts.net`; B02/B03 were still BLOCKED then with the exact reason from the tool card: HTTPS certificates not enabled for the tailnet. After Carlos enabled MagicDNS + HTTPS, run **vm-2026-09-15T04-20-57** (`--only B02`): **B02/B03 PASSED** — Excalidraw published at `https://harbor-test.<tailnet>.ts.net:18080/` (same port as loopback) answered HTTP 200 over the tailnet name with a tailnet certificate, and the Harbor console was published at `https://harbor-test.<tailnet>.ts.net/`; both withdrawn again by the step. Reachability was verified from the node itself (no second tailnet device in the run). Reports: `docs/evidence/vm-2026-09-15T03-57-13/report.md`, `docs/evidence/vm-2026-09-15T04-20-57/report.md`.

### Settings for humans (v0.3.0, 2026-09-15)

Password change, Tailscale login/logout, host storage and the folder picker are covered by `tests/integration/settings.test.ts` (fake Tailscale, real filesystem under a temporary data folder) and two Playwright tests (picker-driven install, settings flows). Live on the droplet after re-bootstrap from the `v0.3.0` archive: `harbor storage` reports the data folder `/srv/harbor` as ready and one system disk; the Tailscale card reports the enrolled node with MagicDNS and HTTPS enabled; the console's Remote access, Storage and Home pages were opened through an SSH tunnel (screenshots kept out of the repo). Found and fixed live: the systemd unit's `ProtectSystem=strict` made `/srv/harbor` read-only for the daemon until `ReadWritePaths` included it, and the service's private `/tmp` and bind mounts appeared as extra "disks" until mounts were deduplicated by device.

### v0.4.0: full uninstall, domains wizard, palette (2026-09-15)

Covered by `tests/integration/purge-domains.test.ts` (purge deletes only Harbor-created volumes, keeps the operator's folders, frees name and ports, skips a foreign volume; domains lifecycle with a fake resolver; wallpaper upload/serve/remove) and Playwright (typed-confirmation uninstall, domains wizard feeding the publish dropdown, ⌘K palette). Live on the droplet: the in-place upgrade to schema v4 first failed in bootstrap (decision 53) and passed after the fix with the daemon back up; `harbor purge interrupted --yes` removed the acceptance suite's failed test instance; `harbor domains add harbor-demo.apein.space` (a real A record created for the check) reported *points here* against the detected public address; the console stayed published on the tailnet.

### v0.5.0: rotating wallpapers, personal launcher, the machine (2026-09-15)

Automated: `tests/unit/wallpaper-sources.test.ts` (Reddit OAuth + listing filters, Bing credit parsing, Wikimedia 1920px rendition, polkit rule scope, host facts), migration v1→v5, OpenAPI route list; `tests/integration/appearance.test.ts` (rotation on/off/next/schedule/failure with the fake fetcher, Reddit credentials never returned, launcher order, display name + glyph/picture icon served openly, purge cleanup, power control); Playwright `tests/e2e/ui.spec.ts` (customize name/emoji/picture icon, mouse drag + keyboard arrange persisted across reload, rotation switch + Reddit key flow + credit line, Settings overview + restart confirmation). Local run: unit 65 passed, integration 64 passed + 3 live-Docker skipped, e2e 16 passed.

Live on the droplet (in-place upgrade 0.4.0 → 0.5.0 by `bootstrap --yes --with-tools --with-tailscale --with-public-proxy`; schema migrated to v5; polkit rule `/etc/polkit-1/rules.d/49-harbor-power.rules` installed):

| Check | Result |
|---|---|
| Reddit anonymous listing (`www.reddit.com/r/EarthPorn/top.json`, `api.reddit.com`, `old.reddit.com`) from laptop and droplet | HTTP 403 / "Blocked" everywhere → Reddit source requires the operator's own app credentials (decision 55) |
| `PUT /v1/appearance/rotation {enabled:true, source:bing}` | picture fetched at once: *Field of kochia plants, China* (lingqi xie/Getty Images), 3.7 MB JPEG stored 0600 under `/var/lib/harbor`, `nextAt` +24 h |
| `GET /v1/appearance/wallpaper` (no token) | 200 `image/jpeg`, `content-security-policy: default-src 'none'; sandbox`, `nosniff` |
| `POST /v1/appearance/rotation/next` | a different Bing picture each time (Gabit Keni Beach; Flight 93 Memorial) |
| `source: wikimedia` | first attempt failed (HTTP 400: Wikimedia only serves standard thumbnail widths) → fixed to the 1920px rendition; redeployed; *Breil-Brigels reservoir* (Agnes Monkelbaan) 596 KB and *Oregon Trail reenactment* (BLM) fetched fine |
| `GET /v1/system/host` | `harbor-test`, Ubuntu 24.04.4 LTS, x64, DO-Regular, `power.available: true` |
| `GET /v1/system/metrics` | host facts present; `temperatureC: null` (VM exposes no thermal zone; UI says "Not reported by this machine") |
| `harbor wallpaper` (CLI on the droplet) | prints the current picture, source, interval and next change |
| `POST /v1/system/power {action:"reboot"}` from the console's session (harbor user, no root) | 202; boot id changed; ~20 s later Harbor `healthz` 200, Caddy and Tailscale active, all 11 containers running again |
| Console screenshots (12) | `docs/evidence/ui-2026-09-15-v0.5.0/` (login clock, launcher with credit, drawer, customize, arrange, overview, restart dialog, appearance, palette, phone, light) |

Not verified live: a real Reddit fetch (needs Reddit app credentials I do not have; the OAuth flow and listing parsing are covered by unit and integration tests against Reddit's documented shapes, and a bad key surfaces as "Reddit refused the app credentials" in Settings). Shut down was not exercised on the droplet (same code path as restart with `poweroff`; the user is testing on it).

### v0.6.0: your own apps and updates (2026-09-15)

Automated: `tests/unit/packages-store.test.ts` (zip reader incl. top-folder strip, path tricks, CRC, limits; image reference parsing; numeric-aware revision ordering; store import: pin by digest, generated release.json, built-in id refusal, unknown image, older/conflicting/identical revisions, higher revision replaces, remove), `tests/integration/packages.test.ts` (upload → local catalog item with served icon → install → higher revision marks `updateAvailable` → update keeps port and tailnet address, swaps the container image, keeps `release-previous/`, generates the new secret → a failing update rolls back and the app stays installed and running on the old revision → an update adding a volume and an endpoint creates both → package removal refused while installed, allowed after purge → a newer *bundled* revision surfaces as an update), Playwright (upload dialog with pin report, *Your apps* filter and badge, install, second upload offers the update, Home card, tile badge, drawer banner, review and tray, same address after the update). Local run: unit 70 passed, integration 69 passed + 3 live-Docker skipped, e2e 17 passed.

Live on the droplet (in-place upgrade 0.5.0 → 0.6.0; real Docker Hub registry; nothing mocked):

| Check | Result |
|---|---|
| `harbor packages add hello-nginx-1.zip` (compose says `nginx:1.27-alpine`) | 1.5 s; pinned `web: nginx:1.27-alpine -> nginx@sha256:65645c7b…` from Docker Hub; listed as *yours*, qualification `pending` |
| `harbor install hello-nginx --yes` | installed on 127.0.0.1:18087, readiness 200 on first probe; container image `65645c7bb6a0` |
| `harbor packages add hello-nginx-2.zip` (`nginx:1.28-alpine`) | pinned `nginx@sha256:a8b39bd9…`; "replaces revision 1"; `harbor list` UPDATE column shows `-> 2 (1.28)`; Home shows *1 update available*, tile badge, drawer banner, review plan with the image change (screenshots) |
| `harbor packages add hello-nginx-3-broken.zip` (`nginx:1.99-does-not-exist`) | refused at upload: `INVALID_PACKAGE … GET library/nginx/manifests/1.99-does-not-exist answered HTTP 404 (no such image or tag)` |
| `harbor update hello-nginx --yes` | succeeded; container now `a8b39bd9cf0f`; same port 18087, app answers 200; instance dir has `release/` (revision 2) and `release-previous/` (revision 1) |
| upload revision 3 with a health path that 404s, then `harbor update` | operation **failed with rollback**: events "restoring revision 2 … hello-nginx is back on revision 2; your data was not changed by Harbor"; `harbor list` shows `hello-nginx@2 installed running healthy` with `-> 3` still offered; container `a8b39bd9cf0f Up`, app answers 200 |
| cleanup | `harbor purge`, `harbor packages remove hello-nginx`, re-upload revision 2 and install: left running for Carlos to look at |
| Console screenshots (6) | `docs/evidence/ui-2026-09-15-v0.6.0/` |

### v0.7.0: terminal, troubleshoot, two-factor, device name, Tailscale self-heal (2026-09-15)

Automated: `tests/unit/totp.test.ts` (RFC 6238 SHA-1 vectors, base32 round trip, drift window, otpauth URL, systemd unit/polkit text, Docker log demux), `tests/integration/security-terminal.test.ts` (two-factor: setup → enable with a live code → login needs the code → wrong/replayed codes refused → password disables; device name; Harbor and app logs; terminal over WebSocket: refused without a session, echoes a command, honours the requested size, exits cleanly), Playwright (terminal typing and exit, Troubleshoot Harbor and app logs, rename with tab title, two-factor setup + login with the code field appearing only after the password). Local run: unit 74 passed, integration 72 passed + 3 skipped, e2e 19 passed.

Live on the droplet (in-place upgrade 0.6.0 → 0.7.0):

| Check | Result |
|---|---|
| Tailscale operator grant | root wiped it (`tailscale set --operator=""`); `sudo -u harbor systemctl start harbor-tailscale-operator.service` restored `OperatorUser: harbor` through the polkit rule |
| *Log in with Tailscale* after a disconnect (the bug Carlos hit) | grant wiped again, then `harbor tailscale login` (same path as the console button): Harbor restored the grant and returned a `https://login.tailscale.com/a/…` link; a second click while the first login was still pending returned the link again (from `status --json` `AuthURL`) |
| Terminal (console, through an SSH tunnel) | `whoami` → `harbor`, `hostname` → `harbor-test`, `docker ps` lists the app containers; screenshot `02-terminal.png` |
| `harbor logs` | systemd journal lines of `harbor.service` (source `journal`), read by the daemon as the harbor user (unit joins `systemd-journal`) |
| `harbor logs hello-nginx` | nginx access log lines from the container (readiness probes) |
| `harbor name "Lab box"` / `harbor name ""` | name shown, then reset to the hostname |
| Two-factor (API, code computed locally) | setup 200 → enable 204 → login without code `401 TOTP_REQUIRED` → wrong code `401 UNAUTHENTICATED` → login with the next code 201 → disable 204 |
| Console screenshots (6) | `docs/evidence/ui-2026-09-15-v0.7.0/` |

### v0.8.x: one-line install, setup wizard, LAN mode, self-update (2026-09-15)

Automated: `tests/unit/selfupdate-lan.test.ts` (GitHub feed parsing incl. drafts/prereleases, version order, systemd template unit + polkit start grant, LAN unit capability, LAN Host rules, private-address test, Caddy LAN server, setup code), `tests/integration/setup-selfupdate.test.ts` (setup needed → login refused → wrong/invalid codes → one-shot claim with device name and session → door closed; LAN mode: `host_ip 0.0.0.0`, `urls.lan`, LAN Host/Origin accepted and strangers refused with raw HTTP, Caddy LAN route reconciled at startup; self-update: status, check, not-available refusal, feed failure keeps the last answer, apply starts `harbor-self-update@<v>.service`, BUSY while running, failed/start errors surfaced), Playwright (`setup.spec.ts` against a second daemon in setup mode: wizard end to end, wrong code, then normal login; `ui.spec.ts`: update card with notes and confirmation, default-login card on Store page, plan warning and drawer). Local run: unit 80 passed, integration 76 passed + 3 skipped, e2e 21 passed.

Live on a **brand-new droplet** (`harbor-test-2`, Ubuntu 24.04 x86-64, created for this; the designated `harbor-test` untouched):

| Check | Result |
|---|---|
| `install.sh` from a bare machine (local archive: the GitHub repo is private, see below) | 1 min 52 s: checks, Docker Engine installed, `avahi-daemon` installed, hostname set to `harbor`, Tailscale + Caddy installed, daemon healthy, **no terminal prompt**; printed `Finish setup in a browser: http://harbor.local/` and `Setup code: 036404` |
| mDNS | `getent hosts harbor.local` resolves on the machine (nss-mdns, avahi publishing); cross-host resolution from the other droplet timed out: DigitalOcean droplets do not share a broadcast domain, so LAN discovery cannot be exercised in the cloud (it is the same mechanism Umbrel and printers use) |
| LAN mode with the public proxy installed | direct listener reports "port 80 is taken (Caddy)"; the observer reconciled Caddy: `harbor_lan` server on :80 with hosts `*.local, harbor, harbor.local, <addresses>` → console; `Host: harbor.local` → 200, `harbor-2.local` → 200, stranger → Caddy 308 (never reaches Harbor); console and the installed app answer on the machine's private address (`http://<private-ip>/` 200, `http://<private-ip>:18080/` 200, container publishes `0.0.0.0:18080`) |
| Setup wizard from another computer over the machine's address | wrong code refused with a message; correct code created `carlos`, named the machine *Lab Harbor*, logged the browser in; reload shows the normal login; `GET /v1/setup` → `needed: false`; screenshots `docs/evidence/install-2026-09-15-v0.8/` |
| App install from the LAN console | Excalidraw installed; the tile's Open link is `http://<ip>:18080/` (the host the page was opened with) |
| Self-update mechanics (root apply from an archive: the GitHub download needs a public repo) | `harbor self-update apply --to 0.8.1 --archive …`: checksum verified, `bootstrap --yes` in place, `status.json` `succeeded`, unit rewritten, setup code preserved across the upgrade of an unclaimed machine (after the fix in decision 72) |
| Self-update through polkit as the harbor user | `sudo -u harbor systemctl start harbor-self-update@0.8.2.service` ran the root step; it failed cleanly at the download (HTTP 404, private repo) and the console's update card shows the failure and the GitHub error |
| Live findings fixed during the round | `--version` option shadowed by the CLI's global flag (renamed `--to`); plain-http LAN origin is not a secure context (`crypto.randomUUID`, `navigator.clipboard` fallbacks); bootstrap of an unclaimed machine used to fail without a password (now keeps the setup code); Caddy's stock config held port 80 (observer now reconciles Caddy at startup) |

**Repository public since 2026-09-15 (decision 75).** Before flipping the visibility, the history was rewritten with `git filter-repo --replace-text` to purge credential-looking **test fixtures** that secret scanning flagged (the VM-suite admin password literal, e2e form-fill passwords, `tskey-auth-*` fake keys — all fixtures, no real credentials; tags force-moved, release assets unaffected). Verified unauthenticated afterwards: `curl -sI https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh` → **200**; `GET /repos/carlosalaniz/harbor/releases` → release list; `releases/download/v0.8.1/SHA256SUMS` downloads.

**Public paths proven live (2026-09-15, fresh droplet `harbor-test-3`, evidence `docs/evidence/install-2026-09-15-public/`):** the real `curl … | sudo bash` one-liner installed 0.8.1 from GitHub Releases on a bare machine (checksum verified, no terminal prompt, setup code printed); the wizard ran through an SSH tunnel; after publishing v0.8.2 the console detected it ("Version 0.8.2 is available") and *Update now* ran the polkit-started root unit: downloaded the archive from GitHub, checksum verified (`f932e40f…`), in-place bootstrap, daemon restart — `status.json` `succeeded`, console reconnected on 0.8.2 in ~13 s.

### v0.9.0: round 9 — notifications, usage, git sources, auto-updates, widgets (2026-09-15/16)

Automated: unit 81 passed (incl. migration v1→v7, OpenAPI route list with 63 paths);
integration 109 passed + 3 live-Docker skipped (notifications engine, per-app usage, git sources
with redeploy-on-commit, auto-updates, widgets proxy, remember sessions + session list +
revoke-others); e2e 21 passed (incl. opacity slider, notifications bell, TOTP, update card).
Live re-qualification of the round-9 paths on a droplet is pending; the fake-adapter suites above
are the current evidence.

### v0.10.0: password-only persistent login + console craft pass (2026-09-16)

`POST /v1/sessions {remember:true}` → 30-day `remember` session (default 12 h);
`GET /v1/sessions` (current marked) + `DELETE /v1/sessions/others`; schema v7
`sessions.kind/last_seen_at`. The browser keeps the long token in localStorage only when
*Remember this browser* is ticked; otherwise the token lives in memory. Login is an Umbrel-style
hero (Harbor mark, lowercase greeting, one quiet line, visible Log in button). One geometric
Harbor mark replaces emoji everywhere; palette entries use a neutral dot; glyphs/monograms flat.
Logout lives only in Settings → Account. Covered by `tests/integration/auth.test.ts` (remember
TTL, session list, revoke-others) and the e2e login/logout/TOTP flows. No live-VM pass yet for
this round; CI (`ci / verify` + `release / release`) runs lint, typecheck, unit, integration,
build, catalog:verify, openapi check and the full e2e suite.

### Live catalog qualification (`node scripts/vm/qualify-catalog.mjs --fresh`)

Every bundled package is installed with the CLI on the designated droplet (fresh Ubuntu 24.04.4 x86-64; Docker 29.8.0, Compose 5.5.1, Node v24.12.0), waited for until Harbor reports it healthy, opened in headless Chromium (title, screenshot, health probe through the SSH tunnel), inspected (containers, mounts, resources) and removed. Packages with external storage claims are installed a second time with host folders under `/srv/harbor-test-storage` and the bind mounts are verified. 23 of 23 steps passed; reports and screenshots: `docs/evidence/catalog-2026-09-15T00-13-13/`, `docs/evidence/catalog-2026-09-15T00-40-44/`, `docs/evidence/catalog-2026-09-15T00-42-58/`.

| Step | Result | Run | Notes |
|---|---|---|---|
| actual | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 24s; page title "Actual"; health 200<br>removed after the check; volumes and folders retained |
| anythingllm | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 41s; page title "AnythingLLM / Your personal LLM trained on anything"; health 200<br>removed after the check; volumes and folders retained |
| audiobookshelf | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 31s; page title "Audiobookshelf"; health 200<br>removed after the check; volumes and folders retained |
| audiobookshelf (external storage) | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 20s; page title "Audiobookshelf"; health 200<br>external storage: --storage audiobooks=/srv/harbor-test-storage/audiobookshelf-audiobooks --storage podcasts=/srv/harbor-test-storage/audiobookshelf-podcasts mounted as bind<br>removed after the check; volumes and folders retained |
| bentopdf | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 30s; page title "BentoPDF - PDF Tools"; health 200<br>removed after the check; volumes and folders retained |
| excalidraw | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 52s; page title "Excalidraw Whiteboard"; health 200<br>removed after the check; volumes and folders retained |
| forgejo | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 28s; page title "Installation - Forgejo: Beyond coding. We forge."; health 200<br>removed after the check; volumes and folders retained |
| freshrss | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 25s; page title "Installation · FreshRSS: step 1"; health 200<br>removed after the check; volumes and folders retained |
| immich | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 131s; page title "Welcome 🎉 - Immich"; health 200<br>removed after the check; volumes and folders retained |
| immich (external storage) | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 55s; page title "Welcome 🎉 - Immich"; health 200<br>external storage: --storage library=/srv/harbor-test-storage/immich-library mounted as bind<br>removed after the check; volumes and folders retained |
| jellyfin | **PASS** | catalog-2026-09-15T00-42-58 | healthy after 31s; page title "ddcb45c82584"; health 200<br>removed after the check; volumes and folders retained |
| jellyfin (external storage) | **PASS** | catalog-2026-09-15T00-42-58 | healthy after 32s; page title "6aad5ee64d56"; health 200<br>external storage: --storage media=/srv/harbor-test-storage/jellyfin-media-q0042 mounted as bind<br>removed after the check; volumes and folders retained |
| mealie | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 81s; page title "Login"; health 200<br>removed after the check; volumes and folders retained |
| memos | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 19s; page title "Memos"; health 200<br>removed after the check; volumes and folders retained |
| n8n | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 104s; page title "n8n.io - Workflow Automation"; health 200<br>removed after the check; volumes and folders retained |
| navidrome | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 25s; page title "Navidrome"; health 200<br>removed after the check; volumes and folders retained |
| navidrome (external storage) | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 20s; page title "Navidrome"; health 200<br>external storage: --storage music=/srv/harbor-test-storage/navidrome-music mounted as bind<br>removed after the check; volumes and folders retained |
| nextcloud | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 65s; page title "Nextcloud"; health 200<br>removed after the check; volumes and folders retained |
| nextcloud (external storage) | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 32s; page title "Nextcloud"; health 200<br>external storage: --storage data=/srv/harbor-test-storage/nextcloud-data mounted as bind<br>removed after the check; volumes and folders retained |
| open-webui | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 211s; page title "Open WebUI"; health 200<br>removed after the check; volumes and folders retained |
| open-webui (external storage) | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 84s; page title "Open WebUI"; health 200<br>external storage: --storage models=/srv/harbor-test-storage/open-webui-models mounted as bind<br>removed after the check; volumes and folders retained |
| uptime-kuma | **PASS** | catalog-2026-09-15T00-40-44 | healthy after 23s; page title "Uptime Kuma"; health 302<br>removed after the check; volumes and folders retained |
| vaultwarden | **PASS** | catalog-2026-09-15T00-13-13 | healthy after 85s; page title "Vaultwarden Web"; health 200<br>removed after the check; volumes and folders retained |

## 3s. The operation queue (2026-10-15, Harbor 0.35.0, decision 183)

**Local only: fake Docker adapter, no live run yet.** What this proves is the contract, not real Docker behavior
(AGENTS.md §3.1).

| Gate (macOS dev loop, branch `queue` merged to `main`) | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck` | clean |
| `pnpm test` (unit) | 604 passed, 2 skipped (+36 since 0.34.1: `queue.test.ts`, `web-queue.test.ts`, `fake-pull-hold.test.ts`, migration v12→v13) |
| `pnpm test:integration` | 351 passed, 3 live-Docker skipped (`queue.test.ts`: different-app approval while busy, same-app action planned at its turn, `REVIEW_NEEDED`, cancel of a waiting install frees name/ports/follow-ups, running → `NOT_CANCELLABLE`, guard items protected, restart and shutdown cancel never-run items and leave apps alone, fixed-port release, dedupe rule, generation guard, Update all, a waiting backup cold pass across a restart; `app-homes.test.ts`: cancelled adopt adopts again, `harbor start` on a locked app free/busy/meant-to-run; `tailnet-all.test.ts`: a cancelled withdrawal leaves the policy) |
| `pnpm build && pnpm test:e2e` | 42 passed (`queue`: a held install, buttons stay enabled, *Uninstall completely* queued behind the install and cancelled, a second install and a same-app Stop in run order, *Already queued*, Cancel, release, results, Clear finished) |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current (3 routes added) |

Integration runs while two other suites ran on the same machine timed out in unrelated long tests (6–16 min per test
under load); the same suite passed in full on a quiet machine. Recorded so a red run under load is not misread.

**Live, harbor-old (2026-10-15):** `sudo harbor self-update apply --to 0.35.0` from 0.34.1: signature
(`harbor-2026-10`) and checksum verified, bootstrap done, `harbor.service` active, console `GET /` 200. The real state
database migrated to v13 at the first start: `user_version` 13, `operations` with `cancelled`, nullable `plan_id`,
`request_json` and `seq NOT NULL UNIQUE`; its 47 operations (all `succeeded`) numbered `seq` 1–47 with no duplicate,
`PRAGMA foreign_key_check` empty. `GET /v1/operations` answers 401 without a session (the route exists).

**Live queue run, harbor-old (2026-10-16), evidence `docs/evidence/live-queue-2026-10-16/`:** installs queued in run
order behind a running install; a Stop of an app queued while its own install ran, planned at its turn and applied
after it; cancelling a waiting install freed its name (installed again at once) while cancelling a running or finished
item was refused `NOT_CANCELLABLE`; a daemon restart with items waiting ended the waiting reviewed Restart `cancelled`
(*Harbor restarted before this ran*) with its app still healthy and no app `needs_action`; five full uninstalls
queued at once ran in order. The box's own apps stayed healthy throughout.

**Upgrade-jump fixture:** `tests/fixtures/state/v0.35.0/` (written by the 0.35.0 daemon in fake mode, schema 13);
`upgrade-jump.test.ts` jumps v0.35.0, v0.22.1 and v0.19.1 to the current code (30 tests). The fixture driver now uses
`tests/fixtures/catalog` for releases that no longer ship `catalog/` (0.28.0 and later).

## 3t. VPN and offline apps (2026-10-20, Harbor 0.36.0, decisions 184–185)

| Gate (macOS dev loop) | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck` | clean |
| `pnpm test` (unit) | 630 passed, 2 skipped (+26: `egress.test.ts` — wg-quick parser and refusals, ruleset, routes, state validation, plans, rendered resolver, `network.internet`; systemd units; actor list) |
| `pnpm test:integration` | 375 passed, 3 live-Docker skipped (`vpn.test.ts`, 14: no root step on an untouched machine, package default, rules between create and start, re-render on a mode change and on a stale start, VPN routes never return or store the key, every-app restarts as `vpn-policy`, `vpn-down` and its resolution, fail closed (install and configure), restart re-apply, update moving the default, remove/purge) |
| `pnpm build && pnpm test:e2e` | 43 passed (`decision 184`: VPN page with a refused and an accepted file, an offline package on the install page and review, the drawer's change, every app through the VPN, remove) |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current (3 routes added) |

**Live, harbor-old with a WireGuard server on the droplet, evidence `docs/evidence/live-vpn-2026-10-20/`** (its README
maps each log): a VPN app leaves with the droplet's address while a direct app keeps the home one; from inside the VPN
app its lookups appear only on `hb-vpn0` and inside the droplet's tunnel; with the server down, or the VPN removed, it
has no internet (no packet on the physical interfaces; fails in 5 ms) while its LAN stays reachable; `vpn-down` rings
after 5 minutes and clears by itself; offline refuses the internet, the LAN, this machine and other apps (also through
its bridge gateway) in milliseconds while the app answers on loopback and over the LAN and stays healthy; every app
through the VPN restarts the moved apps and puts them back; with Harbor's kernel state wiped, starting Docker loads the
firewall and routing first and a VPN app has no internet until the tunnel unit runs. **The live run found four defects
the fake engine could not:** nft refusing `-f -` from a pipe, Docker's resolver forwarding host-inherited servers from
the host namespace (a DNS leak; fixed with a rendered resolver per mode), silent `blackhole` timeouts, and an offline
app reaching other apps through its bridge gateway. All four were fixed and re-checked live on the same box.
Not covered live: a real reboot (harbor-old's root is LUKS; the boot test replays the same unit ordering).

## 3u. Tailscale addresses in bulk and at install (2026-10-20, Harbor 0.37.0, decision 186)

**What started it (home server, read-only checks):** Plane's `https://harbor.<tailnet>.ts.net:18998/` refused
connections. `tailscale serve status --json` held only the console (443) and Open WebUI (18999), and Harbor's
`exposures` table agreed: Plane had no tailnet address. Its only expose plan (17:28 that day) was never submitted,
and the review had shown its future address as a link. Harbor's journal had no tailnet or observer warnings.

| Gate (macOS dev loop) | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck` | clean |
| `pnpm test` (unit) | 631 passed, 2 skipped (+1: `asked` read defensively, the policy covers asked apps only while off) |
| `pnpm test:integration` | 379 passed, 3 live-Docker skipped (`tailnet-all.test.ts` +4: an install that asks gets exactly one address with the policy off and leaves `asked`, one that does not ask gets none, not the main address; a tailnet main address records no extra choice; no with the policy on joins the exceptions; the schema takes only a boolean) |
| `pnpm build && pnpm test:e2e` | 44 passed (`decision 186`: Select all → review lists addresses as text → Apply → every app published; Select none → every address withdrawn; Also on Tailscale at install → the review says so → the app gets its address. The Publish review shows "(once you approve)" and no link) |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current |

The first e2e run of the bulk list hit the suite's 20 app ports (every app plus a tailnet port each): the e2e daemon
now has 80, and the dialog groups refusals by reason (one line naming the apps, not one per app).
Not covered live yet: the home server runs 0.36.0.

## 3v. Ubuntu 26.04 hosts and Node 24.22.1 (2026-10-23, Harbor 0.37.1, decision 187)

Two contributor pull requests (carlosalaniz/harbor#1, #3), reviewed and merged together.

| Check | Result |
|---|---|
| Node 24.22.1 exists and is the security release | `nodejs.org/dist/v24.22.1/SHASUMS256.txt` lists `node-v24.22.1-linux-x64.tar.xz`; the October 2026 advisory names 24.22.1 for CVE-2026-105482/105483/106069 (high) and the CA/OpenSSL/Undici updates. `scripts/package.mjs` still checks the tarball against those SHASUMS at packaging |
| Ubuntu 26.04 bootstrap | **contributor's run, not ours**: 0.35.0 archive with this branch's `host`/`tools`/`bootstrap` swapped in, on a real Ubuntu 26.04.1 (Intel NUC10i3): Docker from `linux/ubuntu resolute`, Tailscale from `stable/ubuntu/resolute`, fscrypt ready, daemon healthy. App installs and backups on 26.04 not covered yet |
| `pnpm lint`, `pnpm typecheck` | clean |
| `pnpm test` (unit) | 646 passed, 2 skipped (+8: `tailscale-repo.test.ts`, 26.04 / out-of-window cases in `host-gate.test.ts`, a real 26.04 os-release in `docker-install.test.ts`; +7 `smoke-settle.test.ts`, §3w) |
| `pnpm test:integration` | 379 passed, 3 live-Docker skipped |
| `pnpm build && pnpm test:e2e` | 44 passed |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current |

The first release run failed on Node 24.22.1 (nothing was published): `auto-update-backup.test.ts` compared two one-second timestamps with a strict `<` (backup `startedAt` < update `createdAt`), and on 24.22.1 both landed in the same second every time, in CI and locally. It now checks that the backup finished no later than the update started. A `lan-https.test.ts` timing flake also showed once in that run (passed in the parallel `ci` run and 5/5 locally on 24.22.1). The gate above ran locally on Node 24.22.1 (darwin-arm64, SHA256 checked against nodejs.org), as CI does.

## 3w. Smoke restart baseline (2026-10-23, Harbor 0.37.1, decision 188)

| Check | Result |
|---|---|
| `pnpm test` (unit) | 646 passed, 2 skipped (+7: `smoke-settle.test.ts`: stopped container, any restart refused with no baseline, restarts up to the baseline allowed and one more refused, re-created container starts from zero, message helpers) |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean |
| `pnpm catalog:smoke` on Docker Desktop (arm64, dev loop) | Homarr revision 4 (harbor-apps main) → a copy raised to revision 5: upgrade-install ok (healthy after 20 s), upgrade ok, fresh ok, settle 20 s each — the snapshot/baseline wiring on a real engine. The tolerated-restart path itself is covered by the unit test (no app restarted here) |

The full gate for both (§3v, §3w) is the one in §3v.

## 3x. Publishing grouped by reach (2026-10-31, Harbor 0.37.2, decision 189)

| Check | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean |
| `pnpm test` (unit) | 646 passed, 2 skipped (no change) |
| `pnpm test:integration` | 379 passed, 3 live-Docker skipped |
| `pnpm test:e2e` | 44 passed (the publish wizard test now checks the *On the internet* / *On your tailnet* / *Not published* regions) |
| `pnpm dev:ui` screenshots | dark, light and 390 px phone: groups render, the degraded name shows its reason on its own line, tailnet rows stay on one line |

Local gate ran on Node 24.12.0 (dev machine); CI runs 24.22.1. Console-only change: no daemon, route or schema change.

## 3y. Lock screen after a restart (2026-10-31, Harbor 0.38.0, decision 190)

Contributor pull request carlosalaniz/harbor#4 (0xDonPepe), merged with one follow-up commit.

| Check | Result |
|---|---|
| Contributor's live run | **theirs, not ours**: two reboots of an Ubuntu 26.04 home server with Immich, Nextcloud and Vaultwarden sealed; found the update that deleted a locked app's containers and the lock-guard skip (a Redis already running) |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean |
| `pnpm test` (unit) | 646 passed, 2 skipped (no change) |
| `pnpm test:integration` | 382 passed, 3 live-Docker skipped (+3 in `app-homes.test.ts`: `unlockNeeded` and the update refusal while locked; lock-guard with one container already running; the automatic update waits for the unlock, which fails without the follow-up fix with `expected '2' to be undefined`) |
| `pnpm test:e2e` | 45 passed (+1: a remembered session lands on the lock screen and the password unlocks in place) |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current |

Gate ran locally on Node 24.22.1 (darwin-arm64), as CI does. Not covered live by us yet: a reboot of harbor-old.

## 3z. Harbor picks network subnets (2026-11-01, Harbor 0.39.0, decision 191)

Found live on the production box: a Khoj install failed at `compose up` with `all predefined address pools have been fully
subnetted` (30 bridge networks; 14 empty leftovers of stacks that had moved onto Harbor).

| Check | Result |
|---|---|
| Compose behaviour, by hand | Compose 2.29.2 (harbor-old) and 5.1.0 (Docker Desktop; production runs 5.1.1): a file naming a subnet makes the network with it and `up` again keeps it; a file without one leaves a Docker-picked network alone; `docker network create --internal --subnet` works. Adding a subnet to an existing network without one: 2.29 ignores it, **5.1 recreates the network and its containers**, so Harbor never does that |
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | clean |
| `pnpm test` (unit) | 654 passed, 2 skipped (+8 in `subnets.test.ts`) |
| `pnpm test:integration` | 387 passed, 3 live-Docker skipped (+5 in `subnets.test.ts`: install, restart keeps it, host ranges skipped, a pre-0.39 network keeps a file without `ipam`, block full; link network subnet in `links-names.test.ts`; `vpn`/`addresses` follow the new range) |
| `HARBOR_LIVE_DOCKER_SOCKET=… live-docker.test.ts` (Docker Desktop, Engine 29.2.1, Compose 5.1.0) | 3 passed: Excalidraw's real network is a Harbor /24, unchanged across stop/start, chosen again after remove + reinstall (dev loop, not host evidence) |
| `pnpm test:e2e` | 45 passed |
| `catalog:verify` / `catalog:hash --check` (fixtures), `openapi -- --check` | ok / ok / current |

Gate ran locally on Node 24.12.0 (darwin-arm64); CI runs 24.22.1. Not covered live yet: the production box after its update.

**0.39.1 (decision 192, lock-guard once per unlock):** `ci` on 0.39.0 failed on `harbor start <locked> --passphrase-stdin`
(the release job passed). Integration 388 passed, 3 skipped (+1: two lock/unlock rounds in one boot, each followed by
lock-guard's start; it failed in round 1 without the fix). `app-homes.test.ts` 4/4 clean runs after the decision-190 reboot
test waits for lock-guard's start instead of `running` (it had failed 1 of 3). Unit 654 + 2 skipped, e2e 45, lint and
typecheck clean.

## 4. Qualified versions

| Component | Version | Source |
|---|---|---|
| Host OS | Ubuntu 24.04.4 LTS (x86_64), systemd 255 (255.4-1ubuntu8.16) | fresh DigitalOcean image `ubuntu-24-04-x64` |
| Docker Engine | 29.8.0 | installed by bootstrap `--install-docker` from download.docker.com (noble stable) |
| Docker Compose plugin | 5.5.1 | same repository |
| Node.js (bundled) | v24.12.0 | nodejs.org linux-x64 tarball, SHA256 verified at packaging |
| Harbor | 0.10.0 | release archive `harbor-0.10.0-linux-x64.tar.gz` |
| Excalidraw | `excalidraw/excalidraw@sha256:f7ee194a…` (tag latest, 2026-05-06) | catalog/excalidraw/release.json |
| BentoPDF | `ghcr.io/alam00000/bentopdf-simple@sha256:3d62b8f8…` (v2.8.8) | catalog/bentopdf/release.json |
| n8n | `n8nio/n8n@sha256:a8c95f75…` (2.38.7) | catalog/n8n/release.json |
| PostgreSQL | `postgres@sha256:f1c3376c…` (16.15) | catalog/n8n/release.json |
| Portainer CE | `portainer/portainer-ce@sha256:0e3c8bc8…` (2.39.7) | src/bootstrap/tools.ts |
| Cockpit | Ubuntu 24.04 `cockpit` package (universe) at run time | apt |

### Catalog images and qualification (from `catalog/*/release.json`)

| Package | Images (tag → index digest) | Qualification |
|---|---|---|
| actual | web: `actualbudget/actual-server:26.9.0` → `sha256:552beab3dec8…` | passed (2026-09-15) |
| anythingllm | web: `mintplexlabs/anythingllm:1.16.1` → `sha256:05617e7bece7…` | passed (2026-09-15) |
| audiobookshelf | web: `ghcr.io/advplyr/audiobookshelf:2.36.0` → `sha256:180acad33d69…` | passed (2026-09-15) |
| bentopdf | web: `ghcr.io/alam00000/bentopdf-simple:v2.8.8` → `sha256:3d62b8f8eece…` | passed (2026-09-15) |
| excalidraw | web: `excalidraw/excalidraw:latest` → `sha256:f7ee194addd6…` | passed (2026-09-15) |
| forgejo | web: `codeberg.org/forgejo/forgejo:16.0.4` → `sha256:a3e33d03e771…` | passed (2026-09-15) |
| freshrss | web: `freshrss/freshrss:1.30.0` → `sha256:258b8edfc8a7…` | passed (2026-09-15) |
| immich | database: `ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0` → `sha256:bcf63357191b…`<br>redis: `valkey/valkey:8.1.3-bookworm` → `sha256:fea8b3e67b15…`<br>machine-learning: `ghcr.io/immich-app/immich-machine-learning:v3.2.1` → `sha256:4f879e40da49…`<br>server: `ghcr.io/immich-app/immich-server:v3.2.1` → `sha256:2ab6a6273755…` | passed (2026-09-15) |
| jellyfin | web: `jellyfin/jellyfin:10.11.11` → `sha256:aefb67e6a7ff…` | passed (2026-09-15) |
| mealie | web: `ghcr.io/mealie-recipes/mealie:v3.26.0` → `sha256:a4d12ab3a009…` | passed (2026-09-15) |
| memos | web: `neosmemo/memos:0.30.0` → `sha256:71a5b4738d1b…` | passed (2026-09-15) |
| n8n | web: `n8nio/n8n:2.38.7` → `sha256:a8c95f75c6fd…`<br>postgres: `postgres:16.15` → `sha256:f1c3376c26f2…` | passed (2026-09-15) |
| navidrome | web: `deluan/navidrome:0.64.0` → `sha256:a384948b81bd…` | passed (2026-09-15) |
| nextcloud | db: `postgres:17.11` → `sha256:67f41722b7a8…`<br>redis: `redis:8.10.1-alpine` → `sha256:becdda6c7f4b…`<br>app: `nextcloud:34.0.4-apache` → `sha256:de4ad9389386…` | passed (2026-09-15) |
| open-webui | ollama: `ollama/ollama:0.34.0` → `sha256:684d8674b431…`<br>web: `ghcr.io/open-webui/open-webui:v0.11.3` → `sha256:41daa0cf2561…` | passed (2026-09-15) |
| uptime-kuma | web: `louislam/uptime-kuma:2.5.4` → `sha256:917318f9d7be…` | passed (2026-09-15) |
| vaultwarden | web: `vaultwarden/server:1.37.3-alpine` → `sha256:9a905c5cf5df…` | passed (2026-09-15) |

## 5. Limitations and honest notes

- Plan expiry (15 minutes) and login rate limiting (429) are verified by integration tests with a controlled clock/sequence, not live (the live run would have to wait 15 minutes or lock itself out).
- The interruption test (A10) restarts the daemon during a real install; whether the restart lands inside the operation depends on timing. The run report says which case occurred; the deterministic version is in `tests/integration/lifecycle.test.ts`.
- Cockpit is exercised in two ways: the recorded `--fresh` run binds a **pre-installed** Cockpit (fixture) without reconfiguring it; the managed install path (apt install + loopback socket drop-in) ran in the manual checkpoint (`docs/evidence/manual-2026-09-14/bootstrap-1.log`).
- The archive is reproducible modulo file modification times.
- No real personal accounts or production credentials were used: all logins are synthetic fixtures created for the run.
- Tailnet exposure (B02/B03) was verified from the node itself over its tailnet name (run vm-2026-09-15T04-20-57); a second tailnet device was not part of the automated run. Every check in the matrix now has live evidence. The provider client and the engine path are covered by `tests/integration/exposure.test.ts` with a fake Tailscale CLI; the public path (Caddy, Let's Encrypt, real DNS) has live evidence.
- Catalog qualification is an install → healthy → browser → remove pass per package on a fresh host, plus a second pass with host folders where a package offers them. It proves the package installs, answers and mounts what it promised; it does not exercise each app's full feature set (the MVP demos in A03/A11 do that for three apps). First-run pages that need an account were left at the account form.
- Retained (removed) instances keep their names and ports until purged; `harbor purge` frees both.
  The qualification script uses per-run instance names and folders.
- External folders: Harbor validates and mounts them but does not manage permissions. The packaged apps either run as root in their container or take ownership on first start; a folder shared with other software is the operator's responsibility.

## 6. Archive provenance

The final acceptance run (vm-2026-09-15T01-01-08) and the catalog qualification re-runs executed the archive
`release/harbor-0.1.0-linux-x64.tar.gz` built from commit `04c19bd` (sha256 `f145f257c5d072c907db701e765cd2a607d69361840262fcf324e09e5b25123f`); it contains the
console, the 17-package catalog with recorded qualifications and the exposure engine. Commits after `04c19bd`
on the `exposure` branch change only documentation and the live-suite runner scripts (`scripts/vm/*`), which
are not part of the archive. Rebuild it at any time with `pnpm package`; `pnpm tsx scripts/catalog-verify.ts`
confirms the package file hashes. The first catalog pass (catalog-2026-09-15T00-13-13) ran an earlier build of
the same sources that differed only in Uptime Kuma's health expectation and the qualification stamps.
