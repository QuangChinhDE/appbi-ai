"""What kinds of question this flow can actually answer, and what it cannot.

THE PROBLEM THIS EXISTS FOR
---------------------------
An author grants a handful of tools, tests a few lookups, sees correct answers and
ships. Then a viewer asks the one class of question the flow has no tool for, and
the bot does not say "I have no way to check that" — it says the report does not
contain the information. Measured on this deployment, on a flow granted only
lookup/rank/share/compare tools:

    Q: "Có điều gì bất thường trong báo cáo này mà tôi nên chú ý không?"
    A: "Báo cáo không cung cấp thông tin cụ thể về các bất thường."
    tool calls: 0

Both halves of that are wrong. The report does contain the information, and
`detect_anomaly` exists, is registered, and was simply never granted. The answer
blamed the data for a gap in the configuration — and the author had no way to
learn it, because the flow was valid, the run was `ok`, and the sentence reads
like a finding.

WHAT THIS DOES
--------------
Maps the tools a step is granted onto the QUESTION CLASSES they make answerable,
and reports the classes nothing covers, each with the pack that would fix it. It
is derived entirely from the registry and the flow — no opinions, no model — so it
cannot drift from what the flow can really do.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
Refuse anything. A flow built to answer "what is X" and nothing else is a perfectly
good flow, and a screen that flags it as broken would be the noise this is meant to
replace. These are gaps, stated once, next to the place the author is already
testing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.agent_flows.contract import Flow


@dataclass(frozen=True)
class QuestionClass:
    key: str
    #: What a viewer would actually type. Prose, not a category name: an author
    #: recognises "vì sao tháng này giảm?" instantly and "diagnosis" not at all.
    example_vi: str
    label_vi: str
    #: Any ONE of these makes the class answerable. Alternatives rather than a
    #: requirement, because there is usually more than one honest way to answer.
    any_of: tuple[str, ...]
    #: Where to go and get one, for the message.
    pack: str


#: Ordered by how often a viewer asks it, so the first gap named is the one most
#: likely to be hit.
CLASSES: tuple[QuestionClass, ...] = (
    QuestionClass(
        "lookup", "GMV toàn kỳ là bao nhiêu?", "Tra một con số",
        ("total_measure", "get_chart_summary", "get_chart_data"), "measure",
    ),
    QuestionClass(
        "ranking", "Danh mục nào cao nhất?", "Xếp hạng",
        ("rank_values",), "measure",
    ),
    QuestionClass(
        "share", "Nhóm đó chiếm bao nhiêu phần trăm?", "Tỉ trọng",
        ("share_of",), "measure",
    ),
    QuestionClass(
        "trend", "Mấy tháng nay đang tăng hay giảm?", "Xu hướng",
        ("analyze_trend", "compare_periods"), "project",
    ),
    QuestionClass(
        "comparison", "Miền Bắc so với miền Nam thế nào?", "So sánh",
        ("compare_segments", "segment_compare", "compare_periods", "compare_to_target"),
        "compare",
    ),
    QuestionClass(
        "diagnosis", "Có gì bất thường tôi nên chú ý?", "Vì sao / bất thường",
        ("detect_anomaly", "explain_change", "correlate_charts", "describe_distribution"),
        "diagnose",
    ),
    QuestionClass(
        "projection", "Cứ thế này thì cuối kỳ có đạt mục tiêu không?", "Dự báo",
        ("forecast_measure", "project_to_period_end"), "project",
    ),
    QuestionClass(
        "definition", "“Đơn hoàn tất” ở đây tính thế nào?", "Định nghĩa / quy ước",
        ("search_knowledge", "read_document", "get_chart_glossary", "recall_knowledge"),
        "knowledge",
    ),
    QuestionClass(
        "freshness", "Số liệu cập nhật tới hôm nào?", "Độ mới của dữ liệu",
        ("describe_time_coverage",), "read",
    ),
)


def _granted_tools(flow: Flow) -> set[str]:
    """Every tool any step of the flow may call.

    Union across steps rather than per-step: a viewer's question reaches whichever
    step answers, and a tool granted three steps earlier still shaped what that step
    was handed. The narrower per-step view is the author's job on the canvas; this
    is about whether the FLOW can answer at all.
    """
    out: set[str] = set()
    for node in flow.all_nodes():
        for grant in getattr(node, "tools", None) or []:
            name = getattr(grant, "tool", None) or getattr(grant, "name", None)
            if name:
                out.add(str(name))
    return out


def coverage(flow: Flow) -> dict[str, Any]:
    """Which question classes this flow can answer, and which it cannot.

    Also reports whether ANY step has a knowledge source bound, because the
    `definition` class has a second route: a step with documents attached can answer
    "what does this term mean" without a search tool, from the passages it was
    already given.
    """
    granted = _granted_tools(flow)
    has_knowledge = any(
        getattr(n, "knowledge", None) for n in flow.all_nodes()
    )

    covered: list[dict[str, Any]] = []
    gaps: list[dict[str, Any]] = []
    for qc in CLASSES:
        hit = sorted(granted & set(qc.any_of))
        if qc.key == "definition" and not hit and has_knowledge:
            # Bound documents answer this without a search tool.
            hit = ["<knowledge>"]
        entry = {
            "key": qc.key,
            "label": qc.label_vi,
            "example": qc.example_vi,
            "tools": hit,
            "pack": qc.pack,
        }
        (covered if hit else gaps).append(entry)

    return {
        "covered": covered,
        "gaps": gaps,
        # Said as a fraction rather than a grade: nine of nine is not a better flow
        # than four of nine, it is a broader one, and an author narrowing on purpose
        # should not be reading a score that says they are failing.
        "answerable": len(covered),
        "total": len(CLASSES),
    }
