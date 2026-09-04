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
        # THE LANGUAGE CONSTRAINT HAS TO SIT NEXT TO THE DECISION.
        #
        # It is already in the system prompt, and that was not enough. A tool result
        # is a large English payload — English keys, an English `ordered_by`, English
        # notes like "compare the values, do not add them" — and next to a
        # ten-word Vietnamese question the model follows the payload. Measured:
        # `total_measure` answered in Vietnamese, `rank_values` and `share_of`
        # answered in English, on identical prompts in one session.
        #
        # So the reminder is repeated as the LAST message before generation, after
        # the tool output rather than before it. One short line, only when a tool
        # actually ran — a flow that never calls one never had the problem.
        if calls_made:
            messages.append({"role": "user", "content": _language_reminder(rctx)})
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
    elif node.output_format == "choice":
        # THE CONSTRAINT, CHECKED AFTER THE MODEL SPEAKS.
        #
        # The prompt above asks for one of the listed values; this decides whether
        # it got one. Asking was the whole mechanism before, and a classifier that
        # answered in prose sent an unmatchable value into the Switch below it,
        # which then ran nothing and still reported ok.
        #
        # One corrective round, because the common miss is shape rather than
        # understanding — a model that appended a sentence usually names the right
        # value when told to send only the value. If the second answer is still not
        # one of them, this RAISES: the step is recorded `error`, the run is no
        # longer `ok`, and the author reads what the model actually said instead of
        # finding an empty branch.
        picked = _match_choice(text, node.choices)
        if picked is None and not provider_error:
            picked = await _retry_choice(
                node, state, system, messages, text,
                provider=provider, api_key=api_key, model=model,
            )
        if picked is None:
            raise RuntimeError(
                f"bước phân loại không trả về giá trị hợp lệ "
                f"(cho phép: {', '.join(node.choices)}) — model trả lời: "
                f"“{(text or '').strip()[:120] or '(rỗng)'}”"
            )
        state.outputs[node.key] = picked
    else:
        # THE LANGUAGE CONSTRAINT, CHECKED AFTER THE MODEL SPEAKS.
        #
        # Same shape as the classifier check above, and for the same reason: asking
        # was the whole mechanism, and asking was not enough. Saying it in the system
        # prompt fixed one of two leaking turns; repeating it after the tool payload
        # fixed a second; a third still came back in English because a large English
        # result sitting next to a ten-word Vietnamese question is simply stronger
        # than an instruction.
        #
        # So it is verified rather than requested. The check is deliberately narrow
        # (see `_looks_wrong_language`) and the correction costs one model call that
        # only happens when the answer is actually wrong — which, by then, is the
        # cheapest thing in the turn.
        asked = getattr(getattr(rctx, "inp", None), "question", None)
        asked_text = asked.text() if hasattr(asked, "text") else ""
        if (
            node.key == rctx.answer_key
            and text
            and not provider_error
            and _looks_wrong_language(text, _locale_of(rctx), asked_text)
        ):
            fixed = await _retry_language(
                node, state, system, messages, text,
                provider=provider, api_key=api_key, model=model,
                locale=_locale_of(rctx),
            )
            # Only if the second attempt is actually better. A restatement that
            # still reads as the wrong language is not worth losing the first
            # answer's figures over.
            if fixed and not _looks_wrong_language(fixed, _locale_of(rctx), asked_text):
                text = fixed
        state.outputs[node.key] = text


#: Any one of these means the text contains Vietnamese. Cheaper and far more
#: reliable than counting English words: Vietnamese prose of any real length carries
#: a diacritic, and English prose never does.
_VI_DIACRITICS = set(
    "ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩị"
    "òóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ"
    "ĂÂĐÊÔƠƯÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊ"
    "ÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ"
)

#: A word made only of plain ASCII letters. Tokens with digits, underscores or dots
#: are excluded on purpose: `health_beauty`, `dataset_table_219` and `9.26` are DATA
#: and appear verbatim in a correct Vietnamese answer, so counting them would flag
#: every reply that quotes a category name.
_ASCII_WORD = re.compile(r"(?<![\w.])[A-Za-z]{2,}(?![\w.])")

#: Below this many plain-ASCII words there is nothing to judge. "GMV is 15,843,553"
#: is two words and a figure — a fragment, not a language choice, and not worth a
#: model call to rewrite.
_MIN_WORDS_TO_JUDGE = 6


def _locale_of(rctx: Any) -> str:
    _req = getattr(getattr(rctx, "inp", None), "request", None)
    return (getattr(_req, "locale", "") or "vi").lower().split("-")[0]


def _segment_is_wrong_language(segment: str, locale: str) -> bool:
    """Is this ONE passage in the wrong language?

    Conservative by construction: it only answers yes when the passage is long
    enough to have needed a diacritic and has none. Wrong answers cost in both
    directions — a false positive spends a model call and risks replacing a good
    answer, a false negative ships an English reply to a Vietnamese viewer — so the
    test is a fact about the characters rather than a guess about the words.
    """
    if locale != "vi" or not segment.strip():
        return False
    if any(ch in _VI_DIACRITICS for ch in segment):
        return False
    return len(_ASCII_WORD.findall(segment)) >= _MIN_WORDS_TO_JUDGE


def _looks_wrong_language(text: str, locale: str, question: str = "") -> bool:
    """Does the answer fail to match the LANGUAGE OF THE QUESTION?

    The question decides, not the locale. A `vi` link with an English-speaking
    viewer should get English answers, and an earlier draft of this check would have
    rewritten them into Vietnamese — enforcing the default instead of the rule, and
    breaking the case the rule exists for. The locale is only the fallback for when
    the question itself says nothing, and a question that says nothing is a question
    too short to judge, so in practice this fires on one shape: a clearly Vietnamese
    question answered in English.

    CHECKED IN TWO PARTS, because they failed independently. The prose and the
    `[FOLLOWUP]` suggestion lines are written under the same instruction and did not
    obey it together: measured here, the answer came back in Vietnamese and all three
    suggestion chips in English. Judging the whole string at once hid that — the
    prose supplied the diacritics that made the chips look fine. The chips are the
    part a reader is invited to CLICK, so they are judged on their own.
    """
    if locale != "vi" or not text:
        return False
    # The viewer wrote Vietnamese, or there is nothing to enforce.
    if not any(ch in _VI_DIACRITICS for ch in question or ""):
        return False
    body: list[str] = []
    follow: list[str] = []
    for line in text.split("\n"):
        (follow if "[FOLLOWUP]" in line.upper() else body).append(line)
    return (
        _segment_is_wrong_language("\n".join(body), locale)
        or _segment_is_wrong_language("\n".join(follow), locale)
    )


async def _retry_language(
    node: AgentNode, state: RunState, system: str, messages: list[dict], said: str,
    *, provider: str, api_key: str, model: str, locale: str,
) -> str:
    """Ask once for the same answer in the right language.

    RESTATE, never re-analyse: the figures in `said` were derived from tool results
    this call no longer carries, so anything it recomputes would be invented. The
    instruction is therefore about the words and explicitly not about the numbers.
    """
    lang = _LANGUAGE_NAMES.get(locale, locale)
    retry_messages = [
        *messages,
        {"role": "assistant", "content": said},
        {
            "role": "user",
            "content": (
                f"Hãy viết lại CHÍNH câu trả lời trên bằng {lang}, KỂ CẢ các "
                "dòng [FOLLOWUP] (giữ đúng số dòng và vẫn bắt đầu bằng "
                "[FOLLOWUP]). Giữ nguyên mọi con số và mọi tên dữ liệu như "
                "health_beauty. Không thêm nhận định mới, không bỏ bớt nội dung."
            ),
        },
    ]
    try:
        state.budget.spend_llm()
    except Exception:  # noqa: BLE001 — out of budget is not this step's failure
        return ""
    out = ""
    try:
        async for ev in _stream(
            provider=provider, api_key=api_key, model=model,
            system_prompt=system, messages=retry_messages, tools=[],
        ):
            if ev.type == "text":
                out += ev.text
            elif ev.type == "usage":
                state.prompt_tokens += int(ev.extra.get("prompt_tokens") or 0)
                state.completion_tokens += int(ev.extra.get("completion_tokens") or 0)
    except Exception:  # noqa: BLE001 — a failed correction keeps the first answer
        logger.warning("[flow] language restatement failed", exc_info=True)
        return ""
    return out.strip()


async def _retry_choice(
    node: AgentNode, state: RunState, system: str, messages: list[dict], said: str,
    *, provider: str, api_key: str, model: str,
) -> str | None:
    """One more round, with the miss quoted back. Returns the value, or None.

    Costs a model call, so it is bounded to exactly one and skipped when the run
    has no budget left for it — a classifier is a cheap step and must not be the
    reason an answer never gets written.
    """
    try:
        state.budget.spend_llm()
    except Exception:  # noqa: BLE001 — out of budget is not this step's failure
        return None
    retry_messages = [
        *messages,
        {"role": "assistant", "content": said},
        {
            "role": "user",
            "content": (
                "Câu trả lời trên không nằm trong danh sách. Trả lời lại bằng ĐÚNG "
                "một giá trị, nguyên văn, không thêm gì khác:\n"
                + "\n".join(f"- {c}" for c in node.choices)
            ),
        },
    ]
    got = ""
    async for ev in _stream(
        provider=provider, api_key=api_key, model=model,
        system_prompt=system, messages=retry_messages, tools=[],
    ):
        if ev.type == "text":
            got += ev.text
        elif ev.type == "usage":
            state.prompt_tokens += int(ev.extra.get("prompt_tokens") or 0)
            state.completion_tokens += int(ev.extra.get("completion_tokens") or 0)
    return _match_choice(got, node.choices)


def _resolve_model(node: AgentNode, rctx: Any) -> tuple[str, str]:
    """The node's provider/model, or the link's when it inherits.

    Delegates rather than deciding: the preflight guard needs the same answer to
    cost the flow, and when it had its own copy it read only the link's model — so
    a flow pinning a reasoning model on a fast link was costed at a quarter of what
    it takes. One rule, both readers.
    """
    from app.services.agent_flows.models_catalogue import effective_model

    return effective_model(
        node.provider, node.model,
        rctx.inp.runtime.provider, rctx.inp.runtime.model,
    )


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
        # `render_value`, not a local `json.dumps`: this was one of three copies of
        # the same rendering and the third one crashed on a `date`.
        from app.services.agent_flows.runtime.state import render_value

        return render_value(previous)
    return ""


def _knowledge_readers(node: AgentNode) -> list[str]:
    """Tools granted to THIS step that can actually open its attached sources.

    Per-step rather than per-flow: the sentence is written for one model, and a
    reader granted three steps away cannot help the one being prompted here.
    """
    from app.services.agent_flows.coverage import READERS_BY_SOURCE

    granted = {str(getattr(g, "tool", "") or "") for g in (node.tools or [])}
    needed: set[str] = set()
    for k in node.knowledge or []:
        needed |= set(READERS_BY_SOURCE.get(str(getattr(k, "source", "") or ""), ()))
    return sorted(granted & needed)


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
    if node.output_format == "choice":
        # A CLASSIFIER IS NOT AN ANALYST, SO IT DOES NOT GET THE ANALYST'S RULES.
        #
        # `_COMPACT_BASE` ends with "Nếu dữ liệu không có, nói rõ là không có" — the
        # right instruction for a step that writes prose about figures, and the
        # wrong one for a step whose entire job is to emit one token from a fixed
        # list. Given both, a model handed thin input follows the more specific,
        # more recent sentence and explains itself; the Switch downstream then
        # matches nothing. The classifier's contract is below, and it is the only
        # contract it needs.
        parts.append(_choice_instructions(node))
    elif rctx.base_system_prompt.strip():
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
        # THESE ARE LABELS, NOT CONTENTS — AND THE MODEL HAS TO BE TOLD SO.
        #
        # An attachment does two things and neither is retrieval: it sets the
        # BOUNDARY a search tool may look inside, and it puts this line in the
        # prompt. The text after the dash is the AUTHOR'S own note about why the
        # source is attached — not a sentence from it.
        #
        # Read as a heading over `- [document] 26 — Quy ước tính GMV và phí vận
        # chuyển của Olist`, the old wording invited exactly one reading. Asked
        # "GMV có gồm phí ship không?", a flow granted no reading tool answered
        # "Theo tài liệu 26 — Quy ước tính GMV và phí vận chuyển của Olist, GMV
        # không bao gồm phí vận chuyển" after one call to `inspect_filters`. The
        # document says nothing about shipping; the description had become the
        # citation, and the answer contradicted the semantic layer's own formula.
        readable = _knowledge_readers(node)
        if readable:
            parts.append(
                "NGUỒN TRI THỨC BƯỚC NÀY ĐƯỢC PHÉP TRA (tên nguồn, chưa phải nội "
                "dung — phải gọi công cụ %s để đọc; chỉ trích dẫn những gì công cụ "
                "trả về)\n%s" % ("/".join(readable), "\n".join(sources))
            )
        else:
            parts.append(
                "NGUỒN CHỈ ĐỂ THAM KHẢO TÊN — BƯỚC NÀY KHÔNG CÓ CÔNG CỤ ĐỂ MỞ "
                "CHÚNG.\nPhần sau dấu gạch là ghi chú của người dựng luồng về lý "
                "do đính kèm, KHÔNG phải trích từ nguồn. Không được trích dẫn, "
                "tóm tắt hay suy ra nội dung của chúng. Nếu câu hỏi cần nội dung "
                "này, hãy nói rõ là chưa tra được.\n" + "\n".join(sources)
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
            "thúc bằng dấu ?. Chúng không tính vào độ dài câu trả lời. "
            # The chips are the one part of the reply the reader is invited to
            # CLICK, and they were coming back in English under a Vietnamese
            # answer — the language rule was read as being about the prose. Said
            # here because this is the sentence that asks for them.
            "Các dòng gợi ý phải CÙNG ngôn ngữ với câu trả lời."
        )
        # WHICH LANGUAGE TO ANSWER IN, SAID RATHER THAN INFERRED.
        #
        # The base prompt already asks for "the language of the question", and the
        # model still got it wrong: measured on this deployment, two of four
        # Vietnamese questions in one session came back in English — the two where a
        # tool returned English data values (`health_beauty`), which is apparently
        # enough to tip the inference. Meanwhile `request.locale` had been on the
        # envelope from the start, set per link, and read by nothing.
        #
        # So the rule now carries a CONCRETE default instead of a principle: the
        # question's language wins, and when that is unclear the link's own language
        # decides. Appended last, beside the follow-up contract, for the same reason
        # — an author's "answer in one short sentence" otherwise wins over anything
        # said earlier.
        # Reached defensively, like everything else this builder touches: assembling
        # a prompt must never be the thing that fails a run, so a caller without a
        # request envelope gets the default rather than an AttributeError.
        _req = getattr(getattr(rctx, "inp", None), "request", None)
        locale = (getattr(_req, "locale", "") or "vi").lower()
        lang = _LANGUAGE_NAMES.get(locale.split("-")[0], locale)
        parts.append(
            "NGÔN NGỮ: trả lời bằng ngôn ngữ của câu hỏi. Nếu không xác định được, "
            f"trả lời bằng {lang}. Giá trị dữ liệu (tên danh mục, tên bang…) giữ "
            "nguyên như trong báo cáo, không dịch."
        )
    return "\n\n".join(p for p in parts if p)


def _language_reminder(rctx: Any) -> str:
    """One line, repeated after tool output, naming the language to answer in.

    Deliberately short. It is competing for attention with a large tool payload, and
    a paragraph here would push the payload further from the model's focus while
    saying nothing the system prompt has not already said.
    """
    _req = getattr(getattr(rctx, "inp", None), "request", None)
    locale = (getattr(_req, "locale", "") or "vi").lower()
    lang = _LANGUAGE_NAMES.get(locale.split("-")[0], locale)
    return (
        f"(Nhắc lại: trả lời bằng ngôn ngữ của câu hỏi — nếu không rõ thì {lang}. "
        "Dữ liệu ở trên là tiếng Anh, đừng để nó đổi ngôn ngữ câu trả lời.)"
    )


#: Named in the prompt so the instruction is concrete rather than a principle. Only
#: the languages this deployment serves; anything else falls through to its own code,
#: which a model reads correctly ("answer in ja") far more reliably than it guesses.
_LANGUAGE_NAMES = {
    "vi": "tiếng Việt",
    "en": "English",
}
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
def _choice_instructions(node: AgentNode) -> str:
    """What a classifier is told. The rule that MATTERS is enforced below, in code;
    this only saves a round by asking for the right shape first.

    THE OPTIONS CARRY THEIR MEANING WHERE THE AUTHOR GAVE ONE. A choice list is
    usually variable names — `tra_so`, `du_bao` — and a model asked to pick between
    variable names is guessing at what they were meant to stand for. Measured: a
    plain lookup question was routed to the forecast branch, and the lookup branch
    never fired at all. `choice_hints` costs a dozen words per option on a step
    whose entire output is one token.
    """
    options = "\n".join(
        f"- {c}" + (f" — {node.choice_hints[c]}" if node.choice_hints.get(c) else "")
        for c in node.choices
    )
    return (
        "Bạn là bộ PHÂN LOẠI. Trả lời bằng ĐÚNG MỘT giá trị trong danh sách dưới "
        "đây, viết nguyên văn, không thêm dấu câu, không giải thích, không xuống "
        "dòng. Nếu không chắc, vẫn phải chọn giá trị gần đúng nhất — không được "
        "trả lời rằng thiếu dữ liệu.\n" + options
    )


def _match_choice(text: str, choices: list[str]) -> str | None:
    """The model's answer as one of `choices`, or None.

    Deliberately forgiving about SHAPE and strict about VALUE: a model that obeyed
    the instruction and then added a full stop, a quote, or an "Answer:" prefix has
    classified correctly, and failing that turn would spend a retry on punctuation.
    A model that wrote a sentence has NOT classified, and no amount of substring
    matching should turn that into a decision — the containment check below runs
    only on a short reply, so a paragraph that mentions a category in passing
    cannot be read as choosing it.
    """
    raw = (text or "").strip().strip("\"'`.。 \n\t")
    if not raw:
        return None
    lowered = raw.lower()
    for c in choices:
        if lowered == c.strip().lower():
            return c
    for c in choices:
        tail = c.strip().lower()
        if lowered.endswith(": " + tail) or lowered.endswith("=" + tail):
            return c
    if len(raw) <= 64:
        hits = [c for c in choices if c.strip().lower() in lowered]
        if len(hits) == 1:
            return hits[0]
    return None


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

    # THE PAYLOAD IS UNDER `data`.
    #
    # `tools.result.normalise` wraps every tool body as `{ok, kind, data}`, so
    # `result.get("citations")` is None and `result.get("name")` is None — this
    # read the ENVELOPE and the facts live one level down. Every knowledge search
    # therefore contributed nothing to the answer's citation list, and every chart
    # citation was labelled with an empty string, in production, while a unit test
    # passed because it handed this function the inner payload directly.
    #
    # Found by driving the Test panel in a browser and seeing no source cards under
    # an answer whose trace showed three `search_knowledge` calls.
    payload = result.get("data") if isinstance(result.get("data"), dict) else result

    chart_id = args.get("chart_id") if isinstance(args, dict) else None
    if chart_id and not any(c.ref == str(chart_id) for c in state.citations):
        state.citations.append(
            Citation(kind="chart", ref=str(chart_id), label=str(payload.get("name") or ""))
        )
    doc_id = args.get("document_id") if isinstance(args, dict) else None
    if doc_id and not any(c.ref == str(doc_id) for c in state.citations):
        state.citations.append(Citation(kind="document", ref=str(doc_id)))

    # THE PASSAGES A KNOWLEDGE SEARCH ACTUALLY RETURNED.
    #
    # Only `chart_id` and `document_id` were read above, both from the tool's
    # ARGUMENTS — so a `search_knowledge` call, which names no document in its
    # arguments and returns eight numbered sources in its result, contributed
    # nothing. An agent could search the knowledge base, quote a policy, and hand
    # the viewer an answer whose citation list was empty.
    #
    # `ref` is "doc:block" rather than the document id alone: two passages from
    # different sections of the same document are two different citations, and
    # collapsing them loses the only part a reader needs — which part.
    for source in (payload.get("citations") or [])[:12]:
        if not isinstance(source, dict):
            continue
        ref = "%s:%s" % (source.get("doc_id"), source.get("block"))
        if any(c.ref == ref for c in state.citations):
            continue
        state.citations.append(Citation(
            kind="document",
            ref=ref,
            label=_source_label(source),
            # The number the model was told to cite. Without it a `[3]` in the
            # answer cannot be resolved back to the passage it names.
            used=[str(source.get("n"))] if source.get("n") else [],
            # What makes the citation re-openable at the version it was made
            # against, months later, with a check that the text is still the same.
            version=source.get("source_version"),
            block_to=source.get("block_to"),
            fingerprint=str(source.get("content_fingerprint") or ""),
        ))


def _source_label(source: dict) -> str:
    """A passage named the way a person would name it: document, section, page."""
    title = str(source.get("title") or "").strip()
    path = [p.strip() for p in str(source.get("heading_path") or "").split(">") if p.strip()]
    if path and title and path[0].lower() == title.lower():
        path = path[1:]
    parts = [title, " > ".join(path)]
    if source.get("page"):
        parts.append("trang %s" % source["page"])
    return " › ".join(p for p in parts if p)


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
