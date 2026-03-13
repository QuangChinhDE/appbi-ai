# AppBI — Business Intelligence Dashboard

Ứng dụng BI nội bộ giúp kết nối nhiều nguồn dữ liệu, xây dựng chart, quản lý dataset và tạo dashboard tương tác. Kiến trúc tách biệt Frontend / Backend / Database, hỗ trợ triển khai bằng Docker Compose chỉ với một lệnh.

---

## Tính năng

| Module | Mô tả |
|---|---|
| **Data Sources** | Kết nối PostgreSQL, MySQL, BigQuery hoặc import file CSV/Excel (nhiều sheet) |
| **Dataset Workspaces** | Tạo virtual table từ SQL query trên data source, dùng làm nguồn dữ liệu cho chart |
| **Charts** | Xây dựng chart (Bar, Line, Pie, Area, Scatter, Table…) với field mapping kiểu PowerBI |
| **Dashboards** | Ghép nhiều chart thành dashboard, kéo-thả sắp xếp layout |
| **Explore** | Khám phá dữ liệu nhanh với giao diện point-and-click, không cần viết SQL |

---

## Tech Stack

**Frontend** — Next.js 14 (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Recharts · TanStack Query

**Backend** — FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · Python 3.10+

**Database** — PostgreSQL 16 (metadata store)

**Infrastructure** — Docker · Docker Compose

---

## Chạy bằng Docker (khuyến nghị)

> Yêu cầu: [Docker Desktop](https://www.docker.com/products/docker-desktop/) hoặc Docker Engine + Compose plugin

### 1. Clone repo

```bash
git clone https://github.com/bachbuiquang9/Dashboard-App.git
cd Dashboard-App
```

### 2. Cấu hình môi trường

```bash
cp .env.docker.example .env
```

Mở `.env` và chỉnh nếu cần (mặc định đã dùng được):

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

> **Lưu ý:** Cổng database **không** expose ra ngoài — chỉ dùng nội bộ trong Docker network.

### 3. Build và chạy

```bash
docker compose up --build -d
```

Lần đầu mất vài phút để build. Từ lần sau không cần `--build` trừ khi có thay đổi code.

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

# Tạo .env cho backend
cp .env.example .env              # hoặc tạo thủ công (xem bên dưới)

alembic upgrade head              # khởi tạo schema DB
uvicorn app.main:app --reload --port 8000
```

Biến môi trường backend cần thiết (`backend/.env`):
```env
DATABASE_URL=postgresql+psycopg2://user:password@localhost:5432/appbi_metadata
```

### Frontend

```bash
cd frontend
npm install

# Tạo .env.local
echo "NEXT_PUBLIC_API_URL=http://localhost:8000/api/v1" > .env.local

npm run dev
```

---

## Cấu trúc thư mục

```
Dashboard-App/
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routers (datasources, charts, dashboards…)
│   │   ├── models/       # SQLAlchemy models
│   │   ├── schemas/      # Pydantic schemas
│   │   └── services/     # Business logic, connector classes
│   ├── alembic/          # Database migrations
│   ├── Dockerfile
│   ├── entrypoint.sh     # Wait for DB → migrate → start server
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── app/(main)/   # Next.js App Router pages
│   │   ├── components/   # React components
│   │   ├── hooks/        # TanStack Query hooks
│   │   └── lib/api/      # API client layer
│   └── Dockerfile
├── docker-compose.yml
├── .env.docker.example
└── README.md
```

---

## Docker — Chi tiết kiến trúc

```
Browser
  │
  ├─► Frontend :3000  (Next.js — static export served by Node)
  │       │
  │       └─► Backend :8000  (FastAPI)  ─── appbi-net (Docker bridge)
  │                   │
  │                   └─► Database :5432  (PostgreSQL — port KHÔNG expose ra host)
  │
  └── Port mapping cấu hình qua .env (FRONTEND_PORT / BACKEND_PORT)
```

- **DB** không có port ra ngoài → không xung đột với PostgreSQL đang chạy trên máy host
- **Tất cả** (DB, BE, FE) giao tiếp qua internal network `appbi-net`
- **Migrations** chạy tự động trong `entrypoint.sh` mỗi khi backend khởi động
- **Dữ liệu DB** lưu trong Docker named volume `db_data` — không mất khi restart

---

## Data Sources hỗ trợ

| Loại | Ghi chú |
|---|---|
| PostgreSQL | Kết nối qua host/port/credentials |
| MySQL | Kết nối qua host/port/credentials |
| Google BigQuery | Dùng service account JSON |
| Manual (File Import) | Upload CSV hoặc Excel (.xlsx/.xls) — tất cả sheet được import |

---

## License

MIT
