# n8n with PostgreSQL (Harbor package)

Workflow automation (`n8nio/n8n`) backed by a private PostgreSQL 16 database. Both services run in
one Compose project on a private bridge network; only n8n's HTTP port is published, on loopback.

## What this package provides

- `web` (n8n, container port 5678) published on a loopback host port allocated by Harbor.
- `postgres` (PostgreSQL 16) reachable only from `web` over the project network; no published port.
- Retained volumes: `database` (PostgreSQL data at `/var/lib/postgresql/data`) and `app-state`
  (n8n's `/home/node/.n8n`, which stays required even with PostgreSQL).
- Generated, retained secrets: `database-password` (bound to both services) and `encryption-key`
  (`N8N_ENCRYPTION_KEY`). A second n8n instance gets different keys and volumes.
- Generated URLs: `N8N_EDITOR_BASE_URL` and `WEBHOOK_URL` are set to the stable browser URL
  `http://localhost:<allocated-port>/`. These are local callback URLs, not public webhook endpoints.

## Readiness and onboarding

- Harbor's readiness check is `GET /healthz/readiness` (database connection and migrations), not
  `/healthz` alone.
- n8n's own owner account setup is **separate** from Harbor. "Installed/healthy" means n8n answers;
  it does not mean an owner exists. Open the instance and complete the setup form.
- n8n uses a secure session cookie; open it at `http://localhost:<port>/` (a secure browser
  context). Do not disable `N8N_SECURE_COOKIE` to reach it over a LAN IP; that exposure is unsupported.

## Version notes

- n8n 2.x ships task runners enabled by default in internal mode (the runner runs inside the
  `web` container). No separate runner container is needed for this release; a workflow without
  Code nodes is what the qualification demonstrates. Advanced external-runner setups are not qualified.
- PostgreSQL 16.x data layout matches the `database` mount; do not switch majors on a retained volume.

## Provenance

- `n8nio/n8n` tag `2.38.7` (what the upstream `stable` tag resolved to on 2026-09-14), pinned by digest.
  Source: https://github.com/n8n-io/n8n (Sustainable Use License).
- `postgres` tag `16.15` (Docker Official Image), pinned by digest. Image declares `VOLUME /var/lib/postgresql/data`, claimed as `database`.
- Platform: linux/amd64.
