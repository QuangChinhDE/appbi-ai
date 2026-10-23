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
| **0A** (#53) | Contracts, ADRs, threat model, security ledger (tests only), CI wiring of the ledger | `docs/features/intelligence-foundation/**`, `backend/tests/test_intelligence_phase0_security_repro.py`, `.gitignore`, `.github/workflows/backend-contract-tests.yml` | infra (declared) | – | – | CODE COMPLETE · CI VERIFIED |
| **0B1** (#54) | Agent Flow containment. **SEC-03:** the studio preview keeps `caller`. **SEC-04:** an undeclared capability is refused (fail-closed, PO-approved; fixtures updated, the fail-open test replaced and declared). **SEC-05:** AI-scope lookup fails closed. | `services/agent_flows/dispatch.py`, `tools/registry.py`, `tools/context.py`, `tools/result.py`, `runtime/agent_runtime.py`, `modules/agent_flows/api.py` | – | – | – (small) | CODE COMPLETE · CI VERIFIED |
| **0B2** (#55) | Knowledge authority, first slice. **SEC-07:** Draft KPI not presented as official. **DEF-07b:** citation NameError. **SEC-08:** no auto-promotion of bot findings; existing self-promoted rows stop being injected as validated. | `dashboard_ai_bot/knowledge_context.py`, `dashboard_ai_bot/knowledge.py` | – | – | – (small) | CODE COMPLETE · CI VERIFIED |
| **0B3** (#56) | Data-access gates. **SEC-02:** preview rows need `use_secret` on the source, capped at 100 (containment, see Backlog B-1). **SEC-09:** `/semantic/query` requires `explore`. | `api/datasources.py`, `routers/semantic.py` | – | – | – (small; security-behaviour change declared) | CODE COMPLETE · CI VERIFIED |
| **0E** (#57) | Sealed eval harness, minimal: JSON case store, deterministic DuckDB oracle on a seeded fixture, leakage check, import-boundary test | `backend/eval/sealed/**`, test | – | – | – (new, isolated) | CODE COMPLETE · CI VERIFIED |
| **0C** (#58) | **SEC-01:** calculated-field AST allow-list (`calculated_field_policy.py`; refs of the query only; no subqueries, set ops, DDL/DML, catalog casts or lexer hazards; 4 dialects). **SEC-01b:** false positives. | `services/calculated_field_policy.py`, `services/semantic_query_engine.py` | **P** | – | **A** (approved) | CODE COMPLETE · CI VERIFIED |
| **0D** (#59) | **SEC-10/ADR-014:** QUARANTINE of orphaned Approved rules/playbooks/Q&A/instructions at injection; Govern-admin inventory route; nothing deleted; GovernAIScope still enforced | `services/governance_ai_service.py`, `modules/metadata_catalog/api.py`, `route_contract.json` | – | – | **A** (approved) | CODE COMPLETE · CI VERIFIED |
| **0F** (#60) | Guardrail coverage for AI modules that read as UNKNOWN (`ai_knowledge_authority`, `datasource_table_preview`, Agent Flow required tests) | `scripts/guardrail/guardrail_rules.yaml` | infra (declared) | – | – | CODE COMPLETE · CI VERIFIED |
| **0G** | Three committed suites that no workflow ran (`test_knowledge_hit_contract`, `test_govern_doc_answerability`, `test_semantic_level0`): allow-listed, wired into CI, registered as `ai_evidence_contract`; their modules join `ai_knowledge_authority` | `.gitignore`, `.github/workflows/backend-contract-tests.yml`, `guardrail_rules.yaml` | infra (declared) | – | – | CODE COMPLETE |

**Status vocabulary (PO, 2026-10-20).** CODE COMPLETE → CI VERIFIED → REVIEW
APPROVED → MERGED TO DEMO → PRODUCT ACCEPTED, each stated separately; none implies the
next. No Phase 0 PR is REVIEW APPROVED or MERGED TO DEMO yet: `demo` requires the four
named checks and a normal PR merge by an actor GitHub allows, after human review.

### Phase 1: Governed Query Service and data policy

The whole phase is medium/large: a new service, a schema, and the call sequence into the
protected semantic layer. **It needs plan approval before PR-1A starts.**

| PR | Scope | P | M | A |
|---|---|---|---|---|
| **1A** | `EffectivePrincipal` + `AuthorizationContext` over `core/authz`; one intersection-only formula (I-1), no delegation term (I-3); unit + property tests (PAT ⊆ human; no owner-borrowing; a delegation row never widens; unknown → deny). #61: CODE COMPLETE; CI re-running on the static-rule fix | – | – | A (phase) |
| **1B** | GQS core (T1): request/result/evidence/refusals per spec §2 (as built: §2.5a); calls the existing sequence; `filter_would_drop` + `accept_dropped_filters`; `column_excluded`; `unsupported_expression` for every principal; AI BigQuery bytes per query as its own limit; NOT LIVE. CODE COMPLETE | calls the protected path, does not edit it | – | A |
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

## Backlog and caveats carried forward (PO review, 2026-10-20)

These are not closed by Phase 0. Each names where it is decided.

- **B-1 (SEC-02): `use_secret` is containment, not the permission model for raw rows.**
  Today a source's raw rows (schema-browser preview) need `use_secret`, the editor
  level that also unlocks the stored-credential test. That is the closest existing
  action, chosen so a viewer reads zero rows now. The permanent model is a separate
  capability for datasource data access (preview, profile, ad-hoc query), decided with
  the Source Catalog (PR-2A/2B), so that reading sample rows and using a credential stop
  being the same right. Until then, the code behaviour is exactly: metadata for
  `data_sources: view`, rows only with `use_secret`, at most 100.
- **B-2 (SEC-01): structural is not exploit-proof.** The calculated-field allow-list is
  verified by a dialect policy matrix (sqlglot parse on default, postgres, bigquery,
  mysql) and by the 17 `semantic_layer` gates on Postgres. The payloads were not
  executed on BigQuery or MySQL. Runtime verification on a credentialed BigQuery and a
  MySQL source is a **release-gate item** for any release that exposes calculated
  fields to a new surface; until it runs, BigQuery/MySQL resistance is NOT VERIFIED.
- **B-3 (SEC-10): quarantine changes legacy bot answers.** Answers that leaned on an
  orphaned rule/playbook/Q&A/instruction change, by design. The inventory
  (`GET /catalog/govern/knowledge-quarantine`) is the input to re-certification in the
  Business Context Studio: an owner re-approves an item into a governed kind, or it
  stays quarantined. Nothing is deleted. Security exclusions (GovernAIScope) are not
  part of the quarantine and stay enforced. A deployment's real inventory count is NOT
  VERIFIED (no production access).
- **B-4 (evaluation): committed suites that ran nowhere.** `scripts/ci/audit_test_reachability.py`
  lists committed tests no workflow runs. The three that guard AI evidence and metric
  meaning became a required gate in 0G (`ai_evidence_contract`). The remaining
  never-referenced suites are not claimed as coverage. They are triaged per area, not
  bulk-wired, because a suite that has never run may encode stale behaviour.

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
- **2026-10-19, 0E:**
  - sealed harness `backend/eval/sealed/` (JSON cases, because PyYAML is not a backend dependency; a JSON fixture, because `*.csv` is gitignored); 5 dev and 2 holdout cases on `retail_vn`;
  - `test_intelligence_eval_harness.py`: 27 passed;
  - every case's DuckDB oracle equals its hand-computed value;
  - the fan-out trap (80 vs 50) is graded wrong;
  - leakage is excluded;
  - isolation preconditions are enforced;
  - mutation control: a runtime module importing the harness makes the boundary test fail;
  - `verify.py task` PASSED.
- **2026-10-20, 0C:** policy matrix on 4 dialects; two independent semantic-guard
  reviews (a comment-nesting bypass, unit-word columns, hand-typed placeholders, catalog
  casts, a unit-slot gap: all closed); 17 `semantic_layer` gates PASS on Postgres.
  Warehouse execution: NOT VERIFIED (B-2).
- **2026-10-20, 0D:** quarantine unit suite + HTTP/Postgres inventory suite PASS; the
  removed routes stay 404 for an admin; control: with the quarantine off all four kinds
  were injected.
- **2026-10-20, 0F:** `guardrail_check.py --health`: 65 runnable, 0 gaps.
- **2026-10-20, 1A:** remote Product gate FAILED on `test_authz_static_rules`: a
  docstring in `governed_query/principal.py` named the raw permission row. No
  executable code reads it (every decision is `authz.can`). Only the wording changed;
  the static rule and its allow-list are untouched. Locally: the CI `authz-core` step
  (92 passed, CI job env) and the GQS suite PASS.
- **2026-10-20, 0G:** the three suites PASS locally (34 + 20 + 15); `--health`: 66
  runnable, 0 gaps; `knowledge_hit.py` / `govern_doc_answerability.py` now resolve to
  `ai_knowledge_authority` (was UNKNOWN).
- **2026-10-20, 1B (GQS core, not live):**
  - `test_intelligence_gqs_execution_pg.py`: 24 passed on a disposable `pgvector:pg16`
    (alembic head; real metadata, a real Postgres source and the real engine). The
    oracle is hand-computed (Bắc 150, Nam 30, Trung 20).
  - `test_intelligence_gqs_core.py`, `test_intelligence_effective_principal.py` and
    `test_authz_static_rules.py`: 30 passed.
  - Mutation controls, 6 of 7 killed:
    - M1: authorization removed;
    - M2: a drop answered;
    - M3b: no ledger AND the begin failure ignored;
    - M4: AI scope on refs skipped;
    - M5: a request raises a bound;
    - M6: escape hatch accepted.
  - M3 (only the `audit is None` guard removed) survives, because the begin-failure
    path independently refuses `audit_unavailable`. It is an equivalent mutant, and
    M3b shows the property is locked.
  - The I-6 test adds one drop record to the REAL engine's output in the engine's own
    shape. A real-engine `unreachable_view` drop over a multi-fact model is not
    exercised here: NOT VERIFIED.
  - BigQuery execution of the bytes limit: NOT VERIFIED (no warehouse). The unit test
    proves the job argument only.
- **2026-10-20, 1B independent review (semantic-guard, on 96472cd6):**
  - Confirmed by reading the code, and each item now has a fail-first regression test
    (22 tests fail on the draft and pass after the fix):
    - a grain was interpolated into `DATE_TRUNC` (SQL injection on Postgres/DuckDB);
    - composed parents were not authorized;
    - AI-scope bypasses through `expression`, formulas, measure filters, bare
      `${col}`, aliases, unqualified refs and labels;
    - filters were silently skipped, through `top_n` and empty values;
    - internal filter keys were forwarded;
    - existence was disclosed before authorization;
    - Sheets/Manual sources had no timeout.
  - The output gate that could never fire was replaced by an identity gate.
  - Mutation controls on the hardened core: 11/12 killed. M11 (`depends_on` not
    followed) is an equivalent mutant: a formula names its dependencies in
    `expression`, and the placeholder walk follows them.
  - Open, because it needs a protected change: relationship key probes are not
    bounded by GQS. BigQuery is refused until PR-1C; Postgres/MySQL keep the guard's
    30-second timeout.
  - The review's trace of EXISTING paths found the same grain injection outside GQS
    (SEC-13, security-matrix.md). It is not fixed here: it is a protected
    semantic-engine change that needs approval.
