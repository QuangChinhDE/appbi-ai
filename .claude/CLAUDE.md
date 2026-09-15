# AppBI — project instructions for Claude

## What this is

A governed BI platform where **AI is the output**. Data sources → semantic model →
knowledge → reports/AI answers, with governance and observability across all layers.
FastAPI + PostgreSQL/pgvector + Alembic; Next.js App Router + TypeScript; Docker Compose.

Full description: `README.md`. Concept ownership and naming: `KNOWLEDGE_DOMAIN_MODEL.md`.
Do not restate either here — read them when the task touches those concepts.

## Architecture boundaries you must not cross

Layering is formalized in `scripts/guardrail/guardrail_rules.yaml` (`layers`).
The ones that get violated in practice:

- `backend/app/models/**` must not import services. Business logic lives in
  `backend/app/services/**`. Routers under `api/**` are NOT thin here (`api/datasets.py`
  is ~6,950 lines) — put *new* logic in a service, and do not refactor a fat router as a
  side effect. Detail: `.claude/rules/backend.md`.
- The **public surface** (`frontend/src/app/d/[token]`, `app/embed/[token]`,
  `backend/app/api/public.py`) uses `publicClient` **only**. One authed call from a
  public page is a data-exposure bug, not a style issue.
- A backend/data/semantic problem is never fixed in the frontend. If the number is
  wrong, the fix is where the number is produced.
- Two subsystems are **protected** (`guardrail_rules.yaml: protected`): the semantic
  layer and public-link security. Smallest surgical change, named gates required.

## Source-of-truth hierarchy

When sources disagree, the higher one wins:

1. **Executable checks** — the tests and scripts in `scripts/ci/`, `backend/tests/`,
   `frontend/scripts/`, `e2e/tests/`. What actually runs.
2. **`guardrail_rules.yaml`** — formalized architecture/invariant contract, self-audited
   (`check_rules_health`, `verify_semantic_contract`) and verified green.
3. **Current code patterns** — an existing implementation of the same thing beats
   inventing a second way.
4. **`DA-Test/Regression-Catalog.md`** — every fixed bug, its root cause, and the test
   that locks it (or a `GAP` marker meaning nothing locks it).
5. **Docs** (`README.md`, `KNOWLEDGE_DOMAIN_MODEL.md`, `docs/**`) — intent; can lag code.
6. **Claude memory** — a hint about where to look, never an authority. Verify before acting.

## Running it locally — two modes, and they behave differently

| | Command | Source changes |
|---|---|---|
| **Prod-style** | `./run.sh` (base `docker-compose.yml` only) | **baked into the image** — an edit does nothing until you rebuild, or `docker cp` the file in and restart the container |
| **Dev** | `docker compose -f docker-compose.yml -f docker-compose.dev.yml up` | hot-reloaded — `./backend/app` and `./frontend` are bind-mounted, uvicorn runs `--reload`, Next.js polls |

`run.sh` does **not** apply the dev override. This is the single most common source of
"I fixed it but nothing changed": you edited source while a prod-style build was serving
the old bundle. Before concluding a fix failed, confirm which mode is running
(`docker ps` — dev containers are `appbi-backend-dev` / `appbi-frontend-dev`).

## Scoped rules — read the one for the area you are in

| Working in | Read |
|---|---|
| `frontend/**` | `.claude/rules/frontend.md` |
| `backend/**` | `.claude/rules/backend.md` |
| `backend/alembic/**`, `backend/app/models/**` | `.claude/rules/database-migrations.md` |
| tests, `e2e/**`, `qa/**` | `.claude/rules/testing.md` |
| semantic services, `api/public.py`, `app/d`, `app/embed` | `.claude/rules/semantic-layer.md` |

## Required workflow

- Trivial change (typo, copy, one-line style): implement, run the fast check, done.
- Small feature / contained bug: short in-session plan first, then implement.
- Medium or large feature: `docs/features/<feature>/{intent,spec,plan}.md` before code
  (`docs/features/_TEMPLATE/`). Sizing policy: `.claude/rules/testing.md`.
- Use the skills rather than improvising the sequence:
  `/implement-feature`, `/fix-bug`, `/review-change`.

Never start a medium/large feature by writing code. Inspect the existing implementation
of the nearest equivalent first — this codebase almost always already has one.

## Change discipline

- Read the existing implementation before adding a parallel one. Reuse its abstractions.
- Minimize blast radius. No unrelated cleanup, no drive-by refactors, no reformatting
  files you only touched incidentally.
- **Commit runtime code.** A commit whose product change lives only in
  `backend/scripts/**`, `DA-Test/**`, `scratchpad/**`, `scripts/guardrail/**` or a `*.spec.ts`
  is not a product fix (`guardrail_rules.yaml: policy.commit_only_runtime`).
- Migrations: additive, single head, parent committed. See `.claude/rules/database-migrations.md`.
- SQL generation must be correct on **BigQuery and Postgres**. Postgres locally hides
  correlated-subquery and implicit-cast failures BigQuery rejects hard.
- New backend test files are git-ignored by default and silently never run. The wiring is
  in `.claude/rules/testing.md`.
- Local artifacts — screenshots, response dumps, QA output — go in `.artifacts/`, never
  the repo root.

## Definition of Done

You may not report a task complete until:

1. `python scripts/ci/verify.py task` passes for the paths you changed. It resolves the
   guardrail's required gates and runs the ones that can run here.
2. Guardrail verdict is resolved: `block` must be fixed; `warn` means you ran the named
   tests; **`unknown` is not `safe`** — it means no rule covers it, so say so explicitly.
3. Every gate `verify.py` printed under `NOT VERIFIED` (missing / untracked / manual /
   needs a warehouse) is named in your report as unverified. A gate that did not run is
   never presented as coverage.
4. You state what you changed, what you ran, what passed, and what residual risk remains.

The Stop hook enforces points 1 and 3 rather than trusting them:

- **Nothing failed, gates unverified** → blocks the turn **once**, listing their names and
  reasons on stderr (Claude Code sends a hook's stdout to the debug log on exit 0, so that
  list would otherwise be invisible). Not a failure: add the named gates to your report as
  unverified and finish again — the retry is allowed.
- **Verification failing** → blocks **every** time until it is green. A red check is not a
  one-shot warning, and finishing is not unlocked by having been told once. Claude Code's
  own cap on consecutive Stop blocks is the loop protection, not this hook.

If a check fails, fix it. Reporting "done, but X is failing" is only acceptable when you
also say plainly that the task is *not* complete.

## Learning rule

If the same class of mistake is corrected more than once, saving it to personal memory is
not enough — memory is not loaded for anyone else and is not enforced. Route it to the
layer that can actually prevent recurrence, in this order of preference:

| The mistake is… | Put it in |
|---|---|
| mechanically checkable on a diff/file | a check in `scripts/ci/` or an invariant in `guardrail_rules.yaml` |
| behavioural | a test in `backend/tests/` (+ allow-list + workflow) or `e2e/tests/` |
| area-specific judgement | the matching `.claude/rules/*.md` |
| universal to every session | this file |
| a bug worth remembering | a row in `DA-Test/Regression-Catalog.md` |

Prefer the highest-enforcement layer that fits. Propose the change; do not silently widen
rules on your own.
