import { expect, test } from '@playwright/test';

/**
 * The half of security a browser test usually misses.
 *
 * Hiding a control is not a permission. Every test here talks to the REAL API with
 * the session the browser holds, sends the payload a hidden control would have
 * sent — or one no control would ever send — and asserts the backend refuses on
 * its own.
 *
 * TWO MISTAKES THIS FILE MADE FIRST, BOTH WORTH KEEPING IN VIEW.
 *
 * 1. `playwright.request.newContext()` with no options INHERITS the project's
 *    `storageState`, so the "anonymous" request arrived carrying the admin session
 *    and came back 200. A security test that quietly authenticates itself passes
 *    forever and guards nothing.
 *
 * 2. The forged-payload tests POSTed to `/brains` and asserted `status >= 400`.
 *    The route is a PUT, so every one of them was reading 405 Method Not Allowed
 *    and calling it a refusal. An assertion that cannot tell "the contract refused
 *    this" from "that verb does not exist" is not testing the contract.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';

/** The real write route: upsert the open draft, `brain_key` in the body. */
const BRAINS = `${API}/api/v1/agent-flows/brains`;
/** The endpoint the builder's validity badge uses. */
const VALIDATE = `${API}/api/v1/agent-flows/validate`;

const anonState = { storageState: { cookies: [], origins: [] } };

test.describe('unauthenticated access @critical', () => {
  for (const path of ['/api/v1/agent-flows/brains',
                      '/api/v1/agent-flows/tools',
                      '/api/v1/agent-flows/nodes']) {
    test(`GET ${path} is refused without a session`, async ({ playwright }) => {
      const anon = await playwright.request.newContext(anonState);
      const res = await anon.get(`${API}${path}`);

      expect([401, 403, 404]).toContain(res.status());
      await anon.dispose();
    });
  }

  test('PUT /brains is refused without a session', async ({ playwright }) => {
    const anon = await playwright.request.newContext(anonState);
    const res = await anon.put(BRAINS, {
      data: { brain_key: 'e2e_anon', name: 'x', body: { nodes: [] } },
    });

    expect([401, 403, 404]).toContain(res.status());
    await anon.dispose();
  });
});

test.describe('the contract refuses a forged flow body @critical', () => {
  /** Validation says WHY, so these assert the reason, not just a 4xx. */
  async function validate(request: any, nodes: unknown[], answer = 'a') {
    const res = await request.post(VALIDATE, {
      data: { brain_key: 'e2e_probe', name: 'E2E probe',
              body: { nodes, answer_node: answer } },
    });
    expect(res.status(), await res.text()).toBe(200);
    return res.json();
  }

  test('a valid body is reported valid — so a refusal below means something',
    async ({ request }) => {
      // THE CONTROL CASE. Without it, every test below would pass on an endpoint
      // that refuses everything.
      const out = await validate(request, [
        { key: 'a', type: 'agent', prompt: 'Trả lời: {{question}}' },
      ]);

      expect(out.ok, JSON.stringify(out)).toBe(true);
    });

  test('an unknown node type is refused, and named', async ({ request }) => {
    const out = await validate(request, [
      { key: 'x', type: 'khong_co_loai_nay', prompt: 'x' },
    ], 'x');

    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.errors)).toContain('khong_co_loai_nay');
  });

  test('a ToolNode with no tool chosen is refused', async ({ request }) => {
    const out = await validate(request, [
      { key: 't', type: 'tool', tool: '', output_var: 'x',
        run_policy: 'every_turn', inputs: {} },
      { key: 'a', type: 'agent', prompt: 'x' },
    ]);

    expect(out.ok).toBe(false);
  });

  test('a ToolNode binding with braces in the variable name is refused',
    async ({ request }) => {
      // The obvious authoring mistake: copying `{{doanh_thu}}` out of a prompt.
      const out = await validate(request, [
        {
          key: 't', type: 'tool', tool: 'total_measure', output_var: 'x',
          run_policy: 'every_turn',
          inputs: { chart_id: { source: 'variable', ref: '{{chart}}' } },
        },
        { key: 'a', type: 'agent', prompt: 'x' },
      ]);

      expect(out.ok).toBe(false);
      expect(JSON.stringify(out.errors).toLowerCase()).toContain('ngoặc');
    });

  test('a variable binding with no variable named is refused', async ({ request }) => {
    const out = await validate(request, [
      {
        key: 't', type: 'tool', tool: 'total_measure', output_var: 'x',
        run_policy: 'every_turn',
        inputs: { chart_id: { source: 'variable', ref: '' } },
      },
      { key: 'a', type: 'agent', prompt: 'x' },
    ]);

    expect(out.ok).toBe(false);
  });

  test('a flow with no steps at all is refused', async ({ request }) => {
    const out = await validate(request, [], '');

    expect(out.ok).toBe(false);
  });
});

test.describe('the tool catalogue is a contract too @critical', () => {
  test('it ships no callable and no model-facing schema', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/agent-flows/tools`);
    expect(res.status()).toBe(200);
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain('"fn"');
    expect(text).not.toContain('input_schema');
    // What it DOES ship, because a ToolNode form has to render one row per
    // argument and an author cannot be asked to type the argument name.
    expect(text).toContain('"inputs"');
    expect(text).toContain('"risk"');
  });

  test('every tool has classified its risk', async ({ request }) => {
    const res = await request.get(`${API}/api/v1/agent-flows/tools`);
    const packs = (await res.json()).packs ?? [];
    const tools = packs.flatMap((p: any) => p?.tools ?? []);

    expect(tools.length, 'catalogue is empty').toBeGreaterThan(10);
    expect(tools.filter((t: any) => !t.risk || t.risk === 'unknown')
      .map((t: any) => t.name)).toEqual([]);
  });

  test('a withheld pack is shown as unavailable rather than hidden',
    async ({ request }) => {
      // An author who cannot find web search should learn the deployment has it
      // off, not conclude the feature never existed.
      const res = await request.get(`${API}/api/v1/agent-flows/tools`);
      const packs = (await res.json()).packs ?? [];
      const external = packs.find((p: any) => p.key === 'external');

      expect(external, 'the external pack is missing entirely').toBeTruthy();
      expect(external).toHaveProperty('available');
    });
});
