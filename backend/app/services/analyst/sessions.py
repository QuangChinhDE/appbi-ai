"""AI Analyst sessions: persisted conversations that can be shared, and the one
rule that makes sharing them safe.

    A STORED ANSWER IS SHOWN ONLY TO SOMEONE WHO MAY READ ITS SOURCES NOW.

A turn records the Datasets it read and the fields it used. Every read of a session,
by anyone (the owner included), re-derives the viewer's CURRENT Analyst catalog
(EXPLORE relation, reporting purpose, GovernAIScope; catalog.discover) and returns
a turn in full only when all of its Datasets and fields are in it. Anything else is
`{question, status, redacted}`. So:

  * sharing a session never shares a Dataset; the owner must grant that through the
    Dataset's own grants, and nothing here creates one;
  * `analyst: full` (oversight) sees every session but not numbers it could not read;
  * a revoked grant hides the owner's own stored numbers on the next read.

WHO MAY DO WHAT (mirrors direct_chat.thread_access)

  owner  started it: read, ask, rename, delete; share through /shares (analyst >= edit)
  full   `analyst: full`: read and delete any session (still redacted per viewer)
  edit   shared at edit: read and ask; the turn runs as THE CALLER (their grants,
         their quota, their ledger rows)
  view   shared at view: read
  none   404, never 403: a session id is not an oracle for which ids exist

A follow-up's previous plan comes from this table, never from the browser; ask()
re-validates it against the caller's catalog like any other plan.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.analyst_session import AnalystSession, AnalystSessionTurn

MODULE = "analyst"
REDACTED_KEYS = ("question", "status", "turn_id")


def _register() -> None:
    from app.core.share_access import register_share_resource
    from app.models.resource_share import ResourceType

    register_share_resource(ResourceType.ANALYST_SESSION, AnalystSession, MODULE, "id")


_register()


# ── access ───────────────────────────────────────────────────────────────────

def access(db: Session, user: Any, session: AnalystSession) -> str:
    if str(getattr(session, "user_id", "")) == str(getattr(user, "id", "")):
        return "owner"
    from app.core.permissions import is_module_admin

    if is_module_admin(user, MODULE):
        return "full"
    from app.core.resource_shares import get_highest_share_for_resource
    from app.models.resource_share import ResourceType

    share = get_highest_share_for_resource(db, user, ResourceType.ANALYST_SESSION, str(session.id))
    if share is None:
        return "none"
    level = getattr(share.permission, "value", share.permission)
    return "edit" if str(level) == "edit" else "view"


def can_ask(level: str) -> bool:
    return level in ("owner", "edit")


def get_session(db: Session, user: Any, session_id: int) -> tuple[Optional[AnalystSession], str]:
    s = (db.query(AnalystSession)
         .filter(AnalystSession.id == session_id, AnalystSession.deleted_at.is_(None)).first())
    if s is None:
        return None, "none"
    level = access(db, user, s)
    return (s, level) if level != "none" else (None, "none")


def list_sessions(db: Session, user: Any, limit: int = 100) -> list[tuple[AnalystSession, str]]:
    from sqlalchemy import or_

    from app.core.permissions import is_module_admin

    q = db.query(AnalystSession).filter(AnalystSession.deleted_at.is_(None))
    if not is_module_admin(user, MODULE):
        from app.core.resource_shares import get_shared_resource_ids_query
        from app.models.resource_share import ResourceType

        shared = get_shared_resource_ids_query(db, user, ResourceType.ANALYST_SESSION)
        ids = [int(r[0]) for r in shared.all() if str(r[0]).strip().isdigit()]
        own = AnalystSession.user_id == user.id
        q = q.filter(or_(own, AnalystSession.id.in_(ids)) if ids else own)
    rows = q.order_by(AnalystSession.last_active_at.desc()).limit(limit).all()
    return [(s, access(db, user, s)) for s in rows]


def create(db: Session, user: Any, title: Optional[str] = None) -> AnalystSession:
    s = AnalystSession(user_id=user.id, title=(title or "").strip()[:255] or None)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


# ── what a turn read, and who may see it ─────────────────────────────────────

def viewer_scope(catalog) -> dict[int, set[str]]:
    """{dataset_id: refs this viewer may read in it}, from THIS request's catalog."""
    out: dict[int, set[str]] = {}
    for c in catalog:
        out.setdefault(int(c.dataset_id), set()).update(f.ref for f in c.fields)
    return out


def _plan_refs(plan: Any) -> set[str]:
    if not isinstance(plan, dict):
        return set()
    refs = {*(plan.get("dimensions") or []), *(plan.get("measures") or []),
            *((plan.get("filters") or {}).keys()), *((plan.get("time_grains") or {}).keys())}
    refs.update(s.get("field") for s in plan.get("sorts") or [] if isinstance(s, dict) and s.get("field"))
    return {str(r) for r in refs if r}


def footprint(response: dict, catalog) -> tuple[list[int], list[str]]:
    """The Datasets and fields a response shows, resolved with the ASKER's catalog."""
    by_explore = {c.explore_id: int(c.dataset_id) for c in catalog}
    ds: set[int] = set()
    ev = response.get("evidence") or {}
    ds.update(int(d) for d in ev.get("datasets") or [] if str(d).lstrip("-").isdigit())
    for explore in (ev.get("explore_id"), (response.get("plan") or {}).get("explore_id")):
        if explore is not None and explore in by_explore:
            ds.add(by_explore[explore])
    ds.update(int(o["dataset_id"]) for o in response.get("sources") or [] if isinstance(o, dict)
              and str(o.get("dataset_id", "")).isdigit())
    return sorted(ds), sorted(_plan_refs(response.get("plan")))


def stored_copy(response: dict, max_rows: int) -> dict:
    """What is kept: the response minus anything that is a capability, not a fact.
    Choice tokens are bound to the asker and would only ever be refused for anyone
    else; the consent flag is re-derived on a new turn."""
    r = copy.deepcopy(response)
    for k in ("choices", "sources"):
        for o in r.get(k) or []:
            if isinstance(o, dict):
                o.pop("token", None)
    r.pop("consent_available", None)
    if isinstance(r.get("rows"), list) and len(r["rows"]) > max_rows:
        r["rows"] = r["rows"][:max_rows]
        r["truncated"] = True
    return r


def visible(turn: AnalystSessionTurn, scope: dict[int, set[str]], viewer_id: Any = None) -> bool:
    ds = [int(d) for d in turn.dataset_ids or []]
    if not ds:
        # Nothing recorded to check against (a clarification between metrics names
        # the asker's catalog in its options): only the person who asked sees it.
        return viewer_id is not None and str(turn.asked_by) == str(viewer_id)
    if any(d not in scope for d in ds):
        return False
    allowed = set().union(*(scope[d] for d in ds)) if ds else set()
    refs = list(turn.refs or [])
    return all(r in allowed for r in refs) if refs else True


def turn_view(turn: AnalystSessionTurn, scope: dict[int, set[str]], viewer_id: Any) -> dict:
    base = {"seq": turn.seq, "turn_id": turn.turn_id, "question": turn.question, "status": turn.status,
            "asked_at": turn.created_at.isoformat() if turn.created_at else None,
            "asked_by_me": str(turn.asked_by) == str(viewer_id)}
    if visible(turn, scope, viewer_id):
        return {**base, "response": turn.response or {}, "redacted": False}
    return {**base, "response": None, "redacted": True}


def session_view(db: Session, user: Any, s: AnalystSession, level: str, scope: dict[int, set[str]],
                 with_turns: bool = True) -> dict:
    out = {"id": s.id, "title": s.title, "access": level, "can_ask": can_ask(level),
           "is_owner": level == "owner",
           "created_at": s.created_at.isoformat() if s.created_at else None,
           "last_active_at": s.last_active_at.isoformat() if s.last_active_at else None}
    if with_turns:
        turns = (db.query(AnalystSessionTurn).filter(AnalystSessionTurn.session_id == s.id)
                 .order_by(AnalystSessionTurn.seq).all())
        out["turns"] = [turn_view(t, scope, user.id) for t in turns]
    return out


def previous_plan(db: Session, s: AnalystSession, scope: dict[int, set[str]], viewer_id: Any) -> Optional[dict]:
    """The plan of the last answered turn the CALLER may read in full: a follow-up
    never builds on an answer the caller could not see."""
    turns = (db.query(AnalystSessionTurn)
             .filter(AnalystSessionTurn.session_id == s.id, AnalystSessionTurn.status == "answered")
             .order_by(AnalystSessionTurn.seq.desc()).limit(20).all())
    for t in turns:
        plan = (t.response or {}).get("plan")
        if isinstance(plan, dict) and visible(t, scope, viewer_id):
            return plan
    return None


def record(db: Session, s: AnalystSession, user: Any, question: str, response: dict, catalog,
           max_rows: int) -> AnalystSessionTurn:
    ds, refs = footprint(response, catalog)
    seq = (db.query(func.coalesce(func.max(AnalystSessionTurn.seq), 0))
           .filter(AnalystSessionTurn.session_id == s.id).scalar() or 0) + 1
    t = AnalystSessionTurn(session_id=s.id, seq=seq, turn_id=str(response.get("turn_id")), asked_by=user.id,
                           question=question[:1000], status=str(response.get("status") or "unsupported")[:16],
                           dataset_ids=ds, refs=refs, response=stored_copy(response, max_rows))
    db.add(t)
    s.last_active_at = datetime.now(timezone.utc)
    if not s.title:
        s.title = question.strip()[:120]
    db.commit()
    db.refresh(t)
    return t
