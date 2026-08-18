# Backend Dockerfile for FastAPI application
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies for PostgreSQL, MySQL, and BigQuery clients
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    default-libmysqlclient-dev \
    pkg-config \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY backend/requirements.txt .

# Install Python dependencies.
# Phase-15.72 — harden against transient network blips during Docker
# build. Default pip times out after ~15s per chunk; on slow PyPI
# mirrors a single big wheel (eg. numpy ~25MB) can stall and KILL an
# 8-minute build. Bumping --timeout + adding --retries gives pip a
# fighting chance to recover instead of aborting the whole layer.
ENV PIP_DEFAULT_TIMEOUT=180 \
    PIP_RETRIES=8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY backend/app/ ./app/
COPY backend/alembic/ ./alembic/
COPY backend/alembic.ini .
COPY backend/scripts/reindex_govern_doc_embeddings.py ./scripts/reindex_govern_doc_embeddings.py

# Copy seed script (used when SEED_DEMO_DATA=true)
# COPY seed_demo.py .
# Copy demo data file used by seed
# COPY scope-foodball-demo.xlsx .

# Copy entrypoint script
COPY backend/entrypoint.sh .
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

# Expose port
EXPOSE 8000

# Use entrypoint script
ENTRYPOINT ["./entrypoint.sh"]
