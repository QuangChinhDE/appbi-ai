"""What a chart data/preview endpoint tells its caller when the chart did not run,
and how much of the run it shows.

ONE place for the three things every chart surface used to decide on its own:

1. A semantic REFUSAL (``SemanticRefusal``: two meanings, a fan-out, an
   unreachable view …) is not a failure of the system — it is the engine
   declining to guess. The caller gets 400, the category in ``X-AppBI-Refusal``
   (unchanged contract) AND a structured ``refusal`` object in the body, so the
   Chart Builder can explain it in business terms instead of re-parsing prose.
   The prose ``detail`` stays exactly what it was (humanised view names).

2. Anything ELSE (driver/connector errors, bugs) is logged in full and answered
   with a generic message plus a reference id. Raw exception text can carry a
   DSN, a host, a project/schema name, credentials echoed by a driver, or the
   SQL — none of which a chart viewer may read.

3. ``debug`` (the emitted SQL with every filter value inlined, routing, dialect)
   is diagnostics for people who may EDIT the chart. A view-only reader gets the
   same safe subset the public link gets: skipped filters and freshness.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

#: debug keys any reader of the chart may see: the skipped-filter badge and
#: data freshness. Everything else (sql_emitted, sql_emitted_per_group, routing,
#: dialect, warnings, execution internals) is editor-only.
SAFE_DEBUG_KEYS = (
    "dropped_filters", "data_source_mode", "snapshot_as_of", "snapshot_stale",
    "snapshot_generation", "snapshot_dataset_id", "result_as_of", "result_cached",
    "row_count", "execution_time_ms",
)

#: permission levels that may read the full diagnostics of a chart.
DIAGNOSTIC_LEVELS = frozenset({"edit", "full"})

GENERIC_FAILURE = (
    "Không tải được dữ liệu biểu đồ do lỗi nguồn dữ liệu hoặc hệ thống. "
    "Thử lại sau; nếu lặp lại, báo quản trị viên kèm mã tham chiếu {ref}."
)


def safe_debug(debug: Any) -> Optional[dict]:
    """The reader-safe subset of a chart ``debug`` payload (None when empty)."""
    if debug is None:
        return None
    get = (lambda k: debug.get(k)) if isinstance(debug, dict) else (lambda k: getattr(debug, k, None))
    out = {k: get(k) for k in SAFE_DEBUG_KEYS}
    out = {k: v for k, v in out.items() if v is not None}
    return out or None


def restrict_debug(result: Any, permission: str) -> Any:
    """``result`` with ``debug`` reduced to the safe subset unless the caller may
    edit the chart. Enforced HERE, server-side — hiding the inspector in the UI
    is not a control."""
    if permission in DIAGNOSTIC_LEVELS:
        return result
    if isinstance(result, dict) and "debug" in result:
        return {**result, "debug": safe_debug(result.get("debug"))}
    return result


def refusal_info(exc: BaseException, humanize) -> Optional[dict]:
    """Structured description of a semantic refusal, or None when ``exc`` is not
    one. ``humanize`` maps internal view tokens to the names the user knows."""
    from app.services.chart_service import refusal_category

    category = refusal_category(exc)
    if not category:
        return None
    info: dict[str, Any] = {"category": category}
    target = getattr(exc, "target", None)
    if isinstance(target, str) and target:
        info["target"] = humanize(target)
    routes = getattr(exc, "routes", None)
    if isinstance(routes, (list, tuple)) and routes:
        info["routes"] = [humanize(str(r)) for r in routes]
    return info


def refusal_response(exc: BaseException, humanize) -> JSONResponse:
    """400 for a ValueError from the chart runtime: the humanised ``detail``
    (unchanged), the category header (unchanged) and, for a refusal, the
    structured ``refusal`` object."""
    from app.services.chart_service import REFUSAL_HEADER

    info = refusal_info(exc, humanize)
    body: dict[str, Any] = {"detail": humanize(str(exc))}
    headers = None
    if info is not None:
        body["refusal"] = info
        headers = {REFUSAL_HEADER: info["category"]}
    return JSONResponse(status_code=400, content=body, headers=headers)


def failure_detail(exc: BaseException, what: str) -> str:
    """Log ``exc`` in full under a fresh reference id and return the generic,
    leak-free message carrying that id."""
    ref = uuid.uuid4().hex[:10]
    logger.error("%s failed [ref=%s]: %s: %s", what, ref, type(exc).__name__, exc, exc_info=exc)
    return GENERIC_FAILURE.format(ref=ref)
