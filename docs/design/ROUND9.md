# Round 9 design — notifications, usage, sources from git, auto-updates, widgets

Scope agreed with Carlos on 2026-09-15 ("all of it"): per-app resource usage, storage inventory,
a notifications/attention engine with external channels, update-all plus opt-in automatic updates
(per app and global), a provisioned admin credential at install, **git-based app sources with
optional redeploy-on-commit (DigitalOcean-PaaS-like)**, and Home widgets. Everything ships in
v0.9.0 unless a feature is explicitly cut; widgets are the designated cut if the round runs long.

## 1. Per-app resource usage

- `DockerAdapter` gains `containerStats(id): Promise<ContainerStats | null>` (one-shot, no stream):
  `{ cpuPercent, memoryBytes, memoryLimitBytes }`, computed from the Docker stats API's two-sample
  delta (dockerode `stats({stream: false})` provides precpu). The fake adapter returns deterministic
  values settable per container.
- The observer tick collects stats for running instances (already iterating them) and caches the
  result in memory (`service.recordUsage`); no persistence, no history. DTO: `InstanceSummary.usage
  { cpuPercent, memoryBytes } | null` (null when stopped/unavailable/stats unsupported).
- UI: app drawer shows "CPU x% · y MiB"; Home tiles get a subtle usage line when running.

## 2. Storage inventory

- `DockerAdapter` gains `diskUsage(): Promise<DockerDiskUsage>` (`docker system df -v` equivalent
  through the API: volumes with `UsageData.Size`): `{ volumes: { name, sizeBytes }[] }`.
- Collected on demand (Storage page load, `GET /v1/system/storage/usage`) with a 60 s in-memory
  cache — `system df` is expensive; never in the observer loop.
- Volumes are matched to instances through recorded resources; the response groups
  `{ instanceId, name, volumes: [{ id, sizeBytes }], totalBytes }` plus an unowned remainder.
- UI: Settings → Storage lists per-app usage under the existing folders section; the app drawer
  shows the app's total.

## 3. Notifications engine

- New table `notifications` (schema v6): `id, created_at, kind, severity ('info'|'warning'|'error'),
  title, body, instance_id?, dedupe_key UNIQUE, read_at?, delivered_at?`. Producers upsert by
  `dedupe_key` (e.g. `update:<instanceId>:<revision>`, `disk:>90`, `degraded:<exposureId>`) so a
  persisting condition is one row, not spam.
- Producers (all in existing code paths, no new pollers):
  - update available (instance list computation) · Harbor update available (self-update check)
  - disk > 90 % (metrics sampling) · app degraded / readiness lost (observer)
  - exposure degraded (observer verify) · operation failed (runner) · git source: new commit seen,
    auto-redeploy result (§6).
- API: `GET /v1/notifications?unread`, `POST /v1/notifications/{id}/read`, `POST /v1/notifications/read-all`.
- Channels (settings key `notifications.channels`): **console** (always), **ntfy** (`{ server, topic,
  token? }` — plain POST), **webhook** (`{ url, secret? }` — JSON POST, HMAC-SHA256 signature header
  when secret set), **email** (`{ smtp: { host, port, secure, user?, pass? }, from, to }` — minimal
  SMTP client, no dependency). Deliveries are per-channel fire-and-forget with one retry; failures
  become a console-only notification (never a loop). Severity filter per channel (`min: 'warning'`).
- UI: bell in the top bar with unread count; panel lists notifications (mark read, clear); Settings →
  Notifications section configures channels with a "send a test" button. The Home attention list
  stays (live conditions), the bell holds the event history.

## 4. Update-all and automatic updates

- Update-all: one button (Home updates card + Store "Your apps") that submits one `update` plan per
  eligible instance sequentially through the existing serial queue; failures roll back per instance
  and never stop the rest.
- Automatic updates are **opt-in**: per instance (`instances.auto_update` column, default off) and a
  global default for newly installed apps (settings `updates.autoDefault`, off). A daily check
  (observer-adjacent timer, `updates.checkIntervalHours` default 24) computes available updates; for
  auto-enabled instances it submits the update plan itself (actor `auto-update`); everything else
  only produces a notification. Every auto result (success or rollback) is a notification.
- Harbor self-update stays manual (root privilege boundary, decision 70) — notification only.

## 5. Provisioned admin credential at install

- Manifest gains `provisionedCredentials { usernameEnv?, passwordEnv, username?, note? }`: Harbor
  generates a strong password (and username unless fixed), injects them through the named
  environment variables at first install only, and shows them **once** in the operation result
  (same UX as exposure basic-auth credentials, stored as retained instance secrets).
- Distinct from `defaultCredentials` (fixed upstream logins, decision 74): provisioned ones are
  per-instance secrets Harbor created.

## 6. Git-based app sources (the PaaS flow)

The developer story: clone a template repo → edit the app (any code, a Dockerfile, and the Harbor
package files) → point Harbor at the repo → Harbor builds and installs it → push a commit → Harbor
redeploys (if enabled).

- **Repo layout** (documented in DEVELOPER_PACKAGES.md; `harbor-app-template` repo to be published
  later): `harbor/manifest.yaml`, `harbor/compose.yaml`, optional `harbor/README.md`, `harbor/icon.svg`,
  and the app source with `Dockerfile`(s) referenced from the compose subset by a new
  `build: { context, dockerfile? }` service field (mutually exclusive with `image`).
- **Sources** (schema v6, table `package_sources`): `id, kind ('git'), url, ref (branch), path?
  (subdir), pinned_commit, last_seen_commit, auto_redeploy (bool), package_id, created_at, checked_at`.
  Git over HTTPS only, public repos first (`git ls-remote` + `git clone --depth 1 --branch`); a
  token setting (`sources.github.token`) unlocks private repos later without schema change.
- **Fetch → package**: clone at the branch head (or given commit), record `pinned_commit`, read
  `<path>/harbor/`, then reuse the existing upload pipeline (validation, asset rules, release.json
  generated by Harbor). The package revision is `<manifest revision>+g<shortsha>` so every commit is
  a newer revision (revision comparison already splits on `[._-]`; a `+g<sha>` suffix segment
  compares numerically as 0 — therefore the commit **date** (`committer date, unix`) is used as the
  numeric suffix instead: `<revision>.<committerDateUnix>`).
- **Builds**: services with `build:` are built locally at plan-apply time (`docker build`) with tag
  `harbor-src/<packageId>-<service>:<commit>`; the rendered compose references that tag. **Trust
  model extension (decision):** for git-sourced apps the provenance pin is the **commit SHA** (and
  the base images its Dockerfile pulls), not a registry digest. The plan review shows "built from
  <repo>@<shortsha>". Build logs stream into the operation events; build failure = operation failed
  (rollback path already exists for updates). Resource guard: builds run with a 15-minute timeout.
  `docker builder prune` is invoked for images Harbor built that no instance references (same
  ownership labels as everything else).
- **Redeploy on commit**: a poller (part of the auto-update timer, not a webhook — the box may not
  be reachable from GitHub) checks `git ls-remote <url> <ref>` every `sources.checkIntervalMinutes`
  (default 15) for sources with `auto_redeploy`; a new head → fetch → import as a new revision →
  submit an `update` plan (actor `git-source`). Without `auto_redeploy` it only notifies ("new
  commit on main: a1b2c3"). Manual "Redeploy now" button always available.
- **CLI/UI**: `harbor source add <url> [--branch main] [--path .] [--auto-redeploy]`,
  `source list/check/remove`; App Store "Your apps" gains "Add from a git repository" beside the
  zip upload; the app page shows source, branch, commit, and the redeploy toggle.
- git availability: bootstrap installs `git` (tiny, from Ubuntu archives) alongside its other
  approved packages.

## 7. Home widgets

- Manifest gains `presentation.widget { endpointId, path, kind: 'metrics'|'list', refreshSeconds? }`:
  the app must expose a JSON endpoint on its own port; Harbor's daemon proxies it
  (`GET /v1/instances/{id}/widget` → loopback fetch with a 2 s timeout, response size ≤ 64 KiB,
  auth headers stripped) so the browser never talks to the app cross-origin and CSP stays strict.
- `kind: 'metrics'`: `{ items: [{ label, value, unit? }] }` (≤ 4 shown). `kind: 'list'`:
  `{ items: [{ title, subtitle? }] }` (≤ 5 shown). Anything malformed → widget hidden, one
  console-severity-info notification, never an error state on Home.
- Home renders widgets as an optional second row on the app tile (opt-in per app from the tile's
  customize dialog, stored in `home.order`-style settings). Poll piggybacks on the console's
  existing 10 s refresh; the daemon caches per widget for `refreshSeconds` (default 30).
- None of the bundled packages declare widgets initially; Uptime Kuma and Immich are candidates once
  their JSON endpoints are qualified.

## Build order and migrations

1. Docker adapter: stats + df (+ fake) → per-app usage + storage inventory (no migration)
2. Schema v6: `notifications`, `package_sources`, `instances.auto_update` (one migration)
3. Notifications engine + channels + UI bell/settings
4. Update-all + auto-update timer
5. Provisioned credentials
6. Git sources (fetch/import; then builds; then redeploy-on-commit)
7. Widgets
8. OpenAPI + tests at every step; live VM round on `harbor-test-3` at the end (git flow proven with
   a real repo; a `harbor-app-template` example repo is part of the verification).

Decisions to record: usage/df adapter methods (76), notifications engine + channels (77),
auto-updates opt-in model (78), provisioned credentials (79), git sources + build-from-source trust
extension (80), widgets contract (81), schema v6 (82).
