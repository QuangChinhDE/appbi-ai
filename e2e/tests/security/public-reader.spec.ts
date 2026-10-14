import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PUBLIC READER BOUNDARY - deterministic, no model, no skip (release gate).
 *
 *   An anonymous public-link reader never receives internal execution, tool or
 *   system details - on the wire or on the page, with every detail panel open.
 *
 * Replaces the model-dependent half of agent-flow-v1-reader-golden.spec.ts:287
 * as the SECURITY gate. A real turn runs in CI with no LLM credential because the
 * bound flow is MODEL-FREE: two `tool` steps (no model decides anything) and a
 * `set_var` answer. Everything is real - the owner creates/publishes/binds the
 * flow through the API, the anonymous browser asks through the public chat
 * endpoint, the dispatcher runs the flow, the registry enforces scope, and the
 * public serializer (agent_flows/wire.py + reader_diagnostics) is what is under
 * test. Nothing is mocked and nothing is injected into the DOM.
 *
 * The run produces dangerous internals ON THE TRUSTED SIDE - proven by reading the
 * owner's own run trace below:
 *   step 1  get_chart_data on a chart OUTSIDE the binding's allowlist -> a real
 *           `chart_out_of_scope` refusal whose technical message names the tool
 *           id and the raw chart id;
 *   step 2  get_chart_data on an allowed chart whose datasource is unreachable ->
 *           a real execution failure (exception class in the technical message);
 *   node keys, the flow key, binding / execution internals of the run row.
 * The test then asserts that NONE of it reaches the reader.
 *
 * Fixture: backend/scripts/ci/seed_e2e_security.py (`reader`). The workflow
 * enrolls exactly that link in the reader pilot (AGENT_FLOW_PILOT_LINK_IDS).
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
    // reading a tool result's technical message. Produced here deterministically
    // by the answer step itself; the reader-text guard must remove all of it
    // before the answer is stored and published, whoever wrote it.
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

    // ── an anonymous browser asks through the real public surface ────────────
    const readerCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page: Page = await readerCtx.newPage();
    const aiWire: { url: string; body: string }[] = [];
    page.on('request', (req) => {
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
    const box = page.locator('textarea').first();
    await expect(box, 'the public assistant offered no chat box (is the flow bound?)').toBeVisible({ timeout: 30_000 });
    await box.fill('Doanh thu là bao nhiêu?');
    await box.press('Enter');
    // the deterministic answer - the turn really ran (not blocked by the pilot)
    await expect(page.getByText(ANSWER).first()).toBeVisible({ timeout: 60_000 });

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

    // ── the trusted side DID produce the internals (else the test proves nothing)
    const runs = await (await owner.get(`${V1}/agent-flows/brains/${KEY}/runs?hours=24`)).json();
    const rows = runs.runs ?? runs.items ?? [];
    expect(rows.length, 'no run was recorded for the public turn').toBeGreaterThan(0);
    const runId = rows[0].run_id ?? rows[0].id;
    const trusted = await (await owner.get(`${V1}/agent-flows/brains/${KEY}/runs/${runId}`)).text();
    expect(trusted, 'the turn was blocked, not run (pilot enrollment?)').not.toMatch(/pilot_not_enrolled|reader_mode_off/);
    expect(trusted).toContain('get_chart_data');
    expect(trusted).toMatch(new RegExp(`chart_id ${r.chart_out} is not part of this dashboard`));
    expect(trusted).toContain('ngoai_pham_vi');
    // ...and the answer step really produced prose full of internals (raw, in the author's trace)
    expect(trusted).toContain('Traceback (most recent call last)');

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
    ];
    const hits = (text: string) => forbidden.filter((f) => (typeof f === 'string' ? text.includes(f) : f.test(text)));

    // THE TURN (chat stream + its saved/restored session) gets the full list. Other
    // public AI endpoints (e.g. the briefing guess) legitimately list the REPORT's
    // own charts by id - those ids are public: the public dashboard payload and
    // the chart-data URLs carry them - so only the chart-id rule is relaxed there.
    const isTurn = (u: string) => /\/ai\/(agent|session)\//.test(u);
    const publicChartIds = new Set<string | RegExp>(['chart_id', forbidden.find((f) => f instanceof RegExp)!]);
    expect(aiWire.some((w) => /\/ai\/agent\/chat/.test(w.url)), 'the chat turn itself was not captured').toBe(true);
    for (const w of aiWire) {
      const found = hits(w.body).filter((f) => isTurn(w.url) || !publicChartIds.has(f));
      expect(found, `internal details on the public wire (${w.url})`).toEqual([]);
    }
    // the page: every forbidden value except the bare chart id (a page may show numbers)
    const domHits = hits(dom).filter((f) => typeof f === 'string');
    expect(domHits, 'internal details rendered to the anonymous reader').toEqual([]);

    await owner.delete(`${V1}/agent-flows/bindings/link/${r.link_id}`).catch(() => {});
    await readerCtx.close();
    await ownerCtx.close();
  });
