# Staging / demo runbook: AppBI Analyst (Engineering Preview → Controlled Business Pilot)

For the **authorized operator**. This runbook does not authorize production. Follow it on a
target environment you have been authorized to change.

## 1. Infrastructure

| Item | Requirement |
| --- | --- |
| Hosts | one Docker host (the base `docker-compose.yml` stack: db/pgvector pg16, backend, frontend, edge), separate from production |
| Database | its own PostgreSQL volume; the application role `appbi_app` is use-only; pgvector installed by a superuser once |
| Sources | PostgreSQL / MySQL QA sources with read-only roles. **BigQuery 52 stays disabled** until `bigquery-qa-handoff.md` is run and verified on the exact SHA |
| Secrets | `SECRET_KEY`, `DATASOURCE_ENCRYPTION_KEY` (Fernet), DB passwords, the model provider key, all from the environment's own secret store; never in git |

## 2. Code

The **resulting `demo` SHA** after the integration handoff (`integration-handoff.md`), with
its CI fully green on that exact SHA. Never use a rehearsal branch.

## 3. Images

`docker compose -p <project> build` with `APPBI_BUILD_SHA=<sha>` (shown in the feedback rows).
The frontend build arg `NEXT_PUBLIC_ANALYST_ENABLED` starts at `false`.

## 4. Backup and restore

- **Before migrating:** take a `pg_dump -Fc` of the target metadata DB from a **separate client
  container**. Never run dump or restore inside a shared database container.
- **Test the restore** into a scratch database before going further.

## 5. Migrations

1. `alembic upgrade head` (or the image entrypoint).
2. Expect a single head. The migrations are additive and were found SAFE by the migration checker.
3. Rehearse on a restored copy first, and compare row counts of the key tables before and after.

## 6. Environment flags

| Flag | Engineering Preview | Controlled Business Pilot |
| --- | --- | --- |
| `ANALYST_ENABLED` | `true` (only after smoke) | `true` |
| `NEXT_PUBLIC_ANALYST_ENABLED` (build arg) | `true` | `true` |
| `ANALYST_PILOT_ALLOWLIST` | named engineers only | named pilot cohort only |
| `ANALYST_DROP_CONSENT_ENABLED` | `false` | `false` |
| `ANALYST_MAX_QUERIES_PER_USER_DAY` | 200 | agreed per user |
| `ANALYST_MAX_ROWS` | 500 | 500 |
| `AI_BQ_MAX_BYTES_PER_QUERY` | 1 GiB (BigQuery disabled anyway) | per the BigQuery handoff |
| `METADATA_CATALOG_ENABLED` | `true` (governed vocabulary) | `true` |
| `ANALYST_PLANNER_MODEL` | `default` (gpt-4o-mini) | `default` |
| `LLM_TEST_BUDGET_USD` / `ANALYST_PLANNER_REPLAY_PATH` | **unset** (test-only, and refused in production) | unset |

## 7–8. Users and dataset permissions

1. Create the users.
2. Give each one the `analyst: view` module permission, plus `explore_charts: edit`
   and `datasets: edit` where they must save charts.
3. Grant **explore** (read) or **build** (save charts) on exactly the pilot Datasets.
4. Link the dimensions and measures to Approved glossary terms in Govern, which supplies
   the business words.

## 9. Cost limits

- **Per-user daily query budget:** `ANALYST_MAX_QUERIES_PER_USER_DAY`.
- **Spending cap on the provider account:** set in the provider console by the account owner.
- **Planner:** one call per question (about $0.0016 worst case at gpt-4o-mini prices,
  with a prompt of about 7k characters).

## 10. Health checks

- `GET /health` returns 200.
- `GET /api/v1/analyst/catalog` returns 404 while OFF, and 200 for an allowlisted user while ON.
- Alembic is at head.

## 11. E2E smoke (on the target, with a real pilot account)

1. Log in and open `/analyst`; the preview label is shown.
2. Ask a question in scope; check the answer, its evidence and its numbers against SQL.
3. Ask a follow-up.
4. Save the chart, then reopen and edit it.
5. Ask an out-of-scope question; it must be refused.
6. Cancel a running turn.
7. Give feedback.
8. Check that a user without the module is blocked.

The deterministic version is `e2e/acceptance/analyst-dogfood.spec.ts`; adapt the base URL
and the accounts.

## 12. Monitoring and feedback

- **Ledger:** `governed_query_executions` (one row per Analyst query: status, rows, bytes,
  cancel), retained per policy.
- **Feedback:** `analyst_feedback` (verdict, reason category, comment, release SHA). Review
  it weekly. Each wrong-answer report needs a root cause and a regression test.

## 13. Emergency OFF

1. Set `ANALYST_ENABLED=false`.
2. Recreate only the backend container.
3. The Analyst API returns 404 within one restart. No data changes and the BI modules are unaffected.

## 14. Rollback and forward-fix

- **Code:** redeploy the previous image SHA. The Analyst migrations are additive, so the old
  code runs with the new columns; no downgrade is needed.
- **Data:** restore the step-4 backup only for corruption, never as a routine rollback.
- **Forward-fix:** a PR with a fail-first regression test, full CI, then redeploy.
