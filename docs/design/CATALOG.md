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

1. Fits the Compose subset without `command`, `cap_add`, `devices`, `privileged`, host networking or
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
- Records: a `bind` resource (`name` = the folder, `metadata.storageId`, `metadata.readOnly`) next to
  the `volume` resources. `inspect` lists it with `present` = folder exists. Schema v3 widens the
  `resources.kind` CHECK; the migration rebuilds the table in place.
- Reinstall and start verify the folder still exists; if not, the operation fails with
  `DATA_MISSING` and a next action ("mount or restore the folder at the same path"). Nothing starts.
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

Nextcloud uses all of `authority` (`NEXTCLOUD_TRUSTED_DOMAINS`, `OVERWRITEHOST`), `scheme`
(`OVERWRITEPROTOCOL`) and `origin` (`OVERWRITECLIURL`); Forgejo uses `url` and `host`; Vaultwarden,
Mealie, Open WebUI and Jellyfin use `origin`. Environment variable names may now be mixed case
(`JELLYFIN_PublishedServerUrl`, `FORGEJO__server__ROOT_URL`), which the previous upper-case-only
pattern forbade.

## 5. Deliberately not in this round

| App | Why not yet | What would unlock it |
|---|---|---|
| OpenClaw | its Compose file needs `command`, `init`, `cap_drop`, `security_opt`, `extra_hosts`; first run is a CLI onboarding that writes the gateway token | a small, reviewed subset extension (`command`, `init`, `cap_drop`) plus a "secret shown once" affordance for the gateway token; AnythingLLM and Open WebUI cover the assistant/agent need meanwhile |
| Paperless-ngx, Linkding | admin account only via CLI or `*_ADMIN_PASSWORD` env | a one-time credential display for install (the exposure flow already has the pattern) |
| Collabora as a separate server | needs different `ssl.termination` for loopback vs published; WOPI setup is an in-app step | scheme-dependent configuration; Nextcloud Office works today through the recommended apps' built-in CODE server |
| Home Assistant, Pi-hole, Syncthing, AdGuard | host networking, DNS port 53, non-HTTP ports | not in the HTTP-endpoint model of this release |
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

## 6. Your own apps and updates (added 2026-09-15, v0.6.0)

Two package roots behind one `PackageStore`: the bundled catalog (hash-verified, shipped with Harbor)
and `localPackagesDir` for packages the operator uploads as a zip. Uploads are validated exactly like
bundled packages; Harbor writes `release.json` itself and pins tag images by digest through the registry
API at upload (decision 61). The console shows them with a *Your app* badge and a *Your apps* filter.

Updates (decision 62): a `PackageStore` revision higher than an instance's revision is an available
update, offered on Home, in the drawer and by `harbor list`/`harbor update`. The `update` plan keeps the
instance identity and swaps the release; the runner keeps `release-previous/` and rolls back automatically
when the new release does not start or answer. Developer guide: docs/DEVELOPER_PACKAGES.md.
