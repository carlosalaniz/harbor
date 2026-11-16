# Future context: Nextcloud with a document server (not implemented)

TDD.md section 14 describes a later goal: installing Nextcloud together with a browser document
server (ONLYOFFICE Docs or Collabora Online). **Nothing of it is implemented, provisioned or
claimed in this release**, and no catalog entry, schema field, proxy or provider infrastructure was
added for it. This note records how the current code already leaves room for it, and what remains.

## What the current implementation already provides

| Property (TDD 14.3) | Where it holds today |
|---|---|
| Instance identity distinct from product name; resources owned per instance | `instances.id` (UUID) → project `hb_<uuid>`; every container/volume/network carries `io.harbor.preview/instance`. Two n8n instances have separate volumes and keys. |
| Multiple services, declared volumes, named endpoints per package | Manifest `deployment.services`, `storage[]`, `endpoints{}` are maps keyed by ID; n8n already has two services and two volumes. No one-container/one-port assumption in the engine. |
| Browser URLs separate from container/host targets | State stores `hostPort`; `browserUrlFor()` in `src/config.ts` is the only place that renders `http://localhost:<port>/`. Readiness probes `127.0.0.1:<hostPort>`. A future proxy changes that one rendering/access function, not packages. |
| Secrets referenced by instance + secret ID | `secrets/<id>` files under the instance directory; bindings are manifest data. No global "office password" concept exists. |
| Validation/rendering separate from lifecycle I/O | `src/packages/*` and `src/planner/*` are pure; only `src/docker/*` and `src/lifecycle/runner.ts` perform I/O. |
| Readiness distinct from user setup | `installState`/`readiness` vs. the manifest `setup` guidance shown separately in UI/CLI. A landing page answering HTTP is never treated as "integration works". |

## What a future integration would still need (deliberately not built)

1. **Deployment relationship choice** per TDD 14.1: bundled office service inside one instance
   (preferred first), explicit binding between instances (only if sharing is really needed), or
   AIO delegated management through the parent's interface. Each is a package/schema extension
   with its own tests; none exists now.
2. **Routing**: browser-reachable URLs for Nextcloud *and* the office server, with HTTPS as the
   connectors require. Loopback `http://localhost:<port>` is the only exposure policy in this release.
3. **Server-to-server URLs**: the office service must fetch documents from Nextcloud and call back
   to save; inside a container `localhost` is the container itself. Internal targets must be
   authorized explicitly (no global SSRF-protection disable), and TLS verification kept.
4. **Connector configuration and credentials**: JWT/shared secret scoped to the relationship,
   configured through a supported Nextcloud API/occ step with stable IDs and postcondition checks
   (no blind re-creation).
5. **Integration verification**: log in, upload a synthetic document, open, edit, save, reopen and
   check the change. Only that counts as "working"; the UI must show setup-required/degraded
   separately from container health.

App data backups exist since 0.26 (decisions 149–154, `docs/design/BACKUPS.md`): encrypted restic
restore points of every encrypted app, fanned out to installable places; what is still future is listed
under "Backups: later" below.

## Context-only architecture check (plan.md §11), performed 2026-09-14

Reviewed the implementation against the four points; no code change was needed.

1. **Services/volumes/endpoints are package data keyed by identity** — `src/planner/render.ts` iterates `compose.services`, `manifest.storage[]` and `manifest.endpoints{}`; the runner records resources per `(instanceId, kind, role)` (`resources` table). There is no "web container" assumption; n8n's two services already flow through it.
2. **Browser URLs are distinct from internal targets** — state holds `hostPort`; `browserUrlFor()` (`src/config.ts`) is the single rendering point used by DTOs and the `configuration` binding; readiness targets `127.0.0.1:<hostPort>` (`src/lifecycle/readiness.ts`). A proxy would change that function and the access policy, not packages.
3. **Instance-owned removal and instance-scoped secrets do not assume unique product names** — every Docker resource is matched by `io.harbor.preview/instance=<uuid>` before mutation (`src/lifecycle/runner.ts`), volumes carry per-instance ownership tokens, secrets live under `instances/<uuid>/secrets/`. Two n8n instances coexist with distinct keys (live evidence A11).
4. **Runtime/readiness is distinct from setup** — `installState`/`readiness` come only from container state and the HTTP probe; the manifest `setup` block renders as separate guidance in `InstanceDetail.setup` and the UI ("Harbor did not create any account in this application").

## Catalog and storage follow-ups (recorded 2026-09-14)

- **Several catalogs** (community or third-party): not built. There is one
  official catalog (harbor-apps, decision 158) with one URL; operators add their own apps as uploads or
  git sources.
- **Umbrel catalog converter**: translate `umbrel-app.yml` + Compose into Harbor packages (bind
  mounts → storage claims, `APP_DATA_DIR` → managed volumes, `app_proxy` → endpoint). Roughly a third
  of Umbrel's apps fit the current subset; each still needs a live qualification.
- **Compose subset extension** (reviewed, small): `command`, `init`, `cap_drop`, `security_opt`
  would unlock OpenClaw and a few others without weakening the trust model (they only *drop*
  privileges). `extra_hosts: host.docker.internal:host-gateway` needs a decision (it exposes the host).
- **One-time credential at install**: reuse the exposure flow's "shown once" credential for apps that
  create their admin from an environment variable (Paperless-ngx, Linkding, code-server).
- **Scheme-dependent configuration** (`format: if-https`, or a template) for Collabora's
  `ssl.termination` and similar switches.
- **Storage inventory**: sizes of managed volumes per app (the Storage page lists disks and folders; volume sizes need `docker system df` plumbing). Full uninstall shipped in v0.4.0.
- **App updates**: shipped in v0.6.0 (update plans with automatic rollback; opt-in auto-updates
  in v0.9.0). A new package revision is offered as an Update, not a manual reinstall.
- **Cross-app links**: AnythingLLM could use the Ollama bundled with Open WebUI if instances could
  address each other; today every package is its own private network.

## Umbrel features reviewed on 2026-09-15 (v0.7.0)

Adopted since: terminal, troubleshoot/logs, two-factor login, device name (Settings), plus earlier rounds' wallpapers,
launcher arranging, updates, own apps, notifications, git sources, Home widgets, persistent login.
Not adopted, on purpose: a files app (a large product on its own; Nextcloud covers it), factory reset (destructive;
`harbor purge` per app exists), external disk formatting/mounting (TDD exclusion; the folder picker sees mounted
disks), migration assistant, language settings.

## External disk management for advanced users (recorded 2026-09-16, partially unblocked 2026-09-20)

Harbor should HELP mount, format and partition EXTERNAL devices (never the system disk, never
implicitly). Bring-your-own-folder stays mount-only; this is a separate advanced flow behind the
Advanced tools acknowledgement. **Update 2026-09-20: the mount half is now built and the hardware
blocker is gone** — a physical Ubuntu box (home-server) with a USB stick is available, and
decision 88 ships enumerate + mount/unmount at `/mnt/<label>` with insert/remove notifications,
missing-folder warnings, and the `.harbor-bind.json` marker; decisions 89–90 add the drive guard
(app-generated identity, auto-stop, adopt), auto-mount on insert and auto-start on return
(policy toggles, both default on); decision 93 ships format-as-ext4 in place
(`POST /v1/host/devices/:name/format`, root `wipefs + mkfs.ext4`, typed confirm,
refused while an app uses the drive). What remains future: **partition, LUKS, SMART**
(still no UI, still no code path).

- Abstraction: **udisks2 over D-Bus** (standard on Ubuntu; enumerate, GPT partition, format
  ext4/exFAT/NTFS/Btrfs, mount, LUKS, SMART — one API; GNOME Disks and Cockpit use it; Node via
  `dbus-next`). Fallback/detection via **util-linux** (`lsblk --json`, `blkid`, `wipefs`,
  `mkfs.*`). Reference implementation: **Cockpit `cockpit-storaged`**; simplest path may be a
  deep link to Cockpit Storage rather than duplicating UI. OpenMediaVault/Rockstor are reference
  only (too opinionated to embed).
- Scope: removable/external disks allowlist only (never root disk), preview + typed confirmation,
  privileged work through the existing root-oneshot pattern (`harbor-tools-install@`-style unit +
  polkit). Test plan needs real USB/SATA hardware: enumerate, partition, format each filesystem,
  mount, bind into an app, reboot persistence, refusal cases (system disk, mounted root).

## Encryption follow-ups (recorded 2026-09-22, after decisions 103–104)

- **Unlock without a login (keyfile/TPM).** Today every sealed app is locked — and down — after a
  reboot until the first console login (the machine key is sealed under the login password, by
  design). A 1.0 item: an optional TPM-bound or keyfile-on-USB unseal of the machine key at boot
  for headless boxes, with the trade-off spelled out (a stolen box then boots into AFU).
- **Sealed instance secrets.** App-generated instance secrets and provisioned app logins live in
  plaintext under `/var/lib/harbor/instances/<id>/secrets` (0600; SECURITY.md calls this out).
  They could move into the app's sealed home so a locked app hides its database password too;
  needs the runner to read them only while AFU and a migration for existing instances.
- **Scrubbing after in-place migration.** Sealing a pre-beta.2 home copies the data into a fresh
  sealed dir and deletes the plaintext copy; the old blocks are not scrubbed (SSD/ext4 make
  `shred` unreliable). New installs seal before any data exists, which is the real fix.


## Backups: later (recorded 2026-10-10, after decisions 149–154)

- **Harbor-to-Harbor backups.** Sending = a `rest` target package (the transport exists). Receiving = a
  built-in system feature, off by default, enable/disable and never uninstall (that would destroy
  friends' data): restic rest-server, append-only, one private space and quota per friend, pairing
  codes, reachable over the tailnet or public HTTPS. Open questions: pruning under append-only (a
  host-approved cleanup window), per-friend quotas (rest-server's limit is per server).
- **Restore as a copy** (a second instance from a restore point, next to the running one).
- **Backing up operator folders** (bind claims) opt-in per claim, read-only, never restored over.
- **A local staging pass** while an app is paused, then shipping to every place after it runs again —
  only if several slow places ever make the pause too long.

## Graphics cards: later (recorded 2026-10-13, after decision 179)

- **AMD ROCm.** Ollama's AMD build needs `/dev/kfd` + `/dev/dri` and a different image (`ollama/ollama:rocm`). The image is
  the package's choice, so this needs per-host image variants in the package format (an image per GPU kind) before
  Harbor can render it. Intel/AMD graphics through `/dev/dri` (Vulkan/VA-API) work today.
- **Choosing one card** when a machine has several (today an app gets every NVIDIA card, `count: all`), and handing
  different cards to different apps.
- **Sharing limits** (memory or time slices per app); NVIDIA MIG/MPS.
- **Installing the NVIDIA container toolkit from Harbor** (`harbor-bootstrap --with-nvidia`), see docs/TODO.md.
- **A per-package minimum NVIDIA driver** (decision 181): an optional field for images that need CUDA 12 or newer, so
  their review says "this app cannot use the card" instead of the generic below-525 note. Until then the note is
  engine-wide and the card is still handed over.
- **Installing, updating or removing the NVIDIA driver: never** (decision 181). Harbor only checks it (no driver
  running, an update waiting for a reboot, older than 525) and names `sudo ubuntu-drivers install` + a restart: drivers
  are kernel modules (DKMS, Secure Boot keys, reboots) and the card may drive the desktop. Even a future
  `--with-nvidia` would install the container toolkit only, never a driver.

## App settings: later (recorded 2026-10-14, after decision 180)

- **Settings that pick an image** (a CUDA or ROCm variant), or reach `command`, volumes or ports. v1 settings are
  environment literals only.
- **Settings shown only when another one is set** (an SMTP block behind "Send email"), groups and ordering hints.
- **Restarting only the service a setting binds** without a plan per service: `compose up` already recreates only the
  services whose environment changed.
- **Settings that are secrets** (a typed password shown as a setting): those stay operator-provided secrets
  (decision 125).

## VPN and offline apps: later (recorded 2026-10-20, after decisions 184–185)

- **OpenVPN, several tunnels, a tunnel per app.** One WireGuard tunnel covers what providers offer; several would need
  a table and mark per tunnel and a picker per app.
- **Exceptions under "every app through the VPN".** Carlos asked for "everything"; an exception list is a later switch.
- **The host itself through the VPN.** It would cut Tailscale, Let's Encrypt and Harbor's own updates.
- **VPN apps reaching tailnet peers** (tailnet addresses route into the tunnel today) and **port forwarding** through
  the VPN provider.
- **Hosts an offline app may still reach** (`network.allow` next to `network.internet`), e.g. one update server.
- **IPv6 inside app networks.** Harbor's app networks are IPv4 only; a non-direct app on one with an IPv6 subnet is
  refused.

## Blockchain nodes: later (recorded 2026-10-23, carlosalaniz/harbor#2)

A contributor asked whether Bitcoin and Ethereum nodes belong in the App Store. The direction: **yes, one step at a
time, starting with a pruned Bitcoin Core that opens no inbound port**, which fits today's package format (settings,
storage on a chosen location, an RPC health path) and needs no engine change. Not built, and not promised:

- **Inbound peer ports** (8333/tcp, 30303 tcp+udp, 9000): manifest `ports:` is UDP-only (decision 163). A `tcp` value
  would be an optional format addition under the same rules (single instance, accepted in the plan, a plain note that
  it only matters with a router port-forward). Only once a package needs it.
- **Hard-fork deadlines**: an Ethereum client that misses a fork release stops following the chain. Ideas: a catalog
  field like `release.updateBy` that raises a notification as the date nears, or auto-update suggested for such
  packages. Needed before an Ethereum execution + consensus pair (a `links:` pair sharing a JWT), not for Bitcoin.
- **Size**: an install plan that shows expected size and checks free space on the chosen location would help every
  large app, not just nodes (an engine feature, not a per-app branch).
- **Sync progress**: a package-declared status probe ("syncing 63%") reusing the readiness machinery.
- **Encryption cost**: measure a chain's initial sync on a sealed home (AES-NI makes fscrypt cheap on most x86-64)
  before designing any opt-out; decision 103's rule stands (never call plaintext encrypted).
- **Validators and staking keys are a non-goal**: slashing risk and liveness duties do not fit a single-admin
  beta manager; no validator client goes into the official catalog.

## CPU and memory: later (recorded 2026-11-16, after decision 205)

- A host-wide reserve (keep N cores for interactive apps) and a host default (background services low unless the
  package says otherwise). Per-app priority covers the case reported in issue #7; asked and deferred.
- Per-service choices from the app page (the operator's choice applies to every service of the app today; packages can
  already differ per service).
- A combined limit for a whole app (one cgroup parent for all its containers) instead of one limit per service.
