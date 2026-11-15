# Design: Spaces (decision 202)

**Status:** approved direction (Carlos, 2026-11-15): "a 'spaces' concept where I can group apps in spaces that share
(or not) a network, also for easier access. […] 'AI tooling' […] 'Productivity' […] I could add an instance of Open
WebUI to productivity so it can connect and use the ERP MCP." Choices made with him: isolated stays the **default**;
a shared network is an **explicit, insecure opt-in** for operators who know what they do; peers reach each other by
**stable names** (`erpnext:8080`), not by IP. First shipped in 0.46.0.

## 1. What the operator sees

- **Home → New space** makes a space (a name), picks its apps, renames or deletes it. An app is in at most one space.
  Home shows each space as its own section under the apps that are in none.
- A space is **grouping only** by default: nothing about the apps' networks changes.
- **Share a network** (a switch on the space, off by default) puts every app of the space on one private network.
  Turning it on asks for a confirmation that says what it costs, in these words:
  *Every service of these apps, databases included, can reach every other one. Harbor's app login does not apply
  between them; only each app's own login does. Turn it on only for apps you trust with each other's data.*
- With sharing on, the app page (*Access → Space*) lists the addresses other apps of the space use: a URL with the
  container port for a service that serves an endpoint (`http://erpnext:8080`), the bare name for any other service
  (`erpnext-db`; Harbor does not know a database's port). Paste one into the other app (Open WebUI → MCP server URL).
  The overview tab shows the space's name.
- CLI: `harbor spaces`, `harbor spaces create <name> [--app <app>…]`, `add|remove <space> <app…>`,
  `rename <space> <name>`, `share <space> --yes`, `unshare <space>`, `delete <space>`.

## 2. Names on the shared network

Every container of a member app joins `hb_space_<spaceId>` with only the names Harbor gives (the decision 171 rule
for links: attached by the runner, never by Compose, so no app's service name is ever an alias there):

| Name | Container |
|---|---|
| `<app>` | the service of the app's first endpoint (the one its tile opens) |
| `<app>-<service>` | every service of the app (`erpnext-db`, `erpnext-backend`, …) |

`<app>` is the instance name (`[a-z][a-z0-9-]{0,62}`), so names are unique per machine except for one case:
`erp` + service `next` and an app called `erp-next`. Harbor refuses to add an app (or to turn sharing on) when two
members would answer to one name, when a name is longer than 63 characters, or when a name equals a service name of
a member (Docker resolves a name on any network a container is on, so `db` there would shadow an app's own `db`).
Ports are the containers' own ports; an alias cannot change a port.

Harbor's login gate (decision 194) containers do not join: peers reach the service itself, as links do.

## 3. How it works

- **State:** the settings doc `spaces` (`{items: [{id, name, shared, apps: [instanceId]}]}`), no migration. Removed
  or uninstalled apps drop out on read and on the next write.
- **Routes:** `GET/POST /v1/spaces`, `PATCH/DELETE /v1/spaces/:id`. Turning sharing on needs `confirmShared: true`
  in the same request (409 `PERMISSION_REQUIRED` without it), like accepting a permission.
- **Docker changes go through the queue.** A route only writes the desired state. Each installed app whose network
  membership changes gets a `space` operation (plan → operation, internal actor `space-policy`, like `vpn-policy`):
  the runner attaches or detaches its containers live (nothing is recreated, no restart), creates the network when
  missing (internal: no route out, nothing published; a Harbor /24, decision 191) and deletes Harbor's space
  networks that no shared space wants and no container uses.
- **Every start re-attaches.** `upAndRecord` attaches the app's containers right after Compose creates them (a
  Restart, update or repair recreates containers, which drops a live attachment). Remove/uninstall prunes networks
  left empty.
- **Ownership:** the network carries the installation label, kind `space` and the space id; Harbor never uses or
  deletes a network it did not label.
- **VPN/offline (decisions 184–185):** the network is internal, so it gives no app a route out. Traffic on it comes
  from the space's subnet, so an offline app can still talk to its peers, the same as a link. Said in the warning.

## 4. Not built (yet)

- Endpoint-only sharing (only endpoint services join, databases stay private). The link model already covers one
  app reaching one endpoint; a space-wide version can come later.
- Per-space backup/start/stop actions, per-space access for other users.
- Arranging tiles inside a space section (the saved launcher order applies; *Arrange* moves apps outside spaces).
