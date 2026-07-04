"""
Main FastAPI application.
"""
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.core import settings, setup_logging
from app.core.config import validate_security_settings
from app.api import api_router
from app.services.google_sheets_cache import SheetsQuotaError

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

    # AI bot institutional-memory daily reflection (curate learned knowledge)
    from app.services.dashboard_ai_bot.learning_scheduler import startup as ai_learning_startup
    ai_learning_startup()

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

    from app.services.dashboard_ai_bot.learning_scheduler import shutdown as ai_learning_shutdown
    ai_learning_shutdown()


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


# Phase-15.62 — Resilient error envelope.
# FastAPI default HTTPException handler calls json.dumps(detail) and
# crashes with "Object of type X is not JSON serializable" when a
# caller passes a non-primitive (raw Exception object, custom class,
# etc.) as detail. The original 4xx/5xx then becomes a generic 500
# with a useless traceback, and the actual error message vanishes
# from the response — DA only sees "500" with no context.
#
# This handler:
#   1. Tries the normal path (json.dumps the detail).
#   2. If serialization fails, falls back to repr/str + logs the bug
#      so we can fix the offending call site, but the client still
#      receives the intended status code + a readable message.
_logger = logging.getLogger("app.error_envelope")


def _safe_detail(value):
    """Recursively coerce `value` into something json.dumps can handle."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _safe_detail(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_safe_detail(item) for item in value]
    if isinstance(value, BaseException):
        return f"{type(value).__name__}: {value}"
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


@app.exception_handler(HTTPException)
async def http_exception_handler_safe(request: Request, exc: HTTPException):
    detail = exc.detail
    try:
        safe = json.loads(json.dumps(detail))
    except (TypeError, ValueError):
        safe = _safe_detail(detail)
        _logger.warning(
            "[error_envelope] HTTPException raised with non-JSON detail "
            "(status=%s, path=%s, type=%s). Sanitised before response.",
            exc.status_code,
            request.url.path,
            type(detail).__name__,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": safe},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(SheetsQuotaError)
async def sheets_quota_handler(request: Request, exc: SheetsQuotaError):
    """Google Sheets read-quota hit anywhere in the request → honest, retryable
    503 (never a silent empty result)."""
    _logger.warning("[sheets_quota] %s at %s", str(exc), request.url.path)
    return JSONResponse(
        status_code=503,
        content={"detail": str(exc) or "Google Sheets read quota exceeded — retry shortly."},
        headers={"Retry-After": "5"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Last-resort 500 with the error class + message — instead of an
    empty body that gives DA nothing to act on. Full stack trace still
    goes to backend logs via logger.exception."""
    _logger.exception(
        "[error_envelope] Unhandled %s at %s",
        type(exc).__name__,
        request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "error_class": type(exc).__name__,
                "message": str(exc) or "Unknown server error",
                "hint": "Check backend logs for the full stack trace.",
            }
        },
    )


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


# Bump this string whenever the SQL codegen behaviour changes, so a deployed
# instance can be asked "which code are you running?" without shell access.
CODE_VERSION = "distinct-decorrelation-v1"


@app.get("/api/v1/health")
def api_health_check():
    """API-reachable health + version probe.

    Nginx only proxies ``/api/*`` to the backend, so the root ``/health``
    is not reachable through the public gateway — this one is. ``git_sha``
    is best-effort from the build environment; ``features`` are *code
    constants*, so a flag is present iff THIS source is the running process.
    That makes it an objective test of whether a deploy actually took effect
    (a stale build 404s this route or reports the flag absent).
    """
    return {
        "status": "healthy",
        "git_sha": (
            os.getenv("GIT_SHA")
            or os.getenv("SOURCE_COMMIT")
            or os.getenv("COMMIT_SHA")
            or "unknown"
        ),
        "code_version": CODE_VERSION,
        "features": {
            # True only in code that de-correlates the distinct-value cascade
            # (EXISTS -> IN), the fix for BigQuery "Correlated subqueries" 400.
            # If this is missing/false on a live instance, it is running a
            # pre-fix build regardless of what was pulled.
            "distinct_cascade_decorrelation": True,
        },
    }
