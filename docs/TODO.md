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

- [ ] CLI `install` defaults to the Harbor data folder (sealed, no passphrase), exactly like the
      console; an explicit opt-out flag only if a real need appears (decide in the decision row).
- [ ] Install plan + `harbor inspect` + console drawer say plainly whether an app is sealed
      ("Encrypted: no — plain Docker volumes"), and `harbor list` gets a column or marker.
- [ ] **`harbor seal <app>`**: move an installed app's plain volumes into a sealed home in place —
      same instance id, ports, names, links, exposures, secrets. Shape like the 0.17.0-beta.2
      in-place sealing (stop → create home → seal empty `volumes/` → `cp -a` each claim's volume
      into it as root → verify entry counts and bytes → switch the instance's volume definitions →
      start → only then delete the plain volumes; any failure restores the original). Needs free
      space for one extra copy; cannot scrub old blocks (say so). Console: *Encrypt this app…* in
      the drawer for unsealed apps. Integration tests with the fake adapter + a live run.
- [ ] Doc: OPERATOR_GUIDE "Headless reboot" section must also say that unsealed apps restart on
      their own (and how to tell which are which).

## 2. Smaller bugs and rough edges

- [ ] **Tailnet exposure collides with the LAN app port.** In LAN mode an app's host port (e.g.
      18080) is published on every interface (`0.0.0.0:18080`, plain HTTP, via docker-proxy).
      Publishing the same app on the tailnet runs `tailscale serve --https=18080 → 127.0.0.1:18080`
      on the **same port number**: tailscaled only gets the tailnet IPv6 address, while on the
      tailnet IPv4 address the app's plain-HTTP listener answers the TLS handshake. Seen as
      `degraded` with `write EPROTO … SSL routines:tls_get_more_records:packet length too long`;
      `http://<tailnet-ipv4>:18080/` answers 200 in plain HTTP. Fix: give tailnet HTTPS its own port
      (or `:443` with a path/hostname split), or bind LAN app ports to the LAN interface only (not
      `tailscale0`); add a check that refuses a tailnet port already bound on `0.0.0.0`.

- [ ] **Port-80 owner misdetection.** With another reverse proxy (not Harbor's Caddy) on :80 the
      daemon logs `port 80 is taken (Caddy): the LAN console is served through the proxy` — wrong
      owner and wrong conclusion; the console is then only on `127.0.0.1:<management port>`.
      Detect Caddy by its admin API/unit, otherwise say "taken by another program".
- [ ] **One-time credentials on stdout.** `harbor install` prints provisioned credentials into the
      terminal/log of whoever runs it. Add `--credentials-file <path>` (0600) and print only where
      they went.
- [ ] **Misleading label.** The install tray calls every provisioned credential "Basic-auth
      credentials", also when it is an app admin login or a shared secret (e.g. a document
      server's JWT secret). Use the package's own label/`credentialsNote`.
- [ ] **Show-once generated secrets.** Let a package mark a generated secret as shown once to the
      operator (so it does not have to abuse `provisionedCredentials` for e.g. a JWT secret).
- [ ] **Unexpose on a retained instance.** `harbor unexpose` right before `purge` failed with
      `INVALID_STATE: exposure changes require an installed instance; <app> is retained` although
      the app looked installed; purge then removed the route anyway. Reproduce and fix the state check
      or the message.
- [ ] **Secret inside a literal env value.** Images without a shell cannot assemble e.g. a
      database URL in `command:`; allow a secret reference inside an environment literal
      (rendered by Harbor, never logged).
- [ ] **Validate a package folder locally.** No CLI/route to run the daemon's validators on a
      folder before pushing a git source (`harbor packages validate <dir>`).
- [ ] **`<` and `>` in package text.** Setup instructions cannot show `Bearer <token>` or
      `https://<domain>/`; allow them as text (it is rendered as text anyway) or document an
      alternative.
- [ ] **API-only apps.** Every app must have a main web endpoint, so an API (e.g. an MCP gateway)
      still shows an *Open* button; allow an endpoint kind "api" with no browser launch.
