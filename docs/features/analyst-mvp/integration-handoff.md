# Integration handoff: PR stack → `demo`

For the **authorized human merger**. The engineering session did not merge, approve or
push any protected branch. All merges go through the normal GitHub PR flow, with
the required reviews.

## Integration candidate: PR #71 (consolidated, Analyst OFF)

The stack is integrated in ONE branch, `integration/analyst-demo-candidate`, PR #71 into
`demo`, so required CI runs on the **exact integrated tree**. Merge commits only: each
original PR keeps its commits and shows as merged when #71 lands.

Why one PR: #70, CI'd alone on its stacked base (#64, which lacks #65's fix), correctly
FAILS - the SEC-13 attack still works there. Reproduced locally:
`test_a_grain_is_never_sql` fails on `9c571b5b`, and the suite passes 3/3 on the integrated
tree. The failure belongs to #70's base, not to the integration.

Merged in this order onto `origin/demo @ 1bac25e8`:

| Step | PR | Head | Merge |
| --- | --- | --- | --- |
| 1 | #65 SEC-13 grain whitelist (security hotfix) | `ddcbb693` | clean |
| 2 | #67 chart-config write validation | `b8454c7b` | clean |
| 3 | #69 semantic sync keeps owner-edited dimensions + glossary link | `d04803ff` | clean |
| 4 | #53 PR-0A security ledger + foundation | `7b69fcf6` | clean |
| 5 | #54 PR-0B1 | `f7ec8914` | **conflict:** `.github/workflows/backend-contract-tests.yml`, resolved by **union** of the test lists (YAML valid; no list entry from any side missing) |
| 6–14 | #55 … #63 | stack heads | clean |
| 15 | #64 SEC-13 ledger regression (strict xfail) | `2062bb9c` | clean |
| 16 | #70 SEC-13 test reconcile (xfail → plain regression) | `9c571b5b` | clean |
| 17 | #68 GQS 1C–1G + Analyst | `c9d5b279` | **conflict:** `.gitignore`, resolved by **union** of the `!backend/tests/...` lines |

**Tree equivalence** (corrected): the tree after the **last** step (#68) - not after #70 - is
identical to the tested release-candidate tree `rc/pilot-3 @ da779c5e` for backend,
frontend, `.github`, scripts, e2e and docs. The tree after #70 still lacks the Analyst code
(#68).

**Dependencies that must hold:**

- **#68 and #69 ship in the same release.** #69 makes a dimension's glossary link survive
  Generate/Sync. #68 adds the field and reads it. Either one alone silently loses the link.
- **#65 first** (security). Then #70 must follow #64 (see step 16).
- **Migrations are additive:** `20261022_0001` (`analyst_feedback`) and `20261023_0001`
  (`analyst_feedback.reason`). The migration checker found them SAFE for a database that
  already holds production data.

## After every merge

Record the resulting `demo` SHA and its CI run, then verify:

- **Alembic:** `python scripts/ci/alembic_chain.py` reports a single head.
- **SEC-13 regression:**
  `backend/tests/test_intelligence_sec13_grain_injection_http_pg.py` passes as a plain test, not xfail.
- **Semantic P1 preservation:** `test_semantic_sync_preserves_dimensions.py`,
  `test_semantic_sync_authored_dims_pg.py`, the Pair 1–5 suites, `filter_matrix`, and the golden SQL tests.
- **GQS security:** the `authz-security` job, plus `test_intelligence_gqs_*`.
- **Analyst:** the Analyst suites in the `backend-contract-tests` workflow.
- **Charts, dashboards and public surface:** the product gate e2e and the full-stack E2E (Playwright) jobs.

## Analyst stays OFF after merge

Merging code and activating the feature are separate decisions.

- **Target environment until activation:** `ANALYST_ENABLED=false`, `ANALYST_PILOT_ALLOWLIST=`
  (empty, so nobody is admitted), `ANALYST_DROP_CONSENT_ENABLED=false`, and the frontend
  build arg `NEXT_PUBLIC_ANALYST_ENABLED=false`.
- **What OFF means:** the Analyst API returns 404, which the dogfood journeys verify, and
  existing BI modules are untouched (the operations journeys ran flag OFF and back ON).

## Not done by the engineering session

- PR approvals and merges.
- Any push to `demo` or `master`.
- Deployment.
- Enabling the Analyst anywhere except the isolated dogfood stack.
