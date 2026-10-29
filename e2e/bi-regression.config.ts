import { defineConfig, devices } from '@playwright/test';

/**
 * Existing BI regression (datasources, datasets, dashboard, public link, revoke) on the
 * isolated QA stack. Explicit run only, like analyst-browser.config.ts: it needs the seeded
 * stack and ORACLE_FILE. E2E_BASE_URL / E2E_API_URL point at the stack's frontend/backend.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /bi-regression\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/bi-regression/report', open: 'never' }]],
  outputDir: '../.artifacts/bi-regression/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3341',
    trace: 'on', video: 'on', screenshot: 'on',
    actionTimeout: 20_000, navigationTimeout: 90_000,
    ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 },
  },
});
