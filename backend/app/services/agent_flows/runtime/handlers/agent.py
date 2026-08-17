"""The AI Agent node: rounds of (ask the model → run the tools it asked for).

This is the only node type that costs a model call, and after this rewrite it is one
of twelve rather than the only thing a flow could contain. That is the point: an
author who wants to read the open report no longer pays a model to decide to do it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import AgentNode
from app.services.agent_flows.envelope import Answer
from app.services.agent_flows.models_catalogue import INHERIT
from app.services.agent_flows.runtime.nodes import NodeSpec
from app.services.agent_flows.runtime.state import RunState
from app.services.agent_flows.tools import registry as tool_registry
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

#: What an INTERMEDIATE node keeps of the base prompt: the two rules that must
#: survive everywhere, and nothing else. The full analyst prompt is for the step
#: whose words a person reads.
_COMPACT_BASE = (
    "Trả lời bằng đúng ngôn ngữ của câu hỏi. "
    "Chỉ dùng số liệu có trong dữ liệu được cung cấp — không tự tạo, không ước lượng, "
    "không lấy từ kiến thức có sẵn. Nếu dữ liệu không có, nói rõ là không có."
)

#: Hard ceiling on rounds within ONE node, on top of the run-wide budget. A model
#: looping on a failing tool would otherwise spend the whole turn here and leave
#: nothing for the node that writes the answer.
MAX_ROUNDS = 12


async def run(
    node: AgentNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    provider, model = _resolve_model(node, rctx)
    api_key = node.resolved_api_key() or rctx.api_key
    if not api_key:
        # An error event rather than a raise: the chain continues, and a later node
        # with its own token can still produce an answer.
        raise RuntimeError(f"chưa có token để gọi {provider or 'nhà cung cấp'}")

    is_answering = node.key == rctx.answer_key
    allowed = set(node.tool_names())
    web_enabled = bool(rctx.inp.binding.capabilities.web_search)
    schemas = tool_registry.definitions_for(allowed, web_enabled=web_enabled)

    # This node's own knowledge scope, set for the duration of the node.
    #
    # ATTACHING NARROWS; ATTACHING NOTHING DOES NOT MEAN NOTHING. A step that names
    # its sources reaches only those. A step that names none is not sealed off — it
    # reaches everything the REPORT is entitled to, which is what the binding's
    # `knowledge.mode` grants. This comment used to claim the boundary held in both
    # cases, and a reader who trusted it would have thought an unattached step read
    # nothing at all. The entitlement is still the ceiling either way; the author's
    # list only ever cuts inside it.
    previous_scope = getattr(rctx.ctx, "knowledge_scope", None)
    _apply_scope(rctx.ctx, node)

    system = _system_prompt(node, state, rctx)
    messages = _messages(node, state, rctx)
    collected = ""
    calls_made = 0
    #: Provider adapters report a refused key or a bad model as an `error` EVENT
    #: rather than an exception. Without capturing it the node finished with empty
    #: text and was recorded `ok` — so the trace said every step succeeded while the
    #: answer was blank, which is the single most misleading thing a run log can do.
    provider_error = ""

    try:
        for _round in range(MAX_ROUNDS):
            state.budget.spend_llm()
            pending: list[AgentEvent] = []
            assistant_text = ""

            # THE RUN BUDGET HAS TO BIND DURING A CALL, NOT ONLY BETWEEN NODES.
            #
            # `max_seconds` was checked between nodes, so a single slow call could
            # ignore it entirely: on a reasoning model this flow took 91s against a
            # 45s budget and every client gave up before the answer arrived. The
            # remaining budget is the ceiling for THIS round.
            remaining = max(5.0, state.budget.max_seconds - state.budget.elapsed())
            try:
                async with asyncio.timeout(remaining):
                    async for ev in _stream(
                        provider=provider, api_key=api_key, model=model,
                        system_prompt=system, messages=messages, tools=schemas,
                    ):
                        if ev.type == "tool_call":
                            pending.append(ev)
                            continue
                        if ev.type == "text":
                            assistant_text += ev.text
                            # Only the answering node's prose reaches the viewer, and
                            # only when it IS prose: a half-written JSON object cannot
                            # be rendered.
                            if is_answering and node.output_format == "chat":
                                yield ev
                            continue
                        if ev.type == "usage":
                            state.prompt_tokens += int(ev.extra.get("prompt_tokens") or 0)
                            state.completion_tokens += int(
                                ev.extra.get("completion_tokens") or 0
                            )
                        if ev.type == "error":
                            provider_error = ev.text or "nhà cung cấp trả về lỗi"
                            continue
                        yield ev
            except TimeoutError:
                # Named, not swallowed. "The model took longer than this link allows"
                # is a different problem from "the model refused", and an operator
                # reading the Runs table has to be able to tell them apart.
                provider_error = (
                    f"{model or provider} không trả lời kịp trong "
                    f"{int(remaining)} giây còn lại của lượt này."
                )
                break

            collected += assistant_text
            if not pending:
                break

            # HOW MANY OF THIS BATCH MAY ACTUALLY RUN.
            #
            # The node ceiling used to be tested once per ROUND, then the whole
            # batch ran. A model that asks for five tools in parallel with one
            # call of headroom left made five — the limit held on paper and was
            # exceeded in fact. The run-wide budget is checked here too, so the
            # answer step is refused a tool rather than killed by one.
            room = max(0, min(
                node.max_tool_calls - calls_made,
                state.budget.tools_left(answering=is_answering),
            ))
            if room <= 0:
                # Out of budget: tell the model so it answers with what it has,
                # rather than cutting it off mid-thought.
                messages.append({
                    "role": "user",
                    "content": (
                        "No tool calls remain for this step. Answer with what "
                        "you already have, and say plainly what you could not "
                        "check. Reply in the language of the user's question."
                    ),
                })
                schemas = []
                continue

            runnable, refused = pending[:room], pending[room:]
            messages.append({
                "role": "assistant",
                "content": assistant_text,
                # `args` — the key BOTH provider adapters read and the one their
                # own docstrings document. Sending `arguments` meant every tool
                # call this engine replayed reached the next round as `{}`: the
                # model could not see what it had just asked for, so it re-asked,
                # spending a second round to learn what it already knew.
                "tool_calls": [
                    {"id": c.tool_call_id, "name": c.tool_name, "args": c.tool_args}
                    for c in pending
                ],
            })
            # THE PROTOCOL OWES A RESULT TO EVERY CALL IT ANNOUNCED.
            #
            # A tool_call with no matching tool message makes OpenAI reject the
            # whole request, so a refused call must still be answered — with the
            # reason, which is also the more useful thing for the model to read.
            for call in refused:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.tool_call_id,
                    "name": call.tool_name,
                    "result": {
                        "ok": False,
                        "error_code": "budget_exhausted",
                        "error": "không còn lượt gọi công cụ cho bước này — hãy "
                                 "trả lời bằng dữ liệu đã có và nói rõ phần chưa kiểm được",
                    },
                })
            for call in runnable:
                state.budget.spend_tool()
                calls_made += 1
                yield AgentEvent(type="status", text=f"Đang dùng {call.tool_name}…")
                # ARGUMENTS THE PROVIDER COULD NOT PARSE ARE NOT ARGUMENTS.
                #
                # They used to arrive as `{}` and the call went ahead, so the tool
                # failed on a missing required field and the model had to guess at
                # a fault the runtime had already identified. Handing back the
                # parse error instead lets it correct the call on the next round.
                malformed = (call.extra or {}).get("malformed_args")
                if malformed:
                    result = {
                        "ok": False,
                        "error_code": "bad_tool_arguments",
                        "error": f"tham số gửi kèm không phải JSON hợp lệ ({malformed}). "
                                 "Hãy gọi lại công cụ với JSON đúng định dạng.",
                    }
                else:
                    result = tool_registry.execute(
                        rctx.ctx, call.tool_name, call.tool_args, allowed=allowed
                    )
                # Named in the run history, success or not. A refused call is the
                # most interesting row in an audit and the easiest one to lose.
                state.tool_log.append(
                    call.tool_name if result.get("ok")
                    else f"{call.tool_name}({result.get('error_code') or 'failed'})"
                )
                state.add_evidence(result)
                _collect_citation(state, call.tool_name, call.tool_args, result)
                yield AgentEvent(
                    type="tool_result",
                    tool_call_id=call.tool_call_id,
                    tool_name=call.tool_name,
                    tool_result=result,
                )
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.tool_call_id,
                    "name": call.tool_name,
                    # `result`, which is the key the provider adapters document and
                    # read. Sending `content` meant every tool output this engine
                    # produced reached the model as `{}` — the agent was answering
                    # about a report it had never actually been shown.
                    "result": result,
                })
    finally:
        # Restored even when the node raises, or the next node would inherit a scope
        # it was never granted — a silent widening of what the flow may read.
        if previous_scope is not None:
            rctx.ctx.knowledge_scope = previous_scope

    text = collected.strip()
    if provider_error and not text:
        # Raised, so the executor records `error`, honours `retry` and `on_error`,
        # and the Runs table shows which node actually failed.
        raise RuntimeError(provider_error)

    if node.output_format == "json":
        state.outputs[node.key] = _parse_blocks(text, state, node)
    else:
        state.outputs[node.key] = text


def _resolve_model(node: AgentNode, rctx: Any) -> tuple[str, str]:
    """The node's provider/model, or the link's when it inherits."""
    if node.provider != INHERIT and node.model:
        return node.provider, node.model
    return rctx.inp.runtime.provider, rctx.inp.runtime.model or ""


def _apply_scope(ctx: Any, node: AgentNode) -> None:
    """This node's knowledge boundary, built by the SAME code the Knowledge node
    uses.

    Two copies of this existed and they disagreed: the copy here never collected
    `term_fqns`, so a glossary term attached to an Agent step was accepted by the
    builder, shown in the step's source list, and then dropped before retrieval —
    the picker worked and the boundary it configured did not. One builder, one
    set of keys, no room for the two to drift again.
    """
    from app.services.agent_flows.runtime.handlers.data import build_knowledge_scope

    if hasattr(ctx, "knowledge_scope"):
        ctx.knowledge_scope = build_knowledge_scope(node.knowledge)


def _messages(node: AgentNode, state: RunState, rctx: Any) -> list[dict]:
    """What conversation this node's model sees.

    The engine used to hand the FULL transcript to EVERY step: a ten-node flow paid
    for it ten times, and a node classifying severity does not need the greeting.
    """
    history = [t.model_dump() for t in rctx.inp.conversation.history]
    if node.context_policy == "none":
        picked: list[dict] = []
    elif node.context_policy == "last_3":
        picked = history[-6:]
    elif node.context_policy == "full":
        picked = history
    else:  # "question"
        picked = []

    out: list[dict] = [*picked, {"role": "user", "content": rctx.inp.question.text()}]
    carried = _previous_text(state.vars.get("previous"))
    if carried:
        out.append({
            "role": "user",
            "content": f"Result of the previous step:\n\n{carried[:8000]}",
        })
    return out


def _previous_text(previous: Any) -> str:
    """The previous step's result, in a form a model can actually read.

    Only `str` used to survive this. `report_read` and `knowledge` — the two steps
    whose entire job is to fetch what the answer is built on — hand back a dict,
    so their output was dropped in silence: the run showed every step green, the
    author saw "→ {{dashboard_context}}" on the canvas, and the model that wrote
    the answer had been shown none of it. It only ever worked when the author
    happened to interpolate the variable by hand, or granted the step tools to go
    and fetch the same data a second time.
    """
    if isinstance(previous, str):
        return previous.strip()
    if isinstance(previous, (dict, list)) and previous:
        try:
            return json.dumps(previous, ensure_ascii=False, default=str)
        except (TypeError, ValueError):  # pragma: no cover — default=str covers it
            return str(previous)
    return ""


def _system_prompt(node: AgentNode, state: RunState, rctx: Any) -> str:
    """Base prompt + the author's instructions (with variables resolved) + scope.

    APPENDED, never substituted. The base carries the citation contract, the
    answer-in-the-question's-language rule and the analysis guardrails; a chain of
    replacement prompts would drop all of them with nothing to show it happened.
    """
    parts: list[str] = []
    # THE FULL BASE PROMPT GOES TO THE NODE THAT TALKS TO THE VIEWER. NOT EVERY NODE.
    #
    # It is ~2,300 tokens of citation contract, language rule and analysis
    # guardrails — written for the step that produces the answer. Pasting it into
    # every node meant a five-node flow paid for it five times: 11,700 tokens
    # before a single word about the actual report. A node whose whole job is
    # "write one sentence about {{segment}}" does not need the citation contract;
    # it needs the two rules that must never be dropped, which is what the compact
    # form carries.
    if rctx.base_system_prompt.strip():
        parts.append(
            rctx.base_system_prompt.strip()
            if node.key == rctx.answer_key
            else _COMPACT_BASE
        )
    parts.append(state.resolve_text(node.prompt).strip())

    notes = [f"- {g.tool}: {g.note.strip()}" for g in node.tools if g.note.strip()]
    if notes:
        parts.append("KHI NÀO DÙNG CÔNG CỤ NÀO\n" + "\n".join(notes))

    sources = [f"- [{k.source}] {k.ref} — {k.description}" for k in node.knowledge]
    if sources:
        parts.append(
            "NGUỒN TRI THỨC BƯỚC NÀY ĐƯỢC TRA (và khi nào nên tra)\n" + "\n".join(sources)
        )
    if node.output_format == "json":
        parts.append(_BLOCK_INSTRUCTIONS)
    elif node.key == rctx.answer_key:
        # THE PLATFORM'S CONTRACT HAS TO OUTLIVE THE AUTHOR'S PROMPT.
        #
        # The base prompt already asks for 2-3 `[FOLLOWUP]` lines — the markers the
        # chat UI turns into clickable suggestion chips. But it is appended BEFORE
        # the author's own instructions, and an author who writes "answer in
        # exactly one short sentence" wins: the model obeys the nearer, more
        # specific rule and drops the follow-ups. Measured across this
        # deployment's stored answers: ONE in twenty-five carried a marker, so the
        # suggestion chips were effectively dead while looking implemented.
        #
        # Restated last, and only for the node that talks to the viewer, so a
        # terse answer style and a working suggestion strip can coexist. Kept to
        # two lines because a long reminder here would itself start competing with
        # the author's prompt for the model's attention.
        parts.append(
            "Dù hướng dẫn ở trên yêu cầu ngắn gọn thế nào, LUÔN kết thúc câu trả "
            "lời bằng 2-3 dòng gợi ý, mỗi dòng bắt đầu bằng [FOLLOWUP] và kết "
            "thúc bằng dấu ?. Chúng không tính vào độ dài câu trả lời."
        )
    return "\n\n".join(p for p in parts if p)


#: What a `json` node must return. Deliberately terse and example-led: a long JSON
#: schema in a prompt buys compliance on the shape and loses it on the content.
#:
#: English, like the rest of the machine contract. This block was written in
#: Vietnamese and survived the language cleanup because it is assembled HERE, in
#: the handler, rather than in `prompts.py` — so a sweep that went file by file
#: through the prompt module never saw it. The lesson is in the scanner now: read
#: the ASSEMBLED prompt, not the files it is thought to come from.
#:
#: The block VALUES stay language-neutral; what the model writes inside
#: `markdown`, `label` and `items` follows the viewer's question, as rule 5 of
#: the base prompt says.
_BLOCK_INSTRUCTIONS = """OUTPUT FORMAT
Return ONE JSON object and nothing else — no prose before or after:
{"blocks":[ ... ]}

Block types available:
{"type":"text","markdown":"..."}
{"type":"metric","label":"...","value":123,"format":"currency|percent|number",
 "delta":{"value":-0.084,"format":"percent","direction":"down"},"source":{"chart_id":41}}
{"type":"table","columns":[{"key":"k","label":"L","format":"text|number|percent|currency"}],
 "rows":[{"k":"v"}],"source":{"chart_id":41}}
{"type":"chart_ref","chart_id":41,"highlight":{"field":"segment","values":["Enterprise"]},
 "caption":"..."}
{"type":"callout","level":"info|warning|danger","text":"..."}
{"type":"followups","items":["next question","..."]}

Use only chart_id values that exist in this report. Always open with a "text"
block. Write the TEXT inside the blocks in the language of the viewer's
question — this instruction being English says nothing about that."""


def _parse_blocks(text: str, state: RunState, node: AgentNode) -> dict:
    """Validate the model's JSON into real blocks, or fall back to prose.

    A model's raw JSON is never handed to the frontend. When it will not validate
    the node still answers — as text — and the run carries a notice saying the
    structure was dropped, because a silently downgraded answer looks like the
    author's own formatting choice.
    """
    from app.services.agent_flows.envelope import Notice

    raw = (text or "").strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S)
    if fenced:
        raw = fenced.group(1)
    else:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]

    try:
        parsed = json.loads(raw)
        answer = Answer.model_validate(
            parsed if isinstance(parsed, dict) and "blocks" in parsed else {"blocks": parsed}
        )
        if answer.blocks:
            return {"blocks": [b.model_dump(mode="json") for b in answer.blocks]}
    except Exception:  # noqa: BLE001
        logger.warning("[flow] node '%s' returned unparseable blocks", node.key)

    state.notices.append(
        Notice(
            code="format_fallback",
            text="Trợ lý trả về định dạng không hợp lệ nên câu trả lời hiển thị dạng văn bản.",
        )
    )
    # NEVER SHOW THE VIEWER RAW JSON. The old fallback put the unparsed string
    # straight into a text block, so a model that ran out of tokens mid-object
    # delivered `{"blocks":[{"type":"text","markdown":"…` as the answer — worse
    # than prose and worse than an apology. Salvage the prose that IS there.
    salvaged = " ".join(
        m.group(1) for m in re.finditer(r'"markdown"\s*:\s*"((?:[^"\\]|\\.)*)"', text or "")
    )
    if salvaged:
        try:
            salvaged = json.loads(f'"{salvaged}"')
        except Exception:  # noqa: BLE001
            pass
    if not salvaged and text and not text.lstrip().startswith(("{", "[")):
        salvaged = text
    return {
        "blocks": [{
            "type": "text",
            "markdown": salvaged or "Chưa soạn được câu trả lời hoàn chỉnh cho câu hỏi này.",
        }],
        "text": salvaged,
    }


def _collect_citation(state: RunState, tool: str, args: dict, result: Any) -> None:
    """Record what the answer was actually built from.

    Derived from the TOOL CALLS, not from what the model says it used: a citation
    the model wrote is a claim, a citation from the tool log is evidence.
    """
    from app.services.agent_flows.envelope import Citation

    if not isinstance(result, dict) or result.get("ok") is False:
        return
    chart_id = args.get("chart_id") if isinstance(args, dict) else None
    if chart_id and not any(c.ref == str(chart_id) for c in state.citations):
        state.citations.append(
            Citation(kind="chart", ref=str(chart_id), label=str(result.get("name") or ""))
        )
    doc_id = args.get("document_id") if isinstance(args, dict) else None
    if doc_id and not any(c.ref == str(doc_id) for c in state.citations):
        state.citations.append(Citation(kind="document", ref=str(doc_id)))


async def _stream(
    *, provider: str, api_key: str, model: str,
    system_prompt: str, messages: list[dict], tools: list[dict],
) -> AsyncGenerator[AgentEvent, None]:
    """Dispatch to the vendor adapter. The one place a provider name is interpreted."""
    from app.services.dashboard_ai_bot.providers import (
        stream_anthropic,
        stream_gemini_singleshot,
        stream_openai,
    )

    fn = {
        "openai": stream_openai,
        "anthropic": stream_anthropic,
        "gemini": stream_gemini_singleshot,
    }.get((provider or "").strip().lower())
    if fn is None:
        raise RuntimeError(f"nhà cung cấp không hỗ trợ: {provider or '(chưa đặt)'}")

    kwargs: dict[str, Any] = {
        "api_key": api_key,
        "system_prompt": system_prompt,
        "messages": messages,
        "tools": tools or None,
    }
    if model:
        kwargs["model"] = model
    async for ev in fn(**kwargs):
        yield ev


SPECS = [
    NodeSpec(
        type="agent",
        label_vi="AI Agent",
        label_en="AI Agent",
        description_vi="Prompt, công cụ, tri thức và model. Bước duy nhất tốn token.",
        category="ai",
        icon="✦",
        handler=run,
        costs_llm=True,
    ),
]
