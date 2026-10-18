# Dashboard Builder UX simplification — plan and evidence

## Files

Frontend only.

| File | Why |
|---|---|
| `app/(main)/dashboards/[id]/page.tsx` | Preview ▾ menu, contextual device bar, AI Design toggle, Slicer out of the header, phone-width fallback in More |
| `components/dashboards/ArrangeBar.tsx` | 2+ only; Arrange ▾ and Frame ▾ menus |
| `components/dashboards/ChartTile.tsx` | hover ✕ and duplicate Explore icon removed; Remove in the ⋯ menu; tools visible when selected/touch |
| `components/dashboards/DashboardGrid.tsx` | still press selects charts; focus dedupe |
| `i18n/catalog/dashboards-detail.ts`, `dashboards-grid.ts` | 2 new strings each (en + vi) |
| `e2e/tests/_helpers.ts` | `chooseBuilderDevice`, `openStudioPreview` |
| `e2e/tests/*responsive*`, `dashboard-pptx-export.spec.ts` | enter a device through the new entry point; every layout/save/publish/isolation/keyboard assertion kept |

## Evidence (real browser, same dashboard 37, sidebar excluded)

| State @1440 | Before | After |
|---|---|---|
| Just opened | 14 controls · 2 layers · canvas from y=127 | 9 · 1 · y=86 |
| One chart selected | 22 · 3 layers | 11 · 1 (−50%) |
| Two charts selected | 29 · 3 | 14 · 2 (−52%) |
| Unsaved changes | 17 · 2 | 14 · 1 |
| Inspector open | 36 · 3 | 27 · 1 |
| AI Design | 26 · 2 | 21 · 1 |
| Tablet AUTO | 15 · 2 | 13 · 2 |

Every width (390–1920) is lower or equal; no header overlap at any width, vi or en,
clean or with unsaved changes.

Journey on throwaway copies of dashboard 146 (deleted afterwards), 1440/1024/390:
open → no device bar; Preview menu by keyboard; Tablet; looking writes nothing;
Customize → Save draft (`PUT draft-responsive` 200) → Desktop untouched → reload keeps
CUSTOM → Save & publish (200) → Phone still AUTO; select one (no bar, tools visible);
⋯ → Remove → confirm → Cancel keeps the tile; select two → bar; Escape keeps selection;
Same height → Undo restores → Redo reapplies; ✕ clears; AI toggle on/off.

## Gates

- `tsc --noEmit`, `npm run qa`, unified-grid and responsive-layout contracts: pass.
- ESLint on touched files: same 242 pre-existing findings as base, none new.
- Device-layout E2E suites need the CI seed fixture ("E2E Presentation fixture"); they run
  in the PR's E2E job, not against the local demo database.

## Backlog (found, not fixed here)

1. **Overlapping stored desktop layout breaks Tablet Customize.** Dashboard 37 stores
   both tiles at x0,y0; Desktop compacts them visually, Customize copies the overlap and
   the server refuses the save (`tiles … overlap`, 400). Same on the current demo build.
   The fix belongs where CUSTOM is seeded from Desktop (compact before seeding), with a
   test.
2. **AI Design panel covers the header More button at 390px**, so at phone width the
   mode can only be left from the panel itself. Pre-existing.
3. Widget (non-chart) tiles still show their own hover cluster, including remove.
4. `x`-axis labels collide on narrow Tablet AUTO tiles (chart rendering, not Builder).
