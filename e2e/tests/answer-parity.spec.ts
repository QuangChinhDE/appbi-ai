import { expect, test } from '@playwright/test';
import { saveDraft, sweepLeftovers } from './_helpers';

/**
 * The author and the reader see the same answer.
 *
 * WHAT THIS LOCKS, AND WHY IT NEEDED A BROWSER
 * --------------------------------------------
 * The answer envelope is a union of six block variants. The Studio's test panel
 * rebuilt the answer with
 *
 *     blocks.map((b) => b.markdown).filter(Boolean)
 *
 * and `metric`, `table`, `chart_ref` and `callout` carry no `.markdown`. Asked for
 * a metric block and nothing else, a published flow produced exactly that, and the
 * panel rendered an em-dash — while the run reported `ok`, spent 4,136 tokens, and
 * raised no notice. An author whose whole job on that screen is judging the answer
 * was shown a blank.
 *
 * `frontend/scripts/check-answer-parity.mjs` guards the structure — one renderer,
 * no private flatten. It cannot prove what a browser paints, which is the half
 * that was wrong. This does.
 *
 * NO MODEL IS CALLED. Asking a real model for a `metric` block is not
 * deterministic: measured on this deployment, the same flow returned a single
 * `text` block when asked normally and a `metric` only when the question named the
 * block type. So the envelope is injected at the network boundary — the panel's own
 * rendering is the thing under test, not the model's willingness to emit a shape.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';

/** One envelope carrying every variant the contract declares. */
const ALL_BLOCKS = [
  { type: 'text', markdown: '**Tổng quan** doanh thu quý này.' },
  {
    type: 'metric', label: 'Tổng doanh thu', value: 13591643.7,
    format: 'currency',
    delta: { value: -0.084, format: 'percent', direction: 'down' },
  },
  {
    type: 'table',
    columns: [
      { key: 'cat', label: 'Danh mục', format: 'text' },
      { key: 'rev', label: 'Doanh thu', format: 'currency' },
    ],
    rows: [{ cat: 'health_beauty', rev: 1258681.34 }],
  },
  { type: 'chart_ref', chart_id: 686, caption: 'Doanh thu theo danh mục' },
  { type: 'callout', level: 'warning', text: 'Chỉ đọc được 10/72 dòng.' },
  { type: 'followups', items: ['Danh mục nào thấp nhất?'] },
];

const ENVELOPE = {
  envelope: {
    schema_version: 1,
    run_id: 'run-e2e-parity',
    status: 'ok',
    answer: { blocks: ALL_BLOCKS },
    citations: [{ kind: 'chart', ref: '686', label: 'Doanh thu theo danh mục' }],
    notices: [],
    trace: { path: 'answer', steps: [
      { key: 'answer', name: 'Trả lời', type: 'agent', status: 'ok', ms: 10 },
    ] },
    usage: {
      llm_calls: 1, tool_calls: 0, prompt_tokens: 10, completion_tokens: 5, ms: 10,
    },
  },
  run_row_id: null,
  readiness: { errors: [], warnings: [] },
  report: { id: 0, name: 'E2E', charts: [] },
};

test.describe('answer parity @critical', () => {
  const KEY = `e2e_parity_${Date.now()}`;

  // A CHAT FLOW ON PURPOSE. A bot flow's test panel first asks which report to run
  // against, and a freshly created flow has no binding — so the send is gated on a
  // precondition that has nothing to do with rendering. A chat flow "has nothing to
  // test AGAINST — that is the surface, not a missing setup" (TestChat), so the
  // picker is replaced by one sentence and the question box is live immediately.
  test.beforeAll(async ({ request }) => {
    await saveDraft(request, KEY, 'E2E answer parity', {
      nodes: [{ key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'x' }],
      answer_node: 'answer',
    }, 'chat');
  });

  test('the Studio test panel renders every block variant, not only text',
    async ({ page }) => {
      // Intercept the run, not the model: the panel's rendering is under test.
      await page.route('**/agent-flows/brains/*/test-as-chat**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json',
                        body: JSON.stringify(ENVELOPE) }));

      await page.goto(`/agent-flows?flow=${KEY}`);
      await page.getByRole('button', { name: /^Test$/ }).click();

      const box = page.locator('textarea').first();
      await box.waitFor({ state: 'visible', timeout: 30_000 });
      await box.fill('Cho tôi mọi loại block.');
      await box.press('Enter');

      const panel = page.locator('[class*="rounded-bl-md"]').last();
      await expect(panel).toBeVisible({ timeout: 60_000 });

      // THE REGRESSION ITSELF: an em-dash is what the flatten produced.
      await expect(panel).not.toHaveText('—');

      // Each variant, by something only that variant renders.
      await expect(panel).toContainText('Tổng quan');          // text
      await expect(panel).toContainText('Tổng doanh thu');     // metric label
      await expect(panel).toContainText('Danh mục');           // table column
      await expect(panel).toContainText('health_beauty');      // table row
      await expect(panel).toContainText('Chỉ đọc được');       // callout
      await expect(page.getByText('Danh mục nào thấp nhất?')).toBeVisible(); // followups

      // Citations are author-side chrome and must survive the change.
      await expect(page.getByText('Doanh thu theo danh mục').first()).toBeVisible();
    });

  test('a run with no blocks says so instead of printing a dash',
    async ({ page }) => {
      const empty = {
        ...ENVELOPE,
        envelope: { ...ENVELOPE.envelope, answer: { blocks: [] } },
      };
      await page.route('**/agent-flows/brains/*/test-as-chat**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json',
                        body: JSON.stringify(empty) }));

      await page.goto(`/agent-flows?flow=${KEY}`);
      await page.getByRole('button', { name: /^Test$/ }).click();
      const box = page.locator('textarea').first();
      await box.waitFor({ state: 'visible', timeout: 30_000 });
      await box.fill('Không có gì.');
      await box.press('Enter');

      const panel = page.locator('[class*="rounded-bl-md"]').last();
      await expect(panel).toBeVisible({ timeout: 60_000 });
      // "produced no answer" and "produced something I cannot show" are different
      // faults, and the em-dash said neither.
      await expect(panel).not.toHaveText('—');
      await expect(panel).toContainText(/không tạo ra nội dung|no answer content/i);
    });
});

test.afterAll(async ({ request }) => {
  await sweepLeftovers(request);
});
