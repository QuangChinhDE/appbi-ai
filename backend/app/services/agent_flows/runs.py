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
                    input_preview=step.input_preview or None,
                    output_preview=step.output_preview or None,
                    # The executor already measured these per node; they used to
                    # be dropped here for want of a column, so a run could say it
                    # spent 14,000 tokens and never say on what.
                    prompt_tokens=step.prompt_tokens or None,
                    completion_tokens=step.completion_tokens or None,
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
    node_configs = _configs_for_version(db, brain_key=brain_key, version=row.version)
    flow_warnings, unresolved = _version_diagnosis(db, brain_key=brain_key, version=row.version)
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
            # Stored since this table was created and never returned, so the one
            # number an operator is actually accountable for was invisible.
            "usd": float(row.usd) if row.usd is not None else None,
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
                # Everything below was already on the row (or measured and then
                # discarded) and never reached the screen, which is why a run
                # could only be read as a list of green and red dots.
                "input": s.input_preview,
                "tool_calls": s.tool_calls or [],
                "prompt_tokens": s.prompt_tokens,
                "completion_tokens": s.completion_tokens,
                # CONFIG AS IT WAS, not as it is now. Read from the immutable
                # version this run executed, so it cannot drift from what
                # actually ran and costs no extra storage — the alternative was
                # copying a whole flow body into every run.
                "config": node_configs.get(s.node_key),
                # WHICH {{name}} THIS STEP USED THAT NOTHING EVER PRODUCES.
                #
                # A reference with no producer resolves to empty at run time, and
                # the step still runs: a Switch on `{{scenario}}` silently takes
                # its fallback every single time, and an agent prompt quietly
                # loses the sentence that was supposed to carry the data. The
                # answer still comes out, which is exactly why this needs saying
                # out loud on the RUN — the flow's design-time warning is on
                # another screen from the one somebody opens when an answer looks
                # wrong.
                "unresolved_refs": unresolved.get(s.node_key, []),
            }
            for s in steps
        ],
        # The version's own review notes, surfaced here too. Same source as the
        # badge in the builder — one detector, two places that need it.
        "flow_warnings": flow_warnings,
        # NODES WITH NO ROW AT ALL, and which kind of absence it is.
        #
        # A trace lists what ran. It cannot, on its own, distinguish a node that
        # sat on a branch nobody took from one the executor ran past — and that
        # ambiguity is precisely what makes a run look like it is skipping steps
        # in silence. Audited across 32 stored runs: every absence was a branch,
        # none was on the spine. Saying so per run turns "why is this node
        # missing" into an answered question instead of a suspicion.
        "not_executed": _not_executed(db, brain_key=brain_key, version=row.version,
                                      ran={s.node_key for s in steps}),
        "config_source": (
            f"v{row.version}" if node_configs else
            "không đọc được bản flow của run này — có thể phiên bản đã bị xoá"
        ),
    }


#: Never shown when replaying a step's configuration. A node may carry an
#: encrypted per-step key; a run inspector is a read surface for anyone with view
#: rights on the flow, and "what did this step run with" must not become "here is
#: the credential it ran with".
_SECRET_CONFIG_FIELDS = frozenset({"api_key", "api_key_enc", "api_key_clear"})


def _configs_for_version(
    db: Session, *, brain_key: str, version: int | None
) -> dict[str, dict[str, Any]]:
    """`node key → its settings` in the version a run actually executed.

    Read rather than stored. The run records which version it ran, and a version
    body is immutable once written, so this is exact by construction and adds
    nothing to the size of a run. Copying the config into each step row would
    duplicate an entire flow body per run to record something already on disk —
    and would then be able to disagree with it.

    Empty when the version has been deleted, which the caller reports rather than
    papering over with the CURRENT body: showing today's settings beside
    yesterday's result is worse than showing none.
    """
    if version is None:
        return {}
    from app.models.agent_brain import AgentBrainVersion

    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    body = getattr(row, "body", None) if row is not None else None
    if not isinstance(body, dict):
        return {}

    out: dict[str, dict[str, Any]] = {}

    def scrub(value: Any) -> Any:
        """Strip credentials at EVERY depth, not just the top of a node.

        Stripping only the outer keys left the secrets in place: an `if` node's
        own entry carries its `paths`, each path carries a `body`, and those
        child dicts were copied verbatim — so the credential of a nested agent
        step was served to anyone with view rights on the flow. Caught by the
        test that asserted the payload contains no `api_key_enc`, on a real run
        with a branch in it.
        """
        if isinstance(value, dict):
            return {
                k: scrub(v) for k, v in value.items()
                if k not in _SECRET_CONFIG_FIELDS
            }
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value

    def walk(nodes: Any) -> None:
        for n in nodes or []:
            if not isinstance(n, dict) or not n.get("key"):
                continue
            out[str(n["key"])] = scrub(n)
            for p in (n.get("paths") or []) + (n.get("cases") or []):
                if isinstance(p, dict):
                    walk(p.get("body"))
            walk(n.get("body"))
            walk(n.get("fallback"))

    walk(body.get("nodes"))
    return out


#: `{{name}}` in any templated field.
_REF_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")

#: Names the ENGINE seeds into every run, so they are never "unproduced" even
#: though no node creates them. Kept here rather than inferred, because guessing
#: would make this report a step as broken for using `{{question}}`.
_ENGINE_VARS = frozenset({
    "question", "previous", "report_ctx_name", "available_metrics",
    "available_dimensions", "outputs", "item", "index",
})


def _version_diagnosis(
    db: Session, *, brain_key: str, version: int | None
) -> tuple[list[str], dict[str, list[str]]]:
    """The version's review notes, and per node the refs nothing produces.

    Uses the SAME `Flow` object the builder validates, so the detection cannot
    disagree with the badge an author already saw — one detector, reported in the
    second place that needs it. Anything the binding resolves (a requirement) or
    the engine seeds counts as produced; otherwise a step would be flagged for
    reading `{{question}}`.
    """
    if version is None:
        return [], {}
    from app.models.agent_brain import AgentBrainVersion

    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if row is None:
        # SAY IT, rather than returning an empty diagnosis that reads as "nothing
        # wrong". Run 100 executed on v12, v12 has since been deleted, and a
        # silent empty list told the reader their flow was clean when in truth
        # nothing had been checked.
        return ([
            f"Không còn bản v{version} mà run này đã chạy, nên không kiểm được "
            "cấu hình hay biến của nó. Đây KHÔNG phải kết luận là flow sạch — là "
            "chưa kiểm được."
        ], {})
    try:
        from app.services.agent_flows import registry as reg

        flow = reg.parse_flow(row)
        if flow is None:
            return ([
                f"Bản v{version} của run này không đọc được, nên không kiểm được "
                "biến hay cấu hình."
            ], {})
        warnings = list(flow.warnings())
        known = (
            set(flow.produced_vars())
            | {r.key for r in flow.requirements.items}
            | _ENGINE_VARS
        )
        out: dict[str, list[str]] = {}
        for node in flow.all_nodes():
            blob = " ".join(
                str(getattr(node, f, "") or "")
                for f in ("prompt", "query", "value", "over", "source", "target")
            )
            missing = sorted({
                m.group(1) for m in _REF_RE.finditer(blob)
                if m.group(1) not in known and m.group(1).split(".")[0] not in known
            })
            if missing:
                out[node.key] = missing
        return warnings, out
    except Exception:  # noqa: BLE001 — a diagnosis must never break a read
        logger.warning("[flow] could not diagnose %s v%s", brain_key, version,
                       exc_info=True)
        return [], {}


def _not_executed(
    db: Session, *, brain_key: str, version: int | None, ran: set[str]
) -> list[dict[str, Any]]:
    """Flow nodes with no trace row, each labelled by WHY it could be absent.

    `on_branch` means the node lives inside an `if` path, a `switch` case or a
    loop body, so not running it is the flow working. Anything else is on the
    spine and its absence is a defect worth chasing.
    """
    if version is None:
        return []
    from app.models.agent_brain import AgentBrainVersion

    row = (
        db.query(AgentBrainVersion)
        .filter(
            AgentBrainVersion.brain_key == brain_key,
            AgentBrainVersion.version == version,
        )
        .first()
    )
    if row is None:
        return []
    try:
        from app.services.agent_flows import registry as reg

        flow = reg.parse_flow(row)
        if flow is None:
            return []
        out: list[dict[str, Any]] = []

        def walk(nodes: Any, on_branch: bool) -> None:
            for n in nodes or []:
                if n.key not in ran:
                    out.append({
                        "key": n.key,
                        "name": getattr(n, "name", "") or n.key,
                        "type": n.type,
                        "on_branch": on_branch,
                    })
                for p in (getattr(n, "paths", None) or []):
                    walk(getattr(p, "body", None), True)
                for c in (getattr(n, "cases", None) or []):
                    walk(getattr(c, "body", None), True)
                walk(getattr(n, "fallback", None), True)
                walk(getattr(n, "body", None), True)

        walk(flow.nodes, False)
        return out
    except Exception:  # noqa: BLE001 — never break a read over this
        return []


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
