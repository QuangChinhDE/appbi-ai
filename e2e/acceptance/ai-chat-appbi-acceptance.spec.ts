import { expect, test, type Page } from '@playwright/test';

import {
  api, ask, chooseSource, DA3, DOMAIN, expectOracle, EXT, login, openChat, ORACLE, OUTCOME, shot, tableOf, watch,
} from './ai-chat-appbi.helpers';

/**
 * THE ONE AI CHAT on the REAL AppBI stack (Compose project appbi-ai, http://localhost:3000),
 * production build, real accounts (the approved qa-chat-* QA accounts), real BigQuery
 * sources, real permissions, real Agent Flow + Knowledge document. Deterministic replay of the
 * MODEL only: the planner's answers are the outputs the live phase recorded (or authored for the
 * clarification), the add-on flow's model output is recorded; every gate, GQS read, redaction and
 * validation is real. Numbers are compared with hand-written SQL on the raw BigQuery tables (ORACLE_FILE).
 * Zero retries.
 */
test.describe.configure({ mode: 'serial' });

// The dataset's fields carry only their column names; the grounding guard wants the question to name them.
const QA = 'Doanh thu theo product_id trong quý 1 năm 2024';
const QB = 'Còn quý 2 thì sao?';
const QC = 'Chỉ tính product_id 5';
const QCL = 'Doanh số theo employee_id';
const QF = 'Doanh thu theo product_id trong quý 2 năm 2024';
const QDOC = 'Chính sách giao hàng trễ được hoàn phí thế nào?';
const NOT_AVAILABLE = /conversation not available|không mở được cuộc trò chuyện/i;

let convUrl = '';
let addOnUrl = '';

async function newConversation(page: Page) {
  await page.getByTestId('chat-new').click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByTestId('chat-exchange')).toHaveCount(0);
}

// ── navigation: one chat ──────────────────────────────────────────────────────
test('R1 · one AI Chat entry, no Analyst, nothing to pick before asking; /analyst redirects; VI/EN labels', async ({ page }, info) => {
  const errors = watch(page);
  await login(page, 'qa-chat-owner');
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/chat"]')).toHaveCount(1);
  await expect(page.locator('a[href="/analyst"]')).toHaveCount(0);
  await page.locator('a[href="/chat"]').click();
  await expect(page.getByTestId('chat-page')).toBeVisible();
  await expect(page.getByTestId('chat-question')).toBeEnabled();
  await expect(page.getByTestId('chat-extension-select')).toHaveValue('');      // the add-on is optional and off
  await expect(page.getByTestId('chat-source-select')).toHaveValue('');         // every source you may use
  const options = await page.getByTestId('chat-source-select').locator('option').allInnerTexts();
  expect(options).toEqual(expect.arrayContaining([DA3, 'E2E BQ dw_buoi_7']));
  await shot(page, info, 'R1-one-chat');
  await page.goto('/analyst');
  await expect(page).toHaveURL(/\/chat$/);
  const label = page.getByTestId('chat-preview-label');
  const first = (await label.innerText()).trim();
  // the account starts in English; the user menu stays open after a language pick
  const pick = async (name: RegExp) => {
    const button = page.getByRole('button', { name });
    if (!(await button.isVisible())) await page.getByRole('button', { name: /^QC$/ }).click();
    await button.click();
  };
  await pick(/^(Vietnamese|Tiếng Việt)$/);
  await expect(label).not.toHaveText(first);                                     // the label follows the language
  await shot(page, info, 'R1-other-language');
  await pick(/^(English|Tiếng Anh)$/);
  await expect(label).toHaveText(first);
  expect(errors).toEqual([]);
});

// ── a data question and its follow-ups ────────────────────────────────────────
test('R2 · choose a BigQuery source, ask in Vietnamese: SQL-equal numbers, evidence, chart, table; follow-ups keep or change context', async ({ page }, info) => {
  const errors = watch(page);
  await openChat(page);
  await chooseSource(page);
  const a = await ask(page, QA);
  expectOracle(await tableOf(a), 'prod_rev_q1_2024');
  await expect(a.getByTestId('chat-evidence')).toContainText(DA3);
  await expect(a.getByTestId('chat-evidence')).toContainText('Total Revenue');
  await expect(a.getByTestId('chat-chart').locator('.recharts-bar-rectangle, .recharts-line-curve').first()).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/c\/\d+$/);
  convUrl = new URL(page.url()).pathname;
  await shot(page, info, 'R2a-answer');
  expectOracle(await tableOf(await ask(page, QB)), 'prod_rev_q2_2024');              // period changed
  const c = await ask(page, QC);
  expect(Object.values(await tableOf(c))).toEqual([102450]);                     // quarter kept, filter added
  await shot(page, info, 'R2c-follow-ups');
  await page.reload();                                                           // history is stored, not streamed
  await expect(page.getByTestId('chat-exchange')).toHaveCount(3);
  expectOracle(await tableOf(page.getByTestId('chat-exchange').nth(1)), 'prod_rev_q2_2024');
  expect(errors).toEqual([]);
});

test('R3 · an ambiguous business term asks which one, and the pick is answered from that metric', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  const ex = await ask(page, QCL);
  await expect(ex.getByTestId('chat-clarify')).toBeVisible();
  await shot(page, info, 'R3a-clarify');
  await ex.getByTestId('chat-clarify').getByRole('button', { name: /Total Revenue/ }).click();
  const picked = page.getByTestId('chat-exchange').last();
  await expect(picked.getByTestId('chat-answer')).toBeVisible({ timeout: 120_000 });
  await expect(picked.getByTestId('chat-evidence')).toContainText('Total Revenue');
  expectOracle(await tableOf(picked), 'emp_rev_all');
  await shot(page, info, 'R3b-picked');
});

test('R4 · a double click asks once; an outage is an error, never an answer; retry works; network loss is an error', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  await page.getByTestId('chat-question').fill(QA);
  await page.getByTestId('chat-ask').dblclick();
  await expect(page.getByTestId('chat-exchange').first().locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('chat-exchange')).toHaveCount(1);
  for (const [label, handler] of [
    ['500', (r: import('@playwright/test').Route) => r.fulfill({ status: 500, body: '{"detail":"boom"}', contentType: 'application/json' })],
    ['offline', (r: import('@playwright/test').Route) => r.abort('internetdisconnected')],
  ] as const) {
    await page.route('**/api/v1/chat/conversations/*/turns', handler);
    const ex = await ask(page, QB);
    await expect(ex.getByTestId('chat-error')).toBeVisible();
    await expect(ex.getByTestId('chat-table')).toHaveCount(0);
    await shot(page, info, `R4-error-${label}`);
    await page.unroute('**/api/v1/chat/conversations/*/turns');
  }
  expectOracle(await tableOf(await ask(page, QB)), 'prod_rev_q2_2024');              // retried after the outage
});

test('R5 · save the answer as a chart, open it in Explore, edit it, reload: same numbers as SQL', async ({ page }, info) => {
  await page.goto('/');
  await openChat(page);
  await chooseSource(page);
  const ex = await ask(page, QA);
  const saved = page.waitForResponse((r) => /\/api\/v1\/charts\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
  await ex.getByTestId('chat-save-chart').click();
  expect((await saved).status()).toBe(201);
  await ex.getByTestId('chat-open-chart').click();
  await expect(page).toHaveURL(/\/explore\/\d+$/);
  const chartId = Number(page.url().split('/').pop());
  await page.getByTestId('explore-run').click();
  await expect(page.getByText(/^\d+ rows?$/).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, info, 'R5a-explore');
  const name = `QA chat chart ${chartId}`;
  await page.getByRole('button', { name: 'Rename chart' }).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(name);
  const put = page.waitForResponse((r) => r.url().includes(`/api/v1/charts/${chartId}`) && r.request().method() === 'PUT');
  await page.keyboard.press('Enter');
  expect((await put).status()).toBe(200);
  await page.reload();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await page.getByTestId('explore-run').click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.getByText(/^Showing \d+ rows?$/)).toBeVisible();
  const cells = await page.locator('table').last().locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const values = cells.map((r) => Number(r[r.length - 1].replace(/[^\d.-]/g, ''))).sort((a, b) => a - b);
  expect(values).toEqual(Object.values(ORACLE.prod_rev_q1_2024).sort((a, b) => a - b));
  await shot(page, info, 'R5b-reopened');
});

test('R6 · feedback on an answer is recorded; switching between conversations shows each one\'s own turns', async ({ page }, info) => {
  await login(page, 'qa-chat-owner');
  await page.goto(convUrl);
  const first = page.getByTestId('chat-exchange').first();
  await first.getByTestId('chat-feedback-reason').selectOption('wrong_filter');
  await first.getByTestId('chat-feedback-comment').fill('QA acceptance feedback');
  const posted = page.waitForResponse((r) => r.url().includes('/feedback') && r.request().method() === 'POST');
  await first.getByTestId('chat-feedback-down').click();
  expect((await posted).status()).toBe(201);
  await expect(first.getByTestId('chat-feedback-sent')).toBeVisible();
  const items = page.getByTestId('chat-conversation-item');
  expect(await items.count()).toBeGreaterThan(1);
  await page.locator(`[data-testid="chat-conversation-item"]:not([href="${convUrl}"])`).first().click();
  await expect(page).not.toHaveURL(new RegExp(`${convUrl}$`));
  await page.locator(`[data-testid="chat-conversation-item"][href="${convUrl}"]`).click();
  await expect(page.getByTestId('chat-exchange')).toHaveCount(3);
  await shot(page, info, 'R6-switch');
});

// ── sharing never shares the data ─────────────────────────────────────────────
test('R7 · shared with someone who may not read the source: questions only, no numbers on the wire; revoke closes it', async ({ page }, info) => {
  const owner = await api();
  const users = await (await owner.ctx.get('/api/v1/users/shareable', { headers: owner.headers })).json();
  const viewer = (users as { id: string; email: string }[]).find((u) => u.email === `qa-chat-viewer@${DOMAIN}`)!;
  const cid = Number(convUrl.split('/').pop());
  await login(page, 'qa-chat-owner');
  await page.goto(convUrl);
  await page.getByTestId('chat-conversation-share').click();
  const dialog = page.locator('div.space-y-5').filter({ has: page.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i) });
  await dialog.getByPlaceholder(/search by name or email|tìm theo tên hoặc email/i).fill(viewer.email);
  await dialog.getByRole('button', { name: new RegExp(viewer.email) }).click();
  const saved = page.waitForResponse((r) => r.url().includes('/shares/chat_conversation/') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(share|chia sẻ)$/i }).first().click();
  expect((await saved).status()).toBe(201);
  await expect(dialog).toContainText(/never shares its data|không chia sẻ dữ liệu/i);
  await shot(page, info, 'R7a-share-dialog');
  await page.keyboard.press('Escape');

  await login(page, 'qa-chat-viewer');
  const bodies: string[] = [];
  page.on('response', async (r) => { if (r.url().includes('/api/v1/chat/')) { try { bodies.push(await r.text()); } catch { /* streamed */ } } });
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-redacted')).toHaveCount(3);
  await expect(page.getByTestId('chat-table')).toHaveCount(0);
  await expect(page.getByTestId('chat-question')).toHaveCount(0);
  const wire = bodies.join('\n');
  for (const v of [...Object.values(ORACLE.prod_rev_q1_2024), ...Object.values(ORACLE.prod_rev_q2_2024)].filter((n) => n > 1000)) {
    expect(wire.includes(String(v)), `oracle value ${v} reached the viewer`).toBe(false);
  }
  expect(wire).not.toContain('"rows"');
  await shot(page, info, 'R7b-viewer-redacted');

  const shares = await (await owner.ctx.get(`/api/v1/shares/chat_conversation/${cid}`, { headers: owner.headers })).json();
  const mine = (shares as { id: number; user_id?: string }[]).find((s) => s.user_id === viewer.id)!;
  expect((await owner.ctx.delete(`/api/v1/shares/chat_conversation/${cid}/entries/${mine.id}`, { headers: owner.headers })).status()).toBe(204);
  await page.reload();
  await expect(page.getByText(NOT_AVAILABLE)).toBeVisible();
  await shot(page, info, 'R7c-revoked');
  await owner.ctx.dispose();
});

test('R8 · authorization: no chat module -> no entry and no access; no explorable source -> a clear empty state', async ({ page }, info) => {
  await login(page, 'qa-chat-nomodule');
  await page.goto('/dashboards');
  await expect(page.locator('a[href="/chat"]')).toHaveCount(0);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-question')).toHaveCount(0);
  await expect(page.getByText(/no permission|không có quyền|do not have access/i).first()).toBeVisible();
  await shot(page, info, 'R8a-no-module');
  await page.goto(convUrl);
  await expect(page.getByTestId('chat-exchange')).toHaveCount(0);
  await login(page, 'qa-chat-viewer');
  await page.goto('/chat');
  await expect(page.getByTestId('chat-no-sources')).toBeVisible();                // honest: nothing to analyse
  await expect(page.getByTestId('chat-conversations-empty')).toBeVisible();
  await shot(page, info, 'R8b-empty-states');
});

// ── the optional add-on ───────────────────────────────────────────────────────
test('R9 · add-on chosen: a policy question is answered from its cited document only - no number from anywhere', async ({ page }, info) => {
  await openChat(page);
  await page.getByTestId('chat-extension-select').selectOption(EXT.flow_key);
  const ex = await ask(page, QDOC);
  await expect(ex.getByTestId('chat-no-data-part')).toBeVisible();
  await expect(ex.getByTestId('chat-table')).toHaveCount(0);
  const sup = ex.getByTestId('chat-supporting');
  await expect(sup).toContainText(EXT.flow_name);
  await expect(sup.getByTestId('chat-documents')).toContainText(EXT.doc_title);
  await expect(sup.getByTestId('chat-finding')).toContainText('QĐ-07/2026');
  addOnUrl = new URL(page.url()).pathname;
  await shot(page, info, 'R9-documents-only');
});

test('R10 · add-on asked on a data question: SQL-equal numbers from the data core, the document beside them, its figures labelled unverified', async ({ page }, info) => {
  await login(page, 'qa-chat-owner');
  await page.goto(addOnUrl);
  await chooseSource(page);
  const ex = await ask(page, QA, { addOn: true });
  expectOracle(await tableOf(ex), 'prod_rev_q1_2024');
  const sup = ex.getByTestId('chat-supporting');
  await expect(sup.getByTestId('chat-documents')).toContainText(EXT.doc_title);
  await expect(sup.getByTestId('chat-unverified-figures')).toContainText('9.876.543.210');
  await expect(sup).not.toContainText('123456');                                // the flow's own "metric" is dropped
  await expect(ex.getByTestId('chat-notices')).toContainText(/separately|trình bày riêng/i);
  await expect(ex.getByTestId('chat-answer')).toHaveCount(1);                   // ONE answer, not two
  await shot(page, info, 'R10-data-plus-document');
  const plain = await ask(page, QB);                                             // not a document question: no add-on
  expectOracle(await tableOf(plain), 'prod_rev_q2_2024');
  await expect(plain.getByTestId('chat-supporting')).toHaveCount(0);
});

test('R11 · the add-on fails: the data answer stands, the reason is said', async ({ page }, info) => {
  await openChat(page);
  await page.getByTestId('chat-extension-select').selectOption(EXT.flow_key);
  await chooseSource(page);
  const ex = await ask(page, QF, { addOn: true });                               // no recorded flow output: the run fails
  expectOracle(await tableOf(ex), 'prod_rev_q2_2024');
  await expect(ex.getByTestId('chat-supporting')).toHaveCount(0);
  await expect(ex.getByTestId('chat-notices')).toContainText(/add-on|luồng hỗ trợ/i);
  await shot(page, info, 'R11-addon-failed');
});

test('R12 · a reader who cannot open the cited document does not see it', async ({ page }, info) => {
  const owner = await api();
  const cid = Number(addOnUrl.split('/').pop());
  const users = await (await owner.ctx.get('/api/v1/users/shareable', { headers: owner.headers })).json();
  const viewer = (users as { id: string; email: string }[]).find((u) => u.email === `qa-chat-viewer@${DOMAIN}`)!;
  expect((await owner.ctx.post(`/api/v1/shares/chat_conversation/${cid}`, { headers: owner.headers,
    data: { user_id: viewer.id, permission: 'view' } })).status()).toBe(201);       // precondition: shared at view
  await login(page, 'qa-chat-viewer');
  const bodies: string[] = [];
  page.on('response', async (r) => { if (r.url().includes('/api/v1/chat/')) { try { bodies.push(await r.text()); } catch { /* */ } } });
  await page.goto(addOnUrl);
  await expect(page.getByTestId('chat-exchange').first().getByTestId('chat-redacted')).toBeVisible();
  expect(bodies.join('\n')).not.toContain('QĐ-07/2026');
  await shot(page, info, 'R12-document-redacted');
  await owner.ctx.dispose();
});

// ── old links never leak ──────────────────────────────────────────────────────
test('R13 · old links: an unknown or foreign conversation shows "not available", never a transcript', async ({ page }) => {
  await login(page, 'qa-chat-owner');
  for (const path of ['/analyst/s/987654321', '/chat?thread=1', '/chat/c/1']) {
    await page.goto(path);
    await expect(page.getByText(NOT_AVAILABLE)).toBeVisible();
    await expect(page.getByTestId('chat-exchange')).toHaveCount(0);
  }
});

// ── visual inspection at six sizes ────────────────────────────────────────────
test('R14 · 360 / 390 / 768 / 1024 / 1440 / 1920: no horizontal scroll, composer and header fit, no console errors', async ({ page }, info) => {
  const errors = watch(page);
  await login(page, 'qa-chat-owner');
  for (const [w, h] of [[360, 800], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(addOnUrl);
    await expect(page.getByTestId('chat-exchange').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal scroll at ${w}`).toBeLessThanOrEqual(1);
    for (const id of ['chat-conversation-header', 'chat-ask', 'chat-question']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= w + 1, `${id} fits at ${w}`).toBeTruthy();
    }
    await shot(page, info, `R14-${w}x${h}`);
    await page.getByTestId('chat-question').focus();
    await expect(page.getByTestId('chat-question')).toBeFocused();
  }
  expect(errors).toEqual([]);
});
