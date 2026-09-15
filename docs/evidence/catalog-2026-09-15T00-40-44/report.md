# Catalog qualification catalog-2026-09-15T00-40-44

Host: Ubuntu 24.04.4 LTS x86_64, Docker 29.8.0, Compose 5.5.1, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| jellyfin | pass | healthy after 37s; page title "fc7eb1d1980d"; health 200; removed after the check; volumes and folders retained |
| jellyfin (external storage) | fail | harbor install jellyfin --name jellyfin-q0040x --storage media=/srv/harbor-test-storage/jellyfin-media --yes exited 3:  {
  "error": {
    "code": "OWNERSHIP_CONFLICT",
    "message": "/srv/harbor-test-storage/jellyfin-media overlaps /srv/harbor-test-storage/jellyfin-media, already used by instance jellyfin-q0013x",
    "nextAction": "Choose a different folder; two apps must not share or nest their storage."
  }
}
 |
| uptime-kuma | pass | healthy after 23s; page title "Uptime Kuma"; health 302; removed after the check; volumes and folders retained |
