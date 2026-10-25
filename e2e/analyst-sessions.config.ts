import { defineConfig, devices } from '@playwright/test';

/**
 * AI Analyst sessions + sharing + AI workspace navigation - real browser acceptance on the
 * isolated QA stack (Deterministic Replay Mode). Explicit run only, like
 * analyst-browser.config.ts: it needs the seeded QA stack and the SQL oracle. A missing
 * stack FAILS, it never skips. Zero retries; video and trace for every test.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /analyst-sessions\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/analyst-sessions/report', open: 'never' }],
             ['json', { outputFile: '../.artifacts/analyst-sessions/results.json' }]],
  outputDir: '../.artifacts/analyst-sessions/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3351',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
