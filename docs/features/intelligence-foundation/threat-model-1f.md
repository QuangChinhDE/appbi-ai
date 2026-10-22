# 1F — data policy over a shared warehouse credential: threat model

**Scope:** reads made by the Governed Query Service (GQS) for AI surfaces (Analyst first).
**Date:** 2026-10-21. Status: code complete + local verified; not reviewed.

## The core risk

A datasource holds ONE credential (a service account, an OAuth token, a DB user). The
warehouse grants that credential everything it can read. AppBI must therefore enforce,
in the application, what each *person* may read through it. A datasource credential is
never "the asker's right to read".

## Assets and actors

Assets: rows and aggregates of governed Datasets; the existence of Datasets/relations;
the audit ledger; warehouse cost. Actors: an authenticated person (human or PAT), the
model (untrusted planner), a second worker process, a person with lesser grants.

## Threats → controls → evidence

| # | Threat | Control | Evidence (test) |
|---|---|---|---|
| T1 | Person reads a Dataset they may only `view`, or may not see at all | `AuthorizationContext.decide(EXPLORE)` per Dataset AND per composition parent, every turn; same refusal for missing / not-yours | `test_intelligence_gqs_execution_pg`, `test_analyst_http_pg` (view-only, no module 403, revoked next turn) |
| T2 | Model names a field/relation outside the person's scope | Catalog built from the person's rights; server validation of every ref; GQS re-checks at execution | `test_analyst_planner`, `test_analyst_http_pg` (foreign explore/field/grain/operator → nothing in ledger) |
| T3 | Model injects SQL (calc fields, windows, grains, operators) | Plan shape has no SQL slot; GQS refuses escape hatches; grain ∈ 5 words; operator allow-list | `test_intelligence_gqs_execution_pg` (escape hatches, grain words), planner tests |
| T4 | AI-hidden columns reached through expressions/formulas | GovernAIScope walk over expression, formulas, measure filters, bare refs; result boundary by identity | `test_intelligence_gqs_execution_pg` (review 3a–3d) |
| T5 | A filter silently dropped widens the answer | `filter_would_drop` refusal; only a server-signed consent bound to user+exact query+exact filters+expiry, single use via ledger unique nonce | `test_intelligence_gqs_execution_pg` (forged/other user/other query/expired/other filters), `test_intelligence_gqs_ledger_pg::test_a_consent_runs_once` |
| T6 | Unbounded cost / runaway query | Server bounds (rows, timeout, BigQuery bytes), dry-run, `maximum_bytes_billed`, atomic budgets per run/user-day/datasource, BigQuery bytes per user-day | ledger budget tests (12 concurrent begins admit exactly the budget; mutation without the lock fails), BigQuery runtime (billing cap refusal) |
| T7 | No audit trail, or a trail that can be rewritten | Ledger row committed before the warehouse; insert-only begin; first terminal status wins; app role has no DELETE/TRUNCATE; downgrade refuses with rows | `test_intelligence_gqs_ledger_schema_pg`, `test_intelligence_gqs_ledger_pg`, entrypoint container boot (privileges after 2 boots) |
| T8 | Cancel a query that is not yours / a reused pid / another tenant's job | Cancel requests only by the owner (ledger, user-scoped); the owning worker cancels on its own credential; Postgres by (pid, backend_start); MySQL user-scoped KILL; BigQuery by job id | cancel suites (reused pid never cancelled; another MySQL user cannot kill; owner-only HTTP cancel), BigQuery job cancel |
| T9 | Cancel silently fails, statement keeps running | Cancellers decrypt the stored config (was a defect); cancel outcome verified at the warehouse | `test_..._cancel_pg::test_a_cancel_works_when_the_source_config_is_encrypted_at_rest`, MySQL full path `[encrypted]` |
| T10 | Answer states numbers the rows do not support | Narrative computed from rows; truncated → no trend; empty under filter → no answer | `test_analyst_narrative`, `test_analyst_planner`, oracle comparisons (rig 96/96, BigQuery 27/27 and 26/26) |
| T11 | Row-level policy (operational/Workboard data) bypassed | Refused: `policy_unenforceable` (rls_service is not applied on this path) | `test_intelligence_gqs_execution_pg` (operational refused) |
| T12 | Sources whose executor cannot be bounded (Sheets, manual) | Refused: `policy_unenforceable` | execution suite (unbounded sources refused) |

## Residual risks (not closed)

- **Shared credential breadth.** Enforcement is app-layer; a bug in GQS policy is a data
  exposure. Mitigated by refusal-by-default and the suites above, not eliminated.
  Per-person warehouse identities (OAuth pass-through) are out of scope.
- **OAuth datasource owner.** BigQuery datasource 52 uses the connecting person's OAuth
  token; every reader's governed query runs as that person at the warehouse. The QA run
  used it by PO authorisation; production use needs an explicit decision.
- **Model semantics.** The model can still map words onto the wrong (but permitted)
  field. Controls make that visible (interpretation, evidence filters, no-match), not
  impossible.
- **Semantic model sync** replaces authored dimensions (labels, types, synonyms) with
  generated ones; authored meaning the Analyst relies on can be lost (protected layer,
  reported, not changed here).
- Row/column policies beyond GovernAIScope column exclusions are not implemented.
