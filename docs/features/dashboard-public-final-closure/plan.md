# Dashboard Public / Embed final closure — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --plan "Public dashboard/embed final closure …" --files <all changed paths>
```

- Verdict: **warn**
- Feature matched: `dashboard_build_render`; most files fall outside a declared feature
  owner (the public/embed surface has no feature row in `guardrail_rules.yaml`) — noted,
  not a block.
- Protected subsystems involved: **public_link_security**, **semantic_layer**
  (literal escaping in `semantic_query_engine` / `live_query_service` / `sql_pattern`).
- Required gates it named: alembic_chain, dialect_structural, layered_merge,
  public_authoritative_bounds (+_pg), surface_parity, pair1–pair5, golden_sql,
  galaxy_golden, filter_matrix, distinct_cascade_bq, relationship_contract(_pg),
  semantic_foundation, measure_render, semantic_state_contracts, semantic_router_access,
  tsc, import_smoke, browser_verify. All are run by `backend-contract-tests.yml`
  (unit + integration-golden) and `e2e.yml`; replayed locally in a pinned python:3.11
  container against pgvector before merge.

## Files and layers, in order

1. **Token authority** — `api/public.py` resolver, `api/dashboards.py` (/share 410,
   auth_version, expiry, preview), `models/models.py`, `schemas/schemas.py`, migration
   `20261004_0001`, `modules/workboards/api.py` (manual token audit).
2. **SQL literals** — `services/sql_literal.py` (new, canonical), routed through
   `semantic_query_engine.py`, `live_query_service.py`, `dataset_model_service.py`,
   `sql_pattern.py`.
3. **Client IP** — `core/trusted_proxy.py`, `main.py`, `entrypoint.sh`.
4. **Integration embed** — `api/integrations.py`, `services/embed_link_service.py`,
   `frontend/src/lib/embed-framing.ts`, `frontend/src/middleware.ts`.
5. **Hygiene** — `core/log_safety.py`, `services/pdf_export_service.py`.
6. **Parameters** — `services/dashboard_parameters.py`; public data endpoints; FE libs
   `chart-instance-parameters.ts`, `dashboard-params.ts`; `PublicDashboardView.tsx`;
   Builder page passes `parameter_fields`.
7. **Render parity** — `lib/dashboard-pages.ts` (one row height).
8. **Preview / UI** — `PublicLinksManager.tsx`, `PublicLinkAppearanceEditor.tsx`, types.
9. **Docs** — `docs/embed-integration-api.md`, `docs/embed_quickstart.py` (tracked).

## Tests decided before coding

| Contract | Test | Kind |
|---|---|---|
| token authority, sessions, expiry, preview | `test_public_token_lifecycle.py` | HTTP (TestClient, SQLite) |
| literal safety per dialect | `test_sql_literal_security.py` | lexer + sqlglot over real builders |
| client IP / rate limit | `test_trusted_proxy_client_ip.py` | ASGI + slowapi |
| embed mint auth, grant life, policy states, origins | `test_embed_integration_security.py` | HTTP via real auth dependency |
| parameter semantics + public data path | `test_dashboard_parameter_parity.py` + shared vectors | unit + HTTP |
| framing decision | `check-embed-framing-contract.mjs` | executes the middleware's decision code |
| FE parameter parity | `check-dashboard-parameter-parity.mjs` | shared vectors + wiring |
| one row height | `check-unified-grid-contract.mjs` | lib execution |
| Builder ↔ /d ↔ /embed geometry + data, params, preview | `e2e/tests/public-parity.spec.ts` | Playwright, full stack |

Every new backend test is allow-listed in `.gitignore` and listed in
`backend-contract-tests.yml`; every FE check is in `npm run qa` (preflight).

## Rollback

- Code: revert the merge commit. The migration's columns are additive and harmless to
  older code. The two data changes are intentionally not reversed by `downgrade()`:
  restoring legacy share tokens would restore the revocation bypass; capped links can be
  re-enabled by hand.
- Grants minted before the deploy stop working at deploy time (they had no PAT recorded);
  integrations re-mint as part of their normal hourly rotation.
- Ops: if a load balancer sits in front of nginx, set `TRUSTED_PROXY_HOPS=2` before
  deploying, otherwise every viewer behind it shares one rate-limit bucket.
