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
