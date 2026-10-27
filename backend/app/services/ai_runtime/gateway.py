"""THE Model Gateway: credentials, token caps and USD budget for every paid model call.

PO directive (2026-10-28): AI Chat, the public Dashboard AI Bot and an Agent Flow
running as their add-on spend under ONE server policy. Nothing here is decided by
the browser: there is no viewer-supplied key, no client-side budget.

A paid call goes through four steps, wherever it is made (`llm_client._call_*` for
the Answer Core's planner, `agent_flows.runtime.handlers.agent._stream` for a Flow
step):

  1. `authorize()` - the worst-case cost (input estimated from the prompt, output
     at the clamped max_tokens, priced by `dashboard_ai_bot.cost`) is RESERVED in
     `ai_usage_ledger` under a transaction-scoped advisory lock on every scope the
     call bills: global, the signed-in user, the public link, the turn. Two
     concurrent calls cannot both pass a ceiling. A ledger that cannot be read
     refuses the call (fail closed): unknown spend is not zero spend.
  2. the provider call, with `max_tokens` clamped to the policy cap;
  3. `settle()` - the reported usage replaces the reservation;
  4. an error after the request was sent keeps the worst case (`unknown`): it may
     have been billed, and it is never counted as free.

The billing scope of a call is the ambient `Billing` (a context variable set by the
consumer for its turn). A call outside any turn is billed as `system` against the
global ceiling - there is no path to a provider that skips this file.

Ceilings (settings, all > 0): AI_GLOBAL_USD_PER_DAY, AI_USER_USD_PER_DAY, the
link's own ceiling (`dashboard_ai_bot.budget.resolve_usd_limit`),
AI_MAX_MODEL_CALLS_PER_TURN, AI_MAX_USD_PER_TURN, AI_MAX_OUTPUT_TOKENS_PER_CALL,
AI_MAX_INPUT_TOKENS_PER_CALL.
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator, Mapping, Optional

logger = logging.getLogger("app.ai_runtime")


# ── refusals ─────────────────────────────────────────────────────────────────

class AiPolicyRefused(RuntimeError):
    """The policy refused a paid call before anything was sent."""

    code = "ai_policy_refused"

    def __init__(self, message_vi: str, detail: Optional[dict] = None):
        super().__init__(message_vi)
        self.message_vi = message_vi
        self.detail = dict(detail or {})


class BudgetUnavailable(AiPolicyRefused):
    code = "budget_unavailable"


class AiBudgetExceeded(AiPolicyRefused):
    code = "ai_budget_exceeded"


class NoCredential(AiPolicyRefused):
    code = "model_unavailable"


class InputTooLarge(AiPolicyRefused):
    code = "input_too_large"


_MSG = {
    "global": "Hệ thống AI đã dùng hết hạn mức chi phí trong ngày; hãy thử lại sau.",
    "user": "Bạn đã dùng hết hạn mức chi phí AI trong 24 giờ.",
    "link": "Trợ lý AI của báo cáo này đã dùng hết hạn mức chi phí trong ngày; hãy quay lại sau.",
    "turn_calls": "Câu hỏi này cần quá nhiều lượt gọi mô hình AI; hãy hỏi cụ thể hơn.",
    "turn_usd": "Câu hỏi này vượt hạn mức chi phí cho một lượt hỏi; hãy hỏi cụ thể hơn.",
}


# ── who pays ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Credential:
    """A provider key resolved server-side. `ref` names it in the ledger; the key
    itself is never logged, stored in the ledger or returned to a client."""

    provider: str
    key: str = field(repr=False)
    ref: str = "server"


@dataclass(frozen=True)
class Billing:
    purpose: str = "system"
    user_id: Optional[str] = None
    link_id: Optional[int] = None
    link_usd_per_day: Optional[float] = None
    turn_ref: Optional[str] = None
    #: a key pinned for this turn (a link's own, from the encrypted store); None = the server's
    credential: Optional[Credential] = None


_current: contextvars.ContextVar[Optional[Billing]] = contextvars.ContextVar("ai_billing", default=None)


@contextlib.contextmanager
def billing(b: Billing) -> Iterator[Billing]:
    token = _current.set(b)
    try:
        yield b
    finally:
        _current.reset(token)


def current() -> Billing:
    return _current.get() or Billing()


def is_turn_scoped() -> bool:
    """True inside a consumer's turn (Chat, the public bot, an add-on)."""
    return _current.get() is not None


# ── policy numbers ───────────────────────────────────────────────────────────

def _setting(name: str, default: float) -> float:
    from app.core.config import settings

    try:
        value = float(getattr(settings, name, default) or 0)
    except (TypeError, ValueError):
        value = 0.0
    return value if value > 0 else float(default)


def max_output_tokens(requested: Optional[int]) -> int:
    cap = int(_setting("AI_MAX_OUTPUT_TOKENS_PER_CALL", 16384))
    return max(1, min(int(requested or cap), cap))


def estimate_tokens(*texts: Any) -> int:
    """Tokens of the request, over-estimated (3 characters per token)."""
    chars = sum(len(t) if isinstance(t, str) else len(repr(t)) for t in texts if t is not None)
    return int(math.ceil(chars / 3.0)) + 16


def worst_case_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    from app.services.dashboard_ai_bot.cost import price_for

    tier = price_for(model or "").tier_for_prompt_tokens(input_tokens)
    return (input_tokens * float(tier.input_per_1m) + output_tokens * float(tier.output_per_1m)) / 1_000_000.0


def usage_usd(model: str, usage: Mapping[str, Any]) -> tuple[float, int, int]:
    """(USD, input tokens, output tokens) of a provider's reported usage."""
    from app.services.dashboard_ai_bot.cost import CostMeter

    u = _normalize_usage(usage)
    meter = CostMeter(model=model or "")
    meter.add_usage(u)
    return float(meter.usd), int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0)


def _normalize_usage(usage: Mapping[str, Any]) -> dict:
    u = dict(usage or {})
    if "prompt_tokens" not in u:
        u["prompt_tokens"] = u.get("input_tokens") or u.get("promptTokenCount") or 0
    if "completion_tokens" not in u:
        out = u.get("output_tokens") or u.get("candidatesTokenCount") or 0
        u["completion_tokens"] = int(out or 0) + int(u.get("thoughtsTokenCount") or 0)
    details = u.get("prompt_tokens_details") or {}
    if isinstance(details, dict) and details.get("cached_tokens") and "cached_prompt_tokens" not in u:
        u["cached_prompt_tokens"] = details["cached_tokens"]
    out_details = u.get("completion_tokens_details") or {}
    if isinstance(out_details, dict) and out_details.get("reasoning_tokens") and "reasoning_tokens" not in u:
        u["reasoning_tokens"] = out_details["reasoning_tokens"]
    return u


def has_usage(usage: Optional[Mapping[str, Any]]) -> bool:
    u = _normalize_usage(usage or {})
    return int(u.get("prompt_tokens") or 0) > 0 or int(u.get("completion_tokens") or 0) > 0


# ── the ledger ───────────────────────────────────────────────────────────────

@dataclass
class Reservation:
    call_id: str
    provider: str
    model: str
    reserved_usd: float
    max_tokens: int


def _engine():
    from app.core.database import app_engine

    return app_engine


def _used(conn, where: str, params: dict) -> float:
    from sqlalchemy import text

    row = conn.execute(text(
        "SELECT COALESCE(SUM(COALESCE(actual_usd, reserved_usd)), 0) FROM ai_usage_ledger "
        f"WHERE status <> 'released' AND {where}"), params).scalar()
    return float(row or 0.0)


def authorize(provider: str, model: str, system: Any, prompt: Any, max_tokens: Optional[int]) -> Reservation:
    """Reserve one call's worst case against every scope it bills, or refuse."""
    from sqlalchemy import text

    b = current()
    in_tok = estimate_tokens(system, prompt)
    cap_in = int(_setting("AI_MAX_INPUT_TOKENS_PER_CALL", 120_000))
    if in_tok > cap_in:
        raise InputTooLarge("Ngữ cảnh gửi cho mô hình AI vượt giới hạn cho phép.",
                            {"input_tokens": in_tok, "limit": cap_in})
    out_tok = max_output_tokens(max_tokens)
    worst = worst_case_usd(model, in_tok, out_tok)
    call_id = str(uuid.uuid4())
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    checks: list[tuple[str, str, dict, float]] = [
        ("global", "created_at >= :since", {"since": since}, _setting("AI_GLOBAL_USD_PER_DAY", 25.0)),
    ]
    if b.user_id:
        checks.append(("user", "user_id = :u AND created_at >= :since", {"u": str(b.user_id), "since": since},
                       _setting("AI_USER_USD_PER_DAY", 2.0)))
    if b.link_id is not None:
        checks.append(("link", "link_id = :l AND created_at >= :since", {"l": int(b.link_id), "since": since},
                       float(b.link_usd_per_day or 0) or _setting("AI_DEFAULT_BUDGET_USD_PER_DAY", 1.0)))
    try:
        with _engine().begin() as conn:
            if conn.dialect.name == "postgresql":
                keys = ["ai:global"]
                if b.user_id:
                    keys.append(f"ai:user:{b.user_id}")
                if b.link_id is not None:
                    keys.append(f"ai:link:{b.link_id}")
                if b.turn_ref:
                    keys.append(f"ai:turn:{b.turn_ref}")
                for k in sorted(keys):  # sorted: two calls never lock the same scopes in opposite orders
                    conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": k})
            for scope, where, params, limit in checks:
                used = _used(conn, where, params)
                if used + worst > limit:
                    raise AiBudgetExceeded(_MSG[scope], {"scope": scope, "limit_usd": round(limit, 4),
                                                         "used_usd": round(used, 4)})
            if b.turn_ref:
                calls = int(conn.execute(text(
                    "SELECT COUNT(*) FROM ai_usage_ledger WHERE turn_ref = :t AND status <> 'released'"),
                    {"t": b.turn_ref}).scalar() or 0)
                max_calls = int(_setting("AI_MAX_MODEL_CALLS_PER_TURN", 8))
                if calls >= max_calls:
                    raise AiBudgetExceeded(_MSG["turn_calls"], {"scope": "turn_calls", "limit": max_calls})
                turn_used = _used(conn, "turn_ref = :t", {"t": b.turn_ref})
                turn_cap = _setting("AI_MAX_USD_PER_TURN", 0.5)
                if turn_used + worst > turn_cap:
                    raise AiBudgetExceeded(_MSG["turn_usd"], {"scope": "turn_usd", "limit_usd": turn_cap})
            conn.execute(text(
                "INSERT INTO ai_usage_ledger (call_id, purpose, status, provider, model, user_id, link_id, turn_ref, "
                "credential_ref, reserved_usd, created_at) VALUES (:c, :p, 'reserved', :pr, :m, :u, :l, :t, :cr, :r, "
                ":now)"),
                {"c": call_id, "p": b.purpose[:40], "pr": provider[:20], "m": (model or "")[:120],
                 "u": str(b.user_id) if b.user_id else None, "l": b.link_id, "t": b.turn_ref,
                 "cr": (b.credential.ref if b.credential else "server")[:40], "r": worst,
                 "now": datetime.now(timezone.utc)})
    except AiPolicyRefused:
        raise
    except Exception as ex:  # noqa: BLE001 - fail closed: the call is not made
        logger.warning("[ai_runtime] budget ledger unavailable (%s) - refusing a paid call", type(ex).__name__)
        raise BudgetUnavailable("Chưa kiểm tra được hạn mức chi phí AI nên chưa gọi mô hình; hãy thử lại sau.",
                                {"error": type(ex).__name__}) from ex
    return Reservation(call_id=call_id, provider=provider, model=model or "", reserved_usd=worst, max_tokens=out_tok)


def settle(res: Optional[Reservation], usage: Optional[Mapping[str, Any]] = None, *,
           error: Optional[str] = None) -> None:
    """Replace the reservation by the reported usage; with no usage after a sent
    request, keep the worst case (`unknown`). Never raises."""
    from sqlalchemy import text

    if res is None:
        return
    try:
        if usage and has_usage(usage):
            usd, tin, tout = usage_usd(res.model, usage)
            status, actual = "settled", usd
        else:
            status, actual, tin, tout = "unknown", res.reserved_usd, None, None
        with _engine().begin() as conn:
            conn.execute(text(
                "UPDATE ai_usage_ledger SET status = :s, actual_usd = :a, input_tokens = :i, output_tokens = :o, "
                "error = :e, settled_at = :now WHERE call_id = :c AND status = 'reserved'"),
                {"s": status, "a": actual, "i": tin, "o": tout, "e": (error or None) and str(error)[:80],
                 "now": datetime.now(timezone.utc), "c": res.call_id})
    except Exception:  # noqa: BLE001 - the reservation stays at its worst case
        logger.warning("[ai_runtime] settle failed for %s; the worst case stays reserved", res.call_id)


def release(res: Optional[Reservation]) -> None:
    """Nothing was sent (refused before the request): the reservation is freed."""
    from sqlalchemy import text

    if res is None:
        return
    try:
        with _engine().begin() as conn:
            conn.execute(text("UPDATE ai_usage_ledger SET status = 'released', actual_usd = 0, settled_at = :now "
                              "WHERE call_id = :c AND status = 'reserved'"),
                         {"now": datetime.now(timezone.utc), "c": res.call_id})
    except Exception:  # noqa: BLE001
        logger.warning("[ai_runtime] release failed for %s", res.call_id)


def turn_usd(turn_ref: str) -> float:
    """What one turn has cost so far (settled or worst case)."""
    try:
        with _engine().connect() as conn:
            return _used(conn, "turn_ref = :t", {"t": turn_ref})
    except Exception:  # noqa: BLE001
        return 0.0


# ── credentials ──────────────────────────────────────────────────────────────

def server_credentials() -> list[Credential]:
    """The deployment's provider keys, in fallback order (server environment)."""
    from app.core.config import settings

    out = []
    for provider, attr in (("openai", "OPENAI_API_KEY"), ("gemini", "GEMINI_API_KEY"),
                           ("anthropic", "ANTHROPIC_API_KEY")):
        key = str(getattr(settings, attr, "") or "").strip()
        if key:
            out.append(Credential(provider=provider, key=key, ref="server"))
    return out


def link_credential(db, appearance_config: Optional[dict]) -> Optional[Credential]:
    """A public link's own key, from the encrypted store - never from the link's JSON."""
    cred_id = (appearance_config or {}).get("ai_bot_credential_id")
    if not cred_id:
        return None
    try:
        from app.core.crypto import decrypt_value
        from app.models.ai_provider_credential import AiProviderCredential

        row = db.get(AiProviderCredential, int(cred_id))
        if row is None or row.deleted_at is not None or not row.secret_enc:
            return None
        key = decrypt_value(row.secret_enc)
        if not key:
            return None
        return Credential(provider=str(row.provider), key=str(key), ref=f"credential:{row.id}")
    except Exception:  # noqa: BLE001 - an unreadable key is no key; the server's applies
        logger.warning("[ai_runtime] link credential %s unreadable", cred_id)
        return None


def readiness(db, appearance_config: Optional[dict] = None) -> dict:
    """What a publisher may know: is a model ready, whose key pays. No secret."""
    own = link_credential(db, appearance_config) if appearance_config else None
    server = server_credentials()
    if own is not None:
        return {"ready": True, "provider": own.provider, "credential": "link"}
    if server:
        return {"ready": True, "provider": server[0].provider, "credential": "server"}
    return {"ready": False, "provider": None, "credential": None}
