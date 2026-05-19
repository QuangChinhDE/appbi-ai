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

import datetime as _dt
import logging
import os
import sys
import threading
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
You are the AppBI Orchestrator: raw data source → shareable AppBI dashboard.
Dashboards MUST be visible from every entry point (Dashboard, Explore,
Dataset model, chart list). Charts that render but vanish from Explore is
a recurring defect — the workflow below is designed to prevent it.

## Canonical workflow — 2 confirmations, design once

  Pre-Phase 1 (read-only): list_data_sources, inspect_source_schema/table,
    list_datasets, get_dataset, get_table_profile (once per table).

  Confirm 1 — commit_dataset_workspace(plan, user_confirmed=true)
    plan = dataset (or existing_dataset_id) + tables + semantic (full
    views/measures/joins) + relationships + planned_charts + dashboard_meta.
    Atomic: writes dataset + tables + semantic, LOGS planned_charts to
    logs/dataset_<id>/charts_design.json. Charts NOT created yet.

  Confirm 2 — build_dashboard_from_design(user_confirmed=true)
    Reads the design log, materialises charts + dashboard. First call
    (user_confirmed=false) writes an HTML preview the DA opens to verify
    layout before the second call commits.

  Polish: add_dashboard_filter / create_public_link / update_chart_description.

For ad-hoc edits on existing artifacts use the granular tools (create_chart,
add_*_chart library, commit_semantic_model, etc.) — do NOT re-design.

## Mandatory rules

1. **Workflow.** "Build a dashboard" → 2-confirm flow above. `create_chart`
   and `add_*_chart` library are for incremental edits ("add this KPI to
   dashboard 7"), not loops in a fresh build.

2. **Semantic-bound charts.** Every metric must resolve to a measure on
   the chart's bound SemanticView. dry-run-create blocks ad-hoc metrics;
   don't pass `bypass_semantic_check=True` unless the user accepts the
   chart will be invisible in Explore.
   Saved chart configs run as bare column names at render time — avoid
   joined-view refs (`other_view.field`) on the stored chart even if the
   explore can reach them.

3. **Claude is the only LLM.** No backend `ai_*` / `regenerate_*` calls.
   You write descriptions, pick chart types, design semantic models.

4. **Preview-then-confirm on every write.** Mutating tools default to
   `user_confirmed=false` and return a plan. Show the plan, wait for an
   explicit "OK / duyệt", then re-call with `user_confirmed=true`.

5. **Logs.** Successful commits auto-log to
   `<MCP_DIR>/logs/dataset_<id>/{dataset,charts,report}.md`. Call
   `get_mcp_logs_dir()` to find the path. Profiling: `get_table_profile`
   once per table (~10-15K tokens for 30 cols — never re-call); use
   `get_column_summary` for drill-downs.

6. **Discovery first.** Start with `list_datasets` + `list_data_sources`;
   reuse existing artifacts when intent matches. Layout: omit and the
   commit stacks full-width safely (see get_design_recommendations for
   specific sizes).

7. **Audit legacy.** If "dashboard exists, Explore empty" — run
   `audit_chart_semantic_health` then `repair_chart_semantic_binding`.

8. AI Chat, AI Agent reports, Workboards are NOT in this MCP — say so.
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
    import functools

    if isinstance(profiles, str):
        tag_set = {profiles}
    else:
        tag_set = set(profiles)

    def decorator(fn):
        if not ("all" in ACTIVE_PROFILES or tag_set & ACTIVE_PROFILES):
            return fn

        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            # Any BackendError that escapes the tool body becomes a
            # structured envelope Claude can branch on per status_code.
            # Tools that catch RuntimeError internally for retry/fallback
            # still work — BackendError is a RuntimeError subclass, and
            # this wrapper only catches what was NOT handled below.
            try:
                return await fn(*args, **kwargs)
            except BackendError as exc:
                logger.info(
                    "tool %s -> backend_error %s on %s %s",
                    fn.__name__, exc.status_code, exc.method, exc.path,
                )
                return _backend_error_envelope(exc)

        return mcp.tool()(wrapped)

    return decorator


# ---------------------------------------------------------------------------
# Session log — auto-appended after every successful commit/mutation.
#
# Keyed by `dataset_id`, NOT by MCP process boot timestamp. Before this
# refactor (Phase 15.40) every MCP restart spawned a fresh `chat_<ts>/`
# folder, so the Phase 1 commit and Phase 2 commit of the same flow
# could land in different folders if Claude Desktop reloaded between
# them. Per-dataset folders are stable across process restarts and
# across multiple conversations on the same dataset — `dataset.md` /
# `charts.md` / `report.md` accumulate as a real history.
# ---------------------------------------------------------------------------


_SESSION_LOG_FILES = {"dataset": "dataset.md", "charts": "charts.md", "report": "report.md"}
_LEGACY_PROCESS_BOOT_DIR: Path | None = None
_LEGACY_LOCK = threading.Lock()


def _session_log_dir(dataset_id: int | None = None) -> Path:
    """Return (and create) the log folder for a given dataset.

    - dataset_id is int  → logs/dataset_<id>/
    - dataset_id is None → logs/_unbound/<MCP_BOOT_TS>/  (last-resort
      bucket for orphan writes; surfaces in the response as a warning
      so the caller knows to pass dataset_id next time)
    """
    logs_root = Path(__file__).resolve().parent / "logs"
    logs_root.mkdir(parents=True, exist_ok=True)
    if dataset_id is not None:
        folder = logs_root / f"dataset_{int(dataset_id)}"
        folder.mkdir(parents=True, exist_ok=True)
        return folder
    # Orphan bucket: per-process so unbound writes from different MCP
    # boots don't all pile into one folder, but still survive a restart
    # within the same process.
    global _LEGACY_PROCESS_BOOT_DIR
    if _LEGACY_PROCESS_BOOT_DIR is not None:
        return _LEGACY_PROCESS_BOOT_DIR
    with _LEGACY_LOCK:
        if _LEGACY_PROCESS_BOOT_DIR is None:
            stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            _LEGACY_PROCESS_BOOT_DIR = logs_root / "_unbound" / f"chat_{stamp}"
            _LEGACY_PROCESS_BOOT_DIR.mkdir(parents=True, exist_ok=True)
            logger.warning(
                "session log: dataset_id was not provided — falling back "
                "to %s. Pass dataset_id to the log call so writes route "
                "to the dataset's own folder.",
                _LEGACY_PROCESS_BOOT_DIR,
            )
    return _LEGACY_PROCESS_BOOT_DIR


def _extract_dataset_id(payload: dict[str, Any] | None) -> int | None:
    """Best-effort dataset_id extraction from a log payload."""
    if not isinstance(payload, dict):
        return None
    for key in ("dataset_id", "datasetId"):
        value = payload.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return None


def _append_session_log(
    stage: str,
    action: str,
    payload: dict[str, Any],
    *,
    dataset_id: int | None = None,
) -> str | None:
    """Append a Markdown entry to the appropriate stage log file.

    Routing rule:
      stage="dataset" → dataset.md in logs/dataset_<id>/
      stage="charts"  → charts.md  in logs/dataset_<id>/
      stage="report"  → report.md  in logs/dataset_<id>/

    If `dataset_id` is missing, the function tries to read it from
    `payload["dataset_id"]`. If still missing, writes to the orphan
    `_unbound/chat_<ts>/` bucket and logs a warning.

    Each entry header carries a `dataset_id=…` line so the three files
    stay cross-referenceable: a chart entry points at its dataset,
    a report entry points at the charts it placed.

    Returns the absolute path of the file written, or None on failure.
    Never raises — log failures are swallowed so they cannot break a commit.
    """
    file_name = _SESSION_LOG_FILES.get(stage)
    if file_name is None:
        return None
    try:
        ds_id = dataset_id if dataset_id is not None else _extract_dataset_id(payload)
        path = _session_log_dir(ds_id) / file_name
        ts = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        lines = [f"\n## {ts} — {action}\n"]
        if ds_id is not None:
            lines.append(f"- **dataset_id**: {ds_id}")
        for key, value in (payload or {}).items():
            # dataset_id already surfaced in the header line above —
            # avoid duplicating it in the body.
            if key in ("dataset_id", "datasetId"):
                continue
            if value is None or value == [] or value == {}:
                continue
            if isinstance(value, (list, tuple)):
                lines.append(f"- **{key}** ({len(value)}):")
                for item in value[:25]:
                    lines.append(f"  - {item}")
                if len(value) > 25:
                    lines.append(f"  - … ({len(value) - 25} more)")
            elif isinstance(value, dict):
                lines.append(f"- **{key}**: {value}")
            else:
                lines.append(f"- **{key}**: {value}")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fp:
            fp.write("\n".join(lines) + "\n")
        return str(path)
    except Exception as exc:  # noqa: BLE001 — log MUST NOT break the commit
        logger.warning("session log append failed (%s/%s): %s", stage, action, exc)
        return None


def _render_dashboard_html_preview(
    dashboard_meta: dict[str, Any],
    planned_charts: list[dict[str, Any]],
) -> str:
    """Render a static HTML mockup of a planned dashboard.

    NO real chart data — just layout boxes + chart specs (title, type,
    role config). Lets the DA visually verify the design in a browser
    BEFORE committing charts to AppBI.

    Layout: react-grid-layout style 12-col grid mapped to CSS grid. Each
    chart cell shows title + type badge + the role_config keys it uses.
    """
    name = str(dashboard_meta.get("name") or "Dashboard").strip()
    description = str(dashboard_meta.get("description") or "").strip()

    def _esc(s: Any) -> str:
        return (
            str(s)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    cells: list[str] = []
    for idx, chart in enumerate(planned_charts):
        layout = chart.get("layout") or {}
        x = max(0, min(11, int(layout.get("x", 0))))
        y = max(0, int(layout.get("y", idx * 4)))
        w = max(1, min(12, int(layout.get("w", 6))))
        h = max(1, int(layout.get("h", 4)))
        chart_type = _esc(chart.get("chart_type") or "?")
        title = _esc(chart.get("title") or f"Chart {idx + 1}")
        role = chart.get("role_config") or {}
        role_lines: list[str] = []
        for key in ("dimension", "timeField", "breakdown", "scatterX",
                     "scatterY", "tableRowDimension", "tableColumnDimension"):
            val = role.get(key)
            if val:
                role_lines.append(f"<b>{_esc(key)}:</b> {_esc(val)}")
        metrics = role.get("metrics") or []
        if metrics:
            metric_strs = [
                f"{_esc(m.get('agg', '?'))}({_esc(m.get('field', '?'))})"
                for m in metrics if isinstance(m, dict)
            ]
            role_lines.append("<b>metrics:</b> " + " · ".join(metric_strs))
        for single_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
            sm = role.get(single_key)
            if isinstance(sm, dict) and sm.get("field"):
                role_lines.append(
                    f"<b>{_esc(single_key)}:</b> "
                    f"{_esc(sm.get('agg', '?'))}({_esc(sm.get('field'))})"
                )
        selected = role.get("selectedColumns") or []
        if selected:
            role_lines.append(
                f"<b>selectedColumns:</b> {_esc(', '.join(map(str, selected[:6])))}"
            )
        # CSS grid is 1-indexed; react-grid-layout x is 0-indexed.
        style = (
            f"grid-column: {x + 1} / span {w};"
            f"grid-row: {y + 1} / span {h};"
        )
        cells.append(
            f'<div class="chart" style="{style}">'
            f'<div class="title">{title}</div>'
            f'<div class="type">{chart_type}</div>'
            f'<div class="role">{"<br>".join(role_lines) or "<i>no config</i>"}</div>'
            f"</div>"
        )

    return f"""<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8">
<title>{_esc(name)} — preview</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 24px; background: #f3f4f6; color: #111; }}
  h1 {{ margin: 0 0 4px 0; font-size: 22px; }}
  .desc {{ color: #555; margin-bottom: 16px; }}
  .meta {{ color: #888; font-size: 12px; margin-bottom: 16px; }}
  .grid {{
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    grid-auto-rows: 80px;
    gap: 12px;
  }}
  .chart {{
    background: #fff;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    padding: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }}
  .title {{ font-weight: 600; font-size: 13px; margin-bottom: 4px; }}
  .type {{
    display: inline-block; align-self: flex-start;
    background: #6366f1; color: #fff;
    padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 700; letter-spacing: .5px;
    margin-bottom: 6px;
  }}
  .role {{ font-size: 11px; color: #374151; line-height: 1.5; }}
</style></head><body>
<h1>{_esc(name)}</h1>
<div class="desc">{_esc(description)}</div>
<div class="meta">Preview rendered from logged design — {len(planned_charts)} charts. Real data is NOT included; this is a layout + spec mockup.</div>
<div class="grid">
{chr(10).join(cells)}
</div></body></html>
"""


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


class BackendError(RuntimeError):
    """Structured backend-error exception.

    Subclasses RuntimeError so existing `except RuntimeError` blocks in
    stage modules (rollback paths, optional reads, fallback chains) keep
    working unchanged. The @tool decorator catches BackendError specifically
    and converts it to a structured envelope Claude can branch on per
    status code.
    """

    def __init__(
        self,
        method: str,
        path: str,
        status_code: int,
        detail: Any,
    ) -> None:
        self.method = method
        self.path = path
        self.status_code = int(status_code)
        self.detail = detail
        super().__init__(f"{method} {path} failed ({status_code}): {detail}")


def _action_hint_for_status(code: int) -> str:
    """Per-status guidance shown back to Claude in the error envelope."""
    if code in (401, 403):
        return (
            "Auth failed. Check APPBI_PAT env on the MCP host. Do NOT retry "
            "until the user verifies / refreshes the token — repeated 401s "
            "can lock the token."
        )
    if code == 404:
        return (
            "Resource not found. The id you passed likely doesn't exist (or "
            "you don't have access). Call the corresponding list_* tool to "
            "find the correct id, then retry."
        )
    if code == 409:
        return (
            "Conflict / cascade guard fired. Read `detail` for the list of "
            "affected charts/measures. Either revise the plan or, if the "
            "user explicitly accepts the breakage, retry with force=true."
        )
    if code == 422:
        return (
            "Pydantic validation rejected the payload. `detail` lists the "
            "offending fields. Fix the shape and retry — do NOT call other "
            "tools or invent new fields."
        )
    if code == 400:
        return (
            "Backend rejected the input. Read `detail` for what's wrong, "
            "fix the offending field, and retry. Do NOT retry blindly with "
            "the same payload — you'll get the same error."
        )
    if code in (502, 503, 504):
        return (
            "Backend temporarily unavailable (gateway / overload). MCP "
            "already auto-retried once. If you see this envelope, the "
            "second attempt also failed — surface to the user and stop."
        )
    if 500 <= code < 600:
        return (
            "Backend crashed with an internal error. This is NOT an MCP / "
            "Claude problem. Surface the message to the user and ask them "
            "to check the AppBI BE logs. Do NOT retry without operator "
            "input. If `detail` is empty, the BE crashed silently — "
            "engineering should investigate the trace on the server."
        )
    return f"Unexpected status {code} — surface `detail` to the user."


def _backend_error_envelope(exc: BackendError) -> dict[str, Any]:
    """Structured response Claude receives instead of an opaque exception.

    Lives in the @tool decorator wrapper — see `tool(...)` below.
    """
    return {
        "status": "backend_error",
        "method": exc.method,
        "path": exc.path,
        "status_code": exc.status_code,
        "detail": exc.detail,
        "claude_should": _action_hint_for_status(exc.status_code),
    }


# Status codes worth auto-retrying once before raising — transient
# infra blips (gateway, overload, slow upstream). Genuine 4xx and 500
# are deterministic responses; retrying them is noise.
_TRANSIENT_STATUS = {502, 503, 504}


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

    Raises `BackendError` (subclass of RuntimeError) on any non-2xx
    response, with method/path/status_code/detail attached as fields so
    the @tool decorator can build a structured envelope for Claude.

    Auto-retries ONCE on transient statuses (502/503/504) and on
    network timeouts (httpx.TimeoutException) — deterministic 4xx/500
    are not retried.
    """
    import asyncio  # local to avoid widening top-level imports

    url = f"{APPBI_API_BASE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {APPBI_PAT}",
        "Accept": "application/json",
    }
    effective_timeout = (
        float(timeout_seconds) if timeout_seconds is not None else APPBI_TIMEOUT_SECONDS
    )

    async def _attempt() -> "httpx.Response":
        async with httpx.AsyncClient(
            timeout=effective_timeout,
            verify=APPBI_VERIFY_TLS,
            follow_redirects=True,
        ) as client:
            return await client.request(
                method,
                url,
                headers=headers,
                params=_clean_params(params),
                json=json_body,
            )

    try:
        response = await _attempt()
        if response.status_code in _TRANSIENT_STATUS:
            await asyncio.sleep(1.0)
            response = await _attempt()
    except httpx.TimeoutException as exc:
        logger.warning("Timeout on %s %s, retrying once: %s", method, path, exc)
        try:
            response = await _attempt()
        except httpx.TimeoutException as exc2:
            raise BackendError(method, path, 504, f"Timeout after retry: {exc2}") from exc2

    if response.status_code >= 400:
        detail: Any = response.text
        try:
            payload = response.json()
            detail = payload.get("detail", payload) if isinstance(payload, dict) else payload
        except Exception:
            pass
        raise BackendError(method, path, response.status_code, detail)

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
        "claude_must_stop_here": True,
        "instruction_for_claude": (
            f"HARD STOP. Show the `plan` object above to the user verbatim "
            f"(or summarise faithfully in Vietnamese). Wait for an EXPLICIT "
            f"'OK / duyệt / yes / ok đi' before re-calling `{action}` with "
            f"`user_confirmed=true`. Do NOT call other tools, do NOT make "
            f"assumptions on the user's behalf. If the user wants changes, "
            f"revise the plan and request confirmation again."
        ),
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


_DESIGN_CHEATSHEET = """
# Pattern → tool routing

## Multi-table chart capability — read first

Charts in this MCP are NOT bound to a single table. A chart is anchored
to one `dataset_table_id` for query routing, but its `dimension` /
`metric_field` / `breakdown` / etc. CAN reference fields on OTHER views
of the same dataset (qualified `other_view.field`) as long as a
RELATIONSHIP exists between those views in the dataset model.

Recipe:
1. `suggest_dataset_model_join(dataset_id, from_view_id, to_view_id,
   from_column, to_column)` — read-only, returns the recommended
   relationship type + warnings.
2. `add_dataset_model_join(...)` — write the relationship. OR include
   the relationship in `commit_dataset_workspace.plan.relationships`
   so it ships with Confirm 1.
3. Use qualified refs in chart roles, e.g.
   `add_bar_chart(dataset_table_id=<deals.id>, dimension="owner.name",
                  metrics=[{field:"deals.revenue", agg:"sum"}], ...)`.
   Engine auto-joins deals ↔ owner via the relationship.

Without a relationship, cross-view refs return empty / error.

## Source discovery — pick by `get_data_source(id).type`
| Source type | List tables/tabs | Inspect one |
|---|---|---|
| BigQuery / Postgres / MySQL / Snowflake / DuckDB / SQL Server | `inspect_source_schema(id)` | `inspect_source_table(id, schema, table)` |
| Google Sheets | `list_gsheet_tabs(id)` | `read_gsheet_rows(id, sheet_name, limit=20)` |

Call `get_data_source(data_source_id)` first to read the `type` field,
then pick the right discovery pair. Mixing them (calling
`inspect_source_schema` on a Google Sheets datasource) returns empty or
errors.

## Measure tools (appbi_measure_library) — 3-tier design hierarchy

**Tier 1** — Standard pattern, typed params (default for 90% of cases):

| User intent | Tool |
|---|---|
| "tổng X", total / sum | `add_sum_measure` |
| "trung bình X", average | `add_avg_measure` |
| "đếm dòng", count rows | `add_count_measure` |
| "đếm duy nhất", # unique values | `add_count_distinct_measure` |
| "nhỏ nhất / lớn nhất" | `add_min_max_measure` (kind='min' or 'max') |
| "tỷ lệ A/B", A per B | `add_ratio_measure` (both A and B must be existing measures) |
| "% trên tổng" | `add_percent_of_total_measure` |

**Tier 2** — Standard pattern + advanced field (escape hatch on the same tool):
Pass `extra={...}` to any Tier-1 tool to add a BE-recognized advanced
field without giving up the typed-param surface. Whitelisted keys:
  • `where_sql`       — raw WHERE fragment (reserve for predicates
                        the structured `filters` list can't express).
  • `description`     — business prose, separate from `label`.
  • `hidden`          — bool; measure exists but hidden from pickers.
  • `context_modifiers` (Phase-14) — list of {type, ...}:
      type="all"           → "% of grand total" via OVER ().
      type="all_except"    → "% of region total" with keep_fields=[...].
      type="use_relationship" → pick a specific JOIN alias.
  • `scope`           — "view" (default) | "dataset" (Phase-12
                        cross-table measure).
  • `source_columns`  — [{view, field}, …], REQUIRED with scope="dataset".

Example: add_sum_measure(..., extra={"where_sql": "status != 'cancelled'",
                                       "hidden": True})

**Tier 3** — Non-standard shape, raw passthrough:
For shapes that don't fit ANY Tier-1 tool — custom `expression` (e.g.
weighted average, window function), multiple context_modifiers
combined, custom `format.pattern`, or any BE field not in the Tier-2
whitelist — use `add_advanced_measure(view_id, measure_spec={...})`
with the full MeasureDefinition shape.

## Chart tools (appbi_chart_library) — pick by intent
| User intent / shape | Tool |
|---|---|
| "1 con số", KPI tile | `add_kpi_chart` |
| "1 con số vs target trên dial" | `add_gauge_chart` |
| "1 con số vs target dạng bar" | `add_bullet_chart` |
| Top-N ranking (1st/2nd/3rd) | `add_podium_chart` |
| "so sánh nhóm" (vertical bars) | `add_bar_chart` |
| Label dài → horizontal bars | `add_horizontal_bar_chart` |
| "nhóm con cạnh nhau" (clustered) | `add_grouped_bar_chart` |
| "tỷ trọng từng nhóm con stacked" | `add_stacked_bar_chart` |
| "doanh thu + %tăng trưởng" (combo) | `add_bar_line_chart` |
| "đóng góp dương/âm vào tổng" | `add_waterfall_chart` |
| "xu hướng theo thời gian" (line) | `add_line_chart` (set `time_grain`) |
| Line nhưng tô màu nền | `add_area_chart` |
| Time-series explicit timeField | `add_time_series_chart` |
| Ranked time series | `add_ribbon_chart` |
| Sự kiện theo thời gian, mỗi loại 1 row | `add_timeline_chart` |
| "tỷ trọng từng phần" (≤6 slices) | `add_pie_chart` |
| Pie có lỗ ở giữa | `add_donut_chart` |
| Pie với slice radii khác nhau | `add_polar_area_chart` |
| Hình chữ nhật lồng nhau theo size | `add_treemap_chart` |
| Phễu chuyển đổi (lead → close) | `add_funnel_chart` |
| Mây từ khoá theo size | `add_word_cloud_chart` |
| Lưới màu (row × col) | `add_heatmap_chart` |
| "luồng A → B" | `add_sankey_chart` |
| Vòng cây phân cấp 2 mức | `add_sunburst_chart` |
| "tương quan 2 chỉ số" | `add_scatter_chart` |
| Scatter + size cho chỉ số 3 | `add_bubble_chart` |
| Spider chart đa chiều | `add_radar_chart` |
| Phân phối theo quartile / outlier | `add_boxplot_chart` |
| Bản đồ điểm (long/lat) | `add_map_point_chart` |
| Bản đồ vùng (choropleth) | `add_map_region_chart` |
| Bảng cột thường | `add_table_chart` |
| Bảng pivot (row × col → giá trị) | `add_pivot_table_chart` |

## Workflow note
For a NEW dashboard, prefer the 2-confirm flow:
1. `propose_dataset_workspace` → author full plan including `planned_charts`
2. `commit_dataset_workspace` (CONFIRM 1) → atomic write of data + semantic + design log
3. `build_dashboard_from_design` (CONFIRM 2) → atomic write of charts + dashboard

The individual `add_*` tools above are for INCREMENTAL edits to an
existing dashboard, or for ad-hoc charts outside a structured build.
""".strip()


@tool({"report", "dataset", "explore"})
async def get_design_recommendations(ctx: Context | None = None) -> dict[str, Any]:
    """Return the measure / chart pattern → tool routing cheatsheet.

    Call this when starting a design session, or whenever unsure which
    add_* tool fits the user's described intent. Output is a single
    Markdown table mapping common Vietnamese / English phrasings to the
    exact tool name in the library.
    """
    return {"cheatsheet": _DESIGN_CHEATSHEET}


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
    "_append_session_log",
    "_session_log_dir",
    "_render_dashboard_html_preview",
    "BackendError",
    "_backend_error_envelope",
    "APPBI_API_BASE_URL",
    "APPBI_LONG_TIMEOUT_SECONDS",
]
