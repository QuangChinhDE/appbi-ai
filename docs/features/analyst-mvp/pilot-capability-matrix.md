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
| Filter by a text value (eq / in) | yes | the value must exist in the data (checked through GQS) |
| Explicit date period (năm, quý, tháng, từ … đến …) | yes, on certified DATE fields | `date_range`, from included, to excluded |
| Follow-up refining filter / breakdown / grain | yes | stays on the same Dataset |
| Choosing between Datasets with the same metric | clarification | the person picks the source |
| Ranking ("cao nhất", "nhiều nhất") | yes | the full sorted list; an explicit "top N" cut is not applied |
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
