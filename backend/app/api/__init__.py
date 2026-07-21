"""
API package initialization.
"""
from fastapi import APIRouter
from app.api import auth, datasources, charts, dashboards, datasets, users, shares, permissions, observability, public, personal_access_tokens, teams, integrations
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

# Metadata Catalog — AppBI-native Govern backend (Vocabulary + Metrics + Knowledge Hub),
# proxied under /catalog. Imported ONLY when enabled so the core app is unaffected while OFF.
if settings.METADATA_CATALOG_ENABLED:
    from app.modules.metadata_catalog.api import router as metadata_catalog_router
    api_router.include_router(metadata_catalog_router)

# Observability — dataset health (incidents + semantic lineage + usage + alert channels)
api_router.include_router(observability.router)

# Public unauthenticated endpoints (shared dashboard links)
api_router.include_router(integrations.router)
api_router.include_router(public.router)

__all__ = ["api_router"]
