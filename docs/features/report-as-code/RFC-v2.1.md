# RFC v2.1 (DELTA): Report as Code — Security, AI-Binding, Vibe Workflow, Quality Gates, POC

> **REVIEW & PLAN ONLY.** Chưa code/migration/commit/PR/merge/deploy. Working-tree, chưa commit.
> **Đây là DELTA trên RFC v2** (`RFC-v2.md`) — chỉ bổ sung/làm sâu 5 nội dung PO yêu cầu; không
> lặp lại phần v2 đã đúng. Kiến trúc tổng (Report-level Artifact + Sandboxed Runtime + Data SDK
> + BI Core bất biến) **đã được PO chấp thuận** và giữ nguyên.
>
> Repo `QuangChinhDE/appbi-ai` · `demo` · HEAD `2201527e` · 2026-11-03 · `[V]`=đọc code `[I]`=suy luận `[U]`=chưa verify
>
> **North Star:** tự do & nhanh như vibe coding, dữ liệu luôn đáng tin & do BI Core quản trị.

---

## Architecture Delta so với v2 (tóm tắt thay đổi)
1. **Security §1:** xác thực postMessage KHÔNG dùng `event.origin` (iframe opaque-origin ⇒ origin=`"null"`); chuyển sang **MessageChannel handshake một lần**. Làm rõ "arbitrary JS dưới CSP nghiêm" = **served-file `script-src 'self'`, cấm inline**, extractor tách inline-script của AI.
2. **AI-Binding §2:** luồng AI→data **build thẳng trên `report_starter_service.py` pattern đã có** (enumerate-from-semantic → AI order/pick-by-id → run-before-keep → mint binding). Không engine thứ hai — đã verify prior art.
3. **Vibe workflow §3:** thêm **stable data-slot anchors + scoped region diff** để sửa-từng-vùng chính xác.
4. **Quality gates §4:** thêm 5 nhóm KPI sản phẩm + benchmark báo cáo KPI HTML.
5. **POC §5:** chốt **một vertical slice tối thiểu** chứng minh cả 3 trụ, đồng bộ dependency↔gate.

---

## 1. Security Contract (hoàn thiện)

### 1.1 Vấn đề: iframe untrusted có origin = `"null"` (opaque)
Sandbox đúng = `sandbox="allow-scripts"` **không** `allow-same-origin` ⇒ document mang **opaque
origin**, `event.origin` của mọi message từ nó là chuỗi `"null"`. **Không thể** dùng cách của
Studio (`e.origin === window.location.origin`, `preview-mode.ts:55`) vì (a) origin là "null",
(b) nhiều iframe "null" không phân biệt được nhau, (c) bất kỳ context "null" nào khác cũng giả
được. ⇒ **origin-matching vô dụng cho surface này.**

### 1.2 Giải pháp: MessageChannel capability handshake (không origin-matching)
```
Host (trusted) khi mount iframe:
  1. tạo  const {port1, port2} = new MessageChannel()
  2. iframe.onload → iframe.contentWindow.postMessage(
        {type:'rac:init', v:1}, /*targetOrigin*/ '*', [port2])   // chuyển port2 vào sandbox
  3. mọi comms sau đó CHỈ qua port1 (host) ↔ port2 (sandbox). port = capability:
     không context nào khác giữ port2 ⇒ không giả được; không cần kiểm origin.
  4. host vẫn schema-validate + version mọi message trên port (chống artifact độc tự gửi rác).
Sandbox:
  window.addEventListener('message', e => { if(e.data?.type==='rac:init'){ port=e.ports[0]; ... }})
  // chỉ chấp nhận init MỘT lần; port đến từ parent qua transferable.
```
- `targetOrigin:'*'` ở bước init **chấp nhận được** vì payload init **không** chứa bí mật (chỉ
  trao port); nếu cần chặt hơn: đặt iframe trên một **origin artifact chuyên biệt** (vd
  `reports.<app-domain>`) và dùng targetOrigin đó.
- **Không token/cookie** đi qua port, bao giờ. Dữ liệu chỉ là `ReportDataDTO` (v2 §3.3).
- Host coi mọi message trên port là **untrusted input**: validate type/version/shape; rate-limit
  `requestData`; reject message thứ hai mang `rac:init`.
- Đây là nâng cấp so với `isStudioMessage` (origin-based, cho trusted) → **channel-based, cho
  untrusted** — khác biệt trust model được tôn trọng.

### 1.3 "Arbitrary JS dưới CSP nghiêm" — mâu thuẫn biểu kiến, cách giải
CSP nghiêm (`default-src 'none'`) **cấm** `'unsafe-inline'`/`'unsafe-eval'`. Nhưng AI/user viết
JS tự do. Giải: **không chạy inline, chạy từ file served.**
```
CSP cho tài liệu artifact (set bởi BACKEND route serve artifact, mirror public.py:3130):
  default-src 'none';
  script-src  'self' <self-hosted-viz-origin>;    // 'self' = origin artifact chuyên biệt
  style-src   'unsafe-inline';                     // CSS tự do an toàn (không exfil)
  img-src     data: <img-allowlist>;
  font-src    <self-hosted-viz-origin>;
  connect-src 'none';                              // chặn mọi fetch/XHR/WebSocket ra ngoài
  frame-ancestors <app-origin>;                    // chỉ app được nhúng
  base-uri 'none'; form-action 'none';
```
- **Publish-time extractor** `[I]`: AI/user có thể viết `<script>...</script>` inline; khi **lưu/
  publish**, backend **tách toàn bộ inline JS ra file `artifact.js` served từ origin artifact** và
  thay bằng `<script src="artifact.js">`. Inline `<script>` còn sót ⇒ CSP tự chặn (fail-safe
  kép: extractor + CSP). Event handler inline (`onclick=`) cũng bị cấm bởi CSP ⇒ hướng dẫn AI
  dùng `addEventListener` (prompt constraint) + validator cảnh báo.
- **`connect-src 'none'`** là then chốt chống exfiltration (T2): JS có thể chạy tùy ý *tính toán*
  nhưng **không gửi được dữ liệu đi đâu** và **không tải được gì ngoài** script-src/img-src
  allow-list. Dữ liệu duy nhất vào/ra là qua MessageChannel (port), do host kiểm soát.
- **Resource budget (T6):** host áp timeout "settled" (mẫu Studio settled), cap số rows đẩy vào
  (mẫu `MAX_ROWS_IN_SCOPE=1000`, `js_evaluator.py:43`), cap kích thước artifact/asset; iframe treo
  → host unmount.
- **`[U-6]`** cần xác minh ở P0: `connect-src 'none'` có chặn font/asset nội bộ của viz lib đã
  pin không → nếu có, nới `font-src`/`img-src` đúng origin self-hosted, **không** nới `connect-src`.

### 1.4 Threat coverage map (bổ sung v2 §3.2)
| Threat | Thêm/đổi ở v2.1 |
|---|---|
| T1 token theft | opaque-origin + token không qua port |
| T2 exfiltration | **`connect-src 'none'`** (mới, rõ) |
| T4 load lạ | **`script-src 'self'`+pin, extractor tách inline** (mới) |
| T7 postMessage giả | **MessageChannel port = capability** thay origin-match (mới) |

---

## 2. AI-to-Data Binding (build trên prior art đã verify, KHÔNG engine thứ hai)

### 2.1 Prior art đúng để kế thừa — `report_starter_service.py` **[V]**
Docstring (`:1-21`) nói thẳng: *"NOT a second report system: every chart is created through
`ChartService.create` exactly as the Explore editor would."* Luồng đã production:
1. **Enumerate từ SEMANTIC MODEL** — measures (format+aggregation) + dimensions (time/category),
   *"never from raw column names or guesses"* (`enumerate_candidates`, `:96`; refuse nếu dataset
   chưa có model, `:272`).
2. **Run-before-keep** — mỗi candidate chạy qua chart engine (`_runs`→`preview_chart_data`, `:163`),
   giữ chỉ khi trả rows có số.
3. **Model chỉ ORDER + NAME theo id** từ danh sách được đưa, *"never invents a field"*
   (`_model_order`, `:203`); fallback deterministic offline (`:183`).

→ **Đây chính là mô hình governance cho AI-to-Data.** Report-as-Code tái dùng nguyên tắc, mở rộng
output từ "dashboard tile" sang "binding manifest".

### 2.2 Luồng AI→Binding cho Report-as-Code
```
(1) AI đọc Semantic Model (KHÔNG raw schema): tái dùng enumerate_candidates + semantic
    discovery AI-bot đã có (search_business_assets / discover pack — dashboard_ai_bot,
    agent_flows/tools/packs/discover.py). AI thấy measures/dimensions ĐÃ KHAI BÁO + format,
    không thấy bảng/cột thô, không thấy SQL.
(2) AI CHỌN/SẮP một tập candidate chart-query theo goal — BẰNG ID, từ danh sách enumerated;
    hoặc yêu cầu một config mới trong biên semantic (measure×dimension×grain hợp lệ).
(3) Backend VALIDATE + RUN mỗi pick qua ChartService (create/preview, run-before-keep).
    Pick không ra số / vượt quyền ⇒ loại, không thành binding.
(4) Backend MINT Binding Manifest: bindingId(opaque) → {chartId, scope, allowed filters}.
    AI/artifact KHÔNG bao giờ thấy chartId/datasetId/SQL.
(5) AI sinh HTML report với DATA-SLOT tham chiếu bindingId (vd <div data-rac-bind="b1">).
    Runtime: SDK xin data theo bindingId → host resolve manifest → get_chart_data dưới
    EffectivePrincipal người xem → ReportDataDTO → port → sandbox render.
```
**Ràng buộc governance (cứng):**
- AI **không viết SQL, không chọn dataset/datasource tự do, không invent field** — chỉ chọn trong
  candidate đã enumerate từ semantic model (kế thừa `:203`).
- Binding resolve + permission check **host/backend-side mỗi lần** (v2 §3.3) — binding là *tham
  chiếu đã-cấp-quyền*, không phải query do sandbox điều khiển.
- **Không query engine thứ hai, không đường vòng governance** — mọi số qua `ChartService`/
  `get_chart_data` như Explore. Đây là ràng buộc #3 của PO, đã thỏa bằng tái dùng path verified.
- `[U-3]` filter→binding nối vào filter engine hiện có: re-verify `filter_propagation.py` trước P3.

### 2.3 "AI tự hiểu Semantic Model" — ranh giới
AI đọc **ý nghĩa đã khai báo** (measure "Doanh thu" kind=currency agg=sum; dimension "Bang"
category), không đọc cột thô → tránh AI đoán sai aggregation/field. Nếu goal cần config chưa có,
AI **đề xuất** config trong biên semantic; backend chạy thử; không hợp lệ ⇒ AI phải chọn lại,
không được "tự chế" SQL. Semantic correctness do BI Core phán, không do AI.

---

## 3. AI Vibe Design Experience (end-to-end workflow)

### 3.1 Workflow
```
Prompt (NL) ─▶ [AI Plan] hiểu goal + đọc semantic model (§2.1) + chọn bindings (§2.2)
            ─▶ [AI Generate] sinh full-page HTML/CSS/JS freeform với data-slots (bindingId)
            ─▶ [Validate+Mint] backend run-before-keep bindings, extractor tách inline-JS,
               CSP profile, validator (allow-list viz lib, cấm connect lạ)
            ─▶ [Live Preview] Studio harness @1440/820/390, data thật dưới quyền người soạn
            ─▶ [Iterate]  (a) AI edit theo prompt vùng chỉ định  (b) Source edit trực tiếp
            ─▶ [Draft→Publish] atomic, immutable version (v2 §4)
Upload path: HTML/screenshot/website-ref ─▶ AI tái tạo layout ─▶ gắn data-slots vào semantic
```

### 3.2 Sửa-từng-vùng CHÍNH XÁC (PO đặc biệt quan tâm)
Vấn đề: AI sửa "khu KPI" không được làm hỏng phần còn lại / không re-generate cả trang.
Cơ chế:
- **Stable region anchors:** mỗi vùng/section mang id ổn định `data-rac-region="kpi-row"` do AI
  gán khi sinh; data-slot mang `data-rac-bind`. Anchor **bất biến qua các lần sửa** (giống cách
  planner V2 giữ "forgotten report headline stays first" — ổn định hóa bằng key, không recompile
  toàn bộ).
- **Scoped diff, không full regen:** lệnh "đổi KPI sang 2 cột" → AI chỉ nhận + trả **subtree của
  region đó** (HTML/CSS/JS phạm vi region), host **merge theo anchor**, phần ngoài region **giữ
  nguyên byte-for-byte**. Kế thừa triết lý V2 "mặc định đổi *how it looks*, không đổi *where
  things are* trừ khi lời yêu cầu đòi" (`dashboard-ai-design-v2/intent.md`).
- **Binding bất biến khi chỉ sửa presentation:** sửa giao diện **không** đổi bindingId/semantic —
  kế thừa "no write path to semantics" của `presentation_planner`. Đổi data = thao tác riêng,
  tường minh, qua §2.
- **Diff review + undo:** mỗi AI edit tạo một draft revision (version++), hiện diff vùng, undo =
  bỏ revision (mẫu AI-block draft-only + Undo/Redo của Studio V3).
- **Vision-review tùy chọn:** tái dùng vòng vision-review (render→1 call rubric→repair qua
  allow-list) cho fidelity, **advisory**, không tự ghi semantic.

### 3.3 Source editing (Q4, trong v1)
Người dùng xem/sửa `source_html/css/js` trực tiếp; mỗi save = draft version; validator+extractor+
CSP chạy như AI path (cùng một cổng validate, không hai đường). Preview tức thì qua harness.

---

## 4. Product Quality Gates (bổ sung)

Benchmark thị giác: **báo cáo KPI HTML tham chiếu** (data-services.pages.dev/demos/bao-cao-kpi) —
chuẩn về *trải nghiệm* (layout app, sidebar/nav, KPI cards, heatmap/gauge/waterfall, drill, so
sánh kỳ, responsive), **không** copy data/brand.

| Nhóm | Chỉ số | Ngưỡng đề xuất (chốt với PO) | Đo thế nào |
|---|---|---|---|
| **G1 Tốc độ tạo** | Time-to-first-report (prompt→preview có data) | p50 ≤ 60s, p95 ≤ 120s `[U]` | instrument thời gian plan+generate+run-bindings |
| | Time-to-region-edit (lệnh→preview) | p50 ≤ 15s | timer scoped-diff |
| **G2 Visual fidelity** | Khoảng cách thị giác vs benchmark (layout/nav/KPI/special visuals) | reviewer rubric ≥ 4/5; vision-review score advisory | vision-review + human @1440/820/390 |
| | Preview == Publish == Public (3 bề mặt khớp) | pixel/structure parity PASS | screenshot 3 nơi, diff |
| **G3 Design freedom** | Dựng được visual **ngoài** Native Widget list (vd waterfall/heatmap/custom SVG) | ≥ N mẫu benchmark dựng được freeform | checklist benchmark |
| | Không bị ép về layout primitive/grid | report-level full-page PASS | §POC test 1 |
| **G4 Semantic correctness** | Mọi số khớp số BI Core (cùng filter) | 100% khớp; **0** số do AI/JS bịa | so DTO vs get_chart_data; negative: AI không đổi được metric |
| | Không SQL/dataset-id rò vào sandbox | 0 occurrence | assert DTO shape (v2 §3.3) |
| | Filter/drill ra đúng scope | 100% đúng | e2e |
| **G5 Preview/Publish parity & an toàn** | Immutable published; viewer không thấy draft | PASS | v2 §4 |
| | Public: 0 authed call; CSP/sandbox áp đúng | PASS | invariant `public_client_only`; DevTools |
| | Rollback về version cũ đúng | PASS | e2e |

Gate: G4 + G5 là **bắt buộc PASS** (governance/an toàn); G1–G3 là **chất lượng sản phẩm**, ngưỡng
chốt với PO, dùng để quyết mở rộng.

---

## 5. POC Alignment — Minimal Vertical Slice

### 5.1 Nguyên tắc
Một slice **mỏng, dọc**, chạm cả 3 trụ — **AI Design + BI-governed Data + freeform presentation**
— trên production image, dữ liệu **Olist**. Native-slot NGOÀI slice (v2 D-4). Full-page report-
level TRONG slice (kiến trúc chính).

### 5.2 Slice tối thiểu (đồng bộ dependency ↔ gate)
| Bước (map phase v2) | Chứng minh trụ | Gate liên quan |
|---|---|---|
| S0 (P0) iframe opaque-origin + MessageChannel + CSP; vẽ 1 KPI từ DTO bằng viz lib pinned | **freeform presentation** an toàn | T1/T2/T4/T7; §1 |
| S1 (P1) 1 prompt → AI chọn 2–3 bindings từ semantic model (run-before-keep) → mint manifest | **AI Design + governed data** | G4 semantic; §2 |
| S2 (P1) AI sinh **full-page** report (sidebar + KPI row + 1 custom visual ngoài Native list, vd mini-waterfall/heatmap SVG) với data-slots | **freeform + report-level** | G3; test "không grid" |
| S3 (P1/P2) Draft→Publish atomic immutable + render trên `/d` qua branch mới, publicClient | parity + an toàn | G5; `public_link_security` |
| S4 (P3 slice) 1 slicer trang + 1 drill cập nhật DTO đúng scope | **governed interactivity** | G4 filter; Q5 READ |
| S5 (P4 slice) 1 lệnh sửa-vùng ("KPI 2 cột + sparkline") đổi đúng region, số **không** đổi | **AI iterate chính xác** | §3.2; G4 negative |

### 5.3 Acceptance gate POC (mở rộng điều kiện)
- S0–S5 PASS trên **production image** tại một HEAD ghi rõ.
- `verify.py task` xanh (paths đã đổi); semantic-guard + `public_link_security` PASS.
- **G4 + G5 toàn PASS**; G1–G3 đạt ngưỡng chốt với PO (ít nhất đo được & trong tầm).
- Threat T1/T2/T4/T7 có test tự động; connect-src/opaque-origin chứng minh bằng DevTools.
- **Verify-with-browser** (không chỉ đọc source).
- Thiếu bất kỳ ⇒ không mở rộng.

---

## 6. Open Decisions (còn cần PO/reviewer)
- **[O-1] Origin cho artifact:** một **origin chuyên biệt** (`reports.<domain>`) cho sandbox vs
  `srcdoc`/blob opaque. Origin riêng cho CSP `script-src 'self'` sạch + cache viz lib; cần
  cấu hình hạ tầng/CDN. (Khuyến nghị: origin riêng cho production.)
- **[O-2] Viz lib allow-list cụ thể** (`[U-5]`): chọn 1–2 (vd ECharts cho special visuals + D3
  cho custom) — license, bundle size, có cần network không (`[U-6]`). Chốt ở P0.
- **[O-3] Ngưỡng G1–G3** (tốc độ/fidelity/freedom): số cụ thể cần PO chốt.
- **[O-4] Phạm vi "config mới" AI được đề xuất** (§2.3): chỉ chọn candidate có sẵn, hay được tạo
  measure×dimension×grain mới trong biên semantic (cần chạy thử nhiều hơn → ảnh hưởng G1 tốc độ).
- **[O-5] Capability write API** (v2 D-5/P6): phạm vi ghi nghiệp vụ nào cho v1 (hay v1 chỉ READ)?

## 7. Implementation Readiness Verdict
- **Kiến trúc: READY để vào implementation planning.** Ba trụ có đường đi đã-verify prior art:
  sandbox (opaque-origin+MessageChannel+CSP, §1), governed AI-binding (`report_starter` pattern,
  §2 `[V]`), freeform presentation (self-hosted viz + full-page branch).
- **Chưa phải READY-to-code:** cần đóng `[U-3..7]` + `[O-1..5]`, và mỗi phase medium/large vẫn
  phải qua `docs/features/.../{intent,spec,plan}.md` + human approval trước code (quy trình repo).
- **Rủi ro còn cao nhất:** (1) full-page render branch mới ở `/d` không được chạm contract public
  cũ (backward-compat, v2 §7); (2) tốc độ G1 phụ thuộc chi phí run-before-keep nhiều candidate +
  LLM latency — cần đo sớm ở POC; (3) `connect-src 'none'` × viz lib (`[U-6]`).
- **Khuyến nghị:** phê duyệt **POC vertical slice §5** trước; chỉ mở rộng sản phẩm khi G4+G5 PASS
  và G1–G3 đạt ngưỡng. Native-slot (P7) và capability-write (P6) tách khỏi POC.

> **Kết:** v2.1 không mở rộng bề mặt tấn công hay phá governance để đạt North Star. Tự do
> presentation nằm trong một sandbox opaque-origin không-mạng; mọi số đi qua BI Core như Explore;
> AI chỉ chọn trong biên semantic đã khai báo. "Vibe coding cảm giác tự do" + "dữ liệu đáng tin"
> cùng lúc là khả thi với các cơ chế đã-có-prior-art trong chính repo này.
