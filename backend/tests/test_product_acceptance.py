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
