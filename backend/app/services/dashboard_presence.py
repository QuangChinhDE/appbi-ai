"""In-memory presence + per-PAGE co-edit rights for the dashboard Build editor.

Two people editing the same dashboard should SEE each other (so they don't
unknowingly overwrite one another). This module keeps a lightweight, in-process
registry of "who is currently editing dashboard X", refreshed by a heartbeat
from the FE every ~20s and expired by TTL.

Beyond presence, it resolves a **per-page co-edit right** with OWNER PRIORITY
(the behaviour the product asked for):

  * The dashboard **owner** has edit priority on whatever page they currently
    have open. A non-owner who opens the SAME page the owner is on is
    **view-only** and must **request edit** → the owner **approves** (a grant)
    before they can edit that page.
  * On a **different page where the owner is absent**, a non-owner edits
    normally. To stop two non-owners clobbering shared writes (theme / widget /
    chart), a first-come **soft-lock** picks one holder per page among them.

This is an ADVISORY UX layer — writes are NOT hard-blocked server-side (mirrors
the workboard lock). The real correctness net stays the publish-409 optimistic
guard + per-user draft layouts (``draft_snapshot.user_layouts[user_key]``), so a
lapsed/raced lock can never corrupt a save.

Why in-memory (no DB table / no migration):
  * The backend runs a SINGLE uvicorn worker (see entrypoint.sh — no --workers),
    so a module-level dict is shared by every request; no cross-worker split.
  * Presence + rights are ephemeral, best-effort state; persisting them (a row
    every ~20s per editor) would be wasteful and needs no durability. On process
    restart, editors simply re-register + re-resolve on their next heartbeat.

Validity rule: an owner/holder "holds" page P only while still present (within
TTL) AND still has P open. The moment they navigate away (their
``editing_page_id`` changes) or expire, the hold lapses and the next heartbeat
on P re-resolves it — snappy, automatic handoff.
"""
from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional, Set

# dashboard_id -> { user_key -> {"name","email","last_seen","editing_chart_id",
#                                "editing_page_id","is_owner"} }
_PRESENCE: Dict[int, Dict[str, dict]] = {}
# dashboard_id -> { page_id -> {"holder_key","since"} }  (soft-lock among non-owners)
_LOCKS: Dict[int, Dict[str, dict]] = {}
# dashboard_id -> { page_id -> set(user_key) }  (owner-approved editors for a page)
_GRANTS: Dict[int, Dict[str, Set[str]]] = {}
# dashboard_id -> { page_id -> { requester_key -> {"name","email","since"} } }
_PENDING: Dict[int, Dict[str, Dict[str, dict]]] = {}
_LOCK = threading.Lock()

# An editor is "active" if seen within this window. The FE heartbeats every
# ~20s, so 50s tolerates one missed beat before dropping them.
TTL_SECONDS = 50.0


def _live(entry: Optional[dict], now: float) -> bool:
    return bool(entry) and (now - entry["last_seen"] <= TTL_SECONDS)


def _key_live_on(dashboard_id: int, user_key: Optional[str], page_id: str, now: float) -> bool:
    """True if ``user_key`` is a present, non-expired editor currently on
    ``page_id``. A soft-lock is only valid while its holder satisfies this."""
    if not user_key:
        return False
    entry = (_PRESENCE.get(dashboard_id) or {}).get(user_key)
    return _live(entry, now) and entry.get("editing_page_id") == page_id


def _name_of(dashboard_id: int, user_key: Optional[str]) -> Optional[str]:
    if not user_key:
        return None
    entry = (_PRESENCE.get(dashboard_id) or {}).get(user_key)
    return entry.get("name") if entry else None


def _owner_key_on_page(dashboard_id: int, page_id: str, now: float) -> Optional[str]:
    """user_key of a present, live OWNER currently on ``page_id`` (or None)."""
    for k, v in (_PRESENCE.get(dashboard_id) or {}).items():
        if v.get("is_owner") and _live(v, now) and v.get("editing_page_id") == page_id:
            return k
    return None


def _prune_locked(now: float) -> None:
    """Drop expired editors, empty dashboards, lapsed locks, stale grants, and
    stale pending requests. Caller holds _LOCK."""
    for dash_id in list(_PRESENCE.keys()):
        editors = _PRESENCE[dash_id]
        for key in list(editors.keys()):
            if now - editors[key]["last_seen"] > TTL_SECONDS:
                del editors[key]
        if not editors:
            del _PRESENCE[dash_id]

    # A soft-lock survives only while its holder is still live on that page.
    for dash_id in list(_LOCKS.keys()):
        locks = _LOCKS[dash_id]
        for page_id in list(locks.keys()):
            if not _key_live_on(dash_id, locks[page_id]["holder_key"], page_id, now):
                del locks[page_id]
        if not locks:
            del _LOCKS[dash_id]

    # A grant survives only while the granted user is still a live editor. When
    # the owner leaves the page the grant becomes moot (resolve() ignores grants
    # once no owner is present), so we only need to prune departed users here.
    for dash_id in list(_GRANTS.keys()):
        page_map = _GRANTS[dash_id]
        editors = _PRESENCE.get(dash_id) or {}
        for page_id in list(page_map.keys()):
            page_map[page_id] = {
                uk for uk in page_map[page_id] if _live(editors.get(uk), now)
            }
            if not page_map[page_id]:
                del page_map[page_id]
        if not page_map:
            del _GRANTS[dash_id]

    # A pending request survives only while the requester is still a live editor.
    for dash_id in list(_PENDING.keys()):
        page_map = _PENDING[dash_id]
        editors = _PRESENCE.get(dash_id) or {}
        for page_id in list(page_map.keys()):
            reqs = page_map[page_id]
            for rk in list(reqs.keys()):
                if not _live(editors.get(rk), now):
                    del reqs[rk]
            if not reqs:
                del page_map[page_id]
        if not page_map:
            del _PENDING[dash_id]


def _resolve_page_edit_locked(
    dashboard_id: int,
    page_id: Optional[str],
    user_key: str,
    now: float,
    *,
    claim: bool,
) -> Optional[dict]:
    """Resolve the caller's edit right for ``page_id`` (owner-priority model).

    OWNER on the page ⇒ owner holds it, can_edit. Non-owner: view-only while an
    owner is present on the page and they haven't been granted; otherwise a
    first-come soft-lock among non-owners decides the single holder. With
    ``claim=True`` the caller claims the non-owner soft-lock when eligible.
    Caller holds _LOCK. Returns None when no page is given.
    """
    if not page_id:
        return None

    entry = (_PRESENCE.get(dashboard_id) or {}).get(user_key) or {}
    i_am_owner = bool(entry.get("is_owner"))
    owner_key = _owner_key_on_page(dashboard_id, page_id, now)
    owner_present = owner_key is not None
    granted = _GRANTS.get(dashboard_id, {}).get(page_id, set())
    i_am_granted = user_key in granted

    holder_key: Optional[str]
    if i_am_owner:
        holder_key = user_key
        can_edit = True
    elif owner_present:
        # Owner holds the page; a non-owner edits only if the owner approved them.
        holder_key = owner_key
        can_edit = i_am_granted
    else:
        # No owner here → first-come soft-lock among non-owners.
        locks = _LOCKS.setdefault(dashboard_id, {})
        cur = locks.get(page_id)
        valid = bool(cur) and _key_live_on(dashboard_id, cur["holder_key"], page_id, now)
        if not valid and claim:
            cur = {"holder_key": user_key, "since": now}
            locks[page_id] = cur
        holder_key = cur["holder_key"] if cur else None
        can_edit = holder_key == user_key

    # Pending requests are only meaningful to the owner of the page.
    pending = [
        {"requester_key": rk, "name": rv.get("name"), "email": rv.get("email")}
        for rk, rv in (_PENDING.get(dashboard_id, {}).get(page_id, {})).items()
    ]

    return {
        "page_id": page_id,
        "holder_key": holder_key,
        "holder_name": _name_of(dashboard_id, holder_key),
        "held_by_me": holder_key == user_key,
        "owner_present": owner_present,
        "i_am_owner": i_am_owner,
        "i_am_granted": i_am_granted,
        "can_edit": can_edit,
        "pending_requests": pending,
    }


def _page_holders_locked(dashboard_id: int, now: float) -> Dict[str, dict]:
    """Map page_id -> {holder_key, holder_name} for every page that currently has
    a resolved holder (owner-on-page or a live non-owner soft-lock)."""
    out: Dict[str, dict] = {}
    # owners currently on a page hold that page
    for k, v in (_PRESENCE.get(dashboard_id) or {}).items():
        pid = v.get("editing_page_id")
        if v.get("is_owner") and _live(v, now) and pid:
            out[pid] = {"holder_key": k, "holder_name": v.get("name")}
    # non-owner soft-locks fill in pages with no owner present
    for page_id, lock in (_LOCKS.get(dashboard_id) or {}).items():
        if page_id in out:
            continue
        if _key_live_on(dashboard_id, lock["holder_key"], page_id, now):
            out[page_id] = {
                "holder_key": lock["holder_key"],
                "holder_name": _name_of(dashboard_id, lock["holder_key"]),
            }
    return out


def _others_locked(dashboard_id: int, user_key: str, now: float) -> List[dict]:
    editors = _PRESENCE.get(dashboard_id) or {}
    return [
        {
            "user_key": k,
            "name": v["name"],
            "email": v["email"],
            "seconds_ago": round(now - v["last_seen"], 1),
            "editing_chart_id": v.get("editing_chart_id"),
            "editing_page_id": v.get("editing_page_id"),
            "is_owner": bool(v.get("is_owner")),
        }
        for k, v in editors.items()
        if k != user_key
    ]


def heartbeat(
    dashboard_id: int,
    user_key: str,
    name: str,
    email: str,
    editing_chart_id: int | None = None,
    editing_page_id: str | None = None,
    is_owner: bool = False,
) -> dict:
    """Register/refresh the current editor and resolve their per-page edit right.

    `editing_chart_id` / `editing_page_id` are the chart + page the user is
    currently focused on (their "cursor"). `is_owner` (the caller is the
    dashboard's owner) drives owner-priority. Returns the OTHER active editors,
    the caller's `lock` (edit-right) for their current page, and a `page_holders`
    map so the UI can badge who holds each page.
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
            "editing_page_id": editing_page_id,
            "is_owner": bool(is_owner),
        }
        lock_info = _resolve_page_edit_locked(
            dashboard_id, editing_page_id, user_key, now, claim=True
        )
        return {
            "editors": _others_locked(dashboard_id, user_key, now),
            "lock": lock_info,
            "page_holders": _page_holders_locked(dashboard_id, now),
        }


def request_edit(
    dashboard_id: int,
    page_id: str,
    user_key: str,
    name: str,
    email: str,
) -> dict:
    """A non-owner asks the owner for edit rights on ``page_id``. Records a
    pending request (idempotent per requester) and returns the caller's freshly
    resolved edit-right (still view-only until the owner approves)."""
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        # keep the requester present so the request isn't pruned immediately
        editors = _PRESENCE.setdefault(dashboard_id, {})
        entry = editors.get(user_key)
        if entry:
            entry["last_seen"] = now
            entry["editing_page_id"] = page_id
        _PENDING.setdefault(dashboard_id, {}).setdefault(page_id, {})[user_key] = {
            "name": name,
            "email": email,
            "since": now,
        }
        return _resolve_page_edit_locked(dashboard_id, page_id, user_key, now, claim=False)


def respond_request(
    dashboard_id: int,
    page_id: str,
    owner_key: str,
    requester_key: str,
    approve: bool,
) -> dict:
    """Owner approves/denies a pending edit request on ``page_id``. Approve adds
    the requester to the page's grant set (they can now edit even while the owner
    is present); deny just clears the request. Returns the OWNER's resolved
    edit-right for the page (with the updated pending list). Route must verify
    ``owner_key`` really is the dashboard owner."""
    now = time.time()
    with _LOCK:
        _prune_locked(now)
        editors = _PRESENCE.setdefault(dashboard_id, {})
        owner_entry = editors.get(owner_key)
        if owner_entry:
            owner_entry["last_seen"] = now
            owner_entry["editing_page_id"] = page_id
        # clear the pending request either way
        _PENDING.get(dashboard_id, {}).get(page_id, {}).pop(requester_key, None)
        if approve:
            _GRANTS.setdefault(dashboard_id, {}).setdefault(page_id, set()).add(requester_key)
        return _resolve_page_edit_locked(dashboard_id, page_id, owner_key, now, claim=False)


def leave(dashboard_id: int, user_key: str) -> None:
    """Best-effort removal when an editor closes/leaves the Build page. Also
    drops any soft-lock, grants, and pending requests tied to the user so a
    collaborator can proceed immediately (TTL would expire them anyway)."""
    with _LOCK:
        editors = _PRESENCE.get(dashboard_id)
        if editors and user_key in editors:
            del editors[user_key]
        locks = _LOCKS.get(dashboard_id)
        if locks:
            for page_id in list(locks.keys()):
                if locks[page_id]["holder_key"] == user_key:
                    del locks[page_id]
            if not locks:
                _LOCKS.pop(dashboard_id, None)
        grants = _GRANTS.get(dashboard_id)
        if grants:
            for page_id in list(grants.keys()):
                grants[page_id].discard(user_key)
                if not grants[page_id]:
                    del grants[page_id]
            if not grants:
                _GRANTS.pop(dashboard_id, None)
        pending = _PENDING.get(dashboard_id)
        if pending:
            for page_id in list(pending.keys()):
                pending[page_id].pop(user_key, None)
                if not pending[page_id]:
                    del pending[page_id]
            if not pending:
                _PENDING.pop(dashboard_id, None)
        if editors is not None and not editors:
            _PRESENCE.pop(dashboard_id, None)
