"""Canonical definitions of the system-seeded flows.

The migration that first inserts these carries its OWN frozen copy — that is
correct for migrations, which must keep working against old code. This module
is the LIVE definition: what a re-seed writes, and what the validator test
checks. A test asserts the two stay structurally identical so drift is caught
at CI time rather than by a customer whose seeded flow no longer matches the
engine's node vocabulary.
"""
from __future__ import annotations

BUILTIN_THINKING_FLOW_KEY = "builtin_thinking_v1"

# The migration bridge: guard → route → legacy → verify → end.
#
# `legacy` runs the pre-v2 Normal/Thinking agent unchanged, so answers stay
# byte-identical while trace, evidence, budget and node timing come along for
# free. With INTELLIGENCE_VERIFIER_MODE at its default ("off") the verify node
# is a no-op, which makes this graph behaviourally identical to today.
BUILTIN_THINKING_GRAPH: dict = {
    "entrypoint": "guard",
    "requires_tools": True,
    "nodes": {
        "guard": {
            "type": "guard",
            "next": "route",
            "routes": {"blocked": "end"},
        },
        "route": {
            "type": "route",
            "next": "legacy",
            "routes": {"normal": "legacy", "thinking": "legacy", "*": "legacy"},
        },
        "legacy": {
            "type": "legacy",
            "next": "verify",
            "config": {
                "mode": "auto",
                "writable_state_fields": [
                    "answer", "usd", "tool_calls", "model_calls",
                ],
            },
        },
        "verify": {
            "type": "function",
            "handler": "verify_claims",
            "on_success": "end",
            "on_failure": "end",
            "config": {"writable_state_fields": ["verification"]},
        },
        "end": {"type": "end"},
    },
    "limits": {
        "max_model_calls": 12,
        "max_tool_calls": 20,
        "deadline_seconds": 240,
        "max_usd": 1.0,
        "max_loops_per_node": 1,
    },
}

BUILTIN_LOOKUP_FLOW_KEY = "builtin_lookup_v1"

# Template for the short lane. Deliberately built from the SAME node types the
# Studio offers, so cloning it produces a graph an author can actually read and
# edit — a template made of special-case internals would teach nothing.
BUILTIN_LOOKUP_GRAPH: dict = {
    "entrypoint": "guard",
    "requires_tools": True,
    "nodes": {
        "guard": {"type": "guard", "next": "route", "routes": {"blocked": "end"}},
        "route": {
            "type": "route",
            "next": "answer",
            "routes": {"normal": "answer", "thinking": "answer", "*": "answer"},
        },
        "answer": {
            "type": "legacy",
            "next": "verify",
            "config": {
                "mode": "normal",
                "writable_state_fields": ["answer", "usd", "tool_calls", "model_calls"],
            },
        },
        "verify": {
            "type": "function",
            "handler": "verify_claims",
            "on_success": "end",
            "on_failure": "end",
            "config": {"writable_state_fields": ["verification"]},
        },
        "end": {"type": "end"},
    },
    "limits": {
        "max_model_calls": 3,
        "max_tool_calls": 6,
        "deadline_seconds": 60,
        "max_usd": 0.05,
        "max_loops_per_node": 1,
    },
}

# Seeded agents. Prompts live here rather than in Python constants so an author
# can fork and reword them without a deploy — that is the entire point of the
# registry.
BUILTIN_AGENTS: tuple[dict, ...] = (
    {
        "agent_key": "composer",
        "display_name": "Người soạn câu trả lời",
        "model_policy": "compose",
        "tool_allowlist": [],
        "writable_state_fields": ["answer"],
        "prompt_template": (
            "Bạn viết câu trả lời cuối cùng cho người xem báo cáo.\n\n"
            "QUY TẮC:\n"
            "- CHỈ dùng số liệu đã có trong phần kết quả phân tích bên dưới. "
            "Tuyệt đối không tự tính thêm, không ước lượng, không bịa.\n"
            "- Mở đầu bằng kết luận, sau đó mới tới số liệu chứng minh.\n"
            "- Mỗi con số phải kèm nguồn dạng [chart:<id>].\n"
            "- Viết tiếng Việt, ngắn gọn, tối đa 5 gạch đầu dòng.\n"
            "- Nếu dữ liệu không đủ để kết luận, nói thẳng là chưa đủ."
        ),
        "runtime_config": {"timeout_seconds": 30, "max_output_tokens": 1200},
    },
    {
        "agent_key": "data_analyst",
        "display_name": "Chuyên viên phân tích dữ liệu",
        "model_policy": "deep_reason",
        "tool_allowlist": [
            "list_charts", "get_chart_summary", "get_chart_data",
            "compare_periods", "compare_segments", "explain_change",
            "analyze_trend", "compute",
        ],
        "writable_state_fields": ["findings", "evidence_ids", "tool_calls", "model_calls", "usd"],
        "prompt_template": (
            "Bạn là chuyên viên phân tích dữ liệu, làm việc trong phạm vi MỘT báo cáo.\n\n"
            "NHIỆM VỤ: dùng công cụ để lấy số liệu và rút ra phát hiện. "
            "KHÔNG đưa khuyến nghị hành động — việc đó của bước sau.\n\n"
            "QUY TẮC:\n"
            "- Mọi con số phải đến từ kết quả công cụ, không lấy từ trí nhớ.\n"
            "- Ghi rõ biểu đồ nguồn cho từng phát hiện.\n"
            "- Nếu một công cụ báo lỗi 2 lần, dừng và dùng dữ liệu đang có.\n"
            "- Nêu rõ điều gì chưa kết luận được thay vì đoán."
        ),
        "runtime_config": {"timeout_seconds": 60, "max_model_calls": 3},
    },
    {
        "agent_key": "advisor",
        "display_name": "Chuyên gia tư vấn nghiệp vụ",
        "model_policy": "deep_reason",
        "tool_allowlist": ["recall_knowledge"],
        "writable_state_fields": ["recommendations"],
        "prompt_template": (
            "Bạn chuyển các phát hiện phân tích thành ý nghĩa nghiệp vụ và khuyến nghị.\n\n"
            "QUY TẮC:\n"
            "- Chỉ dựa trên phát hiện đã được kiểm chứng ở bước trước.\n"
            "- Mỗi khuyến nghị phải nêu rõ dựa vào phát hiện nào.\n"
            "- Ưu tiên theo mức tác động; tối đa 3 khuyến nghị.\n"
            "- Không tự tạo thêm số liệu mới.\n"
            "- Nêu rõ giới hạn: điều gì cần thêm dữ liệu mới khẳng định được."
        ),
        "runtime_config": {"timeout_seconds": 45},
    },
    {
        "agent_key": "critic",
        "display_name": "Người phản biện",
        "model_policy": "critic",
        "tool_allowlist": [],
        "writable_state_fields": ["findings"],
        "prompt_template": (
            "Bạn soi lại kết quả phân tích trước khi nó tới tay người xem.\n\n"
            "TÌM:\n"
            "- Kết luận không có số liệu chống lưng.\n"
            "- Mâu thuẫn giữa các phát hiện.\n"
            "- Suy diễn nhân quả khi mới chỉ có tương quan.\n"
            "- Số liệu bị cắt/lấy mẫu nhưng nói như toàn bộ.\n\n"
            "Trả lời ngắn: những điểm cần sửa. Nếu không có vấn đề, nói 'đạt'."
        ),
        "runtime_config": {"timeout_seconds": 30},
    },
)

BUILTIN_FLOWS: dict[str, dict] = {
    BUILTIN_THINKING_FLOW_KEY: {
        "display_name": "Luồng mặc định (bọc trợ lý hiện tại)",
        "graph": BUILTIN_THINKING_GRAPH,
    },
    BUILTIN_LOOKUP_FLOW_KEY: {
        "display_name": "Luồng tra cứu nhanh (mẫu)",
        "graph": BUILTIN_LOOKUP_GRAPH,
    },
}
