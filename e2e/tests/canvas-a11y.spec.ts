import { expect, test } from '@playwright/test';

import { deleteFlow, saveDraft } from './_helpers';

/**
 * Phase 4.5 — the authoring canvas at the viewports it declares.
 *
 * The Studio's stated minimum is 1280px and it does NOT need a mobile layout, so
 * these run at 1280×800, 1440×900 and 1920×1080 and nowhere below. What they lock
 * is what was measured and fixed, not a wish list:
 *
 *   - no CATASTROPHIC horizontal page overflow. The canvas scrolls internally on
 *     purpose; the page must not.
 *   - a three-specialist coordinator stays usable at the minimum — its lanes have
 *     a floor, so they scroll rather than collapsing into slivers.
 *   - selected state is PROGRAMMATIC. A border colour is not a state a screen
 *     reader can read.
 *   - reaching a step does not mean tabbing past every step before it.
 */
const KEY = `e2e_canvas_a11y_${Date.now()}`;

/** 24 steps: long enough that "tab to the last one" is the question, and the same
 *  size as a real flow rather than a toy. */
const LONG = {
  nodes: Array.from({ length: 24 }, (_, i) => ({
    key: `buoc_${i + 1}`, type: 'set_var', name: `Bước ${i + 1}`,
    var: `v${i + 1}`, value: String(i + 1), value_type: 'number',
  })),
  answer_node: '',
};

const COORDINATOR = {
  nodes: [
    {
      key: 'dieu_phoi', type: 'coordinate', name: 'Điều phối',
      specialists: [
        { key: 'doanh_thu', name: 'Doanh thu', when: 'câu hỏi về doanh thu',
          body: [{ key: 'a1', type: 'agent', name: 'Trả lời doanh thu', prompt: 'x' }] },
        { key: 'don_hang', name: 'Đơn hàng', when: 'câu hỏi về đơn hàng',
          body: [{ key: 'a2', type: 'agent', name: 'Trả lời đơn hàng', prompt: 'x' }] },
        { key: 'giao_hang', name: 'Giao hàng', when: 'câu hỏi về giao hàng',
          body: [{ key: 'a3', type: 'agent', name: 'Trả lời giao hàng', prompt: 'x' }] },
      ],
    },
    { key: 'tra_loi', type: 'agent', name: 'Trả lời', prompt: 'x' },
  ],
  answer_node: 'tra_loi',
};

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

async function openBuilder(page: any, key: string) {
  await page.goto(`/agent-flows?flow=${encodeURIComponent(key)}&tab=design`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-node-button]').first()).toBeVisible({ timeout: 20_000 });
}

/** Horizontal overflow of the PAGE, which is the catastrophic kind. A canvas that
 *  scrolls inside its own pane is intentional and does not show up here. */
async function pageOverflows(page: any): Promise<boolean> {
  return page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test.describe('authoring canvas @critical', () => {
  // RE-SAVED PER TEST, not once. `sweepLeftovers` in another spec deletes every
  // flow whose key starts with `e2e_`, which is the right thing for it to do and
  // includes these — so a fixture created once is a fixture another file can
  // delete out from under this one. `saveDraft` upserts, so re-saving costs a
  // request and removes the whole class of failure.
  test.beforeEach(async ({ request }) => {
    await saveDraft(request, KEY, 'E2E canvas a11y', LONG, 'chat');
    await saveDraft(request, `${KEY}_coord`, 'E2E coordinator', COORDINATOR, 'chat');
  });

  test.afterAll(async ({ request }) => {
    await deleteFlow(request, KEY);
    await deleteFlow(request, `${KEY}_coord`);
  });

  for (const vp of VIEWPORTS) {
    test(`a 24-step flow does not overflow the page at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openBuilder(page, KEY);
      expect(await pageOverflows(page), 'the PAGE scrolls sideways').toBe(false);
    });

    test(`a 3-specialist coordinator stays reachable at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openBuilder(page, `${KEY}_coord`);
      expect(await pageOverflows(page)).toBe(false);

      // Every lane's own card is present and has a real size — the failure this
      // replaces was lanes dividing into ~150px slivers whose cards clipped.
      for (const lane of ['Doanh thu', 'Đơn hàng', 'Giao hàng']) {
        const card = page.getByRole('button', { name: new RegExp(lane) }).first();
        await expect(card).toBeVisible();
        const box = await card.boundingBox();
        expect(box!.width, `lane "${lane}" collapsed`).toBeGreaterThan(120);
      }
    });
  }

  test('the selected step says so programmatically, not only in its border',
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openBuilder(page, KEY);

      const first = page.locator('[data-node-button="buoc_1"]');
      await first.click();
      await expect(first).toHaveAttribute('aria-pressed', 'true');

      const second = page.locator('[data-node-button="buoc_2"]');
      await expect(second).toHaveAttribute('aria-pressed', 'false');
      await second.click();
      await expect(second).toHaveAttribute('aria-pressed', 'true');
      await expect(first).toHaveAttribute('aria-pressed', 'false');
    });

  test('every step button carries a name, not just a shape', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBuilder(page, KEY);
    const labels = await page.locator('[data-node-button]').evaluateAll(
      (els: Element[]) => els.map((e) => e.getAttribute('aria-label') || ''));
    expect(labels.length).toBeGreaterThan(20);
    expect(labels.filter((l) => !l.trim()), 'unlabelled step buttons').toEqual([]);
  });

  test('the keyboard can ENTER the step list on a freshly loaded flow', async ({ page }) => {
    // THE DOOR, and it was missing. Roving focus was implemented correctly but
    // every card was `tabindex="-1"` until something was selected BY MOUSE, so a
    // keyboard-only author tabbed past drag handles and insert points and never
    // reached a step at all. Found by driving it, not by reading it.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBuilder(page, KEY);

    const stops = await page.locator('[data-node-button][tabindex="0"]').count();
    expect(stops, 'no step is reachable by Tab before anything is selected').toBe(1);

    await page.locator('[data-node-button="buoc_1"]').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-node-button="buoc_2"]'))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('the drag handle is not a tab stop ahead of the step it belongs to',
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openBuilder(page, KEY);
      // SCOPED TO THE CANVAS. A broader `[aria-label*="Drag"]` also matched the
      // inspector's resize handle — which is `tabindex="0"` and correctly so, it
      // takes arrow keys — and the test then failed on a control that works.
      const handles = await page
        .locator('[data-node-button]')
        .locator('xpath=..')
        .locator('button[aria-label*="kéo"], button[aria-label*="Drag to reorder"]')
        .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('tabindex')));
      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((v) => v === '-1'), 'a pointer-only handle is a tab stop')
        .toBe(true);
    });

  for (const vp of VIEWPORTS) {
    test(`every builder tab is reachable at ${vp.name}`, async ({ page }) => {
      // At 1280 the header overflowed and "Activity" sat under the sticky verdict
      // group — navigation scrolled out of reach at the width the product names
      // as its minimum.
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openBuilder(page, KEY);
      for (const label of ['Design', 'Runs', 'Feedback', 'Activity']) {
        const tab = page.getByRole('button', { name: label, exact: true });
        await expect(tab).toBeVisible();
        const covered = await tab.evaluate((el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !el.contains(top);
        });
        expect(covered, `the "${label}" tab is covered by another control`).toBe(false);
      }
    });
  }

  test('reaching step 24 does not take 24 tab stops', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBuilder(page, KEY);

    // ROVING FOCUS: only the selected card is a tab stop, and the arrows move
    // between cards from there. Before this, every card was a stop.
    await page.locator('[data-node-button="buoc_1"]').click();
    const stops = await page.locator('[data-node-button][tabindex="0"]').count();
    expect(stops, 'every step is still its own tab stop').toBe(1);

    await page.locator('[data-node-button="buoc_1"]').focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-node-button="buoc_6"]'))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('a step can be reordered from the keyboard, through the same move the drop uses',
    async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openBuilder(page, KEY);

      const order = () => page.locator('[data-node-button]').evaluateAll(
        (els: Element[]) => els.map((e) => e.getAttribute('data-node-button')));
      const before = await order();
      expect(before.slice(0, 2)).toEqual(['buoc_1', 'buoc_2']);

      await page.locator('[data-node-button="buoc_1"]').click();
      await page.locator('[data-node-button="buoc_1"]').focus();
      await page.keyboard.press('Alt+ArrowDown');

      await expect.poll(async () => (await order()).slice(0, 2))
        .toEqual(['buoc_2', 'buoc_1']);
    });
});
