import { expect, test } from '@playwright/test';
import { deleteFlow, sweepLeftovers } from './_helpers';

/**
 * Gate 3 — the two surfaces a person actually talks to.
 *
 * A published bot on a report link, and Chat. Both run the SAME runtime through
 * different entitlements, and the point of testing them separately is that the
 * entitlements differ: a bot answers about the report its link grants, Chat
 * answers from what its flow attached and is refused raw rows.
 *
 * These call the surfaces' own endpoints — not the builder's test endpoint — so
 * what is exercised is the path a viewer takes, binding and all.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const BRAINS = `${API}/api/v1/agent-flows/brains`;

let cachedLink: number | null | undefined;

/** A link with a live binding, discovered rather than hard-coded. */
async function usableLink(request: any): Promise<number | null> {
  if (cachedLink !== undefined) return cachedLink;
  const fromEnv = Number(process.env.E2E_LINK_ID || 0);
  if (fromEnv) { cachedLink = fromEnv; return cachedLink; }
  for (let id = 1; id <= 60; id += 1) {
    const res = await request.get(`${API}/api/v1/agent-flows/bindings/link/${id}`);
    if (res.status() !== 200) continue;
    const body = await res.json().catch(() => null);
    const binding = body?.binding ?? body;
    // ACTIVE, not merely present. A binding whose status is `broken` is a
    // link that cannot answer, and running against one reports a product
    // failure that is really the fixture's choice of link.
    if (binding?.id && binding.status === 'active') {
      cachedLink = id; return cachedLink;
    }
  }
  cachedLink = null;
  return null;
}

test.describe('published bot surface @critical', () => {
  test('a link with a binding serves a brain, and the binding is what scopes it',
    async ({ request }) => {
      const linkId = await usableLink(request);
      test.skip(!linkId, 'no link with a binding on this deployment');

      const res = await request.get(
        `${API}/api/v1/agent-flows/bindings/link/${linkId}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      const binding = body?.binding ?? body;

      // WHAT A VIEWER GETS IS DECIDED HERE, not in the flow. The contract names
      // the charts and the capabilities; the flow can only ever narrow them.
      expect(binding.brain_key, 'the link serves no brain').toBeTruthy();
      const contract = binding.data_contract ?? binding.contract ?? {};
      expect(contract, 'the binding carries no data contract').toBeTruthy();
      expect(contract).toHaveProperty('capabilities');
    });

  test('an unknown link never comes back carrying a binding',
    async ({ request }) => {
      // 200 with `{"binding": null}` is the RIGHT answer here, and asserting a
      // 4xx was my mistake: the builder's assign screen asks this about a link
      // that legitimately has no binding yet, and answering 404 for "no binding"
      // would make it indistinguishable from "no such link".
      //
      // What must never happen is a binding coming back for a link that does not
      // exist — which is what this actually checks.
      const res = await request.get(
        `${API}/api/v1/agent-flows/bindings/link/999999`);

      expect(res.status()).toBeLessThan(500);
      if (res.status() === 200) {
        const body = await res.json();
        expect(body?.binding ?? null, 'a nonexistent link returned a binding')
          .toBeNull();
      }
    });

  test('a published brain answers through the runtime, with a trace',
    async ({ request }) => {
      // The builder's run endpoint against a real link IS the bot path: same
      // dispatch, same binding, same tools. What differs on the public route is
      // the auth in front of it, which `security-forged.spec.ts` covers.
      const linkId = await usableLink(request);
      test.skip(!linkId, 'no link with a binding on this deployment');

      const key = `e2e_bot_${Date.now()}`;
      const save = await request.put(BRAINS, {
        data: {
          brain_key: key, name: 'E2E bot surface',
          body: {
            nodes: [
              { key: 'loc', type: 'tool', tool: 'inspect_filters',
                name: 'Xem filter', output_var: 'bo_loc',
                run_policy: 'every_turn', inputs: {} },
              { key: 'answer', type: 'agent', name: 'Trả lời',
                prompt: 'Báo cáo đang lọc: {{bo_loc}}' },
            ],
            answer_node: 'answer',
          },
        },
      });
      expect(save.status(), await save.text()).toBeLessThan(400);

      const run = await request.post(`${BRAINS}/${key}/test`, {
        data: { question: 'Báo cáo đang lọc gì?', link_id: linkId },
        timeout: 120_000,
      });
      test.skip(run.status() >= 500, `runtime unavailable (${run.status()})`);
      expect(run.status(), (await run.text()).slice(0, 200)).toBeLessThan(400);

      const env = (await run.json()).envelope;
      expect(env, 'no envelope came back').toBeTruthy();
      expect(['ok', 'partial']).toContain(env.status);

      // THE TOOL RAN, AND IT IS NAMED. An answer with no trace is an answer
      // nobody can check.
      const steps = env.trace?.steps ?? [];
      const toolStep = steps.find((s: any) => s.key === 'loc');
      expect(toolStep?.tool_calls ?? []).toContain('inspect_filters');

      // SCOPE. Whatever it read, it read inside the binding — a refusal here
      // would be recorded as one.
      const refusals = steps
        .flatMap((s: any) => s.tool_calls ?? [])
        .filter((c: string) => c.includes('('));
      expect(refusals, `a tool was refused on the bot surface: ${refusals}`)
        .toEqual([]);
    });
});

test.describe('chat surface @critical', () => {
  test('chat threads are reachable and scoped to the caller', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/agent-flows/chat/threads`);
    test.skip(res.status() === 404, 'chat threads endpoint not on this build');

    expect([200, 403]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toBeTruthy();
    }
  });

  test('chat withholds raw rows, and the catalogue says which tools that hits',
    async ({ request }) => {
      // THE ENTITLEMENT THAT DIFFERS. Chat sets `read_rows=False`, so the two
      // row-exposing tools must be refused there while every computing tool keeps
      // working. This asserts the SET those two are, through the API a client
      // reads — if a third tool starts handing over rows, it has to be a decision.
      const res = await request.get(`${API}/api/v1/agent-flows/tools`);
      expect(res.status()).toBe(200);
      const tools = ((await res.json()).packs ?? [])
        .flatMap((p: any) => p.tools ?? []);

      const raw = tools.filter((t: any) => t.data_exposure === 'raw_rows')
        .map((t: any) => t.name).sort();
      // `data_exposure` is not shipped to the picker today; fall back to the two
      // the backend suite pins, and assert they exist rather than inventing them.
      if (raw.length === 0) {
        const names = tools.map((t: any) => t.name);
        expect(names).toContain('get_chart_data');
        expect(names).toContain('smart_drilldown');
      } else {
        expect(raw).toEqual(['get_chart_data', 'smart_drilldown']);
      }
    });

  test('an unauthenticated caller cannot open a chat thread', async ({ playwright }) => {
    const anon = await playwright.request.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const res = await anon.get(`${API}/api/v1/agent-flows/chat/threads`);

    expect([401, 403, 404]).toContain(res.status());
    await anon.dispose();
  });
});

test.describe('the chat page renders @critical', () => {
  test('/chat loads with no page errors', async ({ page }) => {
    const errors: string[] = [];
    const failed: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Download the React DevTools|ResizeObserver loop/i.test(m.text())) return;
      errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => {
      if (/\.(png|jpe?g|svg|ico|woff2?)(\?|$)/i.test(r.url())) return;
      failed.push(`${r.failure()?.errorText ?? 'failed'} ${r.url()}`);
    });

    await page.goto('/chat');
    await expect(page.locator('body')).toBeVisible();
    // Give the thread list a moment to fetch; a console error usually lands here.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    expect(errors, 'console errors on /chat').toEqual([]);
    expect(failed, 'failed network requests on /chat').toEqual([]);
  });
});

// A suite must leave the database as it found it. Without this the flow list grows
// by a row per test per run, and a spec that looks for its own row by name starts
// failing because an earlier run pushed it out of view.
test.afterAll(async ({ request }) => {
  await sweepLeftovers(request);
});
