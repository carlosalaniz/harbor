# FreshRSS

Fast, self-hosted RSS and Atom feed reader with a clean web interface and mobile apps via its API.

## What Harbor does

- Runs FreshRSS on 127.0.0.1 with data and extensions in retained volumes.

## Storage

- `data`: Users, feeds and articles (SQLite).
- `extensions`: Installed extensions.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the app, choose SQLite, create the first user.
2. Add feeds or import an OPML file.

## Notes

- Mobile apps can use the Google Reader compatible API once you enable it in settings and publish the app.

Upstream: https://freshrss.org
