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
const DONE_RE: Record<string, RegExp> = { Update: /is up to date$/, Install: /is ready$/, Start: /is running again$/, Stop: /is stopped$/, Remove: /was removed \(data kept\)$/, Reinstall: /is back$/, Purge: /was uninstalled completely$/, Expose: /is published$/, Unexpose: /address withdrawn$/ };
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
  // overview first (Umbrel-style): the machine, power, wallpaper
  await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: /^[a-zA-Z0-9.-]+$/ }).first()).toBeVisible();
  await expect(page.getByText('Running on')).toBeVisible();
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Restart this machine?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  // account
  await page.getByRole('button', { name: /Account/ }).click();
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

test('customize an app: name and emoji icon show on the launcher and in search; picture icon is served', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Details of memos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Customize memos' }).click();
  const dlg = page.getByRole('dialog', { name: 'Customize Memos' });
  await dlg.getByLabel('Name on the launcher').fill('Notes');
  await dlg.getByRole('radio', { name: 'Emoji or letters' }).click();
  await dlg.getByRole('option', { name: '📝' }).click();
  await dlg.getByRole('option', { name: 'Colour #ff9f0a' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Notes' })).toBeVisible(); // the drawer follows the new name
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const tile = page.locator('.icon-tile[data-instance="memos"]');
  await expect(tile).toContainText('Notes');
  await expect(tile.locator('.glyph-icon')).toHaveText('📝');
  // search finds the new name
  await page.keyboard.press('Meta+k');
  await page.getByLabel('Search everything').fill('notes');
  await expect(page.getByRole('option', { name: /^Notes/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // picture icon
  await page.getByRole('button', { name: 'Details of memos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Customize memos' }).click();
  const dlg2 = page.getByRole('dialog', { name: 'Customize Memos' });
  await dlg2.getByRole('radio', { name: 'My picture' }).click();
  await dlg2.getByLabel('Icon picture file').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  await dlg2.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const img = tile.locator('img.appicon');
  await expect(img).toHaveAttribute('src', /\/v1\/instances\/[0-9a-f-]+\/icon\?v=/);
  const res = await page.request.get((await img.getAttribute('src'))!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
  // back to the app's own icon and name
  await page.getByRole('button', { name: 'Details of memos' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Customize memos' }).click();
  const dlg3 = page.getByRole('dialog', { name: 'Customize Memos' });
  await dlg3.getByLabel('Name on the launcher').fill('');
  await dlg3.getByRole('radio', { name: "App's icon" }).click();
  await dlg3.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(tile).toContainText('Memos');
});

test('arrange the launcher: drag an icon to the front, the order survives a reload; keyboard arranging works', async ({ page }) => {
  await login(page);
  const tiles = page.locator('.icons[aria-label="Installed apps"] .icon-tile.instance');
  await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(2);
  const before = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-instance')));
  const last = before[before.length - 1]!;
  // mouse drag: press on the last tile, move over the first one, release
  const from = page.locator(`.icon-tile[data-instance="${last}"]`);
  const to = page.locator(`.icon-tile[data-instance="${before[0]}"]`);
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 4, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-instance')))).toEqual([last, ...before.slice(0, -1)]);
  // no app opened as a side effect of the drag
  expect(page.context().pages().length).toBe(1);
  // persisted on the daemon
  await page.reload();
  await login(page);
  await expect.poll(() => tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-instance')))).toEqual([last, ...before.slice(0, -1)]);
  // keyboard: Arrange → focus the first tile → ArrowRight moves it one slot
  await page.getByRole('button', { name: 'Arrange' }).click();
  await expect(page.getByRole('status')).toContainText('Drag icons');
  await page.locator(`.icon-tile[data-instance="${last}"] .icon-btn`).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-instance')))).toEqual([before[0], last, ...before.slice(1, -1)]);
  await page.getByRole('button', { name: 'Done' }).click();
});

test('rotating wallpapers: turn on from Settings, a picture with credit appears, next picture works; Reddit asks for a key', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/appearance');
  await expect(page.getByRole('heading', { name: 'Rotating wallpapers' })).toBeVisible();
  await page.getByRole('switch', { name: 'Rotating wallpapers' }).check();
  await expect(page.getByRole('status')).toContainText(/Now showing .* \(Bing\)/);
  const first = await page.getByRole('status').textContent();
  await page.getByRole('button', { name: 'Next picture' }).click();
  await expect.poll(() => page.getByRole('status').textContent()).not.toBe(first);
  // the page paints the daemon's picture
  expect(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--wallpaper-url')")).toContain('/v1/appearance/wallpaper?v=');
  expect(await page.evaluate("document.documentElement.dataset.wallpaper")).toBe('photo');
  // Reddit needs credentials: choosing it turns rotation off until a key is saved
  await page.getByRole('radio', { name: /Reddit/ }).check();
  await expect(page.getByText('Reddit app key needed')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Rotating wallpapers' })).not.toBeChecked();
  await page.getByLabel('Reddit client id').fill('demo-id');
  await page.getByLabel('Reddit secret').fill('demo-secret');
  await page.getByRole('button', { name: 'Save and use Reddit' }).click();
  await expect(page.getByRole('status')).toContainText(/Now showing .* by u\/demo_user \(r\/\w+\)/);
  // home shows the credit line
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('.wallpaper-credit')).toContainText('u/demo_user');
  // off again: presets return
  await page.goto('/#/settings/appearance');
  await page.getByRole('switch', { name: 'Rotating wallpapers' }).uncheck();
  await expect(page.getByRole('button', { name: 'Next picture' })).toHaveCount(0);
});

test('your own app: upload a package zip, it appears under Your apps, installs; a higher revision offers an Update that keeps the address', async ({ page }) => {
  const { writeZip } = await import('../../src/packages/zip.js');
  const manifest = (rev: string, notes = '') => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: hello-e2e
  name: Hello E2E
  description: A tiny page
release:
  revision: "${rev}"
  version: "1.${rev}"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
presentation:
  tagline: Says hello
  category: developer
  icon: icon.svg
${notes ? `  releaseNotes: ${JSON.stringify(notes)}\n` : ''}`;
  const zip = (rev: string, image: string, notes = '') => writeZip({ 'manifest.yaml': manifest(rev, notes), 'compose.yaml': `services:\n  web:\n    image: ${image}\n`, 'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' }, { folder: 'hello-e2e' });
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const dlg = page.getByRole('dialog', { name: 'Your own app' });
  await dlg.getByLabel('Package zip file').setInputFiles({ name: 'hello-e2e.zip', mimeType: 'application/zip', buffer: zip('1', 'nginx:1.27-alpine') });
  await expect(dlg).toContainText('Hello E2E is in your App Store');
  await expect(dlg).toContainText('nginx:1.27-alpine');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  const card = page.locator('.tile.store').filter({ hasText: 'Hello E2E' });
  await expect(card).toContainText('Your app · 1.1');
  await card.getByRole('button', { name: 'Install Hello E2E', exact: true }).click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText('your own uploaded app');
  await plan.getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  const tile = page.locator('.icon-tile[data-instance="hello-e2e"]');
  await expect(tile).toBeVisible();
  const href = await tile.getByRole('link', { name: 'Open hello-e2e' }).getAttribute('href');
  // revision 2 with a new image: the console offers an update
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const dlg2 = page.getByRole('dialog', { name: 'Your own app' });
  await dlg2.getByLabel('Package zip file').setInputFiles({ name: 'hello-e2e-2.zip', mimeType: 'application/zip', buffer: zip('2', 'nginx:1.28-alpine', 'Shinier hello') });
  await expect(dlg2).toContainText('replaces revision 1');
  await expect(dlg2).toContainText('Updates available for hello-e2e');
  await dlg2.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: '1 update available' })).toBeVisible();
  await expect(tile.getByLabel('Update available for hello-e2e')).toBeVisible();
  await page.getByRole('button', { name: 'Details of hello-e2e' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Update available');
  await expect(drawer).toContainText('Shinier hello');
  await drawer.getByRole('button', { name: 'Update hello-e2e' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Review update');
  await expect(review).toContainText('1 image change');
  await review.getByRole('button', { name: 'Update now' }).click();
  await expect(page.getByRole('heading', { name: /Hello E2E is up to date/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '1 update available' })).toHaveCount(0);
  await expect(tile.getByRole('link', { name: 'Open hello-e2e' })).toHaveAttribute('href', href!); // same address after the update
});

test('advanced access: the terminal runs a shell and echoes; troubleshoot shows Harbor and app logs; the machine can be renamed', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/access');
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
  await expect(page.locator('pre.code.wrap').first()).toContainText('-L 18500:127.0.0.1:18500');
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByText(/Connected · shell/)).toBeVisible({ timeout: 15_000 });
  await page.locator('.terminal-wrap textarea').focus();
  await page.keyboard.type('echo e2e-shell-$((20+22))');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-wrap')).toContainText('e2e-shell-42', { timeout: 15_000 });
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Closed/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  // troubleshoot
  await page.getByRole('button', { name: /Troubleshoot/ }).click();
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
  await expect(page.getByLabel('Log output')).toContainText(/"level"/, { timeout: 10_000 });
  await expect(page.getByText(/Source: daemon memory/)).toBeVisible();
  await page.getByLabel('Log source').selectOption({ label: 'Hello E2E' });
  await expect(page.getByLabel('Log output')).toContainText('== web', { timeout: 10_000 });
  await expect(page.getByLabel('Log output')).toContainText('created from nginx@sha256');
  // rename the machine
  await page.getByRole('button', { name: /Overview/ }).click();
  await page.getByRole('button', { name: 'Rename this machine' }).click();
  await page.getByLabel('Device name').fill('Test Box');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test Box' })).toBeVisible();
  await expect(page).toHaveTitle('Test Box · Harbor');
  await expect(page.getByText('Hostname')).toBeVisible();
});

test('two-factor login: set up with a live code, log in again with password + code, turn it off with the password', async ({ page }) => {
  const { totpCode } = await import('../../src/auth/totp.js');
  await login(page);
  await page.goto('/#/settings/account');
  await expect(page.getByRole('heading', { name: 'Two-factor login' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on two-factor login' }).click();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const secret = (await page.locator('code.secret').textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel('Authenticator code').fill(totpCode(secret, Date.now()));
  await page.getByRole('button', { name: 'Confirm and turn on' }).click();
  await expect(page.getByRole('status')).toContainText('Two-factor login is on');
  // log out, log in: the code field appears only after a correct password
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByLabel('Two-factor code')).toBeVisible();
  await page.getByLabel('Two-factor code').fill('000000');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid two-factor code');
  await page.getByLabel('Two-factor code').fill(totpCode(secret, Date.now() + 30_000)); // next step: never used before
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor login' })).toBeVisible(); // back where we were (settings/account)
  // off again so later tests log in with the password alone
  await page.getByLabel('Password to turn off two-factor').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('status')).toContainText('Two-factor login is off');
});

test('Harbor update card: the newest release shows on the Overview, Update asks first and reports progress; default login shows for an app that ships one', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings');
  const card = page.locator('.harbor-update');
  await expect(card).toContainText(/is available/, { timeout: 15_000 });
  await card.getByText(/What is new in/).click();
  await expect(card).toContainText('Demo release');
  await card.getByRole('button', { name: /Update Harbor to/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('verifies its checksum');
  await dlg.getByRole('button', { name: 'Update now' }).click();
  await expect(card.getByRole('status')).toContainText(/Updating to .* Harbor restarts/, { timeout: 10_000 });
  // default credentials on an uploaded package
  const { writeZip } = await import('../../src/packages/zip.js');
  const manifest = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: hello-creds
  name: Hello Creds
  description: Ships with a default login
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
defaultCredentials:
  username: admin
  password: changeme
  note: Sign in with these once and change them in the app's settings.
`;
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  await page.getByLabel('Package zip file').setInputFiles({ name: 'hello-creds.zip', mimeType: 'application/zip', buffer: writeZip({ 'manifest.yaml': manifest, 'compose.yaml': 'services:\n  web:\n    image: nginx:alpine\n' }) });
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'About Hello Creds' }).click();
  const about = page.getByRole('dialog');
  await expect(about.getByRole('note')).toContainText('Default login');
  await expect(about.getByRole('note')).toContainText('changeme');
  await expect(about.getByRole('note')).toContainText('change it after the first sign-in');
  await about.getByRole('button', { name: 'Install Hello Creds now' }).click();
  await expect(page.getByRole('dialog')).toContainText('ships with a default login (admin)');
  await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of hello-creds' }).click();
  await expect(page.getByRole('dialog').getByRole('note')).toContainText('changeme', { timeout: 10_000 });
});
