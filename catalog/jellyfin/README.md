# Jellyfin

Free media system: stream your movies, shows, music and photos to any device, no subscription, no tracking.

## What Harbor does

- Runs the Jellyfin server on 127.0.0.1 with config and cache in retained volumes.
- Mounts the folder you choose at /media (or a managed volume if you choose none).
- Tells Jellyfin its published address so casting and clients get the right URL.

## Storage

- `config`: Jellyfin configuration and database.
- `cache`: Transcoding cache and thumbnails.
- `media`: Your media library. You may point this at a folder of your own at install time (optional): The folder that holds your movies, shows and music, for example /mnt/media. Mounted at /media inside Jellyfin.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open Jellyfin and complete the wizard (language, admin user).
2. Add a library and browse to /media.
3. Install a Jellyfin client on your TV or phone and point it at the published address.

## Notes

- Transcoding uses the CPU; direct play is preferred where possible.
- DLNA discovery is not available (the app runs on a private bridge network).

Upstream: https://jellyfin.org
