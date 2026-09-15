# Uptime Kuma

Self-hosted monitoring: watch websites, ports and services and get notified when they go down.

## What Harbor does

- Runs Uptime Kuma on 127.0.0.1 with its data in a retained volume.

## Storage

- `data`: Monitors, history and settings.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open the app and create the admin account.
2. Add monitors and notification channels.

## Notes

- Monitors run from this machine; ping-type monitors need ICMP, which works in the container.

Upstream: https://uptime.kuma.pet
