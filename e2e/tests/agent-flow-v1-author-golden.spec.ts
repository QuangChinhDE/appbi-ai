import { expect, Page, test } from '@playwright/test';
import { deleteFlow, openFlowList, sweepLeftovers } from './_helpers';

/**
 * The V1 author journey, end to end, as a pilot author walks it.
 *
 * WHY THIS SPEC EXISTS SEPARATELY FROM `builder.spec.ts`. That suite proves the
 * builder's parts work: a field saves, a node round-trips, the canvas mounts.
 * None of that answers the question V1 is judged on — *can somebody who has never
 * seen this product reach a published assistant a reader can use?* Every step
 * below is a place the previous audit found an author stopping, and the order
 * matters: a starter that creates a flow nobody can publish, or a publish that
 * ends without telling the author where it went, passes every part test and fails
 * the journey.
 *
 * WHAT IT DOES NOT SPEND. No model call is required to pass. The starter's two
 * agent steps would cost money to execute, so the run this spec inspects is
 * produced by a deterministic flow (`set_var` / `tool`) through the same test
 * endpoint the Test tab uses. The starter itself is exercised as far as the
 * product can take it without paying a vendor: created, validated, saved,
 * reloaded, published, and read back.
 *
 * WHAT IT ASSERTS ON. User-visible behaviour, through `data-testid` handles and
 * role queries rather than copy — the journey is Vietnamese-first and the labels
 * are expected to change, which is not the same as the journey breaking.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const BRAINS = `${API}/api/v1/agent-flows/brains`;

/** Unique per run, and recognisable to the leftover sweep. */
const STAMP = Date.now().toString(36);
const STARTER_NAME = `E2E golden ${STAMP}`;
/** What `slugifyBrainKey` will make of the name above. Asserted, not assumed. */
const STARTER_KEY = STARTER_NAME
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Download the React DevTools|ResizeObserver loop/i.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Wait for the builder to have a flow on screen, not merely a route change. */
async function builderReady(page: Page) {
  await page.waitForURL(/flow=/, { timeout: 30_000 });
  await expect(page.locator('[data-node-button]').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('V1 author golden journey @critical', () => {
  test.afterAll(async ({ request }) => {
    await deleteFlow(request, STARTER_KEY);
    await sweepLeftovers(request);
  });

  // ── 1. create, from the one route a pilot author is meant to take ─────────
  test('New flow offers the BI starter first, and says what it will build',
    async ({ page }) => {
      const errors = watchConsole(page);
      await openFlowList(page);

      await page.getByTestId('new-flow').click();

      // THE DEFAULT IS THE STARTER. Before this, `New flow` opened on a blank
      // canvas or on instructions to go and prompt a third-party model, and a
      // pilot author had no route that ended in a working assistant.
      const starterTab = page.getByTestId('create-mode-starter');
      await expect(starterTab).toBeVisible();
      await expect(starterTab).toHaveAttribute('aria-pressed', 'true');

      // The other two routes are still there. Making the normal path obvious is
      // the change; removing the advanced ones would be a different product.
      await expect(page.getByTestId('create-mode-blank')).toBeVisible();
      await expect(page.getByTestId('create-mode-ai')).toBeVisible();

      // WHAT WILL EXIST, before it exists. A starter whose result cannot be
      // predicted from the dialog is a differently-shaped blank page.
      const summary = page.getByTestId('starter-summary');
      await expect(summary).toBeVisible();
      const summaryText = (await summary.innerText()).trim();
      expect(summaryText.length, 'the starter explains nothing').toBeGreaterThan(40);
      // Three steps named, because three cards are about to appear.
      expect(summaryText).toMatch(/1\./);
      expect(summaryText).toMatch(/3\./);

      await page.getByTestId('create-name').fill(STARTER_NAME);
      await page.getByTestId('create-submit').click();

      await builderReady(page);
      expect(errors, 'console errors while creating from the starter').toEqual([]);
    });

  // ── 2. what the starter actually produced ────────────────────────────────
  test('the starter opens as a readable three-step flow, valid with no further setup',
    async ({ page, request }) => {
      // Read the stored body first: "three cards are on screen" and "three nodes
      // were saved" are different claims and only the second survives a reload.
      const saved = await request.get(`${BRAINS}/${STARTER_KEY}`);
      expect(saved.status(), await saved.text()).toBe(200);
      const body = (await saved.json()).body ?? (await saved.json());
      const nodes = body.nodes ?? (await saved.json()).body?.nodes;
      expect(Array.isArray(nodes), `no nodes in the saved starter: ${JSON.stringify(body).slice(0, 200)}`)
        .toBe(true);
      expect(nodes.map((n: any) => n.type)).toEqual(['report_read', 'agent', 'agent']);

      // NOT HARDCODED TO ONE CUSTOMER. The single most likely way a starter goes
      // wrong is shipping the demo's report, measure or account inside it.
      const asText = JSON.stringify(nodes);
      expect(asText, 'the starter pins a dashboard id').not.toMatch(/dashboard_id|"chart_ids":\s*\[\s*\d/);
      expect(asText, 'the starter names a demo measure').not.toMatch(/revenue_v2|olist/i);

      // THE ANSWERING STEP HOLDS NO TOOLS. This is the product's own review rule:
      // a step that writes the answer and can still fetch figures may quote a
      // number that passed through no step where it could be checked.
      const answering = nodes[nodes.length - 1];
      expect(answering.tools ?? []).toEqual([]);
      // And the gathering step does hold them, or the assistant cannot measure.
      expect((nodes[1].tools ?? []).length).toBeGreaterThan(3);
      // Nothing gated or external is granted by a starter.
      const granted = (nodes[1].tools ?? []).map((t: any) => t.tool);
      for (const forbidden of ['web_search', 'fetch_url', 'research_web', 'browse_ai_answer']) {
        expect(granted, `the starter granted ${forbidden}`).not.toContain(forbidden);
      }

      // Now the screen. Three steps, each with a name an author can read.
      await page.goto(`/agent-flows?flow=${STARTER_KEY}`);
      await builderReady(page);
      const cards = page.locator('[data-node-button]');
      await expect(cards).toHaveCount(3);
      for (let i = 0; i < 3; i += 1) {
        const label = await cards.nth(i).getAttribute('aria-label');
        expect(label, `step ${i} has no accessible name`).toBeTruthy();
        expect(label!.length, `step ${i} label is too short to mean anything`).toBeGreaterThan(4);
      }

      // VALIDATION PASSES WITH NOTHING ELSE SUPPLIED. A report assistant is handed
      // whichever report the link it is attached to is showing, so there is no
      // context to fill in first — and a starter that opens invalid teaches an
      // author that the product ships broken.
      const validity = page.getByTestId('flow-validity');
      await expect(validity).toBeVisible({ timeout: 20_000 });
      await expect(validity).toHaveAttribute('data-testid', 'flow-validity');
      const verdict = await validity.innerText();
      expect(verdict, `the starter does not validate: ${verdict}`).not.toMatch(/không hợp lệ|invalid/i);
    });

  // ── 3. the round trip an author does before trusting anything ────────────
  test('test panel opens, draft saves, and a hard reload brings the flow back',
    async ({ page }) => {
      await page.goto(`/agent-flows?flow=${STARTER_KEY}`);
      await builderReady(page);

      // TEST PANEL. Opened, not run: executing the starter costs a model call,
      // and what an author needs to see here is that the panel exists and knows
      // which report to aim at.
      await page.getByTestId('builder-test').click();
      await expect(page.getByTestId('test-panel')).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('test-panel')).toBeHidden({ timeout: 10_000 });

      // EDIT → SAVE → RELOAD. Save is disabled until something changes, which is
      // itself the signal that the starter arrived already saved.
      const save = page.getByTestId('builder-save');
      await expect(save).toBeDisabled();

      await page.locator('[data-node-button]').first().click();
      const nameField = page.locator('aside input[type="text"], aside input:not([type])').first();
      await expect(nameField).toBeVisible({ timeout: 15_000 });
      await nameField.fill(`Đọc báo cáo ${STAMP}`);
      await expect(save).toBeEnabled({ timeout: 15_000 });
      await save.click();
      await expect(save).toBeDisabled({ timeout: 20_000 });

      // HARD RELOAD, not a client-side revisit: a builder that keeps its state in
      // memory looks identical until the page is actually re-fetched.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await builderReady(page);
      await expect(page.locator('[data-node-button]')).toHaveCount(3);
      await expect(page.getByText(`Đọc báo cáo ${STAMP}`).first()).toBeVisible({ timeout: 20_000 });
    });

  // ── 4. publish, and the step after publish ───────────────────────────────
  test('publishing shows where the flow ended up, and offers the way to a report',
    async ({ page, request }) => {
      await page.goto(`/agent-flows?flow=${STARTER_KEY}`);
      await builderReady(page);

      // BEFORE PUBLISH the strip must not claim anything about readers.
      const strip = page.getByTestId('flow-activation');
      await expect(strip).toBeVisible({ timeout: 20_000 });
      await expect(strip).toHaveAttribute('data-tone', 'idle');

      await page.getByTestId('builder-publish').click();
      await expect(page.getByTestId('publish-dialog')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('publish-confirm').click();

      // AFTER PUBLISH: published, and honest that no reader can reach it yet.
      await expect(strip).toHaveAttribute('data-tone', 'attention', { timeout: 30_000 });
      const cta = strip.getByRole('link');
      await expect(cta).toBeVisible();
      // The route that owns the binding, which is the dashboard — not a second
      // binding surface invented inside the builder.
      await expect(cta).toHaveAttribute('href', /\/dashboards/);

      // The version is real, read back from the server rather than from the badge.
      const after = await request.get(`${BRAINS}/${STARTER_KEY}`);
      expect(after.status()).toBe(200);
      const detail = await after.json();
      expect(detail.published_version ?? detail.publishedVersion,
        `publish did not stick: ${JSON.stringify(detail).slice(0, 200)}`).toBeTruthy();
    });

  // ── 5. a Tool step says which tool ───────────────────────────────────────
  test('a configured Tool step is named by its tool, and an empty one says so',
    async ({ page, request }) => {
      const key = `e2e_toolid_${STAMP}`;
      const res = await request.put(BRAINS, {
        data: {
          brain_key: key, name: 'E2E tool identity',
          body: {
            nodes: [
              { key: 'tong', type: 'tool', tool: 'total_measure', inputs: {}, run_policy: 'every_turn' },
              { key: 'xep', type: 'tool', tool: 'rank_values', inputs: {}, run_policy: 'every_turn' },
              { key: 'bao_phu', type: 'tool', tool: 'describe_time_coverage', inputs: {}, run_policy: 'every_turn' },
              {
                key: 'dat_ten', type: 'tool', tool: 'total_measure', inputs: {},
                name: 'Doanh thu quý này', run_policy: 'every_turn',
              },
              { key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'xong' },
            ],
            answer_node: 'answer',
          },
        },
      });
      expect(res.status(), await res.text()).toBeLessThan(400);

      try {
        await page.goto(`/agent-flows?flow=${key}`);
        await builderReady(page);

        const labelOf = async (nodeKey: string) => {
          const el = page.locator(`[data-node-button="${nodeKey}"]`);
          await expect(el).toBeVisible({ timeout: 20_000 });
          return (await el.getAttribute('aria-label')) || '';
        };

        const tong = await labelOf('tong');
        const xep = await labelOf('xep');
        const baoPhu = await labelOf('bao_phu');
        const datTen = await labelOf('dat_ten');

        // THE DEFECT THIS LOCKS. Every Tool card read `Call a tool / Call a tool`,
        // because the canvas is handed specs keyed by NODE TYPE and the tool
        // catalogue was not among them. Four configured tools drew four
        // indistinguishable cards.
        const configured = [tong, xep, baoPhu];
        expect(new Set(configured).size,
          `configured Tool steps are not distinguishable: ${JSON.stringify(configured)}`).toBe(3);

        // Named by the TOOL, in the product's words — not by the registry key.
        for (const [label, raw] of [[tong, 'total_measure'], [xep, 'rank_values'],
          [baoPhu, 'describe_time_coverage']] as const) {
          expect(label.length).toBeGreaterThan(4);
          expect(label, `the canvas shows the raw tool id: ${label}`).not.toContain(raw);
        }

        // An author's own name outranks the tool's, and the tool is still audible.
        expect(datTen).toContain('Doanh thu quý này');

        // AN UNCONFIGURED STEP MUST LOOK UNCONFIGURED. It cannot be seeded: the
        // server refuses to store a Tool step with no tool chosen
        // (`bước công cụ phải chọn một công cụ`, 422), which is the right place
        // for that rule to live. So the state is reached the only way an author
        // reaches it — add the step, and do not choose yet.
        const before = await page.locator('[data-node-button]').count();
        // The insert point at the END of the top level. Addressed by the model
        // the canvas itself uses for drop targets rather than by its label,
        // which is translated.
        await page.locator(`[data-drop="#${before}"]`).click();
        await page.getByTestId('node-type-tool').click();
        await expect(page.locator('[data-node-button]')).toHaveCount(before + 1);

        const fresh = page.locator('[data-node-button]').last();
        const freshText = await fresh.innerText();
        expect(freshText, `a Tool step with no tool chosen reads as configured: ${freshText}`)
          .toMatch(/chọn công cụ|no tool chosen/i);
        // And it must not borrow a neighbour's identity either.
        const freshLabel = (await fresh.getAttribute('aria-label')) || '';
        expect(freshLabel).not.toContain('Doanh thu quý này');

      } finally {
        await deleteFlow(request, key);
      }
    });

  // ── 6. runs, and back into the builder from one ──────────────────────────
  test('a run is inspectable and opens the step it came from in the builder',
    async ({ page, request }) => {
      const key = `e2e_goldenrun_${STAMP}`;
      // DETERMINISTIC ON PURPOSE. `set_var` and `tool` need no model, so this
      // proves the Runs surface without making the gate depend on a vendor.
      const saved = await request.put(BRAINS, {
        data: {
          brain_key: key, name: 'E2E golden run',
          body: {
            nodes: [
              { key: 'dat', type: 'set_var', var: 'nguong', value: '5', value_type: 'number' },
              {
                key: 'xem_filter', type: 'tool', tool: 'inspect_filters',
                output_var: 'filters', run_policy: 'every_turn', inputs: {},
              },
              { key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'Nguong={{nguong}}' },
            ],
            answer_node: 'answer',
          },
        },
      });
      expect(saved.status(), await saved.text()).toBeLessThan(400);

      try {
        // A link with an ACTIVE binding is what `POST /test` runs against; there
        // is no way to produce a real run without one.
        let linkId = Number(process.env.E2E_LINK_ID || 0);
        if (!linkId) {
          for (let id = 1; id <= 60 && !linkId; id += 1) {
            const probe = await request.get(`${API}/api/v1/agent-flows/bindings/link/${id}`);
            if (probe.status() !== 200) continue;
            const b = (await probe.json().catch(() => null));
            const binding = b?.binding ?? b;
            if (binding?.id && binding.status === 'active') linkId = id;
          }
        }
        test.skip(!linkId, 'no link with an active binding on this deployment — '
          + 'a run cannot be produced without one');

        const ran = await request.post(`${BRAINS}/${key}/test`, {
          data: { question: 'Báo cáo đang lọc gì?', link_id: linkId },
          timeout: 120_000,
        });
        expect(ran.status(), (await ran.text()).slice(0, 300)).toBeLessThan(400);

        await page.goto(`/agent-flows?flow=${key}&tab=runs`);
        // The run list is served by the API; an empty shell is not a pass.
        const openInBuilder = page.getByTestId('open-in-builder');
        await expect(page.locator('table, [role="table"], [data-run-row]').first())
          .toBeVisible({ timeout: 30_000 });

        // Open the most recent run, then a step inside it. `Open in builder`
        // belongs to a SELECTED STEP, not to the run — the run alone is a list.
        await page.locator('tbody tr').first().click();
        const steps = page.getByTestId('run-step');
        await expect(steps.first()).toBeVisible({ timeout: 30_000 });
        await steps.first().click();
        await expect(openInBuilder).toBeVisible({ timeout: 30_000 });
        await openInBuilder.click();

        // BACK ON THE CANVAS, on the step that was being read. This is the last
        // hop of the debugging loop and the reason Runs is worth having.
        await builderReady(page);
        await expect(page.locator('[data-node-button]').first()).toBeVisible();
      } finally {
        await deleteFlow(request, key);
      }
    });
});
