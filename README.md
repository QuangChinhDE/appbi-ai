# AppBI — Business Intelligence Dashboard Platform

<p align="center">
  <strong>Nền tảng BI tự host với dashboard kéo-thả, AI chat hỏi-đáp dữ liệu, mô tả tự động bằng AI, và phân quyền chi tiết.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-14-black?style=flat-square&logo=next.js" />
  <img src="https://img.shields.io/badge/FastAPI-0.100+-green?style=flat-square&logo=fastapi" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-blue?style=flat-square&logo=postgresql" />
  <img src="https://img.shields.io/badge/DuckDB-analytics-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker" />
</p>

---

## Tổng quan

AppBI là nền tảng BI full-stack gồm 3 service độc lập:

| Service | Công nghệ | Port | Mục đích |
|---------|-----------|------|----------|
| **Backend** | FastAPI + SQLAlchemy | 8000 | BI API, kết nối dữ liệu, phân quyền |
| **Frontend** | Next.js 14 (App Router) | 3000 | UI dashboard, chart builder, explore |
| **AI Service** | FastAPI + WebSocket | 8001 | Chat hỏi-đáp tự nhiên, tool-calling |

**Database**: PostgreSQL 16 (metadata) · DuckDB + Parquet (analytics data)

---

## Tính năng chính

| Module | Mô tả |
|--------|-------|
| **Data Sources** | Kết nối PostgreSQL, MySQL, BigQuery, Google Sheets hoặc upload CSV/Excel. Test kết nối trước khi lưu. Auto-sync theo lịch. |
| **Workspaces** | Nhóm nhiều bảng từ nhiều nguồn vào một workspace. Thêm computed columns với cú pháp công thức Excel. |
| **Explore / Chart Builder** | Giao diện kéo-chọn dimension, metric, filter, loại chart. Lưu tái sử dụng. |
| **Charts** | 11 loại: Bar, Line, Area, Pie, Scatter, Grouped Bar, Stacked Bar, Table, KPI, Time Series, Combo. |
| **Dashboards** | Grid layout kéo-thả. Global filter, per-tile parameter, inline title edit. |
| **AI Mô tả** | Tự động sinh mô tả bảng/biểu đồ, mô tả từng cột, câu hỏi mẫu bằng Tiếng Việt. Chỉnh sửa và lưu lại. |
| **AI Chat** | Hỏi đáp bằng ngôn ngữ tự nhiên. Agent tìm kiếm chart, chạy truy vấn, tạo chart mới. Lưu lịch sử hội thoại. |
| **Phân quyền** | Module-level (none/view/edit/full) + Resource-level sharing (view/edit). Cascade share dashboard → chart → workspace. |
| **Quản lý người dùng** | Admin tạo/khóa user, gán quyền từng module. |

---

## Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| **Frontend** | Next.js 14 App Router · TypeScript · Tailwind CSS · Radix UI · Recharts · TanStack Query · react-grid-layout |
| **Backend** | FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic v2 · DuckDB · Python 3.10+ |
| **AI Service** | FastAPI · WebSocket streaming · OpenAI / Anthropic / Gemini / OpenRouter |
| **AI Auto-tag** | LLM client (OpenAI gpt-4o-mini ưu tiên → OpenRouter fallback) tích hợp trong Backend |
| **Database** | PostgreSQL 16 (metadata, chat sessions) · DuckDB + Parquet (analytics) |
| **Infrastructure** | Docker · Docker Compose |

---

## Khởi động nhanh

### Docker (Khuyến nghị)

```bash
git clone <repo-url> && cd Dashboard-App-v2
cp .env.docker.example .env
# Sửa .env — tối thiểu đặt SECRET_KEY, ADMIN_PASSWORD, OPENAI_API_KEY
docker compose up --build -d
```

Truy cập **http://localhost:3000** và đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env`.

> **Note**: AI Mô tả (auto-tagging) dùng `OPENAI_API_KEY` trực tiếp.  
> AI Chat dùng `LLM_PROVIDER` + `LLM_MODEL`.

### Development (không Docker)

**Prerequisites**: Python 3.10+, Node.js 18+, PostgreSQL 16

```bash
# 1. Tạo database
createdb appbi

# 2. Backend (terminal 1)
cd backend
python -m venv ../venv && source ../venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 3. Frontend (terminal 2)
cd frontend
npm install && npm run dev

# 4. AI Service — tuỳ chọn (terminal 3)
cd ai-service
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API Docs | http://localhost:8000/api/v1/docs |
| AI Chat WebSocket | http://localhost:8001 |

---

## Biến môi trường

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | ✅ | Thông tin kết nối PostgreSQL |
| `SECRET_KEY` | ✅ | JWT signing secret (thay đổi trên production) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | Tài khoản admin được tạo tự động khi boot |
| `DATASOURCE_ENCRYPTION_KEY` | Nguồn ngoài | Fernet key để mã hóa credentials (tạo bên dưới) |
| `SEED_DEMO_DATA` | Không | `true` để nạp demo data khi boot lần đầu |
| `OPENAI_API_KEY` | AI Mô tả + Chat | Dùng cho auto-tagging (`gpt-4o-mini`) và AI chat |
| `OPENROUTER_API_KEY` | Fallback | OpenRouter dùng khi OpenAI không khả dụng |
| `ANTHROPIC_API_KEY` | Chat | Dùng khi `LLM_PROVIDER=anthropic` |
| `GEMINI_API_KEY` | Chat | Dùng khi `LLM_PROVIDER=gemini` |
| `LLM_PROVIDER` | Chat | `openai` / `anthropic` / `gemini` / `openrouter` |
| `LLM_MODEL` | Chat | Tên model, mặc định `gpt-4o-mini` |

Tạo Fernet encryption key:
```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Template đầy đủ: `.env.docker.example`

---

## Kiến trúc hệ thống

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Frontend    │────▶│  Backend    │◀────│  AI Service  │
│  Next.js 14  │     │  FastAPI    │     │  FastAPI WS  │
│  :3000       │     │  :8000      │     │  :8001       │
└──────────────┘     └──────┬──────┘     └──────────────┘
                            │
                   ┌────────┴────────┐
              PostgreSQL          DuckDB
              (metadata,        (analytics,
              auth, chat)        Parquet)
```

### Luồng dữ liệu

- **Metadata** (users, datasource configs, chart/dashboard definitions, permissions, chat sessions) → **PostgreSQL**
- **Analytics data** (synced tables, query results) → **Parquet files + DuckDB engine** trong `.data/`
- **AI Auto-tag** chạy bên trong Backend như background task — không cần AI Service

### Data Model

```
DataSource
  └── DatasetWorkspace
        └── DatasetWorkspaceTable
              └── Chart
                    └── Dashboard
```

| Model | Mô tả |
|-------|-------|
| **DataSource** | Kết nối đến database/file ngoài. Credentials mã hóa Fernet. |
| **DatasetWorkspace** | Nhóm nhiều bảng từ nhiều datasource. |
| **DatasetWorkspaceTable** | Một bảng — SQL query hoặc import vật lý. Hỗ trợ computed columns, column formats, type overrides. |
| **Chart** | Visualization gắn với một `workspace_table_id`. |
| **Dashboard** | Grid layout các charts + global filter config. |
| **ChatSession / ChatMessage** | Lịch sử hội thoại AI được lưu per-user. |

---

## Hệ thống phân quyền

### Layer 1 — Module Permissions (quyền truy cập module)

| Level | Quyền hạn |
|-------|-----------|
| `none` | Module ẩn trong sidebar, API trả 403 |
| `view` | Chỉ đọc |
| `edit` | Tạo + sửa (không xóa) |
| `full` | Tạo + sửa + xóa + share + quản lý quyền |

**Modules**: `dashboards` · `explore_charts` · `workspaces` · `data_sources` · `ai_chat` · `user_management` · `settings`

### Layer 2 — Resource Sharing (chia sẻ tài nguyên)

- Chia sẻ resource (chart, dashboard, workspace, datasource) với người dùng cụ thể ở mức `view` hoặc `edit`
- Chia sẻ dashboard **cascade** tự động chia sẻ luôn các charts và workspaces liên quan
- Owner luôn có quyền `full` trên resource của mình

---

## AI Mô tả (Auto-tagging)

Tính năng tự động sinh metadata cho bảng dữ liệu và biểu đồ bằng LLM:

| Loại | Nội dung sinh ra |
|------|-----------------|
| **Bảng dữ liệu** | Mô tả tổng quan · Mô tả từng cột (bắt buộc) · 3–5 câu hỏi mẫu |
| **Biểu đồ** | Mô tả biểu đồ · Từ khóa tìm kiếm · 2–3 câu hỏi thường gặp |

**Cách dùng**: Nhấn icon Bot (🤖) cạnh tên bảng hoặc nút Save chart → modal AI Mô tả.

**Tính năng UI**:
- "Tạo lại bằng AI" → overlay spinner, polling tự động, tự cập nhật khi xong
- Khóa tất cả input trong lúc AI đang xử lý
- Thêm/xóa câu hỏi mẫu tùy ý
- Lưu chỉnh sửa thủ công

**LLM**: Ưu tiên OpenAI `gpt-4o-mini` (qua `OPENAI_API_KEY`), fallback OpenRouter.  
**Ngôn ngữ**: Toàn bộ output bằng **Tiếng Việt**.

---

## AI Chat Agent

Hỏi-đáp dữ liệu bằng ngôn ngữ tự nhiên. Lịch sử hội thoại được lưu lại theo session.

### Tools của Agent

Agent chỉ truy cập dữ liệu được chia sẻ với user — không truy cập trực tiếp SQL nguồn.

| Tool | Mô tả |
|------|-------|
| `search_charts(query)` | Tìm kiếm ngữ nghĩa trong charts của user |
| `run_chart(chart_id)` | Chạy chart và trả về data + render |
| `search_dashboards(query)` | Tìm kiếm dashboards |
| `list_workspace_tables()` | Liệt kê workspace tables + schema cột |
| `query_table(workspace_id, table_id, ...)` | Truy vấn aggregation trên workspace table |
| `run_workspace_table(workspace_id, table_id)` | Preview raw rows |
| `create_chart(...)` | Tạo và lưu chart mới từ workspace table |
| `create_dashboard(name, chart_ids)` | Tạo dashboard mới |
| `explore_data(workspace_id, table_id)` | Profile bảng — phân phối, top values, nulls |
| `explain_insight(chart_id)` | Giải thích chart bằng ngôn ngữ tự nhiên |

### LLM Providers

```env
LLM_PROVIDER=openai        # openai | anthropic | gemini | openrouter
LLM_MODEL=gpt-4o-mini
```

---

## Demo Data

Bật `SEED_DEMO_DATA=true` trong `.env` để nạp tự động khi boot lần đầu, hoặc chạy thủ công:

```bash
# Từ thư mục gốc, sau khi activate venv
python seed_demo.py
```

Tạo: 1 datasource (Football/FIFA), 3 workspaces, 18 charts, 3 dashboards.

### Tài khoản test

```bash
python seed_test_users.py
```

| Email | Mật khẩu | Quyền |
|-------|----------|-------|
| `admin@appbi.io` | `admin123` | Full (tất cả modules) |
| `edit@appbi.io` | `edit123` | Edit (tất cả modules) |
| `viewer@appbi.io` | `viewer123` | View (tất cả modules) |

---

## Database Migration

```bash
cd backend
source ../venv/bin/activate

# Áp dụng migrations mới nhất
alembic upgrade head

# Tạo migration mới
alembic revision --autogenerate -m "mô tả thay đổi"
```

Migrations nằm trong `backend/alembic/versions/`. Đặt tên theo format `YYYYMMDD_HHMM_slug.py`.

---

## Docker Compose

| File | Dùng cho |
|------|----------|
| `docker-compose.yml` | Production: tất cả services |
| `docker-compose.dev.yml` | Development: hot reload, volume mounts |
| `docker-compose.ai.yml` | Chạy riêng AI Service |

```bash
# Production
docker compose up --build -d

# Development (hot reload)
docker compose -f docker-compose.dev.yml up --build -d

# Xem logs
docker compose logs -f backend
docker compose logs -f frontend
```

---

## API Reference

Interactive docs: **http://localhost:8000/api/v1/docs**

| Endpoint | Methods | Mô tả |
|----------|---------|-------|
| `/auth/login` | POST | Đăng nhập, trả JWT |
| `/auth/signup` | POST | Đăng ký user mới |
| `/datasources` | GET, POST | Danh sách / tạo data source |
| `/datasources/{id}` | GET, PUT, DELETE | CRUD data source |
| `/datasources/{id}/test` | POST | Test kết nối |
| `/dataset-workspaces` | GET, POST | Danh sách / tạo workspace |
| `/dataset-workspaces/{id}` | GET, PUT, DELETE | CRUD workspace |
| `/dataset-workspaces/{id}/tables` | POST | Thêm bảng vào workspace |
| `/dataset-workspaces/{ws}/tables/{t}/description` | GET, PUT | Xem/sửa AI mô tả bảng |
| `/dataset-workspaces/{ws}/tables/{t}/description/regenerate` | POST | Tạo lại AI mô tả bảng |
| `/charts` | GET, POST | Danh sách / tạo chart |
| `/charts/{id}` | GET, PUT, DELETE | CRUD chart |
| `/charts/{id}/data` | GET | Chạy query chart |
| `/charts/{id}/description` | GET, PUT | Xem/sửa AI mô tả chart |
| `/charts/{id}/description/regenerate` | POST | Tạo lại AI mô tả chart |
| `/dashboards` | GET, POST | Danh sách / tạo dashboard |
| `/dashboards/{id}` | GET, PUT, DELETE | CRUD dashboard |
| `/dashboards/{id}/layout` | PUT | Cập nhật vị trí chart |
| `/shares/{type}/{id}` | GET, POST, PUT, DELETE | Quản lý chia sẻ tài nguyên |
| `/permissions/{user_id}` | GET, PUT | Quyền module theo user |
| `/users` | GET | Danh sách users (admin) |
| `/chat-sessions` | GET, POST | Lịch sử chat sessions |

Tài liệu API đầy đủ: [docs/API.md](docs/API.md)

---

## Nguồn dữ liệu hỗ trợ

| Loại | Thông tin cần |
|------|---------------|
| **PostgreSQL** | Host, Port, Database, Username, Password, Schema (tuỳ chọn) |
| **MySQL** | Host, Port, Database, Username, Password |
| **Google BigQuery** | Project ID + Service Account JSON |
| **Google Sheets** | Service Account JSON + Spreadsheet ID |
| **CSV / Excel** | Upload file trực tiếp (.csv, .xlsx, .xls) — tất cả sheets được import |

---

## Cấu trúc project

```
/
├── backend/                    # FastAPI Backend (:8000)
│   ├── app/
│   │   ├── api/                # Route handlers
│   │   ├── core/               # Config, auth, database, permissions
│   │   ├── models/             # SQLAlchemy models
│   │   ├── schemas/            # Pydantic DTOs
│   │   └── services/           # Business logic, LLM client, sync engine
│   └── alembic/                # Database migrations
│
├── frontend/                   # Next.js 14 Frontend (:3000)
│   └── src/
│       ├── app/                # Pages (App Router)
│       ├── components/         # UI components
│       ├── hooks/              # React Query hooks
│       ├── lib/                # API clients, utilities
│       └── types/              # TypeScript types
│
├── ai-service/                 # AI Chat Agent (:8001)
│   └── app/
│       ├── agents/             # Orchestrator, tools, context builder
│       ├── clients/            # BI backend client, LLM clients
│       └── routers/            # WebSocket chat endpoint
│
├── docs/                       # Tài liệu kỹ thuật
├── docker-compose.yml
├── docker-compose.dev.yml
├── .env.docker.example
├── seed_demo.py                # Demo data Football/FIFA
└── seed_test_users.py          # 3 test accounts
```

---

## License

Private — All rights reserved.
