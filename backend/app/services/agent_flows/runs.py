"""Recording what a flow did, and answering questions about it later.

WHY RECORD AT ALL
-----------------
Three questions nobody could answer before, and all three decide what to build next:

  Which questions does this flow fail on?      → the flow needs another branch
  Which branch has never run in 30 days?       → the branch should be deleted
  Is v6 actually better than v5?               → because runs carry their version

The third is why the input envelope is stored: a recorded run can be re-executed
against a later version, so two versions can be compared on the questions real
viewers actually asked instead of on a test script somebody wrote once.

RETENTION IS PART OF THE DESIGN, NOT AN AFTERTHOUGHT
----------------------------------------------------
Metrics stay. Content (the question, the answer) is personal data and is pruned.
Trace is the biggest and the least durable value, so it is pruned first. Deciding
this now costs one function; discovering it later costs a full disk.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent, AgentFlowRunStep
from app.services.agent_flows.envelope import FlowInput, FlowOutput

logger = logging.getLogger(__name__)

#: Defaults. Content is what a person typed; trace is what the machine did.
CONTENT_RETENTION_DAYS = 180
STEP_RETENTION_DAYS = 30

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\sÀ-ỹ]")


def normalise_question(text: str) -> str:
    """A groupable form, kept AFTER the content row is pruned.

    So "what do people ask this bot" survives retention while the exact wording —
    which may carry a customer name or a figure — does not.
    """
    t = _PUNCT_RE.sub(" ", (text or "").lower())
    return _WS_RE.sub(" ", t).strip()[:500]


def record(
    db: Session,
    *,
    inp: FlowInput,
    out: FlowOutput,
    brain_key: str,
    version: int | None,
    binding_id: int | None,
    store_content: bool = True,
    usd: float | None = None,
) -> int | None:
    """Write one run across the three tables. Never raises into the caller.

    A failure to record must not fail the answer that was already delivered — the
    viewer has their reply, and losing a log row is the cheaper loss.
    """
    try:
        run = AgentFlowRun(
            run_key=inp.request.id,
            brain_key=brain_key,
            version=version,
            binding_id=binding_id,
            link_token=inp.binding.link_token or None,
            dashboard_id=inp.report.dashboard_id,
            session_key=inp.conversation.session_key or None,
            status=out.status,
            execution_path=(out.trace.path or "")[:255],
            trigger=inp.request.trigger,
            is_test=bool(inp.request.is_test),
            latency_ms=out.usage.ms,
            llm_calls=out.usage.llm_calls,
            tool_calls=out.usage.tool_calls,
            prompt_tokens=out.usage.prompt_tokens,
            completion_tokens=out.usage.completion_tokens,
            usd=usd,
            blocked_reason=_blocked_reason(out),
            missing_requirements=(inp.binding.unresolved or None),
            question_norm=normalise_question(inp.question.raw),
        )
        db.add(run)
        db.flush()

        if store_content:
            db.add(
                AgentFlowRunContent(
                    run_id=run.id,
                    question=inp.question.raw,
                    answer=out.answer.plain_text(),
                    citations=[c.model_dump(mode="json") for c in out.citations] or None,
                    notices=[n.model_dump(mode="json") for n in out.notices] or None,
                    input_envelope=inp.model_dump(mode="json"),
                    output_envelope=out.to_dict(),
                )
            )

        for seq, step in enumerate(out.trace.steps):
            db.add(
                AgentFlowRunStep(
                    run_id=run.id,
                    seq=seq,
                    node_key=step.key,
                    node_type=step.type,
                    node_name=step.name[:255] if step.name else None,
                    status=step.status,
                    branch=(step.branch or None),
                    iteration=step.iteration,
                    latency_ms=step.ms,
                    tool_calls=step.tool_calls or None,
                    output_preview=step.output_preview or None,
                    error=step.error or None,
                )
            )
        db.commit()
        return run.id
    except Exception:  # noqa: BLE001
        logger.exception("[flow] could not record run %s", inp.request.id)
        db.rollback()
        return None


def _blocked_reason(out: FlowOutput) -> str | None:
    if out.status not in {"blocked", "failed"}:
        return None
    for n in out.notices:
        if n.code:
            return n.code[:64]
    return out.status


def apply_rating(db: Session, *, session_key: str, answer_text: str, rating: str) -> None:
    """Attach the viewer's thumb to the run that produced that answer.

    Matched on the answer text because the public chat client does not know run ids.
    It rates text the SERVER produced, so — unlike anything else posted from a public
    page — it cannot smuggle in a claim of its own.
    """
    if rating not in {"up", "down"} or not session_key:
        return
    try:
        row = (
            db.query(AgentFlowRun)
            .join(AgentFlowRunContent, AgentFlowRunContent.run_id == AgentFlowRun.id)
            .filter(
                AgentFlowRun.session_key == session_key,
                AgentFlowRunContent.answer == answer_text,
            )
            .order_by(AgentFlowRun.created_at.desc())
            .first()
        )
        if row is not None:
            row.rating = rating
            db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[flow] rating not applied", exc_info=True)
        db.rollback()


# ═══ Reading ══════════════════════════════════════════════════════════════════
def list_runs(
    db: Session,
    *,
    brain_key: str,
    status: str | None = None,
    binding_id: int | None = None,
    since_hours: int = 24,
    search: str = "",
    include_tests: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    q = db.query(AgentFlowRun).filter(AgentFlowRun.brain_key == brain_key)
    if not include_tests:
        # The author's own trials are excluded by default: without this the first
        # week of every flow's numbers is mostly its author.
        q = q.filter(AgentFlowRun.is_test.is_(False))
    if status:
        q = q.filter(AgentFlowRun.status == status)
    if binding_id:
        q = q.filter(AgentFlowRun.binding_id == binding_id)
    if since_hours:
        q = q.filter(
            AgentFlowRun.created_at >= datetime.now(timezone.utc) - timedelta(hours=since_hours)
        )
    if search:
        q = q.filter(AgentFlowRun.question_norm.ilike(f"%{normalise_question(search)}%"))

    total = q.count()
    rows = q.order_by(AgentFlowRun.created_at.desc()).limit(limit).offset(offset).all()
    ids = [r.id for r in rows]
    questions = {
        c.run_id: c.question
        for c in db.query(AgentFlowRunContent).filter(AgentFlowRunContent.run_id.in_(ids or [-1])).all()
    }
    return {
        "total": total,
        "runs": [
            {
                "id": r.id,
                "run_key": r.run_key,
                "at": r.created_at.isoformat() if r.created_at else None,
                "status": r.status,
                "link_token": r.link_token,
                "binding_id": r.binding_id,
                "version": r.version,
                "question": questions.get(r.id) or r.question_norm,
                "execution_path": r.execution_path,
                "latency_ms": r.latency_ms,
                "tokens": (r.prompt_tokens or 0) + (r.completion_tokens or 0),
                "rating": r.rating,
                "is_test": r.is_test,
                "blocked_reason": r.blocked_reason,
            }
            for r in rows
        ],
    }


def run_detail(db: Session, *, brain_key: str, run_id: int) -> dict[str, Any] | None:
    row = (
        db.query(AgentFlowRun)
        .filter(AgentFlowRun.id == run_id, AgentFlowRun.brain_key == brain_key)
        .first()
    )
    if row is None:
        return None
    content = db.query(AgentFlowRunContent).filter(AgentFlowRunContent.run_id == row.id).first()
    steps = (
        db.query(AgentFlowRunStep)
        .filter(AgentFlowRunStep.run_id == row.id)
        .order_by(AgentFlowRunStep.seq)
        .all()
    )
    return {
        "id": row.id,
        "run_key": row.run_key,
        "at": row.created_at.isoformat() if row.created_at else None,
        "status": row.status,
        "version": row.version,
        "link_token": row.link_token,
        "binding_id": row.binding_id,
        "execution_path": row.execution_path,
        "latency_ms": row.latency_ms,
        "usage": {
            "llm_calls": row.llm_calls,
            "tool_calls": row.tool_calls,
            "prompt_tokens": row.prompt_tokens,
            "completion_tokens": row.completion_tokens,
        },
        "rating": row.rating,
        "question": content.question if content else None,
        "answer": content.answer if content else None,
        "citations": (content.citations if content else None) or [],
        "notices": (content.notices if content else None) or [],
        # Present only while the content row survives retention, and that is the
        # honest signal that a run can no longer be replayed.
        "replayable": bool(content and content.input_envelope),
        "steps": [
            {
                "seq": s.seq, "key": s.node_key, "type": s.node_type, "name": s.node_name,
                "status": s.status, "ms": s.latency_ms, "branch": s.branch,
                "iteration": s.iteration, "preview": s.output_preview, "error": s.error,
            }
            for s in steps
        ],
    }


def stats(db: Session, *, brain_key: str, since_hours: int = 24) -> dict[str, Any]:
    """The six tiles above the Runs table."""
    since = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    base = db.query(AgentFlowRun).filter(
        AgentFlowRun.brain_key == brain_key,
        AgentFlowRun.is_test.is_(False),
        AgentFlowRun.created_at >= since,
    )
    total = base.count()
    ok = base.filter(AgentFlowRun.status.in_(["ok", "partial"])).count()
    errors = base.filter(AgentFlowRun.status.in_(["failed", "blocked"])).count()
    avg_tokens = (
        db.query(func.avg(AgentFlowRun.prompt_tokens + AgentFlowRun.completion_tokens))
        .filter(
            AgentFlowRun.brain_key == brain_key,
            AgentFlowRun.is_test.is_(False),
            AgentFlowRun.created_at >= since,
        )
        .scalar()
    )
    latencies = sorted(
        x[0] for x in base.with_entities(AgentFlowRun.latency_ms).all() if x[0] is not None
    )
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    return {
        "runs": total,
        "success_rate": round(ok / total * 100, 1) if total else 0.0,
        "p95_latency_ms": p95,
        "avg_tokens": int(avg_tokens or 0),
        "errors": errors,
        "window_hours": since_hours,
    }


def branch_coverage(db: Session, *, brain_key: str, days: int = 30) -> dict[str, Any]:
    """Which nodes have never run.

    A branch nobody reaches is a branch to delete, and no author finds that by
    reading their own canvas. Shown ON the canvas, which is the only place the
    question occurs to anyone.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(AgentFlowRunStep.node_key, func.count(AgentFlowRunStep.id))
        .join(AgentFlowRun, AgentFlowRun.id == AgentFlowRunStep.run_id)
        .filter(
            AgentFlowRun.brain_key == brain_key,
            AgentFlowRun.is_test.is_(False),
            AgentFlowRunStep.created_at >= since,
            AgentFlowRunStep.status.in_(["ok", "reused"]),
        )
        .group_by(AgentFlowRunStep.node_key)
        .all()
    )
    return {"days": days, "counts": {k: int(c) for k, c in rows}}


def prune(
    db: Session,
    *,
    content_days: int = CONTENT_RETENTION_DAYS,
    step_days: int = STEP_RETENTION_DAYS,
) -> dict[str, int]:
    """Delete what has aged out. Returns what it removed, so it can be logged.

    A prune that runs silently is indistinguishable from data loss when somebody
    later goes looking for a run that "should" be there.
    """
    now = datetime.now(timezone.utc)
    steps = (
        db.query(AgentFlowRunStep)
        .filter(AgentFlowRunStep.created_at < now - timedelta(days=step_days))
        .delete(synchronize_session=False)
    )
    content = (
        db.query(AgentFlowRunContent)
        .filter(AgentFlowRunContent.created_at < now - timedelta(days=content_days))
        .delete(synchronize_session=False)
    )
    db.commit()
    result = {"steps_deleted": int(steps or 0), "content_deleted": int(content or 0)}
    logger.info("[flow] pruned run history: %s", result)
    return result
