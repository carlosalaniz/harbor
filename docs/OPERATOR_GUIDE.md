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

## 2. Install (bootstrap)

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

Web UI sections: **Installed** (status, Open, Start/Stop, Remove, Reinstall for retained instances,
progress), **Available** (the bundled catalog), **System** (Docker/Harbor observation), **Platform tools**.

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
  within 5 minutes of start; if that window expires: `sudo docker restart hb_platform_portainer-portainer-1`.
  The tools card shows `setup_required` until the admin exists.
- Both cards report installed/not_installed/setup_required/unknown and reachable/unreachable/unknown
  with observation times. "Reachable" means the login page answers, nothing more.
- Bind existing tools: `harbor tools bind portainer --url https://localhost:9443/` (loopback URLs only).
- Ordinary `harbor remove` cannot touch platform resources; they are not application instances.

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
| Portainer login page loads but no admin form | The 5-minute window expired; restart its container (above). |

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
