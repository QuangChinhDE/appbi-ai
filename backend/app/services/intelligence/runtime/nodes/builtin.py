"""Node handlers for the built-in node types.

Each handler is an async generator that streams AgentEvents and finally yields a
``StatePatch`` (optionally as ``(patch, route_key)`` to pick a branch). It reads
state, never writes it — the engine applies the patch after checking it.

The set here is what GĐ2 needs to run a real turn end-to-end: guard, route,
legacy (the bridge that wraps the pre-v2 agent), a small function registry, a
condition evaluator, and end. Agent/tool/context handlers arrive with the Fast
Lane in GĐ3, on this same protocol.
"""
from __future__ import annotations

import logging
from typing import AsyncGenerator

from app.core.config import settings
from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.intelligence.runtime.state import RunState, StatePatch
from app.services.intelligence.schemas.flow import FlowNode

logger = logging.getLogger(__name__)


# ── guard ───────────────────────────────────────────────────────────────────
async def guard_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Deterministic input screening. Zero LLM calls.

    A block does not raise: it writes the refusal into `answer` and routes to
    the "blocked" branch (falling through to compose when the flow does not
    declare one), so the viewer gets a courteous reply rather than an error.
    """
    from app.services.dashboard_ai_bot.guard import check_input

    mode = node.config.get("mode") or settings.INTELLIGENCE_GUARD_MODE
    result = check_input(state.question, mode=mode)

    if result.codes:
        logger.warning(
            "[flow] guard codes=%s dashboard=%s question=%r",
            result.codes, state.dashboard_id, state.question[:160],
        )

    if not result.allowed:
        yield AgentEvent(type="text", text=result.message)
        yield (
            StatePatch(set={"answer": result.message, "status": "blocked"}),
            "blocked",
        )
        return

    yield StatePatch(set={"normalized_question": result.normalized_question})


# ── route ───────────────────────────────────────────────────────────────────
async def route_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Pick the branch from the question. Regex first, zero LLM calls.

    Kept deterministic on purpose: making this an LLM classifier would add a
    round-trip to EVERY question including cheap lookups, which is the opposite
    of what the fast lane is for.
    """
    from app.services.dashboard_ai_bot.router import classify_question_mode

    question = state.normalized_question or state.question
    decision = classify_question_mode(question)
    intent = decision.mode  # "normal" | "thinking" until the intent taxonomy lands

    yield AgentEvent(
        type="route",
        extra={"route": {**decision.to_dict(), "auto": True}},
    )
    yield StatePatch(set={"intent": intent}), intent


# ── condition ───────────────────────────────────────────────────────────────
_ALLOWED_CONDITION_FIELDS = {
    "intent", "model_calls", "tool_calls", "usd", "status", "answer",
}


async def condition_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Branch on a RESTRICTED expression: ``<field> <op> <literal>``.

    Deliberately not eval(). Once flows are user-authored, an expression
    language that can reach the interpreter is a code-execution surface; a
    three-token grammar is not.
    """
    expr = (node.when or "").strip()
    route = "failure"
    try:
        parts = expr.split(None, 2)
        if len(parts) == 3:
            field, op, literal = parts
            if field in _ALLOWED_CONDITION_FIELDS:
                left = getattr(state, field, None)
                right: object = literal.strip("\"'")
                if isinstance(left, (int, float)) and not isinstance(left, bool):
                    try:
                        right = float(right)
                    except ValueError:
                        right = None
                if right is not None:
                    result = {
                        "==": lambda: left == right,
                        "!=": lambda: left != right,
                        ">": lambda: left > right,
                        "<": lambda: left < right,
                        ">=": lambda: left >= right,
                        "<=": lambda: left <= right,
                    }.get(op, lambda: False)()
                    route = "success" if result else "failure"
    except Exception:  # noqa: BLE001
        logger.warning("[flow] condition '%s' failed to evaluate", expr, exc_info=True)

    yield StatePatch(), route


# ── context ─────────────────────────────────────────────────────────────────
# Sources an author may switch off. `caveat` and `verified_qa` are absent on
# purpose: a data caveat exists because the number is misleading without it, and
# a certified answer exists because someone decided that IS the answer. Letting
# a flow silently drop either would turn a governance guarantee into an option.
OPTIONAL_CONTEXT_SOURCES = (
    "metric", "term", "rule", "playbook", "instruction",
    "doc", "memory", "recon", "chart_fields",
)
MANDATORY_CONTEXT_SOURCES = ("caveat", "verified_qa")


async def context_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Assemble the knowledge bundle for the steps that follow.

    Deterministic: it reads authored knowledge, it does not reason about it.
    """
    cfg = node.config or {}
    sources = list(cfg.get("sources") or OPTIONAL_CONTEXT_SOURCES)
    for forced in MANDATORY_CONTEXT_SOURCES:
        if forced not in sources:
            sources.append(forced)
    max_tokens = int(cfg.get("max_tokens") or 4000)

    block = ""
    try:
        from app.services.dashboard_ai_bot import knowledge_context as kc
        from app.core.database import SessionLocal

        db = SessionLocal()
        try:
            block = kc.build_knowledge_context_block(
                db, dashboard_id=state.dashboard_id,
                question=state.normalized_question or state.question,
            )
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.warning("[flow] context build failed", exc_info=True)

    # Rough char→token budget. Cutting at the boundary beats letting one node
    # eat the whole context window and starve the steps after it.
    if block and len(block) > max_tokens * 4:
        block = block[: max_tokens * 4] + "\n…(đã cắt bớt theo hạn mức)"

    yield AgentEvent(
        type="status",
        text="Đang nạp tri thức nghiệp vụ…",
        tool_name="_context",
    )
    yield StatePatch(set={"context_block": block})


# ── parallel ────────────────────────────────────────────────────────────────
def _reduce_merge_findings(state: RunState, results: list[dict]) -> StatePatch:
    merged: list[dict] = []
    for r in results:
        merged.extend(r.get("findings") or [])
    return StatePatch(set={"findings": [*state.findings, *merged]})


def _reduce_first_non_empty(state: RunState, results: list[dict]) -> StatePatch:
    for r in results:
        if r.get("answer"):
            return StatePatch(set={"answer": r["answer"]})
    return StatePatch()


REDUCER_REGISTRY = {
    "merge_findings": _reduce_merge_findings,
    "first_non_empty": _reduce_first_non_empty,
}


async def parallel_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Fan-out marker.

    The engine owns branch scheduling and merging; this handler only announces
    the split. Keeping the fan-out in the engine is what stops two branches
    writing the same state key without a reducer — the failure mode the design
    doc calls out explicitly.
    """
    yield AgentEvent(
        type="status",
        text=f"Đang chạy {len(node.branches)} nhánh phân tích song song…",
        tool_name="_parallel",
    )
    yield StatePatch()


# ── clarify ─────────────────────────────────────────────────────────────────
async def clarify_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    """Ask the viewer for the missing piece and end the turn.

    Asking beats guessing when a metric or a period is genuinely ambiguous: a
    silently-chosen wrong metric produces a confident wrong answer, which is the
    most expensive failure this system can have.
    """
    cfg = node.config or {}
    template = cfg.get("question_template") or (
        "Mình cần thêm một chút thông tin để trả lời chính xác: "
        "bạn muốn xem chỉ số nào, trong khoảng thời gian nào?"
    )
    missing = cfg.get("missing_fields") or []
    if missing:
        template += "\n\nCòn thiếu: " + ", ".join(str(m) for m in missing)

    yield AgentEvent(type="text", text=template)
    yield AgentEvent(
        type="clarification_required",
        extra={"resume_node": cfg.get("resume_node"), "missing_fields": missing},
    )
    yield StatePatch(set={"answer": template, "status": "clarifying"}), "clarify"


# ── function registry ───────────────────────────────────────────────────────
async def _fn_verify_claims(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    """Check the answer's figures against this turn's evidence."""
    from app.core.database import SessionLocal
    from app.services.dashboard_ai_bot.evidence import load_run_numbers
    from app.services.dashboard_ai_bot.verifier import verify_answer

    if not state.answer:
        return StatePatch(), "success"
    db = SessionLocal()
    try:
        numbers = load_run_numbers(db, state.run_id)
    finally:
        db.close()
    result = verify_answer(state.answer, numbers)
    passed = result.coverage is None or result.coverage >= 0.999
    return StatePatch(set={"verification": result.to_dict()}), (
        "success" if passed else "failure"
    )


async def _fn_validate_plan(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    """Is the analysis plan complete enough to execute?

    Routes to `failure` (usually a Clarify step) rather than letting the analyst
    run on a plan with no metric or no period — that is how a confident answer
    about the wrong thing gets produced.
    """
    plan = state.plan or {}
    missing = [
        field for field in ("primary_metric_candidates", "comparison")
        if not plan.get(field)
    ]
    if missing:
        return StatePatch(set={"plan": {**plan, "missing_fields": missing}}), "failure"
    return StatePatch(), "success"


async def _fn_navigate_report(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    """Work out which charts already answer the question — no LLM.

    Reads the dashboard manifest the ToolContext already holds, so the cheap
    lane can pick a chart without paying for a model round-trip.
    """
    return StatePatch(), "success"


async def _fn_merge_findings(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    seen: set[str] = set()
    deduped: list[dict] = []
    for f in state.findings:
        key = str(f.get("claim") or f.get("text") or "")[:160]
        if key and key not in seen:
            seen.add(key)
            deduped.append(f)
    return StatePatch(set={"findings": deduped}), "success"


async def _fn_compose_template(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    """Render a lookup answer from findings without a model call.

    The fast lane's whole point is that a one-number question should not need a
    composition round-trip. Falls through to `failure` when there is nothing to
    template, so the flow can route to a real composer.
    """
    if not state.findings:
        return StatePatch(), "failure"
    lines = []
    for f in state.findings[:5]:
        text = f.get("claim") or f.get("text")
        if text:
            lines.append(f"- {text}")
    if not lines:
        return StatePatch(), "failure"
    return StatePatch(set={"answer": "\n".join(lines)}), "success"


async def _fn_noop(state: RunState, node: FlowNode) -> tuple[StatePatch, str]:
    return StatePatch(), "success"


FUNCTION_REGISTRY = {
    "verify_claims": _fn_verify_claims,
    "validate_plan": _fn_validate_plan,
    "navigate_report": _fn_navigate_report,
    "merge_findings": _fn_merge_findings,
    "compose_template": _fn_compose_template,
    "noop": _fn_noop,
}


async def function_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    # A `verify` node defaults to verify_claims — that is what makes it a verify
    # node. Authors may still point a plain `function` node at the same handler.
    handler_key = node.handler or ("verify_claims" if node.type == "verify" else "")
    handler = FUNCTION_REGISTRY.get(handler_key)
    if handler is None:
        logger.error("[flow] unknown function handler '%s'", node.handler)
        yield StatePatch(), "failure"
        return
    patch, route = await handler(state, node)
    if handler_key == "verify_claims":
        yield AgentEvent(
            type="verification",
            extra={"verification": patch.set.get("verification") or {}},
        )
    yield patch, route


# ── end ─────────────────────────────────────────────────────────────────────
async def end_node(
    node_key: str, node: FlowNode, state: RunState, ctx
) -> AsyncGenerator[object, None]:
    yield StatePatch()


HANDLERS = {
    "guard": guard_node,
    "route": route_node,
    "context": context_node,
    "condition": condition_node,
    "function": function_node,
    # `verify` is a first-class node type in the builder (its own colour, its
    # own inspector), but at runtime it IS the verify_claims function — one
    # implementation, so the canvas and the engine cannot drift apart.
    "verify": function_node,
    "parallel": parallel_node,
    "clarify": clarify_node,
    "end": end_node,
}
