from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.clients.bi_client import bi_client
from app.config import settings
from app.schemas.agent import AgentBriefRequest, AgentBuildRequest, AgentPlanResponse
from app.services.builder import build_dashboard_stream
from app.services.planner import build_agent_plan, load_table_contexts

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agent", tags=["agent"])

_ALGORITHM = "HS256"
_bearer = HTTPBearer(auto_error=False)
_LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _decode_token(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
    except JWTError:
        return None


def _require_auth_raw(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> tuple[dict, str]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    raw = credentials.credentials
    payload = _decode_token(raw)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload, raw


def _has_level(permissions: dict[str, str], module: str, required: str) -> bool:
    return _LEVEL_ORDER.get(permissions.get(module, "none"), 0) >= _LEVEL_ORDER[required]


async def _require_agent_permissions(token: str) -> None:
    perms_payload = await bi_client.get_my_permissions(token)
    permissions = perms_payload.get("permissions", {})

    if not _has_level(permissions, "ai_agent", "edit"):
        raise HTTPException(status_code=403, detail="Requires ai_agent >= edit")
    if not _has_level(permissions, "dashboards", "edit"):
        raise HTTPException(status_code=403, detail="Requires dashboards >= edit")
    if not _has_level(permissions, "explore_charts", "edit"):
        raise HTTPException(status_code=403, detail="Requires explore_charts >= edit")


@router.post("/plan", response_model=AgentPlanResponse)
async def generate_plan(
    brief: AgentBriefRequest,
    auth_ctx: tuple[dict, str] = Depends(_require_auth_raw),
):
    payload, token = auth_ctx
    if payload.get("ai_agent_level", "none") not in ("edit", "full"):
        raise HTTPException(status_code=403, detail="Requires ai_agent >= edit")
    await _require_agent_permissions(token)

    contexts = await load_table_contexts(brief, token)
    return build_agent_plan(brief, contexts)


@router.post("/build/stream")
async def build_dashboard(
    request: AgentBuildRequest,
    auth_ctx: tuple[dict, str] = Depends(_require_auth_raw),
):
    payload, token = auth_ctx
    if payload.get("ai_agent_level", "none") not in ("edit", "full"):
        raise HTTPException(status_code=403, detail="Requires ai_agent >= edit")
    await _require_agent_permissions(token)

    async def generate():
        try:
            async for event in build_dashboard_stream(request, token):
                yield event
        except HTTPException as exc:
            yield json.dumps(
                {
                    "type": "error",
                    "phase": "build",
                    "message": exc.detail,
                    "error": exc.detail,
                },
                ensure_ascii=False,
            ) + "\n"
        except Exception as exc:
            logger.exception("Agent build failed")
            yield json.dumps(
                {
                    "type": "error",
                    "phase": "build",
                    "message": "Agent build failed",
                    "error": str(exc),
                },
                ensure_ascii=False,
            ) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")
