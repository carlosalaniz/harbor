# Navidrome

Modern music server and streamer compatible with Subsonic and Airsonic apps. Point it at your music folder and play anywhere.

## What Harbor does

- Runs Navidrome on 127.0.0.1 with its database in a retained volume.
- Mounts your music folder read-only at /music.

## Storage

- `data`: Database, cache and settings.
- `music`: Your music library. You may point this at a folder of your own at install time (optional, mounted read-only): The folder with your music, mounted read-only at /music.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the app and create the admin user.
2. Use the web player or any Subsonic-compatible app with the published address.

Upstream: https://www.navidrome.org
