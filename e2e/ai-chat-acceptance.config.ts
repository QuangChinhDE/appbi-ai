import { defineConfig, devices } from '@playwright/test';

/**
 * AppBI Analyst (M2 MVP) acceptance — real frontend, real backend, real
 * Governed Query Service and ledger, and the REAL configured model.
 *
 * Not part of CI on purpose: it spends model calls and needs a seeded Analyst
 * rig (users rig-owner/rig-analyst/rig-viewer/rig-revoked/rig-nomodule and the
 * "Rig Sales" + "Rig Slow Archive" datasets). Run explicitly:
 *
 *   E2E_BASE_URL=… ANALYST_RIG_PASSWORD=… ANALYST_RIG_DOMAIN=… \
 *     npx playwright test -c ai-chat-acceptance.config.ts
 *
 * Screenshots go to ../.artifacts/ai-chat-acceptance (gitignored local evidence).
 * A missing rig FAILS; it never passes by skipping.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /ai-chat-journey\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../.artifacts/ai-chat-acceptance/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3231',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@responsive/ },
  ],
});
