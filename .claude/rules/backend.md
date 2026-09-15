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
api/**  routers/**     thin: validate → authorize → delegate → shape response
services/**            business logic, SQL generation, the semantic engine
modules/**             self-contained features: agent_flows, metadata_catalog, workboards
models/**              SQLAlchemy ORM only — must NOT import services
schemas/**             Pydantic request/response contracts
core/**                config, dependencies, security (high blast radius)
```

- Never put business logic in a router. Never import a service from a model.
- `backend/app/scripts/**` is tooling, not runtime. A product fix that lives only there
  is not a product fix.

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
message; keep messages actionable. It is locked by
`backend/tests/test_phase15_error_contracts.py` — read it before changing an error shape.

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
