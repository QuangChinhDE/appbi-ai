"""Rework: a flow IS a chain of AI Agents, and a public link CHOOSES one.

WHAT CHANGES IN THE DATA
------------------------
1. `ai_flow_versions.graph` now stores the AUTHORED flow — {"steps": [...]}, each
   step carrying its own prompt and capabilities. The runnable graph is compiled
   from it at load time, so the frame (input screening, steering knowledge,
   verification, delivery) is always the CURRENT frame, and fixing the frame
   needs nothing re-published.

2. Specialists move INTO the steps that used them. `ai_agent_versions` existed so
   a node could pin `key@version`. That gave two version axes for one idea, and
   every operation had to keep them in sync: editing a published specialist
   forked a DRAFT, which the flow validator rejected, which blanked the step's
   picker. The prompts are copied into the steps here, then the table goes.

3. Each public link that had a hand-written `ai_bot_report_context_note` gets its
   OWN flow, seeded from the built-in two-step chain with that note folded into
   the analysis step's prompt, published, and pointed at by the link. Nothing a
   person wrote is discarded: the note WAS a way of thinking, and it becomes one
   they can open and edit.

4. `ai_assistants` / `ai_assistant_bindings` go. Resolution used to walk
   link -> dashboard -> global bindings, to an assistant, holding intent->flow
   rules, each able to split traffic to a canary flow. Four indirections between
   a link and a graph, and no way to answer "which flow does this link run?"
   without reading three tables. Now a link names a flow.

WHAT IS DELIBERATELY LEFT ALONE
-------------------------------
`ai_bot_report_context_note` stays on the link. Two OTHER features read it — the
executive Brief and Explore — and silently emptying their context while reworking
the chatbot would break something this change is not about. Chat no longer reads
it.

SELF-CONTAINED
--------------
Every constant below is frozen into this file. 20260806_0035 imported its seed
data from live app code "so the seed cannot drift"; when that module was
regenerated the imported name vanished, `alembic upgrade head` died on a fresh
database, and every report answered "this report has no active AI flow". A
migration records one moment. Drift from today's code is correct; not running is
not.

Revision ID: 20260809_0038
Revises: 20260808_0037
"""
import json
import re

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260809_0038"
down_revision = "20260808_0037"
branch_labels = None
depends_on = None


FROZEN_THINKING_GRAPH = {'steps': [{'key': 'analyst',
            'name': 'Phân tích dữ liệu',
            'prompt': 'Bạn là chuyên viên phân tích dữ liệu của báo cáo này.\n'
                      '\n'
                      'VIỆC CỦA BẠN\n'
                      '1. Đọc câu hỏi, xác định nó cần con số nào.\n'
                      '2. Dùng công cụ để LẤY số thật từ báo cáo. Không đoán, '
                      'không trích từ ký ức.\n'
                      '3. Nếu câu hỏi liên quan tới một khái niệm, quy trình, hoặc '
                      'cách tính một chỉ\n'
                      '   số, hãy tra tri thức doanh nghiệp trước khi tự suy luận: '
                      'search_knowledge,\n'
                      '   rồi read_document nếu đoạn tóm tắt chưa đủ.\n'
                      '4. Nếu số liệu biến động bất thường, tìm nguyên nhân theo '
                      'chiều dữ liệu thay vì\n'
                      '   chỉ nói "tăng/giảm bao nhiêu".\n'
                      '\n'
                      'KHÔNG LÀM\n'
                      '- Không viết câu trả lời cuối cho người xem. Bước sau làm '
                      'việc đó.\n'
                      '- Không nêu con số nào bạn chưa lấy được từ công cụ.\n'
                      '- Không lấy số trong tài liệu rồi coi đó là số đo của báo '
                      'cáo. Tài liệu là định\n'
                      '  nghĩa; dữ liệu biểu đồ mới là số thật.\n'
                      '\n'
                      'TRẢ VỀ\n'
                      'Phần phân tích dạng gạch đầu dòng: từng con số kèm nguồn '
                      '(tên biểu đồ), các phép\n'
                      'so sánh đã làm, và nhận định. Đây là nguyên liệu cho bước '
                      'sau, không phải câu\n'
                      'trả lời.',
            'capabilities': ['report_read',
                             'report_analyze',
                             'knowledge_search',
                             'document_read'],
            'model_policy': 'deep',
            'next': 'writer',
            'position': {'x': 0, 'y': 0}},
           {'key': 'writer',
            'name': 'Soạn câu trả lời',
            'prompt': 'Bạn viết câu trả lời cuối cùng cho người xem báo cáo.\n'
                      '\n'
                      'Bạn KHÔNG có công cụ nào. Mọi con số bạn được dùng đều nằm '
                      'trong phần kết quả\n'
                      'các bước trước. Đó là chủ ý: nếu thiếu số, hãy nói là '
                      'thiếu, đừng tự nghĩ ra.\n'
                      '\n'
                      'CÁCH VIẾT\n'
                      '- Câu đầu trả lời trực tiếp câu hỏi. Không mở bài.\n'
                      '- Mỗi con số phải đúng như bước phân tích đưa ra, kể cả đơn '
                      'vị và kỳ dữ liệu.\n'
                      '- Nêu nguyên nhân/bối cảnh nếu bước trước đã tìm được, và '
                      'nói rõ mức độ chắc\n'
                      '  chắn khi đó chỉ là phỏng đoán.\n'
                      '- Trả lời bằng đúng ngôn ngữ của câu hỏi.\n'
                      '- Ngắn: 3-6 câu, hoặc gạch đầu dòng nếu có nhiều hạng mục.\n'
                      '\n'
                      'NẾU KHÔNG ĐỦ DỮ LIỆU\n'
                      'Nói thẳng là báo cáo chưa có dữ liệu để trả lời, và nêu cần '
                      'thêm gì. Một câu trả\n'
                      'lời trung thực và ngắn tốt hơn một câu nghe hay mà sai.',
            'capabilities': [],
            'model_policy': 'balanced',
            'next': None,
            'position': {'x': 320, 'y': 0}}],
 'verification': {'enabled': True, 'on_fail': 'strip'},
 'limits': {'max_model_calls': 6,
            'max_tool_calls': 14,
            'deadline_seconds': 180,
            'max_usd': 0.35,
            'max_loops_per_node': 1}}

FROZEN_LOOKUP_GRAPH = {'steps': [{'key': 'answer',
            'name': 'Tra cứu nhanh',
            'prompt': 'Bạn trả lời nhanh các câu hỏi tra cứu trên báo cáo này.\n'
                      '\n'
                      '- Lấy đúng con số được hỏi bằng công cụ, rồi trả lời trong '
                      '1-3 câu.\n'
                      '- Luôn kèm đơn vị và kỳ dữ liệu. Không phân tích dài khi '
                      'người ta chỉ hỏi số.\n'
                      '- Nếu câu hỏi thực chất cần tìm nguyên nhân, hãy đưa con số '
                      'trước, rồi nói rõ là\n'
                      '  cần phân tích sâu hơn mới kết luận được nguyên nhân.\n'
                      '- Không nêu con số nào bạn chưa lấy được từ công cụ.\n'
                      '- Trả lời bằng đúng ngôn ngữ của câu hỏi.',
            'capabilities': ['report_read'],
            'model_policy': 'fast',
            'next': None,
            'position': {'x': 0, 'y': 0}}],
 'verification': {'enabled': True, 'on_fail': 'flag'},
 'limits': {'max_model_calls': 3,
            'max_tool_calls': 6,
            'deadline_seconds': 90,
            'max_usd': 0.12,
            'max_loops_per_node': 1}}

FROZEN_FLOWS = {'builtin_thinking_v1': {'display_name': 'Phân tích 2 bước (mặc định)',
                         'description': 'Một agent đọc và phân tích dữ liệu, một '
                                        'agent viết câu trả lời. Agent viết không '
                                        'có công cụ nên không thể tự nghĩ ra số.',
                         'graph': {'steps': [{'key': 'analyst',
                                              'name': 'Phân tích dữ liệu',
                                              'prompt': 'Bạn là chuyên viên phân '
                                                        'tích dữ liệu của báo cáo '
                                                        'này.\n'
                                                        '\n'
                                                        'VIỆC CỦA BẠN\n'
                                                        '1. Đọc câu hỏi, xác định '
                                                        'nó cần con số nào.\n'
                                                        '2. Dùng công cụ để LẤY số '
                                                        'thật từ báo cáo. Không '
                                                        'đoán, không trích từ ký '
                                                        'ức.\n'
                                                        '3. Nếu câu hỏi liên quan '
                                                        'tới một khái niệm, quy '
                                                        'trình, hoặc cách tính một '
                                                        'chỉ\n'
                                                        '   số, hãy tra tri thức '
                                                        'doanh nghiệp trước khi tự '
                                                        'suy luận: '
                                                        'search_knowledge,\n'
                                                        '   rồi read_document nếu '
                                                        'đoạn tóm tắt chưa đủ.\n'
                                                        '4. Nếu số liệu biến động '
                                                        'bất thường, tìm nguyên '
                                                        'nhân theo chiều dữ liệu '
                                                        'thay vì\n'
                                                        '   chỉ nói "tăng/giảm bao '
                                                        'nhiêu".\n'
                                                        '\n'
                                                        'KHÔNG LÀM\n'
                                                        '- Không viết câu trả lời '
                                                        'cuối cho người xem. Bước '
                                                        'sau làm việc đó.\n'
                                                        '- Không nêu con số nào '
                                                        'bạn chưa lấy được từ công '
                                                        'cụ.\n'
                                                        '- Không lấy số trong tài '
                                                        'liệu rồi coi đó là số đo '
                                                        'của báo cáo. Tài liệu là '
                                                        'định\n'
                                                        '  nghĩa; dữ liệu biểu đồ '
                                                        'mới là số thật.\n'
                                                        '\n'
                                                        'TRẢ VỀ\n'
                                                        'Phần phân tích dạng gạch '
                                                        'đầu dòng: từng con số kèm '
                                                        'nguồn (tên biểu đồ), các '
                                                        'phép\n'
                                                        'so sánh đã làm, và nhận '
                                                        'định. Đây là nguyên liệu '
                                                        'cho bước sau, không phải '
                                                        'câu\n'
                                                        'trả lời.',
                                              'capabilities': ['report_read',
                                                               'report_analyze',
                                                               'knowledge_search',
                                                               'document_read'],
                                              'model_policy': 'deep',
                                              'next': 'writer',
                                              'position': {'x': 0, 'y': 0}},
                                             {'key': 'writer',
                                              'name': 'Soạn câu trả lời',
                                              'prompt': 'Bạn viết câu trả lời cuối '
                                                        'cùng cho người xem báo '
                                                        'cáo.\n'
                                                        '\n'
                                                        'Bạn KHÔNG có công cụ nào. '
                                                        'Mọi con số bạn được dùng '
                                                        'đều nằm trong phần kết '
                                                        'quả\n'
                                                        'các bước trước. Đó là chủ '
                                                        'ý: nếu thiếu số, hãy nói '
                                                        'là thiếu, đừng tự nghĩ '
                                                        'ra.\n'
                                                        '\n'
                                                        'CÁCH VIẾT\n'
                                                        '- Câu đầu trả lời trực '
                                                        'tiếp câu hỏi. Không mở '
                                                        'bài.\n'
                                                        '- Mỗi con số phải đúng '
                                                        'như bước phân tích đưa '
                                                        'ra, kể cả đơn vị và kỳ dữ '
                                                        'liệu.\n'
                                                        '- Nêu nguyên nhân/bối '
                                                        'cảnh nếu bước trước đã '
                                                        'tìm được, và nói rõ mức '
                                                        'độ chắc\n'
                                                        '  chắn khi đó chỉ là '
                                                        'phỏng đoán.\n'
                                                        '- Trả lời bằng đúng ngôn '
                                                        'ngữ của câu hỏi.\n'
                                                        '- Ngắn: 3-6 câu, hoặc '
                                                        'gạch đầu dòng nếu có '
                                                        'nhiều hạng mục.\n'
                                                        '\n'
                                                        'NẾU KHÔNG ĐỦ DỮ LIỆU\n'
                                                        'Nói thẳng là báo cáo chưa '
                                                        'có dữ liệu để trả lời, và '
                                                        'nêu cần thêm gì. Một câu '
                                                        'trả\n'
                                                        'lời trung thực và ngắn '
                                                        'tốt hơn một câu nghe hay '
                                                        'mà sai.',
                                              'capabilities': [],
                                              'model_policy': 'balanced',
                                              'next': None,
                                              'position': {'x': 320, 'y': 0}}],
                                   'verification': {'enabled': True,
                                                    'on_fail': 'strip'},
                                   'limits': {'max_model_calls': 6,
                                              'max_tool_calls': 14,
                                              'deadline_seconds': 180,
                                              'max_usd': 0.35,
                                              'max_loops_per_node': 1}}},
 'builtin_lookup_v1': {'display_name': 'Tra cứu nhanh',
                       'description': 'Một agent, trả lời ngắn. Dùng cho báo cáo '
                                      'mà người xem chủ yếu hỏi "số này bao '
                                      'nhiêu".',
                       'graph': {'steps': [{'key': 'answer',
                                            'name': 'Tra cứu nhanh',
                                            'prompt': 'Bạn trả lời nhanh các câu '
                                                      'hỏi tra cứu trên báo cáo '
                                                      'này.\n'
                                                      '\n'
                                                      '- Lấy đúng con số được hỏi '
                                                      'bằng công cụ, rồi trả lời '
                                                      'trong 1-3 câu.\n'
                                                      '- Luôn kèm đơn vị và kỳ dữ '
                                                      'liệu. Không phân tích dài '
                                                      'khi người ta chỉ hỏi số.\n'
                                                      '- Nếu câu hỏi thực chất cần '
                                                      'tìm nguyên nhân, hãy đưa '
                                                      'con số trước, rồi nói rõ '
                                                      'là\n'
                                                      '  cần phân tích sâu hơn mới '
                                                      'kết luận được nguyên nhân.\n'
                                                      '- Không nêu con số nào bạn '
                                                      'chưa lấy được từ công cụ.\n'
                                                      '- Trả lời bằng đúng ngôn '
                                                      'ngữ của câu hỏi.',
                                            'capabilities': ['report_read'],
                                            'model_policy': 'fast',
                                            'next': None,
                                            'position': {'x': 0, 'y': 0}}],
                                 'verification': {'enabled': True,
                                                  'on_fail': 'flag'},
                                 'limits': {'max_model_calls': 3,
                                            'max_tool_calls': 6,
                                            'deadline_seconds': 90,
                                            'max_usd': 0.12,
                                            'max_loops_per_node': 1}}}}


#: Knobs the link no longer owns. Depth is now a property of the chosen flow — a
#: one-step lookup chain and a five-step analysis chain ARE the two modes — and
#: fact-checking belongs to the frame's verify step, not a per-link toggle.
DEAD_LINK_KEYS = ("ai_bot_default_mode", "ai_bot_critique_enabled")

#: Sits between the seeded prompt and the migrated note so whoever opens the
#: generated flow understands where the text came from.
NOTE_PREFACE = (
    "\n\n=== GHI CHU RIENG CUA BAO CAO NAY ===\n"
    "(Chuyen sang tu o ghi chu ngu canh cua link chia se khi he thong doi sang mo "
    "hinh AI Flow. Sua thang o day.)\n"
)


def _has_table(name):
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def _columns(table):
    try:
        return {c["name"] for c in inspect(op.get_bind()).get_columns(table)}
    except Exception:
        return set()


def _slug(text, fallback):
    out = re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")
    return (out or fallback)[:40]


def _as_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _agent_prompts(bind):
    """agent_key -> newest definition, so a step inherits what it used to pin."""
    if not _has_table("ai_agent_versions"):
        return {}
    rows = bind.execute(sa.text(
        "SELECT agent_key, version, prompt_template, display_name, model_policy, "
        "       tool_allowlist "
        "FROM ai_agent_versions ORDER BY agent_key, version"
    )).mappings().all()
    out = {}
    for r in rows:
        out[r["agent_key"]] = {
            "prompt": r["prompt_template"] or "",
            "display_name": r["display_name"] or r["agent_key"],
            "model_policy": r["model_policy"] or "balanced",
            "tool_allowlist": r["tool_allowlist"] or [],
        }
    return out


#: Concrete tool -> the capability that now grants it, for translating a
#: converted step's old allowlist.
TOOL_TO_CAP = {
    "list_charts": "report_read", "get_chart_summary": "report_read",
    "get_chart_data": "report_read", "inspect_filters": "report_read",
    "get_chart_glossary": "report_read", "compute": "report_read",
    "compare_periods": "report_analyze", "compare_segments": "report_analyze",
    "segment_compare": "report_analyze", "explain_change": "report_analyze",
    "analyze_trend": "report_analyze", "describe_distribution": "report_analyze",
    "aggregate_chart_data": "report_analyze", "detect_anomaly": "report_analyze",
    "correlate_charts": "report_analyze", "smart_drilldown": "report_analyze",
    "forecast_measure": "report_analyze", "benchmark_compare": "report_analyze",
    "search_knowledge": "knowledge_search", "read_document": "document_read",
    "remember_fact": "memory", "recall_knowledge": "memory",
    "web_search": "web", "fetch_url": "web",
}

POLICY_MAP = {
    "fast_answer": "fast", "deep_reason": "deep", "balanced": "balanced",
    "fast": "fast", "deep": "deep",
}


def _convert_graph(graph, prompts):
    """A compiled/legacy graph -> an authored flow.

    Walks the old wiring from the entrypoint so the author's ORDER survives. A
    converted flow that ran its steps in dict order would be a different flow.
    """
    nodes = (graph or {}).get("nodes") or {}
    agent_nodes = {
        k: n for k, n in nodes.items()
        if isinstance(n, dict) and n.get("type") == "agent"
    }
    if not agent_nodes:
        return {}

    order, seen, cursor = [], set(), (graph or {}).get("entrypoint")
    while cursor and cursor not in seen:
        seen.add(cursor)
        if cursor in agent_nodes:
            order.append(cursor)
        node = nodes.get(cursor) or {}
        cursor = node.get("next") or node.get("on_success")
    order.extend(k for k in agent_nodes if k not in order)

    steps = []
    for index, key in enumerate(order):
        node = agent_nodes[key]
        ref = str(node.get("agent") or "")
        spec = prompts.get(ref.split("@")[0], {})
        tools = node.get("tools")
        if tools is None:
            tools = spec.get("tool_allowlist") or []
        caps = []
        for tool in tools or []:
            cap = TOOL_TO_CAP.get(tool)
            if cap and cap not in caps:
                caps.append(cap)
        steps.append({
            "key": _slug(key, "step_%d" % (index + 1)),
            "name": node.get("display_name") or spec.get("display_name") or key,
            "prompt": spec.get("prompt", ""),
            "capabilities": caps,
            "model_policy": POLICY_MAP.get(
                str(spec.get("model_policy") or "balanced"), "balanced"
            ),
            "next": None,
            "position": node.get("position") or {"x": index * 320, "y": 0},
        })
    for index in range(len(steps) - 1):
        steps[index]["next"] = steps[index + 1]["key"]

    verify_on = any(
        isinstance(n, dict) and n.get("type") == "verify" for n in nodes.values()
    )
    on_fail = "strip"
    for node in nodes.values():
        if isinstance(node, dict) and node.get("type") == "deliver":
            on_fail = (node.get("config") or {}).get("on_fail") or "strip"
            break
    return {
        "steps": steps,
        "verification": {
            "enabled": verify_on,
            "on_fail": on_fail if on_fail in ("strip", "flag") else "strip",
        },
        "limits": (graph or {}).get("limits") or {},
        "viewport": (graph or {}).get("viewport") or {},
    }


def upgrade():
    bind = op.get_bind()
    if not _has_table("ai_flow_versions"):
        return

    prompts = _agent_prompts(bind)

    # 1. built-in flows: replace outright.
    for flow_key, spec in FROZEN_FLOWS.items():
        graph = spec["graph"]
        limits = json.dumps(graph.get("limits") or {})
        existing = bind.execute(
            sa.text("SELECT id FROM ai_flow_versions WHERE flow_key = :k LIMIT 1"),
            {"k": flow_key},
        ).first()
        if existing:
            bind.execute(
                sa.text(
                    "UPDATE ai_flow_versions SET graph = CAST(:g AS JSON), "
                    " limits = CAST(:l AS JSON), display_name = :n, status = 'published', "
                    " description = :d WHERE flow_key = :k"
                ),
                {"g": json.dumps(graph, ensure_ascii=False), "l": limits,
                 "n": spec["display_name"], "d": spec.get("description"),
                 "k": flow_key},
            )
        else:
            bind.execute(
                sa.text(
                    "INSERT INTO ai_flow_versions "
                    "(flow_key, version, status, display_name, description, graph, "
                    " limits, requires_tools, is_builtin, created_by, published_at, "
                    " created_at) "
                    "VALUES (:k, 1, 'published', :n, :d, CAST(:g AS JSON), "
                    " CAST(:l AS JSON), TRUE, TRUE, 'system', NOW(), NOW())"
                ),
                {"k": flow_key, "n": spec["display_name"],
                 "d": spec.get("description"),
                 "g": json.dumps(graph, ensure_ascii=False), "l": limits},
            )

    # 2. author-built flows: convert in place.
    rows = bind.execute(sa.text(
        "SELECT id, flow_key, graph FROM ai_flow_versions "
        "WHERE is_builtin = FALSE OR is_builtin IS NULL"
    )).mappings().all()
    for row in rows:
        graph = _as_dict(row["graph"])
        if graph.get("steps") is not None:
            continue
        converted = _convert_graph(graph, prompts)
        if not converted.get("steps"):
            # Nothing convertible. Park it as a draft with no steps rather than
            # leave a row the loader rejects mid-answer: the author then sees an
            # empty flow and a validation error that says what to do.
            converted = {
                "steps": [],
                "verification": {"enabled": True, "on_fail": "strip"},
                "limits": graph.get("limits") or {},
            }
            bind.execute(
                sa.text("UPDATE ai_flow_versions SET status = 'draft' WHERE id = :i"),
                {"i": row["id"]},
            )
        bind.execute(
            sa.text("UPDATE ai_flow_versions SET graph = CAST(:g AS JSON) WHERE id = :i"),
            {"g": json.dumps(converted, ensure_ascii=False), "i": row["id"]},
        )

    # 3. links: migrate the note into a flow, then point the link at it.
    if _has_table("dashboard_public_links"):
        links = bind.execute(sa.text(
            "SELECT id, dashboard_id, name, token, appearance_config "
            "FROM dashboard_public_links WHERE appearance_config IS NOT NULL"
        )).mappings().all()
        for link in links:
            cfg = _as_dict(link["appearance_config"])
            if not cfg:
                continue

            changed = False
            for key in DEAD_LINK_KEYS:
                if key in cfg:
                    cfg.pop(key, None)
                    changed = True

            note = str(cfg.get("ai_bot_report_context_note") or "").strip()
            if note and cfg.get("ai_bot_enabled") and not cfg.get("ai_bot_flow_key"):
                flow_key = _slug(
                    "report_%s_%s" % (link["dashboard_id"], link["name"] or link["id"]),
                    "report_%s_%s" % (link["dashboard_id"], link["id"]),
                )
                taken = bind.execute(
                    sa.text("SELECT 1 FROM ai_flow_versions WHERE flow_key = :k LIMIT 1"),
                    {"k": flow_key},
                ).first()
                if taken:
                    flow_key = "%s_%s" % (flow_key[:34], link["id"])

                graph = json.loads(json.dumps(FROZEN_THINKING_GRAPH))
                graph["steps"][0]["prompt"] = (
                    graph["steps"][0]["prompt"] + NOTE_PREFACE + note
                )
                label = link["name"] or str(link["token"])[:8]
                bind.execute(
                    sa.text(
                        "INSERT INTO ai_flow_versions "
                        "(flow_key, version, status, display_name, description, graph, "
                        " limits, requires_tools, is_builtin, created_by, published_at, "
                        " created_at) "
                        "VALUES (:k, 1, 'published', :n, :d, CAST(:g AS JSON), "
                        " CAST(:l AS JSON), TRUE, FALSE, 'system', NOW(), NOW())"
                    ),
                    {
                        "k": flow_key,
                        "n": ("Cach nghi - %s" % label)[:255],
                        "d": ("Tu tao khi chuyen sang AI Flow: ghi chu ngu canh cua "
                              "link chia se da duoc dua vao prompt cua buoc phan tich."),
                        "g": json.dumps(graph, ensure_ascii=False),
                        "l": json.dumps(graph.get("limits") or {}),
                    },
                )
                cfg["ai_bot_flow_key"] = flow_key
                changed = True

            if changed:
                bind.execute(
                    sa.text(
                        "UPDATE dashboard_public_links "
                        "SET appearance_config = CAST(:c AS JSON) WHERE id = :i"
                    ),
                    {"c": json.dumps(cfg, ensure_ascii=False), "i": link["id"]},
                )

    # 4. drop what the model no longer has.
    run_cols = _columns("ai_runs")
    for column in ("assistant_key", "intent"):
        if column in run_cols:
            op.drop_column("ai_runs", column)

    for table in ("ai_assistant_bindings", "ai_assistants", "ai_agent_versions"):
        if _has_table(table):
            op.drop_table(table)


def downgrade():
    """Structural only.

    The dropped tables come back EMPTY and the flow graphs are not un-converted.
    Specialist rows were folded into the steps that used them, so there is no
    lossless inverse — and a downgrade that produced flows referencing
    specialists which no longer exist would be worse than an honest empty table.
    """
    if not _has_table("ai_agent_versions"):
        op.create_table(
            "ai_agent_versions",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("agent_key", sa.String(64), nullable=False, index=True),
            sa.Column("version", sa.Integer, nullable=False, server_default="1"),
            sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
            sa.Column("display_name", sa.String(128), nullable=False, server_default=""),
            sa.Column("model_policy", sa.String(32), nullable=True),
            sa.Column("prompt_template", sa.Text, nullable=True),
            sa.Column("input_schema", sa.JSON, nullable=True),
            sa.Column("output_schema", sa.JSON, nullable=True),
            sa.Column("tool_allowlist", sa.JSON, nullable=True),
            sa.Column("writable_state_fields", sa.JSON, nullable=True),
            sa.Column("runtime_config", sa.JSON, nullable=True),
            sa.Column("is_builtin", sa.Boolean, nullable=False,
                      server_default=sa.text("FALSE")),
            sa.Column("created_by", sa.String(128), nullable=True),
            sa.Column("published_at", sa.DateTime, nullable=True),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        )
    if not _has_table("ai_assistants"):
        op.create_table(
            "ai_assistants",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("key", sa.String(64), nullable=False, unique=True),
            sa.Column("display_name", sa.String(128), nullable=True),
            sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
            sa.Column("routing", sa.JSON, nullable=True),
            sa.Column("budget", sa.JSON, nullable=True),
            sa.Column("knowledge_scope", sa.JSON, nullable=True),
            sa.Column("created_by", sa.String(128), nullable=True),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        )
    if not _has_table("ai_assistant_bindings"):
        op.create_table(
            "ai_assistant_bindings",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("assistant_id", sa.Integer, nullable=False, index=True),
            sa.Column("surface", sa.String(24), nullable=False),
            sa.Column("surface_ref", sa.String(200), nullable=True),
            sa.Column("enabled", sa.Boolean, nullable=False,
                      server_default=sa.text("TRUE")),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        )
    run_cols = _columns("ai_runs")
    if "assistant_key" not in run_cols:
        op.add_column("ai_runs", sa.Column("assistant_key", sa.String(64), nullable=True))
    if "intent" not in run_cols:
        op.add_column("ai_runs", sa.Column("intent", sa.String(32), nullable=True))
