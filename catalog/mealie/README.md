# Mealie

Recipe manager and meal planner: import recipes from any URL, plan the week, build shopping lists.

## What Harbor does

- Runs Mealie on 127.0.0.1 with its data in a retained volume.
- Keeps BASE_URL in step with the published address so links and images resolve.

## Storage

- `data`: Recipes, images and database (SQLite).
- Managed volumes and your folders are retained on remove; Harbor never deletes them.

## First run

1. Open Mealie and log in with the default account (changeme@example.com / MyPassword).
2. Change the email and password right away.
3. Import a recipe by URL.

Upstream: https://mealie.io
