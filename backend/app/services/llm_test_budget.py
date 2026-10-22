"""A hard spending cap for AI calls made while TESTING (off unless configured).

PO policy: every paid model call made for testing AppBI counts against ONE
budget (MAX_AI_TEST_BUDGET_USD), checked BEFORE the call with a worst-case
reservation, and recorded AFTER it with the provider's own token counts.

Configured by settings (never on in production; refused there):
  LLM_TEST_BUDGET_USD   the cap, e.g. 5.00. Empty = this module is inert.
  LLM_TEST_LEDGER_PATH  JSONL ledger of every call - ONE file shared by every
                        process, container and runner (a bind mount); the cap
                        holds across all of them.
  LLM_TEST_PRICES_JSON  {"<model id>": [input, cached_input, output] USD per 1M
                        tokens} from the provider's published pricing. A model
                        with no price is NOT called: a cost that cannot be
                        bounded is not spent.

Guarantees (tests: tests/test_llm_test_budget.py):
  * check-and-reserve is atomic ACROSS PROCESSES: a lock directory next to the
    ledger (mkdir is atomic on every filesystem the runners share, including
    Docker bind mounts from Windows, where flock is not reliable);
  * a reservation is written to disk BEFORE the call and stays counted at its
    worst case until it is settled: a crash, restart or kill never frees budget;
  * a call whose cost is not evidenced (error, timeout, no usage in the
    response) is recorded as UNKNOWN and counted at its worst case; only
    `reconcile` with usage/billing evidence replaces that figure;
  * while a budget is active, every HTTP request to a paid AI host that is not
    inside a metered call is refused (`install_guard`), and the providers whose
    SDKs bypass that HTTP layer have their keys cleared - no paid path is
    left outside the controller.
Each call also records its purpose / test case id / RC sha (contextvars set by
the harness through HTTP headers) and the raw JSON output, which later serves
as a replay fixture so the same plan is never bought twice.
"""
from __future__ import annotations

import contextlib
import contextvars
import datetime as _dt
import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Optional

logger = logging.getLogger(__name__)

PURPOSE: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_purpose", default="")
CASE_ID: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_case", default="")
RC_SHA: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_rc", default="")
QUESTION: contextvars.ContextVar[str] = contextvars.ContextVar("llm_test_question", default="")
FOLLOWUP: contextvars.ContextVar[bool] = contextvars.ContextVar("llm_test_followup", default=False)
#: set only around the provider request of a call that holds a reservation
METERED: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("llm_test_metered", default=None)

_LOCK = threading.Lock()  # threads of THIS process; the lock directory covers other processes
#: an UPPER bound, not an average: a token is never shorter than one character,
#: plus the chat format's per-message overhead.
CHARS_PER_TOKEN_FLOOR = 1.0
MESSAGE_OVERHEAD_TOKENS = 64
LOCK_TIMEOUT_SECONDS = 30.0
#: a lock directory older than this was left by a process that died mid-section
#: (the section itself is a read and an append: milliseconds)
LOCK_STALE_SECONDS = 120.0
#: provider hosts whose requests cost money
PAID_HOSTS = frozenset({"api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"})
#: free metadata reads (key validation lists models; it bills nothing)
_FREE_PATH_PREFIXES = ("/v1/models", "/v1beta/models")


class BudgetRefused(RuntimeError):
    """The call was not made: its worst case does not fit the remaining budget,
    or it could not be metered."""


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


@contextlib.contextmanager
def _ledger_lock(path: str):
    """Exclusive across threads AND processes sharing the ledger file."""
    lockdir = path + ".lock"
    with _LOCK:
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        while True:
            try:
                os.mkdir(lockdir)
                break
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(lockdir) > LOCK_STALE_SECONDS:
                        os.rmdir(lockdir)  # its holder died inside the section
                        continue
                except OSError:
                    continue
                if time.monotonic() > deadline:
                    raise BudgetRefused("budget ledger is locked by another runner; not called")
                time.sleep(0.01)
        try:
            yield
        finally:
            try:
                os.rmdir(lockdir)
            except OSError:
                pass


def ledger_state(path: Optional[str] = None) -> dict:
    """{spent, reserved, unknown, calls}: spent = measured cost of settled calls
    plus the worst case of UNKNOWN ones; reserved = open reservations' worst case.
    Everything not evidenced is counted at its worst case."""
    path = path or _ledger_path()
    worst: dict[str, float] = {}
    final: dict[str, tuple[str, float]] = {}
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                kind, rid = row.get("kind"), row.get("id")
                if kind == "reserve":
                    worst[rid] = float(row["worst_case_usd"])
                elif kind == "settle":
                    final[rid] = ("measured", float(row.get("cost_usd") or 0))
                elif kind == "unknown":
                    final[rid] = ("unknown", float(row.get("cost_usd") or worst.get(rid, 0)))
                elif kind == "reconcile" and rid in final:
                    final[rid] = ("measured", float(row.get("cost_usd") or 0))
    spent = sum(c for _, c in final.values())
    reserved = sum(w for rid, w in worst.items() if rid not in final)
    unknown = sum(c for state, c in final.values() if state == "unknown")
    return {"spent": spent, "reserved": reserved, "unknown": unknown, "calls": len(final),
            "open": sum(1 for rid in worst if rid not in final)}


def _spent_and_reserved(path: str) -> tuple[float, float]:
    st = ledger_state(path)
    return st["spent"], st["reserved"]


def _append(path: str, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())  # a reservation survives a crash right after it


def _now() -> str:
    return _dt.datetime.utcnow().isoformat()


def worst_case_usd(model: str, system: str, prompt: str, max_tokens: int) -> float:
    price = _prices().get(model)
    if not price:
        raise BudgetRefused(f"no verified price for {model}; not called")
    in_tokens = (len(system or "") + len(prompt or "")) / CHARS_PER_TOKEN_FLOOR + MESSAGE_OVERHEAD_TOKENS
    return in_tokens * float(price[0]) / 1e6 + int(max_tokens) * float(price[2]) / 1e6


def reserve(provider: str, model: str, system: str, prompt: str, max_tokens: int) -> Optional[str]:
    """Reserve the worst case of one call or raise BudgetRefused. None = inert."""
    if not active():
        return None
    if str(getattr(_settings(), "ENVIRONMENT", "") or "").lower() == "production":
        raise BudgetRefused("the test budget controller is not for production")
    path = _ledger_path()
    if not path:
        raise BudgetRefused("a test budget needs LLM_TEST_LEDGER_PATH; not called")
    cap = float(getattr(_settings(), "LLM_TEST_BUDGET_USD"))
    worst = worst_case_usd(model, system, prompt, max_tokens)
    rid = uuid.uuid4().hex
    with _ledger_lock(path):
        spent, reserved = _spent_and_reserved(path)
        if spent + reserved + worst > cap:
            _append(path, {"kind": "refused", "id": rid, "ts": _now(),
                           "provider": provider, "model": model, "worst_case_usd": worst,
                           "spent_usd": spent, "reserved_usd": reserved, "cap_usd": cap,
                           "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get()})
            raise BudgetRefused(f"budget: spent {spent:.4f} + reserved {reserved:.4f} + worst {worst:.4f} > {cap}")
        _append(path, {"kind": "reserve", "id": rid, "ts": _now(),
                       "provider": provider, "model": model, "worst_case_usd": worst, "pid": os.getpid(),
                       "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get()})
    return rid


def _worst_of(path: str, rid: str) -> float:
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if rid in line:
                row = json.loads(line)
                if row.get("kind") == "reserve" and row.get("id") == rid:
                    return float(row["worst_case_usd"])
    return 0.0


def settle(rid: Optional[str], provider: str, model: str, usage: dict, raw: Any = None,
           model_returned: str = "", error: str = "") -> None:
    """Record what the provider says was used. Without usage evidence (an error, a
    timeout, a response with no usage) the call is UNKNOWN and keeps its worst case."""
    if rid is None:
        return
    path = _ledger_path()
    common = {"id": rid, "ts": _now(), "provider": provider, "model": model, "model_returned": model_returned,
              "error": error, "purpose": PURPOSE.get(), "case": CASE_ID.get(), "rc": RC_SHA.get(),
              "question": QUESTION.get(), "followup": FOLLOWUP.get(), "raw": raw}
    has_usage = bool(usage) and ("prompt_tokens" in usage or "completion_tokens" in usage) and not error
    with _ledger_lock(path):
        if not has_usage:
            worst = _worst_of(path, rid)
            _append(path, {"kind": "unknown", **common, "cost_usd": worst, "measured": False,
                           "worst_case_usd": worst})
            return
        price = _prices().get(model) or [0, 0, 0]
        pin = int(usage.get("prompt_tokens") or 0)
        cached = int(((usage.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        pout = int(usage.get("completion_tokens") or 0)
        cost = (pin - cached) * float(price[0]) / 1e6 + cached * float(price[1]) / 1e6 + pout * float(price[2]) / 1e6
        _append(path, {"kind": "settle", **common, "input_tokens": pin, "cached_input_tokens": cached,
                       "output_tokens": pout, "cost_usd": cost, "measured": True})


def reconcile(rid: str, model: str, usage: dict, evidence: str) -> float:
    """Replace an UNKNOWN call's worst case by its measured cost, given usage or
    billing evidence (e.g. the provider's usage export row). Returns the cost."""
    if not evidence or not usage:
        raise ValueError("reconciliation needs usage and the evidence it came from")
    price = _prices().get(model) or [0, 0, 0]
    pin = int(usage.get("prompt_tokens") or 0)
    cached = int(usage.get("cached_tokens") or 0)
    pout = int(usage.get("completion_tokens") or 0)
    cost = (pin - cached) * float(price[0]) / 1e6 + cached * float(price[1]) / 1e6 + pout * float(price[2]) / 1e6
    path = _ledger_path()
    with _ledger_lock(path):
        _append(path, {"kind": "reconcile", "id": rid, "ts": _now(), "model": model, "input_tokens": pin,
                       "cached_input_tokens": cached, "output_tokens": pout, "cost_usd": cost,
                       "evidence": str(evidence)[:500]})
    return cost


@contextlib.contextmanager
def metered(rid: Optional[str]):
    """Marks the provider request of a reserved call as metered (see install_guard)."""
    token = METERED.set(rid)
    try:
        yield
    finally:
        METERED.reset(token)


def _check_request(url) -> None:
    host = getattr(url, "host", "") or ""
    path = getattr(url, "path", "") or ""
    if host in PAID_HOSTS and not path.startswith(_FREE_PATH_PREFIXES) and not METERED.get():
        raise BudgetRefused(f"unmetered paid AI request to {host} refused while a test budget is active")


_INSTALLED = False


def install_guard() -> bool:
    """While a test budget is active: refuse every unmetered request to a paid AI
    host (all provider code in this backend uses httpx), and clear the keys of the
    providers whose SDKs do not go through httpx. Idempotent; inert without a budget."""
    global _INSTALLED
    if not active() or _INSTALLED:
        return _INSTALLED
    import httpx

    orig_send, orig_asend = httpx.Client.send, httpx.AsyncClient.send

    def send(self, request, *a, **k):
        _check_request(request.url)
        return orig_send(self, request, *a, **k)

    async def asend(self, request, *a, **k):
        _check_request(request.url)
        return await orig_asend(self, request, *a, **k)

    httpx.Client.send, httpx.AsyncClient.send = send, asend
    s = _settings()
    for key in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
        if str(getattr(s, key, "") or "").strip():
            logger.warning("test budget active: %s cleared (its SDK path cannot be metered)", key)
            setattr(s, key, "")
    _INSTALLED = True
    return True


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
