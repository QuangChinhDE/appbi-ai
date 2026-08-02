"""Tool catalog — the palette the Flow Studio builds from.

One registry, derived from the tools that actually exist in code. Two consumers:

  * the **validator**, which refuses a flow referencing anything not in here;
  * the **Studio palette**, which can only offer what is in here.

That is the whole safety story of letting a non-engineer compose flows: the
builder picks from a fixed set of capabilities, it never writes code. A tool
added in Python shows up in the palette on the next request, with no frontend
change.

Categories drive the grouping in the UI, and `cost_class` is what lets an author
see, before publishing, that they just put three warehouse queries in a loop.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Category = Literal["metadata", "data", "analytics", "knowledge", "external", "ux"]
CostClass = Literal["cheap", "data_query", "expensive", "external"]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    category: Category
    cost_class: CostClass
    label_vi: str
    label_en: str
    description_vi: str
    # Thinking-only tools are unavailable to a flow whose depth is Normal.
    depths: tuple[str, ...] = ("normal", "thinking")
    # External tools additionally require the link to have web search enabled.
    requires_web: bool = False

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "category": self.category,
            "cost_class": self.cost_class,
            "label_vi": self.label_vi,
            "label_en": self.label_en,
            "description_vi": self.description_vi,
            "depths": list(self.depths),
            "requires_web": self.requires_web,
        }


_TOOLS: tuple[ToolSpec, ...] = (
    # ── metadata ────────────────────────────────────────────────────────────
    ToolSpec("list_charts", "metadata", "cheap", "Liệt kê biểu đồ", "List charts",
             "Lấy danh sách biểu đồ, trang và cấu trúc báo cáo. Không đọc dữ liệu."),
    ToolSpec("inspect_filters", "metadata", "cheap", "Xem bộ lọc", "Inspect filters",
             "Cho biết báo cáo đang bị lọc theo điều kiện gì.", depths=("thinking",)),
    ToolSpec("get_chart_glossary", "metadata", "cheap", "Từ điển biểu đồ", "Chart glossary",
             "Giải thích các trường/chỉ số của một biểu đồ.", depths=("thinking",)),
    # ── data ────────────────────────────────────────────────────────────────
    ToolSpec("get_chart_summary", "data", "data_query", "Tóm tắt biểu đồ", "Chart summary",
             "Số liệu tổng hợp của một biểu đồ: tổng, top, xu hướng, ngoại lệ."),
    ToolSpec("get_chart_data", "data", "data_query", "Dữ liệu chi tiết", "Chart rows",
             "Các dòng dữ liệu thô của biểu đồ (đã áp bộ lọc và phạm vi AI)."),
    ToolSpec("aggregate_chart_data", "data", "data_query", "Tổng hợp theo nhóm", "Aggregate",
             "Gom nhóm và tính tổng/đếm/trung bình trên dữ liệu biểu đồ.", depths=("thinking",)),
    ToolSpec("smart_drilldown", "data", "data_query", "Khoan sâu", "Drilldown",
             "Lọc biểu đồ theo một giá trị cụ thể rồi đọc lại.", depths=("thinking",)),
    # ── analytics (deterministic) ───────────────────────────────────────────
    ToolSpec("compare_periods", "analytics", "data_query", "So sánh kỳ", "Compare periods",
             "So sánh hai khoảng thời gian và tính chênh lệch.", depths=("thinking",)),
    ToolSpec("compare_segments", "analytics", "data_query", "So sánh phân khúc", "Compare segments",
             "So sánh các nhóm trong cùng một biểu đồ."),
    ToolSpec("segment_compare", "analytics", "data_query", "Phân khúc vs phần còn lại", "Segment vs rest",
             "So một phân khúc với toàn bộ phần còn lại.", depths=("thinking",)),
    ToolSpec("analyze_trend", "analytics", "data_query", "Phân tích xu hướng", "Analyze trend",
             "Đọc chuỗi thời gian: hướng, độ dốc, điểm gãy.", depths=("thinking",)),
    ToolSpec("describe_distribution", "analytics", "data_query", "Phân phối", "Distribution",
             "Phân vị, độ tập trung, bất cân đối (Gini).", depths=("thinking",)),
    ToolSpec("correlate_charts", "analytics", "data_query", "Tương quan", "Correlate",
             "Đo tương quan giữa hai biểu đồ.", depths=("thinking",)),
    ToolSpec("detect_anomaly", "analytics", "data_query", "Dò bất thường", "Detect anomaly",
             "Tìm điểm bất thường bằng z-score cuộn và điểm gãy.", depths=("thinking",)),
    ToolSpec("explain_change", "analytics", "data_query", "Phân rã nguyên nhân", "Explain change",
             "Bóc tách mức thay đổi theo chiều — ai đóng góp bao nhiêu.", depths=("thinking",)),
    ToolSpec("forecast_measure", "analytics", "data_query", "Dự báo", "Forecast",
             "Chiếu xu hướng ra tương lai gần.", depths=("thinking",)),
    ToolSpec("compute", "analytics", "cheap", "Tính toán", "Compute",
             "Tính một biểu thức số học trên các giá trị đã lấy được."),
    # ── ux ──────────────────────────────────────────────────────────────────
    ToolSpec("emit_reading_plan", "ux", "cheap", "Phát kế hoạch đọc", "Emit reading plan",
             "Hiện các bước AI định làm, trước khi trả lời.", depths=("thinking",)),
    # ── knowledge ───────────────────────────────────────────────────────────
    ToolSpec("recall_knowledge", "knowledge", "cheap", "Tra tri thức", "Recall knowledge",
             "Tìm trong kho tri thức đã tích luỹ về doanh nghiệp."),
    ToolSpec("remember_fact", "knowledge", "cheap", "Ghi nhớ", "Remember fact",
             "Ghi lại điều người dùng dạy. Nguồn ẩn danh phải qua duyệt."),
    # ── external ────────────────────────────────────────────────────────────
    ToolSpec("web_search", "external", "external", "Tìm trên web", "Web search",
             "Tra cứu thông tin thị trường/ngành bên ngoài báo cáo.",
             depths=("thinking",), requires_web=True),
    ToolSpec("fetch_url", "external", "external", "Đọc trang web", "Fetch URL",
             "Đọc nội dung một đường dẫn cụ thể.", depths=("thinking",), requires_web=True),
    ToolSpec("benchmark_compare", "external", "external", "Đối chiếu chuẩn ngành", "Benchmark",
             "Neo số của báo cáo rồi so với dữ liệu ngành tìm được.",
             depths=("thinking",), requires_web=True),
)

TOOLS: dict[str, ToolSpec] = {t.name: t for t in _TOOLS}


@dataclass(frozen=True)
class HandlerSpec:
    """A deterministic `function` node an author may drop into a flow.

    Authors choose from this list and cannot add to it — that is precisely why
    the Studio is configuration rather than a code-execution surface.
    """
    name: str
    label_vi: str
    description_vi: str
    routes: tuple[str, ...] = ("success", "failure")

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label_vi": self.label_vi,
            "description_vi": self.description_vi,
            "routes": list(self.routes),
        }


_HANDLERS: tuple[HandlerSpec, ...] = (
    HandlerSpec("verify_claims", "Kiểm chứng số liệu",
                "Đối chiếu mọi con số trong câu trả lời với bằng chứng đã thu được. "
                "Bắt buộc có trong mọi luồng sinh số liệu."),
    HandlerSpec("validate_plan", "Kiểm tra kế hoạch",
                "Xem kế hoạch phân tích đã đủ chỉ số và khoảng thời gian chưa. "
                "Thiếu thì rẽ sang bước Hỏi lại thay vì đoán."),
    HandlerSpec("navigate_report", "Tìm biểu đồ phù hợp",
                "Chọn biểu đồ trả lời được câu hỏi, dựa trên cấu trúc báo cáo. "
                "Không tốn lượt AI."),
    HandlerSpec("merge_findings", "Gộp phát hiện",
                "Gộp và khử trùng lặp các phát hiện từ nhiều nhánh."),
    HandlerSpec("compose_template", "Soạn câu trả lời mẫu",
                "Dựng câu trả lời từ các phát hiện theo khuôn có sẵn, không tốn "
                "lượt AI. Không đủ dữ liệu thì rẽ nhánh lỗi."),
    HandlerSpec("noop", "Không làm gì",
                "Bước trống — dùng để nối nhánh khi đang dựng thử."),
)

HANDLERS: dict[str, HandlerSpec] = {h.name: h for h in _HANDLERS}


@dataclass(frozen=True)
class ReducerSpec:
    """How a Parallel node merges what its branches produced.

    Chosen from a list rather than written, for the same reason handlers are:
    two branches writing the same state key without an agreed merge rule is a
    silent data race, and "pick a rule" is a question a person can answer.
    """
    name: str
    label_vi: str
    description_vi: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label_vi": self.label_vi,
            "description_vi": self.description_vi,
        }


_REDUCERS: tuple[ReducerSpec, ...] = (
    ReducerSpec("merge_findings", "Gộp mọi phát hiện",
                "Cộng dồn phát hiện của tất cả các nhánh."),
    ReducerSpec("first_non_empty", "Lấy nhánh trả lời đầu tiên",
                "Dùng kết quả của nhánh đầu tiên có câu trả lời."),
)

REDUCERS: dict[str, ReducerSpec] = {r.name: r for r in _REDUCERS}


# Node types an author may place, with what each one needs. Drives the palette.
NODE_TYPES: tuple[dict, ...] = (
    {"type": "guard", "label_vi": "Chặn đầu vào", "system": True,
     "description_vi": "Lọc prompt injection. Bắt buộc, không xoá được.", "llm": False},
    {"type": "route", "label_vi": "Phân loại câu hỏi", "system": True,
     "description_vi": "Chọn nhánh theo ý định câu hỏi. Không tốn LLM.", "llm": False},
    {"type": "agent", "label_vi": "Chuyên gia AI", "system": False,
     "description_vi": "Một lượt LLM với prompt và danh sách tool riêng.", "llm": True},
    {"type": "tool", "label_vi": "Gọi công cụ", "system": False,
     "description_vi": "Chạy thẳng một công cụ, không qua LLM.", "llm": False},
    {"type": "context", "label_vi": "Nạp tri thức", "system": False,
     "description_vi": "Nạp định nghĩa chỉ số, quy tắc, lưu ý dữ liệu cho các bước sau.", "llm": False},
    {"type": "function", "label_vi": "Bước xử lý", "system": False,
     "description_vi": "Một bước deterministic có sẵn (kiểm tra kế hoạch, gộp phát hiện…).", "llm": False},
    {"type": "verify", "label_vi": "Kiểm chứng số liệu", "system": False,
     "description_vi": "Đối chiếu mọi con số với bằng chứng. Bắt buộc nếu luồng sinh số.", "llm": False},
    {"type": "parallel", "label_vi": "Chạy song song", "system": False,
     "description_vi": "Tách nhiều nhánh phân tích cùng lúc rồi gộp lại.", "llm": False},
    {"type": "clarify", "label_vi": "Hỏi lại người dùng", "system": False,
     "description_vi": "Dừng và hỏi thêm khi câu hỏi còn mơ hồ, thay vì đoán.", "llm": False},
    {"type": "condition", "label_vi": "Rẽ nhánh", "system": False,
     "description_vi": "Rẽ theo một biểu thức đơn giản trên trạng thái.", "llm": False},
    {"type": "legacy", "label_vi": "Trợ lý mặc định", "system": False,
     "description_vi": "Chạy nguyên trợ lý hiện tại. Dùng làm nền khi mới bắt đầu.", "llm": True},
    {"type": "end", "label_vi": "Kết thúc", "system": True,
     "description_vi": "Điểm kết của luồng.", "llm": False},
)

MODEL_POLICIES: tuple[dict, ...] = (
    {"policy": "fast_classify", "label_vi": "Phân loại nhanh",
     "description_vi": "Model rẻ nhất — dùng cho phân loại, kiểm tra ngắn."},
    {"policy": "structured_plan", "label_vi": "Lập kế hoạch",
     "description_vi": "Sinh output có cấu trúc: kế hoạch, điều hướng."},
    {"policy": "deep_reason", "label_vi": "Suy luận sâu",
     "description_vi": "Model mạnh nhất — phân tích, chẩn đoán, tư vấn."},
    {"policy": "compose", "label_vi": "Soạn câu trả lời",
     "description_vi": "Viết câu trả lời cuối từ kết quả đã có."},
    {"policy": "critic", "label_vi": "Phản biện",
     "description_vi": "Soi thiếu sót và mâu thuẫn trong kết luận."},
)

# State fields an agent node may be granted write access to. Anything outside
# this list is refused at runtime (see runtime/state.py FROZEN_FIELDS).
WRITABLE_STATE_FIELDS: tuple[dict, ...] = (
    {"field": "answer", "label_vi": "Câu trả lời"},
    {"field": "findings", "label_vi": "Phát hiện"},
    {"field": "recommendations", "label_vi": "Khuyến nghị"},
    {"field": "plan", "label_vi": "Kế hoạch phân tích"},
    {"field": "intent", "label_vi": "Ý định câu hỏi"},
    {"field": "verification", "label_vi": "Kết quả kiểm chứng"},
    {"field": "evidence_ids", "label_vi": "Mã evidence"},
    {"field": "context_block", "label_vi": "Khối tri thức"},
    {"field": "usd", "label_vi": "Chi phí"},
    {"field": "tool_calls", "label_vi": "Số lần gọi tool"},
    {"field": "model_calls", "label_vi": "Số lần gọi model"},
)


# Knowledge a Context node can load. `locked` entries cannot be switched off:
# a data caveat exists because the number misleads without it, and a certified
# answer exists because someone decided that IS the answer.
CONTEXT_SOURCES: tuple[dict, ...] = (
    {"key": "metric", "label_vi": "Định nghĩa chỉ số", "locked": False},
    {"key": "term", "label_vi": "Thuật ngữ nghiệp vụ", "locked": False},
    {"key": "rule", "label_vi": "Quy tắc nghiệp vụ", "locked": False},
    {"key": "playbook", "label_vi": "Playbook phân tích", "locked": False},
    {"key": "verified_qa", "label_vi": "Hỏi-đáp đã chứng thực", "locked": True},
    {"key": "caveat", "label_vi": "Lưu ý dữ liệu", "locked": True},
    {"key": "instruction", "label_vi": "Chỉ dẫn AI", "locked": False},
    {"key": "doc", "label_vi": "Tài liệu nghiệp vụ", "locked": False},
    {"key": "memory", "label_vi": "Tri thức đã học", "locked": False},
    {"key": "recon", "label_vi": "Ảnh chụp báo cáo", "locked": False},
    {"key": "chart_fields", "label_vi": "Trường của biểu đồ", "locked": False},
)

# Intents the router can emit — the vocabulary a routing table picks from.
INTENTS: tuple[dict, ...] = (
    {"key": "*", "label_vi": "Mọi câu hỏi còn lại"},
    {"key": "lookup", "label_vi": "Tra cứu một con số"},
    {"key": "normal", "label_vi": "Câu hỏi nhanh"},
    {"key": "thinking", "label_vi": "Câu hỏi cần phân tích"},
    {"key": "diagnose_change", "label_vi": "Vì sao thay đổi"},
    {"key": "trend", "label_vi": "Xu hướng"},
    {"key": "anomaly", "label_vi": "Bất thường"},
    {"key": "compare", "label_vi": "So sánh"},
    {"key": "recommendation", "label_vi": "Khuyến nghị hành động"},
    {"key": "explain_metric", "label_vi": "Giải thích chỉ số"},
    {"key": "benchmark_external", "label_vi": "So với thị trường"},
)


def tool_names() -> set[str]:
    return set(TOOLS)


def handler_names() -> set[str]:
    return set(HANDLERS)


def reducer_names() -> set[str]:
    return set(REDUCERS)


def palette() -> dict:
    """Everything the Studio needs to render its palette in one request."""
    return {
        "node_types": list(NODE_TYPES),
        "tools": [t.to_dict() for t in _TOOLS],
        "handlers": [h.to_dict() for h in _HANDLERS],
        "model_policies": list(MODEL_POLICIES),
        "writable_state_fields": list(WRITABLE_STATE_FIELDS),
        "reducers": [r.to_dict() for r in _REDUCERS],
        "context_sources": list(CONTEXT_SOURCES),
        "intents": list(INTENTS),
    }
