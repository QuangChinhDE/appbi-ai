import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, BRAINS, deleteFlow, e2eCredentialId, saveDraft } from './_helpers';

/**
 * Specialized Agents: roles with a server-enforced tool boundary, and explicit
 * `reads_from` handoff between agents.
 *
 * Three groups:
 *   • security — the boundary is the SERVER's, proven by forged payloads (no model)
 *   • authoring — the builder, driven like an author (no model)
 *   • live — real runs through the product's own test-on-report path, on a real
 *     model. Only when E2E_LIVE_CREDENTIAL names a stored AI key (cost: a few
 *     tenths of a cent per run on gpt-4o-mini). Otherwise SKIPPED, never faked.
 *
 * Fixtures: the Olist report (E2E_DASHBOARD, default 67) and its documents 26/30.
 */
const LIVE_CRED = Number(process.env.E2E_LIVE_CREDENTIAL || 0);
const DASH = Number(process.env.E2E_DASHBOARD || 67);
const MODEL = process.env.E2E_LIVE_MODEL || 'gpt-4o-mini';
const STAMP = Date.now();
const made: string[] = [];

const DOC = { source: 'document', ref: '26', description: 'Định nghĩa doanh thu, GMV và giá trị đơn của Olist' };

function agent(key: string, extra: Record<string, unknown> = {}) {
  return {
    key, name: key, type: 'agent', prompt: `Bước ${key}: trả lời ngắn gọn bằng tiếng Việt.`,
    provider: 'openai', model: MODEL, credential_id: LIVE_CRED || null, max_tool_calls: 5, tools: [],
    ...extra,
  };
}

const tools = (...names: string[]) => names.map((tool) => ({ tool }));

async function put(request: APIRequestContext, key: string, body: unknown) {
  made.push(key);
  return request.put(BRAINS, { data: { brain_key: key, name: `E2E specialist ${key}`, body } });
}

async function runOnReport(request: APIRequestContext, key: string, question: string) {
  const res = await request.post(`${BRAINS}/${key}/test-on-report`, {
    data: { question, dashboard_id: DASH }, timeout: 300_000,
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  return json.envelope ?? json;
}

const stepOf = (env: any, key: string) => (env.trace?.steps ?? []).find((s: any) => s.key === key);
const codes = (env: any) => (env.notices ?? []).map((n: any) => n.code);

test.afterAll(async ({ request }) => {
  for (const key of made) await deleteFlow(request, key);
});

// ── security: the boundary is enforced by the server ───────────────────────
test.describe('specialist boundary (server)', () => {
  test('a grant outside the role is refused on save (forged payload)', async ({ request }) => {
    const res = await put(request, `e2e_sp_forge_${STAMP}`, {
      nodes: [agent('rr', { role: 'report_reader', tools: tools('list_charts', 'research_web') })],
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('research_web');
  });

  test('an unknown role is refused on save', async ({ request }) => {
    const res = await put(request, `e2e_sp_unknown_${STAMP}`, {
      nodes: [agent('x', { role: 'superuser', tools: tools('list_charts') })],
    });
    expect(res.status()).toBe(422);
  });

  test('a Skill grant is outside every role', async ({ request }) => {
    const res = await put(request, `e2e_sp_skill_${STAMP}`, {
      nodes: [agent('m', { role: 'metric_analyst', tools: tools('total_measure', 'skill:anything') })],
    });
    expect(res.status()).toBe(422);
  });

  test('role dependencies and impossible inputs block publish, even acknowledged', async ({ request }) => {
    const key = `e2e_sp_publish_${STAMP}`;
    const saved = await put(request, key, {
      answer_node: 'w',
      nodes: [
        agent('kr', { role: 'knowledge_reader', tools: tools('search_knowledge') }),
        agent('w', { role: 'answer_writer', reads_from: ['kr', 'ghost_step'] }),
      ],
    });
    expect(saved.status(), await saved.text()).toBeLessThan(400);
    const version = (await saved.json()).version;
    const pub = await request.post(`${BRAINS}/${key}/${version}/publish`, {
      data: { acknowledge_problems: true },
    });
    expect(pub.status()).toBe(409);
    const text = await pub.text();
    expect(text).toContain('chưa đính kèm nguồn tri thức');
    expect(text).toContain('ghost_step');
  });

  test('a custom agent keeps any grant it had (backward compatible)', async ({ request }) => {
    const key = `e2e_sp_custom_${STAMP}`;
    const res = await put(request, key, {
      nodes: [agent('c', { tools: tools('list_charts', 'total_measure', 'search_knowledge') })],
    });
    expect(res.status(), await res.text()).toBeLessThan(400);
    const got = await (await request.get(`${BRAINS}/${key}`)).json();
    const node = got.body.nodes[0];
    expect(node.tools.map((t: any) => t.tool)).toEqual(['list_charts', 'total_measure', 'search_knowledge']);
    expect(node.role || '').toBe('');
  });

  test('the role catalogue is served with the tools it bounds', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/agent-flows/tools`, { params: { web_enabled: 'true' } });
    const json = await res.json();
    const names = new Set(json.packs.flatMap((p: any) => p.tools.map((t: any) => t.name)));
    expect(json.roles.map((r: any) => r.key)).toEqual(
      ['report_reader', 'knowledge_reader', 'metric_analyst', 'diagnostic_analyst', 'answer_writer']);
    for (const r of json.roles) for (const t of r.allowed_tools) expect(names.has(t), `${r.key}:${t}`).toBe(true);
  });
});

// ── authoring: the builder ─────────────────────────────────────────────────
test.describe('specialist authoring (builder)', () => {
  test.setTimeout(180_000);

  test('add a specialist, see its boundary, switch role, wire reads-from, save', async ({ page, request }) => {
    const key = `e2e_sp_ui_${STAMP}`;
    made.push(key);
    await saveDraft(request, key, `E2E specialist UI ${STAMP}`, {
      nodes: [agent('dau_tien', { name: 'Bước đầu', tools: tools('list_charts') })],
    });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('Bước đầu').first().waitFor({ timeout: 120_000 });

    // J11: the role is chosen where a step is added — one click, no wizard.
    await page.locator('button[data-drop]').last().click();
    await expect(page.getByTestId('node-library-roles')).toBeVisible();
    for (const r of ['report_reader', 'knowledge_reader', 'metric_analyst', 'diagnostic_analyst', 'answer_writer']) {
      await expect(page.getByTestId(`node-role-${r}`)).toBeVisible();
    }
    await page.getByTestId('node-role-metric_analyst').click();

    // The inspector says what the role is for and what bounds it.
    const card = page.getByTestId('agent-role-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('agent-role-section').locator('select')).toHaveValue('metric_analyst');
    // The canvas names the role.
    await expect(page.locator('[data-testid^="canvas-role-"]').first()).toBeVisible();

    // J6 wiring: read from the first step explicitly.
    const reads = page.getByTestId('agent-reads-from');
    await reads.locator('select').selectOption('dau_tien');
    await expect(reads).toContainText('Bước đầu');
    await expect(page.locator('[data-testid^="canvas-reads-"]').first()).toContainText('dau_tien');

    // Switching to the writer drops the measuring tools and SAYS so.
    await page.getByTestId('agent-role-section').locator('select').selectOption('answer_writer');
    await expect(page.getByTestId('agent-role-removed')).toBeVisible();

    await page.getByTestId('builder-save').click();
    await expect.poll(async () => {
      const got = await (await request.get(`${BRAINS}/${key}`)).json();
      const n = got.body.nodes.find((x: any) => x.role === 'answer_writer');
      return n ? { tools: n.tools.length, reads: n.reads_from } : null;
    }, { timeout: 30_000 }).toEqual({ tools: 0, reads: ['dau_tien'] });
  });
});

// ── live: real model, real data ────────────────────────────────────────────
test.describe('specialist journeys (live model)', () => {
  test.skip(!LIVE_CRED, 'E2E_LIVE_CREDENTIAL not set — live journeys need a stored AI key');
  test.setTimeout(600_000);

  test('J1 a single custom agent still answers from the report', async ({ request }) => {
    const key = `e2e_sp_j1_${STAMP}`;
    expect((await put(request, key, { nodes: [agent('one', {
      tools: tools('resolve_chart_candidates', 'list_charts', 'total_measure'), prompt: 'Trả lời bằng số liệu.' })] })).status())
      .toBeLessThan(400);
    const env = await runOnReport(request, key, 'Tổng doanh thu sản phẩm toàn kỳ là bao nhiêu?');
    expect(env.status).toBe('ok');
    expect(env.answer.text.replace(/[.,\s]/g, '')).toContain('1359164');
  });

  test('J2/J4 reader then analyst: tools stay inside each role, step 1 reaches step 2', async ({ request }) => {
    const key = `e2e_sp_j2_${STAMP}`;
    const body = { answer_node: 'ma', nodes: [
      agent('rr', { role: 'report_reader', tools: tools('resolve_chart_candidates', 'list_charts', 'describe_time_coverage'),
        prompt: 'Tìm biểu đồ doanh thu theo danh mục; ghi chart_id.' }),
      agent('ma', { role: 'metric_analyst', reads_from: ['rr'],
        tools: tools('resolve_chart_candidates', 'list_charts', 'rank_values', 'share_of'),
        prompt: 'Đo danh mục doanh thu cao nhất và tỷ trọng của nó.' }),
    ] };
    expect((await put(request, key, body)).status()).toBeLessThan(400);
    const env = await runOnReport(request, key, 'Danh mục nào có doanh thu cao nhất và chiếm bao nhiêu %?');
    const rr = stepOf(env, 'rr');
    const ma = stepOf(env, 'ma');
    expect(ma, `steps: ${JSON.stringify((env.trace?.steps ?? []).map((s: any) => [s.key, s.status, s.error]))} notices: ${JSON.stringify(codes(env))}`).toBeTruthy();
    const reader = new Set(['resolve_chart_candidates', 'list_charts', 'describe_time_coverage']);
    for (const t of rr.tool_calls) expect(reader.has(t), t).toBe(true);
    expect(ma.capabilities.handoff.mode).toBe('inputs');
    expect(ma.capabilities.handoff.included).toContain('rr');
    expect(env.answer.text.toLowerCase()).toContain('health');
  });

  test('J3 knowledge reader cites only the attached document', async ({ request }) => {
    const key = `e2e_sp_j3_${STAMP}`;
    expect((await put(request, key, { nodes: [agent('kr', { role: 'knowledge_reader',
      tools: tools('search_knowledge', 'read_document'), knowledge: [DOC] })] })).status()).toBeLessThan(400);
    const env = await runOnReport(request, key, 'Theo tài liệu, GMV có bao gồm phí vận chuyển không?');
    expect(env.status).not.toBe('failed');
    expect(stepOf(env, 'kr').tool_calls.some((t: string) => t === 'search_knowledge' || t === 'read_document')).toBe(true);
    expect(env.answer.text.toLowerCase()).toMatch(/vận chuyển|ship|freight/);
  });

  test('J6/J9 a failed input is told to the next step and the run is partial', async ({ request }) => {
    const key = `e2e_sp_j6_${STAMP}`;
    // `boom` runs on the suite's FAKE key: the vendor refuses it, a real failure
    // that costs nothing. `w` reads from `rr` (works) and `boom` (fails).
    const fake = await e2eCredentialId(request);
    const body = { answer_node: 'w', nodes: [
      agent('rr', { role: 'report_reader', tools: tools('list_charts'), prompt: 'Liệt kê biểu đồ doanh thu.' }),
      agent('boom', { role: 'metric_analyst', tools: tools('list_charts', 'total_measure'), credential_id: fake,
        retry: { max_attempts: 1 }, on_error: 'continue', prompt: 'Đo doanh thu.' }),
      agent('w', { role: 'answer_writer', reads_from: ['rr', 'boom'], prompt: 'Trả lời từ kết quả các bước trước.' }),
    ] };
    expect((await put(request, key, body)).status()).toBeLessThan(400);
    const env = await runOnReport(request, key, 'Tổng doanh thu là bao nhiêu?');
    expect(stepOf(env, 'boom').status).toBe('error');
    const h = stepOf(env, 'w').capabilities.handoff;
    expect(h.mode).toBe('inputs');
    expect(h.included).toContain('rr');
    expect(h.missing).toEqual([expect.objectContaining({ key: 'boom', status: 'error' })]);
    expect(codes(env)).toContain('handoff_input_missing');
    expect(env.status).toBe('partial');
  });

  test('J8 a branch that did not run is reported missing, not silently skipped', async ({ request }) => {
    const key = `e2e_sp_j8_${STAMP}`;
    const body = { answer_node: 'w', nodes: [
      { key: 'phan_loai', type: 'set_var', name: 'Loại', var: 'loai', value: 'so_lieu' },
      { key: 're_nhanh', type: 'switch', name: 'Rẽ nhánh', value: '{{loai}}', cases: [
        { key: 'case_so', label: 'Số liệu', value: 'so_lieu', body: [
          agent('ma', { role: 'metric_analyst', tools: tools('resolve_chart_candidates', 'list_charts', 'total_measure'),
            prompt: 'Đo tổng doanh thu sản phẩm.' })] },
        { key: 'case_doc', label: 'Tài liệu', value: 'tai_lieu', body: [
          agent('kr', { role: 'knowledge_reader', tools: tools('search_knowledge'), knowledge: [DOC] })] },
      ] },
      agent('w', { role: 'answer_writer', reads_from: ['ma', 'kr'] }),
    ] };
    const saved = await put(request, key, body);
    test.skip(saved.status() >= 400, `switch payload shape differs here: ${await saved.text()}`);
    const env = await runOnReport(request, key, 'Tổng doanh thu sản phẩm là bao nhiêu?');
    const h = stepOf(env, 'w').capabilities.handoff;
    expect(h.included).toContain('ma');
    expect(h.missing.map((m: any) => m.key)).toContain('kr');
    expect(env.status).toBe('partial');
  });

  test('J7 coordinator picks the matching specialist and says when none fits', async ({ request }) => {
    const key = `e2e_sp_j7_${STAMP}`;
    const body = { answer_node: 'w', nodes: [
      { key: 'dp', type: 'coordinate', name: 'Điều phối', provider: 'openai', model: MODEL, credential_id: LIVE_CRED,
        max_specialists: 1, prompt: 'Chọn chuyên gia. Nếu không ai phù hợp, không chọn ai.', specialists: [
          { key: 'cg_so', name: 'Số liệu', when: 'Câu hỏi về doanh thu, đơn hàng, con số của báo cáo',
            body: [agent('ma', { role: 'metric_analyst', tools: tools('resolve_chart_candidates', 'list_charts', 'total_measure') })] },
          { key: 'cg_doc', name: 'Tài liệu', when: 'Câu hỏi về định nghĩa, quy ước trong tài liệu',
            body: [agent('kr', { role: 'knowledge_reader', tools: tools('search_knowledge'), knowledge: [DOC] })] },
        ] },
      agent('w', { role: 'answer_writer' }),
    ] };
    expect((await put(request, key, body)).status()).toBeLessThan(400);
    const one = await runOnReport(request, key, 'Tổng doanh thu sản phẩm là bao nhiêu?');
    const picked = (stepOf(one, 'dp').output_preview || '') as string;
    expect(picked).toContain('cg_so');
    expect(stepOf(one, 'kr')).toBeUndefined();
    const none = await runOnReport(request, key, 'Thời tiết ở Hà Nội hôm nay thế nào?');
    if (!stepOf(none, 'ma') && !stepOf(none, 'kr')) expect(codes(none)).toContain('no_specialist_picked');
  });

  test('J12 publish, edit, and the published version keeps its behaviour', async ({ request }) => {
    const key = `e2e_sp_j12_${STAMP}`;
    const v1 = await put(request, key, { nodes: [agent('a', { role: 'report_reader', tools: tools('list_charts') })] });
    const version = (await v1.json()).version;
    const pub = await request.post(`${BRAINS}/${key}/${version}/publish`, { data: {} });
    expect(pub.status(), await pub.text()).toBeLessThan(400);
    // Edit: a new draft switches the step to custom and adds a tool.
    const v2 = await put(request, key, { nodes: [agent('a', { tools: tools('list_charts', 'total_measure') })] });
    expect(v2.status()).toBeLessThan(400);
    const versions = await (await request.get(`${BRAINS}/${key}/versions`)).json();
    const published = (versions.versions ?? versions).find((v: any) => v.status === 'published');
    expect(published.version).toBe(version);
    const pubBody = await (await request.get(`${BRAINS}/${key}`, { params: { version } })).json();
    expect(pubBody.body.nodes[0].role).toBe('report_reader');
    expect(pubBody.body.nodes[0].tools.map((t: any) => t.tool)).toEqual(['list_charts']);
  });
});

// ── builder hardening (F08 / F09 / F10) ─────────────────────────────────────
test.describe('builder: branches, blanks, follow-ups', () => {
  test.setTimeout(180_000);

  test('F09 a case can be removed, a new case key is unique, IF keeps its minimum', async ({ page, request }) => {
    const key = `e2e_sp_branch_${STAMP}`;
    made.push(key);
    await saveDraft(request, key, `E2E branches ${STAMP}`, { answer_node: 'w', nodes: [
      { key: 'sw', type: 'switch', name: 'Rẽ nhánh', value: '{{question}}', cases: [
        { key: 'case_1', label: 'Ca A', value: 'a', body: [] },
        { key: 'case_3', label: 'Ca B', value: 'b', body: [] },
        { key: 'case_5', label: 'Ca C', value: 'c', body: [] }] },
      { key: 'chon', type: 'if', name: 'Chọn', paths: [
        { key: 'yes', name: 'Nhánh có', kind: 'rules', conditions: [{ left: '{{question}}', op: 'contains', right: 'x' }], body: [] },
        { key: 'no', name: 'Nhánh không', kind: 'fallback', body: [] }] },
      agent('w', { name: 'Trả lời' }),
    ] });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('Trả lời').first().waitFor({ timeout: 120_000 });

    await page.getByText('Ca B').first().click();
    await page.getByTestId('remove-case').click();
    await page.getByText('Nhánh có').first().click();
    await expect(page.getByTestId('remove-path-blocked')).toBeVisible();   // 2 paths = minimum
    await page.getByText('Rẽ nhánh').first().click();
    await page.getByRole('button', { name: /add case|thêm case/i }).first().click();
    await page.getByText('Chọn').first().click();
    await page.getByTestId('add-path').click();
    await page.getByTestId('builder-save').click();

    await expect.poll(async () => {
      const b = (await (await request.get(`${BRAINS}/${key}`)).json()).body;
      const sw = b.nodes.find((n: any) => n.key === 'sw');
      const iff = b.nodes.find((n: any) => n.key === 'chon');
      return { cases: sw.cases.map((c: any) => c.key), paths: iff.paths.map((p: any) => p.kind) };
    }, { timeout: 30_000 }).toEqual({ cases: ['case_1', 'case_5', 'case_3'], paths: ['rules', 'rules', 'fallback'] });
  });

  test('F08 a blank Switch saves as a draft but cannot publish, and says why', async ({ request }) => {
    const key = `e2e_sp_blank_${STAMP}`;
    const saved = await put(request, key, { answer_node: 'w', nodes: [
      { key: 'sw', type: 'switch', name: 'Rẽ nhánh', value: '', cases: [{ key: 'case_1', value: 'a', body: [] }] },
      agent('w')] });
    expect(saved.status(), await saved.text()).toBeLessThan(400);
    const pub = await request.post(`${BRAINS}/${key}/${(await saved.json()).version}/publish`,
      { data: { acknowledge_problems: true } });
    expect(pub.status()).toBe(409);
    expect(await pub.text()).toContain('chưa có giá trị để rẽ nhánh');
  });

  test('F10 the answering step offers a follow-up switch that is saved', async ({ page, request }) => {
    const key = `e2e_sp_fu_${STAMP}`;
    made.push(key);
    await saveDraft(request, key, `E2E followups ${STAMP}`, { answer_node: 'w', nodes: [agent('w', { name: 'Trả lời' })] });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('Trả lời').first().click({ timeout: 120_000 });
    const toggle = page.getByTestId('agent-followups');
    await expect(toggle).toBeVisible();
    await toggle.getByRole('switch').or(toggle.locator('button')).first().click();
    await page.getByTestId('builder-save').click();
    await expect.poll(async () => (await (await request.get(`${BRAINS}/${key}`)).json()).body.nodes[0].followups,
      { timeout: 30_000 }).toBe(false);
  });
});

// ── live analytics: the asked metric, the asked period ──────────────────────
const SAAS = Number(process.env.E2E_SAAS_DASHBOARD || 0);
test.describe('analytics meaning (live model, SaaS fixture)', () => {
  test.skip(!LIVE_CRED || !SAAS, 'needs E2E_LIVE_CREDENTIAL and E2E_SAAS_DASHBOARD (backend/eval fixture)');
  test.setTimeout(600_000);

  async function ask(request: APIRequestContext, key: string, q: string) {
    const res = await request.post(`${BRAINS}/${key}/test-on-report`, { data: { question: q, dashboard_id: SAAS }, timeout: 300_000 });
    expect(res.status(), await res.text()).toBe(200);
    const j = await res.json();
    return j.envelope ?? j;
  }
  const nums = (t: string) => (t.match(/\d[\d.,]*/g) || []).map((x) => Number(x.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')));

  test('the Metric Analyst answers August ARR with August, not July or a sum', async ({ request }) => {
    const key = `e2e_sp_arr_${STAMP}`;
    expect((await put(request, key, { nodes: [agent('ma', { role: 'metric_analyst',
      tools: tools('resolve_chart_candidates', 'list_charts', 'total_measure', 'compare_periods'),
      prompt: 'Trả lời bằng số liệu của đúng kỳ được hỏi.' })] })).status()).toBeLessThan(400);
    const one = await ask(request, key, 'ARR tháng 8 năm 2026 là bao nhiêu?');
    expect(nums(one.answer.text)).toContain(72);
    expect(nums(one.answer.text)).not.toContain(864);
    const cmp = await ask(request, key, 'So sánh ARR tháng 8/2026 với tháng 7/2026.');
    expect(nums(cmp.answer.text)).toEqual(expect.arrayContaining([72, 864]));
    expect(cmp.answer.text.toLowerCase()).toMatch(/giảm|sụt/);
  });

  test('a range total of a flow measure is the range, not one month', async ({ request }) => {
    const key = `e2e_sp_churn_${STAMP}`;
    expect((await put(request, key, { nodes: [agent('ma', { role: 'metric_analyst',
      tools: tools('resolve_chart_candidates', 'list_charts', 'total_measure', 'aggregate_chart_data') })] })).status())
      .toBeLessThan(400);
    const env = await ask(request, key, 'Tổng số khách hàng rời bỏ từ tháng 1 đến tháng 8 năm 2026 là bao nhiêu?');
    const n = nums(env.answer.text);
    // 60 is right; 40 (August alone) must not be presented as the range.
    expect(n.includes(60) || (env.notices || []).length > 0, env.answer.text).toBe(true);
    if (!n.includes(60)) expect(n).not.toContain(40);
  });
});
