"""Spend and rate ceilings of a PUBLIC link's AI bot - the cheap pre-check.

The threat is specific: a shared link is public and anonymous, and every turn it
starts spends the organisation's money. The ceilings are keyed by the thing
being abused - the LINK - not by the caller:

  * **USD per rolling 24h** - the cost brake;
  * **turns per rolling 1h** - catches a burst before it becomes a bill.

This is the fast gate in front of a turn. The AUTHORITY is the Model Gateway
(`services/ai_runtime/gateway.py`): every paid call reserves its worst case in the
usage ledger under a lock, per link, per user, per turn and globally, so two
concurrent turns cannot both pass a ceiling this pre-check let through.

Two rules, both found on PR #77 and locked by tests/test_public_answer_core.py:

  * **No header chooses the ceiling.** `X-User-Ai-Key` used to set the USD
    ceiling to 0 ("unlimited") while the turn could still run on the
    organisation's key. A viewer cannot bring a key any more; the credential
    and the ceiling belong to the same billing principal, the link.
  * **Fail closed.** When the spend cannot be read, no paid turn starts.

Resolution order for the USD ceiling:
    appearance_config.ai_bot_budget_usd_per_day (> 0)
    → settings.AI_DEFAULT_BUDGET_USD_PER_DAY (> 0)
    → AI_LINK_FALLBACK_USD_PER_DAY: a link is never unlimited.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.log_safety import token_ref

logger = logging.getLogger(__name__)

#: The ceiling of a link when neither the link nor the server sets one.
AI_LINK_FALLBACK_USD_PER_DAY = 1.0


@dataclass
class BudgetVerdict:
    allowed: bool
    reason: str = ""          # "" | "usd_per_day" | "turns_per_hour" | "budget_unavailable"
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
_MSG_UNAVAILABLE = (
    "Trợ lý AI tạm thời không kiểm tra được hạn mức chi phí nên chưa trả lời. "
    "Bạn thử lại sau ít phút nhé."
)


def resolve_usd_limit(appearance_config: dict | None) -> float:
    """The link's USD ceiling per rolling 24h - always > 0."""
    raw = (appearance_config or {}).get("ai_bot_budget_usd_per_day")
    if raw is not None:
        try:
            value = float(raw)
            if value > 0:
                return value
        except (TypeError, ValueError):
            logger.warning("ai budget: bad ai_bot_budget_usd_per_day=%r", raw)
    default = float(settings.AI_DEFAULT_BUDGET_USD_PER_DAY or 0)
    return default if default > 0 else AI_LINK_FALLBACK_USD_PER_DAY


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
) -> BudgetVerdict:
    """Decide whether this link may start another turn right now (fail closed)."""
    limit_usd = resolve_usd_limit(appearance_config)
    limit_turns = _resolve_turn_limit(appearance_config)
    try:
        from app.models.ai_chat_turn_log import AiChatTurnLog

        now = datetime.now(timezone.utc)
        since_24h = now - timedelta(hours=24)
        since_1h = now - timedelta(hours=1)

        # One pass over the 24h window (covered by ix_ai_chat_turn_logs_token_created),
        # with the 1h turn count folded in via CASE: one round-trip, one index scan.
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
    except Exception:  # noqa: BLE001 - unknown spend is not zero spend
        logger.warning("ai budget: usage read failed for link=%s - refusing", token_ref(token), exc_info=True)
        return BudgetVerdict(allowed=False, reason="budget_unavailable", message=_MSG_UNAVAILABLE,
                             limit_usd=limit_usd, limit_turns=limit_turns)

    if spent >= limit_usd:
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
