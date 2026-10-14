# Unified Grid — independent product review, DoD and decisions

**Review base:** `7c237d7c`, read from source, not from the PR text.

**Method.** Each capability was traced from the user action through frontend state, validation, API, persistence,
the renderer and Public/Embed/PDF, to Undo, Discard and Publish. At each step I looked for a counterexample. A
comment or document is treated as a claim until the code confirms it.

Paths are relative to the repository root. §6 records what was implemented and how it was verified.

## 1 · Findings

### F1 — Removing a published element is not a draft edit *(published-state integrity, priority 1)*

Adding and removing follow different lifecycles, and the draft does not record removals at all.

| Step | What the code does | What the user sees |
|---|---|---|
| **Remove a published chart, widget or control** | `DELETE /dashboards/{id}/charts/{dcid}` → `DashboardService.remove_chart` runs `db.delete` + commit (`backend/app/services/dashboard_service.py:458-480`). The draft does not record it. | The public link and embed lose the element **before Publish**, after the public cache TTL. |
| **Discard** | Deletes only the caller's `draftOnly` rows (`backend/app/api/dashboards.py:2579-2582`). It restores nothing. | "Remove, then Discard" leaves the element **permanently gone**, while the author believes the report is back to its published state. |
| **Undo a control removal** | Re-creates the control through `addWidget(... draftOnly: true)` with a **new id** (`frontend/src/app/(main)/dashboards/[id]/page.tsx:631-650`). | It looks restored. **Remove → Undo → Discard deletes a control that was published.** |
| **Undo a chart or widget removal** | `confirmRemoveChart` calls `resetUndo()` (`page.tsx:2024`). | Not undoable. |
| **Add a chart or widget manually** | `handleAddWidget` and `handleAddChart` create **live** rows (`page.tsx:1906-1918`, `:1977-1989`). AI blocks and grid controls are `draftOnly`. | A manual addition is published instantly. An AI one waits for Publish. |
| **Delete filter** | `PUT /draft-filters`, then one `DELETE` per control, each in its own transaction (`page.tsx:3161-3176`). | **Not atomic.** A failure halfway leaves the filter removed in the draft and controls deleted live. Public viewers keep a filter that applies but can no longer be changed. Filter-pane (`filters_config`) filters keep their entry while their controls are deleted. |
| **`has_draft`** | Ignores `draftOnly` rows (`dashboards.py:1670-1677`). The Publish/Discard bar and `handleDiscardAll`'s server call depend on it (`page.tsx:1838`). | An unpublished block can exist with no draft bar, and Discard does nothing. |
| **Discard with several authors** | Sets the whole `draft_snapshot` to None (`dashboards.py:2583`). | It wipes **every author's** layout draft. Publish only merges the caller's bucket. |
| **Publish a co-author's merged layout** | The merged layout can carry `draftOnly` / `draftOwner` copied from another author's row (`page.tsx:1665`, `dashboards.py:2509`). | A published block can become draft-only again: hidden on Public, and deletable by its creator's Discard. |
| **Public data allow-list** | The chart-data batch and AI-chat allow-lists use every row, `draftOnly` included (`backend/app/api/public.py:3126`, `:4037`). | A public token can query an unpublished tile by id. |

### F2 — A reader cannot see an active filter whose control is not shown *(filter integrity, priority 1)*

| Case | What the code does | What the reader sees |
|---|---|---|
| **Filter locked by the link** | The field is stripped from the served structure (`public.py:1102-1122`). The comment calls a read-only banner "a separate future enhancement". | The numbers are filtered, and nothing on the page says so. On `s6-locked-1440` the report is locked to RJ (Revenue by state shows only RJ) with no indication. |
| **Control with no visible content** | The viewer's control renders `data-slicer-control="absent"`, an empty div that **keeps its grid cell** (`frontend/src/components/dashboards/GridSlicerTile.tsx:119-120`). | A blank strip about 100 px tall above the KPIs on `s6-locked-1440`. |
| **Filter with no control on this page** | A slicer that filters a page but has no control there — a custom scope with "filter, don't show", or a new page — is applied silently. | Nothing states the filter. |

The report-level `filters_config` locked banner exists (`frontend/src/components/dashboards/PublicDashboardView.tsx:612-631`). It does not cover link locks or slicers.

### F3 — Section headings do not stay with their content *(report structure, priority 3)*

- **Nothing stores which tiles a heading owns.**
  - The `section_header` widget has only eyebrow, title and subtitle.
  - `SectionBands` infers membership from position: every tile from the heading down to the next heading (`frontend/src/components/dashboards/SectionBands.tsx:46-56`).
- **AI Design treats an existing heading as one more decorative tile.**
  - Each direction puts every existing heading after the tables or caveats, two per row (`frontend/src/lib/dashboard-presentation/directions.ts:248`, `:315`, `:372`).
  - Under a model plan, a heading the model left out is appended at the end in *snapshot array* order (`compiler.ts:558-572`). The note says "reading order".
- **Headings are sized as 260 px "supporting" tiles** (`compiler.ts:386`). The 64 px heading target is never used for an existing heading.
- **Re-running executive or operations adds another "Detail"** each time and pushes the old one to the end. Reuse only looks at narrative tiles (`directions.ts:169-171`).
- **Seen in `U-studio-compare-1440`:** "Performance" alone at the bottom of the After frame, and the "Detail" band stretched over unrelated content.
- **No test fixture contains an existing heading being redesigned.**

### F4 — Authoring friction *(priority 4)*

- **A control can only be placed "top" or "end".** Putting Region next to its chart means placing it, then dragging it across the page. The grid does not auto-scroll during a drag: the acceptance harness had to enlarge the viewport to make that drag possible, and a person has the same problem on a long report.
- **A new page gets no controls.** The Slicer button counts the page's missing filters, but placing them is one step per filter.

### F5 — Visual and print quality *(priority 5)*

**PDF**
- It prints interactive chrome: the slicer dropdown and chevron, and "Group by Y Q M W D ×Off".
- The header lists filters by name without their value ("Bộ lọc: Customer state").
- Its labels are hard-coded Vietnamese inside an English report ("Xuất lúc", "Bộ lọc", "Ảnh trang — bảng in theo dữ liệu đang hiển thị").
- Other short text is still truncated with an ellipsis: a section header reads "Performan…".

**Layout**
- Executive: the headline card runs full width while its text uses about half of it.
- Real-model redesign (`s7-ai-builder-1440`): the table tile is much taller than its rows.

### F6 — Stale contracts

See §4.

## 2 · Source-to-claim matrix

| Claim (7c237d7c) | Source | Test | Browser evidence | Uncovered negative case | Impact | Status |
|---|---|---|---|---|---|---|
| Controls are grid elements; no filter area outside the grid | `GridSlicerTile`, `SlicerControlScope`, SlicerCluster deleted | unified-grid S1–S13, U, contract | U, L, S12 screenshots | — | — | **VERIFIED** |
| New controls are draft-only until Publish | `placeSlicerControls` → `commitPresentation` (draftOnly) | S10 | S10 | Remove a *published* control before Publish (F1) | Public changes before Publish | **PARTIAL** |
| Remove control is one undoable step | `removeSlicerControl` + `removedBlockSpecs` | contract, S3, F | — | Undo → Discard deletes a published control (F1) | Loss of published work | **FAILED** |
| Remove control ≠ Delete filter ≠ Clear value | `handleDeleteSlicerFilter` | F | — | Partial failure; pane filters; public before Publish (F1) | Half-applied change | **PARTIAL** |
| A locked or hidden link filter gives no editable control | `_strip_link_managed_filter_fields` | S6 | `s6-locked-1440` | The reader is not told the report is filtered; a blank cell remains (F2) | Trust | **PARTIAL** |
| Custom scope "filters silently" | `slicerFiltersHere` | S5 | `s5-public-page1-1440` | Nothing states the active filter to the reader (F2) | Trust | **PARTIAL** |
| A redesign keeps every visual | compiler orphans | contract | — | A heading is placed away from its content (F3) | Misleading structure | **PARTIAL** |
| A forgotten control goes to the filter band | `validator.ts:256-267` | contract | V3 S5 | — | — | **VERIFIED** |
| Migration and rollback are exact | 20260929_0001 | SQLite + Postgres round trip | 574 | Exact **only without author edits** after the upgrade; otherwise a gap is left, never an overlap | Documented | **VERIFIED (scoped)** |
| Builder = viewer for stored overlaps | `grid-settle.ts` | contract, S12 | 445 | — | — | **VERIFIED** |
| PDF has no gap from the old bar | export | U | `U-export-page*` | Chrome printed; filter values missing; VI labels (F5) | Print quality | **PARTIAL** |
| Full e2e reliable | — | 77 tests | — | Container-path stalls; mechanism unknown | Environment | **NOT VERIFIED** (environment) |

## 3 · Product DoD

Each DoD names the user scenario, the observable result, the invariant it protects, a negative case, the evidence
required, and the condition that makes it FAIL.

**DoD-1 — Removal is a draft edit** *(F1; invariant A)*
- **Scenario:** an author removes a published chart, a text widget or a control, then checks the public link, Undoes,
  Discards, removes again and Publishes.
- **Expected:**
  - Until Publish the public link and embed still show the element.
  - In the builder it disappears, and the draft bar shows a pending change.
  - Undo brings back the **same element** (same id, still published).
  - Discard brings it back.
  - Publish removes it from the public link.
- **Negative:**
  - Remove → Undo → Discard leaves it published and present.
  - A co-author's Publish neither removes it nor re-hides a published block.
  - Another author's draft still contains it.
- **Evidence:** a backend test on a real SQLite DB covering the lifecycle and a second author, shown to fail on the
  previous code; a browser run on 574 that checks the public link at every boundary.
- **FAIL if:** the public link changes before Publish, Discard cannot restore the element, or Undo turns a published
  element into draft-only.

**DoD-2 — Manual additions are drafts too** *(F1; invariant A)*
- **Expected:** a chart or widget added in the builder is invisible on the public link until Publish, and Discard
  deletes it.
- **Negative:** its data cannot be fetched through the public chart-data allow-list before Publish.
- **FAIL if:** an addition appears publicly before Publish, or its data is served to a public token.

**DoD-3 — Delete filter is one atomic draft change** *(F1)*
- **Expected:**
  - One request removes the filter entry — a slicer, a page slicer or a filter-pane filter — and every control for it
    on every page, in the draft.
  - The public link keeps the filter and its controls until Publish.
  - Discard restores both.
- **Negative:** injecting a failure after the entry is removed leaves **nothing** changed.
- **FAIL if:** a partial state is reachable, or a filter-pane entry survives while its controls go.

**DoD-4 — `has_draft` and Discard are honest** *(F1)*
- **Expected:** a draft that only adds or only removes elements shows the draft bar, and Discard reverts it.
- **Negative:** Discard by author A keeps author B's layout draft.
- **FAIL if:** either one does not hold.

**DoD-5 — The reader can always tell what filters the page** *(F2; invariant B)*
- **Scenario:** a link locks a field; a slicer filters a page with no control shown there; a filter is hidden by the
  link.
- **Expected:**
  - Public and embed show a read-only line such as "Filtered · Customer state: RJ 🔒" for locked link filters, and
    for applied slicers with no visible control on this page.
  - Hidden (🚫) filters are **never** named.
  - The PDF header states the same filters with their values.
- **Negative:** a hidden link filter's field or value appears nowhere in the served structure or DOM.
- **FAIL if:** a constrained page reads as unfiltered, or a hidden value leaks.

**DoD-6 — An invisible control leaves no blank strip** *(F2; invariant C)*
- **Expected:**
  - On public and embed, a control that renders nothing for this viewer gives back its band when nothing else shares
    those rows.
  - The saved layout is untouched; this is a projection.
  - A locked tile never moves.
- **Negative:** a control beside a chart in the chart's row leaves the chart where it is.
- **FAIL if:** a blank band remains, or any saved geometry changes.

**DoD-7 — A heading introduces its content** *(F3; invariant D)*
- **Scenario:** a report with author headings ("Performance" above its charts) is redesigned by each direction and
  by a model plan that leaves the heading out.
- **Expected:**
  - Each author heading sits directly above the first tile it introduced, is full width, and is heading height, not
    chart height.
  - Re-running a direction does not add a second "Detail".
- **Negative:** a heading whose content is locked or absent stays where the plan put it, never alone at the end.
- **FAIL if:** a heading ends up after unrelated content or at the end introducing nothing, or headings pile up.

**DoD-8 — A control lands beside the element it belongs with** *(F4; invariant C)*
- **Expected:** with an element selected, "Add → Slicer" can place the control next to it — in free space in its
  row, or directly above it.
- **Negative:** a locked neighbour never moves; if it cannot fit, the builder says so and falls back to an explicit
  choice.
- **FAIL if:** the author must drag the control across the page to put it by its chart.

**DoD-9 — Print output is a document, not a screenshot of the UI** *(F5)*
- **Expected:**
  - No interactive chrome in the PDF: group-by toggles, dropdown chevrons.
  - Controls print as "Label: value".
  - The header states filters with their values.
  - Labels follow the UI language.
- **FAIL if:** any of these is visible on an exported page.

**DoD-10 — No regression**
- **Expected:**
  - Unified Grid S1–S14, L, F and U, and V3 S1–S8, keep passing on the production image.
  - `npm run qa`, the backend contract tests and CI stay green at the final HEAD.

## 4 · Stale contracts (F6)

A reference audit classified every remaining mention of a filter bar, cluster or dock in `frontend/src`, `backend/app`,
`frontend/scripts`, `e2e` and these docs into five kinds.

| Kind | Examples | Decision |
|---|---|---|
| **Active runtime** | `filter_bar` primitive (a band of grid controls); `ImportLayoutPreview` drawing a rail/drawer | primitive kept (name only); the preview **fixed** (§6) |
| **Persistence compat** | `slicer_cluster_layout` column (holds the `migratedToGrid` marker the downgrade reads); `theme_config.filterDock` (backend `controls_hidden` reads `'hidden'`) | **kept** — old rows and the rollback depend on them |
| **Misleading, user-visible** | theme hints "filters on top / compact rail / filters in a drawer", "Where filters sit"; HTML-import chip "filters: left" | **fixed** |
| **Misleading, code/docs** | `page.tsx` "release any stored position" (the code no longer releases anything); `spec.md` "its control returns to the filter bar"; `filters.ts`/`models.py` "SlicerBar" comments | the builder comment and `spec.md` **fixed**; others left as naming debt below |
| **Dead code** | the non-`bare` half of `DashboardFilterBar` (~360 lines, unreachable since its only caller passes `bare`); `resolveFilterDock`, `dockLayoutClasses`; 32 `dashboards.slicerCluster.*` i18n keys; `.slicer-cluster` CSS; `slicerClusterPatch` (always `{}`); `data-dashboard-filterdock` | **left**, listed as debt. Deleting it is a cleanup with its own risk (the live controls render through `DashboardFilterBar bare`), not a product fix; two unused imports were removed |

Contract checks that force the inert `filterDock` / `filter_dock` keys to exist
(`frontend/scripts/check-theme-presets.mjs:121-126, 295-310`) are left unchanged: removing them is a separate, declared
guardrail change.

## 5 · Decisions

| Problem | Options considered | Chosen, and why |
|---|---|---|
| Removal lifecycle (F1) | (a) keep hard delete, add a "restore" that re-creates rows; (b) a draft snapshot of the whole tile set; (c) **a per-author removal mark on the live row** | (c): symmetric with the existing `draftOnly` + `draftOwner` for additions. The row keeps its id, so Undo and Discard restore the element itself and every reference to it (narrative findings, locks, public link) survives. Publish and Discard already scope to the author. `DELETE` without `draft` keeps its old semantics for non-builder API clients. |
| Delete filter atomicity | client-side compensation; a new endpoint | **`remove_tile_ids` on the existing draft-filters PUT**: the entry and every control in one transaction, with no new endpoint and no compensation logic. |
| Widget content edits | leave live; store edited configs in the row | **per-author `user_widget_configs` in `draft_snapshot`**, the same shape as `user_layouts`, so Publish, Discard and co-authoring rules apply unchanged. |
| Filter context (F2) | show the control read-only in its cell; **a header statement** | a header statement: a locked field has no control on the page by design (the server strips it), and a statement in the one place a reader looks for context covers link locks, page filters and control-less slicers alike. Hidden entries are never served, so the frontend cannot leak them. |
| Blank cell of an absent control | collapse every absent cell; **close a band only when nothing else shares its rows** | the builder's `closeVacatedBand` rule, applied as a viewer projection: no saved geometry changes and no author-placed neighbour moves. |
| Headings (F3) | store membership on the heading (a schema change); ask the model to keep headings; **anchor in the compiler** | the compiler, from geometry — exactly how `SectionBands` defines membership — so model plans and all three directions get it at once, with no migration and no longer prompt. |
| Placement friction (F4) | drag-and-drop from a palette; auto-place by field; **"Next to the selected element"** | reuses the selection model and `resolveDrop`, so the insert rule is the one the grid already uses. |
| PDF chrome (F5) | CSS media print; **mark screen-only elements and hide them in the capture clone** | the capture already runs on a clone with injected CSS (`legibleClone`); a data attribute is explicit and survives restyling. |

## 6 · What was implemented and verified

**Commits (review base `7c237d7c`):**
- `e9f441e2`: the round's fixes;
- `9572f0d8`: embed `not_in`;
- `29e2e0ee`, `057e6955` and `23f6b3c3`: from three semantic-guard reviews of the public paths;
- `17f8071d`: acceptance R7.

**Code under the final acceptance run: `23f6b3c3`**, built into the production image (:3219) and the host build (:3218)
against the isolated backend. Evidence: [`evidence/README.md`](evidence/README.md).

Every new test was run against the code before its fix and fails there. The negative controls are listed in each
commit message.

**Three levels, kept apart.**
- **Technical:** unit, contract and backend tests.
- **Runtime:** a browser drove the running production build.
- **Product acceptance:** a person judged the experience. This is **not** claimed here. It is the human reviewer's,
  and the screenshots and PDF pages listed in the evidence are for that review.

| DoD | Implemented | Technical foundation | Runtime behaviour (container + host, `23f6b3c3`) | Product acceptance |
|---|---|---|---|---|
| **DoD-1** removal is a draft edit | `draftRemoved` + `draftRemovedBy`; restore endpoint; Publish deletes, Discard restores; Undo restores the same row | **VERIFIED**: `test_dashboard_draft_removal_lifecycle.py` (removal → public → Undo → Discard → Publish; second author) | **VERIFIED**: R1 (link keeps the element until Publish; exact Undo returns the same id) | pending review |
| **DoD-2** manual additions are drafts | `draftOnly` on hand-added charts/widgets; every public path serves published tiles only (also after the access commit); the public AI scope is recorded from the served tiles | **VERIFIED**: lifecycle tests (add → Discard; the public copy writes nothing; capped-link commit; AI scope with a mid-turn commit) | **VERIFIED**: R2 (the AI-scope path is backend-only) | pending review |
| **DoD-3** Delete filter is one transaction | `remove_tile_ids` on the draft-filters PUT | **VERIFIED**: failure injection leaves nothing changed | **VERIFIED**: R3, F | pending review |
| **DoD-4** `has_draft`, per-author Discard | the serializer counts row drafts; `_other_authors_drafts` | **VERIFIED**: lifecycle tests (a second author's draft is kept) | **VERIFIED** (single author): R1/R2 draft bar. Two authors in a browser: NOT VERIFIED | pending review |
| **DoD-5** the reader can tell what filters the page | a lock is served iff the engine keeps it, with the operator and value it enforces; facts read as the engine enforces them (exclusion, range, comparison, pattern, `is_null`, preset); banner on `/d` + `/embed`; per-page PDF header on both export paths | **VERIFIED**: `test_public_link_filter_disclosure.py` (7); unified-grid contract "a reader can always tell…" | **VERIFIED**: R4 (RJ stated; the hidden link serves and names nothing), R7 ("not SP"; numbers differ from the inclusion link), S11 PDF header "Filters: Customer state: SP" | pending review |
| **DoD-6** no blank band for an absent control | `withoutAbsentControls` (viewer projection, `closeVacatedBand` rule) | **VERIFIED**: contract (the band closes; a neighbour and a lock stay) | **VERIFIED**: R4 (first tile at ≤ 24 px, 0 absent cells); `s6-locked-1440` | pending review |
| **DoD-7** headings introduce their content | `anchorSectionHeadings`; heading height; reuse of "Detail"; orphans in reading order | **VERIFIED**: contract + report-experience | **VERIFIED**: R5 (two Executive runs on the 574 copy: the heading is above its charts, 80 px, one "Detail"); `U-studio-compare-1440` | pending review |
| **DoD-8** a control beside its element | `placeBeside` + "Next to <element>" | **VERIFIED**: contract (free space, insert above, lock refusal) | **PARTIAL**: R6 drives the free-space branch only. Insert-above and lock refusal are NOT VERIFIED in a browser | pending review |
| **DoD-9** print is a document | `data-export-hide`, legible CSS, localized labels, filters with values | **VERIFIED**: contract (print) | **VERIFIED**: all 6 PDF pages reviewed; no chevrons or Group-by chips, filters with values, English labels, "Performance" in full. Open and pre-existing (not a DoD-9 condition): KPI glyph gaps, section-band edges across page breaks | pending review |
| **DoD-10** no regression | — | **VERIFIED**: `npm run qa`; the backend contract list (2,003 pass locally; 2 need the pinned FastAPI and pass in CI); the agent-flow gates; tier-1 oracles; CI 5/5 green at `23f6b3c3` | **VERIFIED**: unified grid 24/24 on both surfaces; V3 8/8 host; V3 container 7/8 in the chain, then S4 31/31 twice alone (rig stall, classified in the evidence); CI e2e green; host e2e 72 pass / 0 fail | pending review |

**Found on the way, outside this scope, fixed because they were priority 1:**
- An M2M embed claim `not_in X` was enforced as `in X` (`embed_link_service.py`), so the embed showed exactly what
  the caller excluded (`test_embed_link_claim_operator.py`).
- The public AI's knowledge scope included datasets that exist only on draft tiles.

**Not changed, recorded:**
- **A link lock the engine drops still strips its field** (`link_entry_has_value`, the dashboard-53 class). This is
  pre-existing, protected merge semantics, and belongs in its own change with `layered_merge` and `galaxy_golden`.
- **Dashboard- and page-level `publicMode: 'hidden'` entries are served as stored.** This is pre-existing.
- **Wording gaps** found by the third review pass: `not_between` stored as a string; an unknown preset on a
  report-level lock; `ends_with` and regex conditions. None is reachable through a claim.
- **Chart parameters edited from a tile menu still write the shared chart.**
- **Dragging does not auto-scroll, and a new page gets no controls automatically.**
- **The dead non-`bare` half of `DashboardFilterBar`** (§4).
- **Visual, pre-existing:**
  - the PDF KPI glyph gaps and band edges;
  - the pie label clipped in a short tile;
  - a table tile taller than its rows (`s7`);
  - the Executive headline running full width with half-used text.

## 7 · Benchmarks

Each benchmark is a path a person would take, driven through the UI on the production image. The rows below are what
was measured and what still costs the author effort.

### B1 — Manual authoring (Olist baseline, 13 visuals: S2, S3, L, R6, S14)

| Step | Result | Friction still there |
|---|---|---|
| Arrange, align, nudge, lock, Undo/Redo | exact; a lock holds (S2) | — |
| Move a control between rows | 445–557 ms from gesture to settled; 0 chart queries (S14) | the grid does not auto-scroll while dragging, so on a long report the author drags off-screen or scrolls first |
| Put a control next to its chart | *Add → Slicer → Next to …*: 1.5 s, no drag (R6). Before this round it meant placing at the top, then dragging across the page | when the row is full it inserts directly above instead (contract-verified only); a short control leaves empty space under it in a tall row |
| Three placements in one report (date beside the headline, category above the KPIs, state list beside its chart) | same numbers, narrative and render findings after every move, at 3 widths (L) | — |
| A new page | the Slicer button counts the filters the page has no control for | one placement per filter |

### B2 — AI Design → manual refinement (S7, S8, S9, R5; V3 S3–S5)

| Step | Result | Friction still there |
|---|---|---|
| A real-model redesign with controls | the controls it adds are draft-only; the published control is kept and not duplicated; no typed figure (S7) | the model's composition varies between runs; the suite asserts properties, not a layout |
| A style-only change | every rectangle unchanged (S8) | — |
| An author heading through a redesign | stays directly above its content at heading height; re-running a direction reuses its "Detail" (R5). Before this round "Performance" ended at the bottom introducing nothing | — |
| Manual edits after AI | the AI's control moves, restyles and is removed; the filter stays (S9) | the Executive headline runs full width with its text using about half of it; a table tile can be taller than its rows |

### B3 — Legacy, filters, lifecycle (574 copy and a new report: U, R1–R4, R7, S5, S6, S10, S12)

| Step | Result | Friction still there |
|---|---|---|
| Open the legacy report | no filter area outside the grid; the controls are grid elements (U, S12: 12 migrated reports) | — |
| Remove a published element, check the link, Undo, Discard, Publish | the link keeps it until Publish; Undo returns the same element; nothing is left to publish after an exact Undo (R1) | — |
| Add by hand, Discard | draft-only, deleted by Discard (R2) | — |
| Delete a filter | the entry and all its controls, in one draft change (R3) | — |
| Share a locked link / an excluding link / a hidden link | "Filtered by 🔒 Customer state: RJ"; "not SP"; the hidden link names nothing; no blank band (R4, R7) | a table on another field with the same values (seller state) can still read as contradicting the lock; that is correct data, not changed |
| Export the PDF | each page states its filters with their values, in the UI language, with no interactive chrome (S11, U) | the KPI glyph gaps and band edges across page breaks (pre-existing) |
