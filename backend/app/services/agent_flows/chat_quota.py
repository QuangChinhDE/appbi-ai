"""Admission control for Direct Chat: may this user start another turn today?

WHY THIS IS NOT `runtime.state.Budget`
--------------------------------------
That object is the ceiling for ONE run — model calls, tool calls, wall-clock — it
starts at `time.monotonic()`, dies with the run, and has no database at all. Asking
it "how many turns has this person had today" would mean giving every run a DB
handle and a memory of other runs, which is a different object wearing the same
name. Budget bounds a run; this bounds a person.

WHY PER USER AND NOT PER LINK
-----------------------------
`dashboard_ai_bot.budget.check_budget` already meters the public bot, keyed by link
token. A direct chat has no link, and more importantly it has a different shape of
risk: a public link is bounded by somebody having to find and open it, while a nav
item is one click for every employee at once.

FAILS OPEN
----------
A quota that cannot be read must not take the product down — the same choice, for
the same reason, that `check_budget` already makes. Being unable to count is not
evidence of abuse.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class ChatQuotaVerdict:
    allowed: bool
    reason: str = ""  # "" | "runs_per_day"
    message: str = ""
    runs_today: int = 0
    limit_runs: int = 0


_MSG = (
    "Bạn đã dùng hết lượt chat AI trong ngày ({used}/{limit}). "
    "Hạn mức được đặt lại vào đầu ngày hôm sau."
)


def check_chat_quota(db: Session, user: Any) -> ChatQuotaVerdict:
    """Counted from `agent_flow_runs`, the record the runtime already writes.

    No second telemetry table: `ai_chat_turn_logs` is keyed by link token and knows
    nothing about threads, and writing a row there just to count it would put the
    same turn in two ledgers that can disagree.

    The count is of turns ALREADY RECORDED, so a burst fired in one instant is
    admitted together. That is deliberate for V1 — the ceiling is about sustained
    use, and a reservation scheme costs a write on the hot path to close a gap
    nobody is exploiting.
    """
    limit = int(getattr(settings, "DIRECT_CHAT_RUNS_PER_DAY", 0) or 0)
    if limit <= 0:
        return ChatQuotaVerdict(allowed=True, limit_runs=0)

    try:
        from app.models.agent_flow_chat_thread import AgentFlowChatThread
        from app.models.agent_flow_run import AgentFlowRun

        since = datetime.now(timezone.utc) - timedelta(days=1)
        used = (
            db.query(AgentFlowRun.id)
            .join(
                AgentFlowChatThread,
                AgentFlowChatThread.id == AgentFlowRun.chat_thread_id,
            )
            .filter(
                AgentFlowChatThread.user_id == user.id,
                AgentFlowRun.created_at >= since,
            )
            .count()
        )
    except Exception:  # noqa: BLE001
        logger.warning("[chat] quota unreadable; allowing the turn", exc_info=True)
        return ChatQuotaVerdict(allowed=True, limit_runs=limit)

    if used >= limit:
        return ChatQuotaVerdict(
            allowed=False,
            reason="runs_per_day",
            message=_MSG.format(used=used, limit=limit),
            runs_today=used,
            limit_runs=limit,
        )
    return ChatQuotaVerdict(allowed=True, runs_today=used, limit_runs=limit)
