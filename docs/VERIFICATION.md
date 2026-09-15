# Verification report

Harbor local preview, version 0.1.0. This report lists what actually ran, where, with which versions,
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
| `pnpm test` | unit: YAML restrictions, manifest/Compose schemas and cross-references, catalog/hash verification (incl. presentation assets), planner and renderer (bind mounts, configuration formats), host-path rules, exposure config/URLs, schema migrations v1→v3, OpenAPI, systemd/release files | 57 passed |
| `pnpm test:integration` | daemon in-process with the fake Docker adapter: install flow, idempotency, port claims, readiness timeout, coexistence, sentinel non-interference, restart→needs_action, Docker-down, volumes/secrets retention (synthetic stateful package), auth controls, tool binding, exposure (tailnet/public/primary/degraded/withdraw, UI exposure), external storage (validation, bind mounts, overlap, reinstall verification, DATA_MISSING) | 49 passed |
| `HARBOR_LIVE_DOCKER_SOCKET=~/.docker/run/docker.sock pnpm test:integration` | real Dockerode + `docker compose` against the authorized Docker Desktop engine: Excalidraw install/stop/start/remove/reinstall, BentoPDF coexistence, COOP/COEP headers | 3 passed (plus the 49 above) |
| `pnpm build && pnpm test:e2e` | Playwright against the built console with the fake adapter: login errors, Home/App Store/Platform/Publishing pages (icons served with sandboxed CSP, category filter, search), app page + plan review + double-click safety, reload→re-login→resume, drawer stop/start/remove/reinstall, coexistence + owned resources, logout, publish wizard (tailnet, public with one-time credentials, withdraw), phone width, bring-your-own-folder validation and mount | 10 passed |

Fake-adapter results prove the engine, API and UI contracts. They are not evidence for A03/A09/A11/A14/A16; those come from section 3.

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
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: no localStorage/sessionStorage/cookies; logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
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
| A13 | UI login/logout, bearer auth, Host/Origin/content type controls; no secrets in DTOs or browser storage | **PASS** | 401/403/422/400 controls verified over the tunnel<br>no secret values or bearer tokens in DTOs or journal<br>browser: no localStorage/sessionStorage/cookies; logout revokes the token<br>login rate limiting (429) is covered by tests/integration/auth.test.ts to avoid locking this run out |
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

## 4. Qualified versions

| Component | Version | Source |
|---|---|---|
| Host OS | Ubuntu 24.04.4 LTS (x86_64), systemd 255 (255.4-1ubuntu8.16) | fresh DigitalOcean image `ubuntu-24-04-x64` |
| Docker Engine | 29.8.0 | installed by bootstrap `--install-docker` from download.docker.com (noble stable) |
| Docker Compose plugin | 5.5.1 | same repository |
| Node.js (bundled) | v24.12.0 | nodejs.org linux-x64 tarball, SHA256 verified at packaging |
| Harbor | 0.1.0 | release archive `harbor-0.1.0-linux-x64.tar.gz` |
| Excalidraw | `excalidraw/excalidraw@sha256:f7ee194a…` (tag latest, 2026-05-06) | catalog/excalidraw/release.json |
| BentoPDF | `ghcr.io/alam00000/bentopdf-simple@sha256:3d62b8f8…` (v2.8.8) | catalog/bentopdf/release.json |
| n8n | `n8nio/n8n@sha256:a8c95f75…` (2.38.7) | catalog/n8n/release.json |
| PostgreSQL | `postgres@sha256:f1c3376c…` (16.15) | catalog/n8n/release.json |
| Portainer CE | `portainer/portainer-ce@sha256:0e3c8bc8…` (2.39.7) | src/bootstrap/tools.ts |
| Cockpit | Ubuntu 24.04 `cockpit` package (universe) at run time | apt |

## 5. Limitations and honest notes

- Plan expiry (15 minutes) and login rate limiting (429) are verified by integration tests with a controlled clock/sequence, not live (the live run would have to wait 15 minutes or lock itself out).
- The interruption test (A10) restarts the daemon during a real install; whether the restart lands inside the operation depends on timing. The run report says which case occurred; the deterministic version is in `tests/integration/lifecycle.test.ts`.
- Cockpit is exercised in two ways: the recorded `--fresh` run binds a **pre-installed** Cockpit (fixture) without reconfiguring it; the managed install path (apt install + loopback socket drop-in) ran in the manual checkpoint (`docs/evidence/manual-2026-09-14/bootstrap-1.log`).
- The archive is reproducible modulo file modification times.
- No real personal accounts or production credentials were used: all logins are synthetic fixtures created for the run.

## 6. Archive provenance

The acceptance run above executed the archive built from commit `1b7864c` (before the qualification
stamp existed). The delivered archive `release/harbor-0.1.0-linux-x64.tar.gz`
(sha256 `24723e63626d7354788994ce48d557b054cbeca21f37d992f1a946e9960a2f43`, commit `1b7864c` recorded in
its `release.json`) differs from the tested one only in the three packages' `release.json`
`qualification` blocks (`pending` → `passed` with the recorded versions). No code, dependency, Node
runtime or catalog manifest/Compose bytes changed; `pnpm catalog:verify` confirms the file hashes.
Rebuild it at any time with `pnpm package`.
