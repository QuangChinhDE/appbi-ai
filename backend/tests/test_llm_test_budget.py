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


def test_an_error_after_sending_is_charged_at_its_worst_case(budget, monkeypatch):
    def boom(*a, **k):
        raise llm_client.httpx.ReadTimeout("t")

    monkeypatch.setattr(llm_client.httpx, "post", boom)
    assert llm_client.LLMClient.complete_json("p" * 10, system="s", max_tokens=100) is None
    settle = [r for r in _rows(budget) if r["kind"] == "settle"][0]
    assert settle["error"] == "ReadTimeout" and settle["cost_usd"] > 0 and settle["measured"] is True


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
    from app.services.analyst import planner
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
