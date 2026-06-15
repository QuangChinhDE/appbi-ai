"""In-memory presence tracking for the dashboard Build editor.

Two people editing the same dashboard should SEE each other (so they don't
unknowingly overwrite one another). This module keeps a lightweight, in-process
registry of "who is currently editing dashboard X", refreshed by a heartbeat
from the FE every ~20s and expired by TTL.

Why in-memory (not a DB table):
  * The backend runs a SINGLE uvicorn worker (see entrypoint.sh — no --workers),
    so a module-level dict is shared by every request; there is no cross-worker
    split-brain to worry about.
  * Presence is best-effort, ephemeral state — persisting it (and writing a row
    every 20s per editor) would be wasteful and needs no durability.
  * Zero migration / zero prod DB-write churn.

If the process restarts, editors simply re-register on their next heartbeat.
"""
from __future__ import annotations

import threading
import time
from typing import Dict, List

# dashboard_id -> { user_key -> {"name", "email", "last_seen"} }
_PRESENCE: Dict[int, Dict[str, dict]] = {}
_LOCK = threading.Lock()

# An editor is "active" if seen within this window. The FE heartbeats every
# ~20s, so 50s tolerates one missed beat before dropping them.
TTL_SECONDS = 50.0


def _prune_locked(now: float) -> None:
    """Drop expired editors (and empty dashboards). Caller must hold _LOCK."""
    for dash_id in list(_PRESENCE.keys()):
        editors = _PRESENCE[dash_id]
        for key in list(editors.keys()):
            if now - editors[key]["last_seen"] > TTL_SECONDS:
                del editors[key]
        if not editors:
            del _PRESENCE[dash_id]


def heartbeat(
    dashboard_id: int,
    user_key: str,
    name: str,
    email: str,
    editing_chart_id: int | None = None,
) -> List[dict]:
    """Register/refresh the current editor and return the OTHER active editors.

    `editing_chart_id` is the dashboard_chart the user is currently focused on
    (their "cursor"), so the FE can highlight where each collaborator is — like
    Google Sheets. Returns {"name","email","seconds_ago","editing_chart_id",
    "user_key"} for everyone editing this dashboard except `user_key`.
    """
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        editors = _PRESENCE.setdefault(dashboard_id, {})
        editors[user_key] = {
            "name": name,
            "email": email,
            "last_seen": now,
            "editing_chart_id": editing_chart_id,
        }
        others = [
            {
                "user_key": k,
                "name": v["name"],
                "email": v["email"],
                "seconds_ago": round(now - v["last_seen"], 1),
                "editing_chart_id": v.get("editing_chart_id"),
            }
            for k, v in editors.items()
            if k != user_key
        ]
    return others


def leave(dashboard_id: int, user_key: str) -> None:
    """Best-effort removal when an editor closes/leaves the Build page."""
    with _LOCK:
        editors = _PRESENCE.get(dashboard_id)
        if editors and user_key in editors:
            del editors[user_key]
            if not editors:
                _PRESENCE.pop(dashboard_id, None)
