# Design: Access Guard (allowed addresses for public apps)

**Status:** built in 0.48.0 (decisions 207–209). Requirements agreed with Carlos 2026-11-20.
**Extends:** [EXPOSURE.md](EXPOSURE.md) (public HTTPS through Caddy); reuses the root handoff of [VPN.md](VPN.md).
**User manual:** OPERATOR_GUIDE.md "Allowed addresses". **Package format:** DEVELOPER_PACKAGES.md
(`network.requireVpn`, `provides.ipLookup`).

## 1. Goal

Drop every connection to Harbor's public apps unless it comes from an address on one allowed list. Tag addresses,
count what was dropped, look up where an address is on demand, and (optionally) ask online services about it through
the VPN.

## 2. Constraints from the code

- Every public app shares Caddy's `:443`; a firewall rule sees address + port, never the app.
- Let's Encrypt validates from unpublished addresses: `:80` stays open (Caddy only redirects or answers ACME there).
- Docker-published ports (VPN-server apps, decision 163) go through FORWARD, not INPUT: not covered.
- The console is never public; LAN, tailnet and loopback are exempt, so a wrong list cannot lock the admin out.
- The egress root handoff (decision 184) is the pattern: pure rule builder, `harbor-guard@<action>`, fake provider.

## 3. Decisions (2026-11-20)

| # | Question | Decision |
|---|---|---|
| D1 | Per-app lists or one global list? | **One global list.** The firewall alone enforces it. Per-app lists (Caddy `remote_ip` + `abort`) are FUTURE. |
| D2 | Phone data | **The UI says it:** reach apps from a phone through the tailnet. |
| D3 | Location source | **Local database only** (DB-IP Lite country + ASN). Online lookups only through an app (D6–D8). |
| D4 | Retention of dropped addresses | Not answered; built with the draft default: **30 days**, kept longer when tagged, at most 5000 addresses. |
| D5 | Hairpin NAT | **Exempt the box's own public address** (the A/AAAA records of its public names, re-resolved every check). |
| D6 | What the online lookup is for | **Both** reputation (abuse score, hosting/VPN/Tor flags) and richer location. |
| D7 | "Requires VPN" | **A general package field**, `network.requireVpn` (decision 208). |
| D8 | One app or one per service | **One app, IP Lookup**, wrapping ipinfo and AbuseIPDB (decision 209). |

## 4. How it works

```
internet ──► :443 (tcp/udp) ──► nft inet harbor_guard (input, filter − 10)
                                   lo / tailscale0 ............ accept
                                   exempt4/6 (LAN, CGNAT, own) . accept
                                   allow4/6 (the list) ......... accept
                                   ct new → update @seen4/6 (per-source counter)
                                   drop
                                └─► Caddy ─► app (only if accepted)
```

- **Daemon** (`src/guard/service.ts`): the list is the `access-guard` settings document; a change is applied by root
  at once and saved only when it loaded (fail closed). Every 10 minutes (and *Check now*) it reads the counters
  (`status`), drops expired entries, re-resolves the public names, and notifies. A reload recreates the counting sets,
  so the counters are read before every apply. The dropped-address record is `<stateDir>/guard/addresses.json`.
- **Root** (`src/bootstrap/guard-apply.ts`, `harbor guard-step <apply|off|status>`): re-validates the state, loads it
  with `nft -f` from a root-only file, keeps `/etc/harbor/guard/rules.nft` and reports `nft -j list set` counters.
- **Boot**: `harbor-guard.service` loads `rules.nft` before Caddy; Caddy *requires* it (`RequiredBy=caddy.service`),
  so a list that fails to load keeps the public apps down. Skipped while the guard is off (no rules file).
- **Location** (`src/guard/geo.ts`, `src/guard/mmdb.ts`): DB-IP Lite `.mmdb.gz` downloaded on first lookup (current
  month, else the previous one), refreshed after 35 days, read by Harbor's own MaxMind DB reader.
- **Online** (`src/guard/online.ts`): `GET http://127.0.0.1:<port><path>?ip=` on a running app with
  `provides.ipLookup`; only documented fields are kept.

## 5. Requirements as built

| ID | Requirement | State |
|---|---|---|
| G1 | Settings → Allowed addresses: Everyone / Allowed list only; asks before turning on | built (host setting, like the VPN page, not a plan) |
| G2 | Entries: IPv4/IPv6 address or CIDR, label, tags, optional expiry | built (/8 and /16 limits) |
| G3 | Strict default: an empty list lets nobody in | built |
| G4 | Drop, never reject | built |
| G5 | Exempt LAN, tailnet, loopback, own public address; :80 open | built |
| G6 | Per address: packets, first/last seen; 30 days | built (packets, not tries: one try ≈ 2–3) |
| G7 | Allow / Tag / Look up from a dropped address | built |
| G8 | Location from the local database only | built |
| G9 | "Allow the address I'm using now" | dropped: the console is never public |
| G10 | Notifications: busy address (≥ 300 packets between checks), entry expiring in 24 h | built |
| G11 | CLI `harbor access …` | built |
| G12 | Rules persist and fail closed at boot | built |
| G13 | Phone note | built |
| L1–L4 | Per-app lists, country filter, DDNS entries, Docker-published ports | FUTURE |

## 6. Evidence

- Unit: `tests/unit/access-guard.test.ts` (addresses, ruleset, a real nft 1.0.9 counter answer, MMDB reader, lookup
  answers). Integration: `tests/integration/access-guard.test.ts` (fake provider: list, counters across reloads, tags,
  expiry, fail closed, notifications, requireVpn, provides.ipLookup). E2E: `ui.spec.ts` decision 207.
- Kernel: the generated ruleset loaded and reloaded in an Ubuntu 24.04 container (nft 1.0.9, Docker Desktop,
  2026-11-20); the allowed and own addresses got HTTP 200, two others were dropped and counted (4 and 2 packets).
- Not yet: a droplet run with Caddy and a real public domain (VERIFICATION.md says so).
