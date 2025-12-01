#!/bin/bash

# Docker Startup Verification Script
# Run this after: docker-compose up -d

echo ""
echo "🐳 AppBI Docker Startup Verification"
echo "===================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if Docker is running
echo -e "${YELLOW}Checking Docker...${NC}"
if docker --version > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Docker is installed and running${NC}\n"
else
    echo -e "${RED}❌ Docker is not running or not installed${NC}\n"
    exit 1
fi

# Check if docker-compose is available
echo -e "${YELLOW}Checking Docker Compose...${NC}"
if docker-compose --version > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Docker Compose is available${NC}\n"
else
    echo -e "${RED}❌ Docker Compose is not available${NC}\n"
    exit 1
fi

# Check container status
echo -e "${YELLOW}Checking containers...${NC}"
if docker-compose ps | grep -q "db.*running"; then
    echo -e "${GREEN}✅ Database (PostgreSQL) is running${NC}"
else
    echo -e "${RED}❌ Database is not running${NC}"
fi

if docker-compose ps | grep -q "backend.*running"; then
    echo -e "${GREEN}✅ Backend (FastAPI) is running${NC}"
else
    echo -e "${RED}❌ Backend is not running${NC}"
fi

if docker-compose ps | grep -q "frontend.*running"; then
    echo -e "${GREEN}✅ Frontend (Next.js) is running${NC}\n"
else
    echo -e "${RED}❌ Frontend is not running${NC}\n"
fi

# Check endpoints
echo -e "${YELLOW}Checking endpoints...${NC}"

# Backend health
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/docs | grep -q "200"; then
    echo -e "${GREEN}✅ Backend API is responding (http://localhost:8000)${NC}"
else
    echo -e "${RED}❌ Backend API is not responding${NC}"
fi

# Frontend health
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo -e "${GREEN}✅ Frontend is responding (http://localhost:3000)${NC}\n"
else
    echo -e "${RED}❌ Frontend is not responding${NC}\n"
fi

# Check database connection
echo -e "${YELLOW}Checking database connection...${NC}"
if docker-compose exec -T db psql -U appbi -d appbi -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Database connection successful${NC}\n"
else
    echo -e "${RED}❌ Database connection failed${NC}\n"
fi

# Check migrations
echo -e "${YELLOW}Checking database migrations...${NC}"
if docker-compose exec -T backend alembic current 2>&1 | grep -q "head"; then
    echo -e "${GREEN}✅ Migrations are up to date${NC}\n"
else
    echo -e "${YELLOW}⚠️ Migrations may not be current${NC}\n"
fi

# Summary
echo -e "${CYAN}====================================${NC}\n"
echo -e "${CYAN}🎯 Access Points:${NC}"
echo "   Frontend:  http://localhost:3000"
echo "   Backend:   http://localhost:8000"
echo "   API Docs:  http://localhost:8000/docs"
echo "   Database:  localhost:5432 (appbi/appbi)"
echo ""

echo -e "${CYAN}📊 Quick Commands:${NC}"
echo "   View logs:     docker-compose logs -f"
echo "   Stop all:      docker-compose down"
echo "   Restart:       docker-compose restart"
echo "   Check status:  docker-compose ps"
echo ""

echo -e "${GREEN}✅ Verification complete!${NC}\n"
