"""Flow validation — the gate that makes a user-built graph safe to publish.

Three severities, and the distinction is deliberate:

  * **error** — publishing this would break or endanger a live report. Hard gate.
  * **warning** — legal, but likely to cost more or behave worse than intended.
  * **suggestion** — a cheaper or clearer way to express the same flow.

Only errors block. Warnings and suggestions exist because the Studio's real job
is teaching: an author who is told *why* a lookup flow with four LLM calls is a
bad idea learns something; one who is merely blocked does not.

Every issue carries `node_key` (and `field_path` where it applies) so the canvas
can focus and highlight the exact spot rather than making the author hunt.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.services.intelligence.schemas.flow import (
    FIGURE_PRODUCING,
    MAX_DEADLINE_SECONDS_CEILING,
    MAX_MODEL_CALLS_CEILING,
    MAX_TOOL_CALLS_CEILING,
    MAX_USD_CEILING,
    VERIFYING,
    FlowGraph,
)

Severity = str  # "error" | "warning" | "suggestion"


@dataclass
class ValidationError:
    code: str
    message: str
    node_key: str | None = None
    severity: Severity = "error"
    field_path: str | None = None
    suggested_action: str | None = None

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "node_key": self.node_key,
            "severity": self.severity,
            "field_path": self.field_path,
            "suggested_action": self.suggested_action,
        }


# Tools whose cost class makes repeated use worth flagging.
_EXPENSIVE_TOOLS = frozenset({
    "web_search", "fetch_url", "benchmark_compare", "render_dashboard_pdf",
})


def validate_flow(
    graph: FlowGraph,
    *,
    known_agents: set[str] | None = None,
    known_tools: set[str] | None = None,
    known_handlers: set[str] | None = None,
    known_reducers: set[str] | None = None,
) -> list[ValidationError]:
    """Return every issue found, most severe first. No errors = publishable.

    The `known_*` sets are injected rather than imported so this can be unit
    tested without booting the tool catalog, and so a deployment that registers
    extra tools needs no change here.
    """
    issues: list[ValidationError] = []
    nodes = graph.nodes

    def err(code, message, node_key=None, field_path=None, action=None):
        issues.append(ValidationError(code, message, node_key, "error", field_path, action))

    def warn(code, message, node_key=None, action=None):
        issues.append(ValidationError(code, message, node_key, "warning", None, action))

    def hint(code, message, node_key=None, action=None):
        issues.append(ValidationError(code, message, node_key, "suggestion", None, action))

    # ── Entry / exit ────────────────────────────────────────────────────────
    if graph.entrypoint not in nodes:
        err("ENTRYPOINT_MISSING",
            f"Điểm bắt đầu '{graph.entrypoint}' không tồn tại.",
            action="Chọn một bước làm điểm bắt đầu.")

    end_keys = {k for k, n in nodes.items() if n.type == "end"}
    if not end_keys:
        err("NO_END_NODE", "Luồng phải có bước Kết thúc.",
            action="Thêm bước Kết thúc.")

    if not any(n.type == "guard" for n in nodes.values()):
        err("NO_GUARD_NODE",
            "Luồng phải có bước Chặn đầu vào — đây là lớp lọc prompt injection "
            "bắt buộc cho chat công khai.",
            action="Thêm bước Chặn đầu vào ở đầu luồng.")

    # ── Per-node wiring ─────────────────────────────────────────────────────
    for key, node in nodes.items():
        label = node.display_name or key

        for succ in node.successors():
            if succ not in nodes:
                err("DANGLING_EDGE",
                    f"“{label}” nối tới một bước không còn tồn tại.", key,
                    action="Nối lại hoặc xoá đường dẫn này.")

        if node.type == "end":
            if node.successors():
                err("END_HAS_SUCCESSOR",
                    f"“{label}” là bước kết thúc, không được nối đi tiếp.", key)
            continue

        if node.disabled:
            warn("NODE_DISABLED", f"“{label}” đang bị tắt — luồng sẽ bỏ qua bước này.", key)

        if not node.successors():
            err("NO_SUCCESSOR",
                f"“{label}” chưa nối đi đâu — luồng sẽ dừng giữa chừng.", key,
                action="Nối bước này tới bước kế tiếp.")

        if node.type == "agent":
            if not node.agent:
                err("AGENT_NOT_SET", f"“{label}” chưa chọn chuyên gia AI.", key,
                    field_path="agent", action="Chọn một chuyên gia đã publish.")
            elif known_agents is not None and node.agent not in known_agents:
                err("UNKNOWN_AGENT",
                    f"“{label}” dùng chuyên gia '{node.agent}' chưa được publish.", key,
                    field_path="agent",
                    action="Publish chuyên gia đó hoặc chọn phiên bản khác.")
            if known_tools is not None:
                for tool in node.tools:
                    if tool not in known_tools:
                        err("UNKNOWN_TOOL",
                            f"“{label}” cho phép công cụ '{tool}' không có trong danh mục.",
                            key, field_path="tools")
            if not (node.config or {}).get("writable_state_fields"):
                hint("AGENT_WRITES_NOTHING",
                     f"“{label}” không được ghi kết quả vào đâu — kết quả của bước này "
                     "sẽ không tới được bước sau.", key,
                     action="Chọn ít nhất một mục ở “Bước này được ghi gì”.")
            expensive = [t for t in node.tools if t in _EXPENSIVE_TOOLS]
            if expensive:
                warn("EXPENSIVE_TOOL",
                     f"“{label}” dùng công cụ tốn phí ngoài: {', '.join(expensive)}.", key)

        elif node.type == "tool":
            if not node.tool:
                err("TOOL_NOT_SET", f"“{label}” chưa chọn công cụ.", key, field_path="tool")
            elif known_tools is not None and node.tool not in known_tools:
                err("UNKNOWN_TOOL",
                    f"“{label}” gọi công cụ '{node.tool}' không có trong danh mục.",
                    key, field_path="tool")

        elif node.type in ("function", "verify"):
            handler = node.handler or ("verify_claims" if node.type == "verify" else None)
            if not handler:
                err("HANDLER_NOT_SET", f"“{label}” chưa chọn bước kiểm tra.", key,
                    field_path="handler")
            elif known_handlers is not None and handler not in known_handlers:
                err("UNKNOWN_HANDLER",
                    f"“{label}” dùng bước kiểm tra '{handler}' không có sẵn.", key,
                    field_path="handler",
                    action="Chọn từ danh sách có sẵn — Xưởng AI không cho viết code.")

        elif node.type == "condition":
            if not node.when:
                err("CONDITION_EMPTY", f"“{label}” chưa có điều kiện.", key, field_path="when")
            if not (node.routes or (node.on_success and node.on_failure)):
                err("CONDITION_NO_BRANCH",
                    f"“{label}” cần cả nhánh đúng và nhánh sai.", key)

        elif node.type == "route":
            if "*" not in node.routes and not node.next:
                err("ROUTE_NO_FALLBACK",
                    f"“{label}” thiếu nhánh mặc định (*) — một số câu hỏi sẽ không "
                    "có nhánh nào xử lý.", key, field_path="routes",
                    action="Thêm một dòng định tuyến “*”.")

        elif node.type == "context":
            sources = (node.config or {}).get("sources") or []
            if not sources:
                err("CONTEXT_NO_SOURCE", f"“{label}” chưa chọn nguồn tri thức nào.", key,
                    field_path="config.sources")
            max_tokens = (node.config or {}).get("max_tokens")
            if isinstance(max_tokens, (int, float)):
                if max_tokens > 12000:
                    warn("CONTEXT_TOKENS_HIGH",
                         f"“{label}” nạp tới {int(max_tokens)} token — tốn chi phí và "
                         "làm loãng sự chú ý của model.", key)
                elif max_tokens < 300:
                    warn("CONTEXT_TOKENS_LOW",
                         f"“{label}” chỉ nạp {int(max_tokens)} token, có thể không đủ "
                         "định nghĩa chỉ số.", key)

        elif node.type == "parallel":
            if len(node.branches) < 2:
                err("PARALLEL_NEEDS_BRANCHES",
                    f"“{label}” cần ít nhất 2 nhánh chạy song song.", key,
                    field_path="branches")
            if not node.reducer:
                err("PARALLEL_NO_REDUCER",
                    f"“{label}” chưa chọn cách gộp kết quả các nhánh.", key,
                    field_path="reducer")
            elif known_reducers is not None and node.reducer not in known_reducers:
                err("UNKNOWN_REDUCER",
                    f"“{label}” dùng cách gộp '{node.reducer}' không có sẵn.", key)

        elif node.type == "clarify":
            if not (node.config or {}).get("question_template"):
                warn("CLARIFY_NO_TEMPLATE",
                     f"“{label}” chưa có câu hỏi làm rõ — hệ thống sẽ dùng câu mặc định.",
                     key)

    # ── Reachability ────────────────────────────────────────────────────────
    if graph.entrypoint in nodes:
        seen: set[str] = set()
        stack = [graph.entrypoint]
        while stack:
            cur = stack.pop()
            if cur in seen or cur not in nodes:
                continue
            seen.add(cur)
            stack.extend(nodes[cur].successors())

        for key in nodes:
            if key not in seen:
                err("UNREACHABLE_NODE",
                    f"“{nodes[key].display_name or key}” không bao giờ chạy tới.", key,
                    action="Nối bước này vào luồng, hoặc xoá đi.")

        if end_keys and not (seen & end_keys):
            err("END_UNREACHABLE",
                "Không nhánh nào đi tới bước Kết thúc — luồng sẽ chạy tới khi hết ngân sách.")

    # ── Verifier obligation ─────────────────────────────────────────────────
    produces = [k for k, n in nodes.items() if n.type in FIGURE_PRODUCING and not n.disabled]
    has_verifier = any(
        n.type in VERIFYING
        or (n.type == "function" and (n.handler or "").startswith("verify"))
        for n in nodes.values()
    )
    if produces and not has_verifier:
        err("NO_VERIFIER",
            "Luồng có bước sinh số liệu nhưng thiếu bước Kiểm chứng. Mọi con số đưa "
            "cho người xem phải đối chiếu được với bằng chứng.",
            produces[0], action="Thêm bước Kiểm chứng trước bước soạn câu trả lời.")

    # ── Budget ──────────────────────────────────────────────────────────────
    lim = graph.limits
    for field, value, ceiling in (
        ("max_model_calls", lim.max_model_calls, MAX_MODEL_CALLS_CEILING),
        ("max_tool_calls", lim.max_tool_calls, MAX_TOOL_CALLS_CEILING),
        ("deadline_seconds", lim.deadline_seconds, MAX_DEADLINE_SECONDS_CEILING),
        ("max_usd", lim.max_usd, MAX_USD_CEILING),
    ):
        if value > ceiling:
            warn("LIMIT_ABOVE_CEILING",
                 f"Giá trị {field}={value} vượt trần hệ thống ({ceiling}) và sẽ bị kẹp "
                 f"về {ceiling} khi chạy.", action="Đặt lại trong giới hạn hệ thống.")

    llm_nodes = [k for k, n in nodes.items() if n.type in FIGURE_PRODUCING and not n.disabled]
    if len(llm_nodes) > lim.max_model_calls:
        warn("MODEL_CALLS_UNDER_BUDGET",
             f"Luồng có {len(llm_nodes)} bước AI nhưng trần chỉ {lim.max_model_calls} lượt — "
             "các bước cuối có thể bị bỏ qua khi chạy.",
             action="Tăng trần hoặc bớt bước AI.")
    if len(llm_nodes) >= 4:
        hint("MANY_LLM_STEPS",
             f"Luồng dùng {len(llm_nodes)} bước AI. Cân nhắc thay một bước bằng bước "
             "chạy bằng code — vừa rẻ vừa ổn định hơn.")

    order = {"error": 0, "warning": 1, "suggestion": 2}
    issues.sort(key=lambda i: order.get(i.severity, 9))
    return issues


def parse_and_validate(raw: dict, **kwargs) -> tuple[FlowGraph | None, list[ValidationError]]:
    """Parse a stored graph then validate it. A malformed row is a validation
    failure, not an exception — the caller is usually rendering issues to a
    person, or falling back to a built-in flow at runtime."""
    try:
        graph = FlowGraph.model_validate(raw)
    except Exception as exc:  # noqa: BLE001
        return None, [ValidationError(
            "SCHEMA_INVALID", f"Cấu trúc luồng không hợp lệ: {exc}", severity="error",
        )]
    return graph, validate_flow(graph, **kwargs)


def has_errors(issues: list[ValidationError]) -> bool:
    return any(i.severity == "error" for i in issues)
