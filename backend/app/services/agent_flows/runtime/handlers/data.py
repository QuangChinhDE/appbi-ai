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

from app.services.agent_flows.contract import (
    KnowledgeNode,
    ReportReadNode,
    ToolNode,
    WebNode,
)
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
    state.tool_log.append(
        tool if result.get("ok")
        else f"{tool}({result.get('error_code') or 'failed'})"
    )
    # Everything the run READ, so the answer's figures can be checked against it.
    state.add_evidence(result)
    return result


def _route_call(rctx: Any, state: RunState, tool: str, args: dict) -> Any:
    """A tool call that decides WHICH data to read, not what the data says.

    Budgeted and logged exactly like `_call` — an author reading the tool log must
    see why a slot went — but deliberately NOT harvested into `state.evidence`.
    A chart listing is a record of where the run went looking; its numbers are
    chart ids, and putting those in the pile the figure checker matches against
    would let "chart 1001" vouch for a claim of 1001. The same reason routing
    steps are kept out of what the synthesiser is handed.
    """
    state.budget.spend_tool()
    result = tool_registry.execute(rctx.ctx, tool, args, allowed=None)
    state.tool_log.append(
        tool if result.get("ok")
        else f"{tool}({result.get('error_code') or 'failed'})"
    )
    return result


def _selection_mode(node: ReportReadNode) -> str:
    """How this node decides WHAT to read. Explicit beats question beats index.

    Named rather than re-derived from a pair of booleans at each call site: an
    author has to be able to answer "why those charts?", and so does the trace.
    """
    if node.chart_ids:
        return "explicit"
    if node.detail == "index":
        return "report_index"
    return "question" if node.match_question else "report_order"


def _charts_for_question(
    node: ReportReadNode, state: RunState, rctx: Any, allowed: list[int]
) -> tuple[list[int], dict]:
    """Which charts the question is about, and the evidence for saying so.

    Resolution is delegated to the ONE canonical resolver, which composes the
    audited lexical path with the business vocabulary — governed metrics, glossary
    terms, semantic fields — and the metric -> chart bridge. No second matcher
    lives here.

    NO SILENT FALLBACK. Reading the report in its own order when the question
    cannot be resolved stays allowed, because stored flows must keep working — but
    it is RECORDED as a fallback. "Could not tell what the question refers to" and
    "the first N charts are relevant" are different claims and only one is true.
    """
    from app.services.agent_flows.resolver import resolve_charts

    question = state.resolve_text(node.query) or rctx.inp.question.text()
    if not question.strip():
        return allowed, {"mode": "question", "status": "no_question",
                         "fell_back_to": "report_order", "candidates": []}

    # Through `_route_call`, so these lookups are counted against the turn's tool
    # budget and recorded in the run's tool log exactly like every other call.
    got = resolve_charts(
        question, allowed,
        call=lambda tool, args: _route_call(rctx, state, tool, args),
    )
    status = got.get("status") or "none"
    ids = [c for c in (got.get("chart_ids") or []) if c in set(allowed)]

    # THIS DICT IS SERIALISED INTO THE ANSWERING PROMPT, so it carries the status
    # and the ids and not the evidence prose. The full candidate reasoning goes to
    # the author diagnostic below, which no model pays for.
    candidates = got.get("candidates") or []
    candidate_ids = [c.get("chart_id") for c in candidates
                     if isinstance(c, dict) and isinstance(c.get("chart_id"), int)]
    selection: dict[str, Any] = {"mode": "question", "status": status}
    if status in ("exact", "semantic") and ids:
        selection["selected_ids"] = ids
        return ids, selection

    # EVIDENCE TRUTH IS NOT QUESTION RELEVANCE.
    #
    # This used to return the whole allowed list and merely LABEL it
    # `fell_back_to: report_order`. Observability is not correctness: the step
    # still handed the answering model six charts of unrelated evidence, which it
    # summarised. Asked "thời tiết Hà Nội hôm nay", an Olist assistant replied
    # with GMV, orders, AOV and ratings — every figure real, every figure
    # answering a question nobody asked.
    #
    # In QUESTION mode the author asked for charts THE QUESTION selects. Nothing
    # selected means nothing to read. Explicit report-overview flows never reach
    # here: they run in `report_order` / `report_index` / `explicit` mode, so
    # compatibility needs no new setting — the existing toggle already says which
    # behaviour was asked for.
    if status == "lookup_failed":
        # The resolver could not run, so it has said nothing about the domain.
        # Degrade to the default scope — the behaviour before question matching
        # existed — rather than telling a viewer the report cannot answer them.
        selection["fell_back_to"] = "report_order"
        state.notices.append(
            Notice(
                code="read_question_unmatched", audience="author", severity="warning",
                node_key=node.key,
                facts={"selection_status": status, "fell_back_to": "report_order"},
                remedies=["Xem lượt tool của bước này để biết tra cứu hỏng ở đâu."],
                text=f"Bước “{node.name or node.key}” không tra cứu được để chọn biểu "
                     "đồ theo câu hỏi, nên đọc theo thứ tự báo cáo.",
            )
        )
        return allowed, selection

    if candidate_ids:
        selection["candidate_chart_ids"] = candidate_ids[:5]
    if status == "ambiguous":
        # "Which of these?" — not "I cannot". Different states, different
        # downstream behaviour; merging them loses the useful half.
        selection["needs_clarification"] = True
    else:
        # NOT the same as an empty read. "The report has nothing about this" is a
        # fact about capability; "the read returned nothing" is a fact about data,
        # and it sends an author hunting a problem that is not there.
        selection["unsupported"] = True

    # THE REMEDY FOLLOWS FROM WHAT HAPPENED. Matching RAN to reach this branch, so
    # advising the author to switch it on is advice that changes nothing.
    # EVERY REMEDY HERE MUST BE PERFORMABLE IN THE PRODUCT AS IT STANDS.
    #
    # "Chỉ định danh sách biểu đồ" was removed rather than fixed. `chart_ids` is
    # kept for compatibility and advanced flows, but the builder deliberately has
    # no picker for it: a chart id belongs to ONE report while a flow is meant to
    # stay reusable across bindings, so a UI that persisted a raw id would bake
    # hidden report-specific coupling into a portable object. Binding-aware asset
    # selection is a Wave 3 design item; until it exists, advice to use it would
    # be advice the author cannot follow.
    #
    # What is left is portable: sharpen the query, read the candidates the
    # resolver already reports, or give the asset business vocabulary.
    if status == "ambiguous":
        text = (f"Bước “{node.name or node.key}” tìm được nhiều khả năng cho câu hỏi "
                "nhưng không đủ căn cứ chọn một, nên đọc theo thứ tự báo cáo.")
        remedies = ["Viết rõ hơn câu hỏi hoặc ô “Khớp theo” của bước này.",
                    "Xem danh sách khả năng ở trên để biết nó đang phân vân giữa những gì.",
                    "Đặt bí danh/mô tả cho biểu đồ, hoặc khai báo chỉ số trong Từ điển "
                    "để câu hỏi nghiệp vụ trỏ đúng một thứ."]
    else:
        text = (f"Bước “{node.name or node.key}” đã tra theo câu hỏi nhưng không tìm "
                "được biểu đồ hay chỉ số nào khớp, nên đọc theo thứ tự báo cáo.")
        remedies = ["Viết rõ hơn câu hỏi hoặc ô “Khớp theo” của bước này.",
                    "Thêm mô tả/bí danh cho biểu đồ, hoặc khai báo chỉ số trong Từ điển.",
                    "Nếu báo cáo thực sự không có dữ liệu này, hãy chấp nhận “không "
                    "khớp” thay vì để bước đọc theo thứ tự báo cáo."]

    # THE READER IS TOLD TOO, deterministically. Expecting the model to infer
    # "I was given nothing, so I should refuse" is the prompt-only fix this
    # explicitly is not: the runtime knows the answer is out of scope, so the
    # runtime says so.
    state.notices.append(
        Notice(
            code=("read_question_ambiguous" if status == "ambiguous"
                  else "read_question_unsupported"),
            audience="reader",
            severity="info",
            text=("Câu hỏi có thể hiểu theo nhiều cách với báo cáo này — bạn muốn "
                  "xem cụ thể phần nào?" if status == "ambiguous" else
                  "Báo cáo này không có dữ liệu cho câu hỏi đó, nên trợ lý chưa "
                  "trả lời được."),
        )
    )
    state.notices.append(
        Notice(
            code="read_question_unmatched",
            audience="author",
            severity="warning",
            node_key=node.key,
            facts={"selection_status": status,
                   "candidate_chart_ids": candidate_ids,
                   "concepts": got.get("concepts") or [],
                   "candidates": candidates[:8],
                   "fell_back_to": "report_order"},
            remedies=remedies,
            text=text,
        )
    )
    # Nothing resolved, so nothing is read. The step succeeds: "no chart in this
    # report is about that" is an answer, not a failure.
    return [], selection


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

    # `scope` FIRST, and it is not a style preference. Downstream this dict is
    # serialised and head-truncated at 2,000 characters before a model sees it, so
    # a caveat written at the end is a caveat that is always cut — the one sentence
    # that must survive, dropped by construction, leaving a partial reading looking
    # like a complete one. Filled in below, once there is something to report.
    out: dict[str, Any] = {"scope": {}, "charts": [], "filters": None}
    # WHY THESE CHARTS — recorded, not implied. The trace and the authoring UI
    # both have to answer it, and the answer differs per mode.
    out["selection"] = {"mode": _selection_mode(node)}
    yield AgentEvent(type="status", text="Đang đọc báo cáo…")

    if node.include_filters:
        out["filters"] = _call(rctx, state, "inspect_filters", {})

    # BY THE QUESTION, WHEN THE AUTHOR ASKED FOR THAT. An explicit `chart_ids`
    # list always wins: the author already answered "which charts", and a keyword
    # match must not overrule them.
    if node.match_question and not node.chart_ids:
        wanted, selection = _charts_for_question(node, state, rctx, wanted)
        out["selection"] = selection

    # PROPAGATED DETERMINISTICALLY. The answering step's own output cannot say
    # whether its evidence was relevant; this can. Numeric verification asks
    # whether a figure exists in the evidence — a necessary question that is
    # not sufficient, because unrelated figures exist too.
    state.question_grounding[node.key] = dict(out["selection"])

    planned = wanted[:node.max_charts]
    read_count = 0
    for chart_id in planned:
        # LEAVE THE ANSWERING STEP SOMETHING TO SPEND.
        #
        # Each chart costs a summary plus a data read, so a wide report can drain
        # the turn's whole tool budget here. When that happened the answering step
        # died on its first tool call and the viewer saw "chưa trả lời được" — from
        # a run whose every gathering step reported ok. Reading fewer charts and
        # saying so beats reading all of them and having no one left to answer.
        if state.budget.tools_left() < 2:
            state.notices.append(
                Notice(
                    code="read_truncated",
                    text=f"Chỉ đọc được {read_count}/{len(planned)} biểu đồ — phần lượt "
                         "công cụ còn lại để dành cho bước trả lời. Hãy giới hạn danh "
                         "sách biểu đồ của bước đọc, hoặc nâng ngân sách của link.",
                )
            )
            break
        read_count += 1
        entry: dict[str, Any] = {"chart_id": chart_id}
        meta = rctx.inp.report.chart(chart_id)
        if meta:
            entry["title"] = meta.title
            entry["chart_type"] = meta.chart_type
        if node.detail == "index":
            # An INDEX, not a reading. What the chart is and what it holds, so a
            # step with computing tools can pick the right one and call for an
            # exact figure — instead of being handed a sample of every chart and
            # asked to reason over it in a prompt that is re-sent every round.
            _index(entry, meta, rctx, state, node)
            out["charts"].append(entry)
            if not any(c.ref == str(chart_id) for c in state.citations):
                state.citations.append(
                    Citation(kind="chart", ref=str(chart_id), label=entry.get("title", ""))
                )
            continue
        if node.include_summary:
            entry["summary"] = _call(rctx, state, "get_chart_summary", {"chart_id": chart_id})
            _note_status(entry, "summary", entry["summary"])
        if node.include_data and rctx.inp.binding.capabilities.read_rows:
            # ASK FOR THE TOP ROWS, NOT THE FIRST ROWS.
            #
            # `get_chart_data` caps at 50 rows, so WHICH 50 decides whether a
            # ranking question can be answered at all. Unsorted, a 72-category
            # chart returned the first 50 alphabetically and the assistant
            # answered "highest revenue: agro_industry_and_commerce" — the first
            # row, not the largest, and wrong by a factor of seventeen. Sorted by
            # the chart's own measure, the slice you get is the ranking a viewer
            # sees on screen.
            args: dict[str, Any] = {
                "chart_id": chart_id,
                "top_n": min(node.max_rows, rctx.inp.binding.capabilities.max_rows_per_call),
            }
            measure = meta.measures[0].field if (meta and meta.measures) else ""
            if measure:
                args["sort"] = "desc"
                args["sort_by"] = measure
            entry["data"] = _call(rctx, state, "get_chart_data", args)
            _note_status(entry, "data", entry["data"])
            entry["rows_ordered_by"] = measure or "(thứ tự của biểu đồ)"
            _flag_partial(entry, state, node)
        if node.detail == "compact":
            _compact(entry)
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
        # AND WHY. Counting the charts told an author that something broke and
        # nothing about what — the reason was only ever in the server log, which is
        # not a place a flow author can look. Distinct reasons, because eight charts
        # on one broken table fail the same way eight times and repeating it says
        # nothing new.
        reasons = _failure_reasons(out["charts"])
        because = f" Nguyên nhân: {' · '.join(reasons[:2])}" if reasons else ""
        state.notices.append(
            Notice(
                code="charts_unreadable",
                text=f"Không đọc được dữ liệu của {len(failed)} biểu đồ "
                     f"({', '.join(str(f) for f in failed[:4])}). Câu trả lời có thể thiếu."
                     + because,
            )
        )
    # A CHART CAN BE READ AND STILL HAVE LOST A TOOL, AND THAT IS THE CASE THAT
    # WAS REPORTED. The count above only sees charts that yielded NOTHING. Switch
    # on `Chart data` beside `Chart summary` — which is what an author does when
    # summaries start failing — and a chart whose summary broke still returns rows,
    # so it is not unreadable, so nothing is said. The workaround silences the
    # symptom and the cause together, and the run quietly starts paying raw rows
    # into every downstream prompt where a digest used to go.
    #
    # Grouped BY REASON rather than by chart: eight charts sitting on one broken
    # table produce one sentence, not eight.
    degraded = _degraded_by_reason(out["charts"])
    if degraded:
        # DELIBERATELY NOT PUT IN `out`. `unreadable_chart_ids` belongs there
        # because a downstream agent must know it is missing charts before it
        # answers; this does not — the data arrived. Writing the reasons into the
        # step output would spend downstream prompt tokens to report a problem
        # about spending downstream prompt tokens.
        parts = [
            f"{len(ids)} biểu đồ ({', '.join(str(i) for i in ids[:4])}): {why}"
            for why, ids in list(degraded.items())[:2]
        ]
        # NOT in the chat reader's notice map on purpose. The answer is correct;
        # this is an author's maintenance note, so it surfaces in the builder and
        # the Runs tab and stays out of the conversation.
        state.notices.append(
            Notice(
                code="charts_degraded",
                text="Câu trả lời vẫn đủ dữ liệu, nhưng có công cụ đọc bị lỗi và "
                     "flow phải dùng đường dự phòng — tốn token hơn cho các bước "
                     "sau. " + " · ".join(parts),
            )
        )
    if out["charts"] and not out["read_ok"]:
        # Nothing at all came back. Raised so the node is recorded as an error and
        # the flow's own `on_error` decides — rather than handing a downstream agent
        # an empty context and letting it fill the gap.
        # The reason goes in the raised message too: this is what the step row
        # shows in the builder, and "could not read any chart" with no cause is
        # exactly the dead end that sent one author hunting for a workaround
        # instead of a fix.
        reasons = _failure_reasons(out["charts"])
        first_reason = reasons[0] if reasons else ""
        raise RuntimeError(
            "Không đọc được dữ liệu của bất kỳ biểu đồ nào trong phạm vi được cấp."
            + (f" Nguyên nhân đầu tiên: {first_reason}" if first_reason else "")
        )

    # HOW MUCH OF THE REPORT IS THIS?
    #
    # The context said "charts: [...]" and nothing else, so a step reading it saw
    # six charts and no sign that sixty-four more existed. Asked which product
    # category earned the most, the "số liệu" specialist answered 13,591,643.70 —
    # the grand total off a KPI tile, no category named — without calling a single
    # tool, because as far as it could tell it had the whole report in hand.
    #
    # Granting it `list_charts` did not change that answer. A tool is only reached
    # by a model that knows it is missing something, and nothing here said so. The
    # fix is not a better prompt, it is the context telling the truth about its own
    # extent: N of M, and the sentence that names the way out.
    #
    # Two ways to end up partial and both are silent: the author pinned a chart
    # list, or `planned = wanted[:20]` truncated a wide report. Same note covers
    # them, because to the step reading it they are the same situation.
    available = len(allowed) if allowed else len(rctx.inp.report.charts or [])
    out["scope"].update({"read": len(out["charts"]), "available": available})
    if available and len(out["charts"]) < available:
        out["scope"]["partial"] = True
        out["scope"]["note"] = (
            f"Đây là {len(out['charts'])}/{available} biểu đồ của báo cáo — chỉ "
            "những biểu đồ bước đọc được cấu hình sẵn. Nếu câu hỏi nhắc tới thứ "
            "không có ở đây, ĐỪNG trả lời từ những biểu đồ này: gọi `list_charts` "
            "với `query` là từ khoá trong câu hỏi để tìm đúng biểu đồ trước."
        )

    _warn_if_overflowing(node, out, state)
    state.outputs[node.key] = out


def _why(payload: Any) -> str:
    """The reason ONE tool call failed, in the form a person can act on.

    `detail` before `error`: `error` is the short English fragment the MODEL reads
    from a tool contract ("failed to load chart 987: DataError"), while `detail`
    carries the underlying message — which is the half that names the column, the
    table or the value that actually broke.
    """
    if not isinstance(payload, dict) or payload.get("ok"):
        return ""
    return str(payload.get("detail") or payload.get("error") or "").strip()


def _failure_reasons(entries: list[dict]) -> list[str]:
    """Distinct reasons across every chart that yielded NOTHING.

    Distinct, because eight charts sitting on one broken table fail the same way
    eight times and the eighth repetition tells an author nothing the first did
    not.
    """
    reasons: list[str] = []
    for entry in entries:
        if _entry_has_data(entry):
            continue
        for key in ("summary", "data"):
            why = _why(entry.get(key))
            if why and why not in reasons:
                reasons.append(why)
    return reasons


def _degraded_by_reason(entries: list[dict]) -> dict[str, list]:
    """Charts that DID come back, but only because a second tool covered for a
    first that failed — keyed by reason, so one broken table is one sentence.

    Invisible until now, and it is the case that gets reported: an author whose
    summaries break switches on `Chart data` as a second path, the charts stop
    counting as unreadable, and the cause disappears along with the symptom.
    """
    out: dict[str, list] = {}
    for entry in entries:
        if not _entry_has_data(entry):
            continue  # named by `_failure_reasons`, with its own reason
        for key in ("summary", "data"):
            why = _why(entry.get(key))
            if why:
                out.setdefault(why, []).append(entry.get("chart_id"))
    return out


#: The ceiling this step's result is measured against, imported from the module
#: that owns the handoff. It used to be a local `2000` mirroring a constant in the
#: agent handler; that constant was replaced and this copy was not, so the notice
#: quoted a limit that no longer existed.
from app.services.agent_flows.runtime.context import HANDOFF_CHARS as _DOWNSTREAM_CHARS


def _warn_if_overflowing(node: ReportReadNode, out: dict, state: RunState) -> None:
    """Tell the author when most of what this step fetched can never be read.

    THE GAP THIS CLOSES IS AN AUTHOR'S MENTAL MODEL, and it was reported as one:
    "tất cả các dòng đọc được sẽ trở thành context cho node llm tiếp theo". That is
    the reasonable reading of a step called "read the report" with toggles for what
    to include — and it is not what happens. A step's result is cut to 2,000
    characters on its way into the answering step's prompt.

    MEASURED on a 70-chart report, twenty charts planned:

        summary + data, detail=full       71,650 chars    2.8% survives   7/20 charts
        summary only,   detail=full       49,471 chars    4.0%            6/20
        summary only,   detail=compact     8,244 chars   24.3%            7/20

    So the toggles an author can see move the number by 8x, and every setting still
    loses most of it — to a blind head-cut, which means WHICH charts survive is
    decided by id order rather than by the question. An author cannot reason about
    a ceiling nobody showed them; they tune the controls they can see, conclude the
    step is wasteful, and switch things off. That is exactly what happened.

    Reported once, with the real numbers and the two remedies that actually work:
    match the question, or carry less per chart.
    """
    if not out.get("charts"):
        return
    from app.services.agent_flows.runtime.state import render_value

    size = len(render_value(out))
    if size <= _DOWNSTREAM_CHARS:
        return
    # Reduction is STRUCTURAL now — the compiler shrinks the biggest arrays inside
    # each chart, it does not keep "the first N charts and drop the rest". Saying
    # the old thing would be a second lie on top of the old number.
    vn = lambda n: f"{n:,}".replace(",", ".")

    # REMEDIES ARE DERIVED FROM STATE, NOT WRITTEN INTO THE SENTENCE.
    #
    # The invariant: a diagnostic may only recommend an action that is actually
    # applicable right now. The fixed sentence used to end with "Bật 'đọc theo câu
    # hỏi'" whether or not it was already on, so the product read as though it
    # could not see its own configuration — and an author who follows advice that
    # changes nothing stops trusting the next notice too.
    remedies: list[str] = []
    if not node.match_question and not node.chart_ids:
        remedies.append("Bật “đọc theo câu hỏi” để chọn biểu đồ theo nội dung hỏi.")
    if not node.chart_ids:
        remedies.append("Giảm số biểu đồ tối đa của bước này.")
    if node.detail == "full":
        remedies.append("Hạ mức chi tiết xuống “gọn”.")
    if node.detail in ("full", "compact"):
        remedies.append("Chuyển mức chi tiết sang “chỉ mục” rồi để bước sau gọi "
                        "công cụ lấy đúng con số.")
    if not remedies:
        # Already at the tightest settings this node offers. Saying nothing
        # actionable is honest; pretending there is a knob left is not.
        remedies.append("Bước này đã ở mức gọn nhất; phần dư cần được xử lý ở "
                        "bước sau (gọi công cụ lấy số) thay vì đọc thêm.")

    state.notices.append(
        Notice(
            code="read_exceeds_context",
            audience="author",
            severity="warning",
            node_key=node.key,
            facts={
                "charts_read": len(out["charts"]),
                "rendered_chars": size,
                "downstream_chars": _DOWNSTREAM_CHARS,
                "over_budget_by": size - _DOWNSTREAM_CHARS,
                "match_question": node.match_question,
                "detail": node.detail,
                "explicit_chart_ids": len(node.chart_ids),
            },
            remedies=remedies,
            # REMEDIES LIVE IN `remedies`, ONCE. They were also appended to this
            # sentence, from a time when no surface rendered the field; both
            # author surfaces render it now, so appending printed every remedy
            # twice on screen.
            text=(
                f"Bước “{node.name or node.key}” đọc {len(out['charts'])} biểu đồ "
                f"(~{vn(size)} ký tự), vượt ngân sách ngữ cảnh của bước trả lời "
                f"(~{vn(_DOWNSTREAM_CHARS)} ký tự cho TẤT CẢ các bước cộng lại) nên "
                "phần chi tiết trong mỗi biểu đồ sẽ bị lược bớt; nếu còn bước khác "
                "cũng có kết quả thì phần dành cho bước này còn nhỏ hơn."
            ),
        )
    )


#: Where a chart entry's READ EXECUTION STATUS lives. Separate from the payload on
#: purpose: the payload is shaped for the model (compacted, indexed, trimmed) and a
#: shaping step must never be able to change whether the tool succeeded. Written
#: once, at execution; read by every later stage.
_STATUS = "read_status"


def _note_status(entry: dict, key: str, payload: Any) -> None:
    """Fold one part's outcome into the entry's rollup, as it is read.

    One short string, not a per-part dict: this entry is serialised into the
    downstream prompt, and `{"summary":"ok","data":"ok"}` on twenty charts spends
    ~900 of the 2,000 characters the answering step receives. "partial" also says
    something the model should act on — part of this chart is missing.
    """
    ok = isinstance(payload, dict) and bool(payload.get("ok"))
    prev = entry.get(_STATUS)
    if prev is None:
        entry[_STATUS] = "ok" if ok else "failed"
    elif (prev == "ok") != ok:
        entry[_STATUS] = "partial"


def _entry_has_data(entry: dict) -> bool:
    """Did this chart yield anything usable?

    "Usable" depends on what was ASKED for. An index entry describes a chart
    without reading it, so it has no `summary` and no `data` and is nonetheless
    complete — the guard below only knew the reading shape, so switching a node to
    `index` made every chart look unreadable and the node raised "could not read
    any chart" on a run where nothing had gone wrong. A completeness check that
    does not know what completeness means for the mode it is checking will fail
    the healthy case, which is worse than not checking.
    """
    if entry.get("indexed"):
        return True
    # THE RECORDED STATUS WINS. Sniffing the payload for `ok` made the verdict a
    # property of the payload's SHAPE, so `_compact` — which replaces the summary
    # with a presentation object that has no `ok` — turned a successful
    # summary-only read into "could not read any chart".
    status = entry.get(_STATUS)
    if status:
        return status in ("ok", "partial")
    # Entries built elsewhere (stored traces, replay fixtures) carry no status.
    for key in ("summary", "data"):
        payload = entry.get(key)
        if isinstance(payload, dict) and payload.get("ok"):
            return True
    return False


def _index(
    entry: dict, meta: Any, rctx: Any, state: RunState, node: ReportReadNode
) -> None:
    """Describe one chart without reading its rows.

    The measures and dimensions come from the chart's own configuration, which the
    run already has — so the whole index costs no warehouse query at all, except
    for single-figure charts where the figure IS the chart and omitting it would
    force a tool call to learn something one number long.

    Why this exists: with `compact`, a twelve-chart read produced ~5,000 tokens of
    column statistics and sample values, pasted into every prompt that referenced
    the node — twice for a step that calls a tool, since the question is re-asked
    with the tool result. And a step holding `rank_values` does not need any of it:
    it needs to know that chart 686 is revenue by category, then ask for the exact
    ranking. Handing it a sample of the data is paying, per round, for a worse
    version of what the tool returns for free.
    """
    # Marks this entry as complete-by-design for `_entry_has_data`: an index has
    # no rows and no summary, and that is the whole point of it.
    entry["indexed"] = True
    fields = getattr(meta, "measures", None) or []
    entry["measures"] = [
        {"field": m.field, "label": m.label} for m in fields
    ] if fields else []
    dims = getattr(meta, "dimensions", None) or []
    entry["dimensions"] = [
        {"field": d.field, "label": d.label} for d in dims
    ] if dims else []

    # A KPI tile holds exactly one number and no grouping. Reading it here costs
    # one cheap query and saves the answering step a tool round for questions the
    # dashboard already answers on its face ("how many orders?").
    if str(entry.get("chart_type", "")).upper() in {"KPI", "NUMBER", "SINGLE_VALUE"}:
        got = _call(rctx, state, "get_chart_data", {"chart_id": entry["chart_id"], "top_n": 1})
        rows = ((got or {}).get("data") or {}).get("rows") or []
        cols = ((got or {}).get("data") or {}).get("columns") or []
        if rows and rows[0]:
            entry["value"] = rows[0][-1]
            entry["value_of"] = cols[-1] if cols else ""
    entry["how_to_read"] = (
        "Dùng rank_values / total_measure / share_of với chart_id này để lấy số chính xác."
    )


def _compact(entry: dict) -> None:
    """Keep what a question is answered from; drop what is merely long.

    MEASURED, NOT GUESSED. A three-chart read carried ~4,300 tokens, and most of it
    was each column's per-value frequency list — every category name and its count,
    for a question like "which category earns most". That payload is then pasted
    into EVERY prompt that references the node, so a four-iteration loop paid for it
    four times over.

    What survives is the shape of the chart and each numeric column's totals, which
    is what an answer actually cites; the rows themselves stay, because they are the
    evidence the figure check verifies against.
    """
    # Stamp before reshaping: this function is about to destroy the only evidence
    # that the read succeeded, and the invariant is that it may not.
    for key in ("summary", "data"):
        if key in entry:
            _note_status(entry, key, entry.get(key))
    summary = (entry.get("summary") or {}).get("data") if isinstance(entry.get("summary"), dict) else None
    if not isinstance(summary, dict):
        return
    columns = []
    for col in summary.get("columns") or []:
        if not isinstance(col, dict):
            continue
        kept = {k: col.get(k) for k in ("name", "kind", "total", "min", "max", "avg", "distinct")
                if col.get(k) is not None}
        # A handful of examples is orientation; seventy is a data dump.
        top = col.get("top_values") or []
        if isinstance(top, list) and top:
            kept["examples"] = [v[0] if isinstance(v, (list, tuple)) else v for v in top[:5]]
        columns.append(kept)
    entry["summary"] = {
        "chart_name": summary.get("chart_name"),
        "chart_type": summary.get("chart_type"),
        "total_rows": summary.get("total_rows"),
        "columns": columns,
    }


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
            f"ONLY {got}/{total} ROWS WERE READ — these are the TOP {got} by "
            f"{entry.get('rows_ordered_by') or 'the chart’s own order'}. A ranking "
            "within them is correct; do NOT infer a total, and do not name a "
            "category that is not among these rows."
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
def build_knowledge_scope(attachments: Any) -> dict[str, list]:
    """The retrieval boundary a step's attachments describe.

    Shared with the Agent node on purpose: this used to be written twice, and the
    two copies disagreed about `term_fqns`. All four keys are always present, so a
    consumer can tell "attached nothing" from "this kind is not supported here".
    """
    scope: dict[str, list] = {
        "doc_ids": [], "dataset_ids": [], "metric_names": [], "term_fqns": [],
    }
    for k in attachments or []:
        if k.source == "document" and k.ref.isdigit():
            scope["doc_ids"].append(int(k.ref))
        elif k.source == "semantic" and k.ref.isdigit():
            scope["dataset_ids"].append(int(k.ref))
        elif k.source == "metric":
            scope["metric_names"].append(k.ref)
        elif k.source == "term":
            # The company's own vocabulary, addressed by FQN — the same spelling
            # `GovernMetric.related_term_fqn` uses, so a term has one identity
            # across the product rather than one per feature.
            scope["term_fqns"].append(k.ref)
    return scope


async def run_knowledge(
    node: KnowledgeNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    query = state.resolve_text(node.query) or rctx.inp.question.text()

    # A FOLLOW-UP IS NOT A QUESTION ON ITS OWN.
    #
    # This step retrieves with the viewer's words verbatim, which is right until
    # turn two. Measured on the live corpus: after "Tỷ lệ giao đúng hẹn được tính
    # như thế nào?", the follow-up "Còn trường hợp loại trừ thì sao?" retrieved
    # the Intelligence user guide and the report overview — and the relevance
    # floor was satisfied, so the verdict said the evidence supported an answer.
    # A wrong document, answered confidently.
    #
    # Only when the question OPENS by pointing at the previous one. Joining every
    # turn was measured too and drags a genuine topic change onto the old subject.
    from app.services.dashboard_ai_bot.govern_doc_followup import (
        prior_user_question, resolve as resolve_followup,
    )

    if not state.resolve_text(node.query):
        prior = prior_user_question(rctx.inp.conversation.history)
        query, rewritten = resolve_followup(query, prior)
        if rewritten:
            logger.info("[flow] follow-up resolved against the previous question")
    yield AgentEvent(type="status", text="Đang tra tri thức…")

    previous_scope = getattr(rctx.ctx, "knowledge_scope", None)
    scope = build_knowledge_scope(node.knowledge)
    if hasattr(rctx.ctx, "knowledge_scope"):
        rctx.ctx.knowledge_scope = scope

    try:
        result = _call(rctx, state, "search_knowledge", {"query": query, "limit": node.top_k})
    finally:
        if previous_scope is not None:
            rctx.ctx.knowledge_scope = previous_scope

    _cite_knowledge(result, node, state)
    state.outputs[node.key] = result


# A retrieval result kind → the citation kind the answer may write. A term is
# vocabulary, not a governed number, so it keeps its own kind rather than
# borrowing "metric" and claiming an authority it does not have.
_CITE_KIND = {
    "document": "document",
    "document_chunk": "document",
    "metric": "metric",
    "term": "term",
    "semantic": "dataset",
    "dataset": "dataset",
}


def _cite_knowledge(result: Any, node: KnowledgeNode, state: RunState) -> None:
    """Cite what the search actually RETURNED, under the source's real name.

    Two things were wrong here, and both reached the viewer. The label was the
    author's private "when should it read this?" note, so a reader saw routing
    instructions where the document title belonged. And only documents were ever
    cited — a definition the model took from a governed metric or a glossary term
    had no legal citation token, so the model reached for `[WEB]` on a link with
    web research switched off. Citing the results, not the attachment list, also
    stops a source that matched nothing from appearing as if it backed the answer.
    """
    payload = result if isinstance(result, dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    hits = data.get("results") if isinstance(data.get("results"), list) else []

    # The author's note is the last resort for a title, not the first choice.
    described: dict[str, str] = {
        f"{k.source}:{k.ref}": (k.description or "")[:80] for k in node.knowledge
    }

    for hit in hits:
        if not isinstance(hit, dict):
            continue
        kind = _CITE_KIND.get(str(hit.get("kind") or ""))
        ref = str(hit.get("id") or "").strip()
        if not kind or not ref:
            continue
        if any(c.kind == kind and c.ref == ref for c in state.citations):
            continue
        label = str(hit.get("title") or "").strip()
        if not label:
            label = described.get(f"{kind}:{ref}", "")
        state.citations.append(Citation(kind=kind, ref=ref, label=label[:120]))


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
        # Declared so the trace says "skipped", not "ok". Without this the step
        # showed a green tick for work it deliberately did not do.
        state.skipped[node.key] = "web_disabled"
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



# ═══ Call one tool, decided by the author ════════════════════════════════════
async def run_tool(
    node: ToolNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """One tool, arguments the author bound, no model.

    THE SECURITY SHAPE OF THIS FUNCTION IS THE POINT.

    It resolves bindings and calls `tool_registry.execute()`. It does not reach for
    `spec.fn`, does not special-case a tool, and does not decide anything a gate
    decides. Every invariant the agent path has — capability, resource scope,
    payload ceiling, cache, error taxonomy — applies here because this takes the
    same road, not because it repeats the checks.

    `allowed=None` follows `_call` above: there is no per-step allowlist to
    enforce, because the author picked THIS tool for THIS node and the node is the
    grant. What still bounds it is the binding, narrowed before the first node ran.
    """
    args = _resolve_inputs(node, state)
    yield AgentEvent(type="status", text=f"Đang chạy {node.tool}…")

    state.budget.spend_tool()
    result = tool_registry.execute(rctx.ctx, node.tool, args, allowed=None)
    state.tool_log.append(
        node.tool if result.get("ok")
        else f"{node.tool}({result.get('error_code') or 'failed'})"
    )
    state.add_evidence(result)

    if not result.get("ok"):
        # RAISED, not swallowed. `on_error` on the node decides what happens next —
        # the same choice every other step gets — and a step that failed must not
        # publish a value the next step would read as data.
        detail = result.get("detail") or result.get("error") or "công cụ lỗi"
        raise RuntimeError(f"{node.tool}: {detail}")

    # WHAT THE NEXT STEP READS IS `data`, NOT THE ENVELOPE.
    #
    # `ok` / `kind` / `coverage` are the platform's contract and `output_schema`
    # describes `data`, so an author wiring `{{ranking.items}}` gets what the
    # schema promised. Publishing the envelope instead would make every binding
    # read `{{ranking.data.items}}` and make the schema a lie.
    state.outputs[node.key] = result.get("data")
    if node.output_var:
        state.set_var(node.output_var, result.get("data"))
        if node.run_policy != "every_turn":
            state.memory_set[node.output_var] = result.get("data")


def _resolve_inputs(node: ToolNode, state: RunState) -> dict:
    """Typed bindings → tool arguments.

    A variable binding keeps the variable's TYPE. That is the whole reason the
    contract stores `{source, ref}` instead of `"{{x}}"`: an id stays an int, a
    list stays a list, and a tool does not have to guess what a string was meant
    to be.
    """
    out: dict = {}
    for name, binding in (node.inputs or {}).items():
        if binding.source == "literal":
            out[name] = binding.value
            continue
        if binding.ref in state.vars:
            out[name] = state.vars[binding.ref]
            continue
        # A MISSING VARIABLE IS NOT AN EMPTY ONE. Passing `None` would let the tool
        # refuse for a reason that names the ARGUMENT instead of the BINDING, and
        # an author would go looking at the tool.
        raise RuntimeError(
            f"bước “{node.name or node.key}” cần biến {{{{{binding.ref}}}}} cho "
            f"tham số `{name}`, nhưng chưa bước nào tạo ra biến đó"
        )
    return out


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
    NodeSpec(
        type="tool",
        label_vi="Gọi công cụ",
        label_en="Call a tool",
        description_vi="Chạy đúng một công cụ với tham số bạn chọn. "
                       "Không gọi AI, không tốn token.",
        category="data",
        icon="⚙",
        handler=run_tool,
    ),
]
