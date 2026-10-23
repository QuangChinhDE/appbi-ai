# AppBI Analyst (M2 MVP) — intent

**Status:** in progress (code complete, local verified; not reviewed, not merged, not product-accepted)
**Owner:** Intelligence program
**Date:** 2026-10-21

## Problem

A person who wants to know "how is revenue by product category changing over recent
months?" must find a dataset, build a chart in Explore, choose dimensions, grains and
filters, and read the result. If no chart exists for the question, the AI surfaces either
cannot answer it or answer it outside a governed query path (no durable audit, no bounds,
no cancellation, no per-person data policy).

## Goal

A person asks a new question in plain language. AppBI discovers the semantic assets that
person may use, plans a governed query, runs it through the Governed Query Service (GQS),
verifies the result, and answers with numbers computed from the governed rows, the
evidence behind them, and a chart draft the person can save, reopen and refine.

## Out of scope

- Opening the Analyst to public links, embeds or unauthenticated surfaces.
- Writing SQL from the model, calculated fields or window functions from the model.
- Model-written numbers: every figure in an answer is computed by the server from rows.
- Dashboard drafts (only a single chart draft in this release).
- Changing the protected semantic layer or `/semantic/query` (plan.md named it as 1G's
  first consumer; the Analyst is the first consumer instead — see plan.md).
- A dedicated permission-matrix key for the Analyst (it rides `explore_charts`; open).

## Constraints

- Every read goes through GQS: request-bound principal, explicit scope, server bounds and
  budgets, durable ledger written before the warehouse, cancellation, typed refusals.
- Dataset access is decided per Dataset (and its composition parents) on every turn, so a
  revoked grant is honoured on the next question; GovernAIScope exclusions apply.
- Behind `ANALYST_ENABLED` (backend) and `NEXT_PUBLIC_ANALYST_ENABLED` (frontend), both
  default off.
- SQL generation must be correct on Postgres, MySQL and BigQuery.

## Acceptance criteria

1. With explore on a Dataset, the PO question returns an answer whose rows equal an
   independent oracle; the answer text is derived from those rows.
2. Evidence shows source, measures, filters, limits, ledger query id and fingerprint, and
   the ledger row is `ok` on the `analyst` surface.
3. A person with only `view`, without the module, or whose grant was revoked gets no rows.
4. A plan naming anything outside the person's catalog is refused before any read.
5. A truncated result draws no trend; an empty result under a filter is not an answer.
6. A running question can be cancelled by its owner only, and is recorded `cancelled`.
7. A dropped filter runs only with the person's signed, single-use consent.
8. The chart draft saves through the existing chart API under the person's own rights and
   reopens in Explore.
