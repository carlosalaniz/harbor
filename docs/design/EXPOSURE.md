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

New table `exposures` (instance FK, unique `(instance_id, endpoint_id, via)`):

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

### 3.3 New plan kinds

`expose {instanceId, endpointId, via, hostname?, protection?, makePrimary?}`,
`unexpose {instanceId, endpointId, via}`, `reconfigure {instanceId, primary}`. Plans show the exact
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
  `harbor unexpose ...`, `harbor exposures`, `harbor expose --ui --via tailnet`.
- API: `POST /v1/plans` with the new kinds; `GET /v1/exposures`; tool cards for `tailscale` and `proxy`.
- UI: each installed card shows its addresses with copy buttons and a "Publish…" dialog (choose
  path, hostname, protection, make primary); tool cards show enrollment/certificate/DNS states with
  the exact next action.

## 6. Security posture (stated plainly)

- Public exposure puts the *app* on the internet. Apps without their own login get `basic`
  protection by default; the administrator can opt out per exposure and the UI says so in red.
- The Harbor UI/API is loopback and tailnet only. Tailnet exposure relies on your tailnet ACLs.
- Caddy and tailscaled run as host services with their own upstream update channels; Harbor does not
  update them.
- Generated basic-auth credentials are retained instance secrets, shown once at creation.

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
