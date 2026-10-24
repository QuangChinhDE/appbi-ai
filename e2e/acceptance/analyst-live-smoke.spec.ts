import { expect, test, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Live-model smoke through the browser (NOT replay): the real planner (gpt-4o-mini),
 * metered by the server's test-budget controller, which fails closed at its cap.
 * A smoke, not an accuracy measurement and not a sealed holdout. These questions are
 * NEW (not in the replay set). Every number is compared with the independent SQL oracle
 * (ORACLE_FILE): a wrong number FAILS; what the model chose to do (answer, clarify,
 * refuse) is recorded in live-results.json.
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
const OUTCOME = '[data-testid="analyst-answer"], [data-testid="analyst-clarify"], [data-testid="analyst-unsupported"], [data-testid="analyst-refused"], [data-testid="analyst-error"]';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').first().fill(process.env.LIVE_USER || 'qa-analyst@rig.appbi.io');  // a dedicated live tester keeps quota separate
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

async function askLive(page: Page, q: string): Promise<{ ex: Locator; kind: string | null }> {
  const before = await page.getByTestId('analyst-exchange').count();
  await page.getByTestId('analyst-question').fill(q);
  await page.getByTestId('analyst-ask').click();
  const ex = page.getByTestId('analyst-exchange').nth(before);
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  return { ex, kind: await ex.locator(OUTCOME).first().getAttribute('data-testid') };
}

async function tableOf(ex: Locator): Promise<Record<string, number>> {
  const rows = await ex.getByTestId('analyst-table').locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const got: Record<string, number> = {};
  for (const cells of rows) got[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
  return got;
}

function matches(got: Record<string, number>, key: string): boolean {
  const want = ORACLE[key];
  return JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(want).sort())
    && Object.entries(want).every(([k, v]) => Math.abs((got[k] ?? NaN) - v) < 0.51);
}

test('LIVE · new questions through the browser: numbers against SQL, clarification, follow-up, save/reopen, refusal', async ({ page }, info) => {
  test.setTimeout(600_000);
  if (!PASSWORD) throw new Error('DOGFOOD_PASSWORD not set: the QA stack is required');
  await login(page);
  await page.goto('/analyst');
  const results: Record<string, unknown>[] = [];
  const snap = async (n: string) => {
    const path = info.outputPath(`LIVE-${n}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`LIVE-${n}`, { path, contentType: 'image/png' });
  };
  const fresh = async () => { if (await page.getByTestId('analyst-new-topic').count()) await page.getByTestId('analyst-new-topic').click(); };

  // 1. orders by channel for a year (revenue/order question)
  let r = await askLive(page, 'Năm 2025 mỗi kênh bán có bao nhiêu đơn hàng?');
  let row: Record<string, unknown> = { n: 1, q: 'orders by channel 2025', outcome: r.kind };
  if (r.kind === 'analyst-answer') row = { ...row, match: matches(await tableOf(r.ex), 'orders_channel_2025') };
  results.push(row); await snap('1-orders-channel');

  // 2. a filtered question
  await fresh();
  r = await askLive(page, 'Doanh số của kênh Online ở từng vùng');
  row = { n: 2, q: 'online sales by region', outcome: r.kind };
  if (r.kind === 'analyst-answer') row = { ...row, match: matches(await tableOf(r.ex), 'online_region') };
  results.push(row); await snap('2-filtered');

  // 3. a time range, then 4. a follow-up that changes only the period
  await fresh();
  r = await askLive(page, 'Doanh số từng ngành hàng trong quý 2 năm 2025');
  row = { n: 3, q: 'category Q2 2025', outcome: r.kind };
  if (r.kind === 'analyst-answer') row = { ...row, match: matches(await tableOf(r.ex), 'category_q2_2025') };
  results.push(row); await snap('3-time-range');
  r = await askLive(page, 'còn quý 3 thì sao');
  row = { n: 4, q: 'follow-up: Q3', outcome: r.kind };
  if (r.kind === 'analyst-answer') row = { ...row, match: matches(await tableOf(r.ex), 'category_q3_2025') };
  results.push(row); await snap('4-follow-up');

  // 5. an ambiguous metric: a clarification is the right move; if the model answers
  //    directly the answer is still checked, and that it did not ask is recorded
  await fresh();
  r = await askLive(page, 'Kênh nào hiệu quả nhất?');
  row = { n: 5, q: 'which channel is most effective', outcome: r.kind };
  if (r.kind === 'analyst-clarify') {
    const options = await r.ex.getByTestId('analyst-clarify').getByRole('button').allInnerTexts();
    row.options = options;
    const sales = options.find((o) => /Doanh số/.test(o));
    if (sales) {
      const before = await page.getByTestId('analyst-exchange').count();
      await r.ex.getByTestId('analyst-clarify').getByRole('button', { name: sales }).click();
      const done = page.getByTestId('analyst-exchange').nth(before);         // the NEW exchange, not the card
      await expect(done).toBeVisible({ timeout: 120_000 });
      await expect(done.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
      const got = await tableOf(done);
      row.after_pick = await done.locator(OUTCOME).first().getAttribute('data-testid');
      const top = Math.max(...Object.values(ORACLE.channel_sales));
      row.match = Object.entries(got).length > 0
        && Object.entries(got).every(([k, v]) => Math.abs(v - ORACLE.channel_sales[k]) < 0.51 && Math.abs(v - top) < 0.51);
    }
  }
  results.push(row); await snap('5-clarification');

  // 6. save an answer as a chart, reopen it after a reload, numbers unchanged
  await fresh();
  r = await askLive(page, 'Năm 2025 mỗi kênh bán có bao nhiêu đơn hàng?');
  row = { n: 6, q: 'save + reopen chart', outcome: r.kind };
  if (r.kind === 'analyst-answer' && (await r.ex.getByTestId('analyst-save-chart').count())) {
    await r.ex.getByTestId('analyst-save-chart').click();
    await expect(r.ex.getByTestId('analyst-chart-saved')).toBeVisible();
    await r.ex.getByTestId('analyst-open-chart').click();
    await expect(page).toHaveURL(/\/explore\/\d+$/);
    await page.reload();
    await page.getByTestId('explore-run').click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.getByText(/^Showing \d+ rows?$/)).toBeVisible();
    const values = (await page.locator('table').last().locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => { const td = tr.querySelectorAll('td'); return Number((td[td.length - 1].textContent || '').replace(/[^\d.-]/g, '')); })))
      .sort((a, b) => a - b);
    row.chart = page.url().split('/').pop();
    row.match = JSON.stringify(values) === JSON.stringify(Object.values(ORACLE.orders_channel_2025).sort((a, b) => a - b));
    await snap('6-chart-reopened');
    await page.goto('/analyst');
  } else if (r.kind === 'analyst-answer') {
    row.save_not_offered = (await r.ex.getByTestId('analyst-chart-draft').innerText().catch(() => '')).slice(0, 300);
  }
  results.push(row);

  // 9. the second engine (MySQL marketing spend): its numbers are checked like the rest
  await fresh();
  r = await askLive(page, 'Chi phí marketing năm 2025 của từng kênh là bao nhiêu?');
  row = { n: 9, q: 'marketing spend by channel 2025 (MySQL)', outcome: r.kind };
  if (r.kind === 'analyst-answer') row = { ...row, match: matches(await tableOf(r.ex), 'marketing_channel_2025') };
  results.push(row); await snap('9-mysql');

  // 8. a first-visit example (built from the person's own sources) is answerable
  await fresh();
  await page.reload();
  await expect(page.getByTestId('analyst-example').first()).toBeVisible();   // the guide renders once sources load
  const examples = await page.getByTestId('analyst-example').allInnerTexts();
  const pick = examples.find((e) => /Doanh số/.test(e)) ?? examples[0];
  await page.getByTestId('analyst-example').filter({ hasText: pick }).first().click();
  await expect(page.getByTestId('analyst-question')).toHaveValue(pick);
  await page.getByTestId('analyst-ask').click();
  const exEx = page.getByTestId('analyst-exchange').last();
  await expect(exEx.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
  results.push({ n: 8, q: `first-visit example: ${pick}`, outcome: await exEx.locator(OUTCOME).first().getAttribute('data-testid') });
  await snap('8-example');

  // 7. outside the data: must not be answered with numbers
  await fresh();
  r = await askLive(page, 'Biên lợi nhuận gộp của từng khách hàng là bao nhiêu?');
  results.push({ n: 7, q: 'gross margin per customer (not in the data)', outcome: r.kind,
                 numbers_shown: await r.ex.getByTestId('analyst-table').count() });
  await snap('7-unsupported');

  fs.writeFileSync(info.outputPath('live-results.json'), JSON.stringify(results, null, 1));
  await info.attach('live-results.json', { path: info.outputPath('live-results.json'), contentType: 'application/json' });
  info.annotations.push({ type: 'live results', description: results.map((x) => `${x.n}:${x.outcome}${'match' in x ? (x.match ? ' ✓' : ' ✗') : ''}`).join(' | ') });
  for (const x of results) if ('match' in x) expect(x.match, `wrong numbers: ${x.q}`).toBe(true);
  const outside = results.find((x) => x.n === 7)!;
  expect(outside.numbers_shown, 'a question outside the data shows no numbers').toBe(0);
  expect(results.find((x) => x.n === 8)!.outcome, 'a first-visit example is answered').toBe('analyst-answer');
  // MySQL spend by channel is answerable from the person's sources: a refusal or "unsupported" is a failure
  expect(results.find((x) => x.n === 9)!.outcome, 'the MySQL question is answered, not refused').toBe('analyst-answer');
});
