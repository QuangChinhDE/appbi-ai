# Agent Flow + AI Chat rework — intent

**Status:** draft — awaiting approval, nothing implemented
**Owner:** chinh.bui02@base.vn
**Date:** 2026-09-15

Evidence for every claim here is in `audit.md`, with each finding marked
**[PROVEN]** / **[OBSERVED IN BROWSER]** / **[HISTORY]** / **[INFERENCE]**.
Round 2 closed the six unaudited areas and **changed three round-1 findings**; see
`audit.md` section 8.

## Problem

Four concrete problems, not a feeling that the UI is ugly.

**1. The test loop shows the author a degraded answer.** `TestChat.tsx:317-318` flattens
the answer envelope to `.markdown` and drops every other block type. The contract has six
(`text`, `metric`, `table`, `chart_ref`, `callout`, `followups`). Chat renders all six
through the shared `AnswerBlocks`; the Studio test panel renders none of the non-text
ones, and when every block is non-text it prints `—`. An author using
`output_format: 'json'` — which `handlers/agent.py:1210` exists to support — tests their
flow, sees an em-dash, and has no way to learn why.

**Reproduced in the browser (round 2):** run status `ok`, 4,136 tokens, answer renders
`-`, no notice that a block was dropped
(`.artifacts/audit/F6-emdash-reproduced.png`). **But measured usage reclassifies it**:
4 of 53 agent nodes use `json`, nothing currently ships a typed-block answer, and the
model returns `text` unless explicitly asked for a block type. This is **correctness and
robustness debt, not an active user-facing bug** - it stays early because it is cheap,
not because users are hitting it. **[OBSERVED IN BROWSER]**

**2. Adding a structural node means teaching ~13 places the same topology.** The backend
`NodeSpec` records *that* a node is structural but not *where its children live*, so the
four container shapes are re-derived by hand in 47 frontend branches across 12 functions
and 13 more backend mentions. This has already cost a measured production bug: a
coordinator's lane was invisible to every authoring check at once, and the flow answered
*"13,591,643.70"* — the report's grand total — to "which category earned the most".
`all_nodes()` carries the post-mortem; the fix is a comment saying the next person must
remember. **[PROVEN + HISTORY]**

**3. A Chat reader is told inventory, not capability.** The catalogue shows assistant
count, conversation count and source count. Meanwhile `coverage.py` already computes —
deterministically, from the registry and the flow, with no model and no drift — *what
classes of question this assistant can and cannot answer*. That computation is sent to
the author and never to the reader. The person asking the question is the one who needs
it. **[PROVEN]**

**4. The guardrail does not know this subsystem exists.** `agent_flows` and `direct_chat`
are not among its 11 registered features, and **12 Agent Flow / Direct Chat tests are
committed but referenced by no runner** - including the one locking problem 2, and the one
locking read-only chat-share enforcement. All 12 pass locally (198 tests); they simply
never execute in CI. Under a plausible plan sentence the
guardrail does not merely return `unknown`; the substring "auth" in "**auth**oring" makes
it return `warn` against `auth_permissions` and declare every real file out of scope.
**[PROVEN]**

## Goal

Agent Flow and AI Chat become one product with one vocabulary and one answer contract:
an author can see exactly what a reader will see, a reader can see what the assistant is
actually for, and adding a node type is a single registration rather than a hunt through
a dozen walkers.

## Out of scope

- **Rewriting the runtime.** `run_flow` is already the single backbone and all three
  surfaces share it. It is not being refactored to make files smaller.
- **Renaming `brain_key`, `/brains`, or any database column.** The user-facing word
  "Brain" retires; the internal identity does not move. 52 frontend references and a
  public API for no behavioural gain.
- **A visual redesign in the first phases.** History shows this area's defects escape
  review (`two layouts that were wrong on screen and right in every test`). Structure and
  behaviour stabilise first; polish is a later phase against a stable model.
- **The five live-model answer-quality defects (D1–D5)** from this session's Gate 4 eval.
  They are tool/prompt-layer issues, tracked separately in
  `docs/agent-flow-v3-release-qa.md`, and mixing them in would violate "do not mix
  unrelated cleanup into the rework".
- **The currently red E2E workflow.** A separate thread, unresolved, not caused by this.
- **Repo-wide CI coverage debt.** 43 committed tests are referenced by no runner; only
  **12** are Agent Flow / Direct Chat. The other 31 (18 Knowledge/RAG, 13 unrelated) are a
  separate follow-up, not this rework.
- **Redesigning Runs / Feedback / Activity.** Round 2 audited them and found a designed
  loop, not three tabs of data (F23). Only its last hop is missing.
- **Choosing the minimum supported viewport.** Measured and reported (F25/F27); the
  decision is the product owner's.

## Constraints

- **`METADATA_CATALOG_ENABLED` gates this entire module**, Direct Chat included
  (`api/__init__.py`, documented in `.claude/rules/backend.md`). Any new endpoint must be
  registered inside that flag's block or it silently does not exist.
- **Registration order matters**: `agent_flows.chat_api` mounts after the studio router so
  `/agent-flows/chat/*` is not swallowed by `/agent-flows/{id}`.
- **Every endpoint of a gated module needs a router gate** — read is `view`, write is
  `edit`. Chat has been outside a guard once before (`5b96d0c`).
- The answer envelope (`schema_version`, `AnswerBlock` union) is a **published contract**
  consumed by the dashboard bot, the public link and chat. Additive changes only.
- The backend runtime is a **protected-by-maturity** area in practice: it carries dense
  post-mortems at exactly the points that matter. Smallest surgical change.
- Frontend public/embed surfaces may only use `publicClient` — not touched by this plan,
  and must stay untouched.

## Acceptance criteria

Checkable against the running system or a test.

1. A flow whose answer node emits a `metric` block renders that metric in the Studio test
   panel, visually identical to what `/chat` renders for the same envelope — verified by
   running one flow through both surfaces.
2. The Studio test panel and Chat render answers through **one** shared component; a grep
   shows no second implementation of block rendering.
3. A container node type declares its child slots in exactly one place, and
   `walkNodes`/`replaceNode`/`removeNode`/`insertNode`/`locateNode` contain **zero**
   hard-coded `type === 'if' | 'switch' | 'coordinate' | 'loop'` branches.
4. A test fails if a node type registered on the backend as structural has no child-slot
   declaration, or if the frontend node-type union and the backend registry disagree.
5. The Chat assistant catalogue shows, for each assistant, what it can answer and what it
   cannot, **recomputed against the chat surface's effective ceiling** - not projected
   from `coverage()` output - and no longer leads with conversation count.
6. The reader-facing capability payload contains **no** `tools`, `pack`, `needs_any_of`,
   `step`, `ref` or `unreadable_sources` field, proven by a test that asserts the
   serialised shape (F28).
6b. A reader who cannot access a knowledge source never sees its name or ref, proven by a
   two-account test.
7. `agent_flows` and `direct_chat` exist as guardrail features with owner files, so
   `guardrail_check.py --files backend/app/services/agent_flows/...` returns a real
   verdict instead of `unknown` — and "authoring" no longer matches `auth_permissions`.
8. `scripts/ci/audit_test_reachability.py` reports **0** Agent Flow / Direct Chat tests
   in the never-referenced bucket. The other 31 stay out of scope and are still reported.
9. No change to `brain_key`, `/brains` paths, or any database column.
10. The three dispatch entry points still call one `executor.run_flow`, verified by grep.

## Open questions — resolved in round 2

1. **"Brain" -> "Assistant" in the Studio too?**
   -> **NEEDS PRODUCT OWNER DECISION.** Evidence is in: the split already exists and is
   inconsistent (Chat says Assistant, Studio and API say Brain; Flow 860 / Brain 122 /
   Assistant 8 occurrences). Retiring the *word on screen* is safe; renaming `brain_key`,
   `/brains` or columns is not, and stays out of scope either way. Not blocking - it lives
   in the polish phase.

2. **How common is `output_format: 'json'`?**
   -> **ANSWERED from real local data.** 53 agent nodes across 25 brain versions:
   **47 `chat`, 4 `json`, 2 `choice`**. Two of ten flows. On `revenue_v2` (bound to
   link 39) the answer node was `json` in v1, v2, v4 - then `chat` for v5-v12.

   **Why it changes the plan:** the shared renderer is still right, but **not because of
   severity**. Nothing currently ships a typed-block answer, and the model returns a
   single `text` block even when asked for a metric and a table - only an explicit
   "answer with a metric block" produced one. So F6 is **correctness and robustness debt**,
   not an active user-facing bug. It stays early because it is small (F21: the renderer is
   already surface-agnostic, ~201 lines, two of three surfaces already use it), not
   because users are hitting it. **It no longer justifies being Phase 1 on severity.**

   **Why it does not change the recommendation itself:** the defect is real and silent
   (run reports `ok`, answer renders the em-dash), F20 shows an unknown variant is dropped
   on *every* surface, and leaving one of three surfaces on a private flatten is how the
   drift happened in the first place.

3. **Suggested questions - authored, derived, or both?**
   -> **CAN DEFER**, and now depends on F28. Derived-from-coverage is unsafe as designed
   (leaks tool names and document refs, and is wrong on chat where there is no report).
   Whatever ships must be recomputed against the surface ceiling. Decide when that phase
   is specified, not now.

4. **Is validation feedback good enough now?**
   -> **ANSWERED - yes, for this rework's purposes.** Observed in the test panel: coverage
   gaps are listed per question class with examples ("Tra loi duoc 0/9 loai cau hoi", each
   gap naming the missing tool group), and the `read_exceeds_context` notice is rendered
   as actionable prose. Not a problem this rework needs to solve.

5. **Phase 0 CI/guardrail wiring first and separately?**
   -> **ANSWERED - yes, and it is now BLOCKING BEFORE PHASE 1.** The 12 in-area ghost
   tests pass locally (198 tests) but never run in CI, and two of them lock the exact
   failure classes the later phases risk re-introducing. Wiring them is small, has no
   product change, and makes every later phase verifiable.

## New open question from round 2

6. **What is the minimum supported author viewport?**
   -> **NEEDS PRODUCT OWNER DECISION, and it gates the canvas work.** Measured: a
   three-specialist coordinator needs **~1760px** to avoid horizontal clipping with the
   inspector at its default 700px. At 1440 the third lane is 64% hidden; at 1280, 5 of 6
   node cards and 2 of 3 lanes are clipped. Either the product declares >=1760px and says
   so, or the inspector stops being a fixed 700px. That is a product call, not a refactor,
   and I am not making it inside an audit.
