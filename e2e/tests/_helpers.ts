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

/** Remove every `e2e_*` flow left behind by any earlier run. */
export async function sweepLeftovers(request: any) {
  const res = await request.get(BRAINS);
  if (res.status() !== 200) return 0;
  const brains = (await res.json()).brains ?? [];
  const mine = brains.filter((b: any) => String(b.brain_key || '').startsWith('e2e_'));
  for (const b of mine) await deleteFlow(request, b.brain_key);
  return mine.length;
}
