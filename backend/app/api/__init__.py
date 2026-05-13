"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import auth, datasources, charts, dashboards, datasets, users, shares, permissions, anomaly, feedback, public, personal_access_tokens, teams
from app.core.config import settings
from app.routers import semantic

# Create main API router
api_router = APIRouter()

# Auth routes (no /api/v1 prefix needed — keep at root-ish)
api_router.include_router(auth.router)
api_router.include_router(personal_access_tokens.router)
api_router.include_router(users.router)
api_router.include_router(teams.router)
api_router.include_router(shares.router)
api_router.include_router(permissions.router)

# Data routes
api_router.include_router(datasources.router)
api_router.include_router(datasets.router, prefix="/datasets", tags=["datasets"])
api_router.include_router(charts.router)
api_router.include_router(dashboards.router)

# Workboards mini-app builder — toggleable via WORKBOARDS_ENABLED
# (see backend/app/modules/workboards/ and docker-compose.workboard.yml).
if settings.WORKBOARDS_ENABLED:
    from app.modules.workboards.api import router as workboards_router
    from app.modules.workboards.webhook_api import router as workboards_webhook_router
    from app.modules.workboards.workspace_admin_api import (
        router as workspaces_admin_router,
        _relationships_router as workboard_relationships_router,
    )
    api_router.include_router(workboards_router)
    api_router.include_router(workboards_webhook_router)
    api_router.include_router(workspaces_admin_router)
    api_router.include_router(workboard_relationships_router)

api_router.include_router(semantic.router)

# Phase 4: Proactive Intelligence
api_router.include_router(anomaly.router)

# Phase 5: Feedback-Driven Knowledge System
api_router.include_router(feedback.router)

# Public unauthenticated endpoints (shared dashboard links)
api_router.include_router(public.router)

__all__ = ["api_router"]
