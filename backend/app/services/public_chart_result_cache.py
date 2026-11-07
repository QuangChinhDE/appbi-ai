"""Result cache for public dashboard tiles (POST /public/dashboards/{token}/charts/data).

Pilot (52-chart dashboard, 14 tiles per page): with every tile a result-cache HIT the
page still took 2.9-4.2 s, because each tile re-ran the execution planner, the snapshot
resolve and the filter normalisation before the live-query cache was probed. This cache
sits in FRONT of the chart engine: a tile whose exact engine inputs were answered a moment
ago is served without entering it.

Key = the link + every input the engine receives for the tile (the final merged filters,
locks and hidden filters included, tile overrides, grain, snapshot TTL) + `data_epoch`
(moves on any edit of the charts, datasets, snapshots, models, sources) + the dashboard's
updated_at. Same inputs and same epoch -> the same answer, so the cache cannot widen what
a viewer sees. TTL `PUBLIC_CHART_RESULT_TTL_S` (default 60 s) bounds staleness of live
sources. Shared across uvicorn workers through the live-query cache's sqlite store.
Only successful results are kept.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_NS = -7311  # a namespace no datasource id uses (report DTOs use -7310)
_MAX = 512
_local: Dict[str, Tuple[float, Any]] = {}
_guard = threading.Lock()


def ttl_s() -> int:
    try:
        return max(0, int(getattr(settings, "PUBLIC_CHART_RESULT_TTL_S", 60)))
    except (TypeError, ValueError):
        return 60


def scope(db, dash, link_scope: str, chart_ids: List[int]) -> Optional[str]:
    """The part of the key shared by every tile of one request; None = do not cache."""
    if ttl_s() <= 0:
        return None
    try:
        from app.services.report_code.bindings import data_epoch

        return json.dumps(["dash", link_scope, int(dash.id), str(getattr(dash, "updated_at", "")),
                           data_epoch(db, chart_ids)])
    except Exception:  # noqa: BLE001 - no epoch: compute normally, never serve unverified
        logger.debug("public chart cache: epoch failed", exc_info=True)
        return None


def key_of(scope_key: str, item: Dict[str, Any]) -> str:
    inputs = {k: item.get(k) for k in ("chart_id", "extra_filters", "filter_context", "granularity_override",
                                       "snapshot_ttl_minutes", "role_overrides")}
    # Relative presets ("last 30 days") resolve against the request's as-of date (header
    # X-AppBI-As-Of, PDF export) and today: both are part of what the tile answers.
    try:
        from app.services.time_contract import get_report_anchor

        anchor = get_report_anchor()
    except Exception:  # noqa: BLE001
        anchor = None
    from datetime import date

    raw = json.dumps([scope_key, inputs, str(anchor) if anchor else None, date.today().isoformat()],
                     sort_keys=True, default=str)
    return "pubchart:" + hashlib.sha256(raw.encode()).hexdigest()


def _store():
    try:
        from app.services import query_cache

        return query_cache._get_shared_store()
    except Exception:  # noqa: BLE001
        return None


def get(key: str) -> Optional[Any]:
    ttl = ttl_s()
    hit = _local.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    store = _store()
    if store is None:
        return None
    try:
        got = store.get(_NS, key)
    except Exception:  # noqa: BLE001 - a cache read never fails the page
        return None
    if isinstance(got, dict) and "data" in got:
        with _guard:
            _local[key] = (time.time(), got["data"])
        return got["data"]
    return None


def put(key: str, data: Any) -> None:
    ttl = ttl_s()
    if ttl <= 0:
        return
    try:
        payload = data.model_dump(mode="json") if hasattr(data, "model_dump") else data
        json.dumps(payload, default=str)
    except Exception:  # noqa: BLE001 - not serialisable: just do not cache it
        return
    store = _store()
    if store is not None:
        try:
            store.set(_NS, key, {"data": payload}, ttl_seconds=ttl)
        except Exception:  # noqa: BLE001
            pass
    with _guard:
        if len(_local) >= _MAX:
            now = time.time()
            for k in [k for k, (at, _) in _local.items() if now - at >= ttl]:
                _local.pop(k, None)
            while len(_local) >= _MAX:
                _local.pop(next(iter(_local)))
        _local[key] = (time.time(), payload)
