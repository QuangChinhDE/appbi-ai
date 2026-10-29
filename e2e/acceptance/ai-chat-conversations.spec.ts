import { expect, request, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

/**
 * THE ONE AI CHAT - real browser acceptance of conversations, sharing, the optional
 * Agent Flow add-on and the retired addresses (Deterministic Replay Mode, isolated
 * QA stack). Contract: docs/features/unified-ai-chat/contract.md.
 *
 * Every step under test is done the way a person does it: typing, picking the add-on,
 * clicking the share dialog, reloading, following an old link. `adminApi()` is used
 * ONLY for preconditions (module levels, a Dataset or document grant, a team) and is
 * labelled as such. The model is the only stand-in: the planner and the add-on flow's
 * model answer from recordings (replay files); every gate and validation is real.
 *
 * Proved in the browser:
 *   - one chat: no Analyst entry, no assistant to pick before asking, /analyst redirects;
 *   - a conversation survives a reload; the follow-up context is the server's;
 *   - sharing never shares the data (redacted on the wire) or the documents;
 *   - the add-on adds cited documents BESIDE verified numbers, never instead of them;
 *     it is not run for a plain data question; an unshared add-on leaves the data
 *     answer whole and says so;
 *   - an imported pre-unification analysis opens from its old link.
 * Numbers are compared with the independent SQL oracle (ORACLE_FILE).
 *
 *   E2E_BASE_URL=http://localhost:3351 DOGFOOD_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   ORACLE_FILE=.../oracle.json EXT_FILE=.../ext.json LEGACY_SESSION_ID=<imported analyst session id> \
 *   npx playwright test -c ai-chat-conversations.config.ts
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ADMIN = { email: process.env.ADMIN_EMAIL || '', password: process.env.ADMIN_PASSWORD || '' };
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
/** The seeded add-on: {flow_key, flow_name, doc_id, doc_title} (seed_ext.py). */
const EXT: { flow_key: string; flow_name: string; doc_id: number; doc_title: string } =
  JSON.parse(fs.readFileSync(process.env.EXT_FILE || '', 'utf-8'));
const LEGACY_SESSION_ID = Number(process.env.LEGACY_SESSION_ID || 0);
const DOMAIN = 'rig.appbi.io';
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3351';
const OUTCOME = '[data-testid="chat-answer"], [data-testid="chat-clarify"], [data-testid="chat-unsupported"], [data-testid="chat-no-data-part"], [data-testid="chat-refused"], [data-testid="chat-failed"], [data-testid="chat-error"]';
const Q1 = 'Doanh số Miền Bắc theo kênh bán năm 2025';
const Q2 = 'theo ngành hàng thì sao';
const QDOC = 'Chính sách chiết khấu mới là gì?';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!PASSWORD || !ADMIN.email || !EXT.flow_key || !LEGACY_SESSION_ID) {
    throw new Error('DOGFOOD_PASSWORD / ADMIN_* / EXT_FILE / LEGACY_SESSION_ID not set: the QA stack is required; a skip is not a pass');
  }
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
  const flowShares = async () => (await (await ctx.get(`/api/v1/shares/agent_brain/${EXT.flow_key}`, { headers })).json());
  return {
    ctx, headers, ds, userId,
    level: (who: string, chat: string, extra: Record<string, string> = {}) =>
      ctx.put(`/api/v1/permissions/${userId(who)}`, { headers, data: { permissions: { chat, ...extra } } }),
    revoke: (who: string) => ctx.delete(`/api/v1/datasets/${ds}/grants?user_id=${userId(who)}`, { headers }),
    grant: (who: string, verb: string) => ctx.post(`/api/v1/datasets/${ds}/grants`, { headers, data: { verb, user_id: userId(who) } }),
    shareFlow: (who: string) => ctx.post(`/api/v1/shares/agent_brain/${EXT.flow_key}`, { headers, data: { user_id: userId(who), permission: 'view' } }),
    unshareFlow: async (who: string) => {
      const rows = await flowShares();
      const mine = (Array.isArray(rows) ? rows : rows.shares || []).find((s: { user_id?: string }) => s.user_id === userId(who));
      return mine ? ctx.delete(`/api/v1/shares/agent_brain/${EXT.flow_key}/entries/${mine.id}`, { headers }) : null;
    },
  };
}

async function shot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function ask(page: Page, q: string, opts: { useAddOn?: boolean } = {}): Promise<Locator> {
  const before = await page.getByTestId('chat-exchange').count();
  if (opts.useAddOn) await page.getByTestId('chat-use-extension').check();
  await page.getByTestId('chat-question').fill(q);
  await page.getByTestId('chat-ask').click();
  const ex = page.getByTestId('chat-exchange').nth(before);
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  return ex;
}

async function tableOf(scope: Locator): Promise<Record<string, number>> {
  await expect(scope.getByTestId('chat-table')).toBeVisible();   // a reloaded conversation renders after its fetch
  const rows = await scope.getByTestId('chat-table').locator('tbody tr').evaluateAll((trs) =>
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

/** Every chat response the page receives, so "nothing reached the browser" is checked on the wire. */
function recordResponses(page: Page) {
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (!r.url().includes('/api/v1/chat/')) return;
    try { bodies.push(await r.text()); } catch { /* streamed / aborted */ }
  });
  return bodies;
}

/** The share dialog. AppBI's Modal carries no dialog role, so it is found by its own content. */
function shareDialog(page: Page) {
  return page.locator('div.space-y-5').filter({ has: page.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i) });
}

async function shareWith(page: Page, who: string, permission: 'view' | 'edit') {
  await page.getByTestId('chat-conversation-share').click();
  const dialog = shareDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i).fill(`${who}@${DOMAIN}`);
  await dialog.getByRole('button', { name: new RegExp(`${who}@${DOMAIN}`) }).click();
  await dialog.locator('select').first().selectOption(permission);
  const saved = page.waitForResponse((r) => r.url().includes('/shares/chat_conversation/') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(share|chia sẻ)$/i }).first().click();
  expect((await saved).status()).toBe(201);
  return dialog;
}

const NOT_AVAILABLE = /conversation not available|không mở được cuộc trò chuyện/i;
let convUrl = '';
let docUrl = '';

// ── preconditions ──────────────────────────────────────────────────────────────
test.beforeAll(async () => {
  const a = await adminApi();
  // owner may share (chat: edit) and use a shared add-on (agent_flows: view) + read its document (govern: view)
  expect((await a.level('qa-analyst', 'edit', { agent_flows: 'view', govern: 'view' })).status(), 'precondition: owner levels').toBe(200);
  expect((await a.level('qa-viewer', 'view')).status()).toBe(200);
  await a.grant('qa-analyst', 'build');
  await a.revoke('qa-viewer');                      // the recipient holds NO grant on the Dataset
  await a.shareFlow('qa-analyst');                  // the add-on is shared with the owner (seeded)
  await a.ctx.dispose();
});

// Put the seeded fixtures back (the other acceptance suites depend on them):
// qa-viewer holds VIEW (not explore) on the Dogfood Datasets; qa-analyst is chat: view.
test.afterAll(async () => {
  const a = await adminApi();
  await a.revoke('qa-viewer');
  expect((await a.grant('qa-viewer', 'view')).status()).toBe(200);
  expect((await a.level('qa-analyst', 'view', { agent_flows: 'view', govern: 'view' })).status()).toBe(200);
  expect((await a.level('qa-viewer', 'view')).status()).toBe(200);
  await a.shareFlow('qa-analyst');
  await a.ctx.dispose();
});

// ── C1: one chat ──────────────────────────────────────────────────────────────
test('C1 · one AI Chat: one sidebar entry, no Analyst, nothing to pick before asking; /analyst redirects', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/chat"]')).toHaveCount(1);
  await expect(page.locator('a[href="/analyst"]')).toHaveCount(0);
  await page.locator('a[href="/chat"]').click();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI Chat');
  await expect(page.getByTestId('chat-question')).toBeEnabled();            // no assistant picker stands in the way
  await expect(page.getByTestId('ai-mode-switch')).toHaveCount(0);
  await expect(page.getByTestId('chat-extension-select')).toHaveValue('');  // the add-on is optional and off
  await shot(page, info, 'C1-one-chat');
  await page.goto('/analyst');
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId('chat-page')).toBeVisible();
});

// ── C2: a conversation survives a reload and keeps its follow-up context ──────
test('C2 · first question opens a conversation URL; reload restores the answer; the follow-up after reload is the server\'s', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/chat');
  const ex = await ask(page, Q1);
  expectOracle(await tableOf(ex), 'north_channel_2025');
  await expect(ex.getByTestId('chat-supporting')).toHaveCount(0);           // no add-on: the data core alone
  await expect(page).toHaveURL(/\/chat\/c\/\d+$/);
  convUrl = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByTestId('chat-conversation-title')).toHaveText(Q1);
  const restored = page.getByTestId('chat-exchange').first();
  expectOracle(await tableOf(restored), 'north_channel_2025');
  await expect(restored.getByTestId('chat-asked-at')).toBeVisible();
  // nothing in the browser carries the previous plan: the server reads it from the conversation
  const sent: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/turns')) sent.push(r.postData() || ''); });
  const follow = await ask(page, Q2);
  expectOracle(await tableOf(follow), 'north_category_2025');
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((b) => !b.includes('previous_plan')), 'no client-side previous plan').toBe(true);
  await expect(page.locator(`[data-testid="chat-conversation-item"][href="${convUrl}"]`)).toContainText(Q1);
  await shot(page, info, 'C2-conversation-restored');
});

test('C3 · rename persists', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-rename').click();
  await page.getByTestId('chat-conversation-title-input').fill('Miền Bắc 2025');
  await page.getByRole('button', { name: /^(save|lưu)$/i }).click();
  await expect(page.getByTestId('chat-conversation-title')).toHaveText('Miền Bắc 2025');
  await page.reload();
  await expect(page.getByTestId('chat-conversation-title')).toHaveText('Miền Bắc 2025');
});

// ── C4-C8: sharing never shares the data ──────────────────────────────────────
test('C4 · shared at view with someone WITHOUT the Dataset: questions only, numbers redacted on the wire, no composer', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  const dialog = await shareWith(page, 'qa-viewer', 'view');
  await expect(dialog).toContainText(/never shares its data|không chia sẻ dữ liệu/i);
  await shot(page, info, 'C4-share-dialog');
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  const bodies = recordResponses(page);
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-read-only')).toBeVisible();
  await expect(page.getByTestId('chat-conversation-access')).toBeVisible();
  await expect(page.getByTestId('chat-redacted')).toHaveCount(2);
  await expect(page.getByTestId('chat-table')).toHaveCount(0);
  await expect(page.getByTestId('chat-question')).toHaveCount(0);
  await expect(page.getByTestId('chat-conversation-share')).toHaveCount(0);
  const wire = bodies.join('\n');
  for (const v of Object.values(ORACLE.north_channel_2025)) expect(wire.includes(String(Math.round(v))), `oracle value ${v} on the wire`).toBe(false);
  expect(wire).not.toContain('"rows"');
  await shot(page, info, 'C4-recipient-redacted');
});

test('C5 · the same recipient, once the Dataset itself is granted, sees the numbers - and loses them on revoke', async ({ page }) => {
  const a = await adminApi();
  expect((await a.grant('qa-viewer', 'explore')).status()).toBe(200);   // precondition: the Dataset's own grant
  await login(page, 'qa-viewer');
  await page.goto(convUrl);
  expectOracle(await tableOf(page.getByTestId('chat-exchange').first()), 'north_channel_2025');
  await a.revoke('qa-viewer');                                // precondition: revoked while the page is open
  await page.reload();
  await expect(page.getByTestId('chat-redacted')).toHaveCount(2);
  await a.ctx.dispose();
});

test('C6 · edit share: the recipient may ask, as themselves (no Dataset -> no numbers)', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-share').click();
  const dialog = shareDialog(page);
  const row = dialog.locator('li').filter({ hasText: `qa-viewer@${DOMAIN}` });
  const updated = page.waitForResponse((r) => r.url().includes('/shares/chat_conversation/') && r.request().method() === 'PUT');
  await row.locator('select').selectOption('edit');
  expect((await updated).ok()).toBe(true);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-exchange')).toHaveCount(2);         // the stored turns have rendered
  await expect(page.getByTestId('chat-read-only')).toHaveCount(0);
  const ex = await ask(page, Q1);
  await expect(ex.getByTestId('chat-table')).toHaveCount(0);   // their own rights: no explore grant
  await shot(page, info, 'C6-edit-recipient');
});

test('C7 · revoking the share in the dialog removes access on the next load', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-share').click();
  const dialog = shareDialog(page);
  const removed = page.waitForResponse((r) => r.url().includes('/shares/chat_conversation/') && r.request().method() === 'DELETE');
  await dialog.locator('li').filter({ hasText: `qa-viewer@${DOMAIN}` }).getByRole('button', { name: /remove access|gỡ quyền/i }).click();
  expect((await removed).status()).toBe(204);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(convUrl);
  await expect(page.getByText(NOT_AVAILABLE)).toBeVisible();
  await expect(page.getByTestId('chat-exchange')).toHaveCount(0);
  await shot(page, info, 'C7-revoked');
});

test('C8 · team share reads; leaving the team removes it', async ({ page }) => {
  const a = await adminApi();
  const created = await a.ctx.post('/api/v1/permissions/teams', {
    headers: a.headers, data: { name: `QA chat team ${Date.now()}`, member_ids: [a.userId('qa-viewer'), a.userId('qa-analyst')] },
  });                                                                  // precondition: a configured team
  expect(created.status()).toBe(201);
  const team = await created.json();
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-share').click();
  const dialog = shareDialog(page);
  const teamSelect = dialog.locator('select').nth(1);
  await teamSelect.selectOption(String(await teamSelect.locator('option', { hasText: team.name }).getAttribute('value')));
  const saved = page.waitForResponse((r) => r.url().includes('/shares/chat_conversation/') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(share|chia sẻ)$/i }).nth(1).click();
  expect((await saved).status()).toBe(201);
  await page.keyboard.press('Escape');

  await login(page, 'qa-viewer');
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-conversation-title')).toBeVisible();
  const left = await a.ctx.put(`/api/v1/permissions/teams/${team.id}`, { headers: a.headers, data: { member_ids: [a.userId('qa-analyst')] } });
  expect(left.status(), 'precondition: qa-viewer leaves the team').toBe(200);
  await page.reload();
  await expect(page.getByText(NOT_AVAILABLE)).toBeVisible();
  await a.ctx.delete(`/api/v1/permissions/teams/${team.id}`, { headers: a.headers });
  await a.ctx.dispose();
});

test('C9 · no chat module: the deep link shows no-access, never a transcript', async ({ page }) => {
  await login(page, 'qa-nomodule');
  const bodies = recordResponses(page);
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-exchange')).toHaveCount(0);
  expect(bodies.join('')).not.toContain(Q1);
});

// ── C10-C14: the optional add-on ──────────────────────────────────────────────
test('C10 · an add-on brings cited documents BESIDE the verified numbers, never instead of them', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto('/chat');
  await page.getByTestId('chat-extension-select').selectOption(EXT.flow_key);  // chosen before the first question
  const ex = await ask(page, Q1, { useAddOn: true });
  expectOracle(await tableOf(ex), 'north_channel_2025');                     // the numbers are the data core's
  const sup = ex.getByTestId('chat-supporting');
  await expect(sup).toBeVisible();
  await expect(sup).toContainText(EXT.flow_name);
  await expect(sup.getByTestId('chat-documents')).toContainText(EXT.doc_title);
  await expect(sup.getByTestId('chat-finding')).toContainText('QĐ-12/2025');    // dates and document numbers kept
  await expect(sup.getByTestId('chat-unverified-figures')).toContainText('1.234.567.890');
  await expect(ex.getByTestId('chat-notices')).toContainText(/separately|trình bày riêng/i);
  docUrl = new URL(page.url()).pathname;
  await page.reload();                                                         // stored, not only streamed
  await expect(page.getByTestId('chat-extension-select')).toHaveValue(EXT.flow_key);
  await expect(page.getByTestId('chat-exchange').first().getByTestId('chat-supporting')).toContainText(EXT.doc_title);
  await shot(page, info, 'C10-data-plus-documents');
});

test('C11 · a plain data question in the same conversation does not run the add-on', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto(docUrl);
  const ex = await ask(page, Q2);
  expectOracle(await tableOf(ex), 'north_category_2025');
  await expect(ex.getByTestId('chat-supporting')).toHaveCount(0);
});

test('C12 · a policy question is answered from documents only - no number from anywhere', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(docUrl);
  const ex = await ask(page, QDOC);
  await expect(ex.getByTestId('chat-no-data-part')).toBeVisible();
  await expect(ex.getByTestId('chat-table')).toHaveCount(0);
  await expect(ex.getByTestId('chat-supporting').getByTestId('chat-documents')).toContainText(EXT.doc_title);
  await shot(page, info, 'C12-documents-only');
});

test('C13 · a reader who cannot open the cited document does not see it, whatever else they may read', async ({ page }, info) => {
  const a = await adminApi();
  expect((await a.grant('qa-viewer', 'explore')).status()).toBe(200);   // precondition: the DATA is theirs, the document is not
  await login(page, 'qa-analyst');
  await page.goto(docUrl);
  await shareWith(page, 'qa-viewer', 'view');
  await page.keyboard.press('Escape');
  await login(page, 'qa-viewer');
  const bodies = recordResponses(page);
  await page.goto(docUrl);
  const turns = page.getByTestId('chat-exchange');
  await expect(turns).toHaveCount(3);
  await expect(turns.nth(1).getByTestId('chat-table')).toBeVisible();      // a data turn: their Dataset, shown
  await expect(turns.nth(0).getByTestId('chat-redacted')).toBeVisible();   // data + the document: hidden
  await expect(turns.nth(2).getByTestId('chat-redacted')).toBeVisible();   // documents only: hidden
  expect(bodies.join('\n')).not.toContain('QĐ-12/2025');
  await shot(page, info, 'C13-document-redacted');
  await a.revoke('qa-viewer');
  await a.ctx.dispose();
});

test('C14 · the add-on unshared mid-conversation: the data answer stands, the reason is said', async ({ page }, info) => {
  const a = await adminApi();
  await a.unshareFlow('qa-analyst');                                   // precondition: the flow's own share revoked
  await login(page, 'qa-analyst');
  await page.goto(docUrl);
  const ex = await ask(page, Q1, { useAddOn: true });
  expectOracle(await tableOf(ex), 'north_channel_2025');
  await expect(ex.getByTestId('chat-supporting')).toHaveCount(0);
  await expect(ex.getByTestId('chat-notices')).toContainText(/add-on|luồng hỗ trợ/i);
  await shot(page, info, 'C14-addon-unavailable');
  await a.shareFlow('qa-analyst');
  await a.ctx.dispose();
});

// ── C15: history from before the unification ──────────────────────────────────
test('C15 · an old /analyst/s/{id} link opens the imported conversation with its stored answers', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  await page.goto(`/analyst/s/${LEGACY_SESSION_ID}`);
  await expect(page).toHaveURL(/\/chat\/c\/\d+$/);
  await expect(page.getByTestId('chat-exchange').first()).toBeVisible();
  await expect(page.getByTestId('chat-exchange').first().getByTestId('chat-table')).toBeVisible();
  await shot(page, info, 'C15-legacy-link');
});

test('C16 · responsive: no horizontal scroll and no header overlap at 360-1920', async ({ page }, info) => {
  await login(page, 'qa-analyst');
  for (const width of [360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(docUrl);
    await expect(page.getByTestId('chat-exchange').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll at ${width}`).toBeLessThanOrEqual(1);
    const header = await page.getByTestId('chat-conversation-header').boundingBox();
    expect(header && header.width <= width, `conversation header fits at ${width}`).toBeTruthy();
    await shot(page, info, `C16-${width}`);
  }
});

test('C17 · the owner deletes the conversation; it is gone from the list and the link', async ({ page }) => {
  await login(page, 'qa-analyst');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^(delete|xóa)$/i }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.locator(`[data-testid="chat-conversation-item"][href="${convUrl}"]`)).toHaveCount(0);
  await page.goto(convUrl);
  await expect(page.getByText(NOT_AVAILABLE)).toBeVisible();
});
