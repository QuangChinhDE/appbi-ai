import { defineConfig, devices } from '@playwright/test';

/**
 * AppBI Analyst engineering dogfood, Deterministic Replay Mode: the isolated
 * dogfood stack (docker-compose.dogfood.yml) with recorded planner outputs - no
 * paid model calls. Not CI: it needs the seeded stack. Run explicitly:
 *
 *   E2E_BASE_URL=http://localhost:3341 DOGFOOD_PASSWORD=...  *     npx playwright test -c analyst-dogfood.config.ts
 *
 * A missing stack FAILS; it never passes by skipping.
 */
export default defineConfig({
  testDir: './acceptance',
  testMatch: /analyst-dogfood\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../.artifacts/analyst-dogfood/results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3341',
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
