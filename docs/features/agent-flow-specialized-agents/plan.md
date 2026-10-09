# Agent Flow specialized agents — plan and results

## Guardrail scoping

`guardrail_check.py --plan ... --files contract.py roles.py handlers/agent.py
agent_runtime.py api.py editors/agent.tsx lib/agentFlows.ts` → **warn**.

- **Auth/permissions match:** a keyword hit on "roles". No auth owner file is
  involved.
- **Protected subsystems:** none.
- **Required gates:** `agent_flow_container`, `agent_flow_contract`,
  `agent_flow_credentials`, `agent_flow_evidence`, `agent_flow_replay`,
  `agent_flow_surface`, `tier1_oracles_execute` and `tsc`.

## Files and layers

| # | File | Change |
|---|---|---|
| 1 | services/agent_flows/roles.py (new) | Role profiles: the single source of each tool boundary |
| 2 | contract.py | `AgentNode.role`, `reads_from`; `tool_names()` bounded by role; `effective_grants()`; `role_grant_errors`, `role_dependency_problems`, `input_problems`; inputs satisfy the chart_id dependency |
| 3 | registry.py | Save: 422 for role grant errors. Publish: role and input problems are hard 409 |
| 4 | runtime/agent_runtime.py, handlers/agent.py | Skill and notes grants read through `effective_grants`; role charter in the system prompt; `reads_from` handoff; `previous` projected instead of head-sliced; handoff recorded in `capabilities.handoff` |
| 5 | runtime/executor.py | `handoff_input_missing` downgrades the run to `partial` |
| 6 | runtime/context.py | Fix: reduction no longer collapses a JSON result to its top-level scalars |
| 7 | tools/context.py, dispatch.py, handlers/data.py | Fix: a step's attachments are intersected with the run's scope |
| 8 | api.py | `GET /tools` also returns `roles` |
| 9 | frontend | Node Library role tiles, Role card, narrowed Tool Picker, "Reads results from", canvas badge and chip, trace handoff line, i18n (en/vi) |

## Defects found and fixed along the way (both predate this branch)

1. **Context collapse.** `_shrink_json` could only halve lists, and it looped on
   `[item, "… N more"]`. A Report Read of one-row KPI charts reached the answering
   step as `{"read_ok": true}`. Live: "no revenue data" beside 13,591,643.7.
   - Fix: trim long strings, prune raw payload before summaries, and halve entity
     lists last.
   - Locked by `test_a_read_of_one_row_charts_keeps_its_figures_when_reduced`.
2. **Confused deputy through a step.** `run_scope` removed a document the caller
   may not read, and the step's own attachment put it back (top-level runs had no
   ceiling).
   - Fix: dispatch records `run_scope_ceiling`, and `bounded_scope` intersects
     with it.
   - Locked by `test_a_caller_without_the_document_does_not_get_it_back_through_the_step`.

## Live evaluation (`backend/eval/run_specialist_flow_eval.py`)

**Setup:** Olist dashboard 67 with docs 26 and 30, gpt-4o-mini, 4 questions × 3
repeats per architecture. Ground truth comes from deterministic Tool steps.
Total spend: $0.08.

| Architecture | Correct | Failed | Partial | Unsupported-claim notices | LLM calls/q | Tool calls/q | Prompt tok/q | Median latency | $/q |
|---|---|---|---|---|---|---|---|---|---|
| A one custom agent (16 tools) | 8/12 | 1 | 1 | 1 | 2.3 | 1.8 | 6,910 | 7.2 s | 0.00115 |
| B specialist chain (5 roles, `reads_from`) | **11/12** | 0 | 1 | 1 | 8.6 | 6.2 | 22,300 | 22.1 s | 0.00376 |
| C coordinator + writer | 9/12 | 0 | 0 | 0 | 5.4 | 2.8 | 8,795 | 13.1 s | 0.00152 |
| D Report Read + Knowledge + writer | 3/12 | 0 | 0 | 0 | 1.0 | 11.5 | 1,495 | 5.9 s | 0.00029 |

Per question, correct runs out of 3:

| Question | A | B | C | D |
|---|---|---|---|---|
| Q1 lookup | 3 | 3 | 3 | 3 |
| Q2 rank + share | 3 | 3 | 3 | 0 |
| Q3 Docs definition + report figure | 0 | **3** | 0 | 0 |
| Q4 peak month + hedged explanation | 2 | 2 | 3 | 0 |

**Reading:**

- **Specialization pays off on compound questions.** Q3 needs both a document
  and a report figure. Only the chain answered it, because the Knowledge Reader
  and the Metric Analyst each did their part and the writer combined them.
- **For simple lookups it is pure overhead.** A single agent gets them at a third
  of the cost and latency.
- **The coordinator** (max 2 specialists) picked one specialist for Q3 and missed
  the figure. It suits questions that need exactly one specialty.
- **D is cheapest but cannot recover.** A deterministic read that picks the wrong
  4 of 12 charts leaves a tool-less writer nothing to work with. Use it when the
  charts are known in advance.

**Recommendation:** default to one agent. Reach for a specialist chain when a
question combines sources (Docs + data, or measure + diagnose).

## Browser and e2e

**Rig:** isolated Postgres copy (`appbi-afspec-db`), a backend container built
from this branch (:8137) and Next dev from this worktree (:3237). All runs used
`retries: 0`.

- `agent-flow-specialists.spec.ts`: 15/15 on two consecutive full runs. That is
  6 security, 1 authoring UI and 7 live (J1, J2/J4, J3, J6/J9, J8, J7, J12), plus
  setup. One earlier cold run failed J2 once, with no trace kept; it was not
  reproduced in 3 later runs (one J2-only, two full) and is recorded as an intermittent.
- **Existing Agent Flow specs:** 57/57 (builder, run inspector, open-in-builder,
  v1 author/reader golden, AI keys, security-forged, canvas a11y, pointer drag).
- **Existing flows:** all 333 stored versions parse. No pre-existing step changed
  its effective tools, and no pre-existing flow gained a new problem.
