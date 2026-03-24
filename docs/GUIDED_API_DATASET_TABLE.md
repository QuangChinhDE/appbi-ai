# GUIDED_API_DATASET_TABLE.md — Hướng dẫn đầy đủ Dataset Workspace & Table API

> Tài liệu step-by-step cho AI Agent và Developer.
> Mỗi field bắt buộc đánh dấu ★. Mỗi bước có ✅ checkpoint để kiểm tra.
> Last updated: 2026-03-24

---

## Mục lục

1. [Tổng quan](#tổng-quan)
2. [Bước 0 — Prerequisite](#bước-0--prerequisite)
3. [Bước 1 — Tạo Workspace](#bước-1--tạo-workspace)
4. [Bước 2 — Khám phá Datasource (Schema Discovery)](#bước-2--khám-phá-datasource)
5. [Bước 3 — Thêm Table vào Workspace](#bước-3--thêm-table-vào-workspace)
6. [Bước 4 — Preview Data & Kiểm tra cột](#bước-4--preview-data--kiểm-tra-cột)
7. [Bước 5 — Thêm cột tính toán (Computed Columns)](#bước-5--thêm-cột-tính-toán)
8. [Bước 6 — LOOKUP / VLOOKUP (Tham chiếu bảng khác)](#bước-6--lookup--vlookup)
9. [Bước 7 — Type Overrides & Column Formats](#bước-7--type-overrides--column-formats)
10. [Bước 8 — Execute Query (Aggregation)](#bước-8--execute-query)
11. [Bước 9 — Xóa Table / Workspace](#bước-9--xóa-table--workspace)
12. [Tham khảo: Tất cả Endpoints](#tham-khảo-tất-cả-endpoints)
13. [Tham khảo: Transformation System](#tham-khảo-transformation-system)
14. [Tham khảo: Tất cả hàm Formula (47 hàm)](#tham-khảo-tất-cả-hàm-formula)
15. [Tham khảo: Schemas đầy đủ](#tham-khảo-schemas-đầy-đủ)
16. [Bảng lỗi thường gặp & Cách khắc phục](#bảng-lỗi-thường-gặp--cách-khắc-phục)
17. [Ví dụ Python hoàn chỉnh](#ví-dụ-python-hoàn-chỉnh)
18. [Quick Reference Card](#quick-reference-card)

---

## Tổng quan

### Data Model

```
DataSource (PostgreSQL / MySQL / BigQuery / Google Sheets / CSV)
  └── DatasetWorkspace  ← "Virtual Schema" — nhóm nhiều tables lại
        ├── Table A (physical_table từ datasource A)
        ├── Table B (sql_query từ datasource B)
        └── Table C (physical_table + computed columns + LOOKUP tới Table A)
              └── Chart (visualization trên table C)
```

- **DatasetWorkspace**: Container nhóm nhiều tables từ nhiều datasources khác nhau.
- **DatasetWorkspaceTable**: Một table cụ thể — có thể là physical table hoặc SQL query result.
- **Transformations**: Mảng các phép biến đổi trên table (thêm cột, đổi tên, lọc cột, formula).
- **LOOKUP**: Hàm tra cứu cross-table — lấy dữ liệu từ table khác trong cùng workspace.

### Hai loại Table

| Loại | `source_kind` | Input | Khi nào dùng |
|------|---------------|-------|--------------|
| **Physical Table** | `"physical_table"` | `source_table_name` | Import trực tiếp table từ datasource |
| **SQL Query** | `"sql_query"` | `source_query` | Viết SQL tùy chỉnh, filter, join ở level datasource |

### Hai loại Computed Column

| Loại | `type` | Chạy ở đâu | Khi nào dùng |
|------|--------|-------------|--------------|
| **`js_formula`** | Client-side (browser) | Hỗ trợ 47 hàm Excel, LOOKUP cross-table | Phần lớn trường hợp |
| **`add_column`** | Server-side (DuckDB SQL) | Expression SQL thuần | CASE WHEN, math đơn giản |

> ⚠️ **`js_formula`** là cách chính để thêm cột tính toán. Backend bỏ qua (skip) `js_formula` khi compile SQL — nó được đánh giá hoàn toàn ở frontend per-row.

---

## Bước 0 — Prerequisite

### 0.1 Xác thực

```http
POST /api/v1/auth/login
Content-Type: application/json

{"email": "admin@appbi.io", "password": "your-password"}
```

Response → `access_token`:
```
Authorization: Bearer <access_token>
```

### 0.2 Chuẩn bị Datasource

Table phải thuộc về một **datasource đã kết nối**. Kiểm tra datasources:

```http
GET /api/v1/datasources
```

Nếu chưa có → tạo datasource trước (xem docs Datasource API).

### 0.3 Permission cần thiết

| Hành động | Module Permission tối thiểu |
|-----------|----------------------------|
| Xem workspaces / tables / preview | `workspaces >= view` |
| Tạo / sửa workspace, thêm table | `workspaces >= edit` |
| Xóa workspace / table | `workspaces = full` |

**✅ Checkpoint Bước 0:**
- [ ] Có `access_token`
- [ ] Có ít nhất 1 `datasource_id` đã kết nối
- [ ] User có permission `workspaces >= edit`

---

## Bước 1 — Tạo Workspace

### Endpoint

```http
POST /api/v1/dataset-workspaces
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "name": "Sales Analytics",       // ★ Bắt buộc, 1-200 ký tự
  "description": "CRM + Finance"   // Tùy chọn
}
```

### Response 201

```jsonc
{
  "id": 1,                          // Workspace ID — ghi nhận!
  "name": "Sales Analytics",
  "description": "CRM + Finance",
  "owner_id": "uuid-string",
  "user_permission": "full",
  "created_at": "2026-03-24T00:00:00Z",
  "updated_at": "2026-03-24T00:00:00Z"
}
```

### Xem danh sách Workspaces

```http
GET /api/v1/dataset-workspaces?skip=0&limit=100
```

### Xem chi tiết + bảng chứa trong workspace

```http
GET /api/v1/dataset-workspaces/{workspace_id}
```

→ Response chứa `tables[]` — tất cả tables đã thêm.

**✅ Checkpoint Bước 1:**
- [ ] Workspace tạo thành công, có `workspace_id`
- [ ] GET workspace trả về đúng name/description

---

## Bước 2 — Khám phá Datasource

Trước khi thêm table, cần biết datasource có những tables/columns nào.

### 2.1 Liệt kê Physical Tables của Datasource

```http
GET /api/v1/dataset-workspaces/datasources/{datasource_id}/tables
```

**Response 200:**
```jsonc
[
  {"name": "public.orders", "schema": "public", "table_type": "table"},
  {"name": "public.customers", "schema": "public", "table_type": "table"},
  {"name": "public.products", "schema": "public", "table_type": "view"}
]
```

### 2.2 Xem Columns của 1 Table

```http
GET /api/v1/dataset-workspaces/datasources/{datasource_id}/tables/columns?table=public.orders
```

**Response 200:**
```jsonc
{
  "columns": [
    {"name": "order_id", "type": "BIGINT"},
    {"name": "customer_id", "type": "INTEGER"},
    {"name": "amount", "type": "DOUBLE"},
    {"name": "status", "type": "VARCHAR"},
    {"name": "created_at", "type": "TIMESTAMP"}
  ]
}
```

> Lưu ý: `type` ở đây là SQL raw type (VARCHAR, DOUBLE, TIMESTAMP...). AppBI sẽ tự infer sang loại đơn giản (string, number, date...) khi preview.

**✅ Checkpoint Bước 2:**
- [ ] Biết tên chính xác các tables trong datasource (vd: `"public.orders"`, `"Sheet1"`)
- [ ] Biết danh sách columns + types cho mỗi table cần thêm

---

## Bước 3 — Thêm Table vào Workspace

### Endpoint

```http
POST /api/v1/dataset-workspaces/{workspace_id}/tables
Content-Type: application/json
Authorization: Bearer <token>
```

### Cách 1: Physical Table (import trực tiếp)

```jsonc
{
  "datasource_id": 1,                    // ★ ID datasource
  "source_kind": "physical_table",       // ★ Loại: import table vật lý
  "source_table_name": "public.orders",  // ★ Tên table (lấy từ Bước 2.1)
  "display_name": "Orders",              // ★ Tên hiển thị trên UI
  "enabled": true,                       // Mặc định true
  "transformations": []                  // Có thể thêm computed columns ngay
}
```

### Cách 2: SQL Query (query tùy chỉnh)

```jsonc
{
  "datasource_id": 1,                    // ★ ID datasource
  "source_kind": "sql_query",            // ★ Loại: SQL query
  "source_query": "SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = 'completed'",
  "display_name": "Completed Orders with Customer",
  "enabled": true
}
```

> ⚠️ **JOIN ở level datasource**: Nếu cần JOIN giữa các tables **trong cùng 1 datasource**, dùng `source_kind: "sql_query"` và viết SQL JOIN trực tiếp. Đây là cách duy nhất để thực hiện SQL JOIN.

### Response 201

```jsonc
{
  "id": 2,                               // ★ Table ID — ghi nhận!
  "workspace_id": 1,
  "datasource_id": 1,
  "source_kind": "physical_table",
  "source_table_name": "public.orders",
  "source_query": null,
  "display_name": "Orders",
  "enabled": true,
  "transformations": [],
  "columns_cache": null,                  // Sẽ được populate sau khi preview
  "sample_cache": null,
  "type_overrides": null,
  "column_formats": null,
  "created_at": "2026-03-24T...",
  "updated_at": "2026-03-24T..."
}
```

### Validation khi thêm Table

| Kiểm tra | Lỗi nếu vi phạm |
|----------|-----------------|
| `source_kind = "physical_table"` → phải có `source_table_name` | 422 Validation Error |
| `source_kind = "sql_query"` → phải có `source_query` | 422 Validation Error |
| `source_kind` chỉ chấp nhận `"physical_table"` / `"sql_query"` | 422 Validation Error |
| `datasource_id` phải tồn tại | 400 Bad Request |
| Workspace phải tồn tại | 404 Not Found |
| SQL query syntax (nếu `sql_query`) | 400 Bad Request + message |

**✅ Checkpoint Bước 3:**
- [ ] Table tạo thành công, có `table_id`
- [ ] `source_kind` đúng loại
- [ ] `display_name` rõ ràng

---

## Bước 4 — Preview Data & Kiểm tra cột

### Endpoint

```http
POST /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}/preview
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "limit": 100,    // Số rows trả về (1-1000, default 100)
  "offset": 0      // Phân trang (default 0)
}
```

### Response 200

```jsonc
{
  "columns": [
    {"name": "order_id", "type": "integer", "nullable": false},
    {"name": "customer_name", "type": "string", "nullable": true},
    {"name": "amount", "type": "float", "nullable": true},
    {"name": "status", "type": "string", "nullable": true},
    {"name": "created_at", "type": "datetime", "nullable": true}
  ],
  "rows": [
    {"order_id": 1, "customer_name": "Acme Corp", "amount": 1500.00, "status": "active", "created_at": "2026-03-01T10:30:00"},
    {"order_id": 2, "customer_name": "TechStart", "amount": 750.00, "status": "deactive", "created_at": "2026-03-02T14:15:00"}
  ],
  "total": 37422,
  "has_more": true
}
```

### ⚠️ Mục đích quan trọng của Preview

1. **Xác nhận columns** — biết chính xác tên cột + kiểu dữ liệu
2. **Xem giá trị thực** — tránh giả sử sai khi filter (vd: `"active"` vs `"true"`)
3. **Populate cache** — Backend cache columns + 500 sample rows (dùng cho LOOKUP)
4. **Type inference** — Backend tự nhận dạng type từ data thực tế

### Lỗi thường gặp

| Lỗi | Nguyên nhân | Khắc phục |
|-----|-------------|-----------|
| 422 `NOT_SYNCED` | Table chưa sync vào DuckDB | Chờ auto-sync hoặc trigger sync |
| 500 | SQL query sai syntax | Kiểm tra `source_query` |
| Rows rỗng | Table nguồn trống hoặc filter quá chặt | Kiểm tra datasource gốc |

**✅ Checkpoint Bước 4:**
- [ ] Preview trả về columns + rows
- [ ] Ghi nhận tên chính xác các cột (dùng cho formula, chart)
- [ ] Kiểm tra giá trị thực tế (đặc biệt cho filters/conditions)

---

## Bước 5 — Thêm cột tính toán (Computed Columns)

### Tổng quan

Có 2 cách thêm cột tính toán:

| Cách | Transformation type | Chạy ở đâu | Hỗ trợ LOOKUP | Hỗ trợ 47 hàm Excel |
|------|-------------------|-------------|----------------|---------------------|
| **js_formula** (Khuyến nghị) | `"js_formula"` | Frontend (browser) | ✅ Có | ✅ Có |
| **add_column** (SQL) | `"add_column"` | Backend (DuckDB) | ❌ Không | ❌ Không (chỉ SQL) |

### 5.1 Cách 1: `js_formula` — Formula Excel (Khuyến nghị)

#### Cú pháp cơ bản

- **Tham chiếu cột**: `[Tên_Cột]` → giá trị của cột đó trong dòng hiện tại
- **Chuỗi**: `"Hello"` (dấu nháy kép)
- **Số**: `123`, `1.5`
- **Toán tử**: `+`, `-`, `*`, `/`, `&` (nối chuỗi), `>`, `<`, `>=`, `<=`, `=` (so sánh bằng), `<>` (khác)
- **Hằng số**: `TRUE`, `FALSE`

#### Cách gửi qua API

```http
PUT /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}
Content-Type: application/json
Authorization: Bearer <token>
```

```jsonc
{
  "transformations": [
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "revenue_tier",                    // ★ Tên cột mới
        "formula": "IF([amount]>1000000,\"High\",IF([amount]>500000,\"Medium\",\"Low\"))"  // ★ Formula
      }
    }
  ]
}
```

> ⚠️ **QUAN TRỌNG**: Field `transformations` khi PUT sẽ **THAY THẾ TOÀN BỘ** mảng cũ, KHÔNG merge. Nếu table đã có transformations, phải gửi lại TẤT CẢ + cái mới.

#### Ví dụ: Thêm nhiều computed columns

```jsonc
{
  "transformations": [
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "revenue_tier",
        "formula": "IF([amount]>1000000,\"High\",IF([amount]>500000,\"Medium\",\"Low\"))"
      }
    },
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "full_name",
        "formula": "CONCATENATE([first_name],\" \",[last_name])"
      }
    },
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "days_since_order",
        "formula": "DATEDIF([order_date],TODAY(),\"D\")"
      }
    },
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "amount_formatted",
        "formula": "TEXT([amount],\"#,##0\")"
      }
    }
  ]
}
```

### 5.2 Cách 2: `add_column` — SQL Expression (Server-side)

#### Khi nào dùng

- Cần performance cao (chạy trên DuckDB, không phải per-row trên browser)
- Logic đơn giản: CASE WHEN, phép toán

#### Cú pháp

```jsonc
{
  "transformations": [
    {
      "type": "add_column",
      "enabled": true,
      "params": {
        "newField": "is_active_flag",                  // ★ Tên cột mới
        "expression": "CASE WHEN is_active = 'active' THEN 1 ELSE 0 END"  // ★ SQL expression
      }
    }
  ]
}
```

#### SQL Expression được phép

| Cho phép | Ví dụ |
|---------|-------|
| CASE WHEN | `CASE WHEN x > 0 THEN 'yes' ELSE 'no' END` |
| Phép toán | `price * quantity`, `(a + b) / 2` |
| IF() | `IF(amount > 1000, 'high', 'low')` → tự chuyển thành CASE WHEN |
| ROUND() | `ROUND(price, 2)` |
| COALESCE() | `COALESCE(name, 'Unknown')` |
| So sánh | `=`, `!=`, `>`, `<`, `>=`, `<=` |

#### SQL Expression BỊ CHẶN (bảo mật)

| Từ khóa bị cấm | Lý do |
|----------------|-------|
| `SELECT`, `FROM`, `WHERE`, `JOIN` | Ngăn SQL injection |
| `INSERT`, `UPDATE`, `DELETE` | Ngăn thay đổi data |
| `DROP`, `ALTER`, `CREATE`, `TRUNCATE` | Ngăn thay đổi schema |
| `EXEC`, `EXECUTE` | Ngăn chạy stored procedures |
| `;` (semicolon) | Ngăn chaining commands |

### 5.3 Các Transformation khác

#### `select_columns` — Chỉ giữ lại cột cần thiết

```jsonc
{
  "type": "select_columns",
  "enabled": true,
  "params": {
    "columns": ["order_id", "customer_name", "amount", "revenue_tier"]
  }
}
```

#### `rename_columns` — Đổi tên cột

```jsonc
{
  "type": "rename_columns",
  "enabled": true,
  "params": {
    "mapping": {
      "amt": "amount",
      "cust_nm": "customer_name"
    }
  }
}
```

### 5.4 Kết hợp nhiều loại Transformation

Transformations chạy **theo thứ tự** trong mảng. Có thể kết hợp:

```jsonc
{
  "transformations": [
    {
      "type": "add_column",
      "enabled": true,
      "params": {
        "newField": "total",
        "expression": "price * quantity"
      }
    },
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "tier",
        "formula": "IF([total]>10000,\"VIP\",\"Normal\")"
      }
    },
    {
      "type": "rename_columns",
      "enabled": true,
      "params": {
        "mapping": {"cust_id": "customer_id"}
      }
    },
    {
      "type": "select_columns",
      "enabled": true,
      "params": {
        "columns": ["customer_id", "total", "tier", "order_date"]
      }
    }
  ]
}
```

> Thứ tự: `add_column` (SQL) → `js_formula` (frontend) → `rename` → `select`

> Lưu ý: `js_formula` chạy TRÊN KẾT QUẢ SAU KHI add_column đã tính. Frontend sẽ nhận data từ backend (đã có cột `total` từ `add_column`), rồi tính thêm cột `tier` bằng `js_formula`.

**✅ Checkpoint Bước 5:**
- [ ] Transformations gửi đúng format `[{type, enabled, params}, ...]`
- [ ] `newField` không trùng tên cột gốc (nên dùng snake_case)
- [ ] Formula sử dụng `[Tên_Cột]` chính xác (case-sensitive)
- [ ] Preview lại sau khi update → columns mới xuất hiện

---

## Bước 6 — LOOKUP / VLOOKUP (Tham chiếu bảng khác)

### Tổng quan

LOOKUP cho phép **lấy giá trị từ bảng khác** trong cùng workspace. Giống VLOOKUP trong Excel.

### Cú pháp

```
LOOKUP(giá_trị_tìm, "Tên_Bảng", "cột_tìm", "cột_trả_về")
VLOOKUP(giá_trị_tìm, "Tên_Bảng", "cột_tìm", "cột_trả_về")
```

| Tham số | Kiểu | Mô tả |
|---------|------|-------|
| `giá_trị_tìm` | giá trị / `[Column]` | Giá trị cần tìm (thường là cột của table hiện tại) |
| `"Tên_Bảng"` | string | `display_name` của table đích trong workspace |
| `"cột_tìm"` | string | Tên cột trong table đích để so sánh |
| `"cột_trả_về"` | string | Tên cột trong table đích để trả về giá trị |

### Ví dụ thực tế

**Workspace có 2 tables:**
- **Orders** (Table A): `order_id`, `customer_id`, `amount`, `product_id`
- **Customers** (Table B): `id`, `name`, `email`, `region`

**Muốn thêm cột `customer_name` vào Orders từ Customers:**

```jsonc
// PUT /dataset-workspaces/{ws_id}/tables/{orders_table_id}
{
  "transformations": [
    {
      "type": "js_formula",
      "enabled": true,
      "params": {
        "newField": "customer_name",
        "formula": "LOOKUP([customer_id],\"Customers\",\"id\",\"name\")"
      }
    }
  ]
}
```

**Kết quả:**

| order_id | customer_id | amount | customer_name |
|----------|------------|--------|---------------|
| 1 | C001 | 1500 | Acme Corp |
| 2 | C002 | 750 | TechStart |
| 3 | C001 | 2000 | Acme Corp |

### LOOKUP lồng nhau (Nested)

```
IF(LOOKUP([product_id],"Products","id","category")="Electronics",
   [amount]*1.1,
   [amount])
```

→ Nếu sản phẩm là Electronics → tăng amount 10%.

### LOOKUP + String concat

```
CONCATENATE(LOOKUP([customer_id],"Customers","id","name")," (",LOOKUP([customer_id],"Customers","id","region"),")")
```

→ Kết quả: `"Acme Corp (APAC)"`

### ⚠️ Quy tắc & Giới hạn LOOKUP

| Quy tắc | Mô tả |
|---------|-------|
| **Case-insensitive** | Tên bảng và giá trị so sánh đều không phân biệt hoa/thường |
| **First match** | Trả về dòng đầu tiên tìm thấy (nếu nhiều match) |
| **NULL nếu không tìm thấy** | Trả về `null` nếu không có dòng nào match |
| **Giới hạn 500 rows** | LOOKUP dùng sample cache (tối đa 500 rows). Table đích > 500 rows → có thể thiếu |
| **Phải preview table đích trước** | Table đích cần được preview ít nhất 1 lần để có sample cache |
| **Cùng workspace** | Chỉ LOOKUP được tables trong cùng workspace |
| **Xóa table đích → bị chặn** | Nếu table B đang được LOOKUP bởi table A, xóa table B sẽ bị 409 |

### Xử lý NULL (khi LOOKUP không tìm thấy)

```
IFERROR(LOOKUP([customer_id],"Customers","id","name"),"Unknown Customer")
```

**✅ Checkpoint Bước 6:**
- [ ] Table đích đã có trong workspace + đã preview (có sample cache)
- [ ] `display_name` table đích viết chính xác trong formula (case-insensitive)
- [ ] Tên cột tìm kiếm + cột trả về viết chính xác
- [ ] Preview lại table gốc → cột LOOKUP có giá trị

---

## Bước 7 — Type Overrides & Column Formats

### 7.1 Type Overrides

Override kiểu dữ liệu tự nhận dạng (type inference) của cột.

```http
PUT /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}
Content-Type: application/json
```

```jsonc
{
  "type_overrides": {
    "amount": "float",
    "created_at": "date",
    "is_active": "boolean",
    "qty": "integer",
    "price": "currency"
  }
}
```

**Các loại type:**

| Type | Mô tả | UI behavior |
|------|--------|-------------|
| `string` | Văn bản | Align trái |
| `integer` | Số nguyên | Align phải, không decimal |
| `float` | Số thập phân | Align phải |
| `boolean` | True/False | Checkbox / badge |
| `date` | Ngày YYYY-MM-DD | Date picker |
| `datetime` | Ngày + giờ | DateTime picker |
| `currency` | Tiền tệ | Ký hiệu tiền + format |

### 7.2 Column Formats

Định dạng hiển thị cho cột (không ảnh hưởng data gốc).

```jsonc
{
  "column_formats": {
    "amount": {
      "formatType": "currency",          // Loại format
      "currencySymbol": "$",             // Ký hiệu ($, €, £, ¥, ₫, ₩)
      "decimalPlaces": 2,                // Số chữ số thập phân
      "thousandsSeparator": true,        // Phân cách hàng nghìn
      "displayUnit": "none"             // none, K, M, B
    },
    "growth_rate": {
      "formatType": "percentage",
      "decimalPlaces": 1
    },
    "order_date": {
      "formatType": "date",
      "dateFormat": "DD/MM/YYYY"         // 12 format có sẵn
    },
    "customer_name": {
      "formatType": "text",
      "textCase": "upper",              // none, upper, lower, title
      "prefix": "",
      "suffix": ""
    },
    "revenue": {
      "formatType": "number",
      "decimalPlaces": 0,
      "thousandsSeparator": true,
      "displayUnit": "M"                // Hiển thị: 12,345,678 → 12.3M
    }
  }
}
```

**Các `formatType`:**

| formatType | Params | Ví dụ output |
|------------|--------|--------------|
| `default` | — | Giữ nguyên |
| `number` | `decimalPlaces`, `thousandsSeparator`, `displayUnit` | `12,345.67` |
| `currency` | `currencySymbol`, `decimalPlaces`, `thousandsSeparator`, `displayUnit` | `$12,345.67` |
| `percentage` | `decimalPlaces` | `85.5%` |
| `date` | `dateFormat` | `24/03/2026` |
| `datetime` | `dateFormat` | `24/03/2026 14:30` |
| `text` | `textCase`, `prefix`, `suffix` | `HELLO WORLD` |

**Các `dateFormat` có sẵn:**

```
DD/MM/YYYY      MM/DD/YYYY      YYYY-MM-DD
DD-MM-YYYY      MM-DD-YYYY      YYYY/MM/DD
DD.MM.YYYY      MMM DD, YYYY    DD MMM YYYY
HH:mm           HH:mm:ss        DD/MM/YYYY HH:mm
```

**✅ Checkpoint Bước 7:**
- [ ] `type_overrides` chỉ gửi cho cột cần override (các cột khác giữ auto-inferred)
- [ ] `column_formats` match đúng `formatType` + params
- [ ] Preview lại → format áp dụng đúng

---

## Bước 8 — Execute Query (Aggregation)

Execute cho phép chạy aggregation query trên table (tương tự GROUP BY trong SQL).

### Endpoint

```http
POST /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}/execute
Content-Type: application/json
Authorization: Bearer <token>
```

### Request Body

```jsonc
{
  "dimensions": ["region", "status"],     // GROUP BY columns
  "measures": [                           // Aggregation functions
    {
      "field": "amount",                  // ★ Tên cột
      "function": "sum"                   // ★ Hàm: sum|avg|count|min|max|count_distinct
    },
    {
      "field": "order_id",
      "function": "count"
    }
  ],
  "filters": [                           // WHERE conditions
    {
      "field": "status",
      "operator": "=",                   // SQL operators: =, !=, >, <, >=, <=, LIKE, IN
      "value": "active"
    }
  ],
  "order_by": [                          // ORDER BY
    {
      "field": "amount_sum",             // Tên cột kết quả: {field}_{function}
      "direction": "DESC"                // ASC | DESC
    }
  ],
  "limit": 1000                         // 1-10000, default 1000
}
```

### ⚠️ Lưu ý quan trọng về Operators

Execute endpoint dùng **SQL operators** (khác với Chart config dùng word-form):

| Execute Operator | Chart Config Operator | Nghĩa |
|-----------------|----------------------|--------|
| `=` | `eq` | Bằng |
| `!=` | `neq` | Khác |
| `>` | `gt` | Lớn hơn |
| `<` | `lt` | Nhỏ hơn |
| `>=` | `gte` | Lớn hơn hoặc bằng |
| `<=` | `lte` | Nhỏ hơn hoặc bằng |
| `LIKE` | `contains` | Chứa pattern |
| `IN` | `in` | Trong danh sách |

### Tên cột kết quả

- Nếu không có `alias`: `{field}_{function}` → vd: `amount_sum`, `order_id_count`
- Nếu có `alias`: dùng alias → vd: `total_revenue`, `record_count`

### Response 200

```jsonc
{
  "columns": [
    {"name": "region", "type": "string", "nullable": true},
    {"name": "status", "type": "string", "nullable": true},
    {"name": "amount_sum", "type": "number", "nullable": true},
    {"name": "order_id_count", "type": "number", "nullable": true}
  ],
  "rows": [
    {"region": "APAC", "status": "active", "amount_sum": 245000.50, "order_id_count": 127},
    {"region": "EU", "status": "active", "amount_sum": 189000.00, "order_id_count": 95}
  ]
}
```

**✅ Checkpoint Bước 8:**
- [ ] `dimensions` + `measures` dùng đúng tên cột (từ preview)
- [ ] `function` là 1 trong: `sum`, `avg`, `count`, `min`, `max`, `count_distinct`
- [ ] `filters` dùng SQL operators (`=`, `!=`, không phải `eq`, `neq`)
- [ ] Response có rows > 0

---

## Bước 9 — Xóa Table / Workspace

### 9.1 Xóa Table khỏi Workspace

```http
DELETE /api/v1/dataset-workspaces/{workspace_id}/tables/{table_id}
Authorization: Bearer <token>
```

**Nếu thành công**: 204 No Content

**Nếu table đang được sử dụng**: 409 Conflict

```jsonc
{
  "status": 409,
  "detail": {
    "message": "Table \"Orders\" is in use and cannot be deleted",
    "constraints": [
      {"type": "chart", "id": 5, "name": "Revenue by Month"},
      {"type": "lookup", "table_id": 3, "table_name": "Returns", "column": "original_order_id"}
    ]
  }
}
```

**Constraint types:**

| Type | Mô tả | Khắc phục |
|------|--------|-----------|
| `chart` | Chart đang dùng `workspace_table_id` = table này | Xóa chart trước |
| `lookup` | Table khác đang LOOKUP đến table này | Xóa/sửa formula LOOKUP ở table kia trước |

### 9.2 Xóa Workspace

```http
DELETE /api/v1/dataset-workspaces/{workspace_id}
Authorization: Bearer <token>
```

- Cần permission `workspaces = full`
- **CASCADE xóa TẤT CẢ tables** trong workspace
- Charts reference các tables bị xóa sẽ mất data source

> ⚠️ Xóa workspace là hành động KHÔNG THỂ HOÀN TÁC. Nên kiểm tra charts và dashboards trước.

### 9.3 Thứ tự xóa an toàn

```
1. Xóa Dashboards (dashboard trước → charts vẫn còn)
2. Xóa Charts (chart phải xóa trước tables)
3. Xóa Tables (LOOKUP dependencies → xóa table phụ thuộc trước)
4. Xóa Workspace (cascade tất cả)
```

---

## Tham khảo: Tất cả Endpoints

### Workspace Endpoints

| Method | Path | Permission | Mô tả |
|--------|------|-----------|--------|
| `GET` | `/dataset-workspaces/` | `view` | Danh sách (owned + shared) |
| `POST` | `/dataset-workspaces/` | `edit` | Tạo workspace |
| `GET` | `/dataset-workspaces/{id}` | `view` | Chi tiết + tables |
| `PUT` | `/dataset-workspaces/{id}` | `edit` | Sửa name/description |
| `DELETE` | `/dataset-workspaces/{id}` | `full` | Xóa workspace + CASCADE tables |

### Table Endpoints

| Method | Path | Permission | Mô tả |
|--------|------|-----------|--------|
| `GET` | `/dataset-workspaces/{ws_id}/tables` | `view` | List tables |
| `POST` | `/dataset-workspaces/{ws_id}/tables` | `edit` | Thêm table |
| `PUT` | `/dataset-workspaces/{ws_id}/tables/{t_id}` | `edit` | Update table config |
| `DELETE` | `/dataset-workspaces/{ws_id}/tables/{t_id}` | `edit` | Xóa table (constraint check) |

### Data Endpoints

| Method | Path | Permission | Mô tả |
|--------|------|-----------|--------|
| `POST` | `/dataset-workspaces/{ws_id}/tables/{t_id}/preview` | `view` | Preview data |
| `POST` | `/dataset-workspaces/{ws_id}/tables/{t_id}/execute` | `view` | Aggregation query |

### Metadata Endpoints

| Method | Path | Permission | Mô tả |
|--------|------|-----------|--------|
| `GET` | `/dataset-workspaces/{ws_id}/tables/{t_id}/description` | `view` | AI-generated description |
| `PUT` | `/dataset-workspaces/{ws_id}/tables/{t_id}/description` | `edit` | Update description |
| `POST` | `/dataset-workspaces/{ws_id}/tables/{t_id}/description/regenerate` | `edit` | Regenerate AI description |

### Discovery Endpoints

| Method | Path | Permission | Mô tả |
|--------|------|-----------|--------|
| `GET` | `/dataset-workspaces/tables/search?q=query&limit=10` | `view` | Vector search tables |
| `GET` | `/dataset-workspaces/datasources/{ds_id}/tables` | any | List datasource tables |
| `GET` | `/dataset-workspaces/datasources/{ds_id}/tables/columns?table=name` | any | Column metadata |

---

## Tham khảo: Transformation System

### Cấu trúc Transformation

```jsonc
{
  "type": "js_formula",        // ★ Loại: js_formula | add_column | select_columns | rename_columns
  "enabled": true,             // Có kích hoạt không (default true)
  "params": {                  // ★ Tham số (khác nhau theo type)
    "newField": "column_name",
    "formula": "..."
  }
}
```

### Bảng Transformation Types

| Type | Params | Chạy ở đâu | Mô tả |
|------|--------|-------------|--------|
| `js_formula` | `newField` ★, `formula` ★ | Frontend | Thêm cột tính toán bằng formula Excel |
| `add_column` | `newField` ★, `expression` ★ | Backend (DuckDB) | Thêm cột bằng SQL expression |
| `select_columns` | `columns[]` ★ | Backend | Giữ lại chỉ các cột trong danh sách |
| `rename_columns` | `mapping` ★ `{old: new}` | Backend | Đổi tên cột |

### Thứ tự thực thi

1. Backend compilations: `add_column` → `select_columns` → `rename_columns` (compiled to SQL CTE)
2. `js_formula`: **bị bỏ qua** bởi backend → frontend tính per-row sau khi nhận data

### ⚠️ PUT Transformations = REPLACE ALL

Khi PUT với `transformations`, **toàn bộ mảng cũ bị thay thế**. Workflow đúng:

```python
# 1. GET table hiện tại
table = GET /dataset-workspaces/{ws_id}/tables/{t_id}
existing = table["transformations"] or []

# 2. Thêm transformation mới
existing.append({
    "type": "js_formula",
    "enabled": True,
    "params": {"newField": "new_col", "formula": "..."}
})

# 3. PUT lại toàn bộ
PUT /dataset-workspaces/{ws_id}/tables/{t_id}
{"transformations": existing}
```

---

## Tham khảo: Tất cả hàm Formula (47 hàm)

### Logic (5 hàm)

| Hàm | Mô tả | Cú pháp | Ví dụ |
|-----|--------|---------|-------|
| `IF` | Điều kiện | `IF(condition, true_val, false_val)` | `IF([amount]>1000,"High","Low")` |
| `IFERROR` | Bẫy lỗi | `IFERROR(expr, fallback)` | `IFERROR([a]/[b], 0)` |
| `AND` | Và (tất cả true) | `AND(cond1, cond2, ...)` | `AND([a]>0, [b]>0)` |
| `OR` | Hoặc (ít nhất 1 true) | `OR(cond1, cond2, ...)` | `OR([status]="active", [status]="pending")` |
| `NOT` | Phủ định | `NOT(condition)` | `NOT([is_deleted])` |

### Số học (12 hàm)

| Hàm | Mô tả | Cú pháp | Ví dụ |
|-----|--------|---------|-------|
| `ROUND` | Làm tròn | `ROUND(number, decimals)` | `ROUND([price]*[qty], 2)` |
| `ROUNDUP` | Làm tròn lên | `ROUNDUP(number, decimals)` | `ROUNDUP([val], 0)` |
| `ROUNDDOWN` | Làm tròn xuống | `ROUNDDOWN(number, decimals)` | `ROUNDDOWN([val], 2)` |
| `ABS` | Trị tuyệt đối | `ABS(number)` | `ABS([diff])` |
| `MOD` | Phần dư | `MOD(number, divisor)` | `MOD([total], 7)` |
| `POWER` | Lũy thừa | `POWER(base, exponent)` | `POWER([base], 2)` |
| `SQRT` | Căn bậc hai | `SQRT(number)` | `SQRT([area])` |
| `SUM` | Tổng nhiều giá trị | `SUM(val1, val2, ...)` | `SUM([a], [b], [c])` |
| `MAX` | Giá trị lớn nhất | `MAX(val1, val2, ...)` | `MAX([score1], [score2])` |
| `MIN` | Giá trị nhỏ nhất | `MIN(val1, val2, ...)` | `MIN([a], [b])` |
| `CEILING` | Làm tròn lên bội số | `CEILING(number, significance)` | `CEILING([val], 1000)` |
| `FLOOR` | Làm tròn xuống bội số | `FLOOR(number, significance)` | `FLOOR([val], 1000)` |

### Chuỗi (11 hàm)

| Hàm | Mô tả | Cú pháp | Ví dụ |
|-----|--------|---------|-------|
| `CONCATENATE` | Nối chuỗi | `CONCATENATE(s1, s2, ...)` | `CONCATENATE([first]," ",[last])` |
| `LEFT` | N ký tự từ trái | `LEFT(text, n)` | `LEFT([code], 3)` |
| `RIGHT` | N ký tự từ phải | `RIGHT(text, n)` | `RIGHT([code], 4)` |
| `MID` | Cắt giữa | `MID(text, start, length)` | `MID([code], 2, 3)` |
| `LEN` | Độ dài chuỗi | `LEN(text)` | `LEN([name])` |
| `TRIM` | Xóa khoảng trắng | `TRIM(text)` | `TRIM([name])` |
| `UPPER` | Viết hoa | `UPPER(text)` | `UPPER([name])` |
| `LOWER` | Viết thường | `LOWER(text)` | `LOWER([email])` |
| `TEXT` | Định dạng số/ngày | `TEXT(value, format)` | `TEXT([price], "#,##0")` |
| `SUBSTITUTE` | Thay thế chuỗi | `SUBSTITUTE(text, old, new)` | `SUBSTITUTE([addr], "HN", "Hà Nội")` |
| `FIND` | Tìm vị trí | `FIND(needle, text)` | `FIND("-", [code])` |

> Ghi chú: Toán tử `&` cũng nối chuỗi: `[first_name]&" "&[last_name]`

### Ngày tháng (7 hàm)

| Hàm | Mô tả | Cú pháp | Ví dụ |
|-----|--------|---------|-------|
| `TODAY` | Ngày hôm nay | `TODAY()` | `TODAY()` |
| `NOW` | Ngày giờ hiện tại | `NOW()` | `NOW()` |
| `DATE` | Tạo ngày | `DATE(year, month, day)` | `DATE(2026, 3, 14)` |
| `YEAR` | Lấy năm | `YEAR(date)` | `YEAR([order_date])` |
| `MONTH` | Lấy tháng | `MONTH(date)` | `MONTH([order_date])` |
| `DAY` | Lấy ngày | `DAY(date)` | `DAY([order_date])` |
| `DATEDIF` | Khoảng cách ngày | `DATEDIF(start, end, unit)` | `DATEDIF([birth], TODAY(), "Y")` |

**DATEDIF units:**

| Unit | Trả về |
|------|--------|
| `"Y"` | Số năm |
| `"M"` | Số tháng |
| `"D"` | Số ngày |

### Lookup (2 hàm)

| Hàm | Mô tả | Cú pháp | Ví dụ |
|-----|--------|---------|-------|
| `LOOKUP` | Tra cứu bảng khác | `LOOKUP(search, "Table", "searchCol", "returnCol")` | `LOOKUP([cust_id], "Customers", "id", "name")` |
| `VLOOKUP` | Alias của LOOKUP | `VLOOKUP(search, "Table", "searchCol", "returnCol")` | `VLOOKUP([prod_id], "Products", "id", "category")` |

### Toán tử

| Toán tử | Mô tả | Ví dụ |
|---------|--------|-------|
| `+` | Cộng | `[a] + [b]` |
| `-` | Trừ | `[a] - [b]` |
| `*` | Nhân | `[price] * [qty]` |
| `/` | Chia | `[total] / [count]` |
| `&` | Nối chuỗi | `[first] & " " & [last]` |
| `>` | Lớn hơn | `[amount] > 1000` |
| `<` | Nhỏ hơn | `[age] < 18` |
| `>=` | Lớn hơn bằng | `[score] >= 80` |
| `<=` | Nhỏ hơn bằng | `[qty] <= 0` |
| `=` | Bằng | `[status] = "active"` |
| `<>` | Khác | `[type] <> "test"` |

---

## Tham khảo: Schemas đầy đủ

### WorkspaceCreate (POST Request)

```python
class WorkspaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)  # ★
    description: Optional[str] = None
```

### WorkspaceUpdate (PUT Request)

```python
class WorkspaceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
```

### WorkspaceResponse

```python
class WorkspaceResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    owner_id: Optional[UUID]
    user_permission: Optional[str]   # "none" | "view" | "edit" | "full"
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
```

### TableCreate (POST Request)

```python
class TableCreate(BaseModel):
    datasource_id: int                                   # ★
    source_kind: str = Field(default="physical_table")  # ★ "physical_table" | "sql_query"
    source_table_name: Optional[str] = None             # ★ nếu physical_table
    source_query: Optional[str] = None                  # ★ nếu sql_query
    display_name: str                                    # ★
    enabled: bool = True
    transformations: Optional[List[Dict]] = None
```

### TableUpdate (PUT Request)

```python
class TableUpdate(BaseModel):
    display_name: Optional[str] = None
    source_query: Optional[str] = None                  # Update SQL (chỉ cho sql_query tables)
    enabled: Optional[bool] = None
    transformations: Optional[List[Dict]] = None        # REPLACE ALL (không merge!)
    type_overrides: Optional[Dict[str, str]] = None
    column_formats: Optional[Dict[str, Any]] = None
```

### TableResponse

```python
class TableResponse(BaseModel):
    id: int
    workspace_id: int
    datasource_id: int
    source_kind: str
    source_table_name: Optional[str]
    source_query: Optional[str]
    display_name: str
    enabled: bool
    transformations: Optional[List[Dict]]
    columns_cache: Optional[Union[List, Dict]]          # Cached column metadata
    sample_cache: Optional[List[Dict]]                  # Cached rows (max 500)
    type_overrides: Optional[Dict[str, str]]
    column_formats: Optional[Dict[str, Any]]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
```

### TablePreviewRequest

```python
class TablePreviewRequest(BaseModel):
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)
    filters: Optional[Dict] = None                     # Reserved
    sort: Optional[Dict] = None                        # Reserved
```

### TablePreviewResponse

```python
class TablePreviewResponse(BaseModel):
    columns: List[ColumnMetadata]   # [{name, type, nullable}]
    rows: List[Dict[str, Any]]
    total: int
    has_more: bool
```

### ExecuteQueryRequest

```python
class AggregationSpec(BaseModel):
    field: str                                          # ★ Column name
    function: str                                       # ★ sum|avg|count|min|max|count_distinct

class FilterCondition(BaseModel):
    field: str                                          # ★
    operator: str                                       # ★ =|!=|>|<|>=|<=|LIKE|IN
    value: str                                          # ★

class OrderBySpec(BaseModel):
    field: str                                          # ★
    direction: str = "DESC"                             # ASC | DESC

class ExecuteQueryRequest(BaseModel):
    dimensions: Optional[List[str]] = None
    measures: Optional[List[AggregationSpec]] = None
    filters: Optional[List[FilterCondition]] = None
    order_by: Optional[List[OrderBySpec]] = None
    limit: int = Field(default=1000, ge=1, le=10000)
```

### ExecuteQueryResponse

```python
class ExecuteQueryResponse(BaseModel):
    columns: List[ColumnMetadata]
    rows: List[Dict[str, Any]]
```

---

## Bảng lỗi thường gặp & Cách khắc phục

| # | Lỗi | Status | Nguyên nhân | Cách khắc phục |
|---|------|--------|-------------|----------------|
| 1 | Missing `source_table_name` | 422 | `source_kind="physical_table"` nhưng thiếu `source_table_name` | Gửi `source_table_name` (lấy từ discovery endpoint) |
| 2 | Missing `source_query` | 422 | `source_kind="sql_query"` nhưng thiếu `source_query` | Gửi `source_query` với SELECT statement |
| 3 | Invalid `source_kind` | 422 | Giá trị khác `"physical_table"` / `"sql_query"` | Chỉ dùng 2 giá trị hợp lệ |
| 4 | `NOT_SYNCED` | 422 | Table chưa sync vào DuckDB | Chờ auto-sync (xảy ra khi backend khởi động) hoặc trigger sync |
| 5 | SQL syntax error | 400 | `source_query` có lỗi cú pháp SQL | Kiểm tra lại SQL query. Thử chạy trên datasource gốc trước |
| 6 | Table in use (delete) | 409 | Chart hoặc LOOKUP đang reference table | Xóa chart / sửa LOOKUP formula trước. Response cho biết `constraints[]` cụ thể |
| 7 | Datasource not found | 400 | `datasource_id` không tồn tại | Kiểm tra: `GET /datasources` |
| 8 | Transformations bị mất | 200 | PUT `transformations` = mảng mới thiếu cái cũ | PUT thay thế TOÀN BỘ. Phải GET → append → PUT lại tất cả |
| 9 | Formula `[Column]` undefined | — (frontend) | Tên cột sai trong formula `[...]` | Kiểm tra tên cột chính xác từ preview (case-sensitive) |
| 10 | LOOKUP trả về NULL | — (frontend) | Table đích chưa preview / sample_cache rỗng / > 500 rows | Preview table đích trước. LOOKUP giới hạn 500 rows |
| 11 | Dangerous keyword blocked | 400 | `add_column` expression chứa SELECT/FROM/JOIN... | Dùng `js_formula` thay thế, hoặc viết expression đơn giản hơn |
| 12 | Permission denied | 403 | User không có `workspaces >= edit` | Kiểm tra module permission |
| 13 | Workspace not found | 404 | `workspace_id` không tồn tại | Kiểm tra: `GET /dataset-workspaces` |
| 14 | Execute filter sai operator | — | Dùng `eq` thay vì `=` | Execute dùng SQL operators (`=`, `!=`), KHÔNG phải word-form (`eq`, `neq`) |
| 15 | Computed column không hiện trong chart | — | `js_formula` chạy client-side, chart aggregation chạy server-side | Chart aggregation bỏ qua `js_formula` columns. Nếu cần group by cột tính toán → dùng `add_column` (SQL) |

---

## Ví dụ Python hoàn chỉnh

```python
"""
Ví dụ hoàn chỉnh:
1. Tạo workspace
2. Thêm 2 tables (orders + customers) từ datasource
3. Thêm computed columns (LOOKUP + formula)
4. Preview data
5. Execute aggregation query
"""
import requests
import json

BASE = "http://localhost:8000/api/v1"

# ── Bước 0: Auth ──
token = requests.post(f"{BASE}/auth/login", json={
    "email": "admin@appbi.io",
    "password": "123456"
}).json()["access_token"]

H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

# ── Bước 1: Tạo Workspace ──
ws = requests.post(f"{BASE}/dataset-workspaces", json={
    "name": "Sales Analytics",
    "description": "CRM Orders + Customer data"
}, headers=H).json()
ws_id = ws["id"]
print(f"✅ Workspace created: ID={ws_id}")

# ── Bước 2: Discover datasource tables ──
ds_id = 1  # ID datasource đã có
tables = requests.get(f"{BASE}/dataset-workspaces/datasources/{ds_id}/tables", headers=H).json()
print(f"📋 Available tables: {[t['name'] for t in tables]}")

# ── Bước 3: Thêm Table 1 — Orders (physical) ──
t1 = requests.post(f"{BASE}/dataset-workspaces/{ws_id}/tables", json={
    "datasource_id": ds_id,
    "source_kind": "physical_table",
    "source_table_name": "public.orders",
    "display_name": "Orders",
    "enabled": True,
    "transformations": []
}, headers=H).json()
orders_table_id = t1["id"]
print(f"✅ Table 'Orders' added: ID={orders_table_id}")

# ── Bước 3b: Thêm Table 2 — Customers (physical) ──
t2 = requests.post(f"{BASE}/dataset-workspaces/{ws_id}/tables", json={
    "datasource_id": ds_id,
    "source_kind": "physical_table",
    "source_table_name": "public.customers",
    "display_name": "Customers",
    "enabled": True
}, headers=H).json()
customers_table_id = t2["id"]
print(f"✅ Table 'Customers' added: ID={customers_table_id}")

# ── Bước 3c: Thêm Table 3 — SQL Query (JOIN trong datasource) ──
t3 = requests.post(f"{BASE}/dataset-workspaces/{ws_id}/tables", json={
    "datasource_id": ds_id,
    "source_kind": "sql_query",
    "source_query": """
        SELECT o.order_id, o.amount, o.status, o.created_at,
               c.name AS customer_name, c.region
        FROM public.orders o
        JOIN public.customers c ON o.customer_id = c.id
        WHERE o.status IN ('active', 'completed')
    """,
    "display_name": "Orders with Customer (JOIN)",
    "enabled": True
}, headers=H).json()
join_table_id = t3["id"]
print(f"✅ Table 'Orders with Customer' added: ID={join_table_id}")

# ── Bước 4: Preview để biết columns ──
preview = requests.post(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{orders_table_id}/preview",
    json={"limit": 5},
    headers=H
).json()
print(f"\n📊 Orders columns: {[c['name'] + ':' + c['type'] for c in preview['columns']]}")
print(f"   Total rows: {preview['total']}")
print(f"   Sample: {preview['rows'][:2]}")

# Preview Customers table (QUAN TRỌNG: cần cho LOOKUP cache)
preview_cust = requests.post(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{customers_table_id}/preview",
    json={"limit": 100},
    headers=H
).json()
print(f"\n📊 Customers columns: {[c['name'] for c in preview_cust['columns']]}")

# ── Bước 5: Thêm Computed Columns cho Orders ──
# Lấy transformations hiện tại
orders_current = requests.get(
    f"{BASE}/dataset-workspaces/{ws_id}",
    headers=H
).json()
# Tìm table Orders trong workspace
orders_table = next(t for t in orders_current.get("tables", []) if t["id"] == orders_table_id)
existing_transforms = orders_table.get("transformations") or []

# Thêm các computed columns mới
new_transforms = existing_transforms + [
    # 1. SQL-based: CASE WHEN (chạy server-side)
    {
        "type": "add_column",
        "enabled": True,
        "params": {
            "newField": "is_active_flag",
            "expression": "CASE WHEN status = 'active' THEN 1 ELSE 0 END"
        }
    },
    # 2. JS Formula: IF + tính toán (chạy client-side)
    {
        "type": "js_formula",
        "enabled": True,
        "params": {
            "newField": "amount_tier",
            "formula": "IF([amount]>1000000,\"Premium\",IF([amount]>500000,\"Standard\",\"Basic\"))"
        }
    },
    # 3. JS Formula: LOOKUP từ Customers table
    {
        "type": "js_formula",
        "enabled": True,
        "params": {
            "newField": "customer_name",
            "formula": "LOOKUP([customer_id],\"Customers\",\"id\",\"name\")"
        }
    },
    # 4. JS Formula: LOOKUP + String concat
    {
        "type": "js_formula",
        "enabled": True,
        "params": {
            "newField": "customer_info",
            "formula": "CONCATENATE(LOOKUP([customer_id],\"Customers\",\"id\",\"name\"),\" (\",LOOKUP([customer_id],\"Customers\",\"id\",\"region\"),\")\")"
        }
    },
    # 5. JS Formula: Date calculation
    {
        "type": "js_formula",
        "enabled": True,
        "params": {
            "newField": "days_ago",
            "formula": "DATEDIF([created_at],TODAY(),\"D\")"
        }
    }
]

update_resp = requests.put(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{orders_table_id}",
    json={"transformations": new_transforms},
    headers=H
)
update_resp.raise_for_status()
print(f"\n✅ Added {len(new_transforms)} transformations to Orders")

# ── Bước 6: Type Overrides + Column Formats ──
requests.put(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{orders_table_id}",
    json={
        "type_overrides": {
            "amount": "currency",
            "created_at": "datetime"
        },
        "column_formats": {
            "amount": {
                "formatType": "currency",
                "currencySymbol": "$",
                "decimalPlaces": 2,
                "thousandsSeparator": True
            }
        }
    },
    headers=H
).raise_for_status()
print("✅ Type overrides + formats applied")

# ── Bước 7: Preview lại để xác nhận ──
final_preview = requests.post(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{orders_table_id}/preview",
    json={"limit": 3},
    headers=H
).json()
print(f"\n📊 Final columns: {[c['name'] for c in final_preview['columns']]}")
for row in final_preview["rows"]:
    print(f"   {row}")

# ── Bước 8: Execute Aggregation ──
agg_result = requests.post(
    f"{BASE}/dataset-workspaces/{ws_id}/tables/{orders_table_id}/execute",
    json={
        "dimensions": ["status"],
        "measures": [
            {"field": "amount", "function": "sum"},
            {"field": "amount", "function": "avg"},
            {"field": "order_id", "function": "count"}
        ],
        "filters": [
            {"field": "amount", "operator": ">", "value": "0"}
        ],
        "order_by": [{"field": "amount_sum", "direction": "DESC"}],
        "limit": 100
    },
    headers=H
).json()
print(f"\n📈 Aggregation result:")
for row in agg_result["rows"]:
    print(f"   {row}")

print(f"\n🎉 Done! Workspace '{ws['name']}' ready with {3} tables + computed columns")
```

---

## Quick Reference Card

```
╔══════════════════════════════════════════════════════════════════════╗
║              DATASET WORKSPACE & TABLE API — QUICK REFERENCE        ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  TẠO WORKSPACE:                                                    ║
║  POST /dataset-workspaces                                            ║
║  {"name": "...", "description": "..."}                              ║
║                                                                      ║
║  KHÁM PHÁ DATASOURCE:                                              ║
║  GET /dataset-workspaces/datasources/{ds_id}/tables                  ║
║  GET /dataset-workspaces/datasources/{ds_id}/tables/columns?table=X  ║
║                                                                      ║
║  THÊM TABLE:                                                        ║
║  POST /dataset-workspaces/{ws_id}/tables                             ║
║  Physical: {"source_kind":"physical_table","source_table_name":"..."}║
║  SQL Query: {"source_kind":"sql_query","source_query":"SELECT..."}   ║
║                                                                      ║
║  PREVIEW DATA:                                                       ║
║  POST /dataset-workspaces/{ws_id}/tables/{t_id}/preview              ║
║  {"limit": 100}                                                      ║
║                                                                      ║
║  THÊM CỘT TÍNH TOÁN (Formula):                                     ║
║  PUT /dataset-workspaces/{ws_id}/tables/{t_id}                       ║
║  {"transformations": [{                                              ║
║    "type": "js_formula",                                             ║
║    "enabled": true,                                                  ║
║    "params": {"newField": "col", "formula": "IF([x]>0,1,0)"}       ║
║  }]}                                                                 ║
║  ⚠️ PUT thay thế TOÀN BỘ mảng! GET trước → append → PUT lại        ║
║                                                                      ║
║  LOOKUP (tham chiếu bảng khác):                                     ║
║  LOOKUP([cột_tìm], "Tên_Bảng", "cột_search", "cột_return")        ║
║  → Case-insensitive, first match, max 500 rows                      ║
║  → Phải preview table đích trước!                                    ║
║                                                                      ║
║  EXECUTE (Aggregation):                                              ║
║  POST /dataset-workspaces/{ws_id}/tables/{t_id}/execute              ║
║  {"dimensions": [...], "measures": [{"field":"x","function":"sum"}]} ║
║  ⚠️ Operators: = != > < >= <= LIKE IN (SQL, NOT eq/neq)            ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  TRANSFORMATION TYPES:                                               ║
║  js_formula  → Frontend, 47 hàm Excel, LOOKUP (khuyến nghị)        ║
║  add_column  → Backend SQL, CASE WHEN, math                         ║
║  select_columns → Giữ cột cần thiết                                 ║
║  rename_columns → Đổi tên cột                                       ║
║                                                                      ║
║  47 HÀM: Logic(5) + Số(12) + Chuỗi(11) + Ngày(7) + Lookup(2)      ║
║  + Toán tử: + - * / & > < >= <= = <>                                ║
║                                                                      ║
║  JOIN:                                                               ║
║  Cùng datasource → source_kind="sql_query" + viết SQL JOIN           ║  
║  Khác datasource → LOOKUP function (cross-table, max 500 rows)      ║
║                                                                      ║
║  PERMISSION: view(GET) | edit(POST/PUT) | full(DELETE)              ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

> **Xem thêm:** `GUIDED_API_CHART.md` (tạo charts) · `GUIDED_API_DASHBOARD.md` (tạo dashboards) · `API.md` (reference đầy đủ)
