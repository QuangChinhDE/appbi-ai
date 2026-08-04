"""Turn figures already fetched into a finding.

Separate from `report` because a brain often wants one step that reads and another
that reasons. Giving the writing step none of these is how an author stops it
inventing numbers: with no way to compute, it can only retell what earlier steps
established.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="analysis",
    label_vi="Phân tích & so sánh",
    label_en="Analysis & comparison",
    tools=[
        spec("compute", label_vi="Tính toán", label_en="Compute",
             description_vi="Tính một biểu thức số học trên các giá trị đã lấy được."),
        spec("compare_periods", label_vi="So sánh kỳ", label_en="Compare periods",
             description_vi="So hai khoảng thời gian và tính chênh lệch.",
             cost_class="data_query"),
        spec("compare_segments", label_vi="So sánh phân khúc", label_en="Compare segments",
             description_vi="So các nhóm trong cùng một biểu đồ.",
             cost_class="data_query"),
        spec("segment_compare", label_vi="Phân khúc vs phần còn lại",
             label_en="Segment vs rest",
             description_vi="So một phân khúc với toàn bộ phần còn lại.",
             cost_class="data_query"),
        spec("analyze_trend", label_vi="Phân tích xu hướng", label_en="Analyse trend",
             description_vi="Chiều và độ mạnh của xu hướng theo thời gian.",
             cost_class="data_query"),
        spec("explain_change", label_vi="Giải thích thay đổi", label_en="Explain change",
             description_vi="Tách một biến động thành phần đóng góp của từng nhóm.",
             cost_class="expensive"),
        spec("detect_anomaly", label_vi="Dò bất thường", label_en="Detect anomaly",
             description_vi="Tìm điểm bất thường bằng z-score cuộn và điểm gãy.",
             cost_class="data_query"),
        spec("describe_distribution", label_vi="Phân phối",
             label_en="Describe distribution",
             description_vi="Phân vị, độ tập trung, bất cân đối (Gini).",
             cost_class="data_query"),
        spec("correlate_charts", label_vi="Tương quan", label_en="Correlate charts",
             description_vi="Đo tương quan giữa hai biểu đồ.",
             cost_class="data_query"),
        spec("smart_drilldown", label_vi="Khoan sâu", label_en="Smart drilldown",
             description_vi="Lọc biểu đồ theo một giá trị cụ thể rồi đọc lại.",
             cost_class="data_query"),
        spec("forecast_measure", label_vi="Dự báo", label_en="Forecast",
             description_vi="Chiếu xu hướng ra tương lai gần.",
             cost_class="expensive"),
    ],
)
