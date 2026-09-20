# Agent Flow + AI Chat rework — implementation plan

**Wave A (Phases 0, 1, 2) is IMPLEMENTED** on `feat/agent-flow-chat-rework`.
Phases 3 onward are still proposals awaiting approval.

| Phase | Status | Commit |
|---|---|---|
| 0 — Governance | **shipped** | `0e0ab44` |
| 1 — Answer parity | **shipped** | `5d376fa` |
| 2 — Node topology | **shipped** | `1507b96` |
| — reviewer fix | **shipped** | `06d94b7` |
| 3 — Reader-safe capability | proposed | — |
| 3.5 — Debugging loop's last hop | proposed | — |
| 4 — Decompose mega-components | proposed | — |
| 4.5 — Canvas / a11y | proposed (unblocked: minimum viewport = 1280px) | — |
| 5 — Vocabulary and polish | proposed | — |

## Where Wave A departed from this plan

Recorded because a plan that quietly stops matching the code is worse than none.

1. **`register()` guards the opposite way round.** The plan said a structural type
   with no child slots is refused. Implementing it caught `filter` — which is
   `structural` because it has *no handler*, not because it holds nodes. The flag
   conflates two things, so the guard now refuses a type that declares slots and is
   NOT structural, and the real rule (every container declares its slots) moved to
   `test_node_child_slots.py`, where it can introspect the models instead of
   guessing from a flag.

2. **Per-type presentation deliberately stayed per-type.** The plan implied the
   canvas and inspector would read the declaration throughout. Only the *topology*
   was duplicated — a specialist lane showing its `when` and an if-path showing its
   condition count are real differences, and flattening them would have been the
   oversized framework the plan warned against. The canvas and edge generator
   dispatch on `isContainer`/`isBranching`; what each lane *says* is untouched.

3. **The frontend keeps its own `CHILD_SLOTS`, cross-checked rather than served.**
   The plan had the frontend consume `/nodes`. The builder also needs the
   `containerPath` token (`path`/`case`/`specialist`/…), which is canvas routing the
   backend has no notion of — so pushing it into the contract would have leaked a
   frontend concern into the model layer. The two declarations are held in step by
   `npm run qa:node-topology`, mutation-tested by deleting `coordinate` from the
   backend table.

4. **Phase 1's stated risk was wrong.** "AnswerBlocks may assume a chat-only
   context" — it does not; it imports React, icons, `cn` and the type, and takes an
   optional `onOpenChart`. The real residual risk was `default: return null`
   silently dropping an unknown variant on every surface, which Phase 1 fixed while
   it was in the file.

5. **The `agent_flow_answer_parity` invariant needed two attempts.** Keyed on a
   fragment it fired on the doc comment quoting the bug; tightened to the full
   idiom it spanned two lines and a diff carries only changed lines, so it passed a
   real reintroduction. Both caught by mutation-testing (`06d94b7`).


## Correctness/foundation pass — what actually shipped (2026-09-20)

Commits `c1a5c3c` (Wave 1), `a1c97c7` + `52add2a` (Wave 2), `1b78ea8` (CI + the
defect CI found). Recorded here rather than in a new document.

### Invariants now enforced, each with the test that locks it

| Invariant | Locked by |
|---|---|
| A shaping step cannot change whether a tool succeeded | `test_read_status_survives_compaction.py` |
| A diagnostic only recommends an action that applies to current state | `test_diagnostics_tell_the_truth.py` |
| One definition of "all descendants"; Loop semantics stay explicit | `test_tree_validation_is_canonical.py` |
| A nested credential behaves exactly like a top-level one | `test_nested_specialist_credentials.py` |
| Authoring is strict; reading stored flows stays tolerant | `test_authoring_is_strict.py` |
| Resolution may narrow scope, never widen it; ambiguity stays visible | `test_asset_resolution.py` |
| Report order is never silently presented as question relevance | `test_report_read_selection_is_explicit.py` |
| A green step either reaches the next model or its absence is recorded | `test_context_handoff.py` |
| Absence of evidence is not evidence of support | `test_no_evidence_no_confident_number.py` |

### Three things worth keeping in the record because they cost time

**A green suite that could not see the feature.** Wave 2's resolver was handed the
RunContext instead of the ToolContext and the whole question-matching path died at
runtime — while its unit tests passed, because they stubbed both searches and
passed `object()` as the context. Fixed by deleting the parameter that was wrong:
the resolver takes an injected `call(name, args)` and there is no context to pass
incorrectly. Found by driving the browser, not by reading the diff.

**A Definition of Done that could not predict CI.** `verify.py task` resolves what
to run from `guardrail_rules.yaml`; 23 of the 51 suites CI ran were named by no
gate, so a green local run said nothing about 45% of the CI surface. 20 are now
registered as `agent_flow_surface`; the remaining 3 are named by an advisory
check. This is the same "two differently-shaped sets" family as the five
deployment-shape defects, one level up.

**A constant that outlived its twin.** `_DOWNSTREAM_CHARS = 2000` in the read
handler mirrored `_MAX_STEP_CHARS` by hand. Wave 2 replaced the latter and the
author-facing notice went on quoting a ceiling that no longer existed — exactly
what the test guarding it predicted in its own docstring. One `HANDOFF_CHARS`
now, in the module that owns the handoff.

### Closure pass (2026-09-20) — the three blockers

**Notice audience is a boundary, not a style.** `reader_notices()` drops author
diagnostics in both READER dispatch paths and in the stored-thread replay (which
covers turns written before the field existed); `run_preview`, the author path,
filters nothing. The frontend refuses them again. Four `{code,text}` copies became
one `FlowNotice`; Studio Test and Runs show "what the reader sees" and "author
diagnostics" as separate lists.

**The unperformable remedy was removed, not built.** "Chỉ định danh sách biểu đồ"
pointed at a control the builder does not have. No endpoint was added: a chart id
belongs to one report while a flow is meant to stay reusable across bindings, so a
picker persisting a raw id would bake hidden report-specific coupling into a
portable object. `chart_ids` stays for compatibility. The remaining remedies are
portable, and a test names the CONTROL that performs each one.

**Two suites adopted by dependency tracing.** `test_verifier_false_alarms` guards
the verifier Wave 2's evidence check calls; `test_module_floor` guards
`module_floor('chat')`. `test_knowledge_hit_contract` was traced, has no import
path from agent_flows, and stays in the repo-wide backlog rather than being
adopted to tidy a count.

**read_exceeds_context: re-measured, and the re-measurement found a real defect.**
The reported shape is gone (8 charts compact = 1,793 chars against an 8,000
ceiling). But the genuinely-oversized case exposed something the context module's
own docstring denied: the reducer halved the BIGGEST array, which on a Report Read
result is `charts` itself — a 13-chart read reached the answering step as ONE
chart with every row intact. Bulk now goes before identity.

**Found reviewing this pass's own diff:** a value import put `apiClient` in the
public dashboard bundle (`public_client_only` is file-scoped and could not see
it). Helpers moved to a dependency-free `lib/notices.ts`; `qa:public-bundle` now
walks the import graph from both public entry points.

### Still open, named

- A PRE-EXISTING chain reaches the authed client from the public page:
  `PublicDashboardView -> use-public-filter-distinct-values -> use-dataset-model
  -> api-client`. Reported on every `qa:public-bundle` run; owned by the
  dashboards/public-link area, not by Agent Flow.
- Repo-wide test ownership debt: committed suites referenced by no runner, and
  three suites CI runs whose owner is not clear. Named by the verifier every run.
- `direct_chat_module_floor` cannot run on a machine whose FastAPI is newer than
  the pinned 0.109.0; declared `requires: pinned-fastapi` and run by CI.

### Wave 3 — DESIGN backlog, none implemented

1. **Binding-aware explicit asset selection** — flow requirement / logical role,
   resolved per binding to a physical chart, instead of a report-specific id
   persisted on a portable flow. This is what the removed remedy needs.
2. Reusable Subflow / Specialist.
3. Safe parallel fan-out (preconditions unchanged: independent state writes,
   deterministic merge, budget accounting, trace ordering, evidence merging,
   cancellation/timeout).
4. Durable checkpoint / background execution.
5. Human Approval for side-effecting tools.
6. Agentic builder.
7. MCP / capability boundary.

## Guardrail scoping

Run before writing this section, pasted verbatim:

```bash
python scripts/ci/guardrail_check.py \
  --plan "Rework Agent Flow Studio authoring UX and share node topology model with Direct Chat" \
  --files frontend/src/components/agent-flows/NodeInspector.tsx \
          frontend/src/lib/agentFlows.ts \
          backend/app/services/agent_flows/runtime/nodes.py \
          backend/app/modules/agent_flows/chat_api.py
```

- **Verdict:** `warn` — **and the warn is a false positive.**
- **Features / subsystems touched:** `auth_permissions` — matched because the word
  "**auth**oring" contains the substring "auth". Owner files it named
  (`api/auth.py`, `api/permissions.py`, `core/dependencies.py`, `lib/auth.ts`,
  `hooks/use-permissions.ts`) have nothing to do with this work.
- It declared **all four real files** `out_of_scope` — "own none of the matched features".
- Re-run with the same files and the word "authoring" removed:

```
--plan "Rework Agent Flow Studio node editing UX and share topology model with Direct Chat"
verdict         : unknown
matched_features: []
findings        : ['UNKNOWN: issue text matched no feature keyword — cannot judge scope.']
```

- **Protected subsystems involved:** none reported. Semantic layer and public-link
  security are not touched by this plan.
- **Required tests it named:** `import_smoke`, `tsc`. That is all it knows to ask for.

**The honest reading:** `agent_flows` and `direct_chat` are not among the guardrail's 11
registered features, so for this subsystem the guardrail is **UNKNOWN**, and per
CLAUDE.md unknown is not safe. Recording it here rather than letting it disappear. Phase 0
fixes it, which is why Phase 0 is first.

## Revised phase order (round 2)

The round-1 principle holds - *preserve proven runtime behaviour -> fix correctness and
governance -> reduce structural fragility -> improve authoring information architecture ->
visual polish last*. What moved:

| | Round 1 | Round 2 | Why |
|---|---|---|---|
| Phase 0 governance | "first, and separately" | **BLOCKING before Phase 1** | 12 in-area tests never run; two lock the exact classes later phases risk |
| Phase 1 shared renderer | "highest severity" | same position, **different justification** | reproduced but rare (4/53 nodes); kept early because it is *cheap* (F21), not urgent |
| Capability projection | Phase 3, "a projection" | **re-scoped, harder** | F28: unsafe as designed; needs surface-aware recomputation, not field mapping |
| Debugging loop | not planned | **new Phase 3.5, small** | F23: the loop is designed; only its last hop is missing |
| Canvas / inspector / a11y | not specified | **new Phase 4.5, gated** | F24-F27 measured it; the fix depends on a product decision |

## Phases

Each phase leaves the product usable and is independently revertible. Structure and
behaviour stabilise before any visual redesign — `audit.md` F10 is the argument.

---

### Phase 0 — Governance wiring (no product change) — **SHIPPED** `0e0ab44`

**Goal.** Make the safety net real before changing anything behind it.

**Blocking, not merely first.** `scripts/ci/audit_test_reachability.py` reports 12
Agent Flow / Direct Chat tests referenced by no runner. They pass locally (198 tests).
Two of them - `test_coordinator_is_visible_to_the_flow.py` and
`test_chat_thread_sharing.py` - lock exactly what Phase 2 and the capability work risk
breaking. Starting Phase 1 before this is starting without the net.

**Scope.** Wire the 12 tracked-but-unrun in-area tests into CI. Register `agent_flows` and
`direct_chat` as guardrail features with owner files and keywords. Fix the "auth"
substring match if the rule format allows word-boundary keywords.

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `.gitignore` | CI | allow-list the **12** in-area tests (tracked via `git add -f`, never allow-listed - F19/F29) |
| 2 | `.github/workflows/backend-contract-tests.yml` | CI | add the 12 to the pytest list |
| 3 | `scripts/guardrail/guardrail_rules.yaml` | governance | add `agent_flows` + `direct_chat` features: owner files, keywords, required tests |
| 4 | `scripts/ci/verify.py` | CI checker | close the blind spot: report **tracked** test files that no CI workflow references, not only allow-listed ones |

Row 4 is the one that matters beyond this feature. Today the check compares allow-list
against workflow - two sets that happen to be identical - and is silent about the 43
tracked tests in neither. It should report them. **Fixing the checker is in scope;
wiring up the other 31 tests is not** (F19/F29), and the checker will then say so out
loud on every future run.

**Must not change.** No product behaviour whatsoever. No test content edited - the 12
pass as they are (verified: 198 passed in 15.68s).

**Acceptance.** `guardrail_check.py --files backend/app/services/agent_flows/...` returns
a real verdict naming `agent_flows`, not `unknown`. "authoring" no longer matches
`auth_permissions`. `audit_test_reachability.py` reports **0** in the Agent Flow
bucket; the other 31 stay reported and out of scope.

**Non-goals.** Wiring the 31 out-of-area ghost tests. Editing any test's content.

**Tests.** `python scripts/ci/guardrail_check.py --health` stays healthy; the 12 newly
wired tests pass in CI on the first run after merge.

**Risks.** Adding tests to CI could reveal they fail *in CI* though they pass locally —
which is exactly the class of gap found earlier this session (pgvector, module flag). That
is a discovery, not a regression, and Phase 0 is the right place to absorb it.

**Unverified.** Whether the guardrail rule format supports word-boundary keyword matching.
If it does not, the false positive is reported rather than fixed, and I will say so.

---

### Phase 1 — One answer renderer — **SHIPPED** `5d376fa`

**Goal.** The author sees what the reader sees.

**Re-justified.** Reproduced in the browser - run `ok`, answer renders the em-dash, no
notice (`.artifacts/audit/F6-emdash-reproduced.png`). But 4 of 53 agent nodes use
`json` and nothing currently ships a typed-block answer, so this is **correctness and
robustness debt, not an active bug**. It stays early because F21 makes it small, and
because F20 shows an unknown variant is dropped silently on *every* surface.

**Non-goals.** RunsTab parity - run history stores prose, not blocks (F22); that needs
a schema change this plan does not make.

**Scope.** `TestChat` renders the answer envelope through the same shared component Chat
uses. Author-only context (route warning, coverage gaps, citations, trace) stays around
it.

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `frontend/src/components/dashboards/AnswerBlocks.tsx` | FE shared | already the single renderer for 2 of 3 surfaces (201 lines, surface-agnostic); make `default:` a visible fallback instead of `null` |
| 2 | `frontend/src/components/agent-flows/TestChat.tsx` | FE Studio | replace the flatten-to-`.markdown` at :317-318 with `AnswerBlocks`; distinguish "zero blocks" from "no answer" |

**Must not change.** The envelope contract. Chat's rendering. The route-warning position
above the answer. Citation cards. Trace and cost display.

**Acceptance.** One flow emitting a `metric` block renders identically in the Studio test
panel and `/chat`. Grep shows no second block-rendering implementation. A zero-block
answer says so instead of printing `—`.

**Tests — decided now.**

| Test | New/existing | What it locks |
|---|---|---|
| FE unit or E2E on the shared renderer with all 6 block variants | **new** | every variant renders; an unknown 7th variant renders a fallback, never blank |
| `e2e/tests/` Studio-test-panel spec | **new** | an author running a JSON-output flow sees the rendered block, not `—` |
| `npx tsc --noEmit` | existing | the narrowed local `blocks` type is gone |

**Verification (runtime, not source).** Build and restart; open a flow whose answer node
uses `output_format: 'json'`; run it in the test panel; open the same flow in `/chat`;
compare the two answers side by side. Reading the diff does not count.

**Risks.** Round 1 listed "AnswerBlocks may assume a chat-only context" - **measured
and wrong** (F21): it imports only React, icons, `cn` and the type; `onOpenChart` is
optional and `renderMarkdown` is injectable. Residual risk is low. The real one is that
`default: return null` keeps an unknown variant silent; Phase 1 should turn that into a
visible fallback while it is in the file.

---

### Phase 2 — Declare node topology once — **SHIPPED** `1507b96`

**Goal.** Adding a structural node type is one registration, not thirteen edits.

**Scope.** Extend `NodeSpec` with child-slot declarations; expose them on `/nodes`; make
the frontend walkers consume them. This **extends an existing abstraction** rather than
introducing a second one — the registry already exists and the palette already consumes it.

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/.../runtime/nodes.py` | BE registry | add `child_slots` to `NodeSpec`; declare for `if`/`switch`/`coordinate`/`loop`; `register()` refuses a `structural` type with no slots |
| 2 | `backend/.../contract.py` | BE | `all_nodes()` walks by declared slots instead of its hand-written chain |
| 3 | `backend/app/modules/agent_flows/api.py` | BE api | `/nodes` returns `child_slots` (additive) |
| 4 | `frontend/src/lib/agentFlows.ts` | FE contract | `NodeSpec.child_slots`; the 5 walkers become slot-driven |
| 5 | `FlowCanvas.tsx`, `useFlowEdges.ts`, `BrainBuilder.tsx`, `TestChat.tsx` | FE | consume slots instead of local type branches |

**Must not change.** Graph semantics. Which nodes run in what order. Edge layout output.
Insert/move/drop rules. The golden replay must show **zero** drift.

**Acceptance.** `grep "type === 'if'\|'switch'\|'coordinate'\|'loop'"` over the five
walkers returns nothing. `register()` refuses a structural type without slots. 16 replay
fixtures unchanged.

**Tests — decided now.**

| Test | New/existing | What it locks |
|---|---|---|
| `backend/tests/test_agent_flow_replay.py` | existing | **no semantic drift** — the primary guard for this phase |
| `test_coordinator_is_visible_to_the_flow.py` | existing (wired in Phase 0) | the F2 bug stays fixed |
| new: structural node without slots is refused at registration | **new** | the `all_nodes()` comment becomes an executable rule |
| new: FE node-type union == backend registry types | **new** | the F18 gap — FE and BE cannot silently diverge |
| `test_flow_coordinate.py`, `test_tool_node.py`, `test_flow_type.py` | existing | container behaviour unchanged |

New backend tests must be added to the `.gitignore` allow-list **and**
`backend-contract-tests.yml`, then `git add -f`-ed, or CI never runs them.

**Risks.** This touches the traversal every authoring check depends on — the single
highest-blast-radius change in the plan. It is sequenced after Phase 0 precisely so the
coordinator test is running in CI before it starts. Golden replay is the tripwire.

---

### Phase 3 — A reader-safe capability summary (re-scoped after F28)

**Goal.** A reader can see what an assistant is for, and what it cannot do, before asking.

**Scope.** **Not a projection.** F28 proved the raw `coverage()` output leaks
`unreadable_sources[].ref` (document ids), `step` (node keys) and tool names, and would
advertise report-reading capability on a surface that has `dashboard_id=0` and an empty
chart allowlist. This phase builds a **surface-aware recomputation** carrying only
static question-class metadata - see `spec.md` section 4.1.

**Non-goals.** Naming the sources an assistant reads; that needs a per-reader
permission check and gets its own phase, or does not ship.

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/modules/agent_flows/chat_api.py` | BE api | `/chat/brains` returns `capability` (additive), inside the flag block, `view` gate |
| 2 | `frontend/src/lib/directChat.ts` | FE contract | `ChatBrain.capability` |
| 3 | `AssistantCatalogue.tsx` | FE chat | lead with purpose + can/cannot; demote inventory counts |
| 4 | new pre-conversation view (or an expanded card) | FE chat | limits + suggested questions before the first message |

**Must not change.** Thread creation, SSE, per-turn permission re-resolution, share
semantics, `BLOCK_MESSAGES`.

**Acceptance.** Catalogue shows can/cannot per assistant. An assistant with no
`detect_anomaly` says it cannot answer anomaly questions *before* a reader asks one.
Conversation count is no longer the lead metric.

**Tests — decided now.**

| Test | New/existing | What it locks |
|---|---|---|
| new: serialised payload carries no `tools`/`pack`/`needs_any_of`/`step`/`ref`/`unreadable_sources` | **new** | **security** - asserts the shape, not the intention |
| new: chat capability excludes report-reading classes | **new** | proves the recomputation is real, not a copy of the author's view |
| new: capability matches `coverage.py` for a known flow | **new** | the projection cannot drift from the computation |
| `test_chat_thread_sharing.py` | existing (wired in Phase 0) | share/read-only unchanged |
| `test_chat_chart_scope.py` | existing | chat scope unchanged |

**Risks.** **Data exposure.** Capability describes what an assistant reads; naming a
knowledge document or chart a reader cannot otherwise see would be a leak. This is the
one place in the plan with a genuine security surface, and it gets an explicit test
rather than a review note.

**Verification.** Two accounts — one the assistant is shared with, one not — and confirm
the second sees no capability detail at all.

---

### Phase 3.5 — Close the debugging loop's last hop (new, small)

**Goal.** From "this node is responsible" to "edit this node", without hunting for it.

**Evidence.** F23: Runs / Feedback / Activity are a designed loop, not three tabs of data.
The only missing joint is that `RunsTab`'s canvas is deliberately read-only and offers no
route into the builder at that node. `TestChat` already does the equivalent (`onOpenRun`).

**Scope.** An "open in builder" affordance from a selected step. Nothing else.

**Must not change.** The read-only canvas stays read-only - *"a run is a record, not a
place to edit the flow"* is a correct decision. This adds a door, not an editor.

**Acceptance.** From a failed run, an author reaches the responsible node in the builder in
one action.

**Tests.** E2E: run a flow, open the run, jump to the node, confirm the builder opens with
that node selected.

**Risks.** Low. Additive navigation.

---

### Phase 4 — Decompose the two mega-components

**Goal.** Make the authoring surface editable again.

**Scope.** `NodeForm` (708 lines, 14 types) → per-type editors behind a registry-driven
shell. `BrainBuilder` (717 lines, 31 `useState`) → extract state concerns.

**Must not change.** Visible layout and behaviour. This is a boundary change; any visual
change belongs to Phase 5. Undo, drag/drop, inspector resize, publish flow all behave
identically.

**Acceptance.** No function over ~200 lines in `NodeInspector.tsx`. Adding a node type
adds a file rather than editing a switch. E2E builder specs unchanged and passing.

**Tests.** Existing `e2e/tests/builder.spec.ts` + `layout.spec.ts` are the guard — they
already assert save-then-reload and inspector usability. `tsc` clean.

**Risks.** Pure-refactor phases are where silent behaviour loss happens. Mitigated by
doing it *after* Phase 2, so the node model is already declarative, and by leaning on the
E2E specs — credible as of 2026-09-15, when the workflow went green (`73d4c7a`).

---

### Phase 4.5 — Canvas, inspector and accessibility (new; GATED)

**Goal.** A coordinator is readable at the declared minimum width, and a 24-node flow is
navigable.

**GATED on open question 6** - the minimum supported viewport is a product decision and
the layout fix depends on the answer. Do not start before it is answered.

**Evidence, all measured.** 3.5 screens of scroll for 24 nodes with 6 visible; third
specialist lane 64% clipped at 1440 and 2 of 3 lanes clipped at 1280; inspector fixed at
700px even in a 400px viewport; `min-w-[860px]` on canvas content; no `aria-label` or
selected-state on node cards; 99 tab stops to the last node; 24 sub-24px targets.

**Scope.** Inspector width behaviour, canvas horizontal allocation, a navigation aid for
long flows, and the four accessibility items in `spec.md` section 5.6.

**Non-goals.** Chat responsive work - verified clean at 400px. A mobile Studio layout.

**Must not change.** Graph semantics, the node model, run-overlay behaviour.

**Acceptance.** As stated in `spec.md` sections 5.5 and 5.6, as numbers.

**Risks.** The phase closest to a visual redesign and the easiest to let sprawl.
Deliberately placed after the structural phases and behind a product decision.

**UNVERIFIED going in.** Keyboard node reordering; minimap interaction; behaviour at
`MAX_NODES = 40` (largest real flow is 24 nodes); coordinators beyond three specialists.

---

### Phase 5 — Vocabulary and visual polish

**Goal.** One vocabulary; then, and only then, the visual pass.

**Scope.** Retire "Brain" as a user-facing word. Rename the `coverage` canvas prop to
`runCounts`. Visual hierarchy, density, empty/error states, canvas readability.

**Must not change.** `brain_key`, `/brains`, database columns, API shapes.

**Acceptance.** No user-visible "Brain". "Coverage" means one thing. `grep brain_key`
unchanged in count.

**Risks.** Author muscle memory; i18n catalogue churn across `en`/`vi`.

**Unverified — gating this phase.** Every UX judgement behind it is marked
**[INFERENCE]** in `audit.md` §8. Phase 5 should not be specified in detail until the
rendered UI has been driven in a browser, ideally with a real author. I am not going to
design a visual redesign from source reading.

---

## Risks across the whole plan

| Risk | Shows up as | Caught by |
|---|---|---|
| Slot-driven traversal changes graph semantics | wrong branch runs; a lane goes invisible again | golden replay (16 fixtures), `test_coordinator_is_visible_to_the_flow` |
| Capability projection leaks a name | a reader sees a chart/doc they cannot open | new scope test (Phase 3), two-account manual check |
| Shared renderer assumes chat context | Studio test panel crashes or shows a raw id | new E2E (Phase 1) |
| Refactor loses behaviour silently | undo/drag/publish subtly broken | builder + layout E2E (Phase 4) |
| ~~E2E is currently red~~ | ~~Phase 4's safety net is not actually running~~ | **resolved 2026-09-15 — green, 35 specs (`73d4c7a`)** |
| Guardrail still unknown | a wrong-layer change is not flagged | Phase 0 |

## Verification

Per phase, on a **running build** (rebuild + restart, then drive the UI) — reading source
is not verification, and a stale standalone build is a recurring false green here:

- Phase 1 — same flow, both surfaces, answers compared side by side.
- Phase 2 — `python scripts/agent_flow_replay.py --verify` → 16 fixtures, no drift; then
  build a flow with a coordinator and confirm its lane is still walked.
- Phase 3 — two accounts, one without access.
- Phase 4 — full builder journey by hand: create → add → branch → configure → test →
  publish.
- Every phase — `python scripts/ci/verify.py task`, and every gate printed under
  `NOT VERIFIED` named in the report.

## Rollback

No migration, no destructive change, nothing unrecoverable.

- Phases 1, 3, 4, 5 — revert the commit; frontend only, or additive API fields an older
  client already ignores.
- Phase 2 — the risky one. Revert restores the hand-written walkers. The `/nodes`
  `child_slots` field is additive and harmless if left.
- Phase 0 — reverting re-hides 8 tests, which is the status quo.

## What remains unverified going in

1. The rendered UI. All [INFERENCE] findings — this is why Phase 5 is last and deliberately
   under-specified.
2. `RunsTab` / `FeedbackTab` / `ActivityTab` — not audited in depth; no changes proposed.
3. Large-flow behaviour at `MAX_NODES = 40`.
4. Accessibility and responsive behaviour — not audited, not specified.
5. How common `output_format: 'json'` is in real flows — changes Phase 1's priority, not
   its correctness.
6. ~~The E2E workflow is currently red for unrelated reasons...~~ **Closed 2026-09-15.**
   Not unrelated and not unconfirmed: the frontend middleware verifies the session JWT
   against `process.env.SECRET_KEY`, the backend signs with a different default, and the
   job set neither — so every authed page redirected to /login and 13 specs reported it as
   missing UI. Fixed in `73d4c7a`; green, 35 specs. Phase 4's dependency is met. The
   lesson generalises past this entry: **five** defects on this branch were one shape — a
   workflow running a differently-shaped deployment than the one that ships — and each
   presented as a product bug. Two checks in `verify.py` now cover that shape.
