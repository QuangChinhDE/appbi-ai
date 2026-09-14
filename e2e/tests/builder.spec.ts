import { expect, Page, test } from '@playwright/test';
import { deleteFlow, sweepLeftovers } from './_helpers';

/**
 * The builder as an author uses it, and the round trip underneath it.
 *
 * "Still there after a reload" is the half of a builder that screenshots cannot
 * check: a field that renders, saves, and comes back empty looks correct in every
 * frame. So each test here writes through the real API, reads it back, and — where
 * it matters — looks at the browser too.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const BRAINS = `${API}/api/v1/agent-flows/brains`;

function watchConsole(page: Page) {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // React's dev notice and a browser-level ResizeObserver warning are not this
    // product's errors. Everything else counts, including third-party noise —
    // a whitelist that grows without argument is how a console check dies.
    if (/Download the React DevTools|ResizeObserver loop/i.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/\.(png|jpe?g|svg|ico|woff2?)(\?|$)/i.test(r.url())) return;
    failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`);
  });
  return { errors, failed };
}

/** Upsert a draft through the real write route. */
async function saveDraft(request: any, key: string, name: string, body: unknown) {
  const res = await request.put(BRAINS, { data: { brain_key: key, name, body } });
  expect(res.status(), await res.text()).toBeLessThan(400);
  return res.json();
}

test.describe('builder lifecycle @critical', () => {
  test('the flow list loads with no page errors', async ({ page }) => {
    const seen = watchConsole(page);

    await page.goto('/agent-flows');
    await expect(page.getByRole('heading', { name: /Agent Flows/i })).toBeVisible();
    // Served by the API — an empty shell that renders is not a pass.
    await expect(page.locator('table, [role="table"]').first()).toBeVisible();

    expect(seen.errors, 'console errors on the flow list').toEqual([]);
    expect(seen.failed, 'failed network requests on the flow list').toEqual([]);
  });

  test('the builder opens a flow with no page errors', async ({ page }) => {
    const seen = watchConsole(page);

    await page.goto('/agent-flows');
    await page.locator('tbody tr button').first().click();
    await page.waitForURL(/flow=/, { timeout: 30_000 });
    // The canvas has mounted when a step is on it.
    await expect(page.locator('aside').first()).toBeVisible({ timeout: 30_000 });

    expect(seen.errors, 'console errors in the builder').toEqual([]);
    expect(seen.failed, 'failed network requests in the builder').toEqual([]);
  });

  test('the node palette has one source of truth, and it is the backend',
    async ({ request }) => {
      // THE TWO-SOURCES CHECK. A hard-coded list in the frontend shows up as a
      // type the backend serves that the builder cannot offer, or one it offers
      // that the validator rejects. Asserting a list HERE would be a third source,
      // so this asserts the property instead: the API serves types, and the
      // fourteenth (V3.2's) is among them.
      const res = await request.get(`${API}/api/v1/agent-flows/nodes`);
      expect(res.status()).toBe(200);
      const nodes = (await res.json()).nodes ?? [];
      const types: string[] = nodes.map((n: any) => n.type);

      expect(types.length).toBeGreaterThanOrEqual(14);
      expect(types).toContain('tool');
      // Every offered type must carry what the palette renders.
      for (const n of nodes) {
        expect(n.label_vi || n.label_en, `${n.type} has no label`).toBeTruthy();
        expect(n.category, `${n.type} has no category`).toBeTruthy();
      }
    });

  test('a saved flow survives a hard reload', async ({ page, request }) => {
    const key = `e2e_reload_${Date.now()}`;
    await saveDraft(request, key, 'E2E reload', {
      nodes: [
        { key: 'dat', type: 'set_var', var: 'gia_tri', value: 'xin_chao' },
        { key: 'answer', type: 'agent', name: 'Trả lời', prompt: '{{gia_tri}}' },
      ],
      answer_node: 'answer',
    });

    await page.goto('/agent-flows');
    await expect(page.getByText('E2E reload').first()).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByText('E2E reload').first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('ToolNode end to end @critical', () => {
  test('a ToolNode round-trips with its typed bindings intact', async ({ request }) => {
    // THE V3.2 CONTRACT WHERE IT IS ACTUALLY STORED. A template string would
    // survive this trip; a typed binding that lost its shape would not.
    const key = `e2e_toolnode_${Date.now()}`;
    await saveDraft(request, key, 'E2E ToolNode', {
      nodes: [
        { key: 'cid', type: 'set_var', var: 'chart', value: '41',
          value_type: 'number' },
        {
          key: 'goi', type: 'tool', tool: 'total_measure', name: 'Tính tổng',
          output_var: 'tong', run_policy: 'every_turn',
          inputs: {
            chart_id: { source: 'variable', ref: 'chart' },
            measure: { source: 'literal', value: 'revenue' },
          },
        },
        { key: 'answer', type: 'agent', name: 'Trả lời', prompt: '{{tong}}' },
      ],
      answer_node: 'answer',
    });

    // Read back through the DETAIL route — the one that returns the body.
    //
    // The first version of this called `resolve/{id}` with a guessed id and fell
    // back to the listing when that 404'd. The listing does not carry the body
    // (`include_body=False`), so the typed-binding assertions never ran: a green
    // test asserting nothing about the thing it was written for.
    const res = await request.get(`${BRAINS}/${key}`);
    expect(res.status(), await res.text()).toBe(200);

    const detail = await res.json();
    const nodes = detail?.body?.nodes ?? detail?.draft?.body?.nodes ?? [];
    expect(nodes.length, `no nodes came back: ${JSON.stringify(detail).slice(0, 200)}`)
      .toBeGreaterThan(0);

    const tool = nodes.find((n: any) => n.type === 'tool');
    expect(tool, 'the tool step did not come back').toBeTruthy();

    // TYPED, not stringified. `{{chart}}` would have survived as text; this is
    // the shape that lets a publish-time check compare it against the tool's
    // input schema.
    expect(tool.inputs.chart_id.source).toBe('variable');
    expect(tool.inputs.chart_id.ref).toBe('chart');
    expect(tool.inputs.measure.source).toBe('literal');
    expect(tool.inputs.measure.value).toBe('revenue');
  });

  test('the catalogue gives a ToolNode form everything it needs',
    async ({ request }) => {
      const res = await request.get(`${API}/api/v1/agent-flows/tools`);
      expect(res.status()).toBe(200);
      const tools = ((await res.json()).packs ?? [])
        .flatMap((p: any) => p.tools ?? []);

      const rank = tools.find((t: any) => t.name === 'rank_values');
      expect(rank, 'rank_values missing from the catalogue').toBeTruthy();

      // One row per argument. Without `required` the inspector cannot mark the
      // mandatory ones and an author binds the wrong three.
      expect(rank.inputs).toBeTruthy();
      expect(Object.keys(rank.inputs)).toContain('chart_id');
      expect(rank.inputs.chart_id.required).toBe(true);
      expect(rank.inputs.chart_id.type).toBe('integer');

      // And the output half, for wiring the result into the next step.
      expect(rank.output_schema).toBeTruthy();
      expect(Object.keys(rank.output_schema.properties ?? {})).toContain('items');
    });
});

// A suite must leave the database as it found it. Without this the flow list grows
// by a row per test per run, and a spec that looks for its own row by name starts
// failing because an earlier run pushed it out of view.
test.afterAll(async ({ request }) => {
  await sweepLeftovers(request);
});
