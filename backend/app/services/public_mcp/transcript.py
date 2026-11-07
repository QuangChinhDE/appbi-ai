"""Keeping a viewer's Claude conversation on a public link — in the AI Bot's own turn tables.

One record per question, in the table the link's AppBI AI Bot already uses
(`public_answer_turns` for dashboard links, `report_answer_turns` for report links), so
both engines share one history, one retention and one place to analyse what viewers ask.
A Claude turn is marked by `idempotency_key = "claude:<id>"` and `envelope.engine =
"claude"`; its `conversation_key` is the view session (one conversation per session).

What is kept: the question, Claude's answer, the report tools it used (name + arguments),
the viewer's view (page, filters, drill) and timing. Never kept: credentials or tokens —
the runtime never sends them, and anything shaped like one is redacted here anyway.

Written by the Public MCP service with the session's grant (the runtime's own report
of a finished turn), only when the publisher keeps history on (`mcp_access.keep_history`,
default on, notice shown in the chat). Retention: `PUBLIC_CLAUDE_HISTORY_DAYS` (default
90) — older Claude turns of the link are deleted when a new one is written.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from app.services.public_mcp import access as A

MAX_TEXT = 20_000
MAX_TOOLS = 40
_SECRETS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"\b(?:eyJ[A-Za-z0-9_\-]+\.){2}[A-Za-z0-9_\-]+\b"),  # JWT
    re.compile(r"\b[A-Za-z0-9_\-]{48,}\b"),  # long opaque strings (keys, codes, tokens)
]


def redact(text: Any) -> str:
    s = str(text or "")
    for rx in _SECRETS:
        s = rx.sub("[redacted]", s)
    return s


def _clean(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return None
    if isinstance(value, str):
        return redact(value)[:2000]
    if isinstance(value, dict):
        return {str(k)[:100]: _clean(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, list):
        return [_clean(v, depth + 1) for v in value[:50]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact(value)[:200]


def retention_days() -> int:
    from app.core.config import settings

    try:
        return max(1, int(getattr(settings, "PUBLIC_CLAUDE_HISTORY_DAYS", 90) or 90))
    except (TypeError, ValueError):
        return 90


def record(db, h, turn: Dict[str, Any], view_state: Dict[str, Any] | None) -> Dict[str, Any]:
    """Store one finished Claude turn of this viewer session. Returns {"kept": bool}."""
    if not A.settings_of(h.appearance)["keep_history"]:
        return {"kept": False, "reason": "history_off"}
    from app.models.ai_runtime import PublicAnswerTurn
    from app.models.report_artifact import ReportAnswerTurn
    from app.services.public_mcp.service import DASHBOARD

    T = PublicAnswerTurn if h.kind == DASHBOARD else ReportAnswerTurn
    question = redact(" ".join(str(turn.get("question") or "").split()))[:4000]
    if not question:
        return {"kept": False, "reason": "empty"}
    ref = re.sub(r"[^A-Za-z0-9_\-]", "", str(turn.get("id") or ""))[:40] or uuid.uuid4().hex
    idem = f"claude:{ref}"[:64]
    if db.query(T.id).filter(T.link_id == h.link.id, T.idempotency_key == idem).first():
        return {"kept": True, "replayed": True}
    tools: List[dict] = [{"name": str(t.get("name") or "")[:80], "input": _clean(t.get("input"))}
                         for t in (turn.get("tools") or [])[:MAX_TOOLS] if isinstance(t, dict)]
    envelope = {
        "engine": "claude", "source": "public_mcp",
        "answer": redact(turn.get("answer"))[:MAX_TEXT],
        "tools": tools,
        "view_state": _clean(view_state or {}),
        "model": str(turn.get("model") or "")[:80],
        "duration_ms": int(turn.get("duration_ms") or 0),
        "error": redact(turn.get("error"))[:500] or None,
        "report": {"kind": h.kind, "name": h.name},
    }
    now = datetime.now(timezone.utc)
    row = T(link_id=h.link.id, conversation_key=f"claude-{h.sid}"[:64], turn_id=uuid.uuid4().hex,
            idempotency_key=idem, question=question, status="failed" if envelope["error"] else "answered",
            envelope=envelope, usd=None, finished_at=now)
    db.add(row)
    cutoff = now - timedelta(days=retention_days())
    (db.query(T).filter(T.link_id == h.link.id, T.idempotency_key.like("claude:%"), T.created_at < cutoff)
       .delete(synchronize_session=False))
    db.commit()
    return {"kept": True}


def rate(db, h, ref: str, rating: str) -> dict:
    """The viewer's thumb on one Claude answer of THEIR view session. The same verdict, column
    and rules as an AI Bot answer (answer_core.public_turn.rate), so the publisher's Feedback
    view reads both engines alike. The grant pins link + session: no other viewer's turn."""
    from app.services.answer_core import public_turn

    from app.models.ai_runtime import PublicAnswerTurn
    from app.models.report_artifact import ReportAnswerTurn
    from app.services.public_mcp.service import DASHBOARD

    T = PublicAnswerTurn if h.kind == DASHBOARD else ReportAnswerTurn
    ref = re.sub(r"[^A-Za-z0-9_\-]", "", str(ref or ""))[:40]
    conv = f"claude-{h.sid}"[:64]
    row = (db.query(T).filter(T.link_id == h.link.id, T.idempotency_key == f"claude:{ref}"[:64],
                              T.conversation_key == conv).first())
    if row is None:
        from app.services.public_mcp.service import Refused
        raise Refused("turn_not_found", "This answer was not kept, so it cannot be rated.", 404)
    try:
        out = public_turn.rate(db, link_id=h.link.id, turn_id=row.turn_id, conversation_key=conv, rating=rating, T=T)
    except public_turn.TurnRejected as exc:
        from app.services.public_mcp.service import Refused
        raise Refused("rating_refused", str(exc.detail), exc.status_code)
    return {"rated": True, "rating": out["rating"]}
