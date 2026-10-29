# Public AI Bot — trustworthy numbers and a structured publisher guide — spec

## Behaviour

### A. A turn on a public link (order of decisions)

1. **Out of scope** — the question matches a topic in `guide.out_of_scope` (folded-text match of
   the topic's words): refused, code `guide_out_of_scope`, the topic's reason (or a default
   sentence). No model call, nothing read.
2. **Definition** — the question asks what a term means / how it is computed ("là gì", "tính thế
   nào", "cách tính", "công thức", "định nghĩa", "nghĩa là", "how is … calculated", "what is")
   AND names a term of `guide.definitions` (its name or one of its aliases, folded): answered,
   code `guide_definition`, `data.definition = {name, formula, note}`. No model call.
   A question that names a definition term but does not ask for its meaning goes on to the Core.
3. **The Core** (unchanged flow: shortlist → planner → read → narrative), with:
   - the guide's glossary added to the catalog: each `glossary[]` entry adds its `term` as a
     synonym of the field `ref` it maps to (on every catalog entry showing that ref), and its
     words take part in chart ranking at full weight (not the half weight of free notes);
   - **a dropped filter refuses**: `PublishedReportScope.read` raises
     `filter_not_applied` ("Biểu đồ «X» không lọc được theo «Kỳ = T08» …") when the chart's read
     reports `filters_not_applied`. (Q1 option B: answer, with `evidence.filters_dropped` shown
     prominently and the headline prefixed "Không lọc theo …".)
   - **evidence tells the truth**: `filters_applied` = the filters this chart's read applied
     (`data.filters_applied` of the chart read); `filters_dropped` = what it could not apply.
   - **shares only where they add up**: `narrative.describe` receives each measure's aggregation;
     "(x%)" of total and the over-time sums across groups are computed only for `sum` / `count`
     and never when the plan has a `limit` (top N); otherwise the bullet shows the value only.
4. **Target** — the Core answered, and its plan's measure has a `guide.targets[]` entry whose
   period matches (no period on the target, or the target's period equals the value of the plan's
   period filter / the single period the answer covers): `data.target = {measure, period, target,
   actual, gap, attainment_pct, unit}` computed by code from the Core's single total. Shown under
   the Core figure. Only when the answer is ONE total (one row, no dimension, or a total row); a
   breakdown is not compared (no target per group in this version).
5. **Analysis** (unchanged triggers: could-not-plan refusal on a link without add-on; evaluation
   question beside an answer) with the guide given as structured input:
   `{context, glossary, definitions, targets, facts, style, cause_sources}`;
   - **causes**: the analysis reads the `cause_sources` charts (link's governed path, like every
     other chart) and may state a cause only from their rows or from `facts`; a deterministic
     post-check removes any sentence carrying a causal marker ("do", "vì", "bởi", "nguyên nhân",
     "dẫn đến", "because", "due to", "driven by") whose content words are not found in those rows
     or in `facts`/`context`, and appends "Chưa ghi nhận nguyên nhân trong dữ liệu báo cáo." once;
   - **unverified figures** are wrapped in the text as `⟦figure⟧` and rendered with a warning style
     and tooltip; the footer says "Số liệu đọc từ các biểu đồ này" only when no figure is unverified.
6. **Labels** (UI): every exchange shows one source chip — Core answer: "Số do hệ thống tính";
   analysis: "Phân tích của AI"; definition / out-of-scope: "Theo hướng dẫn của người xuất bản";
   a refusal whose code is `unsupported`/`time_range_unsupported`/`grain_not_shown`/`not_additive`/
   `filter_not_applied`/`outside_published_scope`: "Chưa hỗ trợ câu hỏi này"; budget/model/link/
   policy codes: "Từ chối theo chính sách". When an analysis replaced a Core refusal, the Core's
   reason (`data.message`, scrubbed) is shown in one muted line above the analysis.

### B. The publisher guide (link editor → tab AI Bot)

Sections, each optional; a guide with every section empty behaves exactly like no guide.

| Section | Shape | Used by |
|---|---|---|
| Bối cảnh | `context: {purpose, audience, currency_or_unit, default_period_note}` (≤ 500 chars each) | analysis prompt |
| Thuật ngữ | `glossary: [{term, ref}]` — `ref` picked from the link catalog | catalog synonyms + ranking + planner |
| Định nghĩa & công thức | `definitions: [{name, aliases[], formula, note}]` | deterministic definition answer; analysis |
| Mục tiêu / kế hoạch | `targets: [{ref, period?, value, unit?, label?}]` — `ref` a measure of the catalog; `period` free text equal to the report's period value (e.g. "T08", "2026-08") | deterministic target block; analysis |
| Nguồn nguyên nhân | `cause_sources: [{chart_id, note?}]` — charts of the link (e.g. "Hành động khắc phục") | analysis causes + post-check |
| Chính sách / kiến thức | `facts: [{title, content}]` | analysis knowledge |
| Cách trả lời | `style: {length: short|normal|detailed, tone: executive|operational|neutral, language: auto|vi|en}` | analysis prompt |
| Ngoài phạm vi | `out_of_scope: [{topic, reason?}]` | deterministic refusal |
| Ghi chú khác | the existing `ai_bot_report_context_note` (free text) | as today |

No length cap on any section (owner decision 2026-10-28); the editor shows the size of the guide
and a note that it is sent with each analysis question.

The editor offers **"Gợi ý từ báo cáo"**: pre-fills the glossary with the catalog's fields (label →
ref) for the author to edit — no model call.

## Data

**No schema change.** `dashboard_public_links.appearance_config` (JSON) gains `ai_bot_guide`
(object above, version key `v: 1`). Existing rows: absent → no guide. The legacy
`ai_bot_report_context_note` is unchanged. Server-side validation on save (pydantic model
`PublisherGuide`): types, `ref`s must belong to the link's catalog at save time (unknown refs are
rejected 422 with the offending entries), `chart_id`s must be published charts of the dashboard.

Dashboard draft revision (`shared_draft.rev`, builder): becomes `<last_published_at>#<n>` with `n`
taken from a counter that is NOT reset by Discard (stored in the draft meta's `rev_counter`, kept
across discard). No column change.

## API

| Method | Path | Auth / permission | Request | Response |
|---|---|---|---|---|
| GET | `/dashboards/{id}/public-links/{link_id}/ai/catalog` | `require_publish_access(.., "dashboards")` | — | `{charts: [{chart_id, name, pages}], fields: [{ref, label, kind: dimension|measure, aggregation?, charts: [chart_id]}]}` — exactly the catalog the bot builds for this link (`PublishedReportScope` over `link_tool_context`) |
| PATCH | `/dashboards/{id}/public-links/{link_id}` (existing) | unchanged | `appearance_config.ai_bot_guide` | 422 `{detail, invalid: [...]}` when a ref/chart is not in the link's catalog |
| PUT | `/dashboards/{id}/draft-filters` (existing) | unchanged | unchanged | rev never repeats |
| POST | `/dashboards/{id}/publish` (existing) | unchanged | `confirm_removed_slicers?: [slicer_id]` | 409 `slicer_removal_unconfirmed {removed: [{id, label, value}]}` when the draft drops a scope=all slicer with a non-empty default value that is not confirmed |
| GET | `/public/dashboards/{token}` (existing) | public | — | `ai_bot_guide` stripped like the note; `available_filter_fields` gains raw-field slicers resolved to `{key: <raw field>, semanticField: view.field, datasetId}` |
| GET | `/public/dashboards/{token}/filters/distinct-values` (existing) | public | accepts the resolved raw-field key | values scoped as the tiles' |

Public AI turn (`/public/dashboards/{token}/ai/answer`): new envelope codes `guide_definition`,
`guide_out_of_scope`, `filter_not_applied`; `data.definition`, `data.target`, `evidence.filters_dropped`.

## UI

- **Link editor (AI Bot tab)**: the free-text box becomes the "Ghi chú khác" section of a sectioned
  form; each list section has add/remove rows; ref/chart pickers read the new catalog endpoint
  (loading → "Đang tải danh sách trường…", error → message + retry, empty catalog → "Báo cáo chưa
  có biểu đồ công khai"). Save validation errors highlight the offending rows. Size indicator.
- **Public bot (`DashboardAiBot.tsx`)**: source chip per exchange; definition bubble; target block
  under a Core figure; unverified figures inline; `filters_dropped` line in evidence; the Core's
  reason line above an analysis. Public surface: `publicClient` only, nothing new fetched.
- **Builder**: re-seed slicers on server revision change / discard / publish; publish confirmation
  dialog listing removed report-wide slicers with their default values.
- **Theme**: no visible change except that explicit tokens now win in the four cases.

## Permissions

Guide and catalog: dashboard publish access (as every public-link editor endpoint). Viewers never
receive the guide; the bot's answers may quote definitions, facts and targets (the editor says so).

## Edge cases

- Guide `ref` later removed from the report → on use, entries whose ref is not in the turn's
  catalog are ignored (logged), never an error to the viewer; the editor flags them on next open.
- A definition term that is also a field name → only meaning-questions route to the definition.
- Target with a period the answer does not cover → no target block (never compared across periods).
- Several targets for one measure (per period) → the one matching the answer's period; none → no block.
- Core answer is a breakdown → no target block.
- Out-of-scope topic words that appear inside a legitimate data question ("doanh thu đối thủ" when
  "đối thủ" is out of scope) → refused; the publisher owns that list (the editor explains it).
- Causal post-check on English answers uses the English markers; a sentence with numbers only and
  no cause marker is never touched.
- Raw-field slicer whose field exists in several views → the dropdown unions values from every view
  that a published chart of the page reads (as the tiles filter each such chart).
- Builder: two authors — the second Apply after the first's publish is refused 409 and the editor
  reloads the list (no silent overwrite either way).

## Non-goals

GQS for public viewers; per-group targets; automatic extraction of a guide from free text by a
model; versions/history of dashboards; a single filter-policy implementation; import model building.

## Appendix — recorded for the GQS follow-up (not built here)

Seams found: a new `DataScope` (scope.py:25-43) for links; principal with a link kind
(principal.py:30-33, 63-74, 107-134); catalog allow-list (catalog.py:141-171); allow-side field
check in GQS (service.py:179-187); server-owned mandatory filters fed from
`_build_public_chart_filters` (GQS strips server keys today, service.py:350-384); Sheets/manual
sources unsupported by GQS (service.py:48,170-176); per-user ledger/budgets (ledger.py:116-126);
freshness/TTL parity (context.py:912-918); value lookups under the allow-list.
