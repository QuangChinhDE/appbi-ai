/**
 * AI Vibe Report — Product DoD journeys, in a real browser on the local stack.
 *
 *   J1  /dashboards is ONE report list (both build methods): filter, search, grid/list, actions
 *   J2  Studio: write code, bind governed data, live preview, provenance, save, publish
 *   J3  -> e2e/acceptance/report-vibe-ai-edit.spec.ts (real Studio model; not on CI)
 *   J4  Versions: a draft never reaches the public link; rollback does
 *   J5  Public Modal: password, expiry, locked + hidden filters, appearance, embed, revoke
 *   J6  Public AI Bot: offered only when the link enables it; locks hold
 *   J7  Manual Dashboard regression: its Public Modal + AI Bot surface are unchanged
 *   J8  Responsive 1440 / 820 / 390, no horizontal overflow, no console errors
 *
 * Screenshots: .artifacts/dod/. Run with `--trace on` to keep a trace of every journey.
 * The spec never types, reads or stores an AI key; a paid model call is not made here.
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const API = process.env.E2E_API_URL || 'http://localhost:3000';
const RA = `${API}/api/v1/report-artifacts`;
const PUB = `${API}/api/v1/public/reports`;
const SHOTS = path.resolve(__dirname, '../../.artifacts/dod');
const STAMP = Date.now().toString(36);
const NAME = `DOD E2E ${STAMP}`;
const PASSWORD = 'dodpass123';

fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

test.describe.configure({ mode: 'serial' });

let reportId = 0;
let datasetId = 0;
const consoleErrors: string[] = [];

// The refusals these journeys provoke ON PURPOSE (a password gate, a wrong password, a
// revoked link). Every other 4xx/5xx a page receives is a defect and fails J8.
const EXPECTED_REFUSALS: [number, RegExp][] = [
  [401, /\/public\/reports\/[^/]+$/],          // a password link before it is unlocked
  [403, /\/public\/reports\/[^/]+\/auth$/],    // the deliberately wrong password
  [404, /\/public\/reports\/[^/]+$/],          // a revoked / deleted link
  [401, /\/auth\/(me|refresh)$/],              // the login page's session probe
];

function watchConsole(page: Page, where: string) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/accounts\.google\.com|gsi\/|favicon/i.test(t)) return; // the login page's Google button
    if (/Failed to load resource/.test(t)) return; // judged by URL in the response hook below
    consoleErrors.push(`${where}: ${t.slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const url = r.url().split('?')[0];
    if (/accounts\.google\.com|favicon/.test(url)) return;
    if (EXPECTED_REFUSALS.some(([code, rx]) => code === r.status() && rx.test(url))) return;
    consoleErrors.push(`${where}: HTTP ${r.status()} ${r.request().method()} ${url.replace(/rpt_[\w-]+/, 'rpt_…')}`);
  });
}

async function anonymous(browser: Browser) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function links(request: APIRequestContext) {
  return (await request.get(`${RA}/${reportId}/public-links`)).json() as Promise<any[]>;
}

async function kpiValue(request: APIRequestContext, token: string, headers: Record<string, string> = {}) {
  const r = await request.post(`${PUB}/${token}/data`, { data: { binding: 'b1', state: {} }, headers });
  expect(r.ok(), await r.text()).toBeTruthy();
  const dto = await r.json();
  const m = (dto.fields || []).find((f: any) => f.role === 'measure');
  return Number((dto.rows || [])[0]?.[m?.key]);
}

test.beforeAll(async ({ request }) => {
  const ds = await (await request.get(`${API}/api/v1/datasets/`)).json();
  // CI: the fixture seed_e2e_presentation.py builds (Revenue measure, region dimension).
  // Local stack: the Olist dataset when that fixture was never seeded. Neither = FAIL.
  const all = Array.isArray(ds) ? ds : ds.items || [];
  const fixture = all.find((d: any) => d.name === 'E2E presentation sales');
  const local = process.env.CI ? null : all.find((d: any) => /Olist Sales Reporting/i.test(d.name));
  const dataset = fixture || local;
  expect(dataset, 'the E2E presentation sales fixture (CI) or the Olist dataset (local) exists').toBeTruthy();
  datasetId = dataset.id;
});

test('J2 Studio: write code, bind governed data, live preview, provenance, save, publish', async ({ page }) => {
  watchConsole(page, 'studio');
  await page.goto('/dashboards/code/new');
  await expect(page.getByTestId('rc-mode-code')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('rc-dataset').selectOption(String(datasetId));
  await page.getByTestId('rc-blank-name').fill(NAME);
  await page.getByTestId('rc-create-blank').click();
  await page.waitForURL(/\/dashboards\/code\/\d+$/);
  reportId = Number(page.url().split('/').pop());
  await expect(page.getByTestId('studio-tab-code')).toHaveAttribute('aria-selected', 'true');

  // governed data: one KPI binding and one filter, chosen from the semantic model
  await page.getByTestId('studio-tab-data').click();
  await page.getByTestId('data-add-toggle').click();
  const kpi = page.locator('[data-testid^="data-candidate-"]', { hasText: /revenue|doanh thu/i }).first();
  await kpi.click();
  await expect(page.getByTestId('binding-b1')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('binding-b1-uses')).toContainText(/chưa dùng|not used/i);
  // the picker stays open: its dimension chips (+ label) add a declared filter
  const dim = page.getByRole('button', { name: /^\+ .*(state|bang|tiểu bang|region|vùng)/i }).first();
  await (await dim.count() ? dim : page.getByRole('button', { name: /^\+ / }).first()).click();
  await expect(page.locator('[data-testid^="filter-f1"]').first()).toBeVisible({ timeout: 60_000 });

  // filter semantics set in the Studio, not through the API: one value + its default value
  const filterOf = async (key: string) =>
    ((await (await page.request.get(`${RA}/${reportId}`)).json()).draft.filters || []).find((f: any) => f.key === key);
  if (await page.getByTestId('filter-f1-single').count()) {
    const vals = (await (await page.request.post(`${RA}/${reportId}/values`, { data: { key: 'f1', search: '', state: {} } })).json()).values;
    await page.getByTestId('filter-f1-single').check();
    await expect.poll(async () => (await filterOf('f1'))?.single, { timeout: 30_000 }).toBe(true);
    await page.getByTestId('filter-f1-default').fill(String(vals[0]));
    await page.getByTestId('filter-f1-default').press('Tab');
    await expect.poll(async () => (await filterOf('f1'))?.default_value, { timeout: 30_000 }).toBe(String(vals[0]));
    await shot(page, 'j2-studio-filter-options');
    await page.getByTestId('filter-f1-single').uncheck(); // back to multi-select for the journeys below
    await expect.poll(async () => (await filterOf('f1'))?.single ?? false, { timeout: 30_000 }).toBe(false);
  }

  // insert both at the cursor, then write some code by hand
  await page.getByTestId('binding-b1-insert').click();
  await page.getByTestId('studio-tab-data').click();
  await page.getByTestId('filter-f1-insert').click();
  const html = page.getByTestId('code-editor-html').locator('.cm-content');
  await html.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n<p class="dod-note">Ghi chú DOD — số tĩnh 777</p>');
  await expect(page.getByTestId('studio-preview-unsaved')).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator('[data-testid="report-frame"]');
  await expect(frame.locator('.dod-note')).toContainText('777', { timeout: 15_000 });
  await expect(frame.locator('[data-rac-viz="kpi"]').first()).toBeVisible();
  await shot(page, 'j2-studio-live-preview');

  // provenance: governed vs static numbers
  await page.getByTestId('studio-provenance-toggle').click();
  await page.waitForTimeout(3500); // the runtime's audit settles
  await shot(page, 'j2-studio-provenance');
  await page.getByTestId('studio-provenance-toggle').click();

  await page.getByTestId('code-save').click();
  await expect(page.getByText(/Đã lưu thành phiên bản|Saved as version/)).toBeVisible();
  await page.getByTestId('studio-publish').click();
  await expect(page.getByTestId('studio-published-badge')).toContainText(/v\d/, { timeout: 30_000 });
});

test('J1 /dashboards: one report list for both build methods', async ({ page }) => {
  watchConsole(page, 'list');
  await page.goto('/dashboards');
  await expect(page.getByTestId('report-type-all')).toHaveAttribute('aria-selected', 'true');
  const vibeRow = page.getByTestId(`report-row-vibe-${reportId}`);
  await expect(vibeRow).toBeVisible();
  await expect(vibeRow.getByTestId('report-kind-vibe')).toBeVisible();
  await expect(vibeRow.getByTestId('report-status')).toContainText(/Đã xuất bản|Published/);
  // a Vibe row has the same real actions as a dashboard row: export, duplicate, share, public, delete
  await expect(page.getByTestId(`report-row-vibe-${reportId}-public`)).toBeVisible();
  for (const name of [/Xuất HTML|Export to HTML/, /^(Nhân bản|Duplicate)$/, /Chia sẻ quyền|Share access/, /^(Xoá|Xóa|Delete)/]) {
    await expect(vibeRow.getByRole('button', { name })).toBeVisible();
  }
  await shot(page, 'j1-list-all');
  // both methods are in the one list (by type, not by whichever happens to be on page 1)
  await page.getByTestId('report-type-manual').click();
  const manualRow = page.locator('[data-testid^="report-row-manual-"]').first();
  await expect(manualRow).toBeVisible();
  for (const name of [/Xuất HTML|Export to HTML/, /^(Nhân bản|Duplicate)$/, /Chia sẻ quyền|Share access/]) {
    await expect(manualRow.getByRole('button', { name })).toBeVisible();
  }
  await page.getByTestId('report-type-all').click();

  await page.getByTestId('report-type-vibe').click();
  await expect(page).toHaveURL(/type=vibe/);
  await expect(page.locator('[data-testid^="report-row-manual-"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('report-type-vibe')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('report-type-all').click();

  await page.getByPlaceholder(/Search|Tìm/).first().fill(STAMP);
  await expect(page.locator('[data-testid^="report-row-"]').filter({ hasText: NAME })).toHaveCount(1);
  await page.getByPlaceholder(/Search|Tìm/).first().fill('');

  // grid: the same card for both methods, the method only as a small badge
  await page.getByTestId('view-grid').click();
  await expect(page.getByTestId('view-grid')).toHaveAttribute('aria-pressed', 'true');
  const card = page.getByTestId(`report-card-vibe-${reportId}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('report-kind-vibe')).toBeVisible();
  // every report card has the same mark: the product is the report, not its builder
  await expect(card.locator('svg.lucide-layout-dashboard').first()).toBeVisible();
  await shot(page, 'j1-list-grid');
  await page.getByTestId('view-list').click();
  await page.getByTestId(`report-open-vibe-${reportId}`).click();
  await page.waitForURL(new RegExp(`/dashboards/code/${reportId}$`));
  await page.goto('/dashboards?type=manual');
  await page.locator('[data-testid^="report-open-manual-"]').first().click();
  await page.waitForURL(/\/dashboards\/\d+$/);
});

// J3 (a scoped AI edit) needs the REAL Studio model: e2e/acceptance/report-vibe-ai-edit.spec.ts

test('J4 Versions: a draft never reaches the public link; rollback does', async ({ page, browser }) => {
  watchConsole(page, 'versions');
  const created = await page.request.post(`${RA}/${reportId}/public-links`, { data: { name: 'DOD versions' } });
  const link = await created.json();
  const detail = await (await page.request.get(`${RA}/${reportId}`)).json();
  const published = detail.published_number;
  const { ctx, page: anon } = await anonymous(browser);
  await anon.goto(`/d/r/${link.token}`);
  await expect(anon.getByTestId('public-report')).toHaveAttribute('data-report-version', String(published));
  await expect(anon.getByTestId('public-report')).not.toContainText('DRAFT-ONLY');

  await page.goto(`/dashboards/code/${reportId}`);
  const html = page.getByTestId('code-editor-html').locator('.cm-content');
  await html.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n<p>DRAFT-ONLY</p>');
  await page.getByTestId('code-save').click();
  await expect(page.getByText(/Đã lưu thành phiên bản|Saved as version/)).toBeVisible();
  await anon.reload();
  await expect(anon.getByTestId('public-report')).toHaveAttribute('data-report-version', String(published));
  await expect(anon.frameLocator('[data-testid="report-frame"]').locator('body')).not.toContainText('DRAFT-ONLY');

  // roll back to the first version: the public link follows
  await page.getByTestId('studio-versions').click();
  const rolled = page.waitForResponse((r) => r.url().endsWith(`/report-artifacts/${reportId}/publish`) && r.request().method() === 'POST');
  await page.getByTestId('version-1-publish').click();
  expect((await rolled).ok()).toBeTruthy();
  await expect(page.getByTestId('studio-published-badge')).toContainText('v1');
  await anon.reload();
  await expect(anon.getByTestId('public-report')).toHaveAttribute('data-report-version', '1');
  // and forward again to the latest
  await page.keyboard.press('Escape');
  await page.goto(`/dashboards/code/${reportId}`);
  const forward = page.waitForResponse((r) => r.url().endsWith(`/report-artifacts/${reportId}/publish`) && r.request().method() === 'POST');
  await page.getByTestId('studio-publish').click();
  expect((await forward).ok()).toBeTruthy();
  await expect(page.getByTestId('studio-published-badge')).not.toContainText('v1');
  await page.request.delete(`${RA}/${reportId}/public-links/${link.id}`);
  await ctx.close();
});

test('J5 Public Modal: password, expiry, locked + hidden filters, appearance, embed, revoke', async ({ page, browser }) => {
  watchConsole(page, 'modal');
  await page.goto(`/dashboards/code/${reportId}`);
  await page.getByTestId('studio-share').click();
  await page.getByTestId('public-link-new').click();
  await page.getByTestId('public-link-name').fill('DOD pw');
  for (const tab of ['appearance', 'data', 'aibot', 'security']) await expect(page.getByTestId(`public-link-tab-${tab}`)).toBeVisible();
  // appearance: only what a report link honours
  await expect(page.getByRole('button', { name: /Show page tabs/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Allow data export/ })).toHaveCount(0);
  await page.getByTestId('public-link-headline').fill('DOD Headline');
  // data: the PUBLISHED filters, lock f1
  await page.getByTestId('public-link-tab-data').click();
  await expect(page.getByText(/bản đã xuất bản/)).toBeVisible();
  await expect(page.getByTestId('public-link-filter-action-limit')).toHaveCount(0);
  const value = (await (await page.request.post(`${RA}/${reportId}/values`, { data: { key: 'f1', search: '', state: {}, revision: null } })).json()).values[0];
  await page.getByTestId('public-link-filter-action-lock').first().click();
  await page.getByTestId('public-link-filter-value').first().fill(String(value));
  await page.keyboard.press('Enter');
  // ai bot tab: no Agent Flow add-on for a report link
  await page.getByTestId('public-link-tab-aibot').click();
  await expect(page.getByText('Agent Flow hỗ trợ')).toHaveCount(0);
  // security: password + expiry
  await page.getByTestId('public-link-tab-security').click();
  await page.getByTestId('public-link-password-require').click();
  await page.getByTestId('public-link-password').fill(PASSWORD);
  const exp = new Date(Date.now() + 3 * 864e5);
  const pad = (n: number) => String(n).padStart(2, '0');
  await page.getByTestId('public-link-expires-at').fill(`${exp.getFullYear()}-${pad(exp.getMonth() + 1)}-${pad(exp.getDate())}T12:00`);
  await shot(page, 'j5-modal-security');
  await page.getByTestId('public-link-create').click();
  await expect(page.getByText(/Public link created/)).toBeVisible();
  const pw = (await links(page.request)).find((l) => l.name === 'DOD pw');
  expect(pw.has_password && pw.expires_at && pw.filters_config[0].value[0] === String(value)).toBeTruthy();

  // logged out: the gate, the header, the lock, and no session in the frame's URL
  const { ctx, page: anon } = await anonymous(browser);
  watchConsole(anon, 'public');
  await anon.goto(`/d/r/${pw.token}`);
  await anon.locator('input[type="password"]').fill('wrong-password');
  await anon.keyboard.press('Enter');
  await expect(anon.getByText('Sai mật khẩu.')).toBeVisible();
  await anon.locator('input[type="password"]').fill(PASSWORD);
  await anon.keyboard.press('Enter');
  await expect(anon.getByTestId('public-report-header')).toContainText('DOD Headline');
  await expect(anon.getByTestId('public-report-locked')).toContainText(String(value));
  const session = await anon.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('appbi_pub_session_'))
    .map((k) => JSON.parse(sessionStorage.getItem(k) || '{}').sessionToken)[0]);
  const src = await anon.getByTestId('report-frame').getAttribute('src');
  expect(src).toContain('g=');
  expect(src).not.toContain(session);
  expect((await anon.request.get(`${PUB}/${pw.token}/document?s=${encodeURIComponent(session)}`)).status()).toBe(401);
  await shot(anon, 'j5-public-password-unlocked');

  // the lock is server-side: the locked number differs from the unlocked one, and an override is refused
  const open = await (await page.request.post(`${RA}/${reportId}/public-links`, { data: { name: 'DOD open' } })).json();
  const unlocked = await kpiValue(page.request, open.token);
  const locked = await kpiValue(page.request, pw.token, { 'X-Public-Session': session });
  expect(locked).toBeLessThan(unlocked);
  const override = await page.request.post(`${PUB}/${pw.token}/data`, { data: { binding: 'b1', state: { f1: ['__other__'] } }, headers: { 'X-Public-Session': session } });
  expect(override.status()).toBe(400);
  test.info().annotations.push({ type: 'bi-core', description: `KPI unlocked=${unlocked} locked(${value})=${locked}` });

  // a hidden lock restricts without being named
  const hidden = await (await page.request.post(`${RA}/${reportId}/public-links`, {
    data: { name: 'DOD hidden', filters_config: [{ field: 'f1', value: [String(value)], hidden: true }] } })).json();
  await anon.goto(`/d/r/${hidden.token}`);
  await expect(anon.getByTestId('public-report')).toBeVisible();
  await expect(anon.getByTestId('public-report-locked')).toHaveCount(0);
  expect(await kpiValue(page.request, hidden.token)).toBe(locked);
  const meta = await (await page.request.get(`${PUB}/${hidden.token}`)).json();
  expect(JSON.stringify(meta)).not.toContain(String(value));

  // embed
  await anon.goto(`/embed/r/${open.token}`);
  await expect(anon.getByTestId('public-report')).toBeVisible();
  await shot(anon, 'j5-embed');

  // revoke: off, then deleted
  await page.reload();
  await page.getByTestId('studio-share').click();
  await page.getByTestId(`public-link-row-${open.id}`).getByTestId('public-link-toggle-active').click();
  await expect(page.getByText(/Link deactivated/)).toBeVisible();
  await anon.goto(`/d/r/${open.token}`);
  await expect(anon.getByTestId('public-report-error')).toBeVisible();
  for (const l of [open, hidden]) await page.request.delete(`${RA}/${reportId}/public-links/${l.id}`);
  await anon.goto(`/d/r/${hidden.token}`);
  await expect(anon.getByTestId('public-report-error')).toBeVisible();
  await ctx.close();
});

test('J6 Public AI Bot: offered only when the link enables it; locks hold', async ({ page, browser }) => {
  watchConsole(page, 'bot');
  const pw = (await links(page.request)).find((l) => l.name === 'DOD pw');
  const { ctx, page: anon } = await anonymous(browser);
  // bot off: not offered
  const off = await (await page.request.post(`${RA}/${reportId}/public-links`, { data: { name: 'DOD bot off' } })).json();
  await anon.goto(`/d/r/${off.token}`);
  await expect(anon.getByTestId('public-report')).toBeVisible();
  expect(await (await anon.request.get(`${PUB}/${off.token}/ai/status`)).json()).toEqual({ enabled: false, ready: false });

  // bot on (through the modal), without a key: offered, honestly not ready
  await page.goto(`/dashboards/code/${reportId}`);
  await page.getByTestId('studio-share').click();
  await page.getByTestId(`public-link-row-${pw.id}`).click();
  await page.getByTestId('public-link-tab-aibot').click();
  await page.getByTestId('ai-bot-enable-toggle').click();
  await shot(page, 'j6-modal-aibot');
  await page.getByTestId('public-link-save').click();
  await expect(page.getByText(/Link updated/)).toBeVisible();
  await anon.goto(`/d/r/${pw.token}`);
  await anon.locator('input[type="password"]').fill(PASSWORD);
  await anon.keyboard.press('Enter');
  await expect(anon.getByTestId('public-report')).toBeVisible();
  const session = await anon.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('appbi_pub_session_'))
    .map((k) => JSON.parse(sessionStorage.getItem(k) || '{}').sessionToken)[0]);
  const status = await (await anon.request.get(`${PUB}/${pw.token}/ai/status`, { headers: { 'X-Public-Session': session } })).json();
  expect(status.enabled).toBe(true);
  test.info().annotations.push({ type: 'ai-bot-ready', description: String(status.ready) });
  await shot(anon, 'j6-public-bot');

  // The panel opens BESIDE the report (as on a dashboard link), never below or over it:
  // the report narrows and keeps its height; closing gives the width back. No model call:
  // the answer is a recorded envelope whose source points at binding b1.
  await anon.route(`**/public/reports/${pw.token}/ai/status`, (r) => r.fulfill({ json: { enabled: true, ready: true } }));
  await anon.route(`**/public/reports/${pw.token}/ai/answer`, (r) => r.fulfill({
    status: 200, headers: { 'content-type': 'text/event-stream' },
    body: `data: ${JSON.stringify({ type: 'accepted', turn_id: 't-dod' })}\n\n`
      + `data: ${JSON.stringify({ type: 'final', envelope: { v: 'chat.v1', status: 'answered', code: null, message: null,
        data: { answer: { text: 'Doanh thu: 1.234', checks: [] }, columns: [], rows: [],
          evidence: { source: 'Không trùng tiêu đề nào', chart_id: 1, anchors: ['b1'], filters_applied: [] } },
        supporting: null, notices: [] } })}\n\n`
      + `data: ${JSON.stringify({ type: 'done' })}\n\n`,
  }));
  for (const [w, h] of [[1440, 900], [820, 1100], [390, 844]] as const) {
    await anon.setViewportSize({ width: w, height: h });
    await anon.reload();
    await expect(anon.getByTestId('public-report')).toBeVisible();
    const frameEl = anon.getByTestId('report-frame');
    await expect(frameEl).toBeVisible();
    const before = (await frameEl.boundingBox())!;
    await anon.getByTestId('ai-bot-open').click();
    const panel = anon.getByTestId('ai-bot-panel');
    await expect(panel).toBeVisible();
    const p = (await panel.boundingBox())!;
    const during = (await frameEl.boundingBox())!;
    expect(p.x, `${w}: the panel is on the right of the report`).toBeGreaterThanOrEqual(during.x + during.width - 2);
    expect(p.y, `${w}: never pushed below the report`).toBeLessThan(during.y + during.height);
    expect(p.x + p.width, `${w}: inside the viewport`).toBeLessThanOrEqual(w + 1);
    expect(during.width, `${w}: the report narrows`).toBeLessThan(before.width - 100);
    expect(Math.abs(during.height - before.height), `${w}: the report keeps its height`).toBeLessThan(4);
    expect(await anon.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${w}: no horizontal scroll`).toBe(true);
    await shot(anon, `j6-bot-open-${w}`);
    if (w === 1440) {
      // the source chip scrolls to the block that draws b1 - by its binding id, not its title
      await anon.getByTestId('ai-bot-input').fill('Doanh thu?');
      await anon.getByTestId('ai-bot-send').click();
      await anon.getByTestId('ai-bot-chart-chip').first().click();
      const frame = anon.frameLocator('[data-testid="report-frame"]');
      await expect(frame.locator('.rac-flash').first()).toBeVisible({ timeout: 5_000 });
      expect(await frame.locator('.rac-flash [data-rac-bind="b1"], .rac-flash[data-rac-bind="b1"], .rac-flash [data-rac-value="b1"]').count()).toBeGreaterThan(0);
      await shot(anon, 'j6-bot-source-focus');
    }
    await anon.getByTestId('ai-bot-close').click();
    await expect(panel).toBeHidden();
    const after = (await frameEl.boundingBox())!;
    expect(Math.abs(after.width - before.width), `${w}: closing restores the width`).toBeLessThan(4);
  }
  await anon.unroute('**/ai/status');
  await anon.unroute('**/ai/answer');
  await anon.setViewportSize({ width: 1440, height: 900 });
  // the embed of a report, as of a dashboard, has no AI Bot
  await anon.goto(`/embed/r/${pw.token}`);
  await expect(anon.getByTestId('public-report')).toBeVisible();
  await expect(anon.getByTestId('ai-bot-open')).toHaveCount(0);
  // without the password the bot is closed too
  expect((await anon.request.get(`${PUB}/${pw.token}/ai/status`)).status()).toBe(401);
  // a viewer cannot loosen the lock by asking: refused before any turn is admitted (no model call)
  const ask = { question: 'Doanh thu?', conversation_key: `conv-${STAMP}0000`, idempotency_key: `idem-${STAMP}0000`,
    viewer_state: { f1: ['__other__'] } };
  expect((await anon.request.post(`${PUB}/${pw.token}/ai/answer`, { data: ask, headers: { 'X-Public-Session': session } })).status()).toBe(400);
  await page.request.delete(`${RA}/${reportId}/public-links/${off.id}`);
  await ctx.close();
});

test('J7 Manual Dashboard regression: Public Modal and AI Bot surface unchanged', async ({ page, browser }) => {
  watchConsole(page, 'manual');
  // a dashboard WITH slicers (the 'Giới hạn' option below exists only then): the CI fixture
  // (seed_e2e_presentation.py), or locally the first manual one when it was never seeded
  const dashes = await (await page.request.get(`${API}/api/v1/dashboards/`)).json();
  const fx = (Array.isArray(dashes) ? dashes : dashes.items || []).find((d: any) => d.name === 'E2E Presentation fixture');
  expect(fx || !process.env.CI, 'the E2E Presentation fixture dashboard exists on CI').toBeTruthy();
  await page.goto('/dashboards?type=manual');
  if (fx) await page.getByPlaceholder(/Search|Tìm/).first().fill('E2E Presentation fixture');
  const firstPublic = fx ? page.getByTestId(`report-row-manual-${fx.id}-public`)
    : page.locator('[data-testid^="report-row-manual-"][data-testid$="-public"]').first();
  await expect(firstPublic).toBeVisible();
  const key = (await firstPublic.getAttribute('data-testid'))!.replace('report-row-', '').replace('-public', '');
  const dashId = Number(key.replace('manual-', ''));
  await firstPublic.click();
  await page.getByTestId('public-link-new').click();
  await page.getByTestId('public-link-name').fill('DOD manual');
  await expect(page.getByRole('button', { name: /Show page tabs/ })).toBeVisible();
  await page.getByTestId('public-link-tab-aibot').click();
  await page.getByTestId('ai-bot-enable-toggle').click();
  await expect(page.getByText('Agent Flow hỗ trợ (tuỳ chọn)')).toBeVisible();
  await page.getByTestId('ai-bot-enable-toggle').click();
  await page.getByTestId('public-link-tab-data').click();
  // this dashboard has slicers: the dashboard-only 'Giới hạn' option must still be offered
  await expect(page.locator('[data-testid^="public-link-filter-row-"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('public-link-filter-action-limit').first()).toBeVisible();
  await shot(page, 'j7-manual-modal');
  await page.getByTestId('public-link-create').click();
  await expect(page.getByText(/Public link created/)).toBeVisible();
  const dl = (await (await page.request.get(`${API}/api/v1/dashboards/${dashId}/public-links`)).json()).find((l: any) => l.name === 'DOD manual');
  const { ctx, page: anon } = await anonymous(browser);
  await anon.goto(`/d/${dl.token}`);
  await expect(anon.getByText(/Dashboard not available|not found/i)).toHaveCount(0);
  await anon.waitForTimeout(3000);
  await shot(anon, 'j7-manual-public');
  expect(await (await anon.request.get(`${API}/api/v1/public/dashboards/${dl.token}/ai/status`)).json()).toEqual({ enabled: false, ready: false });
  await page.request.delete(`${API}/api/v1/dashboards/${dashId}/public-links/${dl.id}`);
  await ctx.close();
});

test('J8 Responsive 1440 / 820 / 390: list, studio, public — no horizontal overflow', async ({ page, browser }) => {
  const pw = (await links(page.request)).find((l) => l.name === 'DOD pw');
  const { ctx, page: anon } = await anonymous(browser);
  await anon.goto(`/d/r/${pw.token}`);
  await anon.locator('input[type="password"]').fill(PASSWORD);
  await anon.keyboard.press('Enter');
  await expect(anon.getByTestId('public-report')).toBeVisible();
  for (const [w, h] of [[1440, 900], [820, 1180], [390, 844]] as const) {
    for (const [p, url, name] of [[page, '/dashboards', 'list'], [page, `/dashboards/code/${reportId}`, 'studio'], [anon, null, 'public']] as const) {
      await p.setViewportSize({ width: w, height: h });
      if (url) await p.goto(url);
      await p.waitForTimeout(1500);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, `${name} @${w} scrolls sideways by ${over}px`).toBeLessThanOrEqual(1);
      await shot(p, `j8-${name}-${w}`);
    }
  }
  await page.request.delete(`${RA}/${reportId}/public-links/${pw.id}`);
  await ctx.close();
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
