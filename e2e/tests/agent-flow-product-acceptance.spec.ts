import { expect, test, type Page } from '@playwright/test';

/**
 * Agent Flow — real product acceptance, as a reader sees it.
 *
 * Every test drives the SAME UI a reader uses (public report AI panel, AI Chat) and
 * grades the LIVE answer against values known from the fixture — never a canned
 * response, never a backend-only assertion. Retries are off: a flaky answer is a
 * finding, not noise to retry away.
 *
 * Fixture: the SaaS correctness dataset (backend/tests/test_correctness_closure.py)
 * on a report with charts "SaaS theo tháng" (table), "ARR theo tháng", "ARR (cộng
 * dồn mọi kỳ)" and "ARR theo phân khúc", a report slicer "Gói" on plan_code, and:
 *   PA_LINK_TOKEN        public link with a published report flow assigned
 *   PA_LOCKED_TOKEN      link locked to Gói 103, flow may read only the 3 monthly charts
 *   PA_UNASSIGNED_TOKEN  AI-enabled link with NO flow assigned
 *   PA_READER_EMAIL / PA_READER_PASSWORD  a Chat reader with "Trợ lý chỉ số SaaS"
 *                        (dataset delegated) and "Trợ lý quy ước Olist" (documents 25/26/30)
 * Without them the journeys are SKIPPED, never faked. Cost: ~$0.05 per full run.
 *
 * Ground truth: ARR Jul 864 / Aug 72 (−792, −91,7 %); churn Jan–Aug 60, plan 104 → 43;
 * segments enterprise 5000 / smb 1200 / startup 300; GMV = paid goods value,
 * cancelled orders excluded, refunds not deducted (document 26).
 */
test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ storageState: { cookies: [], origins: [] } });

const LINK = process.env.PA_LINK_TOKEN || '';
const LOCKED = process.env.PA_LOCKED_TOKEN || '';
const UNASSIGNED = process.env.PA_UNASSIGNED_TOKEN || '';
const READER = process.env.PA_READER_EMAIL || '';
const READER_PW = process.env.PA_READER_PASSWORD || '';
const TURN_MS = 240_000;

/** The text the page shows AFTER the last occurrence of `question` — this turn's answer. */
async function answerTo(page: Page, question: string): Promise<string> {
  const all = await page.locator('body').innerText();
  const at = all.lastIndexOf(question);
  expect(at, `the question "${question}" is on the page`).toBeGreaterThanOrEqual(0);
  return all.slice(at + question.length);
}

async function openPublicAi(page: Page, token: string) {
  await page.goto(`/d/${token}`);
  await page.getByRole('button', { name: /Open AI Assistant|Mở AI Assistant/ }).click();
  await expect(page.locator('textarea').last()).toBeVisible({ timeout: 30_000 });
}

async function askPublic(page: Page, question: string): Promise<string> {
  const box = page.locator('textarea').last();
  await box.fill(question);
  await box.press('Enter');
  const stop = page.getByRole('button', { name: /Stop generating|Dừng/ });
  await expect(stop.first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  await expect(stop).toHaveCount(0, { timeout: TURN_MS });
  return answerTo(page, question);
}

async function askChat(page: Page, question: string): Promise<string> {
  await page.locator('[data-chat-input]').fill(question);
  await page.getByRole('button', { name: /^(Gửi|Send)$/ }).click();
  const stop = page.getByRole('button', { name: /^(Dừng|Stop)$/ });
  await expect(stop.first()).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  await expect(stop).toHaveCount(0, { timeout: TURN_MS });
  return answerTo(page, question);
}

const WITHHELD = /đã ẩn: chưa kiểm chứng|withheld: not verified/;

test.describe('public report AI (anonymous viewer)', () => {
  test('a number, its month-on-month change, and no control that controls nothing', async ({ page }) => {
    test.skip(!LINK, 'PA_LINK_TOKEN not set');
    test.setTimeout(2 * TURN_MS + 60_000);
    await openPublicAi(page, LINK);
    // F03/P06: the flow decides model, key and depth — the viewer is offered none of them.
    await expect(page.getByRole('button', { name: /Tự động|Nhanh|Sâu/ })).toHaveCount(0);
    await expect(page.getByPlaceholder(/API key/i)).toHaveCount(0);

    const a1 = await askPublic(page, 'ARR tháng 8 năm 2026 là bao nhiêu?');
    expect(a1).toMatch(/\b72\b/);
    expect(a1).not.toMatch(WITHHELD);
    const a2 = await askPublic(page, 'So với tháng trước thì sao?');
    expect(a2, 'August against JULY, not another pair of months').toMatch(/792/);
    expect(a2).toMatch(/91[,.]7/);
    expect(a2).not.toMatch(WITHHELD);
  });

  test('the report slicer the viewer picks is the scope of the next answer', async ({ page }) => {
    test.skip(!LINK, 'PA_LINK_TOKEN not set');
    test.setTimeout(2 * TURN_MS + 60_000);
    await openPublicAi(page, LINK);
    const q = 'Tổng số khách hàng rời bỏ là bao nhiêu?';
    expect(await askPublic(page, q)).toMatch(/\b60\b/);

    const slicer = page.locator('[data-slicer-id="sl-plan"]').first();
    await slicer.scrollIntoViewIfNeeded();
    await slicer.getByText('104', { exact: true }).click();
    await page.getByRole('button', { name: /^(Apply|Áp dụng)$/ }).first().click();

    const after = await askPublic(page, q);
    expect(after).toMatch(/\b43\b/);
    expect(after, "the viewer's own filter value is a label, never withheld").not.toMatch(WITHHELD);
  });

  test('a locked link: its lock is kept and a chart outside its allowlist is not read', async ({ page }) => {
    test.skip(!LOCKED, 'PA_LOCKED_TOKEN not set');
    test.setTimeout(TURN_MS + 60_000);
    await page.goto(`/d/${LOCKED}`);
    await expect(page.getByText(/Gói:\s*103/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Open AI Assistant|Mở AI Assistant/ }).click();
    const a = await askPublic(page, 'ARR theo phân khúc khách hàng (enterprise, smb, startup) là bao nhiêu?');
    for (const leaked of [/5[.,]?000/, /1[.,]?200/, /\b300\b/]) expect(a).not.toMatch(leaked);
  });

  test('"Phân tích toàn diện" refuses where the assistant is not set up — in words for the viewer', async ({ page }) => {
    test.skip(!UNASSIGNED, 'PA_UNASSIGNED_TOKEN not set');
    await openPublicAi(page, UNASSIGNED);
    await page.getByRole('button', { name: /Phân tích toàn diện/ }).first().click();
    const refusal = page.getByText(/chưa được thiết lập/).first();
    await expect(refusal).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Agent Flow|ChatBot của link/)).toHaveCount(0);
  });
});

test.describe('AI Chat (signed-in reader)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!READER || !READER_PW, 'PA_READER_EMAIL / PA_READER_PASSWORD not set');
    await page.goto('/login');
    await page.locator('input[type="email"], input[name="email"]').first().fill(READER);
    await page.locator('input[type="password"]').first().fill(READER_PW);
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
    await page.goto('/chat');
  });

  async function startWith(page: Page, assistant: string) {
    await page.getByText(assistant).first().click();
    await page.getByRole('button', { name: /New conversation|Cuộc trò chuyện mới/ }).first().click();
    await expect(page.locator('[data-chat-input]')).toBeVisible();
  }

  test('a metric conversation keeps its month across follow-ups', async ({ page }) => {
    test.setTimeout(2 * TURN_MS + 60_000);
    await startWith(page, 'Trợ lý chỉ số SaaS');
    const a1 = await askChat(page, 'ARR tháng 8 năm 2026 là bao nhiêu?');
    expect(a1).toMatch(/\b72\b/);
    const a2 = await askChat(page, 'So với tháng trước thì sao?');
    expect(a2).toMatch(/792/);
    expect(a2).toMatch(/91[,.]7/);
    expect(a2).not.toMatch(WITHHELD);
  });

  test('a document assistant answers from the document, cited, with no false figure warning', async ({ page }) => {
    test.setTimeout(TURN_MS + 60_000);
    await startWith(page, 'Trợ lý quy ước Olist');
    const a = await askChat(page, 'GMV được tính như thế nào?');
    expect(a).toMatch(/thanh toán/);
    expect(a).toMatch(/hu[ỷy]/);
    expect(a).toMatch(/hoàn/);
    expect(a).not.toMatch(/do not match the data|không khớp với dữ liệu/);
  });
});
