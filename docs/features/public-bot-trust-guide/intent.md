# Public AI Bot — trustworthy numbers and a structured publisher guide — intent

**Status:** draft
**Owner:** PO (thanh.dang@base.vn), implementation by Claude Code
**Date:** 2026-10-28

## Problem

A customer demo of the public Dashboard AI Bot (link `/d/[token]`) produced feedback that was
checked against `demo` @ 57a6591b. The checked defects, by what a viewer or author sees:

1. **A number for the wrong period, shown as filtered.** Asked about a shortfall while the report
   shows period T08, the bot answered with all periods summed (224 tỷ instead of ~30 tỷ). When the
   chart the Core reads cannot apply a filter in force (another dataset, or an engine soft-drop),
   `PublishedReportScope.read` still answers (`published_report.py:439-440`, never checked), and the
   evidence lists the filter as applied because it is taken from the link's global filters
   (`published_report.py:433, 469`), not from the filters the chart ran with. The bot UI never
   shows `filters_dropped`.
2. **A percentage that means nothing.** The Core narrative prints "(x%)" as value ÷ sum of rows for
   every measure — averages and rates included — and over a top-N cut (`narrative.py:278-279`); it
   does not know the aggregation (`service.py:282`). A report showing 72.7% can be "explained" with
   a different %.
3. **Invented causes, unverified figures stated as fact, definitions ignored.** Causal claims are
   held back only by a prompt sentence. Unverified figures stay in the sentence with one warning
   line below, under a footer saying the figures were read from the charts. A "how is the KPI
   score computed" question is answered from the charts (or refused) although the publisher's
   prompt holds the formula.
4. **The publisher prompt is free text.** One textarea mixes glossary, formulas, targets, policies
   and tone; the model decides what to do with each line. Targets cannot be compared to an actual
   figure by code, so "đạt/hụt mục tiêu" is LLM arithmetic.
5. **A report silently loses its period slicer.** The builder seeds its slicer list once per mount
   (`page.tsx:1000-1006`) while every refetch refreshes the draft revision
   (`lib/api/dashboards.ts:50-53`); an Apply/add-slicer after any refetch (or after Discard) sends
   the stale list with a fresh revision and passes the 409 check. The revision counter restarts
   after Discard. Publish never warns that a report-wide slicer carrying a default value is gone.
6. **Imported reports' slicer dropdowns are empty on the public link.** Import writes slicers as
   `{field: <raw column>, scope: "all"}` with no `datasetId` (`dashboard_html_import_service.py:4267`);
   `_augment_with_slicer_fields` skips them (`public.py:398-400`); the viewer sees "Không có giá trị
   khả dụng".
7. **Labels do not say where an answer came from** (Core figure vs AI analysis vs a refusal by
   policy vs "not supported yet"), and when the analysis replaces a Core refusal the Core's reason
   disappears.
8. **Theme tokens an author sets lose to the template** in four places (dark+modern CSS overrides
   the accent bar, the legacy `radius` alias, `cardBorderStyle` never emitted, applying a template
   or skin wipes/overrides pinned tokens).

## Goal

A public viewer never receives a figure computed over different filters than the report shows, or
a percentage the data does not support, without being told; a publisher configures the assistant
through a structured guide whose parts are used deterministically where they can be (glossary,
definitions, targets, cause sources, out-of-scope topics); an author cannot lose a report-wide
slicer without being told.

## Out of scope

Deliberately not in this change (each needs its own spec):

- A public query scope through the Governed Query Service (feedback #1). The seams are recorded in
  the spec's appendix; this change only makes the published-chart path honest.
- A "build the model" step at import — shared dimensions, calendar, field aliasing (feedback #7).
- Unifying the builder's and the public link's filter resolution into one implementation
  (feedback #9). This change adds no third copy.
- A dashboard version/history table (feedback #10, the durable-history half).
- Changing the default model or turns/hour (feedback #13): there is no default model since
  1948d3c5, and the real default is 120 turns/hour (`config.py:267`); link 112's 10/hour is its own
  setting. Showing cost per model in the editor is out of scope here.
- The prompt length cap (feedback #12): already removed in #83.

## Constraints

- Protected subsystems: public-link security (`backend/app/api/public.py`, the public bot path) and
  the semantic layer (data_core). Smallest surgical change; nothing a viewer may not see becomes
  reachable; the public FE uses `publicClient` only.
- The guide lives in the link's `appearance_config` (JSON): **no schema migration**. The legacy
  free-text `ai_bot_report_context_note` keeps working and becomes the guide's "Ghi chú khác".
- The guide is never served to viewers (same stripping as the note, `public.py:1939-1945`).
- Every model call stays behind the Model Gateway and the link's budget.
- AI Chat (authed) behaviour must not change except where a shared function is fixed for both
  (the narrative's share rule).
- SQL generation is not touched.

## Acceptance criteria

1. When the chart the Core reads did not apply a filter in force, the viewer gets a refusal that
   names the filter and the chart — never a number. (Option B below changes this to a labelled
   answer.)
2. The evidence of a Core answer lists the filters the chart actually ran with; dropped ones are
   shown as "không áp được".
3. The Core narrative prints a share of total only for SUM/COUNT measures and never over a top-N
   cut; for AVG/COUNT_DISTINCT/ratio measures no "(x%)" appears.
4. A publisher can fill a structured guide (context, glossary, definitions, targets, cause sources,
   policies/facts, answer style, out-of-scope topics, other notes) in the link editor; fields and
   metrics are picked from the link's own catalog; saving and reopening shows the same guide.
5. A definition question ("điểm KPI tính thế nào?") about a term the guide defines is answered
   with the guide's definition, labelled as the publisher's, with no model call.
6. A question about a metric that has a target in the guide gets, beside the Core's figure, a
   deterministic "đạt X% mục tiêu / hụt Y" computed by code from the Core's figure and the target.
7. The analysis states a cause only when it is taken from a configured cause-source chart (its
   rows read through the link's governed path) or the guide; otherwise it says "chưa ghi nhận
   nguyên nhân". A causal sentence without such a source is removed by a deterministic check.
8. A question on an out-of-scope topic listed in the guide is refused with the guide's reason,
   with no model call.
9. Unverified figures are marked inside the sentence; the footer no longer claims every figure was
   read from the charts when some were not.
10. Every answer bubble carries one source label: "Số do hệ thống tính", "Phân tích của AI",
    "Theo hướng dẫn của người xuất bản", "Chưa hỗ trợ câu hỏi này", "Từ chối theo chính sách";
    when an analysis replaces a Core refusal the Core's reason is shown in one line.
11. In the builder, after any refetch, Discard or another author's edit, an Apply / add-slicer /
    remove-filter never removes a slicer it did not remove; a stale write is refused (409); the
    draft revision never repeats.
12. Publishing a draft that removes a report-wide slicer which has a default value requires an
    explicit confirmation naming it.
13. On a public link of an imported report, a raw-field slicer's dropdown lists the field's values
    (scoped exactly as the tiles are), and picking a value filters the tiles as today.
14. An author's explicit accent bar, radius and border survive a template/skin change and render
    the same in builder, public and embed (dark + modern included).
15. Existing suites stay green; the public bot acceptance P0–P13 passes on the real key.

## Decisions (PO, 2026-10-28)

- **Q1 — dropped filter: REFUSE**, naming the filter and the chart (acceptance criterion 1 as written).
- **Q2 — definitions: VERBATIM**, no model call.
- **Q3 — legacy free-text note: KEPT** as "Ghi chú khác", no automatic migration.
- **Delivery:** PRs A → E built in order; pushed, CI-run and merged into `demo` only once all are
  done. Local tests with the real key must not spend more than **5 USD** in total (ledger
  baseline 0.2473 USD at 2026-10-28 09:41 UTC).
