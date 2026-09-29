# Question Intent Contract (QIC) — design

Status: in implementation (pilot stabilization, 2026-09-29). Owner: Agent Flow V3.

## Problem (evidence)

Every wrong figure that still reached a reader in the live P0 runs (df54303b → 0abef689) has
one root: **the runtime never knows, in structured form, what the question asks for.** It
infers it after the fact from the answer's prose:

| Class (live runs) | What was missing |
|---|---|
| Minas Gerais given SP's revenue (4245, 4901, 4943) | the asked *member* as a data label (`MG`) |
| seller-state MG for a customer-state question (4723, 4907) | the asked *breakdown* when two share a cue word |
| on-time rate called "conversion rate" (4164, 4879, 4928, 5051) | that the asked *measure* is **absent** from the report |
| "GMV tháng 10/2017 là 56808.84" in a follow-up (4368, 4756, 4849) | the asked *period* of a follow-up turn |
| total given as SP's / 5-star's (4465, 4024, 4608) | the asked *member / qualifier* |

The claim checker compensated with prose heuristics (cue words, capitalisation, brackets,
bullet headers). Each locked a past run; each can miss a new phrasing. Mapping of the
current machinery: every consumer recomputes intent separately (`target_of`,
`requested_dimension`, `_asked_member`, `named_periods`); nothing persists across turns;
the answering model never sees a structured target.

## Contract

One object per turn, resolved by the **runtime** before any node runs, stored on
`RunState.intent`, persisted with session memory so a follow-up inherits it:

```
Intent {
  measures:   [governed measure key]        # chosen from the report's measures, or []
  absent:     str | None                    # the asked quantity when the report has none
  dimension:  field key | None              # chosen from the report's breakdowns
  members:    [{said: str, code: str|None}] # as said + the model's code guess (validated later)
  periods:    [("m"|"q"|"y", ...)]          # explicit or resolved relative ("tháng trước")
  baseline:   period | None
  inherited:  [field names taken from the previous turn]
  source:     "model" | "heuristic"
}
```

**AI controls local reasoning, runtime controls the rules**: one constrained model call
reads the question, the previous turn's intent and the report's own vocabulary
(governed measure names, breakdowns with their chart titles) and must answer with choices
**from those lists** (or `absent`). The runtime validates every field against the lists;
anything invalid is dropped and the heuristic resolvers fill that field. The call is
bounded (one per turn, short timeout, counted in usage), and its failure never fails the run.

## Consumers

1. **Claim check** — the target (measures, dimension, member, periods, absent) comes from
   the contract instead of re-deriving it from prose. A member figure must be of the
   asked member (label or validated code); a figure presented as the `absent` quantity is
   withheld; a follow-up's figures are judged against the resolved period.
2. **Answering prompt** — the resolved intent is stated to the answering step ("the
   question asks for X of member M in period P; the report does not measure Q — say so"),
   which is the task-completion lever: the model stops guessing the month of "tháng trước".
3. **Trace** — the contract is recorded per run for the author (Runs inspector).

## Non-goals

No planner, no multi-agent routing, no new tools. The contract never widens scope or
grants: it only states what was asked.

## Tests

Deterministic: validation against the report's vocabulary (invalid choices dropped),
follow-up inheritance, absent measure, member code validation, each P0 class negative +
positive through the real claim check. Live: the P0 regression subset ×5 and the full
matrix on the final SHA, plus a holdout of rephrased questions never used to design fixes.
