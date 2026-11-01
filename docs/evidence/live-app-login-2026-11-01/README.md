# Live: Harbor's app login on harbor-old (2026-11-01, Harbor 0.41.0 build, decision 194)

Host: harbor-old (Kubuntu 24.04, kernel 6.8, Docker 29.8.1, Compose 2.29.2, LAN mode), self-updated as root to the local
0.41.0 archive (`--allow-unsigned`). App: `comfyui-gpu` (ComfyUI, no login of its own, WebSocket UI).

| Check | Result |
|---|---|
| `harbor app-login comfyui-gpu on --generate --yes` | 27 s (pulled the pinned `node:24-alpine` once); `harbor_gate_web` publishes `0.0.0.0:18081->8080`, the app keeps only `8188/tcp`; readiness passed through the gate |
| curl | a browser navigation gets `303` to `/.harbor-gate/login?next=/`; `/api/queue` 401 without or with a wrong password, 200 with basic auth; the health path `/system_stats` 200 with an empty body |
| Browser (Playwright, SSH tunnel) | the Harbor page (`login-page.png`); after the password, ComfyUI loads and its WebSocket `/ws` connects and receives frames (`comfyui-after-login.png`; the red nodes are models this test box lacks) |
| `harbor app-login comfyui-gpu off --yes` | "removed the login in front of comfyui-gpu"; the app publishes 18081 again, `/api/queue` 200 without a login; the password is kept (`PASSWORD set`) |

The Open WebUI → ComfyUI link kept working throughout: links reach the app's service on their private network, never
through the gate. `login-page-dark-phone.png`: the page in dark mode at phone width after a wrong password.
