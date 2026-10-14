# Authorization remediation — implementation plan

## Guardrail scoping

```text
python scripts/ci/guardrail_check.py --json --plan "Unify authorization contract and fix P1 authz findings" \
  --files backend/app/core/dependencies.py backend/app/api/public.py backend/app/services/dataset_grants_service.py \
          backend/app/modules/workboards/workspace_admin_api.py backend/app/api/observability.py
```

- **Verdict:** `warn`
- **Matched feature:** `auth_permissions`. The owner files are `api/auth.py`, `api/permissions.py`, `core/dependencies.py`, `hooks/use-permissions.ts` and `lib/auth.ts`.
- **Out-of-scope files flagged:**
  - `public.py`
  - `dataset_grants_service.py`
  - `workspace_admin_api.py`
  - `observability.py`

  They are needed: each contains a confirmed finding. The guardrail's rule base has no feature covering cross-module authorization, which is itself evidence for gap #17. A rule for the new `core/authz` will be added to `guardrail_rules.yaml` (declared engineering-infra change).
- **Protected subsystems:** `public_link_security`. The semantic layer (object access only) and the engineering infrastructure (CI and gates) are also touched, and that will be declared.
- **Required tests named:** `import_smoke`, `layered_merge`, `galaxy_golden`, `distinct_cascade_bq`, `pair4_surfaces`. These are protected-public suites and must stay green.

## Ordering principle

1. Gate 0 contains every exploitable P1 with the smallest surgical patch on the existing helpers, so the exposure closes early. Each fix lands with its own HTTP regression test.
2. Later gates replace those patches with calls into the new contract. The regression tests stay and must keep passing, which proves the migration did not reopen anything.
3. Each gate ends with `verify.py task` green, a commit, and a push of the branch (no merge).

## Gates

### Gate T: test environment first (blocker for everything else)

| # | Change |
|---|---|
| T1 | Run backend security tests in a pinned venv or the backend image (`fastapi==0.109.0`). Add `scripts/ci/run_security_tests.sh`. The local 0.141.1 stays out of the loop. |
| T2 | Make `test_module_floor` hard-fail on a route count below the pinned minimum, or on missing expected router prefixes (workboards, workspaces, observability, govern, agent_flows, chat). |
| T3 | Add a CI job with `WORKBOARDS_ENABLED` and all module flags on. Wire `test_workboard_app_user_roles.py`. Remove the dangling reference to `test_permission_caps.py` by creating that file (PAT matrix, Gate 1). |
| T4 | Add a Postgres service job: owner role plus a non-superuser `appbi_app` role, `-m pg` marker. Running it is mandatory: a skip counts as a fail in this job. |

### Gate 0: P1 containment (surgical, on current helpers)

| # | Finding | Fix |
|---|---|---|
| 0.1 | H1 | entrypoint, config validator and `bootstrap-env.sh`: production fails closed; dev gets a random password and `must_change_password` (M1) |
| 0.2 | F-WB1 | remove the `_internal → True` bypass; a staff session requires Workboard view/edit via `get_effective_permission`; staff are no longer RLS-exempt by flag |
| 0.3 | F-WB2 | workspace list scoped by owner and share; token masked; mutations require owner or module full; a menu slug requires Workboard edit |
| 0.4 | N-DS1 | no stored-secret rehydration when an endpoint field changes; `test` with a stored id requires edit |
| 0.5 | H9 | global channel lifecycle requires `observability: full`; dataset channel mutation requires the owner or dataset edit; minimal egress deny-list on webhook (completed in Gate 4) |
| 0.6 | H4/H4b | revoke requires exactly one valid UUID; grant verb ≤ the grantor's set; no self-grant |
| 0.7 | H8 | global scan requires `observability: full` |
| 0.8 | N-PAT1 | replace the three raw `current_user.permissions` reads with the normalized getter |
| 0.9 | H12 | reject a missing `type`; type check in `public.py`; OAuth state gets a `type` and is refused by `get_current_user` |
| 0.10 | N-DB1, N-AF1 | mask tokens for non-full callers; binding requires dashboard full |
| 0.11 | H7 | credential export requires full; OCR keys stripped from export |

Each row gets an HTTP regression test that fails first on base and passes after. The fail-first runs are recorded.

### Gate 1: authorization core

New package `backend/app/core/authz/`:

- `principals.py`
- `actions.py`
- `registry.py`: the single source for modules, levels and resources
- `decision.py`: `can`, `require`, `scope`, `require_all`, obligations
- `policies/`: `generic_share.py` (today's correct ResourceShare logic moved here) and `dataset.py`
- `system.py`
- `egress.py`
- `audit.py`

Then:

- `get_effective_permission`, `batch_effective_permissions` and `_owned_or_shared` become thin wrappers over `authz` and are deprecated. Callers migrate per gate; the wrappers are deleted in Gate 7.
- `_relation_level` owner columns come from the registry, which fixes the chat-thread `user_id` owner case (N-CT1).
- Add `authz_route(...)` route declarations plus the route-coverage test. It starts as report-only and becomes enforcing at the end of Gate 7.
- Tests:
  - property tests (`hypothesis`, already a dependency? if not, add it to dev requirements): PAT ⊆ human; module none ⇒ deny; list ≡ read; unknown action/resource ⇒ deny; team ≡ direct;
  - a unit matrix.
- M8 audit columns.

### Gate 2: DataSource and Dataset canonicalization

- Dataset policy (`policies/dataset.py`) as specified in spec §5. `dataset_grants_service` becomes a storage adapter only, and the `TeamMember` bug disappears with it.
- M3 migration of ResourceShare(DATASET) rows.
- Dual-evaluation: during this gate, old and new decisions are compared in tests over a generated state space. Every mismatch is either an intended change (documented in spec) or a bug. The old path is then removed in the same gate. Nothing runs dual in production.
- Migrate every call site from the review's inventory (≈60), including charts, dashboards, HTML import, workboards bind, agent-flow attach and composition.
- DataSource actions: `use_secret`, `explore`/query, and the full egress module wired into the connectors (Postgres, MySQL/others found in `connectors/`, HTTP-based Sheets/BigQuery use Google hosts → skipped by allow-list).
- Runtime verification:
  - stand up an attacker listener container;
  - attempt the `/datasources/test` host swap per connector against the branch stack: before = credentials received, after = refused;
  - BigQuery verified hermetically (mock transport), recorded as external-unverified.

### Gate 3: Chart, Dashboard, Public/Embed

- `manage_public_surface`.
- Token masking via obligations.
- Snapshot refresh `trigger_compute` plus rate limit.
- Embed grant owner liveness.
- Runtime: locked-filter widening attempts against `/d` and `/embed` (logged-out), on the dev stack. The protected suites `pair4`, `layered_merge` and public lifecycle must stay green.

### Gate 4: Govern and Observability

- Scoped Govern reads; caveat write checks; Govern admin action for global objects.
- M2 channel scope; scan model; `System` principal in the scheduler; egress for webhook/SMTP; rate limit.
- SSRF runtime test: a webhook to `169.254.169.254`, `127.0.0.1` and a DNS name resolving to private space → refused. Redirects are not followed.

### Gate 5: Agent Flow, Chat, Credentials

- M6 `delegation_mode`; `run_scope` = intersect unless `owner_data`; metric filtering; audit `Delegated`.
- Binding uses `manage_public_surface`; the chat-thread owner fix gets tested through HTTP.

### Gate 6: Workboard, Workspace, runtime/RLS

- Workspace resource (M4), session epoch/jti (M5), DB re-read of app-user role, media/miniapp/export/credentials/OCR actions, random one-time PIN.
- Postgres: RLS tests with the app role, including pk-scoped update/delete under RLS. Also the Knowledge chunk RLS with the app role, and the startup check that the app role is not superuser/BYPASSRLS.
- Runtime: cross-workboard staff attack; OCR export→import→reveal; bind/rebind with a view-only grant then write-back.

### Gate 7: legacy removal and enforcement

- M7 drops `module_permissions`; delete the deprecated wrappers and duplicate maps.
- Enforce the CI checks: forbidden reads, route coverage, registry ↔ frontend schema. Add the `core/authz` feature to `guardrail_rules.yaml`.
- Full regression (backend, all flags; pg; frontend `tsc` and build; e2e security specs), then a fresh adversarial review pass (§43 of the brief) by a separate reviewer agent that did not write the code. Fix what it finds and re-run.
- Rebase on the latest `origin/demo`. Any new auth path is brought under the contract and the gates are re-run.

### Gate E: Playwright security suite (runs alongside Gates 2–7)

`e2e/tests/security/*.spec.ts` against the real stack (frontend + backend + Postgres, pinned deps). Principal fixtures: owner, viewer, editor, module admin, unrelated, team member, PAT caller, app user, public visitor, delegated caller — each its own browser context / API context created by a seed fixture. No sleeps, no retries counted as pass (`retries: 0` for the security project). Journeys: Dataset verbs + grants, DataSource host-swap (receiver container), Workboard/Workspace, Dashboard/Public, Observability, Agent Flow delegation, PAT, token domains. Each journey asserts a deny AND an allow.

## Risks

| Risk | How it shows up | Catch |
|---|---|---|
| Dataset narrowing breaks existing reports | chart reads 403 for VIEW sharees | M3 maps VIEW→build; dual-evaluation diff over generated states; pair4 suites |
| Public surface regression (protected) | `/d` or `/embed` renders empty or refused | public lifecycle, pair4, layered_merge, and logged-out browser verification |
| Forced re-login (security stamp, HKDF keys) | every user logs in again once | expected and documented; PATs unaffected |
| Workboard staff lose write | internal workspaces previously worked via view | migration report; owners grant edit |
| Egress blocks on-prem warehouses | test or connection refused | `EGRESS_ALLOW_PRIVATE_CIDRS`; dev permissive; startup log |
| N+1 from per-row decisions | list pages slow | `scope()` is SQL-side; query-count tests on datasets, charts, dashboards, workboards, flows and observability lists (before/after recorded) |
| Size of the change | review fatigue | one commit per gate item; Gate 0 is reviewable alone |

## Tests: decided now

New backend test files are force-added, put on the allow-list, and wired into `backend-contract-tests.yml`.

| Test | What it locks |
|---|---|
| `test_authz_gate0_regressions.py` | one HTTP abuse test plus a positive control per Gate 0 row |
| `test_authz_properties.py` | property invariants 1, 5–8, 13–15 of the brief |
| `test_permission_caps.py` | PAT matrix: human edit + PAT view, full + none, demotion, revoked, expired, empty scope |
| `test_dataset_policy.py` | verb matrix × owner/direct/team/module/PAT; grant anti-escalation (self, other, team, replace, up/down, no target, both, invalid, membership change, grantor loses authority) |
| `test_authz_route_coverage.py` | every route declared; route count ≥ minimum; zero = fail |
| `test_authz_static_rules.py` | forbidden raw reads/imports and `System(` construction |
| `test_token_domains.py` | every token class against every decoder |
| `test_egress_policy.py` | private/metadata/redirect/rebinding |
| `test_workspace_authz.py`, `test_workboard_export_authz.py` | workspace, runtime, export, media |
| `test_observability_authz.py`, `test_govern_authz.py`, `test_agent_flow_delegation.py` | per module |
| `test_authz_rls_pg.py` (pg marker) | app role RLS, pk update/delete, constraints, revocation visibility |
| `test_authz_list_query_counts.py` | no N+1 |

Existing suites that must stay green: everything in `backend-contract-tests.yml`, plus the guardrail-named public suites and frontend `tsc`/build.

## Verification

- Every attack path in the review is re-run against the branch stack (dev compose), with before/after recorded in `.artifacts/authz-remediation/`.
- Browser check (browser-verifier):
  - public link logged-out;
  - viewer sees a masked token;
  - workspace admin list;
  - Workboard one-time PIN.

## Rollback

- Each gate is a separate commit range on the branch. Nothing reaches `demo` without approval.
- Migrations:
  - **M3:** source rows are kept in `resource_shares_archive`; the downgrade re-inserts them.
  - **M7:** the downgrade recreates the table from `authz_legacy_archive`.
  - **M1** and the HKDF keys force one re-login. That is not reversible, but harmless.
- The rest is additive columns.

## Size and honesty note

This is a multi-week change across ~60 dataset call sites, ~540 route decorators, 8 migrations and 3 protected subsystems. It will be delivered gate by gate with evidence. Nothing will be reported READY until the DoD in the brief is met.
