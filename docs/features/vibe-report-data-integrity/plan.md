# Vibe Report data integrity — implementation plan

## Guardrail scoping

`guardrail_check.py --plan "Vibe report data integrity" --files type_override_service.py
api/report_artifacts.py report_code/runtime.js …`

- Verdict: **unknown** (no feature keyword) — treated as needing extra care, not safe.
- Protected: `semantic_layer` via `type_override_service.py` → surgical change, golden
  gates (`chart_config_write_validation*`, `chart_final_hardening`, …) required.
- `report_artifacts.py` / public report data → public-link security reviewed by tests.

## Order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | services/type_override_service.py | semantic | S1 DuckDB integer regex guard |
| 2 | tests/test_type_override_duckdb_integer.py | test | decimals never round; probe prefers float |
| 3 | api/report_artifacts.py | api | S2 binding access on export/duplicate/publish/links |
| 4 | services/report_code/bindings.py | service | S3 `default: latest` resolution in one place |
| 5 | services/report_code/runtime.js | runtime | S3 filter-text, S4 repeat/cell/bar/tone, S6 sample marker |
| 6 | services/report_code/importer.py | service | S5 list slots, S6 sample wrap |
| 7 | services/report_code/lifecycle.py | service | S6 publish guard |
| 8 | frontend PasteCodeWizard / ReportStudio | FE | list-slot mapping, publish refusal UI |
| 9 | tests (contract + HTTP PG) | test | importer, repeat, filter propagation, negative rights |
| 10 | e2e headed acceptance | e2e | benchmark copy of #33 |

## Data repair

Existing local tables typed `integer` over decimals: re-run type inference
(`column_type_inference_service`) through the product API after S1; benchmark
dataset 221 is re-inferred and re-reconciled against the source file.

## Risks

- S1 turns rounded-wrong values into NULL on tables already mis-typed until re-inferred;
  intentional (a visible gap beats a wrong number) and named in the report.
- S2 makes a shared editor without data rights unable to publish; that is the point.

## Phase 2 — finalize (architecture decisions D1–D5, approved 2026-11-04)

BI Core decides WHAT, the report decides HOW. No second engine; Freeform HTML/JS is kept.

| # | Change | Where | Locked by |
|---|---|---|---|
| P0-A | a link token is listed only to whom could create the link (full on the report AND read rights on every bound chart/dataset); the link AI catalog likewise | api/report_artifacts.py | HTTP PG `test_a_links_token_is_never_listed_to_full_access_without_data_rights` |
| P0-B | a public link's lock/hidden constraint carries the engine's `AUTHORITATIVE_KEY` (the marker Manual locks carry): applied or the binding is `refused`; a reported drop of a lock refuses too (cache hits); value lists and the default period run under the locks; the AI Bot's filters carry the marker | bindings.py, public_reports.py, public_bot.py, public_links.py | HTTP PG `…cannot_apply…`, `…dropped_on_any_path…`, `…value_list…`; real engine + real bot (local acceptance) |
| P0-C | `notApplied` never names a filter the reader may not know | bindings.py | HTTP PG |
| P1-1 | the runtime never adds rows up or picks "the" value of a many-row result (needs a KPI binding or a row address); a period change is labelled a report calculation and skipped for an incomplete period; no donut centre total; the audit no longer accepts JS-added totals | runtime.js, generation.py prompt | e2e `report-runtime-contract.spec.ts` |
| P1-2 | percent = the semantic model's format (ratio x100, the platform convention); a "%" only the design writes is a sign; no label guess, no value-size heuristic | bindings.field_meta, runtime fmt | contract + e2e runtime contract (160% vs 1,6%) |
| P1-3 | Top-N (`topN`) and cut results are told on lists and charts | bindings.mint_dto, runtime | contract + e2e runtime contract |
| UI | one selection + bulk delete for Manual and Vibe, keyed by row key, only deletable rows, named confirm | dashboards page, ReportList | e2e `report-list-bulk.spec.ts` |
| Perf | host DTO + value-list cache per frame owner (60 s, in-flight dedupe; dropped on a new fetcher/bindings/filters); 8 concurrent like Manual; `resolve_state` single-flight memo (30 s, key = filters + state + locks) | ReportFrame.tsx, bindings.py | before/after benchmark (local) |

Not in this phase: official MoM/YoY in the BI Core (no time-intelligence capability exists;
the runtime's change stays a labelled report calculation), Native Chart Slot, multi-dataset.

## Phase 3 — close remaining gaps (2026-11-04)

| Change | Where | Locked by |
|---|---|---|
| live preview re-posts on EVERY source byte (the key read length + first 64 HTML chars, so a same-length CSS/JS edit never re-rendered) | protocol.previewKey, ReportFrame | `npm run qa:report-code` (fails on the old key) |
| a link's locks are probed against every binding on create / change / switch-on; refused blocks are returned (`lock_warnings`) and shown in the shared Public Links manager; serving stays fail-closed | report_artifacts `_lock_warnings`, PublicLinksManager | HTTP PG `test_creating_a_link_whose_lock_a_binding_cannot_apply_says_so` |
| studio data cache scoped to the saved draft revision (a binding re-added under a freed id may read another chart) | ReportStudio fetchers | e2e journeys |
| shared result cache stored rows with `default=str`: a datetime came back "2024-01-01 00:00:00" vs the API's ISO "…T00:00:00", a Decimal as a string - a Manual tile differed between a cache hit and a miss (public-closure date drill) | query_cache `_payload_json_dumps` (FastAPI encoder for payloads; keys unchanged) | contract `test_a_cached_result_keeps_the_response_encoding…`, e2e public-closure-interactions |
| /dashboards Chart / Source / Dataset filters relate a Vibe Report through its bound charts (`chart_ids`), with the same matcher as dashboards | lifecycle summary, dashboards page | e2e list journeys |
| studio filter semantics (month period + newest default, one value + default) set in the Data panel | StudioPanels | e2e J2 |

Cache scopes: host DTO/value caches are per fetcher (report + revision + caller + saved draft), 60 s; a
revoked link / lost right stops at the server on the next request (an open page keeps what it already
showed). `resolve_state` memo is keyed by filters + state (lock values included) + locks, 30 s; the
BI Core read under it is caller-independent (rights are checked before it). Shared result cache: 5 min TTL.
