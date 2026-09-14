import { expect, test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Sign in once; every other spec reuses the session.
 *
 * The login endpoint is rate-limited to 5 requests a minute. A suite that logs in
 * per test trips that limit and then reports a product failure that is entirely
 * its own — which is how a green build starts being ignored.
 */
const AUTH_FILE = path.join(__dirname, '..', '.auth', 'admin.json');

const EMAIL = process.env.E2E_EMAIL || 'admin@appbi.io';
const PASSWORD = process.env.E2E_PASSWORD || '123456';

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/login');

  // By label/placeholder rather than by CSS class: a class is a styling decision
  // and renaming one should not break the suite that guards behaviour.
  const email = page.locator('input[type="email"], input[name="email"]').first();
  const password = page.locator('input[type="password"]').first();
  await email.fill(EMAIL);
  await password.fill(PASSWORD);
  await password.press('Enter');

  // Landing anywhere that is not /login is the signal; the app chooses the
  // destination by permission, and pinning one would break for a narrow account.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  await expect(page.locator('body')).toBeVisible();

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
