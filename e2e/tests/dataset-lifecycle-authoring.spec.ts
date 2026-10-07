import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';

/**
 * J1 — Dataset authoring in the real UI, every step read back from the API.
 *
 * Create dataset → add a physical table → Preview → calculated column →
 * Hide a column the calculated column uses (Hide is VISIBILITY: the formula
 * keeps computing, the field leaves the model's pickers) → Query Table →
 * Calculated Table → measure → reload: everything persisted, no stale UI.
 *
 * Source: the `products` table of seed_e2e_dataset_lifecycle.py
 * (A 5×2, B 7×3, C 11×1). Runs everywhere (no snapshot host needed).
 */
const NAME = 'E2E authoring journey';
const SOURCE = 'E2E dataset-lifecycle Postgres';

async function api(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}/api/v1${path}`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function tableByName(request: APIRequestContext, id: number, name: string) {
  const tables = await api(request, `/datasets/${id}/tables`);
  return (Array.isArray(tables) ? tables : tables.items ?? []).find((t: any) =>
    t.display_name === name || String(t.source_table_name ?? '').endsWith(`.${name}`));
}

async function columnValues(page: Page, header: RegExp): Promise<string[]> {
  // One snapshot of the grid (headers + cells read together) — the grid
  // re-renders while a table switches, so per-index reads race it.
  return page.evaluate(({ src, flags }) => {
    const re = new RegExp(src, flags);
    const heads = Array.from(document.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
    const idx = heads.findIndex((h) => re.test(h));
    if (idx === -1) return [];
    return Array.from(document.querySelectorAll(`tbody tr td:nth-child(${idx + 1})`))
      .map((td) => (td.textContent || '').trim());
  }, { src: header.source, flags: header.flags });
}

test.describe('Dataset authoring', () => {
  test.describe.configure({ mode: 'serial' });
  let id = 0;

  test.afterAll(async ({ request }) => {
    if (id) await request.delete(`${API}/api/v1/datasets/${id}`);
  });

  test('J1 author a dataset in the UI and find it intact after a reload', async ({ page, request }) => {
    test.setTimeout(300_000);
    for (const d of (await api(request, '/datasets/')) as any[]) {
      if (d.name === NAME) await request.delete(`${API}/api/v1/datasets/${d.id}`);
    }

    // 1) create
    await page.goto('/datasets');
    await page.getByRole('button', { name: /^(New Dataset|Tạo dataset)$/ }).first().click();
    await page.locator('#name').fill(NAME);
    await page.getByRole('button', { name: /^Create Dataset$/ }).last().click();
    await expect.poll(async () => ((await api(request, '/datasets/')) as any[]).find((d) => d.name === NAME)?.id,
      { timeout: 20_000 }).toBeTruthy();
    id = ((await api(request, '/datasets/')) as any[]).find((d) => d.name === NAME).id;
    if (!page.url().includes(`/datasets/${id}`)) await page.goto(`/datasets/${id}`);

    // 2) add the physical table `products`
    await page.getByRole('button', { name: /^Source/ }).locator('xpath=..').getByRole('button', { name: /^(Add|Thêm)$/ })
      .click();
    await page.getByRole('button', { name: /^From Table$/ }).click();
    const sources = await api(request, '/datasources/');
    const sourceId = String((Array.isArray(sources) ? sources : sources.items).find((d: any) => d.name === SOURCE).id);
    await page.locator('select:visible').filter({ hasText: /Choose a datasource/ }).first().selectOption(sourceId);
    await page.getByPlaceholder(/Search tables/).last().fill('products');
    await page.getByRole('button', { name: /products/ }).last().click();
    await page.getByRole('button', { name: /^Add (Table|1 Tables?)$/ }).click();
    await expect.poll(async () => Boolean(await tableByName(request, id, 'products')), { timeout: 20_000 }).toBe(true);

    // 3) preview shows the real source rows
    await page.getByText(/^(e2e_dslife\.)?products$/).first().click();
    await expect.poll(async () => (await columnValues(page, /^SKU/i)).sort(), { timeout: 30_000 })
      .toEqual(['A', 'B', 'C']);

    // 4) calculated column revenue = price × qty. Creating one from the grid is
    //    switched off product-wide (ADD_COLUMN_ENABLED = false — being reworked), so
    //    the same persisted step the modal writes goes through the table-update API.
    const created = await tableByName(request, id, 'products');
    const put = await request.put(`${API}/api/v1/datasets/${id}/tables/${created.id}`, { data: {
      transformations: [{ type: 'add_column', enabled: true,
                          params: { newField: 'revenue', expression: '[price] * [qty]' } }] } });
    expect(put.status(), await put.text()).toBeLessThan(300);
    await page.reload();
    await page.getByText(/^(e2e_dslife\.)?products$/).first().click();
    await expect.poll(async () => (await columnValues(page, /^REVENUE/i)).map(Number).sort((a, b) => a - b),
      { timeout: 30_000 }).toEqual([10, 11, 21]);

    // 5) HIDE price (used by revenue) → revenue still computes; price is hidden in the model
    await page.getByRole('button', { name: /^(Columns|Cột)$/ }).click();
    await page.locator('label').filter({ hasText: /^price$/ }).locator('input[type=checkbox]')
      .uncheck();
    await page.getByRole('button', { name: /^(Apply|Áp dụng)$/ }).click();
    await expect.poll(async () => (await tableByName(request, id, 'products')).transformations
      .map((t: any) => t.type), { timeout: 20_000 }).toContain('hide_columns');
    const products = await tableByName(request, id, 'products');
    expect(products.transformations.map((t: any) => t.type), 'Hide never projects the column away')
      .not.toContain('select_columns');
    await page.reload();
    await page.getByText(/^(e2e_dslife\.)?products$/).first().click();
    await expect.poll(async () => (await columnValues(page, /^REVENUE/i)).map(Number).sort((a, b) => a - b),
      { timeout: 30_000 }).toEqual([10, 11, 21]);
    const gen = await request.post(`${API}/api/v1/datasets/${id}/generate-model`);
    expect(gen.status(), await gen.text()).toBeLessThan(300);
    const model = await api(request, `/datasets/${id}/model`);
    const view = (model.views ?? []).find((v: any) => v.dataset_table_id === products.id);
    const price = (view?.dimensions ?? []).find((d: any) => d.name === 'price');
    expect(price?.hidden, 'price is hidden from field pickers, not removed').toBe(true);
    const revenue = (view?.dimensions ?? []).find((d: any) => d.name === 'revenue');
    expect(revenue?.hidden, 'the calculated column over the hidden one stays visible').toBe(false);
  });

  test('J1b Query Table and Calculated Table from their UI tabs', async ({ page, request }) => {
    test.setTimeout(240_000);
    expect(id, 'J1 created the dataset').toBeTruthy();
    await page.goto(`/datasets/${id}`);

    // Query Table (advanced SQL) on the real source
    await page.getByRole('button', { name: /^Source/ }).locator('xpath=..').getByRole('button', { name: /^(Add|Thêm)$/ })
      .click();
    await page.getByRole('button', { name: /^From SQL Query$/ }).click();
    const sources = await api(request, '/datasources/');
    const sourceId = String((Array.isArray(sources) ? sources : sources.items).find((d: any) => d.name === SOURCE).id);
    await page.locator('select:visible').filter({ has: page.locator(`option[value="${sourceId}"]`) }).last()
      .selectOption(sourceId);
    await page.getByPlaceholder(/.+/).filter({ hasNot: page.locator('textarea') })
      .and(page.locator('input:visible')).last().fill('category_revenue');
    const advanced = page.getByRole('button', { name: /advanced SQL|SQL nâng cao/ });
    if (await advanced.isVisible().catch(() => false)) await advanced.click();
    await page.locator('.cm-content').last().click();
    await page.keyboard.insertText(
      'SELECT category, SUM(price * qty) AS revenue FROM e2e_dslife.products GROUP BY category');
    await page.getByRole('button', { name: /^(Add table|Thêm bảng)$/ }).last().click();
    await expect.poll(async () => (await tableByName(request, id, 'category_revenue'))?.source_kind,
      { timeout: 30_000 }).toBe('sql_query');
    await page.getByText(/^category_revenue$/).first().click();
    await expect.poll(async () => (await columnValues(page, /^CATEGORY/i)).sort(), { timeout: 30_000 })
      .toEqual(['books', 'toys']);

    // Calculated Table over the dataset's own products table (alias from the editor's hint)
    await page.getByRole('button', { name: /^Calculated/ }).locator('xpath=..').getByRole('button', { name: /^(Add|Thêm)$/ })
      .click();
    const status = await api(request, `/datasets/${id}/tables/source-status`);
    // a calculated-column / hide edit is NOT source drift (no false "schema changed")
    expect(status.tables.filter((t: any) => t.code === 'SOURCE_SCHEMA_CHANGED')).toEqual([]);
    await page.getByPlaceholder(/Monthly Revenue|Doanh thu/).fill('line_totals');
    const hint = await page.locator('.cm-placeholder').last().innerText();
    const alias = /FROM\s+([\w.`"]+)/.exec(hint)?.[1];
    expect(alias, `alias in the editor hint: ${hint}`).toBeTruthy();
    const products = await tableByName(request, id, 'products');
    await page.locator('.cm-content').last().click();
    await page.keyboard.insertText(`SELECT sku, revenue FROM ${alias!.replace(/[^.`"]+$/, '')}${
      /dataset_table_\d+/.test(alias!) ? `dataset_table_${products.id}` : alias}`);
    await page.getByRole('button', { name: /^(Create calculated table|Tạo bảng tính toán)$/ }).click();
    await expect.poll(async () => Boolean(await tableByName(request, id, 'line_totals')), { timeout: 30_000 })
      .toBe(true);
    await page.getByText(/^line_totals$/).first().click();
    await expect.poll(async () => (await columnValues(page, /^REVENUE/i)).map(Number).sort((a, b) => a - b),
      { timeout: 30_000 }).toEqual([10, 11, 21]);              // a calculated table reads the calculated column
  });

});
