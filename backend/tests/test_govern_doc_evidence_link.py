"""From a measurement to the rule that explains it.

Data says WHAT happened; documents say what it MEANS. Both halves already existed
and nothing joined them — the knowledge pack's own docstring named the gap and
deferred it. These tests pin the join, and the last section pins that it reuses
phases 1-4 rather than growing a fifth retrieval path.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_evidence_link.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot import govern_doc_evidence_link as link


TARGET_RESULT = {
    "ok": True, "kind": "comparison",
    "data": {
        "chart_id": 67, "measure": "on_time_rate", "actual": 91.2, "target": 92.0,
        "gap": -0.8, "status": "below_target", "shortfall_pct": 0.87, "unit": "%",
    },
}


class _Metrics:
    """One governed KPI whose chart column is spelled differently from its name —
    which is the whole reason the metric record exists."""

    ROWS = [("don_giao_dung_hen", "Đơn giao đúng hẹn",
             ["on time rate", "tỷ lệ giao đúng hẹn", "OTD"], 27)]

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return self.ROWS


class _NoMetrics:
    def execute(self, *a, **k):
        raise RuntimeError("no metric table here")


# ── recognising a measurement ──────────────────────────────────────────────────

def test_a_target_check_is_recognised_as_evidence():
    ev = link.from_measurement(TARGET_RESULT)
    assert ev["measure"] == "on_time_rate"
    assert ev["status"] == "below_target"
    assert ev["actual"] == 91.2 and ev["target"] == 92.0


def test_it_is_recognised_by_SHAPE_not_by_tool_name():
    """`target.py` is one producer today and a second will not be renamed to
    match. A result carrying a measure, a status and a target is a measurement
    whoever wrote it."""
    ev = link.from_measurement({"measure": "gmv", "status": "below_target",
                                "target": 100, "actual": 90})
    assert ev is not None


def test_a_chart_read_is_not_a_measurement():
    assert link.from_measurement({"ok": True, "data": {"rows": [], "columns": []}}) is None


def test_a_result_without_a_target_is_not_a_measurement():
    """"Revenue was 4.2 tỷ" raises no question. "Revenue was 4.2 tỷ against a plan
    of 5" does."""
    assert link.from_measurement({"ok": True, "data": {"measure": "gmv",
                                                       "status": "ok"}}) is None


def test_only_a_missed_target_is_worth_asking_about():
    """A metric that BEAT its target rarely needs a policy explaining why."""
    beat = link.from_measurement({**TARGET_RESULT, "data": {
        **TARGET_RESULT["data"], "status": "on_or_above_target", "gap": 1.0}})
    assert link.is_interesting(beat) is False
    assert link.is_interesting(link.from_measurement(TARGET_RESULT)) is True


def test_nothing_at_all_is_not_interesting():
    assert link.is_interesting(None) is False


# ── the question is composed, not asked of a model ─────────────────────────────

def test_the_question_uses_the_words_the_DOCUMENTS_use():
    """A column called `on_time_rate` retrieves nothing from a corpus that says
    "tỷ lệ giao đúng hẹn". The metric record is the translation between them and it
    is already written down — no model call needed to find it."""
    plan = link.to_question(_Metrics(), link.from_measurement(TARGET_RESULT))
    assert "Đơn giao đúng hẹn" in plan["question"]
    assert plan["metric"] == "don_giao_dung_hen"


def test_the_question_asks_what_a_business_document_can_answer():
    """A target has exclusions, a shortfall has causes, a metric has a definition
    that decides what counts."""
    plan = link.to_question(_Metrics(), link.from_measurement(TARGET_RESULT))
    assert "định nghĩa" in plan["question"]
    assert "loại trừ" in plan["question"]


def test_the_declared_definition_document_is_carried_through():
    """`home_doc_id` is a DECLARATION — somebody recorded that this document
    defines this KPI — not a similarity."""
    plan = link.to_question(_Metrics(), link.from_measurement(TARGET_RESULT))
    assert plan["home_doc_id"] == 27


def test_an_ungoverned_measure_still_produces_a_query_and_says_the_link_is_weak():
    """The column itself is a better query than nothing, and there is no home
    document to claim."""
    plan = link.to_question(_Metrics(), {"measure": "cot_la_khong_ai_khai_bao",
                                          "status": "below_target"})
    assert plan["metric"] is None and plan["home_doc_id"] is None
    assert plan["question"]


def test_a_slug_becomes_words():
    plan = link.to_question(_NoMetrics(), {"measure": "on_time_rate",
                                            "status": "below_target"})
    assert "_" not in plan["question"]


def test_a_missing_metric_table_is_not_an_error():
    """The link is an enhancement; a deployment without governed KPIs must still
    answer."""
    plan = link.to_question(_NoMetrics(), link.from_measurement(TARGET_RESULT))
    assert plan["metric"] is None


# ── the reason a reader can follow ─────────────────────────────────────────────

def test_the_reason_names_the_numbers_that_prompted_it():
    """"The bot searched the documents" explains nothing; "it missed its target by
    0.87% and went looking for the rule" explains it."""
    plan = link.to_question(_Metrics(), link.from_measurement(TARGET_RESULT))
    assert "91.2" in plan["reason"] and "92.0" in plan["reason"]
    assert "0.87" in plan["reason"]


def test_the_measurement_is_carried_so_an_answer_cannot_drift_from_it():
    plan = link.to_question(_Metrics(), link.from_measurement(TARGET_RESULT))
    assert plan["grounded_in"]["actual"] == 91.2
    assert plan["grounded_in"]["status"] == "below_target"


# ── the graph channel, bounded ─────────────────────────────────────────────────

def test_no_home_document_means_no_graph_channel():
    assert link.home_doc_passages(_Metrics(), None, "q") == []


def test_the_graph_cannot_reach_outside_the_caller_s_scope():
    """Naming a metric does not grant access to the document that defines it."""
    assert link.home_doc_passages(_Metrics(), 27, "q", scope={1, 2, 3}) == []


def test_traversal_stops_at_one_hop():
    """Section 20 asks for graph retrieval and asks for it BOUNDED. Following
    doc→doc links from the home document would pull in whatever anyone once
    cross-referenced."""
    import inspect

    source = inspect.getsource(link.home_doc_passages)
    assert "govern_doc_links" not in source
    assert "doc_ids={int(home_doc_id)}" in source


# ── across phases: it reuses, it does not fork ─────────────────────────────────

def test_the_tool_returns_phase1_contract_hits():
    """A fifth shape for evidence would put every consumer back to re-deriving the
    mapping — the defect phase 1 removed."""
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    source = inspect.getsource(govern_tools.tool_explain_measurement)
    assert "knowledge_hit.from_chunk" in source


def test_the_tool_carries_the_phase2_verdict():
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    source = inspect.getsource(govern_tools.tool_explain_measurement)
    assert "govern_doc_answerability" in source and "govern_doc_conflict" in source


def test_clause_coverage_is_off_for_a_machine_built_query():
    """That verdict answers "did the evidence cover every part the USER asked", and
    there is no user question here — the aspects are search hints, and the clause
    splitter reads their commas and reports PARTIALLY_ANSWERABLE on every call."""
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    assert "check_clauses=False" in inspect.getsource(govern_tools.tool_explain_measurement)


def test_the_tool_returns_phase3_citations():
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    assert '"citations"' in inspect.getsource(govern_tools.tool_explain_measurement)


def test_a_missed_target_points_at_the_explanation_without_paying_for_it():
    """The pointer costs one vocabulary lookup. Retrieval costs an embedding, a
    vector scan and a rerank, and most target checks are not followed by "why"."""
    import inspect

    from app.services.agent_flows.tools.packs import target

    source = inspect.getsource(target.tool_compare_to_target)
    assert "explanation_available" in source
    assert "if gap < 0:" in source
    # The pointer must NOT retrieve.
    assert "search_doc_chunks" not in source


def test_the_tool_is_registered_where_a_flow_can_grant_it():
    """A tool nobody can grant is a tool nobody can call — the same silent gap as
    a node type with no runtime handler."""
    from app.services.dashboard_ai_bot.govern_tools import (
        GOVERN_TOOL_DEFS,
        GOVERN_TOOLS,
    )

    assert "explain_measurement" in GOVERN_TOOLS
    assert any(d["name"] == "explain_measurement" for d in GOVERN_TOOL_DEFS)


def test_the_pack_declares_it_so_the_picker_shows_it():
    from app.services.agent_flows.tools.packs.knowledge import PACK

    assert any(t.name == "explain_measurement" for t in PACK.tools)
