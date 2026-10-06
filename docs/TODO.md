# TODO — found on a real host, not built yet

Work items found while moving a set of existing Compose apps onto Harbor on one home server
(2026-10-06, Harbor 0.22.1). Unlike `FUTURE.md` (deliberately out of scope), these are wanted.
Each needs the normal round: tests first, decision row, docs, release (AGENTS.md §4).

## 1. Encryption at rest for apps installed from the CLI (highest priority)

**Bug.** `harbor install <package>` without `--location` installs the app on plain Docker volumes
(`/var/lib/docker/volumes/hb_<id>_<claim>`), unsealed. The console wizard defaults to **Local**
(sealed in the Harbor data folder with Harbor's own key, decision 94). Same action, two different
outcomes, and nothing in the CLI output says "not encrypted". Consequence seen: after a reboot such
apps start by themselves before any login (no BFU, see `docs/design/APP_HOMES.md`) and their data is
plaintext on disk.

- [x] *(0.23.0, decision 130)* CLI `install` defaults to the Harbor data folder (sealed, no passphrase), exactly like the
      console; an explicit opt-out flag only if a real need appears (decide in the decision row).
- [x] *(0.23.0, decision 130)* Install plan + `harbor inspect` + console drawer say plainly whether an app is sealed
      ("Encrypted: no — plain Docker volumes"), and `harbor list` gets a column or marker.
- [x] *(0.24.0, decisions 142 + 144, verified live)* **`harbor seal <app>`**: move an installed app's plain volumes into a sealed home in place —
      same instance id, ports, names, links, exposures, secrets. Shape like the 0.17.0-beta.2
      in-place sealing (stop → create home → seal empty `volumes/` → `cp -a` each claim's volume
      into it as root → verify entry counts and bytes → switch the instance's volume definitions →
      start → only then delete the plain volumes; any failure restores the original). Needs free
      space for one extra copy; cannot scrub old blocks (say so). Console: *Encrypt this app…* in
      the drawer for unsealed apps. Integration tests with the fake adapter + a live run.
- [x] *(0.23.0)* Doc: OPERATOR_GUIDE "Headless reboot" section must also say that unsealed apps restart on
      their own (and how to tell which are which).
- [x] *(0.24.0, decision 143, verified live)* **Change an app's encryption passphrase** (custom-passphrase apps, and switching an app between
      "Harbor's own key" and "my own passphrase"): re-wrap the app key in the home's envelope
      (old passphrase or recovery key + new passphrase), never re-encrypt the data; refresh the
      machine wrapping; console drawer *Change passphrase…* + `harbor passphrase <app>` (values via
      stdin/console only, never in plans or logs, like decision 125).

## 2. Features wanted

- [x] *(0.23.0, decision 131)* **Hide apps from Home.** Helper apps without a page of their own (e.g. an MCP gateway, a
      document server) clutter the launcher. Per-app *Hide from Home* (drawer + `harbor look <app>
      --hide/--show`), a settings-table preference, no migration; hidden apps stay in the Store's
      *installed* view, in Platform/app lists and in notifications; Home shows a quiet "N hidden"
      link to reveal them. A package may suggest `presentation.hideFromHome: true` (API-only apps)
      as the default.
- [x] *(0.23.0, decision 132)* **Picture of the day by default.** A fresh install starts with rotating wallpapers on
      (Bing picture of the day, keyless, daily) instead of a static preset; existing installs keep
      their choice; credit shown on Home as today. Must degrade quietly offline (keep the last
      picture or the preset).
- [ ] **Move an app between locations** (Local ↔ external drive, drive ↔ drive) keeping its
      encryption: stop → copy the sealed home's ciphertext as-is (`cp -a` of the home, no decrypt)
      to the target candidate → verify counts/bytes → switch the instance's home path and volume
      definitions → start → delete the source only after success; same instance id, ports, links,
      exposures, secrets. Passphrase rules follow the target (a removable drive requires a
      passphrase or the Harbor-password wrapping, decision 94/112); refuse targets that cannot seal
      (non-ext4). Console *Move to…* in the drawer + `harbor move <app> --location <dir>`.
      Pairs with `harbor seal` (§1): plain → sealed first, then move.

## 3. Smaller bugs and rough edges

- [x] *(0.23.0, decision 133: own port)* **Tailnet exposure collides with the LAN app port.** In LAN mode an app's host port (e.g.
      18080) is published on every interface (`0.0.0.0:18080`, plain HTTP, via docker-proxy).
      Publishing the same app on the tailnet runs `tailscale serve --https=18080 → 127.0.0.1:18080`
      on the **same port number**: tailscaled only gets the tailnet IPv6 address, while on the
      tailnet IPv4 address the app's plain-HTTP listener answers the TLS handshake. Seen as
      `degraded` with `write EPROTO … SSL routines:tls_get_more_records:packet length too long`;
      `http://<tailnet-ipv4>:18080/` answers 200 in plain HTTP. Fix: give tailnet HTTPS its own port
      (or `:443` with a path/hostname split), or bind LAN app ports to the LAN interface only (not
      `tailscale0`); add a check that refuses a tailnet port already bound on `0.0.0.0`.
      **Worse than a warning:** once tailscaled holds that port, the app's next `update` (or any
      container recreate) fails with `failed to bind host port` for the endpoint service, the
      automatic rollback fails the same way, and the app is down in `needs_action`. Seen live; the
      way out was freeing the port by hand (`tailscale serve --https=<port> off`), `remove` +
      `reinstall`, then re-publishing. Fix this before tailnet publishing is offered again.
- [x] *(0.23.0, decision 135: unexpose + Repair)* **`needs_action` has no repair path for publishing.** `unexpose`, `update` and `expose` all
      refuse in `needs_action` ("requires an installed app"), so the exposure that caused the failure
      cannot be withdrawn through Harbor. Allow withdrawing exposures (and a "retry last operation")
      in `needs_action`.
- [x] *(0.23.0, decision 134: kept and re-applied)* **`remove` silently withdraws public names; `reinstall` does not bring them back.** After
      remove + reinstall both domains had to be re-published by hand (and `primary` re-set). Either
      keep exposures with the retained instance and re-apply them on reinstall, or say clearly in the
      remove plan which names will go.
- [x] *(0.23.0, decision 135)* **Failed recreate leaves a container with no network.** After the failed bind, the endpoint
      container existed with `NetworkSettings.Networks = {}` and crash-looped (`host not found in
      upstream`); Harbor showed it as part of a running app. Rollback should remove such half-created
      containers, and readiness should flag them.
- [x] *(0.23.0)* **Package lesson (document in DEVELOPER_PACKAGES):** a cache service (redis) inside a package
      should not persist (`--save ""`): an image-declared VOLUME keeps the cache across restarts and
      reboots, and after a data copy the app ran with the empty install's cache (Frappe hid all
      Server Scripts until `bench clear-cache`).

- [x] *(0.23.0, decision 136)* **Port-80 owner misdetection.** With another reverse proxy (not Harbor's Caddy) on :80 the
      daemon logs `port 80 is taken (Caddy): the LAN console is served through the proxy` — wrong
      owner and wrong conclusion; the console is then only on `127.0.0.1:<management port>`.
      Detect Caddy by its admin API/unit, otherwise say "taken by another program".
- [x] *(0.23.0, decision 138)* **One-time credentials on stdout.** `harbor install` prints provisioned credentials into the
      terminal/log of whoever runs it. Add `--credentials-file <path>` (0600) and print only where
      they went.
- [x] *(0.23.0, decision 138)* **Misleading label.** The install tray calls every provisioned credential "Basic-auth
      credentials", also when it is an app admin login or a shared secret (e.g. a document
      server's JWT secret). Use the package's own label/`credentialsNote`.
- [x] *(0.23.0, decision 138)* **Show-once generated secrets.** Let a package mark a generated secret as shown once to the
      operator (so it does not have to abuse `provisionedCredentials` for e.g. a JWT secret).
- [x] *(0.23.0, decisions 134–135: forgets the kept address; purge withdraws leftovers)* **Unexpose on a retained instance.** `harbor unexpose` right before `purge` failed with
      `INVALID_STATE: exposure changes require an installed instance; <app> is retained` although
      the app looked installed; purge then removed the route anyway. Reproduce and fix the state check
      or the message.
- [x] *(0.23.0, decision 139)* **Secret inside a literal env value.** Images without a shell cannot assemble e.g. a
      database URL in `command:`; allow a secret reference inside an environment literal
      (rendered by Harbor, never logged).
- [x] *(0.23.0, decision 140)* **Validate a package folder locally.** No CLI/route to run the daemon's validators on a
      folder before pushing a git source (`harbor packages validate <dir>`).
- [x] *(0.23.0, decision 137)* **`<` and `>` in package text.** Setup instructions cannot show `Bearer <token>` or
      `https://<domain>/`; allow them as text (it is rendered as text anyway) or document an
      alternative.
- [x] *(0.23.0, decision 141)* **API-only apps.** Every app must have a main web endpoint, so an API (e.g. an MCP gateway)
      still shows an *Open* button; allow an endpoint kind "api" with no browser launch.
