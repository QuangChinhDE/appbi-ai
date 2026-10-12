import fs from 'node:fs';
import path from 'node:path';

import {
  APIRequestContext, Browser, BrowserContext, ConsoleMessage, expect, Page, test,
} from '@playwright/test';

/**
 * AI Chat — the reader's journeys, in a real browser, against a real backend.
 *
 * WHAT IS REAL. Every turn goes through the real engine over real SSE and is
 * recorded as a real run: the seeded flows (`seed_e2e_chat.py`) answer with
 * `stop` / `delay`+`stop` nodes, which need no AI provider. Sharing, revoking,
 * rating and reading back are real HTTP against real Postgres.
 *
 * WHAT IS NOT. Answer QUALITY from a live model is not asserted anywhere here,
 * and nothing here may be reported as live-model certification. One journey
 * (structured blocks) intercepts a single GET to feed the renderer a typed
 * answer the LLM-free flows cannot produce; it says so where it does it, and
 * the server half of that contract is locked by the Postgres test
 * `test_restored_answer_keeps_its_blocks_and_stays_reader_safe`.
 *
 * Each principal is its own browser context carrying only its own token.
 */

const FIXTURE = process.env.E2E_CHAT_FIXTURE
  || path.join(__dirname, '..', '..', '.auth', 'chat.json');
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const CHAT = `${API}/api/v1/agent-flows/chat`;

type Who = 'author' | 'owner' | 'editor' | 'viewer' | 'overseer' | 'outsider' | 'unenrolled';
type Fx = {
  run: string;
  answer: string;
  slow_answer: string;
  users: Record<Who, { id: string; email: string; access: string }>;
  flows: { fast: string; slow: string };
};

let fx: Fx;
const opened: BrowserContext[] = [];
//: Every title this suite writes carries the run stamp: a second run against the
//: same database must not find the first run's conversations by name.
const STAMP = Date.now().toString(36);
const q = (s: string) => `${s} ${STAMP}`;

test.beforeAll(() => {
  // A missing fixture is a FAILURE, never a skip: a gate that skips is no gate.
  expect(fs.existsSync(FIXTURE), `chat fixture missing at ${FIXTURE} - run seed_e2e_chat.py`).toBe(true);
  fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
});

// Per TEST, not per worker: a context left open leaks its pages into the next
// test's failure screenshots and keeps its streams alive.
test.afterEach(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
});

// ── principals ────────────────────────────────────────────────────────────────
async function api(browser: Browser, who: Who): Promise<APIRequestContext> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${fx.users[who].access}` },
  });
  opened.push(ctx);
  return ctx.request;
}

type Watched = { page: Page; problems: string[] };

async function open(
  browser: Browser, who: Who,
  opts: { lang?: 'en' | 'vi'; viewport?: { width: number; height: number }; allow?: RegExp } = {},
): Promise<Watched> {
  const base = new URL(BASE);
  const ctx = await browser.newContext({
    baseURL: base.origin,
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    storageState: {
      cookies: [{ name: 'access_token', value: fx.users[who].access, domain: base.hostname, path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [],
    },
  });
  opened.push(ctx);
  const lang = opts.lang ?? 'en';
  await ctx.addInitScript((l) => { try { window.localStorage.setItem('appbi.language', l); } catch { /* */ } }, lang);
  const page = await ctx.newPage();
  // Console errors and failed API calls are FINDINGS, not noise. A journey that
  // expects a refusal names it in `allow`.
  const problems: string[] = [];
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (opts.allow && opts.allow.test(text)) return;
    problems.push(`console: ${text}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/v1/') || r.status() < 500) return;
    problems.push(`HTTP ${r.status()} ${r.request().method()} ${u}`);
  });
  return { page, problems };
}

async function newThreadWithTurn(req: APIRequestContext, flow: string, question: string): Promise<number> {
  const r = await req.post(`${CHAT}/threads`, { data: { brain_key: flow } });
  expect(r.status()).toBe(200);
  const id = (await r.json()).id as number;
  const s = await req.post(`${CHAT}/threads/${id}/messages`, { data: { question, lang: 'en' } });
  expect(s.status()).toBe(200);
  expect(await s.text()).toContain('"type": "done"');
  return id;
}

async function transcript(req: APIRequestContext, id: number): Promise<any> {
  const r = await req.get(`${CHAT}/threads/${id}`);
  expect(r.status()).toBe(200);
  return r.json();
}

const composer = (p: Page) => p.locator('[data-chat-input]');
const conversation = (p: Page) => p.locator('section').first();
const answers = (p: Page) => p.getByTestId('chat-answer');

async function ask(page: Page, question: string): Promise<void> {
  await composer(page).fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
}

function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

// ── 1-7, 18: the core conversation ───────────────────────────────────────────
test('core: open catalogue, pick an assistant, ask, follow up, reload, rate, rename, delete', async ({ browser }) => {
  const { page, problems } = await open(browser, 'owner');
  const owner = await api(browser, 'owner');

  await page.goto('/chat');
  const card = page.getByRole('button', { name: new RegExp(`E2E Doanh thu ${fx.run}`) }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(new RegExp(`brain=${fx.flows.fast}`));
  // Opening an assistant resumes its latest conversation by design; this
  // journey is about starting one.
  await page.locator('aside').getByTestId('chat-new-conversation').click();
  await expect(page).not.toHaveURL(/thread=/);
  await expect(composer(page)).toBeEnabled();

  // First question creates the thread; the request carries the UI language.
  const sent = page.waitForRequest((r) => r.url().includes('/messages') && r.method() === 'POST');
  await ask(page, q('Revenue in September?'));
  expect((await sent).postDataJSON()).toMatchObject({ question: q('Revenue in September?'), lang: 'en' });
  await expect(answers(page).last()).toContainText(fx.answer);
  await expect(page).toHaveURL(/thread=\d+/);
  const id = Number(new URL(page.url()).searchParams.get('thread'));
  await expect(page.getByTestId('chat-turn-status')).toHaveCount(0);

  // Multi-turn.
  await ask(page, q('And compared with August?'));
  await expect(answers(page)).toHaveCount(2);
  await expect(composer(page)).toBeEnabled();

  // What the server recorded == what is on screen.
  const t = await transcript(owner, id);
  expect(t.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(t.title).toBe(q('Revenue in September?'));

  // On the English UI the engine's Vietnamese integrity notice is worded in English.
  await expect(answers(page).first()).toContainText('the numbers have no source');
  // Reload restores it; the sidebar is titled from the first question.
  await page.reload();
  await expect(answers(page)).toHaveCount(2);
  await expect(conversation(page).getByText(q('And compared with August?'))).toBeVisible();
  await expect(page.locator('aside').getByRole('button', { name: q('Revenue in September?') })).toBeVisible();

  // 18. Feedback on a recorded answer persists and restores.
  const up = answers(page).first().getByRole('button', { name: 'Helpful', exact: true });
  await up.click();
  await expect(up).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await transcript(owner, id)).messages[1].rating).toBe('up');
  await page.reload();
  await expect(answers(page).first().getByRole('button', { name: 'Helpful', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Copy is offered on a finished answer.
  await expect(answers(page).first().getByRole('button', { name: 'Copy answer' })).toBeVisible();

  // 12. Rename then delete (owner).
  const row = page.locator('aside').getByRole('button', { name: q('Revenue in September?') });
  await row.hover();
  await page.locator('aside').getByRole('button', { name: 'Rename' }).first().click();
  const box = page.locator('aside').getByRole('textbox', { name: 'Rename' });
  await box.fill(q('Q3 revenue'));
  await box.press('Enter');
  await expect(page.locator('aside').getByRole('button', { name: q('Q3 revenue') })).toBeVisible();
  expect((await transcript(owner, id)).title).toBe(q('Q3 revenue'));

  await page.locator('aside').getByRole('button', { name: q('Q3 revenue') }).hover();
  await page.locator('aside').getByRole('button', { name: 'Delete' }).first().click();
  // The shared ConfirmDialog exposes no role="dialog" (follow-up, outside Chat);
  // its confirm button is the last "Delete" in the document.
  await expect(page.getByText('Delete this conversation?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page).not.toHaveURL(new RegExp(`thread=${id}`));
  expect((await owner.get(`${CHAT}/threads/${id}`)).status()).toBe(404);

  expect(problems).toEqual([]);
});

// ── 8-9: switching threads, including mid-stream ─────────────────────────────
test('switching thread mid-stream never writes the old turn into the new thread', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const other = await newThreadWithTurn(owner, fx.flows.slow, q('Earlier slow question'));
  const before = await transcript(owner, other);
  expect(before.messages).toHaveLength(2);

  const { page, problems } = await open(browser, 'owner');
  await page.goto(`/chat?brain=${fx.flows.slow}`);
  const inFlight = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(page, q('Stock at period end?'));
  await expect(page).toHaveURL(/thread=\d+/);
  await inFlight;                                                // the stream is OPEN on the server
  await expect(page.getByTestId('chat-stop')).toBeVisible();     // and still streaming
  const a = Number(new URL(page.url()).searchParams.get('thread'));
  expect(a).toBeGreaterThan(0);

  // Switch while A is still streaming.
  await page.locator('aside').getByRole('button', { name: q('Earlier slow question') }).click();
  await expect(page).toHaveURL(new RegExp(`thread=${other}`));
  await expect(conversation(page).getByText(q('Earlier slow question')).last()).toBeVisible();

  // A is recorded as abandoned by the server — and only THEN is B checked, so
  // the old turn has had every chance to leak.
  await expect.poll(async () => {
    const t = await transcript(owner, a);
    return t.messages.at(-1)?.status;
  }, { timeout: 20_000 }).toBe('failed');
  const ta = await transcript(owner, a);
  expect(ta.messages.at(-1).notices.map((n: any) => n.code)).toContain('turn_abandoned');

  await expect(answers(page)).toHaveCount(1);
  await expect(conversation(page).getByText(q('Stock at period end?'))).toHaveCount(0);
  await expect(conversation(page).getByText(fx.slow_answer)).toHaveCount(1); // B's own answer only
  const tb = await transcript(owner, other);
  expect(tb.messages).toHaveLength(2);                           // B untouched on the server too
  await expect(composer(page)).toBeEnabled();                    // no stuck spinner

  // Back to A: it shows honestly what happened.
  await page.locator('aside').getByRole('button', { name: q('Stock at period end?') }).click();
  await expect(page.getByText(/turn ended before an answer arrived|ended before an answer/i)).toBeVisible();
  expect(problems).toEqual([]);
});

// ── T3: two tabs, one conversation ───────────────────────────────────────────
test('a second tab cannot start a turn while the first is answering; history stays ordered', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const id = await newThreadWithTurn(owner, fx.flows.fast, q('Two tabs'));
  const tabA = await open(browser, 'owner');
  const tabB = await open(browser, 'owner', { allow: /423|Failed to load resource/ });
  const threadUrl = `/chat?brain=${fx.flows.fast}&thread=${id}`;
  await tabA.page.goto(threadUrl);
  await tabB.page.goto(threadUrl);
  await expect(answers(tabB.page)).toHaveCount(1);

  // A asks, B asks immediately after. With the fast flow either outcome is
  // legal (B refused while A runs, or admitted after it) — the slow-flow test
  // below pins the refusal deterministically.
  const aSent = tabA.page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(tabA.page, q('From tab A'));
  await aSent;
  const bSent = tabB.page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(tabB.page, q('From tab B'));
  const bStatus = (await bSent).status();
  // The fast flow may finish before B arrives; both outcomes are legal, and each
  // must be SAID honestly and recorded exactly once.
  if (bStatus === 423) {
    await expect(answers(tabB.page).last()).toContainText('still answering another question');
    await expect(tabB.page.getByTestId('chat-turn-status')).toContainText('failed');
  } else {
    expect(bStatus).toBe(200);
  }
  await expect.poll(async () => (await transcript(owner, id)).messages.filter((m: any) => m.role === 'user').length,
    { timeout: 20_000 }).toBe(bStatus === 423 ? 2 : 3);
  const qs = (await transcript(owner, id)).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
  expect(qs[0]).toBe(q('Two tabs'));
  expect(qs[1]).toBe(q('From tab A'));
  expect(new Set(qs).size).toBe(qs.length);                      // no duplicates
  expect([...tabA.problems, ...tabB.problems]).toEqual([]);
});

test('a slow turn holds the conversation: a second tab is refused, then admitted after', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const id = await newThreadWithTurn(owner, fx.flows.slow, q('Slow two tabs'));
  const threadUrl = `/chat?brain=${fx.flows.slow}&thread=${id}`;
  const tabA = await open(browser, 'owner');
  const tabB = await open(browser, 'owner', { allow: /423|Failed to load resource/ });
  await tabA.page.goto(threadUrl);
  await tabB.page.goto(threadUrl);
  const aSent = tabA.page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(tabA.page, q('Slow A'));
  await aSent;
  await expect(tabA.page.getByTestId('chat-stop')).toBeVisible();      // A is mid-answer

  const bSent = tabB.page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(tabB.page, q('Slow B'));
  expect((await bSent).status()).toBe(423);
  await expect(answers(tabB.page).last()).toContainText('still answering another question');
  await expect(composer(tabB.page)).toBeEnabled();

  await expect(answers(tabA.page).last()).toContainText(fx.slow_answer, { timeout: 30_000 });
  await ask(tabB.page, q('Slow B again'));
  await expect(answers(tabB.page).last()).toContainText(fx.slow_answer, { timeout: 30_000 });
  const qs = (await transcript(owner, id)).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
  expect(qs).toEqual([q('Slow two tabs'), q('Slow A'), q('Slow B again')]);   // ordered, refused turn not recorded
  expect([...tabA.problems, ...tabB.problems]).toEqual([]);
});

// ── 10: stop ─────────────────────────────────────────────────────────────────
test('stop ends the turn, says so, and the record agrees after reload', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const { page, problems } = await open(browser, 'owner');
  await page.goto(`/chat?brain=${fx.flows.slow}`);
  const inFlight = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
  await ask(page, q('Please stop me'));
  await inFlight;                                // stop MID-stream, not before the request left
  await page.getByTestId('chat-stop').click();
  await expect(page.getByTestId('chat-turn-status')).toContainText('Stopped');
  await expect(composer(page)).toBeEnabled();
  await expect(page.getByText(fx.slow_answer)).toHaveCount(0);

  const id = Number(new URL(page.url()).searchParams.get('thread'));
  await expect.poll(async () => (await transcript(owner, id)).messages.at(-1)?.status, { timeout: 20_000 })
    .toBe('failed');
  await page.reload();
  await expect(page.getByText(/ended before an answer/i)).toBeVisible();
  expect(problems).toEqual([]);
});

// ── 11: error and recovery ───────────────────────────────────────────────────
test('a failed send is labelled, and the next question works', async ({ browser }) => {
  const { page, problems } = await open(browser, 'owner', { allow: /500|Failed to load resource/ });
  await page.goto(`/chat?brain=${fx.flows.fast}`);
  // ONE injected server failure — the only interception in this journey.
  let failed = false;
  await page.route('**/agent-flows/chat/threads/*/messages', async (route) => {
    if (failed) return route.continue();
    failed = true;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' });
  });
  await ask(page, q('This one fails'));
  await expect(page.getByTestId('chat-turn-status')).toContainText('failed');
  // The reason is said under the turn, in product words — never the raw server
  // detail ("boom"), and never in a toast covering the Send button.
  await expect(answers(page).last()).toContainText('Could not send the question');
  await expect(page.getByText('boom')).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  await ask(page, q('This one works'));
  await expect(answers(page).last()).toContainText(fx.answer);
  expect(problems.filter((p) => !p.includes('/messages'))).toEqual([]);
});

// ── 13-14: sharing, oversight, revocation ────────────────────────────────────
test('view share reads only; edit share continues; oversight reads only; revoke closes it', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const id = await newThreadWithTurn(owner, fx.flows.fast, q('Shared question'));
  const share = async (who: Who, level: 'view' | 'edit') =>
    expect((await owner.post(`${API}/api/v1/shares/chat_thread/${id}`,
      { data: { user_id: fx.users[who].id, permission: level } })).status()).toBeLessThan(300);
  await share('viewer', 'view');
  await share('editor', 'edit');

  // VIEW: transcript readable, box closed, no actions that would 403.
  // The revocation at the end is EXPECTED to answer 404 for this principal.
  const v = await open(browser, 'viewer', { allow: /404|Failed to load resource/ });
  await v.page.goto(`/chat?brain=${fx.flows.fast}&thread=${id}`);
  await expect(conversation(v.page).getByText(q('Shared question')).last()).toBeVisible();
  await expect(v.page.getByTestId('chat-readonly')).toContainText('read only');
  await expect(composer(v.page)).toBeDisabled();
  await expect(answers(v.page).first().getByRole('button', { name: 'Helpful', exact: true })).toHaveCount(0);
  await expect(v.page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await expect(v.page.locator('aside').getByRole('button', { name: 'Rename' })).toHaveCount(0);
  const viewer = await api(browser, 'viewer');
  expect((await viewer.post(`${CHAT}/threads/${id}/messages`, { data: { question: 'x' } })).status()).toBe(403);

  // EDIT: may continue the conversation.
  const e = await open(browser, 'editor');
  await e.page.goto(`/chat?brain=${fx.flows.fast}&thread=${id}`);
  await expect(composer(e.page)).toBeEnabled();
  await ask(e.page, q('Editor follow-up'));
  await expect(answers(e.page)).toHaveCount(2);
  // The verdict on an answer is the owner's alone: the editor is not offered it.
  await expect(answers(e.page).first().getByRole('button', { name: 'Helpful', exact: true })).toHaveCount(0);

  // OVERSIGHT (`chat: full`): reads, may not write — UI and API agree.
  const o = await open(browser, 'overseer');
  await o.page.goto(`/chat?brain=${fx.flows.fast}&thread=${id}`);
  await expect(o.page.getByTestId('chat-readonly')).toBeVisible();
  await expect(composer(o.page)).toBeDisabled();
  const overseer = await api(browser, 'overseer');
  expect((await overseer.post(`${CHAT}/threads/${id}/messages`, { data: { question: 'x' } })).status()).toBe(403);
  expect((await overseer.post(`${CHAT}/threads/${id}/runs/${(await transcript(owner, id)).messages[1].run_id}/rating`,
    { data: { rating: 'down' } })).status()).toBe(403);

  // OUTSIDER: does not even learn it exists.
  const outsider = await api(browser, 'outsider');
  expect((await outsider.get(`${CHAT}/threads/${id}`)).status()).toBe(404);

  // REVOKE the viewer: their next load says so and drops the dead id.
  expect((await owner.delete(`${API}/api/v1/shares/chat_thread/${id}/${fx.users.viewer.id}`)).status())
    .toBeLessThan(300);
  await v.page.reload();
  await expect(v.page.getByText('does not exist, or you no longer have access')).toBeVisible();
  await expect(v.page).not.toHaveURL(/thread=/);
  expect((await viewer.get(`${CHAT}/threads/${id}`)).status()).toBe(404);

  expect([...v.problems, ...e.problems, ...o.problems]).toEqual([]);
});

// ── H10: told before typing ──────────────────────────────────────────────────
test('a reader outside the pilot is told before typing, in their language', async ({ browser }) => {
  for (const lang of ['en', 'vi'] as const) {
    const { page, problems } = await open(browser, 'unenrolled', { lang });
    let posted = false;
    page.on('request', (r) => { if (r.url().includes('/messages') && r.method() === 'POST') posted = true; });
    await page.goto(`/chat?brain=${fx.flows.fast}`);
    await expect(page.getByTestId('chat-readonly'))
      .toContainText(lang === 'en' ? 'limited pilot' : 'thử nghiệm giới hạn');
    await expect(composer(page)).toBeDisabled();
    expect(posted).toBe(false);
    expect(problems).toEqual([]);
  }
});

test('a stale or foreign conversation link says so and is dropped', async ({ browser }) => {
  const { page, problems } = await open(browser, 'owner', { allow: /404|Failed to load resource/ });
  await page.goto(`/chat?brain=${fx.flows.fast}&thread=987654321`);
  await expect(page.getByText('does not exist, or you no longer have access')).toBeVisible();
  await expect(page).not.toHaveURL(/thread=/);
  await expect(composer(page)).toBeEnabled();
  expect(problems).toEqual([]);
});

// ── 15-17: structured answer, citation, follow-up ────────────────────────────
test('structured answer: metric, table, chart reference, citation and follow-ups render and act', async ({ browser }) => {
  const owner = await api(browser, 'owner');
  const id = await newThreadWithTurn(owner, fx.flows.fast, q('Typed answer please'));
  const real = await transcript(owner, id);
  const { page, problems } = await open(browser, 'owner');

  // DETERMINISTIC RENDERER INPUT: the LLM-free flows cannot produce typed blocks,
  // so this ONE response is extended with them. Everything else is the real record.
  await page.route(`**/agent-flows/chat/threads/${id}?*`, async (route) => {
    const typed = JSON.parse(JSON.stringify(real));
    const last = typed.messages[typed.messages.length - 1];
    last.content = '';
    last.blocks = [
      { type: 'metric', label: 'Revenue (Sep)', value: 8043020000, format: 'number' },
      { type: 'table', columns: [{ key: 'm', label: 'Month' }, { key: 'v', label: 'Revenue' }],
        rows: [{ m: 'Aug', v: 7900000000 }, { m: 'Sep', v: 8043020000 }] },
      { type: 'chart_ref', chart_id: 1, caption: '' },
      { type: 'followups', items: ['Compare with last year'] },
    ];
    last.citations = [
      { kind: 'chart', ref: '41', label: 'Monthly revenue' },
      { kind: 'document', ref: '9', label: 'Revenue policy', quote: 'Revenue is booked on delivery' },
    ];
    await route.fulfill({ json: typed });
  });
  await page.goto(`/chat?brain=${fx.flows.fast}&thread=${id}`);
  const ans = answers(page).last();
  await expect(ans).toContainText('Revenue (Sep)');
  await expect(ans.locator('table')).toContainText('Aug');
  // A chart reference with nowhere to open is content, never a dead button.
  await expect(ans.getByText('Related chart')).toBeVisible();
  await expect(ans.getByRole('button', { name: /Related chart/ })).toHaveCount(0);
  // Both kinds of source are reachable: the chart a figure came from (which
  // Chat used to drop) and the document passage.
  await ans.getByTestId('chat-data-sources').getByRole('button').click();
  await expect(ans.getByTestId('chat-data-sources')).toContainText('Monthly revenue');
  await ans.getByRole('button', { name: /Sources \(1\)/ }).click();
  await expect(ans.getByText(/Revenue policy|Revenue is booked on delivery/).first()).toBeVisible();
  // Follow-up fills the box.
  await ans.getByRole('button', { name: 'Compare with last year' }).click();
  await expect(composer(page)).toHaveValue('Compare with last year');
  // Copy carries the figures even with no prose.
  await expect(ans.getByRole('button', { name: 'Copy answer' })).toBeVisible();
  expect(problems).toEqual([]);
});

// ── 19-20: mobile and tablet ─────────────────────────────────────────────────
for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'tablet', width: 820, height: 1180 }]) {
  test(`${vp.name}: conversations are reachable, manageable and the page does not scroll sideways`, async ({ browser }) => {
    const owner = await api(browser, 'owner');
    const first = await newThreadWithTurn(owner, fx.flows.fast, q(`${vp.name} first`));
    const second = await newThreadWithTurn(owner, fx.flows.fast, q(`${vp.name} second`));
    const { page, problems } = await open(browser, 'owner', { viewport: { width: vp.width, height: vp.height } });
    await page.goto(`/chat?brain=${fx.flows.fast}&thread=${second}`);
    await expect(answers(page).first()).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);

    await page.getByTestId('chat-open-conversations').click();
    const drawer = page.getByRole('dialog', { name: 'Conversations' });
    await expect(drawer).toBeVisible();
    // Row actions are visible without hover on a touch screen.
    await expect(drawer.getByRole('button', { name: 'Rename' }).first()).toBeVisible();
    await drawer.getByRole('button', { name: q(`${vp.name} first`) }).click();
    await expect(page).toHaveURL(new RegExp(`thread=${first}`));
    await expect(drawer).toBeHidden();
    await expect(conversation(page).getByText(q(`${vp.name} first`)).last()).toBeVisible();

    // New conversation and asking, from the drawer.
    await page.getByTestId('chat-open-conversations').click();
    await page.getByRole('dialog', { name: 'Conversations' }).getByTestId('chat-new-conversation').click();
    await ask(page, q(`${vp.name} new`));
    await expect(answers(page).last()).toContainText(fx.answer);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(problems).toEqual([]);
  });
}
