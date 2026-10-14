import { expect, test } from '@playwright/test';

import { deleteFlow, saveDraft } from './_helpers';

/**
 * Release certification — a REAL pointer drag, not `moveNode` called by hand.
 *
 * The keyboard reorder spec proves the model underneath: `canDropInto` then
 * `moveNode`. It proves nothing about the thing an author actually does, which
 * is press on a handle, move the pointer across another card, and let go. That
 * path has its own failure modes — the handle capturing the pointer, the drop
 * target hit-testing, the drag state surviving the pointer leaving the 6px
 * handle — and none of them are reachable from a keyboard test.
 *
 * So this drives pointer events over the real canvas and then RELOADS, because a
 * reorder that is not persisted is a reorder that did not happen.
 */
const KEY = `e2e_pointer_drag_${Date.now()}`;

const BODY = {
  nodes: [
    { key: 'mot', type: 'set_var', name: 'Bước một', var: 'a', value: '1', value_type: 'number' },
    { key: 'hai', type: 'set_var', name: 'Bước hai', var: 'b', value: '2', value_type: 'number' },
    { key: 'ba', type: 'set_var', name: 'Bước ba', var: 'c', value: '3', value_type: 'number' },
  ],
  answer_node: '',
};

async function order(page: any): Promise<string[]> {
  return page.locator('[data-node-button]').evaluateAll(
    (els: Element[]) => els.map((e) => e.getAttribute('data-node-button') || ''));
}

test.describe('pointer drag @critical', () => {
  // Re-saved per test: `sweepLeftovers` in another spec deletes every `e2e_`
  // flow, and a fixture made once is a fixture another file can delete.
  test.beforeEach(async ({ request }) => {
    await saveDraft(request, KEY, 'E2E pointer drag', BODY, 'chat');
  });

  test.afterAll(async ({ request }) => { await deleteFlow(request, KEY); });

  test('a step dragged with the pointer lands where it was dropped, and stays there',
    async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/agent-flows?flow=${encodeURIComponent(KEY)}&tab=design`);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('[data-node-button="mot"]')).toBeVisible({ timeout: 20_000 });
      expect(await order(page)).toEqual(['mot', 'hai', 'ba']);

      // The handle belongs to the FIRST card; the target is the third.
      const card = page.locator('[data-node-button="mot"]').locator('xpath=..');
      const handle = card.locator('button[aria-label*="kéo"], button[aria-label*="Drag"]').first();
      await expect(handle).toBeVisible();

      // THE DROP TARGET IS THE "+", not the card. The canvas hit-tests
      // `document.elementFromPoint(...).closest('[data-drop]')` on every
      // pointermove, so dropping on a node card is a no-op BY DESIGN — the
      // target is the insert point an author can actually see. A first version
      // of this test dropped on the card and read the no-op as a defect.
      const drops = page.locator('[data-drop]');
      await expect(drops.first()).toBeAttached();
      const onto = await drops.last().boundingBox();
      const from = await handle.boundingBox();
      expect(from && onto, 'the drag handle or the drop target has no box').toBeTruthy();

      // Pointer, not mouse: the canvas binds `pointerdown` and captures, which is
      // what makes the drag survive the pointer leaving the 6px handle.
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await page.mouse.down();
      // Several intermediate moves: a single jump can miss every hit-test the
      // canvas performs on the way, and passing that way would prove nothing.
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(
          onto!.x + onto!.width / 2,
          from!.y + ((onto!.y + onto!.height - from!.y) * i) / 6,
          { steps: 4 },
        );
      }
      await page.mouse.up();

      // It moved, and it moved DOWN past the step it was dropped on.
      await expect.poll(async () => (await order(page))[0],
        { message: 'the dragged step did not leave position 1' }).not.toBe('mot');
      const after = await order(page);
      expect(after).toHaveLength(3);
      expect(after.indexOf('mot')).toBeGreaterThan(after.indexOf('hai'));

      // AND IT PERSISTED. A canvas that reorders locally and forgets on reload is
      // the failure this whole case exists to catch.
      await page.getByRole('button', { name: /Lưu nháp|Save draft/i }).click();
      await page.waitForTimeout(1200);
      await page.reload();
      await expect(page.locator('[data-node-button="mot"]')).toBeVisible({ timeout: 20_000 });
      expect(await order(page), 'the order did not survive a reload').toEqual(after);
    });
});
