# Nextcloud

Files, calendar, contacts and office documents on your own machine. Sync clients for every platform; Nextcloud Office included via the recommended apps.

## What Harbor does

- Runs Nextcloud, PostgreSQL and Redis on a private network; only Nextcloud is published on 127.0.0.1.
- Generates the database password once; the web installer finds the database pre-configured.
- Keeps trusted domain and overwrite settings in step with the address you publish (loopback, tailnet or public).

## Storage

- `html`: Nextcloud application, config and apps.
- `db`: PostgreSQL database.
- `data`: User files. You may point this at a folder of your own at install time (optional): A folder with room for everyone's files, for example /mnt/nextcloud-data. Nextcloud must own it; it takes ownership on first start.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open Nextcloud, choose an admin username and password, leave the database section as is and finish.
2. Keep Install recommended apps checked: it installs Nextcloud Office (with the built-in office server), Calendar, Contacts, Talk and Mail.
3. Install the desktop or mobile client and connect it to the published address.

## Notes

- The database secret also has to be present when you reinstall; Harbor keeps it.
- The `db` volume is the PostgreSQL data directory; the `data` claim holds user files and can live on a folder you choose.

Upstream: https://nextcloud.com
