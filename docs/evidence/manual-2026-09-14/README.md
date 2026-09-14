# Manual live checkpoint, 2026-09-14 (before the automated suite existed)

Droplet `harbor-test` (fresh Ubuntu 24.04.4 x86_64, no Docker/Node/npm).

- `bootstrap-1.log`: first real bootstrap from the release archive with `--yes --install-docker --with-tools --password-stdin`.
  Installed Docker Engine 29.8.0 / Compose 5.5.1 from download.docker.com, Harbor 0.1.0 (bundled Node v24.12.0),
  **Cockpit via the managed path** (apt install, `cockpit.socket` restricted to 127.0.0.1:9090), Portainer CE 2.39.7 on 127.0.0.1:9443.
- Afterwards via the bundled CLI: `install excalidraw` (37 s, http://localhost:18080/), `install bentopdf`, `install n8n`
  (readiness `/healthz/readiness` returned 503 during migrations, then 200). `ss -ltnp` showed 18000/9090/9443/18080 bound to 127.0.0.1 only.
- `excalidraw-export.png`: PNG exported from the live Excalidraw through the browser (Playwright reconnaissance).
- `bentopdf-merged.pdf`: 2-page PDF merged by the live BentoPDF from two generated fixtures.
- n8n owner created through the setup form; credential + workflow created via REST; manual execution `success`; the
  gateway fixture logged the credentialed call (`/n8n-demo`, ok=true).
