# Forgejo

Lightweight, self-hosted Git forge with issues, pull requests, wikis and CI hooks. Community fork of Gitea.

## What Harbor does

- Runs Forgejo on 127.0.0.1 with SQLite and all data in a retained volume.
- Keeps ROOT_URL and DOMAIN in step with the published address.

## Storage

- `data`: Repositories, database and configuration.
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open Forgejo; the installer shows SQLite pre-selected. Fill in the administrator account section and click Install.
2. Create an organization or repository and push over HTTPS.

## Notes

- SSH is disabled because Harbor publishes HTTP endpoints only; use HTTPS clone URLs with a token.
- Registration is closed by default; the admin creates accounts.

Upstream: https://forgejo.org
