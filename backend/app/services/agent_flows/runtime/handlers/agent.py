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
from app.services.agent_flows.envelope import Answer, Notice
from app.services.agent_flows.models_catalogue import INHERIT
from app.services.agent_flows.qualifiers import check_qualifiers
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


def preview(node: AgentNode, state: RunState, rctx: Any) -> dict:
    """Exactly what this step will hand the model, assembled the way a run does.

    WHY THIS EXISTS
    ---------------
    An author configures eleven sections and a prompt, and nothing anywhere in the
    product showed them the result. The rule that governs everything — the step's
    instructions are APPENDED to a base prompt, prior steps arrive as named blocks,
    tools arrive as schemas — lived in one line of helper text under a textarea.
    So the mental model had to be inferred from field names, which is the complaint
    the product keeps getting: not that there are too many controls, but that
    nobody is told what they do.

    IT CALLS THE SAME THREE FUNCTIONS THE RUN CALLS.
    `_system_prompt`, `_messages` and `definitions_for` are the entire assembly; a
    preview that rebuilt any of them would be a second definition, and a second
    definition drifts. When it drifts, this screen becomes worse than nothing —
    an author would trust it and be wrong.

    What it cannot show is the model's REPLY, and it does not pretend to: no model
    is called, nothing is spent, and every figure here is the input side only.
    """
    allowed = set(node.tool_names())
    web_enabled = bool(rctx.inp.binding.capabilities.web_search)
    schemas = tool_registry.definitions_for(allowed, web_enabled=web_enabled)
    # THE SAME VIEW A RUN BUILDS for round one. A step granted more than the
    # visibility limit is shown a shortlist; showing the author the full grant
    # here would describe a prompt the model never receives.
    from app.services.agent_flows.runtime.capabilities import build_view

    from app.services.agent_flows.runtime.agent_runtime import _skill_capabilities

    try:
        extras, excluded_extras = _skill_capabilities(node, rctx)
    except Exception:                                           # noqa: BLE001
        extras, excluded_extras = [], {}
    view = build_view(node.tool_names(), rctx.ctx, web_enabled=web_enabled,
                      limit=getattr(node, "visible_capabilities", None),
                      extras=extras, excluded_extras=excluded_extras)
    try:
        ranking = " ".join(filter(None, [rctx.inp.question.text(), node.prompt or ""]))
    except Exception:                                           # noqa: BLE001
        ranking = node.prompt or ""
    view.refresh(ranking)
    if view.shortlisted:
        schemas = view.schemas(web_enabled=web_enabled)
    else:
        # A run offers granted Skills alongside the tools; so does the preview.
        schemas = schemas + [e.definition for e in extras]

    previous_scope = getattr(rctx.ctx, "knowledge_scope", None)
    try:
        _apply_scope(rctx.ctx, node)
        # The STRATEGY builds the request, exactly as a run does — so anything a
        # strategy adds to the context (the evidence index a `compute` step is
        # given) is on this screen too.
        from app.services.agent_flows.runtime.strategies import strategy_for

        strategy = strategy_for(node, state, rctx, max_rounds=MAX_ROUNDS)
        strategy.build_request()
        system, messages = strategy.system, strategy.messages
        # The run appends this in `ToolCallingStrategy.run`; the preview must too.
        hidden = view.hidden_index()
        if hidden:
            system = f"{system}\n\n{hidden}"
    finally:
        # Same restore discipline as `run`: a preview must not leave the context
        # holding a scope the next caller was never granted.
        if previous_scope is not None:
            rctx.ctx.knowledge_scope = previous_scope

    def _fn(d: dict) -> dict:
        return d.get("function") or d

    tools = [{
        "name": _fn(d).get("name"),
        "description": (_fn(d).get("description") or "")[:400],
        "arguments": sorted(
            ((_fn(d).get("input_schema") or _fn(d).get("parameters") or {})
             .get("properties") or {}).keys()
        ),
        "required": sorted(
            (_fn(d).get("input_schema") or _fn(d).get("parameters") or {})
            .get("required") or []
        ),
    } for d in schemas]

    # WHERE THE SYSTEM PROMPT CAME FROM, split the way an author reasons about it:
    # the part every step shares and the part THIS step added. Shown as one string
    # too, because that is what the model actually receives and the seam is ours,
    # not its.
    base = (getattr(rctx, "base_system_prompt", "") or "").strip()
    own = (node.prompt or "").strip()
    # WHICH BASE THIS STEP GETS, named rather than implied by a character count.
    # `_system_prompt` gives the FULL base only to the answering node and a compact
    # one to every other step — a real rule, deliberate and documented there, that
    # an author had no way to observe. Measured on the demo flow: the answering
    # step's system prompt is 8,976 characters and a specialist's is 640. Seeing
    # "your 438 characters sit inside 8,976" is the single most clarifying fact
    # this screen can show, and it is wrong unless the base is named.
    if node.output_format == "choice":
        base_kind = "classifier"
    elif node.key == rctx.answer_key:
        base_kind = "full"
    elif base:
        base_kind = "compact"
    else:
        base_kind = "none"

    provider, model = _resolve_model(node, rctx)
    return {
        "step": {"key": node.key, "name": node.name or node.key,
                 "is_answering": node.key == rctx.answer_key},
        "model": {"provider": provider, "model": model},
        "system_prompt": {
            "full": system,
            # What the step actually received, not what was available to it.
            "base_kind": base_kind,
            "shared_base_chars": max(0, len(system) - len(own)),
            "this_step_chars": len(own),
            "this_step": own,
        },
        "messages": [{
            "role": m.get("role"),
            "content": _preview_text(m),
            "chars": len(_preview_text(m)),
        } for m in messages],
        "tools": tools,
        #: Granted vs eligible vs shown on round one — and why anything granted
        #: was left out. The model sees only `tools`; this says how it got there.
        "capabilities": {
            "granted": view.granted,
            "eligible": view.eligible,
            "excluded": view.excluded,
            "limit": view.limit,
            "shortlisted": view.shortlisted,
            "visible": view.visible,
        },
        "knowledge_scope": dict(getattr(rctx.ctx, "knowledge_scope", None) or {}),
        "budget": {
            "max_tool_calls": node.max_tool_calls,
            "max_llm_calls": rctx.inp.runtime.budget.max_llm_calls,
            "max_seconds": rctx.inp.runtime.budget.max_seconds,
        },
        "totals": {
            "system_chars": len(system),
            "message_chars": sum(len(_preview_text(m)) for m in messages),
            "tool_count": len(tools),
        },
    }


def _preview_text(message: dict) -> str:
    """One message as text, whatever shape the provider adapter wants it in."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if content is None and message.get("result") is not None:
        import json as _json

        return _json.dumps(message["result"], ensure_ascii=False)[:4000]
    if content is None:
        return ""
    import json as _json

    return _json.dumps(content, ensure_ascii=False)[:4000]


# The retry policy, dimension outcome, citations, model and scope resolution are
# EXECUTION rules and live in `runtime/agent_runtime.py`. Re-exported under their
# old names, which tests and the executor import from here.
from app.services.agent_flows.runtime.agent_runtime import (  # noqa: E402,F401
    _FINAL_ERROR_CODES,
    _MAX_IGNORED_RECOVERIES,
    AgentRuntime,
    _apply_scope,
    _call_with_retry_policy,
    _collect_citation,
    _is_final_refusal,
    _note_dimension_outcome,
    _resolve_model,
    _retry_key,
    _source_label,
)
from app.services.agent_flows.reader_diagnostics import (
    tool_label as _reader_tool_label,
)


async def run(
    node: AgentNode, state: RunState, rctx: Any
) -> AsyncGenerator[AgentEvent, None]:
    """One Agent step: the node's STRATEGY reasons, the RUNTIME executes and governs.

    The loop that used to live here is `strategies/tool_calling.py`; the rules it
    enforced are `agent_runtime.AgentRuntime`. What stays here is the answer
    contract for the step's output — output formats and the answering node's
    verifiers — which are correctness rules applied to whatever the strategy wrote.
    """
    from app.services.agent_flows.runtime.strategies import strategy_for

    rt = AgentRuntime(
        node, state, rctx,
        # Looked up at call time, so the one place a provider name is interpreted
        # stays `_stream` below — and a harness replacing it replaces it for runs.
        stream=lambda **kw: _stream(**kw),
        status_label=_reader_tool_label,
    )
    strategy = strategy_for(node, state, rctx, max_rounds=MAX_ROUNDS)
    rt.enter()
    try:
        async for ev in strategy.run(rt):
            yield ev
    finally:
        # Restored even when the node raises, or the next node would inherit a scope
        # it was never granted — a silent widening of what the flow may read.
        rt.exit()

    provider, model, api_key = rt.provider, rt.model, rt.api_key
    provider_error = rt.provider_error
    system, messages, collected = strategy.system, strategy.messages, strategy.collected

    text = _plain_formulas(collected.strip())
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
        # ── FIGURES THAT TRACE BACK TO NOTHING THE RUN READ ───────────────────
        #
        # The run already detected these and did nothing about them.
        # `_verify_figures` in the executor checks the FINISHED answer and appends
        # a Notice, so across 269 real runs 32 of them — 12%, one answer in eight —
        # shipped carrying a number absent from the evidence, each labelled "hãy
        # đối chiếu lại" and sent anyway. One reported a total of 13.59M against
        # data summing to 8.56M: every component figure right, the total invented.
        # Detecting a fabricated number and then forwarding it with a disclaimer
        # is not a check, it is a signature.
        #
        # It belongs HERE, because here the tool results are still in `messages`.
        # The executor's copy runs after the run is over, when the only thing left
        # to do is warn. Same verifier and same tolerance — the difference is that
        # at this point the model can still fix it, by re-reading evidence it
        # already has rather than recalling it.
        #
        # A figure the model derived CORRECTLY also fails this test, which is why
        # the correction is offered rather than imposed: it may answer by showing
        # the arithmetic instead of changing the number. So the replacement is
        # accepted only when strictly fewer figures are unsupported afterwards —
        # the same "only if actually better" rule as the language retry below,
        # for the same reason. A rewrite that trades a wrong total for a wrong
        # breakdown is not a correction.
        if node.key == rctx.answer_key and text and not provider_error:
            unsupported, supported = _figure_check(text, state)
            if unsupported:
                fixed = await _retry_figures(
                    node, state, system, messages, text, unsupported,
                    provider=provider, api_key=api_key, model=model,
                )
                if fixed and not _echoes_instruction(fixed):
                    left, kept = _figure_check(fixed, state)
                    # BOTH HALVES, because "fewer unsupported" alone is trivially
                    # gamed: a reply that discards the analysis and says nothing
                    # scores a perfect zero. A golden-test stub did exactly that —
                    # it echoed the correction prompt back, which carried fewer
                    # numbers than the answer it replaced and therefore "won" — and
                    # a real model asked to remove a figure can wander into the
                    # same shape. So a correction may drop figures that trace to
                    # nothing and may not lose ones that trace to something.
                    if len(left) < len(unsupported) and kept >= supported:
                        logger.info(
                            "[flow] %s: figure correction %d -> %d unsupported, "
                            "%d supported kept", node.key, len(unsupported),
                            len(left), kept,
                        )
                        text = fixed

        # THE WORDS AROUND THE NUMBER ARE CLAIMS TOO.
        #
        # `_figure_check` above asks whether the digits trace to evidence. It passes
        # "1.258.681,34 USD doanh thu tháng 9" as readily as "1.258.681,34", and
        # measured on this deployment the same figure was published once as USD and
        # once as VNĐ over BRAZILIAN data, with no currency declared anywhere. Both
        # answers verified clean.
        #
        # Same place, same shape, same "only if actually better" acceptance rule —
        # the tool results are still in `messages`, so the model can fix a qualifier
        # by re-reading rather than recalling.
        if node.key == rctx.answer_key and text and not provider_error:
            tool_results: list[Any] = [
                m.get("result") for m in messages if m.get("role") == "tool"
            ]
            # EARLIER STEPS COUNT AS EVIDENCE. A range established by
            # `describe_time_coverage` in a previous node is a real source, and
            # treating it as absent would flag a correct answer.
            prior = _all_step_results(state, rctx, skip=node.key)
            if prior:
                tool_results.append(prior)
            tools_called = sorted({
                *(str(m.get("name") or "") for m in messages if m.get("role") == "tool"),
                *(t for step in state.trace for t in (step.tool_calls or [])),
            })
            violations = check_qualifiers(text, tool_results, tools_called)
            if violations:
                _, supported_before = _figure_check(text, state)
                fixed = await _retry_qualifiers(
                    node, state, system, messages, text, violations,
                    provider=provider, api_key=api_key, model=model,
                )
                if fixed and not _echoes_instruction(fixed):
                    left = check_qualifiers(fixed, tool_results, tools_called)
                    _, supported_after = _figure_check(fixed, state)
                    # A rewrite that drops the analysis to lose a qualifier is not a
                    # correction — the same trap the figure retry already learned.
                    if len(left) < len(violations) and supported_after >= supported_before:
                        logger.info(
                            "[flow] %s: qualifier correction %d -> %d unsupported",
                            node.key, len(violations), len(left),
                        )
                        text = fixed
                        violations = left
                if violations:
                    state.notices.append(
                        Notice(
                            code="qualifier_unverified",
                            audience="reader",
                            severity="warning",
                            text=(
                                "Câu trả lời nêu "
                                + ", ".join(
                                    f"“{v['claim']}”" for v in violations[:3])
                                + " nhưng dữ liệu đã đọc không khẳng định điều đó — "
                                "hãy đối chiếu lại trước khi dùng."
                            ),
                        )
                    )

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


#: LaTeX a chat bubble cannot render. Narrow on purpose — these are the forms a
#: model actually emits for a formula, and anything broader would start rewriting
#: prose that merely contains a backslash.
_LATEX_FIXES = (
    (re.compile(r"\\\[|\\\]|\\\(|\\\)"), ""),
    (re.compile(r"\\text\s*\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\\mathrm\s*\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\\times"), "×"),
    (re.compile(r"\\(?=[_%&#${}])"), ""),
)


def _plain_formulas(text: str) -> str:
    """Formulas a viewer can read, not LaTeX source.

    Asked how a KPI is calculated, a model answered with a display-math block —
    `\\[`, `\\text{...}`, escaped underscores and all. The chat renders markdown,
    not TeX, so every one of those characters reached the viewer verbatim. Found
    by reading an answer in the product: the whole suite checks the FIGURES in an
    answer and nothing had ever checked whether a person could read it.

    A transform rather than an instruction, because this file already records what
    happened the last three times an instruction was the whole mechanism — a large
    English tool payload beat the prompt twice, and the language rule had to end up
    being verified after the fact. Context can outvote a request; it cannot outvote
    a regex.
    """
    if not text or "\\" not in text:
        return text
    for pattern, replacement in _LATEX_FIXES:
        text = pattern.sub(replacement, text)
    # The stripped delimiters leave their own blank lines behind.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _figure_check(text: str, state: RunState) -> tuple[list[float], int]:
    """(figures that trace back to no tool result, count of figures that do).

    Reuses the bot's verifier rather than writing a second number parser: it
    already reads `1.258.681,34`, `8,4%` and `1,2 tỷ`, and two parsers would
    disagree on exactly the cases worth catching.

    Both numbers are returned because judging a rewrite needs both. What it
    removed matters, and so does what it kept.
    """
    if not text or not state.evidence:
        return [], 0
    try:
        from app.services.dashboard_ai_bot.verifier import verify_answer

        result = verify_answer(text, state.evidence)
        return list(result.unmatched), int(result.matched or 0)
    except Exception:  # noqa: BLE001 — a broken check must not break the answer
        logger.debug("[flow] figure check failed", exc_info=True)
        return [], 0


def _unsupported_figures(text: str, state: RunState) -> list[float]:
    """Just the unsupported half, for callers that only decide on that."""
    return _figure_check(text, state)[0]


#: Phrases that exist ONLY in the correction instruction. An answer containing one
#: is the instruction handed back rather than acted on — some providers do this with
#: a long tool-result history, and a golden-test stub does it by design. Either way
#: it is not a correction, and the first answer is the better of the two.
_INSTRUCTION_MARKERS = ("Đối chiếu lại", "chọn một cách xử lý")


def _echoes_instruction(text: str) -> bool:
    return any(m in text for m in _INSTRUCTION_MARKERS)


def _fmt_figure(value: float) -> str:
    """As the answer would have written it, so the model recognises which one."""
    return str(int(value)) if float(value).is_integer() else ("%g" % value)


async def _retry_figures(
    node: AgentNode, state: RunState, system: str, messages: list[dict], said: str,
    unsupported: list[float], *, provider: str, api_key: str, model: str,
) -> str:
    """Name the figures that trace to nothing, and ask for one correction.

    NAME THEM. The Notice this replaces said "một số con số có thể chưa khớp", and
    a warning that vague produces a hedge — which is what the Notice already was.
    The model is told which numbers failed and given the three honest ways out, so
    that "I could not find this" is an available answer and not a failure.
    """
    shown = ", ".join(_fmt_figure(v) for v in unsupported[:8])
    more = "" if len(unsupported) <= 8 else f" (và {len(unsupported) - 8} số khác)"
    retry_messages = [
        *messages,
        {"role": "assistant", "content": said},
        {
            "role": "user",
            "content": (
                f"Đối chiếu lại: {shown}{more} — những con số này trong câu trả "
                "lời trên không khớp với bất kỳ dữ liệu nào bạn vừa đọc được từ "
                "công cụ.\nVới TỪNG số, chọn một cách xử lý:\n"
                "1. Sửa lại đúng theo số có trong kết quả công cụ ở trên;\n"
                "2. Nếu là số bạn tự tính (tổng, tỷ lệ, chênh lệch), ghi rõ phép "
                "tính từ các số gốc để người đọc kiểm chứng được;\n"
                "3. Nếu không lấy được từ dữ liệu đã đọc, bỏ con số đó đi và nói "
                "thẳng là chưa có dữ liệu.\n"
                "Giữ nguyên phần còn lại, kể cả các dòng [FOLLOWUP] (đúng số dòng, "
                "vẫn bắt đầu bằng [FOLLOWUP]). Không thêm phân tích mới."
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
        logger.warning("[flow] figure correction failed", exc_info=True)
        return ""
    return out.strip()


async def _retry_qualifiers(
    node: AgentNode, state: RunState, system: str, messages: list[dict], said: str,
    violations: list[dict], *, provider: str, api_key: str, model: str,
) -> str:
    """Name the unsourced qualifiers and ask for one correction.

    NAME THEM, like the figure retry does, and for the same reason: "một số chi tiết
    có thể chưa chính xác" produces a hedge, which is what the notice already was.
    Each violation carries the sentence explaining what to change, written where the
    rule that found it lives — so the model is told which claim, and why it fails.
    """
    listed = chr(10).join(f"- {v['why']}" for v in violations[:5])
    retry_messages = [
        *messages,
        {"role": "assistant", "content": said},
        {
            "role": "user",
            "content": (
                "Những chi tiết sau trong câu trả lời trên KHÔNG có trong dữ liệu "
                f"bạn vừa đọc:{chr(10)}{listed}{chr(10)}"
                "Sửa lại từng điểm: bỏ phần không có căn cứ, hoặc nói rõ là dữ liệu "
                "không cho biết điều đó. GIỮ NGUYÊN mọi con số đã đúng và phần phân "
                "tích còn lại, kể cả các dòng [FOLLOWUP] (đúng số dòng, vẫn bắt đầu "
                "bằng [FOLLOWUP]). Không thêm phân tích mới, không bỏ bớt kết quả."
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
        logger.warning("[flow] qualifier correction failed", exc_info=True)
        return ""
    return out.strip()


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

    # A LANE'S ASSIGNMENT, WHEN THIS NODE IS RUNNING INSIDE ONE.
    #
    # Set by the coordinator around each specialist body and cleared after, so a
    # node outside one never sees it. Placed straight after the question because
    # it narrows the question, and before the data because a specialist that reads
    # the whole report first has already decided to answer all of it.
    brief = str(state.vars.get("specialist_brief") or "").strip()
    if brief:
        out.append({"role": "user", "content": brief})

    # THE STEP THAT SYNTHESISES HAS TO SEE EVERYTHING THERE IS TO SYNTHESISE.
    #
    # Every node published its result into `previous`, and `previous` is
    # overwritten by whoever ran last. So a flow with two specialists handed the
    # writer exactly one of them. Measured, three agents in order:
    #
    #     thu tu goi: ['chuyen_gia_a', 'chuyen_gia_b', 'tong_hop']
    #     tong hop nhan: "Result of the previous step: KQ-chuyen_gia_b"
    #     nhac toi ket qua chuyen gia A? False
    #
    # A's work was computed, paid for, and silently dropped. The author sees every
    # step green and an answer that quietly ignores half the flow — and the more
    # specialists they add, the more of the run is discarded.
    #
    # Only the answering node gets the full set. That is where combining is the
    # job; giving it to every node would restore the "full transcript to every
    # step" cost this function exists to avoid.
    if node.key and node.key == getattr(rctx, "answer_key", ""):
        gathered = _all_step_results(state, rctx, skip=node.key)
        if gathered:
            out.append({"role": "user", "content": gathered})
            return out

    carried = _previous_text(state.vars.get("previous"))
    if carried:
        out.append({
            "role": "user",
            "content": f"Result of the previous step:\n\n{carried[:8000]}",
        })
    return out


from app.services.agent_flows.contract import ROUTING_NODE_TYPES as _ROUTING_TYPES

#: What the synthesiser is handed, in characters. Defined by the module that owns
#: the handoff so the read node can warn against the same number this spends.
from app.services.agent_flows.runtime.context import HANDOFF_CHARS as _HANDOFF_CHARS


def _all_step_results(state: RunState, rctx: Any, *, skip: str = "") -> str:
    """Every step's result, projected into what this model can actually read.

    Projection, not truncation. The old version head-sliced each step at 2,000
    characters and spent an 8,000-character total in run order, so a JSON result
    could arrive cut mid-array and a third specialist could vanish because the
    first was verbose — while the run reported three healthy steps.

    Routing steps stay out: `{"picked": ["chuyen_gia_chi_phi"]}` is a record of
    which way the run went, not evidence a number is right. The TRACE keeps it,
    which is where an author looks to see why a lane ran.
    """
    from app.services.agent_flows.runtime.context import StepView, compile_context

    names = {s.key: (s.name or s.key) for s in state.trace}
    views = [
        StepView(key=step.key, name=names.get(step.key, step.key),
                 text=_previous_text(state.outputs.get(step.key)) or "")
        for step in state.trace
        if step.key != skip and step.type not in _ROUTING_TYPES
    ]
    projection = compile_context(views, _HANDOFF_CHARS)
    # WHAT THE MODEL SAW, kept where an author can find it. The Runs inspector
    # cannot tell the truth about a handoff the runtime never recorded.
    state.context_coverage = projection.coverage
    if not projection.text:
        return ""
    return (
        "Kết quả của các bước trước, theo thứ tự đã chạy. Tổng hợp TẤT CẢ, "
        "không chỉ bước cuối; nếu hai bước mâu thuẫn thì nói rõ ra thay vì "
        "chọn bừa một bên:\n\n" + projection.text
    )


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
