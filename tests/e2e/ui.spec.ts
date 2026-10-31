import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ADMIN = { username: 'admin', password: 'e2e-fixture-password' };

async function login(page: Page) {
  trackOperations(page);
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  // the box is checked by default: untick for the ephemeral in-memory session
  // the other tests rely on (reload asks for the password again).
  await page.getByLabel(/Stay logged in/).uncheck();
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
const DONE_RE: Record<string, RegExp> = { Update: /is up to date$/, Install: /is ready$/, Start: /is running again$/, Stop: /is stopped$/, Remove: /was removed \(data kept\)$/, Reinstall: /is back$/, Purge: /was uninstalled completely$/, Expose: /is published$/, Unexpose: /address withdrawn$/, Restart: /restarted$/, Restore: /is restored$/ };
// Every operation the console accepts on this page (POST /v1/operations answers with it), in order. login() starts it.
const acceptedOps = new WeakMap<Page, { ids: string[]; waited: number }>();
function trackOperations(page: Page) {
  if (acceptedOps.has(page)) return;
  const t = { ids: [] as string[], waited: 0 };
  acceptedOps.set(page, t);
  page.on('response', (r) => {
    if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/v1/operations' || !r.ok()) return;
    void r.json().then(
      (j: { operation?: { id?: string } }) => {
        if (j.operation?.id) t.ids.push(j.operation.id);
      },
      () => undefined,
    );
  });
}
// Decision 183: finished items stay in the tray until dismissed (values shown once stay even after Clear finished), so
// the wait is for the result of the operation it follows: the last one accepted since the previous wait, by its id
// (FinishedItem's data-op). No older result, shown-once leftovers included, can satisfy it. Then plain ones are cleared.
async function clearTray(page: Page) {
  const clear = page.locator('aside.tray').getByRole('button', { name: 'Clear finished', exact: true });
  await expect.poll(async () => (await page.locator('aside.tray section.tray-item:not(.done)').count()) === 0, { timeout: 60_000 }).toBe(true);
  if (await clear.count()) await clear.click();
  // every operation accepted so far has finished: trayDone waits for the next one only
  const t = acceptedOps.get(page);
  if (t) t.waited = t.ids.length;
}
async function trayDone(page: Page, kind: string) {
  const t = acceptedOps.get(page);
  if (!t) throw new Error('trayDone needs login(page) first (it tracks the accepted operations)');
  await expect.poll(() => t.ids.length > t.waited, { message: `an operation accepted for ${kind}`, timeout: 10_000 }).toBe(true);
  const id = t.ids[t.ids.length - 1]!;
  t.waited = t.ids.length;
  const tray = page.locator('aside.tray');
  await expect(tray.locator(`section.tray-item.done[data-op="${id}"]`).getByRole('heading', { name: DONE_RE[kind]! })).toBeVisible({ timeout: 30_000 });
  const clear = tray.getByRole('button', { name: 'Clear finished', exact: true });
  if (await clear.count()) await clear.click();
}

// A finished install may show recovery cards: the Harbor recovery key the
// first time this installation encrypts anything, and the app's own 12 words
// when the operator chose their own passphrase. Dismiss whatever is there so
// nothing covers the launcher underneath.
async function dismissRecovery(page: Page) {
  for (let i = 0; i < 2; i++) {
    const gate = page.getByRole('button', { name: 'Dismiss recovery key' }).first();
    if (!(await gate.count())) break;
    await page.getByLabel('I wrote down the recovery key').first().check();
    await gate.click();
  }
  // decision 183: the tray is the queue; every finished item has its own Dismiss
  const plain = page.locator('aside.tray').getByRole('button', { name: /^Dismiss: / });
  for (let n = await plain.count(); n > 0; n--) await plain.first().click();
}

async function installFromStore(page: Page, pkgName: string) {
  await page.getByRole('link', { name: 'App Store' }).click();
  await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();
  // decision 170: once a copy is installed the card offers "Add another copy…" instead of Install
  await page.getByRole('button', { name: `Install ${pkgName}`, exact: true }).or(page.getByRole('button', { name: `Add another copy of ${pkgName}`, exact: true })).click();
  // Every install goes through the install page (decision 148: one Storage
  // summary, defaults accepted) and continues to plan review.
  const wiz = page.getByRole('dialog');
  await expect(wiz.getByRole('region', { name: 'Storage' })).toBeVisible();
  await wiz.getByRole('button', { name: `Install ${pkgName} now` }).click();
}

test.describe.configure({ mode: 'serial' });

test('login rejects bad credentials without revealing which field is wrong', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('nobody');
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid username or password');
});

test('home shows the system strip and an empty launcher; store lists real packages with icons; platform is honest about tools', async ({ page }) => {
  await login(page);
  // the launcher greets the administrator by name (time-of-day + username, capitalized)
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening|night), Admin/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'System' })).toContainText('Processor');
  await expect(page.getByRole('region', { name: 'System' })).toContainText('Docker');
  await expect(page.getByText('No apps yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'About Nextcloud' })).toBeVisible(); // popular picks

  await page.getByRole('link', { name: 'App Store' }).click();
  for (const name of ['Excalidraw', 'BentoPDF']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  // decision 174: the card shows the app's own version (BentoPDF names none in its manifest: its image's, from release.json)
  await expect(page.getByRole('button', { name: 'About BentoPDF' })).toContainText('v2.8.8');
  // Icons are served by the daemon from hashed package assets (SVG, sandboxed).
  const icon = page.locator('.tile.store img').first();
  const src = await icon.getAttribute('src');
  expect(src).toMatch(/^\/v1\/catalog\/[a-z0-9-]+\/asset\/icon\.svg$/);
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/svg+xml');
  expect(res.headers()['content-security-policy']).toContain('sandbox');
  // decision 158: one quiet catalog line under the Store. This daemon's catalog URL has no server behind it
  // (HARBOR_DEV_CATALOG_URL), so a check fails and says why; the setup daemon covers "updates are off".
  await expect(page.getByText(/^App catalog (from|bundled with this Harbor)/)).toBeVisible();
  const checkBtn = page.getByRole('button', { name: 'Check for new apps', exact: true });
  await expect(checkBtn).toBeVisible();
  // hold the request briefly so the busy label is observable
  await page.route('**/v1/catalog/refresh', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await checkBtn.click();
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeVisible();
  const catalogStatus = page.locator('.catalog-line').getByRole('status');
  await expect(catalogStatus).toContainText('catalog.json');
  await expect(catalogStatus).toHaveClass(/error/);
  await expect(checkBtn).toBeVisible();
  await expect(checkBtn).toBeEnabled();
  await page.unroute('**/v1/catalog/refresh');
  // the stored failure is shown on load too (an automatic check that failed looks the same)
  await page.reload();
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await expect(page.locator('.catalog-line').getByRole('status')).toContainText(/^Last check failed: .*catalog\.json/);
  await expect(page.locator('.catalog-line')).toContainText(/· checked (just now|\d+ min ago)/);
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
  // Tailscale/proxy come from the fake providers (installed) so the publishing flows can be exercised.
  await expect(page.getByRole('heading', { name: 'Tailscale' })).toBeVisible();
  // Cockpit/Portainer hide behind the advanced acknowledgement; revealing them shows
  // "Not set up" with a one-click install (fake mode refuses with the root command).
  await expect(page.getByRole('heading', { name: 'Cockpit' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show advanced tools' }).click();
  const tools = page.locator('.tool');
  await expect(tools).toHaveCount(4);
  await expect(tools.filter({ hasText: 'Cockpit' })).toContainText('Not set up');
  await expect(tools.filter({ hasText: 'Portainer' })).toContainText('Not set up');
  await expect(page.getByRole('link', { name: /Open Cockpit|Open Portainer/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up Cockpit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up Portainer' })).toBeVisible();
  // the Set up button asks for acknowledgement of the tool's authority first
  await page.getByRole('button', { name: 'Set up Cockpit' }).click();
  await expect(page.getByRole('heading', { name: 'Set up Cockpit?' })).toBeVisible();
  await expect(page.getByText(/operating-system console/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('link', { name: 'Publishing' }).click();
  await expect(page.getByRole('button', { name: 'Expose Harbor UI on tailnet' })).toBeVisible();
});

test('store app page, install with plan review, progress tray, Open link; duplicate clicks do not duplicate', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About Excalidraw' }).click();
  const about = page.getByRole('dialog');
  // Decision 148: plain summaries — stored encrypted on this machine (no media folder, no drive),
  // reachable only here (loopback), and what happens after Install.
  await expect(about.getByRole('region', { name: 'Storage' })).toContainText('This machine');
  await expect(about).toContainText('Encrypted — unlocks automatically when you sign in');
  await expect(about.getByRole('region', { name: 'Access' })).toContainText('Only you, on this machine');
  await expect(about).toContainText(/After install/);
  await expect(about.getByRole('group', { name: 'Main address' })).toHaveCount(0);
  await about.getByRole('button', { name: 'How the encryption works' }).click();
  await expect(about).toContainText("Linux's built-in encryption");
  // the technical details wait behind Advanced
  await about.getByText('Advanced: name, passphrase, folders, technical details').click();
  await expect(about.locator('code.path')).toContainText('excalidraw/excalidraw');
  await expect(about.getByRole('link', { name: 'Website ↗' })).toHaveAttribute('href', 'https://excalidraw.com');
  // Main address (decision 116) behind Change: only what is set up — this machine, plus the (fake) tailnet; full URLs, no ellipsis.
  await about.getByRole('button', { name: 'Change who can reach Excalidraw' }).click();
  await expect(about.getByRole('group', { name: 'Main address' })).toBeVisible();
  await expect(about.getByRole('radio', { name: 'This machine only' })).toBeChecked();
  await expect(about.getByRole('radio', { name: /^Tailscale — https:\/\/[^…]+$/ })).toBeEnabled();
  await about.getByRole('button', { name: 'Install Excalidraw now' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Review install');
  // decision 157: the review says what the install page said — no localhost-only claim, no path up front
  await expect(dialog).toContainText('Harbor will install Excalidraw on this machine, encrypted');
  await expect(dialog).toContainText('Only you, on this machine');
  await expect(dialog).toContainText('Encrypted — unlocks automatically when you sign in');
  await expect(dialog).not.toContainText('until you publish');
  await expect(dialog.locator('p.warn', { hasText: 'unlocks' })).toHaveCount(0);
  await dialog.getByText(/Exactly what Harbor will do/).click();
  await expect(dialog).toContainText(/Publish endpoint web: 127\.0\.0\.1:\d+/);
  await expect(dialog).toContainText(/Pull image excalidraw\/excalidraw@sha256:/);
  // Rapid double click: the same idempotency key is reused; only one operation must exist.
  await dialog.getByRole('button', { name: 'Install' }).dblclick();
  await expect(page.getByRole('heading', { name: /Installing Excalidraw|Excalidraw is ready/ })).toBeVisible();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
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
  // Unticked "stay logged in": the session lives only in memory, so nothing
  // lands in storage and a reload asks for the password again.
  expect(await page.evaluate(() => JSON.stringify({ ls: { ...localStorage }, ss: { ...sessionStorage } }))).toBe('{"ls":{},"ss":{}}');
  expect(await context.cookies()).toEqual([]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.locator('.instance')).toHaveCount(0);
  await login(page);
  await expect(page.locator('.instance')).toHaveCount(1); // found, not recreated
  await expect(page.locator('.instance').first()).toContainText(/excalidraw/i);
});

test('staying logged in survives a reload; logging out clears it', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel(/Stay logged in/).check();
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('harbor.remember'))).toBeTruthy();
  await page.reload();
  // the remembered session resumes silently: no login form, same state
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
  await page.goto('/#/settings/account');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('harbor.remember'))).toBeNull();
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

  // Restart (decision 116): re-render with current addresses and recreate; data stays.
  await openDrawer();
  await page.getByRole('dialog').getByRole('button', { name: 'Restart excalidraw' }).click();
  await expect(page.getByRole('dialog')).toContainText('with its current addresses');
  await approve(page, 'Restart');
  await trayDone(page, 'Restart');
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
  await dismissRecovery(page);
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
  await page.goto('/#/settings/account');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  const res = await page.request.get('/v1/instances');
  expect(res.status()).toBe(401);
});

test('publish wizard: tailnet address on the tile; public exposure shows one-time credentials; withdraw works', async ({ page }) => {
  await login(page);
  await installFromStore(page, 'Excalidraw'); // fresh instance for this test → excalidraw-2
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Publishing' }).click();
  await page.getByRole('button', { name: 'Publish excalidraw-2' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('keeps listening on 127.0.0.1');
  await dlg.getByRole('button', { name: 'Publish', exact: true }).click(); // tailnet is the default path
  // the review shows the address as text, not a link: nothing answers there until it is approved (decision 186)
  await expect(page.getByRole('dialog')).toContainText('(once you approve)');
  await expect(page.getByRole('dialog').getByRole('link', { name: /tail1234\.ts\.net/ })).toHaveCount(0);
  await approve(page, 'Publish');
  await trayDone(page, 'Expose');
  // decision 189: tailnet addresses sit in their own compact card; the app leaves "Not published"
  const tailnet = page.getByRole('region', { name: 'On your tailnet' });
  await expect(tailnet.getByRole('link', { name: /^https:\/\/harbor-test\.tail1234\.ts\.net:/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Not published' }).getByRole('button', { name: 'Publish excalidraw-2' })).toHaveCount(0);
  const published = page.getByRole('region', { name: 'On the internet' });
  // public with basic auth
  await tailnet.getByRole('button', { name: 'Manage excalidraw-2' }).click();
  const dlg2 = page.getByRole('dialog');
  await dlg2.getByLabel(/Public/).check();
  await dlg2.getByPlaceholder('app.example.com').fill('draw.example.com');
  await dlg2.getByRole('button', { name: 'Publish', exact: true }).click();
  await approve(page, 'Publish');
  await trayDone(page, 'Expose');
  await expect(page.getByText(/Basic-auth login for https:\/\/draw\.example\.com\/, shown once/)).toBeVisible(); // decision 138
  await expect(published.locator('li').filter({ hasText: 'draw.example.com' })).toContainText('basic auth');
  // decision 127: a second domain for the same app, with its own protection
  await published.getByRole('button', { name: 'Manage excalidraw-2' }).click();
  const dlg3 = page.getByRole('dialog');
  await dlg3.getByRole('button', { name: 'Add another domain', exact: true }).click();
  await expect(dlg3.getByRole('radio', { name: /^Public/ })).toBeChecked();
  await dlg3.getByPlaceholder('app.example.com').fill('draw.example.org');
  await dlg3.getByLabel('Protection').selectOption('none');
  await dlg3.getByRole('button', { name: 'Publish', exact: true }).click();
  await approve(page, 'Publish');
  await trayDone(page, 'Expose');
  await expect(published.locator('li').filter({ hasText: 'draw.example.com' })).toHaveCount(1);
  await expect(published.locator('li').filter({ hasText: 'draw.example.org' })).toHaveCount(1);
  // the tile on Home shows the same addresses in the drawer
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of excalidraw-2' }).click();
  await expect(page.getByRole('dialog').locator('.addresses')).toContainText('https://draw.example.com/');
  await expect(page.getByRole('dialog').locator('.addresses')).toContainText('https://draw.example.org/');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish excalidraw-2' }).click();
  // each public name has its own Withdraw; removing one keeps the other
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw draw.example.com', exact: true }).click();
  await approve(page, 'Withdraw');
  await trayDone(page, 'Unexpose');
  await page.getByRole('link', { name: 'Publishing' }).click();
  await expect(page.getByRole('region', { name: 'On the internet' }).locator('li').filter({ hasText: 'draw.example.com' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'On the internet' }).locator('li').filter({ hasText: 'draw.example.org' })).toHaveCount(1);
  await page.getByRole('region', { name: 'On the internet' }).locator('li').filter({ hasText: 'draw.example.org' }).getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw draw.example.org', exact: true }).click();
  await approve(page, 'Withdraw');
  await trayDone(page, 'Unexpose');
  await expect(page.getByRole('region', { name: 'On the internet' }).locator('li').filter({ hasText: 'draw.example.org' })).toHaveCount(0);
});

test('network: secure addresses card is off by default and explains LAN mode', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/network');
  await expect(page.getByRole('heading', { name: 'Secure addresses' })).toBeVisible();
  await expect(page.getByLabel('Secure addresses on the home network')).not.toBeChecked();
  // e2e runs without LAN mode: the card says so and the toggle stays disabled
  await expect(page.getByText(/LAN mode is off/)).toBeVisible();
  await expect(page.getByLabel('Secure addresses on the home network')).toBeDisabled();
  // decision 167: the HTTPS-only switch only appears once secure addresses are on
  await expect(page.getByRole('heading', { name: 'HTTPS only', exact: true })).toHaveCount(0);
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
  // BentoPDF is installed by now: its page offers Open and Close (decision 170)
  await page.getByRole('dialog').getByRole('button', { name: /^(Close|Cancel)$/ }).click();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});

test('notifications screen: nav destination renders, empty state, bell links to it', async ({ page }) => {
  await login(page);
  // The nav has a Notifications destination that opens the full screen.
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  // Fresh daemon: either the empty state or whatever rows the suite already produced. Rows come and go
  // with the poll (a resolved condition deletes its row), so assert "one of the two" in a single retrying
  // expectation; every row has a separate dismiss × with an accessible name.
  await expect(page.getByText('Nothing yet').or(page.getByRole('button', { name: /Dismiss notification:/ }).first())).toBeVisible();
  // The bell's "All notifications" navigates to the same screen.
  await page.getByRole('button', { name: /^Notifications/ }).first().click(); // bell toggle
  const viewAll = page.getByRole('button', { name: /All notifications/ });
  if (await viewAll.count()) {
    await viewAll.click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  }
});

test('install page: a wrong-filesystem drive offers Format, not Mount or a passphrase', async ({ page }) => {
  await login(page);
  // order-independent: a prior run may have left the fixture formatted —
  // reset it to the vfat shape first (unmount clears the format overlay).
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Storage Disks/ }).click();
  await expect(page.locator('.disk', { hasText: 'USB20FD' })).toBeVisible();
  if (await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).count()) {
    await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible({ timeout: 15_000 });
  }
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About BentoPDF' }).click();
  const where = page.getByRole('dialog');
  // decision 170: BentoPDF is installed by now, so its page opens it; the install page is one step further
  await where.getByRole('button', { name: 'Add another copy of BentoPDF', exact: true }).click();
  // This machine is the default (no media folder); Change lists it and every drive as ONE radio group
  await expect(where.locator('.choice-main strong').first()).toHaveText('This machine');
  await where.getByRole('button', { name: 'Change where BentoPDF is stored' }).click();
  await expect(where.getByRole('group', { name: 'Where to keep BentoPDF' })).toContainText('This machine');
  // the unmounted vfat stick shows with Format, never Mount
  await expect(where.getByText(/uses vfat, which cannot hold apps\. Format it as ext4 to use it\./)).toBeVisible();
  await expect(where.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible();
  await expect(where.getByRole('button', { name: 'Mount USB20FD', exact: true })).toHaveCount(0);
  // formatting from the wizard remounts ext4 and selects the drive
  await where.getByRole('button', { name: 'Format USB20FD as ext4', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /Format USB20FD as ext4/ });
  await expect(dlg).toContainText(/erases everything/);
  const go = dlg.getByRole('button', { name: 'Format (erase everything)' });
  await expect(go).toBeDisabled();
  await dlg.getByLabel(/Type .* to confirm/).fill('sdb1');
  await expect(go).toBeEnabled();
  await go.click();
  await expect(where.getByRole('button', { name: /Formatting/ })).toBeVisible();
  // The formatted drive lands selected and installable WITHOUT a passphrase
  // (decision 106): the Harbor recovery key is what opens it elsewhere.
  await expect(where.locator('.choice-main strong').first()).toHaveText('USB20FD', { timeout: 30_000 });
  await expect(where).toContainText('Unplug the drive and BentoPDF pauses');
  await where.getByText('Advanced: name, passphrase, folders, technical details').click();
  await expect(where.getByRole('button', { name: 'Use my own passphrase instead…' })).toBeVisible();
  await expect(where.getByLabel('Encryption passphrase for this app')).toHaveCount(0);
  await expect(where.getByRole('button', { name: 'Install BentoPDF' })).toBeEnabled();
  // …and opting in still offers one, with the 8-character floor gating Install.
  await where.getByRole('button', { name: 'Use my own passphrase instead…' }).click();
  await where.getByLabel('Encryption passphrase for this app').fill('short');
  await expect(where.getByRole('button', { name: 'Install BentoPDF' })).toBeDisabled();
  await where.getByLabel('Encryption passphrase for this app').fill('correct horse battery staple');
  await expect(where.getByRole('button', { name: 'Install BentoPDF' })).toBeEnabled();
  // the enforced path nests package + instance under the drive
  await expect(where.locator('code.path')).toContainText('bentopdf/bentopdf');
  await where.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('install page: bring your own folder validates the path in the plan and mounts it', async ({ page }) => {
  let folder = ''; // eslint-disable-line no-useless-assignment -- assigned from the picker below
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'About Jellyfin' }).click();
  const about = page.getByRole('dialog');
  // decision 148: an own folder is an Advanced exception, labeled as not encrypted
  await about.getByText('Advanced: name, passphrase, folders, technical details').click();
  await about.getByLabel(/Keep your media library in a folder of my own \(not encrypted\)/).check();
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
  await again.getByText('Advanced: name, passphrase, folders, technical details').click();
  await again.getByLabel(/in a folder of my own/).check();
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
  await expect(again.locator('.folder-choice code.path')).toHaveText(chosen);
  await expect(again.getByRole('region', { name: 'Storage' })).toContainText('(not encrypted)');
  await expect(again.getByRole('region', { name: 'Storage' })).toContainText('Encrypted, except your media library (your folder)');
  folder = chosen;
  await again.getByRole('button', { name: 'Install Jellyfin now' }).click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText(`your folder ${folder}`);
  await plan.getByText(/Exactly what Harbor will do/).click();
  await expect(plan).toContainText(`Use your folder ${folder}`);
  await plan.getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
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

test('storage: a wrong-filesystem drive offers Format first, then Eject once ext4', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Storage Disks/ }).click();
  // order-independent: a prior test may have left the fixture formatted —
  // ejecting restores the vfat shape (unmount clears the format overlay).
  // Wait for the drive row first: count() does not retry, so an immediate
  // check would miss the Eject button while the list is still loading.
  await expect(page.locator('.disk', { hasText: 'USB20FD' })).toBeVisible();
  if (await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).count()) {
    await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible({ timeout: 15_000 });
  }
  // the fixture stick is vfat: the Disks row says it needs formatting and
  // leads with Format (Mount would only dead-end on the wrong filesystem)
  await expect(page.locator('.disk', { hasText: 'USB20FD' }).getByText(/needs formatting as ext4 before it can hold apps/)).toBeVisible();
  const format = page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true });
  await expect(format).toBeVisible();
  await format.click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/erases everything/);
  const go = dlg.getByRole('button', { name: 'Format (erase everything)' });
  await expect(go).toBeDisabled();
  await dlg.getByLabel(/Type .* to confirm/).fill('sdb1');
  await expect(go).toBeEnabled();
  await go.click();
  // the row locks with a Formatting… spinner, then the drive is ext4 + mounted
  await expect(page.getByRole('button', { name: /Formatting/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eject USB20FD', exact: true })).toBeVisible({ timeout: 15_000 });
  // and back again
  const eject = page.getByRole('button', { name: 'Eject USB20FD', exact: true });
  await eject.click();
  await expect(page.getByRole('button', { name: /Ejecting/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible({ timeout: 15_000 });
});

test('drives: a desktop-mounted drive shows a Home card (dismissable) and Settings → Storage takes it over (decision 122)', async ({ page }) => {
  await login(page);
  const card = page.getByRole('region', { name: /drive needs attention|drives need attention/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('PHOTOS');
  await expect(card).toContainText('mounted by your desktop at /media/e2e/PHOTOS');
  await expect(card.getByRole('button', { name: 'Let Harbor manage PHOTOS', exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Manage drives' })).toHaveAttribute('href', '#/settings/storage');
  await card.getByRole('button', { name: 'Dismiss the notice about PHOTOS', exact: true }).click();
  await expect(card).toHaveCount(0);
  // The dismissal hides the card only; Settings → Storage still offers the fix.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Storage Disks/ }).click();
  const row = page.locator('.disk', { hasText: 'PHOTOS' });
  await expect(row.getByText(/Mounted by your desktop at \/media\/e2e\/PHOTOS/)).toBeVisible();
  await row.getByRole('button', { name: 'Let Harbor manage PHOTOS', exact: true }).click();
  await expect(row.getByText(/Mounted by your desktop/)).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toContainText('/mnt/sdc1');
});

test('storage: a non-ext4 drive offers Format as ext4 with typed confirmation', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Storage Disks/ }).click();
  // order-independent: a prior test may have left the fixture formatted —
  // ejecting restores the vfat shape (unmount clears the format overlay).
  // Wait for the drive row first: count() does not retry, so an immediate
  // check would miss the Eject button while the list is still loading.
  await expect(page.locator('.disk', { hasText: 'USB20FD' })).toBeVisible();
  if (await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).count()) {
    await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible({ timeout: 15_000 });
  }
  // the fixture stick is vfat: the Disks row says it needs formatting
  await expect(page.locator('.disk', { hasText: 'USB20FD' }).getByText(/needs formatting as ext4 before it can hold apps/)).toBeVisible();
  const format = page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true });
  await expect(format).toBeVisible();
  await format.click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/erases everything/);
  // the destructive button stays disabled until the device name is typed
  const go = dlg.getByRole('button', { name: 'Format (erase everything)' });
  await expect(go).toBeDisabled();
  await dlg.getByLabel(/Type .* to confirm/).fill('sdb1');
  await expect(go).toBeEnabled();
  await go.click();
  // the row locks with a Formatting… spinner, then the drive is ext4 + mounted
  await expect(page.getByRole('button', { name: /Formatting/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Eject USB20FD', exact: true })).toBeVisible({ timeout: 15_000 });
  // the formatted drive row no longer warns; the 2s storage poll reloads the list
  await expect(page.locator('.disk', { hasText: 'USB20FD' }).getByText(/needs formatting as ext4 before it can hold apps/)).toHaveCount(0, { timeout: 15_000 });
  // Eject returns it to unmounted; the row still leads with Format (still vfat-shaped in the fixture)
  await page.getByRole('button', { name: 'Eject USB20FD', exact: true }).click();
  await expect(page.getByRole('button', { name: /Ejecting/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Format USB20FD as ext4', exact: true })).toBeVisible({ timeout: 15_000 });
});

test('full uninstall: typed confirmation, data deleted, name free again', async ({ page }) => {
  await login(page);
  // an encrypted app to back up: the suite's memos when it is there, a fresh one when run alone
  await page.waitForTimeout(1500); // let Home load its tiles
  if (!(await page.getByRole('button', { name: 'Details of memos', exact: true }).count())) {
    await installFromStore(page, 'Memos');
    await approve(page, 'Install');
    await trayDone(page, 'Install');
    await dismissRecovery(page);
  }
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of memos' }).click();
  const d = page.getByRole('dialog');
  // The setup hint opens the app at the same address as the Open button (decision 115).
  await expect(d.getByText('Finish setup inside the app:')).toBeVisible();
  const opens = await d.getByRole('link', { name: 'Open memos', exact: true }).evaluateAll((els) => els.map((e) => (e as { href: string }).href));
  expect(opens).toHaveLength(2);
  expect(new Set(opens).size).toBe(1);
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
  await dismissRecovery(page);
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
  // decision 131: Hide from Home — out of the launcher, behind a quiet "1 hidden app", and back
  await page.getByRole('button', { name: 'Details of memos' }).click();
  await page.getByRole('dialog').getByLabel('Hide memos from Home', { exact: true }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const launcher = page.locator('.icons[aria-label="Installed apps"]');
  await expect(launcher.locator('.icon-tile[data-instance="memos"]')).toHaveCount(0);
  await page.getByText('1 hidden app', { exact: true }).click();
  await page.locator('.retained-list .icon-tile[data-instance="memos"]').getByRole('button', { name: 'Details of memos' }).click();
  await page.getByRole('dialog').getByLabel('Hide memos from Home', { exact: true }).uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(launcher.locator('.icon-tile[data-instance="memos"]')).toHaveCount(1);
  // decision 143: an encrypted app's passphrase — to my own, then back to Harbor's own key
  await page.getByRole('button', { name: 'Details of memos', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByText('Change passphrase…', { exact: true }).click();
  await drawer.getByRole('radio', { name: 'My own passphrase' }).check();
  await drawer.getByLabel('New passphrase for memos', { exact: true }).fill('memos own passphrase');
  await drawer.getByLabel('New passphrase for memos again', { exact: true }).fill('memos own passphrase');
  await drawer.getByRole('button', { name: 'Change passphrase of memos' }).click();
  await expect(drawer.getByRole('status').filter({ hasText: 'Done: it has its new passphrase.' })).toBeVisible();
  await expect(drawer.locator('.recovery-card')).toBeVisible(); // its own 12 words, once
  await dismissRecovery(page);
  await expect(drawer.getByText('It opens with its own passphrase now.')).toBeVisible();
  await drawer.getByRole('radio', { name: /Harbor's own key/ }).check();
  await drawer.getByLabel('Current passphrase of memos', { exact: true }).fill('memos own passphrase');
  await drawer.getByRole('button', { name: 'Change passphrase of memos' }).click();
  await expect(drawer.getByRole('status').filter({ hasText: "Done: it opens with Harbor's own key now." })).toBeVisible();
  // decision 145: Move to… lists where it lives and the other places that can hold it (none here but drives)
  await drawer.getByText('Move to…', { exact: true }).click();
  await expect(drawer.getByText(/Lives at .*harbor-apps\/memos\/memos/)).toBeVisible();
  await expect(drawer.getByText(/No other place can hold it right now|Choose a place…/).first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
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

test('rotating wallpapers: on from the first start, a picture with credit appears, next picture works; Reddit asks for a key', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/appearance');
  await expect(page.getByRole('heading', { name: 'Readability over pictures' })).toBeVisible();
  const slider = page.getByLabel('Surface opacity');
  await expect(slider).toBeVisible();
  await slider.fill('1');
  expect(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--surfaces-opacity').trim()")).toBe('1');
  expect(await page.evaluate("localStorage.getItem('harbor.surfaces-opacity')")).toBe('1');
  await page.getByRole('button', { name: 'Reset' }).click();
  expect(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--surfaces-opacity').trim()")).toBe('0.94');
  await expect(page.getByRole('heading', { name: 'Rotating wallpapers' })).toBeVisible();
  // decision 132: a fresh install starts with the picture of the day already on
  await expect(page.getByRole('switch', { name: 'Rotating wallpapers' })).toBeChecked();
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
  await expect(card).toContainText('Your app');
  await expect(card.locator('.store-ver')).toHaveText('v1.1'); // decision 174: the app's own version, on its own
  await card.getByRole('button', { name: 'Install Hello E2E', exact: true }).click();
  const wiz = page.getByRole('dialog');
  await expect(wiz.getByRole('region', { name: 'Storage' })).toBeVisible();
  await wiz.getByRole('button', { name: 'Install Hello E2E now' }).click();
  const plan = page.getByRole('dialog');
  await expect(plan).toContainText('your own uploaded app');
  await plan.getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
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
  // the Store card leads with Update (Open stays next to it) and says which versions
  const card2 = page.locator('.tile.store').filter({ hasText: 'Hello E2E' });
  await expect(card2).toContainText('Update available');
  await expect(card2.locator('.store-ver')).toHaveText('v1.1 → v1.2');
  await expect(card2.getByRole('button', { name: 'Update hello-e2e', exact: true })).toBeEnabled();
  await expect(card2.getByRole('link', { name: 'Open Hello E2E', exact: true })).toBeVisible();
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
  await expect(review).toContainText('from v1.1 to v1.2');
  await review.getByRole('button', { name: 'Update now' }).click();
  await expect(page.getByRole('heading', { name: /Hello E2E is up to date/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '1 update available' })).toHaveCount(0);
  await expect(tile.getByRole('link', { name: 'Open hello-e2e' })).toHaveAttribute('href', href!); // same address after the update
});

test('app links and typed-in secrets: the install picks the provider, the review asks for the value; the app page and Internal networks show the link (decisions 125/126)', async ({ page }) => {
  const { writeZip } = await import('../../src/packages/zip.js');
  const head = (id: string, name: string, services: string, port: number) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${name}
  description: ${name} for the links test
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: true
  services:
${services}
endpoints:
  web:
    service: web
    containerPort: ${port}
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
  tagline: ${name}
  category: developer
`;
  const docs = head('docs-e2e', 'Docs E2E', '    web: application\n    db: infrastructure', 3010);
  const gw = head('gateway-e2e', 'Gateway E2E', '    web: application', 8080) + `secrets:
  - id: api-token
    source: operator
    prompt: Access token for Docs E2E
    minLength: 8
    retention: retain
    bindings:
      - {service: web, environment: DOCS_TOKEN}
links:
  - id: docs
    purpose: The documents it reads
    provider: {packages: [docs-e2e]}
    bindings:
      - {service: web, environment: DOCS_BASE_URL}
`;
  const zip = (m: string, services: string[]) => writeZip({ 'manifest.yaml': m, 'compose.yaml': `services:\n${services.map((x) => `  ${x}:\n    image: nginx:1.27-alpine\n`).join('')}` });
  await login(page);
  for (const [file, buf, name] of [['docs.zip', zip(docs, ['web', 'db']), 'Docs E2E'], ['gw.zip', zip(gw, ['web']), 'Gateway E2E']] as const) {
    await page.getByRole('link', { name: 'App Store' }).click();
    await page.getByRole('button', { name: 'Add your own app' }).click();
    const dlg = page.getByRole('dialog', { name: 'Your own app' });
    await dlg.getByLabel('Package zip file').setInputFiles({ name: file, mimeType: 'application/zip', buffer: buf });
    await expect(dlg).toContainText(`${name} is in your App Store`);
    await dlg.getByRole('button', { name: 'Done' }).click();
  }
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'Docs E2E' }).getByRole('button', { name: 'Install Docs E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install Docs E2E now' }).click();
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  // the consumer: the wizard picks the only provider; the review asks for the token
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'Gateway E2E' }).getByRole('button', { name: 'Install Gateway E2E', exact: true }).click();
  const wiz = page.getByRole('dialog');
  await expect(wiz).toContainText('Talks privately to');
  await expect(wiz.getByLabel('Provider for docs', { exact: true })).toHaveValue(/.+/);
  await wiz.getByRole('button', { name: 'Install Gateway E2E now' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Review install');
  await expect(review).toContainText('http://docs-link:3010');
  const field = review.getByLabel('Value for api-token', { exact: true });
  await expect(field).toHaveAttribute('type', 'password');
  await expect(review.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  await field.fill('tok-FIXTURE-e2e-123');
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of gateway-e2e' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Links');
  await expect(drawer).toContainText('linked');
  await expect(drawer).toContainText('http://docs-link:3010');
  await expect(drawer).toContainText('set, never shown');
  await expect(drawer).not.toContainText('tok-FIXTURE-e2e-123');
  await expect(drawer.getByRole('button', { name: 'Change api-token' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).last().click();
  await page.goto('/#/settings/links');
  await expect(page.getByRole('heading', { name: 'Internal networks' })).toBeVisible();
  const list = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Internal networks' }) });
  await expect(list).toContainText('gateway-e2e');
  await expect(list).toContainText('docs-e2e');
  await expect(list).toContainText('_link_docs');
});

test('advanced access: the terminal runs a shell and echoes; troubleshoot shows Harbor and app logs; the machine can be renamed', async ({ page }) => {
  await login(page);
  await page.goto('/#/settings/access');
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible();
  const port = process.env['HARBOR_E2E_PORT'] ?? '18500'; // the daemon's own port (playwright.config.ts)
  await expect(page.locator('pre.code.wrap').first()).toContainText(`-L ${port}:127.0.0.1:${port}`);
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
  await page.goto('/#/settings/account');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
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
presentation:
  source: https://github.com/example/hello-creds
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
  // decision 164: the manifest's source link leads the install page
  await expect(about.getByRole('link', { name: /Source code on GitHub/ })).toHaveAttribute('href', 'https://github.com/example/hello-creds');
  await expect(about.getByRole('note')).toContainText('Default login');
  await expect(about.getByRole('note')).toContainText('changeme');
  await expect(about.getByRole('note')).toContainText('change it after the first sign-in');
  await about.getByRole('button', { name: 'Install Hello Creds now' }).click();
  await expect(page.getByRole('dialog')).toContainText('ships with a default login (admin)');
  await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of hello-creds' }).click();
  await expect(page.getByRole('dialog').getByRole('note')).toContainText('changeme', { timeout: 10_000 });
});

test('backups: add a place, back an encrypted app up, restore it in place, delete the copy kept aside (decisions 149–154)', async ({ page }) => {
  await login(page);
  // an encrypted app to back up: the suite's memos when it is there, a fresh one when run alone
  await page.waitForTimeout(1500); // let Home load its tiles
  if (!(await page.getByRole('button', { name: 'Details of memos', exact: true }).count())) {
    await installFromStore(page, 'Memos');
    await approve(page, 'Install');
    await trayDone(page, 'Install');
    await dismissRecovery(page);
  }
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Backups/ }).click();
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add a place' }).click();
  const add = page.getByRole('dialog');
  await add.getByRole('button', { name: 'Choose Another disk' }).click();
  await add.getByLabel('Folder', { exact: false }).fill('/mnt/backup/e2e');
  await add.getByRole('button', { name: 'Test and add' }).click();
  await expect(page.getByRole('status')).toContainText('Another disk is ready');
  await expect(page.locator('.place').first()).toContainText('Ready');
  // the schedule is there with its defaults
  await expect(page.getByLabel('Backup window start')).toHaveValue('02:00');

  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of memos', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.locator('summary', { hasText: /^Backups/ }).click();
  await drawer.getByLabel('Back up memos to Another disk').check();
  await drawer.getByLabel('Back up memos every night').check();
  await drawer.getByRole('button', { name: 'Back up memos now' }).click();
  await expect(drawer.getByRole('status')).toContainText('Queued');
  // the run stops the app only for its last pass; a restore point appears
  const restore = drawer.getByRole('button', { name: /^Restore memos to / });
  await expect(async () => {
    await drawer.getByRole('button', { name: 'Refresh' }).click();
    await expect(restore.first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await restore.first().click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Review restore');
  await expect(review).toContainText('kept aside');
  await review.getByRole('button', { name: 'Restore now' }).click();
  await trayDone(page, 'Restore');
  await page.getByRole('button', { name: 'Details of memos', exact: true }).click();
  const after = page.getByRole('dialog');
  await after.locator('summary', { hasText: /^Backups/ }).click();
  await expect(after).toContainText('before the last restore', { timeout: 15_000 });
  await after.getByRole('button', { name: 'Delete it' }).click();
  await expect(after).not.toContainText('before the last restore', { timeout: 15_000 });
});

test('decision 169: an SFTP place shows the server key fingerprint and is added only after "Trust this key"', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Backups/ }).click();
  await page.getByRole('button', { name: 'Add a place' }).click();
  const add = page.getByRole('dialog');
  await add.getByRole('button', { name: 'Choose SFTP server' }).click();
  await add.locator('label', { hasText: /^Server(?! key)/ }).locator('input').fill('nas.example.test');
  await add.locator('label', { hasText: /^User/ }).locator('input').fill('backup');
  await add.locator('label', { hasText: /^Folder on the server/ }).locator('input').fill('/srv/backup/e2e');
  await add.locator('label', { hasText: /^Private key/ }).locator('textarea').fill('-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n-----END OPENSSH PRIVATE KEY-----');
  await add.getByRole('button', { name: 'Test and add' }).click();
  const check = add.getByRole('alert');
  await expect(check).toContainText('Check the server key');
  await expect(check).toContainText(/SHA256:[A-Za-z0-9+/]{43}/);
  await check.getByRole('button', { name: 'Trust this key', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('SFTP server is ready');
});

test('a VPN-style app: the review lists its UDP port and permissions; Install waits for the permission box; the drawer shows the port to forward (decision 163)', async ({ page }) => {
  const { writeZip } = await import('../../src/packages/zip.js');
  const { createSocket } = await import('node:dgram');
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '0.0.0.0', () => r()));
  const port = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  const manifest = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: tunnel-e2e
  name: Tunnel E2E
  description: A VPN server
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
ports:
  tunnel:
    service: web
    containerPort: 51820
    hostPort: ${port}
    protocol: udp
    purpose: VPN tunnels
permissions:
  web: [net-admin, tun]
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const dlg = page.getByRole('dialog', { name: 'Your own app' });
  await dlg.getByLabel('Package zip file').setInputFiles({ name: 'tunnel-e2e.zip', mimeType: 'application/zip', buffer: writeZip({ 'manifest.yaml': manifest, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: 'tunnel-e2e' }) });
  await expect(dlg).toContainText('Tunnel E2E is in your App Store');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'Tunnel E2E' }).getByRole('button', { name: 'Install Tunnel E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install Tunnel E2E now' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText(`UDP ${port} on every network`);
  await expect(review.getByRole('group', { name: 'This app asks to' })).toContainText('create network tunnels');
  await expect(review.getByRole('group', { name: 'This app asks to' })).toContainText('/dev/net/tun');
  const install = review.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  await review.getByLabel('Allow Tunnel E2E to do this').check();
  await expect(install).toBeEnabled();
  await install.click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of tunnel-e2e' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Ports' })).toBeVisible();
  await expect(drawer).toContainText(`forward UDP ${port} on your router`);
});

test('decision 179: an app that asks for the graphics card: the review names the card and Install waits for the box; the app page and Settings show it', async ({ page }) => {
  // the e2e daemon's fake machine has an NVIDIA card (driver 595.99.02) with the toolkit (HARBOR_DEV_GPU=nvidia in playwright.config.ts)
  const { writeZip } = await import('../../src/packages/zip.js');
  const manifest = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: gpu-e2e
  name: GPU E2E
  description: A local model server
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
    web: application
endpoints:
  web:
    service: web
    containerPort: 80
    scheme: http
    exposure: direct
    browserContext: ordinary
permissions:
  web: [gpu]
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const dlg = page.getByRole('dialog', { name: 'Your own app' });
  await dlg.getByLabel('Package zip file').setInputFiles({ name: 'gpu-e2e.zip', mimeType: 'application/zip', buffer: writeZip({ 'manifest.yaml': manifest, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: 'gpu-e2e' }) });
  await expect(dlg).toContainText('GPU E2E is in your App Store');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'GPU E2E' }).getByRole('button', { name: 'Install GPU E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install GPU E2E now' }).click();
  const review = page.getByRole('dialog');
  const asks = review.getByRole('group', { name: 'This app asks to' });
  await expect(asks).toContainText("Use this machine's graphics card (GPU)");
  await expect(asks).toContainText('This machine has an NVIDIA GeForce RTX 3090: the app uses it.');
  const install = review.getByRole('button', { name: 'Install', exact: true });
  await expect(install).toBeDisabled();
  await review.getByLabel('Allow GPU E2E to do this', { exact: true }).check();
  await expect(install).toBeEnabled();
  await install.click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of gpu-e2e', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'Graphics card', exact: true })).toBeVisible();
  // decision 181: a working NVIDIA card is named with its running driver (the review above stays short)
  await expect(drawer).toContainText('NVIDIA GeForce RTX 3090 (driver 595.99.02, in use)');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('.device-facts')).toContainText('Graphics card');
  await expect(page.locator('.device-facts')).toContainText('NVIDIA GeForce RTX 3090 (driver 595.99.02)');
});

test('decision 180: app settings: the install review has Options; the app page lists Settings and Change… goes through a plan', async ({ page }) => {
  const { writeZip } = await import('../../src/packages/zip.js');
  const manifest = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: tuning-e2e
  name: Tuning E2E
  description: A model server with settings
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
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
settings:
  - id: context-length
    label: "Context length (tokens)"
    help: "How much text a model keeps in mind."
    type: integer
    default: 8192
    min: 2048
    max: 131072
    bindings:
      - {service: web, environment: OLLAMA_CONTEXT_LENGTH}
  - id: flash-attention
    label: "Flash attention"
    type: boolean
    default: false
    bindings:
      - {service: web, environment: OLLAMA_FLASH_ATTENTION}
  - id: kv-cache
    label: "Memory cache precision"
    type: choice
    default: f16
    choices: [{value: f16, label: "Full"}, {value: q8_0, label: "Half"}]
    bindings:
      - {service: web, environment: OLLAMA_KV_CACHE_TYPE}
`;
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const dlg = page.getByRole('dialog', { name: 'Your own app' });
  await dlg.getByLabel('Package zip file').setInputFiles({ name: 'tuning-e2e.zip', mimeType: 'application/zip', buffer: writeZip({ 'manifest.yaml': manifest, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: 'tuning-e2e' }) });
  await expect(dlg).toContainText('Tuning E2E is in your App Store');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'Tuning E2E' }).getByRole('button', { name: 'Install Tuning E2E', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install Tuning E2E now' }).click();
  // the review: Options is collapsed, with the defaults filled in
  const review = page.getByRole('dialog', { name: 'Review install' });
  const options = review.locator('details.options');
  await expect(options).toContainText('Options');
  await expect(options).not.toHaveAttribute('open', '');
  await options.locator('summary').click();
  const context = review.getByLabel('Context length (tokens)', { exact: true });
  await expect(context).toHaveValue('8192');
  await expect(review.getByLabel('Flash attention', { exact: true })).not.toBeChecked();
  const install = review.getByRole('button', { name: 'Install', exact: true });
  await context.fill('100'); // below the minimum: Install waits
  await expect(install).toBeDisabled();
  await expect(options).toContainText('Use a whole number from 2048 to 131072.');
  // the reason stays visible: the summary counts it, an alert names it, and Options does not collapse over it
  await expect(options.locator('summary')).toContainText('1 to fix');
  await expect(review.getByRole('alert')).toContainText('Fix an option first: Context length (tokens): a whole number from 2048 to 131072');
  await options.locator('summary').click();
  await expect(options).toHaveAttribute('open', '');
  await context.fill('16384');
  await review.getByLabel('Flash attention', { exact: true }).check();
  await expect(options).toContainText('2 changed');
  await expect(install).toBeEnabled();
  await install.click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  // the app page: label, value, (default) marker
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of tuning-e2e', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Tuning E2E' });
  await expect(drawer.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  const list = drawer.locator('.settings-list');
  await expect(list).toContainText('Context length (tokens) 16384');
  await expect(list).toContainText('Flash attention on');
  await expect(list).toContainText('Memory cache precision Full (default)');
  // Change… → the form → Review → the normal review dialog → Apply
  await drawer.getByRole('button', { name: 'Change the settings of tuning-e2e', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Settings of Tuning E2E' });
  const reviewBtn = form.getByRole('button', { name: 'Review', exact: true });
  await expect(reviewBtn).toBeDisabled(); // nothing changed yet
  await form.getByLabel('Memory cache precision', { exact: true }).selectOption('q8_0');
  await form.getByRole('button', { name: 'Reset Context length (tokens) to the default', exact: true }).click();
  await expect(form.getByLabel('Context length (tokens)', { exact: true })).toHaveValue('8192');
  await reviewBtn.click();
  const plan = page.getByRole('dialog', { name: 'Review new settings' });
  await expect(plan).toContainText('Memory cache precision: Full → Half');
  await expect(plan).toContainText('Context length (tokens): 16384 → 8192 (default)');
  await plan.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('heading', { name: /settings applied$/ })).toBeVisible({ timeout: 30_000 });
  // the drawer closed when the review opened; the app page shows the new values
  await page.getByRole('button', { name: 'Details of tuning-e2e', exact: true }).click();
  await expect(list).toContainText('Memory cache precision Half', { timeout: 15_000 });
  await expect(list).toContainText('Context length (tokens) 8192 (default)');
  await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
});

test('decision 170: a one-copy app shows only Open once installed, on its card and its page', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  const card = page.locator('.tile.store').filter({ hasText: 'Tunnel E2E' }); // installed by the VPN test above
  await expect(card.getByRole('link', { name: 'Open Tunnel E2E', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Install Tunnel E2E', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Add another copy of Tunnel E2E', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'About Tunnel E2E', exact: true }).click();
  const about = page.getByRole('dialog');
  await expect(about).toContainText('runs as one copy per machine');
  await expect(about.getByRole('link', { name: 'Open Tunnel E2E', exact: true })).toBeVisible();
  await expect(about.getByRole('button', { name: 'Install Tunnel E2E now', exact: true })).toHaveCount(0);
  await expect(about.getByRole('button', { name: 'Add another copy of Tunnel E2E', exact: true })).toHaveCount(0);
  await about.getByRole('button', { name: 'Close', exact: true }).click();
  // removed with its data kept: the card and the page bring that copy back (Reinstall…), never an Install
  // the daemon would refuse
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of tunnel-e2e', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove tunnel-e2e', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove (keep data)' }).click();
  await trayDone(page, 'Remove');
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  const removed = page.locator('.tile.store').filter({ hasText: 'Tunnel E2E' });
  await expect(removed).toContainText('Removed · data kept');
  await expect(removed.getByRole('button', { name: 'Reinstall Tunnel E2E', exact: true })).toBeVisible();
  await expect(removed.getByRole('button', { name: 'Install Tunnel E2E', exact: true })).toHaveCount(0);
  await removed.getByRole('button', { name: 'About Tunnel E2E', exact: true }).click();
  const page2 = page.getByRole('dialog');
  await expect(page2).toContainText('your removed copy still keeps its data');
  await expect(page2.getByRole('button', { name: 'Install Tunnel E2E now', exact: true })).toHaveCount(0);
  await page2.getByRole('button', { name: 'Reinstall Tunnel E2E', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Reinstall tunnel-e2e', exact: true })).toBeVisible();
});

test('decision 170: Store cards for 0, 1 and 2 copies; the second copy says so, with its own name, and Home tells them apart', async ({ page }) => {
  await login(page);
  const store = async () => {
    await page.getByRole('link', { name: 'App Store' }).click();
    await expect(page.getByRole('heading', { name: 'App Store' })).toBeVisible();
    return page.locator('.tile.store').filter({ has: page.getByRole('heading', { name: 'FreshRSS', exact: true }) });
  };
  // no copy yet: Install only
  let card = await store();
  await expect(card.getByRole('button', { name: 'Install FreshRSS', exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open FreshRSS', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Add another copy of FreshRSS', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Install FreshRSS', exact: true }).click();
  const first = page.getByRole('dialog');
  await expect(first.getByRole('note', { name: 'Another copy' })).toHaveCount(0);
  // a bad name typed under Advanced says why Install is greyed out (no silent dead button)
  await first.getByText('Advanced: name, passphrase, folders, technical details', { exact: true }).click();
  const optional = first.getByLabel('Instance name for FreshRSS', { exact: true });
  await optional.fill('Bad_Name');
  await expect(first.getByRole('alert').filter({ hasText: 'Use lowercase letters' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Install FreshRSS now', exact: true })).toBeDisabled();
  await optional.fill('');
  await expect(first.getByRole('alert').filter({ hasText: 'Use lowercase letters' })).toHaveCount(0);
  await first.getByRole('button', { name: 'Install FreshRSS now', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Review install');
  await expect(page.getByRole('dialog')).not.toContainText('You already have FreshRSS');
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  // one copy: Open (the copy you have) plus a secondary "Add another copy…"
  card = await store();
  await expect(card).toContainText('Installed');
  await expect(card.getByRole('link', { name: 'Open FreshRSS', exact: true })).toHaveAttribute('href', /^http:\/\/localhost:\d+\/$/);
  await expect(card.getByRole('button', { name: 'Install FreshRSS', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Add another copy of FreshRSS', exact: true }).click();
  const wiz = page.getByRole('dialog');
  const notice = wiz.getByRole('note', { name: 'Another copy' });
  await expect(notice).toContainText('You already have FreshRSS. This installs a separate copy with its own data, address and login; the first one is not touched.');
  const nameField = wiz.getByLabel('Name for this copy', { exact: true });
  await expect(nameField).toHaveValue('freshrss-2');
  // the name is required and must be free
  const go = wiz.getByRole('button', { name: 'Install FreshRSS now', exact: true });
  await nameField.fill('');
  await expect(go).toBeDisabled();
  await nameField.fill('freshrss');
  await expect(notice.getByRole('alert')).toContainText('already the name of another app');
  await expect(go).toBeDisabled();
  await nameField.fill('freshrss-2');
  await expect(go).toBeEnabled();
  await go.click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Review install');
  await expect(review).toContainText('You already have FreshRSS. This installs a separate copy (freshrss-2)');
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  // two copies: the card counts them; Home names each copy under its icon
  card = await store();
  await expect(card).toContainText('2 installed');
  await expect(card.getByRole('link', { name: 'Open FreshRSS', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Add another copy of FreshRSS', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('.icon-tile[data-instance="freshrss"] .icon-copy')).toHaveText('freshrss');
  await expect(page.locator('.icon-tile[data-instance="freshrss-2"] .icon-copy')).toHaveText('freshrss-2');
  await page.getByRole('button', { name: 'Details of freshrss-2', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'FreshRSS · freshrss-2', exact: true })).toBeVisible();
});

test('decision 164: a locked machine key asks for the password in place and carries on with the install', async ({ page }) => {
  await login(page);
  // the daemon answers the first plan as if it had restarted since this login (its key is in fact open,
  // so the real unlock call that follows succeeds and the retried plan goes through)
  let first = true;
  await page.route('**/v1/plans', async (route) => {
    if (first && route.request().method() === 'POST') {
      first = false;
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MACHINE_KEY_LOCKED', message: 'Harbor restarted since your last login, so its key for encrypted apps is locked', nextAction: 'Type your password' } }) });
    }
    return route.continue();
  });
  await installFromStore(page, 'Excalidraw');
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('heading', { name: 'Type your password to continue' })).toBeVisible();
  await dlg.getByLabel('Your Harbor password').fill('not-the-password');
  await dlg.getByRole('button', { name: 'Unlock and continue' }).click();
  await expect(dlg.getByRole('alert')).toContainText('password is wrong');
  await dlg.getByLabel('Your Harbor password').fill(ADMIN.password);
  await dlg.getByRole('button', { name: 'Unlock and continue' }).click();
  await expect(dlg.getByRole('heading', { name: /^Review install/ })).toBeVisible();
  await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.unroute('**/v1/plans');
});

test('decision 164: Store sections, the catalog line with its refresh icon on top, settings readable and scrolling on their own', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'App Store' }).click();
  const head = page.locator('.store-head');
  await expect(head.getByText(/^App catalog (from|bundled with this Harbor)/)).toBeVisible();
  await expect(head.getByRole('button', { name: 'Check for new apps', exact: true })).toBeVisible();
  const sections = page.getByRole('group', { name: 'Store sections' });
  await sections.getByRole('button', { name: 'Backup places' }).click();
  await expect(page.getByRole('heading', { name: 'Backup places' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Another disk' })).toBeVisible();
  await sections.getByRole('button', { name: 'Apps' }).click();
  await expect(page.getByRole('tablist', { name: 'Categories' })).toBeVisible();
  // desktop settings: the two columns scroll on their own, the page itself does not
  await page.goto('/#/settings/storage');
  await expect(page.locator('.settings-body')).toBeVisible();
  expect(await page.evaluate("getComputedStyle(document.querySelector('.settings-body')).overflowY")).toBe('auto');
  expect(await page.evaluate("getComputedStyle(document.querySelector('.settings-nav')).overflowY")).toBe('auto');
});

test('decision 164: phone settings open as a list, then one section with a way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('link', { name: 'Settings' }).click();
  const list = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(list).toBeVisible();
  await expect(page.locator('.settings-body')).toHaveCount(0);
  await list.getByRole('button', { name: /^Appearance/ }).click();
  await expect(page.getByRole('heading', { name: 'Look' })).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to all settings' }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  // one Notifications destination in the dock (the bell hides on phones)
  await expect(page.locator('.bell-btn')).toBeHidden();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});

test('decision 164: a notification brings its own button — Harbor X is available → Install now opens the update', async ({ page }) => {
  // one deterministic row (the daemon derives the same action for a real harbor-update row)
  await page.route('**/v1/notifications', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unread: 1, items: [{ id: 'n-e2e', createdAt: new Date().toISOString(), kind: 'harbor-update', severity: 'info', title: 'Harbor 9.9.9 is available', body: 'Apps keep running.', instanceId: null, read: false, link: '#/settings', actions: [{ label: 'Install now', do: 'update-harbor', route: null }] }] }) })
      : route.continue(),
  );
  await login(page);
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Install now: Harbor 9.9.9 is available' }).click();
  await expect(page).toHaveURL(/#\/settings\/overview$/);
  await expect(page.getByRole('dialog')).toContainText('verifies its checksum', { timeout: 15_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.unroute('**/v1/notifications');
});

// Decision 183: the tray is the queue. A dev-only knob (HARBOR_DEV_FAKE_CONTROL, src/dev.ts) holds one image's fake
// pull until the test releases it, so an install keeps running while the console queues more behind it.
test.describe('queue', () => {
  const control = process.env['HARBOR_E2E_FAKE_CONTROL'] ?? path.join(tmpdir(), `harbor-e2e-fake-control-${process.env['HARBOR_E2E_PORT'] ?? 18500}.json`);
  // holds every fake pull of a matching image until released (src/dev.ts re-reads the file while a pull waits)
  const holdPulls = (match: string) => writeFileSync(control, JSON.stringify({ hold: true, match }));
  const releasePulls = () => writeFileSync(control, '{}');
  test.afterEach(() => releasePulls()); // a failed run never leaves the next test behind a held pull

  test('nothing greys out while an app installs; a second install and a same-app action queue; Cancel takes a waiting one out', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page);
    // an app of this test's own, installed at normal speed
    await installFromStore(page, 'n8n');
    await approve(page, 'Install');
    await trayDone(page, 'Install');
    await dismissRecovery(page);

    // Uptime Kuma's download is held: it keeps the queue's single runner busy while the rest happens
    holdPulls('louislam/uptime-kuma');
    await installFromStore(page, 'Uptime Kuma');
    await approve(page, 'Install');
    const tray = page.locator('aside.tray');
    await expect(tray.getByRole('heading', { name: 'Installing Uptime Kuma…', exact: true })).toBeVisible();
    await expect(tray.getByRole('heading', { name: /^Queue · 1 running/ })).toBeVisible();
    const waiting = tray.getByRole('list', { name: 'Waiting' });

    // Home: the busy app says so; the other app's buttons and the busy app's own stay enabled
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('.icon-tile[data-instance="uptime-kuma"]')).toContainText('Installing…');
    await page.getByRole('button', { name: 'Details of uptime-kuma', exact: true }).click();
    let drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('status', { name: 'Queue for uptime-kuma' })).toContainText('Installing…');
    await expect(drawer.getByRole('button', { name: 'Customize uptime-kuma', exact: true })).toBeEnabled();
    // an installing app offers what makes sense after its install; each queues behind it
    for (const name of ['Stop uptime-kuma', 'Restart uptime-kuma', 'Remove uptime-kuma']) await expect(drawer.getByRole('button', { name, exact: true })).toBeEnabled();
    await drawer.getByText('Uninstall completely…').click();
    await drawer.getByLabel('Type uptime-kuma to confirm', { exact: true }).fill('uptime-kuma');
    await drawer.getByRole('button', { name: 'Uninstall uptime-kuma completely', exact: true }).click();
    let ask = page.getByRole('dialog');
    await expect(ask.getByRole('heading', { name: 'Queue: Uninstall Uptime Kuma', exact: true })).toBeVisible();
    await expect(ask).toContainText('Harbor is installing Uptime Kuma right now. Harbor will uninstall it as soon as that finishes');
    await ask.getByRole('button', { name: 'Queue uninstall', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Uninstall Uptime Kuma' })).toHaveCount(1);
    // changed our mind: it never started, so it leaves the queue and the install goes on
    await tray.getByRole('button', { name: 'Cancel uninstall Uptime Kuma', exact: true }).click();
    await expect(tray.getByRole('list', { name: 'Waiting' })).toHaveCount(0);
    await expect(tray.getByRole('heading', { name: 'Installing Uptime Kuma…', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Details of n8n', exact: true }).click();
    drawer = page.getByRole('dialog');
    for (const name of ['Stop n8n', 'Restart n8n', 'Remove n8n', 'Customize n8n']) await expect(drawer.getByRole('button', { name, exact: true })).toBeEnabled();

    // a reviewed plan for another app is approved at once and waits its turn
    await drawer.getByRole('button', { name: 'Restart n8n', exact: true }).click();
    await approve(page, 'Restart');
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Restart n8n' })).toHaveCount(1);
    await expect(tray.getByRole('heading', { name: 'Installing Uptime Kuma…', exact: true })).toBeVisible();
    await expect(page.locator('.icon-tile[data-instance="n8n"]')).toContainText('Waiting…');

    // n8n is busy now (its restart waits): Stop joins the queue without a plan, after one question
    await page.getByRole('button', { name: 'Details of n8n', exact: true }).click();
    drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('status', { name: 'Queue for n8n' })).toContainText('Restart waiting');
    await drawer.getByRole('button', { name: 'Stop n8n', exact: true }).click();
    ask = page.getByRole('dialog');
    await expect(ask.getByRole('heading', { name: 'Queue: Stop n8n', exact: true })).toBeVisible();
    await expect(ask).toContainText('n8n is waiting to restart first. Harbor will stop it as soon as that finishes, planning it then.');
    await expect(ask.getByRole('button', { name: 'Queue stop', exact: true })).toBeEnabled();
    await ask.getByRole('button', { name: 'Queue stop', exact: true }).dblclick(); // one idempotency key per dialog: queued once
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Stop n8n' })).toHaveCount(1);
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Stop n8n' })).toContainText('planned at its turn');
    // a second Stop says it is already queued (with its Cancel) instead of queueing it twice
    await page.getByRole('button', { name: 'Details of n8n', exact: true }).click();
    drawer = page.getByRole('dialog');
    // after the waiting Stop the app will be stopped: Start makes sense, Restart does not (R8)
    await expect(drawer.getByRole('button', { name: 'Start n8n', exact: true })).toBeEnabled();
    await expect(drawer.getByRole('button', { name: 'Restart n8n', exact: true })).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Stop n8n', exact: true }).click();
    ask = page.getByRole('dialog');
    await expect(ask.getByRole('heading', { name: 'Already queued: Stop n8n', exact: true })).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Cancel stop n8n', exact: true })).toBeVisible();
    await ask.getByRole('button', { name: 'Keep it', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Stop n8n' })).toHaveCount(1);

    // a second app's install, approved while the first one still downloads
    await page.getByRole('link', { name: 'App Store' }).click();
    await expect(page.getByRole('button', { name: 'Install Immich', exact: true })).toBeEnabled();
    await installFromStore(page, 'Immich');
    await approve(page, 'Install');
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Install Immich' })).toHaveCount(1);
    await expect(tray.getByRole('heading', { name: 'Queue · 1 running, 3 waiting', exact: true })).toBeVisible();
    // run order: what was queued first runs first
    await expect(waiting.getByRole('listitem')).toHaveText([/^Restart n8n/, /^Stop n8n/, /^Install Immich/]);

    // cancel the waiting Stop: it leaves the queue, the rest stays
    await tray.getByRole('button', { name: 'Cancel stop n8n', exact: true }).click();
    await expect(waiting.getByRole('listitem').filter({ hasText: 'Stop n8n' })).toHaveCount(0);
    await expect(waiting.getByRole('listitem')).toHaveText([/^Restart n8n/, /^Install Immich/]);

    // release the held download: it finishes, then the rest in order; each result stays in the tray
    releasePulls();
    await expect(tray.getByRole('heading', { name: 'Uptime Kuma is ready', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tray.getByRole('heading', { name: 'n8n restarted', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tray.getByRole('heading', { name: 'Immich is ready', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tray.getByRole('list', { name: 'Waiting' })).toHaveCount(0);
    await expect(tray.getByRole('heading', { name: /^Queue · \d+ done$/ })).toBeVisible();
    await expect(tray.getByRole('link', { name: 'Launch uptime-kuma', exact: true })).toBeVisible();
    // n8n was not stopped (its Stop was cancelled before it started)
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('.icon-tile[data-instance="n8n"]')).not.toContainText('Stopped');
    // collapse to one line, open again, then Clear finished takes every plain result at once
    await tray.getByRole('button', { name: /^Queue · / }).click();
    await expect(tray.getByRole('heading', { name: 'n8n restarted', exact: true })).toHaveCount(0);
    await tray.getByRole('button', { name: /^Queue · / }).click();
    await tray.getByRole('button', { name: 'Clear finished', exact: true }).click();
    await expect(tray.getByRole('heading', { name: 'n8n restarted', exact: true })).toHaveCount(0);
    await expect(tray.getByRole('heading', { name: 'Uptime Kuma is ready', exact: true })).toHaveCount(0);
    await dismissRecovery(page); // what showed a value once needs its own yes
    await expect(tray).toHaveCount(0);
  });
});

// Last on purpose: with the policy on, the daemon publishes apps on the tailnet in the background.
test('decision 177: every app on Tailscale — the switch asks first, lists the apps; the drawer keeps one off; off withdraws nothing', async ({ page }) => {
  await login(page);
  await installFromStore(page, 'Excalidraw'); // at least one app, whatever ran before
  await approve(page, 'Install');
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Remote access/ }).click();
  await expect(page.getByRole('heading', { name: 'Every app on Tailscale' })).toBeVisible();
  const toggle = page.getByRole('checkbox', { name: 'Give every app a Tailscale address', exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click(); // opens the review first; the box stays unticked until it is confirmed
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Every app gets an address on your tailnet: any device on your tailnet can reach it.');
  await expect(dlg).toContainText('never withdraws an address');
  await expect(dlg.getByRole('list', { name: 'Apps that get a Tailscale address' })).toContainText('excalidraw');
  await dlg.getByRole('button', { name: 'Give every app an address', exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText('Turning this off keeps every address it gave.', { exact: false })).toBeVisible();
  // the drawer's own switch: off keeps that app off the tailnet
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: /^Details of / }).first().click();
  const sw = page.getByRole('dialog').getByRole('checkbox', { name: /on Tailscale$/ });
  await expect(sw).toBeChecked();
  await sw.uncheck();
  await expect(page.getByRole('dialog')).toContainText('Kept off');
  await sw.check();
  await expect(sw).toBeChecked();
  await page.keyboard.press('Escape');
  // turning it off asks nothing and withdraws nothing
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Remote access/ }).click();
  await page.getByRole('checkbox', { name: 'Give every app a Tailscale address', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Give every app a Tailscale address', exact: true })).not.toBeChecked();
});

test('decision 184: VPN and offline apps — add a VPN, an app that asks to be offline, change it in its drawer, every app through the VPN, remove', async ({ page }) => {
  const { writeZip } = await import('../../src/packages/zip.js');
  const { PROVIDER_CONF } = await import('../fixtures/wireguard.js');
  const manifest = `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: quiet-e2e
  name: Quiet E2E
  description: An app that never needs the internet
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
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
network:
  internet: offline
`;
  await login(page);
  // Settings → VPN: a file that runs commands is refused, a provider's file connects; the key never comes back
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^VPN Send your apps/ }).click();
  const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'VPN', exact: true }) });
  await card.getByRole('button', { name: 'Add VPN…', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add a VPN' });
  await add.getByLabel('WireGuard configuration', { exact: true }).fill(PROVIDER_CONF.replace('DNS = 10.64.0.1', 'DNS = 10.64.0.1\nPostUp = iptables -F'));
  await add.getByRole('button', { name: 'Add VPN', exact: true }).click();
  await expect(add.getByRole('alert')).toContainText('PostUp is not accepted');
  await add.getByLabel('WireGuard configuration', { exact: true }).fill(PROVIDER_CONF);
  await add.getByLabel('VPN name', { exact: true }).fill('E2E VPN');
  await add.getByRole('button', { name: 'Add VPN', exact: true }).click();
  await expect(add).toBeHidden();
  await expect(card).toContainText('E2E VPN');
  await expect(card).toContainText('connected');
  await expect(card).toContainText('185.65.134.82:51820');
  await expect(card).toContainText('10.64.0.1');
  await expect(page.locator('body')).not.toContainText('FIXTURE'); // no key on the page
  // an app whose package asks to be offline: the install page and the review say so
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Add your own app' }).click();
  const up = page.getByRole('dialog', { name: 'Your own app' });
  await up.getByLabel('Package zip file').setInputFiles({ name: 'quiet-e2e.zip', mimeType: 'application/zip', buffer: writeZip({ 'manifest.yaml': manifest, 'compose.yaml': 'services:\n  web:\n    image: nginx:1.27-alpine\n' }, { folder: 'quiet-e2e' }) });
  await expect(up).toContainText('Quiet E2E is in your App Store');
  await up.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('tab', { name: 'Your apps' }).click();
  await page.locator('.tile.store').filter({ hasText: 'Quiet E2E' }).getByRole('button', { name: 'Install Quiet E2E', exact: true }).click();
  const wiz = page.getByRole('dialog');
  await expect(wiz).toContainText('Internet: Offline');
  await expect(wiz).toContainText('what Quiet E2E asks for');
  await wiz.getByRole('button', { name: 'Install Quiet E2E now' }).click();
  const review = page.getByRole('dialog', { name: 'Review install' });
  await expect(review).toContainText("Internet access: Offline (the app's default)");
  await review.getByRole('button', { name: 'Install', exact: true }).click();
  await trayDone(page, 'Install');
  await dismissRecovery(page);
  // the drawer: Internet → Change… → Through the VPN → a review that restarts nothing
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('button', { name: 'Details of quiet-e2e', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Quiet E2E' });
  await expect(drawer.getByRole('heading', { name: 'Internet', exact: true })).toBeVisible();
  await expect(drawer).toContainText("Offline · the app's default");
  await drawer.getByRole('button', { name: 'Change how Quiet E2E reaches the internet', exact: true }).click();
  const pick = page.getByRole('dialog', { name: 'Internet for Quiet E2E' });
  await expect(pick.getByRole('button', { name: 'Review', exact: true })).toBeDisabled();
  await pick.getByRole('radio', { name: /^Through the VPN/ }).check();
  await pick.getByRole('button', { name: 'Review', exact: true }).click();
  const plan = page.getByRole('dialog', { name: 'Review internet access' });
  await expect(plan).toContainText('Internet access: Offline → Through the VPN (your choice). quiet-e2e restarts so its lookups follow too');
  await plan.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('heading', { name: /settings applied$/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Details of quiet-e2e', exact: true }).click();
  await expect(drawer).toContainText('Through the VPN · your choice', { timeout: 15_000 });
  await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
  // every app through the VPN asks first; the Apps card lists who goes through it
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^VPN Send your apps/ }).click();
  const apps = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Apps', exact: true }) });
  await expect(apps).toContainText('Through the VPN: quiet-e2e');
  const all = apps.getByLabel('Send every app through the VPN', { exact: true });
  await all.click(); // asks first: the box only ticks once the rules are loaded
  const ask = page.getByRole('dialog', { name: 'Send every app through the VPN?' });
  await ask.getByRole('button', { name: 'Send every app through it', exact: true }).click();
  await expect(all).toBeChecked();
  await all.click();
  await expect(all).not.toBeChecked();
  // remove: the dialog names the app that loses its internet
  await card.getByRole('button', { name: 'Remove…', exact: true }).click();
  const rm = page.getByRole('dialog', { name: 'Remove the VPN?' });
  await expect(rm).toContainText('quiet-e2e goes through the VPN and will have no internet');
  await rm.getByRole('button', { name: 'Remove VPN', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Add VPN…', exact: true })).toBeVisible();
});

// After decision 177's test (which turns the policy off again): the bulk list works on whatever apps exist.
test('decision 186: Apps on Tailscale — select all, review, apply; select none withdraws; Also on Tailscale at install', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Remote access/ }).click();
  await expect(page.getByRole('heading', { name: 'Apps on Tailscale', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'Apps on Tailscale', exact: true });
  const boxes = list.getByRole('checkbox');
  const links = () => list.getByRole('link').count();
  const before = await links();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await expect(boxes.nth(i)).toBeChecked();
  await page.getByRole('button', { name: /^Review \d+ changes?$/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Change Tailscale addresses?' });
  const getting = dlg.getByRole('list', { name: 'Apps that get a Tailscale address' });
  // the addresses are shown, as text: nothing answers there before Apply
  await expect(getting).toContainText('https://harbor-test.tail1234.ts.net:');
  await expect(dlg.getByRole('link')).toHaveCount(0);
  const k = await getting.getByRole('listitem').count();
  await dlg.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect.poll(links, { timeout: 90_000 }).toBe(before + k);
  await expect(page.getByRole('button', { name: 'No changes', exact: true })).toBeVisible();
  await clearTray(page); // the finished items sit over the page's lower right corner
  // select none: every address is withdrawn
  await page.getByRole('button', { name: 'Select none', exact: true }).click();
  await page.getByRole('button', { name: /^Review \d+ changes?$/ }).click();
  await expect(dlg.getByRole('list', { name: 'Apps that lose their Tailscale address' }).getByRole('listitem')).toHaveCount(before + k);
  await dlg.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect.poll(links, { timeout: 90_000 }).toBe(0);
  await clearTray(page);
  // Also on Tailscale at install: unticked while the policy is off; ticked, the review says so and the app gets one
  await page.getByRole('link', { name: 'App Store' }).click();
  await page.getByRole('button', { name: 'Install Excalidraw', exact: true }).or(page.getByRole('button', { name: 'Add another copy of Excalidraw', exact: true })).click();
  const wiz = page.getByRole('dialog');
  const also = wiz.getByRole('checkbox', { name: 'Also on Tailscale', exact: true });
  await expect(also).not.toBeChecked();
  await also.check();
  await wiz.getByRole('button', { name: 'Install Excalidraw now' }).click();
  await expect(page.getByRole('dialog')).toContainText('It also gets an address on your tailnet once it runs.');
  await approve(page, 'Install');
  await expect(page.locator('aside.tray').getByRole('heading', { name: /^Excalidraw \(excalidraw-\d+\) is ready$/ }).first()).toBeVisible({ timeout: 30_000 });
  await dismissRecovery(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Remote access/ }).click();
  await expect.poll(links, { timeout: 60_000 }).toBe(1);
});
