import { defineConfig, devices } from '@playwright/test';

/**
 * Unified AI Chat acceptance on the REAL AppBI stack (Compose project appbi-ai,
 * http://localhost:3000) - existing BI on the same stack: Explore/saved chart, dashboard, public link + revoke, BigQuery runtime.
 * Explicit run only. Zero retries; video, trace and screenshots for every test.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /ai-chat-appbi-bi\.spec\.ts/,
  timeout: 420_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../.artifacts/ai-chat-appbi-bi/report', open: 'never' }],
             ['json', { outputFile: '../.artifacts/ai-chat-appbi-bi/results.json' }]],
  outputDir: '../.artifacts/ai-chat-appbi-bi/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    // a real API key is pasted in these journeys (QA_OPENAI_KEY_FILE): no trace, which would keep it
    trace: process.env.QA_OPENAI_KEY_FILE ? 'off' : 'on',
    video: 'on',
    screenshot: 'on',
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'x-appbi-test-purpose': 'unified-chat-bi', 'x-appbi-test-rc': process.env.RC_SHA || '' },
  },
});
