# harbor-ip-lookup

The container behind Harbor's **IP Lookup** app. When Access Guard blocks an address, the operator can ask
for an online lookup; Harbor's daemon calls this app on loopback, and the app asks ipinfo and/or AbuseIPDB
about that one address. One Node 24 process, no npm dependencies, no state on disk.

Image: `ghcr.io/carlosalaniz/harbor-ip-lookup` (amd64 + arm64). The tag is `version` in `package.json`;
`.github/workflows/ip-lookup-image.yml` builds it on push to `main` and never re-pushes a published tag,
so raise the version for every change. The job summary prints the digest to pin in the app package.

## Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port (all interfaces inside the container). |
| `LOOKUP_IPINFO` | `true` | Ask ipinfo. Works without a token (rate limited). |
| `IPINFO_TOKEN` | unset | ipinfo token, sent as `?token=`. |
| `LOOKUP_ABUSEIPDB` | `true` | Ask AbuseIPDB — only when a key is set too. |
| `ABUSEIPDB_KEY` | unset | AbuseIPDB API key (`Key` header). |

An empty value counts as unset. Keys are never shown on the page, logged or returned.

## API

- `GET /healthz` → `200 {"ok":true}`. Never calls out, so it answers offline.
- `GET /v1/lookup?ip=<IPv4|IPv6>` → `400 {"error":"..."}` for anything that is not an address, else `200`:

  ```json
  { "format": 1, "ip": "203.0.113.5", "cached": false, "results": [
    { "source": "ipinfo", "ok": true, "country": "US", "region": "Virginia", "city": "Ashburn",
      "asn": "AS64500", "org": "Example Hosting", "hostname": "x.example.net", "flags": ["hosting"] },
    { "source": "abuseipdb", "ok": true, "abuseScore": 87, "reports": 412,
      "lastReportedAt": "2026-11-19T10:00:00+00:00", "usage": "Data Center/Web Hosting/Transit",
      "hostname": "y.example.net", "country": "US", "flags": ["tor"] }
  ] }
  ```

  A failed service is `{ "source": "...", "ok": false, "error": "HTTP 429" | "timed out" | "network error" | "invalid response" }`;
  the others still answer. Flags: `vpn`, `proxy`, `tor`, `relay`, `hosting` (ipinfo privacy data, paid plans),
  `bogon`, and `tor` from AbuseIPDB. Missing fields are left out; strings are cut at 200 characters.
  With no service on: `{ "format": 1, "ip": "...", "results": [], "note": "No lookup service is turned on. ..." }`.
- `GET /` → a small page to look up an address by hand (`/app.js` is its script).

Each service has 8 seconds. Answers with at least one `ok` result are cached in memory for 24 hours
(5000 addresses at most) and come back with `"cached": true`. Other methods → 405, other paths → 404.

## What leaves the box

The looked-up address goes to the services that are on (ipinfo, AbuseIPDB), together with the token/key.
Nothing else is sent. Harbor installs this app only behind its VPN, so the services see the VPN's address,
never the Harbor box's own.

## Develop

```sh
node --test images/ip-lookup/test.mjs
docker build -t harbor-ip-lookup:dev images/ip-lookup
docker run --rm -p 127.0.0.1:18089:8080 harbor-ip-lookup:dev
```
