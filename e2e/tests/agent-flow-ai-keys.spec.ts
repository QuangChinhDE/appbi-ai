import { expect, test } from '@playwright/test';
import { API, BRAINS, deleteFlow, openFlowList, saveDraft } from './_helpers';

/**
 * AI Keys: an author keeps provider keys in one place and every model step picks
 * one — and runs on nothing else.
 *
 * The secret used here is fake on purpose. Nothing in this spec calls a model:
 * it proves the key is stored, never echoed, picked by a step, survives save and
 * reload, and that a step without one is refused by name — all without spending.
 */
const CREDENTIALS = `${API}/api/v1/agent-flows/credentials`;
const FAKE = `sk-e2e-fake-${Date.now()}-not-a-real-key-0000`;

async function removeKeys(request: any, prefix: string) {
  const res = await request.get(CREDENTIALS);
  if (res.status() !== 200) return;
  for (const k of (await res.json()).credentials ?? []) {
    if (String(k.name || '').startsWith(prefix)) await request.delete(`${CREDENTIALS}/${k.id}`).catch(() => {});
  }
}

test.describe('Agent Flow AI Keys', () => {
  const prefix = `e2e key ${Date.now()}`;
  const flowKey = `e2e_ai_keys_${Date.now()}`;

  test.afterAll(async ({ request }) => {
    await deleteFlow(request, flowKey);
    await removeKeys(request, 'e2e key');
  });

  test('a key is stored once, never echoed, and a step references it by id', async ({ request }) => {
    const created = await request.post(CREDENTIALS, {
      data: { name: `${prefix} api`, provider: 'openai', secret: FAKE },
    });
    expect(created.status(), await created.text()).toBe(201);
    const body = await created.text();
    expect(body).not.toContain(FAKE);
    expect(body).not.toContain('_enc:');
    const key = JSON.parse(body);
    expect(key.key_hint).toBe(FAKE.slice(-4));

    const listed = await request.get(CREDENTIALS);
    expect(await listed.text()).not.toContain(FAKE);

    const saved = await request.put(BRAINS, {
      data: {
        brain_key: flowKey, name: 'E2E AI keys',
        body: {
          nodes: [{ key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'Trả lời.',
            provider: 'openai', model: 'gpt-4o-mini', credential_id: key.id }],
          answer_node: 'answer',
        },
      },
    });
    expect(saved.status(), await saved.text()).toBeLessThan(400);
    const detail = await (await request.get(`${BRAINS}/${flowKey}`)).json();
    const node = detail.body.nodes[0];
    expect(node.credential_id).toBe(key.id);
    expect(JSON.stringify(detail)).not.toContain(FAKE);
    expect(node).not.toHaveProperty('api_key_enc');

    // A step of one vendor cannot be given another vendor's key.
    const gemini = await (await request.post(CREDENTIALS, {
      data: { name: `${prefix} gemini`, provider: 'gemini', secret: 'AIzaE2EFAKEFAKEFAKEFAKEFAKE0000' },
    })).json();
    const wrong = await request.put(BRAINS, {
      data: {
        brain_key: flowKey, name: 'E2E AI keys',
        body: { nodes: [{ ...node, credential_id: gemini.id }], answer_node: 'answer' },
      },
    });
    expect(wrong.status()).toBe(422);
  });

  test('a step with no key is refused before anything runs', async ({ request }) => {
    const keyless = `${flowKey}_nokey`;
    await saveDraft(request, keyless, 'E2E keyless',
      { nodes: [{ key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'x' }], answer_node: 'answer' },
      'chat');
    const run = await request.post(`${BRAINS}/${keyless}/test-as-chat`, { data: { question: 'xin chào' } });
    expect(run.status()).toBe(409);
    expect(await run.text()).toContain('chưa có AI key');
    await deleteFlow(request, keyless);
  });

  test('the manager adds a key and a step picks it, surviving save and reload', async ({ page, request }) => {
    await openFlowList(page);
    // The page has loaded who I am (and so may add a key) once "New flow" shows.
    await expect(page.getByTestId('new-flow')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('ai-keys-open').first().click();
    const modal = page.getByTestId('ai-keys-modal');
    await expect(modal).toBeVisible();
    await modal.getByTestId('ai-key-add').click();
    await modal.getByTestId('ai-key-provider').selectOption('openai');
    await modal.getByTestId('ai-key-name').fill(`${prefix} ui`);
    await modal.getByTestId('ai-key-secret').fill(FAKE);
    await modal.getByTestId('ai-key-save').click();
    const row = modal.locator(`[data-testid="ai-key-row"][data-key-name="${prefix} ui"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`••••${FAKE.slice(-4)}`);
    await expect(modal).not.toContainText(FAKE);
    await page.keyboard.press('Escape');

    const uiKey = ((await (await request.get(CREDENTIALS)).json()).credentials as any[])
      .find((k) => k.name === `${prefix} ui`);
    expect(uiKey).toBeTruthy();

    // A keyless flow: the builder says so, and picking the key fixes it.
    await request.put(BRAINS, {
      data: {
        brain_key: flowKey, name: 'E2E AI keys',
        body: { nodes: [{ key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'Trả lời.',
          provider: 'openai', model: 'gpt-4o-mini' }], answer_node: 'answer' },
      },
    });
    await page.goto(`/agent-flows?flow=${flowKey}`);
    const chip = page.getByTestId('builder-keyless');
    await expect(chip).toBeVisible();
    // The author has a default OpenAI key, so the one-click assignment is offered.
    await expect(page.getByTestId('builder-assign-default-keys')).toBeVisible();
    await chip.click();
    const picker = page.getByTestId('agent-model-picker');
    await expect(picker).toBeVisible();
    await picker.getByTestId('agent-model-picker-key-select').selectOption(String(uiKey.id));
    await expect(page.getByTestId('agent-model-picker-key')).toContainText(`${prefix} ui`);
    await expect(chip).toBeHidden();
    // Wait for the WRITE, not for the button: it disables the moment saving
    // starts, which is before the PUT has landed.
    const saved = page.waitForResponse((r) => r.url().includes('/agent-flows/brains')
      && r.request().method() === 'PUT', { timeout: 30_000 });
    await page.getByTestId('builder-save').click();
    expect((await saved).status()).toBeLessThan(400);

    const detail = await (await request.get(`${BRAINS}/${flowKey}`)).json();
    expect(detail.body.nodes[0].credential_id).toBe(uiKey.id);

    await page.reload();
    await page.getByText('Trả lời').first().click();
    await expect(page.getByTestId('agent-model-picker-key')).toContainText(`${prefix} ui`);
  });
});
