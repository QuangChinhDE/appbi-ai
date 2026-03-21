#!/bin/bash
# ============================================================
# install-docker-and-run.sh
# Cài Docker Engine + Docker Compose trên Ubuntu 22.04
# rồi chạy AppBI bằng docker compose
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
info() { echo -e "  ${YELLOW}→${RESET} $*"; }
err()  { echo -e "  ${RED}✗${RESET} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "\n${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  AppBI — Docker Setup${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}\n"

# ── 1. Cài Docker Engine ─────────────────────────────────
echo -e "${BOLD}[1/5] Cài Docker Engine...${RESET}"

if command -v docker &>/dev/null; then
    ok "Docker đã được cài: $(docker --version)"
else
    info "Thêm Docker APT repository..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    info "Cài docker-ce + compose plugin..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin

    ok "Docker đã cài: $(docker --version)"
fi

# ── 2. Start Docker service ──────────────────────────────
echo -e "\n${BOLD}[2/5] Khởi động Docker daemon...${RESET}"
sudo systemctl enable docker --quiet
sudo systemctl start docker
ok "Docker daemon đang chạy"

# ── 3. Thêm user vào group docker ───────────────────────
echo -e "\n${BOLD}[3/5] Thêm $USER vào group docker...${RESET}"
sudo usermod -aG docker "$USER"
ok "$USER đã vào group docker (hiệu lực khi mở terminal mới)"

# ── 4. Tạo .env nếu chưa có ─────────────────────────────
echo -e "\n${BOLD}[4/5] Cấu hình .env...${RESET}"
if [ ! -f .env ]; then
    cp .env.docker.example .env
    ok ".env đã được tạo từ .env.docker.example"
    info "Bạn có thể chỉnh sửa .env để thay đổi mật khẩu, API keys, v.v."
else
    ok ".env đã tồn tại — giữ nguyên"
fi

# ── 5. Chạy docker compose ───────────────────────────────
echo -e "\n${BOLD}[5/5] Build và khởi động AppBI...${RESET}"
info "Đang chạy: sudo docker compose up --build -d"
info "(Lần đầu tiên có thể mất vài phút để build images)"
echo ""

sudo docker compose up --build -d

echo ""
ok "Tất cả services đã khởi động!"
echo ""
echo -e "${BOLD}Services:${RESET}"
sudo docker compose ps

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}✓ AppBI đang chạy!${RESET}"
echo -e ""
echo -e "  Frontend :  http://localhost:3000"
echo -e "  Backend  :  http://localhost:8000/api/v1/docs"
echo -e "  AI Chat  :  http://localhost:8001"
echo -e ""
echo -e "  Admin login:"
echo -e "    Email   : $(grep ADMIN_EMAIL .env | cut -d= -f2)"
echo -e "    Password: $(grep ADMIN_PASSWORD .env | cut -d= -f2)"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Xem log: ${YELLOW}sudo docker compose logs -f backend${RESET}"
echo -e "  Dừng   : ${YELLOW}sudo docker compose down${RESET}"
echo ""
