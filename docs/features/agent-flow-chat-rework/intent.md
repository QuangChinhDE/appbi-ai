# Agent Flow + AI Chat rework — intent

**Status:** draft — awaiting approval, nothing implemented
**Owner:** chinh.bui02@base.vn
**Date:** 2026-09-15

Evidence for every claim here is in `audit.md`, with each finding marked
**[PROVEN]** / **[HISTORY]** / **[INFERENCE]**.

## Problem

Four concrete problems, not a feeling that the UI is ugly.

**1. The test loop shows the author a degraded answer.** `TestChat.tsx:317-318` flattens
the answer envelope to `.markdown` and drops every other block type. The contract has six
(`text`, `metric`, `table`, `chart_ref`, `callout`, `followups`). Chat renders all six
through the shared `AnswerBlocks`; the Studio test panel renders none of the non-text
ones, and when every block is non-text it prints `—`. An author using
`output_format: 'json'` — which `handlers/agent.py:1210` exists to support — tests their
flow, sees an em-dash, and has no way to learn why. **[PROVEN]**

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
are not among its 11 registered features, and 8 of 23 tests in the area — including the
one locking problem 2, and the one locking read-only chat-share enforcement — are tracked
but absent from the CI workflow, so they never run. Under a plausible plan sentence the
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
- `RunsTab`, `FeedbackTab`, `ActivityTab` behaviour — audited only to the level of the
  system map. No changes proposed without evidence.

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
   cannot — projected from `coverage.py` — and no longer leads with conversation count.
6. A reader opening an assistant can see at least one suggested question derived from the
   flow's actual capability, not free text typed by the author.
7. `agent_flows` and `direct_chat` exist as guardrail features with owner files, so
   `guardrail_check.py --files backend/app/services/agent_flows/...` returns a real
   verdict instead of `unknown` — and "authoring" no longer matches `auth_permissions`.
8. All 23 backend tests in this area run in CI; the workflow lists the 8 currently missing.
9. No change to `brain_key`, `/brains` paths, or any database column.
10. The three dispatch entry points still call one `executor.run_flow`, verified by grep.

## Open questions

Answers change the plan; I am not assuming them.

1. **Does the "Brain" → "Assistant" vocabulary change extend to the Studio?** Retiring the
   word on the Chat side is easy. Renaming `BrainList`/`BrainBuilder` on screen is a
   larger surface and affects author muscle memory. My recommendation: yes, user-facing
   only, in the polish phase — but it is your product call.
2. **How common is `output_format: 'json'` in real flows?** F6 is proven; its *severity*
   depends on frequency. If no shipped flow uses typed blocks, it drops from "highest
   priority" to "correctness debt".
3. **Should suggested questions be authored, derived, or both?** Derived cannot drift but
   is generic; authored is specific but goes stale. My recommendation: derived by default,
   with an optional author override.
4. **Is the current validation feedback good enough?** `40b8fea` fixed the worst of it.
   Whether it is now adequate is a browser question I have not answered.
5. **Do you want the phase-0 CI/guardrail wiring done first and separately?** It is small,
   independent, and makes every later phase safer — but it is not product work.
