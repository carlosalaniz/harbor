# Catalog qualification catalog-2026-09-15T00-13-13

Host: Ubuntu 24.04.4 LTS x86_64, Docker 29.8.0, Compose 5.5.1, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| actual | pass | healthy after 24s; page title "Actual"; health 200; removed after the check; volumes and folders retained |
| anythingllm | pass | healthy after 41s; page title "AnythingLLM / Your personal LLM trained on anything"; health 200; removed after the check; volumes and folders retained |
| audiobookshelf | pass | healthy after 31s; page title "Audiobookshelf"; health 200; removed after the check; volumes and folders retained |
| audiobookshelf (external storage) | pass | healthy after 20s; page title "Audiobookshelf"; health 200; external storage: --storage audiobooks=/srv/harbor-test-storage/audiobookshelf-audiobooks --storage podcasts=/srv/harbor-test-storage/audiobookshelf-podcasts mounted as bind; removed after the check; volumes and folders retained |
| bentopdf | pass | healthy after 30s; page title "BentoPDF - PDF Tools"; health 200; removed after the check; volumes and folders retained |
| excalidraw | pass | healthy after 52s; page title "Excalidraw Whiteboard"; health 200; removed after the check; volumes and folders retained |
| forgejo | pass | healthy after 28s; page title "Installation - Forgejo: Beyond coding. We forge."; health 200; removed after the check; volumes and folders retained |
| freshrss | pass | healthy after 25s; page title "Installation · FreshRSS: step 1"; health 200; removed after the check; volumes and folders retained |
| immich | pass | healthy after 131s; page title "Welcome 🎉 - Immich"; health 200; removed after the check; volumes and folders retained |
| immich (external storage) | pass | healthy after 55s; page title "Welcome 🎉 - Immich"; health 200; external storage: --storage library=/srv/harbor-test-storage/immich-library mounted as bind; removed after the check; volumes and folders retained |
| jellyfin | fail | fetch failed |
| jellyfin (external storage) | fail | health probe 503 not in 200 at http://localhost:18093/ |
| mealie | pass | healthy after 81s; page title "Login"; health 200; removed after the check; volumes and folders retained |
| memos | pass | healthy after 19s; page title "Memos"; health 200; removed after the check; volumes and folders retained |
| n8n | pass | healthy after 104s; page title "n8n.io - Workflow Automation"; health 200; removed after the check; volumes and folders retained |
| navidrome | pass | healthy after 25s; page title "Navidrome"; health 200; removed after the check; volumes and folders retained |
| navidrome (external storage) | pass | healthy after 20s; page title "Navidrome"; health 200; external storage: --storage music=/srv/harbor-test-storage/navidrome-music mounted as bind; removed after the check; volumes and folders retained |
| nextcloud | pass | healthy after 65s; page title "Nextcloud"; health 200; removed after the check; volumes and folders retained |
| nextcloud (external storage) | pass | healthy after 32s; page title "Nextcloud"; health 200; external storage: --storage data=/srv/harbor-test-storage/nextcloud-data mounted as bind; removed after the check; volumes and folders retained |
| open-webui | pass | healthy after 211s; page title "Open WebUI"; health 200; removed after the check; volumes and folders retained |
| open-webui (external storage) | pass | healthy after 84s; page title "Open WebUI"; health 200; external storage: --storage models=/srv/harbor-test-storage/open-webui-models mounted as bind; removed after the check; volumes and folders retained |
| uptime-kuma | fail | harbor install uptime-kuma --name uptime-kuma-q0013 --yes exited 1:  457",
      "at": "2026-09-15T00:34:31Z",
      "phase": "checking",
      "message": "readiness attempt 10: 302"
    },
    {
      "cursor": "458",
      "at": "2026-09-15T00:34:51Z",
      "phase": "checking",
      "message": "readiness attempt 20: 302"
    },
    {
      "cursor": "459",
      "at": "2026-09-15T00:35:11Z",
      "phase": "checking",
      "message": "readiness attempt 30: 302"
    },
    {
      "cursor": "460",
      "at": "2026-09-15T00:35:31Z",
      "phase": "checking",
      "message": "readiness attempt 40: 302"
    },
    {
      "cursor": "461",
      "at": "2026-09-15T00:35:51Z",
      "phase": "checking",
      "message": "readiness attempt 50: 302"
    },
    {
      "cursor": "462",
      "at": "2026-09-15T00:36:11Z",
      "phase": "checking",
      "message": "readiness attempt 60: 302"
    },
    {
      "cursor": "463",
      "at": "2026-09-15T00:36:31Z",
      "phase": "checking",
      "message": "readiness attempt 70: 302"
    },
    {
      "cursor": "464",
      "at": "2026-09-15T00:36:51Z",
      "phase": "checking",
      "message": "readiness attempt 80: 302"
    },
    {
      "cursor": "465",
      "at": "2026-09-15T00:37:11Z",
      "phase": "checking",
      "message": "readiness attempt 90: 302"
    },
    {
      "cursor": "466",
      "at": "2026-09-15T00:37:11Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 180s (last: 302); containers were kept for inspection"
    }
  ]
}
 |
| vaultwarden | pass | healthy after 85s; page title "Vaultwarden Web"; health 200; removed after the check; volumes and folders retained |
