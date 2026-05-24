"""Shared infrastructure for the AppBI Workboard MCP."""
from __future__ import annotations

import functools
import logging
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP


def _runtime_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = _runtime_root()
load_dotenv(Path(os.getenv("APPBI_ENV_FILE") or (ROOT / ".env")))


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def _normalize_api_base_url(raw: str) -> str:
    base = str(raw or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("APPBI_BASE_URL is required, for example http://localhost:8000")
    if base.endswith("/api/v1"):
        return base
    return f"{base}/api/v1"


def _read_required_pat() -> str:
    token = str(os.getenv("APPBI_PAT") or "").strip()
    if not token:
        raise RuntimeError("APPBI_PAT is required")
    if "replace_me" in token.lower() or token.lower() == "your_token_here":
        raise RuntimeError("APPBI_PAT still contains a placeholder value")
    return token


APPBI_API_BASE_URL = _normalize_api_base_url(os.getenv("APPBI_BASE_URL", ""))
APPBI_PAT = _read_required_pat()
APPBI_TIMEOUT_SECONDS = float(os.getenv("APPBI_TIMEOUT_SECONDS", "120"))
APPBI_VERIFY_TLS = _env_flag("APPBI_VERIFY_TLS", True)


logging.basicConfig(
    level=os.getenv("APPBI_MCP_LOG_LEVEL", "INFO").upper(),
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("appbi_workboard_mcp")


_MCP_INSTRUCTIONS = """
You are the AppBI Workboard Builder. Build a real mini-app from an existing
AppBI dataset. A production-grade result is one coherent Workboard bundle:
layout_json screens + app users + doc webhooks + optional public workspace.

## Canonical workflow

1. Read first:
   list_datasets -> inspect_dataset_for_workboard(dataset_id)
   list_workboards -> list_workspaces when reuse is possible.
2. Design once:
   get_workboard_design_guide() for the current bundle contract and screen
   examples. Build a bundle with only the screens the user asked for.
3. Dry-run:
   validate_workboard_bundle(bundle). Fix every error and consider warnings.
4. Confirm once:
   apply_workboard_bundle(bundle, user_confirmed=true). This can create or
   update a workboard, publish it, upsert app users, store webhook configs,
   and link/create a workspace.
5. Verify:
   audit_workboard and run_workboard_runtime_smoke_test as a real app user.

## Non-negotiable rules

- Start from dataset tables already attached to AppBI. Source ingestion and
  dashboard authoring stay in the dashboard MCP or AppBI UI.
- Use the table ids from inspect_dataset_for_workboard, not source table ids.
- Use current screen kinds only: form, table, doc, dashboard. For a table
  screen the spec key is `table`, never legacy `list` or `grid`.
- Row actions and form after_submit are ScreenAction objects, never strings.
- Doc webhook sync buttons reference webhook ids declared in bundle.webhooks.
  Webhooks belong to doc screens; dashboard screens do not host sync triggers.
- role strings in visible_for_roles and RLS must match app user roles. Owner
  bypass exists, but user/admin rules should still be explicit.
- Every write tool previews a plan until user_confirmed=true.
""".strip()


_VALID_PROFILES = {"design", "delivery", "all"}


def _active_profiles() -> set[str]:
    raw = os.getenv("APPBI_MCP_PROFILE", "all").strip().lower()
    active = {part.strip() for part in raw.split(",") if part.strip()} or {"all"}
    unknown = active - _VALID_PROFILES
    if unknown:
        raise RuntimeError(
            f"APPBI_MCP_PROFILE has unknown values {sorted(unknown)}. "
            f"Valid values: {sorted(_VALID_PROFILES)}."
        )
    return active


ACTIVE_PROFILES = _active_profiles()
logger.info("Workboard MCP starting with profiles=%s", sorted(ACTIVE_PROFILES))

mcp = FastMCP("AppBI Workboard Builder", instructions=_MCP_INSTRUCTIONS)


class BackendError(RuntimeError):
    """Backend response that tool wrappers convert to structured output."""

    def __init__(self, method: str, path: str, status_code: int, detail: Any) -> None:
        super().__init__(f"{method} {path} -> {status_code}: {detail}")
        self.method = method.upper()
        self.path = path
        self.status_code = int(status_code)
        self.detail = detail


def _backend_error_envelope(exc: BackendError) -> dict[str, Any]:
    return {
        "status": "backend_error",
        "method": exc.method,
        "path": exc.path,
        "status_code": exc.status_code,
        "detail": exc.detail,
        "claude_should": (
            "Fix request payload or permissions before retrying."
            if 400 <= exc.status_code < 500
            else "Surface the backend error and inspect AppBI logs before retrying."
        ),
    }


def tool(profiles: set[str] | tuple[str, ...] | list[str] | str):
    """Register a tool only when APPBI_MCP_PROFILE exposes its surface."""
    tags = {profiles} if isinstance(profiles, str) else set(profiles)

    def decorator(fn):
        if not ("all" in ACTIVE_PROFILES or tags & ACTIVE_PROFILES):
            return fn

        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            try:
                return await fn(*args, **kwargs)
            except BackendError as exc:
                logger.info(
                    "tool %s backend error %s on %s %s",
                    fn.__name__,
                    exc.status_code,
                    exc.method,
                    exc.path,
                )
                return _backend_error_envelope(exc)

        return mcp.tool()(wrapped)

    return decorator


def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    if not params:
        return None
    cleaned = {
        key: value
        for key, value in params.items()
        if value is not None and str(value).strip() != ""
    }
    return cleaned or None


def _query_path(path: str, params: dict[str, Any] | None) -> str:
    cleaned = _clean_params(params)
    return f"{path}?{urlencode(cleaned)}" if cleaned else path


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | list[Any] | None = None,
    expect_json: bool = True,
    timeout_seconds: float | None = None,
) -> Any:
    """Call the authenticated AppBI API and raise structured backend errors."""
    timeout = float(timeout_seconds or APPBI_TIMEOUT_SECONDS)
    headers = {
        "Authorization": f"Bearer {APPBI_PAT}",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(
        timeout=timeout,
        verify=APPBI_VERIFY_TLS,
        follow_redirects=True,
    ) as client:
        response = await client.request(
            method.upper(),
            f"{APPBI_API_BASE_URL}{path}",
            headers=headers,
            params=_clean_params(params),
            json=json_body,
        )
    if response.status_code >= 400:
        detail: Any = response.text
        try:
            payload = response.json()
            detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
        except ValueError:
            pass
        raise BackendError(method, path, response.status_code, detail)
    if not expect_json or not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _drop_none(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _clamp_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _requires_confirmation(action: str, plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "requires_confirmation",
        "action": action,
        "claude_must_stop_here": True,
        "message": "No changes were made. Show this plan and wait for explicit approval.",
        "plan": plan,
    }


def _confirmation_required_for_destructive(
    action: str, target: dict[str, Any]
) -> dict[str, Any]:
    return _requires_confirmation(
        action,
        {
            "destructive": True,
            "reversible": False,
            "target": target,
        },
    )


@tool({"design", "delivery"})
async def health_check(ctx: Context | None = None) -> dict[str, Any]:
    """Verify the MCP can reach AppBI with the configured PAT."""
    return {
        "status": "ok",
        "appbi_api_base_url": APPBI_API_BASE_URL,
        "user": await _request("GET", "/auth/me"),
    }


__all__ = [
    "ACTIVE_PROFILES",
    "APPBI_API_BASE_URL",
    "APPBI_PAT",
    "APPBI_TIMEOUT_SECONDS",
    "APPBI_VERIFY_TLS",
    "BackendError",
    "Context",
    "_backend_error_envelope",
    "_clamp_int",
    "_confirmation_required_for_destructive",
    "_drop_none",
    "_query_path",
    "_request",
    "_requires_confirmation",
    "logger",
    "mcp",
    "tool",
]
