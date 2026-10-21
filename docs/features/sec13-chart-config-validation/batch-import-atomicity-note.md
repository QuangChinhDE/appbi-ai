# HTML batch import atomicity — design note (separate, larger change)

**Status:** identified during the SEC-13 A2 work. A partial, in-scope mitigation
landed with A2; full atomicity is a larger change that needs its own review.

## The defect

`build_dashboard_from_import_batch` builds each document through
`build_dashboard_from_import`, which **commits per document** (`db.commit()` at
`dashboard_html_import_service.py` ~5803, plus a second commit for model
generation). After the first document, subsequent documents append pages into the
same dashboard. So if document N fails, documents 1..N-1 are already committed and
the caller gets an error over a dashboard that is half-built. The frontend
(`DashboardHtmlImportModal`) only shows a `buildBatchError` toast on failure — it
does not clean up or reconcile a partial dashboard.

The service docstring says it "preserves the legacy contract and behavior"; it
never promised atomicity. The per-document commit is the accidental source of
partial success, not a documented contract.

## Product contract decision

**All-or-nothing is the correct default when importing several pages into one
dashboard.** A failed import should leave nothing behind. This matches the
single-build path (one transaction, one commit) and the duplicate/snapshot paths.

## What A2 fixed now (in scope)

`_prevalidate_batch_chart_configs` runs the ChartCreate role-config contract over
every chart of every document **before any page is built**. So the failure mode
A2 itself could introduce — an out-of-contract config (e.g. an invalid time
grain) in a later document — now refuses the whole batch with **nothing
committed**. Covered by `test_chart_config_write_validation_http_pg.py`
(`test_batch_with_a_valid_then_invalid_document_builds_nothing`).

This does **not** make the batch atomic against every failure: a mid-build error
that only surfaces during build of document N (a DB error, a source-contract
mismatch found late, an unresolved field in document N when `strict_fields` is on,
model-generation failure) can still partial-persist.

## Full atomicity — the larger change (NOT in A2)

To make the batch truly all-or-nothing, the per-document commits must become one
transaction for the whole batch. That requires, at least:

1. `build_dashboard_from_import` must be callable WITHOUT its own `db.commit()`
   (a `commit: bool = True` parameter, or a private no-commit core the batch
   calls), so the batch controls the transaction boundary.
2. The dataset-creation CRUD used by `upload_excel` source mode
   (`DatasetCRUDService.create_dataset`/`add_table_to_dataset`, which commit
   internally) must also support deferring their commit, or the batch must create
   the dataset once up front (outside the per-document loop) and reuse it — the
   current code already resolves the dataset on document 1 and reuses it for 2..N,
   so the main remaining inner commits are the per-document dashboard/chart writes.
3. Side effects that are not in the DB transaction — model auto-generation
   (`generate_dataset_model`, already wrapped in its own try/commit/rollback) and
   any manual-dataset materialization (DuckDB/storage for `upload_excel`) — need a
   defined behavior on rollback (best-effort cleanup, or accept orphaned
   materialization that a later GC reclaims). `existing_dataset` batches (the
   common wizard path) have no such side effect and can be made fully atomic
   first.
4. Idempotency (`idempotency_key`) and the row-locked publish must keep working
   under the single-transaction shape.

Because this touches the commit structure of a widely used import path and its
Excel-ingestion side effects, it is a separate PR with its own tests
(all-or-nothing against a mid-build DB error, against `strict_fields`, against a
source-contract mismatch in document 2), not folded into the SEC-13 A2 change.

## Recommendation

- Keep A2 (#67) as is: prevalidation closes the config-validation failure mode and
  is fully tested.
- Open a follow-up PR for full batch atomicity, scoped to `existing_dataset` first
  (no external side effects), then `upload_excel` with a defined rollback for
  materialization. Gate it behind the same semantic/golden and authz suites.
