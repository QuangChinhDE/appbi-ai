"""Get a figure out of the report.

The pack that answers "how much", and the one where the choice between two tools
decides whether the answer is right.

READ THE ROWS, OR COMPUTE THE ANSWER
------------------------------------
Two kinds of tool live here and they are not interchangeable:

  * `get_chart_data` and `get_chart_summary` hand over rows for a model to reason
    about. Flexible, and capped — a result has to fit in a prompt, so a chart with
    more groups than the cap arrives as a fragment. Reach for these when the
    question is open-ended enough that you cannot say in advance what to compute.

  * `rank_values`, `total_measure` and `share_of` compute over EVERY row and
    return a few hundred bytes. Exact regardless of size, and callable by a node
    with no model in the loop.

The second kind exists because the first kind got a question wrong in a way that
looked right: asked for the top category of seventy-two, the bot received the
first fifty in alphabetical order and named one that was seventeen times too
small. Ordering the read fixes that question; only computing over all the rows
fixes the class of question. Any "top/highest/total/share" phrasing should reach
for a computing tool first — the schemas say so, in the words a model matches on.

`compute` is the exception to both: it does arithmetic on figures ALREADY
established by earlier steps. Granting it to a writing step is how an author lets
the step do a percentage without also letting it invent an input.
"""
from __future__ import annotations

from app.services.agent_flows.tools.packs import derived
from app.services.agent_flows.tools.packs._source import local, spec
from app.services.agent_flows.tools.registry import ToolPack

PACK = ToolPack(
    key="measure",
    label_vi="Lấy số từ báo cáo",
    label_en="Get a figure",
    purpose_vi=(
        "Trả lời “bao nhiêu”. Ưu tiên nhóm tính-sẵn (xếp hạng/tổng/tỉ trọng): "
        "đúng trên mọi số dòng và gọi được không cần AI."
    ),
    tools=[
        # ── computed: exact, tiny, usable with no model ──────────────────────
        local(
            "rank_values",
            derived.tool_rank_values,
            derived.RANK_VALUES_DEF,
            label_vi="Xếp hạng theo chỉ số",
            label_en="Rank by measure",
            description_vi=(
                "Top/bottom N nhóm, tính trên TOÀN BỘ dòng. Dùng cho mọi câu "
                "“cao nhất / thấp nhất / top mấy” — đọc dữ liệu thô bị giới hạn "
                "dòng nên trả lời sai loại câu này."
            ),
            result_kind="ranking",
            returns={
                "items": "mỗi mục: rank, label, value, formatted, share_pct",
                "total": "tổng thật của toàn bộ nhóm, không phải tổng phần trả về",
                "group_count": "có bao nhiêu nhóm tất cả",
                "coverage": "trả về mấy/bao nhiêu, sắp theo cột nào",
            },
            cost_class="data_query",
            payload="small",
            self_sufficient=True,
            answers_vi=(
                "Danh mục nào doanh thu cao nhất?",
                "Top 5 khu vực bán tốt nhất?",
                "Sản phẩm nào bán kém nhất?",
            ),
        ),
        local(
            "total_measure",
            derived.tool_total_measure,
            derived.TOTAL_MEASURE_DEF,
            label_vi="Tổng của một chỉ số",
            label_en="Total a measure",
            description_vi=(
                "Cộng chỉ số trên TOÀN BỘ dòng, kèm trung bình/nhỏ nhất/lớn nhất."
            ),
            result_kind="value",
            returns={
                "value": "tổng (số thô)",
                "formatted": "tổng đã định dạng, khớp cách hiển thị của KPI",
                "average / min / max": "thống kê kèm theo",
                "rows_counted": "cộng trên bao nhiêu dòng",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Tổng doanh thu là bao nhiêu?", "Trung bình mỗi đơn bao nhiêu?"),
        ),
        local(
            "share_of",
            derived.tool_share_of,
            derived.SHARE_OF_DEF,
            label_vi="Tỉ trọng của một nhóm",
            label_en="Share of one group",
            description_vi=(
                "Giá trị của một nhóm, chiếm bao nhiêu % tổng thật, và đứng thứ mấy."
            ),
            result_kind="value",
            returns={
                "value / formatted": "số của nhóm đó",
                "share_pct": "chiếm bao nhiêu % tổng",
                "rank": "đứng thứ mấy trong tổng số nhóm",
                "matched_exactly": "false khi khớp gần đúng tên người hỏi gõ",
            },
            cost_class="data_query",
            self_sufficient=True,
            answers_vi=("Ngành làm đẹp chiếm bao nhiêu %?", "Miền Bắc đóng góp bao nhiêu?"),
        ),

        # ── raw: flexible, capped, needs a model to interpret ────────────────
        spec(
            "get_chart_summary",
            label_vi="Tóm tắt biểu đồ",
            label_en="Chart summary",
            description_vi="Số tổng quát của một biểu đồ, không tải toàn bộ dữ liệu.",
            result_kind="narrative",
            returns={
                "stats": "tổng/trung bình/số dòng và các giá trị nổi bật",
                "top_values": "vài nhóm dẫn đầu, để định hướng chứ không để xếp hạng",
            },
            cost_class="data_query",
            # MEASURED across every dashboard: 31 .. 2,778 tokens, mean 709. It
            # grows with the chart's column count and distinct values, and a flow
            # that summarises twelve charts pays for all of it — so `medium`
            # understated the case that matters. `report_read` with
            # `detail="index"` is the cheap way to survey many charts.
            payload="large",
            answers_vi=("Biểu đồ này đang nói gì?",),
        ),
        spec(
            "get_chart_data",
            label_vi="Lấy dữ liệu biểu đồ",
            label_en="Chart data",
            description_vi=(
                "Đọc dữ liệu thật của một biểu đồ, đã áp filter của báo cáo. "
                "Có giới hạn số dòng — muốn xếp hạng hay tính tổng thì dùng nhóm "
                "tính-sẵn ở trên."
            ),
            result_kind="table",
            returns={
                "columns / rows": "dữ liệu thô",
                "coverage": "trả về mấy trên tổng bao nhiêu dòng, sắp theo gì, "
                            "có bị cắt không — ĐỌC trước khi kết luận",
                "filters_applied": "điều kiện lọc đã áp",
            },
            cost_class="data_query",
            payload="large",
            answers_vi=("Cho tôi xem chi tiết từng dòng",),
        ),
        spec(
            "aggregate_chart_data",
            label_vi="Tổng hợp theo chiều khác",
            label_en="Aggregate chart data",
            description_vi="Gộp dữ liệu một biểu đồ theo chiều khác để so sánh.",
            result_kind="table",
            returns={
                "groups": "mỗi nhóm: khoá và giá trị đã gộp",
                "aggregation": "phép gộp đã dùng",
            },
            cost_class="data_query",
            payload="scales_with_report",
            answers_vi=("Gộp doanh thu theo tháng giúp tôi",),
        ),
        spec(
            "compute",
            label_vi="Tính toán",
            label_en="Compute",
            description_vi="Tính một biểu thức số học trên các giá trị đã lấy được.",
            result_kind="value",
            returns={
                "result": "kết quả của biểu thức",
                "vars": "các giá trị đầu vào đã dùng",
                "citations": "số này lấy từ đâu",
            },
            answers_vi=("Tính tỉ lệ giữa hai số vừa đọc",),
        ),
    ],
)
