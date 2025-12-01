# Hướng dẫn chạy AppBI không dùng Docker

## Yêu cầu

- Python 3.10+
- Node.js 18+
- PostgreSQL 12+

## Bước 1: Cài đặt PostgreSQL

1. Tải PostgreSQL: https://www.postgresql.org/download/windows/
2. Cài đặt với các thông tin:
   - Port: 5432
   - Username: postgres
   - Password: (chọn password của bạn)

3. Tạo database:
```powershell
# Mở SQL Shell (psql) từ Start Menu
psql -U postgres

# Trong psql:
CREATE DATABASE appbi;
\q
```

## Bước 2: Cài đặt Backend

```powershell
# Di chuyển đến thư mục backend
cd "C:\Users\Thom Tran\appbi\backend"

# Tạo virtual environment
python -m venv venv

# Kích hoạt virtual environment
.\venv\Scripts\Activate.ps1

# Cài đặt dependencies
pip install -r requirements.txt

# Tạo file .env
Copy-Item .env.example .env

# Chỉnh sửa .env (dùng notepad hoặc VSCode)
# Cập nhật DATABASE_URL với password PostgreSQL của bạn:
# DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/appbi
notepad .env

# Chạy migrations
alembic upgrade head

# Khởi động backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend sẽ chạy tại: http://localhost:8000

## Bước 3: Cài đặt Frontend (Terminal mới)

Mở PowerShell window thứ 2:

```powershell
# Di chuyển đến thư mục frontend
cd "C:\Users\Thom Tran\appbi\frontend"

# Cài đặt dependencies
npm install

# Tạo file .env.local
Copy-Item .env.local.example .env.local

# Khởi động frontend
npm run dev
```

Frontend sẽ chạy tại: http://localhost:3000

## Kiểm tra

Mở trình duyệt và truy cập:
- Frontend: http://localhost:3000
- Backend API Docs: http://localhost:8000/docs

## Dừng các service

**Backend (Terminal 1):**
- Nhấn `Ctrl + C`
- Gõ: `deactivate` (để thoát virtual environment)

**Frontend (Terminal 2):**
- Nhấn `Ctrl + C`

## Chạy lại

**Terminal 1 - Backend:**
```powershell
cd "C:\Users\Thom Tran\appbi\backend"
.\venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 - Frontend:**
```powershell
cd "C:\Users\Thom Tran\appbi\frontend"
npm run dev
```

## Khắc phục sự cố

**Lỗi: "Port 8000 is already in use"**
```powershell
# Tìm process đang dùng port 8000
netstat -ano | findstr :8000

# Kill process (thay <PID> bằng số Process ID tìm được)
taskkill /PID <PID> /F
```

**Lỗi: "Port 3000 is already in use"**
```powershell
# Tìm process đang dùng port 3000
netstat -ano | findstr :3000

# Kill process
taskkill /PID <PID> /F
```

**Lỗi: "alembic: command not found"**
```powershell
# Đảm bảo virtual environment đã được kích hoạt
.\venv\Scripts\Activate.ps1

# Cài lại alembic
pip install alembic
```

**Lỗi kết nối database:**
- Kiểm tra PostgreSQL đang chạy (mở Services → PostgreSQL service)
- Kiểm tra DATABASE_URL trong .env có đúng password không
- Kiểm tra database đã được tạo: `psql -U postgres -c "\l"`

## So sánh Docker vs Manual

| Tính năng | Docker | Manual |
|-----------|--------|--------|
| Cài đặt | Phức tạp hơn (cần Docker Desktop) | Đơn giản hơn |
| Chạy | 1 lệnh (docker-compose up) | 2 terminals riêng |
| Quản lý | Dễ dàng | Phức tạp hơn |
| Production | ✅ Recommended | ❌ Not recommended |
| Development | ✅ Good | ✅ Good |

## Khuyến nghị

- **Để phát triển nhanh:** Chạy manual (cách này)
- **Để deploy production:** Dùng Docker
- **Để chia sẻ với team:** Dùng Docker
