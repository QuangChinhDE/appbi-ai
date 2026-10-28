# Public AI Bot — trustworthy numbers and a structured publisher guide — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --plan "public AI bot trust: refuse dropped filters, additive-only shares, structured publisher guide, builder slicer durability, public raw-field slicers, theme token precedence" --files <the files below>
```

- **Verdict:** `warn`.
- **Protected subsystem touched:** `public_link_security` (`backend/app/api/public.py`).
  Locked and hidden filters stay enforced, the public frontend uses `publicClient` only, and the result must be checked while logged out.
- **Matched features:**
  - `distinct_value_cascade` and `filter_pane_slicers`. The guardrail flagged that their owner files (`use-public-filter-distinct-values.ts`, `DashboardFilterBar.tsx`) were missing from the list. They are added to PR-C below.
  - `auth_permissions`, a keyword match on "token". This is noise: no auth code changes.
- **`unknown` coverage:**
  - `answer_core/*` and `data_core/narrative.py` are owned by no rule. Their tests are named here, not discovered.
  - Recorded as a gap: answer_core has no feature rule in `guardrail_rules.yaml`.
- **Recommended tests:** `ai_runtime_gateway`, `analyst_*`, `answer_core_published_scope`, `public_answer_core`, `chat_extension*`, `distinct_*`, `public_filter_authority`, `public_authoritative_bounds*`, `pair4_surfaces`, `tsc`.

## Delivery: five PRs into `demo`, in this order

Each PR is self-contained and green on its own.

| PR | Scope | Acceptance criteria |
|---|---|---|
| A | Core honesty: dropped filter refusal, truthful evidence, additive-only shares, source labels | 1, 2, 3, 10 |
| B | Builder slicer durability: re-seed, monotonic rev, publish confirmation | 11, 12 |
| C | Public raw-field slicers for imported reports | 13 |
| D | Structured publisher guide: schema, catalog endpoint, editor, definition, target, causes, out of scope, unverified inline | 4–9 |
| E | Theme token precedence (4 fixes) | 14 |

### PR-A, files in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/services/answer_core/published_report.py` | service | `read`: refuse `filter_not_applied` when the chart read reports `filters_not_applied`. Evidence `filters_shown` comes from the chart's `data["filters_applied"]`. `measures` aggregation is exposed to the service. |
| 2 | `backend/app/services/data_core/narrative.py` | service | `describe(..., aggregations=None)`. Shares and cross-group sums only for sum/count, and never with `top`/limit. Called with no aggregations (AI Chat), it keeps today's behaviour for sum-like measures only: unknown aggregation means no share. |
| 3 | `backend/app/services/data_core/service.py` | service | Pass each plan measure's aggregation (catalog `CatalogField.type` for measures) to `describe`. |
| 4 | `frontend/src/components/dashboards/DashboardAiBot.tsx`, `frontend/src/i18n/catalog/dashboards-aibot.ts`, `frontend/src/lib/api/public.ts` | FE public | Source chip. `filters_dropped` line. Core reason line above an analysis. |

### PR-B, files in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/api/dashboards.py` (shared-draft rev helpers ~1730-1782, publish ~3073-3260) | API | `rev_counter` survives discard. Publish computes removed scope=all slicers that have a default and needs `confirm_removed_slicers`, else 409 `slicer_removal_unconfirmed`. |
| 2 | `backend/app/schemas/schemas.py` | schema | Publish request body gets `confirm_removed_slicers: list[str] = []`. |
| 3 | `frontend/src/lib/api/dashboards.ts` | FE api | Rev is recorded per editor session at seed time (`seedSharedDraft`), not overwritten by every GET. The publish call carries confirmations and surfaces the 409 payload. |
| 4 | `frontend/src/app/(main)/dashboards/[id]/page.tsx` | FE builder | Re-seed slicers, filters and rev when the server `shared_draft.rev` differs from the seeded one (with no unapplied local edits), and after discard and publish. A publish confirmation dialog lists the removed slicers. |

### PR-C, files in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/api/public.py` (`_augment_with_slicer_fields` ~395, `_sanitize_public_viewer_filters` ~573, distinct-values ~3709, `_pages_offering_field` ~3746) | API public | A raw-field slicer (no `datasetId`, no dotted ref) is resolved through the dashboard's published charts' semantic bindings to `view.field` refs carrying a dimension of that name. It is emitted with `key` = the raw field, `semanticField`, `datasetId` and `linkedFields` for the other views. Distinct values accept that key and union the views. `slicers_config` is never rewritten. |
| 2 | `frontend/src/hooks/use-public-filter-distinct-values.ts`, `frontend/src/components/dashboards/DashboardFilterBar.tsx` | FE public | Match the column by raw `key` (the `getFilterKey` of the control) as well as `semanticField`. |

### PR-D, files in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/services/answer_core/publisher_guide.py` (new) | service | `PublisherGuide` pydantic model (v1) plus pure functions: `out_of_scope(q)`, `definition(q)`, `target_for(plan, answer)`, `glossary_synonyms()`, `causal_check(text, sources_rows, guide)`, `mark_unverified(text, figures)`. |
| 2 | `backend/app/services/answer_core/published_report.py` | service | The catalog takes glossary synonyms. Ranking gets glossary terms at full weight. `catalog_payload()` serves the editor. |
| 3 | `backend/app/services/answer_core/public_turn.py` | service | Order: out of scope → definition → Core → target → analysis (cause sources read, causal check, unverified marking). |
| 4 | `backend/app/services/answer_core/guided_analysis.py` | service | Structured guide input. Cause-source charts are always read when configured. The SYSTEM prompt changes for structure, causes and definitions. |
| 5 | `backend/app/services/chat/envelope.py` | service | `with_definition`, `with_target`, codes. |
| 6 | `backend/app/api/dashboards.py` | API | `GET …/public-links/{link_id}/ai/catalog`. PATCH validates `ai_bot_guide` against the catalog (422 with the invalid entries). |
| 7 | `backend/app/api/public.py` | API public | Strip `ai_bot_guide` with the note (`~1945`). |
| 8 | `frontend/src/components/common/PublicLinkAiBotEditor.tsx` (+ a `PublisherGuideEditor.tsx` sub-component), `frontend/src/lib/api/dashboards.ts`, `frontend/src/types/api.ts` | FE authed | Sectioned editor, pickers, suggest glossary, size indicator, 422 highlighting. |
| 9 | `frontend/src/components/dashboards/DashboardAiBot.tsx`, `frontend/src/i18n/catalog/dashboards-aibot.ts`, `frontend/src/lib/api/public.ts` | FE public | Definition bubble, target block, inline unverified figures, conditional footer. |

### PR-E, files in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `frontend/src/app/globals.css` (~887-895) | FE | The dark+modern top stripe applies only when no `data-dashboard-accentbar` is set. |
| 2 | `frontend/src/components/dashboards/DashboardThemeProvider.tsx` (~106-115, 331-350) | FE | Normalise `radius` to `cardRadius` before expanding the template. Emit `tokens.border` as `data-dashboard-cardborder` plus a CSS variable. |
| 3 | `frontend/src/components/dashboards/DashboardThemeModal.tsx` (~440-460, 491-493) | FE | Applying a template or skin keeps the keys the author pinned. The radius nudge happens only when `cardRadius` is unset. |
| 4 | `frontend/src/lib/tile-frame.ts` (~99-100) | FE | Inline `borderColor` only when the author set it. |

No row crosses an architecture boundary: models import no services, the public frontend stays on `publicClient`, and each fix sits in the layer that produces the defect.

## Risks

| Risk | How it would show | What catches it |
|---|---|---|
| `filter_not_applied` refuses questions that used to get a (wrong) number. Flat imported reports, where a slicer matches only some tables, would refuse more often. | More refusals on dashboards like 91/89. | Acceptance P0–P13 (QA links have a single dataset). A manual run on dashboard 129 (single dataset). Q1 option B is the fallback. |
| The narrative share change alters AI Chat answers for avg/ratio measures. | A share bullet disappears; numbers stay. | `test_analyst_narrative`, `analyst_*`. AI Chat acceptance is not run locally and is recorded as such. |
| Builder re-seed loses an author's unapplied local edit. | A typed-but-unapplied slicer reverts. | Re-seed only when there are no unapplied local edits; otherwise show the 409 banner. E2E builder spec. |
| The publish 409 breaks MCP and other API publishers. | The MCP publish tool fails. | The confirmation is required only when a scope=all slicer **with a default value** is removed. MCP passes the confirmation on explicit removal. Test the MCP tool. |
| Raw-field slicer resolution widens what a viewer can filter. | A dropdown lists values of a field the link does not show. | Only fields that are already slicer controls of the dashboard, values scoped by the same layered filters and page scope as the tiles. `test_public_filter_authority`, `public_authoritative_bounds*`. Logged-out check. |
| The guide leaks to viewers. | `ai_bot_guide` appears in the public JSON. | A new test asserts it is stripped, plus a live check of the public response. |
| The causal post-check removes legitimate sentences. | Analysis text is shortened. | Unit tests with real answers from today's demos. Only sentences carrying a causal marker are touched. |
| Theme changes alter existing dashboards. | A dashboard that relied on the template override looks different. | Only explicitly set tokens change behaviour. `check-theme-presets.mjs`, `check-app-theme-contract.mjs`, and a visual check of one dark modern dashboard. |

## Tests, decided now

| Test | New or existing | What it locks |
|---|---|---|
| `test_answer_core_published_scope.py::test_a_chart_that_cannot_apply_a_filter_in_force_refuses` | existing file, new test | AC1 |
| `…::test_the_evidence_lists_the_filters_the_chart_ran_with` | existing file, new test | AC2 |
| `test_analyst_narrative.py::test_no_share_of_total_for_an_average_or_a_top_n` | existing file, new test | AC3 |
| `test_answer_core_published_scope.py::test_guide_*` (definition, out of scope, target, glossary synonym, causal check, unverified marking, stripped from viewers) | existing file, new tests | AC4–9 |
| `test_public_answer_core.py::test_the_turn_order_guide_before_core` | existing file, new test | AC5, AC8 order |
| `test_dashboard_draft_removal_lifecycle.py::test_rev_never_repeats_after_discard`, `…::test_publish_refuses_a_removed_default_slicer_unconfirmed` | existing file, new tests | AC11, AC12 |
| `test_public_filter_authority.py::test_a_raw_field_slicer_lists_values_scoped_as_tiles` | existing file, new test | AC13 |
| `e2e/tests/…/builder-slicer-durability.spec.ts` | new E2E | AC11 (save, refetch, apply, reload) |
| `frontend/scripts/check-theme-presets.mjs` (extend) | existing gate, extended | AC14. Declared: this improves a gate and weakens none. |

- **Existing suites that must still pass:** the guardrail list above, plus `test_chat_extension`, `test_unified_chat_architecture`, `check-answer-parity`, `check-reader-rating`, `check-filter-scope-contract`.
- **No new backend test file is planned**, so there are no allow-list or workflow edits. If one becomes necessary it goes through `.gitignore`, `backend-contract-tests.yml` and `git add -f`.
- **E2E:** the builder spec (save-then-reload flow) and the existing public bot acceptance P0–P13 run locally with the real key.

## Verification

Each PR is checked on the `appbi-ai` stack: production mode, real key, Postgres CIDR as approved.

- **A:**
  - On dashboard 129, set the year slicer to a value and ask a question whose shortlisted chart is on a slicer of another dataset (if no such pair exists in 129, use the QA fixture). Expect a refusal naming the filter.
  - A ranking of an average metric shows no "(x%)".
- **B:** two browser contexts on one dashboard. Author 1 applies; author 2 (stale) applies, gets the 409, the list reloads and no slicer is lost. Publishing after deleting the period slicer asks for confirmation.
- **C:** a local import of an HTML report with raw slicers. The public link dropdowns list values, and a pick filters the tiles. Checked logged out.
- **D:** in visible Chrome (as today), fill each guide section through the UI, save, reopen, then ask a definition, a target, a cause, an out-of-scope question and an extraction attempt. Check that the public JSON carries no guide.
- **E:** one dark modern dashboard with an explicit accent bar and radius, compared in builder, public and embed.

`verify.py task`, preflight and CI must be green. PRs merge into `demo` only, after CI is green (PO-authorised).

## Rollback

Each PR reverts independently: no migration and no destructive change.

- The guide is a JSON key. Reverting PR-D leaves it unused in `appearance_config`, which is harmless.
- PR-B's `rev_counter` lives in draft meta and is ignored after a revert.
