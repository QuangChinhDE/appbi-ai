# Hướng dẫn cài đặt Docker cho Windows

## Bước 1: Tải Docker Desktop

1. Truy cập: https://www.docker.com/products/docker-desktop
2. Tải Docker Desktop cho Windows
3. Chạy file cài đặt

## Bước 2: Cài đặt Docker Desktop

1. Chạy installer
2. Chọn "Use WSL 2 instead of Hyper-V" (nếu có)
3. Hoàn tất cài đặt
4. Khởi động lại máy tính

## Bước 3: Khởi động Docker Desktop

1. Mở Docker Desktop từ Start Menu
2. Đợi Docker khởi động (biểu tượng Docker ở system tray sẽ chuyển màu xanh)

## Bước 4: Kiểm tra cài đặt

Mở PowerShell và chạy:

```powershell
docker --version
docker-compose --version
```

Nếu thấy version number => Cài đặt thành công!

## Bước 5: Chạy AppBI

```powershell
cd "C:\Users\Thom Tran\appbi"
docker-compose up -d
```

Sau 1-2 phút, truy cập:
- Frontend: http://localhost:3000
- Backend: http://localhost:8000/docs

---

## Lưu ý:

**Yêu cầu hệ thống:**
- Windows 10 Pro/Enterprise/Education (64-bit) hoặc Windows 11
- WSL 2 (Windows Subsystem for Linux)
- Ít nhất 4GB RAM
- Ít nhất 10GB ổ đĩa trống

**Nếu gặp lỗi WSL 2:**
```powershell
# Mở PowerShell as Administrator và chạy:
wsl --install
wsl --set-default-version 2
```

**Nếu bạn dùng Windows Home:**
- Docker Desktop vẫn hoạt động nhưng cần enable WSL 2
- Xem hướng dẫn: https://docs.docker.com/desktop/install/windows-install/
