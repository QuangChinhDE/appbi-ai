"""In-process progress for the manual Sync & Publish / Refresh waiting UI.

The background sync thread (start_sync_and_publish / start_manual_refresh) lives
in the API process, and GET /publish-status is served by the same process, so a
module-level dict is shared between them. Single-worker deployment (uvicorn, no
--workers) — if workers are added later this would need the shared-sqlite KV
instead. Best-effort: every function swallows errors and never affects the sync.

Shape per dataset: {
  phase, current, built, total, rows, rows_done_total,
  tables: [{table_id, name, rows_done, rows_total_est, state}],
  trigger, started_at, updated_at,
}
  phase   = 'syncing' | 'validating' | 'publishing' | 'done' | 'failed'
            | 'stopping' | 'stopped'
  current = display name of the table being built now
  built   = tables completed (done + skipped);  total = tables to build
  rows    = rows loaded for the CURRENT table (back-compat scalar)
  rows_done_total = rows across all done tables + the active table's live count
  tables[].rows_total_est = row_count of the PREVIOUS complete snapshot (the
            free "≈ how many rows remain" denominator); None on the first sync.
  tables[].state = 'pending' | 'active' | 'done' | 'skipped'
"""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional

_lock = threading.Lock()
_progress: Dict[int, Dict[str, Any]] = {}


def _recompute(p: Dict[str, Any]) -> None:
    """Derive built + rows_done_total from the per-table list (call under _lock)."""
    tables = p.get("tables") or []
    if not tables:
        return
    done = [t for t in tables if t.get("state") in ("done", "skipped")]
    p["built"] = len(done)
    p["total"] = len(tables)
    total_rows = 0
    for t in tables:
        st = t.get("state")
        if st in ("done", "active"):
            total_rows += int(t.get("rows_done") or 0)
    p["rows_done_total"] = total_rows


def start(dataset_id: int, total: int = 0, trigger: str = "manual") -> None:
    """Initial 'syncing' state before the table set is known (total may be 0)."""
    with _lock:
        _progress[dataset_id] = {
            "phase": "syncing", "current": None, "built": 0, "total": int(total),
            "rows": 0, "rows_done_total": 0, "tables": [],
            "trigger": trigger, "started_at": time.time(), "updated_at": time.time(),
        }


def begin(dataset_id: int, tables: List[Dict[str, Any]], trigger: Optional[str] = None) -> None:
    """Populate the per-table plan once ``refresh_all_for_dataset`` knows what it
    will build. ``tables`` = [{table_id, name, rows_total_est}] (est may be None
    on the first sync). Preserves started_at/trigger if a prior ``start`` ran."""
    with _lock:
        prev = _progress.get(dataset_id) or {}
        plan = [
            {
                "table_id": int(t.get("table_id")) if t.get("table_id") is not None else None,
                "name": t.get("name") or (f"table {t.get('table_id')}" if t.get("table_id") else "—"),
                "rows_done": 0,
                "rows_total_est": (int(t["rows_total_est"]) if t.get("rows_total_est") is not None else None),
                "state": "pending",
            }
            for t in (tables or [])
        ]
        _progress[dataset_id] = {
            "phase": "syncing", "current": None, "built": 0, "total": len(plan),
            "rows": 0, "rows_done_total": 0, "tables": plan,
            "trigger": trigger or prev.get("trigger", "manual"),
            "started_at": prev.get("started_at", time.time()), "updated_at": time.time(),
        }


def begin_table(dataset_id: int, table_id: int) -> None:
    """Mark one table 'active' (the one being built now)."""
    with _lock:
        p = _progress.get(dataset_id)
        if p is None:
            return
        for t in p.get("tables") or []:
            if t.get("table_id") == int(table_id):
                t["state"] = "active"
                t["rows_done"] = 0
                p["current"] = t.get("name")
                break
        p["rows"] = 0
        p["updated_at"] = time.time()
        _recompute(p)


def note_rows(dataset_id: int, table_id: int, n: int) -> None:
    """Live rows loaded so far for the active table (called from the load loop)."""
    with _lock:
        p = _progress.get(dataset_id)
        if p is None:
            return
        p["rows"] = int(n)
        for t in p.get("tables") or []:
            if t.get("table_id") == int(table_id):
                t["rows_done"] = int(n)
                break
        p["updated_at"] = time.time()
        _recompute(p)


def finish_table(dataset_id: int, table_id: int, rows: int = 0, *, skipped: bool = False) -> None:
    """Mark one table done (or skipped) and freeze its final row count."""
    with _lock:
        p = _progress.get(dataset_id)
        if p is None:
            return
        for t in p.get("tables") or []:
            if t.get("table_id") == int(table_id):
                t["state"] = "skipped" if skipped else "done"
                if not skipped:
                    t["rows_done"] = int(rows or 0)
                break
        if p.get("current") and not any(
            t.get("state") == "active" for t in (p.get("tables") or [])
        ):
            p["current"] = None
        p["updated_at"] = time.time()
        _recompute(p)


def note_table(dataset_id: int, current: Optional[str], built: int, total: int) -> None:
    """Back-compat scalar tick (legacy callers). Prefer begin/begin_table/finish_table."""
    with _lock:
        p = _progress.get(dataset_id) or {"started_at": time.time(), "trigger": "manual", "tables": []}
        p.update({"phase": "syncing", "current": current, "built": int(built),
                  "total": int(total), "updated_at": time.time()})
        _progress[dataset_id] = p


def set_phase(dataset_id: int, phase: str) -> None:
    with _lock:
        p = _progress.get(dataset_id)
        if p is not None:
            p["phase"] = phase
            p["updated_at"] = time.time()


def get(dataset_id: int) -> Optional[Dict[str, Any]]:
    with _lock:
        p = _progress.get(dataset_id)
        if not p:
            return None
        # Deep-ish copy so callers can't mutate the live per-table dicts.
        out = dict(p)
        out["tables"] = [dict(t) for t in (p.get("tables") or [])]
        return out


def clear(dataset_id: int) -> None:
    with _lock:
        _progress.pop(dataset_id, None)
