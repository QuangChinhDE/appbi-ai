---
name: backend
description: FastAPI layering, auth and error conventions for AppBI's backend. Load when editing backend/app.
globs:
  - "backend/**"
---

# Backend rules

Scope: `backend/app/**`. FastAPI, SQLAlchemy, PostgreSQL + pgvector.

## Layering (formalized in guardrail_rules.yaml: layers)

```
api/**                 HTTP routers, mounted by api/__init__.py under /api/v1
routers/**             one module only: semantic.py, the direct semantic API
services/**            business logic, SQL generation, the semantic engine (~84 files)
modules/**             self-contained features: agent_flows, metadata_catalog, workboards
models/**              SQLAlchemy ORM — verified: imports no service today. Keep it that way.
schemas/**             Pydantic request/response contracts
core/**                config, dependencies, security (high blast radius)
```

**Routers here are not thin, and pretending otherwise will mislead you.**
`api/datasets.py` is ~6,950 lines, `api/public.py` ~4,600, `api/dashboards.py` ~2,960.
That is the real shape of this codebase. Two consequences:

- Put **new** business logic in `services/**`, not in the router you happen to be editing.
- Do **not** refactor an existing fat router as a side effect of an unrelated change.
  Shrinking `datasets.py` is its own project with its own risk budget, not drive-by work.

`backend/app/scripts/**` is tooling, not runtime. A product fix that lives only there is
not a product fix.

## Modules are behind feature flags

`api/__init__.py` imports a module's router **only when its flag is on** (`core/config.py`):

| Flag | Default | Gates |
|---|---|---|
| `WORKBOARDS_ENABLED` | `False` | `modules/workboards` — api, webhook_api, workspace_admin_api |
| `METADATA_CATALOG_ENABLED` | `False` | `modules/metadata_catalog` **and** `modules/agent_flows` (api + chat_api) |
| `GOVERN_ENABLED` | `True` | Intelligence modules; effective only when the catalog flag is on |
| `OBSERVABILITY_ENABLED` | `True` | `api/observability.py` |
| `PDF_EXPORT_ENABLED` | `False` | server-side render |

So: a new endpoint on a flagged module must be registered **inside that flag's block**, or
it silently does not exist. And an endpoint that 404s may simply be a flag that is off —
check the flag before hunting for a routing bug. Registration order matters too:
`agent_flows.chat_api` is mounted after the studio router so `/agent-flows/chat/*` is not
swallowed by an `/agent-flows/{id}` route above it.

## Authorization

All of it comes from `backend/app/core/dependencies.py`. Use what is there:

- `require_permission(module, min_level)` — module-level gate on the **router**.
- `module_floor(module)` — the module level is a ceiling over per-resource grants.
- `get_effective_permission` / `require_view_access` / `require_edit_access` /
  `require_full_access` — per-resource checks.

Gate at the router, on every endpoint of a module — including the ones that look harmless.
An endpoint that reads is a `view` gate; anything that writes is `edit`. A new endpoint
added to a gated module without a gate is a hole, and the frontend hiding the button does
not close it.

`backend/app/api/public.py` is an unauthenticated data-exposure surface: locked and hidden
filters must stay enforced server-side, and scope bounds must not be relaxed for
convenience. Changes here require the `public_link_security` gates.

## Errors

Follow the established contract: `ValueError` → 400 with a user-facing (Vietnamese)
message; keep messages actionable. It is real and widespread — ~74 `except ValueError`
handlers across `api/*.py`.

**But it is not actually locked.** `backend/tests/test_phase15_error_contracts.py` exists
on some machines and is neither tracked nor in CI, so it protects nothing on a fresh
clone. Read it if you have it; do not assume a red test will catch you if you change an
error shape. `python scripts/ci/guardrail_check.py --health` lists every registered test
that cannot actually be run.

## Wrong-layer fixes

If a number is wrong, a filter is ignored, or a value is missing, the fix is in the layer
that produces it — service/semantic/data — not in the component that displays it. Patching
the display to hide a backend defect is the single most-repeated mistake in this repo's
history and the guardrail is configured to flag it.

## SQL and dialects

Generated SQL must be valid on **both** BigQuery and Postgres. Local Postgres accepts
correlated subqueries and implicit casts that BigQuery rejects with a hard 400. Any
SQL-generation change needs a dialect-structural check, not just "it worked locally"
(`guardrail_rules.yaml: policy.dialect_blindness`).

## Verification

- Import smoke: `python -c "import app.main"` — lazy imports hide breakage until runtime.
- Run the tests the guardrail names for the files you changed
  (`get_required_tests`, or `python scripts/ci/guardrail_check.py --files …`).
