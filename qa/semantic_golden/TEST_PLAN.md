# TEST PLAN — Semantic Layer (Source → Dataset → Semantic → Chart)

Mục tiêu: **chứng minh logic Semantic Layer không bị hỏng** sau bất kỳ thay đổi nào
(refactor, tính năng mới, fix bug). Plan gồm 4 tầng, từ tự động → thủ công; một
thay đổi chỉ được coi là AN TOÀN khi qua đủ các tầng áp dụng cho nó.

> Nguyên tắc: **SQL sinh ra là hợp đồng.** Mọi thay đổi backend mà làm đổi SQL
> semantic (không chủ đích, không giải thích được) = FAIL, bất kể app "trông vẫn chạy".

---

## TẦNG 1 — Golden harness (tự động, bắt buộc cho MỌI thay đổi backend)

**Cái gì:** khóa byte-level 2 lớp trên 60 chart đại diện (BigQuery 49 + PostgreSQL 11,
đủ loại KPI/GROUP BY/raw-select, calendar, derived, multi-fact, federated):
- **SQL golden** — SQL semantic engine sinh ra (decision layer ép live) → bảo vệ
  RENDERER: dims/measures/joins/filters/time-grain/quoting.
- **Decision golden** — dòng `[exec-decision]` với planner THẬT (triggers stub)
  → bảo vệ DECISION LAYER: mode/dialect/credential/host/federated/n_overrides.

**Chạy (trong container backend):**
```bash
docker cp qa/semantic_golden/harness.py appbi-ai-backend-1:/app/harness.py
docker exec -i appbi-ai-backend-1 sh -c 'export $(tr "\0" "\n" < /proc/1/environ | grep -E "^(DATABASE_URL|SECRET_KEY|ENCRYPTION_KEY|GCP|BQ_)" | xargs -d "\n"); export PYTHONPATH=/app; python /app/harness.py check'
```
**Pass:** `OK — sql=60 + decision=60 charts, normalized-identical`.
**Fail:** in ra từng chart drift. Quy trình xử lý drift:
1. Drift **không giải thích được** → thay đổi có bug → sửa code, KHÔNG re-capture.
2. Drift **chủ đích** (fix có chủ ý làm đổi SQL/decision) → ghi rõ từng chart vì sao,
   được duyệt → `capture` lại baseline mới + commit ghi chú.

**Re-baseline:** `python /app/harness.py capture` (chỉ sau khi mọi drift được duyệt).
**Độ tin của chính harness:** đã mutation-test (đổi 1 comment/LIMIT/case → 45/45,
38/38, 45/45 bị bắt; control 0 false-drift). Khi sửa harness phải chạy lại mutation
suite (`mutation_test.py`).

**Khoảng trống đã biết:** không có chart Sheets/manual (duckdb) trong DB local →
dialect duckdb chưa được golden. Khi có chart Sheets đầu tiên: thêm vào
`ALWAYS_INCLUDE` + re-capture.

---

## TẦNG 2 — Behavior batteries (tự động, chạy khi đụng snapshot/planner/engine)

Bộ script đã có sẵn (scratchpad, chạy trong container, `PYTHONPATH=/app`):

| Script | Bảo vệ | Kịch bản PASS chuẩn |
|---|---|---|
| `path_matrix.py` | 5 đường thực thi | federated=snapshot/host-SA/bigquery; cache-hit vẫn log; live-PG=source-cred; batch mỗi chart 1 log; 0 emit-fail |
| `phase2_behavior.py` | blocked & tự lành | A1 mixed-thiếu-snapshot→message rõ; A2 tự warm nền; A3 tự hồi phục; B disabled-table 2 chiều; C preview resolve dataset qua base-view |
| `phase45_behavior.py` | consistency & reconcile | T1 generation+host stamp; T2 bỏ qua generation partial (torn-read); T3 delayed GC giữ 2 gen + chart sống; T4 INCOMPATIBLE khi đổi định nghĩa + tự lành; T5 model tự resync, measures GIỮ NGUYÊN |
| `phase678_behavior.py` | dedup & phục hồi | P6 distinct=chart cùng host/generation (mixed dataset ra values); P7 rơi về generation TRƯỚC khi mất bảng + tự rebuild; P7 lease cross-worker; P8 phân loại lỗi 6/6 + debug surfaced |

**Quy tắc chọn:** đổi `execution_plan/chart_service` → chạy path_matrix + phase2;
đổi `snapshot_service` → phase45 + phase678(P7); đổi `dataset_model_service` →
phase45(T5) + phase678(P6); đổi `query_cache` → phase678(P7).

---

## TẦNG 3 — Ma trận đúng-số Semantic (bán tự động — vốn quý nhất)

Nguồn chân lý: chạy SQL bằng tay trên nguồn / đối chiếu chéo (theo
DA number-check rulebook: same-total, marginal, invariants).

### 3.1 Ma trận lõi (mỗi ô = 1 test case; fixture: ds111 Olist PG + ds140 mixed + 1 dataset BQ)

| Chiều \ Nguồn | PG (ds111) | BQ (ds3) | Mixed→BQ host (ds140) |
|---|---|---|---|
| KPI (COUNT/SUM/COUNTD) | tổng khớp SQL tay | ✓ | ✓ |
| GROUP BY 1 dim | tổng các nhóm = KPI tổng | ✓ | ✓ |
| Date-hierarchy (year→quarter→month→day) | drill tổng bất biến | ✓ | ✓ |
| Filter đơn (=, IN, range, NULL) | subset đúng | ✓ | ✓ |
| Filter joined-view (snowflake) | không double-count (EXISTS) | ✓ | ✓ |
| Measure-filter (HAVING) | ngưỡng đúng | ✓ | ✓ |
| Multi-fact (2 fact + conformed dim) | mỗi measure đúng grain riêng | ✓ | n/a |
| Top-N / Bottom-N | thứ tự + N đúng | ✓ | ✓ |
| Slicer distinct + cascade | giá trị = SELECT DISTINCT nguồn; **khớp chart** | ✓ | ✓ (đã fix quote-dialect) |

**Bất biến phải giữ (in-variants):**
1. `SUM(group) == KPI total` cùng filter (same-total).
2. Drill date không đổi tổng.
3. `mode=snapshot` và `mode=live` (ép TTL=0) trả **cùng số** khi nguồn không đổi.
4. Slicer values ⊆ distinct nguồn; chọn value bất kỳ → chart trả subset khác rỗng
   (trừ khi nguồn thật sự rỗng).
5. Public link == builder (cùng filter set).

### 3.2 Reconcile-on-read (không được "phải vào Dataset trước")
1. Đổi `source_query`/columns_cache của 1 bảng có snapshot → mở chart NGAY:
   - 1-nguồn: chart trả **số đúng theo định nghĩa mới** (live), log `state=incompatible`.
   - mixed: message "đang dựng lại" → tự lành trong ~1-2 phút, KHÔNG bấm gì.
2. Xóa tay 1 bảng snapshot trên BQ → mở chart: 1-nguồn tự chạy live; mixed rơi về
   generation trước (log `serving PREVIOUS generation`) → tự rebuild.
3. Refresh dataset trong lúc đang mở dashboard, F5 liên tục → không bao giờ thấy
   nửa số cũ nửa số mới (generation consistency).

### 3.3 Regression catalog
Mọi bug số liệu từng fix có test trong Regression-Catalog — chạy các case
filter/snowflake/isolation trước khi kết luận semantic core an toàn.

---

## TẦNG 4 — UI end-to-end (Playwright, trước khi ship)

1. Login → dash 67 (PG): 6 KPI + line + donut render, **0 console error**, số khớp
   lần trước (GMV 15.8M, 99.4K đơn — cập nhật khi data đổi).
2. Dash 71 (mixed): bar 18 sản phẩm render; bấm 1 cột → cross-filter hoạt động.
3. Explore: preview 1 chart mỗi loại nguồn; đổi grain; xem tab Query — SQL hiện
   + `execution_state/reason` có mặt.
4. Public link: mở link công khai — tiles render, KHÔNG có call authed (401→login).
5. `docker logs | grep exec-decision`: mỗi tile 1 dòng, field đúng kỳ vọng
   (mode/cred/dialect/state/generation), `log emit failed` = 0.

---

## Cadence

| Khi nào | Chạy gì |
|---|---|
| Mỗi commit backend đụng semantic/snapshot/cache | Tầng 1 (check) |
| Kết thúc mỗi phase refactor / feature | Tầng 1 + Tầng 2 (theo bảng chọn) + Tầng 4 nhanh |
| Trước khi push lên demo | Tầng 1 + 2 full + Tầng 4 + preflight gate (tsc/alembic/import) |
| Trước release prod | Cả 4 tầng, thêm 3.1 full matrix trên fixture ds111/ds140 |
| Sau khi đổi harness | Mutation suite |

## Trạng thái baseline hiện tại
- Golden: 60 SQL + 60 decision, capture sau Phase 8 (xem sha khi chạy check).
- Batteries: tất cả PASS ngày 2026-07-17 (Phases 0→8).
- Deferred có chủ đích: #17 server-side extract (chờ ATTT); duckdb golden (chưa có
  chart Sheets local); watermark rate-limit vẫn per-worker (chỉ tốn metadata-check).
