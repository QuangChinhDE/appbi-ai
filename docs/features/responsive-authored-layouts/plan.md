# Device-specific dashboard layouts — plan and test matrix

## Steps

1. Capture AUTO golden vectors from the unmodified public pipeline.
2. Phase 0 prerequisites (spec.md) with regressions.
3. Migration + model + server service (validate / stage / conflicts / promote /
   prune / remap / public view) + endpoints.
4. The resolver; Builder (`DashboardGrid`, device mode UX) and public
   (`PublicDashboardView`) draw through it with one width.
5. Tests, docs, mutation checks, CI, merge.

## Test matrix

| Evidence | Where |
|---|---|
| AUTO = old published layout (140 vectors, 1440→390 incl. 639/640/1023/1024) | `frontend/scripts/check-responsive-layout-contract.mjs` |
| CUSTOM drawn as stored, no fit; freeze without jump; stale; orphans below; dropped; twins by tile id; absent controls; determinism; scale 50/200/500 | same |
| Surfaces use the resolver and one width; print uses desktop | same + `check-unified-grid-contract.mjs`, `check-report-structure-contract.mjs`, `check-presentation-contract.mjs` |
| Validation, draft isolation, publish, discard, reset, conflict + force, multi-author, prune (tile, page), draft-moved tile, draft-only tiles, duplicate remap, Phase-0 PUT /layout, /relayout, tile page default, cache invalidation | `backend/tests/test_dashboard_responsive_layouts.py` |
| JSONB, publish conflict and duplicate on Postgres through the real app | `backend/tests/test_dashboard_responsive_layouts_pg.py` |
| Browser journeys A–R (parity on 5 surfaces, customise/save/reload/publish, isolation, reset, regenerate, add/delete tile, multi-page, AI, edges, data independence, draft isolation, Studio read-only) | `e2e/tests/public-closure-responsive.spec.ts` |
| PDF unaffected | existing real-PDF worker journeys (`e2e/tests/user-feedback.spec.ts`) in CI |
