---
name: review-change
description: Review a change in AppBI (working diff, staged diff, or a branch) for wrong-layer fixes, boundary violations, regressions, security and missing test coverage. Use before committing or when asked to review existing work.
---

# Review a change

Review the code that exists, not the reasoning that produced it. If you implemented this
change yourself, start from the diff as if someone else wrote it: do not re-use your
earlier justifications, and treat "I remember checking that" as unverified.

## 1. Establish what is being reviewed

```bash
git diff                 # working tree
git diff --cached        # staged
git diff master...HEAD   # a branch
```

Read the whole diff before forming an opinion on any part of it.

## 2. Establish the acceptance criteria

From the request, the issue, or `docs/features/<feature>/intent.md`. A review without
criteria degrades into a style opinion. If no criteria exist, state the ones you are
reviewing against so they can be disputed.

## 3. Run the machine checks first

```bash
python scripts/ci/guardrail_check.py --diff
bash scripts/ci/verify.sh task
```

These answer the mechanical questions (layering, protected subsystems, invariant removal,
type errors, QA contracts, orphaned tests) so your attention goes to what only a reader
can catch. Report their real output; do not summarize a failure as a nit.

## 4. Review checklist

Work through every item. Say "checked, nothing found" rather than silently skipping —
an unstated omission reads as a pass.

**Acceptance criteria** — does the change actually do what was asked, including the parts
that are inconvenient? Is anything in the diff *not* asked for?

**Wrong-layer fix** — is a symptom being handled where it appears rather than where it
originates? A frontend guard, a default value, a `try/except` or a fallback that makes a
bad value look fine is the signature.

**Architecture boundaries** — model importing a service; business logic in a router; a
public/embed surface importing `apiClient`; a second implementation of something that
already exists in `lib/` or `services/`.

**Regressions** — what behaviour, not mentioned in this change, runs through the lines it
touched? Check `DA-Test/Regression-Catalog.md` for bugs previously fixed in this area: is
this change re-opening one? A removed guard, an inverted condition, a changed default.

**Security and authorization** — every new or modified endpoint gated at the router with
`require_permission` / `module_floor` / `require_*_access`. Locked and hidden filters
still enforced server-side. No credential, token, absolute local path, or `.env` value in
the diff. Nothing newly logged that contains a query string with credentials.

**Data and migrations** — model change without a migration, or vice versa; a destructive
operation; a `down_revision` whose parent is not committed; a privileged statement. Is
the change safe to run against a database that already has production data?

**Type and runtime errors** — what the type checker cannot see: a nullable value used
unguarded, an `any` covering a shape mismatch, an awaited call that is not async, a lazy
import that only fails on the touched code path.

**Test coverage** — is there a test that would have failed before this change and passes
after? For a bug fix, that is mandatory. A new backend test must be in the `.gitignore`
allow-list and the CI workflow, or it does not exist as far as anyone else is concerned.

**Unrelated changes** — reformatting, renames, drive-by cleanup, debug output,
commented-out code, a stray artifact file.

**Dialect** — any SQL-generation change validated on BigQuery, not only Postgres.

## 5. Report

Findings in severity order. For each: the file and line, what is wrong, and a concrete
failure scenario — inputs or state that produce the bad outcome. A finding you cannot
turn into a failure scenario is a suggestion; label it as one.

End with a plain verdict: what must be fixed before this ships, what is optional, and
what you could not verify. If the change is sound, say so directly rather than
manufacturing findings to look thorough.
