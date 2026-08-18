"""Find out WHY, not just how much.

The pack an author grants when the report is expected to be questioned rather
than recited. Everything here is materially more expensive than reading a figure
— `explain_change` decomposes a movement across every group, `correlate_charts`
reads two charts to relate them — so the cost class is the honest signal, and a
step granted all five will be slow.

Granting the whole pack to one step is usually the wrong shape. A flow that
branches — read, notice a drop, THEN explain it — pays for diagnosis only on the
turns that need it, and the run trace shows which branch was taken. That is the
argument for a flow over a single well-prompted agent, and this pack is where it
pays.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="diagnose",
    label_vi="Tìm nguyên nhân",
    label_en="Diagnose",
    purpose_vi="Vì sao số biến động, chỗ nào bất thường, cái gì liên quan cái gì. Tốn hơn nhóm lấy số.",
    tools=[
        spec(
            "explain_change",
            label_vi="Giải thích thay đổi",
            label_en="Explain change",
            description_vi="Tách một biến động thành phần đóng góp của từng nhóm.",
            result_kind="diagnosis",
            returns={
                "contributors": "mỗi nhóm: đóng góp bao nhiêu vào biến động, theo thứ tự ảnh hưởng",
                "total_change": "biến động tổng đang được giải thích",
                "coverage": "mấy nhóm được liệt kê trên tổng số",
            },
            cost_class="expensive",
            # MEASURED across every dashboard: 31 .. 738 tokens. `small` promised
            # <= 500 and the contribution list clears it whenever a change has
            # several drivers, which is the case worth calling the tool for.
            payload="medium",
            self_sufficient=True,
            answers_vi=("Vì sao doanh thu giảm?", "Nhóm nào kéo số xuống?"),
        ),
        spec(
            "detect_anomaly",
            label_vi="Dò bất thường",
            label_en="Detect anomaly",
            description_vi="Tìm điểm bất thường bằng z-score cuộn và điểm gãy.",
            result_kind="diagnosis",
            returns={
                "anomalies": "mỗi điểm: thời điểm, giá trị, độ lệch, mức nghiêm trọng",
                "method": "cách phát hiện đã dùng",
                "baseline": "mức bình thường dùng để so",
            },
            cost_class="data_query",
            # MEASURED: 31 .. 1,347 tokens. Each anomaly carries its whole row, so
            # the payload grows with how many the method finds — and on a wide
            # fact table it finds thousands.
            payload="medium",
            self_sufficient=True,
            answers_vi=("Có gì bất thường không?", "Ngày nào tụt hẳn?"),
        ),
        spec(
            "smart_drilldown",
            label_vi="Khoan sâu",
            label_en="Smart drilldown",
            description_vi="Lọc biểu đồ theo một giá trị cụ thể rồi đọc lại.",
            result_kind="table",
            returns={
                "filter_applied": "đã khoan theo giá trị nào",
                "columns / rows": "dữ liệu sau khi khoan",
                "coverage": "trả về mấy trên tổng bao nhiêu",
            },
            cost_class="data_query",
            payload="medium",
            answers_vi=("Xem chi tiết riêng nhóm này",),
        ),
        spec(
            "correlate_charts",
            label_vi="Tương quan",
            label_en="Correlate charts",
            description_vi="Đo tương quan giữa hai biểu đồ.",
            result_kind="diagnosis",
            returns={
                "coefficient": "hệ số tương quan",
                "strength / direction": "mạnh yếu và cùng/ngược chiều",
                "n_points": "tính trên bao nhiêu điểm — ít điểm thì đừng kết luận",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Hai chỉ số này có liên quan nhau không?",),
        ),
        spec(
            "describe_distribution",
            label_vi="Phân phối",
            label_en="Describe distribution",
            description_vi="Phân vị, độ tập trung, bất cân đối (Gini).",
            result_kind="diagnosis",
            returns={
                "quantiles": "các phân vị",
                "gini": "mức độ tập trung — cao nghĩa là vài nhóm chiếm gần hết",
                "concentration": "top mấy nhóm chiếm bao nhiêu phần trăm",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Doanh thu có tập trung vào vài khách không?",),
        ),
    ],
)
