# Reconciling `fix/dataset-final-hardening` with `security/authz-remediation`

Proven on a local, unpushed merge of the two branches (security head `9b431678`):
every Dataset journey passes on that merge — J1, J1b, J2, J3, J4, J5, J6
(permission matrix, forged requests, 5 roles × 8 actions), J7, J8, J9.

Conflicts: `backend/app/api/datasets.py` (7 hunks), `dataset_grants_service.py`
(1), `frontend/src/app/(main)/datasets/[id]/page.tsx` (1), contract workflow (1).
Take the security side of each authorization hunk, then:

1. **Grant routes** — drop the Dataset branch's `require_grant_authority(...)`
   call in `set_dataset_grant`; `grant_as` / `revoke_as` own grant authority (and
   validate that the target user/team exists, which also removes the 500 a grant
   to a non-existent user produced).
2. **Composed-table lineage** — the Dataset branch's
   `dataset_grants_service.require_view_lineage(db, current_user, dataset_id)`
   in preview / execute / export / distinct values / column summary / profile sits
   where the security branch now puts `_authz.require(... EXPLORE ...)`. Keep BOTH:
   re-add the lineage call right after the EXPLORE check in those six routes.
   The security branch does not do parent lineage
   (`test_composed_reads_check_parent_lineage.py` fails if it is lost).
3. **Dataset page** — re-add `const refreshTableSchema = useRefreshTableSchema(datasetId);`
   right after the security branch's `resPerms` line (the build fails without it).
4. **`test_dataset_grant_authority.py`** — the routes now take `request` (audit)
   and `grant_as` resolves the target user: pass `request=None`, stub `audit`, and
   create `users` rows for the principals.
5. Run: the backend contract list, the Postgres job, and
   `e2e/tests/dataset-lifecycle-*.spec.ts` (J6 un-skips itself once the dataset
   response carries `capabilities`).
