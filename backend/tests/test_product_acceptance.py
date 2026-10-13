# -*- coding: utf-8 -*-
"""Regressions found by driving the real Chat and Public Report UI as a reader.

Each test names the browser journey that exposed the defect.
"""
from __future__ import annotations

import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from app.services.agent_flows import direct_chat  # noqa: E402


# ── C02 (browser, run 8642): a correct month-on-month change hidden as "wrong period" ──
from test_correctness_closure import ADV, saas  # noqa: E402,F401

_COMPARE_TEXT = ("ARR active tháng 8/2026 là 72, giảm 792 (91,7%) so với tháng 7/2026 (864); "
                 "số tháng 8 thấp bất thường và chưa xác định được kỳ này đã đầy đủ hay chưa.")
_GOOD = {"chart_id": 1, "measure": "arr_active", "mode": "custom", "period_a": "2026-08", "period_b": "2026-07"}
_SWAPPED = {**_GOOD, "period_a": "2026-07", "period_b": "2026-08"}


def _flagged(saas, monkeypatch, calls, text=_COMPARE_TEXT):
    from app.services.agent_flows.runtime import claim_check as CC
    from app.services.agent_flows.runtime.state import RunState

    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: set())
    saas.question = "ARR tháng 8/2026 so với tháng trước thì sao?"
    state = RunState()
    state.chart_dims[1] = ["year_month"]
    for a in calls:
        state.record_evidence(ADV.tool_compare_periods(saas, a), tool="compare_periods", args=a)
    return sorted((f["value"], f["why"]) for f in CC.check(state, saas, text).get("flagged") or [])


@pytest.mark.parametrize("order", [[_SWAPPED, _GOOD], [_GOOD, _SWAPPED]])
def test_a_figure_one_reading_supports_is_not_condemned_by_another(saas, monkeypatch, order):
    """The model compared twice, once with the periods swapped; the verdict used to
    be the FIRST reading's, so the order of two tool calls decided whether a
    correct answer was shown."""
    assert _flagged(saas, monkeypatch, order) == []


def test_a_change_only_a_swapped_comparison_supports_is_still_withheld(saas, monkeypatch):
    got = _flagged(saas, monkeypatch, [_SWAPPED])
    assert (792.0, "wrong_period") in got


def test_a_comparison_asks_about_its_baseline_too(saas, monkeypatch):
    """July's 864, stated as the baseline of "tháng 8 so với tháng trước"."""
    assert (864.0, "wrong_period") not in _flagged(saas, monkeypatch, [_GOOD])


# ── C01/C05 (browser): a shared assistant answered "the data does not exist" ──
def test_suggestions_name_this_assistants_data_not_another_reports():
    """The fixed examples ("GMV toàn kỳ…", "Danh mục nào cao nhất?") were offered on
    a SaaS assistant; a reader who clicked one could only be refused."""
    can = [{"key": "lookup"}, {"key": "trend"}, {"key": "comparison"}, {"key": "definition"}]
    got = direct_chat.grounded_suggestions(can, {"chart_names": ["ARR theo tháng"], "en": False})
    assert len(got) == 3 and all("ARR theo tháng" in q for q in got)
    assert not any("GMV" in q for q in got)
    assert direct_chat.grounded_suggestions(can, {"chart_names": [], "en": False}) == []


def test_reader_reach_says_what_was_withheld_without_naming_it(monkeypatch):
    import app.services.agent_flows.permissions as P

    monkeypatch.setattr(P, "unreadable_attachments", lambda db, row, flow, user: {"dataset_ids": [186], "doc_ids": []})
    monkeypatch.setattr(P, "run_scope", lambda db, row, flow, caller=None: {"doc_ids": [], "dataset_ids": [], "metric_names": []})
    monkeypatch.setattr(P, "chart_scope", lambda db, scope: set())
    flow = types.SimpleNamespace(bound_sources=lambda: [types.SimpleNamespace(source="semantic", ref="186")])
    got = direct_chat.reader_reach(None, object(), object(), flow)
    assert got["withheld_data"] is True and got["reachable_count"] == 0 and got["attached_count"] == 1
    from app.services.agent_flows.reader_capability import FORBIDDEN_KEYS

    exposed = {k for k in got if k not in ("chart_names", "en")}
    assert not exposed & set(FORBIDDEN_KEYS)
    assert "186" not in str({k: got[k] for k in exposed})


# ── P04 (browser): "Vì sao ARR tháng 8 giảm mạnh?" refused as "tháng 8/2023" ──
from app.services.agent_flows.runtime.intent import anchor_years  # noqa: E402

_COV = {"year_month": ("2026-01-01", "2026-08-01")}


def test_a_year_the_question_never_said_comes_from_the_data_not_the_model():
    """The intent model returned 2023-08 for a follow-up in a 2026 conversation; the
    period was judged outside the data and the answer refused."""
    got, note = anchor_years([("m", 2023, 8)], "Vì sao ARR tháng 8 giảm mạnh?",
                             "Phân khúc nào đóng góp ARR lớn nhất?", _COV)
    assert got == [("m", 2026, 8)] and "2023" in note


def test_the_previous_turns_year_wins_over_the_data():
    got, _ = anchor_years([("m", 2023, 8)], "còn tháng 8 thì sao?", "ARR tháng 7/2025 là bao nhiêu?", _COV)
    assert got == [("m", 2025, 8)]


def test_an_explicit_year_is_never_rewritten():
    got, note = anchor_years([("m", 2026, 8)], "ARR tháng 8 năm 2026?", None, _COV)
    assert got == [("m", 2026, 8)] and note == ""


def test_no_anchor_means_no_period_rather_than_a_guessed_one():
    got, note = anchor_years([("m", 2023, 8)], "tháng 8 thì sao?", None, {})
    assert got == [] and "dropped" in note


def test_a_spaced_followup_marker_is_still_the_marker():
    from app.services.agent_flows.runtime.handlers.agent import _canonical_markers, _strip_followups

    text = "ARR tháng 8/2026 là 72.\n[ FOLLOWUP] Bạn muốn xem tháng 7?\n[Follow Up] Xem phân khúc?"
    assert _canonical_markers(text).count("[FOLLOWUP]") == 2
    assert _strip_followups(_canonical_markers(text)) == "ARR tháng 8/2026 là 72."


def test_a_relative_followup_is_anchored_on_the_period_just_discussed():
    """P04 (browser, run 8651): after "ARR tháng 8 năm 2026?", the intent model read
    "So với tháng trước thì sao?" as July/July and the answer compared July with June."""
    from app.services.agent_flows.runtime.intent import anchor_relative_followup

    model = {"periods": [("m", 2026, 7)], "baseline": ("m", 2026, 7), "notes": []}
    anchor_relative_followup(model, "So với tháng trước thì sao?", "ARR tháng 8 năm 2026 là bao nhiêu?", True)
    assert model["periods"] == [("m", 2026, 8)] and model["baseline"] == ("m", 2026, 7)
    assert model["notes"]
    keep = {"periods": [("m", 2026, 5)], "baseline": None, "notes": []}
    anchor_relative_followup(keep, "Còn tháng 5/2026 thì sao?", "ARR tháng 8 năm 2026?", True)
    assert keep["periods"] == [("m", 2026, 5)], "an explicit period in the question is never overridden"


# ── P08 (code + browser): "Phân tích toàn diện" ran where the assistant was refused ──
# Public chat runs only the link's assigned flow and refuses when nothing is assigned,
# published or in the reader rollout. Explore is a separate engine on the viewer's,
# the link's or the SERVER's key; it skipped that policy and the link's chart ceiling.

def _gate(monkeypatch, *, problem="", pilot=None, ceiling=(1, 2)):
    from app.services.agent_flows import dispatch as D

    flow = None if problem else object()
    row = None if problem else types.SimpleNamespace(version=3)
    binding = types.SimpleNamespace(id=9)
    monkeypatch.setattr(D, "resolve_for_link", lambda db, link, dashboard: (binding, row, flow, problem))
    monkeypatch.setattr(D, "_reader_gate", lambda **kw: pilot)
    monkeypatch.setattr(D, "build_report_info", lambda dashboard, ctx: None)
    monkeypatch.setattr(D.binding_service, "build_binding_info",
                        lambda *a, **kw: types.SimpleNamespace(allowed_chart_ids=list(ceiling)))
    ctx = types.SimpleNamespace(allowed_chart_ids={1, 2, 3})
    msg = D.explore_gate(None, link=types.SimpleNamespace(id=5, token="t"), dashboard=None, ctx=ctx)
    return msg, ctx


def test_explore_is_refused_where_chat_is_refused(monkeypatch):
    from app.services.agent_flows.dispatch import BLOCK_MESSAGES

    msg, ctx = _gate(monkeypatch, problem="not_configured")
    assert msg == BLOCK_MESSAGES["not_configured"] and ctx.allowed_chart_ids == {1, 2, 3}


def test_explore_follows_the_reader_rollout(monkeypatch):
    msg, _ = _gate(monkeypatch, pilot="pilot_closed")
    assert msg, "a link outside the rollout must not run Explore either"


def test_explore_reads_only_the_charts_the_assignment_allows(monkeypatch):
    msg, ctx = _gate(monkeypatch, ceiling=(2, 7))
    assert msg is None and ctx.allowed_chart_ids == {2}


def test_a_refused_explore_resolves_no_key_and_starts_no_engine(monkeypatch):
    """The refusal comes BEFORE the key: a link nobody may explore is told why — not
    asked for a key — and the server's key is never reached."""
    from fastapi.testclient import TestClient

    from app.api import public as PUB
    from app.core.database import get_db
    from app.main import app
    from app.services.agent_flows import dispatch as D
    from app.services.dashboard_ai_bot.thinking import explorer

    from app.core.config import settings

    monkeypatch.setattr(settings, "PUBLIC_AI_EXPLORE_ENABLED", True)
    touched = []
    link = types.SimpleNamespace(id=5, token="tok")
    db = types.SimpleNamespace(query=lambda *a: types.SimpleNamespace(
        filter=lambda *a: types.SimpleNamespace(first=lambda: link)))
    monkeypatch.setattr(PUB, "_get_dashboard_by_token",
                        lambda *a, **kw: (types.SimpleNamespace(name="d"), [], None, {"ai_bot_enabled": True}))
    monkeypatch.setattr(PUB, "_public_link_tool_context",
                        lambda *a, **kw: types.SimpleNamespace(public_filters=[], allowed_chart_ids={1}))
    monkeypatch.setattr(D, "explore_gate", lambda db, **kw: "Link này chưa gán trợ lý.")
    monkeypatch.setattr(PUB, "resolve_public_ai_credentials", lambda *a, **kw: touched.append("key"))
    monkeypatch.setattr(explorer, "run_exploration_stream", lambda **kw: touched.append("engine"))
    app.dependency_overrides[get_db] = lambda: db
    try:
        res = TestClient(app).post("/api/v1/public/dashboards/tok/ai/agent/explore", json={})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200 and "Link này chưa gán trợ lý." in res.text and '"done"' in res.text
    assert touched == []


def test_a_public_refusal_is_written_for_the_viewer_not_the_author():
    """P08 (browser, link 180): an anonymous viewer was told "Vào phần ChatBot của
    link, chọn một Agent Flow và định nghĩa phạm vi dữ liệu" — steps only the author
    can take, in the author's vocabulary."""
    from app.services.agent_flows.dispatch import BLOCK_MESSAGES

    for code, text in BLOCK_MESSAGES.items():
        low = text.lower()
        assert not any(w in low for w in ("agent flow", "chatbot", "phạm vi dữ liệu", "binding", "gán")), code


def test_a_withheld_figure_says_why_in_words_the_reader_can_act_on():
    """Public link 177 (run 8662): "Tổng ARR cộng dồn của tất cả các tháng?" — 5244, a
    sum of a monthly balance, was rightly withheld, but the reader was told "sai đại
    lượng, sai kỳ, sai chiều/đối tượng, hoặc tự tính": four guesses and no way to
    rephrase. The reason is named; the number never is."""
    from app.services.agent_flows.runtime import claim_check as CC

    flagged = [{"value": 5244.0, "pct": False, "why": "aggregation_unsafe"}]
    for text in (CC.reader_note(flagged), CC.claims_unverified_text(flagged)):
        assert "số dư" in text and "một kỳ cụ thể" in text and "5244" not in text and "5,244" not in text
    assert "balance" in CC.reader_note(flagged, "en")
    # A reason without reader wording keeps the generic sentence — never a half list.
    mixed = [*flagged, {"value": 1.0, "pct": False, "why": "unsupported"}]
    assert CC.reader_reasons(mixed) == [] and "sai đại lượng" in CC.claims_unverified_text(mixed)


def test_the_readers_own_filter_value_is_a_label_not_a_figure(saas, monkeypatch):
    """Public link 177 (browser): after the viewer picked Gói 104 in the slicer the
    answer read "với bộ lọc Gói = [đã ẩn: chưa kiểm chứng]"."""
    from app.services.agent_flows.runtime import claim_check as CC
    from app.services.filter_layered_merge import DISCLOSE_KEY

    shown = {"field": "dataset_table_687.plan_code", "label": "Gói", "operator": "in", "value": [104]}
    text = "Tổng Cus churned là 43 (tháng 7 và 8/2026), với bộ lọc Gói = 104 đang áp dụng."
    monkeypatch.setattr(saas, "public_filters", [shown], raising=False)
    assert CC._filter_value_numbers(saas, text) == {104.0}
    assert CC._filter_value_numbers(saas, "Doanh thu là 104.") == set(), "only beside the filter's name"
    monkeypatch.setattr(saas, "public_filters", [{**shown, DISCLOSE_KEY: False}], raising=False)
    assert CC._filter_value_numbers(saas, text) == set(), "a hidden constraint's value stays a figure"


def test_the_answer_keeps_the_filter_value_the_reader_picked(saas, monkeypatch):
    """The same journey through `check`: without the exemption 104 was withheld."""
    from test_correctness_closure import DER, _declare

    from app.services.agent_flows.runtime import claim_check as CC
    from app.services.agent_flows.runtime.state import RunState

    _declare(monkeypatch, cus_churned={"type": "sum"})
    monkeypatch.setattr(CC, "_question_measures", lambda ctx, q: set())
    monkeypatch.setattr(saas, "question", "Tổng số khách hàng rời bỏ là bao nhiêu?", raising=False)
    monkeypatch.setattr(saas, "public_filters", [{"field": "dataset_table_687.plan_code", "label": "Gói",
                                                  "operator": "in", "value": [104]}], raising=False)
    state = RunState()
    args = {"chart_id": 1, "measure": "cus_churned", "period_from": "2026-07", "period_to": "2026-08"}
    state.record_evidence(DER.tool_total_measure(saas, args), tool="total_measure", args=args)
    text = "Tổng Cus churned là 43 (tổng hai kỳ 2026-07 và 2026-08), với bộ lọc Gói = 104 đang áp dụng."
    assert not CC.check(state, saas, text).get("flagged")
    assert CC.check(state, saas, text.replace("43", "47")).get("flagged"), "a wrong figure is still withheld"


def test_the_ai_is_told_which_filters_the_viewer_cannot_lift():
    """P05 (browser, link 181): the answer twice advised the viewer to "bỏ bộ lọc
    Gói = 103" — a link lock already shown read-only in the report's banner."""
    from app.api.public import _filters_told_to_ai
    from app.services.chart_contracts import AUTHORITATIVE_KEY
    from app.services.dashboard_ai_bot.thinking.prompts import _format_filters
    from app.services.filter_layered_merge import DISCLOSE_KEY

    lock = {"field": "plan_code", "operator": "in", "value": [103], AUTHORITATIVE_KEY: True}
    pick = {"field": "segment", "operator": "in", "value": ["smb"]}
    hidden = {"field": "region", "operator": "in", "value": ["north"], AUTHORITATIVE_KEY: True, DISCLOSE_KEY: False}
    told = _filters_told_to_ai([lock, pick, hidden])
    assert [f.get("locked") for f in told[:2]] == [True, None], "the viewer's own pick is not locked"
    assert told[2] == {"restricted_by_author": 1}, "a 🚫 one is counted, never named (link 182)"
    assert not any(str(k).startswith("_") for f in told for k in f)
    line = _format_filters(told)
    assert "cannot remove" in line.split(";")[0] and "cannot remove" not in line.split(";")[1]
    assert "north" not in line and "region" not in line and "never that no filter applies" in line


def test_a_citation_number_is_not_a_figure_to_verify():
    """Chat C03 (run 8674): "[Nguồn: tài liệu 26]" raised figures_unverified on a
    correct document answer that contained no figure at all."""
    from app.services.agent_flows.envelope import text_answer
    from app.services.agent_flows.runtime.executor import _verify_figures
    from app.services.agent_flows.runtime.state import RunState

    text = "GMV là tổng tiền hàng đã thanh toán trong kỳ, chưa trừ hoàn tiền. [Nguồn: tài liệu 26] [KB] [1][3]"
    assert _verify_figures(RunState(), text_answer(text)) is None
    assert _verify_figures(RunState(), text_answer("GMV là 13,591,643.7 [Nguồn: tài liệu 26]"))


def test_public_explore_is_off_for_the_pilot_even_by_direct_request(monkeypatch):
    """Product decision (pilot): "Phân tích toàn diện" is hidden AND refused. A direct
    POST must not reach the link, a key or the engine."""
    from fastapi.testclient import TestClient

    from app.api import public as PUB
    from app.core.config import settings
    from app.core.database import get_db
    from app.main import app
    from app.services.dashboard_ai_bot.thinking import explorer

    assert settings.PUBLIC_AI_EXPLORE_ENABLED is False, "the pilot default is off"
    touched = []
    monkeypatch.setattr(PUB, "_get_dashboard_by_token", lambda *a, **kw: touched.append("link"))
    monkeypatch.setattr(PUB, "resolve_public_ai_credentials", lambda *a, **kw: touched.append("key"))
    monkeypatch.setattr(explorer, "run_exploration_stream", lambda **kw: touched.append("engine"))
    app.dependency_overrides[get_db] = lambda: None
    try:
        res = TestClient(app).post("/api/v1/public/dashboards/tok/ai/agent/explore", json={})
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 403 and "tạm ngừng" in res.text
    assert touched == []


def test_a_stopped_turn_records_what_was_shown_and_what_was_spent():
    """P07 (browser, run 8684): Stop left a `failed` run with 0 calls, 0 tokens and an
    empty answer, 75 s later. Now: the partial text, `partial`, `turn_stopped`, usage."""
    from app.services.agent_flows.dispatch import _stopped_output

    state = types.SimpleNamespace(prompt_tokens=1200, completion_tokens=80,
                                  budget=types.SimpleNamespace(llm_calls=2, tool_calls=3))
    out = _stopped_output("r1", "MRR tháng 1/2026 là 50, tháng 2", {"state": state}, [], "vi", 900)
    assert out.status == "partial" and "MRR tháng 1/2026 là 50" in out.answer.plain_text()
    assert [n.code for n in out.notices] == ["turn_stopped"]
    assert (out.usage.llm_calls, out.usage.tool_calls, out.usage.prompt_tokens,
            out.usage.completion_tokens, out.usage.ms) == (2, 3, 1200, 80, 900)

    nothing = _stopped_output("r2", "  ", {}, [], "en", 10)
    assert nothing.status == "failed" and [n.code for n in nothing.notices] == ["turn_abandoned"]
    assert "stopped" in nothing.notices[0].text


def test_the_answer_writer_is_told_to_state_each_figure_once_and_hide_its_plumbing():
    """C04 (browser, run 8676): the figure appeared three times and the answer said
    "Chuyên viên tài liệu cung cấp…; chuyên viên số liệu chưa tra được…"."""
    from app.services.agent_flows.roles import get

    charter = get("answer_writer").charter
    assert "MỘT lần" in charter and "KHÔNG nhắc tới bước, chuyên viên" in charter
