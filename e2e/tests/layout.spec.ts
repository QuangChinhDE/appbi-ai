import { expect, test } from '@playwright/test';
import { deleteFlow, ensureFlowExists, sweepLeftovers } from './_helpers';

/**
 * Layout faults a functional test cannot see.
 *
 * Runs at 1440×900 and again at 1920×1080 (the second project in the config).
 * What it checks is the small set of failures that make a builder unusable while
 * every assertion about behaviour still passes: the page scrolling sideways, a
 * panel covering the thing it configures, a control rendered at nothing.
 */

test.describe('builder layout', () => {
  // A layout test still needs something laid out. See `ensureFlowExists`.
  test.beforeAll(async ({ request }) => {
    await ensureFlowExists(request);
  });

  test('the flow list does not scroll sideways', async ({ page }) => {
    await page.goto('/agent-flows');
    await expect(page.getByRole('heading', { name: /Agent Flows/i })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, client: d.clientWidth };
    });

    // A few pixels of rounding is not a layout fault; a column is.
    expect(overflow.scroll - overflow.client,
      `page scrolls sideways by ${overflow.scroll - overflow.client}px`)
      .toBeLessThanOrEqual(2);
  });

  test('the builder canvas and inspector are both usable', async ({ page }) => {
    await page.goto('/agent-flows');
    await page.locator('tbody tr button').first().click();
    await page.waitForURL(/flow=/, { timeout: 30_000 });

    // THE INSPECTOR, not the nav rail. `aside` matches both, and `.last()` picked
    // the 56px collapsed sidebar — a selector that made the test fail for a
    // reason that had nothing to do with the panel it was written for.
    //
    // The inspector is the one whose width the author controls: `useInspectorWidth`
    // writes it as an inline style, so that is what identifies it.
    const aside = page.locator('aside[style*="width"]').first();
    await expect(aside).toBeVisible({ timeout: 30_000 });

    const box = await aside.boundingBox();
    expect(box, 'the inspector has no box').toBeTruthy();
    // The panel is resizable between 320 and 820; anything outside that means the
    // stored width escaped its bounds or the flex row collapsed it.
    expect(box!.width).toBeGreaterThanOrEqual(300);
    expect(box!.width).toBeLessThanOrEqual(860);
    // And it must not have grown past the window.
    const vw = page.viewportSize()!.width;
    expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 2);
  });

  test('no interactive control renders at zero size', async ({ page }) => {
    // A button with no box is a button nobody can press — invisible to a test
    // that only asks whether the handler works.
    await page.goto('/agent-flows');
    await expect(page.locator('table, [role="table"]').first()).toBeVisible();

    const bad = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('button, a[href], select').forEach((el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) {
          out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 30)}"`);
        }
      });
      return out;
    });

    expect(bad, 'controls rendered at zero size').toEqual([]);
  });

  test('a long flow name does not break the row', async ({ page, request }) => {
    const API = process.env.E2E_API_URL || 'http://localhost:8000';
    const key = `e2e_longname_${Date.now()}`;
    const longName =
      'Trợ lý phân tích doanh thu theo danh mục hàng hoá và khu vực địa lý cho ' +
      'ban điều hành — bản dài để kiểm tra bố cục';
    const res = await request.put(`${API}/api/v1/agent-flows/brains`, {
      data: {
        brain_key: key, name: longName,
        body: {
          nodes: [{ key: 'a', type: 'agent', name: 'Trả lời', prompt: 'x' }],
          answer_node: 'a',
        },
      },
    });
    expect(res.status(), await res.text()).toBeLessThan(400);

    await page.goto('/agent-flows');
    await expect(page.getByText(longName.slice(0, 30)).first())
      .toBeVisible({ timeout: 30_000 });

    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth - d.clientWidth;
    });
    expect(overflow, 'a long Vietnamese name pushed the page sideways')
      .toBeLessThanOrEqual(2);
  });
});

// A suite must leave the database as it found it. Without this the flow list grows
// by a row per test per run, and a spec that looks for its own row by name starts
// failing because an earlier run pushed it out of view.
test.afterAll(async ({ request }) => {
  await sweepLeftovers(request);
});
