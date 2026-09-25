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

## 1. Evidence-bound compute — "AI writes the formula, runtime owns the result"

*(Revision 2: provenance is by structured reference, not by value matching. Value
matching cannot tell `Revenue 2025 = 100` from `Target = 100`.)*

**Evidence references.** Every capability result the runtime harvests is registered in
the run's evidence store under a stable id (`e1`, `e2`, ... in run order) and the model is
shown that id with the result (`"evidence_ref": "e3"`). The store keeps the result object
the runtime produced, not a copy the model can edit.

**Canonical call:**

```
compute(
  expression: "(cur - prev) / prev * 100",
  vars: {
    "cur":  {"ref": "e3", "path": "rows[0].revenue"},
    "prev": {"ref": "e5", "path": "value"}
  }
)
```

Runtime:

1. Resolves each reference against the store: missing ref -> `evidence_ref_unknown`;
   path absent -> `evidence_path_missing`; value not a finite number (string, null,
   bool, list) -> `evidence_not_numeric`. All recoverable, with a message naming the
   variable and the shape it found.
2. Parses `expression` with the existing AST whitelist (`thinking/tools.py:_safe_eval`):
   numbers, names, `+ - * / % ** //`, unary +/-, parentheses; plus `abs`, `min`, `max`,
   `round`. No attribute access, other calls, comprehensions or subscripts. Every name
   must be a declared variable. Complexity bounded (<= 200 AST nodes, `**` exponent
   <= 12, finite result); divide-by-zero -> `compute_invalid`.
3. Numeric literals in the expression are **explicit mathematical literals** of any
   value (100, 365, 1e6 ...), allowed, and recorded in lineage as `literals`.
4. Returns `{expression, result, inputs:[{name, value, ref, path, source}], literals}`,
   where `source` is the producing step/tool. The result is itself registered as new
   evidence (`e7`) with this lineage, so it can feed a later compute.

**What the verifier may certify.** A compute result enters the trusted figure ledger only
when every variable is a reference. Literals are allowed and never make a formula fail.
A **bare number passed as a variable** (compatibility path: `"cur": 10748221.5`) is
computed with, lineage marks it `unreferenced`, and the result is registered as evidence
**without** entering the trusted ledger, so an answer quoting it gets the existing
`figures_unverified` notice. An invented input can be computed with, never certified.

## 2. Capability discovery — visibility is the router's, authority is the registry's

*(Revision 2: the model invokes only what the current turn has exposed or discovered;
the limit is policy, not an architectural constant.)*

Per agent round the runtime builds the capability view:

```
granted    node grants (tools + skills)
eligible   granted AND runtime eligibility: pack available; not `reaches_outside` when
           ctx.web_search is false; not `raw_rows` when ctx.read_rows is false; risk
           admissible; Skill resolvable at its version and admissible in this context
visible    all eligible, if |eligible| <= limit; otherwise
           core (granted discover tools, compute, find_capability)
           + sticky (discovered or invoked earlier in this node)
           + top-ranked by intent, up to `limit`
```

`limit` = `AgentNode.visible_capabilities` or the runtime policy default
(`AGENT_FLOW_VISIBLE_CAPABILITIES`, default 8). Ranking is lexical over the question and
the latest result against each capability's `label_vi/label_en/description/answers_vi/
returns`, with Vietnamese diacritic folding: one scorer, also served to the builder picker.

`find_capability(query)` searches **eligible** capabilities only, returns name + one line
+ why it matched, and adds them to `sticky`, so their full schema is exposed on the next
round. It never lists a capability that is ungranted, ineligible, out of scope, or a Skill
the caller cannot resolve.

Invocation:

- visible -> normal execution; `registry.execute()` / the Skill invoker re-checks grant,
  scope, capability flags, risk and budget. Nothing is trusted from the view.
- granted but not visible this round -> refused `capability_not_visible`, recoverable:
  "call find_capability first".
- ungranted -> `not_granted`, exactly as today.

When `|eligible| <= limit` every eligible capability is visible, which is every existing
starter and fixture, so their behaviour is unchanged.

Trace, per agent step: `granted`, `eligible` (with the reason each excluded capability was
dropped), `visible` per round, `discovered`, `invoked`, `rejected` (+ code). This is the
data behind "What the AI sees".

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
  `when_to_use` as its description, subject to §2 discovery.
- **Skill node** (new node type `skill`): `{skill_key, inputs: ToolInput[] (typed,
  variable|literal — the ToolNode binding model, contract.py:827-859), output_var}`.
  Deterministic: no model decides whether it runs.
- **Coordinator lanes** may contain Skill nodes — a specialist can *be* a Skill.

### Version

*(Revision 2.)* A published parent references an **immutable exact Skill version**. At the
parent's publish the runtime resolves each `skill:<key>` grant and Skill node to the
Skill's current published version and stores it in the parent version's body. Publishing
Skill v2 does not change a parent pinned to v1; the builder shows that a newer version
exists and the author republishes the parent to adopt it. Draft and test runs resolve the
Skill's latest published version and say so in the trace.

### Execution — one canonical invocation primitive

Agent capability, Skill node and coordinator lane all call the same `invoke_skill(...)`:

```
validate inputs against the contract
-> resolve version (pinned; latest published only for draft/test)
-> ancestry check: (skill_key, version) not already on the call stack; stack depth <= 3
-> authority = parent context AND Skill declared contract
-> child run on the parent's budget
-> execute the Skill flow with its inputs only
-> validate output
-> return result + child run reference
```

**Depth vs nesting.** Flow tree nesting (`MAX_DEPTH=4`, `contract.py:98`) is structure
inside one flow. Skill depth is the runtime call stack of child runs. They are separate
limits. Skill depth defaults to 3 and is checked on the ancestry of **flow versions**
(`A@v7 -> B@v3 -> C@v2 -> A@v7` is refused), both at publish over the pinned graph and at
run time.

**Authority: a Skill never runs on its owner's ambient rights.**

```
effective authority = caller authority        (the parent run's context:
                                               run_scope AND link AND binding, as today)
                    AND parent node grant      (the grant that lets it call the Skill)
                    AND Skill declared contract (its nodes' grants, its declared resources)
                    AND runtime policy          (read_rows, web_search, actor_type)
```

Concretely: allowed charts = parent `allowed_chart_ids` AND the Skill's declared chart
dependencies (none declared -> the parent's charts); `excluded_columns` = union; knowledge
scope = parent scope AND Skill-declared documents; `read_rows` and `web_search` = parent
AND Skill; actor = parent's. The Skill owner's permissions matter only at authoring and
publish (an owner may declare only resources they can access). They are never a runtime
source: a resource the Skill author can see is not thereby visible to a caller.

**Budget.** The child runs on the parent's `Budget` object: every model call, tool call and
second counts against the parent; token and cost totals roll up into the parent run. A
Skill cannot reset any limit. *(Revision 3, measured live: "half" starved the Skill.)* The child may use everything the parent has left except the parent's answer round (1 model call) and its answering tool reserve. (Previously: a per-invocation ceiling of half the parent's remaining
tool calls) keeps one Skill from starving the answering node. Coordinator lanes already
share the run budget (`executor.py:893, 969`).

**Result.** The Skill's answer is validated against its output contract. Its trusted
figures enter the parent's trusted ledger with source `skill:<key>@v<n>`; its results are
registered under new parent evidence refs; its notices propagate.

**Trace.** The child is its own `agent_flow_runs` row with `parent_run_id`,
`parent_step_seq`, `invoked_as` (`agent_capability | skill_node | coordinator_lane`) and its
own `brain_key`/`version`, the exact Skill version. The parent's step records the child run
id. Runs lists top-level runs; opening one shows:

```
FlowRun
  step (node execution)
    agent rounds: capability view, invocations
      tool call            -- or --
      Skill -> child FlowRun -> its steps
```

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

## 6. Governance fixes — one source of truth each

| Gap | Fix at the root |
|---|---|
| `risk="unknown"` never enforced | inventory first (all 36 built-ins declare `read_only` today); `registry.execute` refuses `risk_unknown`; the rule lives in one function the router's eligibility also uses |
| web capability list misses 2 tools | `Flow.uses_capability` derives from registry metadata (`reaches_outside`, `data_exposure`); the hand list is deleted |
| ToolNode tool not validated at publish | `blocking_problems()` resolves ToolNode / Skill node / `skill:` grants through the registry and the Skill resolver |
| nested Coordinator | refused anywhere below a Coordinate lane, over the whole subtree |
| coordinator preflight cost | `estimate_cost` walks the canonical tree (`child_node_lists`) instead of its own traversal |

## Data

Additive migration, single head:

- `agent_flow_runs`: `parent_run_id` (FK -> `agent_flow_runs.id`, nullable, indexed),
  `parent_step_seq` (int, nullable), `invoked_as` (String(24), nullable). Existing rows:
  NULL = top-level, which is what they are.
- `agent_flow_run_steps`: `capability_trace` (JSONB, nullable): the per-step view of §2
  and child-run references.
- `agent_brains.flow_type` is `String(8)` (`models/agent_brain.py:115`): `"skill"` fits,
  no type change.
- Flow body JSON: optional `skill` contract; optional `AgentNode.strategy`,
  `AgentNode.visible_capabilities`; `skill:<key>` grants; new `skill` node type; pinned
  Skill versions. Old bodies parse unchanged.

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

Builder endpoints keep the `agent_flows` module gates. Attaching a Skill requires `view` on
that Skill flow. Attaching grants **no data access**: at run time the Skill is bounded by
the caller's authority (§3). Resources a Skill declares are validated against the
publishing owner's access at publish, and bounded by the caller's context at every
invocation.

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
