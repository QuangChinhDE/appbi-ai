# AppBI Analyst — pilot capability matrix (frozen before the sealed holdout)

Frozen 2026-10-22, before the sealed holdout was written. A question inside this
scope must be answered correctly; a question outside it must be refused, clarified
or answered "no data" — never answered with a different meaning. This scope is not
narrowed after the holdout is opened.

## Certified data (engineering rig)

| Dataset | Access for the pilot user | Measures | Dimensions |
| --- | --- | --- | --- |
| Rig Commerce | explore | Doanh số, Số lượng bán, Số đơn hàng, Số khách hàng, Tiền hoàn trả, Số lượt trả hàng | Vùng, Phân khúc khách hàng, Kênh bán, Trạng thái đơn, Ngành hàng, Tên sản phẩm, Ngày đặt hàng, Ngày trả hàng, Ngày đăng ký |
| Rig Marketing | explore | Chi phí marketing | Kênh bán, Tháng |
| Rig Sales | explore | Revenue, Orders | category, order date |
| Rig Support | **none** (unauthorized by design) | — | — |

## Supported question forms

| Form | Supported | Notes |
| --- | --- | --- |
| One metric, total | yes | KPI answer |
| One metric by 1–2 categorical breakdowns | yes | identifiers and numeric columns are never breakdowns unless named |
| Several metrics of one Dataset | yes | each metric at its own grain (Kernel v2) |
| Trend by day / week / month / quarter / year | yes | only complete calendar periods are compared; missing periods named; NULL is not zero |
| Filter by a text value (eq / in) | yes | the value must exist in the data (checked through GQS); a value the question never says is re-resolved from its words or refused |
| Exclusion (không tính / ngoại trừ / bỏ / bỏ qua) | yes | `ne` / `not_in`; the excluded value must exist in the data; never turned into `eq` |
| Explicit date period (năm, quý, tháng, từ … đến …) | yes, on certified DATE fields | `date_range`, from included, to excluded |
| Follow-up refining filter / breakdown / grain | yes | stays on the same Dataset |
| Choosing between Datasets with the same metric | clarification | the person picks the source (server-signed choice); a metric reached only through the model's bridge never picks the source silently |
| Choosing between metrics ("tốt nhất") | clarification | the person picks the metric (server-signed choice, re-validated); then a ranking by it |
| Ranking ("cao nhất", "nhiều nhất", "xếp hạng", "từ cao xuống thấp") and Top-N ("top 3", "3 … thấp nhất") | yes, over exactly ONE breakdown | ordered by the metric; Top-N cut server-side; a truncated result or several breakdowns are refused |
| Business words for fields and metrics | yes, from GOVERNED vocabulary | Approved glossary terms linked to dimensions/measures and Approved governed metrics; a synonym counts only as a whole phrase |
| Request framing ("anh chị cho em hỏi … ạ") | yes | recognised as framing, not data |
| Chart draft and save | LINE (time), BAR (category), KPI (total) | saved through the chart API with the person's own rights |

## Outside the pilot scope (must be refused or clarified)

- Metrics the model does not define (profit, margin, conversion rate, NPS, cost of goods, inventory, staff counts).
- Forecasts and future periods.
- Ratios or arithmetic between metrics not defined in the semantic model.
- One answer combining two Datasets (e.g. sales and marketing spend together).
- Time ranges on TIMESTAMP fields, relative dates other than "gần đây", fiscal calendars.
- Data the person has no grant for (Rig Support).
- Accepting a dropped filter (ANALYST_DROP_CONSENT_ENABLED=false).

## Configuration under evaluation

Planner model `gpt-4o-mini` (ANALYST_PLANNER_MODEL=default); ANALYST_MAX_ROWS 500;
value lookup ≤ 4 fields, first page 200 values, search 50 rows.

## Final freeze (2026-10-22, before sealed set 9 is written)

Extended (never narrowed) for the final release candidate; the rows above marked
Top-N, exclusion, governed vocabulary, structured choices and framing were added
at this freeze.

| Frozen item | Value |
| --- | --- |
| Code | `rc/pilot-3` @ `0892b8bc` (backend/app tree `110fea5b`, frontend/src `a59091c9`; docs-only commits after this do not change them) |
| Model | `gpt-4o-mini` (provider returns `gpt-4o-mini-2024-07-18`), temperature 0.2, max 900 output tokens |
| Planner prompt | `planner.SYSTEM` sha256 prefix `8308e7b723f34475` |
| Analyst services | tree `0ca9435c` (planner `693d6fcf`, grounding `e186bb98`, intent `801649f2`) |
| GQS policies | tree `0d21869c` |
| Test budget controller | `llm_test_budget.py` `ef46b7ee` |
| Grader | `holdout.py` sha256 `bf95312e` (adds `filt_not`: an exclusion must be a ne/not_in filter on that value; the oracle still checks numbers), `holdout2.py` `79edfdfa` |
| Governed vocabulary fixture | `seed_vocab.py` sha256 `dfb372d1` (written before set 9) |
