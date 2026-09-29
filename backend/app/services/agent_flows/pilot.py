"""Who may be answered by an Agent Flow — the reader rollout policy.

ONE POLICY FOR EVERY READER PATH. Public-link chat (`dispatch.run_for_link`) and
Direct Chat (`dispatch.run_for_chat_thread`) both ask `reader_decision`; nothing else
serves a reader an Agent Flow answer. Author Studio Test (`dispatch.run_preview`) is
not a reader path and keeps its own gate (edit permission on the flow). The legacy
dashboard assistant (`dashboard_ai_bot`) never goes through here and is unaffected.

    AGENT_FLOW_READER_MODE   off    kill switch: no reader is answered
                             pilot  only the cohort below (DEFAULT, fail closed)
                             all    every reader (general availability)
    AGENT_FLOW_PILOT_LINK_IDS   comma-separated public-link ids in the pilot
    AGENT_FLOW_PILOT_USERS      comma-separated emails in the Direct Chat pilot

An unknown mode is treated as `off`. An empty cohort in `pilot` mode serves no
reader. Every refusal is recorded as a blocked run (`reader_mode_off`,
`pilot_not_enrolled`), so the audit trail shows who was turned away and why.

Replaces AGENT_FLOW_V3_ENABLED, which only refused flows with a Skill: a flow with no
Skill still went through the uncertified analytical runtime (pilot brief §7).
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

MODES = ("off", "pilot", "all")
_logged: dict = {}


def _csv(value: Any) -> list[str]:
    return [x.strip() for x in str(value or "").split(",") if x.strip()]


def policy() -> dict:
    """The effective policy, read from settings on every call (a restart applies a
    change; nothing caches a stale cohort)."""
    from app.core.config import settings

    raw = str(getattr(settings, "AGENT_FLOW_READER_MODE", "pilot") or "").strip().lower()
    mode = raw if raw in MODES else "off"
    links = set()
    for x in _csv(getattr(settings, "AGENT_FLOW_PILOT_LINK_IDS", "")):
        if x.isdigit():
            links.add(int(x))
    users = {x.lower() for x in _csv(getattr(settings, "AGENT_FLOW_PILOT_USERS", ""))}
    out = {"mode": mode, "configured_mode": raw, "link_ids": sorted(links), "users": sorted(users)}
    key = (mode, tuple(out["link_ids"]), len(users))
    if _logged.get("key") != key:
        _logged["key"] = key
        logger.warning("[agent-flow pilot] reader policy: mode=%s%s links=%s users=%d",
                       mode, "" if raw == mode else f" (configured {raw!r}: unknown, fail closed)",
                       out["link_ids"], len(users))
    return out


def reader_decision(*, link_id: Any = None, user_email: Any = None) -> str | None:
    """None when this reader may be answered; otherwise the refusal code."""
    p = policy()
    if p["mode"] == "off":
        return "reader_mode_off"
    if p["mode"] == "all":
        return None
    try:
        if link_id is not None and int(link_id) in p["link_ids"]:
            return None
    except (TypeError, ValueError):
        pass
    if user_email and str(user_email).strip().lower() in p["users"]:
        return None
    return "pilot_not_enrolled"


def describe(user_email: Any = None) -> dict:
    """What an admin sees: the mode, the enrolled links, the cohort's size."""
    p = policy()
    return {"mode": p["mode"], "configured_mode": p["configured_mode"],
            "pilot_link_ids": p["link_ids"], "pilot_user_count": len(p["users"]),
            "you_are_enrolled": bool(user_email) and str(user_email).lower() in p["users"]}


BLOCK_MESSAGES = {
    "reader_mode_off": ("Trợ lý AI đang tạm tắt. / The AI assistant is temporarily turned off."),
    "pilot_not_enrolled": (
        "Trợ lý này đang trong giai đoạn thử nghiệm và chưa mở cho báo cáo hoặc tài khoản này. / "
        "This assistant is in a limited pilot and is not yet open here."),
}
