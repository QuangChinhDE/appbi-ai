"""Runtime entry point: resolve a flow, run it, persist the trace.

`run_turn` is the only function the API layer calls. It keeps the same streaming
contract as the pre-v2 agent, so switching a deployment over is a feature flag
rather than a frontend change.

Failure policy, in order of preference:
  1. run the resolved flow;
  2. if resolution or execution breaks, fall back to the legacy agent and record
     `error_code='flow_fallback'`;
  3. never let the viewer see an empty chat because of a configuration problem.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator

from sqlalchemy.orm import Session

from app.services.dashboard_ai_bot.events import AgentEvent
from app.services.intelligence.registry.resolver import resolve_flow
from app.services.intelligence.runtime.engine import FlowAborted, run_flow
from app.services.intelligence.runtime.nodes.builtin import HANDLERS as _BUILTIN_HANDLERS
from app.services.intelligence.runtime.nodes.legacy import LegacyNodeContext, legacy_node
from app.services.intelligence.runtime.state import RunState

logger = logging.getLogger(__name__)

HANDLERS = {**_BUILTIN_HANDLERS, "legacy": legacy_node}


def _persist_run_start(db_factory, state: RunState, mode: str) -> None:
    try:
        from app.models.ai_intelligence import AiRun

        db = db_factory()
        try:
            db.add(AiRun(
                id=state.run_id,
                assistant_key=state.assistant_key,
                flow_key=state.flow_key,
                flow_version=state.flow_version,
                mode=mode,
                dashboard_id=state.dashboard_id,
                link_token=state.link_token,
                session_key=state.session_key,
                actor_type=state.actor_type,
                actor_ref=state.actor_ref,
                question=(state.question or "")[:2000],
                status="running",
            ))
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.debug("[flow] run-start persist failed", exc_info=True)


def _persist_run_end(db_factory, state: RunState, latency_ms: int, error_code: str | None) -> None:
    try:
        from app.models.ai_intelligence import AiRun

        db = db_factory()
        try:
            row = db.query(AiRun).filter(AiRun.id == state.run_id).first()
            if row is None:
                return
            row.status = state.status
            row.current_node = state.current_node
            row.intent = state.intent
            row.model_calls = state.model_calls
            row.tool_calls = state.tool_calls
            row.usd = state.usd
            row.latency_ms = latency_ms
            row.completed_at = datetime.now(timezone.utc)
            row.error_code = error_code
            if isinstance(state.verification, dict):
                row.verification_coverage = state.verification.get("coverage")
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.debug("[flow] run-end persist failed", exc_info=True)


def _persist_node(db_factory, run_id: str, seq: int, node_key: str, node, latency_ms: float, ok: bool) -> None:
    try:
        from app.models.ai_intelligence import AiNodeRun

        db = db_factory()
        try:
            db.add(AiNodeRun(
                run_id=run_id,
                seq=seq,
                node_key=node_key,
                node_type=node.type,
                agent_key=(node.agent or "").split("@")[0] or None,
                status="ok" if ok else "error",
                latency_ms=int(latency_ms),
                completed_at=datetime.now(timezone.utc),
            ))
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        logger.debug("[flow] node persist failed", exc_info=True)


async def run_turn(
    *,
    db: Session,
    dashboard_id: int,
    link_token: str | None,
    session_key: str | None,
    question: str,
    agent_kwargs: dict,
    actor_type: str = "public_session",
    actor_ref: str | None = None,
    mode: str = "live",
) -> AsyncGenerator[AgentEvent, None]:
    """Run one turn through the flow engine, streaming AgentEvents.

    ``agent_kwargs`` is what the pre-v2 entry point takes; the legacy node
    forwards it untouched, which is why answers stay identical during migration.
    """
    from app.core.database import SessionLocal

    resolved = resolve_flow(
        db, link_token=link_token, dashboard_id=dashboard_id, session_key=session_key,
    )
    if resolved is None:
        logger.info("[flow] no flow resolved — legacy path")
        async for ev in _legacy_passthrough(agent_kwargs):
            yield ev
        return

    limits = resolved.graph.limits.clamped()
    state = RunState(
        run_id=uuid.uuid4().hex,
        flow_key=resolved.flow_key,
        flow_version=resolved.flow_version,
        assistant_key=resolved.assistant_key,
        dashboard_id=dashboard_id,
        link_token=link_token,
        session_key=session_key,
        actor_type=actor_type,
        actor_ref=actor_ref,
        question=question,
        normalized_question=question,
        deadline_at=datetime.now(timezone.utc) + timedelta(seconds=limits.deadline_seconds),
    )
    _persist_run_start(SessionLocal, state, mode)

    ctx = LegacyNodeContext(agent_kwargs)
    started = time.monotonic()
    error_code: str | None = None
    seq = {"n": 0}
    # A turn that streams no text leaves the chat stuck on a thinking bubble
    # forever — worse than an error message. Tracked here rather than inside the
    # engine because only this layer owns the client stream.
    produced_text = False

    async def _on_node_complete(node_key, node, st, latency_ms):
        seq["n"] += 1
        _persist_node(
            SessionLocal, st.run_id, seq["n"], node_key, node, latency_ms,
            ok=not any(e.get("node") == node_key for e in st.errors),
        )

    try:
        async for ev in run_flow(
            graph=resolved.graph,
            state=state,
            handlers=HANDLERS,
            ctx=ctx,
            on_node_complete=_on_node_complete,
        ):
            if ev.type == "text" and ev.text:
                produced_text = True
            yield ev
    except FlowAborted as exc:
        logger.error("[flow] aborted (%s) — falling back to legacy", exc)
        error_code = "flow_fallback"
        async for ev in _legacy_passthrough(agent_kwargs):
            if ev.type == "text" and ev.text:
                produced_text = True
            yield ev
    except Exception:  # noqa: BLE001
        logger.exception("[flow] engine crashed — falling back to legacy")
        error_code = "flow_fallback"
        async for ev in _legacy_passthrough(agent_kwargs):
            if ev.type == "text" and ev.text:
                produced_text = True
            yield ev
    finally:
        # ── Terminal-answer guarantee ──────────────────────────────────────
        # If the graph finished (or died) without ever streaming prose, the
        # viewer is still watching a spinner. Every exit path must end with
        # SOMETHING readable. This is the last line of defence behind
        # ForceCompose and the legacy fallback; reaching it means both missed,
        # so it also logs loudly.
        if not produced_text:
            logger.error(
                "[flow] run %s produced no answer text (flow=%s node=%s errors=%s)",
                state.run_id, state.flow_key, state.current_node, state.errors,
            )
            error_code = error_code or "no_answer"
            yield AgentEvent(
                type="text",
                text=(
                    "Xin lỗi, mình chưa trả lời được câu này. Bạn thử hỏi lại "
                    "theo cách khác, hoặc nêu rõ biểu đồ / chỉ số bạn muốn xem nhé."
                ),
            )
        _persist_run_end(
            SessionLocal, state, int((time.monotonic() - started) * 1000), error_code,
        )

    yield AgentEvent(type="done")


async def run_preview(
    *,
    graph,
    flow_key: str,
    flow_version: int,
    dashboard_id: int,
    link_token: str,
    question: str,
    agent_kwargs: dict,
    actor_ref: str | None,
) -> AsyncGenerator[AgentEvent, None]:
    """Run a DRAFT graph once, for the person building it.

    Differs from `run_turn` in exactly two ways, both deliberate:
      * the graph is passed in rather than resolved, so an unpublished draft can
        be exercised without ever being reachable by a viewer;
      * the run is stamped `mode='preview'` so it stays out of production
        metrics — a builder iterating ten times must not look like a latency
        regression on the dashboard everyone watches.

    It is otherwise the SAME engine, handlers and budgets. A preview that works
    and a published run that doesn't would make the feature worthless.
    """
    from app.core.database import SessionLocal

    limits = graph.limits.clamped()
    state = RunState(
        run_id=uuid.uuid4().hex,
        flow_key=flow_key,
        flow_version=flow_version,
        dashboard_id=dashboard_id,
        link_token=link_token,
        actor_type="user",
        actor_ref=actor_ref,
        question=question,
        normalized_question=question,
        deadline_at=datetime.now(timezone.utc) + timedelta(seconds=limits.deadline_seconds),
    )
    _persist_run_start(SessionLocal, state, "preview")

    ctx = LegacyNodeContext(agent_kwargs)
    started = time.monotonic()
    seq = {"n": 0}
    produced_text = False

    async def _on_node_complete(node_key, node, st, latency_ms):
        seq["n"] += 1
        _persist_node(
            SessionLocal, st.run_id, seq["n"], node_key, node, latency_ms,
            ok=not any(e.get("node") == node_key for e in st.errors),
        )

    error_code: str | None = None
    try:
        async for ev in run_flow(
            graph=graph, state=state, handlers=HANDLERS, ctx=ctx,
            on_node_complete=_on_node_complete,
        ):
            if ev.type == "text" and ev.text:
                produced_text = True
            yield ev
    except Exception as exc:  # noqa: BLE001
        # A preview MUST surface the failure verbatim — the whole point is to
        # show the builder what breaks. No silent fallback to the legacy agent.
        logger.exception("[flow] preview crashed flow=%s", flow_key)
        error_code = "preview_error"
        yield AgentEvent(
            type="error",
            text=f"Luồng lỗi khi chạy: {type(exc).__name__}: {exc}",
        )
    finally:
        if not produced_text and error_code is None:
            error_code = "no_answer"
            yield AgentEvent(
                type="error",
                text="Luồng chạy xong nhưng không sinh ra câu trả lời nào. "
                     "Kiểm tra xem đã có node soạn câu trả lời chưa.",
            )
        _persist_run_end(
            SessionLocal, state, int((time.monotonic() - started) * 1000), error_code,
        )

    yield AgentEvent(
        type="preview_done",
        extra={
            "run_id": state.run_id,
            "nodes": list(state.completed_nodes),
            "errors": list(state.errors),
            "usd": round(state.usd, 6),
            "model_calls": state.model_calls,
            "tool_calls": state.tool_calls,
            "verification": state.verification,
        },
    )
    yield AgentEvent(type="done")


async def _legacy_passthrough(agent_kwargs: dict) -> AsyncGenerator[AgentEvent, None]:
    """The safety net: the pre-v2 agent, unchanged, with its own `done`.

    Copies the kwargs rather than popping from the caller's dict — this can run
    twice (engine crash after a partial attempt) and the second call must see
    the same arguments as the first.
    """
    from app.services.dashboard_ai_bot import run_agent_stream

    kwargs = dict(agent_kwargs)
    mode = kwargs.pop("mode", "auto")
    async for ev in run_agent_stream(mode=mode, **kwargs):
        yield ev
