# Agent Flow V3 capabilities — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --plan "Agent Flow V3: evidence-bound compute, AgentRuntime/Strategy split, capability shortlist router, Skill = published flow invoked as governed child run, bounded coordinator" --files <agent.py executor.py tools/registry.py contract.py registry.py permissions.py runs.py models/agent_flow_run.py thinking/tools.py ToolPicker.tsx>
```

- Verdict: **warn** (plan) — run the named suites. `unknown` on the model/migration file
  pair: no rule covers `agent_flow_run.py` + a new column → handled with the
  migration-checker agent and the alembic chain gate.
- Feature touched: *Agent Flow Studio (authoring + runtime + node model)*.
- Protected subsystems: **none directly** (not the semantic layer, not `api/public.py`).
  Public reader behaviour is unchanged by design; the public-link suites still run.
- Required: `agent_flow_container`, `agent_flow_contract`, `agent_flow_evidence`,
  `agent_flow_replay`, `agent_flow_surface`, `tier1_oracles_execute`.

## Sequence — seven PR-sized phases, each green on its own

Order is dependency + risk: fix promises first, move code before adding behaviour behind
it, add the Skill last because it depends on all of it.

| # | Phase | Files (layer) | Behaviour change |
|---|---|---|---|
| **1** | Governance gaps (spec §6) | `tools/registry.py` (risk refusal), `contract.py` (`uses_capability` from registry; nested coordinator; unknown tool in `blocking_problems`), `binding.py` (coordinator cost) — services | deliberate, small, each tested |
| **2** | Strategy / Runtime seam (spec §4) | new `runtime/agent_runtime.py`, `runtime/strategies/{__init__,tool_calling}.py`; `handlers/agent.py` becomes composition — services | **none**: canonical replay is the only acceptance criterion; any diff ⇒ revert, not "fix to match" |
| **3** | Evidence-bound compute (spec §1) | `tools/packs/measure.py` → `local()` compute on the new contract using `verifier._matches`; `runtime/state.py` derived-evidence lineage — services | deliberate: unsourced inputs refused |
| **4** | Capability shortlisting (spec §2) | new `tools/capability_router.py`; `find_capability` tool (discover pack); `AgentRuntime.exposure`; `/capabilities/search` endpoint; `ToolPicker.tsx` uses it | none for ≤ 8 grants (replay proves); > 8 → shortlist |
| **5** | Skill backend (spec §3) | migration `parent_run_id/parent_step_seq`; `contract.py` (`skill` contract, `SkillNode`, `skill:` grants); new `skills/invoker.py`; `permissions.py` (intersection helper); `registry.py` (publish-time cycle/depth + version pin); `runs.py`/`history.py` (child runs); `api.py` (`/skills`) — models + services + api | new capability; existing flows unaffected |
| **6** | Builder + Runs UX (spec UI) | `ToolPicker.tsx` grouping + Skills; flow settings contract editor; Skill node editor; `RunsTab.tsx` child expansion; `WhatTheAiSees.tsx` exposure; i18n `agent-flows.ts` VI/EN; `check-node-topology.mjs` learns `skill` — frontend | UI |
| **7** | Docs + eval | V3 architecture doc: concept map, status per phase; migration-plan status; eval scenarios | — |

No row crosses a boundary improperly: models gain columns only; new logic lives in
`services/agent_flows/**`; `api.py` only wires endpoints; the public surface is untouched.

## Risks

| Risk | Would show up as | Caught by |
|---|---|---|
| Phase 2 changes behaviour while "only moving code" | a replay snapshot diff | `test_agent_flow_replay.py` (16 fixtures) — hard stop |
| compute refusal breaks a real flow | answers that used to compute now refuse | no fixture or recorded run uses compute (checked: 0 of all local run steps); new test covers the recovery path (model reads the figure, retries, succeeds) |
| Router hides the right tool | wrong/absent tool on a >8-grant agent | router test set (≥ 15 VI/EN questions → expected tool in shortlist); `find_capability` fallback; granted calls still allowed |
| Skill widens access | child reads a chart the parent could not | permission-intersection tests per dimension (charts, columns, rows, web, actor) written **before** the invoker |
| Skill recursion / budget starvation | runaway run, answer node out of budget | publish-time cycle test, runtime depth test, shared-budget + per-invocation-ceiling tests |
| Child runs pollute Runs/funnel | inflated run counts | Runs + `pilot_funnel.sql` filter `parent_run_id IS NULL`; test |
| Migration on a DB with data | crash-loop | additive nullable columns only; migration-checker agent; single head |
| New node type drifts FE/BE | builder cannot render `skill` | `check-node-topology.mjs`, `nodes.py` import-time registry guard (`nodes.py:71-89`) |

## Tests — decided now

| Test | New/existing | Locks |
|---|---|---|
| `test_agent_flow_replay.py` | existing | phases 2 & 4: zero change for existing flows |
| `test_governance_promises_are_kept.py` | new | risk_unknown refused; web set derived from `reaches_outside`; unknown ToolNode tool blocks publish; nested coordinator refused; coordinator cost counted |
| `test_strategy_is_pure.py` | new | no strategy module imports providers or `registry.execute`; default strategy = tool_calling |
| `test_compute_owns_the_number.py` | new | unsourced var refused (recoverable); sourced var → result + lineage; constants bounded; derived result accepted by verifier; chained compute; percent-form match |
| `test_capability_shortlist.py` | new | ≤8 unchanged; >8 capped at 8 + core; web/raw-row pruned only when context forbids; sticky; `find_capability` never lists ungranted; ungranted call still `not_granted`; granted-unexposed call allowed; prompt size with 36 grants ≤ 50% of today; VI/EN intent set hits expected tool |
| `test_skill_permission_intersection.py` | new | parent {A,B} ∩ skill {B,C} ⇒ B only, per charts/columns/raw rows/web/actor; owner-rights read at run time |
| `test_skill_graph.py` | new | A→B→A refused at publish; depth 4 refused; pinned version used; deleted Skill → `skill_not_found` honest refusal |
| `test_skill_execution.py` | new | Agent → Skill → child run: result + `parent_run_id` + child steps; Skill node deterministic (no LLM spend); inputs only explicit; shared budget; per-invocation ceiling; child notices propagate; child figures carry `skill:` source |
| `test_skill_runs_visibility.py` | new | Runs list excludes children; run detail includes them; funnel counts top-level only |
| `test_tool_capability_gates.py`, `test_tool_authorization_metadata.py`, `test_tool_node.py`, `test_report_read_scope.py`, `test_i5_hard_gate_stays_lowest.py` | existing | hard gates stay in registry/data layer (V3 invariant 11) |
| replay fixtures `17_skill_node.json`, `18_agent_calls_skill.json`, `19_compute_lineage.json` | new | canonical behaviour of the new paths |
| author golden E2E: publish a flow as Skill, attach it to an agent, test, see child steps in Runs | new | the user-visible journey |
| `check-node-topology.mjs` / `check-starter-grants.mjs` | existing, extended | FE/BE node parity incl. `skill`; starter unchanged |

Every new backend test: `.gitignore` allow-list + `backend-contract-tests.yml` +
`git add -f` (verify.py checks).

## Verification

Per phase: targeted tests → `verify.py task` → replay. At the end, on a rebuilt stack:
build a Skill "So sánh hai kỳ" from report-read + agent(compare_periods, compute), publish
it, grant it to a Business-Analyst agent in a new flow alongside 20 tools, ask a period
comparison on the Olist report, and confirm in Runs: exposure set ≤ 8, the Skill chosen,
the child run's steps, the compute lineage, a verified answer. Then the same through a
no-web link to prove intersection. Full E2E both modes; Live Agent Eval only against a
deployment serving the exact SHA.

## Rollback

Phases 1–4 have no schema change: revert the commit. Phase 5 adds two nullable columns;
`downgrade()` drops them and is tested before merge. Flows saved as `skill` or containing a
`skill` node would fail validation after a code rollback — the rollback note says to
unpublish Skills first; nothing else in existing data changes meaning.

## Not built, and why

- **Parallel specialists / planner strategy** — the seam in phase 2 makes them possible;
  building them now is speculative (V3 §6: "Planner/Multi-Agent trước khi AgentStrategy ổn định").
- **Runtime Layer Stack (V3.3)** — nothing here needs it; it stays in its own phase.
- **Checkpoint/HITL, MCP/HTTP** — separate phases with their own risks.
- **Embedding-based routing** — lexical + deterministic filtering reaches the goal without
  a new model dependency in the hot path; revisit with pilot evidence.

## Revision 2 — after approval (2026-09-25)

Approved, with these changes folded into `spec.md`:

- **Compute provenance is by structured reference** (`{ref, path}` into the run's evidence
  store), not by value matching. Literals in the expression are allowed at any magnitude;
  a bare number passed as a variable is computed with but never certified.
- **Visibility vs authority.** The router controls visibility only; the model may invoke
  only capabilities visible this turn or discovered via `find_capability`
  (`capability_not_visible` otherwise). The limit is policy, not a constant — default 40 after live A/B evidence (see architecture doc §0).
- **Skill authority** = caller authority ∩ parent grant ∩ Skill declared contract ∩
  runtime policy. The Skill owner's rights are never a runtime source.
- **Pinning** is to an immutable exact Skill version; cycles are detected on flow-version
  ancestry; Skill call depth is a separate limit from flow tree nesting.
- **One invocation primitive** for Agent capability, Skill node and coordinator lane.
- **Trace hierarchy** made explicit: `parent_run_id`, `parent_step_seq`, `invoked_as` on
  the child run; `capability_trace` on the step.
- **Governance fixes derive from registry metadata** — no parallel hand lists.

**Base branch.** V3 touches the same files PR #3 changes (`handlers/agent.py`,
`contract.py`, `BrainBuilder.tsx`, `RunsTab.tsx`, `api/public.py` neighbours), so it is
built on the PR #3 head `428f8355`, not on `demo`. When #3 merges, this branch's base is
already in `demo`; its PR then targets `demo` with only V3 commits in the diff.

**Eval.** Deterministic invariants are hard CI gates (the tests above). Model-quality
behaviour — capability selection, discovery recovery, formula provenance, exposed schemas
per turn, calls, tokens, specialist count, budget accounting, trace completeness — is a
scripted eval (`backend/scripts/agent_flow_v3_eval.py`) reporting metrics, run against a
live stack, not a CI gate.

## Revision 4 — closing the remaining gaps (2026-09-25)

The V3 report listed limitations that are themselves DoD items. This revision closes them;
"the class exists" is not accepted as done for any of them — each has a behavioural test
and, where only a model can show it, a live eval arm.

| Gap (as-built §0) | Closed by | Proven by |
|---|---|---|
| Default visibility 40 = everything shown; `find_capability` never used live | **Tiered view**: full schemas only for core ∪ question-ranked ∪ loaded (default 8); a bounded catalogue (≤30 `name — purpose` lines) inside `find_capability`'s own description; `find_capability(need, names)` loads by intent or by listed name; an unshown eligible call is refused *and* loaded; ≤3 discoveries per step | deterministic router eval over labelled VI/EN intents on the real registry (+200 synthetic distractors: recall and schema size stay flat); live A/B/C: full vs routed vs stress (limit 4) |
| Top-level run can spend its last model call on tools | **Budget reserve by structure**: before each node the executor reserves the minimum model calls the rest of the flow needs; a step's last available call offers no tools; post-answer corrections honour the reserve; per-step budget ledger in the trace | small-budget tests: BA→Skill→Answer on the minimum budget still answers; child, lane and discovery cannot touch the reserve |
| Language reminder appended after the loop (dead) | **Instruction lifecycle**: each injected instruction has a declared phase (system / after-tools / final-round / correction); the strategy places it on the round it governs; corrections go through the runtime (deadline, reserve, usage) | recorded-provider test asserting which instruction each round actually received |
| Revoked/unshared Skill still runs from a pin | **Skill lifecycle** per version: active / deprecated / disabled (+reason, actor, time); disabled refuses at invocation with the reason; deprecated runs with a notice and cannot be newly pinned; sharing re-checked against the parent owner at invocation; typed output (`text` / `number` with provenance) validated | lifecycle tests incl. pinned parent + disabled version, unshare after publish, malformed typed output; migration up/down/up |
| `compute` has no declared output contract; unusable from a ToolNode | typed `output_schema` verified in CI against real results (compute is pure); `{step, path}` variables so a deterministic ToolNode can compute over an earlier step | schema validated on every result shape; ToolNode→compute→Skill number chain |

Schema: one additive migration (`agent_brain_versions.lifecycle*`, `agent_flow_run_steps.budget`).
