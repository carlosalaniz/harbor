# AGENTS.md — rules of engagement for working on Harbor

Read this before writing code, packages, or docs. It tells you **what** Harbor is,
**where** things live, **why** the rules exist, and **how** to ship without breaking CI.

## 1. What Harbor is

A self-hosted application manager ("a private cloud for humans", Umbrel/HexOS-like but simpler):
one Ubuntu 24.04 x86-64 machine, one administrator, apps installed from a catalog of **data-only
packages** (manifest + Compose subset pinned by image digest), a React console (launcher home screen,
App Store, Publishing, Platform, Settings), and a `harbor` CLI against the same local API.
The official apps live in their own repo, **carlosalaniz/harbor-apps** (decision 158): its CI publishes
a catalog bundle as a GitHub release; the daemon downloads it over HTTPS (no signature: the same trust as
Harbor's self-update), checks its integrity and swaps it in at runtime, and every Harbor release tarball
ships the latest one as an offline seed.

- Trust model: the `harbor` service user is in the `docker` group and is therefore
  **root-equivalent**. The API is not a sandbox against root/Docker admins. Loopback by default;
  LAN mode, tailnet (Tailscale) and public HTTPS (Caddy + Let's Encrypt) are opt-in providers.
- Product truth: `docs/spec/TDD.md` (original spec) + `docs/DECISIONS.md` (every scope lift since, numbered —
  next number is **191**). `docs/spec/plan.md` is the historical build order; `docs/dev/PROGRESS.md` is the changelog.
- Session map: `docs/AI_CONTEXT.md` (where things are, versions, gotchas, live droplets).

## 2. Where things live

```
src/            daemon (TypeScript strict ESM, Node 24.22, pnpm 10.16)
  contracts/    JSON Schemas + DTO types — the API's source of truth
  packages/     restricted YAML parser, manifest/compose validators, catalog loader, zip import,
                min-harbor.ts (an app's declared `release.minHarbor` gate, decision 161)
  planner/      identity, port allocation, Compose rendering, gpu facts → Docker keys, app settings (PURE functions, no I/O)
  state/        SQLite (better-sqlite3, SCHEMA_VERSION 13, migrations v1→v13; v9 = `links`, v10 = several public names per endpoint, v11 = `backup_runs`, v12 = recovery words stripped from operation results, v13 = the operation queue: `cancelled`, nullable `plan_id`, `request_json`, `seq`), repositories
  docker/       adapter interface, Dockerode adapter, Compose CLI runner, FAKE adapter, port probe
  lifecycle/    plans/operations service, serial runner, readiness, observer (drive-guard stop,
              auto-mount on insert, auto-start on return, lock-guard start once a sealed app's
              key is back), DTO mapping
  auth/ api/    scrypt + bearer sessions (+TOTP), Fastify routes with Host/Origin/JSON guards
  exposure/     Tailscale + Caddy providers, URL rendering
  appearance/   wallpapers + rotation fetcher        system/  metrics, storage (lsblk devices,
              mounts, folders), device-mount service, power, terminal, logs, LAN, self-update
  storage/      bring-your-own-folder validation + `.harbor-bind.json` drive identity; app-home.ts
              (portable homes: plaintext manifest + dual-key envelope + machine wrapping),
              fscrypt.ts (PURE builders/parsers) + crypto-provider.ts (root oneshot handoff:
              request.json + key FIFO + blocking `systemctl start harbor-app-crypto@<id>:<action>`;
              kernel mkdir probe = read model; fake provider for tests)
  bootstrap/    root-only installer/upgrader (units + polkit; harbor.service grants
              ReadWritePaths `/var/lib/harbor /srv/harbor /mnt /media` so markers backfill);
              app-crypto-apply.ts = root half of sealing (tune2fs/fscrypt readiness, seal,
              unlock, lock, status, migrate-in-place) — the daemon NEVER runs fscrypt itself
  backups/      app backups (decisions 149–154): restic.ts + step.ts + schedule.ts + targets.ts are PURE;
              engine.ts = root handoff (`harbor-backup@<requestId>`, bootstrap/backup-apply.ts runs restic)
              + FAKE engine; service.ts = places, policy, sequential worker, restore points
  egress/       VPN and offline apps (decisions 184–185): wireguard.ts + rules.ts are PURE (wg-quick parser, nft
              ruleset, ip rules, effective mode); provider.ts = root handoff (`harbor-egress@<action>`,
              bootstrap/egress-apply.ts loads nft/routes/WireGuard) + FAKE provider; service.ts = desired state from
              every app, the VPN page, the `vpn-down` notification
  cli/          commander CLI (mirrors every console action)
  notify/       notifications engine + channels (ntfy/webhook/email; resolved rows delete fully)
web/src/        React 19 + Vite, plain CSS tokens, strict CSP; App.tsx, app/pages/*, app/icons.tsx,
                mock/ fixtures for `pnpm dev:ui`
                (the app catalog is NOT here: carlosalaniz/harbor-apps, checked out beside this repo as
                ../harbor-apps; apps/<id>/ = manifest.yaml + compose.yaml + README.md + release.json (+ icon))
targets/<id>/   one backup place package = manifest.yaml (kind BackupTarget: a form + a transport) + README.md
tests/          unit/ integration/ (fake adapter) e2e/ (Playwright) vm/ (live suite, opt-in);
                fixtures/catalog/ = FROZEN copies of 9 apps for tests, e2e and `pnpm dev` (not the store);
                fixtures/state/<tag>/ = FROZEN state dirs written by old releases (upgrade-jump test, decision 172)
scripts/        catalog-pin/hash/verify/bundle (take --catalog <dir> or HARBOR_CATALOG_DIR, default
                ../harbor-apps/apps), catalog-upstream.ts + upstream-tags.ts (the harbor-apps update bot: newer
                upstream tags, apply them; decision 175), catalog-smoke.ts (one app on a real Docker engine:
                install old → update → fresh install), catalog-fetch.mjs (downloads the latest catalog over HTTPS + checks
                the zip against its catalog.json), openapi.ts, package.mjs (ships that catalog as the seed), vm/ controllers
docs/           OPERATOR_GUIDE.md (user manual), DEVELOPER_PACKAGES.md (package authoring),
                VERIFICATION.md (evidence log), FUTURE.md (deliberately not built), TODO.md (wanted, not built yet),
                design/ (UI, CATALOG, EXPOSURE, ROUND9, APP_HOMES, BACKUPS, VPN), openapi.json (GENERATED — never hand-edit)
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
   Encryption is never best-effort: an app home that cannot be kernel-sealed fails its install
   (decision 103); never log "skipped" and continue with plaintext the UI calls encrypted.
5. **Every mutation is a plan → operation** through the serial queue with idempotency keys,
   15-minute plan expiry, persisted phases, and no replay after interruption (`needs_action`).
   No direct Docker writes from routes.
6. **The package format only grows** (decisions 159, 161). Published apps are read by Harbors of every
   age, so never remove, rename or narrow a field or value an official package may use; add new fields
   and values as optional. A breaking change needs a migration in the engine (Harbor adapts old
   packages, like Umbrel). An app that uses something new declares `release.minHarbor` in its manifest
   (the first Harbor release that accepts it); the harbor-apps CI proves the claim against that real
   release and the latest one, which is only sound because the format only grows. CI job
   `official-catalog` loads the latest published catalog with your commit.

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
     `tests/unit/migration.test.ts`; after that release ships, add `node scripts/make-state-fixture.mjs v<that
     release>` + the tag in `tests/integration/upgrade-jump.test.ts` (never edit an existing fixture). Prefer the `settings` table (JSON docs, no migration) for
     new preferences.
   - New DTO field → `src/contracts/api.ts` → `src/lifecycle/dto.ts` → consumers (web imports
     the same contract types — never duplicate shapes).
3. **Fast iteration**: `pnpm dev:ui` renders the console from `web/src/mock/` fixtures (no daemon);
   append `?screen=login` to preview the login hero. `pnpm dev` runs the daemon with fakes;
   `pnpm dev:web` is the proxying Vite server.
4. **Gate before commit** (ALL must pass — this is exactly what CI runs):
   ```sh
   pnpm lint && pnpm typecheck
   pnpm test                    # unit (646 + 2 skipped)
   pnpm test:integration        # 382 + 3 live-Docker skipped (~9 min)
   pnpm build && pnpm test:e2e  # 45 Playwright (~3 min, ports 18500/18700; HARBOR_E2E_PORT moves them)
   pnpm catalog:verify tests/fixtures/catalog --quiet
   pnpm catalog:hash --catalog tests/fixtures/catalog --check
   pnpm openapi -- --check
   ```
   Never `pnpm package | head` (SIGPIPE leaves a stale archive — always `| tail`).
5. **Docs are part of done.** Update together with the code:
   - Non-obvious choice → new row in `docs/DECISIONS.md` (next number **191**).
   - User-visible behavior → `docs/OPERATOR_GUIDE.md` (and `README.md` catalog/layout/scope if
     it changed).
   - Package format change → `docs/DEVELOPER_PACKAGES.md` (+ template) and the relevant
     `docs/design/*.md`.
   - New version behavior → `docs/VERIFICATION.md` section + `docs/dev/PROGRESS.md` phase row + counts.
     Live-run folders (`docs/evidence/vm-<ts>/`) are git-ignored by default (most are iteration
     scratch): commit ONLY the run VERIFICATION cites, with `git add -f docs/evidence/vm-<ts>`
     and a README.md inside saying what it proves.
   - New routes → `docs/openapi.json` via `pnpm openapi` (never hand-edit).
6. **Commit + ship**: commit on `main`, push — CI publishes the release, signed with the `HARBOR_SIGNING_KEY`
   Actions secret (decision 168, `docs/design/SIGNING.md`; the release job fails without it). Bump `package.json`
   `version` when the change deserves a release (CI tags `v<version>` from it). Never run
   `gh release create` manually; never push with a red local suite.

### 4.2 Writing apps for Harbor (package authoring)

The full template and rules live in `docs/DEVELOPER_PACKAGES.md` — follow it, not this summary.
The non-negotiable subset:

- **Layout**: `manifest.yaml` + `compose.yaml` (+ optional `README.md`, `icon.svg` ≤ 256 KiB,
  screenshots ≤ 1 MiB) as a zip (`harbor packages add`) or a git repo with a `harbor/` folder
  (`harbor sources add`).
- **Compose subset ONLY**: `image`, `command` (argument array, decision 123), `environment`
  (literals), `depends_on`, `healthcheck`, `volumes: type: volume`. NO `ports` (Harbor publishes
  endpoints itself), NO `entrypoint`, `privileged`, `cap_add`, `devices`, host networking, bind mounts. (`build:` allowed for
  git sources only.) A VPN server declares manifest `ports:` (fixed UDP) and `permissions:` (net-admin, tun,
  ip-forwarding) instead; Harbor renders them and the operator accepts them (decision 163).
- **Official apps live in carlosalaniz/harbor-apps** (`apps/<id>/`), not here. Edit them there, run
  this repo's scripts against that checkout, and open a PR there; its CI verifies, bundles and
  publishes (decision 158). `tests/fixtures/catalog/` is frozen test data — do not "update" it to match.
- **Icon**: every official app ships one (`presentation.icon`, a square .svg/.png ≤ 256 KiB that reads on light and dark;
  harbor-apps CI refuses an app without it). Take it from the project itself or dashboard-icons, never Umbrel's gallery.
- **Identity**: `metadata.id` lowercase/dashes, must not collide with bundled ids;
  `release.revision` must rise on every upload (that is what triggers Updates).
- **Secrets the operator types** (`source: operator` + `prompt`) and **links to another app**
  (`links:`) are data like everything else (decisions 125–126): values never enter plans, DTOs or
  logs; link networks join only the bound services and the provider's endpoint service.
- **Settings the operator can change** (`settings:`, decision 180, `minHarbor: "0.34.0"`) are visible values, not
  secrets: typed, with a default, bound to environment variables the compose file does not set itself. Only
  overrides are stored (`instances/<id>/settings.json`); never put a password in a setting.
- **Endpoints + health**: every service declared, every named volume claimed by exactly one
  `storage[]` entry, a health path that answers **before** any account exists, first run
  finishable in the browser (no CLI-only admin creation).
- **After editing an official package** (in harbor-apps; the scripts find `../harbor-apps/apps` on their
  own, or take `--catalog <dir>` / `HARBOR_CATALOG_DIR`): raise the revision in the manifest AND in
  `apps/index.json` → `node scripts/catalog-pin.mjs <id>` for new image pins → `pnpm catalog:hash <id>`
  (refresh `release.json` hashes) → `pnpm catalog:verify` (validates as the daemon does). An app that
  needs a Harbor newer than 0.28.0 declares `release.minHarbor: "x.y.z"` in its manifest (decision 161;
  at least 0.28.2, a published Harbor release); `pnpm catalog:bundle` copies it into the index entry, and
  `pnpm catalog:plan` groups apps by it for the harbor-apps CI. Qualification (`passed`) only comes from
  `scripts/vm/qualify-catalog.mjs --catalog <dir>` on a droplet, or from `pnpm catalog:smoke --record` (Harbor's
  engine on a real Docker host; the harbor-apps update bot runs it on GitHub's x86-64 runners, decision 175) —
  never stamp it by hand.
- **Upstream updates are automatic** (decision 175): harbor-apps `updates.yml` runs `catalog:upstream` +
  `catalog:smoke` daily; patch/minor moves land on main, majors (0.x minor included) open a PR, failures an
  issue. Steer it with harbor-apps `updates.json` (`hold` services, `skip` apps, `match` tags), not by editing
  the workflow. It uses the LATEST Harbor release's scripts, so a change to `catalog-upstream`/`catalog-smoke`
  reaches it only after a Harbor release.
- **Forbidden**: secrets in the package, interpolation/`$` tricks, symlinks/`..` paths,
  remote images in presentation, rendering package text as HTML (served sandboxed).
- **Changing the format itself** (a schema in `src/contracts/manifest.schema.ts`, `compose.schema.ts` or
  `release.schema.ts`): it only grows (§3.6): new fields and enum values are optional additions, limits
  and patterns only widen. Say in the release notes which version first accepts the change, so app
  authors know what to put in `release.minHarbor`. index.json entry fields need a new index
  schemaVersion instead. Unknown keys stay refused (they are a security boundary for the Compose subset).

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
- Never commit: real tokens/keys/passwords, VM IPs, LAN addresses or SSH users of physical
  boxes, setup codes, `.env.vm.local`, `release/stage/`, `test-results/`, `playwright-report/`.
- macOS dev loop: no `timeout` (use `curl --max-time`), Node `fetch()` drops custom `Host`
  headers (use `node:http` in tests), plain-http LAN origins lack secure-context APIs
  (`crypto.randomUUID`, `clipboard` need fallbacks).

## 5. Definition of done (checklist)

- [ ] Tests added first; `lint`, `typecheck`, unit, integration, `build` + e2e,
      `catalog:verify`, `openapi --check` all green locally (= CI green)
- [ ] No new engine branch per app; no direct Docker writes outside the runner; no secrets
      in DTOs/logs/storage; observer never touches Docker (drive-guard stops go through
      plan → operation with actor `drive-guard`)
- [ ] Drive-guard semantics kept: guard stops leave `desired` running (operator stops flip it);
      `adopt-drive` refuses only while containers run (`runtime`), not on `desired`;
      `needsDrive` stays a read-time model (no migration); resolved notifications delete fully
- [ ] `docs/DECISIONS.md` row (if non-obvious), operator/dev docs updated, READMEs updated
      (package README for catalog changes), `docs/openapi.json` regenerated (if routes changed)
- [ ] Committed on `main` + pushed (CI releases); version bumped if release-worthy
