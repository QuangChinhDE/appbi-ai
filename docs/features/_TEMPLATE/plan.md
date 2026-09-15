# <Feature> — implementation plan

## Guardrail scoping

Run before writing this section, and paste what it said:

```bash
python scripts/ci/guardrail_check.py --plan "<intent in one line>" --files <expected paths>
```

- Verdict:
- Features / subsystems touched:
- Protected subsystems involved:
- Required tests it named:

A `block` means the plan is in the wrong place. An `unknown` means no rule covers this —
record that here rather than letting it disappear.

## Files and layers, in order

Sequenced so the tree is coherent at each step (a provider before its consumer, a
migration before the code that reads the column).

| # | File | Layer | Change |
|---|---|---|---|
| 1 | | | |
| 2 | | | |

If any row crosses an architecture boundary — a model reaching into services, a public
surface calling an authed client, a fix in a different layer from the cause — justify it
here or change the plan.

## Risks

What could break that this change does not obviously touch. The guardrail's impact scope
and the relevant area of `DA-Test/Regression-Catalog.md` are the inputs. For each risk,
how it would show up and what would catch it.

## Tests — decided now, not afterwards

| Test | New or existing | What it locks |
|---|---|---|
| | | |

- Existing suites that must still pass (from the guardrail):
- New test that locks the new behaviour:
- If a new backend test: added to the `.gitignore` allow-list **and**
  `backend-contract-tests.yml`, then `git add -f`-ed — otherwise CI never runs it.
- E2E needed? Only if this changes a user-visible flow that source inspection cannot
  prove (routing, permissions, public link, render, save-then-reload).

## Verification

How this will be shown to work, beyond the tests: the exact steps, on a running build,
for a user-visible change. Reading source is not verification.

## Rollback

What to do if this misbehaves in production. If a migration is destructive, say what is
unrecoverable.
