# -*- coding: utf-8 -*-
"""Specialized Agent roles: the ONE place a role's tool boundary is written.

A role is a product contract on an ordinary Agent step, not a node type and not
an engine. It names what the step is for, the tools it starts with, the tools it
MAY ever hold, the setup it cannot work without, and a short charter the runtime
appends to its system prompt. Everything else — model, key, knowledge, budget,
retries — is the Agent step exactly as before.

WHY EXPLICIT TOOL NAMES, NEVER PACKS.
A role that said "the measure pack" would grow the day someone added a tool to
that pack, and every published flow holding the role would silently gain it. The
lists below only change when this file changes, and even then a published flow
cannot gain anything: what a step may call is its own GRANTS ∩ its role's
`allowed` (`AgentNode.tool_names`). A profile can narrow a published step; it can
never widen one.

WHERE IT IS ENFORCED.
  * save    — `role_problems`: a grant outside the role, or an unknown role, is a
              422 (`registry.save_draft`), so a forged payload cannot store it.
  * publish — the same check again, not acknowledgeable.
  * run     — `AgentNode.tool_names()` intersects, so a body written before the
              check existed (or edited in the database) still cannot call outside.
The frontend only DISPLAYS these profiles (served by `GET /tools`).

No imports from the contract: the contract imports this module, and the tool
registry is not needed to state a boundary. `test_agent_roles.py` locks every name
here against the live registry so a renamed tool fails loudly instead of quietly
falling out of a role.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: The value an Agent step holds when it has no role — today's behaviour, unbounded
#: by any profile and bounded only by its own grants and the backend's checks.
CUSTOM = ""


@dataclass(frozen=True)
class Role:
    key: str
    label_vi: str
    label_en: str
    #: What the step is for — shown when choosing it.
    purpose_vi: str
    purpose_en: str
    #: When a deterministic node is the better choice. The honest half of a role.
    instead_vi: str
    instead_en: str
    #: What it reads in, what it hands on.
    consumes_vi: str
    consumes_en: str
    produces_vi: str
    produces_en: str
    default_tools: tuple[str, ...]
    #: Superset of `default_tools`. The hard boundary.
    allowed_tools: tuple[str, ...]
    #: Appended to the system prompt at run time. Behaviour, not a suggestion box:
    #: kept short, because every step pays for it.
    charter: str
    #: Default instructions the builder pre-fills (the author edits them freely).
    prompt_vi: str
    prompt_en: str
    #: Setup this role cannot work without, checked at publish (`role_problems`).
    needs_knowledge: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label_vi": self.label_vi, "label_en": self.label_en,
            "purpose_vi": self.purpose_vi, "purpose_en": self.purpose_en,
            "instead_vi": self.instead_vi, "instead_en": self.instead_en,
            "consumes_vi": self.consumes_vi, "consumes_en": self.consumes_en,
            "produces_vi": self.produces_vi, "produces_en": self.produces_en,
            "default_tools": list(self.default_tools),
            "allowed_tools": list(self.allowed_tools),
            "prompt_vi": self.prompt_vi, "prompt_en": self.prompt_en,
            "needs_knowledge": self.needs_knowledge,
            "allows_skills": False, "allows_external": False,
        }


# Shared vocabulary. A role's dependency is spelled here once: a chart-keyed tool
# is useless without a way to learn a chart_id, so every data role that holds one
# also holds `resolve_chart_candidates` + `list_charts` (see
# `contract._CHART_LOOKUP_TOOLS` and `test_grant_has_a_way_in.py`).
_FIND_CHART = ("resolve_chart_candidates", "list_charts")

_NO_INVENTION = (
    "Chỉ dùng số liệu do công cụ trả về hoặc do bước trước bàn giao; không tự "
    "thêm số. Nếu thiếu dữ liệu, nói rõ là thiếu."
)

ROLES: dict[str, Role] = {
    "report_reader": Role(
        key="report_reader",
        label_vi="Đọc báo cáo", label_en="Report Reader",
        purpose_vi="Tìm đúng báo cáo/biểu đồ, xác định phạm vi dữ liệu, bộ lọc và "
                   "khoảng thời gian có dữ liệu, rồi bàn giao cho bước sau.",
        purpose_en="Finds the right report and charts, states the data scope, "
                   "filters and time coverage, and hands them to the next step.",
        instead_vi="Chỉ cần đọc báo cáo đang mở mà không phải chọn lọc? Dùng bước "
                   "“Đọc báo cáo” (không tốn lượt AI).",
        instead_en="Just need the open report as-is? Use the Report Read step — it "
                   "costs no model call.",
        consumes_vi="Câu hỏi của người dùng", consumes_en="The user's question",
        produces_vi="Danh sách biểu đồ liên quan (chart_id), bộ lọc, khoảng thời gian",
        produces_en="Relevant charts (chart_id), filters, time coverage",
        default_tools=("search_business_assets", *_FIND_CHART, "inspect_filters",
                       "describe_time_coverage", "get_chart_glossary",
                       "get_chart_summary"),
        allowed_tools=("search_business_assets", *_FIND_CHART, "inspect_filters",
                       "describe_time_coverage", "get_chart_glossary",
                       "get_chart_summary", "describe_semantic_model",
                       "get_chart_data"),
        charter=(
            "VAI TRÒ: ĐỌC BÁO CÁO. Nhiệm vụ: xác định đúng biểu đồ/tài sản liên "
            "quan, phạm vi dữ liệu, bộ lọc và thời gian có dữ liệu. Liệt kê rõ "
            "chart_id, tên biểu đồ, chỉ số, đơn vị, bộ lọc và khoảng thời gian để "
            "bước sau dùng lại. Không kết luận nguyên nhân, không dự báo. "
            + _NO_INVENTION
        ),
        prompt_vi="Xác định các biểu đồ và chỉ số liên quan đến câu hỏi. Ghi rõ "
                  "chart_id, tên, đơn vị, bộ lọc và khoảng thời gian có dữ liệu.",
        prompt_en="Identify the charts and metrics relevant to the question. List "
                  "each chart_id, name, unit, filters and time coverage.",
    ),
    "knowledge_reader": Role(
        key="knowledge_reader",
        label_vi="Tra cứu tri thức", label_en="Knowledge Reader",
        purpose_vi="Tra Docs/thuật ngữ đã đính kèm: định nghĩa chỉ số, quy tắc "
                   "nghiệp vụ — kèm trích dẫn nguồn.",
        purpose_en="Looks up the attached Docs and glossary — metric definitions, "
                   "business rules — with citations.",
        instead_vi="Luôn cần cùng một tài liệu cho mọi câu hỏi? Dùng bước “Tri "
                   "thức” (truy xuất cố định, không tốn lượt AI).",
        instead_en="Always need the same passages? Use the Knowledge step — "
                   "deterministic retrieval, no model call.",
        consumes_vi="Câu hỏi; các nguồn tri thức đã đính kèm",
        consumes_en="The question; the attached knowledge sources",
        produces_vi="Định nghĩa/quy tắc kèm trích dẫn, hoặc “không tìm thấy”",
        produces_en="Definitions and rules with citations, or “not found”",
        default_tools=("search_knowledge", "read_document", "explain_measurement"),
        allowed_tools=("search_knowledge", "read_document", "explain_measurement",
                       "recall_knowledge", "get_chart_glossary",
                       "describe_semantic_model"),
        charter=(
            "VAI TRÒ: TRA CỨU TRI THỨC. Chỉ trả lời từ nội dung công cụ tra cứu "
            "trả về trong các nguồn được đính kèm; mỗi ý phải ghi nguồn. Nếu không "
            "tìm thấy, nói “không tìm thấy trong tài liệu được cấp” — không suy "
            "đoán, không tính số liệu."
        ),
        prompt_vi="Tra các tài liệu được đính kèm để tìm định nghĩa, quy tắc liên "
                  "quan đến câu hỏi. Trích dẫn nguồn cho từng ý.",
        prompt_en="Search the attached documents for definitions and rules "
                  "relevant to the question. Cite a source for every point.",
        needs_knowledge=True,
    ),
    "metric_analyst": Role(
        key="metric_analyst",
        label_vi="Phân tích chỉ số", label_en="Metric Analyst",
        purpose_vi="Đo chỉ số, so sánh kỳ, xếp hạng, tỷ trọng, phân khúc — bàn giao "
                   "số liệu có nguồn, đơn vị và kỳ rõ ràng.",
        purpose_en="Measures metrics, compares periods, ranks, computes shares and "
                   "segments — every figure with its source, unit and period.",
        instead_vi="Chỉ cần một con số cố định từ một biểu đồ? Dùng bước “Công cụ” "
                   "gọi total_measure trực tiếp.",
        instead_en="Need one fixed figure from one chart? Use a Tool step calling "
                   "total_measure directly.",
        consumes_vi="Câu hỏi; chart_id từ bước đọc báo cáo (nếu có)",
        consumes_en="The question; chart_ids from a reader step (if any)",
        produces_vi="Số liệu đã đo: giá trị, đơn vị, kỳ, phạm vi, nguồn",
        produces_en="Measured figures: value, unit, period, scope, source",
        default_tools=(*_FIND_CHART, "describe_time_coverage", "total_measure",
                       "rank_values", "share_of", "aggregate_chart_data", "compute",
                       "compare_periods", "compare_segments"),
        allowed_tools=(*_FIND_CHART, "describe_time_coverage", "total_measure",
                       "rank_values", "share_of", "aggregate_chart_data", "compute",
                       "compare_periods", "compare_segments", "compare_to_target",
                       "segment_compare", "get_chart_summary", "get_chart_data",
                       "inspect_filters", "get_chart_glossary",
                       "search_business_assets", "explain_measurement"),
        charter=(
            "VAI TRÒ: PHÂN TÍCH CHỈ SỐ. Đo và so sánh bằng công cụ. Mỗi con số phải "
            "kèm đơn vị, kỳ, phạm vi/bộ lọc và biểu đồ nguồn. Nếu bước trước đã "
            "bàn giao chart_id thì dùng lại, không tìm lại. Không giải thích "
            "nguyên nhân. " + _NO_INVENTION
        ),
        prompt_vi="Đo các chỉ số câu hỏi cần và so sánh khi được hỏi. Ghi đơn vị, "
                  "kỳ, phạm vi và biểu đồ nguồn cho từng con số.",
        prompt_en="Measure the metrics the question needs and compare when asked. "
                  "Give unit, period, scope and source chart for every figure.",
    ),
    "diagnostic_analyst": Role(
        key="diagnostic_analyst",
        label_vi="Chẩn đoán biến động", label_en="Diagnostic Analyst",
        purpose_vi="Tìm phân khúc/yếu tố đóng góp vào biến động, phát hiện bất "
                   "thường, đánh giá giả thuyết — không khẳng định nhân quả khi "
                   "dữ liệu không đủ.",
        purpose_en="Finds the segments and drivers behind a change, spots "
                   "anomalies and tests hypotheses — never claims causation the "
                   "data cannot support.",
        instead_vi="Chỉ cần biết tăng hay giảm bao nhiêu? Dùng “Phân tích chỉ số”.",
        instead_en="Only need how much it moved? Use the Metric Analyst.",
        consumes_vi="Câu hỏi; số liệu/chart_id từ các bước trước",
        consumes_en="The question; figures and chart_ids from earlier steps",
        produces_vi="Yếu tố đóng góp có số liệu, mức độ chắc chắn, điều chưa biết",
        produces_en="Contributing drivers with figures, confidence, unknowns",
        default_tools=(*_FIND_CHART, "describe_time_coverage", "compare_periods",
                       "explain_change", "detect_anomaly", "compare_segments",
                       "describe_distribution", "compute"),
        allowed_tools=(*_FIND_CHART, "describe_time_coverage", "compare_periods",
                       "explain_change", "detect_anomaly", "compare_segments",
                       "describe_distribution", "compute", "smart_drilldown",
                       "correlate_charts", "segment_compare", "total_measure",
                       "rank_values", "share_of", "aggregate_chart_data",
                       "analyze_trend", "detect_seasonality", "get_chart_summary",
                       "inspect_filters", "search_business_assets"),
        charter=(
            "VAI TRÒ: CHẨN ĐOÁN. Định lượng mức đóng góp của từng phân khúc/yếu tố "
            "bằng công cụ. Phân biệt rõ: tương quan, đóng góp thống kê, nhân quả — "
            "chỉ gọi là nguyên nhân khi dữ liệu chứng minh; còn lại nói “có thể”. "
            "Nêu rõ điều chưa kiểm chứng được. " + _NO_INVENTION
        ),
        prompt_vi="Phân tích vì sao chỉ số thay đổi: phân khúc nào đóng góp bao "
                  "nhiêu, có bất thường không, điều gì chưa đủ dữ liệu để kết luận.",
        prompt_en="Analyse why the metric changed: which segments contributed how "
                  "much, any anomalies, and what the data cannot yet support.",
    ),
    "answer_writer": Role(
        key="answer_writer",
        label_vi="Viết câu trả lời", label_en="Answer Writer",
        purpose_vi="Tổng hợp kết quả các bước trước thành một câu trả lời nhất "
                   "quán, nêu giới hạn và nguồn. Không truy vấn dữ liệu.",
        purpose_en="Combines the earlier steps' findings into one consistent "
                   "answer with limits and sources. Queries no data.",
        instead_vi="Chỉ có một bước phân tích? Để chính bước đó trả lời, không cần "
                   "thêm bước viết.",
        instead_en="Only one analysis step? Let it answer — no writer needed.",
        consumes_vi="Kết quả của các bước trước", consumes_en="Earlier steps' results",
        produces_vi="Câu trả lời cuối cho người dùng", produces_en="The final answer",
        default_tools=(),
        allowed_tools=(),
        charter=(
            "VAI TRÒ: VIẾT CÂU TRẢ LỜI. Bạn không có công cụ. Chỉ dùng số liệu và "
            "kết luận có trong kết quả các bước trước; không thêm số, không nâng "
            "mức chắc chắn. Nếu các bước mâu thuẫn hoặc thiếu, nói rõ."
        ),
        prompt_vi="Tổng hợp kết quả các bước trước thành câu trả lời ngắn gọn, nêu "
                  "rõ nguồn và giới hạn.",
        prompt_en="Combine the earlier steps' results into a concise answer, with "
                  "sources and limitations.",
    ),
}


def get(role: str | None) -> Role | None:
    return ROLES.get(role or "")


def is_known(role: str | None) -> bool:
    return not role or role in ROLES


def bounded(role: str | None, names: list[str]) -> list[str]:
    """The grants a step may actually call: its grants ∩ its role's boundary.

    Order preserved. A custom step (no role) is returned unchanged. An unknown role
    yields NOTHING — failing closed, because a role that no longer exists cannot
    vouch for any tool.
    """
    if not role:
        return names
    r = ROLES.get(role)
    if r is None:
        return []
    allowed = set(r.allowed_tools)
    return [n for n in names if n in allowed]


def grant_problems(role: str | None, names: list[str]) -> list[str]:
    """Tools outside the role's boundary, as the tool names (empty = fine)."""
    if not role:
        return []
    r = ROLES.get(role)
    if r is None:
        return list(names)
    allowed = set(r.allowed_tools)
    return [n for n in names if n not in allowed]


def catalogue() -> list[dict[str, Any]]:
    return [r.to_dict() for r in ROLES.values()]


def effective_grants_of(node: Any) -> list[Any]:
    """`AgentNode.effective_grants()`, tolerant of a duck-typed step (previews and
    tests build steps from plain namespaces)."""
    fn = getattr(node, "effective_grants", None)
    return list(fn()) if callable(fn) else list(getattr(node, "tools", None) or [])
