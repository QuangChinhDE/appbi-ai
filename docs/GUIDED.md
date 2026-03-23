# AppBI — Hướng dẫn sử dụng

> Tài liệu này hướng dẫn người dùng mới sử dụng toàn bộ tính năng của AppBI từ đầu đến cuối.

---

## Mục lục

1. [Đăng nhập](#1-đăng-nhập)
2. [Kết nối nguồn dữ liệu (DataSource)](#2-kết-nối-nguồn-dữ-liệu-datasource)
3. [Đồng bộ dữ liệu vào hệ thống](#3-đồng-bộ-dữ-liệu-vào-hệ-thống)
4. [Tạo Dataset Workspace và bảng dữ liệu](#4-tạo-dataset-workspace-và-bảng-dữ-liệu)
5. [Tạo biểu đồ (Chart)](#5-tạo-biểu-đồ-chart)
6. [Tạo Dashboard](#6-tạo-dashboard)
7. [Bộ lọc toàn cục (Global Filters)](#7-bộ-lọc-toàn-cục-global-filters)
8. [Chia sẻ tài nguyên (Sharing)](#8-chia-sẻ-tài-nguyên-sharing)
9. [Quản lý phân quyền người dùng](#9-quản-lý-phân-quyền-người-dùng)
10. [AI Chat Agent](#10-ai-chat-agent)

---

## 1. Đăng nhập

Truy cập `http://localhost:3000` (hoặc địa chỉ server được cấp).

- Nhập **Email** và **Mật khẩu**
- Nhấn **Sign In**

Sau khi đăng nhập, bạn sẽ thấy sidebar bên trái với các module tương ứng quyền truy cập của tài khoản.

> **Lưu ý bảo mật**: Đăng nhập bị giới hạn **5 lần/phút** per IP. Nếu bị từ chối, chờ 1 phút rồi thử lại.

**Tài khoản demo:**

| Email | Mật khẩu | Vai trò |
|-------|----------|---------|
| `admin@appbi.io` | `admin123` | Toàn quyền |
| `edit@appbi.io` | `edit123` | Chỉnh sửa |
| `viewer@appbi.io` | `viewer123` | Chỉ xem |

---

## 2. Kết nối nguồn dữ liệu (DataSource)

**Data Sources** là nơi bạn khai báo kết nối tới cơ sở dữ liệu hoặc file dữ liệu bên ngoài.

### Tạo DataSource mới

1. Vào **Data Sources** trên sidebar → nhấn **+ New Data Source**
2. Điền thông tin:
   - **Name**: Tên gợi nhớ (ví dụ: "PostgreSQL Prod", "Google Sheets Sales")
   - **Type**: Chọn loại kết nối

### Các loại DataSource được hỗ trợ

| Loại | Thông tin cần điền |
|------|-------------------|
| **PostgreSQL** | Host, Port, Database, Username, Password, Schema |
| **MySQL** | Host, Port, Database, Username, Password |
| **BigQuery** | Project ID, Service Account JSON, Default Dataset |
| **Google Sheets** | Service Account JSON, Spreadsheet ID, Sheet Name |
| **Manual (CSV/Excel)** | Upload file trực tiếp |

### Ví dụ — Google Sheets

Để kết nối Google Sheets, cần có **Service Account** với quyền truy cập vào spreadsheet:

1. Chọn type **Google Sheets**
2. Dán nội dung file JSON của Service Account vào ô **Credentials JSON**
3. Nhập **Spreadsheet ID** (lấy từ URL của Google Sheet)
4. Nhập **Sheet Name** (tên tab, ví dụ: "Data Lake - Segment")
5. Nhấn **Test Connection** để kiểm tra kết nối
6. Nếu kết nối thành công → nhấn **Save**

> Service Account cần được thêm vào Google Sheet dưới dạng viewer/editor trước khi kết nối.

---

## 3. Đồng bộ dữ liệu vào hệ thống

AppBI lưu dữ liệu phân tích vào DuckDB (in-memory, rất nhanh). Để sử dụng được dữ liệu, cần **sync** từ nguồn vào hệ thống.

### Sync thủ công

1. Vào chi tiết DataSource → nhấn **Sync Now**
2. Hệ thống sẽ kéo toàn bộ dữ liệu từ nguồn và lưu vào file Parquet cục bộ
3. Sau khi sync xong, trạng thái sẽ hiển thị số dòng đã đồng bộ và thời gian lần cuối sync

> Dữ liệu đã sync được lưu lại qua các lần restart. Không cần sync lại mỗi lần khởi động server.

### Sync tự động (Scheduled Sync)

Trong cài đặt DataSource, có thể cấu hình **Sync Schedule** để tự động sync theo chu kỳ (hàng giờ, hàng ngày...).

---

## 4. Tạo Dataset Workspace và bảng dữ liệu

**Dataset Workspace** là không gian làm việc gom nhiều bảng từ các nguồn dữ liệu khác nhau lại thành một "schema ảo". Các biểu đồ được tạo từ bảng trong workspace.

### Tạo Workspace

1. Vào **Workspaces** → nhấn **+ New Workspace**
2. Đặt tên và mô tả cho workspace
3. Nhấn **Create**

### Thêm bảng vào Workspace

Sau khi tạo workspace, vào trang chi tiết và nhấn **+ Add Table**. Có 2 cách thêm bảng:

#### Cách 1 — Physical Table (bảng trực tiếp từ DataSource)

- Chọn **DataSource** đã kết nối
- Chọn **Schema** và **Table name** từ danh sách
- Đặt **Display Name** (tên hiển thị trong hệ thống)
- Nhấn **Save**

Dữ liệu của bảng này là dữ liệu đã được sync vào DuckDB.

#### Cách 2 — SQL Query (câu truy vấn tùy chỉnh)

- Chọn **DataSource** và chọn tab **SQL Query**
- Viết câu SQL để lọc/join/transform dữ liệu
- Hệ thống sẽ validate câu SQL trước khi lưu
- Nhấn **Save**

### Cột tính toán (Computed Columns)

Sau khi thêm bảng, có thể thêm **cột tính toán** bằng công thức Excel:

- Nhấn **Edit Table** → **Add Computed Column**
- Đặt tên cột mới và viết công thức, ví dụ:
  - `[revenue] / [qty]` → tính giá đơn vị
  - `ROUND([amount] * 1.1, 2)` → cộng 10% thuế
  - `LEFT([email], FIND("@", [email]) - 1)` → lấy username từ email
  - `IF([status] = "active", 1, 0)` → flag nhị phân

> Hỗ trợ các hàm: `IF`, `AND`, `OR`, `ROUND`, `ABS`, `LEN`, `LEFT`, `RIGHT`, `MID`, `UPPER`, `LOWER`, `TRIM`, `CONCAT`, `VALUE`, `TODAY`, `YEAR`, `MONTH`, `DAY`, `VLOOKUP`, `IFERROR`, `ISBLANK`, phép tính số học, so sánh, và nối chuỗi bằng `&`.

### Preview dữ liệu

Nhấn **Preview** trên bảng để xem 200 dòng đầu tiên cùng kiểu dữ liệu của từng cột.

---

## 5. Tạo biểu đồ (Chart)

**Charts** là các biểu đồ được lưu lại từ trang Explore, sử dụng dữ liệu từ một bảng trong workspace.

### Tạo Chart từ Explore

1. Vào **Explore** → nhấn **+ New Chart** (hoặc vào workspace → nhấn **Explore** trên bảng)
2. Chọn **Workspace** và **Table**
3. Chọn **Chart Type**
4. Cấu hình trường dữ liệu theo loại biểu đồ:

| Loại biểu đồ | Cấu hình |
|---|---|
| **Bar / Line / Area** | Dimension (trục X), Metrics (trục Y, chọn hàm tổng hợp) |
| **Grouped Bar** | Dimension + nhiều Metrics |
| **Stacked Bar** | Dimension + Metrics + Breakdown (phân nhóm thêm) |
| **Pie** | Label Field (nhãn), Value Field (giá trị) |
| **Scatter** | X Field, Y Field |
| **KPI** | Value Field (hiển thị một số lớn) |
| **Time Series** | Time Field (trục X), Value Field (trục Y) |
| **Table** | Chọn các cột muốn hiển thị |

5. Thêm **Filters** nếu cần (lọc dữ liệu trước khi vẽ biểu đồ)
6. Nhấn **Run** để xem preview
7. Nhập tên → nhấn **Save Chart**

### Các hàm tổng hợp (Aggregation)

| Hàm | Ý nghĩa |
|---|---|
| `sum` | Tổng |
| `avg` | Trung bình |
| `count` | Đếm số dòng |
| `count_distinct` | Đếm giá trị duy nhất |
| `min` | Giá trị nhỏ nhất |
| `max` | Giá trị lớn nhất |

---

## 6. Tạo Dashboard

**Dashboard** là tập hợp nhiều biểu đồ được bố trí trên một màn hình.

### Tạo Dashboard mới

1. Vào **Dashboards** → nhấn **+ New Dashboard**
2. Đặt tên và mô tả → nhấn **Create**

### Thêm biểu đồ vào Dashboard

1. Vào trang chi tiết Dashboard → nhấn **+ Add Chart**
2. Tìm và chọn biểu đồ từ danh sách
3. Biểu đồ sẽ xuất hiện trên grid

### Sắp xếp bố cục

- **Kéo thả**: Giữ vào thanh tiêu đề biểu đồ (có icon 6 chấm) để di chuyển
- **Thay đổi kích thước**: Kéo góc dưới bên phải của tile biểu đồ
- Layout được lưu tự động sau khi thả

### Xóa biểu đồ khỏi Dashboard

Nhấn icon **X** trên góc biểu đồ để gỡ khỏi dashboard (biểu đồ gốc không bị xóa).

---

## 7. Bộ lọc toàn cục (Global Filters)

Global Filters cho phép lọc dữ liệu trên toàn bộ biểu đồ trong dashboard cùng một lúc.

### Cấu hình Filter

1. Trên trang Dashboard → nhấn **Filters** (góc trên phải)
2. Nhấn **+ Add Filter**
3. Chọn:
   - **Label**: Tên bộ lọc (hiển thị cho người dùng)
   - **Field**: Trường dữ liệu cần lọc
   - **Operator**: Điều kiện lọc (`=`, `!=`, `>`, `<`, `contains`, ...)
   - **Default value**: Giá trị mặc định (tùy chọn)
4. Nhấn **Save**

### Sử dụng Filter

Khi xem dashboard, bộ lọc xuất hiện ở đầu trang. Thay đổi giá trị filter → tất cả biểu đồ tự động cập nhật.

---

## 8. Chia sẻ tài nguyên (Sharing)

Bạn có thể chia sẻ **Dashboard, Chart, Workspace, DataSource** cho các thành viên khác trong team.

### Chia sẻ với một người

1. Vào trang chi tiết của tài nguyên → nhấn icon **Share** (hoặc nút **Share**)
2. Tìm kiếm email người dùng
3. Chọn quyền: **View** (chỉ xem) hoặc **Edit** (có thể chỉnh sửa)
4. Nhấn **Share**

Người được chia sẻ sẽ thấy tài nguyên này trong danh sách của họ.

### Chia sẻ với toàn team

Nhấn **Share with all team** để chia sẻ ngay cho tất cả thành viên cùng một quyền.

### Chia sẻ Dashboard theo tầng

Khi chia sẻ một Dashboard, hệ thống tự động cascade share xuống:
- Tất cả **Charts** trong dashboard
- Tất cả **Workspaces** mà các chart đó dùng

Người được chia sẻ sẽ thấy đủ dữ liệu để dashboard hiển thị đúng.

### Cập nhật / Hủy chia sẻ

- **Thay đổi quyền**: Vào Share dialog → chọn lại quyền cho người dùng đó
- **Hủy chia sẻ**: Nhấn icon xóa cạnh tên người dùng trong Share dialog

---

## 9. Quản lý phân quyền người dùng

> Chức năng này chỉ dành cho tài khoản có quyền **User Management**.

### Module Permissions

AppBI kiểm soát quyền truy cập theo từng **module**:

| Module | Điều khiển |
|--------|-----------|
| `dashboards` | Xem/tạo/sửa/xóa Dashboard |
| `explore_charts` | Xem/tạo/sửa/xóa Chart |
| `workspaces` | Xem/tạo/sửa/xóa Workspace |
| `data_sources` | Xem/tạo/xóa DataSource |
| `ai_chat` | Sử dụng AI Chat |
| `user_management` | Quản lý người dùng |
| `settings` | Cài đặt hệ thống |

**Các mức quyền:**

| Mức | Ý nghĩa |
|-----|---------|
| `none` | Không thấy module trong sidebar, API trả về 403 |
| `view` | Chỉ xem (không tạo/sửa/xóa) |
| `edit` | Tạo + Sửa (không xóa) |
| `full` | Toàn quyền (tạo + sửa + xóa + share) |

> Không phải module nào cũng có đủ 4 mức. Ví dụ: `data_sources` không có mức `edit`; `ai_chat` không có mức `full`.

### Xem và thay đổi quyền

1. Vào **Users** trên sidebar → chọn một người dùng
2. Nhấn **Edit Permissions**
3. Thay đổi mức quyền cho từng module
4. Nhấn **Save**

Hoặc dùng **Preset**:
- `admin` — toàn quyền tất cả module
- `editor` — edit hầu hết module, view datasource
- `viewer` — chỉ xem tất cả
- `minimal` — chỉ xem dashboard, ẩn phần còn lại

### Quản lý tài khoản

Từ trang **Users** (admin):

- **Tạo tài khoản mới**: Nhấn **+ New User** → điền email, tên, mật khẩu, quyền ban đầu
- **Deactivate tài khoản**: Nhấn **Deactivate** — tài khoản không đăng nhập được nhưng dữ liệu giữ nguyên
- **Xóa tài khoản**: Nhấn **Delete** — xóa vĩnh viễn (chỉ khi không còn tài nguyên ràng buộc)

---

## 10. AI Chat Agent

AI Chat là trợ lý phân tích dữ liệu tích hợp, có thể hiểu ngôn ngữ tự nhiên và thực hiện truy vấn dữ liệu.

> Cần có quyền `ai_chat >= view` để sử dụng.

### Giao diện Chat

Nhấn biểu tượng **AI Chat** trên sidebar (hoặc nút chat nổi ở góc màn hình) để mở panel chat.

### Những gì AI có thể làm

| Yêu cầu | Ví dụ câu hỏi |
|---------|---------------|
| Liệt kê dữ liệu | "Có những workspace nào?" / "Bảng này có những cột gì?" |
| Xem dữ liệu mẫu | "Cho tôi xem vài dòng dữ liệu trong bảng Data Lake" |
| Phân tích | "Phân phối giá trị của cột status là gì?" |
| Truy vấn | "Tổng revenue theo từng region?" / "Top 10 project theo số records?" |
| Tìm kiếm | "Có biểu đồ nào về revenue chưa?" |
| Tạo biểu đồ | "Tạo biểu đồ bar chart records theo project_id và lưu lại" |
| Câu hỏi liên tiếp | AI nhớ ngữ cảnh trong cùng một phiên — có thể hỏi tiếp "breakdown theo status thế nào?" |

### Lưu ý khi dùng AI

- AI làm việc với **dữ liệu đã được sync** vào hệ thống. Nếu datasource chưa sync, AI sẽ không truy vấn được.
- Nếu AI tạo biểu đồ, chart sẽ xuất hiện trong danh sách **Explore** → Charts để bạn thêm vào dashboard.
- Phiên chat được lưu lại trong **Chat History** (biểu tượng đồng hồ) để xem lại sau.
- AI hỗ trợ cả tiếng Anh và tiếng Việt.

---

## Luồng làm việc điển hình

```
1. Kết nối DataSource (PostgreSQL / Google Sheets / ...)
2. Sync dữ liệu vào hệ thống (Sync Now)
3. Tạo Workspace → Add Table (chọn bảng đã sync)
4. Tạo Charts từ Explore (chọn workspace + table + chart type)
5. Tạo Dashboard → Add Charts
6. Cấu hình Global Filters nếu cần
7. Share Dashboard cho team (cascade tự động share chart + workspace)
8. Dùng AI Chat để khám phá dữ liệu nhanh và tạo chart mới
```

---

## Câu hỏi thường gặp

**Q: Tại sao biểu đồ hiển thị "No data" hoặc lỗi?**
- Kiểm tra datasource đã được sync chưa (vào Data Sources → xem trạng thái sync)
- Kiểm tra workspace table có đang dùng đúng datasource đã sync chưa

**Q: Tôi share dashboard nhưng người kia vẫn không thấy?**
- Kiểm tra quyền module `dashboards` của người đó — cần ít nhất `view`
- Nếu quyền OK, có thể là lỗi hệ thống — liên hệ admin kiểm tra server logs

**Q: AI Chat báo "0 rows" dù tôi biết có dữ liệu?**
- Đây là vấn đề đã biết với hàm `count` trong AI Agent — xem [AI_AGENT.md](AI_AGENT.md#9-known-issues)
- Thử hỏi theo cách khác: "liệt kê sample data" hoặc "tổng revenue là bao nhiêu?"

**Q: Tên dashboard không được chứa ký tự nào?**
- Tránh dùng em-dash `—` (U+2014). Dùng gạch ngang thường `-` thay thế.

**Q: Làm thế nào để thay đổi mật khẩu?**
- Nhấn avatar/tên của bạn ở góc trên phải → **Change Password**

---

## Ghi chú kỹ thuật (Technical Notes)

### API phân quyền module — Format đúng

```http
PUT /api/v1/permissions/{user_id}
{ "permissions": { "dashboards": "view", "explore_charts": "view", ... } }
```

Wrapper `"permissions"` là bắt buộc. User mới mặc định có `{}` (tất cả `none`).

### Google Sheets — source_table_name phải là tên gốc

Khi thêm bảng GSheets vào workspace, dùng tên sheet GỐC, không dùng DuckDB slug:
- ✅ `"Data Lake - Segment"` (tên sheet thực tế)
- ❌ `"synced_ds1__schema__data_lake____segment"` (DuckDB VIEW slug)

### Chart data response format

```json
{ "chart": {...}, "data": [{...}, ...], "pre_aggregated": false }
```

Data rows ở `body["data"]` (là list), không phải `body["rows"]`.

### AI Chat WebSocket

Endpoint: `ws://localhost:8001/chat/ws?token=<JWT>`

Event types: `thinking`, `tool_call` (fields: `tool`, `args`), `tool_result` (fields: `tool`, `summary`, `data`), `text` (field: `content`), `suggestions`, `metrics`, `done` (field: `session_id`).

### Datasource visibility (đã sửa 2026-03-23)

`GET /api/v1/datasources` chỉ trả về datasource của mình hoặc được share. User `full` thấy tất cả.
