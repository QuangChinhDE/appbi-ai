# TEST PLAN TOÀN DIỆN — BÁO CÁO TỪ GOOGLE SHEETS & BIGQUERY

Phạm vi: **mọi case có thể xảy ra khi làm báo cáo mà nguồn là Google Sheets, BigQuery,
hoặc trộn cả hai** — từ kết nối nguồn → Dataset → Semantic model → Chart/Explore →
Dashboard → Slicer → Public link → chế độ phục vụ (live/snapshot/federated) → sự cố.

Cách dùng: mỗi case có `ID | Bước | Kỳ vọng | Ưu tiên`. Dev test đi theo thứ tự
fixture → suite A→I. Case FAIL = ghi ID + screenshot + log `[exec-decision]`.

- **P0** = chặn release (sai số liệu / crash / silent-wrong).
- **P1** = phải sửa trước khi ship rộng (UX sai, message sai, chậm bất thường).
- **P2** = ghi nhận, sửa sau.

**Công cụ chẩn đoán khi test** (dùng ở mọi case):
- `docker logs <backend> | grep exec-decision` → mode/dialect/cred/state/generation/reason của từng chart.
- Tab **Query/Debug** của chart → `sql_emitted`, `execution_state`, `execution_reason`, `dropped_filters`, `data_source_mode`, `snapshot_stale`.
- Đối chiếu số bằng SQL tay trên nguồn (BQ console / Google Sheets công thức).

---

## 0. FIXTURES BẮT BUỘC DỰNG TRƯỚC (1 lần)

| ID | Mô tả | Chi tiết |
|---|---|---|
| **F-GS1** | Dataset thuần Google Sheets | 1 spreadsheet 3 tab: `fact_sales` (~500 dòng: date, product_id, region_id, qty, amount), `dim_product` (product_id, name, category), `dim_region` (region_id, name). Khóa `product_id` để **dạng TEXT** trong Sheet. |
| **F-GS-EDGE** | Tab "edge_data" trong cùng spreadsheet | Cột chứa: số dạng text (`"1200"`), số lẫn chữ trong 1 cột, ô trống giữa chừng, dòng trống, ngày 2 định dạng (`2026-07-17` và `17/07/2026`), tiếng Việt có dấu (`"Đà Nẵng"`), số thập phân kiểu VN (`1.234,56`), giá trị có dấu backtick `` ` `` và nháy `'`  trong text, header có dấu cách + ký tự đặc biệt (`"Doanh thu (VNĐ)"`). |
| **F-BQ1** | Dataset thuần BQ physical, **materialization OFF** | 3 bảng physical (kiểu `dw_buoi_7.sales/products/employees`), có cột Airbyte STRING chứa số. |
| **F-BQ2** | Dataset thuần BQ `sql_query`, **materialization ON** | ≥2 bảng custom SQL nhiều CTE, có `ROW_NUMBER() OVER(...) AS rn`, `SELECT * EXCEPT(rn)`, backtick refs — mô phỏng SDR thật. + 1 generated_calendar. |
| **F-MIX** | Dataset TRỘN, **materialization ON** | BQ fact (`sales`) + Sheets dim (`dim_product` từ F-GS1), join `product_id` (BQ STRING × Sheets TEXT). = dataset 140 mẫu. |
| **F-MIX0** | Bản sao F-MIX nhưng datasource BQ **materialization OFF** | Để test blocked-case. |
| **DASH** | 1 dashboard 2 trang | Trang 1: ≥6 chart trộn F-BQ2 + F-GS1; Trang 2: chart F-MIX; ≥2 slicer (1 per-page, 1 all-pages); 1 public link có locked filter + TTL. |

> Ghi lại **số chuẩn (ground truth)** cho mỗi fixture ngay khi dựng: tổng amount, số dòng
> fact, distinct từng dim — bằng SQL tay/công thức Sheet. Mọi suite dưới so về số này.

---

## SUITE A — KẾT NỐI NGUỒN (Source)

### A-GS: Google Sheets
| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| A-GS-01 | Connect Sheets bằng OAuth, list tabs | Thấy đủ tab; chọn tab import được | P0 |
| A-GS-02 | Sửa 1 ô trên Sheet (đổi amount) → bấm **Làm mới dữ liệu** trên dashboard | Số MỚI hiện (Refresh pull fresh-from-source mọi nguồn) | P0 |
| A-GS-03 | Sửa ô trên Sheet, KHÔNG refresh, đợi hết TTL cache (~5') rồi mở lại | Số mới tự hiện sau TTL | P1 |
| A-GS-04 | **Đổi tên tab** đang dùng làm bảng | Chart báo lỗi RÕ (không treo/silent-0); vào Dataset re-map được | P1 |
| A-GS-05 | **Đổi tên header** 1 cột đang dùng làm dim | Không silent sai; model-drift check tự resync HOẶC lỗi rõ nêu tên cột | P0 |
| A-GS-06 | Xóa hẳn 1 cột đang dùng trong measure | Lỗi rõ ở chart dùng cột đó; chart khác vẫn chạy | P1 |
| A-GS-07 | Thêm cột mới vào Sheet → mở chart (không vào Dataset) | Trong ≤5' cột mới xuất hiện trong model (drift resync nền) | P1 |
| A-GS-08 | Thu hồi quyền OAuth (revoke ở Google Account) → mở chart | Lỗi credential RÕ, không phải lỗi generic 500 | P1 |
| A-GS-09 | Spreadsheet bị xóa/chuyển owner không share | Lỗi rõ "không truy cập được spreadsheet" | P1 |
| A-GS-10 | Sheet ~50k dòng (nếu có) — mở dashboard | Load được; sheets-cache 1 lần/view (log `sheets result cache`) không gọi API mỗi tile | P1 |

### A-BQ: BigQuery
| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| A-BQ-01 | Connect BQ bằng OAuth; test query | OK; list dataset/tables | P0 |
| A-BQ-02 | Connect BQ bằng Service Account | OK | P0 |
| A-BQ-03 | **Đổi key SA → OAuth** (hoặc ngược lại) trên datasource đang dùng → mở chart ngay | Chạy bằng credential MỚI ngay (client-cache evicted), không lỗi "credential cũ" | P0 |
| A-BQ-04 | Query vượt `BQ_MAX_BYTES_SCANNED` | Lỗi rõ "would scan X GB (limit Y)" — không chạy | P1 |
| A-BQ-05 | Mất quyền đọc bảng nguồn (revoke IAM) → mở chart | Lỗi 403 RÕ; **không** rơi nhầm vào self-heal/live-retry (error-taxonomy #44) | P0 |
| A-BQ-06 | Bảng nguồn bị xóa trên BQ | Lỗi rõ nêu bảng; với dataset mat ON: snapshot cũ vẫn phục vụ (serve-stale) cho tới rebuild kế → rebuild fail có log, chart vẫn ra số cũ | P1 |

---

## SUITE B — DATASET & BẢNG

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| B-01 | Import bảng từ F-GS1: kiểm `columns_cache` | Types hợp lý; `source_type` phản ánh kiểu vật lý (text) | P0 |
| B-02 | Import BQ physical có cột Airbyte STRING chứa số | SUM trên cột đó: hoặc chạy đúng qua CAST, hoặc 400 RÕ — **không silent 0/sai** | P0 |
| B-03 | Tạo `sql_query` table (F-BQ2, có `rn`/EXCEPT/backtick) → preview | Preview ra data; cột `rn` KHÔNG lộ ra như dim rác nếu đã EXCEPT | P1 |
| B-04 | Auto-type-detection chạy lại (mở Dataset, đợi job nền) trên bảng Sheets/PG dim của F-MIX | `type` có thể đổi nhưng **`source_type` GIỮ NGUYÊN** → snapshot key không đổi kiểu → join không gãy (incident INT64/STRING) | P0 |
| B-05 | Disable 1 bảng trong dataset → mở chart các bảng khác | Không ảnh hưởng: không mất snapshot-path, không báo mixed-engine oan | P1 |
| B-06 | Xóa 1 bảng khỏi dataset | View/explore của nó dọn sạch; chart đang dùng nó lỗi RÕ; chart khác bình thường | P1 |
| B-07 | Thêm generated_calendar + bật auto-join temporal | Role views `__date_dim` sinh ra; date-hierarchy dùng được ở chart | P0 |
| B-08 | F-MIX: kiểm khóa join `product_id` 2 bên | Sau materialize: cả 2 snapshot cùng kiểu (STRING) — join ra đủ dòng, không NULL-blast | P0 |
| B-09 | Đổi `source_query` của 1 bảng F-BQ2 (thêm cột) → mở chart NGAY (không vào Dataset) | `state=incompatible` → single-source: chart trả số ĐÚNG THEO SQL MỚI (live) + tự rebuild nền; sau ~1-2' quay lại snapshot mới | P0 |
| B-10 | Case B-09 nhưng trên F-MIX (sửa columns_cache/dim Sheets) | Message "đang dựng lại" (blocked) → tự lành không cần bấm gì | P0 |

---

## SUITE C — SEMANTIC MODEL

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| C-01 | Auto-gen model từ F-GS1/F-BQ1 | Views đủ dims; explore per bảng | P0 |
| C-02 | Tạo 5 measure tay (SUM, COUNT, COUNTD, formula A/B, filtered measure) → trigger model resync (B-07/A-GS-07) | **Measures tay GIỮ NGUYÊN** sau mọi resync (merge-not-overwrite) | P0 |
| C-03 | Tạo join tay Sheets-dim ↔ BQ-fact (F-MIX); xóa 1 auto-FK join | Join tay giữ qua resync; auto-FK có thể mọc lại (behavior hiện tại — ghi nhận, không phải bug) | P1 |
| C-04 | Snowflake 2 tầng (fact→dim→sub-dim) filter ở sub-dim | Không double-count (EXISTS); số khớp SQL tay | P0 |
| C-05 | 2 fact + 1 conformed dim (multi-fact), 1 chart lấy measure cả 2 fact theo dim chung | Mỗi measure đúng grain riêng (không fan-out); tổng từng measure khớp KPI riêng lẻ | P0 |
| C-06 | Đặt PK cho view → COUNTD qua join fan-out | Symmetric aggregate đúng (không đếm trùng) | P1 |

---

## SUITE D — CHART / EXPLORE (chạy trên CẢ 3 fixture: F-GS1, F-BQ2, F-MIX)

> Ma trận: mỗi dòng dưới × 3 fixture. Đánh dấu từng ô.

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| D-01 | KPI: SUM(amount), COUNT(*), COUNTD(product_id) | Khớp ground-truth từng fixture | P0 |
| D-02 | BAR theo category; LINE theo tháng; PIE theo region; TABLE chi tiết | Render + tổng các nhóm = KPI (same-total) | P0 |
| D-03 | Date-hierarchy: year→quarter→month→day drill | Tổng BẤT BIẾN qua mọi mức | P0 |
| D-04 | Filter: `=`, `IN` nhiều giá trị, khoảng ngày, IS NULL, contains | Subset đúng; số khớp SQL tay có WHERE tương ứng | P0 |
| D-05 | Filter đặt trên **joined view** (dim) áp vào chart fact | Áp đúng qua join; không double-count | P0 |
| D-06 | Measure-filter (HAVING >, giữa) | Ngưỡng đúng | P1 |
| D-07 | Top-N / Bottom-N theo measure | Đúng N + đúng chiều; đổi chiều không dính cache cũ | P1 |
| D-08 | **Preview (Explore) == Saved chart == Dashboard tile** cùng cấu hình | 3 nơi cùng MỘT số | P0 |
| D-09 | Không có row-cap: chart TABLE trên bảng > mặc định limit | Trả đủ dòng (quy tắc "không giới hạn dữ liệu") | P0 |
| D-10 | Đổi grain trên viewer (Gom theo thời gian) | Số đúng theo grain; không dính cache grain khác | P0 |
| D-11 | Chart lỗi (cột không tồn tại) giữa dashboard | CHỈ tile đó lỗi; các tile khác + batch vẫn render | P0 |
| D-12 | Text tiếng Việt/ký tự đặc biệt từ F-GS-EDGE làm dim | Hiển thị đúng, không vỡ SQL (backtick/nháy trong VALUE không gây lỗi/leak-guard oan) | P1 |
| D-13 | Cột ngày 2 định dạng (F-GS-EDGE) làm trục thời gian | Hoặc parse đúng hoặc lỗi RÕ — không lệch ngày im lặng | P1 |
| D-14 | Số thập phân kiểu VN `1.234,56` (F-GS-EDGE) vào SUM | Không nhân sai ×1000/×10 (bug class dot-decimal) — đúng hoặc lỗi rõ | P0 |

---

## SUITE E — CHẾ ĐỘ PHỤC VỤ (live / snapshot / federated) — TRỌNG TÂM

| ID | Bước | Kỳ vọng (`exec-decision`) | Ưu tiên |
|---|---|---|---|
| E-01 | Chart F-GS1 | `mode=live dialect=duckdb cred=source_datasource` — Sheets KHÔNG BAO GIỜ tự snapshot khi không có host BQ | P0 |
| E-02 | Chart F-BQ1 (mat OFF) | `mode=live dialect=bigquery` | P0 |
| E-03 | Chart F-BQ2 lần đầu (mat ON, chưa build) | Lần 1: `mode=live state=not_built` + tự warm; sau build: `mode=snapshot state=fresh generation=<id>`; **số snapshot == số live** | P0 |
| E-04 | Chart F-MIX (mat ON) sau Refresh | `mode=snapshot cred=host_service_account federated=True`; số == đối chiếu tay (join Sheets×BQ) | P0 |
| E-05 | Chart F-MIX0 (mat OFF) | Lỗi RÕ tiếng Việt "trộn nhiều nguồn… cần host BigQuery bật materialization / tách dataset" — không phải parser error khó hiểu | P0 |
| E-06 | Public link F-MIX đặt **Realtime (TTL=0)** | Message rõ realtime không dùng được với dataset trộn — không silent sai | P1 |
| E-07 | Public link F-BQ2 TTL 15': xem sau 20' | Lượt xem trả NGAY số cũ (serve-stale, `stale=True`) + rebuild nền; lượt sau ra số mới | P0 |
| E-08 | Bấm Refresh trên dashboard (mọi fixture) | Trả về ngay (async), tiles re-execute số MỚI từ nguồn; không đợi >nginx timeout | P0 |
| E-09 | **Xóa tay 1 bảng snapshot** trên BQ console (F-BQ2) → mở chart | Tự lành: chạy live trả đủ số + rebuild nền (log `falling back to LIVE`) | P0 |
| E-10 | Xóa tay 1 bảng snapshot generation MỚI NHẤT (F-MIX) → mở chart | Rơi về **generation TRƯỚC** (log `serving PREVIOUS generation`), có số; tự rebuild → gen mới | P0 |
| E-11 | Refresh trong lúc dashboard đang mở, F5 liên tục trong lúc build | KHÔNG BAO GIỜ nửa bảng số cũ nửa bảng số mới (generation consistency) | P0 |
| E-12 | Sau ≥3 lần Refresh + >10' | Registry: chỉ ~2 generation còn sống, gen cũ `retired_at` set; chart vẫn chạy | P1 |
| E-13 | 20 request đồng thời cùng 1 chart (script/curl) | 1 query nguồn duy nhất (coalescing); các request khác nhận cùng kết quả | P1 |
| E-14 | 1 request lỗi giữa chừng, request sau cùng key | Không bị chờ lease (leader release-on-error) — phản hồi ngay | P1 |
| E-15 | Snapshot vẫn phục vụ khi **nguồn** BQ down/mất quyền tạm | Chart snapshot vẫn ra số (đúng bản chất cache); rebuild fail chỉ ghi log | P1 |
| E-16 | So **snapshot vs live cùng thời điểm**: bật realtime TTL=0 (dataset thuần BQ) trên 1 link, link kia mặc định | Hai link CÙNG SỐ khi nguồn không đổi | P0 |

---

## SUITE F — SLICER / DISTINCT (chạy trên F-GS1, F-BQ2, F-MIX)

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| F-01 | Slicer trên dim mỗi fixture | Values == `SELECT DISTINCT` nguồn (đối chiếu tay) | P0 |
| F-02 | F-MIX: slicer trên **Sheets dim** khi mat ON | Chạy trên snapshot host (nhanh); values đủ; **chọn value bất kỳ → chart có data** (slicer=chart cùng generation) | P0 |
| F-03 | Cascade: chọn slicer A (category) → mở slicer B (product) | B chỉ còn giá trị thuộc A | P0 |
| F-04 | Slicer per-page vs all-pages | Đúng scope; không leak qua trang | P1 |
| F-05 | Public: slicer với locked filter | Không hiện giá trị ngoài locked scope; không tự pin default vào chính nó | P0 |
| F-06 | Slicer trên cột có giá trị tiếng Việt/ký tự đặc biệt | Hiện đúng, filter đúng | P1 |

---

## SUITE G — DASHBOARD / PUBLIC / BATCH

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| G-01 | DASH trang 1: mở lạnh (cache clear) | 1 request batch/trang; tiles hiện dần; không tile nào "No data" oan trong lúc loading | P0 |
| G-02 | Cross-filter: click cột trên chart A | Chart B lọc theo; click lại bỏ lọc | P1 |
| G-03 | Chuyển trang 1↔2 nhiều lần sau khi mở lâu | Không lỗi, không chậm bất thường (page-switch fix) | P0 |
| G-04 | Public link: so TOÀN BỘ tiles với builder (cùng filter) | Từng số một GIỐNG NHAU (public==builder) | P0 |
| G-05 | Public link: locked filter đúng scope; viewer filter chỉ trong allow-list | Không leak data ngoài scope (kể cả khi locked value rỗng) | P0 |
| G-06 | Mục "Độ tươi dữ liệu (snapshot)" khi tạo public link | CHỈ hiện khi dataset materialized; F-GS1/F-BQ1 không hiện | P1 |
| G-07 | Public path không gọi API authed | Network tab: không request nào 401→login | P0 |

---

## SUITE H — SỰ CỐ / RESILIENCE (failure injection)

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| H-01 | Xóa tay cả dataset `appbi_snapshots` trên BQ → Refresh | Tự tạo lại dataset + build lại; không kẹt vĩnh viễn | P1 |
| H-02 | Spam Refresh 5 lần liên tiếp | Chỉ 1 rebuild chạy (lease); poll "đang làm mới" đúng | P1 |
| H-03 | Restart backend GIỮA lúc rebuild | Không kẹt: lease tự hết hạn (≤30'); Refresh lại chạy được | P1 |
| H-04 | Sheets API lỗi tạm (rate-limit) giữa build federated | Build fail ghi log, snapshot cũ (generation trước) vẫn phục vụ; retry sau OK | P1 |
| H-05 | Đổi materialization_dataset name trên datasource → Refresh | Build vào dataset mới; đọc theo registry host mới; không đọc nhầm chỗ cũ | P2 |
| H-06 | Thêm 1 datasource BQ mới (enabled mat) vào hệ thống | Host của các dataset CŨ KHÔNG đổi (recorded-host wins) | P1 |

---

## SUITE I — BẤT BIẾN SỐ LIỆU (checklist ký tên cuối cùng)

Chạy sau khi các suite trên xanh; mỗi mục PASS phải có ảnh chụp số đối chiếu.

| # | Bất biến | Cách kiểm |
|---|---|---|
| I-1 | `Σ(nhóm) == KPI tổng` cùng filter | D-02 trên 3 fixture |
| I-2 | Drill date không đổi tổng | D-03 |
| I-3 | `snapshot == live` cùng nguồn cùng thời điểm | E-03, E-16 |
| I-4 | `slicer values ⊆ distinct nguồn` và chọn value nào chart cũng có data | F-01, F-02 |
| I-5 | `public == builder` từng tile | G-04 |
| I-6 | `preview == saved == tile` | D-08 |
| I-7 | F-MIX == đối chiếu tay join 2 nguồn | E-04 |
| I-8 | Sau Refresh, số == trạng thái nguồn HIỆN TẠI | A-GS-02, E-08 |
| I-9 | Không case nào phải "vào Dataset trước thì báo cáo mới chạy" | B-09, B-10, E-09, E-10 |
| I-10 | Mọi lỗi hiển thị là lỗi RÕ NGHĨA (không parser error thô, không silent) | A-*, E-05 |

---

## SUITE J — GOOGLE SHEETS EDGE THỰC CHIẾN (bổ sung — người dùng thật hay làm)

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| J-01 | Ô là **công thức** (`=VLOOKUP`, `=A2*B2`, `=IMPORTRANGE`) đang dùng làm dim/measure | Đọc GIÁ TRỊ đã tính, không đọc chuỗi công thức; nếu công thức trả số → SUM đúng | P0 |
| J-02 | Ô lỗi công thức `#REF!` / `#N/A` / `#DIV/0!` trong cột số | Coi như NULL/bỏ qua, KHÔNG làm hỏng cả cột hay 400 toàn chart | P1 |
| J-03 | **Merged cells** ở vùng data | Không lệch cột/dòng; giá trị merge về ô đầu, còn lại NULL — không dồn sai | P1 |
| J-04 | Data KHÔNG bắt đầu từ dòng 1 (có tiêu đề mô tả ở trên) / có dòng trống giữa | Header row nhận đúng; dòng trống không thành 1 record rác | P1 |
| J-05 | **Header trùng tên** 2 cột (`Doanh thu` ×2) | Không đè nhau silent; phân biệt được hoặc cảnh báo rõ | P1 |
| J-06 | Tab hoàn toàn rỗng / chỉ có header không data | Import ra 0 dòng, không crash; chart hiện "empty" đúng nghĩa | P1 |
| J-07 | Cột % (0.15 hiển thị "15%") và cột checkbox TRUE/FALSE | SUM/filter theo giá trị nền đúng (0.15, true), không theo chuỗi hiển thị | P1 |
| J-08 | **2 dataset khác nhau cùng trỏ 1 spreadsheet**; sửa Sheet rồi mở cả hai | Cả hai thấy số mới sau refresh/TTL; workbook-cache không phục vụ chéo số cũ cho dataset kia | P1 |
| J-09 | Cột số lẫn chữ (`"1200"`, `"N/A"`, `""`) trong cùng cột dùng làm measure | Hoặc CAST an toàn (chữ→NULL) hoặc lỗi RÕ — không tổng sai | P0 |
| J-10 | Sheet rất rộng (100+ cột) import 1 phần | Chỉ cột đã chọn vào model; không kéo toàn bộ mỗi tile (quota) | P2 |

## SUITE K — BIGQUERY EDGE THỰC CHIẾN (bổ sung)

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| K-01 | Bảng **require_partition_filter=true** làm nguồn (chart + snapshot build) | Query/extract có partition filter → chạy; nếu thiếu → lỗi RÕ, không 500 mù | P0 |
| K-02 | Nguồn là **VIEW** (không phải table) | Chart chạy; snapshot: watermark có thể None → rơi về TTL (không kẹt) | P1 |
| K-03 | Cột **ARRAY / STRUCT / JSON / GEOGRAPHY** trong bảng | Không auto thành dim gây vỡ SQL; hiển thị/loại rõ ràng (complex-type gate) | P1 |
| K-04 | Cột **NUMERIC/BIGNUMERIC** độ chính xác cao qua federation (extract→load) | Không mất chính xác (Decimal→str→NUMERIC); SUM khớp | P1 |
| K-05 | Nguồn ở **location khác US** (vd asia-southeast1) + snapshot dataset | Snapshot dataset tạo COLOCATED cùng location; CTAS/load không lỗi cross-location | P0 |
| K-06 | Bảng đang **streaming buffer** (mới insert) | Watermark change-detect không spam rebuild; số ổn định | P2 |
| K-07 | **Authorized view**: OAuth user đọc được nhưng write-SA KHÔNG | Federation build lỗi quyền RÕ; chart live (OAuth) vẫn chạy; không kẹt | P1 |
| K-08 | `sql_query` ~vài triệu dòng build snapshot (extract-load qua Python) | Build xong trong timeout HOẶC lỗi rõ; không OOM âm thầm; foreground chart không bị đơ (ghi nhận thời gian) | P1 |
| K-09 | Tên bảng/cột phân biệt HOA-thường; ký tự cần backtick | Qualify + quote đúng; không "must be qualified" | P1 |

## SUITE L — MÁY MÓC SERVING EDGE (bổ sung)

| ID | Bước | Kỳ vọng | Ưu tiên |
|---|---|---|---|
| L-01 | 1 BQ datasource dùng cho **2 dataset**, chỉ 1 dataset bật ý định materialize | Chỉ dataset đó build; dataset kia chạy live — host resolve không kéo nhầm | P1 |
| L-02 | Dataset mà **bảng duy nhất là calendar** | Không cố materialize calendar; chart chạy (calendar inline) | P2 |
| L-03 | Chart bind tới **datasetId sai/đã xóa** (binding cũ) | Planner resolve qua base view HOẶC lỗi rõ; không đọc nhầm dataset khác | P0 |
| L-04 | Public link đang mở → DA **Refresh** giữa phiên (generation xoay) | Viewer đang xem không vỡ; lần fetch kế lấy generation mới nhất trọn vẹn (không nửa cũ nửa mới) | P0 |
| L-05 | Batch 1 trang có **cả chart blocked (F-MIX0) lẫn chart OK** | Chart OK vẫn render; chart blocked hiện message rõ; batch không fail cả trang | P0 |
| L-06 | **AI Bot / PDF export** trên dashboard có snapshot | Lấy data qua cùng đường planner (đồng số với tile); nếu KHÔNG qua planner → ghi nhận là gap cần vá | P1 |
| L-07 | Dataset **20+ bảng** có snapshot → mở chart | Fingerprint-check-on-read + generation resolve không gây chậm rõ rệt (đo ms) | P1 |
| L-08 | Model resync nền ĐANG chạy trong lúc render chart cùng dataset | Không lỗi/deadlock; chart trả số nhất quán | P1 |
| L-09 | **Embed link** (nếu dùng) trên dataset snapshot/federated | Đi đúng đường public + planner; filter-locked giữ; đồng số builder | P1 |
| L-10 | Cache poisoning: chart cùng cấu hình, 1 lần chạy live (TTL=0) + 1 lần snapshot | KHÔNG phục vụ chéo (cache key có `_exec_host` + generation + ttl mode) | P0 |

## LỊCH CHẠY GỢI Ý (2 devs)

1. **Ngày 1:** dựng fixtures (gồm F-GS-EDGE cho suite J) + ground-truth; Suite A + B.
2. **Ngày 2:** Suite C + D (ma trận ×3 fixture) + **J** (Sheets edge).
3. **Ngày 3:** Suite E (trọng tâm — cần quyền BQ console để xóa bảng) + F + **K** (BQ edge, cần bảng partition/view/location khác).
4. **Ngày 4:** Suite G + H + **L** (serving edge) + checklist I; tổng hợp báo cáo FAIL theo ID.

**Tổng:** 12 suite (A–L), ~100 case. Bắt đầu từ điểm xuất phát 2 nguồn (Sheets/BQ)
đi hết đường tới public link + sự cố. Suite J/K/L là các case "thực chiến" người
dùng hay đâm vào — đừng bỏ qua vì chúng là nơi số liệu sai âm thầm hay nấp.

Kèm theo: bộ tự động (golden harness + 4 behavior batteries — xem `TEST_PLAN.md`)
chạy TRƯỚC khi dev test tay, để loại sớm regression máy bắt được.
