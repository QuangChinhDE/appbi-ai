"""The test-only AI spending cap (services/llm_test_budget.py) and planner replay.

PO policy: one cumulative budget; a worst-case reservation BEFORE every paid call;
no call when the model has no verified price, when the reservation does not fit,
or in production; no fallback to another provider under a budget; every call
recorded with the provider's own token counts; a call that errors after sending
is settled at its worst case. No network: httpx is replaced.
"""
from __future__ import annotations

import json

import pytest

from app.services import llm_client, llm_test_budget as B

PRICES = {"gpt-4o-mini": [0.15, 0.075, 0.60]}


@pytest.fixture()
def budget(tmp_path, monkeypatch):
    from app.core.config import settings

    ledger = tmp_path / "ledger.jsonl"
    monkeypatch.setattr(settings, "LLM_TEST_BUDGET_USD", "0.01", raising=False)
    monkeypatch.setattr(settings, "LLM_TEST_LEDGER_PATH", str(ledger), raising=False)
    monkeypatch.setattr(settings, "LLM_TEST_PRICES_JSON", json.dumps(PRICES), raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-test", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "g-test", raising=False)
    return ledger


class _Resp:
    def __init__(self, usage):
        self._usage = usage

    def raise_for_status(self):
        return None

    def json(self):
        return {"model": "gpt-4o-mini-2024-07-18", "usage": self._usage,
                "choices": [{"message": {"content": '{"status": "plan"}'}}]}


def _rows(ledger):
    return [json.loads(l) for l in ledger.read_text(encoding="utf-8").splitlines()]


def test_a_call_is_reserved_then_settled_with_the_providers_tokens(budget, monkeypatch):
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: _Resp(
        {"prompt_tokens": 1000, "completion_tokens": 100, "prompt_tokens_details": {"cached_tokens": 400}}))
    B.CASE_ID.set("C1")
    assert llm_client.LLMClient.complete_json("p" * 1200, system="s", max_tokens=200) == {"status": "plan"}
    reserve, settle = _rows(budget)
    assert reserve["kind"] == "reserve" and settle["kind"] == "settle" and settle["id"] == reserve["id"]
    assert settle["model_returned"] == "gpt-4o-mini-2024-07-18" and settle["case"] == "C1"
    assert settle["cost_usd"] == pytest.approx((600 * 0.15 + 400 * 0.075 + 100 * 0.60) / 1e6)
    assert reserve["worst_case_usd"] >= settle["cost_usd"]


def test_no_call_when_the_worst_case_does_not_fit(budget, monkeypatch):
    calls = []
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: calls.append(1) or _Resp({}))
    # 0.01 USD cap; 20,000 output tokens at 0.60/M = 0.012 > cap
    assert llm_client.LLMClient.complete_json("p", system="s", max_tokens=20000) is None
    assert calls == []                                   # nothing sent, and no fallback to Gemini
    assert _rows(budget)[-1]["kind"] == "refused"


def test_a_model_without_a_verified_price_is_never_called(budget, monkeypatch):
    calls = []
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: calls.append(1) or _Resp({}))
    with pytest.raises(B.BudgetRefused):
        B.reserve("openai", "gpt-unknown", "s", "p", 10)
    assert calls == []


def test_an_error_after_sending_is_unknown_and_charged_at_its_worst_case(budget, monkeypatch):
    # PO 2026-10-22: a timeout has no usage evidence - its cost is UNKNOWN, counted
    # at the reservation's worst case (not a computed estimate, never zero).
    def boom(*a, **k):
        raise llm_client.httpx.ReadTimeout("t")

    monkeypatch.setattr(llm_client.httpx, "post", boom)
    assert llm_client.LLMClient.complete_json("p" * 10, system="s", max_tokens=100) is None
    reserve = [r for r in _rows(budget) if r["kind"] == "reserve"][0]
    unknown = [r for r in _rows(budget) if r["kind"] == "unknown"][0]
    assert unknown["error"] == "ReadTimeout" and unknown["measured"] is False
    assert unknown["cost_usd"] == pytest.approx(reserve["worst_case_usd"])
    assert B.ledger_state(str(budget))["spent"] == pytest.approx(reserve["worst_case_usd"])


def test_the_budget_is_cumulative_across_calls(budget, monkeypatch):
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: _Resp(
        {"prompt_tokens": 4000, "completion_tokens": 3000}))
    results = [llm_client.LLMClient.complete_json("p", system="s", max_tokens=3000) for _ in range(10)]
    spent = sum(r["cost_usd"] for r in _rows(budget) if r["kind"] == "settle")
    assert spent <= 0.01 and results.count(None) > 0     # stopped before the cap, not after


def test_production_refuses_the_controller(budget, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "production", raising=False)
    with pytest.raises(B.BudgetRefused):
        B.reserve("openai", "gpt-4o-mini", "s", "p", 10)


def test_inert_without_a_budget(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "LLM_TEST_BUDGET_USD", "", raising=False)
    assert B.reserve("openai", "anything", "s", "p", 10) is None


def test_the_planner_replays_a_recorded_output_without_calling_a_model(tmp_path, monkeypatch):
    from app.core.config import settings
    from app.services.data_core import planner
    from tests.test_analyst_planner import _explore

    path = tmp_path / "replay.jsonl"
    path.write_text(json.dumps({"question": "Doanh thu?", "followup": False, "raw": {
        "status": "plan", "explore_id": 7, "dimensions": [], "measures": ["items.revenue"]}}) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "ANALYST_PLANNER_REPLAY_PATH", str(path), raising=False)
    monkeypatch.setattr(settings, "ENVIRONMENT", "test", raising=False)
    boom = lambda *a, **k: pytest.fail("a model was called in replay mode")  # noqa: E731
    out = planner.plan("Doanh thu?", [_explore()], complete=boom)
    assert isinstance(out, planner.Plan) and out.measures == ["items.revenue"]
    miss = planner.plan("Câu khác?", [_explore()], complete=boom)
    assert isinstance(miss, planner.Unsupported)


# ── PO 2026-10-22: the cap must hold across processes, crashes and every paid path ──

def _child_reserve(ledger, n, out):
    """One runner process: try n reservations against the SHARED ledger."""
    import json as _json

    from app.core.config import settings
    from app.services import llm_test_budget as b

    settings.LLM_TEST_BUDGET_USD = "0.05"
    settings.LLM_TEST_LEDGER_PATH = ledger
    settings.LLM_TEST_PRICES_JSON = _json.dumps({"m": [0.0, 0.0, 1000.0]})  # 10 output tokens = 0.01 USD
    settings.ENVIRONMENT = "test"
    ok = 0
    try:
        for _ in range(n):
            try:
                b.reserve("openai", "m", "", "", 10)
                ok += 1
            except b.BudgetRefused:
                pass
    except Exception as exc:  # a runner crash is a test failure, never a silent 0
        out.put(f"error: {exc!r}")
        return
    out.put(ok)


def test_concurrent_processes_never_reserve_past_the_cap(tmp_path):
    import multiprocessing as mp

    ledger = str(tmp_path / "shared.jsonl")
    ctx = mp.get_context("spawn")
    out = ctx.Queue()
    procs = [ctx.Process(target=_child_reserve, args=(ledger, 5, out)) for _ in range(6)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(120)
    results = [out.get(timeout=60) for _ in procs]
    assert all(isinstance(r, int) for r in results), results
    granted = sum(results)
    state = B.ledger_state(ledger)
    # cap 0.05, each worst case 0.01 (+ the empty prompt's overhead at price 0): exactly 5 fit
    assert granted == 5 and state["open"] == 5 and state["reserved"] == pytest.approx(0.05)


def test_an_unsettled_reservation_survives_a_restart(budget, monkeypatch):
    rid = B.reserve("openai", "gpt-4o-mini", "s", "p" * 100, 100)  # the process then "dies"
    assert rid
    # a fresh process reads the same ledger: the reservation still counts
    state = B.ledger_state(str(budget))
    assert state["open"] == 1 and state["reserved"] > 0


def test_a_response_without_usage_is_unknown_not_free(budget, monkeypatch):
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: _Resp(None))
    assert llm_client.LLMClient.complete_json("p" * 10, system="s", max_tokens=100) == {"status": "plan"}
    rows = _rows(budget)
    assert rows[-1]["kind"] == "unknown" and rows[-1]["cost_usd"] == pytest.approx(rows[0]["worst_case_usd"])
    assert B.ledger_state(str(budget))["unknown"] > 0


def test_only_evidence_reconciles_an_unknown_cost(budget, monkeypatch):
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: _Resp(None))
    llm_client.LLMClient.complete_json("p" * 10, system="s", max_tokens=100)
    rid = _rows(budget)[0]["id"]
    with pytest.raises(ValueError):
        B.reconcile(rid, "gpt-4o-mini", {"prompt_tokens": 20, "completion_tokens": 5}, evidence="")
    before = B.ledger_state(str(budget))["spent"]
    cost = B.reconcile(rid, "gpt-4o-mini", {"prompt_tokens": 20, "completion_tokens": 5},
                       evidence="usage export row 2026-10-22")
    after = B.ledger_state(str(budget))
    assert after["spent"] == pytest.approx(cost) and cost < before and after["unknown"] == 0


def test_an_unmetered_paid_request_is_refused_while_a_budget_is_active(budget, monkeypatch):
    import httpx

    from app.core.config import settings

    monkeypatch.setattr(httpx.Client, "send", httpx.Client.send)          # restored after the test
    monkeypatch.setattr(httpx.AsyncClient, "send", httpx.AsyncClient.send)
    monkeypatch.setattr(B, "_INSTALLED", False)
    assert B.install_guard() is True
    assert settings.GEMINI_API_KEY == "" and settings.ANTHROPIC_API_KEY == ""   # SDK paths cannot run
    ok = httpx.MockTransport(lambda req: httpx.Response(200, json={}))
    with httpx.Client(transport=ok) as c:
        with pytest.raises(B.BudgetRefused):                              # e.g. embeddings, OCR, AI bot
            c.post("https://api.openai.com/v1/embeddings", json={})
        with pytest.raises(B.BudgetRefused):
            c.post("https://api.anthropic.com/v1/messages", json={})
        assert c.get("https://api.openai.com/v1/models").status_code == 200   # free key check
        assert c.get("http://localhost/health").status_code == 200           # not a provider
        with B.metered("rid-1"):
            assert c.post("https://api.openai.com/v1/chat/completions", json={}).status_code == 200


def test_the_guard_is_inert_without_a_budget(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "LLM_TEST_BUDGET_USD", "", raising=False)
    monkeypatch.setattr(B, "_INSTALLED", False)
    assert B.install_guard() is False
