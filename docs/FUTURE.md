# Future context: Nextcloud with a document server (not implemented)

TDD.md section 14 describes a later goal: installing Nextcloud together with a browser document
server (ONLYOFFICE Docs or Collabora Online). **Nothing of it is implemented, provisioned or
claimed in this release**, and no catalog entry, schema field, proxy or provider infrastructure was
added for it. This note records how the current code already leaves room for it, and what remains.

## What the current implementation already provides

| Property (TDD 14.3) | Where it holds today |
|---|---|
| Instance identity distinct from product name; resources owned per instance | `instances.id` (UUID) → project `hb_<uuid>`; every container/volume/network carries `io.harbor.preview/instance`. Two n8n instances have separate volumes and keys. |
| Multiple services, declared volumes, named endpoints per package | Manifest `deployment.services`, `storage[]`, `endpoints{}` are maps keyed by ID; n8n already has two services and two volumes. No one-container/one-port assumption in the engine. |
| Browser URLs separate from container/host targets | State stores `hostPort`; `browserUrlFor()` in `src/config.ts` is the only place that renders `http://localhost:<port>/`. Readiness probes `127.0.0.1:<hostPort>`. A future proxy changes that one rendering/access function, not packages. |
| Secrets referenced by instance + secret ID | `secrets/<id>` files under the instance directory; bindings are manifest data. No global "office password" concept exists. |
| Validation/rendering separate from lifecycle I/O | `src/packages/*` and `src/planner/*` are pure; only `src/docker/*` and `src/lifecycle/runner.ts` perform I/O. |
| Readiness distinct from user setup | `installState`/`readiness` vs. the manifest `setup` guidance shown separately in UI/CLI. A landing page answering HTTP is never treated as "integration works". |

## What a future integration would still need (deliberately not built)

1. **Deployment relationship choice** per TDD 14.1: bundled office service inside one instance
   (preferred first), explicit binding between instances (only if sharing is really needed), or
   AIO delegated management through the parent's interface. Each is a package/schema extension
   with its own tests; none exists now.
2. **Routing**: browser-reachable URLs for Nextcloud *and* the office server, with HTTPS as the
   connectors require. Loopback `http://localhost:<port>` is the only exposure policy in this release.
3. **Server-to-server URLs**: the office service must fetch documents from Nextcloud and call back
   to save; inside a container `localhost` is the container itself. Internal targets must be
   authorized explicitly (no global SSRF-protection disable), and TLS verification kept.
4. **Connector configuration and credentials**: JWT/shared secret scoped to the relationship,
   configured through a supported Nextcloud API/occ step with stable IDs and postcondition checks
   (no blind re-creation).
5. **Integration verification**: log in, upload a synthetic document, open, edit, save, reopen and
   check the change. Only that counts as "working"; the UI must show setup-required/degraded
   separately from container health.

Backups remain configuration and Harbor-owned recovery secrets only; Nextcloud files, databases and
documents stay the application's/administrator's responsibility.
