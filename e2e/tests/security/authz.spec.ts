import { expect, test, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AUTHORIZATION RELEASE GATE (decisions Q1-Q8 of docs/features/authz-remediation).
 *
 * Real stack only: Next.js, FastAPI, Postgres. Nothing is route-mocked. Principals,
 * objects and tokens come from backend/scripts/ci/seed_e2e_security.py, which mints
 * every token with the product's own functions.
 *
 * Isolation: every principal acts from its OWN browser context (own cookies, own
 * request context); nothing is shared with the admin storageState. Each journey
 * asserts at least one DENY and one ALLOW, so a stack that denies everything (or
 * allows everything) fails.
 */
const FIXTURE = process.env.E2E_SECURITY_FIXTURE
  || path.join(__dirname, '..', '..', '.auth', 'security.json');
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const V1 = `${API}/api/v1`;

type Fx = {
  run: string;
  users: Record<string, { id: string; email: string; access: string }>;
  tokens: Record<string, string>;
  team_id: string;
  dataset: { id: number; table_id: number };
  datasource: { id: number; stored_password: string };
  dashboard: { id: number; link_id: number; link_token: string; other_id: number };
  workboard: { id: number; ws_internal: string; ws_public: string; ws_internal_id: number;
    app_user: string; app_pin: string };
  observability: { global_channel: number; dataset_channel: number };
  flow: { key: string };
};

let fx: Fx;
const contexts: BrowserContext[] = [];

test.beforeAll(() => {
  // A missing fixture is a FAILURE, never a skip: a security gate that skips is no gate.
  expect(fs.existsSync(FIXTURE), `security fixture missing at ${FIXTURE} - run seed_e2e_security.py`).toBe(true);
  fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
});

/** A principal = its own browser context, carrying only its own bearer. */
async function as(browser: Browser, who: string | null, bearer?: string): Promise<APIRequestContext> {
  const token = bearer ?? (who ? fx.users[who].access : undefined);
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
  contexts.push(ctx);
  return ctx.request;
}

test('Dataset matrix: view < explore < build < edit, grants cannot escalate', async ({ browser }) => {
  const ds = fx.dataset.id;
  const viewer = await as(browser, 'viewer');
  const builder = await as(browser, 'builder');
  const editor = await as(browser, 'editor');
  const member = await as(browser, 'member');
  const unrelated = await as(browser, 'unrelated');
  const owner = await as(browser, 'owner');

  // read: every grant level reads; an unrelated user cannot even see it exists
  expect((await viewer.get(`${V1}/datasets/${ds}`)).status()).toBe(200);
  expect((await member.get(`${V1}/datasets/${ds}`)).status()).toBe(200); // through the TEAM grant
  expect([403, 404]).toContain((await unrelated.get(`${V1}/datasets/${ds}`)).status());

  // capabilities are the server's answer, not a FE guess
  const capsOf = async (r: APIRequestContext) => (await (await r.get(`${V1}/datasets/${ds}`)).json()).capabilities;
  const vc = await capsOf(viewer);
  expect(vc.read).toBe(true);
  expect(vc.explore).toBe(false);
  expect(vc.build).toBe(false);
  expect(vc.edit).toBe(false);
  const bc = await capsOf(builder);
  expect([bc.explore, bc.build, bc.edit]).toEqual([true, true, false]);
  const mc = await capsOf(member);
  expect([mc.explore, mc.build]).toEqual([true, false]);

  // edit: only edit grant / owner
  expect((await viewer.put(`${V1}/datasets/${ds}`, { data: { description: 'pwn' } })).status()).toBe(403);
  expect((await builder.put(`${V1}/datasets/${ds}`, { data: { description: 'pwn' } })).status()).toBe(403);
  expect((await editor.put(`${V1}/datasets/${ds}`, { data: { description: `sec ${fx.run}` } })).status()).toBe(200);

  // grant management: an editor cannot grant (no manage/reshare), and nobody grants above themselves
  const outsider = fx.users.unrelated.id;
  expect((await editor.post(`${V1}/datasets/${ds}/grants`, { data: { user_id: outsider, verb: 'view' } })).status())
    .toBe(403);
  expect((await viewer.post(`${V1}/datasets/${ds}/grants`, { data: { user_id: fx.users.viewer.id, verb: 'manage' } }))
    .status()).toBe(403);
  // owner grants -> the outsider can read; owner revokes -> the outsider cannot
  expect((await owner.post(`${V1}/datasets/${ds}/grants`, { data: { user_id: outsider, verb: 'view' } })).status())
    .toBe(200);
  expect((await unrelated.get(`${V1}/datasets/${ds}`)).status()).toBe(200);
  const del = await owner.delete(`${V1}/datasets/${ds}/grants?user_id=${outsider}&verb=view`);
  expect(del.status()).toBe(200);
  expect([403, 404]).toContain((await unrelated.get(`${V1}/datasets/${ds}`)).status());
  // H4: a revoke with no target never wipes everyone
  expect((await owner.delete(`${V1}/datasets/${ds}/grants`)).status()).not.toBe(200);
  expect((await viewer.get(`${V1}/datasets/${ds}`)).status()).toBe(200);
});

test('DataSource: a viewer cannot read the stored secret or retarget it', async ({ browser }) => {
  const id = fx.datasource.id;
  const viewer = await as(browser, 'viewer');
  const owner = await as(browser, 'owner');
  const r = await viewer.get(`${V1}/datasources/${id}`);
  expect(r.status()).toBe(200);
  expect(await r.text()).not.toContain(fx.datasource.stored_password);
  // view share cannot run arbitrary SQL
  expect((await viewer.post(`${V1}/datasources/query`, { data: { data_source_id: id, sql_query: 'SELECT 1' } })).status()).toBe(403);
  // the owner sees the masked config, never the plaintext
  const o = await owner.get(`${V1}/datasources/${id}`);
  expect(o.status()).toBe(200);
  expect(await o.text()).not.toContain(fx.datasource.stored_password);
});

test('Public link: tokens masked to non-publishers, publish is its own right, revoke is immediate',
  async ({ browser }) => {
    const d = fx.dashboard.id;
    const viewer = await as(browser, 'viewer');
    const editor = await as(browser, 'editor');
    const owner = await as(browser, 'owner');
    const visitor = await as(browser, null);

    const asViewer = await viewer.get(`${V1}/dashboards/${d}/public-links`);
    expect([200, 403]).toContain(asViewer.status());
    expect(await asViewer.text()).not.toContain(fx.dashboard.link_token);
    // shared EDIT is not publish (Q3)
    expect((await editor.post(`${V1}/dashboards/${d}/public-links`, { data: { name: 'x' } })).status()).toBe(403);
    expect((await editor.patch(`${V1}/dashboards/${d}/public-links/${fx.dashboard.link_id}`,
      { data: { is_active: false } })).status()).toBe(403);

    // the visitor reaches the dashboard through the link - and only that dashboard
    expect((await visitor.get(`${V1}/public/dashboards/${fx.dashboard.link_token}`)).status()).toBe(200);
    expect([401, 403]).toContain((await visitor.get(`${V1}/dashboards/${fx.dashboard.other_id}`)).status());
    // a public-session token is not an API bearer (token domains)
    const pubAsBearer = await as(browser, null, fx.tokens.public_session);
    expect((await pubAsBearer.get(`${V1}/dashboards/${d}`)).status()).toBe(401);

    // the browser: /d/<token> renders for an anonymous visitor
    const page = await (await newPage(browser)).newPage();
    const pr = await page.goto(`/d/${fx.dashboard.link_token}`);
    expect(pr?.status() ?? 200).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);

    // owner revokes -> the link dies at once
    expect((await owner.patch(`${V1}/dashboards/${d}/public-links/${fx.dashboard.link_id}`,
      { data: { is_active: false } })).status()).toBe(200);
    expect((await visitor.get(`${V1}/public/dashboards/${fx.dashboard.link_token}`)).status()).not.toBe(200);
  });

test('Workspace token is an address, never an authority', async ({ browser }) => {
  const w = fx.workboard;
  const anon = await as(browser, null);
  const unrelated = await as(browser, 'unrelated');
  const viewer = await as(browser, 'viewer');
  const owner = await as(browser, 'owner');
  const app = `${V1}/public/workspaces/${w.ws_internal}/workboards/${w.id}/app`;

  expect([401, 403]).toContain((await anon.get(app)).status());
  expect([403, 404]).toContain((await unrelated.get(app)).status()); // knows the token, has no share
  expect((await viewer.get(app)).status()).toBe(200); // shared view
  // view share cannot upload media (H6)
  const media = await viewer.post(`${V1}/public/workspaces/${w.ws_internal}/workboards/${w.id}/media`,
    { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('x') } } });
  expect(media.status()).toBe(403);
  // workspace management: owner yes, unrelated no
  expect((await unrelated.patch(`${V1}/workspaces/${w.ws_internal_id}`, { data: { name: 'pwned' } })).status())
    .not.toBe(200);
  expect((await owner.get(`${V1}/workspaces/${w.ws_internal_id}`)).status()).toBe(200);

  // a public-app-users workspace: a wrong PIN is refused, the right one logs in
  const pub = `${V1}/public/workspaces/${w.ws_public}`;
  expect((await anon.post(`${pub}/login`, { data: { username: w.app_user, pin: '000000' } })).status())
    .not.toBe(200);
  expect((await anon.post(`${pub}/login`, { data: { username: w.app_user, pin: w.app_pin } })).status()).toBe(200);

  // a workspace session token is not an API bearer
  const wsAsBearer = await as(browser, null, fx.tokens.workspace_session);
  expect((await wsAsBearer.get(`${V1}/auth/me`)).status()).toBe(401);
});

test('Observability: global channels and the global scan belong to admins', async ({ browser }) => {
  const g = fx.observability.global_channel;
  const owner = await as(browser, 'owner');
  const admin = await as(browser, 'admin');
  expect((await owner.patch(`${V1}/observability/alert-channels/${g}`,
    { data: { target: 'https://attacker.example/x' } })).status()).toBe(403);
  expect((await owner.post(`${V1}/observability/alert-channels/${g}/test`)).status()).toBe(403);
  expect((await owner.post(`${V1}/observability/scan`)).status()).toBe(403);
  // SSRF: an internal target is refused even for an admin
  expect((await admin.patch(`${V1}/observability/alert-channels/${g}`,
    { data: { target: 'http://169.254.169.254/latest/meta-data' } })).status()).toBe(400);
  expect((await admin.patch(`${V1}/observability/alert-channels/${g}`,
    { data: { name: `global ${fx.run}` } })).status()).toBe(200);
  // the dataset owner manages their own dataset channel
  expect((await owner.patch(`${V1}/observability/alert-channels/${fx.observability.dataset_channel}`,
    { data: { name: 'mine' } })).status()).toBe(200);
});

test('PAT: never above the owner, plaintext only to the owner, revoke is immediate', async ({ browser }) => {
  const viewer = await as(browser, 'viewer');
  const admin = await as(browser, 'admin');
  const created = await viewer.post(`${V1}/auth/personal-access-tokens/`,
    { data: { name: `sec-${fx.run}`, scopes: { datasets: 'edit' }, expires_in_days: 7 } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  const pat = await as(browser, null, body.token);
  const patId = body.item.id;
  // the PAT reads what the viewer reads - and cannot edit, though its scope says edit
  expect((await pat.get(`${V1}/datasets/${fx.dataset.id}`)).status()).toBe(200);
  expect((await pat.put(`${V1}/datasets/${fx.dataset.id}`, { data: { description: 'x' } })).status()).toBe(403);
  // the admin inspects metadata, never the plaintext (Q4)
  const list = await admin.get(`${V1}/auth/personal-access-tokens/admin`);
  expect(list.status()).toBe(200);
  expect(await list.text()).not.toContain(body.token);
  expect((await admin.get(`${V1}/auth/personal-access-tokens/admin/${patId}/reveal`)).status()).not.toBe(200);
  // admin force-invalidates -> the old secret stops at once, the admin gets no token back
  const inv = await admin.post(`${V1}/auth/personal-access-tokens/admin/${patId}/invalidate`);
  expect(inv.status()).toBe(200);
  const invText = await inv.text();
  expect(invText).not.toContain(body.token);
  expect((await inv.json()).token_hint).toContain('...');
  expect((await pat.get(`${V1}/datasets/${fx.dataset.id}`)).status()).toBe(401);
});

test('Token domains: refresh / OAuth-state tokens are not access tokens, in the API and the browser',
  async ({ browser }) => {
    for (const k of ['owner_refresh', 'owner_oauth_state']) {
      const r = await as(browser, null, fx.tokens[k]);
      expect((await r.get(`${V1}/auth/me`)).status(), k).toBe(401);
    }
    expect((await (await as(browser, 'owner')).get(`${V1}/auth/me`)).status()).toBe(200);

    // browser: a real access cookie enters the app; a refresh token in that cookie bounces to /login
    const ok = await newPage(browser, fx.users.owner.access);
    const p1 = await ok.newPage();
    await p1.goto('/datasets');
    await expect(p1).not.toHaveURL(/\/login/);
    const bad = await newPage(browser, fx.tokens.owner_refresh);
    const p2 = await bad.newPage();
    await p2.goto('/datasets');
    await expect(p2).toHaveURL(/\/login/);
  });

test('Agent Flow: a viewer of a flow does not inherit the owner authority', async ({ browser }) => {
  const viewer = await as(browser, 'viewer');
  const unrelated = await as(browser, 'unrelated');
  const owner = await as(browser, 'owner');
  expect((await owner.get(`${V1}/agent-flows/brains/${fx.flow.key}`)).status()).toBe(200);
  expect([403, 404]).toContain((await unrelated.get(`${V1}/agent-flows/brains/${fx.flow.key}`)).status());
  // no delegation exists: the flow's authority for the viewer is only the viewer's own
  const dl = await owner.get(`${V1}/agent-flows/brains/${fx.flow.key}/delegations`);
  expect(dl.status()).toBe(200);
  expect(JSON.stringify(await dl.json())).not.toContain(fx.users.viewer.id);
  expect([403, 404]).toContain((await viewer.post(`${V1}/agent-flows/brains/${fx.flow.key}/delegations`,
    { data: { grantee_user_id: fx.users.viewer.id, resource_type: 'dataset', resource_id: fx.dataset.id, actions: ['explore'] } })).status());
});

test('Dataset across modules: charts, reports and custom SQL each need their own right', async ({ browser }) => {
  const ds = fx.dataset.id;
  const t = fx.dataset.table_id;
  const viewer = await as(browser, 'viewer');
  const builder = await as(browser, 'builder');
  const owner = await as(browser, 'owner');
  const plain = { roleConfig: { selectedColumns: ['id'] } };
  const custom = { queryMode: 'custom', customSql: 'SELECT current_user', customRoleConfig: {} };

  // view on the dataset builds nothing in another module
  expect([403, 404]).toContain((await viewer.post(`${V1}/charts/`,
    { data: { name: `v-${fx.run}`, chart_type: 'TABLE', dataset_table_id: t, config: plain } })).status());
  expect([403, 404]).toContain((await viewer.post(`${V1}/dashboards/report-starter`,
    { data: { dataset_id: ds, goal: 'x' } })).status());
  expect([403, 404]).toContain((await viewer.post(`${V1}/workboards/`,
    { data: { name: `v-${fx.run}`, dataset_id: ds, primary_table_id: t } })).status());
  // build does
  expect((await builder.post(`${V1}/charts/`,
    { data: { name: `b-${fx.run}`, chart_type: 'TABLE', dataset_table_id: t, config: plain } })).status()).toBe(201);
  // ... but custom SQL is datasource authority, not dataset authority
  expect((await builder.post(`${V1}/charts/preview-data`,
    { data: { dataset_table_id: t, chart_type: 'TABLE', config: custom } })).status()).toBe(403);
  expect((await builder.post(`${V1}/charts/`,
    { data: { name: `bs-${fx.run}`, chart_type: 'TABLE', dataset_table_id: t, config: custom } })).status()).toBe(403);
  // the datasource owner passes the authority check (the unreachable host then fails the query itself)
  expect((await owner.post(`${V1}/charts/preview-data`,
    { data: { dataset_table_id: t, chart_type: 'TABLE', config: custom } })).status()).not.toBe(403);
});

test('Govern: catalog notes follow the dataset; global ones are for admins', async ({ browser }) => {
  const ds = fx.dataset.id;
  const owner = await as(browser, 'owner');
  const unrelated = await as(browser, 'unrelated');
  const admin = await as(browser, 'admin');
  const body = { title: `sec ${fx.run}`, content: 'c', dataset_id: ds };
  expect([403, 404]).toContain((await unrelated.put(`${V1}/catalog/govern/caveats`, { data: body })).status());
  const made = await owner.put(`${V1}/catalog/govern/caveats`, { data: body });
  expect(made.status()).toBe(200);
  const cid = (await made.json()).id;
  expect([403, 404]).toContain((await unrelated.delete(`${V1}/catalog/govern/caveats/${cid}`)).status());
  const listed = await (await unrelated.get(`${V1}/catalog/govern/caveats`)).json();
  expect((listed.caveats || []).map((c: { id: number }) => c.id)).not.toContain(cid);
  // tenant-wide notes: module administrators only
  const global = { title: `g ${fx.run}`, content: 'c', dataset_id: null };
  expect((await owner.put(`${V1}/catalog/govern/caveats`, { data: global })).status()).toBe(403);
  expect((await admin.put(`${V1}/catalog/govern/caveats`, { data: global })).status()).toBe(200);
});

// LAST: it revokes the editor's grant and demotes the builder.
test('PAT demotion: a token never outlives its owner\'s authority', async ({ browser }) => {
  const ds = fx.dataset.id;
  const editor = await as(browser, 'editor');
  const builder = await as(browser, 'builder');
  const owner = await as(browser, 'owner');
  const admin = await as(browser, 'admin');
  const mint = async (who: APIRequestContext, scopes: Record<string, string>) => {
    const r = await who.post(`${V1}/auth/personal-access-tokens/`,
      { data: { name: `d-${fx.run}-${Math.random().toString(36).slice(2, 7)}`, scopes, expires_in_days: 7 } });
    expect(r.status()).toBe(201);
    return as(browser, null, (await r.json()).token);
  };

  // (1) the owner of the PAT loses the GRANT
  const ePat = await mint(editor, { datasets: 'edit' });
  expect((await ePat.put(`${V1}/datasets/${ds}`, { data: { description: `pat ${fx.run}` } })).status()).toBe(200);
  expect((await owner.delete(`${V1}/datasets/${ds}/grants?user_id=${fx.users.editor.id}`)).status()).toBe(200);
  expect([403, 404]).toContain((await ePat.put(`${V1}/datasets/${ds}`, { data: { description: 'x' } })).status());
  expect([403, 404]).toContain((await ePat.get(`${V1}/datasets/${ds}`)).status());

  // (2) the owner of the PAT is demoted in the MODULE by an administrator
  const bPat = await mint(builder, { datasets: 'view' });
  expect((await bPat.get(`${V1}/datasets/${ds}`)).status()).toBe(200);
  expect((await admin.put(`${V1}/permissions/${fx.users.builder.id}`,
    { data: { permissions: { datasets: 'none' } } })).status()).toBe(200);
  expect([401, 403, 404]).toContain((await bPat.get(`${V1}/datasets/${ds}`)).status());
});

/** A fresh browser context, optionally carrying an access_token cookie for the frontend. */
async function newPage(browser: Browser, accessCookie?: string): Promise<BrowserContext> {
  const base = new URL(process.env.E2E_BASE_URL || 'http://localhost:3000');
  const ctx = await browser.newContext({
    baseURL: base.origin,
    storageState: {
      cookies: accessCookie ? [{ name: 'access_token', value: accessCookie, domain: base.hostname, path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }] : [],
      origins: [],
    },
  });
  contexts.push(ctx);
  return ctx;
}
