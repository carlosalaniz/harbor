# Nextcloud

Files, calendar, contacts and office documents on your own machine. Sync clients for every platform; Nextcloud Office included via the recommended apps.

## What Harbor does

- Runs Nextcloud, PostgreSQL and Redis on a private network; only Nextcloud is published.
- Generates the database password and the `admin` login once; Nextcloud is set up on its first start, so nobody else on your network can claim the setup page first.
- Works on every address at once: LAN (`http://<hostname>.local:<port>` or the IP), secure LAN, Tailscale and your domains. After every start, publish and unpublish Harbor runs Nextcloud's own admin tool (`occ`) to list those addresses as trusted and to trust forwarded headers only from Harbor's proxies. Each page's links follow the address you opened it with; emails and background jobs use the main address you picked at install.
- Nextcloud Office on the built-in office server follows the main address: the same after-start step re-activates it, so a document still opens after you publish on a domain and make it the main address. If you pointed Nextcloud Office at your own Collabora server, Harbor leaves that setting alone.
- Changed network settings (secure addresses on/off, a renamed machine)? Open Nextcloud in Harbor and press **Restart**. Publishing on Tailscale or a domain needs no restart.

## Storage

- `html`: Nextcloud application, config and apps.
- `db`: PostgreSQL database.
- `data`: User files. You may point this at a folder of your own at install time (optional), under `/mnt`, `/media` or `/srv/harbor`, for example `/mnt/nextcloud-data`. Prepare it once — Nextcloud runs as uid 33 and refuses a data folder other users can read; the `harbor` group lets Harbor keep its small identity file there; Harbor never changes ownership of your folders:

  ```sh
  sudo mkdir -p /mnt/nextcloud-data && sudo chown 33:harbor /mnt/nextcloud-data && sudo chmod 0770 /mnt/nextcloud-data
  ```
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. When the install finishes, Harbor shows the `admin` password once. Sign in with it and change it under Personal settings → Security.
2. Calendar, Contacts and Nextcloud Office (with the built-in office server) are added on the first start; if the internet was down, the next start retries. Talk, Mail and more are in Apps.
3. Install the desktop or mobile client and connect it to an address it can always reach (Tailscale or your domain if you travel).

## Notes

- The database secret also has to be present when you reinstall; Harbor keeps it.
- The `db` volume is the PostgreSQL data directory; the `data` claim holds user files and can live on a folder you choose.

Upstream: https://nextcloud.com
