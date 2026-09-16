# AGENTS.md — rules of engagement for working on Harbor

Read this before writing code, packages, or docs. It tells you **what** Harbor is,
**where** things live, **why** the rules exist, and **how** to ship without breaking CI.

## 1. What Harbor is

A self-hosted application manager ("a private cloud for humans", Umbrel/HexOS-like but simpler):
one Ubuntu 24.04 x86-64 machine, one administrator, apps installed from a catalog of **data-only
packages** (manifest + Compose subset pinned by image digest), a React console (launcher home screen,
App Store, Publishing, Platform, Settings), and a `harbor` CLI against the same local API.

- Trust model: the `harbor` service user is in the `docker` group and is therefore
  **root-equivalent**. The API is not a sandbox against root/Docker admins. Loopback by default;
  LAN mode, tailnet (Tailscale) and public HTTPS (Caddy + Let's Encrypt) are opt-in providers.
- Product truth: `TDD.md` (original spec) + `docs/DECISIONS.md` (every scope lift since, numbered —
  next number is **86**). `plan.md` is the historical build order; `PROGRESS.md` is the changelog.
- Session map: `docs/AI_CONTEXT.md` (where things are, versions, gotchas, live droplets).

## 2. Where things live

```
src/            daemon (TypeScript strict ESM, Node 24.12, pnpm 10.16)
  contracts/    JSON Schemas + DTO types — the API's source of truth
  packages/     restricted YAML parser, manifest/compose validators, catalog loader, zip import
  planner/      identity, port allocation, Compose rendering (PURE functions, no I/O)
  state/        SQLite (better-sqlite3, SCHEMA_VERSION 7, migrations v1→v7), repositories
  docker/       adapter interface, Dockerode adapter, Compose CLI runner, FAKE adapter, port probe
  lifecycle/    plans/operations service, serial runner, readiness, observer, DTO mapping
  auth/ api/    scrypt + bearer sessions (+TOTP), Fastify routes with Host/Origin/JSON guards
  exposure/     Tailscale + Caddy providers, URL rendering
  appearance/   wallpapers + rotation fetcher        system/  metrics, storage, power, terminal, logs, LAN, self-update
  bootstrap/    root-only installer/upgrader         cli/     commander CLI (mirrors every console action)
  notify/       notifications engine + channels (ntfy/webhook/email)
web/src/        React 19 + Vite, plain CSS tokens, strict CSP; App.tsx, app/pages/*, app/icons.tsx,
                mock/ fixtures for `pnpm dev:ui`
catalog/<id>/   one package = manifest.yaml + compose.yaml + README.md + release.json (+ icon)
tests/          unit/ integration/ (fake adapter) e2e/ (Playwright) vm/ (live suite, opt-in)
scripts/        catalog-pin/hash/verify, openapi.ts, package.mjs, vm/ controllers
docs/           OPERATOR_GUIDE.md (user manual), DEVELOPER_PACKAGES.md (package authoring),
                VERIFICATION.md (evidence log), FUTURE.md (deliberately not built),
                design/ (UI, CATALOG, EXPOSURE, ROUND9), openapi.json (GENERATED — never hand-edit)
```

Key separations (do not blur them):

- `src/planner/*` and `src/packages/*` are **pure**: no Docker, no DB, no network. I/O lives in
  `src/docker/*`, `src/lifecycle/runner.ts`, providers, and `src/state/*`.
- The console is a **client** of the API, never a second engine. Every console action goes through
  plan → review → approve → operation → tray. The CLI mirrors the same endpoints.
- Packages are **data**: no per-app code paths in the engine. If a feature needs an engine branch
  for one app, the package model is wrong — fix the model.

## 3. Why the rules exist (read before cutting corners)

1. **Fake adapter proves contracts, never real behavior.** Unit/integration/e2e run against an
   in-memory Docker with real loopback HTTP listeners. Real evidence comes only from
   `HARBOR_LIVE_DOCKER_SOCKET=… pnpm test:integration` (opt-in) and `pnpm test:vm` on a disposable
   droplet. Never claim a live result you did not run.
2. **CI is the release gate.** Push to `main` runs `ci / verify` AND `release / release`, which
   publishes the GitHub Release automatically. A red `main` blocks releases. Keep it green.
3. **Secrets never touch the repo.** Tokens/keys live in git-ignored `.env.vm.local` (0600).
   Test fixtures must look scanner-safe (`*-FIXTURE-*`, `tskey-fixture-*`) — a past incident
   required rewriting the entire history with `git filter-repo` (decision 75).
4. **Ownership is sacred.** Harbor only mutates Docker resources carrying its labels, only deletes
   volumes after an ownership check, never touches operator folders (`bind` resources), never
   chowns. When in doubt: refuse with a clear error code + next action, never guess.
5. **Every mutation is a plan → operation** through the serial queue with idempotency keys,
   15-minute plan expiry, persisted phases, and no replay after interruption (`needs_action`).
   No direct Docker writes from routes.

## 4. HOW to work here

### 4.1 Every change (features, fixes, UI, packages)

1. **Check the map first**: `docs/AI_CONTEXT.md` §7 (conventions) + §8 (gotchas — do not
   rediscover them), the relevant `docs/design/*.md`, and `docs/DECISIONS.md` for prior art.
2. **Tests first, then the smallest implementation**:
   - New engine behavior → `tests/unit/` (pure) + `tests/integration/` (daemon in-process, fake
     adapter). Integration files run **serially** (`fileParallelism: false`) — never rely on
     parallel ports/state.
   - New route → extend `src/contracts/api.ts` schemas AND `tests/unit/openapi.test.ts` (it pins
     the exact route list), then run `pnpm openapi` to regenerate `docs/openapi.json`.
   - New console flow → extend `tests/e2e/ui.spec.ts` (or `setup.spec.ts` for first-run).
     Playwright selectors: prefer `{ exact: true }` on labels/buttons — the eye-toggle
     `aria-label="Show password"` and "Log out of other sessions" both caused strict-mode
     violations before. Buttons must stay **visible and clickable** (a clipped 1px submit broke
     CI); Enter-to-submit still works with a real button.
   - Schema change → bump `SCHEMA_VERSION`, add `migrateVNtoVN+1` in `src/state/db.ts`, extend
     `tests/unit/migration.test.ts`. Prefer the `settings` table (JSON docs, no migration) for
     new preferences.
   - New DTO field → `src/contracts/api.ts` → `src/lifecycle/dto.ts` → consumers (web imports
     the same contract types — never duplicate shapes).
3. **Fast iteration**: `pnpm dev:ui` renders the console from `web/src/mock/` fixtures (no daemon);
   append `?screen=login` to preview the login hero. `pnpm dev` runs the daemon with fakes;
   `pnpm dev:web` is the proxying Vite server.
4. **Gate before commit** (ALL must pass — this is exactly what CI runs):
   ```sh
   pnpm lint && pnpm typecheck
   pnpm test                    # unit (81)
   pnpm test:integration        # 109 + 3 live-Docker skipped (~3.5 min)
   pnpm build && pnpm test:e2e  # 21 Playwright (~1.5 min, ports 18500/18700)
   pnpm catalog:verify && pnpm openapi -- --check
   ```
   Never `pnpm package | head` (SIGPIPE leaves a stale archive — always `| tail`).
5. **Docs are part of done.** Update together with the code:
   - Non-obvious choice → new row in `docs/DECISIONS.md` (next number **86**).
   - User-visible behavior → `docs/OPERATOR_GUIDE.md` (and `README.md` catalog/layout/scope if
     it changed).
   - Package format change → `docs/DEVELOPER_PACKAGES.md` (+ template) and the relevant
     `docs/design/*.md`.
   - New version behavior → `docs/VERIFICATION.md` section + `PROGRESS.md` phase row + counts.
   - New routes → `docs/openapi.json` via `pnpm openapi` (never hand-edit).
6. **Commit + ship**: commit on `main`, push — CI publishes the release. Bump `package.json`
   `version` when the change deserves a release (CI tags `v<version>` from it). Never run
   `gh release create` manually; never push with a red local suite.

### 4.2 Writing apps for Harbor (package authoring)

The full template and rules live in `docs/DEVELOPER_PACKAGES.md` — follow it, not this summary.
The non-negotiable subset:

- **Layout**: `manifest.yaml` + `compose.yaml` (+ optional `README.md`, `icon.svg` ≤ 256 KiB,
  screenshots ≤ 1 MiB) as a zip (`harbor packages add`) or a git repo with a `harbor/` folder
  (`harbor sources add`).
- **Compose subset ONLY**: `image`, `environment` (literals), `depends_on`, `healthcheck`,
  `volumes: type: volume`. NO `ports` (Harbor publishes endpoints itself), NO `command`,
  `privileged`, `cap_add`, `devices`, host networking, bind mounts. (`build:` allowed for
  git sources only.)
- **Identity**: `metadata.id` lowercase/dashes, must not collide with bundled ids;
  `release.revision` must rise on every upload (that is what triggers Updates).
- **Endpoints + health**: every service declared, every named volume claimed by exactly one
  `storage[]` entry, a health path that answers **before** any account exists, first run
  finishable in the browser (no CLI-only admin creation).
- **After editing a bundled package**: `pnpm tsx scripts/catalog-hash.ts <id>` (refresh
  `release.json` hashes) → `pnpm catalog:verify` (validates as the daemon does) →
  `node scripts/registry.mjs digest <image:tag>` for new pins. Qualification (`passed`) only
  comes from `scripts/vm/qualify-catalog.mjs` on a droplet — never stamp it by hand.
- **Forbidden**: secrets in the package, interpolation/`$` tricks, symlinks/`..` paths,
  remote images in presentation, rendering package text as HTML (served sandboxed).

### 4.3 UI/UX rules (the craft pass is the bar)

- One geometric Harbor mark (`web/src/app/icons.tsx` `Mark`) — no emoji as icons, no gradients
  or glows on glyphs/monograms. Palette entries use the neutral dot. Flat wallpaper tints.
- Umbrel is the reference: lowercase hero greetings, one quiet line, one primary action, quiet
  surfaces, 8pt spacing. No AI-looking glow, no placeholder copy, no dead buttons.
- Every action has an accessible name; dialogs are `<dialog>`; focus visible; color never the
  only signal. Phone width must work (bottom tabs, two-column tiles, full-screen dialogs).
- Auth: bearer token in memory; `localStorage` holds ONLY the 30-day remember token (when the
  user ticks the box), theme/wallpaper prefs, and UI state. No secrets in DTOs, logs, or URLs.
- Logout lives in Settings → Account (with the session list + log-out-others). Do not add
  logout buttons elsewhere.

### 4.4 Safety boundaries (stop and ask)

- Host bootstrap, Docker mutation, OS packages, reboots: **only** on the designated disposable
  VM (`pnpm test:vm`, `scripts/vm/`), never on the dev machine, never on an unrelated Docker
  socket. `pnpm test:vm` refuses without an explicit target — keep it that way.
- Confirm before outward-facing/irreversible acts: repo visibility, destroying droplets,
  DNS changes, publishing releases by hand.
- Never commit: real tokens/keys/passwords, VM IPs, `.env.vm.local`, `release/stage/`,
  `test-results/`, `playwright-report/`.
- macOS dev loop: no `timeout` (use `curl --max-time`), Node `fetch()` drops custom `Host`
  headers (use `node:http` in tests), plain-http LAN origins lack secure-context APIs
  (`crypto.randomUUID`, `clipboard` need fallbacks).

## 5. Definition of done (checklist)

- [ ] Tests added first; `lint`, `typecheck`, unit, integration, `build` + e2e,
      `catalog:verify`, `openapi --check` all green locally (= CI green)
- [ ] No new engine branch per app; no direct Docker writes outside the runner; no secrets
      in DTOs/logs/storage
- [ ] `docs/DECISIONS.md` row (if non-obvious), operator/dev docs updated, READMEs updated
      (package README for catalog changes), `docs/openapi.json` regenerated (if routes changed)
- [ ] Committed on `main` + pushed (CI releases); version bumped if release-worthy
