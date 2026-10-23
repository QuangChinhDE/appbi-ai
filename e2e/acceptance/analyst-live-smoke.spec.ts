import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Live-model smoke through the browser (NOT replay): the real planner, metered by the
 * server's test-budget controller against the one shared ledger (fails closed at the cap).
 * A smoke, not an accuracy measurement: 7 questions, each answer checked against the
 * independent SQL oracle. A wrong number FAILS; a clarification is recorded as such.
 */
const PASSWORD = process.env.DOGFOOD_PASSWORD || '';
const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
const OUTCOME = '[data-testid="analyst-answer"], [data-testid="analyst-clarify"], [data-testid="analyst-unsupported"], [data-testid="analyst-refused"], [data-testid="analyst-error"]';

const QS: { q: string; oracle?: string; followUp?: boolean; mustRefuse?: boolean }[] = [
  { q: 'Doanh số theo vùng', oracle: 'region' },
  { q: 'Tổng doanh số năm 2025', oracle: 'total_2025' },
  { q: 'Doanh số Miền Bắc theo kênh bán năm 2025', oracle: 'north_channel_2025' },
  { q: 'theo ngành hàng thì sao', oracle: 'north_category_2025', followUp: true },
  { q: 'Doanh số không tính đơn bị huỷ năm 2025', oracle: 'not_cancelled_2025' },
  { q: 'Doanh số theo vùng từ 01/03/2025 đến 31/05/2025', oracle: 'region_mar_may_2025' },
  { q: 'Lợi nhuận theo vùng', mustRefuse: true },
];

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').first().fill('qa-analyst@rig.appbi.io');
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

test('LIVE · 7 questions through the browser, numbers against SQL', async ({ page }, info) => {
  if (!PASSWORD) throw new Error('DOGFOOD_PASSWORD not set: the QA stack is required');
  await login(page);
  await page.goto('/analyst');
  const results: Record<string, unknown>[] = [];
  for (const [i, c] of QS.entries()) {
    if (!c.followUp && (await page.getByTestId('analyst-new-topic').count())) await page.getByTestId('analyst-new-topic').click();
    const before = await page.getByTestId('analyst-exchange').count();
    await page.getByTestId('analyst-question').fill(c.q);
    await page.getByTestId('analyst-ask').click();
    const ex = page.getByTestId('analyst-exchange').nth(before);
    await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: 120_000 });
    const kind = await ex.locator(OUTCOME).first().getAttribute('data-testid');
    const row: Record<string, unknown> = { n: i + 1, q: c.q, outcome: kind };
    if (kind === 'analyst-answer' && c.oracle) {
      const rows = await ex.getByTestId('analyst-table').locator('tbody tr').evaluateAll((trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
      const got: Record<string, number> = {};
      for (const cells of rows) got[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
      const want = ORACLE[c.oracle];
      row.match = JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(want).sort())
        && Object.entries(want).every(([k, v]) => Math.abs((got[k] ?? NaN) - v) < 0.51);
      row.got = got;
    }
    results.push(row);
    const path = info.outputPath(`LIVE-${i + 1}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`LIVE-${i + 1} ${c.q}`, { path, contentType: 'image/png' });
  }
  fs.writeFileSync(info.outputPath('live-results.json'), JSON.stringify(results, null, 1));
  await info.attach('live-results.json', { path: info.outputPath('live-results.json'), contentType: 'application/json' });
  info.annotations.push({ type: 'live results', description: results.map((r) => `${r.n}:${r.outcome}${'match' in r ? (r.match ? ' ✓' : ' ✗') : ''}`).join(' | ') });
  // a wrong number is a failure; a refusal must be a refusal
  for (const r of results) if ('match' in r) expect(r.match, `wrong numbers for "${r.q}"`).toBe(true);
  expect(results[6].outcome, 'out-of-scope metric refused').toMatch(/unsupported|refused/);
});
