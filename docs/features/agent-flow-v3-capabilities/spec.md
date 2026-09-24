# Agent Flow V3 capabilities — spec

Behaviour once built. Terms are the code's terms; §0 is the concept map the docs adopt.

## 0. Concept map — who decides what

| Concept | Is | Who decides inside it |
|---|---|---|
| **Flow** | the author's architecture of decision-making: a tree of nodes (`contract.py:23-29`) | the author — sequence, branches, autonomy zones, grants, specialist pool |
| **Node** | an orchestration primitive | per type, below |
| ToolNode | "run exactly this capability" (`handlers/data.py:1072`) | author; no model |
| If / Switch / Loop / Filter | deterministic routing (`executor.py:701-751`) | author; no model (a `choice` agent may *feed* a Switch, enforced in code) |
| **Skill node** *(new)* | "run this reusable governed capability" | author chooses *that* it runs; the Skill's own flow decides *how* |
| **Agent** | an autonomy zone: goal + granted capabilities | the model, locally, within grants |
| **Coordinator** | bounded specialist selection (`executor.py:819-976`) | the model picks a subset of the author's roster, ≤ `max_specialists` |
| **Tool** | atomic capability in the registry (`tools/registry.py`) | — |
| **Skill** *(new)* | a published flow with a typed contract, invoked as a child run | — |
| **Capability** | what an Agent can be granted: a Tool or a Skill | — |
| **Strategy** *(new seam)* | how an Agent reasons: builds requests, reads replies, decides to continue | the strategy, pure, no I/O |
| **Runtime** | executes and enforces: provider, capability execution, budget, retry, trace, gates | the runtime; never the prompt |

Invariant **A (authority):** the model can never add, skip, reorder or replace a node.
Its only structural outputs are a `choice` value (validated against declared choices) and
a coordinator subset (scanned against the roster). Nothing in this spec adds a third.

Invariant **R (rules):** a capability executes only if `registry.execute()` (tools) or the
Skill invoker (skills) admits it against the grant, scope, capability flags, risk and
budget. The router, prompt and model have no say.

## 1. Evidence-bound compute — "AI creates the formula, runtime owns the result"

Today `compute(expression, vars, citations)` evaluates whatever numbers the model
supplies (`thinking/tools.py:759-801`).

New contract (additive fields; old calls still parse):

```
compute(
  expression: "(cur - prev) / prev * 100",
  vars:       {"cur": 10748221.5, "prev": 9120004},
  constants:  {"pct": 100}              # optional, declared as constants
)
```

Runtime, before evaluating:

1. Every value in `vars` must match a number already in the run's evidence ledger
   (`RunState.evidence`, `runtime/state.py:221`), using the **same matcher and tolerance
   the answer verifier uses** (`dashboard_ai_bot/verifier.py:_matches`, rel 0.005, ×/÷100
   percent forms). One matcher, not two.
2. A value that matches nothing → refused `unsourced_input`, **recoverable**, message
   names the variable and tells the model to read it from a tool first. The dead-retry
   policy already stops an identical re-send (`handlers/agent.py:253-278`).
3. `constants` are allowed only as small exact numbers (|x| ≤ 1000, e.g. 100, 12, 7) and
   are labelled `constant` in lineage — they cannot smuggle a business figure.
4. Result payload: `{expression, result, inputs:[{name, value, source_label, source_step}],
   constants}`. `source_label` comes from `evidence_labels`/`evidence_sources`
   (`state.py:171, 226`). The result enters the ledger as **derived** evidence with that
   lineage, so a later compute may use it and the verifier accepts it for the right reason.

The model decides *that* a ratio is needed and *which* established figures feed it; the
runtime refuses invented inputs and produces the number.

## 2. Capability shortlisting — Router shortlists, runtime authorizes

For an Agent whose granted capabilities (tools + skills) number **≤ 8**: unchanged — all
schemas every round. This keeps every existing starter and fixture byte-identical.

For **> 8**, each round the strategy asks the runtime for an *exposure set*:

1. **Deterministic filter** over the grant: drop capabilities that would be refused with
   certainty in this context — `reaches_outside` when `ctx.web_search` is false,
   `raw_rows` when `ctx.read_rows` is false, packs not available (`_pack_available`).
   (They stay *granted*; calling one still gets the same refusal as today.)
2. **Always-on core:** granted discover tools (`search_business_assets`,
   `resolve_chart_candidates`), `compute`, and `find_capability`.
3. **Intent shortlist:** lexical score of the question + last tool result against each
   capability's `label_vi/label_en/description/answers_vi/returns` with Vietnamese
   diacritic folding — the same haystack the builder picker already searches
   (`ToolPicker.tsx` `toolHaystack`), moved to one backend function the picker can call.
4. **Sticky:** a capability called earlier in this node stays exposed.
5. Cap at 8 full schemas.

`find_capability(query)` returns name + one line for matching *granted* capabilities; the
next round exposes their schemas. It cannot list or expose anything ungranted.

A model calling a granted capability that is not in the current exposure set is **allowed**
— the grant is the authority, the shortlist is a context optimisation. An ungranted call is
refused `not_granted` exactly as today (`registry.py:932`).

Trace: each agent step records `exposed: [...]` per round, so "why didn't it use X" is
answerable from Runs.

## 3. Skill — reusable governed flow capability

### Authoring

- Any flow can be marked **Skill** (`flow_type = "skill"`, alongside bot/chat,
  `models/agent_brain.py:115`). A Skill declares a contract in its body:
  `skill: {inputs: [{name, type: text|number|date|chart_ref, required, description}],
  output: {description}, when_to_use: "<≥ 12 chars, shown to agents>"}`.
- Inside, the Skill's nodes read inputs as `{{input.<name>}}`; its answering node's
  answer is the Skill's output. Nothing from the caller's context enters the Skill unless
  passed as an input (no implicit parent context).
- Publishing a Skill validates the contract and refuses an unreachable input reference.
  A Skill is edited, tested and versioned exactly like any flow.

### Using a Skill

- **Agent grant:** an Agent's `tools` grant list may include `skill:<brain_key>`. It
  appears to the model as a capability with the contract as its input schema and
  `when_to_use` as its description, subject to §2 shortlisting.
- **Skill node** (new node type `skill`): `{skill_key, inputs: ToolInput[] (typed,
  variable|literal — the ToolNode binding model, contract.py:827-859), output_var}`.
  Deterministic: no model decides whether it runs.
- **Coordinator lanes** may contain Skill nodes — a specialist can *be* a Skill.

### Version

A parent pins the Skill's published version at the parent's own publish (stored in the
parent version's body as `skill_version`). Republishing the Skill does not change a
published parent until the parent republishes; the builder shows "newer Skill version
available". Draft/test runs use the Skill's current published version.

### Execution — a real child FlowRun

`SkillInvoker` (a sibling of `registry.execute`, not a `ToolSpec.fn` — V3 §3.4):

1. **Cycle/depth:** refused at publish if the pinned Skill graph has a cycle or depth > 3;
   re-checked at run time (`skill_depth_exceeded`).
2. **Scope = intersection:** allowed charts = parent `allowed_chart_ids` ∩ Skill owner's
   current rights ∩ Skill attachments (`permissions.run_scope`, `permissions.py:131-189`,
   computed for the Skill owner, then intersected). `excluded_columns` = union.
   `read_rows` = parent ∧ Skill; `web_search` = parent ∧ Skill; `actor_type` = parent's.
   Never wider than the caller in any dimension.
3. **Grants:** the Skill's nodes keep their own grants; the effective set is additionally
   bounded by the parent context's flags (step 2). A Skill granting `web_search` called
   from a no-web link cannot reach the web.
4. **Budget:** the child runs on the **parent's `Budget` object** — every LLM/tool call
   and second is charged to the parent; a child cannot exceed what the parent has left.
   A per-invocation ceiling (default: half the parent's remaining tool calls) stops one
   Skill from starving the answer.
5. **Result:** the child's answer + its verified evidence numbers return to the parent as
   a capability result; child figures enter the parent ledger with source
   `skill:<key>@v<n>`. Child notices (e.g. `figures_unverified`) propagate.
6. **Persistence:** the child is its own `agent_flow_runs` row with `parent_run_id`,
   `parent_step_seq`, `trigger="skill"`; its steps are ordinary step rows. Runs lists
   only top-level runs; a parent step "Skill: X" expands to the child's steps.

## 4. Strategy / Runtime seam

`runtime/handlers/agent.py:run` is split, **moving code, not changing it**:

- `AgentRuntime` (runtime): `stream(request)` (provider + usage + timeout),
  `invoke(call)` (registry/Skill invoker + retry policy + dead-retry breaker + budget +
  evidence + trace), `exposure(node, round)` (§2), `verify_answer(...)` (the four
  `_retry_*` verifiers, which are runtime-owned correctness rules).
- `AgentStrategy` protocol: `build_request(ctx)`, `interpret(response)`,
  `on_result(call, result)`, `should_continue(ctx)`, `final_answer(ctx)`.
- `ToolCallingStrategy` = today's loop. Selected by default; `AgentNode.strategy`
  (optional, default `"tool_calling"`) is the only new field, and only that value exists.

Rule (tested): nothing under `runtime/strategies/` imports a provider module or
`tools.registry.execute`.

## 5. Coordinator — bounded

- A Coordinate inside a coordinate lane is refused at save (`nested_coordinator`).
- Preflight cost counts planner + `max_specialists` lanes.
- Unchanged: sequential lanes, roster-scanned picks, shared budget, `no_specialist_picked`.

## 6. Governance fixes

| Gap | Fix |
|---|---|
| `risk="unknown"` never enforced | `registry.execute` refuses `risk_unknown`; a test asserts all 36 tools declare a known risk |
| `uses_capability("web_search")` misses 2 tools | derive the set from `reaches_outside` in the registry, not a hand list |
| ToolNode name not checked at publish | `blocking_problems()` reports an unknown tool / unknown Skill |
| nested Coordinate | §5 |
| coordinator preflight cost | §5 |

## Data

Additive migration, one head:

- `agent_flow_runs.parent_run_id` (FK → `agent_flow_runs.id`, nullable, indexed),
  `parent_step_seq` (int, nullable). Existing rows: NULL = top-level (their meaning today).
- `flow_type` gains the value `skill` (string column; no enum change needed — verify at
  implementation; if it is a DB enum, add the value additively).
- Flow body JSON: optional `skill` contract block; `AgentNode.strategy` optional; new
  `skill` node type. Old bodies parse unchanged (`extra="ignore"`, strict authoring only
  rejects unknown fields on *new* saves).

## API

| Method | Path | Auth | Change |
|---|---|---|---|
| GET | `/agent-flows/skills` | agent_flows view | published Skills the caller may attach: key, name, contract, version |
| GET | `/agent-flows/capabilities/search?q=` | agent_flows view | the router's scoring, for the builder picker (one scorer) |
| GET | `/agent-flows/runs/{id}` | existing gate | response gains `children: [...]` |
| PUT | `/agent-flows/brains` | existing | accepts `flow_type="skill"` + contract; publish refuses cycles |

Errors: `skill_cycle`, `skill_depth_exceeded`, `skill_not_found`, `skill_contract_invalid`,
`unsourced_input`, `risk_unknown`, `nested_coordinator` — each with a Vietnamese
author-facing message following `test_builder_error_messages.py`.

## UI

- **Capability picker** (Agent inspector): groups *Skills · Dữ liệu & báo cáo · Phân tích ·
  Tri thức · Bên ngoài*, mapped from packs (discover/read → data; measure/compare/
  diagnose/project → analysis; knowledge; external). Skills listed first with
  `when_to_use`. Search uses the backend scorer. Loading/empty/error states follow
  `ToolPicker` as it is.
- **Skill settings:** flow settings gain "Dùng như Skill" with the contract editor (inputs
  list + output description + when-to-use).
- **Skill node** in the palette under AI → "Skill".
- **Runs:** a Skill step expands into the child run's steps; the child's version shown.
- **What the AI sees:** shows the round-1 exposure set and marks shortlisted vs granted.
- Public reader surfaces: **no change**.

## Permissions

Builder endpoints keep the `agent_flows` module gates. Attaching a Skill requires `view`
on that Skill flow (share-to-attach, as knowledge attachments do today). At run time the
Skill is bounded by §3 intersection — attaching grants no data access.

## Edge cases

- Skill deleted/unpublished after a parent pinned it → parent run: capability refused
  `skill_not_found`, honest limitation, no crash; publish of the parent warns.
- Skill owner loses rights → intersection shrinks at run time (rights are read at run
  time, never snapshotted).
- Skill invoked with a missing required input → refused before the child starts.
- compute with every input sourced but a divide-by-zero → existing safe-eval error.
- Agent granted 60 capabilities, question matches none → core set only, model can
  `find_capability`.
- Two Skills with the same `when_to_use` → both shortlisted; model chooses; both granted.

## Non-goals

Parallel lanes; a planner strategy; Skills calling external HTTP/MCP; auto-generated
Skills; editing a Skill from inside the parent canvas (it opens in its own builder tab).
