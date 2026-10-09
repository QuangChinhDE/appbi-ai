# Agent Flow specialized agents — intent

**Status:** in progress (branch `feat/agent-flow-specialized-agents`)
**Date:** 2026-10-08

## Problem

An Agent step is one generic box: the author picks from 36 tools with no guidance
about which job needs which, and a multi-agent flow is hard to wire correctly.

Two measured defects make multi-agent flows unreliable:

- **Only the step before is handed on.** An intermediate agent sees only
  `previous`, head-sliced at 8,000 characters with no notice. Step 4 cannot read
  step 1. After a Coordinator, `previous` holds only the last lane's output.
- **Reduced results lose their figures.** The context compiler collapsed a
  Report Read of one-row KPI charts to `{"read_ok": true}`. The writer answered
  "no revenue data" beside a read holding 13,591,643.7. This reached the
  answering step too, so it predates this work.

## Goal

An author adds an Agent by job, such as Report Reader or Metric Analyst. The job
comes with the right tools, a server-enforced tool boundary and a short charter.
The author can name which earlier steps a step reads from. Each handoff says what
it carried, reduced or lost, in the run trace.

## Out of scope

- No new node type, execution engine, MCP layer or tool.
- No flow templates and no AI flow generator.
- No Evidence Reviewer role. The deterministic `claim_check` already does that
  job; a model re-reading an answer adds cost without independent evidence.
- No change to Dataset, Chart, Dashboard, Source, Docs or Report.

## Constraints

- One source of truth for the boundary: `roles.py`. Grants stay the per-step list.
- Published flows must not gain tools. Roles list explicit tool names, and the
  runtime intersects grants with the role.
- Backward compatible: `role` and `reads_from` are optional, with no schema change.

## Acceptance criteria

1. Saving a grant outside a step's role returns 422; publishing returns 409,
   which cannot be acknowledged.
2. At run time a step can call only (its grants) ∩ (its role's allowed tools),
   including Skill grants.
3. A Knowledge Reader with no attachment reads nothing and cannot publish.
4. `reads_from` lets any later step read any earlier step. A failed or skipped
   input is told to the model, raises `handoff_input_missing`, and makes the run
   `partial`.
5. The trace records each step's handoff: included, reduced, omitted, missing.
6. A custom agent (no role) behaves exactly as before.
