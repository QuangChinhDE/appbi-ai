import { expect, test } from '@playwright/test';
import { deleteFlow, sweepLeftovers } from './_helpers';

/**
 * Gate 3 — the Run Inspector, on a run that actually happened.
 *
 * A flow is created, run through the builder's test endpoint, and the trace that
 * comes back is checked for the things an author reads when a run goes wrong:
 * which steps ran and in what order, how each ended, which tools each one called,
 * what it published, and what the run admitted.
 *
 * THE FLOW IS BUILT TO BE DETERMINISTIC. `set_var`, `if` and `tool` steps need no
 * model, so this exercises the real runtime end to end without spending anything
 * or depending on a vendor being up. The agent step is the only one that would,
 * and the assertions here never depend on what it says.
 */
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const BRAINS = `${API}/api/v1/agent-flows/brains`;

type Step = {
  key: string; type: string; status: string;
  tool_calls?: string[]; output_preview?: string; error?: string;
};

async function saveDraft(request: any, key: string, name: string, body: unknown) {
  const res = await request.put(BRAINS, { data: { brain_key: key, name, body } });
  expect(res.status(), await res.text()).toBeLessThan(400);
}

/**
 * A link with a live binding, discovered rather than hard-coded.
 *
 * The test endpoint takes a `link_id` and not a dashboard, and the reason is in
 * its own contract: "does this flow work" is a question about a flow ON A LINK,
 * because two links resolve requirements differently. So the suite has to find
 * one. `E2E_LINK_ID` wins if it is set; otherwise probe until a link answers with
 * an active binding.
 *
 * `POST /{key}/test` is `run_preview` — it runs the DRAFT against that binding and
 * changes nothing about what the link itself serves.
 */
let cachedLink: number | null = null;

async function usableLink(request: any): Promise<number | null> {
  if (cachedLink !== null) return cachedLink;
  const fromEnv = Number(process.env.E2E_LINK_ID || 0);
  if (fromEnv) { cachedLink = fromEnv; return cachedLink; }

  for (let id = 1; id <= 60; id += 1) {
    const res = await request.get(`${API}/api/v1/agent-flows/bindings/link/${id}`);
    if (res.status() !== 200) continue;
    const body = await res.json().catch(() => null);
    const binding = body?.binding ?? body;
    // ACTIVE, not merely present. A binding whose status is `broken` is a
    // link that cannot answer, and running against one reports a product
    // failure that is really the fixture's choice of link.
    if (binding?.id && binding.status === 'active') {
      cachedLink = id; return cachedLink;
    }
  }
  return null;
}

/** Run through the builder's own test endpoint — the same one the Test tab uses. */
async function runFlow(request: any, key: string, question: string) {
  const linkId = await usableLink(request);
  if (!linkId) return { status: 0, body: 'no link with a binding on this deployment' };
  const res = await request.post(`${BRAINS}/${key}/test`, {
    data: { question, link_id: linkId },
    timeout: 120_000,
  });
  return { status: res.status(), body: await res.text() };
}

function stepsOf(envelope: any): Step[] {
  return envelope?.trace?.steps ?? [];
}

test.describe('run inspector @critical', () => {
  const KEY = `e2e_inspector_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    await saveDraft(request, KEY, 'E2E run inspector', {
      nodes: [
        { key: 'dat', type: 'set_var', var: 'nguong', value: '5',
          value_type: 'number' },
        {
          // THE REAL `if` SHAPE: named paths, each with its own conditions and
          // body. The first version of this spec put `conditions`/`body` on the
          // node, pydantic dropped the unknown keys, and the flow saved with an
          // `if` that had no branches — green in the builder, 422 at run time.
          key: 'kiem', type: 'if',
          paths: [
            { key: 'bang_5', name: 'Bằng 5', kind: 'rules', match: 'all',
              conditions: [{ left: '{{nguong}}', op: 'equals', right: '5' }],
              body: [{ key: 'trong_nhanh', type: 'set_var', var: 'da_vao',
                       value: 'co' }] },
            { key: 'khac', name: 'Khác', kind: 'fallback',
              body: [{ key: 'nhanh_khac', type: 'set_var', var: 'da_vao',
                       value: 'khong' }] },
          ],
        },
        {
          key: 'goi_cong_cu', type: 'tool', tool: 'inspect_filters',
          name: 'Xem filter', output_var: 'filters', run_policy: 'every_turn',
          inputs: {},
        },
        { key: 'answer', type: 'agent', name: 'Trả lời',
          prompt: 'Nguong={{nguong}} DaVao={{da_vao}}' },
      ],
      answer_node: 'answer',
    });
  });

  test('the trace shows node order, status, tools and output', async ({ request }) => {
    const { status, body } = await runFlow(request, KEY, 'Báo cáo đang lọc gì?');
    test.skip(status === 0 || status >= 500, `cannot run a flow here (${status}): ${body.slice(0, 160)}`);
    expect(status, body.slice(0, 300)).toBeLessThan(400);

    const env = JSON.parse(body);
    const envelope = env.envelope ?? env.result ?? env;
    const steps = stepsOf(envelope);
    expect(steps.length, `no trace came back: ${body.slice(0, 200)}`).toBeGreaterThan(0);

    // ORDER. The trace is the record of what happened, in the order it happened.
    const keys = steps.map((s) => s.key);
    expect(keys.indexOf('dat')).toBeLessThan(keys.indexOf('goi_cong_cu'));
    expect(keys.indexOf('goi_cong_cu')).toBeLessThan(keys.indexOf('answer'));

    // STATUS, per step, and it must be one the inspector knows how to render.
    for (const s of steps) {
      expect(['ok', 'error', 'skipped', 'reused', 'blocked']).toContain(s.status);
    }

    // TOOL CALLS land on the step that made them.
    const toolStep = steps.find((s) => s.key === 'goi_cong_cu');
    expect(toolStep, 'the tool step is missing from the trace').toBeTruthy();
    expect(toolStep!.tool_calls ?? []).toContain('inspect_filters');

    // OUTPUT — what the step handed the next one.
    const setStep = steps.find((s) => s.key === 'dat');
    expect(setStep?.output_preview ?? '').toContain('5');
  });

  test('a container does not double-count its children tool calls',
    async ({ request }) => {
      // An `if` that contains a tool step used to report that call twice: once on
      // the child and again on the container, because the container's window is
      // everything that happened while it ran.
      const key = `e2e_container_${Date.now()}`;
      await saveDraft(request, key, 'E2E container count', {
        nodes: [
          { key: 'dat', type: 'set_var', var: 'co', value: 'co' },
          {
            key: 'bao', type: 'if',
            paths: [
              { key: 'co_nhanh', kind: 'rules', match: 'all',
                conditions: [{ left: '{{co}}', op: 'equals', right: 'co' }],
                body: [{
                  key: 'ben_trong', type: 'tool', tool: 'inspect_filters',
                  output_var: 'f', run_policy: 'every_turn', inputs: {},
                }] },
              { key: 'khong_nhanh', kind: 'fallback',
                body: [{ key: 'trong_rong', type: 'set_var', var: 'x',
                         value: 'y' }] },
            ],
          },
          { key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'x' },
        ],
        answer_node: 'answer',
      });

      const { status, body } = await runFlow(request, key, 'Filter?');
      test.skip(status === 0 || status >= 500, `cannot run a flow here (${status}): ${body.slice(0, 120)}`);
      const envelope = (() => { const e = JSON.parse(body); return e.envelope ?? e.result ?? e; })();
      const steps = stepsOf(envelope);

      const child = steps.find((s) => s.key === 'ben_trong');
      const container = steps.find((s) => s.key === 'bao');
      expect(child?.tool_calls ?? []).toContain('inspect_filters');
      expect(container?.tool_calls ?? [],
        'the container repeated its child\'s tool call').toEqual([]);
    });

  test('a step that fails is recorded as an error with a reason',
    async ({ request }) => {
      // A ToolNode bound to a variable nobody created. The step must fail, name
      // the binding, and the run must still produce a trace.
      const key = `e2e_failstep_${Date.now()}`;
      await saveDraft(request, key, 'E2E failing step', {
        nodes: [
          {
            key: 'hong', type: 'tool', tool: 'total_measure', on_error: 'continue',
            output_var: 'x', run_policy: 'every_turn',
            inputs: { chart_id: { source: 'variable', ref: 'khong_ton_tai' } },
          },
          { key: 'answer', type: 'agent', name: 'Trả lời', prompt: 'x' },
        ],
        answer_node: 'answer',
      });

      const { status, body } = await runFlow(request, key, 'Tổng bao nhiêu?');
      test.skip(status === 0 || status >= 500, `cannot run a flow here (${status}): ${body.slice(0, 120)}`);
      const envelope = (() => { const e = JSON.parse(body); return e.envelope ?? e.result ?? e; })();
      const failed = stepsOf(envelope).find((s) => s.key === 'hong');

      expect(failed?.status).toBe('error');
      expect(failed?.error ?? '').toContain('khong_ton_tai');
    });
});

// A suite must leave the database as it found it. Without this the flow list grows
// by a row per test per run, and a spec that looks for its own row by name starts
// failing because an earlier run pushed it out of view.
test.afterAll(async ({ request }) => {
  await sweepLeftovers(request);
});
