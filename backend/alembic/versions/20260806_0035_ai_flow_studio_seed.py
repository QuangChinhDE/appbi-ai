"""P6: seed the Flow Studio — starter agents + a clonable flow template

An empty Studio is a dead end: the first thing an author needs is something that
already works, to clone and reword. This seeds four published agents (composer,
data_analyst, advisor, critic) and a second built-in flow — the short "lookup"
lane — built from the SAME node types the palette offers, so cloning it yields a
graph a person can actually read.

Idempotent: skips anything already present, so it is safe on a database that
already ran the GĐ2 seed.

Revision ID: 20260806_0035
Revises: 20260805_0034
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260806_0035"
down_revision = "20260805_0034"
branch_labels = None
depends_on = None

SEEDED_AGENT_KEYS = ("composer", "data_analyst", "advisor", "critic")
SEEDED_FLOW_KEY = "builtin_lookup_v1"


# FROZEN COPIES — deliberately duplicated, never imported.
#
# This migration used to read BUILTIN_AGENTS / BUILTIN_LOOKUP_GRAPH from
# app.services.intelligence.registry.builtins "so the live definition and the
# seed cannot drift". That inverted the invariant. A migration is a record of
# what the schema looked like at one moment; the module it read is live code
# that later changed. When builtins.py was regenerated for the agent-first
# graphs, BUILTIN_AGENTS stopped existing and `alembic upgrade head` died here
# on a fresh database with ImportError — so 0036/0037 never ran, no specialist
# was ever seeded, and every report answered "this report has no active AI
# flow". Drift between a migration and today's code is correct and expected;
# a migration that cannot run is not.
#
# The graph below still names the node type of its era (`legacy`). 0037
# rewrites every flow row onto the agent-first graphs, so the row is only ever
# invalid mid-chain, which is what forward migrations are for.
FROZEN_AGENTS: tuple[dict, ...] = ({'agent_key': 'composer',
  'display_name': 'Người soạn câu trả lời',
  'model_policy': 'compose',
  'tool_allowlist': [],
  'writable_state_fields': ['answer'],
  'prompt_template': 'Bạn viết câu trả lời cuối cùng cho người xem báo cáo.\n'
                     '\n'
                     'QUY TẮC:\n'
                     '- CHỈ dùng số liệu đã có trong phần kết quả phân tích bên dưới. '
                     'Tuyệt đối không tự tính thêm, không ước lượng, không bịa.\n'
                     '- Mở đầu bằng kết luận, sau đó mới tới số liệu chứng minh.\n'
                     '- Mỗi con số phải kèm nguồn dạng [chart:<id>].\n'
                     '- Viết tiếng Việt, ngắn gọn, tối đa 5 gạch đầu dòng.\n'
                     '- Nếu dữ liệu không đủ để kết luận, nói thẳng là chưa đủ.',
  'runtime_config': {'timeout_seconds': 30, 'max_output_tokens': 1200}},
 {'agent_key': 'data_analyst',
  'display_name': 'Chuyên viên phân tích dữ liệu',
  'model_policy': 'deep_reason',
  'tool_allowlist': ['list_charts',
                     'get_chart_summary',
                     'get_chart_data',
                     'compare_periods',
                     'compare_segments',
                     'explain_change',
                     'analyze_trend',
                     'compute'],
  'writable_state_fields': ['findings',
                            'evidence_ids',
                            'tool_calls',
                            'model_calls',
                            'usd'],
  'prompt_template': 'Bạn là chuyên viên phân tích dữ liệu, làm việc trong phạm vi MỘT '
                     'báo cáo.\n'
                     '\n'
                     'NHIỆM VỤ: dùng công cụ để lấy số liệu và rút ra phát hiện. KHÔNG '
                     'đưa khuyến nghị hành động — việc đó của bước sau.\n'
                     '\n'
                     'QUY TẮC:\n'
                     '- Mọi con số phải đến từ kết quả công cụ, không lấy từ trí nhớ.\n'
                     '- Ghi rõ biểu đồ nguồn cho từng phát hiện.\n'
                     '- Nếu một công cụ báo lỗi 2 lần, dừng và dùng dữ liệu đang có.\n'
                     '- Nêu rõ điều gì chưa kết luận được thay vì đoán.',
  'runtime_config': {'timeout_seconds': 60, 'max_model_calls': 3}},
 {'agent_key': 'advisor',
  'display_name': 'Chuyên gia tư vấn nghiệp vụ',
  'model_policy': 'deep_reason',
  'tool_allowlist': ['recall_knowledge'],
  'writable_state_fields': ['recommendations'],
  'prompt_template': 'Bạn chuyển các phát hiện phân tích thành ý nghĩa nghiệp vụ và '
                     'khuyến nghị.\n'
                     '\n'
                     'QUY TẮC:\n'
                     '- Chỉ dựa trên phát hiện đã được kiểm chứng ở bước trước.\n'
                     '- Mỗi khuyến nghị phải nêu rõ dựa vào phát hiện nào.\n'
                     '- Ưu tiên theo mức tác động; tối đa 3 khuyến nghị.\n'
                     '- Không tự tạo thêm số liệu mới.\n'
                     '- Nêu rõ giới hạn: điều gì cần thêm dữ liệu mới khẳng định được.',
  'runtime_config': {'timeout_seconds': 45}},
 {'agent_key': 'critic',
  'display_name': 'Người phản biện',
  'model_policy': 'critic',
  'tool_allowlist': [],
  'writable_state_fields': ['findings'],
  'prompt_template': 'Bạn soi lại kết quả phân tích trước khi nó tới tay người xem.\n'
                     '\n'
                     'TÌM:\n'
                     '- Kết luận không có số liệu chống lưng.\n'
                     '- Mâu thuẫn giữa các phát hiện.\n'
                     '- Suy diễn nhân quả khi mới chỉ có tương quan.\n'
                     '- Số liệu bị cắt/lấy mẫu nhưng nói như toàn bộ.\n'
                     '\n'
                     'Trả lời ngắn: những điểm cần sửa. Nếu không có vấn đề, nói '
                     "'đạt'.",
  'runtime_config': {'timeout_seconds': 30}})

FROZEN_LOOKUP_GRAPH: dict = {'entrypoint': 'guard',
 'requires_tools': True,
 'nodes': {'guard': {'type': 'guard', 'next': 'route', 'routes': {'blocked': 'end'}},
           'route': {'type': 'route',
                     'next': 'answer',
                     'routes': {'normal': 'answer',
                                'thinking': 'answer',
                                '*': 'answer'}},
           'answer': {'type': 'legacy',
                      'next': 'verify',
                      'config': {'mode': 'normal',
                                 'writable_state_fields': ['answer',
                                                           'usd',
                                                           'tool_calls',
                                                           'model_calls']}},
           'verify': {'type': 'function',
                      'handler': 'verify_claims',
                      'on_success': 'end',
                      'on_failure': 'end',
                      'config': {'writable_state_fields': ['verification']}},
           'end': {'type': 'end'}},
 'limits': {'max_model_calls': 3,
            'max_tool_calls': 6,
            'deadline_seconds': 60,
            'max_usd': 0.05,
            'max_loops_per_node': 1}}


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table("ai_agent_versions") or not _has_table("ai_flow_versions"):
        return

    for agent in FROZEN_AGENTS:
        exists = bind.execute(
            sa.text("SELECT 1 FROM ai_agent_versions WHERE agent_key = :k LIMIT 1"),
            {"k": agent["agent_key"]},
        ).first()
        if exists:
            continue
        bind.execute(
            sa.text(
                "INSERT INTO ai_agent_versions "
                "(agent_key, version, status, display_name, model_policy, "
                " prompt_template, input_schema, output_schema, tool_allowlist, "
                " writable_state_fields, runtime_config, is_builtin, created_by, "
                " published_at, created_at) "
                "VALUES (:k, 1, 'published', :n, :p, :tpl, "
                " CAST('{}' AS JSON), CAST('{}' AS JSON), CAST(:tools AS JSON), "
                " CAST(:fields AS JSON), CAST(:cfg AS JSON), TRUE, 'system', NOW(), NOW())"
            ),
            {
                "k": agent["agent_key"],
                "n": agent["display_name"],
                "p": agent["model_policy"],
                "tpl": agent["prompt_template"],
                "tools": json.dumps(agent["tool_allowlist"]),
                "fields": json.dumps(agent["writable_state_fields"]),
                "cfg": json.dumps(agent.get("runtime_config") or {}),
            },
        )

    exists = bind.execute(
        sa.text("SELECT 1 FROM ai_flow_versions WHERE flow_key = :k LIMIT 1"),
        {"k": SEEDED_FLOW_KEY},
    ).first()
    if not exists:
        bind.execute(
            sa.text(
                "INSERT INTO ai_flow_versions "
                "(flow_key, version, status, display_name, graph, limits, "
                " requires_tools, is_builtin, created_by, published_at, created_at) "
                "VALUES (:k, 1, 'published', :n, CAST(:g AS JSON), CAST(:l AS JSON), "
                " TRUE, TRUE, 'system', NOW(), NOW())"
            ),
            {
                "k": SEEDED_FLOW_KEY,
                "n": "Luồng tra cứu nhanh (mẫu)",
                "g": json.dumps(FROZEN_LOOKUP_GRAPH, ensure_ascii=False),
                "l": json.dumps(FROZEN_LOOKUP_GRAPH["limits"]),
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table("ai_agent_versions"):
        bind.execute(
            sa.text(
                "DELETE FROM ai_agent_versions "
                "WHERE is_builtin = TRUE AND agent_key = ANY(:keys)"
            ),
            {"keys": list(SEEDED_AGENT_KEYS)},
        )
    if _has_table("ai_flow_versions"):
        bind.execute(
            sa.text("DELETE FROM ai_flow_versions WHERE flow_key = :k AND is_builtin = TRUE"),
            {"k": SEEDED_FLOW_KEY},
        )
