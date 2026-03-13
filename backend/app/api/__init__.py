"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import datasources, datasets, charts, dashboards, dataset_models, dataset_workspaces
from app.routers import semantic

# Create main API router
api_router = APIRouter()

# Include all sub-routers
api_router.include_router(datasources.router)
api_router.include_router(datasets.router)
api_router.include_router(dataset_models.router)
api_router.include_router(dataset_workspaces.router, prefix="/dataset-workspaces", tags=["dataset-workspaces"])
api_router.include_router(charts.router)
api_router.include_router(dashboards.router)
api_router.include_router(semantic.router)

__all__ = ["api_router"]
