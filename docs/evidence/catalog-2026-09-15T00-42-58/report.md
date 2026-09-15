# Catalog qualification catalog-2026-09-15T00-42-58

Host: Ubuntu 24.04.4 LTS x86_64, Docker 29.8.0, Compose 5.5.1, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| jellyfin | pass | healthy after 31s; page title "ddcb45c82584"; health 200; removed after the check; volumes and folders retained |
| jellyfin (external storage) | pass | healthy after 32s; page title "6aad5ee64d56"; health 200; external storage: --storage media=/srv/harbor-test-storage/jellyfin-media-q0042 mounted as bind; removed after the check; volumes and folders retained |
