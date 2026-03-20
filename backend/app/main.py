"""
Main FastAPI application.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core import settings, setup_logging
from app.api import api_router

# Setup logging
setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Ensure all required data directories exist before any service starts.
    # This runs on EVERY startup so the folder structure is always correct
    # regardless of which machine the project is cloned to.
    data_root = settings.data_dir_path
    for sub in ("synced", "datasets", "workspaces"):
        (data_root / sub).mkdir(parents=True, exist_ok=True)

    import logging
    logging.getLogger(__name__).info("Data directory: %s", data_root)

    # Legacy DataSource-level scheduler (kept for backward compat)
    from app.services.sync_scheduler import startup as ds_scheduler_startup
    ds_scheduler_startup()

    # New Dataset-level sync scheduler
    from app.services.dataset_sync_scheduler import startup as dataset_scheduler_startup
    dataset_scheduler_startup()

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    from app.services.dataset_sync_scheduler import shutdown as dataset_scheduler_shutdown
    dataset_scheduler_shutdown()

    from app.services.sync_scheduler import shutdown as ds_scheduler_shutdown
    ds_scheduler_shutdown()

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
