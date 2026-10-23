# BigQuery QA handoff: datasource 52 (`base-testlab-01`)

**Status: NOT VERIFIED on the current RC.** The engineering session could not reach
datasource 52's runtime credentials without reading process secrets, which the
safety classifier refused. That refusal was not retried or worked around. An
authorized operator runs the steps below. This handoff does not certify BigQuery.

## Scope

| | |
|---|---|
| Project | `base-testlab-01` only |
| Datasets | the verified QA tables already bound to datasource 52, nothing else |
| Operations | read-only `SELECT` through AppBI; no CREATE / UPDATE / DELETE / DROP / load / materialization |
| IAM, billing limits | unchanged |
| Code | the exact RC SHA under test (`rc/pilot-3` head named in the readiness report) |

## Entry point

Use the product path. Do not use a script that opens its own BigQuery client.

1. Log in to the RC stack as a QA user who holds `analyst: view` and an EXPLORE grant on the
   Dataset built on datasource 52.
2. Open `/analyst`. Ask the questions below.

The Analyst runs every read through the Governed Query Service (GQS): the person's own
rights, the per-query bounds, and the audit ledger.

## Bounds that apply

These are enforced by GQS on every job:

| Bound | Value (default) | Where |
|---|---|---|
| Bytes billed per AI query | `min(AI_BQ_MAX_BYTES_PER_QUERY, BQ_MAX_BYTES_BILLED)` = 1 GiB | `governed_query/bounds.py` → `maximum_bytes_billed` on the job |
| Dry-run guard | `BQ_MAX_BYTES_SCANNED` (60 GiB ceiling; the 1 GiB AI bound is lower) | warehouse layer |
| Rows | `ANALYST_MAX_ROWS` (dogfood 500) | GQS |
| Timeout | 60 s per query | Analyst → GQS |
| Job labels | `appbi_surface=gqs`, `appbi_query=<query id>` | every job |

For the QA run, set `AI_BQ_MAX_BYTES_PER_QUERY` lower (for example 200 MiB). A request
can only lower a bound, never raise it.

## Query classes to run

Run one question per class, on QA tables only:

1. Total of one metric.
2. Metric by one category.
3. Metric by month for one explicit year (`date_range`, a DATE field).
4. A filter on a real value, then the same value misspelled. Expected: a clarification
   offering the real values.
5. An exclusion ("không tính …"). Expected: a `ne` filter, and a total lower than (1).
6. A Top-N ("Top 3 …"). Expected: 3 groups in order.
7. A metric the model does not have. Expected: a refusal with no number.
8. A slow or large question. Expected: refused by the byte bound or the timeout, never a
   partial answer.

## Expected outputs and evidence

Collect the evidence in sanitized form:

- **Answer text and evidence panel:** query id, source, filters described, bounds.
- **Ledger rows:**
  `SELECT query_id, status, rows_returned, bytes_billed, run_id FROM governed_query_executions WHERE surface='analyst' ORDER BY started_at DESC LIMIT 20`.
- **BigQuery job metadata:** read only for jobs labelled `appbi_surface=gqs`. Collect `total_bytes_billed`, `state` and labels; no query text containing values, and no credentials.
- **Independent oracle:** every number is compared with a SQL oracle the operator runs in the BigQuery console on the same tables, with a dry-run first and a byte cap.

## Cancellation

The person cancels a running turn with **Cancel** in the UI (`POST /analyst/turns/{id}/cancel`).
GQS cancels the QA-owned job it started and marks the ledger row `cancelled`.

An operator may cancel only jobs labelled `appbi_surface=gqs` that were started by the QA
user's run. No other jobs.

## Never

- Print or export OAuth or refresh tokens, service-account JSON, private keys or `.env` values.
- Read a process environment to obtain them.
- Raise a bytes bound, change IAM, or disable billing limits.
- Treat this checklist as BigQuery certification without the runtime evidence above, on the exact RC SHA.
