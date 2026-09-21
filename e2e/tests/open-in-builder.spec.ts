import { expect, test } from '@playwright/test';

import { BRAINS, deleteFlow, saveDraft } from './_helpers';

/**
 * Phase 3.5 — the last hop of the debugging loop.
 *
 * Runs could tell an author WHICH step went wrong and then left them to find that
 * node again by eye, on a canvas that may hold forty of them. The trail went cold
 * exactly where it became useful.
 *
 * What this asserts is the whole contract: run -> trace step -> the node that
 * produced it, open in the Builder with that node SELECTED and its Inspector
 * showing. Navigation only — Runs gains no editing control and its canvas stays
 * read-only, which the last case checks rather than assumes.
 *
 * A chat-type flow, because it needs no report binding to run: this spec is about
 * navigation, and arranging a dashboard target would make it fail for reasons
 * that have nothing to do with what it tests.
 */
const KEY = `e2e_openbuilder_${Date.now()}`;

/** Two named steps, so "the RIGHT node is selected" is a real assertion. */
const BODY = {
  nodes: [
    { key: 'chuan_bi', type: 'set_var', name: 'Chuẩn bị', var: 'ten', value: 'Olist' },
    { key: 'tra_loi', type: 'agent', name: 'Trả lời người xem', prompt: 'Xin chào {{ten}}' },
  ],
  answer_node: 'tra_loi',
};

test.describe('Open in Builder @critical', () => {
  test.afterAll(async ({ request }) => {
    await deleteFlow(request, KEY);
  });

  test('a trace step opens its node in the Builder, selected, with the Inspector',
    async ({ page, request }) => {
      await saveDraft(request, KEY, 'E2E open-in-builder', BODY, 'chat');

      // A REAL RUN, so the trace step is a real step. Asserting against a
      // hand-written row would test the fixture, not the product.
      const ran = await request.post(`${BRAINS}/${KEY}/test-as-chat`, {
        data: { question: 'xin chào' },
      });
      expect(ran.status(), await ran.text()).toBeLessThan(400);

      await page.goto(`/agent-flows?flow=${encodeURIComponent(KEY)}&tab=runs`);
      await page.waitForLoadState('domcontentloaded');

      // Open the run, then a step inside it.
      const runRow = page.locator('table tbody tr').first();
      await expect(runRow).toBeVisible({ timeout: 20_000 });
      await runRow.click();

      const step = page.getByText('Chuẩn bị', { exact: false }).first();
      await expect(step).toBeVisible({ timeout: 15_000 });
      await step.click();

      // 4. activate Open in Builder
      const open = page.getByTestId('open-in-builder');
      await expect(open).toBeVisible({ timeout: 10_000 });
      await open.click();

      // 5. the correct flow is open, on the design surface
      await expect(page).toHaveURL(new RegExp(`flow=${KEY}`), { timeout: 10_000 });
      await expect(page).not.toHaveURL(/tab=runs/);

      // 6 + 7. the exact node is selected AND its Inspector shows it. Asserted on
      // the Inspector's own content rather than on a highlight class: a selected
      // border proves a class toggled, not that the panel opened on that node.
      const inspector = page.locator('aside, [data-testid="node-inspector"]').last();
      await expect(inspector).toContainText('Chuẩn bị', { timeout: 10_000 });
      await expect(inspector).not.toContainText('Trả lời người xem');
    });

  test('the Runs canvas stays read-only', async ({ page, request }) => {
    await saveDraft(request, KEY, 'E2E open-in-builder', BODY, 'chat');
    await page.goto(`/agent-flows?flow=${encodeURIComponent(KEY)}&tab=runs`);
    await page.waitForLoadState('domcontentloaded');

    // The constraint this feature had to respect. If a later change starts
    // rendering the editing palette inside Runs, this fails before a user finds
    // an "Add step" button on a page that cannot save.
    await expect(page.getByRole('button', { name: /Thêm bước|Add step/i }))
      .toHaveCount(0);
    await expect(page.getByRole('button', { name: /Lưu nháp|Save draft/i }))
      .toHaveCount(0);
  });
});
