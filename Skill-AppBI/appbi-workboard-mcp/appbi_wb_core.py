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
    # Default to the local backend so the server always imports — the token,
    # not the URL, is the thing a fresh clone is missing. Override in .env.
    base = str(raw or "").strip().rstrip("/") or "http://localhost:8000"
    if base.endswith("/api/v1"):
        return base
    return f"{base}/api/v1"


# How to fix a missing/placeholder PAT — surfaced at the exact moment a tool
# first tries to authenticate, so a fresh clone is never left guessing.
_PAT_HELP = (
    "Get one WITHOUT leaving the MCP: call the bootstrap_personal_access_token "
    "tool with an AppBI email + password. Or run the shipped helper once: "
    "`python bootstrap_pat.py` (writes APPBI_PAT into .env), then restart. "
    "Manual fallback: AppBI UI -> Settings -> Personal Access Tokens."
)


class MissingPATError(RuntimeError):
    """Raised (lazily, on first authenticated call) when no usable PAT is set."""


def _current_pat() -> str:
    """Resolve the PAT fresh from the environment on every authenticated call.

    Reading it lazily (instead of at import) lets the server start with no
    token so the bootstrap_personal_access_token tool can mint one in-session;
    once minted, that tool updates os.environ and this picks it up immediately.
    """
    token = str(os.getenv("APPBI_PAT") or "").strip()
    if not token:
        raise MissingPATError(
            "APPBI_PAT is not set - this is the token the MCP uses to "
            f"authenticate to AppBI. {_PAT_HELP}"
        )
    if "replace_me" in token.lower() or token.lower() in {"your_token_here", "<your-token>"}:
        raise MissingPATError(
            "APPBI_PAT is still a placeholder, not a real token. " + _PAT_HELP
        )
    return token


APPBI_API_BASE_URL = _normalize_api_base_url(os.getenv("APPBI_BASE_URL", ""))
# Raw value at import time, for debugging only — never used to authenticate.
# Requests always call _current_pat() so a freshly bootstrapped token is live.
APPBI_PAT = str(os.getenv("APPBI_PAT") or "").strip()
APPBI_TIMEOUT_SECONDS = float(os.getenv("APPBI_TIMEOUT_SECONDS", "120"))
APPBI_VERIFY_TLS = _env_flag("APPBI_VERIFY_TLS", True)


logging.basicConfig(
    level=os.getenv("APPBI_MCP_LOG_LEVEL", "INFO").upper(),
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("appbi_workboard_mcp")


_MCP_INSTRUCTIONS = """
You are the AppBI Workboard Builder. You take a user from raw data all the way
to a working, shareable mini-app — the full journey, in one tool:

    Source  ->  Dataset  ->  Data Model  ->  Workboard  ->  Share

A production-grade result is one coherent Workboard bundle (layout_json screens
+ app users + doc webhooks + optional public workspace), built on a clean
dataset and a sane relationship model.

## Canonical workflow

STAGE -1 — Connect (only if not connected yet)
   Run health_check. If it returns status "needs_pat" (or any tool returns it),
   the MCP has no Personal Access Token. Call bootstrap_personal_access_token
   with an AppBI email + password (user_confirmed=true after showing the plan).
   It mints the token, connects this session immediately, and saves it to .env.
   A PAT cannot mint itself — this is the one credential the user must provide.

STAGE 0 — Source (only if no dataset exists yet)
   list_data_sources -> reuse a connected source if one fits.
   To inspect: inspect_source_schema / list_gsheet_tabs + read_gsheet_rows.
   To create: get_source_setup_guide(); for Google Sheets run
   check_google_data_access() first, then create_google_sheets_source; for a
   spreadsheet/CSV on disk use create_manual_source_from_file; for pasted data
   use create_manual_source.

STAGE 1 — Dataset
   create_dataset -> add_table_to_dataset for each table you need ->
   get_table_profile(dataset_id, table_id) on every new table (this also
   populates columns_cache, which downstream tools rely on). Add a date table
   via update_dataset settings.calendar_dimension, never add_table_to_dataset.
   Optionally write update_table_description / update_dataset_dictionary.

STAGE 2 — Data Model (relationships)
   generate_dataset_model for a heuristic starter, then refine with
   suggest_dataset_model_join -> add_dataset_model_join. For mini-app lookups
   across tables, suggest_workboard_relationships gives the exact join hints a
   form/table lookup needs. A clean model powers lookups, RLS, and any embedded
   dashboard screen.

STAGE 3 — Workboard
   get_workboard_design_guide() for the full current screen contract. Author
   ONE bundle with only the screens the user asked for. Validate JS computed
   columns up front with test_screen_js. validate_workboard_bundle(bundle) and
   fix every error. apply_workboard_bundle(bundle, user_confirmed=true) creates
   /updates the workboard, publishes, upserts app users, stores webhooks, and
   links a workspace — all in one confirmation.

STAGE 4 — Ship & verify (always finish here — a saved Workboard is not a usable app)
   To make it usable, either put a `workspace` block in the apply bundle (apply
   auto-creates the workspace, adds the Workboard to its menu, and publishes) or
   call deliver_workboard_to_workspace. Create app users with upsert_workboard_
   app_users. For a public form/view use create_workboard_public_link.
   VERIFY WITHOUT A BROWSER: run_workboard_runtime_smoke_test(workspace_token,
   workboard_id, username, pin, screen_ids=[...]) logs in and renders every
   screen over HTTP; pass form_screen_id + table_screen_id + insert_values to
   submit a real row and confirm it lands (inserted_visible). To inspect as staff
   without a PIN, create_workspace_preview_session. Finish with audit_workboard.

## Non-negotiable rules

- YOU HAVE NO BROWSER. You are running inside an MCP client (Claude Desktop /
  Codex / Claude Code). Never try to open the app in a browser, install or run
  Playwright, or hand-write a script to mint a preview session — you cannot, and
  you do not need to. The runtime is an HTTP API that the MCP already drives:
  verify with run_workboard_runtime_smoke_test / create_workspace_preview_session.
- Runtime "Validation failed" on a form? Do NOT guess. Call the smoke test with
  insert_values and read the failing form_insert step's data.detail.violations —
  it lists the exact field(s) that failed.

- Bind every non-dashboard screen's table_id to an ATTACHED dataset table id
  (from inspect_dataset_for_workboard / list_dataset_tables), never a source
  table id.
- Google Sheets source_table_name is the SHEET/TAB name only (e.g.
  "DM_SanPham"), never "<spreadsheet_id>.DM_SanPham".
- Use current screen kinds only: form, table, doc, dashboard. A table screen's
  spec key is `table`, never legacy `list` or `grid`.
- Row actions and form after_submit are ScreenAction objects, never strings.
- Doc data_table sync_triggers reference webhook ids declared in
  bundle.webhooks; webhooks bind to a doc screen_id. Dashboard screens never
  host sync triggers.
- visible_for_roles and RLS roles must match app-user roles (owner/admin/user).
  Owner bypasses RLS, but user/admin rules should still be explicit.
- Pass workboard.slug explicitly when a workspace will deliver the app — the
  backend does not auto-generate one and workspace menus key by slug.
- Every mutating tool previews a plan and makes NO change until
  user_confirmed=true. Show the plan, get approval, then re-call confirmed.
""".strip()


# Stage profiles let a power user shrink the tool surface; the default is
# "all" so a tester needs zero configuration. `discover` is read-only.
_ALL_STAGES = ("discover", "source", "dataset", "model", "build", "deliver")
_VALID_PROFILES = {*_ALL_STAGES, "all"}


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
            except MissingPATError as exc:
                logger.info("tool %s blocked: no PAT configured", fn.__name__)
                return {
                    "status": "needs_pat",
                    "detail": str(exc),
                    "claude_should": (
                        "Call bootstrap_personal_access_token(email, password) to "
                        "mint and install a PAT, then retry this tool."
                    ),
                }
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
        "Authorization": f"Bearer {_current_pat()}",
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


async def _multipart_request(
    method: str,
    path: str,
    *,
    files: dict[str, Any],
    data: dict[str, Any] | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """Call the AppBI API with a multipart/form-data body (file upload).

    `files` maps a field name to either a file-like/bytes payload or an
    httpx tuple (filename, content, content_type). Used by the manual
    file-import source path.
    """
    timeout = float(timeout_seconds or APPBI_TIMEOUT_SECONDS)
    headers = {
        "Authorization": f"Bearer {_current_pat()}",
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
            files=files,
            data=data or None,
        )
    if response.status_code >= 400:
        detail: Any = response.text
        try:
            payload = response.json()
            detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
        except ValueError:
            pass
        raise BackendError(method, path, response.status_code, detail)
    if not response.content:
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


@tool(_ALL_STAGES)
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
    "MissingPATError",
    "ROOT",
    "_ALL_STAGES",
    "_backend_error_envelope",
    "_clamp_int",
    "_confirmation_required_for_destructive",
    "_current_pat",
    "_drop_none",
    "_multipart_request",
    "_query_path",
    "_request",
    "_requires_confirmation",
    "logger",
    "mcp",
    "tool",
]
