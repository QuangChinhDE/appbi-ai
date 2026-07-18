"""In-process progress for the manual Sync & Publish waiting UI.

The background sync thread (start_sync_and_publish) lives in the API process, and
GET /publish-status is served by the same process, so a module-level dict is
shared between them. Single-worker deployment (uvicorn, no --workers) — if workers
are added later this would need the shared-sqlite KV instead. Best-effort: every
function swallows errors and never affects the sync itself.

Shape per dataset: {phase, current, built, total, rows, trigger, started_at, updated_at}
  phase   = 'syncing' | 'validating' | 'publishing' | 'done' | 'failed'
  current = display name of the table being built now
  built   = tables completed;  total = tables to build
  rows    = rows loaded for the current table (for big tables)
"""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional

_lock = threading.Lock()
_progress: Dict[int, Dict[str, Any]] = {}


def start(dataset_id: int, total: int, trigger: str = "manual") -> None:
    with _lock:
        _progress[dataset_id] = {
            "phase": "syncing", "current": None, "built": 0, "total": int(total),
            "rows": 0, "trigger": trigger, "started_at": time.time(), "updated_at": time.time(),
        }


def note_table(dataset_id: int, current: Optional[str], built: int, total: int) -> None:
    with _lock:
        p = _progress.get(dataset_id) or {"started_at": time.time(), "trigger": "manual"}
        p.update({"phase": "syncing", "current": current, "built": int(built),
                  "total": int(total), "rows": 0, "updated_at": time.time()})
        _progress[dataset_id] = p


def note_rows(dataset_id: int, table_id: int, n: int) -> None:
    with _lock:
        p = _progress.get(dataset_id)
        if p is not None:
            p["rows"] = int(n)
            p["updated_at"] = time.time()


def set_phase(dataset_id: int, phase: str) -> None:
    with _lock:
        p = _progress.get(dataset_id)
        if p is not None:
            p["phase"] = phase
            p["updated_at"] = time.time()


def get(dataset_id: int) -> Optional[Dict[str, Any]]:
    with _lock:
        p = _progress.get(dataset_id)
        return dict(p) if p else None


def clear(dataset_id: int) -> None:
    with _lock:
        _progress.pop(dataset_id, None)
