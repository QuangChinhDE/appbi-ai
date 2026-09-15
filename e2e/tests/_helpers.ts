import { expect } from '@playwright/test';

/**
 * Shared helpers. Chiefly: a suite must leave the database as it found it.
 *
 * The first version of these specs created a flow per test and deleted none. After
 * a dozen runs the flow list had twenty `e2e_*` rows in it, and a test that looked
 * for its own row by name started failing because the row had been pushed out of
 * view — a product failure reported by a suite that had caused it.
 */
export const API = process.env.E2E_API_URL || 'http://localhost:8000';
export const BRAINS = `${API}/api/v1/agent-flows/brains`;

/** Upsert a draft through the real write route. */
export async function saveDraft(
  request: any, key: string, name: string, body: unknown,
) {
  const res = await request.put(BRAINS, { data: { brain_key: key, name, body } });
  expect(res.status(), await res.text()).toBeLessThan(400);
  return res.json();
}

/**
 * Delete every version of a flow this suite created.
 *
 * Best effort by design: a test that fails because its own CLEANUP failed tells a
 * reader nothing about the product. What matters is that the row is usually gone.
 */
export async function deleteFlow(request: any, key: string) {
  for (let version = 1; version <= 5; version += 1) {
    await request.delete(`${BRAINS}/${key}/${version}`).catch(() => {});
  }
}

/**
 * Guarantee the flow list has something in it, and say which key it is.
 *
 * A TEST THAT NEEDS DATA HAS TO MAKE IT. Three specs here opened `/agent-flows`
 * and asserted on a table or clicked `tbody tr button` — which works on any
 * developer's machine, where the database has flows in it from ordinary use, and
 * fails on a CI database built by `alembic upgrade head` thirty seconds earlier.
 * The page is not broken when it renders "No brains yet"; that is the correct
 * empty state, and the suite was reporting its own assumption as a product fault.
 *
 * Returns the key so a caller can delete exactly what it made, or '' if it could
 * not make one.
 *
 * BEST EFFORT, DELIBERATELY. This runs in `beforeAll`, and a throw there fails
 * every test in the describe — including the ones that needed no data at all. If
 * the write route is broken, `security-forged.spec.ts` and the ToolNode
 * round-trip say so directly; this is a precondition, not an assertion.
 */
export async function ensureFlowExists(
  request: any, key = `e2e_seed_${Date.now()}`,
): Promise<string> {
  const res = await request.put(BRAINS, {
    data: {
      brain_key: key, name: 'E2E seed flow',
      body: {
        nodes: [
          { key: 'dat', type: 'set_var', var: 'gia_tri', value: 'xin_chao' },
          { key: 'answer', type: 'agent', name: 'Trả lời', prompt: '{{gia_tri}}' },
        ],
        answer_node: 'answer',
      },
    },
  }).catch(() => null);

  if (!res || res.status() >= 400) {
    console.warn(`[e2e] could not seed a flow (${res ? res.status() : 'no response'});`
      + ' specs that need a row will fail on their own assertion');
    return '';
  }
  return key;
}

/** Remove every `e2e_*` flow left behind by any earlier run. */
export async function sweepLeftovers(request: any) {
  const res = await request.get(BRAINS);
  if (res.status() !== 200) return 0;
  const brains = (await res.json()).brains ?? [];
  const mine = brains.filter((b: any) => String(b.brain_key || '').startsWith('e2e_'));
  for (const b of mine) await deleteFlow(request, b.brain_key);
  return mine.length;
}

/**
 * Open the flow list, and fail with the diagnosis rather than the symptom.
 *
 * "heading not found" is equally true of a login page, an error page, a redirect
 * and a page that rendered fine but slowly — and CI is the one place where the
 * screenshot cannot be fetched without a token, so the message IS the evidence.
 * This reports the URL it landed on and whatever heading it did find, which is
 * the difference between "the builder is broken" and "middleware sent us to
 * /login".
 */
export async function openFlowList(page: any): Promise<void> {
  await page.goto('/agent-flows');
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const url: string = page.url();
  const heading = await page.locator('h1').first()
    .innerText({ timeout: 5_000 }).catch(() => '(no h1 rendered)');
  const body = await page.locator('body').innerText()
    .catch(() => '') as string;

  await expect(
    page.getByRole('heading', { name: /Agent Flows/i }),
    `flow list did not render — url=${url} · h1=${JSON.stringify(heading)} · `
    + `body starts: ${JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 160))}`,
  ).toBeVisible();
}
