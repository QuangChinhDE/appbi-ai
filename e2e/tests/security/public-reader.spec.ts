import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PUBLIC READER BOUNDARY (release gate).
 *
 *   An anonymous public-link reader never receives internal execution, tool or
 *   system details - on the wire or on the page, with every detail panel open.
 *
 * REWRITTEN 2026-10-28 for the ONE Answer Core (ADR-3 revised; declared protection
 * change, approved by the PO). The public bot is answered by the Core over the
 * link's published report; a bound Agent Flow is only an optional DOCUMENTS add-on
 * the Core may call, never the answerer. The previous version waited for a
 * model-free flow's own answer to be shown to the reader - the architecture that
 * was retired - and so can no longer pass.
 *
 * What is the same: the owner builds, publishes and binds a MODEL-FREE flow through
 * the real API whose run produces dangerous internals (an out-of-scope chart read,
 * a failing chart read, answer prose that echoes tool ids, error codes, a Traceback
 * and an internal URL); the anonymous browser uses the real public surface; the
 * same forbidden list is asserted on every public AI request/response and on the
 * page with every detail open. Nothing is mocked.
 *
 * What depends on the deployment: a public turn needs the Core's model. With one,
 * a DOCUMENT question runs the bound flow as the add-on and the trusted run is
 * checked to really hold the internals. Without one (CI), the bot states it is not
 * ready - that surface is held to the same list - and the add-on boundary is locked
 * deterministically where it lives: backend/tests/test_chat_extension.py::
 * test_an_add_on_output_that_echoes_internals_reaches_no_reader (same echo).
 *
 * Fixture: backend/scripts/ci/seed_e2e_security.py (`reader`).
 */
const FIXTURE = process.env.E2E_SECURITY_FIXTURE
  || path.join(__dirname, '..', '..', '.auth', 'security.json');
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const V1 = `${API}/api/v1`;

type Fx = {
  run: string;
  users: Record<string, { id: string; email: string; access: string }>;
  reader: { dashboard_id: number; link_id: number; token: string; chart_in: number; chart_out: number };
};

test('an anonymous public reader receives no internal execution details, even with every detail open',
  async ({ browser }) => {
    expect(fs.existsSync(FIXTURE), `security fixture missing at ${FIXTURE}`).toBe(true);
    const fx: Fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
    const r = fx.reader;
    expect(r, 'fixture has no public-reader section - rerun seed_e2e_security.py').toBeTruthy();

    // ── the owner builds and binds a MODEL-FREE flow through the real API ─────
    const ownerCtx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: { Authorization: `Bearer ${fx.users.owner.access}` },
    });
    const owner: APIRequestContext = ownerCtx.request;
    const KEY = `sec_reader_${fx.run}_${Date.now().toString(36)}`;
    const ANSWER = `Câu trả lời xác định ${fx.run}.`;
    // ANSWER PROSE THAT REPEATS INTERNALS - the shape a model can produce after
    // reading a tool result's technical message. Whoever wrote it, none of it may
    // reach a reader.
    const ECHO = ` get_chart_data: chart_id ${r.chart_out} is not part of this dashboard (chart_out_of_scope, `
      + 'error_code, brain_key, answer_node). failed to load chart 1: ValueError. dataset_table_42 at '
      + 'http://localhost:8000/api/v1/internal. Traceback (most recent call last):\n  File "x.py", line 1, in f\n\nHết.';
    const saved = await owner.put(`${V1}/agent-flows/brains`, {
      data: {
        brain_key: KEY, name: 'Security reader boundary', flow_type: 'bot',
        body: {
          nodes: [
            { key: 'ngoai_pham_vi', type: 'tool', name: 'Đọc biểu đồ ngoài phạm vi', tool: 'get_chart_data',
              inputs: { chart_id: { source: 'literal', value: r.chart_out } }, output_var: 'ket_qua_1' },
            { key: 'loi_ket_noi', type: 'tool', name: 'Đọc biểu đồ trong phạm vi', tool: 'get_chart_data',
              inputs: { chart_id: { source: 'literal', value: r.chart_in } }, output_var: 'ket_qua_2' },
            { key: 'tra_loi', type: 'set_var', name: 'Trả lời', var: 'answer', value: ANSWER + ECHO },
          ],
          answer_node: 'tra_loi',
        },
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const published = await owner.post(`${V1}/agent-flows/brains/${KEY}/1/publish`);
    expect(published.status(), await published.text()).toBe(200);
    const bound = await owner.put(`${V1}/agent-flows/bindings`, {
      data: { brain_key: KEY, link_id: r.link_id,
        data_contract: { charts: { mode: 'allowlist', ids: [r.chart_in] } } },
    });
    expect(bound.status(), await bound.text()).toBe(200);

    // ── an anonymous browser uses the real public surface ────────────────────
    const readerCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page: Page = await readerCtx.newPage();
    const aiWire: { url: string; body: string }[] = [];
    const authed: string[] = [];
    const keyHeaders: string[] = [];
    page.on('request', (req) => {
      const h = req.headers();
      if (req.url().includes('/api/') && h['authorization']) authed.push(req.url());
      if (Object.keys(h).some((k) => k.toLowerCase().startsWith('x-user-ai-'))) keyHeaders.push(req.url());
      if (req.url().includes('/api/v1/public/') && /\/ai(\/|-)/.test(req.url()) && req.postData()) {
        aiWire.push({ url: `REQUEST ${req.method()} ${req.url()}`, body: req.postData() || '' });
      }
    });
    const pending: Promise<void>[] = [];
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('/api/v1/public/') && /\/ai(\/|-)/.test(u)) {
        pending.push(res.text().then((body) => { aiWire.push({ url: u, body }); }).catch(() => {}));
      }
    });

    await page.goto(`/d/${r.token}`);
    await page.locator('button[aria-label*="AI"], button[title*="AI"]').first().click();
    await expect(page.getByTestId('ai-bot-panel'), 'the public assistant did not open').toBeVisible({ timeout: 30_000 });
    const status = await (await readerCtx.request.get(`${V1}/public/dashboards/${r.token}/ai/status`)).json();
    let ranTurn = false;
    if (status.ready) {
      // a DOCUMENT question: the Core answers what the data can, then calls the
      // bound flow as its add-on - the run that holds the internals
      const box = page.getByTestId('ai-bot-input');
      await box.fill('Chính sách hoàn phí vận chuyển như thế nào?');
      await page.getByTestId('ai-bot-send').click();
      await expect(page.getByTestId('ai-bot-exchange').first())
        .not.toHaveAttribute('data-status', 'running', { timeout: 120_000 });
      ranTurn = true;
    } else {
      // no model on this deployment: the bot says so plainly, and asks nothing of the reader
      await expect(page.getByTestId('ai-bot-not-ready')).toBeVisible();
      test.info().annotations.push({ type: 'no-model',
        description: 'no public turn on this deployment; add-on boundary locked by test_chat_extension.py' });
    }

    // EXPAND EVERYTHING THE READER CAN EXPAND, until nothing collapsed remains.
    for (let pass = 0; pass < 5; pass += 1) {
      const closed = page.locator(
        'button[aria-expanded="false"], summary, button:has-text("Xem chi tiết"), button:has-text("View details"), button:has-text("▸")',
      );
      const n = await closed.count();
      if (!n) break;
      for (let i = 0; i < n; i += 1) await closed.nth(i).click({ timeout: 2_000 }).catch(() => {});
    }
    await Promise.all(pending);
    const dom = await page.locator('body').innerText();

    if (ranTurn) {
      // ── the trusted side DID produce the internals (else the test proves nothing)
      const runs = await (await owner.get(`${V1}/agent-flows/brains/${KEY}/runs?hours=24`)).json();
      const rows = runs.runs ?? runs.items ?? [];
      expect(rows.length, 'the add-on was not run for the document question').toBeGreaterThan(0);
      const runId = rows[0].run_id ?? rows[0].id;
      const trusted = await (await owner.get(`${V1}/agent-flows/brains/${KEY}/runs/${runId}`)).text();
      expect(trusted).toContain('get_chart_data');
      expect(trusted).toContain('ngoai_pham_vi');
      expect(trusted).toContain('Traceback (most recent call last)');
      expect(aiWire.some((w) => /\/ai\/answer/.test(w.url)), 'the turn itself was not captured').toBe(true);
    }

    // ── nothing internal reaches the reader: WIRE, then PAGE ─────────────────
    const forbidden: (string | RegExp)[] = [
      // tool ids
      'get_chart_data', 'rank_values', 'total_measure', 'search_business_assets',
      // node / registry identifiers and the flow key
      'ngoai_pham_vi', 'loi_ket_noi', 'answer_node', 'brain_key', KEY, 'binding_id',
      // error taxonomy and technical messages
      'error_code', 'chart_out_of_scope', 'is not part of this dashboard', 'failed to load chart',
      'Traceback', 'ValueError', 'Exception',
      // raw field keys / ids
      'dataset_table', 'chart_id', new RegExp(`\\b${r.chart_out}\\b`),
      // internal hosts and execution metadata
      'localhost:', '127.0.0.1', 'warehouse.invalid', 'execution_path', 'not_executed', 'config_source',
      'owner_email', fx.users.owner.email,
      // credentials of any kind
      'ai_bot_key', 'credential_id', 'secret_enc',
    ];
    const hits = (text: string) => forbidden.filter((f) => (typeof f === 'string' ? text.includes(f) : f.test(text)));

    // THE TURN (the answer stream and its turn view) gets the full list. Other public
    // AI endpoints may legitimately carry the REPORT's own chart ids - those are
    // public (the dashboard payload and chart-data URLs carry them) - so only the
    // chart-id rule is relaxed there.
    const isTurn = (u: string) => /\/ai\/answer/.test(u);
    const publicChartIds = new Set<string | RegExp>(['chart_id', forbidden.find((f) => f instanceof RegExp)!]);
    for (const w of aiWire) {
      const found = hits(w.body).filter((f) => isTurn(w.url) || !publicChartIds.has(f));
      expect(found, `internal details on the public wire (${w.url})`).toEqual([]);
    }
    // the page: every forbidden value except the bare chart id (a page may show numbers)
    const domHits = hits(dom).filter((f) => typeof f === 'string');
    expect(domHits, 'internal details rendered to the anonymous reader').toEqual([]);
    expect(authed, 'the public page made a signed-in call').toEqual([]);
    expect(keyHeaders, 'the public page sent a provider key header').toEqual([]);

    await owner.delete(`${V1}/agent-flows/bindings/link/${r.link_id}`).catch(() => {});
    await readerCtx.close();
    await ownerCtx.close();
  });
