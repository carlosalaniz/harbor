# Harbor operator guide (local preview)

Harbor installs a few self-hosted applications on one Ubuntu machine as ordinary Docker Compose
projects, allocates non-conflicting loopback ports, checks readiness, and remembers what it owns.
This release is a **trusted local preview**: one administrator, loopback only, one daemon with
Docker (root-equivalent) authority. It is not a hardened multi-user management service.

## 1. Requirements

| Item | Requirement |
|---|---|
| Host | Ubuntu 24.04 LTS, x86-64, systemd |
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

On a machine (or VM) running Ubuntu 24.04 x86-64, from a terminal on it (SSH or keyboard):

```sh
curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash
```

It checks the machine, installs Docker if needed, downloads the newest release from GitHub and verifies its
checksum, names the machine `harbor` (so it answers as **http://harbor.local** on your network through mDNS),
installs Tailscale and the HTTPS proxy, and prints a **setup code**. Then open the printed address in a
browser and follow the wizard: name your Harbor, create your account (type the code), pick a look. Nothing
is typed on the terminal.

- `HARBOR_HOSTNAME=mybox` changes the mDNS name (`http://mybox.local`); `HARBOR_HOSTNAME=` keeps the current one.
- `HARBOR_LAN=off` keeps LAN mode off (console and apps then answer only on the machine, over Tailscale, or via SSH forwarding). On a cloud server LAN mode stays off automatically: there, "every interface" would be the public internet.
- `HARBOR_TOOLS=1` also sets up Cockpit and Portainer. `HARBOR_VERSION=<version>` pins a release (e.g. `HARBOR_VERSION=0.12.5`).
- Lost the setup code? On the machine: `sudo /opt/harbor/bin/harbor setup-code --config /etc/harbor/harbor.json`.

**LAN mode** means the console (port 80) and every app port answer to any device on your local network,
like Umbrel. Protect the console with a strong password and two-factor login (Settings → Account); apps
without their own login are open to the LAN. It is chosen at install time (`bootstrap --lan`); apps
installed before it was turned on keep answering on the machine only until they are updated.

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

1. verifies Ubuntu 24.04 / x86-64 / systemd / root and detects existing Harbor, Docker, Cockpit, Portainer;
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
harbor install excalidraw         # shows the plan (ports, storage, images) and asks to apply
harbor install excalidraw --name whiteboard-2 --yes --no-wait
harbor list / inspect <name-or-id> / operation <id> --follow
harbor stop <name> / start <name>
harbor remove <name>              # deletes containers + private network; RETAINS volumes, secrets, name, ports
harbor reinstall <name>           # exact same release into the retained instance
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
- **Application data** — the databases, photos, files and workflows inside the apps. Harbor never
  backs these up. Managed Docker volumes live on the engine; drive apps live on their drive.

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

### Failure states

- `failed` install: resources are kept for inspection (`harbor inspect`); use `remove` to clean up.
- `needs_action`: an operation was interrupted (daemon restart) or an ownership/data check failed.
  Nothing is replayed automatically. Inspect, then `stop`/`remove`/`reinstall` after confirming ownership.
- Docker unavailable: instances show `unavailable`/`unknown`, never a stale `healthy`.

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
## 4a2. Install a whole app on a drive (encrypted, portable)

Some apps keep everything in a database that cannot live in one of your own
folders — and on a machine with tiny onboard storage even the database needs to
move. At install time the wizard asks **where the app should live**: **Local**
(encrypted on this machine in the Harbor data folder — Harbor unlocks it
silently when you log in, nothing to remember) or **External drive** (encrypted,
portable with a passphrase). A removable-drive choice asks for an **encryption
passphrase** (8+ characters, or a generated recovery key) — write it down;
losing it loses the data. The Local choice needs no passphrase; *Use my own
passphrase instead…* opts into one (needed only to open the app on another
Harbor machine). The review step names the encrypted home and warns about the
drive and the passphrase.

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

A locked app (this machine holds no key for it — after a reboot, before the
first login) shows a quiet *Locked* tile; its drawer says so and, for a
custom-passphrase app, offers the unlock form. Data-folder apps unlock at the
next login; drive apps with a custom passphrase need the passphrase (or adopt)
on a new machine. **Lock** (drawer button while the app is stopped, or
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

CLI: `harbor install <package> --location /mnt/photos/harbor-apps/immich --passphrase-stdin < passphrase.txt`
(omit the passphrase for the Harbor data folder), `harbor lock <app>` / `harbor unlock <app>`, `harbor found-apps`,
`harbor adopt <home-folder>`.
## 4b. Settings in the console (for people who do not use a terminal)

The console's **Settings** page covers what a household operator needs after bootstrap:

| Section | What you can do |
|---|---|
| Account | change the administrator password (every other logged-in browser or CLI is signed out); *Remember this browser* (30-day session), the session list, *Log out of other sessions*, *Log out* |
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

The same actions exist as commands: `harbor account set-password`, `harbor tailscale login [--authkey-stdin]`, `harbor tailscale logout`, `harbor storage`, `harbor domains [add|check|forget]`, `harbor purge`.

Search everything with **⌘K / Ctrl+K** (or `/`): installed apps open on Enter, store apps show their page, settings sections jump straight there.

### 4c. Make it yours: arrange and customise the launcher

- **Arrange**: drag an icon with the mouse, or press and hold it on a phone, and drop it where you want it. *Arrange* (top right of Home) turns on a jiggle mode where the arrow keys also move the focused app; *Done* or Esc leaves it. The order is saved on the machine, so every device sees the same home screen.
- **Customize…** (in an app's details): give the app the name you use for it ("Photos" instead of "Immich") and pick an icon: the app's own, an emoji or two letters on a colour, or a picture of yours (≤ 1 MB). Also shown in search and in progress messages.
- CLI: `harbor look <app> --name Photos --glyph 📷 --color #3366ff`, `harbor look <app> --reset`; `harbor wallpaper`, `harbor wallpaper set --on --source bing|wikimedia|reddit [--subreddits a,b] [--every 24] [--reddit-client-id ID --reddit-secret-stdin]`, `harbor wallpaper next`; `harbor power restart|shutdown`.
- **Restart / Shut down** work because bootstrap installs a small polkit rule that lets the Harbor service account ask the system for exactly those two actions. On an installation bootstrapped before v0.5.0, run `sudo /opt/harbor/bin/harbor bootstrap --yes` once to add it; Settings tells you when it is missing.

Two things still need root on the machine, once: installing Tailscale (`bootstrap --with-tailscale`) and the public proxy (`bootstrap --with-public-proxy`). Settings shows the exact command when they are missing.

### If "Log in with Tailscale" says Harbor is not allowed to operate Tailscale

Disconnecting from the tailnet (`tailscale logout`) used to wipe the permission bootstrap gave the Harbor service account. Since v0.7.0 Harbor restores it by itself (a small root oneshot unit it may start). On an installation bootstrapped before that, run once: `sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale`.

## 4d. Your own apps and updates

- **Upload a package**: App Store → *+ Your own app* (or `harbor packages add my-app.zip`). A package is a zip with `manifest.yaml`, `compose.yaml`, optionally `README.md`, an icon and screenshots; see [DEVELOPER_PACKAGES.md](DEVELOPER_PACKAGES.md) for the template. Harbor validates it, pins the images by digest, and lists it under *Your apps*. Install it like any other app.
- **Update an app**: when a newer revision of its package exists (you uploaded one, or a Harbor upgrade shipped a newer built-in catalog), Home shows an *updates available* card and the app's tile gets a blue ↑. Press **Update**, review the plan (which images change, what is added), approve. Data, ports and addresses stay. If the new version fails to start, Harbor rolls back to the previous one automatically and tells you. CLI: `harbor list` (UPDATE column), `harbor update <name>`.
- **Remove an uploaded package**: from its App Store page once no app installed from it exists (`harbor packages remove <id>`).

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

Everything stays bound to 127.0.0.1. Publishing adds an HTTPS address in front of the same port:

| Path | Address | Provider | Set up with |
|---|---|---|---|
| tailnet (private) | `https://<node>.<tailnet>.ts.net:<same port>/` | Tailscale (`tailscale serve`) | `sudo ... bootstrap --with-tailscale`, then `sudo tailscale up` and approve the login URL; enable **MagicDNS + HTTPS certificates** in the Tailscale admin console (DNS settings) |
| public | `https://<your hostname>/` | Caddy (Let's Encrypt) | `sudo ... bootstrap --with-public-proxy`; create an A/AAAA record for each hostname pointing at this host; ports 80 and 443 must be reachable from the internet |

```sh
harbor tools                                        # Tailscale / Public proxy cards say what is missing
harbor expose n8n --via tailnet                     # https://<node>.ts.net:18086/
harbor expose n8n --via public --host n8n.example.com --primary
harbor expose bentopdf --via public --host pdf.example.com          # basic auth by default (credentials shown once)
harbor expose bentopdf --via public --host pdf.example.com --protect none
harbor exposures                                    # all published addresses with state
harbor primary n8n loopback                         # which address the app treats as its base URL
harbor unexpose n8n --via public
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
- An address shows `degraded` until DNS resolves and the certificate is issued; Harbor keeps
  re-checking and does not mark it `active` before it answers over HTTPS.
- `remove <instance>` withdraws its addresses first. Tailscale and Caddy entries Harbor did not
  create are never touched.
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
| `DATA_MISSING` / `SECRET_MISSING` | Retained volume or key gone/replaced. Restore from your backup; Harbor will not create replacements. For an app folder on a removable drive, see §4a1 (re-insert, restore with marker, or adopt the replacement). |
| `OWNERSHIP_CONFLICT` | A same-named resource exists that Harbor did not create for this instance. Inspect manually. |
| `DOCKER_UNAVAILABLE` (503) | `systemctl status docker`. |
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
| Nextcloud | files, calendar, contacts, office | `data` folder claim; keep "Install recommended apps" checked for Nextcloud Office |
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
