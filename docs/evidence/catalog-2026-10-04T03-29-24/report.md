# Catalog qualification catalog-2026-10-04T03-29-24

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.8.2, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| audiobookshelf | pass | healthy after 41s; page title "Audiobookshelf"; health 200; removed after the check; volumes and folders retained |
| audiobookshelf (external storage) | pass | healthy after 27s; page title "Audiobookshelf"; health 200; external storage: --storage audiobooks=/mnt/harbor-test-storage/audiobookshelf-audiobooks-q0329 --storage podcasts=/mnt/harbor-test-storage/audiobookshelf-podcasts-q0329 mounted as bind; removed after the check; volumes and folders retained |
| excalidraw | pass | healthy after 58s; page title "Excalidraw Whiteboard"; health 200; removed after the check; volumes and folders retained |
| memos | pass | healthy after 24s; page title "Memos"; health 200; removed after the check; volumes and folders retained |
| navidrome | pass | healthy after 33s; page title "Navidrome"; health 200; removed after the check; volumes and folders retained |
| navidrome (external storage) | pass | healthy after 25s; page title "Navidrome"; health 200; external storage: --storage music=/mnt/harbor-test-storage/navidrome-music-q0329 mounted as bind; removed after the check; volumes and folders retained |
