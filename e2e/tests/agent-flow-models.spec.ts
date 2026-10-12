import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, BRAINS, CREDENTIALS, deleteFlow } from './_helpers';

/**
 * Model & provider compatibility — the journeys M01–M12.
 *
 * Model step on a model → the key → the model's own protocol → a real run. The
 * live journeys need E2E_LIVE_CREDENTIAL (a stored OpenAI key id on the rig);
 * without it they SKIP and say so, they never pass on a mock.
 */
const LIVE_CRED = Number(process.env.E2E_LIVE_CREDENTIAL || 0);
const DASH = Number(process.env.E2E_SAAS_DASHBOARD || 136);
const STAMP = Date.now();
const MODELS = `${API}/api/v1/agent-flows/models`;
const FAKE = 'sk-appbi-e2e-models-not-a-real-key-9Q2X';
const made: string[] = [];
const keysMade: number[] = [];

function agent(key: string, model: string, extra: Record<string, unknown> = {}) {
  return {
    key, name: key, type: 'agent', prompt: `Bước ${key}: trả lời ngắn gọn bằng tiếng Việt.`,
    provider: 'openai', model, credential_id: LIVE_CRED || null, max_tool_calls: 6, tools: [],
    ...extra,
  };
}
const tools = (...names: string[]) => names.map((tool) => ({ tool }));

async function put(request: APIRequestContext, key: string, body: unknown) {
  made.push(key);
  return request.put(BRAINS, { data: { brain_key: key, name: `E2E models ${key}`, body } });
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
const toolCalls = (env: any, key: string) => (stepOf(env, key)?.tool_calls ?? []) as string[];

test.afterAll(async ({ request }) => {
  for (const key of made) await deleteFlow(request, key);
  for (const id of keysMade) await request.delete(`${CREDENTIALS}/${id}`);
});

test.describe('model catalogue and keys (no model spend)', () => {
  test.setTimeout(180_000);

  test('M01 the picker groups models by provider and says how far each claim goes', async ({ page, request }) => {
    const cat = await (await request.get(MODELS)).json();
    expect(cat.providers.map((p: any) => p.provider)).toEqual(['openai', 'anthropic', 'gemini']);
    const luna = cat.providers[0].models.find((m: any) => m.model === 'gpt-6-luna');
    expect(luna.certification.status).toBe('certified');
    expect(luna.price.source).toContain('openai.com');

    const key = `e2e_m01_${STAMP}`;
    await put(request, key, { nodes: [agent('answer', 'gpt-6-luna')], answer_node: 'answer' });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('answer').first().click();
    const picker = page.getByTestId('agent-model-picker');
    await expect(picker).toBeVisible({ timeout: 60_000 });
    const providerSelect = picker.locator('select').first();
    await expect(providerSelect.locator('option')).toHaveText([/OpenAI/, /Anthropic/, /Gemini/]);
    const modelSelect = picker.locator('select').nth(1);
    await expect(modelSelect).toHaveValue('gpt-6-luna');
    await expect(modelSelect.locator('option', { hasText: 'GPT-6 Luna' })).toContainText(/chứng nhận|certified/);
    await expect(page.getByTestId('agent-model-picker-facts')).toBeVisible();
    await expect(page.getByTestId('agent-model-picker-price')).toContainText('0.1');
    await expect(page.getByTestId('agent-model-picker-cert')).toHaveAttribute('data-status', 'certified');
    // A previous-generation model is labelled and names its replacement.
    await modelSelect.selectOption('gpt-4o-mini');
    await expect(page.getByTestId('agent-model-picker-lifecycle')).toContainText('gpt-6-luna');
    // Unverified providers are offered, and say why they are unverified.
    await providerSelect.selectOption('anthropic');
    await expect(modelSelect).toHaveValue('claude-haiku-5-5');
    await expect(page.getByTestId('agent-model-picker-cert')).toHaveAttribute('data-status', 'unverified');
  });

  test('M02 a key is stored without ever being shown again', async ({ request }) => {
    const res = await request.post(CREDENTIALS, {
      data: { name: `E2E models ${STAMP}`, provider: 'openai', secret: FAKE },
    });
    expect(res.status(), await res.text()).toBe(201);
    const created = await res.json();
    keysMade.push(created.id);
    expect(JSON.stringify(created)).not.toContain(FAKE);
    const list = await (await request.get(CREDENTIALS)).text();
    expect(list).not.toContain(FAKE);
  });

  test('M03 a rejected key is named as a rejected key, by its code', async ({ request }) => {
    const id = keysMade[0];
    test.skip(!id, 'M02 did not create the key');
    const got = await (await request.post(`${CREDENTIALS}/${id}/test`)).json();
    expect(got.ok).toBe(false);
    expect(got.code).toBe('invalid_credentials');
    expect(JSON.stringify(got)).not.toContain(FAKE);
  });

  test('M10 an unknown model is refused on save and named on check', async ({ request }) => {
    const res = await put(request, `e2e_m10_${STAMP}`, {
      nodes: [agent('answer', 'gpt-4-retired-x')], answer_node: 'answer',
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('gpt-4-retired-x');
    test.skip(!LIVE_CRED, 'E2E_LIVE_CREDENTIAL not set');
    const chk = await (await request.post(`${CREDENTIALS}/${LIVE_CRED}/check-model`, {
      data: { model: 'gpt-4-retired-x', smoke: true },
    })).json();
    expect(chk.verdict).toBe('not_ready');
    const avail = chk.levels.find((l: any) => l.level === 'availability');
    expect(['unknown_model', 'model_unavailable']).toContain(avail.code);
    expect(chk.levels.find((l: any) => l.level === 'smoke').status).toBe('not_run');
  });

  test('M05 switching model survives save and reload; the provider switch re-picks', async ({ page, request }) => {
    const key = `e2e_m05_${STAMP}`;
    await put(request, key, { nodes: [agent('answer', 'gpt-4o-mini')], answer_node: 'answer' });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('answer').first().click();
    const picker = page.getByTestId('agent-model-picker');
    await expect(picker).toBeVisible({ timeout: 60_000 });
    await picker.locator('select').nth(1).selectOption('gpt-6.1-sol');
    const saved = page.waitForResponse((r) => r.url().includes('/agent-flows/brains')
      && r.request().method() === 'PUT', { timeout: 30_000 });
    await page.getByTestId('builder-save').click();
    expect((await saved).status()).toBeLessThan(400);
    const detail = await (await request.get(`${BRAINS}/${key}`)).json();
    expect(detail.body.nodes[0].model).toBe('gpt-6.1-sol');
    await page.reload();
    await page.getByText('answer').first().click();
    await expect(page.getByTestId('agent-model-picker').locator('select').nth(1)).toHaveValue('gpt-6.1-sol');
  });
});

test.describe('models on the real vendor (live)', () => {
  test.setTimeout(420_000);
  test.skip(!LIVE_CRED, 'E2E_LIVE_CREDENTIAL not set — live journeys need a real stored key');

  test('M04 the picker checks the chosen model with the step\'s key — a real tool call', async ({ page, request }) => {
    const key = `e2e_m04_${STAMP}`;
    await put(request, key, { nodes: [agent('answer', 'gpt-6-luna')], answer_node: 'answer' });
    await page.goto(`/agent-flows?flow=${key}`);
    await page.getByText('answer').first().click();
    await expect(page.getByTestId('agent-model-picker')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('agent-model-picker-check').click();
    const result = page.getByTestId('agent-model-picker-check-result');
    await expect(result).toBeVisible({ timeout: 120_000 });
    await expect(result).toHaveAttribute('data-verdict', 'ready');
    for (const level of ['credential', 'availability', 'compatibility', 'smoke']) {
      await expect(page.getByTestId(`agent-model-picker-level-${level}`)).toHaveAttribute('data-status', 'pass');
    }
  });

  test('M06 a GPT-6 step calls a real AppBI tool and answers from it', async ({ request }) => {
    const key = `e2e_m06_${STAMP}`;
    const res = await put(request, key, {
      nodes: [agent('answer', 'gpt-6-luna', {
        tools: tools('list_charts', 'get_chart_data', 'total_measure'),
        prompt: 'Trả lời bằng số liệu của báo cáo, dùng công cụ để đọc số. Trả lời ngắn gọn tiếng Việt.',
      })], answer_node: 'answer',
    });
    expect(res.status(), await res.text()).toBeLessThan(400);
    const env = await runOnReport(request, key, 'ARR tháng 8 năm 2026 là bao nhiêu?');
    expect(env.status).toBe('ok');
    expect(toolCalls(env, 'answer').length).toBeGreaterThan(0);
    expect(stepOf(env, 'answer').capabilities.model).toMatchObject({ provider: 'openai', model: 'gpt-6-luna' });
    expect(env.answer.text.replace(/[.,]/g, '')).toContain('72');
  });

  test('M07 several tool calls across several model rounds complete', async ({ request }) => {
    const key = `e2e_m07_${STAMP}`;
    await put(request, key, {
      nodes: [agent('answer', 'gpt-6.1-sol', {
        tools: tools('list_charts', 'get_chart_data', 'total_measure', 'compare_periods'),
        prompt: 'Trước hết liệt kê biểu đồ để tìm biểu đồ ARR theo tháng, rồi đọc số của từng tháng được hỏi. Trả lời ngắn gọn tiếng Việt.',
      })], answer_node: 'answer',
    });
    const env = await runOnReport(request, key, 'So sánh ARR tháng 8/2026 với tháng 7/2026.');
    expect(env.status).toBe('ok');
    expect(toolCalls(env, 'answer').length).toBeGreaterThanOrEqual(2);
    expect(env.usage.llm_calls).toBeGreaterThanOrEqual(3);
    const text = env.answer.text.replace(/[.,]/g, '');
    expect(text).toContain('72');
    expect(text).toContain('864');
  });

  test('M08+M09 specialists on different models hand over correctly', async ({ request }) => {
    const key = `e2e_m09_${STAMP}`;
    const res = await put(request, key, {
      nodes: [
        agent('rr', 'gpt-6-luna', { role: 'report_reader', tools: tools('list_charts', 'resolve_chart_candidates'),
          prompt: 'Xác định biểu đồ ARR theo tháng; ghi chart_id.' }),
        agent('ma', 'gpt-6.1-sol', { role: 'metric_analyst', reads_from: ['rr'],
          tools: tools('total_measure', 'get_chart_data', 'compare_periods'),
          prompt: 'Đo ARR của tháng được hỏi bằng chart_id bước trước đã tìm.' }),
        agent('aw', 'gpt-4o-mini', { role: 'answer_writer', reads_from: ['ma'],
          prompt: 'Viết câu trả lời ngắn gọn tiếng Việt từ kết quả bước trước.' }),
      ],
      answer_node: 'aw',
    });
    expect(res.status(), await res.text()).toBeLessThan(400);
    const env = await runOnReport(request, key, 'ARR tháng 8 năm 2026 là bao nhiêu?');
    expect(env.status).toBe('ok');
    expect(stepOf(env, 'rr').capabilities.model.model).toBe('gpt-6-luna');
    expect(stepOf(env, 'ma').capabilities.model.model).toBe('gpt-6.1-sol');
    expect(stepOf(env, 'aw').capabilities.model.model).toBe('gpt-4o-mini');
    for (const t of stepOf(env, 'rr').tool_calls) {
      expect(['list_charts', 'resolve_chart_candidates']).toContain(String(t).replace(/\(.*\)$/, ''));
    }
    expect(stepOf(env, 'aw').tool_calls).toEqual([]);
    expect(stepOf(env, 'aw').capabilities.handoff.included).toContain('ma');
    expect(env.answer.text.replace(/[.,]/g, '')).toContain('72');
  });

  test('M12 a published flow keeps its model when the draft moves to a new one', async ({ request }) => {
    const key = `e2e_m12_${STAMP}`;
    const v1 = await put(request, key, { nodes: [agent('answer', 'gpt-4o-mini')], answer_node: 'answer' });
    const version = (await v1.json()).version;
    expect((await request.post(`${BRAINS}/${key}/${version}/publish`, { data: {} })).status()).toBeLessThan(400);
    await put(request, key, { nodes: [agent('answer', 'gpt-6-luna')], answer_node: 'answer' });
    const pub = await (await request.get(`${BRAINS}/${key}`, { params: { version } })).json();
    expect(pub.status).toBe('published');
    expect(pub.body.nodes[0].model).toBe('gpt-4o-mini');
    const usage = await (await request.get(`${MODELS}/usage`)).json();
    const legacy = usage.models.find((m: any) => m.model === 'gpt-4o-mini');
    expect(legacy.steps.some((s: any) => s.brain_key === key && s.status === 'published')).toBe(true);
    expect(legacy.lifecycle_warning).toContain('gpt-6-luna');
  });
});
