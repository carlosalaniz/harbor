# Live run: move an encrypted app between places (Harbor 0.25.0, 2026-10-06)

Droplet `harbor-test` (Ubuntu 24.04 x86-64, address redacted), self-updated 0.24.0 → 0.25.0 from a local
archive. The "drive" is a 4 GiB ext4 image created with `-O encrypt`, loop-mounted at `/mnt/movetest`
(mountpoint owned by `harbor`, as Harbor's own drive mounts are), removed after the run.

| Step | Command | Result |
|---|---|---|
| sealed install (CLI default, decision 130) | `harbor install memos --name move-live --yes` | plan `Encrypted: yes — sealed at /srv/harbor/harbor-apps/memos` |
| marker | 3 MB random `/var/opt/memos/blob` | sha256 `ecdc17c2…9f20` |
| move to drive | `harbor move move-live --location /mnt/movetest/harbor-apps --yes` | "copied and verified the data", old home deleted; same sha256; `fscrypt status` on the drive: policy set, unlocked |
| at rest on the drive | `harbor stop` + `harbor lock`, `ls …/volumes/*/` | ciphertext names only |
| move back (first build) | `harbor move … --location /srv/harbor/harbor-apps` | **failed**: fscrypt "already a protector named harbor-move-live-…" (left by the deleted home); rollback kept the app running on the drive, same sha256 → decision 146 |
| fixed build: round trip | install again, then drive → data folder → drive | three `move succeeded`, sha256 `ada22b73…` unchanged each time, `encrypted: yes` at each place |
| purge | `harbor purge move-live --yes` | succeeded; both `memos/` folders empty of it |
