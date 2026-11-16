# Umbrel compatibility: what Harbor must add to run the whole Umbrel store

Status: §2–§4 are proposals (2026-10-12, Harbor 0.28.2); each needs the normal round before it ships (AGENTS.md §4):
tests first, a `docs/DECISIONS.md` row, docs, a release. §7 records the first real port (121 apps qualified, 0.28.4).

## 1. Why this document exists

The Umbrel store (`getumbrel/umbrel-apps`, commit `8c0026e`, 393 apps) is the largest catalog of
self-hosted apps already packaged as pinned Compose files. If Harbor can express what those files need,
porting stops being hand work and becomes a converter plus a VM qualification run (see §5). Every
feature below is ranked by how many Umbrel apps it unlocks, so the catalog grows fastest per feature built.

A classifier checked every app's `docker-compose.yml`, `umbrel-app.yml`, `exports.sh` and `hooks/`
against Harbor's Compose subset (`src/contracts/compose.schema.ts`) and manifest schema:

| Tier | Apps | Meaning |
|---|---|---|
| A: automatic | 140 | Fixed rewrite rules only (app_proxy → endpoint, `${APP_DATA_DIR}` → named volume, `APP_SEED` → generated secret, …) |
| B: automatic + review | 48 | The converter drafts the package; a person checks shell commands, links and Umbrel-made images |
| C: needs a Harbor feature | 91 | Blocked by something the format cannot express yet |
| D: blocked | 114 | 80 need the Bitcoin/Lightning stack; 34 need host networking, devices, privileged mode or capabilities |

**Today Harbor can take 188 of 393 apps (48%).** The other 205 need the features below.

Calibration: 11 of the 17 apps already in harbor-apps land in A or B. The other 6 (forgejo, immich,
jellyfin, nextcloud, vaultwarden, anything-llm) were ported by rewriting from upstream and dropping
the parts Harbor lacks, such as Forgejo's SSH port and Jellyfin's discovery port.

## 2. The feature set, in unlock order

Each row counts the apps that feature newly unlocks once the rows above it exist (greedy order over
tiers C and D). "Apps that use it" counts every C/D app that needs the feature at all.

| # | Feature | Apps that use it | Unlocks | Running total | Fits the current model? |
|---|---|---|---|---|---|
| 1 | Bitcoin/Lightning provider apps | 80 | 44 | 232 (59%) | Yes: catalog work plus shared files over links |
| 2 | Raw TCP/UDP endpoints | 70 | 27 | 259 (66%) | Yes: additive endpoint scheme |
| 3 | Package config files | 57 | 22 | 281 (72%) | Yes: additive |
| 4 | Init jobs (run-once services) | 47 | 29 | 310 (79%) | Yes: additive Compose value |
| 5 | Small runtime keys | 22 | 18 | 328 (83%) | Yes: additive Compose keys |
| 6 | `entrypoint` | 29 | 17 | 345 (88%) | Yes, but reverses part of decision 123 |
| 7 | Host networking | 30 | 9 | 354 (90%) | Only as an elevated permission (§3) |
| 8 | Devices, privileged, host paths | 20 | 11 | 365 (93%) | Only as an elevated permission (§3) |
| 9 | Added capabilities | 12 | 11 | 376 (96%) | Only as an elevated permission (§3) |
| 10 | Operator-edited env files | 9 | 9 | 385 (98%) | Yes: additive |
| 11 | Reaching the host (`host-gateway`) | 8 | 8 | 393 (100%) | Only as an elevated permission (§3) |

Features 1–6 keep Harbor's model intact and reach 88%. Features 7, 8, 9 and 11 make a package
able to escape its container, so they need the permission model in §3 before any of them ships.

### 2.1 Bitcoin/Lightning provider apps (80 apps use it, 44 unlocked)

**What Umbrel does.** `bitcoin`, `lightning` (LND), `core-lightning`, `electrs`, `fulcrum` and `mempool`
are ordinary apps that other apps declare under `dependencies:`. Consumers read the provider's RPC
address, credentials and files: LND's `tls.cert` and macaroons arrive as a read-only bind of
`${APP_LIGHTNING_NODE_DATA_DIR}`.

**Why it matters.** It is the largest block in the store (the whole `bitcoin` category: 88 apps, 72 of
them in D) and the reason most Umbrel users run Umbrel. No other feature moves the count as much.

**What Harbor needs.**
- The provider apps themselves in harbor-apps. They need feature 2 for P2P and RPC ports.
- Links (decision 126) already provide private networks and address bindings. They also need
  **shared files**: a provider declares a volume path it shares, read-only, with linked consumers
  (`links[].mounts` on the consumer, a `shares[]` claim on the provider). Ownership stays with the
  provider; the consumer gets a read-only mount and can never delete it.
- Credentials the consumer needs (RPC user/password) become a provider secret passed through the
  link binding. That is a new `format: secret` on link bindings, and the value never enters plans or DTOs.

**Risk.** Shared files are the first cross-app mount. They must stay read-only, and they need a test
proving that uninstalling the consumer never touches the provider's volume.

### 2.2 Raw TCP/UDP endpoints (70 apps, 27 unlocked)

**What Umbrel does.** `ports:` entries for traffic that is not HTTP: Git over SSH (forgejo, gitea,
gitlab, opengist), MQTT (mosquitto), SMB (samba, back-that-mac-up), P2P (transmission, syncthing,
bitcoin, kaspa), game and voice servers (teamspeak), syslog, media discovery (jellyfin UDP 7359).

**Why it matters.** Many popular apps have one non-HTTP port that defines them, and without it they
are only half there: Forgejo without SSH push, Syncthing without its sync port. Today the manifest
pins `scheme: http`.

**What Harbor needs.** Add endpoint `scheme: tcp | udp` (an optional new enum value) with an optional
`hostPort` the package asks for (well-known ports like 22, 445 or 1883 matter to clients) and Harbor's
allocator as the fallback. Raw endpoints get no proxy, no Open button (`kind: api` behavior) and no HTTP
health probe; health stays on an HTTP endpoint or moves to the Compose healthcheck. LAN mode opens
them in ufw like the app ports (decision 160). A port another app or the host already holds refuses
the install with a clear code; no guessing.

**Package format.** Optional `scheme` values and `hostPort` are additions. Apps using them declare
`release.minHarbor`.

### 2.3 Package config files (57 apps, 22 unlocked)

**What Umbrel does.** The app folder ships files that are bind-mounted into the container:
`nginx.conf`, `torrc`, `mosquitto.conf`, an `init.sql` for Postgres, or a pre-filled `data/config/` folder.

**Why it matters.** Many upstream images expect a config file and will not start without one. Today a
package author has to bake a custom image, which leaves the official-image + digest-pin model.

**What Harbor needs.** A `files[]` manifest block: a path inside the package, the volume it lands in,
the target path, and a mode: `seed` (copied once at install, then the app owns it) or `readOnly`
(Harbor-owned, refreshed on each update). The only substitution is `{{secret:<id>}}` placeholders,
filled at render time like decision 139 templates. Same path rules as the rest of the package: no
symlinks, no `..`, size-capped, covered by `release.json` hashes.

### 2.4 Init jobs (47 apps, 29 unlocked)

**What Umbrel does.** `hooks/pre-start` and `post-install` shell scripts run **on the host as root**.
Of 95 hooked apps, about half only chown, mkdir or run Umbrel's own version migrations (a fresh Harbor
install needs none of that). The rest generate config with `sed`, `jq`, `openssl`, or start containers in
order to bootstrap an app.

**Why it matters.** This is real app setup (generate a key pair, write a config from a template,
create a bucket) and there is no place for it today. Running host scripts would break the trust model,
but the same work fits in a container.

**What Harbor needs.** A run-once service: `deployment.services.<id>: job` (new optional role) plus
Compose `depends_on.condition: service_completed_successfully` (a new enum value Compose already
supports). The job runs inside its own container with the app's volumes, and dependents wait for it to
exit 0. A failed job fails the operation with its log tail, and it re-runs on every start, so jobs must
be idempotent (written in the package docs). This also replaces most `hooks.afterStart` needs.

### 2.5 Small runtime keys (22 apps, 18 unlocked)

**What Umbrel does.** `shm_size` (browsers, Postgres, Frigate), `ulimits` (nofile for databases and
crawlers), `tmpfs`, `read_only`, `working_dir`, `cpu_shares`.

**Why it matters.** These are tuning knobs, but without them the app crashes or misbehaves (Chromium
needs a large `/dev/shm`). Each is container-local and grants nothing on the host.

`cpu_shares` (only lower than normal), `cpus` and `mem_limit` are accepted since 0.47.0 (decision 205).

**What Harbor needs.** Optional Compose keys with bounds: `shm_size` ≤ 4 GiB, `ulimits` only `nofile` and
`nproc` (bounded), `tmpfs` (container paths only, size required), `read_only`, `working_dir` (absolute
container path). Add two more for fidelity even though they block nothing:

- **`user`.** 205 apps set it. The converter drops it today, which works with named volumes but runs
  some apps as root. Harbor already accepts a user on `hooks.afterStart`.
- **`stop_grace_period`** (182 apps). Databases such as Bitcoin Core and Postgres need longer than
  Docker's 10 s to shut down cleanly, so dropping it risks corruption on stop and update.

### 2.6 `entrypoint` (29 apps, 17 unlocked)

**What Umbrel does.** It overrides the image entrypoint, usually with `["/bin/sh", "-c"]` so a shell
script can run, or with a script shipped as a config file.

**Why it matters.** `command` alone cannot replace an image's ENTRYPOINT. Decision 123's own reasoning
applies: it runs inside the container with the rights the container already has, and a git-sourced
package could bake it into a Dockerfile anyway.

**What Harbor needs.** Allow `entrypoint` as a literal argument array, with the same rules as `command`
(decision 123): no string form, dollars literal. Needs a new decision row that narrows the "stays
forbidden" part of decision 123.

**Less urgent than it looks.** Checked against each image's own ENTRYPOINT (read by digest from the registry),
20 of the 33 overriding services need no `entrypoint` at all: the image has none (the override moves into
`command`), the override repeats the image's binary, or the image's wrapper runs any command it is given
(postgres, nginx, memcached, tini). 4 are Umbrel-only migration hooks, 7 are Docker-in-Docker (blocked by §3
anyway). About 6 really need it; some of those have another way (ntfy: `command: [serve]` plus
`provisionedCredentials` and `hooks.afterStart` for the admin user).

### 2.7 Operator-edited env files (9 apps, 9 unlocked)

**What Umbrel does.** `env_file: ${APP_DATA_DIR}/settings.env` that the user edits afterwards (librechat,
outline, plane, lobe-chat, karakeep): API keys, OAuth and SMTP settings.

**Why it matters.** These apps are configured only through environment variables, so without this the
operator cannot set them up.

**What Harbor needs.** A manifest `settings[]` block (key, prompt, secret or not, default) shown in the
console as an "App settings" form. Applying changes runs a reconfigure plan → operation, which is the
same idea as operator secrets (decision 125) but editable after install. No raw env file on disk.

**Built in 0.34.0** for the non-secret half (decision 180, docs/design/LOCAL_AI.md part 2): typed `settings:`
(integer, number, boolean, string, choice) with defaults, the install review's *Options*, the app page's
*Settings → Change…* → a `configure` plan, `--set` on the CLI. Secret values (API keys, SMTP passwords) stay
operator-provided secrets (decision 125), which configure can already replace after install.

## 3. Elevated permissions (features 7, 8, 9, 11)

These four break the rule that a package stays inside its container:

| Feature | Apps | Typical use |
|---|---|---|
| Host networking | 30 | DNS servers (pi-hole, adguard, technitium), discovery (home-assistant, homebridge, plex, matter), VPNs |
| Devices / privileged / host paths | 20 | Zigbee/USB sticks, `/dev/dri` transcoding, Docker-in-Docker (arcane, dockge, komodo, onedev), `/run/dbus` |
| Added capabilities | 12 | `NET_ADMIN` for VPNs and DNS (tailscale, wireguard, netbird), `SYS_ADMIN` for Chromium sandboxes |
| Host gateway | 8 | Reaching services on the host (Ollama, cloudflared to local apps) |

**Why they matter anyway.** These are flagship apps: Home Assistant, Pi-hole, Plex, Tailscale and
WireGuard are among the main reasons people buy a home server. A store without them reads as incomplete.

**Why they cannot be plain fields.** Unknown keys are refused because the Compose subset is a security
boundary (AGENTS.md §4.2, decision 123). A package with `privileged: true` owns the machine.

**Proposed model.**
- A manifest `permissions[]` list with fixed values: `host-network`, `device:<class>` (an allowlist:
  `usb-serial` by-id, `dri`, `hidraw`), `capability:<name>` (allowlist: `NET_ADMIN`, `NET_RAW`,
  `SYS_ADMIN`), `host-gateway`, `docker` (Docker-in-Docker, implies privileged).
- Raw Compose keys stay refused. Harbor renders the right Compose keys from the permission, so the
  package can never ask for more than the allowlist.
- Every permission appears in the install plan review in plain words ("Can see every device on your
  network"), and the operator must tick it before approving. An update that adds a permission needs
  approval again and is never automatic.
- Host-network apps get no Harbor port allocation; their endpoint names a fixed host port, and a
  conflict refuses the install.
- Official-catalog CI flags any package that requests a permission, so a reviewer looks at it on purpose.
- GPU fits here as `device:dri` (14 apps run CPU-only today: immich, frigate, jellyfin, ollama). **Built in 0.34.0** as
  the `gpu` permission (decision 179, docs/design/LOCAL_AI.md): NVIDIA through the container toolkit, Intel/AMD
  through `/dev/dri`, CPU otherwise. Umbrel's `devices: [/dev/dri]` maps to `permissions: {<service>: [gpu]}`.

This needs its own design round and decision row before any code: it is the largest change to
Harbor's trust model since the catalog split.

## 4. Deliberately left out

- **Tor hidden services.** 16 Umbrel apps ship a Tor sidecar for remote access. Harbor's remote access
  is Tailscale and public HTTPS, so the converter drops the sidecar. Only a `torOnly` app would need
  Tor, and there are none today.
- **Umbrel-made images** (`getumbrel/*`, 32 apps), such as `media-app-configurator` (auto-wires the
  \*arr apps) and `umbrel-bitcoin`. These are Umbrel's code, not upstream projects. Use the upstream image
  or rebuild the function from Harbor links.
- **Umbrel's upgrade hooks.** They migrate old Umbrel installs, which a new Harbor install never has.

## 5. With these features, the port becomes deterministic

The converter exists: `scripts/umbrel-import.mjs` (§7). It maps Umbrel files to Harbor packages with fixed rules
and refuses an app outright when any part has no exact equivalent. Only one step is empirical, and Harbor
already measures it:

1. Convert: Umbrel files → `manifest.yaml` + `compose.yaml` + a report of everything dropped.
2. `node scripts/catalog-pin.mjs <id>` → `pnpm catalog:hash <id>` → `pnpm catalog:verify`.
3. `scripts/vm/qualify-catalog.mjs` on a droplet: install, probe the health path, record the real
   status codes and start time, write `health`.
4. Commit only packages that pass. Failures go to manual review with the log.

The health path and whether an app still runs without Umbrel's `user:` cannot be known from the files,
so step 3 is required for every app. At about 190 apps (345 once features 1–6 ship), droplet time is a
real cost: qualify in batches.

**License.** `umbrel-apps` has no license file, so its contents are all rights reserved by default.
Use the converter only to draft our own packages. Take descriptions, icons and screenshots from the
upstream projects, never from Umbrel's gallery.

## 6. Suggested order

| Release | Features | Store coverage after |
|---|---|---|
| next | 5 small runtime keys (+ `user`, `stop_grace_period`), 6 `entrypoint` | converter-ready for A/B (188) |
| +1 | 2 raw TCP/UDP endpoints, 3 config files, 4 init jobs | about 72–79% |
| +2 | 1 provider apps + shared files over links (catalog work in harbor-apps) | about 88% |
| +3 | §3 elevated permissions (own design round first) | 100% expressible |

Building feature 1 first gives the biggest single jump (+44), but it depends on features 2–4 for the
provider apps themselves, so it comes after them. "100% expressible" does not mean all 393 apps
qualified: the VM run decides that, one app at a time.

## 7. The first port (2026-10-12, Harbor 0.28.4)

`scripts/umbrel-import.mjs --umbrel <umbrel-apps checkout>` drafted every app that maps 1:1: 130 of 393
(the other 246 refused with a reason, 17 already in harbor-apps). Pinned with `catalog-pin --keep-digest`
(the image Umbrel tested, not whatever the tag points to now) through `HARBOR_DOCKERHUB_MIRROR=mirror.gcr.io`
and `HARBOR_DOCKERHUB_LOGIN=1` (anonymous Docker Hub allows a few manifest reads an hour). Qualified with
`qualify-catalog.mjs` on 15 droplets in parallel (`HARBOR_QUALIFY_SOCKS_PORT`: each run reaches its box through
its own SSH SOCKS proxy, so no two runs need the same local ports).

| Result | Apps |
|---|---|
| Qualified (`passed`) | 121 |
| Image gone or private (file-drop, l-town, sikka, simple-torrent) | 4, removed |
| Dead upstream: libreddit (Reddit closed the API it reads; `/r/popular` 404) | 1, removed |
| Still blocked, need a Harbor feature (below) | 3 (bitboard, trilium-notes, kokoro) |
| Waiting on codeberg.org (503 while pinning) | 1 (readeck) |

What the port taught us:

- **Umbrel never acts on Docker health; Harbor waits for it.** Umbrel packages carry checks that cannot pass
  (blinko runs a `curl` the image lacks, networkingtoolbox calls `localhost` which resolves to IPv6 while the app
  listens on IPv4, guacd's image check first runs after 5 minutes) and nobody notices, because nothing waits.
  Harbor starts apps with `compose up --wait`, so each was a failed install. The converter keeps a check only
  where another service waits for it (`service_healthy`) and switches off every other one with
  `healthcheck: {disable: true}` (decision 162, new in 0.28.4), the image's own check included. 38 apps carry it
  and declare `release.minHarbor: "0.28.4"`.
- **A Harbor bug, found by metube:** the drive guard's `.harbor-bind.json` was written `0600` (harbor.service's
  `UMask=0077` overrode the intended `0644`), so an app that chowns its bound folder at start (metube, every
  linuxserver image with PUID) hid the marker from Harbor and the guard stopped the app. Fixed in 0.28.4.
- **Another, found by the parallel run:** `harbor --json …` piped into another program stopped at 65,536 bytes
  (`process.exit` right after the write); a 142-app catalog crossed it. Fixed in 0.28.4.
- **Two features still missing** (the 3 blocked apps):
  - *Initial owner of a new, empty volume* (trilium-notes, bitboard): Umbrel creates every data folder owned by
    uid 1000, so images that run as 1000 and do not create their data dir in the image can write there. A fresh
    Harbor volume belongs to root, and the app fails with `EACCES mkdir /data`. Proposal: `storage[].owner:
    "1000:1000"`, applied once when Harbor creates an empty volume (never to operator folders, never later).
    Needs a decision against AGENTS.md §3.4 ("never chowns").
  - *A UI path* (kokoro): its page lives at `/web/`; `/` answers 404. Umbrel's `path:` field. Proposal:
    `ui.path` (where Open goes; the health check can use the same path).

## 8. The VPN pack (Harbor 0.29.0, decision 163)

The first slice of §2.2 (raw ports) and §3 (permissions), cut to what VPN servers need:

- **`ports:`** in the manifest: a fixed UDP host port published on every interface. Its own block (not an
  endpoint scheme), so nothing that assumes HTTP sees it. Single-instance apps only; the plan refuses a port in
  Harbor's range, held by another app, published by Docker or bound on the host.
- **`permissions:`** per service, from `net-admin`, `tun`, `ip-forwarding` only. Harbor renders `cap_add`,
  `devices` and namespaced `net.*` sysctls itself; compose keeps refusing those keys. The review lists them in
  plain words and Install waits for a checkbox (`--accept-permissions` in the CLI). An update that adds one is
  never applied by update-all or auto-update.
- **WireGuard** (wg-easy 15.3.0) in harbor-apps: `ports.wireguard` UDP 51820, `permissions: [net-admin,
  ip-forwarding]`. Umbrel's `SYS_MODULE` + `/lib/modules` are left out (Ubuntu 24.04 loads the module on demand),
  so the package sets `DISABLE_IPV6: "true"`: wg-easy's IPv6 rules need `ip6table_nat`, which only `SYS_MODULE` could
  load. Live: qualified, and a real tunnel from a second droplet (VERIFICATION 3u).

Not yet: raw TCP ports (Git over SSH, MQTT), host networking, devices beyond `/dev/net/tun` and the graphics card
(`gpu`, 0.34.0, decision 179), Docker-in-Docker.

**OpenVPN is parked** (checked 2026-10-12; WireGuard covers the use for now):
- *openvpn-ui* (d3vilh, MIT, has a login) is the candidate. Its UI uses the Docker socket only for its two Restart
  buttons (`build/assets/restart.sh`), so it can run without the socket. But the server image (d3vilh/openvpn-server)
  ships no config (`server.conf` and `config/easy-rsa.vars` are expected from host mounts), and its shell-form
  ENTRYPOINT runs `sysctl -p` under `set -e`, which fails on the read-only `/proc/sys` of an unprivileged container.
  It needs package config files (§2.3) and `entrypoint` (§2.6).
- *ovpn-admin* (Palark, Apache-2.0): its admin page has no login, so in LAN mode anyone on the network could create
  VPN users. Not packageable until Harbor can put a login in front of a LAN address.
- *kylemanna/openvpn*: no web page (clients are made with `docker exec`), so first run is not finishable in a browser.
