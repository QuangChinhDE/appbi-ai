"""Spend and rate ceilings for the PUBLIC AI chat — denial-of-wallet guard.

The threat is specific and already live: a shared link's `appearance_config`
can carry the ORGANISATION's provider key (`ai_bot_key`), the chat endpoint is
public and anonymous, and the only existing brake is a 20/minute limit keyed by
IP. Twenty IPs walk straight past that and spend the customer's money all day.

So the ceilings here are keyed by the thing being abused — the LINK — not by the
caller:

  • **USD per rolling 24h** — the real cost brake.
  • **Turns per rolling 1h** — catches a burst before it becomes a bill, and
    covers the case where usage reporting lags.

Both read `ai_chat_turn_logs`, which the chat endpoint already writes at the end
of every turn, so no new bookkeeping is introduced.

**A viewer using their OWN key (`X-User-Ai-Key`) is never blocked on cost** —
they are paying, not the organisation. The turn ceiling still applies, because
that one protects our CPU and the warehouse, not the wallet.

Resolution order for the USD ceiling:
    appearance_config.ai_bot_budget_usd_per_day
    → settings.AI_DEFAULT_BUDGET_USD_PER_DAY
    → 0 means unlimited (explicit opt-out for a customer who wants no cap)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class BudgetVerdict:
    allowed: bool
    reason: str = ""          # "" | "usd_per_day" | "turns_per_hour"
    message: str = ""
    spent_usd: float = 0.0
    turns_last_hour: int = 0
    limit_usd: float = 0.0
    limit_turns: int = 0

    def to_log(self) -> dict:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "spent_usd": round(self.spent_usd, 4),
            "turns_last_hour": self.turns_last_hour,
        }


_MSG_USD = (
    "Trợ lý AI của báo cáo này đã dùng hết hạn mức chi phí trong ngày. "
    "Bạn vui lòng quay lại sau, hoặc liên hệ người quản trị báo cáo để nâng hạn mức."
)
_MSG_TURNS = (
    "Trợ lý AI của báo cáo này đang nhận quá nhiều câu hỏi cùng lúc. "
    "Bạn thử lại sau vài phút nhé."
)


def _resolve_usd_limit(appearance_config: dict | None) -> float:
    raw = (appearance_config or {}).get("ai_bot_budget_usd_per_day")
    if raw is not None:
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            logger.warning("ai budget: bad ai_bot_budget_usd_per_day=%r", raw)
    return max(0.0, float(settings.AI_DEFAULT_BUDGET_USD_PER_DAY or 0))


def _resolve_turn_limit(appearance_config: dict | None) -> int:
    raw = (appearance_config or {}).get("ai_bot_turns_per_hour")
    if raw is not None:
        try:
            return max(0, int(raw))
        except (TypeError, ValueError):
            logger.warning("ai budget: bad ai_bot_turns_per_hour=%r", raw)
    return max(0, int(settings.AI_DEFAULT_TURNS_PER_HOUR or 0))


def check_budget(
    db: Session,
    *,
    token: str,
    appearance_config: dict | None,
    viewer_supplied_key: bool,
) -> BudgetVerdict:
    """Decide whether this link may start another turn right now.

    Best-effort by design: if the usage table cannot be read we ALLOW the turn.
    A monitoring failure must not take the assistant offline — the 20/minute IP
    limit and the per-turn ceilings are still in force underneath.
    """
    limit_usd = 0.0 if viewer_supplied_key else _resolve_usd_limit(appearance_config)
    limit_turns = _resolve_turn_limit(appearance_config)
    if limit_usd <= 0 and limit_turns <= 0:
        return BudgetVerdict(allowed=True)

    try:
        from app.models.ai_chat_turn_log import AiChatTurnLog

        now = datetime.now(timezone.utc)
        since_24h = now - timedelta(hours=24)
        since_1h = now - timedelta(hours=1)

        # One pass over the 24h window (covered by ix_ai_chat_turn_logs_token_created),
        # with the 1h turn count folded in via CASE so this stays one round-trip
        # and one index scan on the hot path of every question.
        row = (
            db.query(
                func.coalesce(func.sum(AiChatTurnLog.usd), 0.0),
                func.coalesce(
                    func.sum(case((AiChatTurnLog.created_at >= since_1h, 1), else_=0)), 0
                ),
            )
            .filter(
                AiChatTurnLog.token == token,
                AiChatTurnLog.created_at >= since_24h,
            )
            .one()
        )
        spent = float(row[0] or 0.0)
        turns = int(row[1] or 0)
    except Exception:  # noqa: BLE001
        logger.warning("ai budget: usage read failed for token=%s — allowing", token, exc_info=True)
        return BudgetVerdict(allowed=True)

    if limit_usd > 0 and spent >= limit_usd:
        return BudgetVerdict(
            allowed=False, reason="usd_per_day", message=_MSG_USD,
            spent_usd=spent, turns_last_hour=turns,
            limit_usd=limit_usd, limit_turns=limit_turns,
        )
    if limit_turns > 0 and turns >= limit_turns:
        return BudgetVerdict(
            allowed=False, reason="turns_per_hour", message=_MSG_TURNS,
            spent_usd=spent, turns_last_hour=turns,
            limit_usd=limit_usd, limit_turns=limit_turns,
        )
    return BudgetVerdict(
        allowed=True, spent_usd=spent, turns_last_hour=turns,
        limit_usd=limit_usd, limit_turns=limit_turns,
    )
