# Design addendum: exposure (private tailnet and public HTTPS)

**Status:** approved direction (Carlos, 2026-09-14), implementation on branch `exposure`.
**Extends:** [TDD.md](../spec/TDD.md) sections 2, 5, 7, 8, 10. Everything the TDD says about the MVP
stays true; this adds an *exposure* layer on top of the loopback-only baseline.

## 1. Goal

Let the administrator publish an installed app beyond `http://localhost:<port>` in two canonical ways:

| Path | Who can reach it | Transport | Provider on the host |
|---|---|---|---|
| `loopback` (baseline, unchanged) | this machine / SSH forwarding | HTTP on 127.0.0.1 | none |
| `tailnet` (private cloud) | devices in your Tailscale tailnet | HTTPS with tailnet certificates | `tailscaled` + `tailscale serve` |
| `public` (internet) | anyone who resolves the name | HTTPS with Let's Encrypt | Caddy on the host, admin API on 127.0.0.1:2019 |

The Harbor UI/API itself may be exposed on the tailnet (so you can administer remotely) and is
**never** exposed publicly.

## 2. Principles carried over from the MVP

1. **Exposure is a Harbor concept, not a package hook.** Packages describe what an endpoint is
   (`service`, `containerPort`, `browserContext`). The administrator decides per instance how it is
   published. No package code runs; no registration hooks; adding exposure to a package needs no
   package change.
2. **Apps keep binding to 127.0.0.1.** Providers on the host reverse-proxy to the already allocated
   loopback port. Nothing is republished on 0.0.0.0, no container networks are shared, no Docker
   socket is handed to a proxy.
3. **Every change is a plan → operation** through the same serial queue, idempotency and ownership
   checks. Provider config is owned by Harbor and reconciled from state; nothing is edited by hand.
4. **Off-loopback means HTTPS.** n8n's session cookie is `Secure`, BentoPDF needs a secure context.
   Both providers terminate TLS; there is no plain-HTTP LAN mode.
5. **Honest state.** An exposure is `active` only after Harbor has verified the provider answers on
   the published address; DNS not resolving, certificate pending or provider down are visible states.

## 3. Model

### 3.1 Exposure records

New table `exposures` (instance FK; unique `(via, hostname, port)`). Until schema v9 it was also unique
per `(instance_id, endpoint_id, via)`; since v10 (decision 127) an endpoint may carry **several public
rows, one per hostname** — tailnet and your-own-proxy stay one per endpoint, enforced at plan time:

| Column | Meaning |
|---|---|
| `via` | `tailnet` \| `public` |
| `endpoint_id` | manifest endpoint |
| `hostname` | tailnet: the node's MagicDNS name (read from `tailscale status`), public: administrator-supplied FQDN |
| `port` | tailnet: same number as the loopback host port (443 is reserved for the Harbor UI when exposed); public: 443 |
| `protection` | `none` \| `basic` (generated username/password stored as a retained instance secret; Caddy basic_auth). Default `basic` for endpoints whose package declares no own authentication (all three MVP packages except n8n). |
| `state` | `pending` \| `active` \| `degraded` \| `removing` |
| `observed_at`, `note` | last verification result |

`InstanceSummary.endpoints[]` gains `urls: { loopback, tailnet?, public? }` and `primary` (which URL
is handed to the app's `configuration` bindings). `browserUrl` stays as the loopback URL for
compatibility.

### 3.2 Primary URL and reconfigure

Apps that embed their base URL (n8n's `N8N_EDITOR_BASE_URL`, `WEBHOOK_URL`) must be told which URL
users will use. Each instance has one *primary* exposure (`loopback` by default). Changing it is a
`reconfigure` operation: re-render the private Compose file with the new URL, `compose up` (Compose
recreates only the changed service), same volumes, same secrets, same ports, then readiness. This
reuses the reinstall path; the only new code is "which URL does `browserUrlFor` render for this
instance". Packages without `configuration` bindings need no reconfigure.

With several public hostnames (decision 127) the main one is explicit: `instances.primary_host`
(`NULL` = the first one published, in `created_at, rowid` order). `primaryUrlFor` / `endpointUrls`
pick it through `mainPublicExposure()`; `urls.public` is that main name and `ExposureDto.isPrimary`
is true only on its row. Every name is in `appAuthorities` (`HARBOR_ADDRESSES`). Withdrawing the main
name while others remain moves the main address to the next one (a `public` + `primaryHost` change
in the same plan, so apps that embed it are re-rendered); withdrawing the last one falls back to
loopback as before.

### 3.3 New plan kinds

`expose {instanceId, endpointId, via, hostname?, protection?, makePrimary?}`,
`unexpose {instanceId, endpointId, via, hostname?}`, `reconfigure {instanceId, primary, hostname?}`
(`hostname`, decision 127: which public name to withdraw — required when there are several — or to
make the main one). Plans show the exact
public address, provider, protection, and DNS/firewall prerequisites as `changes`/`warnings`.

## 4. Providers (platform tools, like Cockpit/Portainer)

### 4.1 Tailscale (`--with-tailscale`)

- Bootstrap installs `tailscale` from `pkgs.tailscale.com` (signed apt repo), previews and asks.
- Enrollment is the administrator's action: bootstrap runs `tailscale up` and prints the login URL,
  or accepts `--tailscale-authkey-stdin` (auth keys are secrets; never argv). Harbor records the node's
  DNS name and tailnet, and checks that MagicDNS + HTTPS certificates are enabled (`tailscale status`
  reports it); otherwise the tool card says `setup_required` with the exact admin-console step.
- Publishing: `tailscale serve --bg --https=<port> http://127.0.0.1:<hostPort>` per exposure; the
  port number equals the loopback port, so the mental model is "same port, three addresses":
  `http://localhost:18086`, `https://<node>.<tailnet>.ts.net:18086`, `https://n8n.example.com`.
  Harbor UI: `--https=443 → 127.0.0.1:18000` when the administrator runs `harbor expose --ui`.
- Harbor reconciles the full serve configuration from its own state (`tailscale serve status --json`
  is the observation); entries it did not create are reported, never removed.
- The daemon's Host/Origin allow-list is extended with the tailnet hostname while the UI exposure
  exists. Funnel (Tailscale's public path) is **not** used in this iteration.

### 4.1a Every app on Tailscale (decision 177, 0.33.0)

An opt-in policy in the `settings` table (`exposure.tailnetAll = { enabled, except: [instanceId] }`, no
migration). The observer (`src/lifecycle/tailnet-all.ts`, driven like the drive and lock guards, only on a
tick that saw Docker) never calls Docker or tailscale itself: for an app that needs an address it creates an
ordinary `expose` plan `{ via: 'tailnet', makePrimary: false }` with actor `tailnet-policy` and submits it.

- Eligible (pure `tailnetAllCandidates`): not removed, `installed`, no active operation, no plan open for
  review by someone else (an approve after the policy's operation would fail with `STATE_CHANGED`), running
  and healthy, its primary endpoint allocated, no tailnet exposure on its primary endpoint, not in
  `except`, not attempted since the daemon started. Every endpoint kind counts (an API is as useful on a
  laptop); other endpoints are out of scope.
- One plan at a time, and only while no instance has an active operation. `tailnetPort` (and app-port
  allocation) skip the ports held by open plans (not submitted, not expired: their tailnet address, and an
  install plan's app ports), so a background plan never takes the number a reviewed plan shows. The
  setting is read again after planning (which awaits tailscale and Docker): off or excluded meanwhile means
  the plan is never submitted.
- Readiness gate: `tailscale status` Running, online, with a DNS name and HTTPS certificates. Turning the
  policy on is refused (`UNSUPPORTED_CAPABILITY` + next action) otherwise; while on and not ready the
  status is `waiting` with the reason, and nothing is planned.
- One attempt per (instance, daemon start); a success clears it (attempts only stop failure loops). A
  submit refusal that only means "not now" (`BUSY`, `STATE_CHANGED`, `PLAN_EXPIRED`, `DOCKER_UNAVAILABLE`)
  is no attempt. A failed plan or operation is kept in memory, shown as `failed` with the reason and raised
  as one `tailnet-all-failed` notification per app (`tailnet-all:<id>`; the runner skips its generic
  `operation-failed` row for this actor); an operation that failed after its address was recorded (a
  later hook) counts as published. Including the app again (`PUT /v1/instances/:id/tailnet-all
  {included: true}`) clears the attempt; the plan comes at the next check. A tailnet expose whose
  `tailscale serve` fails runs a best-effort `serve … off` and deletes the exposure row it inserted (no
  `pending` row, no orphan serve entry). A daemon restart in the middle of an expose, unexpose or
  reconfigure leaves the app's `installState` as it was (the operation alone is `needs_action`), as a
  failure of those kinds already did.
- Exceptions: the drawer switch sets/clears one (shown while the policy is on, or while Tailscale is ready);
  it never withdraws an address. An `unexpose` of the primary endpoint's tailnet address submitted by
  anyone but `tailnet-policy`, with the policy on or off, adds the app (its plan says so). Purged instances
  are dropped from `except` (when the observer's check or a write next runs; reads filter them); a retained
  one keeps its entry so Reinstall honours it.
- Off never withdraws anything. Install plans carry a note while the policy is on, and a warning when the
  app has `setup` or `defaultCredentials` (its first-run page is reachable from the tailnet as soon as it
  answers; Harbor cannot tell when setup is done).
- Isolated since 0.42.0 (decision 196): `tailscale serve` targets a loopback relay on `hostPort + 10000` with the decision-167 cookie firewall and cross-app Origin checks; headers pass untouched. A new Harbor starts with the policy on, an existing one is asked once (decision 197).
- API: `GET`/`PUT /v1/exposures/tailnet-all` (`TailnetAllDto`: enabled, status off|waiting|on, reason,
  nextAction, except, apps[] with published|pending|waiting|failed|excluded; GET writes nothing), `PUT
  /v1/instances/:id/tailnet-all`. CLI: `harbor tailscale every-app [on|off] [--app <app>] [--yes]`.

### 4.2 Caddy (`--with-public-proxy`)

- Bootstrap installs `caddy` from Caddy's signed apt repo, keeps the admin API on 127.0.0.1:2019,
  and replaces the default Caddyfile with a Harbor-owned JSON config (marker + `@id` on every route).
- Per exposure Harbor pushes one route: `host == <fqdn>` → `reverse_proxy 127.0.0.1:<hostPort>`,
  optional `basic_auth`, security headers, request body limit. TLS is automatic (HTTP-01 / TLS-ALPN)
  and needs ports 80/443 reachable from the internet plus an A/AAAA record; Harbor verifies the
  record resolves to one of the host's public addresses before activating and reports otherwise.
- DNS automation is optional: with `--dns-provider digitalocean` and a token supplied on stdin,
  Harbor creates/removes the A record itself (token stored as a platform secret). Without it, the plan
  prints the record to create.
- The Harbor UI is refused for `public` at the API level.
- Why Caddy rather than Nginx Proxy Manager: documented, stable admin API and automatic TLS make it
  reconcilable from state; NPM's API is undocumented and UI-oriented. NPM stays possible later as a
  manually operated proxy, outside Harbor's control.

### 4.3 Ownership and removal

Exposures are instance-owned resources like containers: `remove <instance>` unexposes first (routes
and serve entries are deleted, DNS records only if Harbor created them), and provider entries not
created by Harbor are never touched. Uninstalling a provider requires no active exposures.

## 5. Bootstrap, CLI, API, UI

- Bootstrap: `--with-tailscale`, `--with-public-proxy`, each previewed and separately approved;
  re-run idempotent; existing installations are bound, not reconfigured (same policy as Cockpit).
- CLI: `harbor expose <instance> [--endpoint id] --via tailnet|public [--host fqdn] [--protect none|basic] [--primary]`,
  `harbor unexpose ... [--host fqdn]`, `harbor primary <instance> public [--host fqdn]`, `harbor exposures`,
  `harbor expose --ui --via tailnet`. Running `expose --via public` again with another `--host` adds a
  second public name (decision 127).
- API: `POST /v1/plans` with the new kinds; `GET /v1/exposures`; tool cards for `tailscale` and `proxy`.
- UI: each installed card shows its addresses with copy buttons and a "Publish…" dialog (choose
  path, hostname, protection, make primary; each public name has its own Withdraw and Make primary,
  plus **Add another domain**); tool cards show enrollment/certificate/DNS states with
  the exact next action.

## 6. Security posture (stated plainly)

- Public exposure puts the *app* on the internet. Apps without their own login get `basic`
  protection by default; the administrator can opt out per exposure and the UI says so in red.
- The Harbor UI/API is loopback and tailnet only. Tailnet exposure relies on your tailnet ACLs.
- Caddy and tailscaled run as host services with their own upstream update channels; Harbor does not
  update them.
- Generated basic-auth credentials are retained instance secrets, shown once at creation.
- LAN apps share one host name (`harbor.local:<port>`), so browsers share their cookies. The LAN HTTPS
  relay is the cookie firewall (decision 167): HttpOnly cookies an app sets become
  `[__Host-|__Secure-]hb_<tag>__<name>=<value>.<sig>` (tag = 8 hex of sha256(instance id); sig = 16 bytes of
  HMAC-SHA256 over tag, name, value with `<state>/cookie-firewall.key`; Secure forced, Domain dropped); on
  the way in only this instance's validly signed cookies come back under their own names, other tags and
  forgeries are dropped, as is an untagged cookie shadowing a signed name (an older untagged copy the
  request carried is cleared when the app sets the name again); no app response may set a name shaped like
  a tagged cookie (dropped, whatever its size or mode); unsafe methods and WebSocket handshakes whose Origin
  is another instance's port on the same host get a 403, and so do those with `Origin: null` or none that the
  browser marks `Sec-Fetch-Site: same-site` (a redirect hop through another app hides the origin but keeps
  SameSite cookies). An endpoint may declare `cookies: shared` (its own cookies untagged, no shadow check).
  A link re-render with no restart keeps the binding of the file it replaces, so `rebindToApply` follows
  the running containers. *HTTPS only* (`network.httpsOnly`) renders app ports on
  127.0.0.1 with `x-harbor: {lanAccess: relay}` in the runtime file (the relay serves those) and turns the
  plain-http console (daemon `:80` and Caddy's `harbor_lan`) into a 307 to https except
  `GET /v1/network/https/ca.crt` and `/probe`. Not covered: plain-http app ports while HTTPS only is off,
  tailnet addresses (`tailscale serve` targets the app port directly, decision 133), non-HttpOnly cookies.

## 7. Acceptance additions (B-matrix, live on the designated VM)

| ID | Test |
|---|---|
| B01 | Fresh bootstrap with `--with-tailscale --with-public-proxy`; both tool cards honest (`setup_required` until enrolled / DNS ready); re-run idempotent |
| B02 | Expose Excalidraw on the tailnet; open `https://<node>.<tailnet>.ts.net:18080` from a tailnet client and draw/export |
| B03 | Expose Harbor UI on the tailnet; log in from a tailnet client; public exposure of the UI is refused |
| B04 | Expose n8n publicly on `<name>.apein.space` as primary; owner login and workflow run through the public URL (Secure cookie works); webhook URL reflects the public address |
| B05 | Expose BentoPDF publicly with `basic` protection; unauthenticated request gets 401; authenticated merge works |
| B06 | Unexpose and remove: routes/serve entries/DNS records Harbor created are gone; entries it did not create remain |
| B07 | Provider down (stop caddy / tailscaled): exposures show `degraded`, apps still fine on loopback |
| B08 | Reboot: exposures return with the apps |
| B09 | Reconfigure primary back to loopback; n8n works locally again |
| B10 | Negative: invalid hostname, hostname already used by another exposure, DNS pointing elsewhere → clear errors, no partial config |

## 8. Out of scope for this addendum

Tailscale Funnel, LAN plain-HTTP, path-based routing (`/app` prefixes), wildcard certificates,
per-user access control inside apps, NPM management, exposing infrastructure services (PostgreSQL).
