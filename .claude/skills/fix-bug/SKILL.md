---
name: fix-bug
description: Diagnose and fix a bug in AppBI. Use when something is broken, wrong, or behaving unexpectedly. Enforces reproduce before fix, root cause over symptom, a regression test that fails first, and a catalog entry.
---

# Fix a bug

The rule this repository learned the hard way: **a fix without a failing test first is a
guess, and a fix in the layer where the symptom appears is usually the wrong fix.**

## Visible progress protocol

When `/fix-bug` runs interactively, do not work silently from start to finish. A
long bug hunt looks identical to a stalled one, and the person watching cannot
tell which they have without asking.

Emit ONE short user-visible update at each phase boundary:

```
[1/6] REPRODUCING   what failure is being reproduced
[2/6] ROOT CAUSE    did reproduction succeed, and the one-sentence causal chain
[3/6] RED TEST      the regression test name, and that it fails for the right reason
[4/6] IMPLEMENTING  the canonical layer/files changing, and the invariant restored
[5/6] VERIFYING     which targeted checks are running, and whether the regression is green
[6/6] REVIEW / CI   review result, commit SHA, remote CI state
```

**Rules**

- Two to three concise lines per update. Factual status only — never private
  reasoning.
- Send the update BEFORE starting a long browser, test or CI phase, not after. Its
  whole job is to cover the silence.
- Do not narrate file reads, searches, commands, tool calls or hypotheses, and do
  not repeat what you have already reported. Visibility, not narration.
- If new evidence contradicts the working hypothesis, say so in one update rather
  than quietly changing course.
- Never announce a phase complete before its evidence exists. "[3/6] RED TEST" means
  you watched it fail, not that you wrote it.
- While waiting on remote CI, say exactly:

  ```
  [6/6] CI — pushed <sha>; waiting for <checks>
  ```

  so a silent gap is never mistaken for a stalled one.

The last line of every `/fix-bug` task is exactly one of:

```
DONE — <commit SHA> — <short verification summary>
BLOCKED — <exact blocker> — <decision/input required>
```

The nine steps below are unchanged; this protocol says when to speak while working
through them.

## 1. Reproduce it

Do not start from the report. Start from the failure, observed by you.

- Backend/data/semantic: reproduce against a real fixture. Capture the generated SQL and
  the actual numbers — those are the truth, not intuition about what the code does.
- Frontend: drive the real UI in a real browser against a running build. A source read
  cannot tell you whether the deployed bundle is stale, which is itself a recurring cause
  of "bugs" here.
- Record what you did to trigger it precisely enough that someone else could repeat it.

If you cannot reproduce it, say so and ask for what you need. Do not fix what you have
not seen.

## 2. Find the root cause

Trace from the observed symptom backwards to where the wrong value or wrong decision is
first produced. Write the causal chain down in one or two sentences before touching code.

**The layer test.** A wrong number, a dropped filter, a missing value, or an empty list
originates where it is produced — service, semantic engine, query, data — not in the
component rendering it. Patching the display to mask a backend defect is the single
most-repeated mistake in this repo's history. If you find yourself adding a frontend
guard to make a symptom disappear, stop: you have found the symptom, not the cause.

Check whether this is a **known** bug class first:

```bash
grep -i "<keyword>" DA-Test/Regression-Catalog.md
```

A bug already in the catalog with a `GAP` marker means it has no locking test — which is
why it came back.

## 3. Check the area's existing locks before you change anything

```bash
python scripts/ci/guardrail_check.py --files <the file you believe is at fault>
```

Run the tests it names **now**, while the bug is still present. You need to know the
current correct behaviour before you alter it, and you need to know which of those tests
already fail.

## 4. Write the regression test — and watch it fail

Write a test that reproduces the bug and fails for the right reason. Failing for the
wrong reason (an import error, a fixture problem) proves nothing.

- Backend: `backend/tests/test_<bug>.py`. It must assert the **shape** of the result or
  the structure of the emitted SQL, not merely that nothing raised.
- Dialect-sensitive SQL: assert the structure on BigQuery, which is the dialect that
  rejects the bad shape. Postgres will happily run SQL BigQuery refuses.
- User-visible flow that source cannot prove: an `e2e/tests/*.spec.ts` case.
- A new backend test needs the allow-list wiring in `.claude/rules/testing.md`, or CI
  never runs it. `verify.py task` checks this.

Where a bug genuinely cannot be expressed as a test, say so explicitly and explain why.

## 5. Fix it minimally

Smallest change that addresses the root cause. Do not refactor the surrounding code while
you are in there. In a protected subsystem (semantic layer, public-link security) the
requirement is surgical: never flip a default, never rewrite a working path.

## 6. Watch the test pass — and the old ones too

The new test goes green. Every test the guardrail named in step 3 is still green. If a
previously-passing test now fails, that is not a test to update: it is your fix changing
behaviour you did not intend to change, until you can argue otherwise in writing.

## 7. Validate the patch

```bash
python scripts/ci/guardrail_check.py --diff
python scripts/ci/verify.py task
```

`verify.py task` runs the guardrail's required gates for the files you touched. Any gate
it prints under `NOT VERIFIED` (missing harness, untracked, manual, or needing a seeded
database) must be named in your report as unverified — not folded into "tests pass".

## 8. Record it

Add a row to the relevant area table in `DA-Test/Regression-Catalog.md`:
**symptom · root cause · fix location · the test that locks it**. If you fixed something
previously marked `GAP`, clear the marker.

This is not paperwork. The catalog is the reason the same bug does not come back after
the next refactor.

## 9. Report

What was broken, why (the causal chain), where the real cause was, what you changed, the
test that now locks it, what you ran, and what remains uncertain. If the symptom appeared
in a different layer from the fix, say so — it tells the reader the class of bug.
