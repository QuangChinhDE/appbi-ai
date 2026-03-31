# AI Agent Report - Domain-First Development Strategy

> Status: proposed direction
> Audience: product, backend, frontend, AI/runtime developers
> Last updated: 2026-03-28

---

## 1. Why This Document Exists

`AI Agent Report` has evolved beyond a generic "AI dashboard generator".

The product direction is now:

- user selects a bounded data scope
- user gives a short business brief
- AI behaves like a senior domain analyst
- AI proposes a reviewable analytical plan
- human reviews the plan
- AI builds the final dashboard and narrative report

The next major upgrade is to make the system **domain-aware**.

This document defines how we should build that direction without turning the codebase into prompt spaghetti.

---

## 2. Product Direction

### 2.1 What the product is

`AI Agent Report` is an **AI-native analytical reporting workflow**.

It is not just:

- a chat assistant
- a one-shot chart generator
- a dashboard templating wizard

It is a workflow where:

1. business intent is captured in a minimal brief
2. AI interprets that brief through a domain lens
3. AI proposes analytical reasoning before execution
4. the user reviews the reasoning
5. the system persists the full report lifecycle

### 2.2 Core belief

A high-quality AI analyst should not try to be equally good at every domain.

We should prefer:

- smaller, clearer input from the user
- stronger domain-specialized reasoning behind the scenes

In practice, that means:

- the brief stays compact
- the domain decides how to interpret the brief
- domain packs shape KPI inference, question framing, chart strategy, and narrative style

---

## 3. Target Product Model

### 3.1 User mental model

The user should experience the product like this:

1. choose the tables AI is allowed to use
2. choose the business domain
3. provide a short decision-oriented brief
4. review the AI's draft reasoning
5. approve and build the report

### 3.2 Product promise

The product promise is:

> "Give me the business decision, the audience, and the reporting context. I will reason like a senior analyst in the chosen domain, propose the right story, and then build the report."

---

## 4. Design Principles

### 4.1 Domain-first, not prompt-first

We should not treat "domain support" as only:

- different prompt strings

We should treat domain support as:

- prompt variations
- domain glossary
- KPI vocabulary
- question inference rules
- section archetypes
- chart heuristics
- review/quality rules
- narrative style

### 4.2 Shared engine, pluggable domain brains

We should not clone the planner per domain.

We should build:

- one shared core engine
- many pluggable domain packs

### 4.3 Review before build

The system should continue to require a human reviewable plan before build.

This is a product moat:

- AI proposes
- human approves
- system executes

### 4.4 Keep user input small

The product should keep the new compact brief shape.

We should not regress into long forms where the user manually writes:

- KPI lists
- analytical questions
- dataset interpretation
- narrative instructions

That is the AI's job.

---

## 5. Proposed Runtime Architecture

## 5.1 Layers

### Layer A - Core Engine

Shared across all domains:

- wizard state and report lifecycle
- table scope selection
- persistence for specs and runs
- generic table profiling
- chart materialization
- dashboard creation
- build orchestration
- generic event streaming

### Layer B - Domain Registry

A registry that knows:

- which domains exist
- whether they are enabled
- which version is active
- which runtime pack to load

### Layer C - Domain Packs

Each domain contains:

- domain prompt fragments
- business glossary
- KPI canon
- standard business questions
- section patterns
- chart heuristics
- review rules
- narrative rules

### Layer D - Evaluation Layer

Each domain should have:

- domain datasets or fixtures
- expected planning behavior
- sample prompts
- quality checks

---

## 5.2 Recommended folder structure

```text
ai-agent-service/app/
  domains/
    core/
      base.py
      registry.py
      types.py
    generic/
      config.py
      prompts.py
      glossary.py
      heuristics.py
      review.py
      narrative.py
    data_governance/
      config.py
      prompts.py
      glossary.py
      heuristics.py
      review.py
      narrative.py
    sales/
      config.py
      prompts.py
      glossary.py
      heuristics.py
      review.py
      narrative.py
```

---

## 5.3 Domain interface

Each domain pack should implement the same interface.

Suggested responsibilities:

- `normalize_brief()`
- `infer_kpis()`
- `infer_business_questions()`
- `rank_tables()`
- `suggest_sections()`
- `score_chart_fit()`
- `review_plan()`
- `build_narrative_style()`

The core engine should call the interface, not hardcode domain `if/else` logic in the planner.

---

## 6. Domain Data Model Changes

## 6.1 Report spec

Add domain metadata to the saved report spec.

Suggested fields:

- `domain_id`
- `domain_version`

Why:

- reproduce old runs
- audit behavior
- safely roll forward / roll back domain packs

## 6.2 Runs

Each run should capture:

- `domain_id`
- `domain_version`
- `runtime_metadata`

This matters because the same brief may produce a different plan if the domain pack changes over time.

---

## 7. Backend Responsibilities

## 7.1 Parser

The parser should stay compact-input oriented.

Its job is not to ask for more fields.

Its job is to:

- interpret the short brief
- hand off to the domain pack
- create a domain-aware parsed brief artifact

## 7.2 Planner

The planner should become an orchestrator:

1. load generic table context
2. load selected domain pack
3. run domain-specific KPI/question inference
4. run domain-aware analysis planning
5. run domain-aware plan review

The planner should not become a monolithic file full of domain branches.

## 7.3 Quality review

Quality scoring should be domain-aware.

Examples:

- `sales`: poor if no driver breakdown or no baseline comparison
- `finance`: poor if no variance framing or no margin/cost lens
- `data_governance`: poor if no stewardship, freshness, ownership, or metadata risk framing

## 7.4 Builder

The builder should remain mostly shared.

Domain can influence:

- preferred chart mix
- narrative tone
- section ordering

But chart creation and dashboard assembly should stay in the common engine.

---

## 8. Frontend Responsibilities

## 8.1 Keep the 4-step shell

The current 4-step structure still fits the product well:

1. Select scope
2. Brief
3. Review plan
4. Build

We do **not** need to redesign the entire flow from scratch.

## 8.2 Step-by-step impact

### Step 1 - Scope

Keep mostly unchanged.

Possible addition:

- show a lightweight domain hint if tables strongly resemble one domain

### Step 2 - Brief

This is the main FE change.

We should add:

- `domain selector`

The brief can remain compact, but:

- helper copy
- examples
- placeholder text
- guidance

should adapt to the chosen domain.

### Step 3 - Review

This is the second most important FE change.

We should surface:

- selected domain
- inferred domain lens
- inferred KPI or question framing
- domain assumptions
- why each section makes sense for this domain

This makes the AI feel like a specialist instead of a generic generator.

### Step 4 - Build

Minimal change.

Show:

- domain badge
- domain version

The build process itself can remain largely unchanged.

---

## 8.3 Frontend config shape

Frontend should not hardcode domain UX in scattered components.

Use a config model such as:

```ts
type DomainUIConfig = {
  id: string;
  label: string;
  description: string;
  brief_examples: {
    goal: string[];
    notes: string[];
  };
  helper_copy: {
    step2_intro: string;
    step3_intro: string;
  };
};
```

This allows new domains to be added without rewriting the wizard shell.

---

## 9. Prompt Strategy

## 9.1 What should be domain-specific

Per domain, we should vary:

- system prompt framing
- KPI vocabulary
- business question patterns
- section templates
- risk language
- recommendation style

## 9.2 What should remain shared

Keep shared:

- JSON output contract
- validation rules
- chart payload structure
- streaming/event protocol
- dashboard assembly protocol

## 9.3 Anti-pattern to avoid

Do not create:

- one huge planner prompt with dozens of domain branches

Instead:

- shared planner frame
- domain prompt fragment injected at runtime

---

## 10. Recommended Domain Pack Contents

Each domain pack should define:

### 10.1 `config.py`

- domain id
- version
- enabled flag
- preferred planning model
- preferred insight model

### 10.2 `glossary.py`

- KPI names
- synonyms
- domain terms
- forbidden ambiguous interpretations

### 10.3 `prompts.py`

- planner prompt fragment
- insight prompt fragment
- narrative prompt fragment

### 10.4 `heuristics.py`

- metric ranking rules
- dimension ranking rules
- common baseline logic
- section ordering logic

### 10.5 `review.py`

- domain quality checks
- domain warning rules
- confidence penalties

### 10.6 `narrative.py`

- tone
- summary style
- action recommendation style

---

## 11. Domain Versioning

This is required, not optional.

Every domain pack must expose a version.

Example:

- `generic@1.0`
- `data_governance@1.0`
- `sales@1.1`

Saved specs and runs must record that version.

Without this:

- debugging becomes difficult
- old runs become non-reproducible
- evaluation becomes noisy

---

## 12. Suggested Rollout Plan

## Phase 1 - Foundation

- add `domain_id` and `domain_version` to spec/run models
- create `domains/core/`
- create `generic` domain pack
- move current compact-brief logic into `generic`

## Phase 2 - First real specialist domain

- create `data_governance` domain pack
- use current AI Report testing flow as the first domain eval bed

This is a strong first candidate because the product already has examples around:

- metadata coverage
- ownership gaps
- stale or inactive assets
- governance health

## Phase 3 - FE domain-aware UX

- add domain selector to Step 2
- add domain badge and inferred reasoning to Step 3
- persist domain choice into spec and runs

## Phase 4 - Domain evaluation harness

- add domain fixtures
- add evaluation prompts
- define pass/fail expectations for plan quality

## Phase 5 - More domains

Add new domains only after:

- the first domain pack structure works
- the registry is stable
- evaluation is in place

---

## 13. Risks and Failure Modes

## 13.1 Prompt-only domain support

Risk:

- domain sounds different but reasoning quality does not materially improve

Mitigation:

- domain logic must affect heuristics and review, not just prompt wording

## 13.2 Planner becomes a domain switchboard

Risk:

- endless `if domain == ...` branches in one file

Mitigation:

- use pluggable domain packs and a registry

## 13.3 Frontend overfits to one domain

Risk:

- wizard UX becomes custom for the first domain and hard to reuse

Mitigation:

- keep the 4-step shell
- use domain UI config, not one-off JSX forks

## 13.4 No versioning

Risk:

- behavior changes silently between runs

Mitigation:

- domain version stored on every spec/run

---

## 14. Non-Goals

This direction does **not** mean:

- rebuilding the entire wizard from scratch
- duplicating the whole planner for each domain
- asking the user for long domain forms
- turning AI Agent Report into a generic chatbot

---

## 15. Development Rules

When implementing this direction:

1. Keep the brief compact.
2. Keep the 4-step shell.
3. Move domain logic into packs, not into giant planner branches.
4. Version every domain pack.
5. Persist domain metadata in specs and runs.
6. Add evaluation before scaling to many domains.
7. Prefer one strong specialist domain over many weak domains.

---

## 16. Immediate Recommendation

The best next move is:

1. define `domain_id` and `domain_version` in the data model
2. introduce a `generic` domain pack
3. extract current planner/brief logic into that pack
4. implement `data_governance` as the first specialist domain
5. update Step 2 and Step 3 to be domain-aware

This gives us:

- clean architecture
- minimal product disruption
- clear migration path
- strong foundation for scaling more domains later

---

## 17. Summary

The future of `AI Agent Report` should be:

- **shared workflow engine**
- **domain-specialized reasoning packs**
- **review-before-build UX**
- **versioned, testable, scalable runtime behavior**

That is the right path if we want the product to feel like a real senior analyst, not a generic reporting bot.
