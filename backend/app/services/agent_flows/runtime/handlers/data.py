"""Nodes that fetch, without a model deciding to fetch.

WHY THESE EXIST
---------------
Before this, "read the open report" was only expressible as an AI Agent granted
three tools: a model call to decide to do the obvious thing, then the tool calls,
then another model call to summarise them. These nodes do the fetch directly. They
cost no tokens, cannot hallucinate a number, and cannot decide not to bother.

They call the SAME tool implementations an agent would — the data path (public
filters merged in, semantic layer resolved, snapshot vs live chosen, column types
coerced) is where years of corrections live, and having a second one would be
having a second set of bugs.
"""
from __future__ import annotations

import logging
from typing import Any, AsyncGenerator
from urllib.parse import urlparse

from app.services.agent_flows.contract import KnowledgeNode, ReportReadNode, WebNode
from app.services.agent_flows.envelope import Citation, Notice
from app.services.agent_flows.runtime.nodes import NodeSpec
from app.services.agent_flows.runtime.state import RunState
from app.services.agent_flows.tools import registry as tool_registry
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)


def _call(rctx: Any, state: RunState, tool: str, args: dict) -> Any:
    """Run one tool as the ENGINE, not as a model.

    `allowed=None` because there is no allowlist to enforce: the author picked this
    node type, and the node type is the grant. What still bounds it is the binding —
    `ctx.allowed_chart_ids` was narrowed before the first node ran.
    """
    state.budget.spend_tool()
    result = tool_registry.execute(rctx.ctx, tool, args, allowed=None)
    # Everything the run READ, so the answer's figures can be checked against it.
    state.add_evidence(result)
    return result


# ═══ Read the open report ═════════════════════════════════════════════════════
async def run_report_read(
    node: ReportReadNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    allowed = set(rctx.inp.binding.allowed_chart_ids or [])
    wanted = [c for c in (node.chart_ids or []) if not allowed or c in allowed]
    if not wanted:
        wanted = sorted(allowed) or [c.id for c in rctx.inp.report.charts]
    # A node that names a chart the binding does not allow is an authoring mistake
    # the preflight catches; at run time it is simply dropped, never widened.
    dropped = [c for c in (node.chart_ids or []) if allowed and c not in allowed]
    if dropped:
        state.notices.append(
            Notice(
                code="chart_not_allowed",
                text=f"Bước “{node.name or node.key}” bỏ qua biểu đồ không được cấp: "
                     f"{', '.join(str(d) for d in dropped)}.",
            )
        )

    out: dict[str, Any] = {"charts": [], "filters": None}
    yield AgentEvent(type="status", text="Đang đọc báo cáo…")

    if node.include_filters:
        out["filters"] = _call(rctx, state, "inspect_filters", {})

    for chart_id in wanted[:20]:
        entry: dict[str, Any] = {"chart_id": chart_id}
        meta = rctx.inp.report.chart(chart_id)
        if meta:
            entry["title"] = meta.title
            entry["chart_type"] = meta.chart_type
        if node.include_summary:
            entry["summary"] = _call(rctx, state, "get_chart_summary", {"chart_id": chart_id})
        if node.include_data and rctx.inp.binding.capabilities.read_rows:
            entry["data"] = _call(
                rctx, state, "get_chart_data",
                {"chart_id": chart_id, "top_n": min(node.max_rows, rctx.inp.binding.capabilities.max_rows_per_call)},
            )
            _flag_partial(entry, state, node)
        out["charts"].append(entry)
        if not any(c.ref == str(chart_id) for c in state.citations):
            state.citations.append(
                Citation(kind="chart", ref=str(chart_id), label=entry.get("title", ""))
            )

    # DID WE ACTUALLY READ ANYTHING?
    #
    # `tool_registry.execute` turns a failure into `{"ok": false, "error": …}` so one
    # broken chart cannot kill a turn — but that shape then travelled into the
    # prompt as if it were data. A warehouse that is briefly unavailable (a schema
    # being rebuilt under it, a pool that lost its connection) produced a context
    # full of error objects, and the model answered from its own memory of the
    # domain rather than saying it could not see anything. Silence about a failed
    # read is how a confident, sourceless answer gets made.
    failed = [
        c.get("chart_id") for c in out["charts"]
        if not _entry_has_data(c)
    ]
    out["read_ok"] = len(failed) < len(out["charts"]) if out["charts"] else False
    if failed:
        out["unreadable_chart_ids"] = failed
        state.notices.append(
            Notice(
                code="charts_unreadable",
                text=f"Không đọc được dữ liệu của {len(failed)} biểu đồ "
                     f"({', '.join(str(f) for f in failed[:4])}). Câu trả lời có thể thiếu.",
            )
        )
    if out["charts"] and not out["read_ok"]:
        # Nothing at all came back. Raised so the node is recorded as an error and
        # the flow's own `on_error` decides — rather than handing a downstream agent
        # an empty context and letting it fill the gap.
        raise RuntimeError(
            "Không đọc được dữ liệu của bất kỳ biểu đồ nào trong phạm vi được cấp."
        )

    state.outputs[node.key] = out


def _entry_has_data(entry: dict) -> bool:
    """Did this chart yield anything usable?"""
    for key in ("summary", "data"):
        payload = entry.get(key)
        if isinstance(payload, dict) and payload.get("ok"):
            return True
    return False


def _flag_partial(entry: dict, state: RunState, node: ReportReadNode) -> None:
    """Say out loud when the rows are only part of the chart.

    OBSERVED, NOT HYPOTHETICAL. A live run read 50 of a chart's 72 categories —
    the row tool caps, the summary knows the real total, and nothing compared the
    two. The model received an alphabetical half of a ranking, presented it as the
    ranking, and filled the missing names from somewhere else. A slice that does
    not announce itself as a slice is read as the whole.
    """
    data = (entry.get("data") or {}).get("data") if isinstance(entry.get("data"), dict) else None
    summary = (entry.get("summary") or {}).get("data") if isinstance(entry.get("summary"), dict) else None
    if not isinstance(data, dict) or not isinstance(summary, dict):
        return
    got = data.get("row_count")
    total = summary.get("total_rows")
    if not isinstance(got, int) or not isinstance(total, int) or total <= got:
        return

    entry["coverage"] = {
        "rows_read": got,
        "rows_total": total,
        "complete": False,
        "note": (
            f"CHỈ ĐỌC ĐƯỢC {got}/{total} DÒNG của biểu đồ này, theo thứ tự biểu đồ trả "
            "về — KHÔNG phải xếp hạng đầy đủ. Không được suy ra thứ hạng, tổng, hay "
            "tên hạng mục nằm ngoài số dòng này."
        ),
    }
    state.notices.append(
        Notice(
            code="partial_rows",
            text=f"Biểu đồ {entry.get('chart_id')} chỉ đọc được {got}/{total} dòng — "
                 "xếp hạng trong câu trả lời có thể chưa đầy đủ.",
        )
    )


# ═══ Retrieval ════════════════════════════════════════════════════════════════
async def run_knowledge(
    node: KnowledgeNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    query = state.resolve_text(node.query) or rctx.inp.question.text()
    yield AgentEvent(type="status", text="Đang tra tri thức…")

    previous_scope = getattr(rctx.ctx, "knowledge_scope", None)
    scope = {"doc_ids": [], "dataset_ids": [], "metric_names": []}
    for k in node.knowledge:
        if k.source == "document" and k.ref.isdigit():
            scope["doc_ids"].append(int(k.ref))
        elif k.source == "semantic" and k.ref.isdigit():
            scope["dataset_ids"].append(int(k.ref))
        elif k.source == "metric":
            scope["metric_names"].append(k.ref)
    if hasattr(rctx.ctx, "knowledge_scope"):
        rctx.ctx.knowledge_scope = scope

    try:
        result = _call(rctx, state, "search_knowledge", {"query": query, "limit": node.top_k})
    finally:
        if previous_scope is not None:
            rctx.ctx.knowledge_scope = previous_scope

    for k in node.knowledge:
        if k.source == "document" and not any(
            c.kind == "document" and c.ref == k.ref for c in state.citations
        ):
            state.citations.append(Citation(kind="document", ref=k.ref, label=k.description[:80]))
    state.outputs[node.key] = result


# ═══ Outside AppBI ════════════════════════════════════════════════════════════
async def run_web(
    node: WebNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """Reach outside — only where the link allows it.

    A link with web off does not fail the flow: the node yields nothing and says so.
    That is what lets one flow serve a link that researches externally and a link
    that must not, without two versions of the flow.
    """
    if not rctx.inp.binding.capabilities.web_search:
        state.notices.append(
            Notice(
                code="web_disabled",
                text=f"Bước “{node.name or node.key}” bị bỏ qua vì link này tắt tìm kiếm web.",
            )
        )
        state.outputs[node.key] = {"ok": False, "skipped": "web_disabled", "results": []}
        yield AgentEvent(type="status", text="Bỏ qua tra cứu web (link tắt).")
        return

    query = state.resolve_text(node.query) or rctx.inp.question.text()
    yield AgentEvent(type="status", text="Đang tra cứu bên ngoài…")
    result = _call(rctx, state, "web_search", {"query": query, "max_results": node.top_k})

    results = result.get("results") if isinstance(result, dict) else None
    kept = _within_domains(results or [], node.allowed_domains)
    if node.allowed_domains and results and len(kept) < len(results):
        # Enforced here, not merely suggested to a model. A domain restriction the
        # model is asked to respect is a preference; this is the restriction.
        state.notices.append(
            Notice(
                code="domains_filtered",
                text=f"Đã bỏ {len(results) - len(kept)} kết quả ngoài danh sách domain cho phép.",
            )
        )

    pages: list[dict] = []
    if node.fetch_pages:
        for item in kept[:3]:
            url = (item or {}).get("url") or ""
            if not url or not _domain_ok(url, node.allowed_domains):
                continue
            pages.append(_call(rctx, state, "fetch_url", {"url": url}))

    for item in kept[:5]:
        url = (item or {}).get("url") or ""
        if url:
            state.citations.append(
                Citation(kind="web", ref=url, url=url, label=(item or {}).get("title", ""))
            )
    state.outputs[node.key] = {"ok": True, "results": kept, "pages": pages}


def _within_domains(results: list[dict], domains: list[str]) -> list[dict]:
    if not domains:
        return list(results)
    return [r for r in results if _domain_ok((r or {}).get("url") or "", domains)]


def _domain_ok(url: str, domains: list[str]) -> bool:
    if not domains:
        return True
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return False
    if not host:
        return False
    # Suffix match so `statista.com` covers `www.statista.com`, anchored on a dot so
    # it does not also cover `notstatista.com`.
    return any(host == d.lower() or host.endswith("." + d.lower().lstrip(".")) for d in domains)


SPECS = [
    NodeSpec(
        type="report_read",
        label_vi="Đọc Dashboard",
        label_en="Dashboard Data",
        description_vi="Đọc biểu đồ, filter và dữ liệu của báo cáo đang mở. Không tốn token.",
        category="data",
        icon="▥",
        handler=run_report_read,
    ),
    NodeSpec(
        type="knowledge",
        label_vi="Tra Knowledge",
        label_en="Knowledge Search",
        description_vi="Tìm trong tài liệu, semantic model và định nghĩa chỉ số.",
        category="data",
        icon="▤",
        handler=run_knowledge,
    ),
    NodeSpec(
        type="web",
        label_vi="Web Research",
        label_en="Web Research",
        description_vi="Tìm thông tin ngoài AppBI. Chỉ chạy trên link đã bật tìm kiếm web.",
        category="data",
        icon="🌐",
        handler=run_web,
        reaches_outside=True,
    ),
]
