# Live evidence: app backups (Harbor 0.26.0, decisions 149–154), 2026-10-10

Two real Ubuntu 24.04 x86-64 hosts: **harbor-old** (the physical test box, ext4 on LUKS, running ERPNext and
other apps that were left untouched) and the **droplet `harbor-test`**. Never the production box.
`harbor-old-run.log` is the console output of the single-host run (operation event lines trimmed); IPs,
passwords and recovery words are not in this folder.

## Upgrade

| Host | From → to | Notes |
|---|---|---|
| harbor-old | 0.20.1 → 0.26.0 (`self-update apply --archive`) | v10 → v11 migration; all 12 existing containers kept running; bootstrap installed restic 0.19.1 + rclone 1.75.2 (sha256-checked) into `/usr/local/lib/harbor/bin`, `harbor-backup@.service`, the polkit rule |
| droplet | 0.25.0 → 0.26.0 | same |

## One host (harbor-old): three places, incremental, ciphertext only, restore in place

- Places: **Another disk** (`/srv/harbor/backups/live`), **S3-compatible** (SeaweedFS on `127.0.0.1:19000`, a
  bucket that did not exist yet — restic created it at `init`), **SFTP** (`127.0.0.1`, Harbor's own key, the
  server key pinned at the first test). All three `ready`.
- `memos-bk` installed sealed in the data folder, a marker file written inside its home.
- Run 1: **paused 2 s**, 909,165 bytes sent, all three places ok. Run 2: **paused 2 s**, **156,249 bytes** sent.
- `grep -r` for the marker in the disk repository, the SFTP repository and SeaweedFS's data dir: **no match**
  (the places hold only restic's encrypted packs).
- Restore in place from the SFTP place after changing the marker: operation `restore` succeeded, the marker
  is back, the app healthy; the previous copy was kept at `memos-bk.before-restore-<ts>` and deleted with
  `harbor backup forget-previous`.

## Two hosts: restore on another machine with the recovery key

1. Droplet: a fresh recovery card (`POST /v1/account/recovery-key`), `memos-x` sealed, a 3,000,000-byte random
   blob (`sha256 543a8634186043198bd56ef48943f0ab228d7e775ea57415f5a86f50c858d939`) and a marker; an SFTP place
   on the droplet itself; backup **paused 5 s**, 3.1 MB restore point, no plaintext at the place.
2. harbor-old: the **same SFTP place** added by the droplet's public address → `foreign` ("Backups of another
   Harbor are here") → `harbor backup open` with the droplet's 12 words → `ready` → `harbor backup found` lists
   `memos-x` → `harbor backup restore-app` → install succeeded: **same SHA-256**, the marker, healthy, HTTP 200,
   same instance id, home kernel-sealed (`fscrypt status`: policy v2, AES_256_XTS, unlocked).
3. harbor-old: `harbor purge memos-x`, then restore again → a **fresh instance id** (the purged row keeps the old
   one), manifest rewritten to it, same SHA-256, healthy.

## Found live and fixed before release

| What | Fix |
|---|---|
| rclone never installed: the zip reader drops the archive's top folder, so the binary is `rclone`, not `rclone-v…/rclone` | `rcloneBinary()` + unit test |
| Testing an S3 place whose bucket did not exist hung until the timeout: restic retries "bucket does not exist" instead of exiting 10 | the test step treats it as an empty place (init creates the bucket) |
| `init` against a server refusing writes (SeaweedFS without credentials) retried for minutes; the CLI call timed out | every step stops after 3 retries (8 for backup/restore/prune/check) and reports what restic kept failing at |
| A place test that ran out of time said "raise the maximum downtime" | timeouts are worded per step |
| A new place got its prune + check right away; the prune's exclusive lock broke the restore's listing | first prune in a week, first check in a month; maintenance runs in the backup worker, never next to an operation; listing uses `--no-lock`; lock-taking steps `--retry-lock 5m` (two Harbors can share a place) |
| Restoring an app that was uninstalled here: "already on this machine" (purged rows stay for history) | restored under a fresh identity; integration test added |
