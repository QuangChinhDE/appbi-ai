"""THE Model Gateway: every paid model call reserves its worst case first, settles
with the reported usage, and is refused - before anything is sent - when a ceiling
would be crossed or the ledger cannot be read (services/ai_runtime/gateway.py).

Runs on an in-memory SQLite ledger (the advisory locks are PostgreSQL-only; the
concurrency of reservations is locked on PostgreSQL by the ledger_pg suite and the
acceptance run). No provider is called here.
"""
from __future__ import annotations

import pytest
import sqlalchemy as sa


@pytest.fixture()
def ledger(monkeypatch):
    from app.models.ai_runtime import AiUsageLedger
    from app.services.ai_runtime import gateway

    engine = sa.create_engine("sqlite://", poolclass=sa.pool.StaticPool,
                              connect_args={"check_same_thread": False})
    AiUsageLedger.__table__.create(engine)
    monkeypatch.setattr(gateway, "_engine", lambda: engine)
    from app.core.config import settings

    for name, value in (("AI_GLOBAL_USD_PER_DAY", 10.0), ("AI_USER_USD_PER_DAY", 1.0),
                        ("AI_DEFAULT_BUDGET_USD_PER_DAY", 1.0), ("AI_MAX_MODEL_CALLS_PER_TURN", 3),
                        ("AI_MAX_USD_PER_TURN", 0.5), ("AI_MAX_OUTPUT_TOKENS_PER_CALL", 1000),
                        ("AI_MAX_INPUT_TOKENS_PER_CALL", 50_000)):
        monkeypatch.setattr(settings, name, value, raising=False)
    return engine


def _rows(engine):
    with engine.connect() as c:
        return [dict(r._mapping) for r in c.execute(sa.text("SELECT * FROM ai_usage_ledger ORDER BY id"))]


def test_a_call_reserves_its_worst_case_and_settles_with_the_reported_usage(ledger):
    from app.services.ai_runtime import gateway

    with gateway.billing(gateway.Billing(purpose="public_core", link_id=7, turn_ref="t1")):
        res = gateway.authorize("openai", "gpt-4o-mini", "system", "hello " * 100, 900)
    row = _rows(ledger)[0]
    assert row["status"] == "reserved" and row["reserved_usd"] > 0 and row["link_id"] == 7
    assert row["credential_ref"] == "server" and "hello" not in str(row)  # no prompt in the ledger
    gateway.settle(res, {"prompt_tokens": 120, "completion_tokens": 40})
    row = _rows(ledger)[0]
    assert row["status"] == "settled" and 0 < row["actual_usd"] < row["reserved_usd"]
    assert (row["input_tokens"], row["output_tokens"]) == (120, 40)


def test_output_tokens_are_clamped_to_the_policy_cap(ledger):
    from app.services.ai_runtime import gateway

    res = gateway.authorize("openai", "gpt-4o-mini", "s", "p", 100_000)
    assert res.max_tokens == 1000


def test_a_link_over_its_ceiling_is_refused_before_anything_is_sent(ledger):
    from app.services.ai_runtime import gateway

    with ledger.begin() as c:
        c.execute(sa.text("INSERT INTO ai_usage_ledger (call_id, purpose, status, link_id, reserved_usd, actual_usd, "
                          "created_at) VALUES ('x', 'public_core', 'settled', 7, 1.0, 0.999, :now)"),
                  {"now": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)})
    with gateway.billing(gateway.Billing(purpose="public_core", link_id=7, link_usd_per_day=1.0)):
        with pytest.raises(gateway.AiBudgetExceeded) as ex:
            gateway.authorize("openai", "gpt-4o", "s", "p" * 4000, 1000)
    assert ex.value.detail["scope"] == "link"
    # another link is not affected
    with gateway.billing(gateway.Billing(purpose="public_core", link_id=8, link_usd_per_day=1.0)):
        gateway.authorize("openai", "gpt-4o-mini", "s", "p", 100)


def test_a_turn_cannot_make_more_model_calls_than_the_policy_allows(ledger):
    from app.services.ai_runtime import gateway

    with gateway.billing(gateway.Billing(purpose="chat_core", user_id="u1", turn_ref="t2")):
        for _ in range(3):
            gateway.authorize("openai", "gpt-4o-mini", "s", "p", 100)
        with pytest.raises(gateway.AiBudgetExceeded) as ex:
            gateway.authorize("openai", "gpt-4o-mini", "s", "p", 100)
    assert ex.value.detail["scope"] == "turn_calls"


def test_a_user_over_their_daily_ceiling_is_refused(ledger):
    from app.services.ai_runtime import gateway

    with gateway.billing(gateway.Billing(purpose="chat_core", user_id="u9")):
        with pytest.raises(gateway.AiBudgetExceeded) as ex:
            gateway.authorize("openai", "gpt-4o", "s", "p" * 3000, 1000)  # ~$0.0125 worst case each
            for _ in range(200):
                gateway.authorize("openai", "gpt-4o", "s", "p" * 3000, 1000)
    assert ex.value.detail["scope"] in ("user", "global")


def test_an_unreadable_ledger_refuses_the_paid_call(monkeypatch, ledger):
    from app.services.ai_runtime import gateway

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(gateway, "_engine", boom)
    with pytest.raises(gateway.BudgetUnavailable):
        gateway.authorize("openai", "gpt-4o-mini", "s", "p", 100)


def test_an_error_after_sending_keeps_the_worst_case_never_free(ledger):
    from app.services.ai_runtime import gateway

    res = gateway.authorize("openai", "gpt-4o-mini", "s", "p", 500)
    gateway.settle(res, None, error="ReadTimeout")
    row = _rows(ledger)[0]
    assert row["status"] == "unknown" and row["actual_usd"] == pytest.approx(row["reserved_usd"])
    assert row["error"] == "ReadTimeout"


def test_a_request_that_never_left_frees_its_reservation(ledger):
    from app.services.ai_runtime import gateway

    res = gateway.authorize("openai", "gpt-4o-mini", "s", "p", 500)
    gateway.release(res)
    row = _rows(ledger)[0]
    assert row["status"] == "released" and row["actual_usd"] == 0


def test_an_oversized_context_is_refused(ledger):
    from app.services.ai_runtime import gateway

    with pytest.raises(gateway.InputTooLarge):
        gateway.authorize("openai", "gpt-4o-mini", "s", "x" * 200_000, 100)


def test_the_llm_client_cannot_be_given_a_key_by_a_caller_and_raises_a_policy_refusal(ledger, monkeypatch):
    """Inside a turn a policy refusal is raised (the Core reports it), never routed
    around by trying another provider; the only keys are the server's or the turn's
    pinned credential."""
    from app.core.config import settings
    from app.services import llm_client
    from app.services.ai_runtime import gateway

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-test-server", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "gem-test-server", raising=False)
    sent = []
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: sent.append(a) or (_ for _ in ()).throw(
        AssertionError("no request may be sent")))
    monkeypatch.setattr(settings, "AI_MAX_USD_PER_TURN", 0.0000001, raising=False)
    # (a public turn runs on the link's pinned key and model: PO 2026-10-28)
    link_key = gateway.Credential(provider="openai", key="sk-link", ref="credential:9", model="gpt-4o-mini")
    with gateway.billing(gateway.Billing(purpose="public_core", link_id=1, turn_ref="t3", credential=link_key)):
        with pytest.raises(gateway.AiBudgetExceeded):
            llm_client.LLMClient.complete_json("question", max_tokens=500)
    assert sent == []


@pytest.mark.parametrize("purpose", ["chat", "public_core"])
def test_a_chat_or_public_turn_without_the_persons_key_never_uses_the_servers(ledger, monkeypatch, purpose):
    """PO 2026-10-28: AI Chat and the public Dashboard AI Bot run on the key and model
    a PERSON supplied (a conversation's, a link's). With none pinned the call is
    refused before anything is sent - the server's keys are not a fallback."""
    from app.core.config import settings
    from app.services import llm_client
    from app.services.ai_runtime import gateway

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-test-server", raising=False)
    sent = []
    monkeypatch.setattr(llm_client.httpx, "post", lambda *a, **k: sent.append(a))
    with gateway.billing(gateway.Billing(purpose=purpose, link_id=1, turn_ref="t9")):
        with pytest.raises(gateway.NoCredential):
            llm_client.LLMClient.complete_json("question", max_tokens=200)
    assert sent == [] and _rows(ledger) == []


def test_the_model_the_person_chose_is_the_model_called(ledger, monkeypatch):
    from app.services import llm_client
    from app.services.ai_runtime import gateway

    seen = {}

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"usage": {"prompt_tokens": 5, "completion_tokens": 3},
                    "choices": [{"message": {"content": '{"ok": true}'}}]}

    monkeypatch.setattr(llm_client.httpx, "post", lambda url, **k: seen.update(url=url, body=k["json"]) or _Resp())
    mine = gateway.Credential(provider="openai", key="sk-mine", ref="credential:3", model="gpt-4.1")
    with gateway.billing(gateway.Billing(purpose="chat", user_id="u", turn_ref="t10", credential=mine)):
        assert llm_client.LLMClient.complete_json("q", max_tokens=100, strong=True) == {"ok": True}
    assert seen["body"]["model"] == "gpt-4.1" and seen["url"].endswith("/chat/completions")


def test_a_responses_api_model_is_called_on_the_responses_endpoint(ledger, monkeypatch):
    """The GPT-6 family is served on the Responses API: JSON mode via text.format,
    output read from the message items, usage settled in the ledger."""
    from app.services import llm_client
    from app.services.ai_runtime import gateway

    seen = {}

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"model": "gpt-6-luna", "usage": {"input_tokens": 50, "output_tokens": 20},
                    "output": [{"type": "reasoning", "summary": []},
                               {"type": "message", "content": [{"type": "output_text", "text": '{"status": "plan"}'}]}]}

    monkeypatch.setattr(llm_client.httpx, "post", lambda url, **k: seen.update(url=url, body=k["json"]) or _Resp())
    mine = gateway.Credential(provider="openai", key="sk-mine", ref="credential:3", model="gpt-6-luna")
    with gateway.billing(gateway.Billing(purpose="chat", user_id="u", turn_ref="t11", credential=mine)):
        assert llm_client.LLMClient.complete_json("q", system="Answer in JSON", max_tokens=100) == {"status": "plan"}
    body = seen["body"]
    assert seen["url"].endswith("/v1/responses") and body["model"] == "gpt-6-luna"
    assert body["text"] == {"format": {"type": "json_object"}} and body["instructions"] == "Answer in JSON"
    assert "max_tokens" not in body and "temperature" not in body
    row = _rows(ledger)[-1]
    assert row["status"] == "settled" and (row["input_tokens"], row["output_tokens"]) == (50, 20)


def test_a_link_is_ready_only_with_its_own_key_and_model(ledger, monkeypatch):
    """No server fallback: the server's key never makes a public link 'ready'."""
    from app.core.config import settings
    from app.services.ai_runtime import gateway

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-test-server", raising=False)
    assert gateway.readiness(None, {})["ready"] is False
    monkeypatch.setattr(gateway, "stored_credential",
                        lambda db, cid, model=None: gateway.Credential("openai", "k", f"credential:{cid}", model)
                        if cid and model else None)
    assert gateway.readiness(None, {"ai_bot_credential_id": 4})["missing"] == "model"
    ready = gateway.readiness(None, {"ai_bot_credential_id": 4, "ai_bot_model": "gpt-4o-mini"})
    assert ready["ready"] is True and ready["model"] == "gpt-4o-mini" and ready["credential"] == "link"
    assert gateway.answer_model_ok("openai", "gpt-6-luna") and not gateway.answer_model_ok("openai", "nope")


def test_a_pinned_link_credential_is_the_only_key_used(ledger, monkeypatch):
    from app.core.config import settings
    from app.services import llm_client
    from app.services.ai_runtime import gateway

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-server", raising=False)
    seen = {}

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"content": [{"type": "text", "text": "{\"ok\": true}"}],
                    "usage": {"input_tokens": 10, "output_tokens": 5}}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen["url"], seen["key"] = url, (headers or {}).get("x-api-key")
        return _Resp()

    monkeypatch.setattr(llm_client.httpx, "post", fake_post)
    cred = gateway.Credential(provider="anthropic", key="sk-ant-link", ref="credential:5")
    with gateway.billing(gateway.Billing(purpose="public_core", link_id=1, turn_ref="t4", credential=cred)):
        assert llm_client.LLMClient.complete_json("q", max_tokens=100) == {"ok": True}
    assert "anthropic" in seen["url"] and seen["key"] == "sk-ant-link"
    assert _rows(ledger)[0]["credential_ref"] == "credential:5" and _rows(ledger)[0]["status"] == "settled"
