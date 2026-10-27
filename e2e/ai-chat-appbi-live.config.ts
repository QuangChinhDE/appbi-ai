import { defineConfig, devices } from '@playwright/test';

/**
 * Unified AI Chat acceptance on the REAL AppBI stack (Compose project appbi-ai,
 * http://localhost:3000) - real model under the cumulative $5 test cap: a small controlled set; every call is labelled in the shared ledger.
 * Explicit run only. Zero retries; video, trace and screenshots for every test.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /ai-chat-appbi-live\.spec\.ts/,
  timeout: 420_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/ai-chat-appbi-live/report', open: 'never' }],
             ['json', { outputFile: '../.artifacts/ai-chat-appbi-live/results.json' }]],
  outputDir: '../.artifacts/ai-chat-appbi-live/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-appbi-test-purpose': 'unified-chat-live', 'x-appbi-test-rc': process.env.RC_SHA || '' },
  },
});
