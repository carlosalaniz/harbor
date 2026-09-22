# Verification report

Harbor local preview, version 0.17.0-beta.5. This report lists what actually ran, where, with which versions,
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
| `pnpm test` | unit: YAML restrictions, manifest/Compose schemas and cross-references, catalog/hash verification (incl. presentation assets), planner and renderer (bind mounts, configuration formats), host-path rules, exposure config/URLs, schema migrations v1→v7, OpenAPI (72 paths), systemd/release files (incl. `/mnt /media` writes), device mount/format + bind marker (round-trip, restore keeps id, replacement fresh, legacy verifies; format oneshot start, in-use/system-disk refusals, no-systemd hint), install candidates (eligibility, non-POSIX/read-only refusal), app homes (manifest+vault, passphrase unlock, cross-machine portability) | 120 passed |
| `pnpm test:integration` | daemon in-process with the fake Docker adapter: install flow, idempotency, port claims, readiness timeout, coexistence, sentinel non-interference, restart→needs_action, Docker-down, volumes/secrets retention (synthetic stateful package), auth controls (incl. 30-day remember sessions, session list, revoke-others), tool binding, exposure (tailnet/public/primary/degraded/withdraw, UI exposure), external storage (validation, bind mounts, overlap, reinstall verification, DATA_MISSING, drive guard: swap→stop+refuse+adopt, restore→auto-start, policy toggles), app homes (install-location plan wording, submit-secret gate, manifest+vault layout, wrong-passphrase refusal, found-apps wiring, adopt conflicts, volume-rooting with `device=` log, on-demand apps-folder creation), purge/domains, appearance/rotation, packages/updates, git sources, notifications (resolved rows delete), security/terminal, setup/LAN/self-update | 122 passed (+3 live-Docker skipped without opt-in) |
| `HARBOR_LIVE_DOCKER_SOCKET=~/.docker/run/docker.sock pnpm test:integration` | real Dockerode + `docker compose` against the authorized Docker Desktop engine: Excalidraw install/stop/start/remove/reinstall, BentoPDF coexistence, COOP/COEP headers | 3 passed (plus the 49 above) |
| `pnpm build && pnpm test:e2e` | Playwright against the built console with the fake adapter: Umbrel-style login hero (incl. bad-credentials, reload→re-login→resume, logout revokes), Home/App Store/Platform/Publishing pages (icons served with sandboxed CSP, category filter, search), app page + plan review + double-click safety, drawer stop/start/remove/reinstall, coexistence + owned resources, publish wizard (tailnet, public with one-time credentials, withdraw), phone width, install-location picker + passphrase + encrypted review (BentoPDF to the data-folder candidate), bring-your-own-folder validation and mount, settings (password, Tailscale, storage incl. mount spinner + format-as-ext4 + auto-mount/auto-start toggles + found-apps, appearance, opacity slider, rotation, terminal, logs, rename, 2FA), first-run wizard, Harbor update card | 25 passed |

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

Same box as §3a (`carlos-desktop`, Ubuntu 24.04.3 x86_64), USB stick `sdb1` 14.4 GB **ntfs** label `USB20FD`, unmounted, no apps installed. Deployed with `pnpm package` → `scp` tarball + `SHA256SUMS` to `/tmp/` → `sudo /opt/harbor/bin/harbor self-update apply --to 0.15.1` (checksum verified, bootstrap re-run, daemon back `ok`).

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

## 3. Live acceptance runs (`pnpm test:vm -- --fresh`)

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
