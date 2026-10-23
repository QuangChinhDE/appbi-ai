import { defineConfig, devices } from '@playwright/test';

/**
 * AppBI Analyst V1 - real browser product acceptance (Deterministic Replay Mode) on the
 * isolated QA stack. Explicit run only (not general CI): it needs the seeded QA stack,
 * its replay fixtures and the SQL oracle file. Zero retries; video and trace for every
 * test; an HTML report for reviewers. A missing stack FAILS, it never skips.
 *
 *   E2E_BASE_URL=http://localhost:3341 DOGFOOD_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   ORACLE_FILE=.../oracle.json npx playwright test -c analyst-browser.config.ts
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /analyst-browser-acceptance\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/analyst-browser/report', open: 'never' }],
             ['json', { outputFile: '../.artifacts/analyst-browser/results.json' }]],
  outputDir: '../.artifacts/analyst-browser/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3341',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
