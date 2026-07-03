# AppBI × OpenMetadata — Integration Plan

> Mục tiêu: AppBI có một lớp **Catalog + Business Glossary + Lineage + Governance** mạnh,
> chạy trên engine của **OpenMetadata (OM)**, nhưng **OM ẩn hoàn toàn** — người dùng chỉ
> thấy AppBI. AppBI là producer (đẩy metadata vào OM) và là gateway (FE đọc qua AppBI BE,
> không bao giờ gọi thẳng OM).

---

## 0. Nguyên tắc bất di bất dịch

1. **Không đụng core đang chạy.** Engine semantic (fan-out / base-invariance / filter funnel)
   giữ nguyên. Tất cả phần OM là **additive**, nằm sau một cờ `METADATA_CATALOG_ENABLED`
   mặc định **OFF** → khi chưa bật, hệ thống chạy y như hôm nay.
2. **OM là sản phẩm độc lập.** DB riêng (`openmetadata_db`), không ghi vào bảng của AppBI.
   Hai module độc lập về quản trị — KHÔNG sync 2 chiều ở giai đoạn đầu (push một chiều).
3. **OM ẩn 100%.** Container OM **không mở port ra host** — chỉ reachable trong mạng
   `appbi-net` bởi backend AppBI. FE chỉ gọi `/api/v1/catalog/*` của AppBI. User không hề
   biết có OM bên dưới.
4. **Một chiều trước (AppBI → OM).** Glossary/định nghĩa gốc vẫn ở AppBI; OM là nơi
   *trưng bày + governance + lineage*. Nâng 2 chiều sau nếu cần.

---

## 1. Kiến trúc tổng thể

```
                          ┌─────────────────────────── appbi-net (docker bridge) ───────────────────────────┐
                          │                                                                                  │
   Browser (user)         │   ┌────────────┐      ┌──────────────────┐      ┌───────────────────────────┐    │
        │  HTTPS           │   │  frontend  │      │     backend       │      │   openmetadata-server      │    │
        ▼                  │   │ (Next.js)  │      │   (FastAPI)       │      │   (Java, KHÔNG mở port)     │    │
   ┌─────────┐  /api/v1    │   │            │ ───▶ │  /api/v1/catalog  │ ───▶ │   :8585  (chỉ nội bộ net)   │    │
   │  nginx  │ ──────────▶ │   │            │      │   (proxy + hide)  │      │                            │    │
   └─────────┘             │   └────────────┘      │  metadata_catalog │      └───────────┬───────────────┘    │
                          │                        │   - om_client     │                  │                    │
                          │                        │   - publisher ────┼──── PUT entities ─┘                    │
                          │                        └─────────┬─────────┘                  │                    │
                          │                                  │                            │                    │
                          │              ┌───────────────────┴──────────┐     ┌───────────┴──────────┐         │
                          │              │  appbi-db (Postgres pg16)     │     │  opensearch (search) │         │
                          │              │  • database "appbi"  (core)   │     │  (OM bắt buộc)        │         │
                          │              │  • database "openmetadata_db" │     └──────────────────────┘         │
                          │              └───────────────────────────────┘                                     │
                          └──────────────────────────────────────────────────────────────────────────────────┘
```

- **Một Postgres instance** (`appbi-db`), **hai database**: `appbi` (core, không động tới) +
  `openmetadata_db` (của OM). ✅ đúng yêu cầu "chung CSDL, khác database".
- **opensearch**: OM **bắt buộc** một search engine — đây là container *thêm* không thể bỏ
  (giới hạn của OM, không phải lựa chọn của ta).
- **openmetadata-server**: KHÔNG có `ports:` ra host → ẩn. Chỉ `backend` gọi nó qua
  `http://openmetadata-server:8585`.

---

## 2. Hợp đồng dữ liệu — AppBI xuất gì vào OM (3 tầng)

| Tầng | AppBI nguồn | → OM entity | Trạng thái build |
|---|---|---|---|
| **1 Catalog đầy đủ** | datasource | Database Service | ✅ mapping |
| | dataset_table + columns_cache | Table + Column | ✅ mapping |
| | PK/FK (Generate-Model) | tableConstraints | ✅ mapping |
| | (mọi asset) | FQN ổn định | ✅ `fqn.py` |
| **2 Quản trị tốt** | `dictionary` (business_name/desc) | Glossary + GlossaryTerm | 🟡 stub |
| | dictionary.quality (PII) | Classification/Tag | 🟡 stub |
| | owner/team | Owner | 🟡 stub |
| **3 Lineage + trust** | semantic_views.measures | Metric | 🟡 stub |
| | dashboards/charts | Dashboard/Chart | 🟡 stub |
| | binding source→measure→chart | Lineage (column-level) | 🟡 stub |
| | columns_cache stats | Column Profile | 🟡 stub |

> Giai đoạn 1 (turn này) hiện thực Tầng 1 đầy đủ + khung Tầng 2/3. Hai lợi thế riêng của
> AppBI mà OM thường "đói": **PK/FK** và **column-level lineage source→KPI**.

---

## 3. Các thành phần build

### 3.1 Hạ tầng — `open-metadata/`
- `docker-compose.openmetadata.yml` — opensearch + openmetadata-server (+ bước migrate),
  join external `appbi-net`, trỏ DB `appbi-db/openmetadata_db`, **không expose port**.
- `.env.example` — biến môi trường OM (DB, search, JWT bot).
- `init-db/01-create-openmetadata-db.sql` — tạo database + user cho OM trong `appbi-db`.
- `README.md` — runbook bật/migrate/lấy bot token/verify.

### 3.2 Backend — `backend/app/modules/metadata_catalog/`
- `om_client.py` — async httpx client tới OM (base URL + JWT bot token; PUT/GET entity, lineage).
- `fqn.py` — chiến lược sinh FQN tất định (service/db/schema/table/column/glossary/metric).
- `mapping.py` — map entity AppBI → payload OM.
- `publisher.py` — orchestrate upsert idempotent (service→db→schema→table→cols→constraints; +stub glossary/metric/lineage).
- `api.py` — router proxy `/api/v1/catalog/*` cho FE (health/search/glossary/asset/lineage + "sync now"); reshape response sang ngôn ngữ AppBI để **giấu OM**.

### 3.3 Wiring (an toàn, mặc định OFF)
- `core/config.py` — thêm `METADATA_CATALOG_ENABLED=False` + `OPENMETADATA_*`.
- `api/__init__.py` — include router **chỉ khi** cờ bật (giống `WORKBOARDS_ENABLED`) → inert khi off.

### 3.4 Frontend — `frontend/src/app/(main)/catalog/`
- `lib/catalogClient.ts` — chỉ gọi `/api/v1/catalog/*` (KHÔNG có URL nào của OM).
- `page.tsx` — trang Catalog/Glossary theo style AppBI (skeleton, sẽ khoác design-system của bạn).

---

## 4. Chiến lược FQN (gotcha số 1 — chống nhân bản khi re-sync)

OM định danh mọi thứ bằng *fully-qualified name*. Phải tất định + ổn định:

```
Service      : appbi_ds_<datasource_id>
Database     : appbi_ds_<datasource_id>.<db_logical>          (mặc định "default")
Schema       : ...<schema_logical>                            (mặc định "public")
Table        : ...<table_key>          table_key = dataset_table_id (ổn định, không đổi tên)
Column       : <table_fqn>.<column_name>
Glossary     : appbi_glossary
GlossaryTerm : appbi_glossary.<dataset_id>_<term_slug>
Metric       : appbi_metric.<dataset_id>_<measure_key>
```

Dùng **ID nội bộ** (datasource_id, dataset_table_id) làm khoá thay vì tên hiển thị → đổi tên
không tạo entity mới. Upsert = PUT theo FQN (OM PUT là idempotent upsert).

---

## 5. Quyết định đã chốt
- **Push một chiều** AppBI → OM (không sync ngược ở GĐ1). Hai module độc lập về quản trị.
- **dataset (data mart)** → để GĐ sau quyết map vào OM **Data Product** (đúng ngữ nghĩa) hay View.
- **OM ẩn**: không expose port; FE chỉ thấy `/api/v1/catalog`.

---

## 6. Lộ trình triển khai (rủi ro tăng dần)

| Bước | Việc | Rủi ro | Trạng thái |
|---|---|---|---|
| A | Dựng scaffold (compose + module + FE skeleton), inert sau cờ OFF | ~0 (không chạy gì) | **GĐ1 — turn này** |
| B | `docker compose ... up` OM + opensearch; tạo DB; migrate; lấy bot token | thấp (container mới, DB mới) | next |
| C | Bật cờ; chạy publisher Tầng-1 cho 1 datasource thử; xem trong FE catalog | thấp | next |
| D | Hoàn thiện Tầng 2 (glossary từ dictionary) + Tầng 3 (metric + lineage) | trung | sau |
| E | Trigger publish tự động khi dataset/dashboard đổi | trung | sau |
| F | (tuỳ chọn) 2 chiều glossary, hoặc OM MCP cho AI agent | cao | tương lai |

> Mỗi bước verify xong mới sang bước sau. A không đụng gì đang chạy; B/C chỉ thêm; chỉ E mới
> nối vào luồng core (và vẫn sau cờ).

---

## 7. Sự thật cần biết (đừng kỳ vọng sai)
- **opensearch là bắt buộc** — không có chế độ "chỉ Postgres" cho OM. Chấp nhận 1 container search.
- **OM image nặng** (server Java + opensearch) — `up` lần đầu kéo vài GB, boot vài phút, phải
  chạy bước **migrate** trước khi server khỏe.
- **Bot token**: server-to-server cần JWT bot của OM — lấy 1 lần, nạp vào `.env` của AppBI.
- Scaffold GĐ1 **không tự bật**; bật là việc có chủ đích ở bước B/C.
