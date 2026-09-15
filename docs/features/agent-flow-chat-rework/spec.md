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
it can *answer*, derived from `coverage.py`. Inventory numbers (conversations, sources)
move to a secondary position or off the card entirely — they describe the module, not the
assistant.

For each assistant a reader sees, before committing to a conversation:

- its purpose (authored, one sentence)
- what it can answer — the covered question classes, in reader language
- what it cannot — the uncovered classes, stated plainly, because an assistant that
  cannot detect anomalies should say so rather than blame the data
- what it reads — report and/or knowledge domains, by name, not by count
- suggested questions, derived from covered classes
- its trust state — whether answers carry citations

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
| GET | `/agent-flows/chat/brains` | signed-in; `agent_flows: view`; per-flow share re-resolved | — | **extended**: existing fields plus `capability: { purpose, can_answer[], cannot_answer[], reads: { report, knowledge[] }, suggested[], evidence: 'cited' \| 'uncited' }` |
| GET | `/agent-flows/nodes` | `agent_flows: view` | — | **extended**: each `NodeSpec` gains `child_slots: [{ name, kind: 'list' \| 'group', path }]`, empty for leaf types |

Both are additive: an older client ignoring the new fields behaves exactly as today.

**Error responses** follow the module's existing contract — `ValueError` → 400 with an
actionable Vietnamese message; 403 with the module/level named for a permission failure;
a chat endpoint additionally re-resolves per-turn eligibility and returns the existing
`BLOCK_MESSAGES` shape rather than a bare 403.

**Gates**, per `.claude/rules/backend.md` — every endpoint of a gated module, including
the ones that only read. `/chat/brains` is a read: `view`. Both endpoints live inside the
`METADATA_CATALOG_ENABLED` block or they do not exist.

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

### 5.5 Canvas

No structural change in the early phases. The `coverage` prop is renamed `runCounts` at
the same time as the vocabulary work. Large-flow readability is **not** specified here —
`audit.md` §8 records that I did not verify behaviour at `MAX_NODES = 40`, and I am not
specifying a fix for something I have not observed.

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
  a neutral fallback, never blank. Today's flatten-to-markdown makes this failure silent.
- **A structural node with an empty lane** — must remain walkable and countable; this is
  the `all_nodes()` class of bug and is covered by the new registry test.
- **Deeply nested containers at `MAX_DEPTH = 4`** — slot-driven walkers must terminate
  identically to today's hand-rolled ones. Golden replay is the guard.
- **A shared thread whose flow was later unshared** — already handled per-turn; must stay
  handled after the capability projection is added.
- **Older client, newer server** — additive fields only; ignoring them yields today's
  behaviour.

## 8. Non-goals

- Making the backend files smaller.
- Changing how an assistant answers — this is about what the author and reader can *see*,
  not what the model does.
- Fixing the five live-model quality defects (D1–D5).
- A visual redesign of the canvas.
- Accessibility and responsive work — not audited, so not specified. They need their own
  pass rather than a guess inside this one.
