# Immich

High-performance photo and video backup for your phone, with search, faces, maps and sharing. Your own Google Photos.

## What Harbor does

- Runs the Immich server, machine-learning worker, PostgreSQL and Valkey on a private network; only the web UI is published on 127.0.0.1.
- Generates the database password once and keeps it as a retained secret.
- Stores originals in the folder you choose (or a managed volume) and the database in a retained volume.

## Storage

- `library`: Photos and videos (originals, thumbnails, encoded video). You may point this at a folder of your own at install time (optional): Pick a folder with plenty of room, for example /mnt/photos. Immich creates its own subfolders inside it.
- `database`: PostgreSQL database (metadata, faces, search index).
- `model-cache`: Downloaded machine-learning models.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open Immich, create the admin account.
2. Publish the app (tailnet recommended) so your phone can reach it, then install the mobile app and log in.
3. Turn on automatic backup in the mobile app.

## Notes

- Face recognition and smart search run on the CPU here; the first pass over a large library takes a while.
- Upstream recommends 128 MB shared memory for PostgreSQL; this profile uses the Docker default (64 MB), which is fine for small and medium libraries.

Upstream: https://immich.app
