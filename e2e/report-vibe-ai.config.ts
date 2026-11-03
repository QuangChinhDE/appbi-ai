import { defineConfig, devices } from '@playwright/test';

/**
 * AI Vibe Report — the journey that needs the deployment's REAL Studio model (a scoped
 * AI edit). Local stack only, explicit run; CI has no Studio model. Zero retries.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /report-vibe-ai-edit\.spec\.ts/,
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../.artifacts/report-vibe-ai/results.json' }]],
  outputDir: '../.artifacts/report-vibe-ai/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    storageState: '.auth/admin.json',
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
});
