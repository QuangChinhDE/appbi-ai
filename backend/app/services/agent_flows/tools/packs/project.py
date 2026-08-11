"""Read a direction, and extend it.

Two tools, kept apart from `diagnose` because they are the only ones whose output
is not a fact about data that exists.

`analyze_trend` describes what already happened. `forecast_measure` states what
has not happened yet, and an answer built on it is a different kind of claim —
which is why it is the one tool here declared NOT deterministic and NOT
cacheable: its result depends on where "now" falls, so serving yesterday's
projection as today's would be presenting a stale guess as a current one.

An author granting `forecast_measure` should say so in the answering step's
prompt. A forecast presented in the same voice as a measured figure is the most
confidently wrong sentence this system can produce.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs._source import spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="project",
    label_vi="Xu hướng & dự báo",
    label_en="Trend & forecast",
    purpose_vi="Đọc chiều hướng đã xảy ra, và chiếu tiếp. Dự báo là phỏng đoán — nói rõ khi trả lời.",
    tools=[
        spec(
            "analyze_trend",
            label_vi="Phân tích xu hướng",
            label_en="Analyse trend",
            description_vi="Chiều và độ mạnh của xu hướng theo thời gian.",
            result_kind="series",
            returns={
                "direction": "tăng / giảm / đi ngang",
                "slope": "độ dốc",
                "strength": "xu hướng rõ hay nhiễu",
                "points": "chuỗi điểm đã dùng để tính",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Xu hướng mấy tháng qua thế nào?",),
        ),
        spec(
            "forecast_measure",
            label_vi="Dự báo",
            label_en="Forecast",
            description_vi=(
                "Chiếu xu hướng ra tương lai gần. Kết quả là phỏng đoán, "
                "không phải số đo — phải nói rõ khi trình bày."
            ),
            result_kind="projection",
            returns={
                "points": "mỗi điểm dự báo: kỳ và giá trị",
                "method": "cách ngoại suy đã dùng",
                "confidence": "khoảng tin cậy, nếu tính được",
                "based_on": "dựa trên bao nhiêu kỳ lịch sử",
            },
            cost_class="expensive",
            # Depends on where "now" falls, so the same arguments give a
            # different answer tomorrow. Caching it would serve a stale
            # projection as a current one.
            deterministic=False,
            self_sufficient=True,
            answers_vi=("Tháng tới dự kiến bao nhiêu?",),
        ),
    ],
)
