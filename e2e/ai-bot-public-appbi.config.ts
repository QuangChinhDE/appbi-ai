import { defineConfig, devices } from '@playwright/test';

/**
 * The public Dashboard AI Bot (Answer Core) on the REAL AppBI stack (Compose project
 * appbi-ai, http://localhost:3000), BigQuery DA6 through the governed public chart
 * path; real model under the cumulative test cap and the link's own USD ceiling.
 * Explicit run only. Zero retries; video, trace and screenshots for every test.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /ai-bot-public-appbi\.spec\.ts/,
  timeout: 600_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/ai-bot-public-appbi/report', open: 'never' }],
             ['json', { outputFile: '../.artifacts/ai-bot-public-appbi/results.json' }]],
  outputDir: '../.artifacts/ai-bot-public-appbi/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-appbi-test-purpose': 'public-bot-live', 'x-appbi-test-rc': process.env.RC_SHA || '' },
  },
});
