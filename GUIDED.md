# AppBI — Hướng Dẫn Sử Dụng

> Tài liệu dành cho người dùng mới — hướng dẫn từ bước đầu tiên đến khi tạo ra dashboard hoàn chỉnh.

---

## Mục Lục

1. [AppBI là gì?](#1-appbi-là-gì)
2. [Đăng nhập & Giao diện chính](#2-đăng-nhập--giao-diện-chính)
3. [Data Sources — Kết nối nguồn dữ liệu](#3-data-sources--kết-nối-nguồn-dữ-liệu)
4. [Dataset Workspaces — Quản lý bảng dữ liệu](#4-dataset-workspaces--quản-lý-bảng-dữ-liệu)
5. [Explore — Xây dựng biểu đồ](#5-explore--xây-dựng-biểu-đồ)
6. [Dashboards — Tổng hợp báo cáo](#6-dashboards--tổng-hợp-báo-cáo)
7. [AI Chat — Phân tích bằng ngôn ngữ tự nhiên](#7-ai-chat--phân-tích-bằng-ngôn-ngữ-tự-nhiên)
8. [Chia sẻ & Phân quyền](#8-chia-sẻ--phân-quyền)
9. [Quản trị hệ thống (Admin)](#9-quản-trị-hệ-thống-admin)
10. [Luồng đầy đủ từ A đến Z](#10-luồng-đầy-đủ-từ-a-đến-z)
11. [Câu hỏi thường gặp](#11-câu-hỏi-thường-gặp)

---

## 1. AppBI là gì?

**AppBI** là nền tảng Business Intelligence (BI) đầy đủ chức năng, cho phép bạn:

- **Kết nối** với nhiều nguồn dữ liệu: PostgreSQL, MySQL, BigQuery, Google Sheets, hoặc upload file CSV thủ công
- **Xây dựng bảng dữ liệu** từ các nguồn khác nhau, thêm cột tính toán, định dạng hiển thị
- **Tạo biểu đồ** với 10+ loại visualization (bar, line, pie, scatter, KPI card, table…)
- **Tổng hợp** nhiều biểu đồ thành dashboard có bộ lọc toàn cục
- **Hỏi AI** bằng tiếng Việt hoặc tiếng Anh để tự động tạo biểu đồ và phân tích

### Kiến trúc tổng quan

```
Nguồn dữ liệu (PostgreSQL / MySQL / CSV…)
        ↓
   Data Source  →  Dataset Workspace  →  Chart  →  Dashboard
                                                  ↑
                                             AI Chat
```

Mọi thứ đều được lưu trong hệ thống — bạn không cần viết SQL thủ công.

---

## 2. Đăng nhập & Giao diện chính

### Đăng nhập

Truy cập `http://localhost:3000` → nhập **email** và **mật khẩu** → bấm **Sign in**.

> Nếu bạn đã được admin tạo tài khoản, hãy dùng thông tin đó. Nếu cần đổi mật khẩu sau khi đăng nhập, vào menu user ở góc trái dưới → **Change Password**.

### Giao diện sau khi đăng nhập

```
┌─────────────┬──────────────────────────────────────┐
│  Sidebar    │                                      │
│             │        Nội dung trang chính          │
│  ☁ Data     │                                      │
│    Sources  │                                      │
│  ⬡ Worksp.  │                                      │
│  📊 Explore │                                      │
│  📋 Dashb.  │                                      │
│  🤖 AI Chat │                                      │
│  ⚙ Settings │                                      │
│             │                                      │
│  [Avatar]   │                                      │
└─────────────┴──────────────────────────────────────┘
```

**Sidebar (thanh điều hướng trái)** gồm các mục chính:

| Mục | Chức năng |
|-----|-----------|
| **Data Sources** | Quản lý kết nối đến database / file |
| **Workspaces** | Tổ chức và xử lý các bảng dữ liệu |
| **Explore** | Tạo và lưu biểu đồ |
| **Dashboards** | Tổng hợp nhiều biểu đồ thành báo cáo |
| **AI Chat** | Hỏi đáp phân tích dữ liệu bằng ngôn ngữ tự nhiên |
| **Settings** | Quản lý người dùng và phân quyền (chỉ Admin) |

> **Lưu ý:** Các mục sidebar chỉ hiện ra nếu bạn có quyền truy cập tương ứng. Nếu một mục bị ẩn, hãy liên hệ admin để được cấp quyền.

---

## 3. Data Sources — Kết nối nguồn dữ liệu

Data Source là điểm kết nối của AppBI với database hoặc file của bạn. Đây là **bước đầu tiên** trước khi làm bất cứ điều gì khác.

### 3.1 Xem danh sách Data Sources

Bấm **Data Sources** trên sidebar → trang hiển thị danh sách tất cả datasource bạn có quyền xem.

### 3.2 Tạo Data Source mới

1. Bấm nút **+ New Data Source** (góc trên phải)
2. Chọn **loại kết nối**:

| Loại | Khi nào dùng |
|------|-------------|
| **PostgreSQL** | Database PostgreSQL nội bộ hoặc trên cloud |
| **MySQL** | Database MySQL / MariaDB |
| **BigQuery** | Google BigQuery (cần Service Account JSON) |
| **Google Sheets** | Spreadsheet Google Sheets (cần API key) |
| **Manual / CSV** | Upload file CSV trực tiếp không cần database |

3. Điền thông tin kết nối (host, port, database, username, password…)
4. Bấm **Test Connection** để kiểm tra kết nối trước khi lưu
5. Bấm **Save** → datasource được tạo

#### Tab Sync Settings (sau khi lưu)

Sau khi tạo xong, bạn có thể cấu hình lịch đồng bộ dữ liệu vào hệ thống:

| Tùy chọn | Ý nghĩa |
|----------|---------|
| **Manual** | Chỉ đồng bộ khi bạn bấm nút Sync thủ công |
| **Interval** | Đồng bộ định kỳ (ví dụ: mỗi 30 phút) |
| **Daily** | Đồng bộ mỗi ngày vào giờ cố định |
| **Cron** | Biểu thức cron tùy chỉnh |

> Dữ liệu sau khi đồng bộ được lưu vào DuckDB cục bộ để xử lý truy vấn nhanh. Đây là bước cần thiết trước khi tạo biểu đồ.

### 3.3 Đồng bộ dữ liệu (Sync)

Sau khi tạo datasource, bấm vào datasource đó → bấm nút **Sync Now** để kéo dữ liệu về. Trạng thái sync sẽ hiển thị trong mục **Sync Jobs**.

### 3.4 Chạy thử truy vấn SQL

Từ trang chi tiết datasource, chọn tab **Query Runner**:
- Nhập câu SQL bất kỳ vào ô soạn thảo
- Đặt giới hạn số dòng trả về (mặc định 1000)
- Bấm **Run** → kết quả hiển thị dạng bảng ngay bên dưới

Dùng Query Runner để kiểm tra dữ liệu trước khi xây dựng workspace.

### 3.5 Chia sẻ Data Source

Bấm icon **Share** trên card datasource → tìm kiếm tên người dùng → chọn quyền **Viewer** hoặc **Editor** → bấm **Share**.

---

## 4. Dataset Workspaces — Quản lý bảng dữ liệu

**Workspace** là nơi bạn tổ chức và chuẩn bị dữ liệu trước khi vẽ biểu đồ. Một workspace có thể chứa nhiều bảng từ nhiều datasource khác nhau.

> **Hãy nghĩ workspace như một "schema ảo"** — bạn lấy bảng từ nhiều nguồn, xử lý chúng, rồi dùng để vẽ biểu đồ.

### 4.1 Tạo Workspace mới

1. Sidebar → **Workspaces** → **+ New Workspace**
2. Nhập tên và mô tả
3. Bấm **Create** → workspace rỗng được tạo

### 4.2 Thêm bảng vào Workspace

Bên trong workspace, bấm **+ Add Table**:

**Bước 1 — Chọn nguồn:**
- Chọn **Datasource** từ danh sách
- Chọn kiểu: **Physical Table** (bảng thực trong DB) hoặc **SQL Query** (bạn tự viết câu truy vấn)

**Bước 2 — Cấu hình:**
- Nếu là Physical Table: chọn tên bảng từ schema
- Nếu là SQL Query: nhập câu SQL, hệ thống preview kết quả ngay

**Bước 3 — Đặt tên:**
- Đặt **Display Name** (tên hiển thị trong workspace, ví dụ: "Doanh thu tháng 3")
- Bấm **Save**

### 4.3 Xem và tùy chỉnh bảng

Sau khi thêm bảng, bấm vào tên bảng ở sidebar trái để xem preview:

**Điều chỉnh hiển thị:**

| Nút | Chức năng |
|-----|-----------|
| **Columns** | Chọn/ẩn cột, sắp xếp lại thứ tự cột |
| **Limit** | Đổi số dòng preview (10 → 1000) |
| **Refresh** | Làm mới dữ liệu preview |

**Định dạng cột (click vào tên cột):**
- Số thập phân, đơn vị (K/M/B), dấu phân cách nghìn
- Ký hiệu tiền tệ (VND, USD…)
- Định dạng ngày tháng
- Tiền tố / hậu tố (ví dụ: "đ", "%")

**Ghi đè kiểu dữ liệu cột:**
- Nếu hệ thống detect nhầm kiểu (ví dụ: số bị nhận dạng là text), click vào tên cột → chọn đúng kiểu

### 4.4 Thêm cột tính toán

Bấm **+ Add Column** để tạo cột mới từ công thức:

**Chế độ Formula (Excel-like):**
```
= [price] * [quantity]
= ROUND([revenue] / [orders], 2)
= IF([status] = "completed", [revenue], 0)
= VLOOKUP([product_id], "product_table", "product_name")
```

- Hỗ trợ hàm Excel phổ biến: IF, ROUND, SUM, VLOOKUP, TEXT, DATE…
- Tham chiếu cột bằng `[tên_cột]`
- VLOOKUP có thể tra cứu từ bảng khác trong workspace

**Chế độ JavaScript:**
```javascript
return row.price * row.quantity * (1 - row.discount_rate);
```

- Toàn bộ sức mạnh của JavaScript
- Biến `row` chứa tất cả giá trị của dòng hiện tại

> **Lưu ý:** Cột formula tính toán ở phía client (trình duyệt). Cột SQL expression (thêm qua server-side) được tính trong DuckDB, hỗ trợ dùng trong bộ lọc và GROUP BY.

### 4.5 Transformations (Biến đổi bảng)

Từ drawer **Columns**, bạn có thể thêm các bước biến đổi:
- **Select Columns**: chỉ giữ lại một số cột nhất định
- **Rename Columns**: đổi tên cột hiển thị
- **Add Column**: thêm cột tính toán bằng SQL

Các bước này được áp dụng theo thứ tự và lưu cùng bảng.

---

## 5. Explore — Xây dựng biểu đồ

**Explore** là nơi bạn kết hợp dữ liệu từ Workspace để tạo ra các biểu đồ có thể lưu lại và dùng trong Dashboard.

### 5.1 Tạo biểu đồ mới

Sidebar → **Explore** → **+ New Chart**

Giao diện Chart Builder gồm 5 phần (có thể thu gọn lại):

---

#### Phần 1 — Source Selector (Chọn nguồn dữ liệu)

1. Chọn **Workspace**
2. Chọn **Table** trong workspace đó
3. Preview dữ liệu sẽ hiển thị bên dưới

---

#### Phần 2 — Configuration (Cấu hình biểu đồ)

**Bước 1: Chọn loại biểu đồ**

| Loại | Dùng khi nào |
|------|-------------|
| **BAR** | So sánh giá trị giữa các nhóm |
| **GROUPED BAR** | So sánh nhiều metric cùng lúc theo nhóm |
| **STACKED BAR** | Thể hiện tỉ lệ phần trăm trong tổng thể |
| **LINE** | Xu hướng theo thời gian hoặc danh mục |
| **AREA** | Giống Line nhưng tô màu vùng bên dưới |
| **TIME SERIES** | Dữ liệu theo trục thời gian (có format ngày) |
| **PIE** | Tỉ lệ phần trăm trong tổng |
| **SCATTER** | Tương quan giữa hai biến số |
| **TABLE** | Hiển thị dữ liệu dạng bảng (tối đa 500 dòng) |
| **KPI** | Một con số lớn với nhãn (ví dụ: Tổng doanh thu) |

**Bước 2: Cấu hình trục (Role Configuration)**

Tùy loại biểu đồ, bạn sẽ thấy các ô cấu hình:

| Trường | Ý nghĩa |
|--------|---------|
| **Dimension** | Trục X hoặc nhóm phân loại (ví dụ: "region", "product_name") |
| **Metrics** | Giá trị Y — chọn cột + hàm tổng hợp (SUM, AVG, COUNT…) |
| **Breakdown** | Phân chia thêm một chiều nữa (tạo nhiều series) |
| **Time Field** | Trường ngày giờ cho biểu đồ TIME SERIES |
| **X / Y Field** | Hai trục của SCATTER |

**Thêm nhiều metric:**
- Bấm **+ Add Metric** → chọn cột và hàm tổng hợp
- Ví dụ: Metric 1 = SUM(revenue), Metric 2 = COUNT(orders)

**Hàm tổng hợp (Aggregation):**
`SUM` · `AVG` · `COUNT` · `COUNT DISTINCT` · `MIN` · `MAX`

---

#### Phần 3 — Filters (Bộ lọc)

Bấm **+ Add Filter**:
1. Chọn **cột** cần lọc
2. Chọn **điều kiện**: = · ≠ · > · ≥ · < · ≤ · IN · NOT IN · contains · is null
3. Nhập **giá trị**
4. Có thể thêm nhiều filter (chúng được kết hợp bằng AND)

> Filters được áp dụng **trước** khi GROUP BY, tức là chỉ tính toán trên tập dữ liệu đã lọc.

---

#### Phần 4 — Metadata (AI Search Tags)

Phần này giúp AI tìm kiếm và đề xuất biểu đồ phù hợp:
- **Domain**: lĩnh vực dữ liệu (sales, marketing, finance…)
- **Intent**: mục đích biểu đồ (trend, comparison, ranking…)
- **Metrics tags**: nhãn mô tả các chỉ số
- **Dimensions tags**: nhãn mô tả các chiều phân tích
- **Tags**: từ khóa tự do

---

#### Phần 5 — Parameters (Tham số động)

Parameters cho phép dashboard override bộ lọc của biểu đồ:
- Đặt tên tham số (ví dụ: "start_date")
- Chọn loại: `time_range` / `dimension` / `measure`
- Map với cột dữ liệu tương ứng
- Đặt giá trị mặc định

---

#### Preview biểu đồ

Biểu đồ được render real-time bên dưới phần cấu hình. Bảng dữ liệu gốc (sau khi lọc) hiển thị bên dưới biểu đồ để kiểm chứng.

### 5.2 Lưu biểu đồ

1. Đặt tên ở ô **Chart Name** (góc trên)
2. Thêm mô tả nếu cần
3. Bấm **Save** → biểu đồ được lưu và xuất hiện trong danh sách Explore

### 5.3 Thêm biểu đồ vào Dashboard

Từ trang chart detail, bấm **Add to Dashboard**:
1. Chọn dashboard (hoặc tạo mới)
2. Đặt vị trí ban đầu (x, y) và kích thước (w, h)
3. Bấm **Add** → biểu đồ xuất hiện trong dashboard

---

## 6. Dashboards — Tổng hợp báo cáo

Dashboard là trang tổng hợp nhiều biểu đồ, dùng để theo dõi và trình bày dữ liệu.

### 6.1 Tạo Dashboard mới

Sidebar → **Dashboards** → **+ New Dashboard** → nhập tên và mô tả → **Create**

### 6.2 Thêm biểu đồ vào Dashboard

Bên trong dashboard, bấm **+ Add Chart**:
1. Tìm kiếm biểu đồ theo tên
2. Chọn biểu đồ muốn thêm
3. Nhập vị trí (hoặc để mặc định, kéo thả sau)
4. Bấm **Add**

### 6.3 Sắp xếp và Resize biểu đồ

Dashboard sử dụng **grid 12 cột** (mỗi cột ~80px chiều cao):

- **Kéo** tiêu đề biểu đồ để di chuyển
- **Kéo góc** dưới phải để thay đổi kích thước
- Layout tự động lưu sau **1 giây** không tương tác
- Kích thước tối thiểu: 2 cột × 2 hàng

> **Mẹo:** Dùng `w=6, h=4` cho biểu đồ thông thường (chiếm nửa trang, cao 320px). Dùng `w=12` cho table muốn full chiều ngang.

### 6.4 Bộ lọc toàn cục (Global Filters)

Dashboard hỗ trợ bộ lọc áp dụng đồng thời cho **tất cả** biểu đồ:

1. Bấm **+ Add Filter** trên thanh filter bar
2. Chọn cột và điều kiện lọc
3. Filter xuất hiện dạng chip — bấm **×** để xóa

> Các biểu đồ sẽ tự động re-render với dữ liệu đã lọc khi bộ lọc thay đổi.

### 6.5 Chia sẻ Dashboard

Bấm icon **Share** → tìm tên người dùng → chọn quyền **Viewer** hoặc **Editor** → **Share**.

Khi chia sẻ dashboard:
- Người nhận tự động được quyền xem các biểu đồ và workspace liên quan
- Permission level quyết định họ chỉ xem hay có thể sửa

### 6.6 Xóa biểu đồ khỏi Dashboard

Hover vào biểu đồ → bấm nút **×** (góc trên phải tile) → xác nhận.

> Xóa khỏi dashboard **không** xóa biểu đồ gốc — biểu đồ vẫn tồn tại trong Explore.

---

## 7. AI Chat — Phân tích bằng ngôn ngữ tự nhiên

**AI Chat** cho phép bạn hỏi câu hỏi dữ liệu bằng tiếng Việt hoặc tiếng Anh, AI sẽ tự động tìm dữ liệu phù hợp và tạo biểu đồ.

> Tính năng này yêu cầu cấu hình **LLM API key** (OpenAI, Anthropic, Gemini…) trong file `.env`. Liên hệ admin nếu chức năng này không hoạt động.

### 7.1 Bắt đầu cuộc hội thoại mới

Sidebar → **AI Chat** → bấm **+ New Chat**

### 7.2 Đặt câu hỏi

Nhập câu hỏi vào ô input, ví dụ:
- *"Top 10 cầu thủ có giá trị chuyển nhượng cao nhất?"*
- *"Doanh thu theo tháng trong năm 2025 so với 2024?"*
- *"Tỉ lệ đơn hàng hoàn thành vs. bị hủy theo từng khu vực?"*
- *"Tạo biểu đồ cột thể hiện số lượng sản phẩm theo danh mục"*

### 7.3 AI xử lý và trả lời

AI sẽ:
1. **Tìm kiếm** biểu đồ và bảng dữ liệu phù hợp trong hệ thống
2. **Tạo truy vấn** SQL / aggregation
3. **Render biểu đồ** nhúng trực tiếp trong tin nhắn
4. **Giải thích** kết quả bằng văn bản

Bạn có thể xem các bước AI thực hiện bằng cách mở **Activity Log** (nút mũi tên bên cạnh mỗi bước xử lý).

### 7.4 Lưu biểu đồ từ AI

Khi AI tạo biểu đồ trong chat, bạn có thể:
- Bấm **Save Chart** để lưu vào Explore
- Thêm trực tiếp vào một Dashboard

### 7.5 Suggestion Chips

Phía trên ô input có các gợi ý câu hỏi nhanh — bấm để điền tự động vào input.

### 7.6 Lịch sử Chat

Tất cả cuộc hội thoại được lưu lại. Bấm vào session cũ trong danh sách để xem lại.

---

## 8. Chia sẻ & Phân quyền

AppBI có **2 lớp phân quyền**:

### Lớp 1 — Module Permissions (Quyền truy cập tính năng)

Admin cấp quyền cho từng người dùng trên từng module:

| Mức | Ý nghĩa |
|-----|---------|
| **none** | Không thấy module trong sidebar, không truy cập được |
| **view** | Chỉ xem, không tạo/sửa |
| **edit** | Tạo và sửa, không xóa |
| **full** | Toàn quyền: tạo, sửa, xóa, chia sẻ |

### Lớp 2 — Resource Sharing (Chia sẻ tài nguyên cụ thể)

Mỗi tài nguyên (datasource, workspace, chart, dashboard, chat session) có thể được chia sẻ cho từng người:

**Cách chia sẻ:**
1. Bấm icon **Share** trên bất kỳ tài nguyên nào
2. Tìm kiếm người dùng
3. Chọn quyền: **Viewer** (chỉ xem) hoặc **Editor** (sửa được)
4. Bấm **Share**

**Đặc biệt với Dashboard:**
Khi bạn chia sẻ một dashboard, hệ thống tự động chia sẻ cả:
- Tất cả biểu đồ trong dashboard
- Tất cả workspace mà các biểu đồ đó dùng

Người nhận không cần được cấp quyền riêng cho từng tài nguyên.

---

## 9. Quản trị hệ thống (Admin)

> Phần này dành cho người dùng có quyền **Settings = full**.

### 9.1 Quản lý người dùng

Sidebar → **Settings** → tab **Users**

- **Xem danh sách**: email, tên, trạng thái (active/deactivated), lần đăng nhập cuối
- **Thêm user mới**: bấm **+ Add User** → nhập email, tên, chọn preset role
- **Vô hiệu hóa**: bấm **Deactivate** → user bị khóa, không đăng nhập được nhưng dữ liệu vẫn còn
- **Không có nút xóa user** — hệ thống chỉ deactivate, không xóa

### 9.2 Phân quyền Module

Sidebar → **Settings** → tab **Permission Matrix**

Hiển thị bảng grid: **người dùng × module**. Click vào ô để thay đổi quyền.

**Modules và quyền:**

| Module | none | view | edit | full |
|--------|------|------|------|------|
| data_sources | Không thấy | Xem | Tạo/sửa | + Xóa/chia sẻ |
| workspaces | Không thấy | Xem | Tạo/sửa | + Xóa/chia sẻ |
| explore_charts | Không thấy | Xem | Tạo/sửa | + Xóa/chia sẻ |
| dashboards | Không thấy | Xem | Tạo/sửa | + Xóa/chia sẻ |
| ai_chat | Không thấy | Dùng được | Lưu biểu đồ | (giống edit) |
| settings | Không thấy | — | — | Quản lý user & quyền |

### 9.3 Preset Roles

Tab **Presets** cho phép tạo template quyền dùng lại:

**4 preset mặc định:**

| Preset | Mô tả |
|--------|-------|
| **Admin** | Toàn quyền tất cả module |
| **Editor** | edit trên tất cả module nội dung |
| **Viewer** | view trên tất cả module nội dung |
| **Minimal** | Chỉ view dashboard và ai_chat |

Bạn có thể tạo preset tùy chỉnh và gán cho user mới.

---

## 10. Luồng đầy đủ từ A đến Z

Dưới đây là ví dụ thực tế: **Xây dựng báo cáo doanh thu cho team kinh doanh**.

```
Bước 1 — Kết nối Database
  Data Sources → + New Data Source
  Loại: PostgreSQL
  Host: db.company.com | Port: 5432 | DB: sales_db
  → Test Connection ✓ → Save
  → Sync Now (chờ sync xong)

Bước 2 — Tạo Workspace
  Workspaces → + New Workspace → "Sales Analytics"
  → Add Table → datasource "sales_db" → table "orders"
     Display name: "Đơn hàng"
  → Add Table → datasource "sales_db" → table "products"
     Display name: "Sản phẩm"
  → (Tùy chọn) Add Column tên "revenue" = [price] * [quantity]

Bước 3 — Tạo Biểu đồ
  Explore → + New Chart → "Doanh thu theo tháng"
  Source: Workspace "Sales Analytics" | Table "Đơn hàng"
  Type: LINE
  Dimension: order_month  |  Metric: SUM(revenue)
  → Save

  Explore → + New Chart → "Top 10 sản phẩm bán chạy"
  Source: "Đơn hàng"
  Type: BAR
  Dimension: product_name  |  Metric: COUNT(order_id)
  Filter: status = "completed"
  → Save

Bước 4 — Lắp ráp Dashboard
  Dashboards → + New Dashboard → "Báo cáo Doanh thu"
  → + Add Chart → chọn "Doanh thu theo tháng" → vị trí (0,0) w=12 h=4
  → + Add Chart → chọn "Top 10 sản phẩm" → vị trí (0,4) w=6 h=5
  → Kéo thả để sắp xếp lại
  → + Add Filter: region = "Hà Nội"  (lọc tất cả biểu đồ)

Bước 5 — Chia sẻ
  Dashboard → Share → tìm "nguyen.van.a@company.com"
  → Viewer → Share ✓

Bước 6 — Phân tích AI (tuỳ chọn)
  AI Chat → New Chat
  "Cho tôi xem doanh thu theo khu vực tháng này"
  AI tự tạo biểu đồ → có thể Save để dùng lại
```

---

## 11. Câu hỏi thường gặp

**Q: Tôi không thấy mục "Explore" trong sidebar?**
> Liên hệ admin để được cấp quyền `explore_charts >= view`.

**Q: Biểu đồ hiển thị "No data" dù bảng có dữ liệu?**
> Kiểm tra: (1) Datasource đã sync chưa? Vào Data Sources → Sync Now. (2) Cột Dimension và Metric có đúng tên không? Thử chọn lại từ dropdown.

**Q: Tôi muốn lọc theo khoảng thời gian động (ví dụ: "tháng này")?**
> Dùng tính năng **Parameters** trong chart builder + **Global Filter** trong dashboard. Đặt parameter type = `time_range`, map với cột ngày.

**Q: Công thức tôi nhập bị lỗi?**
> Kiểm tra: (1) Tên cột phải đúng hoa/thường, bọc trong `[...]`. (2) Hàm phải viết hoa (IF, ROUND…). (3) Dùng dấu chấm phẩy `;` thay dấu phẩy nếu dùng locale Châu Âu.

**Q: AI Chat không phản hồi hoặc báo lỗi?**
> Hệ thống AI yêu cầu cấu hình LLM API key. Liên hệ admin kiểm tra biến môi trường `LLM_PROVIDER` và `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` trong file `.env`.

**Q: Tôi đã xóa biểu đồ khỏi dashboard, bây giờ muốn thêm lại?**
> Biểu đồ vẫn tồn tại trong Explore. Vào Dashboard → **+ Add Chart** → tìm kiếm tên biểu đồ → thêm lại.

**Q: Làm sao để xóa một datasource đang được workspace sử dụng?**
> Bạn phải xóa tất cả workspace table đang dùng datasource đó trước. Hệ thống sẽ hiển thị danh sách ràng buộc trong hộp thoại xác nhận.

**Q: Tôi muốn đổi mật khẩu?**
> Bấm vào tên/avatar của bạn ở góc trái dưới sidebar → **Change Password** → nhập mật khẩu cũ và mới.

---

## Bảng tham chiếu nhanh

| Tôi muốn... | Đi đến... |
|-------------|-----------|
| Kết nối database mới | Data Sources → + New |
| Xem cấu trúc bảng | Data Sources → [tên] → Query Runner |
| Tổ chức dữ liệu từ nhiều bảng | Workspaces → tạo workspace mới |
| Thêm cột tính toán | Workspace → [bảng] → + Add Column |
| Tạo biểu đồ | Explore → + New Chart |
| Xem tất cả biểu đồ đã lưu | Explore |
| Lắp ráp nhiều biểu đồ thành báo cáo | Dashboards → + New Dashboard |
| Lọc toàn bộ dashboard | Dashboard → Filter Bar → + Add Filter |
| Phân tích bằng câu hỏi tự nhiên | AI Chat → + New Chat |
| Cấp quyền cho đồng nghiệp | Settings → Permission Matrix |
| Chia sẻ một dashboard cụ thể | Dashboard → Share icon |
| Đổi mật khẩu | Avatar (góc trái dưới) → Change Password |

---

*AppBI — Built for analysts, not just engineers.*
