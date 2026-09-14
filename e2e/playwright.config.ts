import { defineConfig, devices } from '@playwright/test';

/**
 * Full-stack, not browser-smoke.
 *
 * The browser, Next.js, the API, the database and the Agent Flow runtime are all
 * real. Nothing is route-mocked: a suite that intercepts the API and asserts on
 * its own fixtures proves the frontend can render a fixture, which is not the
 * question. The only thing these tests avoid is spending money on a model, and
 * they do it by exercising flows whose steps are deterministic — `report_read`,
 * `tool`, `set_var`, `if` — rather than by faking the backend.
 *
 * WHERE IT POINTS. `E2E_BASE_URL` / `E2E_API_URL` default to the local stack the
 * repository already runs (`docker compose`: frontend 3000, backend 8000). CI
 * overrides them.
 *
 * WHY `storageState`. The login endpoint is rate-limited to 5/minute; a suite that
 * logs in per test trips it and reports a product failure that is its own. The
 * setup project signs in once and every test reuses the session.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const API_URL = process.env.E2E_API_URL || 'http://localhost:8000';

export default defineConfig({
  testDir: './tests',
  // A flow run walks the warehouse; 60s is generous for a click and mean for a hang.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Serial by default: these share one database, and two tests renaming the same
  // flow is a flake nobody can reproduce.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['blob']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    // ARTEFACTS ON FAILURE ONLY. A reviewer has to be able to see what broke
    // without re-running it locally; keeping them for green runs just fills a disk.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    extraHTTPHeaders: { 'x-e2e': '1' },
  },

  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/admin.json',
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // The second desktop size the QA gate asks for. Layout only — the
      // functional specs do not need to run twice.
      name: 'chromium-1920',
      dependencies: ['setup'],
      testMatch: /layout\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/admin.json',
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],

  metadata: { apiUrl: API_URL },
});
