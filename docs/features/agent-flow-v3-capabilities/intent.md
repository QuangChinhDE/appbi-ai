# Agent Flow V3 capabilities — intent

**Status:** draft — awaiting approval
**Owner:** Agent Flow
**Date:** 2026-09-24
**Extends:** `docs/agent-flow-v3-target-architecture.md` (§3.3 Strategy, §3.4 Capability
catalogue, §4 invariants) and `docs/agent-flow-v3-migration-plan.md` (V3.4, V3.7). This
is not a second architecture: it delivers the phases those documents already sequence,
plus two gaps they do not cover (evidence-bound compute, capability shortlisting).

> **User controls the structure. AI controls the local reasoning. Runtime controls the rules.**

## Problem

Measured on the code at `428f8355`, not assumed:

1. **The model is the calculator of record.** `compute` takes `vars` straight from the
   model (`dashboard_ai_bot/thinking/tools.py:715-718`, "the agent is responsible for
   citing — we only enforce arithmetic safety"). Its result is then harvested into the
   evidence ledger like any tool result (`runtime/handlers/agent.py:520`), so a number
   the model typed becomes "evidence" and the figure verifier vouches for it. `citations`
   are free strings, never checked.
2. **Every granted tool's full schema is sent on every round.** Built once
   (`handlers/agent.py:295`), passed each round (`:357`), only ever reduced to `[]`
   (`:415`, `:565`). An agent granted 30 tools pays for 30 schemas per round, and the
   catalogue can only grow.
3. **A good flow cannot be reused.** No subflow, child run, or flow-calls-flow exists
   (`contract.py` node union `:901-919`; no `parent_run_id` on `agent_flow_runs`,
   `models/agent_flow_run.py:43-110`). An author who builds "compare period performance"
   rebuilds it in every flow.
4. **Reasoning and execution are one 480-line function.** `handlers/agent.py:run`
   (`:282-762`) owns model resolution, prompt building, the round loop, budget, provider
   streaming, tool execution, retry, dead-retry breaking, evidence, and four answer
   verifiers. A second way of reasoning means forking all of it.
5. **Governance promises the code does not keep** (found in the audit):
   - `risk="unknown"` "is not permitted to act" (`tools/registry.py:193-195`) — nothing
     enforces it.
   - `Flow.uses_capability("web_search")` (`contract.py:1316-1322`) omits `research_web`
     and `browse_ai_answer`, both `reaches_outside=True`: preflight does not warn, the
     tools are refused at run time (fail-closed, but silent to the author).
   - ToolNode "validated against the registry at publish time" (`contract.py:888`) — it is
     not; an unknown tool name surfaces only at run time (`registry.py:938`).
   - A Coordinate inside a Coordinate lane is not forbidden (only loop-in-loop is,
     `contract.py:1194`), and preflight cost ignores coordinate lanes (`binding.py:536-593`).

## Goal

An author designs *where* the AI may decide and *what* it may use; inside those zones the
AI chooses capabilities and writes formulas; the runtime computes the numbers, enforces
every boundary, and traces every decision back to the flow the author built.

## Out of scope

- Graph/DAG topology, recursive agent societies, parallel specialists, background runs,
  HITL/checkpoints (V3.5/V3.6), MCP/HTTP invokers (V3.8), a marketplace, an agentic
  builder.
- A second reasoning strategy (planner/supervisor). This work builds the seam and moves
  the current behaviour behind it; a new strategy is its own feature.
- The Runtime Layer Stack (V3.3). Not needed for any goal here; it stays sequenced.
- Hard-coded business Skills ("Analyze KPI Change"…). The mechanism ships; authors make
  the Skills.
- Bilingual parity of new UI beyond the existing VI/EN catalog convention.

## Constraints

- **Flow is the source of truth for orchestration authority.** No capability, router or
  Skill may add, skip or reorder a node. AI authority exists only inside Agent and
  Coordinate nodes, exactly as today (`choice` enforced in code `handlers/agent.py:594-620`;
  coordinator picks scanned against the roster `executor.py:782-816`).
- **Runtime is the source of truth for security.** Every hard gate stays in
  `registry.execute()` / tool bodies (V3 invariant 11). The router shortlists; it never
  authorizes.
- **Zero behaviour change for existing flows** except where a change is a deliberate
  correctness fix, named here: (a) `compute` refuses unsourced inputs; (b) `risk="unknown"`
  refused; (c) nested Coordinate refused at save. Canonical replay (16 fixtures) is the
  gate for everything else.
- Migrations additive, single head. The public reader surface is unchanged.

## Acceptance criteria

1. `compute` with a variable not traceable to the run's evidence is refused
   (`unsourced_input`, recoverable, telling the model what to cite); with sourced inputs it
   returns the result plus lineage `{expression, inputs:[{name, value, source}]}`, and the
   answer verifier accepts the result because it is *derived*, not because the model said it.
2. An agent granted N > 8 capabilities receives at most 8 full schemas per round
   (deterministic + intent shortlist) plus a `find_capability` affordance; granted-but-
   unlisted capabilities remain callable (grant is the authority) and ungranted ones are
   refused exactly as today. Agents with ≤ 8 grants are byte-identical in replay.
3. Prompt size for an agent granted all 36 tools falls by at least half versus today,
   measured by a test, and a ranking/total/share question still reaches the right tool in
   the deterministic router test set.
4. A flow can be published as a Skill with typed inputs/outputs. A parent Agent (granted
   the Skill) or a Skill node invokes it; the child runs as a real child FlowRun with
   `parent_run_id`, its steps visible under the parent step in Runs.
5. Permission intersection: the child's effective scope is parent-scope ∩ Skill-owner
   rights ∩ Skill attachments; its capability flags (web, raw rows) are parent ∧ Skill.
   A test proves parent {A,B} + Skill needs {B,C} ⇒ child can use B, never C.
6. Skill cycles (A→B→A) are refused at **publish**; runtime depth is capped at 3; the child
   draws from the parent's budget and cannot exceed it.
7. `AgentStrategy` / `AgentRuntime` split with the current behaviour as strategy
   `tool_calling`: canonical replay unchanged, and no strategy module imports a provider
   or `registry.execute`.
8. The five governance gaps in Problem §5 are closed, each with a test.
9. Builder: the agent's capability picker groups by meaning (Skills · Data & reports ·
   Analysis · Knowledge · External) and lists published Skills; Runs shows child runs.
10. Docs: one concept map (Node, Tool, Skill, Agent, Strategy, Coordinator, Runtime, Flow)
    in the V3 architecture doc, matching the code's terms.

## Open questions

1. **Base branch.** PR #3 (V1) is not merged. This branch starts at the V1 candidate head
   `428f8355`; its PR should target `demo` after #3 merges. Confirm.
2. **Skill runs as whom.** Proposed: caller ∩ Skill owner ∩ Skill attachments (never the
   owner's rights alone — that would let a Skill launder its author's access to a reader).
   Confirm this is the product rule.
3. **Skill version binding.** Proposed: a parent pins the Skill's published version at the
   parent's publish time (same model as link pinning, `registry.py:519-537`); republishing
   the Skill does not change a published parent until the parent republishes. Confirm.
