"""In-memory editor presence + soft edit-LOCK for the Workboard builder.

This mirrors ``services/dashboard_presence`` but adapts the model to how a
mini-app is actually built. Two differences from the dashboard version:

1. **The concurrency unit is a SCREEN, not a tile.** A dashboard is a flat grid
   of independent tiles, so two people naturally work on different tiles of the
   same board. A workboard screen, by contrast, is a tightly-coupled object
   (fields ↔ column refs ↔ RLS ↔ validations ↔ actions), so two people editing
   the SAME screen at once is genuinely dangerous. Each editor therefore reports
   the ``editing_screen_id`` they currently have open (their "cursor").

2. **Soft edit-lock (not just a warning).** At most ONE editor "holds" a given
   screen at a time; everyone else who opens that screen is view-only until they
   explicitly take over or the holder leaves. This is the behaviour the product
   asked for ("người khác đang sửa → chỉ được xem"). It is a *soft* lock: a
   holder that goes stale (closes the tab, navigates away, or misses its TTL)
   releases automatically, and any editor can force a takeover — so a colleague
   who walks away never freezes a screen. The backend optimistic-version 409
   guard on PATCH remains the hard correctness net underneath this UX layer.

Why in-memory (no DB table / no migration):
  * The backend runs a SINGLE uvicorn worker (see entrypoint.sh — no --workers),
    so a module-level dict is shared by every request; no cross-worker split.
  * Presence + soft-lock are ephemeral, best-effort state — persisting them (and
    writing a row every ~20s per editor) would be wasteful and needs no
    durability. On process restart, editors simply re-register + re-claim.

Lock validity rule: a lock on screen X is only honoured while its holder is
still present (within TTL) AND still has X open. The moment the holder navigates
away from X (their ``editing_screen_id`` changes) or expires, the lock lapses
and the next heartbeat on X re-claims it — giving snappy, automatic handoff.
"""
from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional

# workboard_id -> { user_key -> {"name","email","last_seen","editing_screen_id"} }
_PRESENCE: Dict[int, Dict[str, dict]] = {}
# workboard_id -> { screen_id -> {"holder_key","since"} }
_LOCKS: Dict[int, Dict[str, dict]] = {}
_LOCK = threading.Lock()

# An editor is "active" if seen within this window. The FE heartbeats every
# ~20s, so 50s tolerates one missed beat before dropping them.
TTL_SECONDS = 50.0


def _key_live_on(workboard_id: int, user_key: str, screen_id: str, now: float) -> bool:
    """True if ``user_key`` is a present, non-expired editor currently on
    ``screen_id``. A lock is only valid while its holder satisfies this — so a
    holder who leaves the screen (or lets their heartbeat lapse) frees it."""
    editors = _PRESENCE.get(workboard_id) or {}
    entry = editors.get(user_key)
    if not entry:
        return False
    if now - entry["last_seen"] > TTL_SECONDS:
        return False
    return entry.get("editing_screen_id") == screen_id


def _name_of(workboard_id: int, user_key: Optional[str]) -> Optional[str]:
    if not user_key:
        return None
    entry = (_PRESENCE.get(workboard_id) or {}).get(user_key)
    return entry.get("name") if entry else None


def _email_of(workboard_id: int, user_key: Optional[str]) -> Optional[str]:
    if not user_key:
        return None
    entry = (_PRESENCE.get(workboard_id) or {}).get(user_key)
    return entry.get("email") if entry else None


def _prune_locked(now: float) -> None:
    """Drop expired editors, empty workboards, and lapsed locks. Caller holds
    _LOCK."""
    for wb_id in list(_PRESENCE.keys()):
        editors = _PRESENCE[wb_id]
        for key in list(editors.keys()):
            if now - editors[key]["last_seen"] > TTL_SECONDS:
                del editors[key]
        if not editors:
            del _PRESENCE[wb_id]
    # A lock survives only while its holder is still live on that screen.
    for wb_id in list(_LOCKS.keys()):
        locks = _LOCKS[wb_id]
        for screen_id in list(locks.keys()):
            if not _key_live_on(wb_id, locks[screen_id]["holder_key"], screen_id, now):
                del locks[screen_id]
        if not locks:
            del _LOCKS[wb_id]


def _resolve_lock_locked(
    workboard_id: int,
    screen_id: str,
    user_key: str,
    now: float,
    *,
    claim: bool,
) -> dict:
    """Resolve (and optionally claim) the soft-lock for ``screen_id``.

    With ``claim=True`` the caller becomes the holder IFF the screen has no
    currently-valid holder; an existing holder (someone else still on the
    screen) is left untouched and the caller is a viewer. Caller holds _LOCK.
    """
    locks = _LOCKS.setdefault(workboard_id, {})
    cur = locks.get(screen_id)
    valid = bool(cur) and _key_live_on(workboard_id, cur["holder_key"], screen_id, now)
    if not valid and claim:
        cur = {"holder_key": user_key, "since": now}
        locks[screen_id] = cur
    if not cur:
        return {
            "screen_id": screen_id,
            "holder_key": None,
            "holder_name": None,
            "holder_email": None,
            "held_by_me": False,
            "since": None,
        }
    return {
        "screen_id": screen_id,
        "holder_key": cur["holder_key"],
        "holder_name": _name_of(workboard_id, cur["holder_key"]),
        "holder_email": _email_of(workboard_id, cur["holder_key"]),
        "held_by_me": cur["holder_key"] == user_key,
        "since": round(now - cur["since"], 1),
    }


def _screen_holders_locked(workboard_id: int, now: float) -> Dict[str, dict]:
    """Map screen_id -> {holder_key, holder_name} for every currently-valid
    lock, so the canvas can badge "đang được sửa bởi X" on screen cards."""
    out: Dict[str, dict] = {}
    for screen_id, lock in (_LOCKS.get(workboard_id) or {}).items():
        if _key_live_on(workboard_id, lock["holder_key"], screen_id, now):
            out[screen_id] = {
                "holder_key": lock["holder_key"],
                "holder_name": _name_of(workboard_id, lock["holder_key"]),
            }
    return out


def _others_locked(workboard_id: int, user_key: str, now: float) -> List[dict]:
    editors = _PRESENCE.get(workboard_id) or {}
    return [
        {
            "user_key": k,
            "name": v["name"],
            "email": v["email"],
            "seconds_ago": round(now - v["last_seen"], 1),
            "editing_screen_id": v.get("editing_screen_id"),
        }
        for k, v in editors.items()
        if k != user_key
    ]


def heartbeat(
    workboard_id: int,
    user_key: str,
    name: str,
    email: str,
    editing_screen_id: Optional[str] = None,
) -> dict:
    """Register/refresh the caller as editing ``workboard_id`` (on
    ``editing_screen_id``) and, if a screen is given, resolve+claim its
    soft-lock. Returns the OTHER active editors, the caller's lock state for
    their current screen, and the holder map for all screens."""
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        editors = _PRESENCE.setdefault(workboard_id, {})
        editors[user_key] = {
            "name": name,
            "email": email,
            "last_seen": now,
            "editing_screen_id": editing_screen_id,
        }
        lock_info = (
            _resolve_lock_locked(workboard_id, editing_screen_id, user_key, now, claim=True)
            if editing_screen_id
            else None
        )
        return {
            "editors": _others_locked(workboard_id, user_key, now),
            "lock": lock_info,
            "screen_holders": _screen_holders_locked(workboard_id, now),
        }


def takeover(
    workboard_id: int,
    user_key: str,
    name: str,
    email: str,
    screen_id: str,
) -> dict:
    """Force the caller to become the holder of ``screen_id`` (explicit "Chiếm
    quyền" action). The previous holder learns it lost the lock on its next
    heartbeat (``held_by_me`` flips to False) and its client drops to view-only.
    """
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        editors = _PRESENCE.setdefault(workboard_id, {})
        editors[user_key] = {
            "name": name,
            "email": email,
            "last_seen": now,
            "editing_screen_id": screen_id,
        }
        _LOCKS.setdefault(workboard_id, {})[screen_id] = {
            "holder_key": user_key,
            "since": now,
        }
        return _resolve_lock_locked(workboard_id, screen_id, user_key, now, claim=False)


def leave(workboard_id: int, user_key: str) -> None:
    """Best-effort removal when an editor closes/leaves the builder. Also drops
    any locks the user held so a collaborator can claim immediately (TTL would
    expire them anyway)."""
    with _LOCK:
        editors = _PRESENCE.get(workboard_id)
        if editors and user_key in editors:
            del editors[user_key]
        locks = _LOCKS.get(workboard_id)
        if locks:
            for screen_id in list(locks.keys()):
                if locks[screen_id]["holder_key"] == user_key:
                    del locks[screen_id]
            if not locks:
                _LOCKS.pop(workboard_id, None)
        if editors is not None and not editors:
            _PRESENCE.pop(workboard_id, None)
