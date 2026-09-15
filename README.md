# Harbor (working codename) — simple self-hosted application manager, local preview

Harbor lets one administrator install a few self-hosted applications on one Ubuntu 24.04 x86-64
machine. Packages describe deployments; Harbor allocates non-conflicting loopback ports, starts
normal Docker Compose projects, verifies readiness, and remembers what it owns.

Bundled packages: **Excalidraw**, **BentoPDF**, **n8n + PostgreSQL** (all pinned by image digest).
Platform tools: **Cockpit** and **Portainer** set up or bound by bootstrap, opened from Harbor.

- Requirements, install, access, lifecycle, tools, troubleshooting: [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)
- Requirements/spec: [TDD.md](TDD.md) · build order: [plan.md](plan.md) · progress: [PROGRESS.md](PROGRESS.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · verification report: [docs/VERIFICATION.md](docs/VERIFICATION.md) · future context: [docs/FUTURE.md](docs/FUTURE.md)
- API: [docs/openapi.json](docs/openapi.json) (generated from the route schemas)

## Catalog (17 packages)

Excalidraw, BentoPDF, n8n, Open WebUI (with Ollama), AnythingLLM, Jellyfin, Immich, Nextcloud,
Vaultwarden, Uptime Kuma, Forgejo, FreshRSS, Actual Budget, Audiobookshelf, Navidrome, Memos, Mealie.
Every package is data (manifest, Compose subset with images pinned by digest, README, release
inventory with hashes and a qualification record). Apps with big data (Immich, Jellyfin, Nextcloud,
Audiobookshelf, Navidrome, Open WebUI models) accept a folder of your own at install time; see
docs/design/CATALOG.md and the operator guide section 4a.

## For the person running it

The console is a launcher (your apps as icons), an App Store, a Publishing page and a Settings page
that covers the household jobs without a terminal: change the password, connect the machine to your
Tailscale tailnet (log in with a click or paste an auth key) and put Harbor on it, see disks and pick or
create folders for apps like Immich and Jellyfin, choose theme and wallpaper. See the operator guide,
sections 4a and 4b.

## Repository layout

```
src/            daemon, domain, CLI, bootstrap (TypeScript, strict ESM)
  contracts/    JSON Schemas + DTO types (manifest, Compose subset, release inventory, API)
  packages/     restricted YAML parser, validators, catalog loader
  planner/      identity, port allocation, Compose rendering (pure functions)
  state/        SQLite (better-sqlite3), repositories, singleton lock
  docker/       adapter interface, Dockerode adapter, Compose CLI runner, fake adapter, port probe
  lifecycle/    plans/operations service, serial runner, readiness, observer
  auth/ api/    scrypt + bearer sessions; Fastify routes with Host/Origin/JSON guards
  tools/        Cockpit/Portainer state and probes
  bootstrap/    root-only host bootstrap, Docker install, systemd unit, tool recipes
web/            React + Vite UI (plain CSS, strict CSP, in-memory token)
catalog/        the three bundled packages (manifest.yaml, compose.yaml, release.json, README.md)
tests/          unit, integration (fake adapter; opt-in live Docker), e2e (Playwright), vm (live suite)
scripts/        catalog hashing/verification, OpenAPI, release packager, VM controller
release-assets/ shell launchers shipped in the archive
Vagrantfile     disposable Ubuntu 24.04 x86-64 test VM (generated output)
```

## Development

Prerequisites: Node 24.12+, pnpm 10.16+. No Docker needed for unit/integration/e2e (fake adapter).

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint
pnpm test                 # unit: contracts, parser, planner, catalog, OpenAPI
pnpm test:integration     # daemon in-process with the fake Docker adapter, temp state
pnpm build && pnpm test:e2e   # Playwright against the built UI + fake adapter
pnpm dev                  # daemon on http://localhost:18000 with private .harbor-dev state (fake Docker)
pnpm dev:web              # Vite dev server proxying to the daemon
pnpm package              # release/harbor-<version>-linux-x64.tar.gz + SHA256SUMS
```

Fake adapter vs live: unit/integration/e2e tests prove the engine, API and UI contracts with an
in-memory Docker that runs real loopback HTTP listeners; they are **not** evidence of real app
behaviour. Real evidence comes from:

- `HARBOR_LIVE_DOCKER_SOCKET=/path/docker.sock pnpm test:integration` — explicit opt-in engine for
  the developer loop (real Dockerode + `docker compose`).
- `pnpm test:vm` — the full A01–A16 suite against the designated disposable VM only
  (see [docs/VERIFICATION.md](docs/VERIFICATION.md)). It refuses to run without an explicit target.

Catalog maintenance: edit a package, run `pnpm tsx scripts/catalog-hash.ts <id>` to refresh its
inventory hashes, `pnpm catalog:verify` to validate everything as the daemon does, and
`node scripts/registry.mjs digest <image:tag>` to resolve digests.

## Scope and limits

This is a trusted local preview: loopback-only HTTP, one administrator, one daemon with Docker
authority. Not included (by design): backups, app upgrades, purge, proxies/TLS, LAN or public
administration, roles/SSO/MFA, remote catalogs, Nextcloud/office integration. See the operator guide.
