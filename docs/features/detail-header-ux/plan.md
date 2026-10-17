# Unified Detail Header UX — intent, spec and plan

Status: **PROPOSED — awaiting approval. Nothing implemented.**

## Intent

Detail and editor headers across seven modules grew one control at a time. Each module
hand-rolls its own header, segmented tabs, overflow menu and banner. The result is
toolbars that overflow or wrap unpredictably, warnings scattered across rows, and one
security smell: the workboard owner PIN is rendered in plaintext in a strip right under
the header.

Goal: one compact, consistent header system that removes nothing. Every action, state and
warning that exists today stays reachable. The information is reorganised, not deleted.

Out of scope: API contracts, DB schema, permission logic, the execution engine, and
draft/live semantics. This change is frontend-only.

## Audit findings (defects → root cause)

| # | Module | Defect | Root cause |
|---|---|---|---|
| D1 | all | No shared header, overflow menu or banner component. There are three hand-rolled menus (fixed backdrop + absolute panel) and ad-hoc banner divs. | No primitive exists, so each page copies the h-11 row and diverges. |
| D2 | Dataset `datasets/[id]/page.tsx:1341` | Fixed h-11 row with no wrap and no overflow. With publish controls (badge, mixed-sources badge, Sync, Share, History) plus preview tools (Export, Columns, Rows, Refresh), the row overflows below ~1280px. | Preview-table tools live in the page header instead of the table toolbar. |
| D3 | Dataset | Three status carriers can say related things at the same time: state Badge, mixed-sources Badge and `DatasetPublishBanner`. | No severity model; each carrier was added independently. |
| D4 | Dashboard `dashboards/[id]/page.tsx:4209` | About 15 header controls. `flex-wrap` grows the sticky header to 2–3 rows, which eats canvas height. The pending Save cluster can wrap away from the right edge. | Wrap is used as overflow; there is no priority model. |
| D5 | Agent Flow `BrainBuilder.tsx:600` | Wraps below xl and scrolls horizontally at xl and up, with a sticky right group. The tabs and the validity badge can scroll out of view. | Same as D4. |
| D6 | Data Source `datasources/[id]/page.tsx:126` | Old 3-row header (back link / text-2xl title / meta), then tabs in a card. Hardcoded English, no i18n. | Never migrated to the compact pattern. |
| D7 | Explore `ExploreEditor.tsx:3003` | The view-only strip sits above the header as a full-width row. The header wraps to multiple lines. | Notice is a banner rather than contextual status. |
| D8 | Workboard `workboards/[id]/layout.tsx:236` | **Default owner username and PIN shown in plaintext** in a red strip with no mask, no copy and no acknowledgement. The h-11 row has no wrap. | The one-shot notice reuses a banner instead of a disclosure dialog. |
| D9 | Observability `observability/page.tsx:298` | Minor: the detail row duplicates the dataset pattern. | Same as D1. |

## Design

### Components (new, in `frontend/src/components/common/`)

- **`DetailHeader`**: one row with a 48px target and a 56px maximum on desktop. Typed slots:
  - `back`, `title` (truncates, renamable via render prop), `status` (≤1 primary badge), `tabs`, `primaryActions`, `secondaryActions[]`, `issues`.
  - **Priority overflow.** `secondaryActions` render inline while they fit (measured with ResizeObserver). The rest collapse into an `OverflowMenu`.
  - Back, title, critical status and primary actions are never collapsed.
  - The header never wraps.
- **`OverflowMenu`**: an accessible menu (`role=menu`, arrow-key navigation, Esc, focus return). It replaces the three hand-rolled menus. Disabled items carry a reason tooltip.
- **`IssueSummary`**: takes `Issue[] { id, severity: 'critical'|'warning'|'info', title, detail?, action? }`.
  - **Critical** issues render as a persistent inline strip under the header (role=alert) and are never collapsed.
  - **Warning** and **info** issues collapse into a counter chip (`⚠ 3`) that opens a popover listing all of them, with their actions.
- **`DetailTabs`**: adopts the existing `ui/Tabs` (pill, sm) so tabs are keyboard accessible. On mobile they scroll horizontally with the active tab scrolled into view.

Everything is i18n via `useI18n()`, with a new `common.detailHeader.*` key set in en and vi.

### Severity mapping (no semantic change; same server state)

| Module | Critical (inline strip) | Warning (counter) | Primary actions |
|---|---|---|---|
| Dataset | `sync_failed`; operational with no destination (charts can't run) | changes_pending, firstsync, mixed sources, draft-unpublished | Sync & Publish |
| Dashboard | view-only/page-held lock (with Request edit) | owner's pending edit requests, cross-filter notice | Save draft, Save & Publish, Discard (always visible while pending) |
| Agent Flow | validation blockers | keyless agents, validation warnings | Save, Publish (Test as secondary) |
| Data Source | health = failing | — | Edit |
| Explore | — (view-only becomes a status chip with an explanatory tooltip) | query dirty | Run, Save |
| Workboard | — | — | Publish, Share |
| Observability | open incident with critical severity | other incidents | — |

### Workboard credential disclosure (D8)

Replace the strip with a one-time **modal**:
- Username is shown. The PIN is masked by default, with Reveal and Copy controls.
- The user must explicitly acknowledge ("I've saved this") before the modal closes, and there is a "Change PIN" link.
- The existing one-shot storage consume stays as it is.
- Nothing is rendered in a sticky region, and nothing is logged. A test asserts the PIN never reaches `console`.

### What moves where

- Dataset preview tools (Export, Columns, Rows, Refresh) move to the table preview toolbar. They only apply there anyway.
- Dashboard low-frequency items (Public links, Filter map, Tidy, Compact, Theme, Manage charts, Import HTML) were already in "More"; they move into the shared `OverflowMenu`.
- Undo/Redo, Studio preview and Inspector become priority-collapsible secondaries.
- Data Source "Created by" metadata moves into the Settings/details tab.

## Files and layers, in order

| # | File | Change |
|---|---|---|
| 1 | `components/common/{DetailHeader,OverflowMenu,IssueSummary}.tsx`, `i18n/catalog/common*.ts` | new primitives + en/vi keys |
| 2 | `components/workboards/DefaultOwnerCredentialDialog.tsx`, `workboards/[id]/layout.tsx` | D8 first: security-relevant, smallest |
| 3 | `observability/page.tsx`, `datasources/[id]/page.tsx` (+i18n) | low-risk adopters |
| 4 | `datasets/[id]/page.tsx`, `DatasetPublishBar.tsx`, `OperationalDestinationBanner.tsx` | issues model; preview tools move |
| 5 | `ExploreEditor.tsx` | view-only becomes status |
| 6 | `BrainBuilder.tsx` | header only; props unchanged |
| 7 | `dashboards/[id]/page.tsx` | last and largest; `builderHeaderH` measurement kept |

Every existing `data-testid` is preserved, because the e2e specs depend on them: `dashboard-*`, `design-mode-*`, `inspector-toggle`, `builder-*`, `flow-validity`, `ai-keys-open`. When an action moves into the overflow menu, its menu item keeps the same testid.

## Guardrail scoping

`guardrail_check.py --plan …` returned **warn** with the text form and **unknown** with `--json`. No rule covers a frontend-only header refactor and no protected subsystem is touched. Per AGENTS.md, `unknown` is not `safe`, so this plan relies on the explicit tests below.

## Tests (decided before coding)

- **Unit/component**
  - `OverflowMenu` keyboard and focus behaviour.
  - `DetailHeader` never collapses primary or critical content.
  - `IssueSummary`: critical issues are always inline; the counter equals warning + info.
- **New Playwright spec** `e2e/tests/detail-header.spec.ts`, per module:
  - Viewports: 390, 768, 1024, 1280, 1440 and 1920.
  - Assertions:
    - `scrollWidth <= clientWidth` (no horizontal overflow).
    - Header height ≤ 56px at ≥1024px.
    - Every primary action passes `toBeVisible()` + `elementFromPoint` hit-test.
    - Every secondary action is reachable inline or via the overflow menu.
    - Critical issues are visible.
    - No banner overlaps the canvas or a modal.
- **Roles:** owner, editor and viewer (seed users), with the actions present or absent per gate.
- **Languages:** vi + en snapshot of header text.
- **Business calls:** Save draft, Publish and Sync are asserted by network request (route + method), not by UI.
- **Workboard PIN:** masked by default; reveal and copy work; the dialog can't close before acknowledgement; no PIN in console.
- **Regression:** the existing specs listed in the audit (dashboard-presentation, report-studio, unsaved-theme-nav, final-release-verify, user-feedback, agent-flow-v1-author-golden, agent-flow-ai-keys, data-state).
- **Evidence:** before and after screenshots per module × {390, 1280, 1920} saved to `.artifacts/detail-header/`.
- **Done when:** `verify.py task` passes.

## Delivery

- Feature branch `feat/detail-header-ux` from `origin/demo`, with one PR into `demo`.
- Commits are split per step above.
- No merge until CI is green and a review has been done.
- No `master` change and no deploy.

## Risks

- The dashboard header is about 650 lines inside a 5k-line page. A regression there hits the most-used editor, which is why it goes last and only behind the full existing dashboard specs.
- Priority overflow relies on measurement, and the dashboard already measures its header height. That code is reused; a second ResizeObserver loop is not added.
