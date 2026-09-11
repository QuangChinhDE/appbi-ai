"""A container the flow cannot see inside is a container that disables every check.

`coordinate` was added to the node union, the executor, the canvas and six frontend
walkers — and not to `Flow.all_nodes()`, which is how the flow knows what it
contains. Everything downstream reads that one method, so every check went blind at
once, on exactly the nodes a coordinator exists to hold.

Found by running the product rather than by reading it. Asked "danh mục sản phẩm
nào có doanh thu cao nhất", a three-specialist flow answered "13,591,643.70" — the
report's grand total, with no category named and no notice raised. The specialist
holding the measuring tools had no way to obtain a chart_id, the warning for that
case was already written, and it had simply never looked inside the lane.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.coverage import coverage


def _flow(specialist_tools: list[str], *, prompt: str = "Đo số.") -> Flow:
    body = {
        "nodes": [
            {
                "key": "doc", "name": "Đọc báo cáo", "type": "report_read",
                "chart_ids": [1, 2], "output_var": "dashboard_context",
            },
            {
                "key": "dp", "name": "Điều phối", "type": "coordinate",
                "prompt": "Điều phối các chuyên gia.",
                "specialists": [
                    {
                        "key": "so_lieu",
                        "when": "câu hỏi cần con số cụ thể từ báo cáo",
                        "body": [{
                            "key": "cg_so_lieu", "name": "CG số liệu", "type": "agent",
                            "prompt": prompt,
                            "tools": [{"tool": t} for t in specialist_tools],
                        }],
                    },
                    {
                        "key": "dinh_nghia",
                        "when": "câu hỏi hỏi về định nghĩa hoặc công thức",
                        "body": [{
                            "key": "cg_dn", "name": "CG định nghĩa", "type": "agent",
                            "prompt": "Giải thích công thức.",
                            "tools": [{"tool": "search_knowledge"}],
                        }],
                    },
                ],
            },
            {"key": "tra_loi", "name": "Soạn câu trả lời", "type": "agent",
             "prompt": "Gộp kết quả các bước trước.", "tools": []},
        ],
    }
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )


def test_the_flow_can_see_the_nodes_inside_a_coordinator():
    """Three top-level nodes, five actual ones. The walker knew about three."""
    flow = _flow(["total_measure"])
    keys = [n.key for n in flow.all_nodes()]

    assert keys == ["doc", "dp", "cg_so_lieu", "cg_dn", "tra_loi"]
    assert {n.key for n in flow.agent_nodes()} == {"cg_so_lieu", "cg_dn", "tra_loi"}


def test_a_specialists_tools_count_towards_what_the_flow_can_answer():
    """Coverage described this flow's abilities while ignoring all of its tools.

    Every tool in a coordinator flow is granted inside a lane, so `granted_tools`
    returned the empty set and the coverage report said the flow could answer
    nothing at all — for a flow that answers most things. An author reading that
    report learns to ignore it, which costs more than not having one.
    """
    flow = _flow(["total_measure", "rank_values"])
    cov = coverage(flow)
    covered = {c["key"] for c in cov["covered"]}

    assert "lookup" in covered
    assert "ranking" in covered
    assert cov["answerable"] >= 2


def test_the_coverage_report_names_the_gap_that_produces_a_wrong_answer():
    """The failing question, as the report would have predicted it.

    `rank_values` absent means "Danh mục nào cao nhất?" has no tool behind it —
    and the flow does not decline, it answers from whatever total it can reach.
    The gap list is where an author sees that before a viewer does.
    """
    flow = _flow(["total_measure", "get_chart_data", "compare_periods"])
    gaps = {g["key"]: g for g in coverage(flow)["gaps"]}

    assert "ranking" in gaps
    assert gaps["ranking"]["tools"] == []


def test_a_specialist_that_must_name_a_chart_and_cannot_find_one_is_warned_about():
    """The warning existed and could not reach the node that needed it."""
    flow = _flow(["total_measure", "get_chart_data"])
    warned = [w for w in flow.warnings() if "CG số liệu" in w]

    assert warned, "a lane's measuring step must still be checked"
    assert "chart_id" in warned[0]
    assert "list_charts" in warned[0]


def test_being_able_to_look_a_chart_up_satisfies_the_requirement():
    """Two ways to know a chart_id, and the search only recently became one.

    Before `list_charts` took a `query` and stopped costing 37 seconds, being
    handed an index was the only practical route, so the check only knew about
    that one. Granting the search is now a complete answer and must not warn.
    """
    flow = _flow(["total_measure", "list_charts"])

    assert not [w for w in flow.warnings() if "CG số liệu" in w and "chart_id" in w]


def test_reading_the_index_variable_also_satisfies_it():
    """The original route still counts — this check adds an option, not a rule."""
    flow = _flow(["total_measure"], prompt="Đo số dựa trên {{dashboard_context}}.")

    assert not [w for w in flow.warnings() if "CG số liệu" in w and "chart_id" in w]


def test_a_flow_with_no_read_step_at_all_is_the_worst_case_and_used_to_be_silent():
    """`if read_vars:` skipped the check exactly when it mattered most.

    No read step means no index anywhere in the flow, so a measuring step is
    certainly guessing — and that was the one shape that produced no warning.
    """
    body = {
        "nodes": [
            {"key": "do_so", "name": "Đo số", "type": "agent", "prompt": "Đo.",
             "tools": [{"tool": "total_measure"}]},
        ],
    }
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )

    warned = [w for w in flow.warnings() if "chart_id" in w]
    assert warned
    assert "không có bước đọc báo cáo nào" in warned[0]


@pytest.mark.parametrize("tools,expected", [
    (["total_measure"], True),
    (["search_knowledge"], False),        # needs no chart_id — nothing to warn about
    (["total_measure", "list_charts"], False),
])
def test_only_steps_that_actually_need_a_chart_id_are_warned(tools, expected):
    """A knowledge step has no business being told to call list_charts."""
    flow = _flow(tools)
    warned = bool([w for w in flow.warnings() if "CG số liệu" in w and "chart_id" in w])

    assert warned is expected
