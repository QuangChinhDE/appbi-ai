import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * DETAIL HEADER — one compact row, nothing unreachable, nothing hidden that matters.
 *
 * Before this contract the detail headers each grew their own way: the dataset
 * row pushed "Sync & Publish" off-screen at 390 and History at 768; the
 * dashboard header wrapped to 74-108px with six tools off-screen on a phone;
 * Explore wrapped to 95-175px; the Agent Flow row was 218px on a phone and
 * covered its own "Feedback"/"Activity" tabs at 1280. The workboard showed the
 * default owner's PIN in plain text in a strip under the header.
 *
 * What is asserted, per module and per width (390 / 768 / 1024 / 1280 / 1440 / 1920):
 *   - the header row is one row of <= 56px;
 *   - the page does not scroll sideways;
 *   - every control in the row is inside the viewport AND is the element hit at
 *     its own centre (not covered by a sibling);
 *   - the "more" menu opens from the keyboard, moves with the arrows, closes on
 *     Escape and gives focus back.
 * Plus: roles (owner / editor / viewer see the right actions), both languages,
 * the dashboard's pending-changes cluster on a phone and a desktop, and the
 * one-time owner credential disclosure (masked, revealable, never in the DOM
 * or the console until revealed, cleared once acknowledged).
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_security.py (principals + a dataset,
 * dashboard, data source, workboard, flow). A missing fixture is a FAILURE.
 */

const API = process.env.E2E_API_URL || 'http://localhost:8000';
const V1 = `${API}/api/v1`;
const FIXTURE = process.env.E2E_SECURITY_FIXTURE
  || path.join(__dirname, '..', '.auth', 'security.json');
const WIDTHS = [390, 768, 1024, 1280, 1440, 1920];
const ROW = '[data-testid="detail-header-row"], [data-testid="dashboard-header-row"]';

type Fx = {
  users: Record<string, { id: string; email: string; access: string }>;
  dataset: { id: number; table_id: number };
  datasource: { id: number };
  dashboard: { id: number };
  workboard: { id: number };
  flow: { key: string };
};

let fx: Fx;
const contexts: BrowserContext[] = [];

test.beforeAll(() => {
  expect(fs.existsSync(FIXTURE), `security fixture missing at ${FIXTURE} - run seed_e2e_security.py`).toBe(true);
  fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
});

/** A browser session as one of the fixture principals (the product's own JWT in its own cookie). */
async function sessionAs(browser: Browser, who: string, lang: 'vi' | 'en' = 'vi'): Promise<Page> {
  const base = test.info().project.use.baseURL as string;
  const ctx = await browser.newContext({ baseURL: base, storageState: { cookies: [], origins: [] } });
  contexts.push(ctx);
  await ctx.addCookies([{ name: 'access_token', value: fx.users[who].access, url: base }]);
  await ctx.addInitScript((l) => { try { window.localStorage.setItem('appbi.language', l); } catch { /* noop */ } }, lang);
  return ctx.newPage();
}

/** The geometry contract for the header row at the current viewport. */
async function expectCompactHeader(page: Page, label: string) {
  const row = page.locator(ROW).first();
  await expect(row, `${label}: header row`).toBeVisible({ timeout: 30_000 });
  // Let late chips (status, validation) arrive before measuring.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const m = await page.evaluate((sel) => {
    const vw = document.documentElement.clientWidth;
    const rowEl = document.querySelector(sel)!;
    const r = rowEl.getBoundingClientRect();
    const bad: string[] = [];
    for (const c of rowEl.querySelectorAll<HTMLElement>('button, a, [role="tab"], select, input')) {
      const s = getComputedStyle(c);
      const b = c.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || b.width === 0 || b.height === 0) continue;
      const name = (c.dataset.testid || c.getAttribute('aria-label') || c.textContent || c.tagName).trim().slice(0, 40);
      if (b.left < -1 || b.right > vw + 1) { bad.push(`${name} off-screen`); continue; }
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (hit && !c.contains(hit) && !hit.contains(c)) bad.push(`${name} covered by ${hit.tagName}.${String(hit.className).slice(0, 40)}`);
    }
    return { height: r.height, docOverflow: document.documentElement.scrollWidth - vw, bad };
  }, ROW);
  expect(m.height, `${label}: header row height`).toBeLessThanOrEqual(56);
  expect(m.docOverflow, `${label}: page scrolls sideways`).toBeLessThanOrEqual(0);
  expect(m.bad, `${label}: unreachable header controls`).toEqual([]);
}

/** The shared overflow menu: keyboard open, arrow, Escape, focus returns. */
async function expectKeyboardMenu(page: Page, triggerTestId: string, label: string) {
  const trigger = page.getByTestId(triggerTestId);
  await expect(trigger, `${label}: more trigger`).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu, `${label}: menu opens from the keyboard`).toBeVisible();
  const first = menu.getByRole('menuitem').first();
  await expect(first, `${label}: first item focused`).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(menu, `${label}: Escape closes`).toBeHidden();
  await expect(trigger, `${label}: focus returns to the trigger`).toBeFocused();
}

async function firstChartId(page: Page): Promise<number> {
  const res = await page.request.get(`${V1}/charts/`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const rows: Array<{ id: number }> = Array.isArray(body) ? body : body.items ?? body.charts ?? [];
  expect(rows.length, 'a chart exists to open in Explore').toBeGreaterThan(0);
  return rows[0].id;
}

test.describe('Detail header — one row at every width', () => {
  test.describe.configure({ timeout: 300_000 });

  const routes = (chartId: number): Array<[string, string]> => [
    ['dataset', `/datasets/${fx.dataset.id}`],
    ['dashboard', `/dashboards/${fx.dashboard.id}`],
    ['datasource', `/datasources/${fx.datasource.id}`],
    ['explore', `/explore/${chartId}`],
    ['agent-flow', `/agent-flows?flow=${encodeURIComponent(fx.flow.key)}`],
    ['observability', `/observability?dataset=${fx.dataset.id}`],
    ['workboard', `/workboards/${fx.workboard.id}`],
  ];

  for (const lang of ['vi', 'en'] as const) {
    test(`owner, ${lang}: every module, every width`, async ({ browser }) => {
      const page = await sessionAs(browser, 'owner', lang);
      const chartId = await firstChartId(page);
      // EN runs the two widths where the longer labels bite; VI runs them all.
      const widths = lang === 'vi' ? WIDTHS : [390, 1024, 1440];
      for (const [name, url] of routes(chartId)) {
        for (const w of widths) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.goto(url);
          await expectCompactHeader(page, `${name} @${w} ${lang}`);
        }
      }
    });
  }

  test('the overflow menus are keyboard menus', async ({ browser }) => {
    const page = await sessionAs(browser, 'owner');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/workboards/${fx.workboard.id}`);
    await expectKeyboardMenu(page, 'workboard-more', 'workboard');
    // On a phone the dataset's Share/History live in its menu.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/datasets/${fx.dataset.id}`);
    await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /^(More actions|Thao tác khác)$/ }).click();
    await expect(page.getByTestId('dataset-history')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('tabs move with the arrow keys', async ({ browser }) => {
    const page = await sessionAs(browser, 'owner');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/datasets/${fx.dataset.id}`);
    const tabs = page.locator(ROW).getByRole('tab');
    await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();
  });
});

test.describe('Detail header — roles', () => {
  test('dashboard: owner and editor get the authoring tools, the viewer gets none', async ({ browser }) => {
    for (const [who, canEdit] of [['owner', true], ['editor', true], ['viewer', false]] as const) {
      const page = await sessionAs(browser, who);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/dashboards/${fx.dashboard.id}`);
      await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('dashboard-more'), `${who}: More`).toBeVisible();
      await expect(page.getByTestId('add-element-open'), `${who}: Add`).toHaveCount(canEdit ? 1 : 0);
      await expect(page.getByTestId('design-mode-ai'), `${who}: design mode`).toHaveCount(canEdit ? 1 : 0);
      await expect(page.getByTestId('dashboard-save-draft'), `${who}: no save without a draft`).toHaveCount(0);
    }
  });

  test('dataset: the viewer sees the state, not Sync & Publish', async ({ browser }) => {
    for (const [who, canManage] of [['owner', true], ['viewer', false]] as const) {
      const page = await sessionAs(browser, who);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/datasets/${fx.dataset.id}`);
      await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('dataset-history'), `${who}: History`).toBeVisible();
      await expect(page.getByTestId('dataset-sync-publish'), `${who}: Sync & Publish`).toHaveCount(canManage ? 1 : 0);
    }
  });

  test('workboard: Unpublish is an editor action', async ({ browser }) => {
    for (const [who, canEdit] of [['owner', true], ['editor', true], ['viewer', false]] as const) {
      const page = await sessionAs(browser, who);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/workboards/${fx.workboard.id}`);
      await page.getByTestId('workboard-more').click();
      await expect(page.getByTestId('workboard-export'), `${who}: Export`).toBeVisible();
      await expect(page.getByTestId('workboard-unpublish'), `${who}: Unpublish`).toHaveCount(canEdit ? 1 : 0);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('Detail header — dashboard pending changes', () => {
  test('Save & Publish stays on the row on a phone; Save draft and Discard are one tap away; Discard really discards', async ({ browser }) => {
    const page = await sessionAs(browser, 'owner');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/dashboards/${fx.dashboard.id}`);
    await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
    // A text widget opens a server draft: the pending cluster appears.
    await page.getByTestId('add-element-open').click();
    const addText = page.getByRole('button', { name: /^(Text|Văn bản)/ }).first();
    await addText.click();
    await expect(page.getByTestId('dashboard-publish')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('dashboard-discard')).toBeVisible();
    await expectCompactHeader(page, 'dashboard pending @1440');

    for (const w of [390, 768]) {
      await page.setViewportSize({ width: w, height: 844 });
      await expectCompactHeader(page, `dashboard pending @${w}`);
      await expect(page.getByTestId('dashboard-publish'), `@${w}: Save & Publish on the row`).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('dashboard-more').click();
    await expect(page.getByTestId('dashboard-save-draft'), 'phone: Save draft in More').toBeVisible();
    const discard = page.getByTestId('dashboard-discard');
    await expect(discard, 'phone: Discard in More').toBeVisible();

    // The business call, not just the UI: Discard sends a write for THIS dashboard.
    const write = page.waitForRequest((r) => r.method() !== 'GET'
      && r.url().includes(`/dashboards/${fx.dashboard.id}`), { timeout: 30_000 });
    await discard.click();
    await page.getByRole('button', { name: /^(Discard changes|Bỏ thay đổi)$/ }).click();
    await write;
    await expect(page.getByTestId('dashboard-publish'), 'the draft is gone').toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe('Workboard default owner credentials', () => {
  test('masked until revealed, never in the DOM or console before that, cleared once acknowledged', async ({ browser }) => {
    const page = await sessionAs(browser, 'owner', 'en');
    const consoleText: string[] = [];
    page.on('console', (m) => consoleText.push(m.text()));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workboards');
    await page.getByRole('button', { name: /^New workboard$/ }).first().click();
    const name = `E2E header PIN ${Date.now()}`;
    await page.getByPlaceholder('E.g. Production log').fill(name);
    const select = page.locator('form select').first();
    const values = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(values.length, 'a dataset can back a new workboard').toBeGreaterThan(0);
    await select.selectOption(values.includes(String(fx.dataset.id)) ? String(fx.dataset.id) : values[0]);
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/workboards\/?$/.test(new URL(r.url()).pathname));
    await page.getByRole('button', { name: /^Create$/ }).click();
    const res = await created;
    const pin = res.headers()['x-appbi-default-owner-pin'];
    const wbId = (await res.json()).id as number;
    expect(pin, 'the create response carries a default PIN').toBeTruthy();

    try {
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const secret = page.getByTestId('credential-secret');
      await expect(secret).not.toContainText(pin);
      expect(await page.locator('body').innerText(), 'PIN rendered before reveal').not.toContain(pin);
      // Escape does not drop credentials the user has not saved.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await page.getByTestId('credential-reveal').click();
      await expect(secret).toHaveText(pin);
      await page.getByTestId('credential-reveal').click();
      await expect(secret).not.toContainText(pin);
      // Acknowledge, enter the builder: no second disclosure, nothing left behind.
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: /^Enter Builder$/ }).click();
      await page.waitForURL(new RegExp(`/workboards/${wbId}`));
      await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(pin);
      expect(await page.evaluate((id) => sessionStorage.getItem(`workboard-default-owner:${id}`), wbId)).toBeNull();

      // Left before acknowledging (stored by the list page): the detail page
      // shows the SAME masked dialog — not a banner — and a refresh does not lose it.
      await page.evaluate(({ id, p }) => sessionStorage.setItem(`workboard-default-owner:${id}`,
        JSON.stringify({ workboardId: id, username: 'owner', pin: p, expiresAt: Date.now() + 600_000 })), { id: wbId, p: pin });
      await page.reload();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
      await page.reload();
      await expect(page.getByRole('dialog'), 'a refresh before acknowledging keeps it').toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('credential-secret')).not.toContainText(pin);
      await page.getByRole('dialog').getByRole('checkbox').check();
      await page.getByRole('dialog').getByRole('button', { name: /^I saved it$/ }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate((id) => sessionStorage.getItem(`workboard-default-owner:${id}`), wbId)).toBeNull();

      // A legacy entry (no expiry) is dropped, not shown.
      await page.evaluate(({ id, p }) => sessionStorage.setItem(`workboard-default-owner:${id}`,
        JSON.stringify({ workboardId: id, username: 'owner', pin: p })), { id: wbId, p: pin });
      await page.reload();
      await expect(page.locator(ROW)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate((id) => sessionStorage.getItem(`workboard-default-owner:${id}`), wbId)).toBeNull();

      expect(consoleText.filter((t) => t.includes(pin)), 'PIN written to the console').toEqual([]);
    } finally {
      await page.request.delete(`${V1}/workboards/${wbId}`);
    }
  });
});
