# Manual Report Studio: plan

Scope is the "Manual first, AI second" round of V3 (PR #7). This file records the source audit this round
started from, and the implementation order. As-built results go in `README.md` next to it.

## Capability audit at `c4252bda`

Columns follow the brief's eight levels:

| Column | Level |
|---|---|
| model | 1. data model |
| manual | 2. exposed in the Manual Builder |
| render | 3. rendered |
| save | 4. survives Save/Reload |
| public | 5. Public/Embed |
| resp | 6. responsive |
| pdf | 7. PDF |
| AI | 8. AI |

| Capability | model | manual | render | save | public | resp | pdf | AI | Finding |
|---|---|---|---|---|---|---|---|---|---|
| Report title / description in the canvas | — | toolbar only | — | ✓ | masthead title; **description never rendered** | — | title only | — | no report opening inside the report |
| Hero (`hero_strip`) | ✓ | buried in ⋯ → Add widget | gradient box | **title edits invisible after the 1st save** (headline wins) | ✓ | ✓ | ✓ | preserved only | its "metric" is typed text, so a fabricated number can be published |
| Section header | ✓ | buried | ✓ | ✓ | ✓ | stays with content only by coincidence | keep-with-next | ✓ | **membership inferred from y**; there is no way to end a section |
| Callout | ✓ | buried | ✓ | **tone always saved as accent** (FE good/warn/bad ≠ BE info/success/…) | ✓ | ✓ | ✓ | — | |
| Narrative (live findings) | ✓ | **no** | ✓ | ✓ | ✓ | ✓ | ✓ | AI only | editor modal is empty |
| Text | ✓ | buried | ✓ | ✓ | `{{param}}` empty on public (**params not passed**) | ✓ | ✓ | — | inline default font size bypasses the type scale |
| Parameter switcher | ✓ | buried | ✓ | ✓ | **does nothing on public** | ✓ | ✓ | — | double frame in the builder |
| Image | ✓ | buried | ✓ | ✓ | ✓ | ✓ | ✓ | — | `link` rendered but not editable |
| KPI hierarchy (primary / supporting) | AI emphasis only | **no** | one size | — | — | — | — | sizing only | KpiCard ignores the kpiValue token |
| Typography levels | tokens exist | typoBase is hidden under Advanced | report title / narrative / caption **not consumed** | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Frame (card / subtle / flush) | ✓ | charts only | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Selection editing | — | modal per type | — | — | — | — | — | — | no persistent property panel |
| Layout patterns (row, primary + rail, KPI strip) | AI compiler | **no** | — | — | — | — | — | ✓ | the manual only has align/match/distribute |
| Insert position | — | always at the page end | — | — | — | — | — | — | "insert here" is not possible |
| Studio preview tablet / phone | — | — | builder route | — | differs from public | — | — | — | preview ≠ published at 820/390 |
| PDF custom layout | — | — | — | — | — | — | **drops every widget** | — | |

## Order (gates of the brief)

- **A. Trust and lifecycle.** The previous round closed A1–A6 (see `../readiness/README.md`). Remaining here: A7,
  the rollout and rollback of the whole stacked chain, with the migrations' downgrade/upgrade actually executed on a
  database copy.
- **B. Manual Builder (primary).** Work in this order:
  1. Fix the broken basics above: callout tone, hero title, public params, the switcher frame, image link, text size
     from the type scale.
  2. Structure: explicit section membership (`layout.sectionId`) with geometric inference for legacy reports.
     Includes a group move of a section, structure issues (empty section, orphan heading, a member above its heading,
     detached narrative), and consumers: bands, responsive order, PDF.
  3. Insert: one "Add" palette in the toolbar with every element, localized defaults, and insertion below the
     selection (the content below moves down). A guided start for a blank report.
  4. Report header: the hero becomes a real opening. Title and description from the report, the period and active
     context computed live, an optional live headline finding, a few variants. No typed figures.
  5. Inspector panel: the selected element's content, style, layout, structure and data in one place. With nothing
     selected, the report's own properties and structure outline.
  6. Typography and hierarchy: the tokens are consumed (report title, section, narrative, caption, meta). Tile
     emphasis gives KPI and chart hierarchy. The type scale is in plain view.
  7. Content-aware sizing: "fit to content", automatic after a content edit, never moving unrelated tiles.
  8. Layout patterns on a selection (equal row, primary + supporting, KPI strip), native and shared with AI.
  9. Manual "Insight from data" (narrative with a finding picker).
- **C. Parity.** Studio preview uses the published derivations. Builder narrow projection = public. PDF keeps
  sections, header and description; custom layout keeps widgets.
- **D. AI on top.** The compiler emits section membership; model chapters/headings become sections; narrative and
  chartSurface are editable manually.
- **E. Verification.** Focused tests per subsystem, then one final integrated Playwright pass on the final code.
