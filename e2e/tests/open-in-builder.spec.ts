import { expect, test } from '@playwright/test';

import { deleteFlow, saveDraft } from './_helpers';

/**
 * Phase 3.5 — the last hop of the debugging loop.
 *
 * Runs could name the step that went wrong and then left the author to find that
 * node again by eye, on a canvas that may hold forty of them. The trail went cold
 * exactly where it became useful. A trace step now opens its node in the Builder,
 * selected, Inspector showing.
 *
 * THE RUN IS MOCKED AT THE RUNS API, and the first version of this spec was not:
 * it POSTed `test-as-chat` to produce a real run. That endpoint refuses with 409
 * before it looks at the flow — `deployment_key()` is checked at the top — and
 * `e2e.yml` deliberately configures no model key, because the suite's stated
 * design is to exercise deterministic steps rather than spend money on a vendor.
 * So the spec passed on a developer machine that has a key and failed in CI, which
 * is the workflow-shaped-differently-than-the-deployment mistake, authored into a
 * test. `answer-parity.spec.ts` already established the pattern: intercept the
 * transport, assert the UI.
 *
 * What is mocked is the RUN RECORD. What is under test — the button, the URL
 * parameter, the Builder's selection and the Inspector — is all real.
 */
const KEY = `e2e_openbuilder_${Date.now()}`;

/** Two named nodes, so "the RIGHT one is selected" is a real assertion. */
const BODY = {
  nodes: [
    { key: 'chuan_bi', type: 'set_var', name: 'Chuẩn bị', var: 'ten', value: 'Olist' },
    { key: 'tra_loi', type: 'agent', name: 'Trả lời người xem', prompt: 'Xin chào {{ten}}' },
  ],
  answer_node: 'tra_loi',
};

const RUN_ID = 90001;
const SESSION = 'e2e-openbuilder-session';

const RUN_ROW = {
  id: RUN_ID, run_key: 'run_e2e_openbuilder', at: new Date().toISOString(),
  status: 'ok', version: 1, link_token: null, binding_id: null,
  question: 'xin chào', is_test: true, trigger: 'studio_test',
  session_key: SESSION, latency_ms: 42, rating: null,
};

const STEPS = [
  {
    seq: 1, key: 'chuan_bi', type: 'set_var', name: 'Chuẩn bị', status: 'ok',
    ms: 1, branch: null, iteration: null, preview: 'Olist',
  },
  {
    seq: 2, key: 'tra_loi', type: 'agent', name: 'Trả lời người xem', status: 'ok',
    ms: 41, branch: null, iteration: null, preview: 'Xin chào Olist',
  },
];

const RUN_DETAIL = {
  ...RUN_ROW,
  execution_path: 'Chuẩn bị · Trả lời người xem',
  usage: { llm_calls: 1, tool_calls: 0, prompt_tokens: 10, completion_tokens: 5, usd: null },
  answer: 'Xin chào Olist', citations: [], notices: [], replayable: true,
  steps: STEPS,
};

const CONVERSATION = {
  key: SESSION, session_key: SESSION, brain_key: 'x', turn_count: 1,
  started_at: RUN_ROW.at, last_at: RUN_ROW.at, is_test: true, dashboard_id: null,
  link_token: null, version: 1, tokens: 15,
  // THE WHOLE TURN CONTRACT, not the fields this test reads. The first mock
  // carried only the interesting ones and the tab crashed on `turn.usage.ms` —
  // `usage` is not optional in `ConversationTurn`, and a mock that is laxer than
  // the contract tests a component the server never feeds.
  turns: [{
    index: 1, run_id: RUN_ID, at: RUN_ROW.at, status: 'ok', version: 1,
    is_test: true, trigger: 'studio_test', rating: null,
    question: 'xin chào', answer: 'Xin chào Olist',
    citations: [], notices: [], execution_path: 'Chuẩn bị · Trả lời người xem',
    blocked_reason: null, missing_requirements: [], signals: [],
    steps: STEPS,
    usage: { llm_calls: 1, tool_calls: 0, prompt_tokens: 10, completion_tokens: 5, ms: 42, usd: null },
  }],
  up: 0, down: 0,
};

const SUMMARY = {
  key: SESSION, session_key: SESSION, turns: 1,
  started_at: RUN_ROW.at, last_at: RUN_ROW.at,
  first_run_id: RUN_ID, last_run_id: RUN_ID, first_question: 'xin chào',
  worst_status: 'ok', statuses: ['ok'], tokens: 15, ms: 42, up: 0, down: 0,
  is_test: true, paths: [], dashboard_id: null, link_token: null, version: 1,
  kept_asking: false,
};

/**
 * The Runs tab is CONVERSATION-centric: it lists conversations, opens one, and
 * only then shows a turn's trace. A first attempt mocked `/runs` alone and the
 * panel stayed empty — `?run=` is resolved to its conversation through the run's
 * `session_key`, so a detail with `session_key: null` has nowhere to be shown.
 * All three endpoints, from one regex, because registration order decides which
 * glob wins and that is not a thing a reader should have to know.
 */
async function mockRuns(page: any) {
  await page.route(/\/agent-flows\/brains\/[^/]+\/(runs|conversations)/, (route: any) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (url.includes('/runs/stats')) return json({ total: 1, ok: 1, partial: 0, failed: 0 });
    if (url.includes('/runs/coverage')) return json({ nodes: [], days: 30 });
    if (new RegExp(`/runs/${RUN_ID}`).test(url)) return json(RUN_DETAIL);
    if (url.includes(`/conversations/${SESSION}`)) return json(CONVERSATION);
    if (url.includes('/conversations')) return json({ total: 1, conversations: [SUMMARY] });
    return json({ total: 1, runs: [RUN_ROW] });
  });
}


/**
 * THE TRACE STEP, not merely the words "Chuẩn bị" on the page.
 *
 * Three things carry that text: the conversation row on the left (its
 * `execution_path` names every node it ran), the node on the canvas, and the step
 * list. `.first()` took the conversation row, whose click handler re-opens the run
 * and CLEARS the selected step — so the test clicked, the panel reset, and the
 * button it was waiting for was never going to appear. The step's own type and
 * duration are what make this one unambiguous.
 */
function traceStep(page: any, type: string) {
  return page.getByRole('button').filter({ hasText: new RegExp(type + ' · \\d+ms') }).first();
}

test.describe('Open in Builder @critical', () => {
  test.afterAll(async ({ request }) => {
    await deleteFlow(request, KEY);
  });

  test('a trace step opens its node in the Builder, selected, with the Inspector',
    async ({ page, request }) => {
      await saveDraft(request, KEY, 'E2E open-in-builder', BODY, 'chat');
      await mockRuns(page);

      await page.goto(`/agent-flows?flow=${encodeURIComponent(KEY)}&tab=runs&run=${RUN_ID}`);
      await page.waitForLoadState('domcontentloaded');

      // Select the trace step for the FIRST node, so selecting the wrong one is
      // distinguishable from selecting none.
      const step = traceStep(page, 'set_var');
      await expect(step).toBeVisible({ timeout: 20_000 });
      await step.click();

      const open = page.getByTestId('open-in-builder');
      await expect(open).toBeVisible({ timeout: 10_000 });
      await open.click();

      // The correct flow, on the design surface.
      await expect(page).toHaveURL(new RegExp(`flow=${KEY}`), { timeout: 10_000 });
      await expect(page).not.toHaveURL(/tab=runs/);
      // The parameter is consumed, not left to re-select on every later click.
      await expect(page).not.toHaveURL(/node=/);

      // The exact node is selected AND the Inspector shows it. Asserted on the
      // Inspector's own content rather than a highlight class: a selected border
      // proves a class toggled, not that the panel opened on that node.
      const inspector = page.locator('aside, [data-testid="node-inspector"]').last();
      await expect(inspector).toContainText('Chuẩn bị', { timeout: 10_000 });
      await expect(inspector).not.toContainText('Trả lời người xem');
    });

  test('the Runs surface gains no editing control', async ({ page, request }) => {
    await saveDraft(request, KEY, 'E2E open-in-builder', BODY, 'chat');
    await mockRuns(page);
    await page.goto(`/agent-flows?flow=${encodeURIComponent(KEY)}&tab=runs&run=${RUN_ID}`);
    await page.waitForLoadState('domcontentloaded');

    // SCOPED TO THE RUNS SURFACE. The first version asserted over the whole page
    // and tripped on "Lưu nháp", which lives in the Builder's shared header above
    // the tab switch and has been on all four tabs since 74f7dca. It was never a
    // Runs control, so the assertion was wrong rather than the product.
    //
    // `main` and nothing else: an earlier line here read
    // `'[data-testid="runs-tab"], main'`, and no such testid exists in the
    // frontend. The union still passed — through its second arm — while reading
    // as though the scope were the Runs pane itself, which is the kind of dead
    // arm somebody later tightens a test around and finds nothing holding it.
    const runs = page.locator('main').last();
    await expect(runs.getByRole('button', { name: /Thêm bước|Add step/i })).toHaveCount(0);
    await expect(runs.getByRole('button', { name: /Xóa bước|Delete step/i })).toHaveCount(0);
    // And the one control this feature DID add is navigation, not editing.
    await traceStep(page, 'set_var').click();
    await expect(page.getByTestId('open-in-builder')).toBeVisible({ timeout: 10_000 });
  });
});
