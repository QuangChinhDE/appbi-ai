# RFC v2: Report as Code / AI Vibe Design — Architecture & Implementation Plan

> **Trạng thái: REVIEW & PLAN ONLY.** Chưa code, migration, commit, PR, merge, deploy.
> File working-tree, chưa commit. **Supersedes `RFC.md` (v1).** Dành cho reviewer độc lập + PO.
>
> - Repo `QuangChinhDE/appbi-ai` · Nhánh `demo` · HEAD `2201527e` · Ngày 2026-11-03
> - Hướng đã được PO đồng ý ở v1: **Sandboxed Report Runtime + Data SDK trên BI Core, không
>   Query Engine thứ hai.** v2 này phản hồi 5 phản biện kiến trúc của PO và sửa những chỗ v1
>   overclaim.
> - **Quy ước bằng chứng:** `[V]` đọc code trực tiếp (file:line). `[I]` suy luận. `[U]` chưa
>   xác minh — có owner + cách kiểm chứng (§8).
> - **Phân biệt trạng thái (PO yêu cầu):** *(a) code tồn tại & merged* · *(b) test từng chạy*
>   · *(c) runtime đã verify tại HEAD hiện tại*. Dùng xuyên suốt, không gộp.

---

## 0. Những chỗ v1 sai / overclaim — đã sửa trong v2

| # | v1 nói | Sự thật đã verify | Sửa ở |
|---|---|---|---|
| 1 | Studio Preview iframe "gần như chính là data-bridge cần" | **Sai.** StudioPreview là iframe **same-origin, TRUSTED**, load đúng route app với full context; guard `e.origin === window.location.origin` (`preview-mode.ts:8,55`). Nó chỉ chứng minh ergonomics iframe+postMessage, **không phải** boundary bảo mật — trust model ngược hẳn. | §3, §4 |
| 2 | "render-native-into-slot" là option dễ | **Sai.** Production path là `ChartTile → ExploreChart` (`ChartTile.tsx:1637`), mà `ExploreChart` (4467 dòng) **cần** `DashboardThemeProvider` (`:34`), `LanguageProvider`/i18n (`:38`), export-mode context (`:35`). Đưa vào sandbox cross-origin = **port/rewrite**, không drop-in. React element không qua được `structuredClone` postMessage. | §3, §6 |
| 3 | `widget_type="code_report"` tile là kiến trúc chính | **Thiếu.** Hôm nay **mọi thứ là Dashboard + DashboardChart trong một react-grid** (`PublicDashboardView.tsx:13`); V3 còn "one grid, Canvas is gone" (commit `5ce457af`). **Không có** full-page concept. Tile = chỉ capability *embedded*; PO yêu cầu report-level mode riêng. | §4 |
| 4 | Versioning model trên Dashboard | **Sửa nguồn.** Dashboard **không** có version table (chỉ `draft_snapshot` + `last_published_at`, `models.py:252,260`). Prior art đúng là **Workboard**: `published_layout_json` immutable, `version`/`published_version`, atomic draft→publish (`modules/workboards/models.py:84-98`). | §5 |
| 5 | CSP "mẫu public.py:3130" | **Hai lớp.** `frame-ancestors` cho `/d`,`/embed` do **Next middleware** phát (`middleware.ts:202`). `script-src` allow-list cho tài liệu artifact nên do **backend route** sở hữu (mirror `public.py:3130`). Không gộp. | §3, §7 |
| 6 | Truyền `ChartDataResponse` qua SDK | **Nguy hiểm.** `ChartResponse` lộ `owner_id/owner_email/user_permission/dataset_id/datasource_id` (`schemas.py:470-479`); `ChartDebugInfo` lộ `sql_emitted` (`:523`). **Phải** mint DTO rút gọn từ binding manifest, resolve host-side. | §3 |
| 7 | AI-Design "đã ship" | **Chính xác hơn:** (a) merged & wired — `48d3eaae` PR #9; `presentation_planner` import tại `dashboards.py:2388` **[V]**. (b)/(c): test-in-CI và runtime tại HEAD hiện tại **chưa** tự verify → §8. | §8 |

---

## 1. Updated Architecture Decisions & Trade-offs

Chốt lại theo quyết định PO (Q1–Q5) + phản biện (A–E).

- **[D-1] Hai năng lực, hai trust model, chung Core (Q1).** Native/AI-Design (schema-constrained,
  đã merged) giữ nguyên. Report-as-Code = freeform-but-sandboxed, **không** bị ép thành Native
  Widget. Chung Data/Chart/Query/Publish/Auth Core.
- **[D-2] Report-level runtime là kiến trúc chính, embedded-widget là capability phụ (phản biện A).**
  Code Report sở hữu **full page** (sidebar/nav/sections/responsive/interaction) trên một
  **render branch mới** ở `/d`,`/embed` và builder — **không** nhốt trong react-grid tile.
  Embedded `code_widget` trong dashboard native là capability bổ sung (phase sau).
- **[D-3] Data SDK = DTO rút gọn qua binding manifest, KHÔNG phải ChartDataResponse (phản biện C).**
  Backend mint DTO chỉ gồm giá trị + descriptor hiển thị; binding→chart + permission resolve
  **host/backend-side**; sandbox chỉ xin `bindingId` đã cấp.
- **[D-4] Native-slot là OPTIONAL, không blocker POC (Q2 + phản biện E).** v1 feasible: host
  tính rows → sandbox vẽ bằng **viz lib self-hosted, version-pinned, allow-list** (Q3). Native-
  slot (ship một renderer-bundle recharts vào sandbox) đánh giá là **capability sau**, feasibility
  HARD, không gate POC.
- **[D-5] Interactivity public đầy đủ READ, WRITE qua capability API riêng (Q5).** Filter/param/
  cross-filter/drill/nav/custom-visual-interaction: có ở v1. Ghi nghiệp vụ: **không** cho JS tự
  gọi API ghi; phải qua capability API có authz + audit (tái dùng mẫu Workboard write-back).
- **[D-6] Source editor + AI prompt đều trong v1, chia milestone (Q4).**
- **[D-7] Versioning model trên Workboard pattern, thiết kế TRƯỚC public execution (phản biện D).**
- **[D-8] Mọi thứ sau flag `REPORT_AS_CODE_ENABLED=False`; `publicClient`-only trên public.**

### Trade-off chính còn lại
| Trục | Chọn | Đánh đổi |
|---|---|---|
| Report-level route mới vs tái dùng Dashboard shell | **Route/entity mới** (ReportArtifact) | Thêm plumbing publish/permission, nhưng trung thực với "owns the page" & không đụng grid shell |
| Viz lib self-hosted allow-list vs CDN tự do | **Self-hosted pinned** (Q3) | Giới hạn lib, nhưng chặn supply-chain & cho CSP `script-src` chặt |
| Sandbox vẽ data thuần vs native-slot | **Data DTO v1** | Mất tương tác/theme native trong v1; bù bằng native-slot sau |

---

## 2. Revised Target Architecture

```
┌──────────────── TRUSTED HOST (builder route / app/d / app/embed) ────────────────┐
│ DATA PLANE  (BI Core — KHÔNG đổi)                                                 │
│   ChartService.get_chart_data (chart_service.py:4475+)  /  public.py chart-data   │
│   (:3893) → filter/param/scope/RLS/permission enforce SERVER-SIDE                 │
│        │                                                                          │
│   ┌────▼── Binding Manifest (backend) ──────────────────────────────────────┐    │
│   │  bindingId(opaque) → {chartId | savedQuery, scope, allowed filters}      │    │
│   │  resolve + permission check HERE; sandbox never sends chart/dataset ids  │    │
│   └────┬────────────────────────────────────────────────────────────────────┘    │
│        │  host fetch: apiClient (builder) | publicClient (/d,/embed)              │
│        ▼                                                                          │
│   DTO MINTER → ReportDataDTO (rút gọn, §3.3)  ── KHÔNG ChartResponse/debug/SQL    │
│        │  postMessage (structured clone: chỉ data, KHÔNG hàm/token/cookie)        │
│ ┌──────▼─────────── PRESENTATION PLANE (UNTRUSTED, SANDBOXED) ─────────────────┐  │
│ │ Artifact document served bởi BACKEND ROUTE (mirror public.py:3130):          │  │
│ │   CSP: default-src 'none'; script-src <self-hosted-viz-origin>;              │  │
│ │        style-src 'unsafe-inline'; img-src data: <allowlist>; connect-src 'none'│ │
│ │ <iframe sandbox="allow-scripts">  (KHÔNG allow-same-origin với origin app)   │  │
│ │ Full-page artifact: HTML/CSS/JS/SVG do AI/người dùng viết tự do              │  │
│ │ Viz: lib self-hosted, version-pinned, allow-list                            │  │
│ │ Chỉ nhận ReportDataDTO qua SDK; KHÔNG fetch, KHÔNG cookie, KHÔNG chạm semantic│  │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ frame-ancestors (page shell) ← Next middleware (middleware.ts:202)                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Hai lớp render (D-2):**
- **Report-level mode** (chính): artifact chiếm full page, render branch mới ở `app/d/[token]`
  (hôm nay `app/d` **luôn** mount react-grid — `PublicDashboardView.tsx:13` — nên cần nhánh mới,
  không chỉ widget type).
- **Embedded code_widget** (phụ, sau): một artifact nhỏ trong react-grid tile của dashboard native.

**Chart Core tái dùng qua DATA, không qua component (do §6):** sandbox nhận `ReportDataDTO` và
tự vẽ. Tái dùng Chart Configuration + Query Execution ở tầng *backend/host* (binding→chart→
`get_chart_data`), **không** nhúng `ExploreChart`/`ChartPreview` React vào sandbox ở v1.

---

## 3. Threat Model & Secure Data SDK Contract

### 3.1 Phân biệt 4 cơ chế (PO phản biện B — không được lẫn)
| Cơ chế | Trust | Vai trò | **KHÔNG phải** |
|---|---|---|---|
| CSP tĩnh `public.py:3130` | n/a | Phục vụ asset script-less | sandbox JS tin cậy |
| QuickJS evaluator | server | Tính computed-column per-row | runtime render UI |
| Studio Preview iframe | **TRUSTED same-origin** | Harness xem trước | **sandbox bảo mật** |
| **Report Runtime (mới)** | **UNTRUSTED** | Chạy JS AI/user, render | — |

→ Ba cái đầu là **prior art ergonomics/pattern**, **không chứng minh** runtime mới an toàn.
Runtime mới cần threat model + security contract **riêng** (dưới).

### 3.2 Threat model (asset = dữ liệu người xem + tính toàn vẹn báo cáo + token/cookie)
| Threat | Vector | Mitigation (verify-able) |
|---|---|---|
| T1 Steal auth cookie/token | JS đọc `document.cookie`/`localStorage` của app | iframe `sandbox` **không** `allow-same-origin` với origin app → cross-origin, không đọc được app storage; token **không bao giờ** postMessage vào |
| T2 Exfiltrate data ra ngoài | `fetch`/`XHR`/`img` tới server lạ | CSP `connect-src 'none'; default-src 'none'`; data chỉ vào qua postMessage; `img-src` allow-list |
| T3 Scope bypass (đọc data ngoài quyền) | sandbox tự chọn chart/dataset id | Binding manifest resolve **host-side**; sandbox chỉ gửi `bindingId` đã cấp; backend check permission mỗi lần |
| T4 Load executable lạ | `<script src=cdn>` | CSP `script-src <self-hosted-origin>` + allow-list; Q3 |
| T5 Clickjack/frame app | nhúng route app vào iframe artifact | `frame-ancestors` (middleware) + sandbox không điều hướng top |
| T6 DoS tài nguyên | loop vô hạn, O(n²), DOM bomb | Resource budget: timeout render, `MAX_ROWS` đẩy vào (mẫu `js_evaluator.py:43`), cap kích thước artifact/asset |
| T7 postMessage injection | message giả từ origin khác | Host validate `event.origin === <sandbox-origin>` + schema-validate mọi message (như `isStudioMessage` nhưng cho untrusted origin) |
| T8 Business write qua JS | JS gọi API ghi | Không expose API ghi vào sandbox; ghi chỉ qua capability API host-mediated + authz + audit (D-5) |
| T9 Stored XSS leo thang | artifact độc published cho viewer khác | Artifact chạy cross-origin sandbox → không chạm app; + validate/scan khi publish (§5) |

### 3.3 Secure Data SDK — ReportDataDTO (host→sandbox), đã verify field nhạy cảm **[V]**

**CẤM qua boundary** (xác nhận lộ): toàn bộ `ChartResponse` — `owner_id/owner_email`
(`schemas.py:470-471`), `user_permission` (`:472`), `capabilities` (`:475`), `dataset_id/
dataset_name/dataset_table_name/datasource_id` (`:476-479`); toàn bộ `ChartDebugInfo` —
`sql_emitted` (`:523`), `dialect/routing/row_count/...` (`:508-547`).

**DTO tối thiểu được phép:**
```
ReportDataDTO {
  bindingId: string              // opaque handle, KHÔNG chart_id/dataset_id
  rows: Array<Record<string,JSON>>   // chỉ giá trị (từ ChartDataResponse.data)
  fields: Array<{
    key, label, role: "measure"|"dimension",
    kind: "number"|"date"|"string",
    format?: NumberFormat        // FE đã derive qua ExploreChartConfig/chartColors
  }>
  timeGrain?: string
  timeCompleteness?: {...}        // từ ChartDataResponse.time_completeness (:560-563)
  preAggregated: boolean
  title?: string
  chartTypeHint?: string         // optional; sandbox được phép bỏ qua & vẽ tự do
  status: "ready"|"updating"|"empty"|"error"
}
```
**Backend DTO Minter** nhận `bindingId`, resolve qua manifest → `chartId`+scope → gọi
`get_chart_data` dưới `EffectivePrincipal` người xem → strip → trả DTO. Sandbox **không** quyết
định được dataset/filter ngoài binding.

### 3.4 SDK protocol (postMessage, versioned, schema-validated)
```
sandbox → host:  {v, type:"requestData", bindingId}
                 {v, type:"applyFilter"|"drill"|"navigate", payload}   // READ interactions
                 {v, type:"resize", height}
                 {v, type:"businessAction", capabilityId, payload}     // → capability API (D-5)
host → sandbox:  {v, type:"data", bindingId, dto: ReportDataDTO}
                 {v, type:"context", filters, params, theme-tokens(whitelisted)}
```
Host validate origin + schema mọi message; filter/drill nối vào filter engine hiện có
(re-verify §B.4 của v1 trước — `[U-3]`), **không** engine mới. `businessAction` đi qua
authz+audit, không chạm semantic.

---

## 4. Full-Page Code Report Lifecycle

### 4.1 Storage (net-new, additive) — model trên Workboard **[V prior art]**
Dashboard thiếu versioning (`models.py:252,260`); Workboard có đủ (`modules/workboards/
models.py:84-98`). Nên artifact theo **Workboard pattern + history**:

```
ReportArtifact                     // draft, mutable
  id, title, owner_id, created_by
  source_html, source_css, source_js, assets_ref
  bindings: [BindingManifest]       // bindingId → chartId/savedQuery + scope
  version (int)                     // draft version, tăng mỗi save
  published_version (int|null)      // = snapshot đang live
  csp_profile, validated_at
ReportArtifactVersion              // IMMUTABLE snapshot mỗi lần Publish (rollback N-version)
  artifact_id, version
  published_html/css/js, published_bindings
  content_hash, published_at, published_by
  runtime_config_snapshot          // frozen tại publish (mẫu published_runtime_config :98)
ReportPublicLink (hoặc tái dùng DashboardPublicLink.stage :325-330)  stage∈{draft,published}
```
Lưu ý trung thực `[I]`: Workboard giữ **1** snapshot published (`published_layout_json`); rollback
N-version là **mở rộng net-new** (bảng `ReportArtifactVersion`), không copy thẳng.

### 4.2 Lifecycle & transaction
- **Draft→Publish atomic**: copy draft → `ReportArtifactVersion` immutable mới, set
  `published_version` (mẫu atomic draft→publish `:84-90`). Public runtime chỉ serve
  `published_version`; `published_version=null` ⇒ refuse (mẫu Workboard `:88-89`).
- **Rollback**: trỏ `published_version` về một `ReportArtifactVersion` đã giữ; audit.
- **Immutable published**: viewer public **không bao giờ** thấy draft; published snapshot không
  sửa tại chỗ (sửa = draft mới → publish = version mới).
- **Audit**: `report_artifact_published/rolled_back/business_action` events.
- **Render branch mới** ở `app/d/[token]` + `app/embed/[token]`: nếu token trỏ ReportArtifact →
  full-page runtime; nếu Dashboard → react-grid như cũ (backward-compat §7).

---

## 5. Updated Phased Roadmap & Dependencies

Flag `REPORT_AS_CODE_ENABLED=False`. Mỗi phase: verify độc lập + rollback = flag off. Medium/
large qua `docs/features/.../{intent,spec,plan}.md` + human approval trước code. **Versioning &
threat model thiết kế ở Phase 1–2, KHÔNG để cuối (phản biện D).**

| Phase | Mục tiêu | Phạm vi chính | Depends | DoD / Acceptance | Rollback |
|---|---|---|---|---|---|
| **P0** Spike sandbox + SDK | iframe cross-origin nhận ReportDataDTO, vẽ bằng viz lib self-hosted; chứng minh không cookie/không network | `lib/report-sdk/*` (contract thuần + contract-check script như `embed-framing.ts`); backend route serve artifact-doc với CSP `default-src 'none'` | — | DevTools: iframe không cookie, `connect-src` chặn fetch; postMessage schema-validated; contract-check xanh | xóa lib |
| **P1** Artifact + versioning + builder | Tạo/lưu ReportArtifact + ReportArtifactVersion; **report-level** render ở builder; Data DTO Minter + binding manifest | migration additive (2 bảng); `services/report_artifact_service.py`; DTO minter; builder route; validator/scan khi save | P0 | versioning+draft/publish atomic hoạt động; DTO **không** chứa SQL/ids (test); `verify.py task` xanh | flag off; migration additive |
| **P2** Public/embed report-level | Full-page artifact trên `/d`,`/embed` qua render branch mới; publicClient | render branch `app/d`,`app/embed`; backend serve published snapshot + CSP; **gate `public_link_security`**; semantic-guard | P1 | published-only; **không** authed call (invariant `public_client_only`); immutable published; e2e | flag off → Dashboard path nguyên |
| **P3** READ interactivity đầy đủ (Q5) | filter/param/cross-filter/drill/nav/custom-visual qua SDK | SDK protocol mở rộng; nối filter engine (re-verify `[U-3]`); **không** engine mới | P2 | đổi filter→DTO cập nhật; drill đúng scope; e2e | flag off |
| **P4** AI sinh/sửa (Q4) | AI tạo/sửa artifact từ prompt; upload HTML/screenshot ref; iterative; vision-review | LLMClient; **AI chỉ ghi artifact+binding, KHÔNG semantic** (kế thừa planner); validator+CSP build trên output AI trước serve | P1 | prompt→report; "sửa vùng này" đúng; AI không đổi metric/SQL (negative control) | flag off |
| **P5** Source editor + rollback UI (Q4) | Xem/sửa source trực tiếp; history + rollback | code editor; preview harness (Studio); rollback UI trên ReportArtifactVersion | P1 | sửa source→preview; rollback version; audit | flag off |
| **P6** Capability write API (D-5) + polish | Ghi nghiệp vụ host-mediated + authz+audit; responsive; PDF | capability API (mẫu Workboard write-back); PDF tái dùng `export-pdf` | P3 | ghi qua authz+audit; JS **không** gọi API ghi trực tiếp (test) | flag off |
| **P7** (optional/sau) Native-slot | Ship renderer-bundle recharts vào sandbox, fed by DTO | renderer bundle riêng (HARD, §6) | P1 | native chart render trong sandbox từ DTO | flag off |

Dependency chain: P0→P1→{P2,P4,P5}; P2→P3→P6; P7 độc lập sau P1.

---

## 6. Chart Renderer Feasibility (phản biện E) — đánh giá trung thực **[V]**

- Production chart tile = `ChartTile → ExploreChart` (`ChartTile.tsx:1637`), đôi khi `ChartPreview`
  (`:1662`). `DashboardWidget` chart case → `ChartTile`; public wrap trong `DashboardThemeProvider`
  (`PublicDashboardView.tsx:30`).
- `ExploreChart` (4467 dòng) **coupled context**: `useDashboardChartTheme` (`:34`), `useExportMode`
  (`:35`), `useI18n` (`:38`). → đưa vào sandbox cross-origin = **recreate cả theme+i18n+export
  context + CSS bundle**, hoặc chạy một mini React app trong sandbox = **port, không drop-in**.
- `ChartPreview` (1110 dòng, recharts) **nhẹ hơn** — không apiClient/store/context, chỉ recharts +
  util — nhưng vẫn cần React+recharts+CSS ship vào sandbox.
- React element **không** qua `structuredClone` postMessage.
- **Verdict:** native-slot = **HARD / own-mini-app**, đúng như PO lo. ⇒ v1 = data DTO + viz lib
  self-hosted (D-4); native-slot = **P7 optional**, feasible dạng "ship một ChartPreview-renderer
  bundle vào sandbox, fed by ReportDataDTO", **không** gate POC.

---

## 7. Migration, Backward Compatibility & Rollback

- **Migration**: additive, single head, parent committed (quy tắc repo). Hai bảng mới
  (`ReportArtifact`, `ReportArtifactVersion`); không sửa `Dashboard`/`DashboardChart`. Nếu dùng
  embedded widget sau: thêm `widget_type="code_widget"` (additive enum, FE cũ bỏ qua loại lạ).
- **Backward-compat `/d`,`/embed`**: render branch mới chỉ kích hoạt khi token→ReportArtifact;
  token→Dashboard giữ nguyên react-grid (`PublicDashboardView`). Contract `publicClient`-only và
  server-side scoping **không** đổi. Không đổi response shape cũ.
- **CSP hai lớp (đã sửa)**: `frame-ancestors` page-shell giữ ở Next middleware (`middleware.ts:202`);
  `script-src` tài liệu-artifact ở backend route mới (mirror `public.py:3130`). Không đụng framing
  cũ của Dashboard/embed.
- **Rollback vận hành**: `REPORT_AS_CODE_ENABLED=False` ⇒ toàn bộ surface biến mất, dashboard/
  public cũ nguyên vẹn. Rollback nội dung: `published_version` → version cũ.
- **Migration chạy trên prod có data**: additive nên an toàn; vẫn cần migration-checker review.

---

## 8. Chưa xác minh — Owner & cách kiểm chứng

| ID | Khẳng định chưa chắc | Trạng thái | Owner | Cách kiểm chứng |
|---|---|---|---|---|
| **[U-1]** | AI-Design/Report-Studio chạy đúng tại HEAD hiện tại | (a) merged+wired `[V]` (`48d3eaae` PR#9, `dashboards.py:2388`); (b)/(c) **chưa** | QA | Chạy production image tại HEAD, verify-with-browser; docs V3 từng BLOCKED-on-BigQuery (`6b0635be`) → kiểm tra lại |
| **[U-2]** | Test report-experience/S1–S8 còn chạy trong CI | (b) từng tham chiếu; nhiều backend test gitignore/không-CI | QA | `guardrail_check.py --health`; kiểm allow-list test |
| **[U-3]** | Filter engine nối được vào SDK như mô tả | chưa đọc `filter_propagation.py` (protected) | BE | Đọc `filter_propagation.py` + trace một filter→tile trước P3 |
| **[U-4]** | `quickjs` wrapper hiện diện ở runtime (nếu v2 cần server-eval) | import có guard ImportError (`js_evaluator.py:28-31`) | BE | `python -c "import quickjs"` trong container |
| **[U-5]** | Viz lib self-hosted nào (echarts/d3/recharts) + license/size cho allow-list | chưa chọn | Arch+PO | Spike P0: pin 1–2 lib, đo bundle |
| **[U-6]** | `connect-src 'none'` không làm hỏng viz lib cần tải font/asset | giả định | FE | Thử trong P0 với lib đã chọn |
| **[U-7]** | Capability write API tái dùng được mẫu Workboard write-back | chưa đọc Workboard write-back path | BE | Đọc `modules/workboards` write-back trước P6 |

---

## 9. POC Scope, Test Matrix & Acceptance Gates

**POC = P0+P1+P2 tối thiểu + một slice P3/P4.** Dữ liệu **Olist** (đã có). Native-slot **ngoài**
POC (D-4). Full-page report-level **trong** POC (phản biện A).

### Test matrix
| # | Chứng minh | Loại | Gate |
|---|---|---|---|
| 1 | Full-page Code Report (sidebar+sections+KPI+custom SVG) render trong sandbox cross-origin | e2e/visual | Report-level mode, không grid |
| 2 | Dữ liệu từ BI Core qua ReportDataDTO; **không** hardcode | e2e+network | DTO không chứa SQL/ids (assert) |
| 3 | iframe **không** cookie, `connect-src` chặn fetch ngoài, token không vào sandbox | security | T1/T2/T4 |
| 4 | Chart Config + Query tái dùng (binding→`get_chart_data`), **không** engine mới | BE test | guardrail: no 2nd engine |
| 5 | Filter trang + 1 drill cập nhật đúng qua SDK, scope đúng | e2e | Q5 READ |
| 6 | AI prompt sửa presentation; metric/SQL **không** đổi | e2e+negative | D-5/planner principle |
| 7 | Source edit → preview | e2e | Q4 |
| 8 | Responsive @1440/820/390 (Studio harness) | visual | — |
| 9 | Draft→Publish atomic, immutable published, rollback version | e2e+BE | §4; public không thấy draft |
| 10 | Public: **không** authed call; server-side scope áp | security | invariant `public_client_only`, gate `public_link_security` |

### Acceptance gates (cho phép mở rộng thành sản phẩm)
- 10/10 PASS trên **production image** tại HEAD cụ thể (ghi head).
- `python scripts/ci/verify.py task` xanh cho paths đã đổi.
- semantic-guard + `public_link_security` review PASS.
- Threat model T1–T9 có mitigation chứng minh được (ít nhất T1–T5,T7,T9 test tự động).
- **Verify-with-browser** (không chỉ đọc source) — đúng kỷ luật repo.
- Chưa đạt bất kỳ gate ⇒ **không** mở rộng.

---

## 10. Tinh thần sản phẩm được bảo vệ (PO mục 3)

Report-as-Code **không** phải một bản schema-constrained AI Design khác: AI/người dùng viết
HTML/CSS/SVG/JS **tự do** trong sandbox, không giới hạn bởi danh sách Native Widget/layout
primitive/Chart Style. **Ranh giới cứng giữ nguyên:** AppBI Core sở hữu dữ liệu/semantics/quyền/
governance (Data Plane bất biến); Code Report sở hữu presentation (Presentation Plane tự do, có
sandbox). Tự do presentation đi cùng threat model (§3), validation khi publish (§5), và budget
tài nguyên — không phải tự do truy cập.

### Ba DoD (PO yêu cầu phân biệt)
- **Product DoD** — test matrix §9.1–§9 (người dùng làm được gì).
- **Architecture DoD** — §2–§4 được reviewer độc lập chấp nhận; không engine thứ hai; không
  chạm protected ngoài API đã phơi; DTO không lộ SQL/ids.
- **Runtime Verification** — §9 gates trên production image + verify-with-browser; `[U-1..7]`
  đóng với owner.
