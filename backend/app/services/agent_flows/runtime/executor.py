"""Run a flow: walk the tree, one node at a time, streaming events.

WHAT THIS IS NOT
----------------
It is not a second engine. The provider adapters already speak all three vendors and
normalise their tool-call protocols into `AgentEvent`s, so the work here is
orchestration only.

The function this replaces was a `for` loop over a flat list that carried the
previous step's raw text forward. Everything that made a flow a flow — branches,
loops, variables, reuse across turns, a budget for the whole turn — had nowhere to
live. That is what this file is.

TWO CHANNELS, AND BOTH MATTER
-----------------------------
  events    progressive, for the person watching: text as it arrives, "đang dùng
            get_chart_data…", node lifecycle. Unchanged from what the FE already
            renders.
  envelope  complete and structured, delivered as the FINAL `result` event: what
            the bot renders properly, what the Runs table stores, and what a replay
            re-runs.

WHAT REACHES THE VIEWER
-----------------------
Only the answering node's text streams. Earlier nodes emit `status`, never `text`:
a viewer watching four agents deliberate would see four answers and believe the
first.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import (
    Flow,
    IfNode,
    LoopNode,
    SwitchNode,
    FilterNode,
)
from app.services.agent_flows.envelope import (
    Answer,
    FlowInput,
    FlowOutput,
    MemoryDelta,
    Notice,
    Trace,
    TraceStep,
    Usage,
    text_answer,
)
from app.services.agent_flows.runtime import nodes as node_registry
from app.services.agent_flows.runtime.state import (
    Budget,
    BudgetExhausted,
    RunState,
    as_list,
    evaluate,
    evaluate_all,
)
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)


class BranchStopped(Exception):
    """A Filter node said this branch should not continue.

    Scoped to the body it was raised in — the siblings after the enclosing IF still
    run. "Stop the whole run" is a different node (`stop`), because conflating them
    is how a filter deep inside one loop iteration silently kills the answer.
    """


@dataclass
class RunContext:
    """Everything a handler may reach. Assembled once, never patched mid-run."""

    inp: FlowInput
    flow: Flow
    #: `ToolContext`, already narrowed to the binding's allowed charts and scope by
    #: the caller. Handlers read it; nothing here writes to it.
    ctx: Any
    #: Fallback credential for nodes that carry none of their own.
    api_key: str = ""
    base_system_prompt: str = ""
    #: Key of the node whose text streams to the viewer.
    answer_key: str = ""
    db: Any = None
    events: list[AgentEvent] = field(default_factory=list)


async def run_flow(
    inp: FlowInput,
    *,
    flow: Flow,
    ctx: Any,
    api_key: str = "",
    base_system_prompt: str = "",
    db: Any = None,
) -> AsyncGenerator[AgentEvent, None]:
    """Run `flow` against `inp`. The last event is always `result`."""
    started = time.monotonic()
    state = RunState(
        vars=inp.seed_vars(),
        budget=Budget(
            max_llm_calls=inp.runtime.budget.max_llm_calls,
            max_tool_calls=inp.runtime.budget.max_tool_calls,
            max_seconds=inp.runtime.budget.max_seconds,
        ),
    )
    rctx = RunContext(
        inp=inp,
        flow=flow,
        ctx=ctx,
        api_key=api_key,
        base_system_prompt=base_system_prompt,
        answer_key=flow.answering_key(),
        db=db,
    )

    status = "ok"
    streamed_text = False
    try:
        async for ev in _run_body(list(flow.nodes), state, rctx):
            if ev.type == "text" and ev.text:
                streamed_text = True
            yield ev
    except BudgetExhausted as exc:
        status = "partial"
        state.notices.append(Notice(code="budget_exhausted", text=str(exc)))
        yield AgentEvent(type="status", text=str(exc))
    except BranchStopped:
        # A filter at the top level ends the run; there is no enclosing branch to
        # return to. Not an error.
        pass
    except Exception:  # noqa: BLE001
        logger.exception("[flow] run failed for %s", flow.key)
        status = "failed"
        state.notices.append(
            Notice(code="run_failed", text="Có lỗi khi chạy trợ lý cho câu hỏi này.")
        )

    answer = _final_answer(state, rctx)
    if _answer_is_fallback(state, rctx):
        # The designated answering node never ran — the budget ran out, or a Stop
        # ended the run early — so what reaches the viewer is an INTERMEDIATE node's
        # working-out. Presenting that as the answer is how a half-finished run
        # reads as a confident conclusion, so the run says which it is.
        status = "partial" if status == "ok" else status
        state.notices.append(
            Notice(
                code="answer_incomplete",
                text="Câu trả lời chưa qua bước tổng hợp cuối — đây là kết quả của "
                     "một bước trung gian.",
            )
        )
    if not answer.blocks:
        status = "failed" if status == "ok" else status
        # Say WHICH way it failed. "Chưa tạo được câu trả lời" was true of a run
        # that timed out, one that hit its call ceiling, and one whose model
        # rejected the key — three different things for whoever is meant to fix
        # it, and the run already knows which happened. A viewer reading a
        # generic sentence retries the same question and gets the same sentence.
        reason = next(
            (n.text for n in state.notices if n.code == "budget_exhausted"), ""
        )
        answer = text_answer(
            f"Chưa trả lời được: {reason}." if reason
            else "Chưa tạo được câu trả lời cho câu hỏi này."
        )
    if any(s.status == "error" for s in state.trace) and status == "ok":
        status = "partial"

    # ── Are the answer's figures supported by what the run actually read? ──────
    #
    # Deterministic, and it runs on the finished answer rather than trying to stop
    # the model mid-sentence. A live run of this flow reported a total of 13.59M
    # against data summing to 8.56M — every individual category figure was right,
    # the aggregate was invented, and nothing in the pipeline noticed. The check
    # does not alter the answer; it says out loud how much of it traces back to
    # evidence, because a wrong number stated confidently is the failure this
    # module can least afford.
    verification = _verify_figures(state, answer)
    if verification:
        yield AgentEvent(type="verification", extra={"verification": verification})
        if verification.get("unknown_labels"):
            names = ", ".join(verification["unknown_labels"][:4])
            logger.warning(
                "[flow] %s: answer names entities absent from the evidence: %s",
                flow.key, verification["unknown_labels"][:8],
            )
            state.notices.append(
                Notice(
                    code="labels_unverified",
                    text=f"Câu trả lời nhắc tới {names} nhưng dữ liệu đã đọc không có "
                         "các mục này — có thể báo cáo đang giới hạn số dòng.",
                )
            )
        if verification.get("unmatched"):
            logger.warning(
                "[flow] %s: %s figure(s) in the answer are not in the evidence: %s",
                flow.key, len(verification["unmatched"]), verification["unmatched"][:6],
            )
            state.notices.append(
                Notice(
                    code="figures_unverified",
                    text=f"{len(verification['unmatched'])} con số trong câu trả lời "
                         "không khớp với dữ liệu đã đọc — hãy đối chiếu lại trước khi dùng.",
                )
            )

    # Built BEFORE the envelope: `memory_payload()` can append a notice (a value too
    # large to remember), and Pydantic COPIES the notices list when it validates —
    # so a notice added while the envelope was being constructed vanished. The one
    # warning that explains why a flow keeps re-reading the report was unreachable.
    memory_set = state.memory_payload()

    out = FlowOutput(
        run_id=inp.request.id,
        status=status,  # type: ignore[arg-type]
        answer=answer,
        citations=state.citations,
        notices=state.notices,
        memory_delta=MemoryDelta(
            set=memory_set, fingerprint=inp.memory.fingerprint
        ),
        trace=Trace(path=state.path_label(), steps=state.trace),
        usage=Usage(
            llm_calls=state.budget.llm_calls,
            tool_calls=state.budget.tool_calls,
            prompt_tokens=state.prompt_tokens,
            completion_tokens=state.completion_tokens,
            ms=int((time.monotonic() - started) * 1000),
        ),
    )
    # THE ANSWER MUST ALSO ARRIVE AS TEXT.
    #
    # `json` nodes stream nothing while they compose, so the whole answer exists
    # only inside the terminal `result` envelope — and any client that does not
    # implement typed blocks then shows an empty bubble for a run that succeeded.
    # That is not a bug to chase in one client: an embed, a mobile shell and a
    # webhook consumer all have the same gap. So prose goes out on the ordinary
    # `text` channel first, and `result` upgrades it for clients that can render
    # blocks. Skipped when text already streamed, or the viewer would see it twice.
    prose = answer.plain_text()
    if prose and not streamed_text:
        yield AgentEvent(type="text", text=prose)

    yield AgentEvent(type="result", extra={"envelope": out.to_dict()})
    yield AgentEvent(type="done")


# ═══ Walking ══════════════════════════════════════════════════════════════════
async def _run_body(
    body: list[Any], state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    for node in body:
        if state.stopped:
            return
        async for ev in _run_node(node, state, rctx):
            yield ev


async def _run_node(
    node: Any, state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    label = node.name or node.key
    state.budget.check()

    reused = _reuse(node, state, rctx)
    if reused is not None:
        # Recorded as `reused`, not as `ok`. A Runs table that reports a skipped node
        # as having run is lying about what the turn cost.
        state.record(
            TraceStep(key=node.key, type=node.type, name=label, status="reused", ms=0)
        )
        yield AgentEvent(
            type="node_completed",
            extra={"step": node.key, "status": "reused", "name": label},
        )
        return

    yield AgentEvent(
        type="node_started", extra={"step": node.key, "name": label, "type": node.type}
    )
    began = time.monotonic()
    tokens_before = (state.prompt_tokens, state.completion_tokens)
    tools_before = len(state.tool_log)
    attempts = node.retry.max_attempts if node.retry else 1
    last_error = ""

    for attempt in range(1, attempts + 1):
        try:
            if isinstance(node, IfNode):
                async for ev in _run_if(node, state, rctx):
                    yield ev
            elif isinstance(node, SwitchNode):
                async for ev in _run_switch(node, state, rctx):
                    yield ev
            elif isinstance(node, LoopNode):
                async for ev in _run_loop(node, state, rctx):
                    yield ev
            elif isinstance(node, FilterNode):
                _run_filter(node, state)
            else:
                handler = node_registry.handler_for(node.type)
                if handler is None:
                    # Unreachable through the API — the contract only accepts types
                    # the registry declares — but a stored body from a newer version
                    # could name one. Skipped loudly rather than crashing the turn.
                    raise RuntimeError(f"chưa hỗ trợ loại bước '{node.type}'")
                async for ev in handler(node, state, rctx):
                    yield ev
            last_error = ""
            break
        except BranchStopped:
            # The branch stops, but the DECISION still has to appear in the trace.
            # Raising straight through left no row at all, so a Runs view showed a
            # loop iteration that simply vanished — the reader's only conclusion
            # being that the engine lost it.
            state.record(
                TraceStep(
                    key=node.key, type=node.type, name=label, status="skipped",
                    ms=int((time.monotonic() - began) * 1000),
                    output_preview="điều kiện không khớp — dừng nhánh",
                )
            )
            yield AgentEvent(
                type="node_completed",
                extra={"step": node.key, "name": label, "status": "skipped"},
            )
            raise
        except BudgetExhausted as exc:
            # Same reasoning as BranchStopped above, and the same failure when it
            # was missing: raising straight through left the trace EMPTY, so a run
            # that spent its whole budget on one node reported "no answer" with
            # nothing to say where the budget went. The node that consumed it is
            # the single most useful fact about such a run, and it was the one
            # fact being discarded.
            state.record(
                TraceStep(
                    key=node.key, type=node.type, name=label, status="error",
                    ms=int((time.monotonic() - began) * 1000),
                    error=str(exc),
                    output_preview=(
                        f"đã dùng {state.budget.tool_calls}/{state.budget.max_tool_calls} "
                        f"lượt công cụ và {state.budget.llm_calls}/"
                        f"{state.budget.max_llm_calls} lượt mô hình khi tới bước này"
                    ),
                )
            )
            yield AgentEvent(
                type="node_completed",
                extra={"step": node.key, "name": label, "status": "error"},
            )
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)[:300]
            logger.warning("[flow] node '%s' attempt %s failed: %s", node.key, attempt, exc)
            if node.retry and attempt < attempts:
                import asyncio

                await asyncio.sleep(min(node.retry.backoff_seconds, 5))
                continue
            break

    ms = int((time.monotonic() - began) * 1000)
    if last_error:
        state.record(
            TraceStep(
                key=node.key, type=node.type, name=label,
                status="error", ms=ms, error=last_error,
                tool_calls=state.tool_log[tools_before:],
            )
        )
        yield AgentEvent(
            type="error",
            text=f"Bước “{label}” gặp lỗi và bị bỏ qua.",
            extra={"step": node.key},
        )
        if node.on_error == "stop":
            state.stopped = True
        return

    _publish(node, state)
    state.record(
        TraceStep(
            key=node.key, type=node.type, name=label, status="ok", ms=ms,
            tool_calls=state.tool_log[tools_before:],
            output_preview=_preview(state.outputs.get(node.key)),
            prompt_tokens=state.prompt_tokens - tokens_before[0],
            completion_tokens=state.completion_tokens - tokens_before[1],
        )
    )
    yield AgentEvent(
        type="node_completed", extra={"step": node.key, "name": label, "ms": ms}
    )


def _reuse(node: Any, state: RunState, rctx: RunContext) -> Any:
    """The stored value for a node that need not run again this turn.

    Returns None when the node must run. A reused node still HYDRATES its variable —
    skipping without doing that would leave later nodes reading an empty string,
    which is the failure mode that makes cached control flow untrustworthy.
    """
    if node.run_policy == "every_turn" or not node.output_var:
        return None
    if node.key not in (rctx.inp.memory.reusable_nodes or []):
        return None
    value = rctx.inp.memory.vars.get(node.output_var)
    if value is None:
        return None
    state.outputs[node.key] = value
    state.set_var(node.output_var, value)
    state.memory_set[node.output_var] = value
    return value


def _publish(node: Any, state: RunState) -> None:
    """Name this node's result, and remember it if the node asked to be remembered."""
    value = state.outputs.get(node.key)
    if node.output_var:
        state.set_var(node.output_var, value)
        if node.run_policy != "every_turn":
            state.memory_set[node.output_var] = value
    state.set_var("previous", value)


# ═══ Control flow — the executor's own job ════════════════════════════════════
async def _run_if(
    node: IfNode, state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    """First matching path wins; `fallback` runs only when nothing else matched.

    IF/Else, not "run every branch that matches". The mockup draws exclusive lanes
    that merge, and running two lanes would double the cost of a turn without any
    control saying so.
    """
    chosen = None
    for path in node.paths:
        if path.kind == "fallback":
            continue
        if path.kind == "always" or evaluate_all(state, path.conditions, path.match):
            chosen = path
            break
    if chosen is None:
        chosen = next((p for p in node.paths if p.kind == "fallback"), None)

    if chosen is None:
        state.outputs[node.key] = {"matched": None}
        return

    label = chosen.name or chosen.key
    state.path.append(label)
    state.outputs[node.key] = {"matched": chosen.key, "label": label}
    yield AgentEvent(
        type="branch_taken",
        extra={"step": node.key, "path": chosen.key, "label": label},
    )
    try:
        async for ev in _run_body(chosen.body, state, rctx):
            yield ev
    except BranchStopped:
        # The filter stopped THIS lane. Siblings after the IF still run.
        pass


async def _run_switch(
    node: SwitchNode, state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    value = state.resolve(node.value)
    matched: list[Any] = []
    for case in node.cases:
        if evaluate(state, str(value), case.op, case.value):
            matched.append(case)
            if node.mode == "first_match":
                break

    if not matched and node.has_fallback and node.fallback:
        state.path.append("fallback")
        state.outputs[node.key] = {"matched": None, "value": value}
        yield AgentEvent(type="branch_taken", extra={"step": node.key, "path": "fallback"})
        try:
            async for ev in _run_body(node.fallback, state, rctx):
                yield ev
        except BranchStopped:
            pass
        return

    state.outputs[node.key] = {
        "matched": [c.key for c in matched], "value": value,
    }
    for case in matched:
        label = case.label or case.key
        state.path.append(label)
        yield AgentEvent(
            type="branch_taken", extra={"step": node.key, "path": case.key, "label": label}
        )
        try:
            async for ev in _run_body(case.body, state, rctx):
                yield ev
        except BranchStopped:
            continue


async def _run_loop(
    node: LoopNode, state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    """Walk a list, running the body per item.

    `as_list` matters here: a binding or a model may hand back a JSON string or a
    comma-separated line, and a loop that iterates the CHARACTERS of a string is
    both wrong and, at one model call per character, expensive.
    """
    items = as_list(state.resolve(node.over), limit=node.max_iterations)
    collected: list[Any] = []
    outer_item = state.vars.get(node.item_var)

    if not items:
        # A loop over nothing is not an error, but it IS the difference between
        # "analysed every segment" and "analysed none" — and silently skipping it
        # produced a run that looked complete with a body that never executed.
        state.notices.append(
            Notice(
                code="loop_empty",
                text=f"Bước “{node.name or node.key}” không có dữ liệu để lặp "
                     f"({node.over}), nên phần phân tích theo từng mục đã bị bỏ qua.",
            )
        )

    state.path.append(f"Loop×{len(items)}")
    for index, item in enumerate(items):
        state.budget.check()
        state.set_var(node.item_var, item)
        if node.index_var:
            state.set_var(node.index_var, index)
        yield AgentEvent(
            type="loop_iteration",
            extra={"step": node.key, "index": index, "total": len(items)},
        )
        try:
            async for ev in _run_body(node.body, state, rctx):
                yield ev
        except BranchStopped:
            # This item was filtered out; the remaining items still run.
            continue
        if state.stopped:
            break
        last = state.outputs.get(node.body[-1].key) if node.body else None
        collected.append(last)

    # The loop variable is restored rather than left dangling: a node AFTER the loop
    # reading `{{segment}}` would otherwise silently get the last iteration's value.
    if outer_item is None:
        state.vars.pop(node.item_var, None)
    else:
        state.set_var(node.item_var, outer_item)

    state.outputs[node.key] = collected
    if node.collect_into:
        state.set_var(node.collect_into, collected)


def _run_filter(node: FilterNode, state: RunState) -> None:
    if not evaluate_all(state, node.conditions, node.match):
        state.outputs[node.key] = {"passed": False}
        raise BranchStopped(node.key)
    state.outputs[node.key] = {"passed": True}


# ═══ The answer ═══════════════════════════════════════════════════════════════
def _final_answer(state: RunState, rctx: RunContext) -> Answer:
    """Whose text reaches the viewer.

    A Stop node that emitted wins, because it ended the run on purpose. Otherwise
    the designated answering node — never "whatever ran last", which under branching
    is whichever leaf happened to be written last in the JSON.
    """
    if state.stopped and state.stop_message:
        return text_answer(state.stop_message)

    value = state.outputs.get(rctx.answer_key)
    if isinstance(value, dict) and isinstance(value.get("blocks"), list):
        try:
            return Answer.model_validate({"blocks": value["blocks"]})
        except Exception:  # noqa: BLE001
            logger.warning("[flow] answering node returned unusable blocks")
            return text_answer(str(value.get("text") or ""))
    if isinstance(value, str):
        return text_answer(value)
    if value is None:
        # The answering node failed. Fall back to the last node that produced PROSE,
        # so a working chain with a broken final step still says something.
        #
        # Restricted to `agent` nodes on purpose. Accepting any string output meant a
        # Set Variable holding "none" became the viewer's answer — a variable is not
        # a sentence, and presenting one as the reply is worse than admitting there
        # is no answer.
        for step in reversed(state.trace):
            if step.type != "agent":
                continue
            candidate = state.outputs.get(step.key)
            if isinstance(candidate, str) and candidate.strip():
                return text_answer(candidate)
        return Answer()
    return text_answer(str(value))


def _verify_figures(state: RunState, answer: Answer) -> dict | None:
    """Check the answer's numbers against the run's own tool output.

    Reuses the existing verifier rather than writing a second one — it already
    knows how to read `1.258.681,34`, `8,4%` and `1,2 tỷ`, and a second parser
    would disagree with the first on exactly the cases that matter.
    """
    if not state.evidence:
        return None
    try:
        from app.services.dashboard_ai_bot.verifier import verify_answer

        # Every figure the viewer will SEE, not just the prose. `plain_text()`
        # drops table cells, and a fabricated number is just as wrong in a table
        # as in a sentence — arguably more so, because a table reads as data.
        parts: list[str] = [answer.plain_text()]
        for b in answer.blocks:
            data = b.model_dump(mode="json")
            if data.get("type") == "table":
                for row in data.get("rows") or []:
                    parts.extend(str(v) for v in (row or {}).values())
            elif data.get("type") == "metric":
                parts.append(str(data.get("value")))
                if data.get("delta"):
                    parts.append(str((data["delta"] or {}).get("value")))
        out = verify_answer(" ".join(p for p in parts if p), state.evidence).to_dict()
        out["unknown_labels"] = _unknown_labels(state, answer)
        return out
    except Exception:  # noqa: BLE001
        logger.debug("[flow] figure verification failed", exc_info=True)
        return None


def _unknown_labels(state: RunState, answer: Answer) -> list[str]:
    """Row labels in the answer that the run never actually read.

    THE NUMBER CHECK CANNOT CATCH THIS. A real run listed `watches_gifts` and
    `sports_leisure` in a revenue table; neither category was in the chart it read
    (that chart returns 50 rows in alphabetical order and stops before "s"), but
    the figures beside them existed elsewhere in the payload, so coverage came back
    100%. Recognising a name the evidence never contained is what closes it.

    Only the FIRST text cell of each row is checked — that is the entity the row is
    about; later cells are its measures.
    """
    if not state.evidence_labels:
        return []
    unknown: list[str] = []
    for block in answer.blocks:
        data = block.model_dump(mode="json")
        if data.get("type") != "table":
            continue
        for row in (data.get("rows") or [])[:50]:
            if not isinstance(row, dict):
                continue
            for value in row.values():
                if not isinstance(value, str) or not value.strip():
                    continue
                label = value.strip().lower()
                if label not in state.evidence_labels and label not in unknown:
                    unknown.append(label)
                break  # the row's first text cell is its identity
    return unknown[:12]


def _answer_is_fallback(state: RunState, rctx: RunContext) -> bool:
    """True when the viewer is about to be shown something other than the answer."""
    if state.stopped and state.stop_message:
        return False  # a Stop node's message IS a deliberate answer
    return state.outputs.get(rctx.answer_key) is None


def _preview(value: Any) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else repr(value)
    return text[:200]
