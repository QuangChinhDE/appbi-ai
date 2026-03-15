# AppBI — Business Intelligence Dashboard

Ứng dụng BI nội bộ giúp kết nối nhiều nguồn dữ liệu, xây dựng dataset, khám phá dữ liệu không cần SQL, tạo chart đa dạng và ghép thành dashboard tương tác. Kiến trúc tách biệt Frontend / Backend / Database, triển khai bằng Docker Compose một lệnh.

---

## Tính năng

| Module | Mô tả |
|---|---|
| **Data Sources** | Kết nối PostgreSQL, MySQL, BigQuery, Google Sheets hoặc import CSV/Excel (nhiều sheet). Bắt buộc **Test Connection** thành công trước khi tạo mới. PostgreSQL hỗ trợ cấu hình `schema` (search_path). |
| **Datasets** | Tạo dataset từ SQL query trên Data Source. Tự động suy diễn kiểu cột. |
| **Explore** | Khám phá dữ liệu nhanh với giao diện point-and-click — chọn trục X, metric (SUM/AVG/COUNT/MIN/MAX), breakdown, bộ lọc, Parameters — không cần viết SQL. Giao diện 5 panel collapsible: Data · Visualization · Fields · Filters · Parameters. |
| **Charts** | Lưu cấu hình chart từ Explore. Hỗ trợ Bar, Line, Area, Pie, Scatter, Grouped Bar, Stacked Bar, Table, KPI, Time Series. |
| **Dashboards** | Ghép nhiều chart thành dashboard, kéo-thả sắp xếp layout (react-grid-layout). **Global filter bar** (pre-aggregation, chỉ dimension fields). **Per-tile HAVING filter** (post-aggregation, chỉ metric fields). Đổi tên tile inline. |
| **Dataset Workspaces** | Môi trường workspace kết hợp nhiều bảng/datasource, thêm transformation step (filter, sort, join, group by…). |

---

## Tech Stack

| Tầng | Công nghệ |
|---|---|
| **Frontend** | Next.js 14 (App Router) · TypeScript · Tailwind CSS · Recharts · TanStack Query v5 · react-grid-layout · Sonner (toast) |
| **Backend** | FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · Python 3.10+ |
| **Database** | PostgreSQL 16 (lưu metadata: datasources, datasets, charts, dashboards) |
| **Infrastructure** | Docker · Docker Compose |

---

## Chạy bằng Docker (khuyến nghị)

> Yêu cầu: [Docker Desktop](https://www.docker.com/products/docker-desktop/) hoặc Docker Engine + Compose plugin.

### 1. Clone repo

```bash
git clone https://github.com/bachbuiquang9/Dashboard-App.git
cd Dashboard-App
```

### 2. Cấu hình môi trường

```bash
cp .env.docker.example .env
```

Mở `.env` và chỉnh nếu cần (mặc định hoạt động ngay):

```env
DB_USER=appbi
DB_PASSWORD=appbi
DB_NAME=appbi

SECRET_KEY=change-this-in-production
LOG_LEVEL=INFO

# Đổi nếu port đã bị chiếm trên máy bạn
FRONTEND_PORT=3000
BACKEND_PORT=8000
```

> **Lưu ý:** Cổng PostgreSQL **không** expose ra ngoài — chỉ dùng nội bộ trong Docker network. Sẽ không xung đột với Postgres đang chạy trên máy.

### 3. Build và chạy

```bash
docker compose up --build -d
```

Lần đầu build mất vài phút. Từ lần sau chỉ cần `docker compose up -d`.

### 4. Kiểm tra

| URL | Mô tả |
|---|---|
| `http://localhost:3000` | Giao diện Frontend |
| `http://localhost:8000/api/v1/docs` | Swagger API Documentation |
| `http://localhost:8000/api/v1/health` | Health check Backend |

### 5. Dừng ứng dụng

```bash
docker compose down          # dừng, giữ dữ liệu DB
docker compose down -v       # dừng + xóa toàn bộ dữ liệu DB
```

---

## Chạy thủ công (Development)

### Yêu cầu

- Python 3.10+
- Node.js 18+
- PostgreSQL 14+

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Tạo file môi trường
cp .env.example .env              # hoặc tạo thủ công

alembic upgrade head              # khởi tạo schema DB
uvicorn app.main:app --reload --port 8000
```

`backend/.env` tối thiểu:
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/appbi_metadata
```

### Frontend

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1" > .env.local
npm run dev
```

---

## (Tuỳ chọn) Seed dữ liệu demo – Football

Repo kèm script seed dữ liệu mẫu sử dụng nguồn "Football" (dữ liệu FIFA thủ công):

```bash
# Đảm bảo backend đang chạy, đã tạo sẵn datasource "Football"
pip install requests        # nếu chưa có
python seed_demo.py
```

Script tạo:
- **5 Datasets** — Rankings, WC History, Top Scorers, Confederation summary, Top 10
- **10 Charts** — Bar, Pie, Grouped Bar, KPI, Table
- **3 Dashboards**:
  - *FIFA World Rankings Overview* — điểm FIFA, top 10, phân bổ liên đoàn
  - *World Cup History & Champions* — số WC titles, so sánh WC vs Continental titles
  - *World Cup Top Scorers — Golden Boot Analysis* — vua phá lưới từng kỳ 1930–2022

---

## Cấu trúc thư mục

```
Dashboard-App/
├── backend/
│   ├── app/
│   │   ├── api/              # FastAPI routers (datasources, datasets, charts, dashboards…)
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── schemas/          # Pydantic v2 schemas (request/response)
│   │   └── services/         # Business logic & connector classes
│   ├── alembic/              # Database migrations
│   ├── Dockerfile
│   ├── entrypoint.sh         # Wait for DB → alembic upgrade head → uvicorn
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── app/(main)/       # Next.js App Router pages
│   │   │   ├── datasources/  # List + Create + Edit datasource
│   │   │   ├── datasets/     # Dataset management + preview
│   │   │   ├── explore/      # Point-and-click data exploration
│   │   │   ├── dashboards/   # Dashboard grid + global filter bar
│   │   │   └── dataset-workspaces/ # Workspace + transformation pipeline
│   │   ├── components/       # React UI components
│   │   ├── hooks/            # TanStack Query data-fetching hooks
│   │   └── lib/api/          # Axios-based API client layer
│   └── Dockerfile
├── seed_demo.py              # Demo data seed script (Football / FIFA)
├── docker-compose.yml
├── .env.docker.example
└── README.md
```

---

## Docker — Kiến trúc

```
Browser
  │
  ├─► Frontend :3000  (Next.js — Node runtime)
  │       │
  │       └─► Backend :8000  (FastAPI / uvicorn)  ─── appbi-net (Docker bridge)
  │                   │
  │                   └─► Database :5432  (PostgreSQL — KHÔNG expose ra host)
```

- **DB**: không có port binding ra host → không xung đột với Postgres local
- Tất cả service giao tiếp qua internal Docker network `appbi-net`
- **Migrations** chạy tự động trong `entrypoint.sh` mỗi lần backend start
- **Dữ liệu DB** lưu trong named volume `db_data` — không mất khi restart container

---

## Data Sources hỗ trợ

| Loại | Ghi chú |
|---|---|
| **PostgreSQL** | Host · Port · Database · Username · Password · Schema (tuỳ chọn, đặt search_path) |
| **MySQL** | Host · Port · Database · Username · Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID (snapshot toàn bộ sheet khi kết nối) |
| **Manual (File Import)** | Upload CSV hoặc Excel `.xlsx/.xls` — tất cả sheet được import, xem preview trước khi lưu |

> Với PostgreSQL và MySQL: bắt buộc nhấn **Test Connection** thành công trước khi nút Create được kích hoạt.

---

## Filter Architecture (Dashboards)

| Loại | Phạm vi | Khi nào áp dụng | Field hợp lệ |
|---|---|---|---|
| **Global Filter Bar** | Toàn dashboard | Trước aggregation (pre-agg) | Dimension / breakdown fields |
| **Per-tile HAVING** | Từng chart tile | Sau aggregation (post-agg) | Metric keys (e.g. `sum__point`) |

---

## License

MIT

