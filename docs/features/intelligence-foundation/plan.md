# AppBI Intelligence — Foundation (Phase 0–1) — plan

## Ground rules for every PR

1. Each PR has its own branch off the current `origin/demo` and targets `demo`.
2. The PR description carries:
   - baseline SHA;
   - capability;
   - contracts touched;
   - risk;
   - tests;
   - rollback;
   - evidence.
3. Each fix removes its ledger `xfail` in the same commit (`security-matrix.md`).
4. The size class follows `docs/features/README.md`:
   - **small:** a short plan, then code;
   - **medium/large or protected:** this plan, plus explicit PO/human approval
     before code.
5. The definition of done is `python scripts/ci/verify.py task`, plus the guardrail's
   named tests. Every gate that did not run is reported as `NOT VERIFIED`.
6. Merge to `demo` only through a PR, after the required checks.
   - Never `master`.
   - Never production.
   - Never a migration against real data.

## Guardrail scoping (run 2026-10-19)

```
python scripts/ci/guardrail_check.py --plan "Phase 0 security containment for AI data access" \
  --files <agent_flows dispatch/registry/context, api/datasources, datasource_service,
           semantic_query_engine, knowledge_context, knowledge, api/public>
```

- **Verdict:** `warn`.
- **Protected subsystems touched:**
  - `semantic_layer` (`semantic_query_engine.py`): only PR-0C;
  - `public_link_security` (`api/public.py`): no PR here edits it. SEC-12 is contained
    in `knowledge.py`, behind the call.
- **Scope finding:** the guardrail matched `semantic_direct_api` (owner
  `routers/semantic.py`). That is where SEC-09 is fixed (PR-0B3).
- **Test suites named:** `agent_flow_container`, `agent_flow_contract`,
  `agent_flow_credentials`, `agent_flow_evidence`, `agent_flow_replay`, plus the
  semantic and public protected suites.
- Each PR re-runs the guardrail on its own file list.

## PR breakdown

**Legend:**
- **P** = touches a protected path;
- **M** = schema/migration;
- **A** = needs explicit human approval before implementation (medium/large or
  protected).

### Phase 0: foundation, security and contracts

| PR | Scope | Files (expected) | P | M | A | Status |
|---|---|---|---|---|---|---|
| **0A** | Contracts, ADRs, threat model, security ledger (tests only), CI wiring of the ledger | `docs/features/intelligence-foundation/**`, `backend/tests/test_intelligence_phase0_security_repro.py`, `.gitignore`, `.github/workflows/backend-contract-tests.yml` | infra (declared) | – | – | READY FOR REVIEW |
| **0B1** | Agent Flow containment. **SEC-03:** the studio preview keeps `caller`. **SEC-04:** Studio Test declares the binding's capabilities; the default flip is BLOCKED (see the matrix). **SEC-05:** AI-scope lookup fails closed. | `services/agent_flows/dispatch.py`, `tools/registry.py`, `tools/context.py`, `tools/result.py`, `runtime/agent_runtime.py`, `modules/agent_flows/api.py` | – | – | – (small) | READY FOR REVIEW |
| **0B2** | Knowledge authority, first slice. **SEC-07:** Draft KPI not presented as official. **DEF-07b:** citation NameError. **SEC-08:** no auto-promotion of bot findings; existing self-promoted rows stop being injected as validated. | `dashboard_ai_bot/knowledge_context.py`, `dashboard_ai_bot/knowledge.py` | – | – | – (small) | READY FOR REVIEW |
| **0B3** | Data-access gates. **SEC-02:** preview row ceiling. **SEC-09:** `/semantic/query` requires `explore`. | `api/datasources.py`, `routers/semantic.py` | – | – | – (small; security-behaviour change declared) | READY FOR REVIEW |
| **0C** | **SEC-01:** calculated-field AST allow-list (relations and columns of the view only; no subqueries, set ops or DDL/DML; dialect-correct). **SEC-01b:** false positives. **DEF-06:** triage. | `services/semantic_query_engine.py` | **P** | – | **A** | PLANNED: needs plan approval + golden gates |
| **0D** | **SEC-10/ADR-014:** inventory of orphaned Approved knowledge (a service plus an admin-only read endpoint, not an ad-hoc DB script) and an injection-time quarantine flag | `services/governance_ai_service.py`, `dashboard_ai_bot/knowledge_context.py`, new admin route | – | – | **A** (PO default, intent Q2) | BLOCKED on PO decision Q2 |
| **0E** | Sealed eval harness, minimal: YAML case store, deterministic oracle runner on a seeded fixture, leakage check, import-boundary test | `backend/eval/cases/**`, `backend/eval/sealed_harness.py`, test | – | – | – (new, isolated) | PLANNED |

### Phase 1: Governed Query Service and data policy

The whole phase is medium/large: a new service, a schema, and the call sequence into the
protected semantic layer. **It needs plan approval before PR-1A starts.**

| PR | Scope | P | M | A |
|---|---|---|---|---|
| **1A** | `EffectivePrincipal` + `AuthorizationContext` over `core/authz`; one intersection-only formula (I-1), no delegation term (I-3); unit + property tests (PAT ⊆ human; no owner-borrowing; a delegation row never widens; unknown → deny) | – | – | A (phase) |
| **1B** | GQS core (T1): request/result/evidence/refusals per spec §2; calls the existing sequence; `filter_would_drop`; `column_excluded`; `unsupported_expression` for AI calc fields | calls the protected path, does not edit it | – | A |
| **1C** | Bounds and budgets (spec §2.5): server-clamped; per run/user/datasource; BQ dry-run estimate | – | – | A |
| **1D** | Cancellation: Postgres/MySQL/BigQuery cancellers + ledger-driven cross-worker cancel | – | – | A |
| **1E** | `governed_query_executions` ledger: migration (additive, single head) + pre-write/finalize (I-7) | – | **M** | A + migration-checker |
| **1F** | Row/column policy threat model + adversarial tests for app-layer enforcement over a shared credential; per-adapter `policy_unenforceable` | – | – | A (PO, ADR-002) |
| **1G** | First consumer: the existing `/semantic/query` router delegates to GQS (behaviour-preserving except the declared 0B3 gate); semantic golden + `semantic_direct_api` suites unchanged | – | – | A |

**Phase 1 acceptance** is the mandate's list, mapped to intent criteria 3–8.
- Golden and protected suites must stay byte-identical in their assertions.
- **The warehouse half:** BigQuery cancel and bytes are executed when a credentialed
  warehouse is available. Otherwise they are reported `BLOCKED: no warehouse`.

## Tests: decided now, not chosen afterwards

| PR | Must add | Must stay green |
|---|---|---|
| 0B1 | flip SEC-03/04/05 to passing; HTTP-level test of `test-as-chat` scope for a shared editor (allow + deny) | `agent_flow_*` suites named by the guardrail; `test_governance_promises_are_kept.py` |
| 0B2 | flip SEC-07, DEF-07b, SEC-08; an Approved metric is still injected; a human-taught fact is still validated | `test_what_the_ai_sees.py`, `test_govern_*`, `test_ai_bot_*` suites named by the guardrail |
| 0B3 | flip SEC-02, SEC-09; an explore grant is still served; the schema browser's default 5 rows unchanged | `test_semantic_router_object_access.py`, `test_source_security.py`, `semantic_direct_api` |
| 0C | flip SEC-01/01b; BigQuery + Postgres structural assertions for allowed calc fields | all `semantic_layer.required_tests` |
| 1x | per spec invariants I-1…I-9, C-1…C-4 | everything above, plus `verify.py task` |

## Risks

- **0B3 SEC-09 changes who may query.** A user holding only a `view` grant (not the
  ShareDialog's `explore`) loses `/semantic/query`. This is the policy as written (authz
  spec §5). It is declared in the PR. Rollback is a one-line revert.
- **0B1 SEC-05 fail-closed may refuse turns while governance is degraded.** That is the
  intended trade (PO: no fail-open). The refusal message must say why.
- **0B2 changes what the AI says.** A Draft KPI no longer appears as official. Answers
  that relied on it change. The agent-flow replay fixtures are the tripwire.
- **Python 3.12 locally vs 3.11 in CI.** The ledger ran on 3.12 with pinned packages.
  CI is authoritative.

## Rollback

- Every Phase 0 PR is code-only and revertible by `git revert`. The ledger tests turn
  back into `xfail` on revert, which is correct.
- 1E (migration) is additive.
  - **Code rollback and schema rollback are distinct.** Reverting code leaves the audit
    table and its rows.
  - `downgrade()` refuses on a non-empty ledger (spec §2.4).
  - Production rollback is code-only.

## Verification log (append per PR)

- **2026-10-19, 0A:**
  - ledger: 8 passed, 11 xfailed (pinned venv, `run_security_tests.sh` env);
  - `--runxfail`: all 11 fail at their assertion;
  - SEC-06 mutation control fails as intended;
  - `verify.py task`: see the PR evidence.
- **2026-10-19, 0B1:**
  - ledger: 14 passed, 9 xfailed;
  - fail-first: the 8 SEC-03/04/05 tests fail on base and pass with the fix;
  - the first `verify.py task` FAILED (`agent_flow_container`, `agent_flow_surface`, `tier1_oracles`). All three came from flipping the SEC-04 default, which existing tests lock. The flip was reverted and reported, not worked around;
  - the second run PASSED: import smoke, `agent_flow_container` / `contract` / `credentials` / `evidence` / `replay` / `surface`, `tier1_oracles_execute`;
  - note: `check_tier1_oracles.py` crashes on Windows unless `PYTHONUTF8=1` is set (cp1252 decode of subprocess output). This affects local environments only; CI runs on Linux.
- **2026-10-19, 0B2:**
  - ledger: 21 passed, 6 xfailed;
  - fail-first: 6 SEC-07/DEF-07b/SEC-08 tests fail on base and pass with the fix; the allow halves pass on both;
  - `verify.py task` PASSED;
  - `dashboard_ai_bot` has no feature in the guardrail rule base. The guardrail keyword-matched `dashboard_build_render` (frontend), which is noise. Coverage is therefore UNKNOWN, not safe;
  - every backend test importing the changed modules was run by hand: 6 files, 126 passed, 6 xfailed.
- **2026-10-19, 0B3:**
  - ledger: 24 passed, 3 xfailed (SEC-01, SEC-01b, SEC-04);
  - fail-first: SEC-02 and SEC-09 fail on base and pass with the fix;
  - `verify.py task` PASSED: `error_contracts`, `relationship_contract`, `semantic_router_access`;
  - `relationship_contract_pg` was run on a disposable `pgvector:pg16` container (alembic head): 10 passed. 3 tests are NOT VERIFIED locally: they need CI's `bcfix` seed, and `scripts/seed_snowflake_ci_fixture.py` hard-codes `localhost:5432`, so it was not pointed at any non-disposable database. CI runs it.
