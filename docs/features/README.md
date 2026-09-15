# Feature artifacts — when to write them, and when not to

Most changes need no document. These exist so that the *large* ones stop being
reconstructed from memory halfway through implementation, not so that every change
acquires paperwork.

## The policy

| Size | Examples | Artifacts |
|---|---|---|
| **Trivial** | typo, copy, spacing, a log line | none — implement and run the fast check |
| **Small** | one surface, one layer, reversible; a contained bug fix | a short plan stated in the conversation before coding |
| **Medium / large** | a new user-visible surface, a schema change, anything crossing frontend and backend, anything touching a protected subsystem (semantic layer, public-link security) | `docs/features/<feature>/{intent,spec,plan}.md`, written before code |

If you are unsure which bucket you are in, you are probably in the middle one.

A feature folder that is written after the implementation is documentation, not design,
and it is worth much less. Write `intent.md` before you know the answer.

## The three files

- **`intent.md`** — *why*. The problem, the goal, what is deliberately out of scope, the
  constraints, and acceptance criteria that can be checked rather than admired.
- **`spec.md`** — *what*. Expected behaviour, data and API shapes, UI states, permissions,
  and the edge cases, including the ones you would rather not handle.
- **`plan.md`** — *how*. Files and layers in sequence, risks, and the tests required —
  decided before implementation, not chosen afterwards to match what was built.

Copy `_TEMPLATE/` to `docs/features/<feature>/` and delete every prompt you do not answer.
An unanswered prompt left in place reads as an answer.

## Keep them honest

When the implementation departs from the plan — and it will — update the file in the same
change and say why. A plan that quietly stops matching the code is worse than no plan,
because the next reader trusts it.
