"""Read a direction, and extend it.

Four tools, kept apart from `diagnose` because they are the only ones whose output
is not a fact about data that exists.

THE THINNEST GROUP IN THE CATALOGUE, AND THE ONE MOST IS EXPECTED OF
-------------------------------------------------------------------
A review noted that two tools was too few for the group a business pays the most
attention to, and that was right in two different ways.

`detect_seasonality` closes a CORRECTNESS hole. `forecast_measure` extrapolates a
line or a growth rate, and over a seasonal series that is wrong confidently: it
carries whichever part of the cycle it starts from forward. Its caveat said "no
seasonality is modelled" — honest, and useless, because a reader cannot tell
whether that matters for the series in front of them. Measuring whether a repeat
exists turns the disclaimer into a decision.

`project_to_period_end` closes the QUESTION hole. "Will we hit the target?" is
what a trend is usually being read for, and answering it meant reading a run rate
from one tool, a target from another, and dividing in a model — where the division
cannot be checked afterwards. `compare_to_target` answers it in the present tense;
this one answers it in the tense the question is actually asked in.

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

from app.services.agent_flows.tools.packs import project_ahead
from app.services.agent_flows.tools.packs._source import local, spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="project",
    label_vi="Xu hướng & dự báo",
    label_en="Trend & forecast",
    purpose_vi=(
        "Đọc chiều hướng đã xảy ra, chiếu tiếp, và trả lời “có kịp mục tiêu "
        "không”. Mọi thứ ở đây là phỏng đoán có điều kiện — nói rõ khi trả lời."
    ),
    tools=[
        local(
            "project_to_period_end",
            project_ahead.tool_project_to_period_end,
            project_ahead.PROJECT_TO_PERIOD_END_DEF,
            label_vi="Chiếu tới cuối kỳ vs mục tiêu",
            label_en="Project to period end vs target",
            description_vi=(
                "Giữ đà hiện tại thì cuối kỳ đạt bao nhiêu, và có kịp mục tiêu "
                "không. Trả kèm tốc độ CẦN có để đạt — câu hỏi “còn phải làm bao "
                "nhiêu mỗi kỳ nữa”."
            ),
            result_kind="projection",
            returns={
                "to_date / run_rate_per_period": "đã đạt bao nhiêu, tốc độ hiện tại",
                "projected_total": "cuối kỳ đạt bao nhiêu nếu giữ đà",
                "verdict / projected_attainment_pct": "kịp hay không, đạt bao nhiêu %",
                "required_run_rate / what_it_takes": "cần bao nhiêu mỗi kỳ để kịp",
                "assumption": "giả định đã dùng — phải nói lại khi trả lời",
            },
            cost_class="data_query",
            deterministic=False,
            self_sufficient=True,
            answers_vi=("Có kịp mục tiêu năm không?",
                        "Còn phải bán bao nhiêu mỗi tháng nữa?",
                        "Giữ đà này thì cuối quý được bao nhiêu?"),
        ),
        local(
            "detect_seasonality",
            project_ahead.tool_detect_seasonality,
            project_ahead.DETECT_SEASONALITY_DEF,
            label_vi="Có tính mùa vụ không",
            label_en="Detect seasonality",
            description_vi=(
                "Chuỗi có lặp theo chu kỳ không, chu kỳ mấy kỳ, mạnh cỡ nào. GỌI "
                "TRƯỚC khi tin dự báo: phép chiếu đường thẳng sai chắc chắn trên "
                "chuỗi có mùa vụ."
            ),
            result_kind="diagnosis",
            returns={
                "seasonal": "có chu kỳ đủ mạnh để hành động theo hay không",
                "strongest_cycle": "chu kỳ mấy kỳ",
                "cycles_tested": "chu kỳ nào đủ dữ liệu để kiểm, chu kỳ nào không",
                "note": "nếu có mùa vụ thì tại sao không được chiếu đường thẳng",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Doanh thu có theo mùa không?",
                        "Có chu kỳ lặp lại không?"),
        ),
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
