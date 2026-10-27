import { expect, test } from '@playwright/test';

import { ask, chooseSource, DA3_UNCERTIFIED, expectOracle, OUTCOME, openChat, shot, tableOf, watch } from './ai-chat-appbi.helpers';

/**
 * Unified AI Chat on the REAL AppBI stack (appbi-ai, localhost:3000) with the REAL model, under
 * the cumulative $5 test cap (every call reserved first and labelled `unified-chat-live` in the
 * one shared ledger). A small controlled set: what only a real model can show - Vietnamese
 * questions planned live, follow-ups that keep or change context, an ambiguous business term,
 * Stop while the model is still planning, refresh / leave-and-return during a running turn, and
 * one BigQuery question for runtime evidence. The numbers are checked against hand-written SQL.
 * Its planner outputs are recorded in the ledger and become the deterministic replay of the
 * broad suite (ai-chat-appbi-acceptance.spec.ts).
 */
test.describe.configure({ mode: 'serial' });

// This dataset's fields carry only their column names (no Vietnamese labels / synonyms), and the
// grounding guard refuses a question word that matches no field - so the questions name the fields.
const QA = 'Doanh thu theo product_id trong quý 1 năm 2024';
const QB = 'Còn quý 2 thì sao?';
const QC = 'Chỉ tính product_id 5';
const QD = 'Doanh số theo employee_id';
const QE = 'Doanh thu theo product_id';
const QF = 'Doanh thu theo product_id trong quý 2 năm 2024';
/** Needs the product NAME: a JOIN to dim_product, whose key probe GQS cannot bound on BigQuery yet. */
const QJ = 'Doanh thu theo product_name trong quý 1 năm 2024';
const QBQ = 'Tổng Sum theo quantity';

test('L1 · a Vietnamese question, then a follow-up that changes the period and one that adds a filter', async ({ page }, info) => {
  const errors = watch(page);
  await openChat(page);
  await chooseSource(page);
  const a = await ask(page, QA);
  expectOracle(await tableOf(a), 'prod_rev_q1_2024');
  await expect(a.getByTestId('chat-evidence')).toContainText(/bigquery/i);
  await expect(a.getByTestId('chat-evidence')).toContainText(/2024-01-01/);
  await shot(page, info, 'L1a-q1');
  const b = await ask(page, QB);
  expectOracle(await tableOf(b), 'prod_rev_q2_2024');                       // the period changed, the breakdown kept
  await shot(page, info, 'L1b-q2');
  const c = await ask(page, QC);
  const values = Object.values(await tableOf(c));
  expect(values, 'only product code 5 in Q2 2024 remains').toEqual([102450]); // the quarter was kept, the filter added
  await expect(c.getByTestId('chat-evidence')).toContainText(/2024-04-01/);
  await shot(page, info, 'L1c-product5-q2');
  expect(errors).toEqual([]);
});

test('L2 · an ambiguous business term is clarified or answered from a named source - never guessed silently', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  const d = await ask(page, QD);
  const kind = await d.locator(OUTCOME).first().getAttribute('data-testid');
  info.annotations.push({ type: 'live-outcome', description: `${QD} -> ${kind}` });
  expect(['chat-clarify', 'chat-answer']).toContain(kind);
  if (kind === 'chat-answer') await expect(d.getByTestId('chat-evidence')).toContainText(/Total Revenue|Order Count|Total Quantity|Avg Order Value/i);
  await shot(page, info, 'L2-ambiguous');
});

test('L3 · Stop while the model is planning ends the turn as cancelled, and a reload says the same', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  await page.getByTestId('chat-question').fill(QE);
  await page.getByTestId('chat-ask').click();
  await expect(page.getByTestId('chat-running')).toBeVisible();
  await page.getByTestId('chat-cancel').click();
  const ex = page.getByTestId('chat-exchange').last();
  await expect(ex.getByTestId('chat-cancelled')).toBeVisible({ timeout: 60_000 });
  await shot(page, info, 'L3-stopped');
  await page.reload();
  await expect(page.getByTestId('chat-exchange').last().getByTestId('chat-cancelled')).toBeVisible({ timeout: 60_000 });
});

test('L4 · refresh during a running turn: the turn is recovered and ends in its real state', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  await page.getByTestId('chat-question').fill(QF);
  const accepted = page.waitForResponse((r) => r.url().includes('/turns') && r.request().method() === 'POST');
  await page.getByTestId('chat-ask').click();
  await accepted;
  await expect(page).toHaveURL(/\/chat\/c\/\d+$/);
  await page.reload();                                         // mid-turn
  const ex = page.getByTestId('chat-exchange').last();
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  expectOracle(await tableOf(ex), 'prod_rev_q2_2024');
  await shot(page, info, 'L4-recovered-after-refresh');
});

test('L5 · leave during a running turn and come back: the answer is there', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page);
  await page.getByTestId('chat-question').fill(QA);
  const accepted = page.waitForResponse((r) => r.url().includes('/turns') && r.request().method() === 'POST');
  await page.getByTestId('chat-ask').click();
  await accepted;
  await expect(page).toHaveURL(/\/chat\/c\/\d+$/);
  const url = new URL(page.url()).pathname;
  await page.goto('/dashboards');
  await page.goto(url);
  const ex = page.getByTestId('chat-exchange').last();
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  expectOracle(await tableOf(ex), 'prod_rev_q1_2024');
  await shot(page, info, 'L5-returned');
});

test('L6 · BigQuery: a governed read on the real BigQuery source, with its evidence', async ({ page }, info) => {
  await openChat(page);
  await chooseSource(page, 'E2E BQ dw_buoi_7');
  const ex = await ask(page, QBQ);
  await expect(ex.getByTestId('chat-answer')).toBeVisible();
  await expect(ex.getByTestId('chat-evidence')).toContainText(/bigquery/i);
  const rows = await tableOf(ex);
  info.annotations.push({ type: 'bigquery-rows', description: JSON.stringify(rows) });
  expect(Object.keys(rows).length).toBeGreaterThan(0);
  await shot(page, info, 'L6-bigquery');
});

test('L7 · governance: a period on a date whose physical type was never certified is refused - no number around it', async ({ page }, info) => {
  const errors = watch(page);
  await openChat(page);
  await chooseSource(page, DA3_UNCERTIFIED);
  const ex = await ask(page, QA);
  const refused = ex.getByTestId('chat-refused');
  await expect(refused).toBeVisible();
  await expect(refused).toHaveAttribute('data-code', 'time_range_unsupported');
  await expect(refused).toContainText(/trường ngày đã chứng nhận/);
  await expect(ex.getByTestId('chat-table')).toHaveCount(0);
  await shot(page, info, 'L7-uncertified-date-refused');
  expect(errors).toEqual([]);
});

test('L8 · a question that needs a JOIN on BigQuery is refused plainly while key probes cannot be bounded - never answered around', async ({ page }, info) => {
  const errors = watch(page);
  await openChat(page);
  await chooseSource(page);
  const ex = await ask(page, QJ);
  const kind = await ex.locator(OUTCOME).first().getAttribute('data-testid');
  info.annotations.push({ type: 'live-outcome', description: `${QJ} -> ${kind}` });
  // the model may also ask which field it means; it must never come back with numbers
  expect(['chat-refused', 'chat-clarify']).toContain(kind);
  if (kind === 'chat-refused') await expect(ex.getByTestId('chat-refused')).toHaveAttribute('data-code', 'policy_unenforceable');
  await expect(ex.getByTestId('chat-table')).toHaveCount(0);
  await shot(page, info, 'L8-join-refused');
  expect(errors).toEqual([]);
});
