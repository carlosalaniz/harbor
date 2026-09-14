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
| `pnpm test` | unit: YAML restrictions, manifest/Compose schemas and cross-references, catalog/hash verification, planner, OpenAPI, release file replacement | 42 passed |
| `pnpm test:integration` | daemon in-process with the fake Docker adapter: install flow, idempotency, port claims, readiness timeout, coexistence, sentinel non-interference, restart→needs_action, Docker-down, volumes/secrets retention (synthetic stateful package), auth controls, tool binding | 34 passed |
| `HARBOR_LIVE_DOCKER_SOCKET=~/.docker/run/docker.sock pnpm test:integration` | real Dockerode + `docker compose` against the authorized Docker Desktop engine: Excalidraw install/stop/start/remove/reinstall, BentoPDF coexistence, COOP/COEP headers | 3 passed (plus the 34 above) |
| `pnpm build && pnpm test:e2e` | Playwright against the built UI with the fake adapter: login errors, dashboard sections, install with confirmation and double-click safety, reload→re-login→resume, stop/start/remove/reinstall, coexistence, details, logout, no browser persistence | 7 passed |

Fake-adapter results prove the engine, API and UI contracts. They are not evidence for A03/A09/A11/A14/A16; those come from section 3.

## 3. Live acceptance runs (`pnpm test:vm -- --fresh`)

### Run vm-2026-09-14T17-27-18 (fresh VM) — FAILED at A01, fixed

Bootstrap #1 on the fresh VM passed (Docker 29.8.0 / Compose 5.5.1 installed, all listeners loopback-only, CLI login).
Bootstrap #2 (re-run with `--with-tools`) failed: `EEXIST /opt/harbor/node_modules/.bin` because Node's `cpSync`
cannot overwrite existing symlinks. Fixed in `replaceReleaseFiles` (remove each release entry before copying;
unit test `tests/unit/bootstrap-files.test.ts`). Evidence: `docs/evidence/vm-2026-09-14T17-27-18/`.

RUN_PLACEHOLDER

## 4. Qualified versions

VERSIONS_PLACEHOLDER

## 5. Limitations and honest notes

- Plan expiry (15 minutes) and login rate limiting (429) are verified by integration tests with a controlled clock/sequence, not live (the live run would have to wait 15 minutes or lock itself out).
- The interruption test (A10) restarts the daemon during a real install; whether the restart lands inside the operation depends on timing. The run report says which case occurred; the deterministic version is in `tests/integration/lifecycle.test.ts`.
- Cockpit is exercised in two ways: the recorded `--fresh` run binds a **pre-installed** Cockpit (fixture) without reconfiguring it; the managed install path (apt install + loopback socket drop-in) ran in the manual checkpoint (`docs/evidence/manual-2026-09-14/bootstrap-1.log`).
- The archive is reproducible modulo file modification times.
- No real personal accounts or production credentials were used: all logins are synthetic fixtures created for the run.
