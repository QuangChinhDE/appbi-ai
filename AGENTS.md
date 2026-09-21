# AppBI — agent instructions

Provider-neutral entrypoint for any AI coding agent working in this repository
(Codex reads this file directly; Claude Code reads it through `.claude/CLAUDE.md`).

**This file is an entrypoint, not the authority.** It exists to put an agent into the
repository's workflow. What is allowed to ship is decided by executable gates, not by
anything written here.

## What this is

A governed BI platform where **AI is the output**. Data sources → semantic model →
knowledge → reports/AI answers, with governance and observability across all layers.
FastAPI + PostgreSQL/pgvector + Alembic; Next.js App Router + TypeScript; Docker Compose.

Full description: `README.md`. Concept ownership and naming: `KNOWLEDGE_DOMAIN_MODEL.md`.
Read them when the task touches those concepts rather than restating them here.

## Source-of-truth hierarchy

When sources disagree, the higher one wins. Agent instructions are **last** on purpose:

1. **Executable checks** — `scripts/ci/`, `backend/tests/`, `frontend/scripts/`,
   `e2e/tests/`. What actually runs, and the only thing that decides PASS/FAIL.
2. **`scripts/guardrail/guardrail_rules.yaml`** — the formalized architecture, protected
   subsystems, invariants and test registry. Self-audited (`--health`).
3. **Current implementation and contracts** — an existing implementation of the same
   thing beats inventing a second way.
4. **The regression catalog** at DA-Test/Regression-Catalog.md — every fixed bug, its
   root cause, and the test that locks it (`GAP` = nothing locks it). Note that
   that tree is gitignored: it is local-only, absent from a fresh clone and from CI,
   so consult it when you have it and do not assume it is there.
5. **Docs** — `README.md`, `KNOWLEDGE_DOMAIN_MODEL.md`, `docs/**`. Intent; can lag code.
6. **Agent instructions** — this file, `.claude/CLAUDE.md`, `.claude/rules/**`, and any
   personal agent memory. Guidance for getting to the right answer, never the verdict.

If this file and an executable check disagree, the check is right and this file is a bug.

## Before you design: inspect what exists

This codebase almost always already has an implementation of the nearest equivalent.
Read it before adding a parallel one, and reuse its abstractions. A second way to do
something that already exists needs a stated reason, not a preference.

Scope the change with the guardrail before writing code:

```bash
python scripts/ci/guardrail_check.py --plan "<one-line intent>" --files <paths you expect to touch>
```

It answers: right layer? which features does this drag in? is a protected subsystem
involved? which tests become required? A `block` means the plan is in the wrong place —
change the plan, not the verdict. `unknown` means no rule covers it: that is a reason for
more care, not less.

## Read the rule for the area you are touching

Area-specific judgement lives in one file per area. Read the matching one **before
editing**, not after. They are not duplicated here; there is one copy and this is a map
to it. (Claude Code auto-loads these by path; other agents must open them.)

| Touching | Read first |
|---|---|
| `frontend/**` | `.claude/rules/frontend.md` |
| `backend/**` | `.claude/rules/backend.md` |
| `backend/alembic/**`, `backend/app/models/**` | `.claude/rules/database-migrations.md` |
| tests, `e2e/**`, `qa/**` | `.claude/rules/testing.md` |
| semantic services, `backend/app/api/public.py`, `frontend/src/app/d`, `app/embed` | `.claude/rules/semantic-layer.md` |
| `scripts/ci/**`, `scripts/guardrail/**`, `.github/**`, `.githooks/**`, `.claude/**`, this file | the protection rules below |

## Architecture boundaries

Formalized in `guardrail_rules.yaml` (`layers`). The ones violated in practice:

- `backend/app/models/**` must not import services. Business logic lives in
  `backend/app/services/**`. Routers under `api/**` are NOT thin here
  (`api/datasets.py` is ~6,950 lines) — put *new* logic in a service, and do not
  refactor a fat router as a side effect.
- The **public surface** (`frontend/src/app/d/[token]`, `app/embed/[token]`,
  `backend/app/api/public.py`) uses `publicClient` **only**. One authed call from a
  public page is a data-exposure bug, not a style issue.
- A backend/data/semantic problem is never fixed in the frontend. If the number is
  wrong, the fix goes where the number is produced.
- Three subsystems are **protected** (`guardrail_rules.yaml: protected`): the semantic
  layer, public-link security, and the engineering infrastructure itself. Smallest
  surgical change; named gates required.

## Change discipline

- **Minimize blast radius.** No unrelated cleanup, no drive-by refactors, no reformatting
  files you only touched incidentally. Finish the task you were given.
- **Do not fix the wrong layer.** Patching a display to hide a backend defect is the
  single most-repeated mistake in this repository's history.
- **Commit runtime code.** A change whose product effect lives only in
  `backend/scripts/**`, the gitignored DA-Test tree, `scratchpad/**` or a `*.spec.ts`
  is not a product fix.
- Migrations: additive, single head, parent committed.
- SQL generation must be correct on **BigQuery and Postgres**. Postgres locally hides
  correlated-subquery and implicit-cast failures BigQuery rejects hard.
- New backend test files are git-ignored by default and silently never run. The wiring is
  in `.claude/rules/testing.md`.
- Local artifacts — screenshots, response dumps, QA output — go in `.artifacts/`, never
  the repo root.

## Running it locally — two modes that behave differently

| | Command | Source changes |
|---|---|---|
| **Prod-style** | `./run.sh` (base `docker-compose.yml` only) | **baked into the image** — an edit does nothing until you rebuild, or `docker cp` the file in and restart |
| **Dev** | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | hot-reloaded — `backend/app` and `frontend` bind-mounted, uvicorn `--reload` |

`run.sh` does **not** apply the dev override. This is the most common source of "I fixed
it but nothing changed": you edited source while a prod-style build served the old bundle.
Before concluding a fix failed, check which mode is running (`docker ps` — dev containers
are `appbi-backend-dev` / `appbi-frontend-dev`).

## Never weaken the protection system

`scripts/ci/**`, `scripts/guardrail/**`, `.github/workflows/**`, `.githooks/**`,
`.claude/**`, `AGENTS.md`, and the regression/test contracts decide whether anything else
may ship.

**Do not modify, disable, delete or weaken a test, an invariant, a required gate, a CI
step or a hook in order to make your own change pass.** That includes deleting an
assertion, marking a gate `missing`/`untracked`/`manual`, removing a verification step,
and making the Stop gate fail-open.

Changing these files is legitimate — improving a gate is good work. It must be
deliberate, declared in the change description, and never a side effect of an unrelated
task. A trusted copy of `scripts/ci/check_protection_integrity.py` taken from the merge
base inspects `base..head` in CI, so editing the checker in the same change does not
disable it.

If a test blocks you and you believe the test is wrong, say so and stop. Do not edit it
quietly.

## Definition of Done — the same for every agent

One canonical command, machine-readable and human-readable:

```bash
python scripts/ci/verify.py task          # add --json for a structured result
```

It resolves the guardrail's required gates for what you changed and runs the ones that
can run here. You may not report a task complete until:

1. `verify.py task` passes for the paths you changed.
2. The guardrail verdict is resolved: `block` fixed; `warn` means you ran the named
   tests; **`unknown` is not `safe`** — say so explicitly.
3. Every gate printed under `NOT VERIFIED` (missing / untracked / manual / needs a
   warehouse) is named in your report as unverified, with its reason.
4. You state what you changed, what you ran, what passed, and the residual risk.

**Three distinct states. Do not collapse them:**

| State | Meaning |
|---|---|
| `PASS` | the gate ran and succeeded |
| `FAIL` | the gate ran and failed — the task is not done |
| `NOT VERIFIED` | the gate did not run. **Never report this as coverage.** |

`UNKNOWN` coverage is not `SAFE`. A gate that could not run is not a gate that passed.
Reporting "done, but X is failing" is only acceptable if you also say plainly that the
task is **not** complete.

## Sizing a change

| Size | What to produce |
|---|---|
| Trivial — typo, copy, styling | nothing; implement and run the fast check |
| Small — one surface, one layer, reversible | a short plan stated before coding |
| Medium/large — new surface, schema change, cross-layer, protected subsystem | `docs/features/<feature>/{intent,spec,plan}.md` from `docs/features/_TEMPLATE/`, presented for human approval **before** implementing |

For medium/large work: present the plan and stop. Wait for an explicit go-ahead. Silence
is not approval.

## Commands

```bash
python scripts/ci/verify.py fast     # coding loop: typecheck + touched QA contracts
python scripts/ci/verify.py task     # before claiming done (canonical DoD)
python scripts/ci/guardrail_check.py --plan "..." --files ...   # scope before coding
python scripts/ci/guardrail_check.py --diff                     # review your own diff
python scripts/ci/guardrail_check.py --health                   # gate registry status
bash   scripts/ci/preflight.sh       # commit-integrity gate (also runs on push)
```
