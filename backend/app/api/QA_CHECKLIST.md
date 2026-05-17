# AppBI QA Checklist — Phase 1-15

> **Mục đích**: checklist DA / dev mở app làm theo từng bước, đánh dấu
> pass/fail. Đây là **manual test playbook** bổ sung cho automated tests
> ở `backend/tests/test_phase15_qa_user_journey.py` và
> `test_phase15_error_contracts.py`.
>
> **Khi nào dùng**: trước khi giao DA test, trước mỗi commit lớn, trước
> khi đóng phase mới.
>
> **Cách dùng**: copy checklist này vào 1 file Notion / Issue / Doc
> riêng, đánh ✅/❌ từng dòng. Bug nào fail, add test case mới trước
> khi fix.

Cập nhật: 2026-05-17 (Phase-15.7 — implicit measure end-to-end).

---

## A. Smoke test — chạy được không?

| # | Test | Kỳ vọng | ✅/❌ |
|---|---|---|---|
| A1 | `cd backend && pytest tests/test_phase15_qa_user_journey.py -v` | 36 pass, 0 fail | |
| A2 | `cd backend && pytest tests/test_phase15_error_contracts.py -v` | 16 pass, 0 fail | |
| A3 | `cd backend && pytest tests/test_semantic_query_engine_measures.py -v` | 33 pass | |
| A4 | `cd backend && pytest tests/test_dataset_relation_invariant.py -v` | 4 pass | |
| A5 | `cd frontend && npx next lint --file src/components/explore/ExploreEditor.tsx` | 0 errors | |
| A6 | `cd frontend && npm run dev` | Port 3000 starts, no compile error | |
| A7 | `cd backend && uvicorn app.main:app --reload` | Port 8000 starts, no startup error | |

---

## B. Dataset & Semantic Model — DA mở Data Model tab

### B1. Tạo dataset cơ bản
1. Vào `/datasets` → Create dataset
2. Add table (vd `sales` với columns `date date`, `region string`, `amount number`)
3. Vào Data Model tab → click "Generate Model"
4. Kỳ vọng:
   - [ ] View `sales` xuất hiện trên canvas
   - [ ] Dimensions: `date`, `region`, `amount` (numeric column thành dim type=number, KHÔNG auto-promote thành measure — default `auto_generate_measures=False`)
   - [ ] Measure list rỗng (do trên)

### B2. Add measure cơ bản (Phase 1)
1. Mở view `sales` → Add Measure dropdown
2. Pick template "Sum of column" → measure `sum_1` xuất hiện
3. Edit: name=`total_sales`, type=sum, sql=`amount`
4. Save
5. Kỳ vọng:
   - [ ] Save success không 400
   - [ ] Measure list hiện `total_sales`
   - [ ] Refresh page — measure persisted

### B3. Hierarchy / drill-down (Phase 13.1, 15.1) ⭐
1. View `sales` add 3 dims: `year` (type=number), `month` (type=string), `day` (type=string)
2. Edit `day` → expand → **Parent dropdown** → pick `month`
3. Edit `month` → Parent → pick `year`
4. Save view
5. Kỳ vọng:
   - [ ] Parent dropdown hiển thị sibling dims (không có chính nó trong list)
   - [ ] Save success
   - [ ] Tạo measure cycle thử: `year.parent=day` → save → reject với "hierarchy có vòng lặp"

### B4. Cross-table measure (Phase 12, 15.2) ⭐
1. Tạo dataset có 2 bảng: `deals` (date, amount), `leads` (date, id, lead_type)
2. Add relationship `leads.id ← deals.lead_id` (1:N)
3. Vào view `deals` → Add Measure dropdown
4. Mở section **Cross-table (đa bảng)** — kỳ vọng có 2 preset PBI
5. Pick "Cross-table ratio" → measure mới với `scope='dataset'` + 2 source_columns trống
6. Fill expression: `${deals.amount} / NULLIF(COUNT(${leads.id}), 0)`
7. Fill source_columns: `deals.amount`, `leads.id`
8. Kỳ vọng:
   - [ ] Drift detection hiện warning nếu source_columns thiếu vs expression
   - [ ] 1-click `+ add` cho missing entry work
   - [ ] Save success
   - [ ] Header MeasureRow hiện badge "đa bảng" sau save

### B5. Filter Context preset (Phase 14, 15.4) ⭐
1. View `sales` → Add Measure `total_sales` (basic SUM(amount))
2. Add Measure `pct_of_region` → expand Advanced → section **Filter context**
3. Click preset "**% within ...**"
4. Field input: gõ `region`
5. Kỳ vọng:
   - [ ] Preview emit: `SUM(amount) OVER (PARTITION BY orders.region)` (xem qua API runtime preview)
   - [ ] Header hiện badge "ctx"
   - [ ] Click preset "**% of grand total**" — `OVER ()` không partition
   - [ ] Click both → cảnh báo "không thể đồng thời ALL và ALL EXCEPT"

### B6. Time intelligence builder (Phase 15.5) ⭐
1. View `sales` → Add Measure dropdown
2. Section "Time intelligence" → click "**+ Time intelligence (smart)**"
3. Dialog mở. Pick:
   - Function: "Same period last year"
   - Base measure: `total_sales` (đã tạo ở B2)
   - Date dim: `sales.date`
4. Preview SQL hiện: `SUM(CASE WHEN ${sales.date} >= ${PREV_YEAR_START} AND ${sales.date} < ${YEAR_START} THEN ${TABLE}.amount END)`
5. Click "Generate measure"
6. Kỳ vọng:
   - [ ] Measure mới `total_sales_same_period_last_year_1` xuất hiện trong list
   - [ ] Label = "total_sales — Same period last year"
   - [ ] Edit name / agg / expression như measure thường được

---

## C. Explore — DA tạo chart

### C1. Implicit measure (Phase 15.7) ⭐⭐ — Bug DA report cũ
1. Mở Explore với dataset chỉ có dim numeric (KHÔNG có measure declared)
2. Chọn chart type BAR
3. Kéo `region` (string) vào X Axis
4. Kéo `amount` (numeric DIM, không phải measure) vào Y Axis
5. Click Run
6. Kỳ vọng:
   - [ ] Chart render OK với SUM(amount) per region (KHÔNG 400 "Measure not found")
   - [ ] Metric pill hiện badge "**auto**" (Phase 13.2 implicit flag)
   - [ ] Tooltip badge: "Measure tạm — FE tự tạo từ cột raw. Để dùng lại ở chart khác, vào Data Model tab và Add Measure với cùng cột + agg."

### C2. Qualified field routing (Phase 12.5, 12.7)
1. View `sales` đã có semantic model (B1)
2. Tạo measure declared `total_sales = SUM(amount)`
3. Mở Explore, kéo `total_sales` vào metric
4. Kỳ vọng:
   - [ ] FE gửi field qualified `sales.total_sales`
   - [ ] BE route sang semantic engine (không phải live_query)
   - [ ] Chart render
   - [ ] Badge "auto" KHÔNG hiện (vì là measure declared, không phải implicit)

### C3. Cross-table chart với scope='dataset' measure (Phase 12)
1. Dataset có 2 bảng + relationship (B4 setup)
2. Tạo measure `revenue_per_lead` scope='dataset' (B4)
3. Mở Explore, chọn chart type LINE, base view = leads
4. Kéo `leads.date` vào X
5. Kéo `revenue_per_lead` vào Y
6. Kỳ vọng:
   - [ ] Chart render — engine auto JOIN deals + leads
   - [ ] Không 400 "Bảng deals chưa có relationship..."
   - [ ] Nếu xoá join trước rồi try lại → engine raise VN message

### C4. Time grain picker (Phase 13.4, 15.3) ⭐
1. Mở Explore, chart type BAR
2. Kéo `date` (date type) vào X Axis
3. Kỳ vọng:
   - [ ] **TimeGrainSlot hiện ngay** dưới SelectSlot dim
   - [ ] Default "none (raw)"
4. Pick grain = "Month"
5. Click Run
6. Kỳ vọng:
   - [ ] BE emit `DATE_TRUNC('month', sales.date)` (Postgres) hoặc tương đương (DuckDB/BQ/MySQL)
   - [ ] Chart hiện 1 bar per month thay vì 1 bar per raw timestamp
7. Đổi chart type → LINE → grain picker vẫn hiện
8. Đổi chart type → TIME_SERIES → grain picker vẫn ở slot Time Field

### C5. Drill-down action (Phase 15.1)
1. View `sales` có dim hierarchy `year → month → day` (B3)
2. Mở Explore, chart BAR, X Axis = `sales.year`
3. Kỳ vọng:
   - [ ] Dưới X Axis slot có "**↓ Drill into: month**" button
4. Click button
5. Kỳ vọng:
   - [ ] X Axis tự đổi thành `sales.month`
   - [ ] Drill button mới hiện "↓ Drill into: day"
   - [ ] Chart re-run, render data theo month

### C6.1 Chart renders when table renders (Phase 15.8) ⭐⭐ — DA bug 2026-05-17
1. Cùng 1 chart_id, 2 chart instance: 1 chart type TABLE, 1 chart type BAR (cùng dataset_table_id, cùng metric)
2. Run cả hai
3. Kỳ vọng:
   - [ ] **TABLE hiển thị data đúng** với cột metric có số liệu
   - [ ] **BAR cũng hiển thị data** (không phải chart trống)
   - [ ] **Cả 2 phải hiện cùng giá trị** (nếu BAR cùng X/Y với TABLE row/measure)
4. Mở DevTools Network → check response `/charts/{id}/data` → `data[0]` có key dạng `"view.field"` (qualified, sau remap engine)
5. Kỳ vọng: Recharts dataKey = `"sum__view.field"` (metricKey) **must match** value sau khi `rewriteRowsForRecharts` chạy
   - [ ] Nếu chart vẫn trống → audit `chartDataAdapter.ts` `rewriteRowsForRecharts` helper có chạy không

### C6. Filter Context với chart (Phase 14)
1. Tạo 2 measure: `total_sales` (basic) + `pct_of_region` (filter context all_except region)
2. Mở Explore chart BAR
3. X = region, Y = [total_sales, pct_of_region]
4. Kỳ vọng:
   - [ ] BE emit cả 2 SQL: `SUM(amount)` thường + `SUM(amount) OVER (PARTITION BY region)`
   - [ ] Chart hiện 2 series

---

## D. Dashboard — DA assemble + share

### D1. Tạo dashboard cơ bản
1. `/dashboards` → Create
2. Add chart từ B/C
3. Kỳ vọng:
   - [ ] Chart hiện trên dashboard
   - [ ] Layout grid hoặc canvas tùy mode

### D2. Cross-filtering (Phase 15.6) ⭐
1. Dashboard có ≥ 2 chart cùng base view
2. Hover chart 1 — kỳ vọng:
   - [ ] **Cursor → crosshair** (Phase 15.6 hint)
   - [ ] Tooltip "Click một slice để filter chart khác trong dashboard"
3. Click 1 slice ở chart 1
4. Kỳ vọng:
   - [ ] Chart 1 hiện ring warning border (cross-filter source)
   - [ ] Chart 2 auto-filter, re-render với slice đó
   - [ ] Banner "Cross-filter from {Chart 1}: region = north" hiện trên dashboard
5. Click "Clear" trên banner
6. Kỳ vọng:
   - [ ] Filter xoá, chart 2 trở về full data
   - [ ] Ring warning ở chart 1 mất

### D3. Public share + viewer filter (Phase 10)
1. Dashboard → Share → tạo public link
2. Mở incognito → paste link
3. Apply viewer filter (vd region = south)
4. Kỳ vọng:
   - [ ] Chart filter đúng
   - [ ] AI Bot (nếu có) thấy data đã filtered (Phase 10 Issue C)

---

## E. Error message contracts (Phase 11, 12.6, 12.7)

### E1. Chart config sai → 400 không phải 404
1. Tạo chart với measure ref tới view không reachable (xoá relationship sau khi save)
2. Load chart data
3. Kỳ vọng:
   - [ ] HTTP 400 (không 404)
   - [ ] Detail tiếng Việt: `"Bảng X chưa có relationship tới base view Y. Mở tab Data Model để định nghĩa join trước khi dùng field từ bảng này."`

### E2. Public share chart broken → message forwarded
1. Tạo dashboard public, chart có measure broken (cột bị xoá)
2. Mở public link incognito
3. Kỳ vọng:
   - [ ] HTTP 400 với detail là VN message (KHÔNG phải "Chart data not found." generic)

### E3. Implicit measure missing column → 2 paths
1. Chart ref tới cột không tồn tại (vd `view.nonexistent`)
2. Run
3. Kỳ vọng:
   - [ ] Error VN: `"Measure 'nonexistent' không tồn tại trong view 'X'. Để aggregate cột này, hãy chọn: (a) khai báo nó là dimension type=number trên view, hoặc (b) tạo measure tên này trong tab Data Model."`

### E4. Schema validation reject — VN
1. POST /datasets/{id}/model/views/{vid} với measure `scope='dataset'` + empty source_columns
2. Kỳ vọng:
   - [ ] 422 hoặc 400 với detail VN: "Measure scope='dataset' phải khai báo ít nhất một entry..."

### E5. Multi-dialect SQL emit (Phase 12.6)
1. Dataset trên BigQuery / MySQL / DuckDB datasource
2. Chart với measure dùng time macro `${MONTH_START}`
3. Run
4. Kỳ vọng:
   - [ ] BE emit `DATE_TRUNC(CURRENT_DATE(), MONTH)` (BigQuery) / `DATE_FORMAT(CURDATE(), '%Y-%m-01')` (MySQL) / `date_trunc('month', current_date)` (DuckDB/PG)
   - [ ] KHÔNG hard-code postgres syntax cho mọi dialect (Phase 12.6 bug)

---

## F. React #31 hardening (Phase 12.7)

### F1. RelationshipDialog 409 conflict
1. Tạo relationship đã tồn tại (duplicate)
2. Click Save
3. Kỳ vọng:
   - [ ] Dialog hiển thị error message tiếng Việt (KHÔNG crash với React #31 "Objects are not valid as React child")
   - [ ] BE return 409 với detail object — FE `extractApiError` convert thành string an toàn

### F2. Generate model fail
1. Generate model với dataset có circular FK (giả lập)
2. Kỳ vọng:
   - [ ] Toast error với message rõ ràng
   - [ ] KHÔNG crash UI

---

## G. Phase-1 invariants — đừng phá

### G1. Dimension chỉ map cột, không phải expression
1. Try save view với `dim.sql = "UPPER(region)"`
2. Kỳ vọng:
   - [ ] 400 với detail: "Dimension.sql phải bằng chính tên cột..."

### G2. Measure SQL không chứa DDL/DML
1. Try save measure với `expression = "DROP TABLE x"`
2. Kỳ vọng:
   - [ ] 400 với "forbidden token"

### G3. Cycle in derived_table
1. Tạo derived_table A SELECT FROM B
2. Tạo derived_table B SELECT FROM A
3. Kỳ vọng:
   - [ ] 400 cycle detected ở Phase-2 helper `check_derived_table_cycle`

### G4. Measure rename cascade
1. Tạo measure `revenue`, dùng trong chart
2. Rename `revenue → revenue_v2` qua PUT view với `rename_map`
3. Kỳ vọng:
   - [ ] Chart config tự rewrite (Phase-6 + 7)
   - [ ] Chart render OK sau rename
   - [ ] Response trả `renamed: {charts: N, depends_on: N, expressions: N}`

---

## H. MCP-dashboard contract (Phase 12.5, 12.6, 14)

Chỉ test nếu bác có Claude Desktop + MCP cấu hình.

### H1. `commit_semantic_model` reject bad scope
1. Claude gọi với plan có measure `scope='dataset'` + empty source_columns
2. Kỳ vọng:
   - [ ] MCP `commit_semantic_model` trả validation_errors, KHÔNG round-trip BE 400
   - [ ] Error message giống BE: "scope='dataset' requires at least one entry..."

### H2. `execute_semantic_query` qualified-only
1. Claude gọi với `dimensions: ["amount"]` (bare)
2. Kỳ vọng:
   - [ ] Docstring nhắc dùng qualified. Bare có thể route sai → measure data lệch silent

### H3. `create_chart` không strip qualifier
1. Claude pass config với `roleConfig.metrics[].field = "deals.amount"` (qualified)
2. Kỳ vọng:
   - [ ] Chart save OK, qualifier giữ nguyên trong config
   - [ ] Runtime BE route sang semantic engine

---

## I. Run-all script — chạy toàn bộ checklist automated

```bash
# Backend tests
cd backend
DATABASE_URL=sqlite:///./qa.db python -m pytest \
  tests/test_phase15_qa_user_journey.py \
  tests/test_phase15_error_contracts.py \
  tests/test_semantic_query_engine_measures.py \
  tests/test_dataset_relation_invariant.py \
  -v -p no:warnings

# Frontend typecheck (no workboards-broken files)
cd ../frontend
cat > tsconfig.qa.json <<EOF
{
  "extends": "./tsconfig.json",
  "exclude": [
    "node_modules",
    "src/components/workboards/builder/CanvasOverview.tsx",
    "src/components/workboards/builder/ScreenSwitcherModal.tsx"
  ]
}
EOF
node node_modules/typescript/bin/tsc -p tsconfig.qa.json --noEmit --pretty false
rm tsconfig.qa.json
```

**Pass condition**:
- BE: tổng 89 test pass (36 user journey + 16 error contract + 33 measures + 4 relation invariant)
- FE: 0 TS errors

---

## J. Khi bug mới xuất hiện

1. **Bug-first test**: add failing test vào `test_phase15_qa_user_journey.py` HOẶC `test_phase15_error_contracts.py` HOẶC mục manual ở file này.
2. **Verify test fail** trên codebase hiện tại.
3. **Fix code**.
4. **Verify test pass**.
5. **Update QA_CHECKLIST.md** nếu là kiểu bug mới không cover.

Nguyên tắc: **mỗi DA-reported bug = 1 test name mới**. Tên test = mô tả bug. Khi grep `test_implicit_measure_falls_back` lần sau, ai cũng biết "đó là bug DA gặp 2026-05-17 với deal_value".
