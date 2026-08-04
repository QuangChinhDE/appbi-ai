"""Replace the legacy-wrapper flows with real multi-agent pipelines.

Every shipped flow was ``guard → route → legacy → verify → end``, where the
`legacy` node handed the whole turn to the pre-v2 monolithic agent. So the
product promised a multi-agent brain and delivered the old single bot wearing a
diagram. This migration makes the shipped flows what they claim to be.

TWO LANES, because a question like "what is total revenue" should not pay for a
five-step pipeline:

    lookup   guard → context → answer(1 agent, few tools) → verify → deliver
    analyse  guard → context → analyst(tools) → composer(NO tools) → verify
                   → (repair once) → deliver

The split between analyst and composer is the point. The analyst may call tools
and writes structured findings; the composer may call NOTHING and can only
restate what the analyst found. A step that cannot fetch a number cannot invent
one — that is a property of the wiring, not of how well the prompt is written.

`deliver` exists so the answer reaches the browser only AFTER verification. The
composing steps buffer (`stream: false`); without that, "repair" and "strip"
would be fiction because the viewer has already read the number.

ON PROMPT LENGTH: these role prompts are short on purpose. The engine appends
them to the full system prompt, which already carries the analysis guardrails,
the insight ladder, the [chart:N]/[HIGH] citation contract, the format rules and
"answer in the language of the question". A role prompt says what this STEP is
for; restating the rules would only create a second copy to drift.

Revision ID: 20260808_0037
Revises: 20260807_0036
"""
from alembic import op
import sqlalchemy as sa

revision = "20260808_0037"
down_revision = "20260807_0036"
branch_labels = None
depends_on = None


ANALYST_PROMPT = """\
Nhiệm vụ của bạn ở bước này: LẤY SỐ, KHÔNG VIẾT CÂU TRẢ LỜI.

- Dùng công cụ để đọc đúng những biểu đồ liên quan tới câu hỏi. Không đoán.
- Với mỗi phát hiện, ghi rõ: con số, đơn vị, kỳ, và biểu đồ nguồn [chart:<id>].
- Nếu số liệu không đủ để kết luận, nói rõ thiếu gì — đừng lấp bằng suy đoán.
- KHÔNG viết mở bài, KHÔNG khuyến nghị hành động. Bước sau lo việc đó.

Kết quả của bạn là danh sách phát hiện có căn cứ, để bước soạn dùng lại."""

COMPOSER_PROMPT = """\
Nhiệm vụ của bạn ở bước này: VIẾT CÂU TRẢ LỜI CUỐI CÙNG.

- Bạn KHÔNG có công cụ nào. Chỉ được dùng đúng những con số đã có ở phần kết quả
  các bước trước. Tuyệt đối không tự tính thêm, không ước lượng, không bịa.
- Nếu phần kết quả trước không có con số cần thiết, nói thẳng là chưa đủ dữ liệu.
- Mở đầu bằng kết luận, rồi mới tới số liệu chứng minh.
- Giữ nguyên nguồn [chart:<id>] mà bước phân tích đã ghi."""

LOOKUP_PROMPT = """\
Nhiệm vụ của bạn ở bước này: TRẢ LỜI NHANH MỘT CON SỐ.

- Câu hỏi thuộc dạng tra cứu. Đọc đúng một hoặc hai biểu đồ cần thiết rồi trả
  lời ngắn gọn — không mở rộng phân tích, không khuyến nghị.
- Mọi con số phải kèm nguồn [chart:<id>].
- Nếu câu hỏi thật ra cần phân tích sâu, nói rằng bạn chỉ trả lời được phần tra
  cứu và nêu phần còn thiếu."""

ANALYST_TOOLS = [
    "list_charts", "get_chart_summary", "get_chart_data",
    "compare_periods", "compare_segments", "explain_change",
    "analyze_trend", "compute", "describe_distribution",
]
LOOKUP_TOOLS = ["list_charts", "get_chart_summary", "get_chart_data", "compute"]

AGENTS = [
    {
        "agent_key": "data_analyst",
        "display_name": "Chuyên viên phân tích dữ liệu",
        "model_policy": "deep_reason",
        "prompt_template": ANALYST_PROMPT,
        "tool_allowlist": ANALYST_TOOLS,
        "writable_state_fields": ["findings"],
    },
    {
        "agent_key": "composer",
        "display_name": "Người soạn câu trả lời",
        "model_policy": "compose",
        "prompt_template": COMPOSER_PROMPT,
        # Empty is the whole point: no tools means no invented numbers.
        "tool_allowlist": [],
        "writable_state_fields": ["answer"],
    },
    {
        "agent_key": "quick_lookup",
        "display_name": "Trả lời nhanh",
        "model_policy": "fast_classify",
        "prompt_template": LOOKUP_PROMPT,
        "tool_allowlist": LOOKUP_TOOLS,
        "writable_state_fields": ["answer"],
    },
]

_CTX = {
    "type": "context",
    "next": None,
    "config": {
        "sources": ["metric", "term", "rule", "playbook", "instruction", "doc", "memory"],
        "max_tokens": 3000,
        "writable_state_fields": ["context_block"],
    },
}


def _analyse_graph() -> dict:
    return {
        "entrypoint": "guard",
        "requires_tools": True,
        "nodes": {
            "guard": {"type": "guard", "next": "context",
                      "routes": {"blocked": "deliver"},
                      "position": {"x": 0, "y": 0}},
            "context": {**_CTX, "next": "analyst", "position": {"x": 260, "y": 0}},
            "analyst": {
                "type": "agent", "agent": "data_analyst@2", "next": "composer",
                "tools": ANALYST_TOOLS, "position": {"x": 520, "y": 0},
                "config": {"writable_state_fields": ["findings"], "stream": False},
            },
            "composer": {
                "type": "agent", "agent": "composer@2", "next": "verify",
                "tools": [], "position": {"x": 780, "y": 0},
                "config": {"writable_state_fields": ["answer"], "stream": False},
            },
            "verify": {
                "type": "verify", "handler": "verify_claims",
                "on_success": "deliver", "on_failure": "composer",
                "position": {"x": 1040, "y": 0},
                "config": {"writable_state_fields": ["verification"]},
            },
            # on_failure loops back to composer exactly once — max_loops_per_node
            # is 1, so the second failure falls through to deliver, which applies
            # on_fail. That IS "repair once, then strip".
            "deliver": {
                "type": "deliver", "next": "end", "position": {"x": 1300, "y": 0},
                "config": {"on_fail": "strip", "writable_state_fields": ["answer"]},
            },
            "end": {"type": "end", "position": {"x": 1560, "y": 0}},
        },
        "limits": {
            "max_model_calls": 6, "max_tool_calls": 14,
            "deadline_seconds": 180, "max_usd": 0.35, "max_loops_per_node": 1,
        },
    }


def _lookup_graph() -> dict:
    return {
        "entrypoint": "guard",
        "requires_tools": True,
        "nodes": {
            "guard": {"type": "guard", "next": "context",
                      "routes": {"blocked": "deliver"},
                      "position": {"x": 0, "y": 0}},
            "context": {**_CTX, "next": "answer", "position": {"x": 260, "y": 0},
                        "config": {**_CTX["config"], "max_tokens": 1500}},
            "answer": {
                "type": "agent", "agent": "quick_lookup@1", "next": "verify",
                "tools": LOOKUP_TOOLS, "position": {"x": 520, "y": 0},
                "config": {"writable_state_fields": ["answer"], "stream": False},
            },
            "verify": {
                "type": "verify", "handler": "verify_claims",
                "on_success": "deliver", "on_failure": "deliver",
                "position": {"x": 780, "y": 0},
                "config": {"writable_state_fields": ["verification"]},
            },
            "deliver": {
                "type": "deliver", "next": "end", "position": {"x": 1040, "y": 0},
                "config": {"on_fail": "flag", "writable_state_fields": ["answer"]},
            },
            "end": {"type": "end", "position": {"x": 1300, "y": 0}},
        },
        "limits": {
            "max_model_calls": 3, "max_tool_calls": 6,
            "deadline_seconds": 90, "max_usd": 0.12, "max_loops_per_node": 1,
        },
    }


def upgrade() -> None:
    conn = op.get_bind()
    now = sa.func.now()

    # ── Specialists ─────────────────────────────────────────────────────────
    # A NEW version rather than an update: a published prompt is what some
    # report is answering with right now, and rewriting it in place would change
    # live behaviour with no version to roll back to.
    for spec in AGENTS:
        existing = conn.execute(
            sa.text("SELECT MAX(version) FROM ai_agent_versions WHERE agent_key = :k"),
            {"k": spec["agent_key"]},
        ).scalar()
        version = int(existing or 0) + 1
        if existing:
            conn.execute(
                sa.text(
                    "UPDATE ai_agent_versions SET status = 'archived' "
                    "WHERE agent_key = :k AND status = 'published'"
                ),
                {"k": spec["agent_key"]},
            )
        conn.execute(
            sa.text(
                "INSERT INTO ai_agent_versions "
                "(agent_key, version, status, display_name, model_policy, "
                " prompt_template, input_schema, output_schema, tool_allowlist, "
                " writable_state_fields, runtime_config, is_builtin, published_at, created_at) "
                "VALUES (:k, :v, 'published', :n, :p, :tpl, '{}', '{}', "
                " CAST(:tools AS JSON), CAST(:writes AS JSON), '{}', true, now(), now())"
            ),
            {
                "k": spec["agent_key"], "v": version, "n": spec["display_name"],
                "p": spec["model_policy"], "tpl": spec["prompt_template"],
                "tools": _json(spec["tool_allowlist"]),
                "writes": _json(spec["writable_state_fields"]),
            },
        )

    # ── Flows ───────────────────────────────────────────────────────────────
    # Every existing flow is rewritten, including user copies: they were all
    # clones of the legacy-wrapper shape, and leaving one behind would leave a
    # `legacy` node in a schema that no longer has the type.
    plans = {
        "builtin_lookup_v1": _lookup_graph(),
        "builtin_thinking_v1": _analyse_graph(),
    }
    # The old names described the wrapper ("bọc trợ lý hiện tại" — wraps the
    # current assistant). There is no wrapper any more, and a name that
    # describes deleted machinery is worse than no name.
    names = {
        "builtin_lookup_v1": "Tra cứu nhanh (mẫu)",
        "builtin_thinking_v1": "Phân tích đầy đủ (mẫu)",
    }
    rows = conn.execute(
        sa.text("SELECT id, flow_key, graph::text FROM ai_flow_versions")
    ).fetchall()
    for row in rows:
        graph = plans.get(row[1])
        if graph is None:
            # Not one of ours. Rewrite only if it still uses the removed node.
            if '"legacy"' not in (row[2] or ""):
                continue
            graph = _analyse_graph()
        conn.execute(
            sa.text(
                "UPDATE ai_flow_versions SET graph = CAST(:g AS JSON), "
                "limits = CAST(:l AS JSON) WHERE id = :i"
            ),
            {"g": _json(graph), "l": _json(graph["limits"]), "i": row[0]},
        )
        new_name = names.get(row[1])
        if new_name:
            conn.execute(
                sa.text("UPDATE ai_flow_versions SET display_name = :n WHERE id = :i"),
                {"n": new_name, "i": row[0]},
            )


def downgrade() -> None:
    """Put the legacy wrapper back.

    Rewriting graphs is destructive to author edits, so downgrade restores the
    SHAPE that existed before rather than pretending to restore content.
    """
    conn = op.get_bind()
    legacy = {
        "entrypoint": "guard",
        "requires_tools": True,
        "nodes": {
            "guard": {"type": "guard", "next": "route", "routes": {"blocked": "end"}},
            "route": {"type": "route", "next": "legacy",
                      "routes": {"normal": "legacy", "thinking": "legacy", "*": "legacy"}},
            "legacy": {"type": "legacy", "next": "verify",
                       "config": {"mode": "auto", "writable_state_fields": [
                           "answer", "usd", "tool_calls", "model_calls"]}},
            "verify": {"type": "function", "handler": "verify_claims",
                       "on_success": "end", "on_failure": "end",
                       "config": {"writable_state_fields": ["verification"]}},
            "end": {"type": "end"},
        },
        "limits": {"max_model_calls": 12, "max_tool_calls": 20,
                   "deadline_seconds": 240, "max_usd": 1.0, "max_loops_per_node": 1},
    }
    conn.execute(
        sa.text("UPDATE ai_flow_versions SET graph = CAST(:g AS JSON)"),
        {"g": _json(legacy)},
    )
    for key in ("data_analyst", "composer", "quick_lookup"):
        conn.execute(
            sa.text(
                "DELETE FROM ai_agent_versions WHERE agent_key = :k AND version > 1"
            ),
            {"k": key},
        )
        conn.execute(
            sa.text(
                "UPDATE ai_agent_versions SET status = 'published' "
                "WHERE agent_key = :k AND version = 1"
            ),
            {"k": key},
        )


def _json(value) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)
