# Agent Flow + AI Chat — audit

**Status:** draft — audit only, no implementation
**Date:** 2026-09-15
**Scope:** Agent Flow Studio (authoring) and AI Chat (reading) as one product system.

This file is the evidence base. `intent.md`, `spec.md` and `plan.md` are the decisions
that follow from it. It exists as a fourth file because the task was an audit first and a
feature second, and burying the evidence inside `intent.md` would make both unreadable.

## How to read the evidence markers

Every finding below carries one, and they are not interchangeable:

| Marker | Means |
|---|---|
| **[PROVEN]** | Read out of the current code or measured by a command in this session. Cited by file and line. |
| **[HISTORY]** | Supported by a commit or an in-code post-mortem. The bug it describes may already be fixed — where it is, that is stated. |
| **[INFERENCE]** | A judgement about how this behaves for a person. Needs a browser or a user to confirm. **Not presented as fact.** |

---

## 1. CURRENT SYSTEM MAP

### 1.1 Shape and size

| Layer | Files | Lines |
|---|---|---|
| Studio frontend (`components/agent-flows/`) | 14 | 8,320 |
| Chat frontend (`components/chat/`) | 4 | 960 |
| Shared FE contract (`lib/agentFlows.ts`) | 1 | 1,585 |
| Backend module (`modules/agent_flows/`) | api 1,699 + chat_api 414 | 2,113 |
| Backend runtime (`services/agent_flows/`) | dispatch 1,130 + executor 1,415 + others | ~4,600 |
| Backend tests in area | 23 | ~8,000 |

The Studio frontend is **8.7× the size of the Chat frontend**. That ratio is itself a
finding: the authoring half absorbed nearly all the investment.

### 1.2 The three runtime surfaces, and where they converge

**[PROVEN]** `executor.run_flow` is called from exactly three places, all in
`dispatch.py`, and from nowhere else in the codebase:

```
dispatch.py:522   run_for_link            → Dashboard / Published Bot
dispatch.py:840   run_preview             → Studio Test
dispatch.py:1066  run_for_chat_thread     → Direct Chat
```

Verified by `grep -rn "run_flow(" --include=*.py backend/app` → 3 call sites, 1 definition.

**There is already exactly one orchestration engine.** The user's stated preference —
"ONE execution backbone with surface-specific contracts/context" — is not a target state.
It is the current state, and it is deliberate. `run_for_chat_thread`'s docstring says so
in its own words:

> THE SAME ENGINE, A DIFFERENT CEILING. Everything downstream of the envelope is
> byte-for-byte the public path. What differs is assembled here, and only here:
> report / binding / scope / actor / permission.

What each surface assembles differently, per that docstring and the code beneath it:

| | Dashboard bot | Studio test | Direct Chat |
|---|---|---|---|
| report | real dashboard | real dashboard or link | `dashboard_id=0` sentinel |
| binding | stored row | stored row | ephemeral `id=0`, empty chart allowlist |
| scope | `run_scope` | `run_scope` | `run_scope` (same delegation) |
| actor | viewer | author | `CHAT_USER` |
| permission | binding | author's edit right | re-resolved **every turn** |

The chat sentinel is reasoned, not lazy: a stub Dashboard row "would make every
report-reading tool believe it had something to read and answer from an empty result
instead of refusing."

### 1.3 The author journey, as the code implements it

```
/agent-flows  AgentFlowsPage (106)
  └ BrainList (1004)              catalogue, stats strip, card grid, create
      └ BrainBuilder (1091)       ← shell: 717 lines, 31 useState
          ├ NodeLibrary (171)     palette, generated from the backend registry
          ├ FlowCanvas (642)      node blocks, insert points, drag
          │   └ useFlowEdges (284) layout + edge generation
          ├ NodeInspector (1781)  ← NodeForm alone is 708 lines, all 14 types
          ├ TestChat (860)        test → diagnose loop
          ├ RunsTab (1101)        run history + trace
          ├ FeedbackTab (272)
          └ ActivityTab (146)
```

### 1.4 The reader journey

```
/chat  ChatModule (298)
  ├ AssistantCatalogue (265)      assistants + stats strip
  └ ConversationView (376)        thread, SSE, answer blocks, citations
```

---

## 2. ARCHITECTURE FINDINGS

### F1 — The node registry is a presentation registry, not a topology registry **[PROVEN]**

`runtime/nodes.py:36` declares `NodeSpec` with: `type, label_vi, label_en,
description_vi, category, icon, handler, structural, costs_llm, reaches_outside`.

It records **that** a node is structural (`structural: bool`). It does not record
**where that node's children live**.

The four container shapes are therefore re-derived by hand everywhere:

| Container | Child slots |
|---|---|
| `if` | `paths[].body` |
| `switch` | `cases[].body` + `fallback` |
| `coordinate` | `specialists[].body` + `fallback` |
| `loop` | `body` |

Measured distribution of that same knowledge:

| Where | Branches | Functions |
|---|---|---|
| `lib/agentFlows.ts` | 25 | `walkNodes`, `replaceNode`, `removeNode`, `insertNode`, `locateNode` |
| `BrainBuilder.tsx` | 7 | 2 |
| `FlowCanvas.tsx` | 4 | `NodeBlock` |
| `NodeInspector.tsx` | 4 | 1 |
| `useFlowEdges.ts` | 4 | `layoutNode`, `ruleIds` |
| `TestChat.tsx` | 3 | `branchProbes` |
| **Frontend total** | **47** | **12** |
| Backend (`contract.py`, `handlers/logic.py`, `binding.py`, `registry.py`) | 13 | — |

**Adding one container node type today means teaching ~13 independent call sites the
same topology.** The backend is far more consolidated than the frontend (13 mentions in
4 files vs 47 in 6), because the backend has the registry and the frontend has only
consumed it for *presentation*.

This is not a duplication-is-ugly argument. It has already cost a measured production
bug — see F2.

### F2 — The cost of F1 is on the record **[HISTORY, fix verified present]**

`contract.py:1089 all_nodes()` carries its own post-mortem:

> `coordinate` was added without being taught here, and this method is what the flow
> knows about itself. Everything downstream reads it, so a lane's contents were
> invisible to all of it at once … A live run found the cost: the "số liệu" specialist
> held `get_chart_data`, `total_measure` and `compare_periods` — three tools that all
> require a `chart_id` — and nothing that can produce one. The check for that case was
> already written and simply never looked inside the lane. Asked which product category
> earned the most, the flow answered "13,591,643.70" — the report's grand total, no
> category named, no notice raised.

**The bug is fixed.** I verified `all_nodes()` now walks every container. The rule it
encodes is stated in the same docstring: *"a node that holds nodes must be walked here,
and adding one is not finished until it is."*

That rule is currently enforced by a comment. F1 is the reason it will be broken again.

### F3 — Two mega-functions carry the authoring surface **[PROVEN]**

- `NodeInspector.tsx` → `NodeForm` spans **lines 379–1087 (708 lines)** and branches on
  **all 14 node types** (16 branches). Each type's editor is an inline block, not a
  component.
- `BrainBuilder.tsx` → `BrainBuilder` spans **lines 127–844 (717 lines)** with
  **31 `useState`** calls in one component.

These two functions are why the files are large. The file size is a symptom; the missing
boundary is *per-node-type editor* and *per-concern builder state*.

### F4 — "Coverage" names two unrelated things **[PROVEN]**

| Meaning | Where |
|---|---|
| Which **question classes** the flow can answer | `services/agent_flows/coverage.py`, surfaced to the author via `readiness.coverage` in `TestChat.tsx:355` |
| Per-node **run counts** in a time window | `FlowCanvas.tsx:43-44` — "node key → runs in the coverage window. `0` marks a branch nobody reaches." |

Two different concepts, one word, both on the author's screen. **[INFERENCE]** that this
adds cognitive load — plausible and cheap to fix, but not measured with a user.

### F5 — The runtime is mature and should mostly be left alone **[PROVEN]**

The backend carries dense, specific post-mortems at the points that matter
(`all_nodes`, `run_for_chat_thread`, `coverage.py`, `_set_refresh_cookie`). Its
container knowledge is already consolidated. `dispatch.py`'s three entry points share one
executor.

**Do not refactor this to make files smaller.** The backend's real debt is narrow and
named in F1 (no slot declarations) and F8 (no projection to chat).

---

## 3. PRODUCT / UX FINDINGS

### F6 — The Studio test panel shows the author a degraded answer **[PROVEN]** — highest severity

The answer contract `AnswerBlock` has **six variants**
(`agentFlows.ts:656`): `text`, `metric`, `table`, `chart_ref`, `callout`, `followups`.

- **Chat** renders them through a shared component:
  `ConversationView.tsx:365` → `<AnswerBlocks blocks={message.blocks} …/>`
- **Studio test** flattens them (`TestChat.tsx:317-318`):

```ts
const answer = (env?.answer?.blocks || [])
  .map((b) => b.markdown).filter(Boolean).join('\n\n');
```

`TestChat.tsx` does **not** import `AnswerBlocks` (verified). Its local type is
`blocks: { type: string; markdown?: string }[]` — markdown only.

So every `metric`, `table`, `chart_ref` and `callout` block has no `.markdown`, is
filtered out, and vanishes. When *all* blocks are non-text, `answer.body` is empty and
`TestChat.tsx:723` renders **`—`**.

This path is reachable, not theoretical: `AgentNode.output_format: 'json'` exists to
request typed blocks, `handlers/agent.py:1210-1214` is the prompt instructing the model to
emit `{"type":"metric"…}` and `{"type":"chart_ref"…}`, and `executor.py:1092` handles
them.

**An author using JSON output tests their flow and sees an em-dash, while the reader
sees a rendered metric.** This is a direct, provable answer to "why does authoring still
feel difficult": the test loop does not show what the user will see.

### F7 — The Chat reader is told inventory, not capability **[PROVEN]**

`ChatBrain` (`lib/directChat.ts:15`) carries exactly:
`brain_key, name, description, version, flow_id, knowledge_count`.

`AssistantCatalogue.tsx:74-79` shows a stats strip of: **assistants count, conversations
count, knowledge count** — three inventory numbers about the module.

The user's question was whether those are the right things to emphasise. They are not,
and the evidence is that **the system already computes the right things and does not
send them**. See F8.

### F8 — Capability information exists server-side and is never projected to chat **[PROVEN]**

`services/agent_flows/coverage.py` computes "What kinds of question this flow can
actually answer, and what it cannot", derived "entirely from the registry and the flow —
no opinions, no model — so it cannot drift from what the flow can really do."

Its docstring records the exact failure it exists for:

> Q: "Có điều gì bất thường trong báo cáo này mà tôi nên chú ý không?"
> A: "Báo cáo không cung cấp thông tin cụ thể về các bất thường."
> tool calls: 0
>
> Both halves of that are wrong. The report does contain the information, and
> `detect_anomaly` exists, is registered, and was simply never granted.

Consumers, verified by grep:

- `binding.py:32` — the dashboard/public path uses it
- `TestChat.tsx:355` — the **author** sees it as `readiness.coverage`
- `chat_api.py` — **no reference at all**

**The system knows what an assistant can and cannot answer, tells the author, and does
not tell the person asking the question.** Closing this is a projection of an existing,
tested, drift-proof computation — not a new feature and not new authoring burden.

### F9 — Validation feedback was a known wound and has been treated **[HISTORY]**

`40b8fea fix(agent-flows): the builder answered "what is wrong?" with a link to
pydantic.dev`. **[INFERENCE]** whether the current state is now good enough is a browser
question, not a source question.

### F10 — Layout/visual defects have repeatedly escaped the test suite **[HISTORY]**

Commit titles in this area are unusually explicit about it:

- `9d6bfe7 fix(ui): two layouts that were wrong on screen and right in every test`
- `e1bcf07 fix(agent-flows): three defects only the browser could find`
- `c9ada68 fix(agent-flows): three things the coordinator only got wrong when run for real`
- `1e75e72 fix(agent-flows): the coordinator's lanes, drawn like the branches they are`

54 commits since 2026-06-01 in this area: 30 `feat`, 17 `fix`, 5 `refactor`.

This is the historical justification for doing **architecture and behaviour stabilisation
before a visual redesign**, which is what the user suspected.

---

## 4. DIRECT CHAT FINDINGS

### F11 — At runtime, Chat is a surface, not a parallel product **[PROVEN]**

Established in §1.2. One executor, three entry points, surface-specific context assembly
with documented reasons. **Reject the "accidental parallel runtime" hypothesis for the
backend.**

### F12 — At the frontend, the last mile *has* diverged **[PROVEN]**

Chat imports from the Studio exactly two things:

```
ConversationView / AssistantCatalogue → formatWhen  (a date helper)
ChatModule                            → FlowOutputEnvelope  (a type only)
```

The **envelope — the single output contract of the single shared backbone — has two
independent renderers**: `TestChat.tsx` (Studio) and `ConversationView.tsx` (Chat). F6 is
the consequence: they have already drifted, and the Studio one is the degraded copy.

So the honest answer to the user's question 5 is split:

- backend: **one product, one runtime** — keep
- frontend: **one contract, two renderers** — this is the real divergence, and it is
  small and fixable (960 lines of chat, one shared component already exists in
  `components/common/AiAnswer`)

### F13 — Chat has been outside a guard before **[HISTORY]**

`5b96d0c fix(permissions): AI Chat was outside the module guard, and the matrix never
said it existed`. Fixed. Relevant as evidence that Chat was added alongside rather than
inside the module's governance, which is the same shape as F8 and F12.

### F14 — `flow_type` already models the surface split **[PROVEN]**

`contract.py:1232 warnings(flow_type)` takes the type because "three of these notes
describe a consequence that only holds on a report, and stated to a chat author they are
not merely useless — they are false, and two of them are REASSURING."

The backend already models *Flow + intended surface*. The frontend vocabulary has not
caught up (F15).

---

## 5. NAMING / MENTAL MODEL

**[PROVEN]** occurrence counts across Studio + Chat frontend:

| Term | Count |
|---|---|
| Flow | 860 |
| Brain | 122 |
| `brain_key` | 52 |
| Bot | 16 |
| Agent | 13 |
| Specialist | 9 |
| Assistant | 8 |
| Coordinator | 0 (the node type is `coordinate`) |

The split already exists in practice and is inconsistent rather than absent: the Chat
surface calls them **Assistants** (`AssistantCatalogue`), the Studio and the API call the
same object a **Brain** (`BrainList`, `BrainBuilder`, `/brains`, `brain_key`).

**Verdict on the user's hypothesis:** *accept with one modification.*

| Hypothesis | Verdict |
|---|---|
| Assistant = the thing a person uses | **Accept** — Chat already does this |
| Flow = how the assistant is orchestrated | **Accept** — matches `flow_type`, `FlowBody` |
| Agent / Tool / Logic = building blocks | **Accept** — matches `NodeCategory` (`ai`/`data`/`logic`/`flow`/`utility`) |
| Dashboard Bot / AI Chat = runtime surfaces | **Accept** — matches the three dispatch entry points exactly |
| *(modification)* **Brain** | Retire as **user-facing** vocabulary only. **Do not rename `brain_key`, `/brains`, or the DB columns** — that is cosmetic churn across a mature runtime, 52 FE references and a public API, with no behavioural gain. Internal identity stays `brain_key`; the word "Brain" stops appearing on screen. |

---

## 6. TEST + GUARDRAIL GAP ANALYSIS

### F16 — The guardrail has **no knowledge of this subsystem** — UNKNOWN, and unknown is not safe **[PROVEN]**

`guardrail_rules.yaml` registers 11 features:

```
auth_permissions, calendar_time, chart_sql_engine, dashboard_build_render,
distinct_value_cascade, filter_layered_merge, filter_pane_slicers,
join_resolution, measures, metadata_catalog, workboards
```

`metadata_catalog` and `workboards` are registered. **`agent_flows` and `direct_chat`
are not.** Grep for `agent_flow|direct_chat|chat` in the rules file returns nothing.

Measured directly:

```
--plan "Rework Agent Flow Studio node editing UX …"   → verdict: unknown, matched_features: []
```

Worse — and this is a second defect — the *first* probe returned a confident wrong answer:

```
--plan "Rework Agent Flow Studio authoring UX …"      → verdict: warn, matched: auth_permissions
  findings: "SCOPE GAP: the issue points at 'auth_permissions' … but the plan doesn't touch them"
  out_of_scope: all four agent_flows files
```

The word **"auth**oring**"** substring-matched the keyword **"auth"**. The guardrail
pointed at `backend/app/api/auth.py` and `core/dependencies.py` for a node-editor change,
and declared every actual file out of scope.

So the guardrail is not merely silent on the largest, most actively developed module in
the repo — under a plausible plan sentence it **misdirects**. Per CLAUDE.md, `unknown` is
not `safe`; a false `warn` is worse than either.

### F17 — 8 of 23 tests in this area are tracked but never run in CI **[PROVEN]**

Cross-checking `backend/tests/` against the pytest list in
`.github/workflows/backend-contract-tests.yml`:

| Test | Tracked | In CI |
|---|---|---|
| `test_coordinator_is_visible_to_the_flow.py` | yes | **NO** |
| `test_flow_coordinate.py` | yes | **NO** |
| `test_flow_synthesis_sees_all_steps.py` | yes | **NO** |
| `test_chat_thread_sharing.py` | yes | **NO** |
| `test_flow_attached_but_unreadable.py` | yes | **NO** |
| `test_flow_type.py` | yes | **NO** |
| `test_govern_knowledge_tools.py` | yes | **NO** |
| `test_chart_discovery_and_figure_correction.py` | yes | **NO** |

15 of 23 do run. The 8 that do not include **the test locking F2** (the coordinator
visibility bug that produced the wrong number) and **`test_chat_thread_sharing.py`**,
which locks read-only share enforcement — an access-control behaviour.

I ran all eight locally: **119 passed in 9.25s**. They are good tests with a wiring gap,
not broken tests. This is the cheapest high-value fix in the whole plan.

This is the same failure class as the CI defects found earlier this session: coverage
that looks present and does not execute.

### F19 — 43 of 72 backend tests never run in CI, and the DoD check reports "ok" **[PROVEN]** — repo-wide, beyond this feature

F17 is the Agent Flow slice of a much larger hole. Measured across the whole repository:

| | Count |
|---|---|
| Tracked test files in `backend/tests/` | 72 |
| In the `.gitignore` allow-list | 29 |
| Referenced by `backend-contract-tests.yml` | 29 |
| **Tracked, not allow-listed, never run by CI** | **43 (60%)** |

`python scripts/ci/verify.py task` prints:

> **Backend tests reach CI** — ok: every allow-listed suite exists and is run by CI

That statement is **true and misleading**. Allow-listed (29) and CI-referenced (29) match
exactly, so the check passes — and it never looks at the other 43, because they are not
allow-listed.

**The mechanism.** `.claude/rules/testing.md` documents a three-step ritual: add to the
allow-list, add to the workflow, `git add -f`. It assumes you do all three or none. Doing
**only step 3** produces a test that is tracked, survives a fresh clone, looks like
coverage in the tree, is invisible to the DoD checker, and never executes.

Ghosts include security-adjacent suites well outside this feature:
`test_module_floor.py` (the permission floor), `test_workboard_app_user_roles.py`,
`test_chunk_scope_is_the_guarantee.py`, `test_semantic_level0.py`.

**Scope discipline:** this rework fixes the 8 in its own area (Phase 0) and fixes the
*checker* so the remaining 35 become visible. Wiring up 35 unrelated tests is its own
project with its own risk budget — several may fail in CI — and is explicitly **not**
absorbed into this rework.

This is the same failure class as the CI defects found earlier this session: coverage that
looks present and does not execute.

### F18 — Frontend has no structural guard for the node model **[PROVEN]**

`npm run qa` guards `module-routes`, `theme`, `presentation`. There is no check that the
frontend's node-type union, walkers and editors stay in step with the backend registry —
which is exactly the F1/F2 failure mode.

---

## 7. KEEP / REWORK / REMOVE

| Concept | Verdict | Reasoning |
|---|---|---|
| Single `run_flow` backbone | **KEEP — do not touch** | §1.2 [PROVEN]. Already the preferred architecture. |
| Surface-specific context assembly in `dispatch.py` | **KEEP** | Documented, reasoned, three entry points. F11. |
| `coverage.py` question-class model | **KEEP + PROJECT** | Correct and drift-proof; just not sent to chat. F8. |
| `contract.py` / `all_nodes()` / validation | **KEEP** | Mature, carries its own post-mortems. F5. |
| Backend `NodeSpec` registry | **REWORK (extend)** | Add child-slot declaration. F1. Extension of an existing abstraction, not a new one. |
| FE topology walkers (5 in `agentFlows.ts` + 7 elsewhere) | **REWORK** | Consume declared slots instead of hand-rolling. F1/F2. |
| `NodeForm` (708 lines, 14 types) | **REWORK** | Split per node type. F3. |
| `BrainBuilder` (717 lines, 31 useState) | **REWORK** | Extract state concerns. F3. |
| `TestChat` answer rendering | **REWORK — highest priority** | Must use the shared `AnswerBlocks`. F6. |
| `ChatBrain` contract | **REWORK** | Project capability, not inventory. F7/F8. |
| "Brain" as user-facing word | **REWORK (vocabulary only)** | F15. **Not** a backend rename. |
| `brain_key` / `/brains` / DB columns | **KEEP** | Cosmetic churn, no behavioural gain. F15. |
| FlowCanvas `coverage` prop name | **REWORK (rename to `runCounts`)** | F4. Local, safe. |
| `flow_type` | **KEEP** | Already models the surface split correctly. F14. |
| Studio `RunsTab` / `FeedbackTab` / `ActivityTab` | **NEEDS MORE EVIDENCE** | Not inspected in depth this pass; no finding either way. Do not classify on size alone. |
| Direct Chat as a module | **KEEP** | It is a surface of one product, not a second product. F11. |
| Guardrail coverage for this area | **REWORK (add)** | F16. |
| 8 tests missing from CI | **REWORK (wire up)** | F17. |

Nothing is classified **REMOVE**. No evidence in this pass supports deleting a concept.

---

## 8. WHAT I DID NOT VERIFY

Stated plainly, because a gate that did not run is never coverage:

1. **The rendered UI.** Every UX judgement marked [INFERENCE] — visual hierarchy,
   cognitive load, canvas readability at scale, whether validation feedback is *now*
   good — is from source and history. I did not drive the browser this pass.
2. **`RunsTab`, `FeedbackTab`, `ActivityTab`** — listed in the map, not audited in depth.
3. **Large-flow behaviour.** `MAX_NODES = 40`. I did not build a 40-node flow to observe
   canvas, minimap or inspector behaviour at that size.
4. **Accessibility.** Not audited at all.
5. **Responsive behaviour** of Studio and Chat. Not audited.
6. **Whether authors actually use `output_format: 'json'`.** F6's severity depends on how
   common that path is in real flows. The defect is proven; its *frequency* is not.
7. **E2E status.** The repository's E2E workflow is currently red for reasons unrelated to
   this audit (investigated earlier in this session; last run produced no annotations, so
   the remaining cause is not confirmed).
