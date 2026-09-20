---
name: testing
description: Which tests to run, when to add one, and when E2E is required. Load when writing or selecting tests.
paths:
  - "backend/tests/**"
  - "e2e/**"
  - "qa/**"
  - "frontend/scripts/**"
---

# Testing rules

## Choosing what to run — do not guess

The mapping from changed files to required tests is data, not judgement:

```bash
python scripts/ci/guardrail_check.py --files <paths...>    # required tests for this change
```

It reads `guardrail_rules.yaml` (`features`, `tests`) and returns exact run commands.
`DA-Test/Regression-Catalog.md` section 1 is the human-readable version of the same
inventory.

## Tiers

| Tier | Command | When |
|---|---|---|
| FAST | `python scripts/ci/verify.py fast` | in the coding loop, after edits |
| TASK | `python scripts/ci/verify.py task` | before claiming anything is done; runs the guardrail's required gates |
| FULL | `bash scripts/ci/preflight.sh` + CI | pre-push; CI runs contract + golden + E2E |

Never run the full Playwright suite after a single edit.

## The gitignore trap

`.gitignore` blocks `test_*.py` everywhere and re-includes an explicit allow-list. A test
you add is **invisible to CI and lost on a fresh clone** unless you:

1. add `!backend/tests/test_<name>.py` to `.gitignore`, and
2. add it to the pytest list in `.github/workflows/backend-contract-tests.yml`, and
3. `git add -f` it.

`python scripts/ci/verify.py task` checks 1 and 2 for you.

## Bug fixes

Reproduce before fixing. Where the failure can be expressed as a test, write the failing
test first, watch it fail, then fix it and watch it pass. Then add a row to
`DA-Test/Regression-Catalog.md` (symptom, root cause, fix location, locking test).

An area marked `GAP` in the catalog has no automated regression test — if you touch it,
writing the missing test is part of the work.

## Test content

- Assert the **shape** a function returns, not only that it does not raise. A test that
  only checks "no exception" locks nothing.
- For SQL generation, assert the emitted SQL structure on the dialect that can reject it
  (BigQuery), not just the numbers Postgres happens to produce.
- One test per fixed bug, named for the bug, not for the function.

## When E2E is required

`e2e/tests/` (real browser, real Next.js, real API, real database) is required when the
change affects a user-visible flow that source inspection cannot prove: routing, auth and
permission surfaces, the public/embed link, dashboard render, builder save-then-reload.
Backend-only logic changes do not need E2E; they need their contract test.

## Sizing a change

| Size | Artifacts |
|---|---|
| Trivial — typo, copy, styling | none; fast check |
| Small — one surface, one layer, reversible | short in-session plan |
| Medium/large — new surface, schema change, cross-layer, protected subsystem | `docs/features/<feature>/{intent,spec,plan}.md` first |
