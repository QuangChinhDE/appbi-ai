# RFC: Report as Code / AI Vibe Design — Architecture Review & Implementation Plan

> **Trạng thái: REVIEW & PLAN ONLY.** Chưa có code, migration, commit, PR hay deploy.
> File này nằm trong working tree, chưa commit. Dùng để chuyển cho một reviewer độc lập
> và Product Owner đánh giá trước khi phê duyệt triển khai.
>
> - Repo: `QuangChinhDE/appbi-ai` · Nhánh khảo sát: `demo` · HEAD: `2201527e`
> - Ngày: 2026-11-02
> - Mọi dẫn chứng `file:line` được đọc trực tiếp từ code tại HEAD trên. Phần **[VERIFIED]**
>   là đã đọc code; **[INFERRED]** là suy luận có cơ sở nhưng chưa đọc hết, ghi rõ.

---

## A. Executive Verdict

### A.1 Kết luận một dòng

**Khả thi, nhưng khung vấn đề trong brief đã lỗi thời so với code hiện tại.** AppBI *không
còn* chỉ là "kéo thả Chart". Nửa "AI thiết kế presentation từ dữ liệu" trong tầm nhìn của
anh **đã được xây và đã ship** (Report Experience PR #5/#6, Report Studio V3 PR #7,
Dashboard AI Design v2). Phần thực sự *mới* là **freeform code** — upload HTML/CSS/JS/React,
sửa source trực tiếp, AI viết markup tự do bind dữ liệu thật — và đây là phần mà kiến trúc
hiện tại **cố ý từ chối làm** vì lý do bảo mật/governance.

### A.2 Khuyến nghị kiến trúc (điều quan trọng nhất)

Không xây "freeform codegen chạm vào semantic". Thay vào đó:

> **Report as Code = một RUNTIME iframe sandboxed, nhận dữ liệu qua một DATA SDK (postMessage
> bridge) đứng trên hợp đồng `ChartDataResponse` đã có, KHÔNG có đường ghi vào semantic/SQL/
> security.** AI (hoặc người dùng) viết HTML/CSS/JS tự do *bên trong hộp cát đó*; dữ liệu,
> metric, filter, quyền vẫn do BI Core cấp qua một API hẹp, đã được scope sẵn.

Lý do đây là lựa chọn đúng (xem §D để so sánh phương án):

1. **Hợp đồng dữ liệu renderer-agnostic đã tồn tại** — `ChartDataResponse` = `{chart, data:
   List[Dict], pre_aggregated, time_completeness}` (`backend/app/schemas/schemas.py:550-563`).
   Đây chính là "SDK" cần — chỉ cần *đóng gói và phơi ra*, không cần phát minh query engine
   mới (ràng buộc bắt buộc #3 của anh: "không tạo Query Engine độc lập").
2. **Primitive sandbox đã tồn tại trong repo** — không phải xây từ số không:
   - Sandboxed-iframe script-less phục vụ qua CSP: `public.py:3130`
     (`"Content-Security-Policy": "default-src 'none'; sandbox"`),
     `modules/metadata_catalog/api.py:708`.
   - Sandbox thực thi JS server-side: **QuickJS** (`modules/workboards/services/js_evaluator.py`)
     — deny-list `eval/Function/globalThis/setTimeout`, timeout 1000ms/row, không `require/
     fetch/process/fs` (`js_evaluator.py:1-43`).
   - Hạ tầng CSP `frame-ancestors` + chính sách framing theo origin đã production:
     `frontend/src/lib/embed-framing.ts` (fail-closed, per-grant allowlist).
   - **Harness preview iframe + `postMessage`** đã chạy: Report Studio V3 render builder
     route trong iframe theo đúng device-width, state truyền qua `postMessage`
     (`lib/studio/preview-mode.ts`, `StudioPreview.tsx`). Đây gần như *chính là* data-bridge
     cần cho Report-as-Code, chỉ đảo chiều.
3. **Đã có precedent governance "AI không bao giờ phát ra code thực thi"** —
   `dashboard_presentation_planner.py:31-108` ép LLM trả *typed plan*, cấm sinh HTML/CSS/React,
   cấm chạm dataset/measure/filter; validator + layout engine phía client áp dụng
   ("a compromised or hallucinating model cannot damage a dashboard from here. It has no write
   path."). Report-as-Code phải **kế thừa nguyên tắc "no write path to semantics"** này, chỉ
   nới trust model ở tầng *trình bày* trong hộp cát.

### A.3 Những gì KHÔNG nên làm, và tại sao

| Không làm | Lý do |
|---|---|
| Để AI viết HTML/JS chạy với quyền truy cập BI Core không kiểm soát | Vi phạm ràng buộc #6; không có boundary bảo mật |
| Mở rộng pathway `html_fragment` hiện tại cho JS/live-data | `html_fragment` là **static, không data-bound**, sanitize allow-list *không phải* sandbox thực thi (`html_fragment_sanitizer.py` strip hết `script/style/iframe`, render `dangerouslySetInnerHTML` — `DashboardWidget.tsx:229-299`). Nó an toàn *vì* không chạy gì. Thêm JS vào đây là phá chính mô hình an toàn của nó. |
| Ép mọi HTML Report convert thành native widget | Vi phạm ràng buộc #5; và `dashboard_html_import_service.py` (6717 dòng) đi theo hướng này đã bị **PARKED** (memory `dashboard_html_import_rework_parked`, gap "DOMParser has no CSSOM") |
| Build query/data engine thứ hai cho report code | Vi phạm ràng buộc #3; `ChartService.get_chart_data` (`chart_service.py:4475+`) đã là pipeline chín (single-flight, snapshot TTL, authoritative-filter). Tái dùng, đừng nhân bản. |
| Cho AI sửa trực tiếp file semantic protected | `.claude/rules/semantic-layer.md` + guardrail `protected`. Report-as-Code chỉ *đọc* qua API công khai đã scope. |
| Rewrite Native Dashboard Builder | Vi phạm ràng buộc #4. Native Builder và Report-as-Code là hai mặt, chia chung Data/Chart/Publish Core. |

---

## B. Current Architecture — As Built

### B.1 Pipeline render dashboard/report **[VERIFIED]**

```
Dashboard (models.py:151-280)
  ├─ draft_snapshot JSON (:238-252)  ── bản nháp per-author + shared; publish → ghi đè cột live
  ├─ last_published_at (:256-260)    ── token optimistic-concurrency (chống clobber, KHÔNG phải rollback)
  ├─ filters_config / slicers_config / slicer_cluster_layout (:161-190)
  └─ DashboardChart[] (:344-379)      ── 1 tile = 1 row
       ├─ layout {x,y,w,h}
       ├─ widget_type ∈ {chart,text,countdown,image,shape,parameter_switcher,
       │                  section_header,callout,hero_strip,narrative,html_fragment,slicer}
       ├─ widget_config JSON          ── cho widget non-chart (vd html_fragment.html)
       └─ parameters                  ── filter/param per-tile

Frontend:
  DashboardWidget.tsx  ── switch(widget_type) (:24-72) → renderer mỗi loại
    └─ widget_type="chart" → ChartPreview.tsx (1110 dòng, monolithic; import TableVisualization,
                              KpiCard, color/theme helpers)   ← MỌI chart type trong 1 component
    └─ widget_type="html_fragment" → dangerouslySetInnerHTML (:229-299)  ← static, không data
```

Hợp đồng dữ liệu tile (điểm tái dùng then chốt) **[VERIFIED]**:
`ChartDataResponse` (`schemas.py:550-563`) = `{chart: ChartResponse, data: List[Dict[str,Any]],
pre_aggregated, debug?, time_completeness?}` — **plain JSON rows + metadata, độc lập với chart
type**. Đây là thứ một custom renderer cần, đã có sẵn.

### B.2 Chart Engine **[VERIFIED (một phần)]**

- `ChartService.get_chart_data` (`chart_service.py:4475+`, file 5040 dòng) — entry điểm duy
  nhất: single-flight de-dup, snapshot TTL (realtime vs stale-serve), granularity override,
  logging contextvar. **Pipeline chín — không nhân bản.**
- `chart_contracts.py` (738 dòng) — normalize filter, `refuse_unapplied_authoritative`,
  normalize metric/role. Đây là "contract" gần nhất nhưng là *query semantics*, **không phải
  adapter render**.
- **Không có adapter boundary ở frontend** giữa "chart data" và "chart rendering":
  `ChartPreview.tsx` (1110 dòng) sở hữu trực tiếp mọi native chart type. **[INFERRED]** nội
  bộ là big-switch, nhất quán với "fat component" của repo.

### B.3 Semantic & query boundary **[VERIFIED + rule-flagged]**

File protected (`.claude/rules/semantic-layer.md`): `chart_contracts.py`,
`chart_semantic_service.py`, `chart_service.py`, `semantic_query_engine.py`,
`semantic_join_resolver.py`, `api/public.py`. Mọi đường data của Report-as-Code tái dùng
các file này phải qua `guardrail_check.py` trước khi sửa. Nhưng **không cần sửa chúng** nếu
chỉ gọi qua API đã phơi.

### B.4 Filters / parameters / cross-filter **[INFERRED/PARTIAL]**

`filters_config`, `slicers_config`, `slicer_cluster_layout` ở cấp dashboard; `DashboardChart.
parameters` per-tile. Runtime propagation (`filter_propagation.py`, protected) **chưa đọc hết
lần này** — tham chiếu memory (`dashboard_filter_dual_path`, `filter_engine_convergence_plan`)
nhưng phải re-verify trước khi dựa vào chi tiết. Ý nghĩa cho RFC: filter đã enforce **server-
side** (xác nhận ở public, §B.6), nên Report-as-Code nhận rows *đã* scope, không tự filter.

### B.5 Draft/Publish lifecycle **[VERIFIED (schema-level)]**

Draft/live chung một bảng: `draft_snapshot` → promote sang cột live + rows `DashboardChart`
khi Publish. `DashboardPublicLink.stage` (`draft`/`published`, `:324-330`) cho link workboard.
**Không thấy bảng version-history/rollback đầy đủ** — Publish ghi đè, `last_published_at` chỉ
chống clobber đồng thời, không cho rollback về version tùy ý. Report Studio V3 đã bổ sung
lifecycle AI-block (draft-only rows, Discard xóa, Undo/Redo) nhưng vẫn không phải full
versioning. **→ Cờ cho RFC: versioning/rollback cho artifact code cần hạ tầng mới (§C, §E).**

### B.6 Public link / embed **[VERIFIED]**

`api/public.py`: `GET /dashboards/{token}/charts/{chart_id}/data` (`:3893`),
`GET /dashboards/{token}` (`:1803`), scoping server-side (`_public_chart_filters`,
`_public_page_scope_by_chart`, `_shape_public_structure`). `publicClient`-only enforce bởi
`.claude/rules/frontend.md` + guardrail `public_client_only`. **Hệ quả cứng: bất kỳ bề mặt
Report-as-Code nào render trên `/d/[token]` PHẢI fetch qua đúng public API này — tái dùng là
bắt buộc, không phải tùy chọn.**

### B.7 Bề mặt thực thi code đã có **[VERIFIED — phát hiện quan trọng nhất]**

| Bề mặt | Bản chất | Bảo mật | Dùng được cho Report-as-Code? |
|---|---|---|---|
| `html_fragment` widget | HTML **tĩnh**, không data-bound | Allow-list sanitizer x2 (`html_fragment_sanitizer.py`), `dangerouslySetInnerHTML`, **không** iframe/CSP | Không — an toàn *vì* không chạy gì |
| HTML import service (6717 dòng) | Convert HTML → native chart; phần dư → fragment tĩnh | Deterministic parse | PARKED; đi ngược ask ("live" vs "freeze") |
| **QuickJS evaluator** (`js_evaluator.py`) | JS server-side cho computed column Workboard | Deny-list, 1000ms/row, no net/DB | **Có — prior art sandbox JS tốt nhất repo** |
| **CSP sandboxed-iframe serving** (`public.py:3130`, `metadata_catalog/api.py:708`) | Phục vụ nội dung script-less trong iframe `sandbox` | `default-src 'none'; sandbox` | **Có — nền cho runtime iframe** |
| **Studio preview harness** (`preview-mode.ts`, `StudioPreview.tsx`) | iframe theo device-width, state qua `postMessage` | Builder route trong iframe | **Có — gần chính là data-bridge cần** |

### B.8 AI Design / Vibe Design đã ship **[VERIFIED — mâu thuẫn với giả định trong brief]**

Nửa "AI thiết kế từ prompt/reference" đã có, kiến trúc **ngược** với "AI viết HTML":

- `dashboard_presentation_planner.py:31-108` — LLM trả `PresentationPlan` (typed), **cấm**
  sinh HTML/CSS/React, **cấm** chạm dataset/dimension/measure/aggregation/filter/semantic;
  validator + layout engine client áp dụng. "It has no write path."
- `dashboard_presentation_critic.py` (141 dòng) — pass kiểm tra plan.
- Report Experience / Studio V3 (PR #5/#6/#7) đã có: **report-starter** từ semantic model;
  **Studio preview** before/after @1440/820/390 qua iframe+postMessage; **design directions**
  (executive/operations/editorial); **plan boundary** (drop số khỏi text, coerce layout
  primitive lạ); **vision review loop** (2 call, repair qua allow-list); **KPI context**;
  **lifecycle** draft-only + Undo/Redo; **responsive + PDF export**. (dẫn chứng:
  `docs/features/report-studio-v3/as-built.md`, `docs/features/report-experience/README.md`.)

> **Điều này buộc một quyết định PO (§G):** AppBI đã có mô hình "AI đổi trình bày trong một
> capability-schema có kiểm soát, không bao giờ phát code thực thi". Report-as-Code đưa vào
> một trust model **thứ hai, đối lập** (freeform-but-sandboxed). Hai mô hình cùng tồn tại được,
> nhưng phải cố ý, không được lẫn lộn.

---

## C. Gap Analysis & Technical Debt

Ưu tiên theo tác động thực: **P0** chặn Report-as-Code; **P1** cần cho sản phẩm thật; **P2** polish.

### Existing capabilities (tái dùng, đừng xây lại)
- [E1] Hợp đồng data renderer-agnostic `ChartDataResponse` **[VERIFIED]**
- [E2] Chart/query pipeline chín `ChartService.get_chart_data` **[VERIFIED]**
- [E3] Public data API đã scope server-side **[VERIFIED]**
- [E4] Sandbox JS (QuickJS) + CSP sandboxed-iframe serving + framing policy **[VERIFIED]**
- [E5] Harness preview iframe + postMessage (Studio V3) **[VERIFIED]**
- [E6] AI-plan→validate→apply governance (no write path) **[VERIFIED]**
- [E7] Draft/publish lifecycle + AI-block draft-only rows **[VERIFIED]**

### Missing capabilities
- [M0-P0] **Runtime thực thi code client-side sandboxed, data-bound live** — chưa tồn tại.
  `html_fragment` tĩnh; QuickJS là server-side per-row, không phải render UI. **Đây là đầu tư
  hạ tầng net-new lớn nhất.**
- [M1-P0] **Data SDK / postMessage contract** phơi `ChartDataResponse` cho code trong iframe,
  kèm filter/param/drill-down protocol — chưa đóng gói.
- [M2-P0] **Lưu trữ artifact code** (HTML/CSS/JS/asset) như một `widget_type` mới + ở public
  surface — chưa có schema.
- [M3-P1] **Versioning/rollback** cho artifact code (§B.5 — native cũng thiếu) — Report-as-Code
  *phải* có vì code dễ hỏng hơn config.
- [M4-P1] **Chế độ sửa source + code editor + iterative AI edit** — chưa có.
- [M5-P1] **Validation/scan AI-generated code** trước khi serve (CSP build, strip script
  ngoài allow-list origin, giới hạn network) — chưa có cho surface này.
- [M6-P2] **Upload HTML/screenshot/website-reference → AI tái tạo** — một phần có ở HTML import
  (parked) nhưng không cho live runtime.

### Technical debt (xử lý trước/khi mở rộng)
- [D1] `ChartPreview.tsx` 1110 dòng monolithic, không adapter boundary → khó cho renderer thứ
  hai tái dùng từng chart. **Không refactor như side-effect** (ràng buộc repo). Thay vào đó
  Report-as-Code bind ở tầng *data* (E1), không tầng component.
- [D2] HTML import service 6717 dòng PARKED, gap CSSOM → **không dựa vào**; coi như dead-end
  cho hướng mới.
- [D3] Fat routers (`datasets.py` ~6950, `public.py` ~4600, `dashboards.py` ~2960) — logic
  mới vào `services/**`/`modules/**`, không nhồi router.
- [D4] Không có full version table cho dashboard → thiết kế versioning của Report-as-Code nên
  đứng riêng, không chờ refactor native.

### Security risks
- [S1-P0] **Thực thi code AI/người dùng = bề mặt tấn công mới.** Bắt buộc: iframe `sandbox`
  (không `allow-same-origin` với origin app), CSP `default-src 'none'` + allow-list hẹp,
  data chỉ qua postMessage (không `fetch` trực tiếp tới API từ trong hộp cát). Tái dùng mẫu
  `public.py:3130`.
- [S2-P0] **Token/credential leak:** code trong iframe **không bao giờ** thấy auth cookie
  hay token. Host page fetch (publicClient/apiClient tùy surface) rồi *đẩy rows* vào iframe.
  Khớp ràng buộc `public_client_only`.
- [S3-P1] **Scope bypass:** code không được tự chọn dataset/filter ngoài phạm vi cấp. Host
  quyết định binding; iframe chỉ nhận kết quả đã scope (E3).
- [S4-P1] **Supply-chain qua lib viz bên thứ ba** AI nhúng (CDN) → chặn bằng CSP origin
  allow-list, hoặc bundle self-hosted.

### Compatibility risks
- [C1-P0] Không được phá `/d` và `/embed` hiện tại (ràng buộc #1) → Report-as-Code là
  `widget_type`/surface **mới, thêm vào**, không đổi contract cũ.
- [C2-P1] `publicClient`-only phải giữ trên mọi path public của surface mới.

### Performance risks
- [P1perf] Mỗi iframe runtime = chi phí mount/isolation. Giới hạn số artifact/trang; tái dùng
  harness "settled" của Studio V3 để biết khi nào render xong.
- [P2perf] Code AI O(n²) trên rows lớn → giới hạn rows đẩy vào (mẫu `MAX_ROWS_IN_SCOPE=1000`,
  `js_evaluator.py:43`) + timeout.

---

## D. Target Architecture

### D.1 Nguyên tắc: tách Data Plane và Presentation Plane

```
┌─────────────────────── HOST (app/d/embed page, TRUSTED) ───────────────────────┐
│  Data Plane  (BI Core — KHÔNG đổi)                                              │
│    ChartService.get_chart_data / public.py chart-data endpoint                 │
│    → ChartDataResponse {chart, data[], pre_aggregated, time_completeness}      │
│    filter/param/scope/permission/RLS enforce SERVER-SIDE                        │
│         │                                                                       │
│         │  host fetch (apiClient trên builder / publicClient trên /d,/embed)    │
│         ▼                                                                       │
│    ┌─ Report Data SDK (postMessage bridge) ─ hợp đồng hẹp, versioned ─┐         │
│    │   host → iframe:  {type:'data', bindingId, rows, meta}           │         │
│    │   iframe → host:  {type:'request', bindingId}  // xin data đã scope│       │
│    │                   {type:'filter', ...}         // drill/cross-filter│      │
│    │                   {type:'resize', height}      // như Studio V3     │       │
│    └──────────────────────────────────────────────────────────────────┘        │
│         │  postMessage (structured clone — KHÔNG truyền hàm, KHÔNG token)        │
│  ┌──────▼──────────────── Presentation Plane (SANDBOXED, UNTRUSTED) ─────────┐  │
│  │  <iframe sandbox="allow-scripts" (KHÔNG allow-same-origin với origin app) │  │
│  │   srcdoc/blob, CSP: default-src 'none'; script-src <self-hosted bundle>;  │  │
│  │                     style-src 'unsafe-inline'; img-src data: <allowlist>  │  │
│  │   Artifact code: HTML/CSS/JS/React do AI hoặc người dùng viết             │  │
│  │   Chỉ nhận rows qua SDK; muốn chart native → gọi SDK 'render-native'      │  │
│  │   KHÔNG fetch, KHÔNG thấy cookie/token, KHÔNG chạm semantic/SQL           │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Điểm cốt lõi: **iframe sandbox KHÔNG chia origin với app** → dù code bị chèn độc, nó không
đọc được DOM app, không đọc cookie, không gọi API. Mọi dữ liệu đến *đã* được host scope theo
quyền người xem. Đây là mô hình `public.py:3130` đã dùng, nâng lên có data-bridge.

### D.2 Chart Core tái dùng theo nhiều renderer

Một chart đã cấu hình có thể hiển thị bằng: (a) Native Renderer (ChartPreview) như cũ;
(b) trong artifact code, bằng cách SDK trả `ChartDataResponse` để code tự vẽ (SVG/canvas/lib);
(c) hoặc "render-native-into-slot" — host render native chart vào một vùng do artifact chỉ
định (giữ tương tác/theme native). Cả ba **chung một Chart Configuration + Query Core** (E1,
E2) — không có engine thứ hai.

### D.3 Lưu trữ (bổ sung, không phá cũ)

- `widget_type="code_report"` mới trên `DashboardChart`, `widget_config` giữ `{artifactId,
  bindings:[{bindingId, chartId|datasetQuery}]}`. Code thực tế **không** nhồi vào
  `widget_config` (khác `html_fragment`) mà ở bảng artifact riêng để versioning.
- Bảng mới `ReportArtifact` (+ `ReportArtifactVersion`): `{id, source_html, source_css,
  source_js, assets, content_hash, created_by, validated_at, csp_profile}`. Additive, single
  head (ràng buộc migration repo).
- Public surface: thêm endpoint phục vụ artifact đã-validate dưới CSP sandbox (mẫu `:3130`),
  data vẫn qua `/dashboards/{token}/charts/{chart_id}/data` (`:3893`).

### D.4 Phương án thay thế đã cân nhắc (trade-off)

| Phương án | Ưu | Nhược | Verdict |
|---|---|---|---|
| **A. Sandboxed iframe + Data SDK** (khuyến nghị) | Isolation thật; tái dùng CSP/preview prior art; freeform thật; không chạm semantic | Chi phí iframe; cần SDK contract; versioning mới | **CHỌN** |
| B. Mở rộng `html_fragment` cho JS | Ít code | Phá mô hình an toàn "không chạy gì"; không isolation; XSS | Loại (A.3) |
| C. Convert HTML→native (mở rộng import service) | Dùng renderer native, không sandbox | Không "live/freeform"; service parked; CSSOM gap; ép convert (vi phạm #5) | Loại |
| D. Chỉ mở rộng Presentation Planner (schema-constrained, không code) | An toàn nhất; đã có | **Không đáp ứng** ask "viết HTML/JS tự do/sửa source" | Không đủ (nhưng giữ song song cho Native path) |
| E. Server-side render code (SSR trong QuickJS/Node sandbox) | Không tốn iframe client | QuickJS không có DOM; Node-sandbox = container/EOL nặng; vi phạm "không stack riêng mỗi report" (#7) | Loại cho v1 |

→ **A** là duy nhất thỏa mọi ràng buộc bắt buộc đồng thời cho freeform. **D giữ nguyên** làm
Native/AI-Design path (đã ship) — hai path chung Core.

---

## E. Implementation Roadmap

Nguyên tắc: bước nhỏ, verify độc lập, mỗi phase có rollback, không regression `/d` `/embed`.
Mọi phase medium/large phải qua `docs/features/<f>/{intent,spec,plan}.md` + human approval
*trước* code (quy trình repo). **Flag mới** `REPORT_AS_CODE_ENABLED=False` (mẫu
`WORKBOARDS_ENABLED`) để toàn bộ off mặc định.

### Phase 0 — Spike sandbox + Data SDK contract (P0, nền tảng)
- **Mục tiêu:** chứng minh một iframe sandboxed nhận `ChartDataResponse` qua postMessage và
  vẽ được, không fetch/không token.
- **Phạm vi:** `lib/report-sdk/*` (contract + host bridge, thuần, có contract-check script như
  `embed-framing.ts`); một iframe `srcdoc` demo; không DB, không migration.
- **Module tác động:** frontend lib mới; không chạm protected.
- **DoD:** rows render trong iframe; DevTools chứng minh iframe không có cookie/không gọi
  network tới API; contract-check script xanh. **Rollback:** xóa lib (chưa ai dùng).

### Phase 1 — Lưu artifact + widget `code_report` trên builder (P0)
- **Mục tiêu:** tạo/lưu/mở một code_report tile với code tĩnh + binding tới 1 chart đã có.
- **Phạm vi:** migration additive `ReportArtifact(+Version)`; `services/report_artifact_service.py`;
  endpoint builder (authed, gate `require_edit_access`); render qua Phase-0 SDK; validator CSP
  server-side (strip script ngoài allow-list; set `csp_profile`).
- **DoD:** tile lưu/tải; draft/publish lifecycle như AI-block; validator chặn script lạ (negative
  control); `verify.py task` xanh. **Rollback:** flag off; migration additive nên data cũ an toàn.

### Phase 2 — Public/embed render (P0, protected)
- **Mục tiêu:** code_report hiển thị trên `/d/[token]` và `/embed`, data qua publicClient.
- **Phạm vi:** endpoint public phục vụ artifact dưới CSP `default-src 'none'; sandbox` (mẫu
  `:3130`); SDK host dùng `publicClient`; **gate `public_link_security`**; semantic-guard review.
- **DoD:** public viewer thấy report; chứng minh **không** authed call từ public page
  (invariant `public_client_only`); filter/scope server-side vẫn áp; e2e public. **Rollback:**
  flag off → surface biến mất, dashboard cũ nguyên vẹn.

### Phase 3 — Filter / param / drill-down qua SDK (P1)
- **Mục tiêu:** code_report phản ứng filter trang + phát cross-filter/drill.
- **Phạm vi:** mở rộng SDK protocol (`filter`/`drill`); host nối vào filter engine hiện có
  (re-verify §B.4 trước); không engine mới.
- **DoD:** đổi filter trang → rows trong iframe cập nhật; drill phát đúng scope; e2e.

### Phase 4 — AI Vibe: sinh + sửa artifact qua prompt (P1)
- **Mục tiêu:** AI tạo/sửa code report từ prompt; iterative edit; upload HTML/screenshot ref.
- **Phạm vi:** dùng LLMClient; **AI chỉ ghi vào artifact code + binding, KHÔNG ghi semantic**
  (kế thừa nguyên tắc `presentation_planner`); validator + CSP build chạy trên output AI
  *trước* khi serve; vision-review loop tái dùng từ Studio V3.
- **DoD:** prompt → report chạy; "sửa phần này" đổi đúng vùng; mọi output AI qua validator;
  AI không đổi được metric/SQL (negative control). **Rollback:** flag off.

### Phase 5 — Code editor + source edit + versioning/rollback (P1→P2)
- **Mục tiêu:** sửa source trực tiếp; xem/rollback version.
- **Phạm vi:** `ReportArtifactVersion` history + UI editor + preview (Studio harness).
- **DoD:** sửa source → preview; rollback về version cũ; audit.

### Phase 6 — Thư viện viz self-hosted + polish responsive/PDF (P2)
- Bundle lib viz self-hosted (tránh supply-chain S4); responsive breakpoints; PDF export tái
  dùng `export-pdf`.

---

## F. Proof of Concept (cảm hứng báo cáo tham chiếu, dữ liệu thật đã cấp quyền)

**Bộ dữ liệu:** Olist (đã có trong môi trường, dùng cho report-experience evidence).

**POC phải chứng minh (tiêu chí cho phép mở rộng thành sản phẩm):**

1. **HTML/CSS/JS tùy biến chạy trong AppBI** — một artifact code_report (layout kiểu app:
   sidebar + KPI cards + 1 custom SVG visual) render trong iframe sandbox trên builder.
2. **Dữ liệu từ BI Core** — KPI và visual lấy số từ `ChartDataResponse` qua SDK, *không*
   hardcode; DevTools chứng minh iframe không có token/không gọi API.
3. **Chart Core + Semantic tái dùng** — ít nhất một visual là "render-native-into-slot" (host
   render native chart vào vùng artifact chỉ định), chứng minh chung Chart Config/Query.
4. **Filter + drill-down đúng** — slicer trang đổi → KPI/visual cập nhật qua SDK; một drill
   phát cross-filter đúng scope.
5. **AI sửa giao diện theo prompt** — "đổi KPI card sang layout 2 cột, thêm sparkline" → chỉ
   presentation đổi; validator chạy; metric/SQL **không** đổi (negative control hiển thị).
6. **Responsive** — render đúng @1440/820/390 trong Studio preview harness.
7. **Draft/Publish + security + rollback đúng contract** — publish ra `/d/[token]`, public
   viewer thấy, **không** authed call (invariant); rollback về version trước; flag off → sạch.

**Gate chấp nhận POC:** 7/7 ở trên PASS trên production image + `verify.py task` xanh cho
paths đã đổi + semantic-guard/public_link_security review PASS. Chưa đạt → không mở rộng.

---

## G. Decisions & Open Questions

### Quyết định kỹ thuật tôi đề xuất chốt
- **[D-1]** Report-as-Code = **sandboxed iframe + Data SDK**, không freeform-codegen-chạm-
  semantic. (§A.2, §D.4-A)
- **[D-2]** Tái dùng `ChartDataResponse` làm SDK data contract; **không** query engine mới.
- **[D-3]** AI kế thừa nguyên tắc **"no write path to semantics"** của `presentation_planner`;
  chỉ ghi artifact code + binding.
- **[D-4]** `html_fragment` và HTML-import-service **không** phải nền cho hướng này (static/
  parked). Native AI-Design path (Studio V3) **giữ nguyên, chạy song song**.
- **[D-5]** Toàn bộ sau `REPORT_AS_CODE_ENABLED=False`; mọi path public giữ `publicClient`-only.
- **[D-6]** Versioning/rollback riêng cho artifact (`ReportArtifactVersion`), không chờ refactor
  native dashboard.

### Câu hỏi cần Product Owner quyết (ảnh hưởng lớn)
- **[Q-1] Hai trust model cùng tồn tại — ranh giới UX?** Người dùng chọn "Native/AI-Design"
  (schema-constrained, đã ship) vs "Report as Code" (freeform sandbox) như thế nào? Cùng một
  Studio hai mode, hay hai entry riêng? (Ảnh hưởng toàn bộ IA.)
- **[Q-2] "Render-native-into-slot" có bắt buộc không?** Nếu có, tương tác/theme native giữ
  được nhưng freeform bị giới hạn ở layout. Nếu không, mọi visual do code tự vẽ (tự do hơn,
  mất tương tác native). Cân freeform ↔ nhất quán.
- **[Q-3] Thư viện viz:** cho AI nhúng CDN bên thứ ba (tiện, rủi ro supply-chain S4) hay chỉ
  self-hosted allow-list (an toàn, hạn chế lựa chọn)?
- **[Q-4] Phạm vi v1:** chỉ "AI sinh + sửa qua prompt" (M4 một phần) hay có cả "sửa source
  code trực tiếp" (Phase 5) ngay v1? Cái sau tăng đáng kể bề mặt bảo mật/validation.
- **[Q-5] Interactivity public:** code report trên `/d`/`/embed` được phép JS tương tác tới
  mức nào (chỉ hiển thị, hay drill/cross-filter đầy đủ)? Ảnh hưởng độ phức tạp SDK Phase 3.

---

## Phụ lục: Phân biệt ba loại DoD (ràng buộc #cuối của brief)

- **Product DoD** — tiêu chí F.1–F.7 (người dùng làm được gì).
- **Architecture DoD** — §D được reviewer độc lập chấp nhận; không engine thứ hai; không chạm
  protected ngoài API đã phơi.
- **Runtime Verification** — `verify.py task` xanh + semantic-guard + public_link_security +
  e2e trên production image; chứng minh-bằng-trình-duyệt (không chỉ đọc source), đúng kỷ luật
  "verify with browser before ship" của repo.
