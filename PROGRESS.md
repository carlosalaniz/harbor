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

### Phase 2 — two apps + minimal UI 🔄
- [x] BentoPDF package with real digest `ghcr.io/alam00000/bentopdf-simple@sha256:3d62b8f8…` (v2.8.8)
- [x] start/stop/remove/reinstall implemented generically (smoke-tested via CLI with fake adapter)
- [ ] Coexistence/ownership/restart-recovery integration tests
- [ ] React UI (login, Installed, Available, System, Platform tools)
- [ ] OpenAPI document generated from route schemas

### Phase 3 — n8n + PostgreSQL ⏳
- Digests resolved (see DECISIONS): n8n 2.38.7 (= `stable` tag) `sha256:a8c95f75…`, postgres 16.15 `sha256:f1c3376c…`
- [ ] package files, secrets/volume tests, reinstall retention tests

### Phase 4 — bootstrap + tools ⏳
### Phase 5 — full demo + report ⏳

## Test results (latest local run)

| Command | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test` (unit) | 40 passed |
| `pnpm test:integration` (fake adapter) | 9 passed |
| CLI smoke (`pnpm dev` + CLI, fake adapter) | login, catalog, install, stop, start, remove, reinstall, second instance, logout — all exit codes as documented |

## Blockers
None. Live evidence pending until bootstrap (Phase 4) can install Docker on the designated VM.

## Exact next step
Phase 2 tests (coexistence, second instance, stop/remove non-interference with a sentinel, daemon restart → needs_action, Docker unavailable → unavailable/unknown), then the React UI.
