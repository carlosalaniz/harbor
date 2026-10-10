# Harbor operator guide (local preview)

Harbor installs a few self-hosted applications on one Ubuntu machine as ordinary Docker Compose
projects, allocates non-conflicting loopback ports, checks readiness, and remembers what it owns.
This release is a **trusted local preview**: one administrator, loopback only, one daemon with
Docker (root-equivalent) authority. It is not a hardened multi-user management service.

## 1. Requirements

| Item | Requirement |
|---|---|
| Host | Ubuntu 24.04 LTS or Debian 12/13, x86-64, systemd. Debian/Ubuntu derivatives (Linux Mint, Pop!_OS, Raspberry Pi OS, …) usually work but are not tested: bootstrap refuses them unless you pass `--force` (one-line installer: `HARBOR_FORCE=1`). |
| Memory | 4 GiB RAM minimum (8 GiB recommended — see the heavy apps below) |
| Disk | 20 GiB free minimum (apps + images + one recovery bundle); 50+ GiB if you run Immich or Nextcloud |
| Docker | Docker Engine + Compose plugin. Absent: bootstrap can install them from Docker's apt repository when you pass `--install-docker`. Present: validated, never modified. |
| Access | Local browser on the machine, or SSH local port forwarding. Harbor never listens on anything but 127.0.0.1. |
| Build tooling on the host | None. The archive bundles Node.js and all dependencies. |

Heavy apps (give the machine headroom before installing these): **Immich** (photo library —
needs several GiB for its database + machine-learning models, and a drive of its own for the
library), **Open WebUI + Ollama** (local AI models are GiB each; CPU-only inference is slow —
this is a patience question, not a failure), **Nextcloud** (files + office; grows with what you
put in it). On a 4 GiB box, run one heavy app at a time.

Qualified pair for this release (see `docs/VERIFICATION.md` for the run that produced it): Docker
Engine and Compose versions installed by `--install-docker` on the date of qualification; Node
24.12.0 bundled.

## 2. Install

### 2a. The one-line installer (recommended)

On a machine (or VM) running Ubuntu 24.04 or Debian 12/13 x86-64, from a terminal on it (SSH or keyboard):

```sh
curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash
```

It checks the machine, installs Docker if needed, downloads the newest release from GitHub and verifies its
checksum, names the machine `harbor` (so it answers as **http://harbor.local** on your network through mDNS),
installs Tailscale and the HTTPS proxy, and prints a **setup code**. Then open the printed address in a
browser and follow the wizard: name your Harbor, create your account (type the code, pick a login name,
tell Home what to call you), pick a look. Nothing
is typed on the terminal.

- `HARBOR_HOSTNAME=mybox` changes the mDNS name (`http://mybox.local`); `HARBOR_HOSTNAME=` keeps the current one.
  If avahi's config pinned an old name (`host-name=` in `/etc/avahi/avahi-daemon.conf`), Harbor
  comments that line out so `<name>.local` follows the machine's hostname. Machine already renamed but
  still answering the old `.local` name? `sudo /opt/harbor/bin/harbor bootstrap --yes --hostname <name>` fixes it.
- `HARBOR_LAN=off` keeps LAN mode off (console and apps then answer only on the machine, over Tailscale, or via SSH forwarding). On a cloud server LAN mode stays off automatically: there, "every interface" would be the public internet.
- `HARBOR_TOOLS=1` also sets up Cockpit and Portainer. `HARBOR_VERSION=<version>` pins a release (e.g. `HARBOR_VERSION=0.12.5`).
  The installer takes the newest release; pinning is for troubleshooting only. Releases older than 0.17.0 said
  "installed encrypted" and were not — do not install them (`docs/releases/v0.17.0.md`).
- Lost the setup code? On the machine: `sudo /opt/harbor/bin/harbor setup-code --config /etc/harbor/harbor.json`.

**LAN mode** means the console (port 80) and every app port answer to any device on your local network,
like Umbrel. Protect the console with a strong password and two-factor login (Settings → Account); apps
without their own login are open to the LAN. It is chosen at install time (`bootstrap --lan`); apps
installed before it was turned on keep answering on the machine only until they are updated.

**Every address at once.** An app opens on all the addresses you have set up: LAN (`http://<hostname>.local:<port>`
or the IP), secure LAN, Tailscale and your domains. Its **main address**, picked at install, is only the one it
puts in links it sends out (emails, share links, webhooks). The install page offers only what is set up:
*this network* (secure when secure addresses are on), Tailscale, or a domain that points here; picking
Tailscale or a domain publishes the app in the same step. Apps that do not work at all over plain `http://`
(n8n, Vaultwarden) need an HTTPS main address in LAN mode — the store says so before you install.

**Restart after network changes.** Turning secure addresses on or off, or renaming the machine, changes the
addresses apps know about. Open the app and press **Restart** (CLI: `harbor restart <app>`): Harbor rewrites its
settings with today's addresses and recreates its containers — data, secrets and ports stay. The Network card
lists which apps want a restart, and warns before turning secure addresses off if an app would stop working.
Publishing or withdrawing a Tailscale or domain address needs no restart. Nextcloud keeps its list of trusted
addresses itself after every start (decision 116).

**Secure addresses** (Settings → Network, needs LAN mode) turn those same addresses into HTTPS:
Harbor mints its own certificate on the machine (nothing leaves your network, nothing phones home)
and serves the console on port 443 plus one secure address per app. Each device trusts the one
Harbor certificate once — the card shows whether *this* browser already does, and the trust sheet
walks through every platform (iOS needs two stages: install the profile, then enable full trust;
Firefox keeps its own store everywhere). Until a device trusts it, the plain-HTTP console shows a
banner pointing at the sheet; the browser's own warning page for the HTTPS address cannot be
styled by Harbor.

### 2b. Manual install (bootstrap)

Running `bootstrap` without `--password-stdin` on a machine that has no administrator yet leaves it in setup mode: it prints the setup code and the wizard creates the account in the browser.

```sh
# on your workstation
scp release/harbor-<version>-linux-x64.tar.gz release/SHA256SUMS user@host:
# on the host
sha256sum -c SHA256SUMS
tar -xzf harbor-<version>-linux-x64.tar.gz
sudo ./harbor-<version>-linux-x64/bin/harbor bootstrap [--install-docker] [--with-tools] [--port 18000]
```

Bootstrap previews every step and asks for approval (or `--yes`). It:

1. verifies the distro (Ubuntu 24.04 / Debian 12/13, or a derivative with `--force`) / x86-64 / systemd / root, checks that every system tool it will call is present, and detects existing Harbor, Docker, Cockpit, Portainer;
2. validates Docker, or installs it only with `--install-docker` (separately approved; never touches an existing setup);
3. copies the release to `/opt/harbor`, creates the `harbor` system user (in the `docker` group), `/etc/harbor` and `/var/lib/harbor`;
4. initializes state explicitly and prompts for the administrator password without echo (`--password-stdin` for automation);
5. installs and starts `harbor.service`, waits for `/healthz`;
6. with `--with-tools`, offers Cockpit and Portainer (section 6) after separate approval.

Re-running bootstrap is safe: it updates the release files and unit, and keeps state, keys,
administrator and applications. A conflicting unrelated `/opt/harbor` or `harbor.service` is an
error, never overwritten.

**Reset the administrator** (daemon stopped; invalidates all sessions; touches nothing else).
Resetting destroys the sealed machine key, so data-folder apps lose silent unlock until each is
unlocked with its own passphrase or recovery key. Export a recovery bundle first (section 4f),
then:

```sh
sudo systemctl stop harbor
sudo /opt/harbor/bin/harbor recovery export --config /etc/harbor/harbor.json --file /root/harbor-recovery.harbor-recovery
sudo /opt/harbor/bin/harbor enroll --config /etc/harbor/harbor.json --reset --username admin --i-understand-data-loss
sudo systemctl start harbor
```

## 3. Access: browser and SSH forwarding

- On the host: http://localhost:18000/ (or the port you chose).
- From your workstation, forward the **same** local and remote port numbers:

```sh
ssh -L 18000:127.0.0.1:18000 \
    -L 18080:127.0.0.1:18080 -L 18081:127.0.0.1:18081 -L 18082:127.0.0.1:18082 \
    -L 9090:127.0.0.1:9090 -L 9443:127.0.0.1:9443 \
    user@host
```

Add one `-L` per installed app port (see `harbor list`) and per tool. If a local port is busy on
your workstation, free it or pick another local port (`-L 28080:127.0.0.1:18080`) and open
http://localhost:28080/ — the remote binding never changes and Harbor never republishes on other interfaces.

Apps like BentoPDF and n8n rely on a secure browser context or secure cookies; `http://localhost`
qualifies, a LAN IP over plain HTTP does not. Do not disable app security settings to work around this.

## 4. Application lifecycle

Console pages (sidebar on desktop, bottom tabs on a phone): **Home** (system strip with processor,
memory, storage and Docker; your apps as tiles with a plain-words status, Open and a details drawer
with Start/Stop/Remove/Reinstall and technical details), **App Store** (catalog cards with icon,
tagline, category chips and search; an app page with Install and the storage choices), **Publishing**
(every published address, Publish/Withdraw, Harbor on your tailnet), **Platform** (Docker, Cockpit,
Portainer, Tailscale, proxy with real state and links; Cockpit and Portainer show a **Set up**
button when absent — one click starts the install as root and the card reports progress),
**Settings** (session, SSH forwarding line,
about). Every change goes through the same plan review; the operation tray at the bottom right shows
progress and, once, any generated credentials.

CLI (`/opt/harbor/bin/harbor`, add it to PATH if you like):

```sh
harbor login                      # prompts without echo; token stored 0600 in ~/.config/harbor
harbor catalog
harbor install excalidraw         # shows the plan (ports, storage, images) and asks to apply; sealed like the console's "Local"
harbor install excalidraw --name whiteboard-2 --yes --no-wait
harbor install excalidraw --unencrypted              # plain Docker volumes (says "Encrypted: no" in the plan)
harbor install nextcloud --credentials-file ~/nextcloud-login.txt   # one-time values to a new 0600 file, not the terminal
harbor list / inspect <name-or-id> / operation <id> --follow
harbor stop <name> / start <name>
harbor remove <name>              # deletes containers + private network; RETAINS volumes, secrets, name, ports, addresses
harbor reinstall <name>           # exact same release into the retained instance; publishes its addresses again
harbor seal <name>                # encrypt an app that runs on plain Docker volumes, in place
harbor passphrase <name>          # change an encrypted app's passphrase (or --harbor-key)
harbor move <name> --location /mnt/photos/harbor-apps   # an encrypted app to another place, same key
harbor repair <name>              # an app stuck in needs_action/failed: run its stored release again (alias: retry)
harbor plan install n8n && harbor apply <plan-id> --idempotency-key <key>
harbor tools / tools bind cockpit --url https://localhost:9090/
harbor doctor
```

Exit codes: 0 success, 1 operation failed, 2 invalid request, 3 conflict/action required,
4 dependency unavailable, 5 authentication. `--json` for machine-readable output.

States: **install** installing/installed/failed/needs_action/retained · **desired**
running/stopped/retained · **runtime** running/stopped/starting/unavailable/unknown ·
**readiness** healthy/unhealthy/checking/unknown. `installed`+`healthy` means the app answers its
readiness URL. It does **not** mean the app's own onboarding is done: n8n shows separate setup guidance.

### Full uninstall

`remove` keeps data so `reinstall` can bring an app back. When you want an app **gone**, use the full
uninstall: in the console open the app's details, expand *Uninstall completely…*, type the app's name,
confirm; or `harbor purge <instance>` (asks you to type the name unless `--yes`). It deletes the
containers, the data volumes Harbor created for that app (after checking they really are Harbor's),
its secrets and stored release, and frees the name and ports. Folders of yours are never touched.
There is no undo.

### Data retention

- `remove` never deletes data volumes or generated secrets. `reinstall` verifies both (ownership
  token, creation time, key files) and refuses with `DATA_MISSING` / `SECRET_MISSING` rather than
  initializing replacements. `purge` (full uninstall) deletes Harbor-created volumes after an
  ownership check; deleting anything else is a manual `docker volume rm` decision by you.
- Secrets live in `/var/lib/harbor/instances/<uuid>/secrets/` (0600) and appear in plaintext in the
  private generated Compose file. That is deliberate for the trusted local preview; there is no
  encrypted vault.
- Back up (outside Harbor): `/var/lib/harbor` (state, secrets, release snapshots). Application data
  volumes are the application's responsibility.

## 4f. If this machine dies (recovery bundle)

Harbor keeps two different kinds of data, and only one of them is in the recovery bundle:

- **Harbor-owned state** — the database (which apps exist, ports, addresses, settings), the
  per-instance secrets, the stored release snapshots, your uploaded packages, and the app-home
  envelopes (which app lives where, and how to unlock it). This is what
  `harbor recovery export` writes into one passphrase-wrapped file.
- **Application data** — the databases, photos, files and workflows inside the apps. The bundle
  never includes these; app backups (4g) do, for every encrypted app you turn them on for. Managed
  Docker volumes live on the engine; drive apps live on their drive.

Export regularly (daemon stopped; the passphrase is the only key — without it the file is
unreadable, so store both somewhere that is not this machine):

```sh
sudo systemctl stop harbor
sudo /opt/harbor/bin/harbor recovery export --config /etc/harbor/harbor.json --file /root/harbor-recovery.harbor-recovery
sudo systemctl start harbor
```

Restore onto a **fresh** machine (a new Ubuntu install with Harbor bootstrapped but no apps yet;
import refuses to overwrite existing state):

```sh
sudo systemctl stop harbor
sudo /opt/harbor/bin/harbor recovery import --config /etc/harbor/harbor.json --file /root/harbor-recovery.harbor-recovery
sudo systemctl start harbor
```

Then, per app:

- **Drive apps** are portable: re-insert the drive, find the app under Settings → Storage →
  Found apps, and *Adopt* it with its own passphrase or recovery key. Ports are allocated fresh;
  addresses differ from the old machine.
- **Data-folder apps** unlock silently after restore (the sealed machine key travels in the
  bundle) as long as the administrator password is unchanged. After an `enroll --reset`, unlock
  each one with its own passphrase or recovery key instead.
- **Managed volumes** (apps without a drive home) are **not** in the bundle: their data lived on
  the dead machine's Docker engine. Reinstall the app; its configuration is back, its data is
  whatever the app's own backup holds.
- **Apps you back up** (4g below) come back from their backup place with their data, even when the
  machine and its disks are gone.

### Failure states

- `failed` install: resources are kept for inspection (`harbor inspect`); use `remove` to clean up.
- `needs_action`: an operation was interrupted (daemon restart), an ownership/data check failed, or an
  update failed and its rollback failed too. Nothing is replayed automatically. The way out (decision 135):
  if the error names a port or an address, withdraw that address first (`harbor unexpose <app> --via
  <via>` works in this state), then **Repair** (drawer button, `harbor repair <app>`): it renders the
  stored release again, recreates the containers and checks the app answers. `stop`/`remove`/`reinstall`
  stay available. A failed start removes the containers it half-created (never started, or left with no
  network), and a container with no network is never shown as running.
- Docker unavailable: instances show `unavailable`/`unknown`, never a stale `healthy`.

## 4g. Backups of your apps (encrypted, incremental, to several places)

Since 0.26 Harbor backs up whole apps: their data, and the secrets and release they need to come back
(design: `docs/design/BACKUPS.md`). The recovery bundle above stays the way to rebuild Harbor itself;
backups are how the **apps' data** survives a dead machine, a dead disk or a bad day.

**What gets backed up.** Every app installed encrypted (the default since 0.17: the Harbor data folder
or an ext4 drive). An app on plain Docker volumes says *Not encrypted* in its Backups panel: encrypt it
first (*Encrypt* in its window, or `harbor seal <app>`). Folders of your own (bring your own folder) are
not included: Harbor never owns them, back them up with your own tool.

**Privacy.** Everything is encrypted on this machine before it leaves (restic: AES-256). The place only
stores pieces it cannot read; it learns sizes and times, nothing else. Two keys open a place: Harbor's
own backup key (so the nightly runs need no one; it works after the first login after a reboot), and
**your Harbor recovery key** (the 12 words from setup). The 12 words alone open every backup this
Harbor made, on any machine, even with plain `restic` (the words, lowercase, single spaces, are the
password).

**1. Add a place** (Settings → Backups → *Add a place*, or App Store → *Backup places*):

| Place | You fill in | Notes |
|---|---|---|
| Another disk | a folder under `/mnt/…` or `/media/…` (a mounted drive) | fast; same house as the original |
| S3-compatible | endpoint, bucket, folder, access key ID + secret | Backblaze B2, Cloudflare R2, Wasabi, AWS, MinIO; a bucket with object lock keeps backups even a hacked machine cannot delete |
| SFTP server | server, port, user, folder, a private key (no passphrase) | put the key's public half in the server's `authorized_keys`; the server key is pinned at the first test |
| Proton Drive (beta) | Proton email, password, the current 2FA code | through rclone's unofficial Proton backend: it can break when Proton changes things, pair it with another place |

Harbor tests a place before it saves it. An empty place is set up there and then; a place that already
holds this Harbor's backups is simply ready; a place holding **another Harbor's** backups says so
(see 4 below). Add as many places as you like ("B2", "USB disk", "Mom's NAS").

**2. Turn backups on per app.** Open the app from Home → *Backups*: tick the places (it is sent to every
one of them), tick *Back up on the schedule*, optionally give it its own start time. *Back up now* runs
it right away.

**3. The schedule** (Settings → Backups → Schedule): start time (default 02:00), every night or once a
week, **longest pause per app** (default 5 min), how many restore points to keep (7 daily, 4 weekly,
6 monthly), and a pause switch. Apps go **one at a time**. Each one is first copied while it keeps
running (the slow part), then paused only to send what changed in the last minutes, then started
again. The pause depends on how much changed, not on how big the app is: a 100 GB database usually
pauses for seconds. If the last pass would take longer than your limit, the app keeps running, the
run is marked *Skipped* or *Failed*, and the bell tells you; raise the limit or pick another time.
A locked app (before the first login after a reboot, or a custom passphrase not typed since) is
skipped, never forced open.

**Restore in place** (the app's *Backups* → a restore point → *Restore…*): Harbor stops the app,
moves its current data aside to `<home>.before-restore-<time>`, puts back the data, secrets and
release of that moment, and starts it. Anything that fails puts it back exactly as it was. The copy
kept aside stays until you press *Delete it* (or `harbor backup forget-previous <app>`), so a wrong
restore point costs nothing. Everything the app saved after the restore point is only in that copy.

**4. Restore on a new machine.** Install Harbor, then Settings → Backups → *Add a place* with the same
details. It shows *Another Harbor's backups*: type the old Harbor's 12 words, then *Restore apps from
here* → pick the app and where it should live → review → *Restore here*. It comes back with the same
data and secrets on fresh ports (addresses differ). The app's package must be on this Harbor (bundled
ones are; re-upload your own apps first). From then on this Harbor can back it up to the same place.

**Removing a place** keeps the backups stored there. Tick *Also delete every backup this Harbor stored
there* and type the place's name to delete them too.

CLI: `harbor backup` (overview), `harbor backup add s3 B2 --set endpoint=… --set bucket=… --set
accessKeyId=… --secret secretAccessKey=@key.txt`, `harbor backup enable immich --to B2 --to "USB disk"`,
`harbor backup now immich`, `harbor backup points immich`, `harbor restore immich <run-id>`,
`harbor backup policy --window 03:30 --max-downtime 10`, `echo "<12 words>" | harbor backup open "Old
USB"`, `harbor backup found "Old USB"`, `harbor backup restore-app "Old USB" <instance-id> <run-id>`.

## 4a. Your own folders for app data ("bring your own folder")

Apps keep their data in retained Docker volumes by default. Where the big data lives (photos, media,
files) a package may offer an **external** storage claim: at install time you can point it at a folder
on this machine instead. Harbor validates the folder, mounts it into the app and never creates,
changes or deletes it.

```sh
harbor catalog                                              # lists claims that accept a folder
sudo mkdir -p /mnt/photos                                   # the folder must already exist
harbor install immich --storage library=/mnt/photos         # claim=path, repeatable
harbor install jellyfin --storage media=/mnt/media          # Jellyfin sees it at /media
harbor inspect immich                                       # `bind` resources show the folder and whether it is present
```

In the console, the app page shows "Where should the data live?" with *Managed by Harbor* or *Use a
folder on this machine* per claim.

Rules and behaviour:

- **Where:** under `/mnt`, `/media` or `/srv/harbor`. Harbor writes one small identity file
  (`.harbor-bind.json`) into the folder so a swapped or missing drive is never mistaken for the app's
  data, and its service may write only there. A folder elsewhere (or a read-only mount) is refused at
  plan time with that reason (decision 121); `/home` is not visible to the service at all.

- In the console you pick the folder in a browser: disks, the Harbor data folder (`/srv/harbor`) and
  subfolders; *Create folder here* works wherever the `harbor` account may write (the data folder
  always). Typing a path is still possible under *Type a path instead*.
- Absolute path, must exist and be a directory; system locations (`/etc`, `/usr`, `/var/lib/docker`,
  `/var/lib/harbor`, …) and the root are refused, also when a symlink points there.
- Two instances cannot share or nest their folders; the plan says which instance uses a folder.
- Remove leaves the folder untouched. Reinstall and start check that it still exists; a missing
  folder blocks with `DATA_MISSING` (mount or restore it at the same path, then retry).
- Harbor does not change permissions. The packaged apps run as root inside their containers or take
  ownership on first start (Nextcloud); keep the folder for one app only.
- Read-only claims (Navidrome's music) are mounted read-only.
- When you claim a folder, Harbor writes a small `.harbor-bind.json` marker inside it: which app
  and claim, plus a random drive id the app generated. A backup restored onto a new drive keeps
  working (copy the folder with its marker); a different or empty drive at the same path makes
  start and reinstall refuse with `DATA_MISSING` — mount the right drive back, restore the
  folder, or accept the new folder from the app drawer (*Use this folder instead*).

## 4a1. Removable drives (USB sticks, external disks)

Plug in a drive and it appears under **Settings → Storage → Removable** and in the folder
picker's *Removable* section — mounted drives open like any disk, unmounted ones show *Mount*.
Mounting puts the drive at `/mnt/<label>` (the label, lowercased and sanitized, or the device
name); unmounting is the *Eject* button. Harbor only ever mounts removable media — system disks
are never touched.

- Insert and removal also raise a bell notification (one row per drive, resolved when it leaves).
  A freshly inserted drive is mounted automatically (Settings → Storage has an
  *Automatically mount inserted drives* toggle, on by default).
- If a drive holding an app folder is removed, Harbor stops the app to protect its data and the
  bell says which app lost its drive. Home shows *Needs its drive*; starting is refused
  (`DATA_MISSING`) until the drive (or a restored folder with its marker) is back at the same
  path. A replacement drive can be accepted from the app drawer (*Use this folder instead* —
  available once the app is stopped); nothing is ever started against the wrong folder.
  When the right folder is back, Harbor starts the app again by itself
  (*Automatically start apps when their drive returns*, on by default) and the
  bell row disappears.
- A drive on the wrong filesystem (exFAT, NTFS, vfat — shown as *cannot hold
  apps as-is*) can be converted in place: **Format as ext4…** next to the drive
  erases everything on it and formats it as ext4, then remounts it at the usual
  place so it qualifies for whole-app installs. Mounting such a drive would only
  dead-end (an app database on exFAT/NTFS is corruption, not portability), so
  Harbor does not offer Mount there — only Format. Formatting is refused while an
  app uses the drive, and asks for the device name (e.g. `sdb1`) as typed
  confirmation. System disks are never offered.
- **A drive that needs you** (decision 122) gets a card on Home and, after a minute, a bell warning
  that opens Settings → Storage:
  - *Mounted by your desktop* — a desktop (KDE, GNOME) grabbed it at `/media/<you>/<label>`, where
    Harbor cannot write, so apps cannot use it. **Let Harbor manage it** unmounts it there (refused
    while a program has files open on it — close it and retry), mounts it the Harbor way at
    `/mnt/<label>`, and tells the desktop not to automount that drive again (a udev rule,
    `/etc/udev/rules.d/90-harbor-drive-<uuid>.rules`; delete it to give the drive back for good).
  - *Plugged in but not mounted* (a Linux filesystem that could hold apps) — **Mount it**. A drive you
    ejected in Harbor never nags.
  The × on the card hides it (and the bell row) until something changes — the drive is fixed,
  unplugged, or has a different problem.
- **Moving a drive between machines** (decision 122): Harbor's identity files (`.harbor-bind.json`)
  are readable by any user, and every Harbor mount re-owns just those files to this machine's
  `harbor` user (each machine's `harbor` has a different number), so a folder an app used on another
  Harbor still verifies here. Your own files are never re-owned.
## 4a2. Install a whole app on a drive (encrypted, portable)

Some apps keep everything in a database that cannot live in one of your own
folders — and on a machine with tiny onboard storage even the database needs to
move. At install time the wizard asks **where the app should live**: **Local**, in the
Harbor data folder on this machine, or **External drive**. Either way the app is
sealed, this machine unlocks it when you log in, and your Harbor recovery key
opens it on any other machine. Neither choice asks you to invent a passphrase.

*Use my own passphrase instead…* opts into one, for either location. Give an app
its own passphrase for one of two reasons: you want to open that one app on a
machine that does not have your Harbor recovery key, or you want to hand that
one app over along with its drive without giving away everything else. A
passphrase must be 8 characters or more, and the *Generate* button makes one for
you. Write it down; an app whose passphrase and Harbor recovery key are both
lost is gone. The review step names the sealed home and says exactly how it will
open.

The whole app — database included — then lives **sealed** in one folder on the
drive (`<candidate>/<package>/<instance>/{manifest.json, vault/, volumes/}`, for
example `/mnt/photos/harbor-apps/immich/immich`). *Sealed* means the kernel's
own directory encryption (fscrypt, v2 policy, one key per app): the app's data
under `volumes/` is ciphertext on the disk — file names included — and stays
that way for every reader, root and Docker included, until Harbor adds the
app's key to the kernel. Unplug the drive and the app stops; plug it into
another Harbor machine and it appears under **Settings → Storage → Found
apps**, where *Adopt* (with the passphrase) installs it there with fresh
ports. Only ext4 drives qualify for sealing (Harbor turns on the ext4 `encrypt`
feature and sets fscrypt up by itself, at format time and again at install; a
database on exFAT/NTFS is corruption, not portability — those show a *needs
formatting as ext4* warning with a Format button instead of Mount or a
passphrase, and Install stays disabled until the drive is ext4; a plugged-in
but unmounted drive on an eligible filesystem offers *Mount it* right in the
wizard, and a folder picked on an unmounted drive blocks Install with a mount
prompt until the drive is mounted). A machine that cannot seal (no ext4, no
`fscrypt`) refuses the install with the exact fix — Harbor never installs an
app it would later call encrypted on plaintext.

**Your Harbor recovery key.** Setting Harbor up shows you twelve words, once,
and never again. They are the master key to everything this Harbor encrypts:
with them you open your apps on another machine even if this one is stolen,
wiped or dead. Harbor keeps them only behind your password, which is why it
cannot show them twice. Write them on paper and keep them away from the
machine, the way you would a spare house key. Settings → Account tells you
when they were issued and lets you *Replace it…* if the paper is lost or
someone saw it. Replacing re-stamps every app Harbor can reach at that moment
and names any it could not, for example an app on an unplugged drive: those
keep opening with the old words until you plug the drive in and replace again,
so keep the old paper until the list comes back empty. If you set Harbor up
from the command line rather than the browser, the card is issued the first
time you install an encrypted app and shown once in that install's result.

An app you gave **its own passphrase** also gets its own twelve words at
install. Those open that one app and nothing else, which is what you hand over
along with a drive when you give somebody a single app. An app installed
without a passphrase has none, because there is no passphrase to forget: your
Harbor recovery key is its way back.

A locked app (this machine holds no key for it — after a reboot, before the
first login) shows a quiet *Locked* tile; its drawer says so and, for a
custom-passphrase app, offers the unlock form. Data-folder apps unlock at the
next login. Drive apps whose passphrase **is your Harbor password** unlock at
login too (this machine keeps a wrapping of their key behind your login, like
data-folder apps — the passphrase still travels with the drive, so another
Harbor machine adopts it the same way). Drive apps with **any other
passphrase** ask for it every time they are locked: type it in the drawer
(or the 12-word recovery key). Typing the passphrase once on a same-password
app that predates this behaviour records the wrapping for next time. **Lock** (drawer button while the app is stopped, or
`harbor lock <app>`) evicts the key again: Harbor refuses to lock a running
app because its files are open. To see for yourself, on the machine:
`sudo fscrypt status <home>/volumes` (shows `Unlocked: No` while locked) and
`ls <home>/volumes` (ciphertext names; reading a file answers *Required key
not available*).

Apps installed by a Harbor older than 0.17.0-beta.2 have plaintext data under
`volumes/` (the drawer says *Not sealed yet*). Their next **Start** seals the
data in place: Harbor moves the folder aside, seals a fresh one under the same
path, copies everything back as root, verifies entry counts and bytes, and only
then deletes the plaintext copy (any failure puts the original back and the
Start reports why). This needs free space for one extra copy, and it cannot
scrub the old blocks from the device — a drive that already held plaintext may
keep recoverable remnants until they are overwritten. Apps installed from
0.17.0-beta.2 on are sealed before any data exists.

**Headless reboot, in plain words:** after a power cut or reboot, every sealed app stays
locked — and therefore down — until the first console login unlocks it. On a headless box
that means Immich is down until someone logs in (any login unlocks every data-folder app at
once and Harbor starts them again; drive apps with a custom passphrase each need theirs typed
once). This is deliberate: the unlock key lives behind your login, not on the disk, and while
locked the data is ciphertext — Docker cannot even find the app's folder. Automatic unlock
without a login (keyfile/TPM) is a 1.0 item, not a beta one — for now, log in once after a reboot.

**Apps that are not encrypted start on their own.** An app installed on plain Docker volumes (the
CLI's `--unencrypted`, or anything installed from the CLI before 0.23.0 without `--location`) keeps
its data readable on disk and starts right after a reboot, before anyone logs in. To tell which is
which: `harbor list` has an **ENCRYPTED** column (`yes`, `yes (locked)`, `no`), `harbor inspect <app>`
prints `encrypted: yes — sealed at …` or `encrypted: no — plain Docker volumes`, and the app's details
in the console say the same under its name.

**Encrypt an app that is not encrypted** (decision 142): app details → *Encrypt this app…*, or
`harbor seal <app>`. It is the same app afterwards — same name, ports, addresses, links and secrets —
with its data moved into a sealed home in the Harbor data folder (Harbor's own key, unlocks when you log
in). The app is down while the data is copied (as root, verified per volume), it needs free space for
one extra copy, and the plain volumes are deleted only after the sealed app has started; any failure
before that leaves it running unencrypted as before. Old blocks of the plain volumes cannot be scrubbed
and may stay recoverable on the disk until overwritten. Folders of your own are never moved.

**Move an app** (decision 145): app details → *Move to…*, or `harbor move <app> --location
/mnt/photos/harbor-apps` — between the Harbor data folder and an ext4 drive, or drive to drive. It is the
same app with the same key: its passphrase, its own 12 words and your Harbor recovery key keep working.
It is down during the copy; the data is decrypted only inside the kernel and written sealed at the new
place (never plaintext on a disk); the old copy is deleted only after the app has started from the new
place, and any failure before that leaves it where it was. An app on plain Docker volumes is encrypted
first (`harbor seal`). A drive that is not ext4 is refused (Settings → Storage can format it).

**Change an app's passphrase** (decision 143): app details → *Change passphrase…*, or
`harbor passphrase <app>` (prompts; `--stdin` reads the current one on line 1 and the new one on line 2;
`--harbor-key` switches to Harbor's own key). The current passphrase, the app's own 12 words or your
Harbor recovery key all work as "current"; an app that opens with Harbor's own key needs none while you
are logged in. Choosing your own passphrase issues the app's own 12 words once (if it had none); a
passphrase equal to your Harbor password unlocks at login, any other one must be typed after each
reboot. Switching back to Harbor's own key removes the app's own words. The data is never re-encrypted —
only the key that opens it is wrapped anew, so it takes a second.

CLI: `harbor install <package>` installs sealed in the Harbor data folder with Harbor's own key, exactly
like the console's **Local** (decision 130; `--unencrypted` for plain Docker volumes), and
`harbor install <package> --location /mnt/photos/harbor-apps/immich --passphrase-stdin < passphrase.txt`
puts it on a drive (omit the passphrase for no custom passphrase), `harbor lock <app>` / `harbor unlock <app>`, `harbor found-apps`,
`harbor adopt <home-folder>`.
## 4b. Settings in the console (for people who do not use a terminal)

The console's **Settings** page covers what a household operator needs after bootstrap:

| Section | What you can do |
|---|---|
| Account | change the administrator password (every other logged-in browser or CLI is signed out); *Remember this browser* (30-day session), the session list, *Log out of other sessions*, *Log out*; *What should Home call you?* sets the greeting name Home shows ("Good evening, Carlos") — the login name stays the credential, clearing it falls back to the login name |
| Network | **secure addresses** on your home network: turn on HTTPS for Harbor and every app (`https://harbor.local/` with no warning once each device trusts the one Harbor certificate); the card shows whether *this* browser already trusts it, and *How to trust it on a new device…* walks through macOS, iOS (install the profile, then enable full trust), Windows, Android and Linux, plus the Firefox note |
| Remote access | connect this machine to your Tailscale tailnet by clicking *Log in with Tailscale* (opens the approval page) or by pasting an auth key; see the node name; turn *Harbor on your tailnet* on or off; log out of the tailnet |
| Public addresses | the wizard for publishing on the internet: this machine's public address, your domains with a DNS check (*Points here* / *Points elsewhere* / *No DNS record yet*), which app uses each, re-check and forget; certificates are automatic |
| Remote access (details) | tailnet addresses, node key expiry, link to the Tailscale admin console; the auth key you used is single-use and is not stored |
| Storage | disks with free space, removable drives (mount/eject, auto-mount/auto-start toggles), the Harbor data folder (`/srv/harbor`, where Harbor may create folders for you), folders currently used by apps, and a folder browser with *Create folder here* |
| Overview | the landing page: your machine's name, what it runs on, Harbor version, uptime, storage/memory/temperature, *Restart* and *Shut down* (each asks first), and the wallpaper picker |
| Appearance | theme (match device / dark / light), wallpaper presets, your own picture (PNG/JPEG/WebP up to 6 MB), or **rotating wallpapers**: Harbor itself fetches a new picture on a schedule from Bing or Wikimedia Commons (no account) or from your favourite subreddits (needs a free Reddit "script" app key; Settings walks you through it). The picture and its credit show on Home. |
| Advanced access | a **terminal** on the machine (shell of the Harbor service account: `docker`, `harbor …`), the SSH forwarding lines with copy buttons, and the CLI equivalents |
| Troubleshoot | Harbor's own log (systemd journal) and each app's container logs, copyable |
| Account (two-factor) | turn on a 6-digit authenticator code at login (QR code or typed key); turn off with the password; lost the app? on the machine: `sudo /opt/harbor/bin/harbor account totp reset --local --config /etc/harbor/harbor.json` |
| Overview (name) | rename the machine (shown in Settings and the browser tab) |

The same actions exist as commands: `harbor account set-password`, `harbor account name [name]` (show or set the Home greeting name; empty clears it), `harbor tailscale login [--authkey-stdin]`, `harbor tailscale logout`, `harbor network https` / `harbor network https on|off` / `harbor network ca`, `harbor storage`, `harbor domains [add|check|forget]`, `harbor purge`.

Search everything with **⌘K / Ctrl+K** (or `/`): installed apps open on Enter, store apps show their page, settings sections jump straight there.

### The notification bell

The bell (bottom of the sidebar, a badge when something is unread) collects updates, warnings and
failures. Clicking a row marks it read and, for app rows, opens the app. Each row has a **×** to
dismiss it, and the panel header has **Dismiss all** to clear the list; **Mark all read** quiets the
badge without deleting anything. Dismissing deletes the row outright — a one-shot event (a failed
install) is gone for good, while a row for a problem that still exists (a missing drive) comes back
on the next check, because the condition is still true. When more than 30 rows pile up, a
**View all** button opens the full history in a dialog.

### 4c. Make it yours: arrange and customise the launcher

- **Arrange**: drag an icon with the mouse, or press and hold it on a phone, and drop it where you want it. *Arrange* (top right of Home) turns on a jiggle mode where the arrow keys also move the focused app; *Done* or Esc leaves it. The order is saved on the machine, so every device sees the same home screen.
- **Customize…** (in an app's details): give the app the name you use for it ("Photos" instead of "Immich") and pick an icon: the app's own, an emoji or two letters on a colour, or a picture of yours (≤ 1 MB). Also shown in search and in progress messages.
- **Hide from Home** (in an app's details): helpers without a page of their own (an MCP gateway, a
  document server) leave the launcher; Home shows a quiet *N hidden apps* to reach them, and they stay in
  the App Store, Publishing, Platform, `harbor list` and notifications. A package can suggest it
  (`presentation.hideFromHome`); your choice wins. API-only apps have no *Open* button, only addresses.
- **Wallpaper**: a fresh install starts with Bing's picture of the day (keyless, daily, credit on Home);
  offline it keeps the last picture or the flat preset. Existing installations keep their choice.
- CLI: `harbor look <app> --name Photos --glyph 📷 --color #3366ff`, `harbor look <app> --hide` / `--show`, `harbor look <app> --reset`; `harbor wallpaper`, `harbor wallpaper set --on --source bing|wikimedia|reddit [--subreddits a,b] [--every 24] [--reddit-client-id ID --reddit-secret-stdin]`, `harbor wallpaper next`; `harbor power restart|shutdown`.
- **Restart / Shut down** work because bootstrap installs a small polkit rule that lets the Harbor service account ask the system for exactly those two actions. On an installation bootstrapped before v0.5.0, run `sudo /opt/harbor/bin/harbor bootstrap --yes` once to add it; Settings tells you when it is missing.

Two things still need root on the machine, once: installing Tailscale (`bootstrap --with-tailscale`) and the public proxy (`bootstrap --with-public-proxy`). Settings shows the exact command when they are missing.

### If "Log in with Tailscale" says Harbor is not allowed to operate Tailscale

Disconnecting from the tailnet (`tailscale logout`) used to wipe the permission bootstrap gave the Harbor service account. Since v0.7.0 Harbor restores it by itself (a small root oneshot unit it may start). On an installation bootstrapped before that, run once: `sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale`.

## 4d. Your own apps and updates

- **Upload a package**: App Store → *+ Your own app* (or `harbor packages add my-app.zip`). A package is a zip with `manifest.yaml`, `compose.yaml`, optionally `README.md`, an icon and screenshots; see [DEVELOPER_PACKAGES.md](DEVELOPER_PACKAGES.md) for the template. Harbor validates it, pins the images by digest, and lists it under *Your apps*. Install it like any other app. Check a folder before you zip or push it with `harbor packages validate <folder>` (the daemon's own validators, offline, no login).
- **Update an app**: when a newer revision of its package exists (you uploaded one, or a Harbor upgrade shipped a newer built-in catalog), Home shows an *updates available* card and the app's tile gets a blue ↑. Press **Update**, review the plan (which images change, what is added), approve. Data, ports and addresses stay. If the new version fails to start, Harbor rolls back to the previous one automatically and tells you. CLI: `harbor list` (UPDATE column), `harbor update <name>`.
- **Remove an uploaded package**: from its App Store page once no app installed from it exists (`harbor packages remove <id>`).

### Values an app asks you for, and apps that talk to each other

- **A value only you have** (decision 125): some apps need something you already own — another
  service's access token, an SMTP password. The install review shows a password field for each; the
  value is kept like the secrets Harbor generates (a private file of that app, kept when you remove and
  reinstall it, deleted by *Uninstall completely*) and is never shown again — not in the console, the
  API, plans, logs or the tray. Change it later on the app's page (*Values you provided → Change…*).
  CLI: `harbor install <app> --secret <id>=@file` (or `<id>=-` to read stdin; on a terminal Harbor
  asks without echo), `harbor configure <app> --secret <id>=@file`. A value typed on the command line
  itself is refused (shell history).
- **Apps that talk to each other** (decision 126): apps are isolated from each other. An app that
  needs another one (an assistant that reads your documents app) declares a *link*; the install
  wizard asks which installed app provides it (*Talks privately to*; picked for you when there is only
  one). Harbor creates a private network for just these two — only the app that asked and the one
  service of the other app join it, never its database — with no route to the internet, and hands the
  app an address like `http://docs-link:3010`. The other app is not restarted. The app's page shows
  its links (*Change*, *Link*, *Unlink* for optional ones) and, on the other app, who reaches it;
  **Settings → Internal networks** lists every link on the machine. If you remove the providing app,
  the link is dropped and the app that used it shows *needs a provider* (bell, Home, its page) until
  you pick another one. Removing the app that asked drops the link too; Reinstall brings it back.
  CLI: `harbor install <app> --link <id>=<other-app>`, `harbor configure <app> --link <id>=<other-app>`
  (or `--unlink <id>`), `harbor links`.

## 4e. Updating Harbor itself

Settings → Overview shows the installed version and, when GitHub has a newer release, an **Update to
x.y.z** button (release notes underneath; *Check now* asks GitHub immediately, otherwise every 6 hours).
Harbor downloads the release, verifies its checksum, installs it in place and restarts; your apps keep
running, the console is away for about a minute and reconnects by itself. The same from the terminal:
`harbor self-update`, `harbor self-update check`, `harbor self-update start`. Manual path, still supported:
download the archive, extract, `sudo ./harbor-<version>-linux-x64/bin/harbor bootstrap --yes`.

If the new release fails to start, Harbor puts the previous one back by itself: the running
release is snapshotted before the update, the console is polled after the restart, and on
failure the snapshot is restored and the console comes back on the previous version (your
apps keep running throughout — they belong to Docker, not to the daemon). The Overview card
then says the update was rolled back. Manual downgrade, if you ever need it:
`sudo /opt/harbor/bin/harbor self-update apply --to <previous-version>` (state is kept;
migrations only add tables/columns, so the older release opens the newer database).

## 5. Service operations

```sh
systemctl status harbor          # daemon (user harbor, KillMode=control-group)
journalctl -u harbor -f          # JSON lines; no secrets or tokens are logged
systemctl restart harbor         # apps keep running; UI recovers after login
```

Restarting Harbor never stops application containers (they belong to Docker with
`restart: unless-stopped`). After a host reboot, desired-running apps come back through Docker;
intentionally stopped instances stay stopped. Harbor re-observes and reports actual readiness.
Sealed apps are the exception: they stay locked (and down) until the first login after the
reboot, and come back on their own once it happened — see §4a2 above.

## 6. Platform tools

- **Cockpit** (OS console): installed from Ubuntu repositories; `cockpit.socket` restricted to
  `127.0.0.1:9090`; log in with an OS account (not the Harbor administrator); self-signed certificate,
  so your browser will ask you to trust it once. Existing installations are bound as-is and not reconfigured.
- **Portainer CE** (Docker console): Compose project `hb_platform_portainer`, HTTPS on
  `127.0.0.1:9443` only, data volume `hb_platform_portainer_data` (retained), Docker socket mounted
  (full Docker authority: disclosed, not hidden). Create the Portainer admin in its first-run form
  within 5 minutes of start. Portainer 2.39 asks for a one-time **setup token** that it prints to its
  container log: `sudo docker logs hb_platform_portainer-portainer-1 2>&1 | grep setup_token`. If the
  5-minute window expires the instance locks itself; `sudo docker restart hb_platform_portainer-portainer-1`
  re-opens it and prints a new token. The tools card shows `setup_required` until the admin exists.
- Both cards report installed/not_installed/setup_required/unknown and reachable/unreachable/unknown
  with observation times. "Reachable" means the login page answers, nothing more.
- Bind existing tools: `harbor tools bind portainer --url https://localhost:9443/` (loopback URLs only).
- One-click install: when Cockpit or Portainer is absent, the Platform page shows **Set up** — one
  click starts `harbor-tools-install@<tool>.service` as root (polkit-allowed, same recipe as
  `--with-tools`) and the card reports requested → installing → installed/failed. Root equivalent
  on the terminal: `sudo /opt/harbor/bin/harbor tools-install cockpit|portainer`.
- Ordinary `harbor remove` cannot touch platform resources; they are not application instances.

## 6a. Publishing apps beyond localhost (exposure)

Without LAN mode everything stays bound to 127.0.0.1. Publishing adds an HTTPS address in front of the same port (the app keeps answering on its other addresses; see "Every address at once" above):

| Path | Address | Provider | Set up with |
|---|---|---|---|
| tailnet (private) | `https://<node>.<tailnet>.ts.net:<its own port>/` (taken from the top of the app range, never the app's own port: in LAN mode that port already answers plain HTTP on every interface, decision 133) | Tailscale (`tailscale serve`) | `sudo ... bootstrap --with-tailscale`, then `sudo tailscale up` and approve the login URL; enable **MagicDNS + HTTPS certificates** in the Tailscale admin console (DNS settings) |
| your own proxy | `https://<your hostname>/` | your reverse proxy (Nginx Proxy Manager, Traefik…) keeps the certificate | ports 80/443 already go to another machine: point the hostname's DNS at your home IP, forward it in your proxy to `http://<this machine's LAN IP>:<app port>` with WebSockets on, then **Publish… → Your own proxy** with the hostname and the proxy machine's LAN IP (`harbor expose <app> --via proxy --host <fqdn> --proxy-from <ip>`). Harbor only tells the app about the name and trusts forwarded headers from that IP |
| public | `https://<your hostname>/` | Caddy (Let's Encrypt) | `sudo ... bootstrap --with-public-proxy`; create an A/AAAA record for each hostname pointing at this host; ports 80 and 443 must be reachable from the internet |

```sh
harbor tools                                        # Tailscale / Public proxy cards say what is missing
harbor expose n8n --via tailnet                     # https://<node>.ts.net:18999/ (its own port)
harbor expose n8n --via public --host n8n.example.com --primary
harbor expose bentopdf --via public --host pdf.example.com          # basic auth by default (credentials shown once)
harbor expose bentopdf --via public --host pdf.example.com --protect none
harbor exposures                                    # all published addresses with state
harbor primary n8n loopback                         # main address back to "this network" (secure LAN when on)
harbor restart nextcloud                            # after turning secure addresses on/off: pick up today's addresses
harbor unexpose n8n --via public
harbor expose erp --via public --host erp.example.com --primary
harbor expose erp --via public --host customers.example.org        # a second domain for the same app
harbor primary erp public --host customers.example.org              # which domain is the main address
harbor unexpose erp --via public --host erp.example.com             # withdraw one domain, keep the other
harbor expose --ui --via tailnet                    # Harbor itself on your tailnet (never public)
```

In the console, the Publishing page and every running app's drawer have **Publish…** with the same
options; the Platform page shows Tailscale enrollment and proxy state.

Notes:

- Apps that embed their base URL (n8n's editor and webhook URLs) follow the **primary** address.
  Changing it recreates their containers with the same volumes, secrets and ports; data is untouched.
- Apps without their own login (Excalidraw, BentoPDF) get **basic-auth** protection on public
  addresses unless you opt out; the credentials are shown once and retained as an instance secret
  (`/var/lib/harbor/instances/<uuid>/secrets/exposure-basic-<endpoint>`).
- **One app, several domains** (decision 127): publish the same app again with another `--host`
  (console: *Publish…* → **Add another domain**). Each domain gets its own Caddy route, its own
  Let's Encrypt certificate and its own protection; a domain is used by one app only. The app's hook
  (Nextcloud's trusted domains, `HARBOR_ADDRESSES`) gets all of them; the base URL apps embed is the
  **main** one — the first domain published, or the one you pick with `harbor primary <app> public
  --host <fqdn>` (console: *Make primary* on that row). With several domains, `harbor unexpose`
  needs `--host` (Harbor never guesses which to withdraw); withdrawing the main domain makes the next
  remaining one main. Basic-auth domains of one app share its one generated password.
- An address shows `degraded` until DNS resolves and the certificate is issued; Harbor keeps
  re-checking and does not mark it `active` before it answers over HTTPS. The check asks for the
  app's own health page (e.g. `https://<host>/healthz` for an API-only app whose `/` answers 404)
  when you publish the endpoint that page lives on, and `/` otherwise.
- `remove <instance>` withdraws its addresses first and remembers them; the remove plan lists each one,
  and `reinstall` publishes them again with the same main address (a tailnet address gets a fresh port;
  a name another app took meanwhile is reported and skipped). `harbor unexpose` on a removed app forgets
  a remembered address; `purge` forgets all of them. Tailscale and Caddy entries Harbor did not create
  are never touched.
- Tailnet addresses published before 0.23.0 used the app's own port number. Harbor moves each one to its
  own port once after the upgrade (new entry first, old one removed after) and leaves a notification with
  the new address; an app whose main address is the tailnet one should be restarted so its links follow.
- The Harbor UI is loopback and tailnet only; the API refuses any public exposure of it.

### Publishing on the internet, step by step

1. **Settings → Public addresses** shows this machine's public address. Create an A (and, if shown, AAAA)
   record for your domain pointing at it. Behind a home router, forward ports 80 and 443 to this machine.
2. Add the domain in the same page. Harbor resolves it and says *Points here*, *Points elsewhere* (with
   the address it found) or *No DNS record yet*; *Re-check* after DNS has spread.
3. **Publishing** → *Publish…* on the app → *Public* → pick the domain. Caddy requests the Let's Encrypt
   certificate as soon as the address is added and renews it; the address is *pending* for a minute and
   then *active*. Apps without their own login get a generated password unless you opt out.

`harbor domains` prints the same table from the terminal.

## 7. Troubleshooting

| Symptom | What to do |
|---|---|
| `PORT_CONFLICT` at plan/submit | Another listener or a retained instance holds the port. `ss -ltnp`, or remove/reinstall retained instances. Harbor never stops the other listener. |
| `NAME_CONFLICT` | Pick another `--name`. |
| `PLAN_EXPIRED` (410) | Plans live 15 minutes. Create a new one. |
| `IDEMPOTENCY_CONFLICT` | The key was used for another request, or the plan was already submitted; poll the returned operation id. |
| `READINESS_TIMEOUT` | App did not answer within its manifest deadline. `harbor inspect`, `docker logs <container>`. Resources kept; `remove` to clean up. |
| "Harbor restarted since your last login: log in again before installing an encrypted app" | After Harbor restarts (an update, a reboot) your remembered browser session still works, but the key that lets this machine reopen encrypted apps at login is loaded only by a password login. Log out, log in with your password, and install again. Harbor refuses rather than sealing an app that only your recovery key could reopen. |
| `DATA_MISSING` / `SECRET_MISSING` | Retained volume or key gone/replaced. Restore from your backup; Harbor will not create replacements. For an app folder on a removable drive, see §4a1 (re-insert, restore with marker, or adopt the replacement). |
| `OWNERSHIP_CONFLICT` | A same-named resource exists that Harbor did not create for this instance. Inspect manually. |
| `DOCKER_UNAVAILABLE` (503) | `systemctl status docker`. |
| `http://harbor.local` stops resolving but `http://<ip>/` works | On the machine: `sudo systemctl restart avahi-daemon.socket avahi-daemon.service` (both — a service-only restart can leave avahi answering some queries and not others), then `avahi-resolve -n harbor.local` must print only the machine's LAN address; if it prints a `172.x` Docker address, re-run the installer (it pins avahi to the LAN interface). On a Mac that still fails: toggle Wi-Fi off/on, or `sudo launchctl kickstart -k system/com.apple.mDNSResponder`. `dig @224.0.0.251 -p 5353 harbor.local +short` from the client shows whether the box answers on the wire at all. |
| Home stays on "Loading your apps…" and public sites time out | Caddy stopped answering (seen once after turning secure addresses on, before 0.25.2). On the machine: `curl --max-time 5 http://127.0.0.1:2019/config/` hangs → `sudo systemctl restart caddy` (it comes back with its last good configuration). |
| Login 429 | Rate limited after repeated failures; wait ten minutes. |
| UI says "session ended" after reload | Expected unless you ticked *Remember this browser*: short sessions live in memory only. Log in again; running operations continue. |
| Public address stays `degraded` | Check `dig +short <hostname>` resolves to this host and that 80/443 are open in your cloud firewall; `journalctl -u caddy` shows certificate attempts. |
| Tailnet address stays `degraded` | `tailscale status` must show the node online; enable HTTPS certificates in the admin console; `tailscale serve status` lists Harbor's entries. |
| Portainer login page loads but no admin form, or the form refuses to submit | The 5-minute window expired (restart its container, above) or the setup token is missing (read it from the container log). |

**Report a problem:** run `harbor diagnostics` on the machine and paste the whole block into
your bug report (see `SECURITY.md` for what it contains — versions, host facts, app states,
disks, log tail; never secrets). File it at
`https://github.com/carlosalaniz/harbor/issues/new?template=bug.md`.

## 8. Trust boundary and limits (read this)

- The `harbor` service user is in the `docker` group and is therefore root-equivalent. The API is
  not a sandbox against anyone with Docker or root access.
- Loopback by default; LAN mode, tailnet and public HTTPS are opt-in providers (section 6a).
  The console itself is loopback + tailnet only, never public.
- Not included: backups of application data, multi-user roles/SSO, remote/community catalogs.

## 9. Uninstall

```sh
sudo /opt/harbor/bin/harbor uninstall        # previewed; stops the daemon, deletes Harbor-labelled
                                             # Docker objects (apps, platform tools), release/config/state,
                                             # units and the service account; frees every port
sudo /opt/harbor/bin/harbor uninstall --yes  # non-interactive
sudo /opt/harbor/bin/harbor uninstall --keep-data  # keep /var/lib/harbor (state, secrets, snapshots)
```

Your own folders are never deleted (`/srv/harbor` is removed only when empty). Docker Engine and the
Cockpit/Tailscale/Caddy packages stay installed. Non-Harbor Docker objects are never touched.

## 10. The catalog

Seventeen packages ship in this release (see docs/design/CATALOG.md for the selection rules and the
per-app first-run notes in each `catalog/<id>/README.md`):

| App | What it is | Notes |
|---|---|---|
| Excalidraw, BentoPDF | whiteboard, PDF tools | no accounts; basic auth when published |
| n8n | workflow automation with PostgreSQL | owner setup in the app |
| Open WebUI | private AI assistant with bundled Ollama (CPU) | first account is admin; pull a model |
| AnythingLLM | chat with documents, agents | onboarding wizard |
| Jellyfin | media server | `media` folder claim |
| Immich | photo backup | `library` folder claim; mobile app needs a published address |
| Nextcloud | files, calendar, contacts, office | `data` folder claim; keep "Install recommended apps" checked for Nextcloud Office (it follows the main address after you publish or change it; your own Collabora server is left alone) |
| Vaultwarden | password manager server | Bitwarden apps need HTTPS: publish it |
| Uptime Kuma | monitoring | – |
| Forgejo | Git forge | HTTPS clone only; registration closed |
| FreshRSS | feed reader | – |
| Actual Budget | budgeting | set a server password first |
| Audiobookshelf | audiobooks and podcasts | `audiobooks`, `podcasts` folder claims |
| Navidrome | music streaming | `music` folder claim (read-only) |
| Memos | notes | – |
| Mealie | recipes | default login `changeme@example.com` / `MyPassword`: change it |

`qualification` in `harbor catalog` tells you whether a package passed the live check on the
reference host (Ubuntu 24.04 x86-64) for the pinned image digests; `pending`/`blocked` packages can
still be installed, the status is shown honestly in the CLI and the console.
