"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import auth, datasources, charts, dashboards, dataset_workspaces, users, shares, permissions, anomaly
from app.routers import semantic

# Create main API router
api_router = APIRouter()

# Auth routes (no /api/v1 prefix needed — keep at root-ish)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(shares.router)
api_router.include_router(permissions.router)

# Data routes
api_router.include_router(datasources.router)
api_router.include_router(dataset_workspaces.router, prefix="/dataset-workspaces", tags=["dataset-workspaces"])
api_router.include_router(charts.router)
api_router.include_router(dashboards.router)
api_router.include_router(semantic.router)

# Phase 4: Proactive Intelligence
api_router.include_router(anomaly.router)

__all__ = ["api_router"]
