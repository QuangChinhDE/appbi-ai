import { defineConfig, devices } from '@playwright/test';

/**
 * Report Studio V3 acceptance — the eight scenarios, driven like an end user on a
 * production build, against the REAL planner and vision model.
 *
 * Not part of the CI suite on purpose: it spends model calls and writes evidence
 * (full-page screenshots, exported PDFs, a results file) into
 * docs/features/report-studio-v3/evidence for a reviewer. It is run explicitly:
 *
 *   E2E_BASE_URL=… E2E_API_URL=… npx playwright test -c acceptance.config.ts
 *
 * The deterministic regressions of the same behaviours run in CI
 * (tests/report-studio.spec.ts); this suite is the runtime acceptance with the
 * model in the loop. A scenario whose model is unavailable records NOT VERIFIED —
 * it never fakes evidence.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const API_URL = process.env.E2E_API_URL || 'http://localhost:8000';

export default defineConfig({
  testDir: './acceptance',
  timeout: 360_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'acceptance-report' }]],
  outputDir: 'acceptance-results',
  use: {
    baseURL: BASE_URL,
    trace: 'on',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    extraHTTPHeaders: { 'x-e2e': '1' },
  },
  projects: [
    { name: 'setup', testDir: './tests', testMatch: /auth\.setup\.ts/ },
    {
      name: 'acceptance',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: '.auth/admin.json' },
      dependencies: ['setup'],
    },
  ],
  metadata: { api: API_URL },
});
