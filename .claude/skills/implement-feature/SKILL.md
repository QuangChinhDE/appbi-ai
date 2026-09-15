---
name: implement-feature
description: Build a feature or make a non-trivial change in AppBI. Use when asked to add, extend, or change product behaviour. Enforces inspect-before-code, guardrail scoping, tests-before-implementation, and a verified Definition of Done.
---

# Implement a feature

The order matters. Most defects in this repo came from starting at step 10.

## 1. Understand the request

Restate what you are being asked for in one sentence, including what is explicitly
*out* of scope. If two readings would produce materially different work, ask now — not
after implementing one of them.

## 2. Inspect before designing

Find how this repository already does the nearest equivalent thing and read it. Not a
grep for a symbol — read the file. AppBI almost always has an existing pattern:

- a frontend surface → the sibling page and its `lib/api/*.ts` module
- a backend endpoint → the sibling router in `backend/app/api/` and its service
- a module feature → `backend/app/modules/<module>/`
- a semantic behaviour → the engine, and `DA-Test/Regression-Catalog.md` for what is
  already locked in that area

Reusing the existing abstraction is the default. Introducing a second way to do something
that already exists needs a stated reason.

## 3. Scope it with the guardrail

```bash
python scripts/ci/guardrail_check.py --plan "<one-line intent>" --files <paths you expect to touch>
```

Read the result rather than skimming it: it tells you the layer, which features you are
dragging in, whether you are touching a protected subsystem, and the exact tests that
will be required. A `block` here means your plan is in the wrong place — change the
plan, not the verdict. `unknown` means no rule covers it, which is a reason for more
care, not less.

## 4. Size the change

| Size | What you produce before coding |
|---|---|
| Trivial (typo, copy, styling) | nothing — go to step 8 |
| Small (one surface, one layer, reversible) | a short plan in the conversation |
| Medium/large (new surface, schema change, cross-layer, protected subsystem) | `docs/features/<feature>/{intent,spec,plan}.md` from `docs/features/_TEMPLATE/` |

Do not produce feature artifacts for a small change; do not skip them for a large one.

## 5. State the plan

Whether in-session or committed, the plan must name:

- **Files expected to change**, by layer. If the list crosses a boundary
  (`models` → `services`, authed → public), justify it.
- **Risks** — what could break that the change does not obviously touch. The guardrail's
  impact scope is your input here.
- **Tests required, decided now** — which existing suites must still pass, and what new
  test locks the new behaviour. Naming the tests *after* writing the code produces tests
  shaped to the implementation instead of to the requirement.

## 6. Implement the smallest coherent change

One concern at a time. No unrelated cleanup, no reformatting, no renaming on the way
past. If you discover a second problem, note it and finish the first.

## 7. Verify fast, in the loop

```bash
bash scripts/ci/verify.sh fast
```

Type check plus the QA contracts for what you touched. Seconds, not minutes. Run it
after each meaningful edit, not once at the end.

## 8. Read your own diff

```bash
git diff
```

Look for: debug output left behind, a file you did not mean to touch, a commented-out
block, a default you flipped without meaning to, a secret or an absolute local path.

## 9. Guardrail-validate the patch

```bash
python scripts/ci/guardrail_check.py --diff
```

`block` must be resolved. `warn` means run the named tests. `unknown` must be reported
as unknown.

## 10. Run the required tests

The ones you named in step 5, plus everything the guardrail named. Run them; do not
reason about whether they would pass.

## 11. Self-review against the acceptance criteria

Go back to step 1 and step 5 and check each criterion off against the code that now
exists — not against your memory of what you intended. For a user-visible change, verify
in a **running build** (rebuild + restart, then drive the UI), because a stale standalone
build is a recurring source of false green here.

## 12. Definition of Done

```bash
bash scripts/ci/verify.sh task
```

Then report, concretely:

- files changed, grouped by layer, and why each one had to change
- checks run and their actual results
- tests added and what they lock
- residual risk — including anything the guardrail rated `unknown`, and anything you
  could not verify

If a check fails, you are not done. Say so plainly rather than reporting completion with
a caveat attached.
