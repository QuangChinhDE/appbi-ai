# -*- coding: utf-8 -*-
"""The viewer gets the reason; the author keeps the identifiers.

THE LEAK THIS LOCKS.

Pilot UAT on an anonymous `/d/{token}` link opened "view details" under the
dashboard bot and read:

    rank_values: biểu đồ 684 nhóm theo 'year_month', không phải theo
                 'customer_state' — câu hỏi đang hỏi theo 'customer_state'.

An internal tool id, a chart id and two raw column names, shown to someone who
cannot open the report those ids belong to. The notice directly above it already
said "Customer state" — the governed label — so this was never a missing fact,
only a path that used the model's message where the reader's belonged.

WHY THE ASSERTIONS ARE SHAPED THIS WAY.

Hiding the error would also pass a "no identifiers" check and would be worse
than the leak: a viewer told nothing cannot tell a refusal from a wrong answer.
So every case here asserts BOTH halves — the identifiers are gone AND the
sentence still carries the real reason — and one case asserts the author's trace
still has what a person diagnosing the refusal actually needs.

The unknown-code case is the one that matters most over time. The mapper is an
allow-list, so a code nobody has taught it yet degrades to a generic sentence
rather than falling through to the raw message. Without that test the allow-list
could be turned into a `.get(code, result["error"])` by someone being helpful.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.reader_diagnostics import GENERIC, reader_error, tool_label
from app.services.agent_flows.wire import event_to_envelope
from app.services.dashboard_ai_bot.events import AgentEvent

#: Verbatim from the pilot report. If any of these reach a reader, the leak is back.
FORBIDDEN = ("rank_values", "684", "681", "customer_state", "year_month")

#: The refusal exactly as `dimension_gate.refusal()` builds it.
DIMENSION_REFUSAL = {
    "ok": False,
    "error": (
        "biểu đồ 684 nhóm theo 'year_month', không phải theo 'customer_state' — "
        "câu hỏi đang hỏi theo 'customer_state'. Kết quả của công cụ này sẽ đúng "
        "cho 'year_month' và KHÔNG trả lời được câu hỏi đã đặt."
    ),
    "error_code": "dimension_mismatch",
    "retryable": False,
    "recovery": "Gọi resolve_chart_candidates với dimension='customer_state' …",
    "detail": {
        "requested_dimension": "customer_state",
        "requested_label": "Customer state",
        "chart_dimensions": ["year_month"],
        "chart_id": 684,
    },
}


def _wire(result: dict, tool_name: str = "rank_values") -> dict:
    return event_to_envelope(
        AgentEvent(type="tool_result", tool_name=tool_name, tool_result=result)
    )


def test_the_public_reader_never_sees_the_tool_id_chart_id_or_column():
    """The exact string from the pilot must not survive the wire boundary."""
    env = _wire(DIMENSION_REFUSAL)
    rendered = f"{env['tool']}: {env['error']}"
    for token in FORBIDDEN:
        assert token not in rendered, f"reader output still leaks {token!r}: {rendered}"


def test_the_reader_is_still_told_why_rather_than_nothing():
    """Suppressing the error would pass the leak check and fail the person."""
    env = _wire(DIMENSION_REFUSAL)
    assert env["ok"] is False
    assert env["error"], "a refusal with no reader message is a silent failure"
    # The real reason: the chart does not cut by the dimension that was asked for.
    assert "Customer state" in env["error"]
    assert "không tách số liệu" in env["error"]


def test_the_tool_is_named_in_the_products_own_words():
    """`rank_values` is an id; the builder already shows authors a label.

    ASSERTED AGAINST THE REGISTRY, not against "looks tidy". The first version of
    this test only checked that no underscore survived, and it passed while the
    lookup was silently broken — `all_tools()` is a dict keyed by name, iterating
    it yields the keys, so every call fell through to the humanising fallback.
    "Rank values" cleared a cosmetic check and was not the product's word.
    """
    from app.services.agent_flows.tools.registry import all_tools

    spec = all_tools().get("rank_values")
    assert spec is not None, "rank_values left the registry — update this test"
    assert tool_label("rank_values") == spec.label_vi
    assert "rank_values" not in tool_label("rank_values")


def test_a_tool_the_registry_does_not_know_still_never_shows_an_identifier():
    """The fallback is a safety net, not the normal path."""
    label = tool_label("some_retired_tool")
    assert "_" not in label, f"{label!r} still looks like an identifier"


def test_an_unknown_error_code_degrades_to_generic_and_never_to_the_raw_message():
    """The allow-list is the safety property, not an optimisation."""
    leaky = {
        "ok": False,
        "error": "rank_values blew up on chart 681 grouping by customer_state",
        "error_code": "some_code_added_next_month",
        "detail": {"chart_id": 681},
    }
    msg = reader_error(leaky)
    assert msg == GENERIC
    for token in FORBIDDEN:
        assert token not in msg
    env = _wire(leaky)
    assert env["error"] == GENERIC


def test_a_result_with_no_code_at_all_still_says_nothing_technical():
    """Legacy bodies emit a bare sentence and no code. They must not pass through."""
    legacy = {"ok": False, "error": "rank_values: chart 681 has no grouping column"}
    assert reader_error(legacy) == GENERIC
    assert "681" not in _wire(legacy)["error"]


@pytest.mark.parametrize(
    "code,expected_fragment",
    [
        ("chart_out_of_scope", "phạm vi"),
        ("not_granted", "phạm vi"),
        ("gated", "phạm vi"),
        ("chart_not_found", "Không tìm thấy"),
        ("no_data", "Không có dữ liệu"),
        ("not_applicable", "không áp dụng"),
        ("query_failed", "Không lấy được"),
    ],
)
def test_every_taught_code_says_something_useful_and_nothing_internal(code, expected_fragment):
    msg = reader_error({"ok": False, "error": "chart 681 / customer_state", "error_code": code})
    assert expected_fragment in msg
    for token in FORBIDDEN:
        assert token not in msg


def test_success_carries_no_error_and_the_label_still_resolves():
    env = _wire({"ok": True, "data": {"dimension": "customer_state"}})
    assert env["ok"] is True
    assert env["error"] is None


def test_the_status_line_does_not_carry_the_raw_tool_id():
    """`Đang dùng rank_values…` was the other half of the same leak."""
    env = event_to_envelope(
        AgentEvent(type="status", text="Đang dùng Xếp hạng…", tool_name="rank_values")
    )
    assert "rank_values" not in str(env["tool"])


def test_the_author_trace_keeps_the_technical_detail():
    """Reader-safety must not cost the person diagnosing the refusal.

    `reader_error` reads the result; it does not mutate it. The chart id, the raw
    field names and the model-facing message stay on the object the Runs tab and
    `state.tool_log` store.
    """
    result = dict(DIMENSION_REFUSAL)
    _ = reader_error(result)
    assert result["error_code"] == "dimension_mismatch"
    assert "684" in result["error"]
    assert result["detail"]["chart_id"] == 684
    assert result["detail"]["chart_dimensions"] == ["year_month"]
    assert "customer_state" in result["recovery"]


# ── Flow lifecycle events carry no internal keys (public reader journey) ───────
# node_started / node_completed / branch_taken / loop_iteration used to be the
# executor payload spread onto the wire, so every reader - including an
# anonymous public-link visitor - received the flow's NODE keys (`step`) and a
# branch's CASE key (`path`). Found by e2e/tests/security/public-reader.spec.ts.

@pytest.mark.parametrize("et,extra", [
    ("node_started", {"step": "ngoai_pham_vi", "name": "Đọc biểu đồ", "type": "tool"}),
    ("node_completed", {"step": "ngoai_pham_vi", "name": "Đọc biểu đồ", "ms": 12, "status": "reused"}),
    ("branch_taken", {"step": "re_nhanh", "path": "case_noi_bo", "label": "Doanh thu"}),
    ("loop_iteration", {"step": "vong_lap", "index": 2, "total": 5}),
])
def test_lifecycle_events_carry_only_what_a_reader_is_shown(et, extra):
    env = event_to_envelope(AgentEvent(type=et, extra=extra))
    assert env["type"] == et
    assert "step" not in env and "path" not in env
    text = str(env)
    for internal in ("ngoai_pham_vi", "re_nhanh", "case_noi_bo", "vong_lap"):
        assert internal not in text
    # what the reader IS shown survives
    for k in ("name", "label", "ms", "status", "index", "total"):
        if k in extra:
            assert env[k] == extra[k]


# ── The ANSWER prose carries no internals, whoever wrote it (reader_text) ──────
# The structured channels were already clean; the prose was protected only by a
# prompt instruction. A model reads tool results whose technical messages name the
# tool id, raw ids and the exception, so the answer is scrubbed deterministically
# before it is stored and published (executor).

_DANGEROUS = (
    "Doanh thu 10 tỷ. get_chart_data: chart_id 1566 is not part of this dashboard "
    "(chart_out_of_scope, error_code). failed to load chart 1565: ValueError. "
    "dataset_table_42 tại http://localhost:8000/api/v1/x và 127.0.0.1:5432, brain_key=k, "
    "answer_node. Traceback (most recent call last):\n  File \"a.py\", line 3, in f\n\nTiếp tục."
)


def test_answer_prose_loses_every_internal_identifier():
    from app.services.agent_flows.reader_text import scrub

    out = scrub(_DANGEROUS)
    for internal in ("get_chart_data", "chart_id", "1566", "is not part of this dashboard",
                     "chart_out_of_scope", "error_code", "failed to load chart", "ValueError",
                     "dataset_table_42", "localhost", "127.0.0.1", "brain_key", "answer_node",
                     "Traceback", 'File "a.py"'):
        assert internal not in out, (internal, out)
    assert out.startswith("Doanh thu 10 tỷ.") and out.endswith("Tiếp tục.")


@pytest.mark.parametrize("text", [
    "Doanh thu tháng 3 tăng 12% so với tháng 2.",
    "Top 5: A (12), B (9).",
    "Error rate thấp; out-of-stock giảm.",
    "Xem https://appbi.example.com/report để biết thêm.",
])
def test_ordinary_reader_prose_is_untouched(text):
    from app.services.agent_flows.reader_text import scrub

    assert scrub(text) == text


def test_the_published_answer_is_the_scrubbed_one():
    """Stored, published and rated text stay byte-identical: the Answer itself is
    scrubbed, so `Answer.text` (computed from blocks) is the clean string."""
    from app.services.agent_flows.envelope import Answer
    from app.services.agent_flows.reader_text import scrub_answer

    a = Answer.model_validate({"blocks": [
        {"type": "text", "markdown": _DANGEROUS},
        {"type": "metric", "label": "chart_id 7 get_chart_data", "value": 5},
        {"type": "followups", "items": ["Vì sao chart_out_of_scope?"]},
    ]})
    a = scrub_answer(a)
    for internal in ("get_chart_data", "chart_id", "chart_out_of_scope", "Traceback"):
        assert internal not in a.text and internal not in a.plain_text()
    assert a.text == a.plain_text()
