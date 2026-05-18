"""Core infrastructure for the AppBI Orchestrator MCP.

This module owns:
  - the FastMCP instance shared across all stage modules
  - HTTP client (`_request`) targeting the AppBI backend
  - the preview-then-confirm helper (`_requires_confirmation`)
  - environment loading + PAT handling

Design principles:
  - Claude is the only LLM. This MCP must NEVER call any AppBI endpoint that
    triggers backend LLM calls (e.g. /description/regenerate, /quality/ai-suggest).
  - Every write tool exposes a `user_confirmed: bool = False` flag and returns
    a `requires_confirmation` plan when False so the human can review the diff
    before any change lands in AppBI.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import Context, FastMCP


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------


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
        raise RuntimeError("APPBI_BASE_URL is required (e.g. http://localhost:8000)")
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
APPBI_LONG_TIMEOUT_SECONDS = float(os.getenv("APPBI_LONG_TIMEOUT_SECONDS", "300"))
APPBI_VERIFY_TLS = _env_flag("APPBI_VERIFY_TLS", True)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


logging.basicConfig(
    level=os.getenv("APPBI_MCP_LOG_LEVEL", "INFO").upper(),
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("appbi_orchestrator_mcp")


# ---------------------------------------------------------------------------
# FastMCP instance + master instructions
# ---------------------------------------------------------------------------


_MCP_INSTRUCTIONS = """
You are the AppBI Orchestrator. Your job: take a user from a raw data source
to a finished, shareable AppBI dashboard. The single most important thing
about this MCP is that **dashboards must be visible from every entry point
in AppBI** — Dashboard view, Explore, Dataset model, chart list. Charts
that render in the dashboard but disappear from Explore are a recurring
defect; the canonical workflow below is designed to prevent it.

## Canonical workflow (the only correct way for full dashboards)

  Stage 1 — Source         (read-only)
    list_data_sources, inspect_source_schema, inspect_source_table,
    run_source_query

  Stage 2 — Dataset        (lay the table groundwork)
    list_datasets, create_dataset, add_table_to_dataset,
    get_table_profile, update_table_description

  Stage 3 — Semantic       (THIS STAGE IS NON-NEGOTIABLE before any chart)
    propose_semantic_model(dataset_id, business_intent)
        → returns existing model + tables + plan_template
    (Author plan_json. Surface open_questions_for_user.)
    commit_semantic_model(plan_json, user_confirmed=true)
        → writes SemanticView rows whose `measures` are the canonical
          place metrics live. Without this, charts show numbers but the
          measure list in Explore stays empty.

  Stage 4 — Dashboard blueprint (design before execute)
    propose_dashboard_blueprint(dataset_id, business_intent)
        → returns available_measures from Stage 3 + blueprint_template
    (Author blueprint_json: charts whose metric `field` values match
     available_measures. Surface open_questions_for_user.)
    commit_dashboard_blueprint(blueprint_json, user_confirmed=true)
        → validates every metric against the live semantic model, then
          creates charts + dashboard + placements in one go.

  Stage 5 — Optional polish    (after the blueprint shipped)
    add_chart_to_dashboard / add_dashboard_filter / create_public_link
    update_chart_description (Claude-authored prose)

## Mandatory rules

1. **Blueprint is the path. Lone create_chart is the exception.**
   For any user request that resembles "build me a dashboard / report",
   you MUST go through propose_dashboard_blueprint → commit. Do not call
   create_chart in a loop. The blueprint flow forces design review,
   makes measures show up in Explore, and lets the user veto before any
   write happens. `create_chart` standalone is only for ad-hoc edits the
   user explicitly scopes that small ("add this single KPI tile to
   dashboard 7").

2. **No semantic view, no chart.** Every chart's metrics resolve to a
   measure on the SemanticView bound to its dataset_table. `create_chart`
   refuses to write when this fails — do NOT bypass the check by passing
   `bypass_semantic_check=True` unless the user has been told the chart
   will be invisible in Explore and has accepted that.
   Saved-chart limitation: use only measures/dimensions from the chart's
   bound/base view. Do NOT save joined-view fields like
   `other_view.field` even if the semantic explore can conceptually reach
   them, because the final stored chart config is executed as bare column
   names in Explore/runtime.

3. **You are the only LLM.** The backend will not generate descriptions,
   chart suggestions, or quality rules for you. You write the prose, you
   pick the chart types, you design the semantic model. There is no
   `ai_*` or `regenerate_*` escape hatch.

4. **Preview-then-confirm on every write.** Every mutating tool accepts
   `user_confirmed: bool = False`. The first call returns a plan and
   writes nothing. Present the plan in plain language; wait for an
   explicit yes/duyệt before calling again with `user_confirmed=true`.

5. **Profile + log per-chat artifacts.** Call `get_table_profile` once
   per table (~10-15K tokens per 30-col table — never re-call). Use
   `get_column_summary` for one-column drill-downs.

   Persist what you and the DA confirm into a per-chat folder so a
   resumed session can recover without re-profiling:
     a. Call `get_mcp_logs_dir()` once. Inside it, create a session
        folder `chat_<YYYYMMDD_HHMMSS>/` on the first write.
     b. Maintain 3 files using Claude's native Write tool:
        - `dataset.md` — column index (Qualified Key | Display | Type
          | PK/FK | Sample) per table, plus a "Cross-table name
          conflicts" list. Add measures + joins after Stage 3 commits.
        - `charts.md` — one entry per committed chart: title,
          chart_type, dataset_table_id, role_config keys/values.
        - `report.md` — final dashboard id, url, placement list.
     c. On session resume, list the logs folder newest-first and
        confirm with the DA which chat to continue before reusing.
   Reference qualified keys from `dataset.md` when authoring measures,
   joins, and chart role_config — never guess from memory.

6. **Discovery first.** Always start with `list_datasets` and
   `list_data_sources`. Reuse existing datasets and semantic models when
   the user's intent matches; ask the user to choose rather than
   creating a duplicate.

7. **Chart layout.** Omit `layout` and commit_dashboard_blueprint
   stacks full-width (always safe). When specifying (react-grid-layout,
   12 cols × 80px): KPI=3×2, LINE/BAR/AREA/PIE=6×4, TABLE/PIVOT=12×5,
   SCATTER=6×5, COMBO=12×4. Min w≥3, h≥2 (smaller clips axes).

8. **HTML Import (Flow A — alternative to blueprint for visual mockups).**
   When the DA supplies an HTML mockup or wants to author a self-contained
   `.html` file laying out charts visually, use the import-html flow:
   `get_html_dashboard_spec()` → write AppBI Import Plan v1 HTML →
   `analyze_html_import()` → review chart_plans + warnings →
   `build_dashboard_from_html()`. The backend validates every chart plan
   server-side before materialising Dataset + Charts + Dashboard in one
   transaction. Use it when there are ≥4 charts AND a visual layout
   matters, or when source is an uploaded Excel. The blueprint flow
   (`propose_dashboard_blueprint` → `commit_dashboard_blueprint`) remains
   the default for plain JSON-driven builds.

9. **Auditing legacy data.** If the user reports "the dashboard exists
   but Explore looks empty", run `audit_chart_semantic_health` to
   inventory broken charts, then `repair_chart_semantic_binding` per
   chart. Do not rebuild from scratch unless the user asks.

10. **Stay inside these stages.** AI Chat sessions, AI Agent reports,
   Workboards are NOT part of this MCP. If the user asks for them, say
   they are not available here.
""".strip()


_VALID_PROFILES = {"report", "dataset", "explore", "all"}


# Profile tags are kept for power users who want a smaller surface area,
# but the default is "all" so non-technical end users don't have to touch
# env vars to make the MCP work. Token cost is kept down at the
# *per-tool* level — see the slim docstrings on each @tool decorator.


def _active_profiles() -> set[str]:
    raw = os.getenv("APPBI_MCP_PROFILE", "all").strip().lower()
    if not raw:
        return {"all"}
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    unknown = parts - _VALID_PROFILES
    if unknown:
        raise RuntimeError(
            f"APPBI_MCP_PROFILE has unknown values: {sorted(unknown)}. "
            f"Valid: {sorted(_VALID_PROFILES)}."
        )
    return parts or {"all"}


ACTIVE_PROFILES = _active_profiles()
logger_init = logging.getLogger("appbi_orchestrator_mcp")
logger_init.info("MCP starting with profiles=%s", sorted(ACTIVE_PROFILES))


mcp = FastMCP(
    "AppBI Orchestrator",
    instructions=_MCP_INSTRUCTIONS,
)


def tool(profiles: set[str] | tuple[str, ...] | list[str] | str):
    """Register a tool only when its profile tag overlaps the active profile.

    Usage:
        @tool("report")
        @tool({"report", "explore"})

    Tools tagged with a profile not present in APPBI_MCP_PROFILE are skipped
    at import time — they remain importable Python functions but FastMCP never
    sees them, so they do not consume tool-schema tokens in Claude's context.

    Profile `all` (default when env unset) registers everything — equivalent
    to legacy `@mcp.tool()` behavior.
    """
    if isinstance(profiles, str):
        tag_set = {profiles}
    else:
        tag_set = set(profiles)

    def decorator(fn):
        if "all" in ACTIVE_PROFILES or tag_set & ACTIVE_PROFILES:
            return mcp.tool()(fn)
        return fn

    return decorator


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


async def _request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | list[Any] | None = None,
    expect_json: bool = True,
    timeout_seconds: float | None = None,
) -> Any:
    """Call the AppBI backend with the configured PAT.

    Raises RuntimeError on any non-2xx response, with the backend's `detail`
    field surfaced when present so MCP clients see a useful error.
    """
    url = f"{APPBI_API_BASE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {APPBI_PAT}",
        "Accept": "application/json",
    }
    effective_timeout = (
        float(timeout_seconds) if timeout_seconds is not None else APPBI_TIMEOUT_SECONDS
    )

    async with httpx.AsyncClient(
        timeout=effective_timeout,
        verify=APPBI_VERIFY_TLS,
        follow_redirects=True,
    ) as client:
        response = await client.request(
            method,
            url,
            headers=headers,
            params=_clean_params(params),
            json=json_body,
        )

    if response.status_code >= 400:
        detail: Any = response.text
        try:
            payload = response.json()
            detail = payload.get("detail", payload)
        except Exception:
            pass
        raise RuntimeError(
            f"{method} {path} failed ({response.status_code}): {detail}"
        )

    if not expect_json or not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    if not params:
        return None
    cleaned = {
        key: value
        for key, value in params.items()
        if value is not None and str(value).strip() != ""
    }
    return cleaned or None


def _query_path(path: str, params: dict[str, Any]) -> str:
    cleaned = _clean_params(params)
    if not cleaned:
        return path
    return f"{path}?{urlencode(cleaned)}"


# ---------------------------------------------------------------------------
# Preview-then-confirm helpers
# ---------------------------------------------------------------------------


def _requires_confirmation(action: str, plan: dict[str, Any]) -> dict[str, Any]:
    """Return a `requires_confirmation` envelope when a write tool is called
    without `user_confirmed=True`.

    The MCP client (Claude) MUST present `plan` to the human and wait for
    explicit consent before calling the same tool again with
    `user_confirmed=True`.
    """
    return {
        "status": "requires_confirmation",
        "action": action,
        "message": (
            "No changes were made. Present this plan to the user in plain "
            "language and call the tool again with user_confirmed=true only "
            "after explicit consent."
        ),
        "plan": plan,
    }


def _confirmation_required_for_destructive(
    action: str, target: dict[str, Any], reversible: bool = False
) -> dict[str, Any]:
    """Confirmation envelope for delete/destructive operations."""
    plan = {
        "destructive": True,
        "reversible": reversible,
        "target": target,
        "warning": (
            "This action removes data and may cascade to dependent objects."
            if not reversible
            else "This action is reversible but still requires confirmation."
        ),
    }
    return _requires_confirmation(action, plan)


# ---------------------------------------------------------------------------
# Common utilities for tool modules
# ---------------------------------------------------------------------------


def _clamp_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _drop_none(payload: dict[str, Any]) -> dict[str, Any]:
    """Strip None values from a dict — useful when building PUT/PATCH bodies
    so we only send the fields the caller actually set."""
    return {k: v for k, v in payload.items() if v is not None}


# ---------------------------------------------------------------------------
# Health check (registered immediately so the MCP always exposes one tool)
# ---------------------------------------------------------------------------


@tool({"report", "dataset", "explore"})
async def health_check(ctx: Context | None = None) -> dict[str, Any]:
    """Verify MCP can reach AppBI and the configured PAT is valid.

    Returns the authenticated user info on success. Use this first when
    troubleshooting.
    """
    me = await _request("GET", "/auth/me")
    return {
        "status": "ok",
        "appbi_base_url": APPBI_API_BASE_URL,
        "user": me,
    }


@tool({"report", "dataset", "explore"})
async def get_mcp_logs_dir(ctx: Context | None = None) -> dict[str, Any]:
    """Return the absolute path to the MCP session-log folder.

    Lives next to the MCP install (machine-stable across DA machines).
    Use Claude's native Write/Read on subpaths like
    {logs_dir}/chat_<YYYYMMDD_HHMMSS>/dataset.md to persist what was
    confirmed with the user in this conversation.
    """
    logs = Path(__file__).resolve().parent / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    return {"logs_dir": str(logs)}


# Re-export for stage modules to import.
__all__ = [
    "mcp",
    "tool",
    "ACTIVE_PROFILES",
    "Context",
    "logger",
    "_request",
    "_query_path",
    "_requires_confirmation",
    "_confirmation_required_for_destructive",
    "_clamp_int",
    "_coerce_bool",
    "_drop_none",
    "APPBI_API_BASE_URL",
    "APPBI_LONG_TIMEOUT_SECONDS",
]
