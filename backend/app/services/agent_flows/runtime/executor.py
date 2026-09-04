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

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from app.services.agent_flows.contract import (
    ROUTING_NODE_TYPES,
    CoordinateNode,
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

#: Notices that mean the run did NOT execute as designed, even though every step
#: that ran, ran without error. They downgrade `ok` to `partial`, because a run
#: whose branches all missed is not a success — it is a question the flow was not
#: shaped to answer, and the operator has to be able to see that in the numbers.
DEGRADING_NOTICES = frozenset({"branch_unmatched"})



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
    if not _has_visible_answer(answer):
        # NOTHING REACHED THE VIEWER, SO THE RUN FAILED — whatever was decided
        # above.
        #
        # The test is the CONTENT, not the container. This read `not
        # answer.blocks`, and a model that streamed usage but no text produced
        # exactly one block holding the empty string: a non-empty list of nothing.
        # The guard passed, and a run in which the viewer was shown a blank reply
        # was filed `ok` — counted as an answered question in the flow's success
        # rate, which is the number an operator uses to decide the flow works.
        # Same defect as the one described below, one level further in.
        #
        # This was `status = "failed" if status == "ok" else status`, and the
        # branch above had already moved status to "partial" in exactly the case
        # that produces no blocks: the answering node died, so the answer is a
        # fallback AND there is nothing in it. The guard could therefore never
        # fire, and a run the viewer got nothing from was filed as half-success.
        #
        # Measured in this deployment: runs #4, #36, #39 and #46 each lost their
        # answering node — to a 401, to two timeouts, to a 400 — and all four are
        # stored `partial`. The flow's own success statistics counted them as
        # partly working. "Partial" has to mean the viewer got something.
        status = "failed"
        # Say WHICH way it failed. "Chưa tạo được câu trả lời" was true of a run
        # that timed out, one that hit its call ceiling, and one whose model
        # rejected the key — three different things for whoever is meant to fix
        # it, and the run already knows which happened. A viewer reading a
        # generic sentence retries the same question and gets the same sentence.
        #
        # It read ONLY the budget notice, so every other cause fell through to the
        # generic sentence the comment above exists to prevent. Across this
        # deployment's history that is 21 error steps over five distinct causes —
        # 401, model timeout, HTTP 400, no readable chart, 429 — none of which
        # ever reached the person reading the answer. The step that actually
        # failed already carries its message; use it.
        reason = next(
            (n.text for n in state.notices if n.code == "budget_exhausted"), ""
        )
        if not reason:
            failed_steps = [s for s in state.trace if s.status == "error" and s.error]
            if failed_steps:
                last = failed_steps[-1]
                reason = f"bước “{last.name or last.key}” lỗi — {last.error}"
        answer = text_answer(
            f"Chưa trả lời được: {reason}." if reason
            else "Chưa tạo được câu trả lời cho câu hỏi này."
        )
    if any(s.status == "error" for s in state.trace) and status == "ok":
        status = "partial"
    if status == "ok" and any(n.code in DEGRADING_NOTICES for n in state.notices):
        # EVERY STEP RAN FINE AND THE FLOW STILL DID NOT RUN AS DESIGNED.
        #
        # A branching node that matched nothing executes cleanly — there is no
        # error to find in the trace — so the existing "any step errored" rule
        # cannot see it, and the run was filed `ok`. An operator reading the flow's
        # success rate then counts a question whose whole analysis lane was skipped
        # as a working answer. "ok" has to mean the designed path ran.
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

    # THE OTHER HALF OF THE SAME CHECK.
    #
    # `_verify_figures` asks whether the answer's NUMBERS came from somewhere. This
    # asks whether its SOURCE REFERENCES do. The retriever hands the model numbered
    # passages and an instruction to cite them; a `[7]` when six were given is not a
    # typo, it is a reference nobody can follow — the exact failure citations were
    # added to prevent. A wrong number is caught above; an uncheckable source was
    # not caught at all.
    _verify_answer_citations(state, answer)

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
        #
        # BUT AN EMPTY ROW IS ITS OWN LIE. This wrote key/type/name/status and
        # nothing else, so the first node of every follow-up turn appeared in the
        # inspector as a step that did nothing — no input, no output, no reason —
        # which reads exactly like a node being skipped in silence. It is not
        # skipped: it HAS a value, the one it is reusing, and the reason it did
        # not re-run is knowable. Both are recorded now, because "reused" is only
        # trustworthy if you can see what was reused.
        state.record(
            TraceStep(
                key=node.key, type=node.type, name=label, status="reused", ms=0,
                # The REASON, then the same variable snapshot every other step
                # gets. A reused step is still a step somebody debugs, and
                # answering "why did it not run" while withholding "what did it
                # have" only moves the blind spot — the value it inherited is
                # exactly what the next step will be working from.
                input_preview=_vars_preview(
                    state,
                    note=(
                        f"Dùng lại kết quả lượt trước: bước này đặt run_policy="
                        f"'{node.run_policy}', và dữ liệu vào chưa đổi nên không "
                        f"chạy lại. Giá trị kế thừa nằm ở "
                        f"{{{{{node.output_var}}}}} và ở tab OUTPUT."
                    ),
                ),
                output_preview=_preview(reused),
            )
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
    # A CONTAINER MAKES NO TOOL CALLS OF ITS OWN.
    #
    # The window `tool_log[tools_before:]` is everything that happened WHILE this
    # node ran, which for a branching node is everything its children did. So the
    # inspector listed the same calls twice — once under the specialist that made
    # them and again under the coordinator that contains it:
    #
    #     CG doanh thu   | agent      | [get_chart_data, get_chart_data, get_chart_data]
    #     CG đánh giá    | agent      | [get_chart_data, get_chart_data]
    #     Điều phối      | coordinate | [get_chart_data × 5]
    #
    # A reader counting tool calls off that screen gets ten. The children own them.
    is_container = getattr(node, "type", "") in ROUTING_NODE_TYPES
    # WHAT THIS STEP CAN SEE, captured BEFORE it runs. Taken here rather than
    # after, because a node publishes into the same `vars` it reads from — read
    # it afterwards and you get the output mixed into the input.
    input_before = _vars_preview(state)
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
            elif isinstance(node, CoordinateNode):
                async for ev in _run_coordinate(node, state, rctx):
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
                    # A step that spent tokens before it stopped still spent them.
                    prompt_tokens=state.prompt_tokens - tokens_before[0],
                    completion_tokens=state.completion_tokens - tokens_before[1],
                    tool_calls=[] if is_container else state.tool_log[tools_before:],
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
                    # THE COST OF THE STEP THAT ATE THE BUDGET.
                    #
                    # The comment above says the node that consumed the budget is
                    # the single most useful fact about such a run — and then this
                    # row reported it as costing nothing, because the token deltas
                    # were only set on the success path. Measured on a 13-node
                    # harness: a turn spent 9,737 prompt tokens and only 7,227 of
                    # them landed on any step, the missing 2,510 belonging to the
                    # one step that failed. Reading the trace, the expensive step
                    # looked free.
                    prompt_tokens=state.prompt_tokens - tokens_before[0],
                    completion_tokens=state.completion_tokens - tokens_before[1],
                    tool_calls=[] if is_container else state.tool_log[tools_before:],
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
                tool_calls=[] if is_container else state.tool_log[tools_before:],
                # Same reasoning as the budget path above, and it matters more here:
                # `retry` means a failing step can pay for the same work several
                # times over, and a row reading 0 tokens for three attempts hides
                # exactly the configuration an author would want to reconsider.
                prompt_tokens=state.prompt_tokens - tokens_before[0],
                completion_tokens=state.completion_tokens - tokens_before[1],
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
    # A handler that declined its work is not a handler that did it. Read from the
    # state the handler wrote rather than inferred from its output shape.
    declined = state.skipped.pop(node.key, "")
    state.record(
        TraceStep(
            key=node.key, type=node.type, name=label,
            status="skipped" if declined else "ok", ms=ms,
            tool_calls=[] if is_container else state.tool_log[tools_before:],
            input_preview=input_before,
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
    if getattr(node, "type", "") in ROUTING_NODE_TYPES:
        # A ROUTING NODE MUST NOT CLOBBER `previous`.
        #
        # `previous` is what the next step is shown as "the result of the previous
        # step", and a branch's result is a record of which way the run went. A
        # Switch wrapping the only step that fetched anything therefore handed the
        # step after it `{"matched": ["case_b"], "value": "..."}` in place of the
        # data — the finding was computed inside the branch and then buried by the
        # branch's own bookkeeping. Observed on a coordinator whose plan chose
        # nobody: the answering step was shown `{"picked": [], "considered":
        # ["chuyen_gia_doanh_thu", ...]}`, a list of internal keys and nothing else.
        #
        # `{{outputs.<key>}}` still reaches it, which is the deliberate way to ask
        # which branch ran.
        return
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
        # NOTHING RAN, AND UNTIL NOW NOTHING SAID SO.
        #
        # `_run_loop` already reports an empty iteration for exactly this reason —
        # "a run that looked complete with a body that never executed" — and the two
        # branching nodes were left out of that lesson. An IF whose conditions all
        # missed with no fallback drew lanes on the canvas and drove down none of
        # them, while the trace showed the step green.
        state.outputs[node.key] = {"matched": None}
        state.notices.append(
            Notice(
                code="branch_unmatched",
                text=f"Bước “{node.name or node.key}” không nhánh nào khớp và cũng "
                     "không có nhánh dự phòng, nên phần việc trong các nhánh đã bị bỏ qua.",
            )
        )
        return

    label = chosen.name or chosen.key
    state.outputs[node.key] = {"matched": chosen.key, "label": label}
    yield AgentEvent(
        type="branch_taken",
        extra={"step": node.key, "path": chosen.key, "label": label},
    )
    with state.in_branch(label):
        try:
            async for ev in _run_body(chosen.body, state, rctx):
                yield ev
        except BranchStopped:
            # The filter stopped THIS lane. Siblings after the IF still run.
            pass


#: The planner's way of saying "none of these". A real choice rather than an empty
#: answer, because `choice` refuses an empty answer and should.
_NO_SPECIALIST = "khong_ai"

#: Where a lane's assignment lives while that lane runs. A run variable rather than
#: a node field because the specialists are ORDINARY nodes — the coordinator must be
#: able to brief a body it did not write, including one an author built before this
#: node type existed.
_BRIEF_VAR = "specialist_brief"


def _specialist_brief(specialist: Any) -> str:
    """What to tell a lane about its own job, in the author's own words.

    Says three things, and each is there because leaving it out changes the answer:
    that OTHER specialists are running (so this one need not cover their ground),
    what this one is for (the author's `when`), and that something downstream will
    combine the parts (so a lane that answers only its slice is not producing a
    half-answer for the viewer).
    """
    return (
        "Bạn là MỘT trong nhiều chuyên gia đang cùng trả lời câu hỏi này.\n"
        f"PHẦN VIỆC CỦA BẠN: {(specialist.when or '').strip()}\n"
        "Chỉ trả lời đúng phần đó. Các phần khác đã có chuyên gia khác lo, và một "
        "bước sau sẽ gộp tất cả lại — nên bạn không cần nhắc tới chúng. Nếu câu "
        "hỏi không có phần nào thuộc về bạn, nói ngắn gọn là không có."
    )


def _picked_specialists(raw: Any, roster: list[Any], ceiling: int) -> list[Any]:
    """The specialists a plan names, in ROSTER order, deduplicated and capped.

    WHY THIS PARSES INSTEAD OF THE RUNTIME ENFORCING A `choice`
    -----------------------------------------------------------
    The planner started as a `choice` step, which is the runtime's own classifier
    and refuses anything outside its list. It refuses one thing too many: a plan is
    a SUBSET, and `choice` can only ever say one word. Measured on the first run,
    "Lợi nhuận tháng này thế nào?" — a question that genuinely needs both the
    revenue and the cost specialist — produced

        model trả lời: "chuyen_gia_doanh_thu chuyen_gia_chi_phi"
        bước phân loại không trả về giá trị hợp lệ

    and the coordinator ran nobody at all. Enumerating combinations as choices
    would be 2^n of them; asking each specialist yes/no would be n model calls,
    which is the cost this node exists to avoid.

    So the constraint moved here, and it is still a constraint in code rather than
    a request in a prompt: the text is SCANNED for the roster's keys and nothing
    else survives. Prose, apologies, invented keys and markdown all reduce to the
    same thing — the set of real specialists the planner actually named. A plan
    that names none is `khong_ai`, which is a legitimate answer and is handled by
    the caller.

    Roster order, not the order the planner listed them: the author arranged the
    specialists on the canvas, and a run that reorders them for no reason is
    harder to read against the design.
    """
    text = raw if isinstance(raw, str) else str((raw or {}).get("choice") or raw or "")
    named = {
        s.key for s in roster
        if re.search(r"(?<![a-z0-9_])%s(?![a-z0-9_])" % re.escape(s.key), text)
    }
    return [s for s in roster if s.key in named][:ceiling]


async def _run_coordinate(
    node: CoordinateNode, state: RunState, rctx: RunContext
) -> AsyncGenerator[AgentEvent, None]:
    """One model call picks the specialists this question needs; they run.

    WHAT THIS REPLACES
    ------------------
    Routing was `If`/`Switch` on conditions written by hand, or a `choice`
    classifier feeding a Switch. Both need the author to enumerate the questions in
    advance, and a viewer's question is the one thing that cannot be enumerated. So
    in practice either every specialist ran on every question, or one hand-written
    branch matched and the rest of the flow sat idle — sub-agents each doing their
    own thing with nothing joining them up.

    HOW THE CHOICE IS MADE, AND WHY IT IS NOT A PROMPT
    ---------------------------------------------------
    The planner is a `choice` agent — the runtime's own classifier, which ENFORCES
    the answer instead of requesting it. That matters here for the same reason it
    mattered there: asked in a prompt to "reply with the keys, comma separated", a
    model answers in prose often enough that "a plan of nothing" and "a question
    nobody could serve" become indistinguishable.

    Each specialist is offered with its `when`, never its key alone. A classifier
    handed bare keys — `tra_so`, `so_sanh`, `bat_thuong` — sent "GMV toàn kỳ là bao
    nhiêu?" down the FORECAST branch and never once fired the lookup case. The
    contract makes `when` required for exactly that reason.

    NOTHING CHOSEN IS AN ANSWER, NOT AN ERROR
    ------------------------------------------
    A question none of the specialists fit is a real outcome, so this runs
    `fallback` when there is one and otherwise publishes an empty plan and says so
    in a notice. The answering step then has something honest to work from. The
    alternative — running everything "just in case" — is what this node exists to
    stop.
    """
    from app.services.agent_flows.contract import AgentNode

    roster = node.specialists
    planner = AgentNode(
        key=f"{node.key}__planner",
        name=f"{node.name or node.key} — chọn chuyên gia",
        prompt=(
            (node.prompt.strip() + "\n\n" if node.prompt.strip() else "")
            + "Chọn (các) chuyên gia cần thiết để trả lời câu hỏi của người xem.\n\n"
            + "\n".join(f"- {s.key}: {s.when}" for s in roster)
            + f"\n\nTrả lời bằng CÁC KEY ở trên, cách nhau bởi dấu cách, tối đa "
            f"{node.max_specialists}. Chỉ chọn người thực sự cần — mỗi chuyên gia "
            f"thừa là một lượt gọi mô hình cho câu hỏi này. Nếu không ai phù hợp, "
            f"trả lời '{_NO_SPECIALIST}'. Không giải thích gì thêm."
        ),
        provider=node.provider,
        model=node.model,
        api_key_enc=node.api_key_enc,
        context_policy="question",
    )

    yield AgentEvent(type="status", text="Đang chọn chuyên gia…")
    # THE ROUTER DOES NOT NEED THE DATA. IT NEEDS THE QUESTION.
    #
    # Every agent node is handed `previous` — the last step's whole result. Ahead of
    # a coordinator that is usually a `report_read`, and on a real 70-chart report
    # that is tens of kilobytes of chart dumps. The planner was reading all of it to
    # answer "which of these two specialists?".
    #
    # Measured on one run before this: the planning call alone took 8,216ms, on a
    # question whose entire routing input is the roster's `when` lines. The run then
    # ran out of time in the specialist and never reached the step that writes the
    # answer.
    #
    # Set aside for the planner only, and restored immediately — the specialists
    # that follow still get everything the step before the coordinator produced.
    carried = state.vars.get("previous")
    state.set_var("previous", "")
    try:
        async for ev in _run_node(planner, state, rctx):
            # The planner's own text is working-out, never the answer.
            if ev.type != "text":
                yield ev
    finally:
        state.set_var("previous", carried)

    plan = state.outputs.get(planner.key)
    # READ, THEN TAKE IT OUT OF THE OUTPUTS.
    #
    # The answering step is handed every step's result, and the planner's result is
    # the string "chi_phi doanh_thu" — a routing decision, not a finding. Leaving it
    # in the gather puts a list of internal keys in front of the model that writes
    # the answer. The TRACE keeps it, which is where an author looks to see why a
    # specialist did or did not run.
    state.outputs.pop(planner.key, None)

    picked = _picked_specialists(plan, roster, node.max_specialists)
    state.outputs[node.key] = {
        "picked": [s.key for s in picked],
        "considered": [s.key for s in roster],
    }
    yield AgentEvent(
        type="branch_taken",
        extra={"step": node.key,
               "path": ", ".join(s.key for s in picked) or _NO_SPECIALIST},
    )

    if not picked:
        state.notices.append(
            Notice(
                code="no_specialist_picked",
                text=f"Bước “{node.name or node.key}” không chọn được chuyên gia nào "
                     "phù hợp với câu hỏi này.",
            )
        )
        if node.fallback:
            with state.in_branch(_NO_SPECIALIST):
                try:
                    async for ev in _run_body(node.fallback, state, rctx):
                        yield ev
                except BranchStopped:
                    pass
        return

    for specialist in picked:
        # LANES ARE SIBLINGS, NOT A CHAIN.
        #
        # Each specialist starts from what the coordinator was handed. Without
        # this the second one is shown the FIRST one's answer as "the result of
        # the previous step", because `_publish` moves `previous` on after every
        # node — and a specialist reads that before it reads anything else.
        #
        # Observed on a two-lane run. The revenue specialist failed to fetch and
        # wrote "Hiện tại, tôi không thể lấy được số liệu thực tế về doanh thu và
        # điểm đánh giá…". The review specialist, which had its own tools and its
        # own question, opened with the same sentence: it was answering the lane
        # beside it rather than the report. A fan-out whose branches contaminate
        # each other is a chain wearing a fan-out's shape, and the whole reason
        # for choosing specialists is that they are independent.
        state.set_var("previous", carried)
        # AND TELL IT WHAT ITS JOB IS ON THIS QUESTION.
        #
        # Without this, every lane is handed the whole question and the whole
        # report and does the whole job. Measured on "Doanh thu và điểm đánh giá
        # của khách đang thế nào?": the revenue specialist answered revenue AND
        # review, and the review specialist answered revenue AND review — two
        # model calls, two sets of tool calls, one answer's worth of content.
        #
        # `when` already says what this specialist is for; it was only ever shown
        # to the planner. Shown to the specialist too, it becomes the assignment,
        # which is the half of "coordination" that is not routing.
        state.set_var(_BRIEF_VAR, _specialist_brief(specialist))
        try:
            with state.in_branch(specialist.name or specialist.key):
                try:
                    async for ev in _run_body(specialist.body, state, rctx):
                        yield ev
                except BranchStopped:
                    # Scoped to this specialist. A filter inside one lane must not
                    # cancel the others — being independent lanes is the point.
                    continue
        finally:
            state.set_var(_BRIEF_VAR, "")


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
        state.outputs[node.key] = {"matched": None, "value": value}
        yield AgentEvent(type="branch_taken", extra={"step": node.key, "path": "fallback"})
        with state.in_branch("fallback"):
            try:
                async for ev in _run_body(node.fallback, state, rctx):
                    yield ev
            except BranchStopped:
                pass
        return

    state.outputs[node.key] = {
        "matched": [c.key for c in matched], "value": value,
    }
    if not matched:
        # Same silence as the IF above, with one addition that matters when it is
        # a model choosing the value: SAY WHAT THE VALUE WAS. "No case matched" is
        # not actionable; "no case matched 'Không có dữ liệu…'" tells the author
        # both that their classifier answered in prose and which case list to fix.
        shown = str(value)
        declared_but_empty = node.has_fallback and not node.fallback
        state.notices.append(
            Notice(
                code="branch_unmatched",
                text=(
                    f"Bước “{node.name or node.key}” không có nhánh nào khớp với giá trị "
                    f"“{shown[:80]}”"
                    + (
                        " — nhánh dự phòng đã bật nhưng đang rỗng, nên không có gì chạy."
                        if declared_but_empty
                        else ", nên không có nhánh nào chạy."
                    )
                ),
            )
        )
    for case in matched:
        label = case.label or case.key
        yield AgentEvent(
            type="branch_taken", extra={"step": node.key, "path": case.key, "label": label}
        )
        with state.in_branch(label):
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

    with state.in_branch(f"Loop×{len(items)}"):
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
        # Restricted on purpose. Accepting any string output meant a Set Variable
        # holding "none" became the viewer's answer — a variable is not a sentence,
        # and presenting one as the reply is worse than admitting there is no answer.
        #
        # `flow.writes_prose` rather than `step.type == "agent"`, which was the test
        # here and was one definition of "prose" out of two. A `choice` agent IS an
        # agent and emits a single token from a fixed list, so this fallback could
        # hand a viewer the word "du_bao" as the reply — the same defect the comment
        # above describes, arriving through the door the comment left open.
        for step in reversed(state.trace):
            if not rctx.flow.writes_prose(step.key):
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


#: Prose that claims a source. Deliberately narrow — it must match a CLAIM OF
#: PROVENANCE and not ordinary analysis. "theo báo cáo" is absent on purpose: the
#: report IS what the run reads, so attributing to it is usually true.
_ATTRIBUTION_RE = re.compile(
    r"(?:theo\s+tài\s+liệu"
    r"|theo\s+quy\s+ước\s+(?:tại|trong)"
    r"|\(\s*ngu[ồo]n\s*[:\d]"
    r"|ngu[ồo]n\s*:\s*\S"
    r"|\baccording to\s+(?:the\s+)?(?:document|source)"
    r"|\bsource\s*:\s*\S)",
    re.IGNORECASE,
)


def _flag_unsupported_attribution(state: RunState, answer: Answer) -> None:
    """The answer claims a source and the run consulted none.

    "CONSULTED NONE" IS NARROWER THAN "COLLECTED NO CITATIONS".
    -----------------------------------------------------------
    The first version of this fired on `not state.citations`, and immediately
    produced a false positive worth keeping in mind. Granted
    `describe_semantic_model`, the same GMV question answered correctly —
    "GMV = Doanh thu + Phí vận chuyển", which is exactly what the semantic layer
    records — and signed it "Nguồn: Báo cáo nội bộ". That attribution is TRUE. It
    collected no document citations because the semantic layer is not a document,
    and warning about it would teach an author to distrust a right answer.

    So the test is whether any tool that can return a DEFINITION actually ran.
    `inspect_filters` does not count: a run that inspected the filter state and
    then cited document 26 has still cited something it never opened.

    Only when nothing was consulted. Once real sources are in hand,
    `verify_citations` above is the sharper instrument and firing here too would
    report the same sentence twice.
    """
    from app.services.agent_flows.coverage import READERS_BY_SOURCE

    if state.citations:
        return
    knowledge_tools = {t for tools in READERS_BY_SOURCE.values() for t in tools}
    if any(set(step.tool_calls) & knowledge_tools for step in state.trace):
        return
    text = answer.plain_text()
    if not _ATTRIBUTION_RE.search(text or ""):
        return
    logger.warning(
        "[flow] answer attributes to a source but the run read none: %r",
        (text or "")[:160],
    )
    state.notices.append(
        Notice(
            code="citations_unsupported",
            text="Câu trả lời có dẫn nguồn nhưng bước này chưa đọc được nguồn nào "
                 "— nội dung đó không tra được, hãy tự đối chiếu trước khi dùng.",
        )
    )


def _verify_answer_citations(state: RunState, answer: Answer) -> dict | None:
    """Check every `[n]` in the answer against the sources the run actually read.

    WHY IT REWRITES THE ANSWER INSTEAD OF ONLY WARNING
    -------------------------------------------------
    A notice is the right response to a figure that does not match: the number is
    still the model's claim and the reader can weigh it. An invented citation is
    different — the marker itself asserts "this came from source 7", and leaving it
    in place while adding a footnote elsewhere means the sentence keeps making a
    false claim about its own provenance. So the marker goes, and the notice says
    why. Nothing else about the sentence is touched: removing the model's WORDS
    over a citation defect would be editing the answer, which is not this
    function's business.

    A citation-free answer is NOT an error. Not every sentence needs a source, and
    demanding one produces decorative citations, which are worse than none.
    """
    from app.services.dashboard_ai_bot.govern_doc_context import verify_citations

    allowed = sorted({
        int(n) for c in state.citations if c.kind == "document"
        for n in c.used if str(n).isdigit()
    })
    if not allowed:
        # NO SOURCES READ IS WHERE AN INVENTED ONE DOES THE MOST DAMAGE.
        #
        # This returned early, so the one case with nothing to check against was
        # the one case never checked. Both observed fabrications landed here.
        # Attaching document 26 to a step granted no reading tool produced:
        #
        #     "Theo tài liệu 26 — Quy ước tính GMV và phí vận chuyển của Olist,
        #      GMV không bao gồm phí vận chuyển."          (0 sources read)
        #
        # and once the prompt stopped inviting that, the same question produced:
        #
        #     "... (Nguồn: Investopedia) ... (Nguồn: Harvard Business Review)"
        #                                                  (0 tool calls)
        #
        # Neither carries an `[n]` marker, so neither was ever a citation as far
        # as this function was concerned — while both read to a viewer as one.
        # The markers are not stripped here: there are none to strip, and cutting
        # the model's own words over provenance is not this function's business.
        # Saying plainly that nothing backs them is.
        _flag_unsupported_attribution(state, answer)
        return None
    sources = [{"n": n} for n in allowed]
    text_seen = answer.plain_text()
    result = verify_citations(text_seen, sources)
    if result["ok"]:
        return result

    invented = result["invented"]
    logger.warning(
        "[flow] answer cites %s but only %s were provided", invented, allowed,
    )
    _strip_invented_markers(answer, invented)
    state.notices.append(
        Notice(
            code="citations_invented",
            text="Câu trả lời dẫn nguồn [%s] không có trong danh sách trích dẫn — "
                 "các dấu dẫn nguồn đó đã được bỏ, nội dung câu giữ nguyên để bạn "
                 "tự đối chiếu." % ", ".join(str(n) for n in invented),
        )
    )
    return result


def _strip_invented_markers(answer: Answer, invented: list[int]) -> None:
    """Remove exactly the bracketed numbers that point nowhere.

    Bounded to `[n]` with the specific numbers found: a blanket strip of every
    bracketed digit would also delete `[1]` when it was correct, and delete
    legitimate brackets from a quoted formula.
    """
    import re

    if not invented:
        return
    pattern = re.compile(r"\s?\[(?:%s)\]" % "|".join(str(n) for n in invented))
    # Both fields `plain_text()` reads. A callout is prose the viewer reads exactly
    # like a paragraph, so cleaning only `markdown` would leave the false marker
    # standing in the one block designed to draw the eye.
    for block in answer.blocks:
        for field in ("markdown", "text"):
            value = getattr(block, field, None)
            if not isinstance(value, str) or not value:
                continue
            cleaned = pattern.sub("", value)
            if cleaned == value:
                continue
            try:
                setattr(block, field, cleaned)
            except Exception:  # noqa: BLE001 — a frozen block keeps its text
                logger.debug("[flow] could not rewrite a block's %s", field)


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


def _has_visible_answer(answer: Any) -> bool:
    """Did the viewer actually get something to read?

    A block carrying only whitespace is not an answer, and counting it as one is
    how a blank reply becomes a success statistic. Any non-text block (a table, a
    chart) counts on sight — its content is not in `markdown`.
    """
    for block in getattr(answer, "blocks", None) or []:
        if getattr(block, "type", "") != "text":
            return True
        if str(getattr(block, "markdown", "") or "").strip():
            return True
    return False


def _answer_is_fallback(state: RunState, rctx: RunContext) -> bool:
    """True when the viewer is about to be shown something other than the answer."""
    if state.stopped and state.stop_message:
        return False  # a Stop node's message IS a deliberate answer
    return state.outputs.get(rctx.answer_key) is None


#: Structural caps applied BEFORE serialising, never after.
#:
#: Cutting a JSON string at N characters produces something that is no longer
#: JSON, so the reader gets a wall of broken syntax instead of a table. Trimming
#: the VALUE instead — shorter strings, fewer rows, shallower nesting — keeps the
#: result valid, which is what lets the panel render it as fields and tables and
#: lets "download JSON" hand over a file that actually parses.
_STR_CHARS = 600      # one text value
_LIST_ITEMS = 25      # rows kept from a list
_MAX_DEPTH = 6
#: Per-variable and per-output caps in an input snapshot.
_INPUT_VAR_CHARS = 600
_INPUT_MAX_VARS = 12


def _trim(value: Any, depth: int = 0) -> Any:
    """A smaller value of the SAME SHAPE, with every cut declared in the data.

    Trimming silently would be worse than not trimming: somebody would read 25
    rows, conclude the step saw 25 rows, and debug the wrong thing. Every place
    something was dropped leaves a marker saying how much.
    """
    if isinstance(value, str):
        return (value[:_STR_CHARS] + f"… (+{len(value) - _STR_CHARS} ký tự)"
                if len(value) > _STR_CHARS else value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if depth >= _MAX_DEPTH:
        return "… (lồng quá sâu, đã cắt)"
    if isinstance(value, dict):
        return {str(k): _trim(v, depth + 1) for k, v in list(value.items())[:40]}
    if isinstance(value, (list, tuple)):
        items = [_trim(v, depth + 1) for v in list(value)[:_LIST_ITEMS]]
        if len(value) > _LIST_ITEMS:
            items.append(f"… (+{len(value) - _LIST_ITEMS} mục nữa)")
        return items
    return _trim(str(value), depth)


def _as_json(value: Any) -> str:
    """JSON, not `repr`. The panel parses this to render fields and tables.

    `repr` was unreadable twice over: `{'a': 1}` is not JSON so nothing could
    parse it into a table, and the reader — who may not write code — was handed
    Python syntax to interpret. JSON costs the same to store and is the only
    form both a person and the screen can read.
    """
    try:
        return json.dumps(_trim(value), ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 — a preview must never break a run
        return json.dumps(str(value)[:_STR_CHARS], ensure_ascii=False)


def _preview(value: Any) -> str:
    if value is None:
        return ""
    # A plain string is left as a string — an agent's answer is prose, and
    # quoting it as JSON would only put quotes around something already readable.
    if isinstance(value, str):
        return value[:_STR_CHARS]
    return _as_json(value)


def _vars_preview(state: RunState, note: str = "") -> str:
    """Everything a step could read, as a JSON snapshot.

    READS BOTH DICTIONARIES. A node's result always lands in
    `state.outputs[key]`; it lands in `state.vars` ONLY when the node was given
    an `output_var`. Reading `vars` alone therefore showed nothing for any flow
    whose steps are wired through `{{outputs.step_key}}` — the panel said "this
    step read no variables" about a step that was handed everything. Worth being
    precise about, because the wrong reading here does not look like a broken
    panel: it looks like a broken FLOW, and it would send somebody rewiring
    something that already worked.

    STRUCTURED, NOT `name = <repr>` LINES. The panel renders each variable as a
    labelled field — and a rows-and-columns value as an actual table — which it
    can only do if the shape survives to the screen. The previous line format had
    flattened everything to Python syntax, so the one screen a non-programmer
    opens to ask "what did this step see" answered in a language they do not read.

    `note` carries the human sentence (why a step was reused, for instance) so
    adding an explanation no longer costs the machine-readability of the rest.
    """
    try:
        payload: dict[str, Any] = {}
        if note:
            payload["note"] = note
        # Named variables — what a prompt writes as {{name}}.
        payload["vars"] = {
            name: _trim(value)
            for name, value in list((state.vars or {}).items())[:_INPUT_MAX_VARS]
        }
        # Earlier steps' results, which a prompt reads as {{outputs.key}}. Keyed
        # with that exact spelling so what is shown is what an author would type.
        payload["outputs"] = {
            f"outputs.{key}": _trim(value)
            for key, value in list((state.outputs or {}).items())[:_INPUT_MAX_VARS]
        }
        if not payload["vars"] and not payload["outputs"] and not note:
            return ""
        return json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 — a preview must never break a run
        return ""
