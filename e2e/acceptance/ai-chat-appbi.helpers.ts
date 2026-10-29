import { expect, request, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

/**
 * Shared steps for the unified AI Chat acceptance on the REAL AppBI stack (Compose project
 * appbi-ai, http://localhost:3000). The accounts are the dedicated QA accounts the owner
 * approved (qa-chat-owner / -viewer / -nomodule @qa.appbi.io); their passwords live in a
 * file outside the repo (QA_ACCOUNTS_FILE) and are never printed. Numbers are compared with
 * an INDEPENDENT SQL oracle (ORACLE_FILE: hand-written SQL on the raw BigQuery tables).
 */
export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
export const DOMAIN = 'qa.appbi.io';
export const OLIST = 'Olist E-Commerce';
/** BigQuery (base-testlab-01 / dw_buoi_7): reachable from this stack, governed measures, a CERTIFIED DATE
 *  (declared date, physical type date) - the only kind of field a period filter may use. */
export const DA3 = 'DA3 Sales Performance (no-date)';
/** The same BigQuery tables, but its date's physical type was never recorded: a period must be refused. */
export const DA3_UNCERTIFIED = 'DA3 Sales Performance Analytics';
const ACCOUNTS: Record<string, string> = JSON.parse(fs.readFileSync(process.env.QA_ACCOUNTS_FILE || '', 'utf-8'));
export const ORACLE: Record<string, Record<string, number>> = JSON.parse(fs.readFileSync(process.env.ORACLE_FILE || '', 'utf-8'));
export const EXT: { flow_key: string; flow_name: string; doc_id: number; doc_title: string } =
  JSON.parse(fs.readFileSync(process.env.EXT_FILE || '', 'utf-8'));
export const OUTCOME = ['chat-answer', 'chat-clarify', 'chat-unsupported', 'chat-no-data-part', 'chat-refused',
  'chat-failed', 'chat-cancelled', 'chat-error'].map((t) => `[data-testid="${t}"]`).join(', ');

/** Every console error / page error / failed API request of a page, for the console findings. */
export function watch(page: Page) {
  const found: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Download the React DevTools|ResizeObserver loop/i.test(m.text())) return;
    // Google's own Sign-In button iframe on /login intermittently answers 403 for this
    // localhost origin (OAuth client configuration, not AppBI) - reported, not hidden
    if (m.location().url.startsWith('https://accounts.google.com/')) return;
    if (m.text().startsWith('[GSI_LOGGER]: The given origin is not allowed for the given client ID')) return;
    // KNOWN PRE-EXISTING DEFECT (unchanged since demo 0b48f597, reported): Dashboards /
    // Datasets / Explore list data sources for every user, so a user without the
    // data_sources module gets a 403 the backend rightly returns. Only this exact call.
    if (/status of 403/.test(m.text()) && /\/api\/v1\/datasources\/$/.test(m.location().url)) return;
    found.push(`console: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => found.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/') && r.status() >= 500) found.push(`http ${r.status()} ${r.url()}`);
  });
  return found;
}

export async function login(page: Page, who: string) {
  await page.context().clearCookies();
  for (let attempt = 1; ; attempt += 1) {
    await page.goto('/login');
    await page.locator('input[type="email"]').first().fill(`${who}@${DOMAIN}`);
    await page.locator('input[type="password"]').first().fill(ACCOUNTS[who]);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/login'));
    await page.getByRole('button', { name: /sign in|đăng nhập|log in/i }).first().click();
    const status = (await answer).status();
    if (status === 429 && attempt < 3) { await page.waitForTimeout(65_000); continue; }
    expect(status, 'UI login').toBe(200);
    break;
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
}

/** PRECONDITIONS ONLY: the QA owner's own API session, in its own request context. */
export async function api(who = 'qa-chat-owner') {
  const ctx = await request.newContext({ baseURL: BASE });
  const r = await ctx.post('/api/v1/auth/login', { data: { email: `${who}@${DOMAIN}`, password: ACCOUNTS[who] } });
  expect(r.status(), 'precondition login').toBe(200);
  const headers = { Authorization: `Bearer ${(await r.json()).access_token}` };
  return { ctx, headers };
}

/** The model the QA journeys choose, and the QA OpenAI key: a file outside every repo
 *  (QA_OPENAI_KEY_FILE), read here only, never printed or written to a step title. */
export const QA_MODEL = process.env.QA_CHAT_MODEL || 'gpt-4o-mini';

export function qaKey(): string {
  const key = fs.readFileSync(process.env.QA_OPENAI_KEY_FILE || '', 'utf-8').trim();
  expect(key.length > 20, 'QA_OPENAI_KEY_FILE holds a key').toBe(true);
  return key;
}

/** Put a secret into an input the way typing does (React sees an input event) without
 *  the value appearing in a Playwright step title. */
export async function fillSecret(target: Locator, value: string) {
  await target.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** PO 2026-10-28: every conversation runs on the model and key its owner chooses. A
 *  new or not-yet-configured conversation is given QA_MODEL and the QA key - pasted the
 *  first time, then the key pasted before is reused. */
export async function ensureModel(page: Page) {
  const panel = page.getByTestId('chat-model');
  if (!(await panel.count()) || (await panel.getAttribute('data-ready')) === 'true') return;
  if (!(await page.getByTestId('chat-model-key').count())) return;   // not this person's conversation
  await page.getByTestId('chat-model-provider').selectOption('openai');
  await page.getByTestId('chat-model-model').selectOption(QA_MODEL);
  const reuse = page.getByTestId('chat-model-reuse');
  if (await reuse.count()) {
    await reuse.selectOption(String(await reuse.locator('option').nth(1).getAttribute('value')));
  } else {
    await fillSecret(page.getByTestId('chat-model-key'), qaKey());
  }
  const save = page.getByTestId('chat-model-save');
  if (await save.count()) {
    await save.click();
    await expect(panel).toHaveAttribute('data-ready', 'true');
  }
}

export async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
  await info.attach(name, { path, contentType: 'image/png' });
}

export async function openChat(page: Page, who = 'qa-chat-owner') {
  await login(page, who);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-page')).toBeVisible();
}

export async function chooseSource(page: Page, name = DA3) {
  const select = page.getByTestId('chat-source-select');
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  await select.selectOption(String(value));
}

/** Type a question and press Ask; wait for the NEW exchange's terminal outcome. */
export async function ask(page: Page, q: string, opts: { addOn?: boolean; timeout?: number } = {}): Promise<Locator> {
  const before = await page.getByTestId('chat-exchange').count();
  await ensureModel(page);
  if (opts.addOn) await page.getByTestId('chat-use-extension').check();
  await page.getByTestId('chat-question').fill(q);
  await page.getByTestId('chat-ask').click();
  const ex = page.getByTestId('chat-exchange').nth(before);
  await expect(ex.locator(OUTCOME).first()).toBeVisible({ timeout: opts.timeout ?? 120_000 });
  return ex;
}

/** The answer's data table as {label: value}; label = every dimension cell joined by " / ". */
export async function tableOf(scope: Locator): Promise<Record<string, number>> {
  await expect(scope.getByTestId('chat-table')).toBeVisible();
  const rows = await scope.getByTestId('chat-table').locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())));
  const out: Record<string, number> = {};
  for (const cells of rows) out[cells.slice(0, -1).join(' / ') || 'total'] = Number(cells[cells.length - 1].replace(/[^\d.-]/g, ''));
  return out;
}

export function expectOracle(got: Record<string, number>, key: string) {
  const want = ORACLE[key];
  expect(Object.keys(got).sort(), `groups of ${key}`).toEqual(Object.keys(want).sort());
  for (const [k, v] of Object.entries(want)) expect(Math.abs(got[k] - v), `${key} / ${k}: ${got[k]} vs SQL ${v}`).toBeLessThan(0.51);
}
