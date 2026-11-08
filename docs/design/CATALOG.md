# Design addendum: the one-click catalog and "bring your own folder"

**Status:** approved direction (Carlos, 2026-09-14): a catalog of apps that are easy to install
(Open WebUI, Nextcloud with office, an OpenClaw-class agent, Immich, Jellyfin, plus useful Umbrel
staples), with configurable external storage for the apps where that is the biggest pain.
North star: *a self-hosted cloud for humans.*

## 1. What a package must be

Every package is the same four files plus optional assets, checked the same way (docs/design and
TDD section 4): `manifest.yaml`, `compose.yaml` in the supported subset (image by digest,
environment, depends_on, healthcheck, named volumes only), `README.md`, `release.json` with file and
asset hashes, per-image index digest and linux/amd64 platform digest, and a qualification record.
There is still no per-app code path in the engine: a package is data.

Selection rules for this catalog round:

1. Fits the Compose subset (`command` is allowed since decision 123) without `cap_add`, `devices`, `privileged`, host networking or
   extra ports. Apps that need them are listed in section 5 instead of being bent into shape.
2. First run finishes in the browser (its own account setup or no accounts at all). Apps whose only
   admin-creation path is a CLI command or a password in an environment variable are excluded for now
   (Harbor would either print a secret or hide it; both are wrong for a one-click flow).
3. No telemetry by default where the app offers a switch.
4. A health path that answers HTTP before any account exists.

## 2. Packages (revision 1)

| Package | Services | Category | External storage | First run |
|---|---|---|---|---|
| open-webui | Open WebUI + Ollama | ai | `models` (optional) | first account is admin; pull a model |
| anythingllm | AnythingLLM | ai | – | onboarding wizard (provider, workspace) |
| jellyfin | Jellyfin | media | `media` (optional) | setup wizard |
| immich | server, machine-learning, PostgreSQL (VectorChord), Valkey | media | `library` (optional) | admin account; mobile app |
| nextcloud | Nextcloud (Apache), PostgreSQL 17, Redis | files | `data` (optional) | admin account; recommended apps include Nextcloud Office (built-in CODE) |
| vaultwarden | Vaultwarden | security | – | create account; sign-ups open until turned off |
| uptime-kuma | Uptime Kuma | network | – | admin account |
| forgejo | Forgejo (SQLite, SSH off) | developer | – | installer pre-filled; admin section |
| freshrss | FreshRSS | productivity | – | installer (SQLite) |
| actual | Actual Budget server | finance | – | set server password |
| audiobookshelf | Audiobookshelf | media | `audiobooks`, `podcasts` (optional) | root account |
| navidrome | Navidrome | media | `music` (optional, read-only) | admin account |
| memos | Memos | productivity | – | first account is host |
| mealie | Mealie | home | – | default account, change it |

Plus the three MVP packages (Excalidraw, BentoPDF, n8n). Images were pinned on 2026-09-14 with
`scripts/catalog-pin.mjs` (registry API, no Docker daemon); each `release.json` records the tag that
was resolved, the index digest used in `compose.yaml`, the linux/amd64 platform digest, the image
creation time and the image config facts (exposed ports, declared volumes, user).

## 3. "Bring your own folder" (external storage)

The biggest pain with Immich, Nextcloud, Jellyfin and friends is where the big data lives. Harbor
keeps managed Docker volumes as the default and adds one optional choice per storage claim:

```yaml
storage:
  - id: library
    composeVolume: library
    purpose: Photos and videos
    retention: retain
    external: {hint: "Pick a folder with plenty of room, for example /mnt/photos", required: false, readOnly: false}
```

- The install request may carry `storage: {library: {hostPath: "/mnt/photos"}}` (CLI:
  `harbor install immich --storage library=/mnt/photos`; console: a per-claim choice in the install
  page). Only claims marked `external` accept a folder; `required: true` forces a choice.
- Plan time validation (before anything reaches Docker): absolute, normalized, no `..`, not the root,
  not under a denylist (`/etc /usr /proc /sys /dev /boot /run /root /var/lib/docker /var/lib/harbor`
  and the like, also after resolving symlinks), must exist and be a directory, must not overlap a
  folder another instance already uses (equal, parent or child), nor another claim of the same plan.
  The plan says `Use your folder /mnt/photos for Photos and videos; Harbor never deletes it`.
- Rendering: the service volume entry becomes a bind mount with `create_host_path: false` (and
  `read_only` when the claim says so); no Docker volume is created or declared for that claim.
- Records: a `bind` resource (`name` = the folder, `metadata.storageId`, `metadata.readOnly`,
  `metadata.driveId`) next to the `volume` resources. `inspect` lists it with `present` = folder exists. Schema v3 widens the
  `resources.kind` CHECK; the migration rebuilds the table in place.
- Claiming a folder stamps an app-generated `driveId` into its `.harbor-bind.json` marker
  (random at install, kept on restore, fresh on replacement — never a hardware UUID; see
  decisions 89–90). Reinstall and start verify folder + marker; a missing, foreign or swapped
  folder fails with `DATA_MISSING` and a next action. The observer stops the app through the
  queue when its drive leaves (`needsDrive` on the summary, Start refused), auto-mounts fresh
  inserts and auto-starts recovered apps (both policy-gated), and `adopt-drive` accepts a
  replacement folder. Nothing ever starts against the wrong folder.
- Remove leaves the folder untouched and says so in the events. Harbor never chowns or deletes an
  external folder; it creates one only when the operator names it in the folder picker, inside a parent
  the service account may already write to (the Harbor data folder `/srv/harbor` by default). Permissions are the app's business: the packaged images run as root
  (Immich, Jellyfin, Audiobookshelf, Navidrome) or take ownership on first start (Nextcloud), which
  is why the hint for Nextcloud says so.

## 4. Configuration binding formats

Apps want different shapes of "their own address". `configuration[].format` selects the part of the
endpoint's primary URL a variable receives, and it is re-rendered when the primary address changes:

| format | value for `https://cloud.example.com:8443/` |
|---|---|
| `url` (default) | `https://cloud.example.com:8443/` |
| `origin` | `https://cloud.example.com:8443` |
| `authority` | `cloud.example.com:8443` |
| `host` | `cloud.example.com` |
| `scheme` | `https` |

Nextcloud revision 1 used `authority` (`NEXTCLOUD_TRUSTED_DOMAINS`, `OVERWRITEHOST`), `scheme`
(`OVERWRITEPROTOCOL`) and `origin` (`OVERWRITECLIURL`); revision 2 drops them for an `afterStart`
hook that hands it every address at once (decision 116). Forgejo uses `url` and `host`; Vaultwarden,
Mealie, Open WebUI and Jellyfin use `origin`. Environment variable names may now be mixed case
(`JELLYFIN_PublishedServerUrl`, `FORGEJO__server__ROOT_URL`), which the previous upper-case-only
pattern forbade.

## 5. Deliberately not in this round

| App | Why not yet | What would unlock it |
|---|---|---|
| OpenClaw | its Compose file needs `command`, `init`, `cap_drop`, `security_opt`, `extra_hosts`; first run is a CLI onboarding that writes the gateway token | a small, reviewed subset extension (`command`, `init`, `cap_drop`) plus a "secret shown once" affordance for the gateway token; AnythingLLM and Open WebUI cover the assistant/agent need meanwhile |
| Paperless-ngx, Linkding | admin account only via CLI or `*_ADMIN_PASSWORD` env | a one-time credential display for install (the exposure flow already has the pattern) |
| Collabora as a separate server | needs different `ssl.termination` for loopback vs published; WOPI setup is an in-app step | scheme-dependent configuration; Nextcloud Office works today through the recommended apps' built-in CODE server |
| Pi-hole, AdGuard | host networking, DNS port 53 | not in the HTTP-endpoint model of this release (Syncthing has since shipped; Home Assistant is harbor-apps PR #31 (2026-11-08): the Container install on its own network: devices added by IP, no discovery, USB or Bluetooth, an after-start hook trusts Harbor's proxies) |
| Bitcoin/Lightning stack | not in the "cloud for humans" scope | – |

## 6. Porting Umbrel's official catalog

Umbrel packages are `umbrel-app.yml` + a Compose file that relies on `app_proxy`, `APP_DATA_DIR`
bind mounts, `${APP_*}` interpolation and often host features. About a third of its ~300 apps fit
Harbor's subset as-is; the rest need one or more of the exclusions above. A converter would be a
translation of the manifest (name, tagline, category, icon, gallery, developer, website) plus a
Compose rewrite (bind mounts → storage claims, `APP_DATA_DIR` → managed volumes, `app_proxy` →
endpoint). This round ports fourteen apps by hand with Harbor semantics (digest pinning, storage
claims, configuration formats, qualification). The converter is listed in docs/FUTURE.md; each
converted app still needs a live qualification, which is the real cost.

## 7. Qualification

`scripts/vm/qualify-catalog.mjs [--fresh] [--only a,b]` installs every package on the designated
droplet, waits for readiness, opens the UI in headless Chromium (title + screenshot + health probe),
inspects mounts and resources, removes the instance, and repeats once with host folders for every
package that has external claims. Results land in `docs/evidence/catalog-<timestamp>/` and in each
package's `release.json` qualification (`passed` or `blocked` with the reason).
Since 0.28.0 (§9) the packages live in harbor-apps: pass `--catalog <dir>` (default `../harbor-apps/apps`)
and the results are written into that checkout. The script refuses to record anything when the box's
`harbor catalog` revisions differ from the checkout's, so build the archive from a bundle of the same
checkout (`HARBOR_CATALOG_BUNDLE=<dir> pnpm package`) or narrow the run with `--only`. Right after
bootstrap, both the qualification and the VM suite (`run-vm-tests.mjs`, A01) pin the box to the archive's
seed: `catalog: {url: null}` in `/etc/harbor/harbor.json` (root:harbor 0640), `/var/lib/harbor/catalog`
removed, harbor restarted. They then assert `harbor catalog status` reports origin `bundled` with the
seed's serial: in A02 before the tamper steps, and in qualification again just before results are
recorded (a mismatch records nothing). Without that pin a downloaded catalog could take over mid-run.

## 6. Your own apps and updates (added 2026-09-15, v0.6.0)

Two package roots behind one `PackageStore`: the official catalog (hash-verified; shipped with Harbor, and since 0.28.0 also downloaded, §9)
and `localPackagesDir` for packages the operator uploads as a zip. Uploads are validated exactly like
bundled packages; Harbor writes `release.json` itself and pins tag images by digest through the registry
API at upload (decision 61). The console shows them with a *Your app* badge and a *Your apps* filter.

Updates (decision 62): a `PackageStore` revision higher than an instance's revision is an available
update, offered on Home, in the drawer and by `harbor list`/`harbor update`. The `update` plan keeps the
instance identity and swaps the release; the runner keeps `release-previous/` and rolls back automatically
when the new release does not start or answer. Developer guide: docs/DEVELOPER_PACKAGES.md.

## 8. Operator-provided secrets and app links (added 2026-10-05, v0.21.0, decisions 125–126)

- **`secrets[].source: operator`**: the value comes from the operator, not from Harbor's generator.
  Plan rows carry only `{id, source, prompt, optional, minLength, maxLength, ask}`; the value travels
  with `POST /v1/operations` (`secrets: {id: value}`), is checked before the operation exists, held in
  memory keyed by plan id and taken by the runner first thing (the install-location passphrase pattern).
  Storage, binding, retention and redaction are those of generated secrets. `configure` plans replace
  values later.
- **`links[]`**: per-link Docker network `<consumer project>_link_<id>`, created by the runner
  (`internal`, Harbor labels incl. `link` and `provider`, ownership checked before use and removal).
  Joined by the consumer's bound services and the provider's endpoint service (alias `<id>-link`) only.
  The consumer's variables get `http://<id>-link:<containerPort>` (`url`/`authority`/`host`/`port`).
  Relation state in the `links` table (schema v9): `active`, `needs_provider` (provider removed or never
  chosen), `dormant` (consumer removed; Reinstall revives). Render paths re-create a missing network.
  **Decision 171: link networks are never in a rendered Compose file.** Compose names every container it
  attaches after its service on each network, and Docker resolves a name on any network a container sits
  on (its own network answers first, but while the provider's `db` is stopped its endpoint service
  resolved `db` to a consumer service called `db`, Docker 29). So the runner attaches both sides with
  `docker network connect` and explicit aliases only (consumer services none, provider `<id>-link`;
  Docker adds just the unique container name and short id). A linked app is created with `up --no-start`,
  its side attached, then started (`up --wait`), so the link is there from the first second; after
  every `up`/`start` both sides are checked and the other app attached live. A member that answers to
  any other name (what Compose left before 0.32.0) is detached and attached again: same container, same
  address (always detach first: Docker accepts a second connect of an attached, stopped container and
  keeps its old aliases; aliases are read by network name, because Docker leaves `NetworkID` empty on
  every network of a container that never started). Once per daemon start the observer reads every link
  that exists then; one whose containers still answer to other names gets a `relink` operation (internal
  kind, actor `link-guard`, not accepted by the API): both sides attached again live, nothing recreated,
  both Compose files rewritten without the link network. So an upgrade switches untouched links by
  itself; `compose start` on a 0.31 file never re-adds the names (Compose attaches networks only on `up`).
- Not in this round: links to platform tools, several providers per link, cross-machine links, and
  automatic restarts of a consumer when a provider's container port changes (an event says to Restart).

## 9. The catalog moves to harbor-apps and updates itself (added 2026-10-11, v0.28.0, decision 158)

**Where it lives.** carlosalaniz/harbor-apps: `apps/index.json` + `apps/<id>/`, same package format.
Harbor keeps only frozen copies of 9 apps in `tests/fixtures/catalog` for its own tests, e2e and
`pnpm dev`; `targets/` (backup place packages) stays in Harbor. Editorial scripts resolve the catalog as
`--catalog <dir>` (or a positional dir), then `HARBOR_CATALOG_DIR`, then `../harbor-apps/apps`.

**What is published.** One GitHub release `c<serial>` per change on harbor-apps `main`, two assets:

| File | Content |
|---|---|
| `catalog.zip` | `index.json` at the root + per app only `manifest.yaml`, `compose.yaml`, `README.md`, `release.json` and the assets its manifest names; sorted, deterministic; ≤ 96 MiB, ≤ 4096 entries |
| `catalog.json` | `{schemaVersion: 1, serial, commit, createdAt, zip: {sha256, bytes}, packages}`, ≤ 64 KiB — an integrity check of the zip, not a trust anchor |

`serial` = the commit's committer time (unix seconds). The workflow refuses a committer time more than
5 minutes in the future, skips a re-run of a commit that is already released, fails a different commit
with the same serial as an existing release, and for a serial not newer than the latest release skips
when `main` has moved on (the newer commit publishes) and fails otherwise (clock skew).

**CI layout.** Four jobs. *plan* (every PR, manual run, and push to main touching the apps, the CI
scripts or the workflow) resolves the latest Harbor release to its commit, runs its `catalog:plan`, and
checks each declared `release.minHarbor` is a published release (decision 161, §10). *check* runs the
tools of each of those releases at its exact commit: the latest on every app, each declared minimum on
the apps declaring it. *bundle* (main push or manual run only; read-only, no token) builds `catalog.zip`
+ `catalog.json` + `summary.json` with the latest release's tools and uploads them. *publish* (the only
job with `contents: write`; no checkout, no install, its token only on the two `gh` steps) downloads that
artifact, checks it belongs to this commit, signs `catalog.json` with `HARBOR_SIGNING_KEY` (decision 168), and runs `gh release create c<serial> catalog.zip catalog.json catalog.json.sig
--latest`.

**Trust.** Since 0.32.0 (decision 168, `docs/design/SIGNING.md`): the release key that signs Harbor's own
releases also signs every catalog. The publish job writes `catalog.json.sig` (base64 Ed25519 over the exact
`catalog.json` bytes) and uploads it with the release; a box verifies it with the pinned keys
(`src/release-keys.ts`) before it reads anything in `catalog.json`, and refuses an unsigned or badly signed
bundle (status error, the active catalog stays). `catalog.json` then pins the zip (sha256 + size). Before
0.32.0 the trust was HTTPS to GitHub only (decision 158: signing the catalog alone was built and removed).
A box accepts a bundle only if the signature verifies, the catalog URL is https
(plain http only for loopback), the serial is strictly higher than the active one (no rollback) and at
most 24 h ahead of the box's clock ("the app catalog is dated in the future" otherwise: a far-future
serial would block every newer bundle until then), the zip is within its caps and matches the sha256 and
size in `catalog.json`, it extracts safely, and the index validates with every listed folder present.

**On the box.**

- Seed: `config.catalogDir` (`/opt/harbor/catalog`), extracted from the bundle by `pnpm package`
  (which resolves `releases/latest` to its `c<serial>` tag once, fetches both files from
  `releases/download/c<serial>/`, requires the serial in `catalog.json` to match the tag, and fails
  rather than ship an empty or unchecked catalog), with `catalog.json` kept verbatim. Without a `catalog.json` (dev, tests) the seed is serial 0. Read once at start.
- Downloads: `<stateDir>/catalog/<serial>/` (same layout) and `<stateDir>/catalog/current.json`
  (`{"serial": N}`, written via rename). Every catalog read picks the downloaded folder only when the
  pointer parses, its `index.json` exists, its serial beats the seed's, and its stored `catalog.json`
  still verifies with the `catalog.json.sig` stored beside it (0.32.0, decision 168), parses and names that
  folder's serial (= the pointer); otherwise the seed (logged once as "damaged" or "not signed"). The
  signature re-check also retires a folder that Harbor 0.31 or older downloaded unsigned: after the update to
  0.32.0 the box uses its seed until the first check (a minute later) downloads the newest signed bundle. It is
  cached by serial + size/mtime of `catalog.json` and `catalog.json.sig`, so reads stay cheap, and the next
  bundle is compared with the seed, not with the damaged folder. A Harbor upgrade
  with a newer seed takes over by itself.
- Check: a minute after start, then every hour (6 h before 0.30.0, decision 164), or on demand (`POST /v1/catalog/refresh`,
  `harbor catalog refresh`, Store → *Check for new apps*; single-flight). Resolve `releases/latest` once
  (redirect not followed; its Location names tag `c<serial>`) and stop if that serial is not newer; then
  everything comes from `releases/download/c<serial>/` (0.32.0, decision 168; before, each file came from
  `releases/latest/download` and a check that read two releases started over once): `catalog.json` and
  `catalog.json.sig` (30 s each), verify the signature, require the serial in `catalog.json` to be the tag's,
  then `catalog.zip` (capped at the size `catalog.json` gives,
  5 min), extract to `.partial-<serial>` with a path check, validate, rename, write the pointer,
  prune all but the new folder and the one it replaced. The whole check has one deadline of 240 s (each
  step gets at most what is left), below the CLI's 300 s wait for the response. A `catalog.url` that is not
  a `…/releases/latest/download` URL (a mirror) is read as is, signature required the same way; there a publish
  between two reads can still mix two bundles (a signature or checksum that does not match), so a mirror check
  that sees one starts over once. Any failure leaves the active catalog
  as it was and is reported in `GET /v1/catalog/status` (`error`; `checkedAt` lives in memory only).
  The Store's catalog line shows a stored failure on load ("Last check failed: …", role=status) and
  "· checked <relative time>", so a stuck automatic check is never silent.
- Refresh is a direct route, not a plan: it never touches Docker. Installed apps see a higher revision
  on the next observer tick as an ordinary update — the notification, or an automatic `update` plan for
  instances with auto-update on. A plan made before a swap still pins its revision and hashes: if the
  runner finds them changed when it starts (before anything is written), the operation fails
  `PLAN_STALE` ("Review the plan again"), the app keeps its install state and readiness, no
  notification is sent, and a stale install leaves no instance row or port claim behind.
- Config: `catalog: {url}`. A leftover `publicKeys` (from a hand-edited config) is accepted and
  ignored, with one warning in the log at start. Default url
  `https://github.com/carlosalaniz/harbor-apps/releases/latest/download`; https only (http just for
  loopback); `url: null` means no timer and no fetch (dev, tests, openapi generation).

**minHarbor.** Optional `"minHarbor": "x.y.z"` on an index entry. A Harbor older than that lists the app
as unavailable ("needs Harbor x.y.z or newer"), install fails with INVALID_STATE and the next action
"Update Harbor …", restore from a backup says the same (not "no package"), and the app offers no
update. Presentation assets (`/v1/catalog/<id>/asset/<name>`) skip the gate, and fall back to an
installed copy's release snapshot when the current revision cannot be read, so installed apps keep
their icon. Since decision 161 the bundle copies it from the app's own manifest (`release.minHarbor`),
and the daemon checks the manifest value too: see §10.

**Id clashes.** An id the operator uploaded keeps winning after the official catalog adds the same id
(the official duplicate is hidden and offers no update); removing the upload hands the id back. A new
upload of an official id is still refused.

**Bootstrap order.** Harbor's release job needs a published harbor-apps release (the first one,
`c1791783123`, exists). harbor-apps CI uses published Harbor releases only (decision 161; the
`.harbor-ref` commit pin of decision 158 is gone): Harbor changes reach the catalog tooling when they are
released, and `pnpm catalog:plan`, which the per-version checks need, exists from 0.28.2 (0.28.1 was
released without it, so harbor-apps CI fails until 0.28.2 is the latest release).

**Not done yet** (docs/TODO.md): persisting `checkedAt`, and a review policy for community submissions.
(Signing Harbor releases and the catalog with one key, and the daemon downloading by tag, shipped in 0.32.0,
decision 168.)

## 10. Compatibility: the format only grows (added 2026-10-11, v0.28.0, decision 159; minHarbor reworked in v0.28.2, decision 161)

Published apps are read by Harbors of every age, and a new Harbor reads apps written for old ones.
Neither direction may break.

**The rule.** The package format only grows: never remove, rename or narrow a field or value an
official package may use. New fields and values are optional; limits and patterns only widen. A
breaking change needs a migration in the engine: Harbor adapts old packages (as Umbrel does), packages
are never rewritten for it. Release notes say which version first accepts a format change.

**Declared minHarbor (old Harbor, new app).** Each app states the oldest Harbor it runs on in its own
manifest, `release.minHarbor: "x.y.z"`. It is the app's contract.

| | |
|---|---|
| absent | 0.28.0, the first Harbor that downloads catalogs |
| present | canonical `x.y.z` (no leading zeros, so it is spelled like the release tag `v<x.y.z>`) and at least 0.28.2, the first release that ships the field (0.28.0 and 0.28.1 do not know it and would refuse the manifest); checked by `validateManifestShape` |
| index.json | `pnpm catalog:bundle` copies it into the app's entry (left out when absent), so a 0.28.0 box, which reads only the index, lists the app as "needs Harbor x.y.z or newer". The repo's `apps/index.json` may omit it; when present it must equal the manifest's (verify, plan and bundle fail otherwise) |
| daemon | gates on the index value before parsing (§9) **and** on the manifest value, read off the parsed YAML before the schema check (`src/packages/min-harbor.ts`), so a manifest written for a newer Harbor says what it needs instead of failing validation: catalog listing/load (unavailable), uploads and git sources (refused, 409 `INVALID_STATE`) |

The bundle log prints `ok   <id>@<revision>[ (<version>)][ minHarbor=<x.y.z>]` per app, for people.
Tools read `pnpm catalog:bundle … --summary <file>` instead: JSON
`{serial, commit, packages:[{id, revision, version|null, minHarbor|null}]}`, sorted by id (the harbor-apps
publish job builds its release notes from it with jq; `version` is free text, so the log line cannot be
parsed safely). `pnpm catalog:verify` prints `minHarbor=<value>` or `minHarbor=0.28.0(default)`.

**The proof (harbor-apps CI).** CI proves the claim instead of computing it:
1. the declared version must be a real published Harbor release: GitHub release `v<x.y.z>` on
   carlosalaniz/harbor, not draft or prerelease, its tag commit on `main`;
2. the apps declaring it must validate with **that** release's own validator: resolve the tag to its
   commit, check the commit is on `main`, check out that exact commit (never the tag name), set up the
   toolchain that commit names (Node from `package.json` engines, pnpm from `packageManager`),
   `pnpm install`, run its `pnpm catalog:verify` on a subset folder holding just those apps (copies plus
   an index.json filtered to them, built by harbor-apps' dependency-free `scripts/subset.mjs`; an app's
   folder must equal its id, which `readCatalogIndex` already enforces);
3. every app also validates with the **latest** Harbor release, which also builds the bundle in a job
   without write access; a separate publish job (`contents: write`, no Harbor checkout, no install)
   downloads it and runs only the `gh` steps.

Because the format only grows, passing on the minimum and on the latest release is the proof for every
release in between. The groups come from `pnpm -s catalog:plan <dir>` (0.28.2+), one line of JSON on
stdout: `{"groups":[{"minHarbor":"0.28.0","ids":[...]},...]}`, groups sorted by version, ids sorted. It
validates every app with its own loader first and exits 1 with the reason (stderr) when an app does not
load or declares an invalid minimum (not canonical x.y.z, below 0.28.2, or an index.json value that differs).

Decision 159's computed table (`src/packages/features.ts`, its constraint snapshot and guard test) was
removed: it had to name every schema path, value and constraint, and still could not see cross-field
rules, inline checks, file caps or parser settings. Running the real old validator covers all of that
by construction.

**Strict validation stays.** Umbrel ignores unknown manifest keys; Harbor refuses them. An unknown
Compose key is a security boundary (an old engine that silently dropped one could run something other
than what was reviewed), so old boxes get the explicit `minHarbor` gate instead of leniency.

**New Harbor, live catalog.** Harbor CI job `official-catalog` (separate from `verify`, so it never
changes that job's result) runs `pnpm catalog:fetch --out <dir>` (`scripts/catalog-fetch.mjs`, the same
tag-resolving download, checked against catalog.json, `pnpm package` uses) and then `pnpm catalog:verify <dir>`
with the commit's code. An engine change that would break a published app fails at push/PR time, not
first at release. With no catalog release yet (bootstrap only) the fetch fails with "is there a
published catalog release on carlosalaniz/harbor-apps?".

**Why.** Umbrel's `manifestVersion` is the minimum OS, set by hand, and Umbrel only started enforcing it
on app updates in Aug 2026 (umbrel commit 36fa892d5e); StartOS stamps the minimum OS at pack time.
Harbor takes StartOS's stamping and Umbrel's grow-only format.

## 11. The catalog follows upstream releases (added 2026-10-13, v0.33.0, decisions 174–175)

**What people see.** The Store shows each app's own version (decision 174): the manifest's `release.version`, else
the `appVersion` of the main endpoint's image in `release.json` (variant suffix dropped). The 17 original packages
never wrote `release.version`, so Open WebUI read "revision 1" while it was 0.11.3; nothing in the packages changed.

**Who moves the versions.** harbor-apps `.github/workflows/updates.yml`, daily (decision 175):

```
find  (read)   latest Harbor release → pnpm catalog:upstream check --policy updates.json
               → leave out updates that already have an open PR/issue (marker <!-- harbor-update: id svc=tag… -->)
               → at most 8 apps, patch first
try   (read)   per app: catalog:upstream apply → catalog:verify (that Harbor) → catalog:smoke --record
               → artifact: git diff of apps/<id>/ + meta.json (result passed|failed|skipped|invalid|apply-failed)
land  (write)  no package or Harbor code; patch must touch only plain files under apps/<id>/
               passed patch/minor → commit on main (index.json revision via jq), then gh workflow run ci.yml
               passed major       → branch updates/<id> + PR (or an issue with the compare link when Actions
                                    may not open PRs), ci.yml dispatched on the branch
               failed             → issue with Harbor's events and the containers' last log lines
```

ci.yml is unchanged: a dispatch on main checks, bundles, signs and publishes exactly like a push.
GITHUB_TOKEN pushes start no workflows, hence the explicit dispatch.

**Choosing a tag** (`scripts/upstream-tags.ts`, pure, `tests/unit/upstream-tags.test.ts`): same shape (digit runs
replaced, same count), numerically newer, never a version→date switch; level = first differing place, one place
further for 0.x (0.11 → 0.12 is major) and 0.0.x always major. Infrastructure services and known databases stay
within their major. Lockstep groups = same registry owner + same current tag; a group takes the newest tag every
member has. A candidate must resolve for linux/amd64, be at least `minAgeDays` (2) old and newer than the pinned
image (that check removed old date tags like heimdall's 2021.11.28 in the first full run).

**Proving it** (`scripts/catalog-smoke.ts`): the daemon in-process with the real Dockerode adapter and `docker
compose`, a throwaway state dir, one-app catalogs. With `--base`: install the current revision, close the daemon
(the app keeps running), start it on the new catalog, update; the update must succeed without a rollback. Then purge
and install the new revision fresh. Each phase ends with a settle window (60 s in CI): every container running with
no restart, Harbor's readiness not unhealthy. Only resources labelled with the run's installation id are removed.
A pass with `--record` writes `qualification: passed` (host = the runner: Ubuntu 24.04 x86-64, its Docker and
Compose versions) and refreshes the hashes. GitHub's runners are disposable x86-64 Ubuntu machines; the droplet's
`qualify-catalog.mjs` stays the deeper check (systemd bootstrap, browser, sealed homes).

**Not covered yet.** A floating tag (`postgres:16`, `redis:7`) whose digest moved is not refreshed (same tag, no
newer shape); a major PR is reviewed by a person against the project's upgrade notes; apps with a required link
to another app are reported as needing a manual check.
