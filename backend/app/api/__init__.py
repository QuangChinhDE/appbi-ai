"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import auth, datasources, charts, dashboards, dataset_workspaces, users, shares, permissions, anomaly, feedback, chat_sessions, agent_report_specs
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

# Phase 5: Feedback-Driven Knowledge System
api_router.include_router(feedback.router)

# AI Chat session persistence
api_router.include_router(chat_sessions.router)

# AI Agent saved reports
api_router.include_router(agent_report_specs.router)

__all__ = ["api_router"]
