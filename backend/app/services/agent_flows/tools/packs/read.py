"""Understand the report before reading numbers out of it.

These are the tools that tell a brain what it is looking at — which charts exist,
what is filtered, what a field means, and WHEN the data stops.

That last one was missing until a review of this group went looking for holes. The
demo report's data runs to 2018-10-17 while the calendar says 2026; nothing in the
catalogue could say so, and every question containing "this month", "recently" or
"last year" was therefore answered against a period the report has no rows for.
`describe_time_coverage` closes it, and it belongs HERE rather than in the
measuring group because it is not a figure from the report — it is a fact about
what the report can be asked.

`inspect_filters` earns its place by being the most-skipped step and the most
expensive to skip: an answer computed over filtered data and presented as if it
were the whole business is wrong in a way that reads as confident.

`list_charts` is the one tool in this pack whose payload is not small. It queries
nothing, so on the warehouse axis it is genuinely cheap — and on a 70-chart report
it returned ~15,600 tokens, which is the axis an agent actually spends. It now
lists compactly and takes a `page`, and it says `scales_with_report` out loud so
an author sizing a flow can see the half that used to be invisible.

`emit_reading_plan` is deliberately absent. It let the first-generation bot
announce the steps it was about to take — a hardcoded pipeline narrating itself.
A brain's steps ARE the plan, and they are visible in the builder.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs import coverage
from app.services.agent_flows.tools.packs._source import local, spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="read",
    label_vi="Hiểu báo cáo",
    label_en="Understand the report",
    purpose_vi=(
        "Biết báo cáo có gì, đang lọc gì, mỗi trường nghĩa là gì, và dữ liệu "
        "chạy tới đâu. Gọi trước khi đọc bất kỳ con số nào."
    ),
    tools=[
        spec(
            "list_charts",
            label_vi="Danh sách biểu đồ",
            label_en="List charts",
            description_vi=(
                "Xem báo cáo có những biểu đồ nào và mỗi cái đo gì. Báo cáo lớn "
                "thì truyền `page` để liệt kê từng trang — liệt kê cả 70 biểu đồ "
                "tốn vài nghìn token mỗi lần gọi."
            ),
            result_kind="catalogue",
            returns={
                "charts": "mỗi biểu đồ: id, tên, loại, chỉ số và chiều nó dùng",
                "pages": "các trang của báo cáo và mỗi trang có mấy biểu đồ",
                "coverage": "liệt kê mấy trên tổng bao nhiêu, ở mức chi tiết nào",
                "filters_applied": "điều kiện lọc đang áp cho toàn báo cáo",
            },
            payload="scales_with_report",
            self_sufficient=True,
            answers_vi=("Báo cáo này có những biểu đồ nào?",
                        "Trang Doanh thu có gì?"),
        ),
        spec(
            "inspect_filters",
            label_vi="Xem báo cáo đang lọc gì",
            label_en="Inspect filters",
            description_vi=(
                "Cho biết báo cáo đang bị lọc theo điều kiện nào — trả lời sai vì "
                "bỏ qua filter là lỗi hay gặp nhất."
            ),
            result_kind="catalogue",
            returns={
                "active_filters": "từng điều kiện: trường, toán tử, giá trị",
                "has_filters / filter_count": "có đang lọc không, mấy điều kiện",
                "note": "một câu mô tả phạm vi dữ liệu đang xem",
            },
            self_sufficient=True,
            answers_vi=("Số liệu đang lọc theo gì?",
                        "Báo cáo đang xem khoảng nào?"),
        ),
        local(
            "describe_time_coverage",
            coverage.tool_describe_time_coverage,
            coverage.DESCRIBE_TIME_COVERAGE_DEF,
            label_vi="Dữ liệu chạy tới đâu",
            label_en="Data time coverage",
            description_vi=(
                "Dữ liệu của báo cáo chạy từ ngày nào đến ngày nào, và cách hôm "
                "nay bao xa. Gọi TRƯỚC mọi câu có chữ chỉ thời gian — dữ liệu có "
                "thể dừng trước hôm nay nhiều năm."
            ),
            result_kind="value",
            returns={
                "from / to": "ngày đầu và ngày cuối của dữ liệu",
                "latest_period": "kỳ gần nhất có số (YYYY-MM)",
                "days_behind_today": "dữ liệu chậm hơn hôm nay bao nhiêu ngày",
                "covers_today": "hôm nay có nằm trong khoảng dữ liệu không",
                "staleness_note": "phải hiểu “tháng này / gần đây” theo mốc nào",
            },
            cost_class="data_query",
            # The range is a fact about the data; the comparison with today is
            # not, and the comparison is the useful half. A cached answer would
            # drift from the clock it was measured against.
            deterministic=False,
            self_sufficient=True,
            answers_vi=("Số liệu tính đến khi nào?",
                        "Dữ liệu có mới không?",
                        "Báo cáo này che khoảng thời gian nào?"),
        ),
        spec(
            "get_chart_glossary",
            label_vi="Từ điển trường của biểu đồ",
            label_en="Chart glossary",
            description_vi=(
                "Chi tiết MỘT biểu đồ: các cột, kiểu dữ liệu, mô tả nghiệp vụ, "
                "và cách người dùng hay gọi chúng."
            ),
            result_kind="catalogue",
            returns={
                "columns": "mỗi cột: tên, kiểu, mô tả, là chỉ số hay chiều",
                "dataset / dataset_table": "bộ dữ liệu và bảng nguồn đằng sau",
                "query_aliases": "cách người dùng hay gọi, để dịch sang tên cột",
                "common_questions": "câu hỏi thường gặp đã được khai báo",
            },
            payload="medium",
            self_sufficient=True,
            answers_vi=("Cột doanh thu ở đây tính thế nào?",
                        "Biểu đồ này lấy từ bảng nào?"),
        ),
        spec(
            "describe_semantic_model",
            label_vi="Đọc mô hình dữ liệu",
            label_en="Describe semantic model",
            description_vi=(
                "Định nghĩa nghiệp vụ của measure/dimension do người khai báo "
                "trong Semantic Layer — chỉ trả về những trường ĐÃ được mô tả. "
                "Dùng khi CÂU HỎI là về ý nghĩa của trường; không cần cấp cho "
                "bước chỉ đi lấy số — nhóm tính-sẵn đã trả kèm phép gộp và đơn vị."
            ),
            result_kind="catalogue",
            returns={
                "fields": "tên, nhãn, mô tả, là measure hay dimension",
                "datasets": "thuộc bộ dữ liệu nào",
                "total": "có bao nhiêu trường đã được khai báo",
            },
            self_sufficient=True,
            answers_vi=("GMV ở đây định nghĩa thế nào?",
                        "Mô hình dữ liệu đằng sau báo cáo này ra sao?"),
        ),
    ],
)
