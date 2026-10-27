# Unified AI Chat — architecture contract

**Status:** ACCEPTED by the Product Owner (2026-10-27): ADR-1 approved, ADR-4 approved. **ADR-3 REVISED by the Product Owner (2026-10-28):** the public Dashboard AI Bot is a consumer of the one Answer Core, not a Flow-engine surface (see ADR-3 and section H). Implemented on `feat/unified-ai-chat-contract` (sections G and H).
**Version:** 1.0
**Baseline audited:** `origin/demo` at `0b48f597` (2026-10-27)
**Supersedes:** the Agent-Flow-first decisions in `docs/features/agent-flow-chat-rework/*`, and the decision in `docs/features/analyst-official-module/*` to keep Analyst as a separate product.

Product statement: AppBI has **one** AI Chat. Its data answers come from **one** governed Data Intelligence Core. **Agent Flow is an optional extension**. It adds knowledge, rules and tools, and it never owns a turn.

**This contract is enforced, not just written.** `backend/tests/test_unified_chat_architecture.py` (CI unit job) fails if any of these comes back:
- a second answering route for signed-in users;
- a Flow required to ask;
- a Flow reading business data;
- a second conversation store;
- a user-facing Analyst toggle;
- a retired chat or analyst module imported in the frontend.

Change this contract deliberately, and that test with it.

---

## A. Current state (audited facts)

`PROVEN` means the claim was read in code at `0b48f597`. `ASSUMED` means it was not verified.

### A.1 Two engines answer questions today, plus two that are out of scope

| # | Surface | Entry | Engine | Data path | Final answer written by |
|---|---|---|---|---|---|
| 1 | **AI Chat** `/chat` | `modules/agent_flows/chat_api.py` — 7 routes under `/api/v1/agent-flows/chat` | `dispatch.run_for_chat_thread` (`dispatch.py:990`) → `runtime/executor.run_flow` (`executor.py:151`) | Flow tools → `tools/context.py:_fetch_chart_data` → `ChartService.get_chart_data(db, chart_id, …)` (`context.py:888`). **No principal is passed and GQS is not used.** | the LLM inside the flow (`runtime/handlers/agent.py:_stream`) |
| 2 | **Analyst** `/analyst`, `/analyst/s/{id}` | `api/analyst.py` — 11 routes under `/api/v1/analyst` | `services/analyst/service.ask` | `GovernedQueryService.execute` with `EffectivePrincipal.for_user(surface="analyst")` (`service.py:67,209,238`) | `narrative.describe` (deterministic text over verified rows), after the planner LLM |
| 3 | Public dashboard assistant `/d/{token}` | `api/public.py:5184` → `dispatch.run_for_link` | Agent Flow | chart allowlist of the published report | flow LLM |
| 4 | Studio preview | `modules/agent_flows/api.py:1322…1697` → `run_preview` / `preview_step` | Agent Flow | as in 1 | flow LLM |

Rows 3 and 4 are not the authenticated AI Chat. See ADR-3.

**PROVEN:**
- `governed_query` is imported **only** by `api/analyst.py` and `services/analyst/{service,catalog}.py`. No Agent Flow code uses it, even though GQS already declares `surface="agent_flow"` (`governed_query/principal.py:31`).

### A.2 Where a Flow is mandatory today (all PROVEN)

- **Thread model:** `agent_flow_chat_threads.brain_key` is `NOT NULL` (`models/agent_flow_chat_thread.py:49`), and `NewThread.brain_key` has `min_length=1` (`chat_api.py:78`).
- **Thread creation:** returns 404 unless `direct_chat.resolve_for_chat` passes (`chat_api.py:154-159`).
- **Every turn:** re-checked at `dispatch.py:1067`. The flow must be published and opted in through `agent_brain_versions.direct_chat_enabled`.
- **UI:** `ChatModule.tsx:121` reads `if (!question || streaming || !brainKey) return;`. Without `?brain=`, nothing is sent.
- **Rollout gates:** the reader cohort uses `AGENT_FLOW_READER_MODE` (default `pilot`) and `AGENT_FLOW_PILOT_USERS` (`config.py:216-218`). With an empty cohort, nobody is served.
- **Credentials:** a step without a stored key returns 409 (`chat_api.py:308`). There is no server fallback key.

### A.3 Duplicated responsibilities

| Responsibility | Chat (Flow) | Analyst | Decision |
|---|---|---|---|
| Conversation identity | `agent_flow_chat_threads` | `analyst_sessions` | one: `chat_conversations` |
| Turns or messages | no message table: `agent_flow_runs` + `agent_flow_run_content`, joined by `chat_thread_id` | `analyst_session_turns` (seq, unique turn_id, response JSONB, dataset_ids, refs) | one: `chat_turns` |
| Follow-up context | last 12 runs as history, plus `ai_chat_sessions` memory (`dispatch.py:186,249,1148`) | server `previous_plan` of the last fully visible turn | one: Core plan context, plus a typed extension memory |
| Idempotency | **none** (PROVEN) | `turn_id` unique, 409 on reuse | Core |
| Cancellation | client abort, then `agen.aclose()`, recorded as `failed/turn_abandoned` | `POST /turns/{id}/cancel` + `CancelRegistry` | Core, with a real `cancelled` state |
| Quota | `DIRECT_CHAT_RUNS_PER_DAY=100`, counted from recorded runs, so bursts are possible (`chat_quota.py:60`) | `PostgresLedger` budgets under advisory lock, checked before the model is called | one budget authority |
| Terminal states | `ok/partial/blocked/failed` | `answered/clarify/unsupported/refused`; no `error` state, so an exception becomes HTTP 500 (ASSUMED) | `answered / clarification_required / refused / failed / cancelled` |
| Answer schema | `Answer.blocks`: Text, Metric, Table, ChartRef, Callout, Followups (`envelope.py:346-412`) + `Citation` | flat `answer/columns/rows/evidence/chart_draft` | one envelope that reuses AnswerBlocks |
| Sharing | `ResourceType.CHAT_THREAD` | `ResourceType.ANALYST_SESSION`, redacted on read | one resource type, redacted on read |
| Module permission | `chat` | `analyst` (+ `explore_charts:view` + allowlist) | `chat` only |

### A.4 Security contracts that must survive (PROVEN)

- **GQS:**
  - It refuses raw SQL and accepts only `semantic_explore` relations.
  - It checks `authz.decide(EXPLORE)` on the Dataset and on every parent Dataset.
  - It applies GovernAI scope exclusions.
  - It refuses Datasets with operational purpose, because GQS does not apply RLS.
  - It applies the bytes, rows and timeout bounds.
  - It refuses to run without an audit sink, and it cancels per dialect.
  - It accepts only HMAC-signed consent tokens.
- **Analyst sessions:** each read re-derives scope and redacts what the reader can no longer see; an id the caller cannot see returns 404, not 403.
- **Agent Flow `run_scope`** (`permissions.py:164-225`): owner's current rights ∩ what the flow attached ∩ what the link declared ∩ (caller's rights ∪ explicit delegation). The scope is re-derived on every turn and fails closed.
- **Chat module:** `chat` was deliberately left out of `api/public.py`, and anonymous `/chat/threads` is refused (`e2e/tests/surfaces.spec.ts:191`).

### A.5 Gaps found that matter to this contract

1. **G1, PROVEN: Flow data reads are not governed by GQS.**
   - `ChartService.get_chart_data` runs with no principal. The only gate is a chart allowlist.
   - Dataset rights on the caller side come from `readable_datasets` (owned or shared at any level). That is not an EXPLORE decision, and RLS/GovernAI scope are not re-checked by GQS.
2. **G2, PROVEN: delegation lends the author's data rights.** `agent_flow_delegations` can add a Dataset the caller cannot read themselves (`permissions.py:214-218`). This conflicts with directive §7 invariant 10: "No Flow gets a broader authority because of its author."
3. **G3:** there is no idempotency on the chat turn endpoint, and the quota allows bursts.
4. **G4:** Analyst has no production model-cost ledger; `llm_test_budget` is a test harness only. Flow runs record tokens and USD per run, but there is no per-user cost cap (ASSUMED).

---

## B. Who owns what

| Concern | Owner |
|---|---|
| Conversation, turn identity, idempotency, authorization context, budget, cancellation, terminal status, final evidence, final answer | **Chat Core** (one orchestrator) |
| Business-data reads by the AI | **GQS** (`services/governed_query`), with the asker's `EffectivePrincipal`. No other AI data path exists. |
| Question → governed plan (catalog, intent, planner, grounding, verification, narrative, chart draft) | **Data Intelligence Core**: today's `services/analyst/*`, re-homed |
| Knowledge, rules, SOPs, specialised tools | **Agent Flow extension**, invoked by the Core, returning typed evidence |
| Authoring flows | Agent Flow Studio (unchanged as a product area) |
| Documents | Knowledge Hub (unchanged) |

---

## C. Challenges (directive §3)

### ADR-1: Flow output may not contain business numbers in v1. ACCEPT WITH REFINEMENT

- **A. Requirement:**
  - C3: a Flow may "Bổ sung nguồn bằng chứng".
  - C3: a Flow must not "Tự thực thi SQL ngoài GQS".
  - C3: a Flow must not "Đọc thêm dữ liệu do quyền của Flow author cao hơn".
- **B. Evidence:** G1 and G2. Every Flow data tool (`rank_values`, `total_measure`, `share_of`, `get_chart_data`, `aggregate_chart_data`, …) reads through `ChartService` with no principal.
- **C. Failure mode if Flows are enabled inside Chat as they are:**
  - A Flow could return a number from a chart the asker cannot EXPLORE, because it was delegated or owned by the author.
  - The Core would then cite that number. That is a scope leak and an unverifiable figure.
- **D. Alternative:** a Flow invoked as an extension runs with **data tools disabled**. It may return only:
  - `document_evidence`: Knowledge Hub passages, read under the **asker's** document rights, with no delegation in extension mode.
  - `finding`: text marked `derived`, with no numeric claims.
  - `clarification_suggestion` and `warning`.

  Numbers in Flow text are checked: any number that is not in the Core's verified result is flagged and stripped from the final answer. A later version may add governed data tools that call GQS with the asker's principal.
- **E. Trade-offs:**
  - Lost: no existing Flow "data skill" is usable from Chat until it is rebuilt on GQS.
  - Gained: one number authority and no confused deputy.
  - Cost: none extra.
- **F. Recommendation: ACCEPT WITH REFINEMENT.**
  - v1: no numbers come from Flows.
  - Delegation (`agent_flow_delegations`) is ignored for Chat extension calls.

### ADR-2: Which storage becomes canonical. ACCEPT WITH REFINEMENT

- **Evidence:**
  - Chat threads have no turn table; their transcript is reconstructed from `agent_flow_runs`/`run_content`, which retention pruning can drop.
  - Analyst turns already have a seq, a unique turn_id, the stored response, and the dataset footprint for redaction.
- **Recommendation:** rename and evolve `analyst_sessions`/`analyst_session_turns` into `chat_conversations`/`chat_turns`, then add:
  - `idempotency_key`;
  - a terminal `status` drawn from the five states;
  - `envelope` JSONB;
  - an `invocations` table for Flow calls (contract in D.4).

  Migrate `agent_flow_chat_threads` into `chat_conversations`, one turn per run, with `status` mapped and authors and timestamps kept. Those turns are read-only legacy turns marked `origin="flow_v0"` and are never re-executed. `agent_flow_runs` stays as the execution record of Flow invocations.

### ADR-3 (REVISED 2026-10-28): One Answer Core; the public Dashboard AI Bot is its second consumer

The 2026-10-27 recommendation (keep the public assistant on the Flow engine as a separate surface) was **not accepted** by the Product Owner. The decision:

> AppBI has ONE Answer Core for AI question answering. AI Chat and the Dashboard AI Bot are two consumers of the Core. Agent Flow is an add-on module the Core may call when needed. Every final answer, data access, number verification, credential and token budget is under the Core's control and the system's common policy.

- **How an anonymous viewer is answered without weakening GQS.** GQS keeps its person principal; no anonymous principal is added. The Core reads through a **data scope** (`services/data_core/scope.py`):
  - `GovernedScope`: a signed-in asker, GQS on the `chat` surface (unchanged behaviour);
  - `PublishedReportScope` (`services/answer_core/published_report.py`): the link's PUBLISHED charts, read through `_fetch_chart_data` on the link's tool context - the governed public chart path the tiles render through (dashboard filters, the link's locks and hidden filters, page slicers and page bounds, exposed fields, AI-scope exclusions, freshness). No SQL, no dataset-wide read, no owner rights.
- **The answer** is the Core's: the same planner, grounding, filter-value checks, ranking and deterministic narrative as AI Chat; numbers come only from the chart rows. A grouping the chart does not show is computed only for additive measures; an average/distinct count is answered at the chart's own grouping or refused.
- **Agent Flow** bound to the link is an optional documents-only add-on (`services/answer_core/link_extension.py`): `data_reads_forbidden`, the link's own knowledge ceiling, validated by the same `chat.extension.accept` as AI Chat's add-on. No flow is needed for the bot to answer.
- **Studio preview** (`run_preview`) stays the author's diagnostic; it is not a viewer's answer path.
- **Enforced by:** `tests/test_public_answer_core.py` (the public route is served by the Core; no public route reaches `run_for_link` or reads `X-User-Ai-Key`; the published scope reads only through the governed public chart path; the link budget fails closed), `tests/test_answer_core_published_scope.py`, `tests/test_ai_runtime_gateway.py`, and the frontend `check-answer-parity.mjs` (sections 6-7).

### ADR-4: `analyst` permission module. ACCEPT AS WRITTEN

`chat:view` becomes the only gate. Data visibility is decided per Dataset by EXPLORE, so `analyst` adds nothing.
- Users who hold `analyst` but not `chat` get `chat:view`, and only them.
- The `analyst` module key is removed from the registry, presets, route contract and UI.
- `ANALYST_ENABLED` becomes `AI_CHAT_CORE_ENABLED`, an operator kill switch. When it is off, Chat returns a clear "temporarily unavailable" and **does not fall back** to the old Flow engine.

**Note:**
- Today `chat` is granted wherever Flow chat was granted. After the rework, those users can ask about Datasets they can EXPLORE without any Flow.
- This widens the capability but not data access: GQS enforces EXPLORE on every read.
- This matters for "Do not expose to all users by default", so the PO must confirm it.

### ADR-5: Removing `explore_charts:view` as an extra Analyst gate. ACCEPT WITH REFINEMENT

GQS already enforces EXPLORE per Dataset. The extra module check is kept only for **saving a chart** (`can_save`), where it is the right gate.

---

## D. Target architecture

### D.1 Turn sequence

```
UI /chat ──POST /api/v1/chat/conversations/{id}/turns {question, idempotency_key, sources?, follow_up}──▶ ChatOrchestrator
  1 authn + module chat:view + conversation access (owner|edit)             → 404 if not readable
  2 idempotency: (conversation, key) seen → replay the stored envelope/stream
  3 budget authority: queries/day + model-cost/day + concurrency           → refused(budget)
  4 context: Core plan of the last fully-visible turn (server-owned)
  5 Data Core: catalog.discover(asker) → intent → plan (LLM) → ground → GQS.execute(asker principal)
                → deterministic verification → narrative/blocks/chart draft
  6 Router (D.3): eligible extension? → ExtensionRunner(run_flow, mode="extension", ceiling=asker)
                → typed results → validate (schema, provenance, number check)
  7 Merge: Core blocks + extension evidence; conflicts reported, never resolved silently
  8 Persist chat_turn (terminal status, envelope, footprint) → stream `final` → `done`
```

Only step 8 writes the final answer. A Flow never streams `text` to the UI directly; its progress appears as `extension_progress` events.

### D.2 Turn state machine

`accepted → running(core) → [running(extension)] → answered | clarification_required | refused | failed | cancelled`

- Exactly one terminal state per turn, written once, guarded by a DB constraint.
- If verification fails, the state is `failed` with code `verification_failed`. It is never `answered`.
- Cancel at any stage: GQS cancel plus extension cancel, then `cancelled`. A reload shows `cancelled`.

### D.3 Extension routing (deterministic first)

- **Eligible flows:** flows bound to the conversation's chat configuration by an authorized admin or the user, that are published, `chat_extension_enabled`, and whose `run_flow` grant the asker holds.
- **Invoke only if:**
  - the user names the capability explicitly ("theo chính sách…" or a `@flow` mention), **or**
  - the intent classifier returns a non-data need (policy/SOP/document) **and** an eligible flow declares that capability tag.
- **Never invoked:** for pure data questions (Case A/B), when no eligible flow exists, or when the budget is exhausted.
- **Limits:** at most 1 invocation per turn in v1, a 30 s timeout, and the flow's own `Budget` capped by the turn budget. Extension mode cannot start a sub-chat; the coordinator inside a flow keeps its existing MAX_DEPTH and MAX_NODES limits.
- **Failure:** the Core answer stands, with the notice `extension_unavailable` (Case D).

### D.4 Extension contract `ext.v1`

- **Input:** `{invocation_id, conversation_id, turn_id, flow_key, flow_version, reason, question, core_summary (no rows), ceiling:{user_id, doc_ids (asker-readable ∩ attached), dataset_ids: []}, capabilities, budget:{llm_calls, tool_calls, seconds}}`
- **Output:** `{invocation_id, status: ok|refused|failed|cancelled|timeout, results:[document_evidence{doc_id, version, passage, locator} | finding{text, basis:[evidence refs]} | clarification_suggestion{question, options} | warning{code, text}], usage}`
- **Validation:** schema check; every `doc_id` must be inside the ceiling; numbers in `finding` that the Core did not verify are flagged and stripped; document text is treated as data and never as instructions.

### D.5 Unified answer envelope

`{conversation_id, turn_id, seq, status, blocks:[Text|Metric|Table|ChartRef|ChartDraft|Callout|Followups|Clarification|Refusal], evidence:{data:[GQS evidence], documents:[…], extensions:[invocation summaries]}, notices[], usage}`

The Analyst's flat fields map onto blocks. The existing `AnswerBlocks` rendering is reused.

SSE events:
- `status`, `plan`, `extension_progress`, `final` (the envelope) and `done`.
- `error` only before a turn is accepted.

### D.6 Permissions

| Action | Gate |
|---|---|
| Use Chat | `chat:view` |
| See or ask about a Dataset | EXPLORE on it (GQS) plus GovernAI scope |
| Use document evidence | the asker's Knowledge doc rights (no delegation in extension mode) |
| Use a flow as an extension | flow shared to the asker plus a chat binding |
| Bind a flow to Chat | `agent_flows:edit` (admin or builder) |
| Share a conversation | `chat:edit`, redacted on every read |
| Save a chart | `explore_charts:edit` |

---

## E. Migration and retirement

**Expand / migrate / contract, all in one release. There is no dual answering at any point.**

1. **Expand (additive migration):**
   - rename `analyst_sessions` → `chat_conversations` and `analyst_session_turns` → `chat_turns`, through additive copy and views if a rename is unsafe;
   - add `idempotency_key`, `envelope`, `origin` and `legacy_ref`;
   - create `chat_extension_invocations`;
   - add the resource type `chat_conversation`.
2. **Migrate (data migration, one-way and idempotent):**
   - every `agent_flow_chat_threads` row becomes a conversation (owner, title, timestamps);
   - every linked `agent_flow_runs` row becomes a read-only turn with `origin="flow_v0"`;
   - `CHAT_THREAD` and `ANALYST_SESSION` shares are copied to `chat_conversation` at the **same level**, and never widened.
   - The migration prints before/after counts for threads, runs, sessions, turns and shares, and fails if any count does not match.
3. **Contract (same release, code):**
   - `/api/v1/analyst/*` ask/session routes and `/api/v1/agent-flows/chat/*` are removed.
   - `/analyst` and `/analyst/s/{id}` become a 308 redirect to `/chat` and `/chat/c/{mapped id}`.
   - Old `?brain=` links open a new conversation with that flow pre-bound as an extension.
   - Old tables are dropped in a **later** release, after the report-demo backup and restore rehearsal.
4. **Rollback:** restore the previous image and DB backup. There is no runtime fallback.

**Before/after counts:**
- On the QA stack: produced by the migration test.
- On `report-demo`: produced only during the authorized operator deployment.

---

## F. PR graph and gates

| PR | Content | Depends on | Gate to merge |
|---|---|---|---|
| **A** | This contract (accepted), the superseded marks, and architecture tests that are **expected to fail** (strict xfail) for: Chat needs a Flow, a Flow data read without GQS, a second answering route, a duplicate session model, an Analyst toggle | — | docs plus xfail tests in CI |
| **B** | Chat Core: orchestrator, re-homed Data Core, `chat_conversations`/`chat_turns` expand migration, idempotency, the 5 states, envelope, budget authority, new `/api/v1/chat/*` routes (behind no flag; routes not yet linked from the UI) | A | PG tests, SQL oracles, authz-pg, alembic |
| **C** | Extension runner `ext.v1`, router, delegation off in extension mode, number check, injection tests | B | the Flow cases in §9.3 |
| **D+E** | **One PR, so `demo` never shows a half state:** data migration, removal of old routes and the module key, redirects, the unified `/chat` UI (no Flow required), Sidebar, i18n, CI architecture checks switched from xfail to enforced | B, C | full browser acceptance (14 journeys, 6 widths, VI/EN), BI regression, migration count test |
| **F** | Integrated acceptance on Docker built from the exact SHA, then the operator handoff for report-demo | D+E | evidence report |

PRs A, B and C are safe to merge to `demo` one at a time, because users still see today's UI until D+E.

**CI architecture checks (scripts/ci + guardrail invariants):**
- no `governed_query`-free data tool reachable from `ChatOrchestrator`;
- no route outside `api/chat` that writes `chat_turns`;
- no `brain_key` required by a `/chat` route;
- no `analyst` module key;
- no import of `run_for_chat_thread` from authenticated routes.

**Unchanged readiness labels:**
- Internal Preview is the target of this rework.
- Business Pilot still requires the independent ≥95% benchmark and a PO-approved model-cost operating budget. The QA $5 cumulative cap stays, and the ledger is not reset.

---

## G. As built (implementation reference)

This section names the real modules. Sections A–F above are the design and audit.

### G.1 Backend

| Concern | Where |
|---|---|
| The only chat API | `backend/app/api/chat.py`: `/api/v1/chat/*`, 11 routes, `module_floor("chat")` + `chat:view`, always mounted |
| Turn lifecycle | `services/chat/orchestrator.py`, `begin()` / `run()` / `cancel()` |
| Conversation store and read-time redaction | `services/chat/conversations.py` |
| The one envelope `chat.v1` | `services/chat/envelope.py` |
| Extension contract `ext.v1`: routing, invocation, validation | `services/chat/extension.py` |
| Data Core (moved from `services/analyst`) | `services/data_core/*`: every read is `GovernedQueryService.execute` on surface `chat` |
| Flow side of an extension | `services/agent_flows/dispatch.run_as_extension` + `permissions.extension_scope` |
| No Flow data reads | `ToolContext.data_reads_forbidden` → `DataReadForbidden` before ChartService |
| Storage | `models/chat_conversation.py`: `chat_conversations`, `chat_turns`, `chat_extension_invocations`, `chat_feedback`; share type `chat_conversation` |
| Migration | `alembic/versions/20261027_0001_unified_chat.py`: additive DDL plus frozen, idempotent, reconciled legacy import |

**Turn lifecycle (`orchestrator.py`):**
- `begin()` admits a turn:
  - checks access;
  - applies the operator switch `AI_CHAT_ENABLED` (503);
  - replays an idempotency key;
  - allows one running turn per conversation;
  - enforces the per-person ceilings (`AI_CHAT_TURNS_PER_USER_DAY`, `AI_CHAT_MAX_RUNNING_PER_USER`) under a per-user advisory lock, before any model call.
- `run()` executes the turn in this order:
  1. the Data Core in a worker thread, with stop checkpoints before the model and before every governed read;
  2. `extension.decide`;
  3. the bounded extension;
  4. one conditional terminal write.
- `cancel()` uses the same conditional write, then cancels the governed read through the ledger.
- The turn runs as a server task, so leaving the page does not lose it.

**Conversation store (`conversations.py`):**
- Every read re-derives the viewer's data catalog and readable Knowledge documents. A turn whose Datasets, fields or cited documents the viewer cannot read now is `redacted`.
- Access levels are owner, full, edit and view. A missing conversation returns 404.
- A turn left running longer than `AI_CHAT_TURN_STALE_SECONDS` becomes `failed/interrupted`.

**The envelope (`envelope.py`):**
- Terminal states: `answered`, `clarification_required`, `refused`, `failed`, `cancelled`.
- Sections:
  - `data`: the Data Core response, the only source of numbers;
  - `supporting`: the validated extension result;
  - `legacy`: an imported turn, as it was;
  - `notices`.
- The stored copy carries no choice tokens and its rows are capped.

**The extension (`extension.py`):**
- **When it runs:**
  - `explicit`: the person ticked "also check documents";
  - `document_need`: a deterministic lexical detector found a document question;
  - `core_unsupported`: the Core found no data question it could answer.
- **When it never runs:** a plain data question, a clarification, a failure or a cancel.
- **Bounds:** at most one invocation per turn, `AI_CHAT_EXTENSION_TIMEOUT_SECONDS`, and model and tool calls capped by `AI_CHAT_EXTENSION_MAX_LLM_CALLS` / `_MAX_TOOL_CALLS`.
- **What is accepted:**
  - only document citations inside the ceiling;
  - flow metric, table and chart blocks are dropped;
  - a finding needs a document behind it, and its text is kept verbatim with any unverified figures listed;
  - a malformed result counts as `failed/invalid_output`.
- **Audit:** every invocation is a `chat_extension_invocations` row (reason, ceiling, status, warnings), and its Flow run is recorded in `agent_flow_runs` with trigger `chat_extension`.

**The Flow side of an extension (`run_as_extension`):**
- It re-checks the flow's share to the caller, the published status, the reader rollout policy and the key.
- It has no data, no charts, no memory, and no delegation. Its document ceiling is attached ∩ owner-readable ∩ caller-readable.

### G.2 Retired, not merely hidden

**Retired:**
- `api/analyst.py` (11 routes);
- `modules/agent_flows/chat_api.py` (7 routes);
- `dispatch.run_for_chat_thread`;
- the `direct_chat` thread functions;
- `chat_quota.py`;
- `services/analyst/sessions.py`;
- the `analyst` permission module;
- the `ANALYST_ENABLED` / `ANALYST_PILOT_ALLOWLIST` / `NEXT_PUBLIC_ANALYST_ENABLED` / `DIRECT_CHAT_RUNS_PER_DAY` settings;
- in the frontend, `components/analyst/*`, `ChatModule`, `ConversationView`, `AssistantCatalogue`, `lib/directChat.ts`, `lib/api/analyst.ts`, and the Analyst sidebar entry and flag.

**Kept on purpose:**
- the `ANALYST_*` tunables (rows, budgets, planner model and replay) and the `analyst_feedback` / `analyst_session*` / `agent_flow_chat_threads` tables, which are read by the migration only and dropped in a later release after the operator's restore rehearsal;
- `chat_thread` / `analyst_session` as non-shareable legacy share types.

### G.3 Old addresses

| Old | Now |
|---|---|
| `/analyst` | redirects to `/chat` |
| `/analyst/s/{id}` | resolves through `GET /api/v1/chat/legacy/analyst_session/{id}`, then `/chat/c/{new id}`; resolves only for someone who may read it |
| `/chat?thread={id}` | resolves the same way through `flow_thread` |
| `/chat?brain={key}` | starts a conversation with that add-on preselected |

No old address ever answers a question.

### G.4 Studio preview (ADR-3 revised)

Studio preview (`run_preview`) stays on the Flow engine as the author's diagnostic. The public Dashboard AI Bot no longer does: see section H.

### G.5 Test-only switches (refused in production)

- `ANALYST_PLANNER_REPLAY_PATH`: replays the Data Core planner's model output.
- `AI_CHAT_EXTENSION_REPLAY_PATH`: replays an extension flow's model output. Every gate and validation around it still runs.

---

## H. The public Dashboard AI Bot and the central AI runtime (PO directive 2026-10-28)

### H.1 Call paths

| Consumer | Route | Turn owner | Data scope | Final answer |
|---|---|---|---|---|
| AI Chat | `POST /api/v1/chat/conversations/{id}/turns` | `services/chat/orchestrator.py` | `GovernedScope` (GQS, asker) | the Core |
| Dashboard AI Bot | `POST /api/v1/public/dashboards/{token}/ai/answer` | `services/answer_core/public_turn.py` | `PublishedReportScope` (published charts) | the Core |
| Optional add-on (both) | - | the consumer's turn | none (`data_reads_forbidden`), documents only | never |

Retired (410 Gone): `/public/dashboards/{token}/ai/agent/chat` (Flow-first answering), `/ai/briefing/brief` and `/ai/agent/explore` (second answering engines on the public link), `/dashboards/{id}/ai/suggest-system-prompt` (a paid call outside every budget). No viewer route reads `X-User-Ai-Key`.

### H.2 The public turn

`begin` (admission before anything is spent: question size, idempotency key -> the same turn, one running turn per viewer conversation, a per-link running cap, the link's USD/turn pre-check, fail closed) -> `run` (the Core in a worker thread on its own session, the link re-authenticated there; optional add-on) -> ONE terminal write (`WHERE status = 'running'`, so Stop and an answer cannot both win). `public_answer_turns` holds the turn, the envelope the viewer got, the plan a follow-up refines (re-validated against the link's catalog), and the viewer's rating.

### H.3 The Model Gateway (`services/ai_runtime/gateway.py`)

Every paid model call - the Core's planner (AI Chat and the public bot), an Agent Flow step (`runtime/handlers/agent.py::_stream`), any other `LLMClient` user - reserves its worst case in `ai_usage_ledger` under a transaction-scoped advisory lock on every scope it bills (global, user, public link, turn), is clamped to the output-token cap, and settles with the reported usage; an error after sending keeps the worst case. A ledger that cannot be read refuses the call. Ceilings: `AI_GLOBAL_USD_PER_DAY`, `AI_USER_USD_PER_DAY`, the link's `ai_bot_budget_usd_per_day` (never unlimited), `AI_MAX_MODEL_CALLS_PER_TURN`, `AI_MAX_USD_PER_TURN`, `AI_MAX_OUTPUT_TOKENS_PER_CALL`, `AI_MAX_INPUT_TOKENS_PER_CALL`.

### H.4 Credentials

Server-side only: the deployment's provider keys, or a public link's own key held in the encrypted credential store (`ai_provider_credentials`) and referenced by `ai_bot_credential_id`. Migration `20261028_0001` moves any plaintext `appearance_config.ai_bot_key` there (idempotent; downgrade restores). The credential a turn uses and the budget it spends belong to the same billing principal (the link). A key that was ever stored in plain text should be rotated at the provider.
