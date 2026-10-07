import { expect, test, type APIRequestContext } from '@playwright/test';
import { API } from './_helpers';

/**
 * J6 — Dataset capability matrix with forged API requests.
 *
 * Five real users, ONE DatasetGrant each (view / explore / edit / reshare /
 * manage) on a dataset they do not own, module level `datasets: edit` so the
 * grant alone decides. Every request below is sent directly (no UI hiding a
 * button): the server must answer by capability.
 *
 *   view     → consume only: detail yes, raw rows NO
 *   explore  → + raw rows (preview / export)
 *   edit     → + change the design
 *   reshare  → view + share at most what it holds
 *   manage   → everything (publish / grants / delete)
 *
 * FIXTURE: backend/scripts/ci/seed_e2e_dataset_authz.py.
 */
const PASSWORD = 'e2e-authz-123456';
const VERBS = ['view', 'explore', 'edit', 'reshare', 'manage'] as const;
type Verb = typeof VERBS[number];

async function login(request: APIRequestContext, verb: Verb): Promise<Record<string, string>> {
  let res = await request.post(`${API}/api/v1/auth/login`, {
    data: { email: `ds-${verb}@appbi.io`, password: PASSWORD } });
  for (let i = 0; i < 2 && res.status() === 429; i++) {      // login is rate-limited (5/min)
    await new Promise((r) => setTimeout(r, 61_000));
    res = await request.post(`${API}/api/v1/auth/login`, {
      data: { email: `ds-${verb}@appbi.io`, password: PASSWORD } });
  }
  expect(res.status(), `login ds-${verb}: ${await res.text()}`).toBe(200);
  return { Authorization: `Bearer ${(await res.json()).access_token}` };
}

async function fixture(request: APIRequestContext) {
  const body = await (await request.get(`${API}/api/v1/datasets/`)).json();
  const ds = (body as any[]).find((d) => d.name === 'E2E authz sales');
  expect(ds, 'run seed_e2e_dataset_authz.py').toBeTruthy();
  const tables = await (await request.get(`${API}/api/v1/datasets/${ds.id}/tables`)).json();
  return { id: ds.id as number, tableId: (Array.isArray(tables) ? tables : tables.items)[0].id as number };
}

let OWNER = '';  // grants go to the dataset owner (a real user): harmless, and never an FK error

type Case = { name: string; allowed: Verb[];
  call: (r: APIRequestContext, h: Record<string, string>, id: number, t: number) => Promise<any> };

const CASES: Case[] = [
  { name: 'read the dataset', allowed: ['view', 'explore', 'edit', 'reshare', 'manage'],
    call: (r, h, id) => r.get(`${API}/api/v1/datasets/${id}`, { headers: h }) },
  { name: 'preview raw rows', allowed: ['explore', 'edit', 'manage'],
    call: (r, h, id, t) => r.post(`${API}/api/v1/datasets/${id}/tables/${t}/preview`, { headers: h, data: { limit: 5 } }) },
  { name: 'export raw rows', allowed: ['explore', 'edit', 'manage'],
    call: (r, h, id, t) => r.get(`${API}/api/v1/datasets/${id}/tables/${t}/export/excel`, { headers: h }) },
  { name: 'change the design', allowed: ['edit', 'manage'],
    call: (r, h, id, t) => r.put(`${API}/api/v1/datasets/${id}/tables/${t}`, { headers: h, data: { display_name: 'products' } }) },
  { name: 'share view', allowed: ['reshare', 'manage'],
    call: (r, h, id) => r.post(`${API}/api/v1/datasets/${id}/grants`, { headers: h,
      data: { verb: 'view', user_id: OWNER } }) },
  { name: 'grant manage', allowed: ['manage'],
    call: (r, h, id) => r.post(`${API}/api/v1/datasets/${id}/grants`, { headers: h,
      data: { verb: 'manage', user_id: OWNER } }) },
  { name: 'start Sync & Publish', allowed: [],   // manage is allowed but not exercised (it would build)
    call: (r, h, id) => r.post(`${API}/api/v1/datasets/${id}/publish`, { headers: h, data: {} }) },
  { name: 'delete the dataset', allowed: [],     // manage is allowed but not exercised (destructive)
    call: (r, h, id) => r.delete(`${API}/api/v1/datasets/${id}`, { headers: h }) },
];

test.describe('Dataset permissions', () => {
  test('J6 every capability is enforced on forged requests', async ({ request, playwright }) => {
    test.setTimeout(360_000);
    const { id, tableId } = await fixture(request);
    // The Dataset capability contract arrives with security/authz-remediation
    // (one authorization engine; `capabilities` on the dataset response). Before
    // it lands the legacy engine ignores DatasetGrant and this matrix CANNOT
    // pass — C2, blocked on that branch. Skipped BY NAME, never silently.
    const detail = await (await request.get(`${API}/api/v1/datasets/${id}`)).json();
    test.skip(!('capabilities' in detail),
      'C2 BLOCKED: needs security/authz-remediation (Dataset capability contract) — certified on a local merge');
    OWNER = String((await (await request.get(`${API}/api/v1/auth/me`)).json()).id);
    const anon = await playwright.request.newContext();     // no admin session cookies
    const failures: string[] = [];
    try {
      for (const verb of VERBS) {
        const h = await login(anon, verb);
        for (const c of CASES) {
          if (c.allowed.length === 0 && verb === 'manage') continue;
          const res = await c.call(anon, h, id, tableId);
          const ok = res.status() < 300;
          const want = c.allowed.includes(verb);
          if (ok !== want) failures.push(`${verb} → ${c.name}: HTTP ${res.status()} (expected ${want ? 'allowed' : 'refused'})`);
        }
      }
    } finally {
      await anon.dispose();
      await request.delete(`${API}/api/v1/datasets/${id}/grants?user_id=${OWNER}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
