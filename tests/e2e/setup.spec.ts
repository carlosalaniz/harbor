import { expect, test } from '@playwright/test';

// A daemon with no administrator: the console shows the first-run wizard instead of the login form.
test('first-run wizard: name the machine, create the account with the setup code, pick a look, land in the console', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome. This is your own cloud.' })).toBeVisible();
  await expect(page).toHaveTitle('Set up Harbor');
  await page.getByLabel('Device name').fill('Attic box');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Username').fill('carlos');
  await page.getByLabel('Password', { exact: true }).fill('first-run-FIXTURE-password');
  await page.getByLabel('Password again').fill('first-run-FIXTURE-password');
  await page.getByLabel('Setup code').fill('000000');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('wrong setup code');
  await page.getByLabel('Setup code').fill('424 242');
  await page.getByRole('button', { name: 'Create account' }).click();
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
  await page.getByLabel('Username').fill('carlos');
  await page.getByLabel('Password').fill('first-run-FIXTURE-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Your apps' })).toBeVisible();
});
