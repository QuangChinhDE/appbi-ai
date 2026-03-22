"""
Main FastAPI application.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.core import settings, setup_logging
from app.api import api_router

# Setup logging
setup_logging()

limiter = Limiter(key_func=get_remote_address)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Ensure all required data directories exist before any service starts.
    # This runs on EVERY startup so the folder structure is always correct
    # regardless of which machine the project is cloned to.
    data_root = settings.data_dir_path
    for sub in ("synced", "workspaces"):
        (data_root / sub).mkdir(parents=True, exist_ok=True)

    import logging
    logging.getLogger(__name__).info("Data directory: %s", data_root)

    # Re-register any Parquet files written by previous runs so DuckDB views
    # are immediately available without requiring a manual re-sync.
    from app.services.sync_engine import restore_synced_views
    restore_synced_views()

    # DataSource-level sync scheduler
    from app.services.sync_scheduler import startup as ds_scheduler_startup
    ds_scheduler_startup()

    # Anomaly detection daily scheduler (Phase 4)
    from app.services.anomaly_scheduler import startup as anomaly_scheduler_startup
    anomaly_scheduler_startup()

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    from app.services.sync_scheduler import shutdown as ds_scheduler_shutdown
    ds_scheduler_shutdown()

    from app.services.anomaly_scheduler import shutdown as anomaly_scheduler_shutdown
    anomaly_scheduler_shutdown()

    # Shutdown DuckDB engine
    from app.services.duckdb_engine import DuckDBEngine
    DuckDBEngine.shutdown()


# Create FastAPI application
app = FastAPI(
    title="AppBI - Modern BI Tool",
    description="Open-source Business Intelligence tool with SQL data source support",
    version="0.1.0",
    lifespan=lifespan,
)

# Configure CORS
print(f"DEBUG: CORS origins = {settings.cors_origins_list}")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
print("DEBUG: CORS middleware added")

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
