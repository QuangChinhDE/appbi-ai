# Internal AI Preview: reviewer, merger and operator handoff

Who this is for: the GitHub reviewers and merger of PR #71, and the authorized operator of a
non-production preview environment. It turns the PO's Internal Team Preview directive into the
steps only those people can take. Steps that need nobody's permission are already done; the
evidence is linked from the PR.

This is an **Internal AI Preview** (named testers, verify every number). It is not a certified
Business Pilot. The independent accuracy gate (>=95% on a new sealed holdout) has not been met.

## 1. What is waiting on whom

| Step | Owner | State |
| --- | --- | --- |
| Review #71 (see section 2) | security, semantic, GQS/authz, BI compatibility, migrations reviewers | **waiting** (0 approvals) |
| Review the protected date-grain PR (section 2.3) | semantic reviewer | **waiting** |
| Merge #71 into `demo` with a merge commit | authorized merger | **waiting**: no self-approval, no bypass |
| Close or retarget #53-#70 that #71 supersedes | PR authors / merger | after the merge, check each PR's real state on GitHub |
| Provide a non-production preview host, DNS + HTTPS, access restriction | operator | **not started**: no such environment exists yet |
| Secrets in the environment's secret store | operator | **not started** |
| Create 3-5 tester accounts and grants | operator | **not started** |
| Provider-side spending cap on the model key | account owner | **not confirmed** |

## 2. Reviewer handoff

### 2.1 What #71 contains

#71 (`integration/analyst-demo-candidate`) is merge commits only. It contains, unchanged:
#65 + #67 (SEC-13 hotfix and chart-config validation), #69 (semantic sync keeps edited
dimensions), #53-#64 (Intelligence foundation, GQS core), #68 (GQS 1C-1G + Analyst MVP,
behind `ANALYST_ENABLED`, default off) and #70 (SEC-13 ledger reconciled with the #65 fix;
red on its own base, green inside #71). Verify with
`git log --first-parent origin/integration/analyst-demo-candidate`.

### 2.2 Per area

| Area | Look at | Gate that locks it |
| --- | --- | --- |
| Security / SEC-13 | `semantic_query_engine` grain whitelist, `chart_config_validation` | `test_intelligence_sec13_*`, authz-security job |
| Protected semantic | #69 `dataset_model_service` sync, the date-grain PR | integration-golden job, `test_dialect_structural.py` |
| GQS / authorization | `services/governed_query/**`, `api/analyst.py` router gate | `test_intelligence_gqs_*_pg.py`, `test_analyst_http_pg.py` |
| Dataset/Chart/Dashboard compatibility | Analyst OFF leaves BI untouched; saved charts use the normal chart API | e2e job, `analyst-off-acceptance.spec.ts` |
| Migrations | `20261022_0001`, `20261023_0001`, `20261024_0001` (all additive; downgrade of the last refuses while preview reasons are in use) | `scripts/ci/alembic_chain.py`, migration-checker: SAFE |

### 2.3 The protected date-grain fix

A separate PR, because it changes the protected semantic layer. On Postgres, `DATE_TRUNC`
over a DATE returns `timestamp with time zone`, so a month bucket of a DATE field reached the
browser as midnight UTC and was shown as `01/01/2025 07:00:00` (and as the previous day west
of UTC). The fix casts a DATE bucket back to DATE on Postgres only; TIMESTAMP columns keep
their instant semantics; BigQuery and MySQL are unchanged. Fail-first test in
`test_dialect_structural.py`.

## 3. Operator: the preview environment

### 3.1 Package

| Item | Value |
| --- | --- |
| Code | the resulting `demo` SHA after the merge, or, if the PO approves an isolated candidate, the exact #71 SHA. Never a local build of an unpushed tree |
| Build | `docker compose -p appbi-preview build` with `APPBI_BUILD_SHA=<sha>`, frontend build arg `NEXT_PUBLIC_ANALYST_ENABLED=true` (preview only) |
| Record | the image digests (`docker image inspect --format '{{.Id}}'`) next to the SHA |
| Migrations | `alembic upgrade head`; expect the single head `20261024_0001` |
| Database | its own metadata PostgreSQL; never production; `pg_dump -Fc` from a separate client container before migrating |
| Exposure | HTTPS only, authenticated, reachable only from the company network or VPN (firewall allowlist). Not public |

### 3.2 Flags (preview only)

| Flag | Value |
| --- | --- |
| `ENVIRONMENT` | `staging` (the test budget controller refuses to run as `production`) |
| `ANALYST_ENABLED` | `true` only after the smoke in 3.6 passes |
| `ANALYST_PILOT_ALLOWLIST` | the named cohort's e-mails, nobody else |
| `ANALYST_DROP_CONSENT_ENABLED` | `false` |
| `ANALYST_MAX_QUERIES_PER_USER_DAY` | `40` |
| `ANALYST_MAX_ROWS` | `500` |
| `ANALYST_PLANNER_MODEL` | `default` (gpt-4o-mini) |
| `ANALYST_PLANNER_REPLAY_PATH` | **unset** (the preview must use the real model) |
| `LLM_TEST_BUDGET_USD` | the PO-approved preview allowance; without a separate approval it must be at most what remains of the cumulative $5.00 test cap after the last recorded spend ($1.0503 at the time of writing, so at most $3.94) |
| `LLM_TEST_LEDGER_PATH` | a persistent volume path on the preview host |
| `LLM_TEST_PRICES_JSON` | the provider's current gpt-4o-mini prices |
| `METADATA_CATALOG_ENABLED` | `true` |

The ledger is a guard inside this app only. The account owner must also set a spending limit
on the provider key, and the key must be used by nothing else. If either cannot be done, keep
`ANALYST_ENABLED=false`: open-ended paid requests are not allowed.

Cost reference: one planner call per question, about $0.0003-0.0016. 40 questions per user
per day across 5 users is at most about $0.32 per day at the worst case.

### 3.3 Data

Two or three Semantic Datasets on read-only PostgreSQL/MySQL QA sources, each with approved
business metrics, clear dimension labels, Approved glossary terms in Govern, a supported DATE
field, and 5-10 reference questions whose answers were computed by hand in SQL before the
preview opens. No production data without a separate approval. BigQuery datasource 52 stays
disabled until `bigquery-qa-handoff.md` is completed.

### 3.4 Cohort (3-5 people, chosen by the PO)

1. Create the accounts (no shared passwords; each person sets their own).
2. Grant `analyst: view` and `explore_charts: view` to the cohort only.
3. Grant **explore** on the preview Datasets; grant **build** plus `explore_charts: edit` only
   to those who should save charts.
4. Put exactly those e-mails in `ANALYST_PILOT_ALLOWLIST`.
5. Check a non-member: no Analyst entry in the sidebar, `/api/v1/analyst/catalog` refused.

### 3.5 Monitoring, audit, feedback

- Every question is a row in `governed_query_executions` (status, rows, duration, cancel).
- Feedback is in `analyst_feedback`: turn ID, build SHA (`rc_sha`), verdict, reason, comment.
- Weekly triage query (read-only):

```sql
SELECT f.created_at, u.email, f.rc_sha, f.turn_id, f.verdict, f.reason, f.comment
FROM analyst_feedback f JOIN users u ON u.id = f.user_id
WHERE f.created_at > now() - interval '7 days'
ORDER BY (f.verdict = 'down') DESC, f.created_at DESC;
```

Reason classes: `correct`, `wrong_metric`, `wrong_dataset`, `wrong_filter`,
`incorrect_number`, `wrong_interpretation`, `unsupported_but_answerable`, `ux_issue`.
Every `incorrect_number` or `wrong_filter` gets a root cause and a regression test before it
is called fixed.

### 3.6 Acceptance on the target (exact deployed SHA)

```bash
cd e2e
E2E_BASE_URL=https://<preview-host> npx playwright test -c analyst-browser.config.ts   # replay gate
E2E_BASE_URL=https://<preview-host> npx playwright test -c analyst-off.config.ts       # with ANALYST_ENABLED=false
E2E_BASE_URL=https://<preview-host> npx playwright test -c analyst-live.config.ts      # real model, metered
```

The replay gate needs the QA seed and fixtures (`ANALYST_PLANNER_REPLAY_PATH` set) and is
meant for a QA copy of the stack; on the preview itself run the live smoke with the preview's
own reference questions and compare every number with SQL. A login and a new question by a
cohort member on the deployed URL is the minimum before anyone calls the preview ACTIVE.

### 3.7 Emergency OFF

Set `ANALYST_ENABLED=false` and recreate the backend container. The Analyst API returns 404
and the page says the feature is not enabled; BI modules and data are unaffected. Do it at
once on any security or material wrong-number report, then investigate.

### 3.8 Rollback

Redeploy the previous image SHA. The Analyst migrations are additive and the old code runs
with them; do not downgrade the database while preview feedback rows exist.
