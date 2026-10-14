import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';

async function dashboardByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/dashboards/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.dashboards ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dashboard ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  const detail = await request.get(`${API}/api/v1/dashboards/${found.id}`);
  expect(detail.status(), await detail.text()).toBe(200);
  return detail.json();
}

async function datasetByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/datasets/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.datasets ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dataset ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  const detail = await request.get(`${API}/api/v1/datasets/${found.id}`);
  expect(detail.status(), await detail.text()).toBe(200);
  return detail.json();
}

test('exact 007 replay keeps KPI, bar and table in one North page scope', async ({ page, request }) => {
  test.setTimeout(120_000);
  const dashboard = await dashboardByName(request, 'E2E closure original 007');
  const chartIds = dashboard.dashboard_charts
    .filter((item: any) => item.layout?.pageId === 'a')
    .map((item: any) => Number(item.chart_id));
  expect(chartIds).toHaveLength(4);

  const chartRequests: Array<{ chartId: number; filters: any[] }> = [];
  page.on('request', req => {
    const match = req.url().match(/\/charts\/(\d+)\/data(?:\?|$)/);
    if (!match || !chartIds.includes(Number(match[1]))) return;
    const raw = new URL(req.url()).searchParams.get('filters');
    chartRequests.push({ chartId: Number(match[1]), filters: raw ? JSON.parse(raw) : [] });
  });

  await page.goto(`/dashboards/${dashboard.id}`);
  await expect(page.getByText('E2E 007 A Total').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new Set(chartRequests.map(item => item.chartId)).size, { timeout: 60_000 }).toBe(4);

  for (const chartId of chartIds) {
    const last = chartRequests.filter(item => item.chartId === chartId).at(-1);
    expect(last, `chart ${chartId} must issue a data request`).toBeTruthy();
    expect(last!.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'region', operator: 'eq', value: 'North' }),
    ]));
  }

  const kpi = page.locator('[data-grid-item-id]').filter({ hasText: 'E2E 007 A Total' });
  await expect(kpi).toContainText('610');
  await expect(kpi).not.toContainText(/skipped/i);
  const bar = page.locator('[data-grid-item-id]').filter({ hasText: 'E2E 007 A Region' });
  await expect(bar).toContainText('North');
  const table = page.locator('[data-grid-item-id]').filter({ hasText: 'E2E 007 A Detail' });
  await expect(table).toContainText('North');
  await expect(table).not.toContainText('South');
});

test('public relative-date batch sends one anchor and renders its hand-computed value', async ({ page }) => {
  test.setTimeout(90_000);
  const anchor = `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`;
  let batch: { headers: Record<string, string>; body: any } | null = null;
  page.on('request', req => {
    if (!req.url().includes('/public/dashboards/e2e-closure-pdf/charts/data')) return;
    batch = { headers: req.headers(), body: req.postDataJSON() };
  });

  await page.goto(`/d/e2e-closure-pdf?asOf=${encodeURIComponent(anchor)}`);
  const tile = page.locator('[data-grid-item-id]').filter({ hasText: 'E2E PDF A Today' });
  await expect(tile).toContainText('300', { timeout: 60_000 });
  await expect.poll(() => batch, { timeout: 30_000 }).not.toBeNull();

  expect(batch!.headers['x-appbi-as-of']).toBe(anchor);
  expect(batch!.body.items).toHaveLength(1);
  expect(batch!.body.items[0].filters).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'day', datePreset: 'today' }),
    expect.objectContaining({ field: 'page_code', value: 'A' }),
  ]));
});

test('actual XLSX route preserves dates, numbers, Unicode and formula-like source text', async ({ request }, testInfo) => {
  test.setTimeout(90_000);
  const dataset = await datasetByName(request, 'E2E closure original 007');
  expect(dataset.tables).toHaveLength(1);
  const response = await request.get(
    `${API}/api/v1/datasets/${dataset.id}/tables/${dataset.tables[0].id}/export/excel`,
  );
  const status = response.status();
  if (status !== 200) throw new Error(`XLSX export failed (${status}): ${await response.text()}`);
  const bytes = Buffer.from(await response.body());
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
  const xlsxPath = testInfo.outputPath('closure-sales.xlsx');
  fs.writeFileSync(xlsxPath, bytes);

  const parser = [
    'import json, sys',
    'from openpyxl import load_workbook',
    'book = load_workbook(sys.argv[1], data_only=False)',
    'sheet = book[book.sheetnames[0]]',
    'rows = list(sheet.iter_rows())',
    'headers = [cell.value for cell in rows[0]]',
    'body = [[cell.value.isoformat() if hasattr(cell.value, "isoformat") else cell.value for cell in row] for row in rows[1:]]',
    'types = [[cell.data_type for cell in row] for row in rows[1:]]',
    'print(json.dumps({"headers": headers, "body": body, "types": types}, ensure_ascii=False))',
  ].join('\n');
  const parsed = JSON.parse(execFileSync('python', ['-c', parser, xlsxPath], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }));
  expect(parsed.headers).toEqual(expect.arrayContaining(['day', 'region', 'amount', 'note']));
  const dayIndex = parsed.headers.indexOf('day');
  const amountIndex = parsed.headers.indexOf('amount');
  const noteIndex = parsed.headers.indexOf('note');
  const datedRow = parsed.body.findIndex((row: any[]) => String(row[dayIndex]).startsWith('2026-03-14'));
  expect(datedRow).toBeGreaterThanOrEqual(0);
  expect(parsed.types[datedRow][dayIndex]).toBe('d');
  expect(parsed.body.some((row: any[]) => row[amountIndex] === -25)).toBe(true);
  expect(parsed.body.some((row: any[]) => row[noteIndex] === 'Áo thun')).toBe(true);
  const formulaRow = parsed.body.findIndex((row: any[]) => row[noteIndex] === '=SUM(A1)');
  expect(formulaRow).toBeGreaterThanOrEqual(0);
  expect(parsed.types[formulaRow][noteIndex]).toBe('s');
});

test('real PDF worker renders three ordered relative-date pages with actual values', async ({ request }, testInfo) => {
  test.setTimeout(180_000);
  const capabilities = await request.get(`${API}/api/v1/public/dashboards/e2e-closure-pdf/exports/capabilities`);
  expect(capabilities.status(), await capabilities.text()).toBe(200);
  expect((await capabilities.json()).server_engine, 'CI/local closure stack must run the real PDF worker').toBe(true);

  const create = await request.post(`${API}/api/v1/public/dashboards/e2e-closure-pdf/exports`, {
    data: { pages: ['a', 'b', 'c'], orientation: 'landscape', page_format: 'a4', layout: 'snapshot', filters: [] },
  });
  expect(create.status(), await create.text()).toBe(202);
  const created = await create.json();
  let job: any = created;
  await expect.poll(async () => {
    const status = await request.get(`${API}/api/v1/public/dashboards/e2e-closure-pdf/exports/${created.id}`);
    expect(status.status(), await status.text()).toBe(200);
    job = await status.json();
    return job.status;
  }, { timeout: 150_000, intervals: [1_000, 2_000, 3_000] }).toBe('succeeded');

  expect(job.page_count).toBe(3);
  expect(job.file_size).toBeGreaterThan(10_000);
  expect(job.warnings ?? []).toEqual([]);
  expect(job.download_token).toBeTruthy();

  const download = await request.get(
    `${API}/api/v1/public/dashboards/e2e-closure-pdf/exports/${created.id}/download?dl=${encodeURIComponent(job.download_token)}`,
  );
  const downloadStatus = download.status();
  if (downloadStatus !== 200) {
    throw new Error(`PDF download failed (${downloadStatus}): ${await download.text()}`);
  }
  expect(downloadStatus).toBe(200);
  const bytes = Buffer.from(await download.body());
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const pdfPath = testInfo.outputPath('closure-relative-three-pages.pdf');
  fs.writeFileSync(pdfPath, bytes);

  const renderDir = testInfo.outputPath('rendered-pages');
  fs.mkdirSync(renderDir, { recursive: true });
  const parser = [
    'import fitz, json, pathlib, sys',
    'doc = fitz.open(sys.argv[1])',
    'out_dir = pathlib.Path(sys.argv[2])',
    'result = []',
    'for index, page in enumerate(doc):',
    '    pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)',
    '    pix.save(out_dir / f"page-{index + 1}.png")',
    '    result.append({"text": page.get_text() or "", "width": pix.width, "height": pix.height, "nonwhite": sum(value < 245 for value in pix.samples)})',
    'print(json.dumps(result, ensure_ascii=False))',
  ].join('\n');
  const parsed: Array<{ text: string; width: number; height: number; nonwhite: number }> = JSON.parse(
    execFileSync('python', ['-c', parser, pdfPath, renderDir], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }),
  );
  const pages = parsed.map(page => page.text);
  expect(pages).toHaveLength(3);
  expect(pages[0]).toContain('A — Bắc Áo');
  expect(pages[0]).toContain('300');
  expect(pages[1]).toContain('B — Nam Bộ');
  expect(pages[1]).toContain('70');
  expect(pages[2]).toContain('C — Tổng cộng');
  expect(pages[2]).toContain('350');
  for (const pageText of pages) {
    expect(pageText).toMatch(/Xuất lúc/);
    expect(pageText.trim().length).toBeGreaterThan(30);
  }
  for (const rendered of parsed) {
    expect(rendered.width).toBeGreaterThan(1_000);
    expect(rendered.height).toBeGreaterThan(700);
    expect(rendered.nonwhite).toBeGreaterThan(1_000);
  }
});
