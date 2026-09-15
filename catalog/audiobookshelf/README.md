# Audiobookshelf

Self-hosted audiobook and podcast server with progress sync, mobile apps and a beautiful web player.

## What Harbor does

- Runs Audiobookshelf on 127.0.0.1; config and metadata live in retained volumes.
- Mounts your audiobook and podcast folders (or managed volumes if you choose none).

## Storage

- `config`: Users, libraries and settings.
- `metadata`: Covers, cached metadata and backups.
- `audiobooks`: Your audiobooks. You may point this at a folder of your own at install time (optional): The folder with your audiobooks, mounted at /audiobooks.
- `podcasts`: Podcast downloads. You may point this at a folder of your own at install time (optional): Where downloaded podcast episodes go, mounted at /podcasts.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the app and create the root account.
2. Add a library at /audiobooks and scan.
3. Install the mobile app and connect to the published address.

Upstream: https://www.audiobookshelf.org
