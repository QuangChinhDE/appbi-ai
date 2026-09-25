# Dashboard AI Design v2 — plan and verification

The changes are listed in the order they were built. Each is locked by a check.

1. **Contract.** Layer, structure operations, suggestions and value domains, in
   `types.ts` and `capabilities.ts`. Dead capabilities removed.
   Checks: `qa:presentation` "decorative…", "span…", "section_break…".
2. **Intent and clamp.** `intent.ts` and `coerceModelPlan`.
   Checks: "the user's words grant the layer", "a plan can ask for less".
3. **Executor by layer, locks as fixed tiles, validator permission rules.**
   Checks: STYLE, LOCK and SCOPE proofs.
4. **Structure engine.** `structure.ts`: patch, settle, lift into vacated space.
   Checks: STRUCTURE proofs.
5. **Design Context and role inference.**
   Checks: snapshot label/leak checks, "role inference reads meaning first",
   backend `test_presentation_planner_reference_image.py`.
6. **Selection UI, lock through the draft, tidy/compact respecting locks.**
   Checks: e2e STRUCTURE, contract LOCK tidy/compact.
7. **Tile frame and parity.** `tile-frame.ts` and `SectionBands` shared.
   Checks: PARITY proofs, e2e PARITY.
8. **Responsive derivation.**
   Checks: RESPONSIVE proofs, e2e 820 px and 390 px.
9. **Render audit and critic.**
   Checks: e2e "the render audit catches a real rendered defect", and the STYLE
   check "no new hard defect".

## Gates

- `cd frontend && npm run qa`
- `npx tsc --noEmit`
- `pytest backend/tests/test_presentation_planner_reference_image.py`. Now tracked
  in `.gitignore` and `backend-contract-tests.yml`.
- `e2e/tests/dashboard-presentation.spec.ts`. It needs a representative dashboard
  in the database; on an empty CI seed it skips with its reason.
