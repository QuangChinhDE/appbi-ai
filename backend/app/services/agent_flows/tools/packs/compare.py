"""Put two figures beside each other.

Separated from `measure` because comparison is where a brain most often needs a
step of its own: read, then compare, then write. An author granting only these to
the comparing step gets a step that cannot wander off into fresh data.

Three tools that sound alike and are not:

  `compare_periods`   the same measure, two spans of time.
  `compare_segments`  two named groups inside one chart, against each other.
  `segment_compare`   one group against EVERYTHING ELSE — the question
                      "is this segment unusual", which comparing two groups
                      cannot answer.

The names came from the old module and are kept, because brains stored in the
database name their tools and renaming one silently breaks every flow that
granted it. The descriptions do the disambiguating instead.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="compare",
    label_vi="So sánh",
    label_en="Compare",
    purpose_vi="Đặt hai con số cạnh nhau và tính chênh lệch: theo kỳ, theo nhóm, hoặc nhóm với phần còn lại.",
    tools=[
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
