import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './_helpers';
import { MIN_CHART_INK, readDeck, type Deck } from './_pptx';

/**
 * PowerPoint export closure — fixture `E2E PPTX export`
 * (backend/scripts/ci/seed_e2e_data_state.py `_pptx_export_fixture`,
 * public token `e2e-pptx-export`).
 *
 * The real failure this closes: a downloaded deck in which one chart block was a
 * valid PNG of an empty card — the browser captured the tile before its chart had
 * drawn, and the export reported success. Every test here drives the real export
 * dialog, receives the real .pptx and READS it (texts, native tables, and the
 * pixels of every chart picture), against the real API and Postgres.
 */

/** MIRROR of PPTX_EXPORT_MAX_MS in frontend/src/lib/export-pptx.ts (capture
 *  budget 180 s + server build 60 s): past it the export itself fails with an
 *  error toast. check-pptx-export-contract.mjs keeps the two equal. */
const PPTX_EXPORT_MAX_MS = 240_000;
/** The download wait is DERIVED from that cap, never tuned to make a run pass:
 *  the cap plus slack for the last captures and the browser's download. */
const DOWNLOAD_WAIT_MS = PPTX_EXPORT_MAX_MS + 30_000;

// A test = page load + one or two exports: the timeout follows the export cap.
test.describe.configure({ mode: 'serial', timeout: Math.max(300_000, DOWNLOAD_WAIT_MS + 90_000) });

const TOKEN = 'e2e-pptx-export';
const PAGES = ['Tổng quan', 'Chi tiết', 'Biểu đồ'];
const REGRESSION = 'SỐ NGƯỜI DÙNG TRUY CẬP TRUNG BÌNH TRÊN NGÀY THEO ỨNG DỤNG';
/** Every chart that must arrive as a real picture, by slide title. */
const CHART_TITLES = [
  'Doanh số theo ngày', 'Tỷ trọng theo vùng', 'Doanh số theo vùng', REGRESSION,
  'Xu hướng trang chi tiết',
  'Họ GROUPED_BAR', 'Họ STACKED_BAR', 'Họ BAR_LINE', 'Họ TIME_SERIES', 'Họ DONUT',
  'Họ SCATTER', 'Họ BUBBLE', 'Họ RIBBON', 'Họ TIMELINE',
];

async function dashboardIdByName(request: APIRequestContext, name: string) {
  const response = await request.get(`${API}/api/v1/dashboards/`);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body.items ?? body.dashboards ?? [];
  const found = rows.find((row: any) => row.name === name);
  expect(found, `fixture dashboard ${JSON.stringify(name)} — run seed_e2e_data_state.py`).toBeTruthy();
  return Number(found.id);
}

/** Applying a slicer in the Builder stages the choice in the report's draft:
 *  every Builder journey starts from the published report (no North left over). */
async function discardDraft(request: APIRequestContext) {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  const res = await request.post(`${API}/api/v1/dashboards/${id}/discard-draft`);
  expect(res.status(), await res.text()).toBeLessThan(300);
}

test.beforeEach(async ({ request }) => { await discardDraft(request); });
test.afterAll(async ({ request }) => { await discardDraft(request); });

/** A tile by its title, from the report definition (a below-fold tile is an empty
 *  placeholder until it is reached, so its title is not in the DOM yet). */
async function tileIdByTitle(request: APIRequestContext, title: string): Promise<number> {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  const dash = await (await request.get(`${API}/api/v1/dashboards/${id}`)).json();
  const tile = (dash.dashboard_charts as any[]).find((dc) => dc.layout?.custom_title === title);
  expect(tile, `fixture tile "${title}"`).toBeTruthy();
  return Number(tile.id);
}

/** In the open export dialog: PowerPoint, the given pages, Export — the real download. */
async function exportDeck(page: Page, path: string, pages: string[]): Promise<Deck> {
  await page.getByTestId('export-filetype-pptx').click();
  for (const name of pages) {
    const box = page.locator('label').filter({ hasText: name }).locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.check();
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS }),
    page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pptx$/);
  await download.saveAs(path);
  return readDeck(path);
}

function picturesByTitle(deck: Deck) {
  return deck.slides.flatMap((s) => s.pictures);
}

/** Every expected chart is a real picture — never an empty card. */
function expectEveryChartDrawn(deck: Deck, titles: string[]) {
  const pics = picturesByTitle(deck);
  for (const title of titles) {
    const pic = pics.find((p) => p.title === title);
    expect(pic, `no picture for "${title}" (pictures: ${pics.map((p) => p.title).join(' | ')})`).toBeTruthy();
    expect(pic!.ink, `"${title}" is a blank card in the deck (plot ink ${pic!.ink})`).toBeGreaterThan(MIN_CHART_INK);
  }
  const texts = deck.slides.flatMap((s) => s.texts).join('\n');
  expect(texts, 'a chart fell back to the placeholder').not.toContain('biểu đồ không chụp được');
}

/**
 * A slow network (Chrome DevTools emulation: every request takes 1.5 s longer).
 * Nothing is mocked — the real API answers with the real rows, later. This is
 * the condition that reproduced the customer's deck BEFORE the fix: the
 * Builder export of pages never opened came out with every chart an empty card
 * (plot ink 0) and the download "succeeded"
 * (.artifacts/pptx-closure/latency-builder-BEFORE-FIX.pptx).
 */
async function slowNetwork(page: Page, latency = 1500) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
}

test('Builder on a slow network: every chart of three pages (below the fold, a page never opened, every renderer) is a real picture', async ({ page, request }, testInfo) => {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expect(page.locator('[data-grid-item-id]').filter({ hasText: 'Tổng doanh số' }).first()).toContainText(/\d/, { timeout: 60_000 });
  await slowNetwork(page);
  await page.getByTestId('dashboard-more').click();
  await page.getByRole('button', { name: /PowerPoint/ }).first().click();
  const deck = await exportDeck(page, testInfo.outputPath('builder-all.pptx'), PAGES);
  expectEveryChartDrawn(deck, CHART_TITLES);
});

// ── Filters: the CONTROL leaves the deck, the FILTER stays in every number ─────

/** Choose a value on the report's Region slicer through its real control. */
async function chooseRegion(page: Page, value: string) {
  const card = page.locator('[data-slicer-card]').filter({ hasText: /Region/i }).first();
  await card.scrollIntoViewIfNeeded();
  // A short list renders as segmented buttons; a longer one as a dropdown menu.
  const segment = card.getByRole('button', { name: value, exact: true });
  if (await segment.count()) {
    await segment.first().click();
  } else {
    await card.getByRole('button').first().click();
    const menu = page.locator('[data-slicer-menu], .dashboard-slicer-menu').first();
    await expect(menu).toBeVisible();
    await menu.getByText(value, { exact: true }).first().click();
    await page.keyboard.press('Escape');
  }
  const apply = page.getByTestId('slicer-menu-apply');
  if (await apply.count() && await apply.isEnabled()) await apply.click();
  // The report stages a control's choice until the reader applies it (the bar
  // "1 filter change not applied yet … Apply").
  const applyBar = page.getByRole('button', { name: /^(Apply|Áp dụng)$/ });
  await expect(applyBar).toBeVisible({ timeout: 15_000 });
  await applyBar.click();
  await expect(applyBar).toHaveCount(0, { timeout: 30_000 });
}

const kpiTile = (page: Page, title: string) =>
  page.locator('[data-grid-item-id]').filter({ has: page.locator('[data-pdf-tile-title]', { hasText: title }) }).first();

/** A KPI's value as the reader sees it: scrolled into view (an off-screen tile defers its refetch). */
async function expectKpi(page: Page, title: string, value: string, message?: string) {
  const tile = kpiTile(page, title);
  await tile.scrollIntoViewIfNeeded();
  await expect(tile, message).toContainText(value, { timeout: 60_000 });
}

/** CONTENT_TOP of report_pptx_service (1.05 in) + a little: no empty band above the first block. */
const CONTENT_TOP_EMU = 960_120;

function expectNoControlsAndNorth(deck: Deck) {
  const first = deck.slides[0];
  const texts = deck.slides.flatMap((s) => s.texts);
  // the control blocks are gone (their labels are not slide text) …
  // (a control would arrive as a text block such as "Region All North South")
  for (const label of ['Region', 'System ID']) {
    const leaked = texts.filter((t) => new RegExp(`^\\s*${label}\\b`, 'i').test(t));
    expect(leaked, `the "${label}" control reached the deck`).toEqual([]);
  }
  // … and the band they took is closed: the first content starts at the top.
  expect(first.content_top - CONTENT_TOP_EMU, `an empty band above the first block (${first.content_top} EMU)`).toBeLessThan(150_000);
  // … but the filter shapes every number: North only (610 of 685, 4 rows).
  expect(first.texts, 'Tổng doanh số for North').toContain('610');
  expect(first.texts, 'the unfiltered total was exported').not.toContain('685');
  expect(first.texts, 'Số đơn for North').toContain('4');
  const table = deck.slides.flatMap((s) => s.tables).find((t) => t[0]?.includes('region'));
  expect(table, 'the transactions table is a native table').toBeTruthy();
  const body = table!.slice(1);
  expect(body, 'North has 4 rows').toHaveLength(4);
  const regionCol = table![0].indexOf('region');
  expect([...new Set(body.map((r) => r[regionCol]))]).toEqual(['North']);
  // and author chrome never reaches a picture.
  for (const p of deck.slides.flatMap((s) => s.pictures)) {
    expect(p.amber, `"${p.title}" carries the author filter badge`).toBe(0);
  }
}

test('Builder, Region = North through the slicer: the deck has North numbers, no filter control, no empty band, no badge', async ({ page, request }, testInfo) => {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expectKpi(page, 'Tổng doanh số', '685');
  await chooseRegion(page, 'North');
  await expectKpi(page, 'Tổng doanh số', '610', 'the slicer did not filter the KPI');
  // the author sees the diagnostic on the chart the filter cannot reach
  const regression = page.locator(`[data-grid-item-id="${await tileIdByTitle(request, REGRESSION)}"]`).first();
  await regression.scrollIntoViewIfNeeded();
  await expect(regression.getByTestId('tile-filter-diagnostic')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${testInfo.outputDir}/builder-north.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId('dashboard-more').click();
  await page.getByRole('button', { name: /PowerPoint/ }).first().click();
  const deck = await exportDeck(page, testInfo.outputPath('builder-north.pptx'), ['Tổng quan']);
  expectNoControlsAndNorth(deck);
  expectEveryChartDrawn(deck, ['Doanh số theo ngày', 'Tỷ trọng theo vùng', 'Doanh số theo vùng', REGRESSION]);
  // the filter value the author chose is still chosen
  await expectKpi(page, 'Tổng doanh số', '610');
});

test('Public, the reader picks Region = North: the same deck contract from the shared link', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/d/${TOKEN}`);
  await expectKpi(page, 'Tổng doanh số', '685');
  await chooseRegion(page, 'North');
  await expectKpi(page, 'Tổng doanh số', '610');
  await page.getByTestId('public-export-open').first().click();
  const deck = await exportDeck(page, testInfo.outputPath('public-north.pptx'), ['Tổng quan', 'Chi tiết']);
  expectNoControlsAndNorth(deck);
  expectEveryChartDrawn(deck, ['Doanh số theo ngày', 'Tỷ trọng theo vùng', 'Doanh số theo vùng', REGRESSION, 'Xu hướng trang chi tiết']);
});

// ── The filter diagnostic: the author's, never the viewer's ────────────────────

test('the filter diagnostic: the Builder explains it in plain words; /d, /embed and emb_ never show it', async ({ page, request }) => {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expectKpi(page, 'Tổng doanh số', '685');
  await chooseRegion(page, 'North');
  const regression = page.locator(`[data-grid-item-id="${await tileIdByTitle(request, REGRESSION)}"]`).first();
  await regression.scrollIntoViewIfNeeded();
  const badge = regression.getByTestId('tile-filter-diagnostic');
  await expect(badge).toBeVisible({ timeout: 60_000 });
  await expect(badge).toHaveText(/^\d+ (bộ lọc không áp dụng|filters? not applied)$/);
  await badge.click();
  const details = regression.getByTestId('tile-filter-diagnostic-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText(/bộ lọc|filters/i);
  await expect(details).toContainText(/không thay đổi theo|do not change with/);
  await expect(details.getByTestId('tile-filter-diagnostic-item').first()).toContainText('Region');
  // No engine words in what an author reads by default (they sit behind "technical details").
  const visible = await details.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details').forEach((d) => d.remove());
    return clone.innerText;
  });
  expect(visible).not.toMatch(/dataset_table_|semantic|dataset_mismatch|join|view\b|_id\b/i);
  // The title is still readable beside it.
  const titleBox = await regression.locator('[data-pdf-tile-title]').boundingBox();
  expect(titleBox!.width, 'the diagnostic squeezes the title').toBeGreaterThan(200);
  await page.keyboard.press('Escape');

  // Viewers: no badge, no hidden placeholder, no "bỏ qua" / "skipped", same numbers.
  const { mintEmbed, deleteTestPats } = await import('./_public-closure');
  const emb = await mintEmbed(request, id, { full_report: true });
  try {
    for (const url of [`/d/${TOKEN}`, `/embed/${TOKEN}`, emb]) {
      await page.goto(url);
      await expectKpi(page, 'Tổng doanh số', '685');
      await chooseRegion(page, 'North');
      await expectKpi(page, 'Tổng doanh số', '610');
      const tile = page.locator(`[data-grid-item-id="${await tileIdByTitle(request, REGRESSION)}"]`).first();
      await tile.scrollIntoViewIfNeeded();
      await expect(tile.locator('svg.recharts-surface').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('tile-filter-diagnostic'), `${url}: the author diagnostic reached a viewer`).toHaveCount(0);
      expect(await tile.locator('[class*="amber"]').count(), `${url}: a hidden diagnostic element remains`).toBe(0);
      await expect(page.locator('body')).not.toContainText(/bị bỏ qua|bỏ qua|\bskipped\b|không áp dụng/);
    }
  } finally {
    await deleteTestPats(request);
  }
});

// ── Failure is loud, and the screen is left as the user had it ────────────────

test('a refused deck names the charts, keeps the dialog for Retry, never says "downloaded"; page, device and filter are restored', async ({ page, request }) => {
  const id = await dashboardIdByName(request, 'E2E PPTX export');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${id}`);
  await expectKpi(page, 'Tổng doanh số', '685');
  await chooseRegion(page, 'North');
  await expectKpi(page, 'Tổng doanh số', '610');
  // The author is on page "Chi tiết", in Tablet mode.
  await page.getByTestId('builder-pages-menu').click();
  await page.getByTestId('builder-page-p2').click();
  await page.getByTestId('device-mode-tablet').click();
  await expect(page.getByTestId('device-mode-tablet')).toHaveAttribute('aria-pressed', 'true');
  // A controlled server refusal of the DECK (the chart data is real).
  await page.route('**/export-pptx', (route) => route.fulfill({
    status: 422, contentType: 'application/json',
    body: JSON.stringify({ detail: { code: 'pptx_chart_missing', charts: ['Doanh số theo vùng'] } }),
  }));
  await page.getByTestId('dashboard-more').click();
  await page.getByRole('button', { name: /PowerPoint/ }).first().click();
  await page.getByTestId('export-filetype-pptx').click();
  for (const name of PAGES) {
    const box = page.locator('label').filter({ hasText: name }).locator('input[type="checkbox"]');
    if (!(await box.isChecked())) await box.check();
  }
  await page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }).click();
  const toasts = page.locator('[data-sonner-toast]');
  const refused = toasts.filter({ hasText: /chart\(s\) could not be rendered|biểu đồ không dựng được/ });
  await expect(refused).toBeVisible({ timeout: 180_000 });
  await expect(refused).toContainText('Doanh số theo vùng');
  await expect(toasts.filter({ hasText: /PowerPoint downloaded|Đã tải file PowerPoint/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }), 'Retry is gone').toBeVisible();
  // Restored: the page, the device, the filter.
  await expect(page.getByTestId('device-mode-tablet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-grid-item-id]').filter({ hasText: 'Xu hướng trang chi tiết' }).first()).toBeVisible();
  await expect(page.locator('[data-device-frame="tablet"]')).toHaveCount(1);
  await page.unroute('**/export-pptx');
  // Retry succeeds, and the screen is again what it was.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_WAIT_MS }),
    page.getByRole('button', { name: /^(Export PowerPoint|Xuất PowerPoint)$/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pptx$/);
  await expect(toasts.filter({ hasText: /PowerPoint downloaded|Đã tải file PowerPoint/ })).toBeVisible();
  await expect(page.getByTestId('device-mode-tablet')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-grid-item-id]').filter({ hasText: 'Xu hướng trang chi tiết' }).first()).toBeVisible();
  await page.getByTestId('builder-pages-menu').click();
  await page.getByTestId('builder-page-p1').click();
  await expectKpi(page, 'Tổng doanh số', '610', 'the export changed the filter');
});
