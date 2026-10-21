# AppBI Analyst (M2 MVP) — spec

## Flow

```
question ──► discovery (catalog.discover)      what this person may explore
         ──► plan (planner.plan + validate)     model proposes JSON; server validates
         ──► GQS.execute                        principal, policy, bounds, budgets,
                                                ledger begin/finish, cancel registry
         ──► verify + answer (narrative)         words computed from the rows
         ──► chart draft (narrative.chart_draft) saved by the person via POST /charts
```

## API (`/api/v1/analyst`, mounted only when `ANALYST_ENABLED`)

| Route | Contract kind | Gate | Notes |
|---|---|---|---|
| `GET /catalog` | scope | `explore_charts: view` | sources the caller may ask about |
| `POST /ask` | cross | `explore_charts: view` | `{question, turn_id?, previous_plan?, drop_consent?}` |
| `POST /consents` | identity | `explore_charts: view` | `{query_fingerprint, fields}` → token bound to the caller |
| `POST /turns/{turn_id}/cancel` | resource | `explore_charts: view` | marks the caller's own running queries of that turn |

`ask` returns one of `answered | refused | clarify | unsupported`. `answered` carries
`plan, answer{headline, bullets, facts, checks, note}, columns, rows, truncated,
evidence{query_id, source, measures, filters_applied, filters_dropped, bounds,
duration_ms, freshness, sql_fingerprint, policy_fingerprint, semantic_epoch},
chart_draft | chart_draft_unavailable`. No SQL text is ever returned.

## Discovery

Explores of `reporting` Datasets the caller may `explore` (and every composition parent),
on bounded sources (Postgres, MySQL, BigQuery), fields minus GovernAIScope exclusions.
Fields carry label, type, description, an `identifier` mark for key columns and optional
business `synonyms` from the semantic definition. An optional `ceiling_dataset_ids`
narrows (never widens) the scope through `SurfaceCeiling`.

## Plan validation (server)

- explore must be one listed for this caller;
- each ref must be a field of that explore of the right kind; a wrongly view-qualified
  name resolves only when the field name is unique in the explore;
- grains ∈ {day, week, month, quarter, year} and only on date/time-typed fields (a
  string-typed field is refused with its name);
- filter operators on the Direct Semantic API allow-list;
- no SQL, calculated fields, window functions or consent in the plan's shape.

## Answer rules

- Over time: the window is the last 3 periods present ("recent"), totals and per-group
  movers computed from rows; the note states the window and the data range.
- Ranking: top groups with share.
- Truncated result (row bound hit): no trend/ranking/total, says incomplete.
- Empty result under a filter: `unsupported` naming field and values (model may have
  mapped the question's words onto a field that does not mean them).
- Checks shown: row count, completeness, null measures, null periods.

## Consent to drop a filter (1F)

`filter_would_drop` returns `query_fingerprint`. The person's click calls `/consents`;
the token (HMAC over SECRET_KEY-derived key) binds user, fingerprint of relation+ask,
exact dropped field set, expiry (300 s), nonce. GQS verifies; the ledger stores the nonce
under a partial unique index in the same transaction as `begin` (`consent_replayed`).

## Budgets (server-side, settings)

`ANALYST_MAX_QUERIES_PER_USER_DAY` (200), `ANALYST_MAX_CONCURRENT_PER_DATASOURCE` (4),
`ANALYST_MAX_BQ_BYTES_PER_USER_DAY` (20 GiB, reserved per query at its bound),
`ANALYST_MAX_ROWS` (500). Reserved under sorted advisory locks inside `begin`.

## Frontend

`/analyst` (Intelligence nav group, flag `NEXT_PUBLIC_ANALYST_ENABLED`), route mapped to
`explore_charts`. Steps with Cancel, answer, checks, data table, line/bar chart, evidence,
drop-consent flow, clarification options, follow-ups refining the last plan, Save as chart.
EN/VI catalog `i18n/catalog/analyst.ts`.
