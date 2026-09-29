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

## Hardening round — verification

- **Fixture.** `backend/scripts/ci/seed_e2e_presentation.py`, run by `e2e.yml`. The spec fails on CI if the fixture is missing.
- **Backend.** `tests/test_dashboard_presentation_publish_is_atomic.py` covers:
  - staging does not touch live;
  - publish applies everything together;
  - a 409 applies nothing;
  - discard;
  - reload overlay;
  - public cache invalidation.
- **E2E on a production build** (`npm run build` + `next start`, real API, real Postgres). The flows covered are:
  - style-only preview == apply → Save draft → reload;
  - Publish → reload, with `/d` and `/embed` parity;
  - theme-only;
  - discard, undo and multi-turn;
  - lock under structure and redesign, and after publish;
  - multi-selection;
  - desktop, tablet and phone.
- **Screenshots** from that run are in `screenshots/`.
- **CI note.** The `next/font/google` build failure (`loader.js:122`, reading `[1]` of null) is upstream: Google Fonts sometimes returns a font URL with no file extension, and Next's loader assumes one. It reproduced locally once and then passed on retry. `layout.tsx` is not changed by this PR.
- **Vision critic: deferred.** The shipped critic is DOM-based (deterministic, bounded, re-validated). A vision pass would add model cost and latency to every preview, and there is no aesthetic golden to judge its repairs. It would plug into the same findings → bounded-repair contract in `critic.ts`.
