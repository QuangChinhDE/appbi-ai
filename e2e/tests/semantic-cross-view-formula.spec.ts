import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import { API } from './_helpers';

/**
 * Semantic Kernel v2 — a cross-view derived measure, authored and consumed as an
 * analyst does it, in the real UI against the real engine and warehouse.
 *
 * Source (prepared outside the UI, deterministic): three tables of one source —
 *   sales   (id, rep_id, amount)        Ann 50 + 70 = 120 · Bob 80 + 100 = 180 · total 300
 *   targets (id, rep_id, quarter, target) Ann 100 (Q1) + 200 (Q2) = 300 · Bob 300 (Q1) · total 600
 *   reps    (id, name)                   1 Ann · 2 Bob
 * sales → reps and targets → reps are many-to-one (reps is the conformed dimension).
 *
 * Hand oracles. Attainment = Revenue / Total target, each at its OWN grain:
 *   overall 300 / 600 = 0.5 · Ann 120 / 300 = 0.4 · Bob 180 / 300 = 0.6.
 * The historical JOIN-before-aggregate answer (sales × targets through the rep):
 *   (120·2 + 180·1) / (300·2 + 300·2) = 420 / 1200 = 0.35 — must never be shown.
 * By targets.quarter the formula has no meaning (sales has no quarter): refused.
 *
 * Where the warehouse is: `XV_SOURCE_DS` / `XV_SOURCE_SCHEMA` (the journey's own
 * disposable tables). Without them the journey skips BY NAME: it needs a source the
 * engine can publish from (a BigQuery snapshot host).
 */
const SOURCE_DS = Number(process.env.XV_SOURCE_DS || 0);
const SOURCE_SCHEMA = process.env.XV_SOURCE_SCHEMA || '';
const OUT = process.env.XV_OUT || '';
const NAME = `E2E cross-view formula ${SOURCE_SCHEMA}`;

async function j(res: { status(): number; text(): Promise<string>; json(): Promise<any> }) {
  expect(res.status(), await res.text()).toBeLessThan(300);
  return res.json();
}

async function dump(page: Page, name: string) {
  if (OUT) fs.writeFileSync(`${OUT}/${name}.txt`, await page.locator('body').ariaSnapshot());
}

type World = { id: number; views: Record<string, { id: number; name: string; table: number }> };

function rowsOf(body: any): any[] {
  return Array.isArray(body) ? body : body.items ?? body.charts ?? body.dashboards ?? [];
}

/** A previous run's objects (same name) are removed first — the journey is re-runnable. */
async function clearLeftovers(request: APIRequestContext) {
  for (const d of rowsOf(await j(await request.get(`${API}/api/v1/dashboards/`)))) {
    if (String(d.name).startsWith(NAME)) await request.delete(`${API}/api/v1/dashboards/${d.id}`);
  }
  for (const c of rowsOf(await j(await request.get(`${API}/api/v1/charts/`)))) {
    if (String(c.name).startsWith(NAME)) await request.delete(`${API}/api/v1/charts/${c.id}`);
  }
  for (const d of rowsOf(await j(await request.get(`${API}/api/v1/datasets/`)))) {
    if (d.name === NAME) await request.delete(`${API}/api/v1/datasets/${d.id}`);
  }
}

async function prepare(request: APIRequestContext): Promise<World> {
  await clearLeftovers(request);
  const id = (await j(await request.post(`${API}/api/v1/datasets/`, { data: { name: NAME } }))).id as number;
  for (const t of ['sales', 'targets', 'reps']) {
    await j(await request.post(`${API}/api/v1/datasets/${id}/tables`, { data: {
      datasource_id: SOURCE_DS, source_kind: 'physical_table', source_table_name: `${SOURCE_SCHEMA}.${t}`,
      display_name: t } }));
  }
  const tables = await j(await request.get(`${API}/api/v1/datasets/${id}/tables`));
  const byName: Record<string, number> = {};
  for (const t of (Array.isArray(tables) ? tables : tables.items)) {
    byName[t.display_name] = t.id;
    await j(await request.post(`${API}/api/v1/datasets/${id}/tables/${t.id}/preview`, { data: { limit: 50 } }));
  }
  await j(await request.post(`${API}/api/v1/datasets/${id}/generate-model`));
  const model = await j(await request.get(`${API}/api/v1/datasets/${id}/model`));
  const views: World['views'] = {};
  for (const [name, table] of Object.entries(byName)) {
    const v = model.views.find((x: any) => x.dataset_table_id === table);
    views[name] = { id: v.id, name: v.name, table };
  }
  for (const fact of ['sales', 'targets']) {
    await j(await request.post(`${API}/api/v1/datasets/${id}/model/joins`, { data: {
      from_view_id: views[fact].id, to_view_id: views.reps.id, from_column: 'rep_id', to_column: 'id',
      join_type: 'left', relationship: 'many_to_one' } }));
  }
  return { id, views };
}

async function measuresOf(request: APIRequestContext, w: World, view: string): Promise<any[]> {
  const model = await j(await request.get(`${API}/api/v1/datasets/${w.id}/model`));
  return model.views.find((v: any) => v.id === w.views[view].id)?.measures ?? [];
}

function addMeasureButton(page: Page) {
  return page.getByRole('button', { name: /^Measures \d+/ }).locator('xpath=..').getByRole('button', { name: /^Add$/ });
}

async function pickTable(page: Page, table: string) {
  await page.getByRole('combobox', { name: /Measure sẽ được tạo trên bảng này/ }).selectOption({ label: table });
}

async function save(page: Page) {
  const btn = page.getByRole('button', { name: /^Save$/ }).last();
  await expect(btn).toBeEnabled();
  await btn.click();
}

async function chartRows(request: APIRequestContext, chartId: number): Promise<any[]> {
  const body = await j(await request.get(`${API}/api/v1/charts/${chartId}/data`));
  return body.data ?? [];
}

test.describe('Semantic kernel v2 — cross-view derived measure', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!SOURCE_DS || !SOURCE_SCHEMA, 'needs XV_SOURCE_DS / XV_SOURCE_SCHEMA (a publishable warehouse source)');
  let w: World;
  const charts: Record<string, number> = {};
  let dashboardId = 0;

  test.afterAll(async ({ request }) => {
    if (process.env.XV_KEEP) return;
    if (dashboardId) await request.delete(`${API}/api/v1/dashboards/${dashboardId}`);
    for (const c of Object.values(charts)) await request.delete(`${API}/api/v1/charts/${c}`);
    if (w?.id) await request.delete(`${API}/api/v1/datasets/${w.id}`);
  });

  test('X1 an analyst builds Revenue / Total target across two tables and previews 0.5', async ({ page, request }) => {
    test.setTimeout(300_000);
    w = await prepare(request);
    await page.goto(`/datasets/${w.id}`);

    // two ordinary measures, on two different tables
    await addMeasureButton(page).click();
    await pickTable(page, 'sales');
    await page.getByPlaceholder('Display name').fill('Revenue');
    await page.getByPlaceholder('sql_identifier').fill('revenue');
    await page.getByPlaceholder(/Chọn \/ gõ cột/).click();
    await page.getByRole('button', { name: /^amount$/ }).click();
    await save(page);
    await expect.poll(async () => (await measuresOf(request, w, 'sales')).map((m) => m.name), { timeout: 20_000 })
      .toContain('revenue');

    await addMeasureButton(page).click();
    await pickTable(page, 'targets');
    await page.getByPlaceholder('Display name').fill('Total target');
    await page.getByPlaceholder('sql_identifier').fill('total_target');
    await page.getByPlaceholder(/Chọn \/ gõ cột/).click();
    await page.getByRole('button', { name: /^target$/ }).click();
    await save(page);
    await expect.poll(async () => (await measuresOf(request, w, 'targets')).map((m) => m.name), { timeout: 20_000 })
      .toContain('total_target');

    // the formula, typed with the editor's own suggestions (another table's measure included)
    await addMeasureButton(page).click();
    await pickTable(page, 'sales');
    await page.getByPlaceholder('Display name').fill('Attainment');
    await page.getByPlaceholder('sql_identifier').fill('attainment');
    await page.getByRole('button', { name: /Công thức nâng cao/ }).click();
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.click();
    await page.keyboard.type('Reve');
    await dump(page, 'x1-suggest-revenue');
    await page.getByRole('button', { name: /^revenue$/ }).click();
    await page.keyboard.type(' / ');
    await page.keyboard.type('total');
    await dump(page, 'x1-suggest-target');
    await expect(page.getByText(/Measure từ bảng: targets/)).toBeVisible();
    await page.getByRole('button', { name: /total_target$/ }).first().click();
    await dump(page, 'x1-formula-typed');

    // Chạy thử — the engine's answer, before saving
    await page.getByRole('button', { name: /Chạy thử/ }).first().click();
    await dump(page, 'x1-preview');
    await expect(page.getByText(/^0[.,]5$/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^0[.,]35$/)).toHaveCount(0);

    await save(page);
    await expect.poll(async () => (await measuresOf(request, w, 'sales')).find((m) => m.name === 'attainment'),
      { timeout: 30_000 }).toBeTruthy();
    const att = (await measuresOf(request, w, 'sales')).find((m) => m.name === 'attainment');
    expect(att.depends_on.sort()).toEqual(['revenue', `${w.views.targets.name}.total_target`].sort());
    expect(att.expression.replace(/\s+/g, '')).toBe(`\${revenue}/\${${w.views.targets.name}.total_target}`);

    // reload: the definition is the persisted one
    await page.reload();
    await expect(page.getByRole('button', { name: /^Measures 3/ })).toBeVisible({ timeout: 30_000 });
  });

  test("X2 charts and a dashboard show the formula at each dependency's own grain", async ({ page, request }) => {
    test.setTimeout(300_000);
    expect(w?.id, 'X1 built the model').toBeTruthy();
    const S = w.views.sales.name;
    const R = w.views.reps.name;
    const T = w.views.targets.name;
    const make = async (name: string, dims: string[]) => {
      const measures = [`${S}.attainment`];
      const role = { selectedColumns: [...dims, ...measures], metrics: measures.map((m) => ({ field: m, agg: 'auto' })) };
      const body = await j(await request.post(`${API}/api/v1/charts/`, { data: {
        name: `${NAME} ${name}`, chart_type: 'TABLE', dataset_table_id: w.views.sales.table,
        config: { chartType: 'TABLE', roleConfig: role, styleConfig: { chartTitle: name } } } }));
      return body.id as number;
    };
    charts.kpi = await make('Attainment', []);
    charts.byRep = await make('Attainment by rep', [`${R}.name`]);
    charts.byQuarter = await make('Attainment by quarter', [`${T}.quarter`]);

    // the saved charts' data (ChartService) — hand oracles
    const kpi = await chartRows(request, charts.kpi);
    expect(kpi.length).toBe(1);
    expect(Number(Object.values(kpi[0]).find((v) => typeof v === 'number' || /^[\d.]+$/.test(String(v))))).toBeCloseTo(0.5, 9);
    const byRep = Object.fromEntries((await chartRows(request, charts.byRep))
      .map((r) => [String(r[`${R}.name`]), Number(r[`${S}.attainment`])]));
    expect(byRep.Ann).toBeCloseTo(0.4, 9);
    expect(byRep.Bob).toBeCloseTo(0.6, 9);
    const refused = await request.get(`${API}/api/v1/charts/${charts.byQuarter}/data`);
    expect(refused.status()).toBe(400);
    expect(refused.headers()['x-appbi-refusal']).toBe('FANOUT_RISK');

    // a dashboard a viewer opens
    const dash = await j(await request.post(`${API}/api/v1/dashboards/`, { data: {
      name: `${NAME} board`, charts: [
        { chart_id: charts.kpi, layout: { x: 0, y: 0, w: 4, h: 4 } },
        { chart_id: charts.byRep, layout: { x: 4, y: 0, w: 4, h: 6 } },
        { chart_id: charts.byQuarter, layout: { x: 8, y: 0, w: 4, h: 6 } },
      ] } }));
    dashboardId = dash.id;
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByText(/^Ann$/).first()).toBeVisible({ timeout: 60_000 });
    await dump(page, 'x2-dashboard');
    await page.screenshot({ path: `${OUT || 'test-results'}/x2-dashboard.png`, fullPage: true });
    await expect(page.getByText(/^0[.,]5$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]4$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]6$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]35$/)).toHaveCount(0);
    // the unsafe grouping is a product refusal on its tile, never a plausible number
    const quarterTile = page.locator('div').filter({ has: page.getByText('Attainment by quarter', { exact: true }) })
      .filter({ has: page.getByText(/no single, safe meaning|không có một nghĩa/i) }).last();
    await expect(quarterTile.getByText(/no single, safe meaning|không có một nghĩa/i)).toBeVisible();
    await expect(quarterTile.getByText(/^\d+([.,]\d+)?$/)).toHaveCount(0);
  });

  test('X3 after Sync & Publish the dashboard reads the published result', async ({ page, request }) => {
    test.setTimeout(600_000);
    expect(dashboardId, 'X2 built the dashboard').toBeTruthy();
    const runsBefore = await j(await request.get(`${API}/api/v1/datasets/${w.id}/refresh-runs`));
    const before = (Array.isArray(runsBefore) ? runsBefore : runsBefore.runs ?? [])[0]?.id ?? 0;
    await page.goto(`/datasets/${w.id}`);
    const latestRunId = async () => {
      const runs = await j(await request.get(`${API}/api/v1/datasets/${w.id}/refresh-runs`));
      return Number((Array.isArray(runs) ? runs : runs.runs ?? [])[0]?.id ?? 0);
    };
    // A publish is declined while a background snapshot rebuild of the same dataset is
    // still running (one build at a time). An analyst presses Sync & Publish again;
    // so does the journey — keyed on a NEW run, never on an old one.
    for (let attempt = 0; attempt < 3 && (await latestRunId()) <= before; attempt += 1) {
      await page.getByRole('button', { name: /^(Sync & Publish|Re-publish)$/ }).first().click();
      await dump(page, 'x3-publish-modal');
      await expect(page.getByRole('heading', { name: 'Sync & Publish' })).toBeVisible();
      await page.getByRole('button', { name: /^Sync & Publish$/ }).last().click();
      await expect.poll(latestRunId, { timeout: 30_000, intervals: [2_000] }).toBeGreaterThan(before).catch(() => {});
      if ((await latestRunId()) <= before) await page.reload();
    }
    expect(await latestRunId(), 'Sync & Publish started a run').toBeGreaterThan(before);
    let run: any;
    await expect.poll(async () => {
      const runs = await j(await request.get(`${API}/api/v1/datasets/${w.id}/refresh-runs`));
      run = (Array.isArray(runs) ? runs : runs.runs ?? [])[0];
      return run && run.id > before && run.status !== 'running' ? run.status : 'pending';
    }, { timeout: 480_000, intervals: [5_000] }).toBe('success');
    const status = await j(await request.get(`${API}/api/v1/datasets/${w.id}/publish-status`));
    expect(status.publish_state).toBe('published');
    expect(status.published_generation).toBeTruthy();

    const S = w.views.sales.name;
    const R = w.views.reps.name;
    const byRep = Object.fromEntries((await chartRows(request, charts.byRep))
      .map((r) => [String(r[`${R}.name`]), Number(r[`${S}.attainment`])]));
    expect(byRep.Ann).toBeCloseTo(0.4, 9);
    expect(byRep.Bob).toBeCloseTo(0.6, 9);

    await page.goto('about:blank');
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByText(/^Ann$/).first()).toBeVisible({ timeout: 60_000 });
    await dump(page, 'x3-dashboard-published');
    await page.screenshot({ path: `${OUT || 'test-results'}/x3-dashboard-published.png`, fullPage: true });
    await expect(page.getByText(/^0[.,]5$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]4$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]6$/).first()).toBeVisible();
    await expect(page.getByText(/^0[.,]35$/)).toHaveCount(0);
  });
});
