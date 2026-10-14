# Agent Flow + AI Chat rework — spec

What the system does once this is built. Behaviour, not implementation.
Evidence: `audit.md`. Decisions and scope: `intent.md`.

## 1. Target product model

One product, four concepts, three surfaces. This accepts the user's hypothesis with the
one modification argued in `audit.md` §5.

| Concept | What it is | Who says it |
|---|---|---|
| **Assistant** | The thing a person talks to. Has a purpose, a competence, and limits. | User-facing, everywhere |
| **Flow** | How that assistant is orchestrated — the graph of steps. | Author-facing |
| **Agent / Tool / Logic / Data** | The building blocks inside a flow. Already the `NodeCategory` split. | Author-facing |
| **Dashboard Bot / AI Chat** | The two runtime surfaces an assistant is served through. | Both |

**Internal identity does not move.** `brain_key`, `/brains`, `AgentBrainVersion` stay
exactly as they are. "Brain" stops being a word on screen; it stays the word in the
database. This is the difference between fixing a mental model and renaming things.

The system already agrees with this model in two places and simply does not say so:
`flow_type` ('bot' | 'chat') already records which surface a flow was built for, and the
Chat surface already calls them Assistants.

## 2. Behaviour

### 2.1 The author journey (what changes)

The journey itself is not being redesigned — catalogue → open → add node → configure →
branch → attach → validate → test → inspect → fix → publish stays. Three behaviours change:

**Test shows the truth.** The test panel renders the answer envelope through the same
component Chat uses. A `metric` block renders as a metric, a `table` as a table, a
`chart_ref` as a chart reference, a `callout` as a callout. An author can no longer see
`—` for an answer a reader would see rendered. Where the two surfaces legitimately differ
(the author also sees the trace, the routing warning, coverage gaps, citations at the
version cited) those remain **additions around** the shared answer, not a different
answer.

**Adding a node type is one registration.** A node type declares its identity, its
presentation and — if it holds other nodes — where its children live. Every walker,
canvas layout, edge generator and inspector reads that declaration. Adding a fifteenth
node type does not require finding twelve functions.

**Readiness speaks in one vocabulary.** "Coverage" means one thing: which question
classes this assistant can answer. The per-node run counts on the canvas are called
run counts.

### 2.2 The reader journey (what changes)

**Choosing an assistant.** The catalogue leads with what each assistant is *for* and what
it can *answer*, **recomputed against the chat surface's effective ceiling** (§4.1 — not
projected from `coverage()`, which is the author's view and would be wrong here).
Inventory numbers (conversations, sources) move to a secondary position or off the card
entirely — they describe the module, not the assistant.

For each assistant a reader sees, before committing to a conversation:

- its purpose (authored, one sentence)
- what it can answer — the covered question classes, in reader language
- what it cannot — the uncovered classes, stated plainly, because an assistant that
  cannot detect anomalies should say so rather than blame the data
- suggested questions, derived from covered classes
- its trust state — whether answers carry citations

**Not** in this contract: what it reads, named. `bound_sources()` carries document refs,
and naming a source to a reader needs a per-reader permission check rather than a
projection (F28). It gets its own phase, or it does not ship.

**In conversation.** Unchanged in structure: thread, SSE, node/tool progress, terminal
envelope, answer blocks, citations, notices. What changes is that a notice or a refusal
is readable against the stated limits the reader already saw, instead of arriving as a
surprise.

### 2.3 What does not change

- One `executor.run_flow`. Three entry points. Surface-specific context assembly.
- The answer envelope contract — additive only.
- Permission model, thread access levels, share semantics, quota.
- `flow_type` semantics and type-aware authoring warnings.
- Public/embed surfaces. Untouched.

## 3. Data

**No schema change.**

Everything the reader-facing capability view needs is derived at request time from the
flow body and the tool registry (`coverage.py` already does exactly this, for the author).
No new table, no new column, no migration, no backfill.

If open question 3 resolves toward author-written suggested questions, that would add a
field to the flow body JSON — additive, no migration, and it is **not** in this plan.

## 4. API

Additive only. Existing endpoints keep their shapes.

| Method | Path | Auth / permission | Request | Response |
|---|---|---|---|---|
| GET | `/agent-flows/chat/brains` | signed-in; `agent_flows: view`; per-flow share re-resolved | — | **extended**: existing fields plus `capability: { purpose, can_answer[], cannot_answer[], suggested[], evidence }` — see the reader-safe contract below |
| GET | `/agent-flows/nodes` | `agent_flows: view` | — | **extended**: each `NodeSpec` gains `child_slots: [{ name, kind: 'list' \| 'group', path }]`, empty for leaf types |

Both are additive: an older client ignoring the new fields behaves exactly as today.

**Error responses** follow the module's existing contract — `ValueError` → 400 with an
actionable Vietnamese message; 403 with the module/level named for a permission failure;
a chat endpoint additionally re-resolves per-turn eligibility and returns the existing
`BLOCK_MESSAGES` shape rather than a bare 403.

**Gates**, per `.claude/rules/backend.md` — every endpoint of a gated module, including
the ones that only read. `/chat/brains` is a read: `view`. Both endpoints live inside the
`METADATA_CATALOG_ENABLED` block or they do not exist.

### 4.1 The reader-safe capability contract (revised after F28)

**`coverage()` output must never be serialised to a reader.** Tested against the
reader-safety constraints it fails on two counts, so the round-1 "projection" is replaced
by a narrower, surface-aware summary.

| `coverage()` field | Reader | Why |
|---|---|---|
| `covered[].label`, `.example` | ✅ include | static strings from the fixed `CLASSES` list; no user data |
| `answerable` / `total` | ⚠️ as prose | a score reads as a grade; "can answer X, not Y" does not |
| `covered[].tools`, `.pack` | ❌ **strip** | internal tool and pack names — author-only implementation detail |
| `unreadable_sources[]` | ❌ **strip entirely** | carries `step` (node key), **`ref` (document id)**, `description`, `needs_any_of` (tool names) |

**And it must be recomputed, not projected.** `coverage()` reflects the *flow's* grants.
The chat surface runs with `dashboard_id=0` and an explicitly empty chart allowlist, so
`assert_chart_in_scope` refuses every id. A flow granted `get_chart_data` would otherwise
advertise "can answer ranking" on a surface with no report — the one failure mode that
makes a reader trust the assistant *more* than they should.

So the contract is: **question classes answerable under the effective ceiling of the
surface the reader is on**, carrying only static class metadata.

"What it reads", by name, is **not** in this contract. `bound_sources()` carries refs, and
naming a document requires a per-reader permission check rather than a projection of the
author's view. Deferred to its own phase with its own test.

## 5. UI

Described as structure and state, not markup — enough to build a mockup from, and
deliberately no JSX.

### 5.1 Chat — assistant catalogue

Keeps `PageListLayout` + card grid (the module-landing pattern every other catalogue uses;
`AssistantCatalogue`'s own docstring explains why inventing a different landing was wrong
the first time). What changes is the card and the strip.

- **Card, in priority order:** assistant name → one-sentence purpose → *what it can
  answer* as 2–4 short capability chips → what it reads, by name → a secondary line with
  last-used. Conversation count demoted or dropped.
- **Stats strip:** currently three inventory counts. Becomes at most one module-level fact;
  the strip is not the place to describe an individual assistant.
- **States:** loading — skeleton cards matching the grid, the sibling pattern.
  Empty (no assistants shared with you) — `EmptyState` explaining that assistants are
  built in Agent Flow and shared, with a build CTA only when `canBuild`.
  Error — the page's existing error pattern, not a new one.
  Degraded — if capability cannot be computed, the card falls back to purpose + name and
  says so; it never silently shows an assistant as capability-less.

### 5.2 Chat — assistant detail / pre-conversation

Between choosing and typing. Shows purpose, can/cannot answer, what it reads, suggested
questions (clicking one starts the thread with it), and evidence state. This is where a
reader learns the limits *before* hitting them.

### 5.3 Studio — test panel

- The answer area renders the shared `AnswerBlocks`. Identical to Chat for the same
  envelope.
- Around it, author-only context stays: intended-vs-actual route warning (deliberately
  above the answer, because "an author who reads a good answer first stops reading"),
  coverage gaps, citation cards, trace, cost.
- **States:** an answer with zero blocks renders an explicit "this step produced no answer
  blocks" rather than `—`, because those are different failures and only one is the
  author's fault.

### 5.4 Studio — inspector

Per-node-type editors become separate components behind one registry-driven shell. The
visible layout does not change in the structural phases; this is a boundary change, and
any visual change is a later phase.

### 5.5 Canvas and the inspector — measured, so now specifiable

Round 1 declined to specify this. Round 2 measured it (F24/F25/F27), so the constraints
are stated as numbers rather than adjectives:

| Observation | Value |
|---|---|
| Largest real flow | **24 nodes** (`full_coverage_probe`) — no 40-node flow exists |
| Vertical scroll at 24 nodes, 1440×900 | **2,927px ≈ 3.5 screens**, 6 nodes visible |
| Canvas width used by the node column | 249 of 668px — **55% unused** |
| Canvas content hard floor | **`min-w-[860px]`** |
| Inspector | **fixed 700px at every viewport**, including 400px |
| 3-specialist coordinator at 1440 | third lane **64% clipped** |
| 3-specialist coordinator at 1280 | 5/6 cards and 2/3 lanes clipped; inspector = 55% |
| First width with no horizontal clipping | **≈1760px** |

**What the target must satisfy** (the mechanism is the implementer's choice):

1. A three-specialist coordinator is fully readable at the declared minimum width.
2. The inspector does not hold a fixed 700px below that width — it yields, collapses, or
   overlays deliberately, and the decision is visible in code rather than emergent.
3. The canvas does not reserve 55% of its width while the node column is narrow.
4. A 24-node flow is navigable without 3.5 screens of blind scrolling — a working
   minimap, jump-to-node, or collapse. **Not** specified further until the minimum
   viewport is decided (open question 6), because the answer changes the layout.

### 5.6 Accessibility — the three measured gaps

What already holds (F26): node cards are real buttons with 44px targets, focus is a
visible 2px brand outline, the inspector resize handle is a focusable `role="separator"`,
and every one of 55 small buttons has an accessible name.

What must change:

1. **Node cards get an `aria-label`.** Today the accessible name is concatenated card
   text — `"▥1 · Đọc báo cáoĐọc Dashboardkhi đổi…"`.
2. **Selected state becomes programmatic** (`aria-pressed` or `aria-current`), not visual
   only.
3. **Reaching the last node must not cost 99 tab stops** — a skip mechanism or a node
   list.
4. Targets below 24×24px (24 buttons, including the 22×22 drag handle) meet WCAG 2.2 AA
   2.5.8, or the exception is stated deliberately.

**[UNVERIFIED]** whether keyboard node reordering is possible at all; if it is not, that
is a fifth item and needs its own decision.

### 5.7 Responsive

**AI Chat needs no work** — verified clean at 1440, 768 and 400 with no horizontal
overflow. It is not a desktop-only surface and already behaves.

**Agent Flow Studio is desktop-only and that is fine** — what is not fine is having no
declared minimum and no behaviour at it. This spec does **not** invent a mobile layout.

## 6. Permissions

Unchanged. Stated so the rework cannot quietly relax them.

| Surface | Gate |
|---|---|
| Studio read | `agent_flows: view` |
| Studio write / publish | `agent_flows: edit` + per-flow ownership (`_may_manage_flow`) |
| Chat catalogue / threads | signed-in + per-flow share, **re-resolved every turn** |
| Thread write | `owner` / `edit` / `full`; a `view` share is a transcript, and a reader typing into it would be writing in someone else's record |
| Dashboard bot | the binding's data contract; the link is the ceiling |

A user without access gets a 403 naming the module and level, or the existing
`BLOCK_MESSAGES` shape on chat — not an empty list. An empty list and a 403 are different
answers and only one is honest.

The new capability projection **must not widen what a reader can see**: it describes what
an assistant can do; it must not name a chart, a dataset or a knowledge document the
reader could not otherwise reach. This is an explicit test in `plan.md`.

## 7. Edge cases

- **Assistant with no knowledge and no report** — capability is nearly empty. Say that;
  do not render an empty section that looks like a loading failure.
- **Assistant covering every question class** — "cannot answer" is empty. Omit the section
  rather than printing "none".
- **Coverage computation fails** — degrade to purpose + name, flagged. Never fabricate.
- **A flow whose answer node emits zero blocks** — distinct from "no answer"; see §5.3.
- **A block type the frontend does not know** (contract added a seventh variant) — render
  a neutral fallback, never blank. `AnswerBlocks` currently ends with `default: return
  null`, so this is silent on **every** surface today, not only the Studio (F20).
- **A structural node with an empty lane** — must remain walkable and countable; this is
  the `all_nodes()` class of bug and is covered by the new registry test.
- **Deeply nested containers at `MAX_DEPTH = 4`** — slot-driven walkers must terminate
  identically to today's hand-rolled ones. Golden replay is the guard.
- **A shared thread whose flow was later unshared** — already handled per-turn; must stay
  handled after the capability projection is added.
- **Older client, newer server** — additive fields only; ignoring them yields today's
  behaviour.

## 7b. Deliberate non-goal: run history answer parity

`RunDetail.answer` is a `string`. Runs persist prose, not blocks, so the shared renderer
**cannot** give RunsTab typed-block parity; that would need the envelope's blocks
persisted — a schema change this plan does not make (F22). Stated here so it is a decision
rather than a surprise discovered mid-phase.

## 8. Non-goals

- Making the backend files smaller.
- Changing how an assistant answers — this is about what the author and reader can *see*,
  not what the model does.
- Fixing the five live-model quality defects (D1–D5).
- A visual redesign of the canvas.
- Accessibility and responsive work — not audited, so not specified. They need their own
  pass rather than a guess inside this one.
