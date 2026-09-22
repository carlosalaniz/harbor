import { expect, test } from '@playwright/test';

// A daemon with no administrator: the console shows the first-run wizard instead of the login form.
test('first-run wizard: name the machine, create the account with the setup code, pick a look, land in the console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome. This is your own cloud.' })).toBeVisible();
  await expect(page).toHaveTitle('Set up Harbor');
  await page.getByLabel('Device name').fill('Attic box');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('carlos');
  await page.getByLabel('Password', { exact: true }).fill('first-run-FIXTURE-password');
  await page.getByLabel('Password again').fill('first-run-FIXTURE-password');
  await page.getByLabel('Setup code').fill('000000');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('wrong setup code');
  await page.getByLabel('Setup code').fill('424 242');
  await page.getByRole('button', { name: 'Create account' }).click();
  // The Harbor recovery key: 12 words, shown exactly once, gated on "I wrote it down".
  await expect(page.getByRole('heading', { name: 'Your recovery key' })).toBeVisible();
  const card = page.getByRole('alert');
  await expect(card).toContainText('Your Harbor recovery key.');
  await expect(card).toContainText('opens every app this Harbor encrypts');
  await expect(card.locator('code')).toHaveText(/^(\S+ ){11}\S+$/);
  const done = page.getByRole('button', { name: 'Dismiss recovery key' });
  await expect(done).toBeDisabled();
  await page.getByLabel('I wrote down the recovery key').check();
  await done.click();
  await expect(page.getByRole('heading', { name: 'Make it yours' })).toBeVisible();
  await page.getByRole('option', { name: 'Wallpaper dusk' }).click();
  await page.getByRole('button', { name: 'Open Harbor' }).click();
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
  await expect(page).toHaveTitle('Attic box · Harbor');
  // the door is closed: a reload shows the normal login, and the setup route says so
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  const st = await page.request.get('/v1/setup');
  expect((await st.json()).needed).toBe(false);
  await page.getByLabel('Username', { exact: true }).fill('carlos');
  await page.getByLabel('Password', { exact: true }).fill('first-run-FIXTURE-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
  // …and it is never shown again: Settings says only when it was issued.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Account/ }).click();
  const rec = page.locator('section', { has: page.getByRole('heading', { name: 'Recovery key' }) });
  await expect(rec).toContainText('Issued');
  await expect(rec.locator('code')).toHaveCount(0);
  await expect(rec.getByRole('button', { name: 'Replace the recovery key' })).toBeVisible();
});
