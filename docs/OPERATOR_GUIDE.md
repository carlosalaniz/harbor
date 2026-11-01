# Harbor operator guide (local preview)

Harbor installs a few self-hosted applications on one Ubuntu machine as ordinary Docker Compose
projects, allocates non-conflicting loopback ports, checks readiness, and remembers what it owns.
This release is a **trusted local preview**: one administrator, loopback only, one daemon with
Docker (root-equivalent) authority. It is not a hardened multi-user management service.

## 1. Requirements

| Item | Requirement |
|---|---|
| Host | Ubuntu 24.04 or 26.04 LTS, or Debian 12/13, x86-64, systemd. Debian/Ubuntu derivatives (Linux Mint, Pop!_OS, Raspberry Pi OS, …) usually work but are not tested: bootstrap refuses them unless you pass `--force` (one-line installer: `HARBOR_FORCE=1`). |
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
24.22.1 bundled since 0.37.1 (the October 2026 Node.js security release; the last fresh-host qualification ran
with 24.12.0).

## 2. Install

### 2a. The one-line installer (recommended)

On a machine (or VM) running Ubuntu 24.04/26.04 or Debian 12/13 x86-64, from a terminal on it (SSH or keyboard):

```sh
curl -fsSL https://raw.githubusercontent.com/carlosalaniz/harbor/main/install.sh | sudo bash
```

It checks the machine, installs Docker if needed, downloads the newest release from GitHub and verifies its
signature (0.32.0 and later: `SHA256SUMS.sig`, Harbor's release key is built into the installer; it stops if
the signature is missing or wrong) and its checksum, names the machine `harbor` (so it answers as **http://harbor.local** on your network through mDNS),
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
  Releases older than 0.32.0 are not signed: the installer refuses them unless you add `HARBOR_ALLOW_UNSIGNED=1`
  next to `HARBOR_VERSION` (it then warns loudly). A local `HARBOR_ARCHIVE` needs its `SHA256SUMS.sig` next to
  it; for an archive you built yourself without a signing key, extract it and run
  `sudo ./harbor-<version>-linux-x64/bin/harbor bootstrap --yes` instead. A signature that is there but does not
  match is always refused.
- Lost the setup code? On the machine: `sudo /opt/harbor/bin/harbor setup-code --config /etc/harbor/harbor.json`.
- The setup page's status route (`GET /v1/setup`) needs no login. Once the administrator exists it only says
  that setup is done and whether HTTPS is on, with its addresses (the login page uses them to move you to
  https). The version, machine name, LAN address and remote-access state are shown only after you log in.

**LAN mode** means the console (port 80) and every app port answer to any device on your local network,
like Umbrel. Protect the console with a strong password and two-factor login (Settings → Account); apps
without their own login are open to the LAN. It is chosen at install time (`bootstrap --lan`); apps
installed before it was turned on keep answering on the machine only until they are updated.
If the machine runs **ufw** (Ubuntu's firewall), bootstrap allows what LAN mode needs — the console port,
443, the app ports and their secure twins (port + 20000), and mDNS — from private networks only, on every
install and update (`sudo ufw status` lists them with the comment `harbor`; `harbor uninstall` removes them).
Other firewalls (firewalld, your router) are yours to open.

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

**Apps keep their logins to themselves (0.32.0, decision 167).** On your network every app lives at
`harbor.local:<port>`, and browsers share cookies between ports of one name. Over the secure addresses,
Harbor's relay renames and signs each app's login cookies (`HttpOnly` ones), so another app on this
Harbor never receives them and cannot fake them, and it refuses a form or WebSocket sent from one app's
page to another's. Cookies an app's own scripts read are left as they are. Limits: plain-http app
addresses do not go through the relay (turn on *HTTPS only* below); a login made before 0.32.0 is
cleared from the browser the next time that app sets its cookie (logging out and in once does it right
away, and also ends the old session on the app's side); Tailscale addresses are not covered yet. The signing key is `<state dir>/cookie-firewall.key`: stop Harbor, delete it and start
Harbor again to log every browser out of every app once.

**HTTPS only** (Settings → Network, under Secure addresses; `harbor network https-only on|off`). Once
every device you use trusts the certificate, this closes the plain-http doors: `http://harbor.local/`
answers every request with a redirect to `https://` (except the certificate download and the probe, so
a new device can still fetch the certificate), and each app answers only on its secure address. Apps
switch when they restart: the card and the CLI name the ones that still need it, every time you open them. It can only be turned
on from a page opened over https (or on the machine itself), so you cannot lock yourself out from a
browser that never reached the https console; turning it off always works, and turning secure
addresses off turns it off too (apps it moved then need a restart to get their plain address back).

### 2b. Manual install (bootstrap)

Running `bootstrap` without `--password-stdin` on a machine that has no administrator yet leaves it in setup mode: it prints the setup code and the wizard creates the account in the browser.

```sh
# on your workstation
scp release/harbor-<version>-linux-x64.tar.gz release/SHA256SUMS release/SHA256SUMS.sig user@host:
# on the host: the signature first (0.32.0 and later; harbor-release-key.pem = the public key in install.sh
# or src/release-keys.ts), then the checksum
openssl base64 -d -A -in SHA256SUMS.sig -out SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey harbor-release-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum -c SHA256SUMS
tar -xzf harbor-<version>-linux-x64.tar.gz
sudo ./harbor-<version>-linux-x64/bin/harbor bootstrap [--install-docker] [--with-tools] [--port 18000]
```

Bootstrap previews every step and asks for approval (or `--yes`). It:

1. verifies the distro (Ubuntu 24.04/26.04 / Debian 12/13, or a derivative with `--force`) / x86-64 / systemd / root, checks that every system tool it will call is present, and detects existing Harbor, Docker, Cockpit, Portainer;
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
(addresses in three groups: *On the internet* with your domains, broken ones first; *On your tailnet*,
a compact list under the tailnet hostname with the Harbor console toggle; *Not published*, running apps
with no address yet), **Platform** (Docker, Cockpit,
Portainer, Tailscale, proxy with real state and links; Cockpit and Portainer show a **Set up**
button when absent — one click starts the install as root and the card reports progress),
**Settings** (session, SSH forwarding line,
about). Every change goes through the same plan review; the queue at the bottom right shows what runs, what
waits its turn and what just finished, with, once, any generated credentials (see *The queue* below).

CLI (`harbor`; bootstrap links `/usr/local/bin/harbor` to `/opt/harbor/bin/harbor` since 0.28.2, and never replaces a file of yours there):

```sh
harbor login                      # prompts without echo; token stored 0600 in ~/.config/harbor
harbor catalog
harbor catalog status             # which app catalog is in use, when Harbor last looked for a newer one
harbor catalog refresh            # look now (same as App Store → Check for new apps)
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
harbor queue                      # what runs now, what waits (in order) and what finished lately
harbor queue cancel <operation>   # take a waiting item out of the queue (nothing is changed)
harbor tools / tools bind cockpit --url https://localhost:9090/
harbor doctor
```

**A second copy of an app** (decision 170). Once an app is installed its Store card and its page say
**Open** (the copy you have; when it is not running, Open shows its page in Harbor instead). An app that
allows copies also offers **Add another copy…**: the install page then says *You already have Immich. This
installs a separate copy with its own data, address and login; the first one is not touched.* and asks for
the copy's name, prefilled with the next free one (`immich-2`). Home names each copy under its icon, so the
copies stay apart. An app that runs one copy per machine (a VPN server with a fixed port, for example) has no
second Install at all; when its only copy was removed with its data kept, its card and its page offer
**Reinstall…** (restoring a backup of it says the same: reinstall or fully uninstall that copy first).
The install review repeats the line, and `harbor install` prints it too; `harbor install immich --name photos-2`
names the copy from the terminal, and `harbor catalog` shows `one` or `many` under COPIES.

Exit codes: 0 success, 1 operation failed, 2 invalid request, 3 conflict/action required,
4 dependency unavailable, 5 authentication. `--json` for machine-readable output.

States: **install** installing/installed/failed/needs_action/retained · **desired**
running/stopped/retained · **runtime** running/stopped/starting/unavailable/unknown ·
**readiness** healthy/unhealthy/checking/unknown. `installed`+`healthy` means the app answers its
readiness URL. It does **not** mean the app's own onboarding is done: n8n shows separate setup guidance.

### The queue (since 0.35.0)

Harbor does one thing at a time, but you never have to wait to ask for the next one. No button is greyed out
because something else is running: what you approve joins the **queue** and runs in turn.

- **Another app is busy.** Review and approve as usual; the item waits in the queue and runs when its turn comes.
- **The same app is busy** (installing, updating, …). *Start*, *Stop*, *Restart*, *Update*, *Remove*, *Reinstall*
  and *Uninstall completely* stay on its page and ask once (*Queue: Update Immich*, "Harbor is installing Immich right
  now. Harbor will update it as soon as that finishes, planning it then."), then join the queue without a plan. When
  its turn comes Harbor makes the plan against the app as it is then and runs it, the way automatic updates do. If
  that plan needs something only you can give (a new permission to accept, a value to type, a passphrase), the item
  stops as **Needs your review** and nothing changes: open the app and choose the action again to review it. The same
  action already last in line is not queued twice (*Already queued: Update Immich*, with its Cancel; *Already running*
  for an update in progress), and the page offers what fits after what is queued (after a waiting Stop: Start, not
  Restart). Other changes
  (publishing, settings, moving, restoring), and any review where you already typed a value or ticked a permission,
  wait for the app in their review, then show the plan again.
- **The queue** sits at the bottom right: the running item with its progress, the waiting items in the order they
  will run, and finished items: what you started here (whatever happened), anything that shows a password or
  recovery words once, and anything that failed. Background work that went fine (a nightly backup, an automatic
  update) leaves by itself. Fold the queue to one line, close an item with ×, or **Clear finished** (a password or
  recovery words stay until you acknowledge them).
- **Cancel** takes a waiting item out before it starts; nothing is changed. A cancelled install frees its name and
  ports and cancels what you queued behind it for that app; a cancelled adopt leaves the app on the drive ready to
  adopt again. A running item cannot be stopped halfway. Items Harbor queued itself to protect an app (a stop because
  its drive disappeared, a link repair, a lock, a backup's last pass) cannot be cancelled; the queue says why.
- **If Harbor restarts or stops**, items that had not started yet are cancelled (nothing was changed; queue them
  again); the one that was running stops as *Needs attention* as before.

`harbor queue` shows the same list (`--json` for scripts) and `harbor queue cancel <operation>` cancels a waiting item.
On a busy app, `harbor start|stop|restart|update|remove|reinstall|purge` offers to queue the action (`--yes` accepts);
with `--accept-permissions`, `--passphrase-stdin` or values (`--set`, `--secret`, `--link`, storage) it waits for the
app instead, then plans and asks as before. `harbor start` on a locked app asks for its passphrase (or reads
`--passphrase-stdin`), unlocks it for this boot and starts it, busy or not. New accounts cannot be called like one of
Harbor's own actors (`scheduler`, `auto-update`, `drive-guard`, …); an existing one should be renamed, because its
queued items would read as Harbor's own and could not be cancelled.

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

**1. Add a place** (Settings → Backups → *Add a place*, or App Store → *Backup places* tab):

| Place | You fill in | Notes |
|---|---|---|
| Another disk | a folder under `/mnt/…` or `/media/…` (a mounted drive) | fast; same house as the original |
| S3-compatible | endpoint, bucket, folder, access key ID + secret | Backblaze B2, Cloudflare R2, Wasabi, AWS, MinIO; a bucket with object lock keeps backups even a hacked machine cannot delete |
| SFTP server | server, port, user, folder, a private key (no passphrase) | put the key's public half in the server's `authorized_keys`; Harbor shows the server key's fingerprint and pins it only after you click **Trust this key** (compare it first: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server). CLI: `harbor backup add sftp NAS … --host-key SHA256:…`, or answer *yes* at the prompt |
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

In the console, open **Advanced** on the install page and tick *Keep … in a folder of my own (not
encrypted)* for the claim, then choose the folder. Without that, the data lives inside the app's
encrypted home like everything else.

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
are never touched (a disk that holds anything the system runs from is never listed as removable,
whatever the hardware reports). Drives are mounted `nosuid,nodev`: a program or device file on a
drive never gains extra rights from it. A drive is never mounted on top of another one: if
`/mnt/<label>` already holds a drive, Mount says so — eject that one or give the new drive another label.

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
move. The install page shows one **Storage** line: where the whole app will live
(*This machine* or a drive, with its free space and, when the package says, how
much room the app needs) and *Encrypted — unlocks automatically when you sign in*.
*Change* lists this machine and every drive in one list (a drive that is not
mounted, or not ext4, offers *Mount it* or *Format as ext4…* right there). Apps
that keep a media library (Immich, Jellyfin, Nextcloud, …) start out on the
plugged-in drive with the most free space, when it has more room than this
machine; everything else starts on this machine. Either way the app is sealed, this machine unlocks it when you log in,
and your Harbor recovery key opens it on any other machine. Neither choice asks
you to invent a passphrase.

The **Access** line says who can reach the app right after install (*Only you, on
this machine*, or *Devices on your home network* in LAN mode); its *Change* picks
the main address (Tailscale or a domain also publishes it there; a domain another
app already uses is not offered). The review step that follows repeats the same
two lines — where it lives and who can reach it — and keeps the exact path and
every step under *Exactly what Harbor will do*. Everything else
— instance name, your own passphrase, your own folders, versions and the exact
path — is under **Advanced**.

*Use my own passphrase instead…* (under Advanced) opts into one, for either location. Give an app
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
machine, the way you would a spare house key. When an install issues words (the Harbor key the
first time, or an app's own words), the tray shows them; Harbor keeps them in memory for a day and
never writes them to its database, so a daemon restart before you have copied them loses them —
then make new ones (*Replace it…* below, or *Change passphrase…* for an app's own words). Settings → Account tells you
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

A browser that stayed logged in (*Stay logged in on this browser*) does not skip this step: after a
reboot, or any restart of Harbor itself (a Harbor update included), it opens on a **lock screen** that
asks only for your password, like a phone after a restart. The password unlocks every data-folder app
and lets the nightly backups run again; your session is kept, so nothing else is logged out. From the
CLI: `harbor account unlock`. While an app is still locked, Harbor refuses to update, repair or
reinstall it (it asks for the password first), because those steps would delete its containers and
then find no readable data to start them on. An app set to update automatically waits the same way: its
update runs once the password is back.

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
| Network | **secure addresses** on your home network: turn on HTTPS for Harbor and every app (`https://harbor.local/` with no warning once each device trusts the one Harbor certificate); the card shows whether *this* browser already trusts it, and *How to trust it on a new device…* walks through macOS, iOS (install the profile, then enable full trust), Windows, Android and Linux, plus the Firefox note. Once a browser trusts the certificate, opening `http://harbor.local/` moves to `https://harbor.local/` by itself (Harbor checks the browser really trusts it first, so an untrusted device stays on http with no warning page). To stay on plain http in one tab anyway, add `?skiphttps` to the address (`http://harbor.local/?skiphttps`); `?skiphttps=false` undoes it. Apps open with the same scheme as the console: from an http console their plain http address, from https their secure one. The certificate can only vouch for this machine's `.local` names, its own name and private addresses — never another website. A certificate from Harbor 0.30 or older could vouch for any site: the card then says so and offers *Replace certificate…* (`harbor network replace-ca`); trust the new one once per device afterwards. Harbor answers its console names only to devices on your own network, even when a public domain is published |
| Remote access | connect this machine to your Tailscale tailnet by clicking *Log in with Tailscale* (opens the approval page) or by pasting an auth key; see the node name; turn *Harbor on your tailnet* on or off; **Every app on Tailscale** (give every app its own tailnet address, see §6a); **Apps on Tailscale** (tick the apps that get an address, *Select all* / *Select none*, review and apply in one go); log out of the tailnet |
| Public addresses | the wizard for publishing on the internet: this machine's public address, your domains with a DNS check (*Points here* / *Points elsewhere* / *No DNS record yet*), which app uses each, re-check and forget; certificates are automatic |
| Remote access (details) | tailnet addresses, node key expiry, link to the Tailscale admin console; the auth key you used is single-use and is not stored |
| Storage | disks with free space, removable drives (mount/eject, auto-mount/auto-start toggles), the Harbor data folder (`/srv/harbor`, where Harbor may create folders for you), folders currently used by apps, and a folder browser with *Create folder here* |
| Overview | the landing page: the **Harbor version first**, with *Update to x.y.z* when a release is out, then your machine's name, what it runs on, uptime, storage/memory/temperature, *Restart* and *Shut down* (each asks first), the Look picker and the automatic app-update default |
| Appearance | **Look**: Harbor in *Auto* (follows the device), *Light* or *Dark*, over the *Picture of the day* (or your own picture) or flat *Harbor*; *Readability over pictures* (how solid cards are, per browser); your own picture (PNG/JPEG/WebP up to 6 MB), or **rotating wallpapers**: Harbor itself fetches a new picture on a schedule from Bing or Wikimedia Commons (no account) or from your favourite subreddits (needs a free Reddit "script" app key; Settings walks you through it). The picture and its credit show on Home. Harbor downloads pictures over https only and never from an address on this machine or your home network, not even when a site redirects there. |
| Advanced access | a **terminal** on the machine (shell of the Harbor service account: `docker`, `harbor …`), the SSH forwarding lines with copy buttons, and the CLI equivalents. An open terminal closes when its session ends: logging out, *Log out other sessions*, a password change (every other session) or the session expiring |
| Troubleshoot | Harbor's own log (systemd journal) and each app's container logs, copyable |
| Account (two-factor) | turn on a 6-digit authenticator code at login (QR code or typed key); turn off with the password; lost the app? on the machine: `sudo /opt/harbor/bin/harbor account totp reset --local --config /etc/harbor/harbor.json` |
| Overview (name) | rename the machine (shown in Settings and the browser tab) |

The same actions exist as commands: `harbor account set-password`, `harbor account name [name]` (show or set the Home greeting name; empty clears it), `harbor tailscale login [--authkey-stdin]`, `harbor tailscale logout`, `harbor tailscale every-app [on|off]`, `harbor network https` / `harbor network https on|off` / `harbor network ca`, `harbor storage`, `harbor domains [add|check|forget]`, `harbor purge`.

On a desktop the section list and the section scroll separately. On a phone Settings opens as a list;
tap a section to open it, and *‹ Settings* goes back.

Search everything with **⌘K / Ctrl+K** (or `/`): installed apps open on Enter, store apps show their page, settings sections jump straight there.

### The notification bell

Email delivery (Settings → Notifications → channels): when you give the mail server a user and password,
Harbor sends them only inside TLS, either *secure* (implicit TLS, usually port 465) or STARTTLS that the
server offers on 587. A server that offers neither gets no password and the test says so. The from and to
addresses are one line each.

The bell (bottom of the sidebar, a badge when something is unread) collects updates, warnings and
failures. Clicking a row marks it read and, for app rows, opens the app. Each row has a **×** to
dismiss it, and the panel header has **Dismiss all** to clear the list; **Mark all read** quiets the
badge without deleting anything. Dismissing deletes the row outright — a one-shot event (a failed
install) is gone for good, while a row for a problem that still exists (a missing drive) comes back
on the next check, because the condition is still true. When more than 30 rows pile up, a
**View all** button opens the full history in a dialog.

Each notification brings its own button: *Harbor x.y.z is available* → **Install now** (opens Overview
with the update's confirm), an app update → **Update now** (the usual review), a failed backup →
**Back up now** and **Open Backups**, a drive or full disk → **Open Storage**, an app that stopped
answering → **Open app**, a channel that failed → **Check channels**. On a phone the bell lives in the
bottom bar as the *Alerts* tab, with the unread count on it.

### 4c. Make it yours: arrange and customise the launcher

- **Arrange**: drag an icon with the mouse, or press and hold it on a phone, and drop it where you want it. *Arrange* (top right of Home) turns on a jiggle mode where the arrow keys also move the focused app; *Done* or Esc leaves it. The order is saved on the machine, so every device sees the same home screen.
- **Customize…** (in an app's details): give the app the name you use for it ("Photos" instead of "Immich") and pick an icon: the app's own, an emoji or two letters on a colour, or a picture of yours (≤ 1 MB). Also shown in search and in progress messages.
- **Hide from Home** (in an app's details): helpers without a page of their own (an MCP gateway, a
  document server) leave the launcher; Home shows a quiet *N hidden apps* to reach them, and they stay in
  the App Store, Publishing, Platform, `harbor list` and notifications. A package can suggest it
  (`presentation.hideFromHome`); your choice wins. API-only apps have no *Open* button, only addresses.
- **Wallpaper**: a fresh install starts with Bing's picture of the day (keyless, daily, credit on Home);
  offline it keeps the last picture or flat Harbor. The other backgrounds are flat *Harbor* (light or dark,
  with the theme) and your own picture; the old Dusk/Forest/Plain presets are gone (a browser that had one
  shows the picture).
- CLI: `harbor look <app> --name Photos --glyph 📷 --color #3366ff`, `harbor look <app> --hide` / `--show`, `harbor look <app> --reset`; `harbor wallpaper`, `harbor wallpaper set --on --source bing|wikimedia|reddit [--subreddits a,b] [--every 24] [--reddit-client-id ID --reddit-secret-stdin]`, `harbor wallpaper next`; `harbor power restart|shutdown`.
- **Restart / Shut down** work because bootstrap installs a small polkit rule that lets the Harbor service account ask the system for exactly those two actions. On an installation bootstrapped before v0.5.0, run `sudo /opt/harbor/bin/harbor bootstrap --yes` once to add it; Settings tells you when it is missing.

Two things still need root on the machine, once: installing Tailscale (`bootstrap --with-tailscale`) and the public proxy (`bootstrap --with-public-proxy`). Settings shows the exact command when they are missing.

### If "Log in with Tailscale" says Harbor is not allowed to operate Tailscale

Disconnecting from the tailnet (`tailscale logout`) used to wipe the permission bootstrap gave the Harbor service account. Since v0.7.0 Harbor restores it by itself (a small root oneshot unit it may start). On an installation bootstrapped before that, run once: `sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale`.

## 4d. Your own apps and updates

- **Upload a package**: App Store → *+ Your own app* (or `harbor packages add my-app.zip`). A package is a zip with `manifest.yaml`, `compose.yaml`, optionally `README.md`, an icon and screenshots; see [DEVELOPER_PACKAGES.md](DEVELOPER_PACKAGES.md) for the template. Harbor validates it, pins the images by digest, and lists it under *Your apps*. Install it like any other app. Check a folder before you zip or push it with `harbor packages validate <folder>` (the daemon's own validators, offline, no login).
- **Versions** (0.33.0): App Store cards and the app's page show the app's own version (*v0.12.0*), next to Harbor's package revision (*rev 3*, which only counts Harbor's releases of the package). `harbor list` has a VERSION column, `harbor catalog` too.
- **Update an app**: when a newer revision of its package exists (you uploaded one, or a newer official catalog arrived — see below), Home shows an *updates available* card and the app's tile gets a blue ↑, with the versions it moves between (*v0.11.3 → v0.12.0*); its App Store card and Store page say *Update available* and lead with an **Update** button (0.33.1). Press **Update**, review the plan (which images change, what is added), approve. Data, ports and addresses stay. If the new version fails to start, Harbor rolls back to the previous one automatically and tells you. CLI: `harbor list` (UPDATE column), `harbor update <name>`.
- **Automatic updates** (the app's page: *Update this app automatically…*; off by default; Settings → Overview sets the default for new installs): Harbor updates the app by itself when a new version arrives. If the app backs up somewhere (its Backups tab), Harbor makes a fresh backup first and only then updates, so a new version that changes the app's data can still be undone by restoring that backup. If the backup fails, the update waits (notification *… was not updated automatically*, with the reason) and Harbor tries again a few hours later; *Update now* skips the backup. A finished automatic update says so in Notifications (*… was updated automatically*); a failed one is rolled back and reported, and Harbor does not try that version again (even after a restart) until a newer one arrives.
- **Remove an uploaded package**: from its App Store page once no app installed from it exists (`harbor packages remove <id>`).

### Where the built-in apps come from (the official catalog)

- The built-in apps live in their own repository, [harbor-apps](https://github.com/carlosalaniz/harbor-apps).
  Each change there is published as a new catalog on that repository's GitHub releases. Harbor downloads
  it over HTTPS from GitHub, the same way it downloads its own updates. Since 0.32.0 (decision 168) it only
  uses a catalog signed with Harbor's release key (`catalog.json.sig`, the same key that signs Harbor
  releases): an unsigned or badly signed one is refused ("refusing the app catalog …" under *App catalog
  from …* and in `harbor catalog status`) and the box keeps the catalog it has. It only
  uses a catalog that arrived complete (its archive matches the checksum in its `catalog.json`), whose
  apps all validate, that is newer than the one it has, and that is not dated more than a day ahead of
  the machine's clock. Anything else is ignored and the current catalog stays. If a downloaded catalog
  on disk is damaged later, Harbor sets it aside and uses the catalog it shipped with until a good one
  arrives.
- **The official apps follow their projects' releases** (0.33.0): every day the catalog repository looks for newer
  releases of each app, moves the app to the newest one and proves it on a real machine first (it installs the
  current version, updates it, checks it stays healthy, then installs the new version from nothing). Small updates
  (patch and minor) are published on their own; bigger ones (a new major version, or 0.x minor ones such as
  Open WebUI 0.11 → 0.12) wait for a person to review the project's upgrade notes. Databases inside an app stay on
  their major version. The app's page says *tested on a real machine* for these too.
- **New apps and app updates arrive on their own.** Harbor looks a minute after it starts and then every
  hour (0.30.0; it was 6 hours), and an open App Store picks a new catalog up within minutes. To look now:
  the refresh icon next to *App catalog from …* under the App Store title, or `harbor catalog refresh`.
  No restart is needed, and running apps are not touched.
- **What happens to installed apps**: a newer version shows up like any update (the *updates available*
  card and the blue ↑). If an app has *Update this app automatically* on, Harbor updates it by itself,
  with the usual automatic rollback. Before 0.28.0 that only happened after a Harbor upgrade; now it can
  happen any day a new catalog arrives. Leave it off for apps you want to update by hand.
- **"needs Harbor x.y.z or newer"**: an app that needs a newer Harbor is listed but cannot be installed,
  restored from a backup, or updated, until you update Harbor (§4e). Copies you already run keep working
  and keep their icon. It means the app's author says this version of the app needs Harbor x.y.z or
  newer (each app states it in its own package, and the catalog's checks prove it against that real
  Harbor release before publishing). Your Harbor would not understand the app yet.
- **Uploading your own app** (or adding a git source) that states a newer Harbor than yours is refused
  with the same "needs Harbor x.y.z or newer" message (Harbor 0.28.2 and newer; 0.28.0 and 0.28.1 refuse
  such a package as invalid instead, because they do not know the field). Update Harbor, then add it again.
- **An update or install you reviewed just before a new catalog arrived** fails with `PLAN_STALE`
  ("The app catalog changed since this plan was made"): nothing was changed. Review it again (§7).
- **Offline machines**: every Harbor release ships the latest catalog, so a machine without internet
  keeps the apps it came with. Updating Harbor brings a newer catalog too.
- **"Catalog updates are off"** (in the App Store, with no button) means this Harbor never downloads a
  catalog: the daemon config has `"catalog": { "url": null }`. To turn downloads off on purpose, add that
  to `/etc/harbor/harbor.json` and restart Harbor (`sudo systemctl restart harbor`); remove it to turn
  them back on. Upgrades keep your config file.
- **Your own app with the same id**: if you uploaded an app and the official catalog later adds one with
  the same id, yours stays in charge of that id. Remove your package to get the official one.
- `harbor catalog status` prints the catalog's date, where it came from (*downloaded* or *bundled with
  this Harbor*), and the last check with its error, if any. The last check is forgotten when Harbor
  restarts ("Not checked since the daemon started"). The App Store line shows the same thing: when the
  last check (automatic or yours) failed it says **Last check failed: …**, plus *· checked 5 min ago*.
- Exit codes: `harbor catalog status` exits 0. `harbor catalog refresh` exits 0 for *Up to date*,
  *New apps and updates loaded*, and when catalog updates are off (it prints the off line once; nothing
  was checked — `--json` shows `"source": null`); it exits 1 when the check failed.

### Apps that ask for permissions (VPN servers)

A few apps need more than a normal app: a VPN server such as **WireGuard** creates network tunnels and opens a
UDP port on your machine. Harbor lets an app ask for only a short, fixed list (decision 163):

| The review says | What it lets the app do |
|---|---|
| Change network settings inside the app (NET_ADMIN) | create tunnels, routes and firewall rules in its own network |
| Use this machine's tunnel device | open `/dev/net/tun` (OpenVPN-style servers) |
| Pass traffic between networks inside the app | IP forwarding, so VPN clients reach your home network |
| Port: UDP 51820 on every network | the tunnel port, open on every network of this machine (not only this one) |
| Use this machine's graphics card (GPU) | use the graphics card, for local AI apps such as Ollama (since 0.34.0; see *GPU (graphics cards)* below) |

The **Install** button stays off until you tick **Allow … to do this**. On the command line, add
`--accept-permissions` (`harbor --accept-permissions install wireguard`); `--yes` alone never accepts them.
An update that asks for a new permission, or opens a port the app did not have before, waits for you:
*Update all* and automatic updates skip it, and the review lists the new port next to the permissions.

**Reaching the VPN from outside.** Forward the UDP port on your router to this machine (the app's drawer shows
which), and tell the app your public IP or a domain when it asks for its host. Inside your home network it works
without that. Only one VPN server can use a port: Harbor refuses a second app, or anything else on the machine,
that wants the same one.

### A Harbor login in front of an app (since 0.41.0)

Many apps have no login of their own: anyone who can reach their address can use them. Harbor can put its own login
page in front of any of them (decision 194):

1. Open the app's drawer → **Login** → **Turn on…**.
2. Type a password, or press **Generate**, then **Apply** in the review.

From then on every address of the app (this machine, your network, Tailscale, the internet) first shows a Harbor page
that asks for that password. A browser stays signed in for 30 days. Scripts can send it as a basic-auth password
(`curl -u any:<password> …`).

- **Show password…** shows it again after you type your Harbor password.
- **Change password…** sets a new one; every browser has to sign in again.
- **Turn off** opens the app again; Harbor keeps the password for next time.
- Some apps always have it (the package requires it, like Android); their password is made at install and shown
  once, and the drawer shows it again later. Some apps cannot have it, because their own phone or desktop apps would
  stop syncing; the drawer says so.
- Command line: `harbor app-login <app>` (status), `on` / `off`, `--generate` or `--password-stdin` for a new password,
  `--show` to print it.

### Apps with full control of this machine, and developer mode (since 0.40.0)

A few apps cannot run without full control of this machine. **Android** (redroid) is one: it runs as a
*privileged* container and needs Android's binder driver in the kernel. Harbor gives these two permissions only to
apps from its own catalog, the way a phone only trusts its store (decision 193):

| The review says | What it lets the app do |
|---|---|
| Full control of this machine | everything: it could read, change or erase anything on this machine |
| Load Android's binder driver into this machine's kernel | Harbor loads `binder_linux` before the app starts, and again at every boot |

If the kernel has no binder driver, the review refuses with the command to add it (Ubuntu:
`sudo apt install linux-modules-extra-$(uname -r)`). Harbor never installs system packages itself.

**Developer mode** (Settings → Advanced access, or `harbor developer-mode on`) lets apps you upload or add from
git ask for these permissions too, for testing a package before it goes into the catalog. It asks for your
password, and a yellow banner stays on every page while it is on. Turning it off stops nothing: apps already
installed keep running, the Developer mode card lists the ones with full control that are not from the catalog,
and Harbor refuses to update or reinstall them until you turn it on again or remove them.

### GPU (graphics cards)

Local AI apps (Ollama, Open WebUI with its bundled Ollama, and ComfyUI for images) run much faster on a graphics card. Such an app
asks for the **gpu** permission (decision 179, Harbor 0.34.0 and later). Harbor checks the machine and the review
says what the app gets:

| This machine has | The app gets | The review / app page says |
|---|---|---|
| An NVIDIA card **and** the NVIDIA container toolkit | the card (all NVIDIA cards, for computing: CUDA and `nvidia-smi`) | "Use the NVIDIA GeForce RTX 3090 (GPU)…", *Graphics card: … (driver 595.99.02, in use)* |
| An NVIDIA card with **no driver** running | nothing yet: it runs on the CPU | "…the NVIDIA driver is not running…" (since 0.34.1) |
| An NVIDIA driver **updated but not rebooted** | nothing new: an app already on the card keeps it until it restarts, others run on the CPU | "…the machine has not restarted since the NVIDIA driver update (… installed, … running)…" (since 0.34.1) |
| An NVIDIA driver **older than 525**, with the toolkit | the card, with a note: apps built on CUDA 12 or newer (like Ollama) cannot use it | "…the NVIDIA driver is older than 525…" (since 0.34.1) |
| Intel or AMD graphics | its render device only (`/dev/dri/renderD…`), not the display | "Use Intel graphics…" |
| An NVIDIA card **without** the toolkit | nothing yet: it runs on the CPU | "…the NVIDIA container toolkit is not installed…" |
| An NVIDIA card, the toolkit installed, Docker **not restarted** since | nothing yet: it runs on the CPU | "…Docker has not restarted since the NVIDIA container toolkit was installed…" |
| No graphics card | nothing: it runs on the CPU | "No usable graphics card found…" |

When Intel or AMD graphics sit next to an NVIDIA card Harbor cannot use yet, the app uses the Intel/AMD graphics
and every screen also names the NVIDIA card and what to do for it. You allow the permission even on a machine
without a card: a card added later is then used without a new question. *Settings → Overview → Graphics card*,
`harbor inspect <app>` and `harbor gpu` show what Harbor found. Adopting such an app from a drive asks the same
question (*Settings → Storage → Adopt…*: tick *Allow … to do this*; CLI: `harbor adopt <home> --accept-permissions`;
`harbor found-apps` lists the permissions).

**Drivers: Harbor checks, you install** (decision 181). Harbor never installs, updates or removes the NVIDIA
driver: it is part of the operating system (kernel modules rebuilt for every kernel, Secure Boot keys, a reboot), and
the card may also drive this machine's screen. It only reads what is there and says what to do, in this order:

- *the NVIDIA driver is not running*: the card is in the machine but no driver is loaded. Install Ubuntu's
  recommended one with `sudo ubuntu-drivers install`, then restart the machine. With Secure Boot on, Ubuntu asks
  you to set a password for the driver's key during the install and to enroll it (*Enroll MOK*) on the blue screen
  at the next boot; skip that and the driver stays blocked.
- *the NVIDIA driver is installed but not running*: its files are there, its kernel module is not loaded. Restart
  the machine. If it still says so, Secure Boot is likely refusing the module: enroll its key (`sudo
  update-secureboot-policy --enroll-key`, then *Enroll MOK* at the next boot) or switch to Ubuntu's signed prebuilt
  modules (`sudo ubuntu-drivers install` picks them where they exist).
- A card handed to a virtual machine (bound to `vfio-pci` or `pci-stub`) is not this machine's: Harbor does not
  count it and gives no driver advice for it.
- *the machine has not restarted since the NVIDIA driver update*: apt installed a newer driver while the old one
  still runs (`nvidia-smi` says "Driver/library version mismatch"). Restart the machine. Until then an app already
  on the card keeps it (its page says *in use*); restarting that app first moves it to the CPU until the reboot.
- *the NVIDIA driver is older than 525*: a note, not a block. Apps still get the card (CUDA 11 images and video
  transcoding work on older drivers), but apps built on CUDA 12 or newer, like Ollama, cannot use it. If the card
  supports it, run `sudo ubuntu-drivers install` (or install a newer `nvidia-driver-<version>` package), then
  restart the machine. Some older cards (Kepler) stop at driver 470.

Check the driver with `nvidia-smi`: it names the card and the driver version. *Settings → Overview → Graphics card*
and `harbor gpu` show the version Harbor found (`harbor gpu --json` also has the installed one, `libraryVersion`).
After the machine restarts, Docker restarts every app with the containers it had; restart an app that should use
the card (app page → Restart) once its page says *found · restart the app to use it*.

**NVIDIA: install the container toolkit once** (Ubuntu 24.04; the driver must already work, see above). Harbor does
not do this for you: it adds NVIDIA's package repository and restarts Docker, which restarts every app.

```sh
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Do not skip `systemctl restart docker`: Docker only notices the toolkit when it starts. Until then Harbor reports
*Docker has not restarted since the NVIDIA container toolkit was installed* and keeps the app on the CPU (an app
asking Docker for the card before that would fail to start). Then **restart the app** (app page → Restart, or
`harbor restart <app>`): Harbor checks the machine again each time it prepares an app's containers (install,
Restart, update, changing its values), so the next Restart hands the card over. The app page says *found · restart
the app to use it* whenever the card found now differs from the one the app's containers have. Stop and Start reuse the same containers and do not. The app page then says
*Graphics card: NVIDIA … (in use)*. In Ollama, `ollama ps` shows `100% GPU` while a model answers.

Not yet: AMD ROCm (Ollama's `:rocm` image), choosing one card when there are several (an app gets all NVIDIA cards),
and limits on how much of a card an app uses.

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
  app an address like `http://docs-link:3010`. The other app is not restarted. On that network the
  app's own services answer to no name and the other app only to that address, so neither can pose as
  the other's database or services (decision 171). Links made before 0.32.0 switch over by themselves
  when Harbor first starts after the upgrade: a short *link check* operation per app (actor
  `link-guard` in the daemon log) attaches both sides again with no restart and no new container, and
  each link drops for a moment. Should that check fail, the next Start, Restart, update, reinstall or
  link change of either app does the same. Data, ports and the address stay. The next time such an
  app is restarted or updated, Harbor may recreate its linked service once (like a Restart). The app's
  page shows
  its links (*Change*, *Link*, *Unlink* for optional ones) and, on the other app, who reaches it;
  **Settings → Internal networks** lists every link on the machine. If you remove the providing app,
  the link is dropped and the app that used it shows *needs a provider* (bell, Home, its page) until
  you pick another one. Removing the app that asked drops the link too; Reinstall brings it back.
  CLI: `harbor install <app> --link <id>=<other-app>`, `harbor configure <app> --link <id>=<other-app>`
  (or `--unlink <id>`), `harbor links`.

### App settings (since 0.34.0)

Some apps have settings you can change without editing any file (decision 180), for example Ollama's
*Context length*, *Keep models loaded* or *Flash attention*. Each one has a default from the app's package.

- **At install**: the review has a collapsed **Options** section with every setting at its default. Open it,
  change what you want (a number shows its allowed range; a value outside it keeps *Install* greyed out) and
  install. Nothing to change? Leave it closed.
- **Later**: the app's page has a **Settings** section with each value; *(default)* marks the ones you never
  changed. **Change…** opens a form with every setting (*Reset to default* next to each one you changed);
  **Review** shows the plan ("Context length (tokens): 8192 → 16384") and **Apply** recreates the app with the new
  values. Data, ports and addresses stay.
- **What Harbor keeps**: only the values you changed. A setting you left at its default follows the package, so an
  update that changes a default changes it for you too. Your values are kept when you remove and reinstall the app,
  go with its backups (a restore puts back the values it had then) and are deleted by *Uninstall completely*. An
  app adopted from a drive on another machine starts at the defaults.
- **Updates**: a setting the new release adds starts at its default (the update review lets you pick another in
  *Options*); one it removes is dropped; a value it no longer allows goes back to the default. The review says
  which. Automatic updates do the same without asking.
- Settings are **not secrets**: they appear in plans, the app's events and logs. Passwords and tokens are asked as
  *values only you have* (above), never as settings.
- **CLI**: `harbor settings <app>` lists them (id, value, default, what is allowed; `--json` too);
  `harbor configure <app> --set context-length=16384` changes one (a default value removes your override);
  `harbor install <app> --set context-length=16384 --set flash-attention=on` chooses at install;
  `harbor update <app> --set parallel=2` for a setting the update adds; `harbor apply <plan> --set …` for a plan
  made with `harbor plan`. On/off settings take `on`/`off` (or `true`/`false`). A value that is not allowed is
  refused with `SETTING_INVALID` and what the setting accepts.

### VPN and offline apps (since 0.36.0)

Every app has an **Internet access** choice (decision 184):

| Choice | What the app may open | Reached by people |
|---|---|---|
| **Direct** (the default) | anything, straight from this machine | as usual |
| **Through the VPN** | only through the VPN in Settings → VPN; nothing while it is down | as usual |
| **Offline** | nothing: not the internet, not your network, not this machine, not other apps | as usual |

- **Settings → VPN → Add VPN…**: paste (or choose) the WireGuard configuration file your VPN provider gives you
  (Mullvad, Proton VPN, IVPN, AirVPN and most others; pick one server and "all traffic"). Harbor shows whether it
  is connected (last handshake), its server, tunnel address and DNS. *Replace…* swaps the file, *Remove…* drops it.
  The private key stays on this machine, readable by root only (`/etc/harbor/egress/tunnel.conf`); Harbor never
  shows it again. A file with `PostUp`/`PreUp`/`PostDown`/`PreDown`, `Table`, `FwMark` or `SaveConfig` lines is
  refused (Harbor never runs commands from it): delete those lines.
- **One app**: its page → **Internet** → **Change…** → pick → **Review** → **Apply**. A running app restarts for
  a few seconds (its DNS setting is part of its containers); a stopped one changes when it next starts. *The app's default* follows what the package asks for again. At install, the install page's
  **Internet** row has the same choice (*Change*).
- **Send every app through the VPN** (Settings → VPN → Apps): every app set to Direct goes through the VPN too;
  offline apps stay offline. There are no exceptions while it is on.
- **Kill switch**: an app that goes through the VPN never falls back to direct. While the VPN is not connected (or
  none is set up) it has no internet, and the bell says so after 5 minutes. Its DNS lookups go to the VPN's DNS
  server, through the tunnel, whatever resolver the app uses. Your own network (a NAS, a printer, the router) stays
  reachable from a VPN app; tailnet addresses do not (they would go into the tunnel).
- **What stays direct**: Harbor itself (updates, the catalog, Tailscale, Let's Encrypt) and image downloads for
  updates (Docker pulls them on the host), so offline and VPN apps still update.
- **Packages** may ask for a default (`network.internet`, e.g. *offline* for an app that never needs the internet);
  the install page shows "what X asks for". Your choice wins and is kept across updates; an update that changes the
  package's default moves only apps that follow it, and its review says so.
- The choice lives next to the app's settings: kept by remove/reinstall, carried by backups and restores, deleted by
  *Uninstall completely*.
- **CLI**: `harbor vpn` (status; `harbor vpn status --check` asks the tunnel now), `harbor vpn set provider.conf
  --name "Mullvad Stockholm"` (`-` reads stdin), `harbor vpn every-app on|off`, `harbor vpn remove`;
  `harbor internet <app>` shows an app's choice, `harbor internet <app> offline|vpn|direct|default` changes it;
  `harbor install <app> --internet offline`; `harbor configure <app> --internet vpn`.
- **How it is enforced** (docs/design/VPN.md): an nftables table of Harbor's own (`inet harbor_egress`) marks what
  each app opens from its network, routes VPN apps into the WireGuard interface `hb-vpn0`, rewrites their DNS into the
  tunnel and refuses anything else. At boot Docker waits for that table (`harbor-egress.service`); the tunnel follows
  once the network is up (`harbor-vpn.service`). To look: `sudo nft list table inet harbor_egress`,
  `sudo wg show hb-vpn0`, `ip rule` (5160–5180).

## 4e. Updating Harbor itself

Settings → Overview shows the installed version and, when GitHub has a newer release, an **Update to
x.y.z** button (release notes underneath; *Check now* asks GitHub immediately, otherwise every 6 hours).
Harbor downloads the release, checks that Harbor's release key signed it (`SHA256SUMS.sig`, 0.32.0 and later)
and its checksum, installs it in place and restarts; your apps keep
running, the console is away for about a minute and reconnects by itself. The same from the terminal:
`harbor self-update`, `harbor self-update check`, `harbor self-update start`. Manual path, still supported:
download the archive, check it (section 2b), extract, `sudo ./harbor-<version>-linux-x64/bin/harbor bootstrap --yes`.

**Only signed, only forward** (0.32.0, decision 168). An update from the console or `harbor self-update start`
only ever goes to a newer release, and only to one that carries a valid signature; anything else is refused
before a byte is installed ("is not signed", "does not match its SHA256SUMS.sig", "self-update never
downgrades"). Going back on purpose is a root command on the machine:
`sudo /opt/harbor/bin/harbor self-update apply --to <version> --allow-downgrade` (add `--allow-unsigned` for a
release older than 0.32.0, which was published before signing existed). `--allow-unsigned` also lets
`--archive <file>` install an archive you built yourself without `SHA256SUMS.sig`; a GitHub release from 0.32.0 on
always needs its signature, and a signature that is there but wrong is always refused. Neither flag works in the
update the console starts. While a new release is still being uploaded (its signature comes last), Settings
says "Harbor x.y.z is still being published" and offers the update a few minutes later.

If the new release fails to start, Harbor puts the previous one back by itself: the running
release is snapshotted before the update, the console is polled after the restart, and on
failure the snapshot is restored and the console comes back on the previous version (your
apps keep running throughout — they belong to Docker, not to the daemon). The Overview card
then says the update was rolled back. Manual downgrade, if you ever need it:
`sudo /opt/harbor/bin/harbor self-update apply --to <previous-version> --allow-downgrade` (plus `--allow-unsigned` below 0.32.0; state is kept;
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

In the console, the Publishing page (*Publish…* under *Not published*, *Manage* on an app that already
has an address) and every running app's drawer open the same dialog with the same options. A healthy
address shows just its link; the state, the reason and the last check appear only when it is not
*active*; the Platform page shows Tailscale enrollment and proxy state.

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

### Every app on Tailscale (since 0.33.0)

Publishing on the tailnet is one app at a time by default: an address on your tailnet can be reached
from every device on it, including people you share the tailnet with, so Harbor never opens an app wider
than you asked. When the tailnet is only your own devices, **Settings → Remote access → Every app on
Tailscale** gives every app its own tailnet address instead (decision 177):

- **Turning it on** shows the apps that will get an address and asks first ("any device on your tailnet
  can reach it"). It is refused, with the step to take, while Tailscale is not ready (not installed, not
  logged in, offline, or HTTPS certificates off in the Tailscale admin console).
- **Know what it shares**: every app's address uses this machine's one tailnet name (one port each), so
  your browser shares the apps' cookies between them. The cookie firewall that keeps apps apart on secure
  home addresses (`https://harbor.local:<port>`) does not cover tailnet addresses. Publish only apps you
  trust side by side, or keep the others off (below).
- Harbor then publishes each app without a tailnet address, **one at a time**, each through its own
  ordinary *Publish* operation (you see them in the tray; the actor is `tailnet-policy`). Only an app that
  is running and answering gets one; a stopped, busy, installing or broken app gets its address once it
  runs again. Nothing is planned while another operation runs, and an app is left alone while one of its
  plans is open for review (so approving it still works). The main address of an app does not change.
- **New installs**: the install review says the app also gets a Tailscale address once it runs. For an
  app whose first visitor creates the owner account (or that ships a default login), the review warns
  that this page is reachable from your tailnet as soon as it runs: create the account right after
  install, or switch it off in its drawer while it installs.
- **Keep one app off**: switch **On Tailscale** off in its drawer (under its addresses; shown whenever
  Tailscale is ready, so you can keep an app off before turning the policy on). That only stops Harbor
  from giving it an address; an address it already has stays until you withdraw it with
  *Publish… → Withdraw*. Withdrawing an app's main tailnet address by hand, with the policy on or off,
  also keeps that app off from then on (the review says so). Switch it back on to let Harbor publish it
  again.
- **If one fails** (no free port, Tailscale refused it), Harbor tries **once per start** of Harbor, shows
  it as *failed* in Remote access with the reason, and leaves one notification for that app. *Try again*
  in Remote access lets Harbor try once more at its next check (within seconds, once no other operation
  runs). A refusal that only meant "not now" (the app got busy at that moment) is not a failure: Harbor
  simply tries later.
- **Turning it off** never withdraws an address: every app keeps the one it has; withdraw them one by one.
- Every kind of app counts, API-only ones too (a script on your laptop can use the address as well).
- Uninstalled apps leave the list of apps kept off; a removed app you may reinstall keeps its choice.

### Choosing apps for Tailscale in bulk, and at install (since 0.37.0)

- **Settings → Remote access → Apps on Tailscale** lists every app with a checkbox: ticked = it has a
  tailnet address. Tick or untick apps (or use **Select all** / **Select none**), then **Review N changes**:
  the dialog lists the apps that get an address (with the address each will have) and the ones that lose
  theirs, plus any app that cannot change and why (for example *no free port left*). **Apply** sends them
  all to the queue; each is its own operation in the tray. Unticking an app also keeps it off when Every
  app on Tailscale is on; ticking one that was kept off includes it again.
- **Install page → Access → Also on Tailscale**: the new app also gets a tailnet address once it runs (not
  its main address; that is *Change* under Access). It is ticked by default only while Every app on
  Tailscale is on; untick it there to keep this one app off. CLI: `harbor install <app> --tailnet`
  (or `--no-tailnet`).
- **An address in a review is not live yet.** The review of a *Publish* shows the address it will create as
  plain text, "(once you approve)". Nothing answers there until you approve and the operation has run;
  the address then appears in the app's drawer, on Publishing and in the tray.

```sh
harbor tailscale every-app                          # on/off, waiting reason, where each app stands
harbor tailscale every-app on                       # lists the apps that get one, asks, then turns it on (--yes skips the question)
harbor tailscale every-app --app nextcloud off      # keep this app off the tailnet (its current address stays)
harbor tailscale every-app --app nextcloud on       # let Harbor publish it again
harbor tailscale every-app off                      # stop; nothing is withdrawn
```

### Publishing on the internet, step by step

1. **Settings → Public addresses** shows this machine's public address. Create an A (and, if shown, AAAA)
   record for your domain pointing at it. Behind a home router, forward ports 80 and 443 to this machine.
2. Add the domain in the same page. Harbor resolves it and says *Points here*, *Points elsewhere* (with
   the address it found) or *No DNS record yet*; *Re-check* after DNS has spread.
3. **Publishing** → *Publish…* (or *Manage* when it is already on your tailnet) on the app → *Public* → pick the domain. Caddy requests the Let's Encrypt
   certificate as soon as the address is added and renews it; the address is *pending* for a minute and
   then *active*. Apps without their own login get a generated password unless you opt out.

`harbor domains` prints the same table from the terminal.

## 7. Troubleshooting

| Symptom | What to do |
|---|---|
| `PORT_CONFLICT` at plan/submit | Another listener or a retained instance holds the port. `ss -ltnp`, or remove/reinstall retained instances. Harbor never stops the other listener. |
| `NAME_CONFLICT` | Pick another `--name`. |
| `PLAN_EXPIRED` (410) | Plans live 15 minutes. Create a new one. |
| `PLAN_STALE` (409) | A newer app catalog (or a new upload of the package) arrived between the review and the moment Harbor started the change. Nothing was changed: the app runs as before (an install leaves nothing behind). Review the plan again; it now shows the new version. |
| `IDEMPOTENCY_CONFLICT` | The key was used for another request, or the plan was already submitted; poll the returned operation id. |
| `READINESS_TIMEOUT` | App did not answer within its manifest deadline. `harbor inspect`, `docker logs <container>`. Resources kept; `remove` to clean up. |
| *Type your password to continue* while installing, restoring or encrypting an app (CLI: "Harbor restarted since your last login, so its key for encrypted apps is locked", exit 3) | After Harbor restarts (an update, a reboot) your remembered browser session still works, but the key that lets this machine reopen encrypted apps is unlocked only by your password. Type it in the dialog and Harbor carries on with the same install; from a terminal run `harbor account unlock`. Harbor refuses rather than sealing an app that only your recovery key could reopen. |
| `DATA_MISSING` / `SECRET_MISSING` | Retained volume or key gone/replaced. Restore from your backup; Harbor will not create replacements. For an app folder on a removable drive, see §4a1 (re-insert, restore with marker, or adopt the replacement). |
| `OWNERSHIP_CONFLICT` | A same-named resource exists that Harbor did not create for this instance. Inspect manually. |
| `DOCKER_UNAVAILABLE` (503) | `systemctl status docker`. |
| An install fails with Docker's `all predefined address pools have been fully subnetted` (Harbor before 0.39.0) | Docker ran out of address ranges for new networks (about 30, often taken by empty networks of Compose stacks you no longer run). Update Harbor: from 0.39.0 it gives each new app network a range from its own block (`10.200.0.0/13`, 2048 networks) and no longer depends on Docker's. Apps already installed keep their networks. To see leftovers: `docker network ls`; `docker network rm <name>` removes one that nothing uses (Harbor never removes networks it did not create). |
| `no free address range for network …` | Every range in Harbor's block `10.200.0.0/13` is used by a Docker network or overlaps a network this machine is on (a VPN that routes all of `10.0.0.0/8`, for example). Remove Docker networks nothing uses (`docker network ls`, `docker network rm <name>`), or narrow that VPN's routes, then try again. |
| `http://harbor.local` stops resolving but `http://<ip>/` works | On the machine: `sudo systemctl restart avahi-daemon.socket avahi-daemon.service` (both — a service-only restart can leave avahi answering some queries and not others), then `avahi-resolve -n harbor.local` must print only the machine's LAN address; if it prints a `172.x` Docker address, re-run the installer (it pins avahi to the LAN interface). On a Mac that still fails: toggle Wi-Fi off/on, or `sudo launchctl kickstart -k system/com.apple.mDNSResponder`. `dig @224.0.0.251 -p 5353 harbor.local +short` from the client shows whether the box answers on the wire at all. |
| Home stays on "Loading your apps…" and public sites time out | Caddy stopped answering (seen once after turning secure addresses on, before 0.25.2). On the machine: `curl --max-time 5 http://127.0.0.1:2019/config/` hangs → `sudo systemctl restart caddy` (it comes back with its last good configuration). |
| *Check for new apps* shows an error, the App Store says "Last check failed: …", or `harbor catalog refresh` says "Could not update the catalog: …" (exit 1) | Nothing was changed: Harbor keeps the catalog it has. The message says why (no internet, the server answered an error, "the app catalog archive does not match its catalog.json checksum" — an incomplete download, "dated in the future" — check the machine's clock). When a new catalog is published during a check, Harbor checks again once by itself. Try again later, or check that the machine can reach `github.com`. |
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
- Apps share one host name in LAN mode (`harbor.local:<port>`). The secure relay keeps their login
  cookies apart (decision 167); plain-http addresses, Tailscale addresses and cookies an app's scripts
  read are not isolated. *HTTPS only* closes the plain-http addresses.
- Apps from the official catalog may get full control of this machine (`privileged`, decision 193); apps you
  upload or add from git only while developer mode is on (§4d).
- Not included: multi-user roles/SSO, community catalogs (there is one official catalog, §4d; your own apps come as uploads or git sources).

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

The built-in apps come from [harbor-apps](https://github.com/carlosalaniz/harbor-apps) and can change
between Harbor releases (§4d). The seventeen below were in the catalog when 0.28.0 was written (see
docs/design/CATALOG.md for the selection rules, and each app's `apps/<id>/README.md` in harbor-apps for
first-run notes):

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
