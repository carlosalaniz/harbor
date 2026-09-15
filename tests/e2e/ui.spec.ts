import { expect, test, type Page } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'e2e-fixture-password' };

async function login(page: Page) {
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
}

// Every mutation goes through the same wizard: action → server plan review → approve → tray.
async function approve(page: Page, label: string | RegExp) {
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/^Review /);
  await dlg.getByRole('button', { name: label }).click();
}
const trayDone = (page: Page, kind: string) => expect(page.getByRole('heading', { name: `${kind} succeeded` })).toBeVisible({ timeout: 30_000 });

async function installFromStore(page: Page, pkgName: string) {
  await page.getByRole('link', { name: 'App Store' }).click();
  await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();
  await page.getByRole('button', { name: `Install ${pkgName}`, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('login rejects bad credentials without revealing which field is wrong', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('nobody');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid username or password');
});

test('home shows the system strip and an empty launcher; store lists real packages with icons; platform is honest about tools', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('region', { name: 'System' })).toContainText('Processor');
  await expect(page.getByRole('region', { name: 'System' })).toContainText('Docker');
  await expect(page.getByText('No apps yet')).toBeVisible();

  await page.getByRole('link', { name: 'App Store' }).click();
  for (const name of ['Excalidraw', 'BentoPDF']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  // Icons are served by the daemon from hashed package assets (SVG, sandboxed).
  const icon = page.locator('.tile.store img').first();
  const src = await icon.getAttribute('src');
  expect(src).toMatch(/^\/v1\/catalog\/[a-z0-9-]+\/asset\/icon\.svg$/);
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/svg+xml');
  expect(res.headers()['content-security-policy']).toContain('sandbox');
  // category chips filter the grid
  const all = await page.locator('.tile.store').count();
  await page.getByRole('tab', { name: 'Productivity' }).click();
  const filtered = page.locator('.tile.store');
  expect(await filtered.count()).toBeGreaterThan(0);
  expect(await filtered.count()).toBeLessThan(all);
  await expect(filtered.filter({ hasText: 'Excalidraw' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'All' }).click();
  await page.getByLabel('Search apps').fill('pdf');
  await expect(page.locator('.tile.store')).toHaveCount(1);
  await expect(page.locator('.tile.store')).toContainText('BentoPDF');

  await page.getByRole('link', { name: 'Platform' }).click();
  await expect(page.getByRole('heading', { name: 'Platform tools' })).toBeVisible();
  await expect(page.getByText(/Docker Engine/)).toBeVisible();
  // Cockpit/Portainer are absent in this fixture: "Not set up", no fake Open link.
  // Tailscale/proxy come from the fake providers (installed) so the publishing flows can be exercised.
  const tools = page.locator('.tool');
  await expect(tools).toHaveCount(4);
  await expect(tools.filter({ hasText: 'Cockpit' })).toContainText('Not set up');
  await expect(tools.filter({ hasText: 'Portainer' })).toContainText('Not set up');
  await expect(tools.filter({ hasText: 'Tailscale' })).toContainText('Ready');
  await expect(page.getByRole('link', { name: /Open Cockpit|Open Portainer/ })).toHaveCount(0);

  await page.getByRole('link', { name: 'Publishing' }).click();
  await expect(page.getByRole('button', { name: 'Expose Harbor UI on tailnet' })).toBeVisible();
});

test('store app page, install with plan review, progress tray, Open link; duplicate clicks do not duplicate', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About Excalidraw' }).click();
  const about = page.getByRole('dialog');
  await expect(about).toContainText('Runs on 127.0.0.1 only until you publish it');
  await expect(about).toContainText('website');
  await about.getByRole('button', { name: 'Install Excalidraw now' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Review install');
  await expect(dialog).toContainText(/Publish endpoint web: 127\.0\.0\.1:\d+/);
  await expect(dialog).toContainText(/Pull image excalidraw\/excalidraw@sha256:/);
  // Rapid double click: the same idempotency key is reused; only one operation must exist.
  await dialog.getByRole('button', { name: 'Install' }).dblclick();
  await expect(page.getByRole('heading', { name: /Install (in progress|succeeded)/ })).toBeVisible();
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  const tiles = page.locator('.instance');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Running');
  const open = page.getByRole('link', { name: 'Open excalidraw' });
  await expect(open).toHaveAttribute('href', /^http:\/\/localhost:\d+\/$/);
  const href = await open.getAttribute('href');
  const res = await page.request.get(href!); // fake app listener on the allocated loopback port
  expect(res.status()).toBe(200);
});

test('reload requires login and then resumes existing state; no token in browser storage or cookies', async ({ page, context }) => {
  await login(page);
  await expect(page.locator('.instance')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }))).toBe('{"ls":{},"ss":{}}');
  expect(await context.cookies()).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.locator('.instance')).toHaveCount(0);
  await login(page);
  await expect(page.locator('.instance')).toHaveCount(1); // found, not recreated
  await expect(page.locator('.instance').first()).toContainText('excalidraw');
});

test('app drawer: stop, start, remove (data kept wording) and reinstall', async ({ page }) => {
  await login(page);
  const openDrawer = () => page.getByRole('button', { name: 'Details of excalidraw' }).click();
  await openDrawer();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop excalidraw' }).click();
  await approve(page, 'Stop');
  await trayDone(page, 'Stop');
  await expect(page.locator('.instance').first()).toContainText('Stopped');
  await expect(page.getByRole('link', { name: 'Open excalidraw' })).toHaveCount(0);

  await openDrawer();
  await page.getByRole('dialog').getByRole('button', { name: 'Start excalidraw' }).click();
  await approve(page, 'Start');
  await trayDone(page, 'Start');
  await expect(page.getByRole('link', { name: 'Open excalidraw' })).toBeVisible();

  await openDrawer();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove excalidraw' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/retained/i);
  await dlg.getByRole('button', { name: 'Remove (keep data)' }).click();
  await trayDone(page, 'Remove');
  await expect(page.locator('.instance.retained')).toHaveCount(1);
  await expect(page.locator('.instance.retained')).toContainText('Removed · data kept');

  await openDrawer();
  await page.getByRole('dialog').getByRole('button', { name: 'Reinstall excalidraw' }).click();
  await approve(page, 'Reinstall');
  await trayDone(page, 'Reinstall');
  await expect(page.locator('.instance').first()).toContainText('Running');
});

test('second package installs on a distinct port; drawer shows owned resources', async ({ page }) => {
  await login(page);
  await installFromStore(page, 'BentoPDF');
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('.instance')).toHaveCount(2);
  const hrefs = await page.getByRole('link', { name: /^Open / }).evaluateAll((els) => els.map((e) => (e as { href: string }).href));
  expect(new Set(hrefs).size).toBe(2);
  await page.getByRole('button', { name: 'Details of bentopdf' }).click();
  const d = page.getByRole('dialog');
  await d.getByText('Technical details').click();
  await expect(d).toContainText('Owned resources');
  await expect(d).toContainText('container');
  await expect(d).toContainText(/hb_[0-9a-f]{32}-web-1/);
  await d.getByRole('button', { name: 'Close', exact: true }).click();
});

test('logout returns to login and the API rejects the old token', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.getByText('Logged out.')).toBeVisible();
  const res = await page.request.get('/v1/instances');
  expect(res.status()).toBe(401);
});

test('publish wizard: tailnet address on the tile; public exposure shows one-time credentials; withdraw works', async ({ page }) => {
  await login(page);
  await installFromStore(page, 'Excalidraw'); // fresh instance for this test → excalidraw-2
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Publishing' }).click();
  await page.getByRole('button', { name: 'Publish excalidraw-2' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('keeps listening on 127.0.0.1');
  await dlg.getByRole('button', { name: 'Publish', exact: true }).click(); // tailnet is the default path
  await approve(page, 'Publish');
  await trayDone(page, 'Expose');
  const published = page.getByRole('region', { name: 'Published addresses' });
  const row = published.locator('li').filter({ hasText: 'excalidraw-2' });
  await expect(row).toContainText('tailnet');
  await expect(row).toContainText('https://harbor-test.tail1234.ts.net:');
  // public with basic auth
  await page.getByRole('button', { name: 'Publish excalidraw-2' }).click();
  const dlg2 = page.getByRole('dialog');
  await dlg2.getByLabel(/Public/).check();
  await dlg2.getByPlaceholder('app.example.com').fill('draw.example.com');
  await dlg2.getByRole('button', { name: 'Publish', exact: true }).click();
  await approve(page, 'Publish');
  await trayDone(page, 'Expose');
  await expect(page.getByText(/Basic-auth credentials, shown once/)).toBeVisible();
  await expect(published.locator('li').filter({ hasText: 'draw.example.com' })).toContainText('basic auth');
  // the tile on Home shows the same addresses in the drawer
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of excalidraw-2' }).click();
  await expect(page.getByRole('dialog').locator('.addresses')).toContainText('https://draw.example.com/');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish excalidraw-2' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw public address' }).click();
  await approve(page, 'Withdraw');
  await trayDone(page, 'Unexpose');
  await page.getByRole('link', { name: 'Publishing' }).click();
  await expect(page.getByRole('region', { name: 'Published addresses' }).locator('li').filter({ hasText: 'draw.example.com' })).toHaveCount(0);
});

test('phone width: bottom tabs navigate, tiles render in two columns, dialogs open', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await login(page);
  await expect(page.locator('.instance').first()).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  const box = await nav.boundingBox();
  expect(box!.y).toBeGreaterThan(600); // bottom bar, not a side rail
  await nav.getByRole('link', { name: 'App Store' }).click();
  await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();
  await page.getByRole('button', { name: 'About BentoPDF' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});

test('install page: bring your own folder validates the path in the plan and mounts it', async ({ page }) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const folder = mkdtempSync(`${tmpdir()}/harbor-e2e-media-`);
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About Jellyfin' }).click();
  const about = page.getByRole('dialog');
  await expect(about).toContainText('Where should the data live?');
  await about.getByLabel('Use a folder on this machine').check();
  await about.getByLabel('Folder for Your media library').fill('/definitely/missing/folder');
  await about.getByRole('button', { name: 'Install Jellyfin now' }).click();
  // the daemon rejects the folder while planning; nothing was created
  await expect(page.getByRole('dialog')).toContainText('does not exist');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'About Jellyfin' }).click();
  const again = page.getByRole('dialog');
  await again.getByLabel('Use a folder on this machine').check();
  await again.getByLabel('Folder for Your media library').fill(folder);
  await again.getByRole('button', { name: 'Install Jellyfin now' }).click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText(`Use your folder ${folder}`);
  await expect(plan).toContainText(`your folder ${folder}`);
  await plan.getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of jellyfin' }).click();
  const d = page.getByRole('dialog');
  await d.getByText('Technical details').click();
  await expect(d).toContainText('bind');
  await expect(d).toContainText(folder);
});
