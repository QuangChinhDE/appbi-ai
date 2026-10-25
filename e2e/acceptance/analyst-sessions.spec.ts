import { expect, request, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

/**
 * AI Analyst as an official module - REAL BROWSER ACCEPTANCE of sessions, sharing and the
 * AI workspace navigation (Deterministic Replay Mode, isolated QA stack).
 *
 * Every step under test is done the way a person does it: typing, clicking the share
 * dialog, reloading, following a link. `adminApi()` is used ONLY for preconditions
 * (module levels, a Dataset grant, a team) and is labelled as such.
 *
 * The security contract proved in the browser: a shared analysis NEVER shows numbers
 * from a Dataset the viewer cannot read - the question is shown, the answer is
 * redacted, and no response carries rows - until the Dataset itself is granted.
 * Numbers are compared with the independent SQL oracle (ORACLE_FILE).
 *
 *   E2E_BASE_URL=http://localhost:3351 E2E_API_URL=http://localhost:8351 DOGFOOD_PASSWORD=... \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... ORACLE_FILE=.../oracle.json \
 *   npx playwright test -c analyst-sessions.config.ts
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ADMIN = { email: process.env.ADMIN_EMAIL || '', password: process.env.ADMIN_PASSWORD || '' };
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
const DOMAIN = 'rig.appbi.io';
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3351';
const OUTCOME = '[data-testid="analyst-answer"], [data-testid="analyst-clarify"], [data-testid="analyst-unsupported"], [data-testid="analyst-refused"], [data-testid="analyst-error"]';
const Q1 = 'Doanh số Miền Bắc theo kênh bán năm 2025';
const Q2 = 'theo ngành hàng thì sao';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!PASSWORD || !ADMIN.email) throw new Error('DOGFOOD_PASSWORD / ADMIN_* not set: the QA stack is required; a skip is not a pass');
});

// ── helpers ────────────────────────────────────────────────────────────────────

async function login(page: Page, who: string) {
  await page.context().clearCookies();
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/login');
    await page.locator('input[type="email"]').first().fill(`${who}@${DOMAIN}`);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
    await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
    const status = (await answer).status();
    if (status === 429 && attempt < 3) { await page.waitForTimeout(65_000); continue; }
    expect(status, 'UI login').toBe(200);
    break;
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

/** PRECONDITIONS ONLY: its own request context, never the page's cookies. */
async function adminApi() {
  const ctx = await request.newContext({ baseURL: BASE });
  let r = await ctx.post('/api/v1/auth/login', { data: ADMIN });
  if (r.status() === 429) { await new Promise((ok) => setTimeout(ok, 65_000)); r = await ctx.post('/api/v1/auth/login', { data: ADMIN }); }
  const headers = { Authorization: `Bearer ${(await r.json()).access_token}` };
  const ds = (await (await ctx.get('/api/v1/datasets/', { headers })).json())
    .find((d: { name: string }) => d.name === 'Dogfood Commerce').id as number;
  const users = (await (await ctx.get('/api/v1/permissions/matrix', { headers })).json()).users;
  const userId = (who: string) => users.find((u: { email: string }) => u.email === `${who}@${DOMAIN}`).user_id as string;
  return {
    ctx, headers, ds, userId,
    level: (who: string, analyst: string, extra: Record<string, string> = {}) =>
      ctx.put(`/api/v1/permissions/${userId(who)}`, { headers, data: { permissions: { analyst, ...extra } } }),
    revoke: (who: string) => ctx.delete(`/api/v1/datasets/${ds}/grants?user_id=${userId(who)}`, { headers }),
    grant: (who: string, verb: string) => ctx.post(`/api/v1/datasets/${ds}/grants`, { headers, data: { verb, user_id: userId(who) } }),
  };
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function ask(page: Page, q: string): Promise<Locator> {
  const before = await page.getByTestId('analyst-exchange').count();
  await page.getByTestId('analyst-question').fill(q);
  await page.getByTestId('analyst-ask').click();
  const ex = page.getByTestId('analyst-exchange').nth(before);
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  return ex;
}

async function tableOf(scope: Locator): Promise<Record<string, number>> {
  const rows = await scope.getByTestId('analyst-table').locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const out: Record<string, number> = {};
  for (const cells of rows) out[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
  return out;
}

function expectOracle(got: Record<string, number>, key: string) {
  const want = ORACLE[key];
  expect(Object.keys(got).sort(), `groups of ${key}`).toEqual(Object.keys(want).sort());
  for (const [k, v] of Object.entries(want)) expect(Math.abs(got[k] - v), `${key} / ${k}: ${got[k]} vs SQL ${v}`).toBeLessThan(0.51);
}

/** Every response the page receives, so "no numbers reached the browser" is checked on the wire. */
function recordResponses(page: Page) {
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (!r.url().includes('/api/v1/analyst/')) return;
    try { bodies.push(await r.text()); } catch { /* streamed / aborted */ }
  });
  return bodies;
}

/** The share dialog. AppBI's Modal carries no dialog role, so it is found by its own content. */
function shareDialog(page: Page) {
  return page.locator('div.space-y-5').filter({ has: page.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i) });
}

async function shareWith(page: Page, who: string, permission: 'view' | 'edit') {
  await page.getByTestId('analyst-session-share').click();
  const dialog = shareDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i).fill(`${who}@${DOMAIN}`);
  await dialog.getByRole('button', { name: new RegExp(`${who}@${DOMAIN}`) }).click();
  await dialog.locator('select').first().selectOption(permission);
  const saved = page.waitForResponse((r) => r.url().includes('/shares/analyst_session/') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(share|chia sẻ)$/i }).first().click();
  expect((await saved).status()).toBe(201);
  return dialog;
}

let sessionUrl = '';

// ── preconditions ──────────────────────────────────────────────────────────────
test.beforeAll(async () => {
  const a = await adminApi();
  // owner may share (analyst: edit) and also holds AI Chat, so both AI modes are offered to them
  expect((await a.level('qa-analyst', 'edit', { chat: 'view' })).status(), 'precondition: owner levels').toBe(200);
  expect((await a.level('qa-viewer', 'view')).status()).toBe(200);
  await a.grant('qa-analyst', 'build');
  await a.revoke('qa-viewer');                      // the recipient holds NO grant on the Dataset
  await a.ctx.dispose();
});

// ── S1: navigation - one AI area, two modes ───────────────────────────────────
test('S1 · the sidebar groups AI Assistant and Data Analysis; the mode switch explains and links them', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/analyst');
  await expect(page.getByTestId('analyst-page')).toBeVisible();
  const nav = page.locator('aside, nav').filter({ has: page.locator('a[href="/analyst"]') }).first();
  await expect(nav.locator('a[href="/chat"]')).toBeVisible();
  await expect(page.getByTestId('ai-mode-analyst')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('ai-mode-chat')).toBeVisible();
  await shot(page, info, 'S1-ai-workspace');
  await page.getByTestId('ai-mode-chat').click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.locator('body')).not.toContainText(/Something went wrong|Đã xảy ra lỗi/);
});

// ── S2: a session survives a reload and keeps its follow-up context ───────────
test('S2 · first question opens a session URL; reload restores the answer; the follow-up after reload is the server\'s', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/analyst');
  const ex = await ask(page, Q1);
  expectOracle(await tableOf(ex), 'north_channel_2025');
  await expect(page).toHaveURL(/\/analyst\/s\/\d+$/);
  sessionUrl = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByTestId('analyst-session-title')).toHaveText(Q1);
  const restored = page.getByTestId('analyst-exchange').first();
  expectOracle(await tableOf(restored), 'north_channel_2025');
  await expect(restored.getByTestId('analyst-asked-at')).toBeVisible();
  // nothing in the browser carries the previous plan any more: the server reads it from the session
  const sent: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/ask')) sent.push(r.postData() || ''); });
  const follow = await ask(page, Q2);
  expectOracle(await tableOf(follow), 'north_category_2025');
  expect(sent.every((b) => !b.includes('previous_plan')), 'no client-side previous plan').toBe(true);
  await expect(page.locator(`[data-testid="analyst-session-item"][href="${sessionUrl}"]`)).toContainText(Q1);
  await shot(page, info, 'S2-session-restored');
});

test('S3 · rename persists', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  await page.getByTestId('analyst-session-rename').click();
  await page.getByTestId('analyst-session-title-input').fill('Miền Bắc 2025');
  await page.getByRole('button', { name: /^(save|lưu)$/i }).click();
  await expect(page.getByTestId('analyst-session-title')).toHaveText('Miền Bắc 2025');
  await page.reload();
  await expect(page.getByTestId('analyst-session-title')).toHaveText('Miền Bắc 2025');
});

// ── S4: sharing never shares the data ─────────────────────────────────────────
test('S4 · shared at view with someone WITHOUT the Dataset: questions only, numbers redacted on the wire, no composer', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  const dialog = await shareWith(page, 'qa-viewer', 'view');
  await expect(dialog).toContainText(/never shares its data|không chia sẻ dữ liệu/i);
  await shot(page, info, 'S4-share-dialog');
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  const bodies = recordResponses(page);
  await page.goto(sessionUrl);
  await expect(page.getByTestId('analyst-read-only')).toBeVisible();
  await expect(page.getByTestId('analyst-session-access')).toBeVisible();
  await expect(page.getByTestId('analyst-redacted')).toHaveCount(2);
  await expect(page.getByTestId('analyst-table')).toHaveCount(0);
  await expect(page.getByTestId('analyst-question')).toHaveCount(0);
  await expect(page.getByTestId('analyst-session-share')).toHaveCount(0);
  const wire = bodies.join('\n');
  for (const v of Object.values(ORACLE.north_channel_2025)) expect(wire.includes(String(Math.round(v))), `oracle value ${v} on the wire`).toBe(false);
  expect(wire).not.toContain('"rows"');
  await shot(page, info, 'S4-recipient-redacted');
});

test('S5 · the same recipient, once the Dataset itself is granted, sees the numbers - and loses them on revoke', async ({ page }) => {
  const a = await adminApi();
  await a.grant('qa-viewer', 'explore');                      // precondition: the Dataset's own grant
  await login(page, 'qa-viewer');
  await page.goto(sessionUrl);
  expectOracle(await tableOf(page.getByTestId('analyst-exchange').first()), 'north_channel_2025');
  await a.revoke('qa-viewer');                                // precondition: revoked while the page is open
  await page.reload();
  await expect(page.getByTestId('analyst-redacted')).toHaveCount(2);
  await a.ctx.dispose();
});

test('S6 · edit share: the recipient may ask, as themselves (no Dataset -> no numbers)', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  await page.getByTestId('analyst-session-share').click();
  const dialog = shareDialog(page);
  const row = dialog.locator('li').filter({ hasText: `qa-viewer@${DOMAIN}` });
  const updated = page.waitForResponse((r) => r.url().includes('/shares/analyst_session/') && r.request().method() === 'PUT');
  await row.locator('select').selectOption('edit');
  expect((await updated).ok()).toBe(true);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(sessionUrl);
  await expect(page.getByTestId('analyst-read-only')).toHaveCount(0);
  const ex = await ask(page, Q1);
  await expect(ex.getByTestId('analyst-table')).toHaveCount(0);   // their own rights: no explore grant
  await shot(page, info, 'S6-edit-recipient');
});

test('S7 · revoking the share in the dialog removes access on the next load; the link shows "not available"', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  await page.getByTestId('analyst-session-share').click();
  const dialog = shareDialog(page);
  const removed = page.waitForResponse((r) => r.url().includes('/shares/analyst_session/') && r.request().method() === 'DELETE');
  await dialog.locator('li').filter({ hasText: `qa-viewer@${DOMAIN}` }).getByRole('button', { name: /remove access|gỡ quyền/i }).click();
  expect((await removed).status()).toBe(204);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(sessionUrl);
  await expect(page.getByText(/analysis not available|không mở được phiên phân tích/i)).toBeVisible();
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);
  await shot(page, info, 'S7-revoked');
});

test('S8 · team share reads; leaving the team removes it', async ({ page }) => {
  const a = await adminApi();
  const team = await (await a.ctx.post('/api/v1/permissions/teams', {
    headers: a.headers, data: { name: `QA analyst team ${Date.now()}`, member_ids: [a.userId('qa-viewer'), a.userId('qa-analyst')] },
  })).json();                                                           // precondition: a configured team
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  await page.getByTestId('analyst-session-share').click();
  const dialog = shareDialog(page);
  const teamSelect = dialog.locator('select').nth(1);
  await teamSelect.selectOption(String(await teamSelect.locator('option', { hasText: team.name }).getAttribute('value')));
  const saved = page.waitForResponse((r) => r.url().includes('/shares/analyst_session/') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(share|chia sẻ)$/i }).nth(1).click();
  expect((await saved).status()).toBe(201);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(sessionUrl);
  await expect(page.getByTestId('analyst-session-title')).toBeVisible();
  await a.ctx.patch(`/api/v1/permissions/teams/${team.id}`, { headers: a.headers, data: { member_ids: [a.userId('qa-analyst')] } });
  await page.reload();
  await expect(page.getByText(/analysis not available|không mở được phiên phân tích/i)).toBeVisible();
  await a.ctx.delete(`/api/v1/permissions/teams/${team.id}`, { headers: a.headers });
  await a.ctx.dispose();
});

test('S9 · no module: the deep link shows no-access, never a transcript', async ({ page }) => {
  await login(page, 'qa-nomodule');
  const bodies = recordResponses(page);
  await page.goto(sessionUrl);
  await expect(page.getByTestId('analyst-exchange')).toHaveCount(0);
  expect(bodies.join('')).not.toContain(Q1);
});

test('S10 · responsive: no horizontal scroll and no header overlap at 360-1920', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  for (const width of [360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(sessionUrl);
    await expect(page.getByTestId('analyst-exchange').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll at ${width}`).toBeLessThanOrEqual(1);
    const header = await page.getByTestId('analyst-session-header').boundingBox();
    expect(header && header.width <= width, `session header fits at ${width}`).toBeTruthy();
    await shot(page, info, `S10-${width}`);
  }
});

test('S11 · the owner deletes the session; it is gone from the list and the link', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto(sessionUrl);
  await page.getByTestId('analyst-session-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^(delete|xóa)$/i }).click();
  await expect(page).toHaveURL(/\/analyst$/);
  await expect(page.locator(`[data-testid="analyst-session-item"][href="${sessionUrl}"]`)).toHaveCount(0);
  await page.goto(sessionUrl);
  await expect(page.getByText(/analysis not available|không mở được phiên phân tích/i)).toBeVisible();
});
