import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// UI tests run against the real daemon + real built UI with the FAKE Docker adapter in a private
// temporary state directory. This proves the UI/API contract, not real app behaviour: live app
// demos are collected separately by the VM suite (docs/VERIFICATION.md).
const PORT = Number(process.env['HARBOR_E2E_PORT'] ?? 18500);
const SETUP_PORT = PORT + 200; // a second daemon with no administrator, for the first-run wizard
const root = process.env['HARBOR_E2E_ROOT'] ?? mkdtempSync(path.join(tmpdir(), 'harbor-e2e-'));
const setupRoot = mkdtempSync(path.join(tmpdir(), 'harbor-e2e-setup-'));

export default defineConfig({
  testDir: path.resolve(import.meta.dirname),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.resolve(import.meta.dirname, '../../playwright-report') }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm tsx src/dev.ts',
      cwd: path.resolve(import.meta.dirname, '../..'),
      url: `http://localhost:${PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        HARBOR_DEV_ROOT: root,
        HARBOR_DEV_PORT: String(PORT),
        HARBOR_DEV_PORT_FROM: String(PORT + 80),
        HARBOR_DEV_PORT_TO: String(PORT + 99),
        HARBOR_DEV_PASSWORD: 'e2e-fixture-password',
        HARBOR_DEV_LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'pnpm tsx src/dev.ts',
      cwd: path.resolve(import.meta.dirname, '../..'),
      url: `http://localhost:${SETUP_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        HARBOR_DEV_ROOT: setupRoot,
        HARBOR_DEV_PORT: String(SETUP_PORT),
        HARBOR_DEV_PORT_FROM: String(SETUP_PORT + 80),
        HARBOR_DEV_PORT_TO: String(SETUP_PORT + 99),
        HARBOR_DEV_SETUP: '1',
        HARBOR_DEV_SETUP_CODE: '424242',
        HARBOR_DEV_LOG_LEVEL: 'warn',
      },
    },
  ],
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testMatch: /ui\.spec\.ts/ },
    { name: 'setup', use: { browserName: 'chromium', baseURL: `http://localhost:${SETUP_PORT}` }, testMatch: /setup\.spec\.ts/ },
  ],
});
