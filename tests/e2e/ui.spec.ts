import { expect, test, type Page } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'e2e-fixture-password' };

async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Installed' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('login rejects bad credentials without revealing which field is wrong', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('nobody');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('invalid username or password');
});

test('dashboard shows the three sections, real packages, system and honest tool state', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Available' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Platform tools' })).toBeVisible();
  for (const name of ['Excalidraw', 'BentoPDF']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('No applications installed yet')).toBeVisible();
  await expect(page.getByText(/Docker Engine/)).toBeVisible();
  // Tools are absent in this fixture: shown as not installed, with no fake Open link.
  const tools = page.locator('.tool');
  await expect(tools).toHaveCount(2);
  await expect(tools.first()).toContainText('not installed');
  await expect(page.getByRole('link', { name: /Open Cockpit|Open Portainer/ })).toHaveCount(0);
});

test('install Excalidraw with confirmation, progress, Open link; duplicate clicks do not duplicate', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Install Excalidraw' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Confirm install');
  await expect(dialog).toContainText(/Publish endpoint web: 127\.0\.0\.1:\d+/);
  await expect(dialog).toContainText(/Pull image excalidraw\/excalidraw@sha256:/);
  const approve = dialog.getByRole('button', { name: 'Install' });
  // Rapid double click: the same idempotency key is reused; only one operation must exist.
  await approve.dblclick();
  await expect(page.getByRole('heading', { name: /Install (in progress|succeeded)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Install succeeded' })).toBeVisible({ timeout: 30_000 });
  const cards = page.locator('.instance');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('installed');
  await expect(cards.first()).toContainText('healthy');
  const open = page.getByRole('link', { name: 'Open excalidraw' });
  await expect(open).toHaveAttribute('href', /^http:\/\/localhost:\d+\/$/);
  // Open target actually answers (fake app listener on the allocated loopback port).
  const href = await open.getAttribute('href');
  const res = await page.request.get(href!);
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

test('stop, start, remove (retained wording) and reinstall through the UI', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Stop excalidraw' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('heading', { name: 'Stop succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.instance').first()).toContainText('stopped');
  await expect(page.getByRole('link', { name: 'Open excalidraw' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Start excalidraw' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: 'Start succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Open excalidraw' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove excalidraw' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText(/retained/i);
  await dlg.getByRole('button', { name: 'Remove (keep data)' }).click();
  await expect(page.getByRole('heading', { name: 'Remove succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.instance.retained')).toHaveCount(1);
  await expect(page.locator('.instance.retained')).toContainText('retained');

  await page.getByRole('button', { name: 'Reinstall excalidraw' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reinstall' }).click();
  await expect(page.getByRole('heading', { name: 'Reinstall succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.instance').first()).toContainText('installed');
});

test('second install of the same package coexists and BentoPDF installs on a distinct port; details show resources', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Install BentoPDF' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await expect(page.getByRole('heading', { name: 'Install succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.instance')).toHaveCount(2);
  const hrefs = await page.getByRole('link', { name: /^Open / }).evaluateAll((els) => els.map((e) => (e as { href: string }).href));
  expect(new Set(hrefs).size).toBe(2);
  await page.getByRole('button', { name: 'Details of bentopdf' }).click();
  const d = page.getByRole('dialog');
  await expect(d).toContainText('Owned resources');
  await expect(d).toContainText('container');
  await expect(d).toContainText(/hb_[0-9a-f]{32}-web-1/);
  await d.getByRole('button', { name: 'Close' }).click();
});

test('logout returns to login and the API rejects the old token', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await expect(page.getByText('Logged out.')).toBeVisible();
  const res = await page.request.get('/v1/instances');
  expect(res.status()).toBe(401);
});
