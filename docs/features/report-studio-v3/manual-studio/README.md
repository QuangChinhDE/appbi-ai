# Manual Report Builder: status at the end of this round

**Audience.** Reviewers and the owner deciding whether to accept and deploy the Report Studio stack (#5 → #6 → #7).

**Status.**

- Product commit: `50ff1d8c`, on branch `feat/report-studio-v3`.
- Every executable gate listed below ran at that commit.
- Human acceptance and deployment authorization are still pending. They are the owner's decision.

**Related documents.**

- [`plan.md`](plan.md): the capability audit and the implementation order.
- [`release.md`](release.md): deploy order, migrations and rollback.

## 1. What a report author can do now, without AI

| Step | How |
|---|---|
| Start | Use **New report** (name and "what is it for"). The report opens in the builder on a guided start with three steps: add a header, add charts, group them into sections. |
| Add anything | **Add** opens one palette for every native element: report header, section, chart, insight, filter control, text, note, image, shape, parameter, countdown. It says where the element will go, which is under the selected element and inside its section, with the rows below moving down, or else at the end of the page. The chart picker keeps picks across searches. |
| Report header | By default it states the report's title and description. It computes the period from the data and states the filters in force. Its headline can be a finding from the data. It has three layouts: banner, split and minimal. No figure in it is typed by hand. |
| Sections | Membership is stored (`layout.sectionId`), not guessed. Moving a heading moves its whole section. A heading placed above content that belongs to no section adopts it. The Inspector outline lists what a reader would find broken: an empty section, a member above its heading, or an insight about another section's charts. |
| Inspector | Toolbar, double-click, or the pencil button. **Content** is saved to the draft as you type. **Style** covers emphasis (lead, normal, quiet), frame and surface. **Position and size** covers typed geometry through the same placement rule as dragging, the section, lock and fit to content. **Data** covers the Explore link and cross-highlight. With nothing selected, it shows the report's name, description and structure outline. |
| Several elements | Patterns: **equal row**, **KPI strip**, **lead + supporting**. They never overlap, never move a locked tile, and close the rows the selection leaves behind. A selection that is alone in its rows fills the page width. |
| Insight | A manual "insight" element. The author chooses findings computed from the data; the element never stores numbers. |
| Reading surfaces | The builder, `/d`, `/embed`, Studio preview and PDF share one structure: bands, phone reading order, and a tablet preview identical to the published tablet view. On paper, bands print whole, a lone heading stays with its section, an arranged PDF includes report elements, and the text is in the reader's language. |

**AI Design uses the same native capabilities.**

- It reads stated section membership.
- It stamps membership on what it moves, including under a heading it creates.
- Surface, emphasis and insights are available by hand as well.

## 2. Benchmarks, driven through the UI (`e2e/acceptance/manual-studio.spec.ts`)

**Environment.**

- Production build, served on the host.
- Isolated backend and a temporary Postgres database.
- Run at `50ff1d8c`.

**Evidence.**

- Files are in [`evidence/`](evidence/), with `results.json` listing every assertion.
- All four scenarios are **PASS**.

| | Scenario | Assertions |
|---|---|---|
| M1 | Blank report to finished report. Covers: new report, guided start, header, 5 charts placed under the header, KPI strip, a section that adopts the charts, an insight with two findings, fit to content, lead emphasis, resize, moving the section as a whole, undo, publish. Then the public report at 1440, 820 and 390, and the PDF. | 40 |
| M2 | An existing report's charts become a composed report. Covers: KPI strip, lead + supporting, a split header whose headline is a finding, publish. KPI figures stay between 20 and 60 px. | 13 |
| M3 | Migrated report 574 (copied) is improved. Covers: the outline names its section, a header is added, the section moves as a whole, the filter controls stay intact. Its band on the public page holds only its own section. | 14 |
| M4 | Two independent datasets in one report. Each section holds its own dataset's charts and is arranged as lead + supporting, filling the row. The header states the period both datasets cover. The phone view keeps each dataset under its own heading. PDF. | 16 |

**Timings.** These are measured end to end by the spec, including its fixed settle waits, so they are upper bounds and not latencies.

| Interaction | Time |
|---|---|
| Select | 163 ms |
| Resize | 1.2 s |
| Drag a section | 1.2–1.35 s |
| Pattern commit | ≤ 0.97 s (includes a 0.9 s wait) |
| Fit to content | ≤ 1.05 s |
| Add 5 charts | 4.4 s |
| Save draft | 1.6 s |
| Publish | 0.25–0.78 s |
| Public first render | 2.2–3.6 s |
| PDF (2 pages) | 1.6 s |

The latency gates are in unified-grid S14 (performance), which is PASS.

**Found by the benchmarks, and fixed:**

- `sectionId: null` was dropped by the draft save, so "no section" became "inferred" and the public band covered the KPIs.
- The chart picker lost earlier picks on each new search.
- A heading introduced nothing that was placed before it.
- Double-click on a chart title did nothing.
- The picker said "added at the top" when it wasn't.
- The toolbar drew items over each other once a draft was open. Its wrap fix then hid Manual/AI under the AI panel; the overlays now sit below the measured header.
- Shift-click selected text.
- The new report dialog was in English only.
- The PDF engine printed Vietnamese in English reports.

## 3. Visual review

I opened every screenshot and read every PDF page. The observations below are a reviewer's notes; they are not an acceptance.

**Reads well:**

- The M2 and M4 compositions.
- The phone order: header, KPIs, heading, insight, charts.
- The PDF:
  - the header states the title, description, page and "Exported";
  - the section heading stays with its insight;
  - the footer is in the reader's language.

**Still weak, and not fixed this round:**

- The last x-axis label of "Delivery days by month" is clipped at the right edge ("Oct 1…"). This chart-renderer margin issue predates this round.
- KPI tiles taller than their content leave empty space under the figure.
- The split header's aside states the finding as a sentence without a large figure.
- PDF captures print KPI figures in grey.
- In the M1 layout, the insight fills half a row. That is a choice the benchmark made, not a product default.

## 4. Definition of Done

| Area | State | Basis |
|---|---|---|
| Gate A: trust and data safety | TECHNICALLY VERIFIED | Semantic-guard review of the public surface: no authed call, no data outside the link's scope. It found two presentation defects (link-title precedence, parameter switcher), which are now fixed. The public-bundle check passes. |
| A7: stack migration round trip | RUNTIME VERIFIED on a copy of the rig database | Down to `20260914_0002` and back up: counts restored, no new overlap. Constraints are documented in `release.md` §4. |
| Gate B: manual builder (B1–B14) | RUNTIME VERIFIED | M1–M4 driven through the UI, plus unified-grid S1–S14, L, F, U and R1–R7. |
| Gate C: preview, responsive, parity, PDF, localization | RUNTIME VERIFIED | 1440/820/390 in M1–M4 and readiness R8/R9. PDF in M1, M4 and R10. EN strings asserted by contract. Accessibility (roles, labels, keyboard in the palette and Inspector) is CODE COMPLETE; no audit tool was run. |
| Gate D: AI uses native capabilities | TECHNICALLY VERIFIED | Contract checks on membership stamping and the temporary-id swap. The AI suites (V3 S1–S8, smoke B, readiness R11, unified-grid S7–S9) pass with the real model. |
| Gate E: integrated pass on the production build | RUNTIME VERIFIED | See §5. |
| BigQuery-backed gates | **BLOCKED** | No warehouse credentials on this rig. No result is claimed. |
| Human product acceptance | **HUMAN ACCEPTANCE PENDING** | The owner's decision. |
| Deployment | not done | Needs authorization; follow `release.md`. |

## 5. Verification at `50ff1d8c`

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS |
| `npm run qa` (includes `check-report-structure-contract.mjs`, 23 checks) | PASS |
| Backend `test_report_content_widgets.py` (14) | PASS. Wired into CI; `verify.py` confirms it runs. |
| `python scripts/ci/verify.py task` | PASS: nothing failed, nothing unverified |
| Guardrail diff | OK. The new acceptance spec and contract are an "unknown layer" (tests). |
| Acceptance: manual-studio M1–M4 | 4/4 PASS |
| Acceptance: readiness R3–R11 | 9/9 PASS |
| Acceptance: completion smoke A–C | 3/3 PASS |
| Acceptance: unified grid | 24/24 scenarios PASS |
| Acceptance: Report Studio V3 S1–S8 | 8/8 PASS |
| CI e2e | 72 passed, 5 skipped. The skips are Agent Flow runtime tests that need a flow-bound link this rig doesn't have: NOT VERIFIED here, unrelated to this area. |

**Declared changes to tests, gates and CI in this round:**

- **New:** `frontend/scripts/check-report-structure-contract.mjs`, added to `npm run qa`.
- **New:** `backend/tests/test_report_content_widgets.py`, allow-listed in `.gitignore` and added to `backend-contract-tests.yml`.
- **New:** `e2e/acceptance/manual-studio.spec.ts`. It is not in CI and is run explicitly.
- **Changed:** in `check-theme-presets.mjs`, the widget-key contract for `hero_strip` now reads the renderer from `ReportHeaderWidget.tsx`, with the same assertion.
- No existing assertion was removed or weakened.
