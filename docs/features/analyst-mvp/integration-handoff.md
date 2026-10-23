# Integration handoff: PR stack → `demo`

For the **authorized human merger**. The engineering session did not merge, approve or
push any protected branch. All merges go through the normal GitHub PR flow, with
the required reviews.

## Rehearsal (2026-10-22, local throwaway worktree, nothing pushed)

The order below was merged onto `origin/demo @ 1bac25e8` exactly as listed.

- **Result:** after #70, the tree equals `rc/pilot-3` for backend, frontend, CI and scripts.
- **Alembic:** a single head.
- **Conflicts:** exactly two textual conflicts. Both are list files where each side
  only adds lines. The resolution is the **union** of both sides; delete nothing.

| Step | PR | Head | Base | Merge |
| --- | --- | --- | --- | --- |
| 1 | #65 SEC-13 grain whitelist (security hotfix) | `ddcbb693` | demo | clean |
| 2 | #67 chart-config write validation | `b8454c7b` | #65 branch | clean |
| 3 | #69 semantic sync keeps owner-edited dimensions + glossary link | `d04803ff` | demo | clean |
| 4 | #53 PR-0A security ledger + foundation | `7b69fcf6` | demo | clean |
| 5 | #54 PR-0B1 | `f7ec8914` | #53 | **conflict:** `.github/workflows/backend-contract-tests.yml`, resolve by union of both test lists |
| 6–14 | #55, #56, #57, #58, #59, #60, #61, #62, #63 | stack heads | previous | clean |
| 15 | #64 SEC-13 ledger regression (strict xfail) | `2062bb9c` | #63 | clean |
| 16 | **#70** SEC-13 test reconcile (xfail → plain regression once #65 is in) | `9c571b5b` | #64 branch | clean; **required after #64**, or #64's strict xfail XPASSes and fails CI |
| 17 | #68 GQS 1C–1G + Analyst | current head of `feat/gqs-1c-1d-bounds-cancel` | #63 | **conflict:** `.gitignore`, resolve by union of the `!backend/tests/...` lines |

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
