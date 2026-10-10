# Design: app backups (encrypted, incremental, fanned out)

**Status:** built in 0.26.0, §1–§9 (decisions 149–154). §10 (database dumps), uploaded target
packages, Google Drive/MEGA packages and the Harbor-to-Harbor host are later batches
(`docs/TODO.md`, `docs/FUTURE.md`).

Code: `src/backups/` (restic.ts builders/parsers, step.ts root contract, engine.ts root + fake,
targets.ts, schedule.ts, service.ts), `src/bootstrap/backup-apply.ts` (root), `backup-tools.ts`,
runner kinds `backup`/`restore`, `web/src/app/pages/Backups.tsx`, `harbor backup …` / `harbor restore`.

## 1. What a backup is

A **restore point of one app**: everything needed to bring that app back on this or another Harbor,
exactly as it was at that moment.

| Part | Where it lives on the machine | Why it travels |
|---|---|---|
| the app home's `manifest.json` | `<drive>/harbor-apps/<package>/<name>/` | identity + the key envelopes (Harbor card, own passphrase) |
| the app's data | `<home>/volumes/` (read through the unlocked fscrypt view) | the point of it |
| a state slice `harbor-app/` | written by the root step to tmpfs `/run/harbor-backup/stage/<app>/<place>/` for the length of one pass: `instance.json`, `home-manifest.json`, `app-key`, `secrets/`, `release/` | homes carry no secrets: a restored database needs the passwords it was created with, the release it ran, and the key its home is sealed with |

Only **sealed-home apps** are backed up (the default since 0.17). An app still on plain Docker volumes
is offered "Encrypt it first" (`harbor seal`, decision 142). Folders of the operator's own (`bind`
claims) are **not** included: Harbor never owns them, and the UI says so.

## 2. Engine: restic (+ rclone as a transport)

Harbor does not implement chunking, dedup or crypto. **restic** (pinned 0.19.1, sha256-checked) does:

- content-defined chunking + dedup → each run uploads only new chunks (a changed 8 KB database page
  costs ~1 MB, not the whole file); every snapshot is a complete recipe, no chain to replay;
- client-side encryption (AES-256 + Poly1305; keys scrypt-wrapped in the repository);
- snapshots (restore points), `forget --prune` (retention), `check` (verification), several keys per
  repository.

**rclone** (pinned 1.75.2) is only a transport for clouds restic cannot reach itself (v1: Proton
Drive). Binaries live in `/usr/local/lib/harbor/bin/` (root-owned, installed by bootstrap, never in
the harbor-writable state dir: root runs them).

The repository format is documented and has a second implementation (rustic): a Harbor backup is a
standard restic repository whose password is your Harbor recovery card (§4). Nothing is locked in.

## 3. Targets (installable, data-only packages)

A target package is a **form plus a transport word**. Bundled under `targets/<id>/manifest.yaml`:

```yaml
apiVersion: harbor/v1alpha1
kind: BackupTarget
metadata: { id: s3, name: S3-compatible storage, description: "…", status: stable }
release: { revision: "1" }
transport: s3                 # local | s3 | sftp | rclone | rest
fields:
  - { id: endpoint, label: Endpoint, type: text, required: true, hint: s3.us-west-002.backblazeb2.com }
  - { id: secretAccessKey, label: Secret access key, type: secret, required: true }
```

- `transport` picks built-in code; the package can carry **no code** (backups run as root and see every
  app's plaintext, so a package that shipped a script would be a root shell). For `local | s3 | sftp |
  rest` the field ids are fixed by the transport; for `rclone` each field names its rclone option
  (`rclone: password`) and the package names the backend (`rclone: { backend: protondrive }`).
- v1 ships **Another disk** (`local`: a folder under `/mnt`, `/media` or `/srv/harbor/backups`, never
  inside a `harbor-apps` tree), **S3-compatible** (`s3`), **SFTP** (`sftp`: Harbor's own key, the server
  key pinned at the first test), **Proton Drive** (`rclone`, beta: rclone's Proton backend is
  unofficial; the 2FA code is needed once, rclone keeps the session in root-only state).
- **Install** = Settings → Backups → Add a place → fill the form → *Test connection* (Harbor reads the
  repository: empty / ours / another Harbor's). Several installs of the same package are fine
  ("B2 – home", "B2 – office"). Secrets live in the `settings` table like notification channels,
  masked `••••` on read, never in DTOs or logs.
- **Uninstall** removes the target from every app's policy and forgets its credentials. The
  backups stored there are **kept** unless the operator ticks "also delete the backups there" and
  types the target's name. Harbor never deletes remote data on its own.
- Targets are settings, not plans: nothing touches Docker (same as notification channels).

## 4. Keys: the host never sees plaintext

**One restic repository per installed target**, holding every app (snapshots tagged `app:<instanceId>`).
Two keys are added at `init`:

1. **the backup key**: 32 random bytes, stored only machine-wrapped (`backups.key`, like the
   recovery card). Scheduled runs use it, so they need the machine key (after the first login).
2. **the Harbor recovery card**: the 12 words, normalized (lowercase, single spaces). One paper opens
   every backup of this Harbor, on any machine, even with plain `restic`.

Rotating the card (`POST /v1/account/recovery-key`) re-keys every target on its next run: add the new
card, remove the old one. What the host learns: sizes and timing of uploads. Nothing else.

**The app key travels inside the snapshot** (`app-key` in the state slice). Whoever opens the
repository already reads the app's data in clear, so this adds no exposure, and a restore never depends
on which card was current when the backup was made. The slice reaches the root step through the
secrets FIFO and lives in tmpfs only; it never touches a disk outside the encrypted repository.

**Another Harbor's backups.** Installing a target whose repository does not open with our key shows
"Backups of another Harbor are here". Typing that Harbor's recovery card adds our own backup key and
our own card to it. This is the new-machine restore path.

## 5. Policy and schedule

- **Global** (Settings → Backups): window start (`02:00`, local time), cadence (daily, or weekly on a
  weekday), **max downtime per app** (default 5 min), retention (7 daily, 4 weekly, 6 monthly).
- **Per app** (drawer → Backups): on/off, which targets (fan-out), optional own window/cadence.
- **Sequential**: one app at a time, in window order. Only the app in its cold pass is ever down.

## 6. One run (consistency A: stop-copy with warm passes)

```
warm pass (app running, all targets in parallel, outside the queue)   ← the slow part
  repeat while the last pass added more than fits the cap (max 3)
backup operation (serial queue, actor `scheduler`):
  stop the app (desired stays running) → cold pass to every target in parallel → start + readiness
  the cold pass is killed at the cap → the app starts again, the run is "too busy", notification
```

- Cold-pass time ≈ re-reading the files changed since the last warm pass + uploading their new chunks.
  For a 100 GB Postgres that is seconds to a minute on a home uplink; size does not matter, churn does.
- An app the operator stopped is backed up with one pass (it is already consistent).
- A locked app (before the first login, or a custom passphrase not unlocked this boot) is skipped
  with a notification; so are apps whose drive is missing.
- Warm passes are read-only (no Docker, no state mutation) and run as their own root step; that is why
  they may run outside the queue. The cold pass is a mutation (stop/start), so it is an operation.
- Fan-out: the same run id is tagged on every target; the console groups them into one restore point
  ("on 2 of 3 places"). A target that failed is retried on the next run; the others still count.

## 7. Restore

- **In place** (drawer → Backups → a restore point → Restore): operation `restore`: stop and delete the
  containers → rename the home to `<home>.before-restore-<ts>` → create a fresh home with the same
  manifest, seal it with the same key → root restores the data into the sealed dir → state slice
  (secrets, release) back → render + start + readiness. Any failure renames the old home back and
  starts it. The previous copy is kept until the operator deletes it from the drawer.
- **On a new machine**: install the same target → card → Settings → Backups → *Restore apps from here*
  lists the apps found there → pick one and a location → `POST /v1/backups/restore` returns an
  **install plan** (same instance id, fresh ports). The runner creates the home from the restore point
  (manifest, sealed with the app key, data restored by root, secrets put back), stamps this Harbor's
  card, and the install continues like an adopt, keeping the restored secrets. The package must exist
  here (bundled, or re-uploaded first); it runs the revision this Harbor has.

## 8. Root step `harbor-backup@<requestId>`

Same handoff as `harbor-app-crypto@` (decision 103): the daemon writes
`<stateDir>/backup/requests/<id>/request.json` (action, target transport + non-secret fields, paths,
tags, deadline — never a secret), streams the secrets (repository password, target credentials) through
`secrets.fifo`, and **blocks** on `systemctl start`. The root step re-validates everything (home paths
allowlisted with the manifest's instance id, stage paths under `<stateDir>/backup/stage/<id>`, restore
targets inside a sealed and unlocked `volumes/`), runs restic with argv only, streams `--json` progress
to `progress.json`, writes `status.json`, and kills restic at the deadline (SIGINT: no snapshot).
Actions: `test`, `init`, `keys`, `add-key`, `remove-key`, `backup`, `snapshots`, `restore-meta` (the
state slice, returned through `out.fifo`), `restore-data` (`restic restore <id>:<home>/volumes` straight
into the new sealed dir), `forget`, `prune`, `check`, `unlock`, `forget-target`. Credentials reach restic through its environment only (S3 keys,
`RESTIC_PASSWORD`); SFTP keys and rclone config are written under `/run/harbor-backup/<id>/` (tmpfs,
0600) or the root-only `<stateDir>/backup/targets/<id>/rclone.conf` (rclone keeps its Proton session
there), and removed with the target.

## 9. Health

- Retention after every run (`forget --tag app:<id> --keep-…`), `prune` weekly per target,
  `check --read-data-subset=2%` monthly per target.
- Notifications: run failed, too busy for the cap, skipped (locked/drive), stale (no restore point in
  2× the cadence), target unreachable. Resolved rows delete fully (existing rule).
- `backup_runs` table (schema v11) keeps the history the console shows.

## 10. Later: consistency B (database dumps)

A package may declare how a database exports itself, so the app never stops:

```yaml
backup:
  dumps:
    - service: database
      command: [pg_dumpall, -U, postgres]   # stdout streamed into restic --stdin
      restore: [psql, -U, postgres]
      replaces: db                          # this claim's raw files are skipped
```

Packages without it keep A. The operator can force A for an app that has B.

## 11. Later: Harbor-to-Harbor

Sending = a `rest` connector package. Receiving = a **built-in system feature**, off by default
(enable/disable, never uninstall: that would destroy friends' data), like LAN/tailnet/public HTTPS:
restic's rest-server, append-only, one private space and quota per friend, pairing codes, reachable
over the tailnet or public HTTPS. Open: pruning under append-only (a host-approved cleanup window),
per-friend quotas.
