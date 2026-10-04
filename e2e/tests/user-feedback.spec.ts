import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API } from './_helpers';

/**
 * User-feedback closure (fixture: backend/scripts/ci/seed_e2e_data_state.py
 * `_feedback_fixture`, public token `e2e-feedback-exec`).
 *
 *  FEEDBACK-03  "nút filter và sort bị đè lên nhau nên không bấm được sort" —
 *               the column filter sat absolutely ON the sort arrow of long
 *               headers and, invisible until hover, swallowed the click.
 *  FEEDBACK-01  "PDF 4 ô đầu căn khá lệch" — on the REAL worker the four KPI
 *               values must share one baseline with equal gaps, and the full-data
 *               export must print every table row and column.
 *  FEEDBACK-02  "export editable" — the PowerPoint export is a real, parseable
 *               deck with editable KPI text and a native table.
 */

const TOKEN = 'e2e-feedback-exec';
const TABLE_TITLE = 'Chi tiết đơn hàng';

async function dashboardIdByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/dashboards/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.dashboards ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dashboard ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  return Number(found.id);
}

function detailTable(page: Page): Locator {
  return page.locator('[data-grid-item-id]').filter({ hasText: TABLE_TITLE }).locator('table').first();
}

const overlap = (a: { x: number; y: number; width: number; height: number } | null,
                 b: { x: number; y: number; width: number; height: number } | null) =>
  !a || !b ? 0
    : Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

async function assertSeparateHitAreas(page: Page) {
  const ths = detailTable(page).locator('thead th');
  const n = await ths.count();
  expect(n).toBeGreaterThanOrEqual(9);
  for (let i = 0; i < n; i++) {
    const th = ths.nth(i);
    await th.scrollIntoViewIfNeeded();
    // Selectors that also exist in the pre-fix markup, so this check fails on
    // the overlap itself, not on a missing test id.
    const sort = await th.locator('[data-testid="table-sort-indicator"], span.shrink-0').first().boundingBox();
    const filter = await th.locator('button[aria-label^="Filter"]').boundingBox();
    const resize = await th.locator('button[aria-label^="Resize"]').boundingBox();
    expect(overlap(sort, filter), `column ${i}: filter covers the sort arrow`).toBe(0);
    expect(overlap(filter, resize), `column ${i}: resize strip covers the filter`).toBe(0);
  }
}

async function sortAndFilterLongHeader(page: Page) {
  const table = detailTable(page);
  const th = table.locator('thead th').filter({ hasText: 'customer_' }).first();
  await th.scrollIntoViewIfNeeded();
  const channelIndex = await th.evaluate((el) => Array.from(el.parentElement!.children).indexOf(el));
  const firstChannel = () => table.locator('tbody tr').first().locator('td').nth(channelIndex).innerText();

  // Click EXACTLY where the user sees the sort arrow.
  const arrow = th.locator('[data-testid="table-sort-indicator"], span.shrink-0').first();
  await arrow.click();
  await expect(th).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(firstChannel).toBe('Direct');
  await arrow.click();
  await expect(th).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(firstChannel).toBe('Referral partner program');

  // The filter opens its own popover and does not touch the sort.
  const filter = th.locator('button[aria-label^="Filter"]');
  await th.hover();
  await filter.click();
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  await expect(th).toHaveAttribute('aria-sort', 'descending');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(filter).toHaveAttribute('aria-expanded', 'false');

  // …and sort is still clickable afterwards (third click clears it).
  await arrow.click();
  await expect(th).toHaveAttribute('aria-sort', 'none');

  // Keyboard users can sort too.
  await th.focus();
  await page.keyboard.press('Enter');
  await expect(th).toHaveAttribute('aria-sort', 'ascending');
}

for (const width of [1440, 1024, 820, 390]) {
  test(`public table: sort and filter have separate hit areas @${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/d/${TOKEN}`);
    await expect(detailTable(page)).toBeVisible({ timeout: 60_000 });
    await assertSeparateHitAreas(page);
    await sortAndFilterLongHeader(page);
  });
}

test('builder table: sort and filter have separate hit areas', async ({ page, request }) => {
  test.setTimeout(120_000);
  const id = await dashboardIdByName(request, 'E2E feedback executive');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expect(detailTable(page)).toBeVisible({ timeout: 60_000 });
  await assertSeparateHitAreas(page);
  await sortAndFilterLongHeader(page);
});

// ── Real PDF worker: first-row geometry + full data ─────────────────────────

const PDF_PARSER = [
  'import fitz, json, re, sys',
  'doc = fitz.open(sys.argv[1])',
  'out = {"pages": len(doc), "spans": [], "text": ""}',
  'for pi, page in enumerate(doc):',
  '    out["text"] += page.get_text() + "\\n"',
  '    for b in page.get_text("dict")["blocks"]:',
  '        for l in b.get("lines", []):',
  '            for s in l["spans"]:',
  '                t = s["text"].strip()',
  '                if re.fullmatch(r"8[.,]0B|920|1[.,]6B|0[.,]2", t):',
  '                    out["spans"].append({"page": pi, "text": t, "bbox": s["bbox"], "size": s["size"]})',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');

async function serverPdf(request: APIRequestContext, layout: string, orientation: string, path: string) {
  const base = `${API}/api/v1/public/dashboards/${TOKEN}/exports`;
  const create = await request.post(base, {
    data: { pages: ['p1'], orientation, page_format: 'a4', layout, filters: [] },
  });
  expect(create.status(), await create.text()).toBe(202);
  const created = await create.json();
  let job: any = created;
  await expect.poll(async () => {
    job = await (await request.get(`${base}/${created.id}`)).json();
    return job.status;
  }, { timeout: 150_000, intervals: [1_000, 2_000, 3_000] }).toBe('succeeded');
  const dl = await request.get(`${base}/${created.id}/download?dl=${encodeURIComponent(job.download_token)}`);
  expect(dl.status()).toBe(200);
  const bytes = Buffer.from(await dl.body());
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  fs.writeFileSync(path, bytes);
  return JSON.parse(execFileSync('python', ['-c', PDF_PARSER, path], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })) as { pages: number; text: string; spans: Array<{ page: number; text: string; bbox: number[]; size: number }> };
}

for (const orientation of ['landscape', 'portrait']) {
  test(`real PDF worker: the four KPI values are one aligned row, every row and column prints (${orientation})`, async ({ request }, testInfo) => {
    test.setTimeout(240_000);
    const caps = await request.get(`${API}/api/v1/public/dashboards/${TOKEN}/exports/capabilities`);
    expect((await caps.json()).server_engine, 'the real PDF worker must be running').toBe(true);
    const pdf = await serverPdf(request, 'tiled', orientation, testInfo.outputPath(`feedback-${orientation}.pdf`));

    // Biggest occurrence of each value = the KPI card (bar labels are smaller).
    const kpi = ['8.0B', '920', '1.6B', '0.2'].map((v) => {
      const hits = pdf.spans.filter((s) => s.text.replace(',', '.') === v && s.page === 0);
      expect(hits.length, `KPI value ${v} on page 1`).toBeGreaterThan(0);
      return hits.sort((a, b) => b.size - a.size)[0];
    }).sort((a, b) => a.bbox[0] - b.bbox[0]);
    const tops = kpi.map((s) => s.bbox[1]);
    expect(Math.max(...tops) - Math.min(...tops), `KPI values at different heights: ${tops}`).toBeLessThanOrEqual(1.5);
    const sizes = kpi.map((s) => s.size);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(0.5);
    const lefts = kpi.map((s) => s.bbox[0]);
    const steps = lefts.slice(1).map((x, i) => x - lefts[i]);
    expect(Math.max(...steps) - Math.min(...steps), `uneven KPI columns: ${steps}`).toBeLessThanOrEqual(2);

    // "Keep dashboard layout" promises every row AND every column.
    for (const header of ['sales_', 'profit_', 'customer_']) expect(pdf.text).toContain(header);
    expect(pdf.text).toContain('Nhân viên 4'); // row 40's owner (40 % 6 = 4)
    const ids = pdf.text.split('\n').map((l) => l.trim()).filter((l) => /^\d{1,2}$/.test(l)).map(Number);
    expect(ids).toEqual(expect.arrayContaining([1, 20, 39, 40]));
  });
}

// ── Editable PowerPoint ─────────────────────────────────────────────────────

const PPTX_PARSER = [
  'import json, sys',
  'from pptx import Presentation',
  'prs = Presentation(sys.argv[1])',
  'out = {"slides": len(prs.slides), "texts": [], "tables": [], "pictures": 0, "overflow": 0}',
  'for s in prs.slides:',
  '    for sh in s.shapes:',
  '        if sh.top + sh.height > prs.slide_height: out["overflow"] += 1',
  '        if sh.shape_type == 13: out["pictures"] += 1',
  '        if sh.has_table: out["tables"].append([c.text for c in sh.table.rows[0].cells])',
  '        elif sh.has_text_frame and sh.text_frame.text: out["texts"].append(sh.text_frame.text)',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');

test('PowerPoint export: a real deck with editable KPI text, a native table and chart pictures', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/d/${TOKEN}`);
  await expect(detailTable(page)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('public-export-open').first().click();
  await page.getByTestId('export-filetype-pptx').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pptx$/);
  const path = testInfo.outputPath('feedback.pptx');
  await download.saveAs(path);
  const deck = JSON.parse(execFileSync('python', ['-c', PPTX_PARSER, path], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }));
  expect(deck.slides).toBeGreaterThanOrEqual(1);
  expect(deck.overflow, 'a block runs off its slide').toBe(0);
  for (const t of ['E2E feedback executive', 'Tổng quan', 'Doanh thu', '8.0B', '920', '1.6B', 'Lợi nhuận gộp (VND)']) {
    expect(deck.texts, `editable text "${t}"`).toContain(t);
  }
  expect(deck.tables.length).toBe(1);
  expect(deck.tables[0]).toEqual(expect.arrayContaining(['customer_acquisition_channel', 'doanh_thu_thuan_theo_khu_vuc']));
  expect(deck.pictures).toBeGreaterThanOrEqual(2); // the bar and the trend
});

// ── Builder "Arrange it yourself" ───────────────────────────────────────────

test('builder Arrange-it-yourself is populated and its PDF contains every tile', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const id = await dashboardIdByName(request, 'E2E feedback executive');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expect(detailTable(page)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('dashboard-more').click();
  await page.getByRole('button', { name: /PowerPoint/ }).first().click();
  await page.getByRole('button', { name: /Arrange it yourself|Tự sắp bố cục/ }).click();
  await page.getByRole('button', { name: /^(Arrange…|Sắp xếp…)$/ }).click();
  await expect(page.getByText(/·\s*7\s*(items|ô)/)).toBeVisible({ timeout: 30_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180_000 }),
    page.getByRole('button', { name: /Export \d+ sheet|Xuất \d+ tờ/ }).click(),
  ]);
  const path = testInfo.outputPath('builder-custom.pdf');
  await download.saveAs(path);
  const parsed = JSON.parse(execFileSync('python', ['-c', [
    'import fitz, json, sys',
    'd = fitz.open(sys.argv[1])',
    'print(json.dumps({"images": sum(len(p.get_images()) for p in d), "text": "".join(p.get_text() for p in d)}, ensure_ascii=False))',
  ].join('\n'), path], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  expect(parsed.images).toBeGreaterThanOrEqual(7);
  expect(parsed.text).not.toMatch(/Không tìm thấy biểu đồ|not found on the report/i);
});
