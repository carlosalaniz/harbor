# Harbor operator guide (local preview)

Harbor installs a few self-hosted applications on one Ubuntu machine as ordinary Docker Compose
projects, allocates non-conflicting loopback ports, checks readiness, and remembers what it owns.
This release is a **trusted local preview**: one administrator, loopback only, one daemon with
Docker (root-equivalent) authority. It is not a hardened multi-user management service.

## 1. Requirements

| Item | Requirement |
|---|---|
| Host | Ubuntu 24.04 LTS, x86-64, systemd |
| Docker | Docker Engine + Compose plugin. Absent: bootstrap can install them from Docker's apt repository when you pass `--install-docker`. Present: validated, never modified. |
| Access | Local browser on the machine, or SSH local port forwarding. Harbor never listens on anything but 127.0.0.1. |
| Build tooling on the host | None. The archive bundles Node.js and all dependencies. |

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
- `HARBOR_TOOLS=1` also sets up Cockpit and Portainer. `HARBOR_VERSION=0.8.0` pins a release.
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

**Reset the administrator** (daemon stopped; invalidates all sessions; touches nothing else):

```sh
sudo systemctl stop harbor
sudo /opt/harbor/bin/harbor enroll --config /etc/harbor/harbor.json --reset --username admin
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
Portainer, Tailscale, proxy with real state and links), **Settings** (session, SSH forwarding line,
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
  initializing replacements. There is no purge command in this release; deleting a volume is a
  manual `docker volume rm` decision by you.
- Secrets live in `/var/lib/harbor/instances/<uuid>/secrets/` (0600) and appear in plaintext in the
  private generated Compose file. That is deliberate for the trusted local preview; there is no
  encrypted vault.
- Back up (outside Harbor): `/var/lib/harbor` (state, secrets, release snapshots). Application data
  volumes are the application's responsibility.

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

## 4b. Settings in the console (for people who do not use a terminal)

The console's **Settings** page covers what a household operator needs after bootstrap:

| Section | What you can do |
|---|---|
| Account | change the administrator password (every other logged-in browser or CLI is signed out) |
| Remote access | connect this machine to your Tailscale tailnet by clicking *Log in with Tailscale* (opens the approval page) or by pasting an auth key; see the node name; turn *Harbor on your tailnet* on or off; log out of the tailnet |
| Public addresses | the wizard for publishing on the internet: this machine's public address, your domains with a DNS check (*Points here* / *Points elsewhere* / *No DNS record yet*), which app uses each, re-check and forget; certificates are automatic |
| Remote access (details) | tailnet addresses, node key expiry, link to the Tailscale admin console; the auth key you used is single-use and is not stored |
| Storage | disks with free space, the Harbor data folder (`/srv/harbor`, where Harbor may create folders for you), folders currently used by apps, and a folder browser with *Create folder here* |
| Overview | the landing page: your machine's name, what it runs on, Harbor version, uptime, storage/memory/temperature, *Log out*, *Restart* and *Shut down* (each asks first), and the wallpaper picker |
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

## 5. Service operations

```sh
systemctl status harbor          # daemon (user harbor, KillMode=control-group)
journalctl -u harbor -f          # JSON lines; no secrets or tokens are logged
systemctl restart harbor         # apps keep running; UI recovers after login
```

Restarting Harbor never stops application containers (they belong to Docker with
`restart: unless-stopped`). After a host reboot, desired-running apps come back through Docker;
intentionally stopped instances stay stopped. Harbor re-observes and reports actual readiness.

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
| `DATA_MISSING` / `SECRET_MISSING` | Retained volume or key gone/replaced. Restore from your backup; Harbor will not create replacements. |
| `OWNERSHIP_CONFLICT` | A same-named resource exists that Harbor did not create for this instance. Inspect manually. |
| `DOCKER_UNAVAILABLE` (503) | `systemctl status docker`. |
| Login 429 | Rate limited after repeated failures; wait ten minutes. |
| UI says "session ended" after reload | Expected: tokens live in memory only. Log in again; running operations continue. |
| Public address stays `degraded` | Check `dig +short <hostname>` resolves to this host and that 80/443 are open in your cloud firewall; `journalctl -u caddy` shows certificate attempts. |
| Tailnet address stays `degraded` | `tailscale status` must show the node online; enable HTTPS certificates in the admin console; `tailscale serve status` lists Harbor's entries. |
| Portainer login page loads but no admin form, or the form refuses to submit | The 5-minute window expired (restart its container, above) or the setup token is missing (read it from the container log). |

## 8. Trust boundary and limits (read this)

- The `harbor` service user is in the `docker` group and is therefore root-equivalent. The API is
  not a sandbox against anyone with Docker or root access.
- HTTP only, on loopback. No LAN/public listener, no TLS, no proxy. Use SSH forwarding.
- Not included: backups, app upgrades, purge, external disks, roles/SSO/MFA, remote catalogs,
  Nextcloud/office integration (see `docs/FUTURE.md`).

## 9. Uninstall (manual, by design)

```sh
sudo systemctl disable --now harbor
# applications keep running until you remove them with `harbor remove` first, or manually via docker
sudo rm -rf /opt/harbor /etc/harbor /etc/systemd/system/harbor.service
sudo rm -rf /var/lib/harbor            # DELETES state, secrets and release snapshots; volumes stay in Docker
sudo userdel harbor
```

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
