"""Read the report being viewed.

The pack every brain will want, because it is what makes an answer about THIS
report rather than about data in general. Each tool here already applies the
dashboard's public filters, so a brain cannot accidentally answer about numbers
the viewer is not looking at.

`emit_reading_plan` is deliberately absent. It let the first-generation bot
announce the steps it was about to take — a hardcoded pipeline narrating itself.
A brain's steps ARE the plan, and they are visible in the builder.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="report",
    label_vi="Đọc báo cáo đang mở",
    label_en="Read the open report",
    tools=[
        spec(
            "list_charts",
            label_vi="Danh sách biểu đồ",
            label_en="List charts",
            description_vi="Xem báo cáo có những biểu đồ nào và mỗi cái đo gì.",
        ),
        spec(
            "get_chart_summary",
            label_vi="Tóm tắt biểu đồ",
            label_en="Chart summary",
            description_vi="Số tổng quát của một biểu đồ, không tải toàn bộ dữ liệu.",
        ),
        spec(
            "get_chart_data",
            label_vi="Lấy dữ liệu biểu đồ",
            label_en="Chart data",
            description_vi="Đọc dữ liệu thật của một biểu đồ, đã áp filter của báo cáo.",
            cost_class="data_query",
        ),
        spec(
            "aggregate_chart_data",
            label_vi="Tổng hợp theo chiều khác",
            label_en="Aggregate chart data",
            description_vi="Gộp dữ liệu một biểu đồ theo chiều khác để so sánh.",
            cost_class="data_query",
        ),
        spec(
            "inspect_filters",
            label_vi="Xem báo cáo đang lọc gì",
            label_en="Inspect filters",
            description_vi=(
                "Cho biết báo cáo đang bị lọc theo điều kiện nào — trả lời sai vì "
                "bỏ qua filter là lỗi hay gặp nhất."
            ),
        ),
        spec(
            "get_chart_glossary",
            label_vi="Từ điển trường của biểu đồ",
            label_en="Chart glossary",
            description_vi="Giải thích các trường và chỉ số của một biểu đồ.",
        ),
    ],
)
