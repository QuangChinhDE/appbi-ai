"""
Main FastAPI application.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.core import settings, setup_logging
from app.core.config import validate_security_settings
from app.api import api_router

# Setup logging
setup_logging()

# Fail-fast if production uses insecure defaults
validate_security_settings()

limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    import logging
    logging.getLogger(__name__).info("Data directory: %s", settings.data_dir_path)

    # Anomaly detection daily scheduler (Phase 4)
    from app.services.anomaly_scheduler import startup as anomaly_scheduler_startup
    anomaly_scheduler_startup()

    # Dataset Quality automation scheduler
    from app.services.dataset_quality_scheduler import startup as quality_scheduler_startup
    quality_scheduler_startup()

    # Periodic cleanup of expired revoked tokens
    from app.services.token_cleanup import schedule_token_cleanup
    schedule_token_cleanup()

    # Reclaim workboard webhook sync runs left running from a previous
    # process — without this they'd be stuck in "running" forever.
    try:
        from app.modules.workboards.services.webhook_sync_service import (
            reap_stuck_sync_runs,
        )
        reap_stuck_sync_runs()
    except Exception as exc:  # pragma: no cover — best-effort startup hook
        logging.getLogger(__name__).warning(
            "Failed to reap stuck workboard sync runs on startup: %s", exc
        )

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    from app.services.anomaly_scheduler import shutdown as anomaly_scheduler_shutdown
    anomaly_scheduler_shutdown()

    from app.services.dataset_quality_scheduler import shutdown as quality_scheduler_shutdown
    quality_scheduler_shutdown()


# Disable Swagger UI / ReDoc / OpenAPI schema in production to prevent
# leaking the full API surface to unauthenticated users.
_is_dev = settings.ENVIRONMENT.lower() in ("dev", "development", "test")

# Create FastAPI application
app = FastAPI(
    title="AppBI - Modern BI Tool",
    description="Open-source Business Intelligence tool with SQL data source support",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _is_dev else None,
    redoc_url="/redoc" if _is_dev else None,
    openapi_url="/openapi.json" if _is_dev else None,
)

# Configure CORS
print(f"DEBUG: CORS origins = {settings.cors_origins_list}")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Public-Session", "X-Requested-With"],
    max_age=3600,  # cache preflight 1h so cross-origin calls skip repeated OPTIONS
)
print("DEBUG: CORS middleware added")

# Compress responses > 1 KB — chart data payloads shrink ~10× with gzip.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Include API router
app.include_router(api_router, prefix="/api/v1")


@app.get("/")
def root():
    """Root endpoint."""
    return {
        "message": "AppBI API",
        "version": "0.1.0",
        "docs": "/docs"
    }


@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}
