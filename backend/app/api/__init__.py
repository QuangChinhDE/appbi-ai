"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import datasources, datasets, charts, dashboards

# Create main API router
api_router = APIRouter()

# Include all sub-routers
api_router.include_router(datasources.router)
api_router.include_router(datasets.router)
api_router.include_router(charts.router)
api_router.include_router(dashboards.router)

__all__ = ["api_router"]
