"""A hard spending cap for AI calls made while TESTING (off unless configured).

PO policy: every paid model call made for testing AppBI counts against ONE
budget (MAX_AI_TEST_BUDGET_USD), checked BEFORE the call with a worst-case
reservation, and recorded AFTER it with the provider's own token counts.

Configured by settings (never on in production; refused there):
  LLM_TEST_BUDGET_USD   the cap, e.g. 5.00. Empty = this module is inert.
  LLM_TEST_LEDGER_PATH  JSONL ledger of every call (shared by every process).
  LLM_TEST_PRICES_JSON  {"<model id>": [input, cached_input, output] USD per 1M
                        tokens} from the provider's published pricing. A model
                        with no price is NOT called: a cost that cannot be
                        bounded is not spent.
Each call also records its purpose / test case id / RC sha (contextvars set by
the harness through HTTP headers) and the raw JSON output, which later serves
as a replay fixture so the same plan is never bought twice.
"""
from __future__ import annotations

import contextvars
import datetime as _dt
import json
import os
import threading
from typing import Any, Optional

PURPOSE: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_purpose", default="")
CASE_ID: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_case", default="")
RC_SHA: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_rc", default="")
QUESTION: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_question", default="")
FOLLOWUP: contextvars.ContextVar[bool] = contextvars.ContextVar("llm_test_followup", default=False)

_LOCK = threading.Lock()
#: an UPPER bound, not an average: a token is never shorter than one character,
#: plus the chat format's per-message overhead.
CHARS_PER_TOKEN_FLOOR = 1.0
MESSAGE_OVERHEAD_TOKENS = 64


class BudgetRefused(RuntimeError):
    """The call was not made: its worst case does not fit the remaining budget."""


def _settings():
    from app.core.config import settings

    return settings


def active() -> bool:
    return bool(str(getattr(_settings(), "LLM_TEST_BUDGET_USD", "") or "").strip())


def _prices() -> dict:
    raw = getattr(_settings(), "LLM_TEST_PRICES_JSON", "") or "{}"
    return json.loads(raw) if isinstance(raw, str) else dict(raw)


def _ledger_path() -> str:
    return str(getattr(_settings(), "LLM_TEST_LEDGER_PATH", "") or "")


def _spent_and_reserved(path: str) -> tuple[float, float]:
    spent = reserved = 0.0
    if not path or not os.path.exists(path):
        return 0.0, 0.0
    open_res: dict[str, float] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("kind") == "reserve":
                open_res[row["id"]] = float(row["worst_case_usd"])
            elif row.get("kind") == "settle":
                open_res.pop(row["id"], None)
                spent += float(row.get("cost_usd") or 0)
    reserved = sum(open_res.values())
    return spent, reserved


def _append(path: str, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def reserve(provider: str, model: str, system: str, prompt: str, max_tokens: int) -> Optional[str]:
    """Reserve the worst case of one call or raise BudgetRefused. None = inert."""
    if not active():
        return None
    if str(getattr(_settings(), "ENVIRONMENT", "") or "").lower() == "production":
        raise BudgetRefused("the test budget controller is not for production")
    price = _prices().get(model)
    if not price:
        raise BudgetRefused(f"no verified price for {provider}:{model}; not called")
    cap = float(getattr(_settings(), "LLM_TEST_BUDGET_USD"))
    in_tokens = (len(system or "") + len(prompt or "")) / CHARS_PER_TOKEN_FLOOR + MESSAGE_OVERHEAD_TOKENS
    worst = in_tokens * float(price[0]) / 1e6 + int(max_tokens) * float(price[2]) / 1e6
    path = _ledger_path()
    import uuid

    rid = uuid.uuid4().hex
    with _LOCK:
        spent, reserved = _spent_and_reserved(path)
        if spent + reserved + worst > cap:
            _append(path, {"kind": "refused", "id": rid, "ts": _dt.datetime.utcnow().isoformat(),
                           "provider": provider, "model": model, "worst_case_usd": worst,
                           "spent_usd": spent, "reserved_usd": reserved, "cap_usd": cap,
                           "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get()})
            raise BudgetRefused(f"budget: spent {spent:.4f} + reserved {reserved:.4f} + worst {worst:.4f} > {cap}")
        _append(path, {"kind": "reserve", "id": rid, "ts": _dt.datetime.utcnow().isoformat(),
                       "provider": provider, "model": model, "worst_case_usd": worst,
                       "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get()})
    return rid


def settle(rid: Optional[str], provider: str, model: str, usage: dict, raw: Any = None,
           model_returned: str = "", error: str = "") -> None:
    """Record what the provider says was used; the reservation is released."""
    if rid is None:
        return
    price = _prices().get(model) or [0, 0, 0]
    pin = int(usage.get("prompt_tokens") or 0)
    cached = int(((usage.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
    pout = int(usage.get("completion_tokens") or 0)
    cost = (pin - cached) * float(price[0]) / 1e6 + cached * float(price[1]) / 1e6 + pout * float(price[2]) / 1e6
    with _LOCK:
        _append(_ledger_path(), {"kind": "settle", "id": rid, "ts": _dt.datetime.utcnow().isoformat(),
                                 "provider": provider, "model": model, "model_returned": model_returned,
                                 "input_tokens": pin, "cached_input_tokens": cached, "output_tokens": pout,
                                 "cost_usd": cost, "error": error, "measured": bool(usage),
                                 "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get(),
                                 "question": QUESTION.get(), "followup": FOLLOWUP.get(), "raw": raw})


def replay_lookup(question: str, followup: bool) -> Optional[dict]:
    """The recorded planner output for this exact question (and follow-up-ness),
    from the replay file, or None. Refused in production."""
    s = _settings()
    path = str(getattr(s, "ANALYST_PLANNER_REPLAY_PATH", "") or "")
    if not path:
        return None
    if str(getattr(s, "ENVIRONMENT", "") or "").lower() == "production":
        raise BudgetRefused("planner replay is not for production")
    hit = None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("question") == question and bool(row.get("followup")) == bool(followup) \
                    and isinstance(row.get("raw"), dict):
                hit = row["raw"]  # the last recording wins
    return hit
