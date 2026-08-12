"""Put two figures beside each other.

Separated from `measure` because comparison is where a brain most often needs a
step of its own: read, then compare, then write. An author granting only these to
the comparing step gets a step that cannot wander off into fresh data.

`compare_to_target` was added after a review asked what this group could not
answer. It could compare two periods, two segments, and a segment against the
rest — and nothing against a PLAN, which in a business report is often the only
comparison that decides anything. The deployment's own semantic layer already
carried `target_revenue`, `total_goal`, `quota_units` and an `attainment_pct`
measure, so the question was being asked and the group had no answer for it.

WHAT THIS PACK STILL CANNOT DO
------------------------------
Explain a difference. It reports that actual is 8% below plan; whether that
is a problem depends on what somebody wrote down — the plan's assumptions, a
known outage, a pricing change. Pairing a comparison with the knowledge tools
is an open design question, deferred to the `knowledge` pack's own review
where the retrieval cost can be weighed properly. See the note there.

Four tools that sound alike and are not:

  `compare_periods`   the same measure, two spans of time.
  `compare_segments`  two named groups inside one chart, against each other.
  `segment_compare`   one group against EVERYTHING ELSE — the question
                      "is this segment unusual", which comparing two groups
                      cannot answer.
  `compare_to_target` the actual against the plan: gap, attainment, shortfall.

The names came from the old module and are kept, because brains stored in the
database name their tools and renaming one silently breaks every flow that
granted it. The descriptions do the disambiguating instead.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs import target
from app.services.agent_flows.tools.packs._source import local, spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="compare",
    label_vi="So sánh",
    label_en="Compare",
    purpose_vi=(
        "Đặt hai con số cạnh nhau và tính chênh lệch: theo kỳ, theo nhóm, "
        "nhóm với phần còn lại, hoặc thực tế với mục tiêu."
    ),
    tools=[
        local(
            "compare_to_target",
            target.tool_compare_to_target,
            target.COMPARE_TO_TARGET_DEF,
            label_vi="Thực tế vs mục tiêu",
            label_en="Actual vs target",
            description_vi=(
                "So số thực tế với mục tiêu/kế hoạch/định mức: chênh bao nhiêu và "
                "đạt bao nhiêu %. Mục tiêu lấy từ số người hỏi nêu, từ cột được "
                "chỉ định, hoặc từ cột có tên khai rõ (target_/plan_/goal_)."
            ),
            result_kind="comparison",
            returns={
                "actual / target": "số thực tế và mục tiêu",
                "gap": "chênh lệch, theo ĐƠN VỊ của chỉ số",
                "attainment_pct": "đạt bao nhiêu % mục tiêu — KHÁC với gap",
                "status / shortfall_pct": "đạt hay chưa, thiếu bao nhiêu %",
                "target_source": "mục tiêu lấy từ đâu",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Có đạt mục tiêu không?",
                        "Còn thiếu bao nhiêu so với kế hoạch?",
                        "Tỉ lệ hoàn thành là bao nhiêu?"),
        ),
        spec(
            "compare_periods",
            label_vi="So sánh kỳ",
            label_en="Compare periods",
            description_vi="So hai khoảng thời gian và tính chênh lệch.",
            result_kind="comparison",
            returns={
                "a / b": "giá trị từng kỳ kèm nhãn kỳ",
                "delta": "chênh lệch tuyệt đối",
                "pct_change": "phần trăm thay đổi",
                "direction": "tăng / giảm / đi ngang",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Tháng này so tháng trước thế nào?", "Quý 2 tăng hay giảm?"),
        ),
        spec(
            "compare_segments",
            label_vi="So sánh phân khúc",
            label_en="Compare segments",
            description_vi="So các nhóm trong cùng một biểu đồ.",
            result_kind="comparison",
            returns={
                "segment_a / segment_b": "tên nhóm, giá trị, số dòng",
                "delta": "chênh lệch tuyệt đối",
                "pct_change_vs_b": "A hơn/kém B bao nhiêu phần trăm",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Miền Bắc so miền Nam ra sao?",),
        ),
        spec(
            "segment_compare",
            label_vi="Phân khúc vs phần còn lại",
            label_en="Segment vs rest",
            description_vi="So một phân khúc với toàn bộ phần còn lại.",
            result_kind="comparison",
            returns={
                "segment": "nhóm được hỏi và giá trị của nó",
                "rest": "tổng hợp của tất cả nhóm còn lại",
                "delta / pct_change": "khác biệt so với phần còn lại",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Nhóm này có bất thường so với phần còn lại không?",),
        ),
    ],
)
