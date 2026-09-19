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

Backups remain configuration and Harbor-owned recovery secrets only; Nextcloud files, databases and
documents stay the application's/administrator's responsibility.

## Context-only architecture check (plan.md §11), performed 2026-09-14

Reviewed the implementation against the four points; no code change was needed.

1. **Services/volumes/endpoints are package data keyed by identity** — `src/planner/render.ts` iterates `compose.services`, `manifest.storage[]` and `manifest.endpoints{}`; the runner records resources per `(instanceId, kind, role)` (`resources` table). There is no "web container" assumption; n8n's two services already flow through it.
2. **Browser URLs are distinct from internal targets** — state holds `hostPort`; `browserUrlFor()` (`src/config.ts`) is the single rendering point used by DTOs and the `configuration` binding; readiness targets `127.0.0.1:<hostPort>` (`src/lifecycle/readiness.ts`). A proxy would change that function and the access policy, not packages.
3. **Instance-owned removal and instance-scoped secrets do not assume unique product names** — every Docker resource is matched by `io.harbor.preview/instance=<uuid>` before mutation (`src/lifecycle/runner.ts`), volumes carry per-instance ownership tokens, secrets live under `instances/<uuid>/secrets/`. Two n8n instances coexist with distinct keys (live evidence A11).
4. **Runtime/readiness is distinct from setup** — `installState`/`readiness` come only from container state and the HTTP probe; the manifest `setup` block renders as separate guidance in `InstanceDetail.setup` and the UI ("Harbor did not create any account in this application").

## Catalog and storage follow-ups (recorded 2026-09-14)

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
blocker is gone** — a physical Ubuntu box (carlos-desktop) with a USB stick is available, and
decision 88 ships enumerate + mount/unmount at `/mnt/<label>` with insert/remove notifications,
missing-folder warnings, and the `.harbor-bind.json` marker. What remains future: **partition,
format, LUKS, SMART** (still no UI, still no formatting code path).

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
