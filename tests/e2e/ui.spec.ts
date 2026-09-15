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
// Tray titles are human sentences; map the operation kind to the wording that proves success.
const DONE_RE: Record<string, RegExp> = { Install: /is ready$/, Start: /is running again$/, Stop: /is stopped$/, Remove: /was removed \(data kept\)$/, Reinstall: /is back$/, Purge: /was uninstalled completely$/, Expose: /is published$/, Unexpose: /address withdrawn$/ };
const trayDone = (page: Page, kind: string) => expect(page.getByRole('heading', { name: DONE_RE[kind]! })).toBeVisible({ timeout: 30_000 });

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
  await expect(page.getByRole('button', { name: 'About Nextcloud' })).toBeVisible(); // popular picks

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
  await expect(dialog).toContainText('Harbor will install Excalidraw on this machine');
  await dialog.getByText(/Exactly what Harbor will do/).click();
  await expect(dialog).toContainText(/Publish endpoint web: 127\.0\.0\.1:\d+/);
  await expect(dialog).toContainText(/Pull image excalidraw\/excalidraw@sha256:/);
  // Rapid double click: the same idempotency key is reused; only one operation must exist.
  await dialog.getByRole('button', { name: 'Install' }).dblclick();
  await expect(page.getByRole('heading', { name: /Installing Excalidraw|Excalidraw is ready/ })).toBeVisible();
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
  await expect(page.locator('.instance').first()).toContainText(/excalidraw/i);
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
  await page.getByText(/removed app.* with data kept/).click(); // retained apps are folded away on Home
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
  let folder = ''; // eslint-disable-line no-useless-assignment -- assigned from the picker below
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About Jellyfin' }).click();
  const about = page.getByRole('dialog');
  await expect(about).toContainText('Where should the data live?');
  await about.getByLabel('Use a folder on this machine').check();
  // typed path (advanced) that does not exist
  await about.getByRole('button', { name: 'Choose folder for Your media library' }).click();
  const picker = page.getByRole('dialog', { name: /^Folder for/ });
  await picker.getByText('Type a path instead').click();
  await picker.getByLabel('Folder path').fill('/definitely/missing/folder');
  await picker.getByRole('button', { name: 'Use this path' }).click();
  await about.getByRole('button', { name: 'Install Jellyfin now' }).click();
  // the daemon rejects the folder while planning; nothing was created
  await expect(page.getByRole('dialog')).toContainText('does not exist');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'About Jellyfin' }).click();
  const again = page.getByRole('dialog');
  await again.getByLabel('Use a folder on this machine').check();
  // the picker: go to the Harbor data folder, create a folder, use it
  await again.getByRole('button', { name: 'Choose folder for Your media library' }).click();
  const picker2 = page.getByRole('dialog', { name: /^Folder for/ });
  await picker2.getByRole('button', { name: /Harbor data folder/ }).click();
  await picker2.getByLabel('New folder name').fill('Media e2e');
  await picker2.getByRole('button', { name: 'Create folder here' }).click();
  await picker2.getByRole('button', { name: 'Open folder Media e2e' }).click();
  await expect(picker2.locator('code.path')).toContainText('Media e2e');
  const chosen = (await picker2.locator('code.path').textContent())!.trim();
  await picker2.getByRole('button', { name: 'Use this folder' }).click();
  await expect(again.locator('code.path')).toHaveText(chosen);
  folder = chosen;
  await again.getByRole('button', { name: 'Install Jellyfin now' }).click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText(`your folder ${folder}`);
  await plan.getByText(/Exactly what Harbor will do/).click();
  await expect(plan).toContainText(`Use your folder ${folder}`);
  await plan.getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of jellyfin' }).click();
  const d = page.getByRole('dialog');
  await d.getByText('Technical details').click();
  await expect(d).toContainText('bind');
  await expect(d).toContainText(folder);
});

test('settings: change password and back, remote access login flow, storage overview', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  // account
  await page.getByLabel('Current password').fill(ADMIN.password);
  await page.getByLabel('New password', { exact: true }).fill('brand-new-FIXTURE-password');
  await page.getByLabel('New password (again)').fill('brand-new-FIXTURE-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toContainText('Password changed');
  await page.getByLabel('Current password').fill('brand-new-FIXTURE-password');
  await page.getByLabel('New password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('New password (again)').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toContainText('Password changed');
  // remote access with the fake provider: connected → log out → login URL → key
  await page.getByRole('button', { name: /Remote access/ }).click();
  await expect(page.getByText(/This machine is/)).toBeVisible();
  await page.getByText('Disconnect').click();
  await page.getByRole('button', { name: 'Log out of the tailnet' }).click();
  await expect(page.getByRole('button', { name: 'Log in with Tailscale' })).toBeVisible();
  await page.getByRole('button', { name: 'Log in with Tailscale' }).click();
  await expect(page.getByRole('link', { name: /Open the approval page/ })).toHaveAttribute('href', /login\.tailscale\.com/);
  await page.getByText('I have an auth key instead').click();
  await page.getByLabel('Tailscale auth key').fill('tskey-fixture-good-e2e');
  await page.getByRole('button', { name: 'Connect with key' }).click();
  await expect(page.getByText(/This machine is/)).toBeVisible();
  // storage
  await page.getByRole('button', { name: /^💽/ }).or(page.getByRole('button', { name: /Storage/ })).first().click();
  await expect(page.getByRole('heading', { name: 'Harbor data folder' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Folders used by apps' })).toBeVisible();
  await expect(page.getByText('Media e2e')).toBeVisible(); // from the Jellyfin install above
});

test('full uninstall: typed confirmation, data deleted, name free again', async ({ page }) => {
  await login(page);
  await installFromStore(page, 'Memos');
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of memos' }).click();
  const d = page.getByRole('dialog');
  await d.getByText('Uninstall completely…').click();
  const del = d.getByRole('button', { name: 'Uninstall memos completely' });
  await expect(del).toBeDisabled();
  await d.getByLabel('Type memos to confirm').fill('memos');
  await expect(del).toBeEnabled();
  await del.click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText('uninstall Memos completely');
  await expect(plan).toContainText(/deletes the app's data for good/);
  await plan.getByRole('button', { name: 'Delete everything' }).click();
  await trayDone(page, 'Purge');
  await expect(page.locator('.instance').filter({ hasText: 'Memos' })).toHaveCount(0);
  // the name is free: installing again works with the default name
  await installFromStore(page, 'Memos');
  await approve(page, 'Install');
  await trayDone(page, 'Install');
});

test('public addresses wizard: public IP, add and check a domain, use it in the publish wizard; spotlight palette', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/public');
  await expect(page.getByRole('heading', { name: /Publish an app on the internet/ })).toBeVisible();
  await expect(page.getByText('203.0.113.10').first()).toBeVisible(); // fake public IP
  await page.getByLabel('Domain name').fill('photos.example.com');
  await page.getByRole('button', { name: 'Add and check' }).click();
  const row = page.locator('.domain').filter({ hasText: 'photos.example.com' });
  await expect(row).toContainText('No DNS record yet'); // fake resolver has no records
  await page.getByRole('button', { name: 'Re-check photos.example.com' }).click();
  await expect(row).toContainText('No DNS record yet');
  // the publish wizard offers the registered domain
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Publishing' }).click();
  await page.getByRole('button', { name: 'Publish memos' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel(/Public/).check();
  await dlg.getByLabel('Domain').selectOption('photos.example.com');
  await expect(dlg).toContainText("Let's Encrypt automatically");
  await dlg.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Forget photos.example.com' }).isVisible().catch(() => false);
  // palette
  await page.keyboard.press('Meta+k');
  const pal = page.getByRole('dialog', { name: 'Search' });
  await expect(pal).toBeVisible();
  await pal.getByLabel('Search everything').fill('storage');
  await expect(pal.getByRole('option', { name: /Settings · Storage/ })).toBeVisible();
  await pal.getByLabel('Search everything').press('Enter');
  await expect(page.getByRole('heading', { name: 'Harbor data folder' })).toBeVisible();
  await page.keyboard.press('/');
  await page.getByLabel('Search everything').fill('memos');
  await expect(page.getByRole('option', { name: /Memos/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
});
