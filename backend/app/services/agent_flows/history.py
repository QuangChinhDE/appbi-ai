"""Run history read as CONVERSATIONS, and the feedback attached to them.

WHY THIS IS NOT IN `runs.py`
---------------------------
`runs.py` writes a run and reads one back. This module answers a different
question with the same rows, and the difference is not cosmetic: a run is one
turn, and nobody asks a bot one question.

The Runs tab listed turns. That is the right unit for "did this call succeed" and
the wrong one for every question an author actually has. A viewer who asked four
times because the first three answers were useless appeared as four unrelated
rows, three of them `ok` — because each one DID answer, just not usefully. The
thing that went wrong lived between the rows, and a per-turn list is the one shape
that cannot show it.

So: group by `session_key`, order by time, and a conversation becomes readable as
what it was. Nothing new is stored — `agent_flow_runs.session_key` has been there
since the table existed, filled on every public turn and, from now on, on studio
tests too.

RUNS WITH NO SESSION
--------------------
Legacy studio tests carry no session key. They are returned as single-turn
conversations keyed by their run id rather than dropped or lumped together: a
history view that silently omits rows teaches an author to distrust it.

FEEDBACK IS A JOIN, NOT A TABLE
-------------------------------
A thumb is one column on the run it rates. What makes it useful is everything
already recorded beside it — the branch taken, the notices raised, the steps that
errored or were skipped, the requirements that were missing. `signals()` reads
those into the short list of things that could explain the reaction, which is the
difference between "somebody was unhappy" and "somebody was unhappy on the runs
where the knowledge step found nothing".
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import String, case, cast, func
from sqlalchemy.orm import Session

from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent, AgentFlowRunStep
from app.services.agent_flows.runs import normalise_question

logger = logging.getLogger(__name__)

#: Worst-first. A conversation is described by its worst turn, because that is the
#: one worth opening — an author scanning for trouble should not have to expand a
#: green conversation to find the failed turn inside it.
_SEVERITY = {"failed": 3, "blocked": 2, "partial": 1, "ok": 0}

#: Read as "this many turns is a conversation that went wrong". Not a hard rule and
#: not enforced anywhere — it is the threshold the list uses to flag re-asking, and
#: it is here so the number has one home.
LONG_CONVERSATION = 5


def _group_key():
    """The conversation a run belongs to.

    `case` + `cast` rather than string concatenation: both are portable, and this
    query runs on Postgres in production and SQLite in the test suite.
    """
    return case(
        (AgentFlowRun.session_key.is_(None), cast(AgentFlowRun.id, String)),
        else_=AgentFlowRun.session_key,
    )


def _by_source(q, source: str):
    """Filter by WHERE the question came from.

    Three values, not a boolean. `include_tests` could say "viewers" or "viewers and
    me" and never "just what I ran" — which is the view an author wants while
    building, and the one the Runs tab could not produce. Worse, it defaulted to
    excluding tests, so the tab was empty in the moment right after a test run.

    Unknown values fall through to `all` rather than raising: this comes from a query
    string, and a typo should show more than intended, never break the screen.
    """
    if source == "viewer":
        return q.filter(AgentFlowRun.is_test.is_(False))
    if source == "test":
        return q.filter(AgentFlowRun.is_test.is_(True))
    return q


def _window(q, since_hours: int):
    if since_hours:
        q = q.filter(
            AgentFlowRun.created_at >= datetime.now(timezone.utc) - timedelta(hours=since_hours)
        )
    return q


def list_conversations(
    db: Session,
    *,
    brain_key: str,
    since_hours: int = 24,
    source: str = "all",
    status: str | None = None,
    rated: str | None = None,
    search: str = "",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """Conversations newest-last-turn first.

    `status` and `rated` filter on the CONVERSATION, not the turn: asking for
    `failed` returns conversations containing a failed turn, because "show me what
    broke" means the conversation it broke in, not one row out of its middle.

    `source` is `all` by default. This is read inside the builder, by the person who
    authored the flow, and hiding their own test runs from them there made the tab
    look empty in the one moment they most needed it.
    """
    gk = _group_key().label("gk")
    rated_up = func.sum(case((AgentFlowRun.rating == "up", 1), else_=0))
    rated_down = func.sum(case((AgentFlowRun.rating == "down", 1), else_=0))

    q = db.query(
        gk,
        func.count(AgentFlowRun.id).label("turns"),
        func.min(AgentFlowRun.created_at).label("started_at"),
        func.max(AgentFlowRun.created_at).label("last_at"),
        func.min(AgentFlowRun.id).label("first_run_id"),
        func.max(AgentFlowRun.id).label("last_run_id"),
        func.sum(func.coalesce(AgentFlowRun.prompt_tokens, 0)).label("prompt_tokens"),
        func.sum(func.coalesce(AgentFlowRun.completion_tokens, 0)).label("completion_tokens"),
        func.sum(func.coalesce(AgentFlowRun.latency_ms, 0)).label("ms"),
        rated_up.label("up"),
        rated_down.label("down"),
        func.max(cast(AgentFlowRun.is_test, String)).label("any_test"),
    ).filter(AgentFlowRun.brain_key == brain_key)

    q = _by_source(q, source)
    q = _window(q, since_hours)
    q = q.group_by(gk)

    if status:
        # HAVING, not WHERE: the filter is a property of the group. Filtering rows
        # first would return the conversation with only its failed turn in it, and
        # a conversation shown without the turns around it is unreadable.
        q = q.having(
            func.sum(case((AgentFlowRun.status == status, 1), else_=0)) > 0
        )
    if search:
        # Matches ANY turn, for the same reason: somebody looking for "the
        # conversation about churn" means the whole conversation, and the phrase they
        # remember is often not in its opening question.
        needle = f"%{normalise_question(search)}%"
        q = q.having(
            func.sum(case((AgentFlowRun.question_norm.ilike(needle), 1), else_=0)) > 0
        )
    if rated == "up":
        q = q.having(rated_up > 0)
    elif rated == "down":
        q = q.having(rated_down > 0)
    elif rated == "any":
        q = q.having(rated_up + rated_down > 0)

    rows = q.order_by(func.max(AgentFlowRun.created_at).desc()).limit(limit).offset(offset).all()
    total = db.query(func.count()).select_from(q.subquery()).scalar() or 0

    keys = [r.gk for r in rows]
    if not keys:
        return {"total": 0, "conversations": []}

    # One extra query for the turn-level facts a group cannot carry: which statuses
    # occurred, which paths ran, and which report it was on. Cheaper than a
    # per-conversation lookup and it keeps the shape of the answer honest.
    detail_rows = (
        db.query(
            _group_key().label("gk"),
            AgentFlowRun.id,
            AgentFlowRun.status,
            AgentFlowRun.execution_path,
            AgentFlowRun.dashboard_id,
            AgentFlowRun.link_token,
            AgentFlowRun.is_test,
            AgentFlowRun.session_key,
            AgentFlowRun.version,
        )
        .filter(AgentFlowRun.brain_key == brain_key, _group_key().in_(keys))
        .all()
    )
    by_key: dict[str, list[Any]] = {}
    for d in detail_rows:
        by_key.setdefault(d.gk, []).append(d)

    first_ids = [r.first_run_id for r in rows]
    openers = {
        c.run_id: c.question
        for c in db.query(AgentFlowRunContent)
        .filter(AgentFlowRunContent.run_id.in_(first_ids or [-1]))
        .all()
    }

    out = []
    for r in rows:
        members = by_key.get(r.gk, [])
        statuses = sorted({m.status for m in members if m.status})
        worst = max(statuses, key=lambda s: _SEVERITY.get(s, 0)) if statuses else "ok"
        sess = next((m.session_key for m in members if m.session_key), None)
        out.append(
            {
                "key": r.gk,
                # Null when these turns were never part of a session — legacy
                # single-shot tests. Said rather than faked, so the client can
                # offer "open the conversation" only where there is one.
                "session_key": sess,
                "turns": int(r.turns or 0),
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "last_at": r.last_at.isoformat() if r.last_at else None,
                "first_run_id": r.first_run_id,
                "last_run_id": r.last_run_id,
                "first_question": openers.get(r.first_run_id) or "",
                "worst_status": worst,
                "statuses": statuses,
                "tokens": int(r.prompt_tokens or 0) + int(r.completion_tokens or 0),
                "ms": int(r.ms or 0),
                "up": int(r.up or 0),
                "down": int(r.down or 0),
                "is_test": any(bool(m.is_test) for m in members),
                "paths": sorted({m.execution_path for m in members if m.execution_path}),
                "dashboard_id": next((m.dashboard_id for m in members if m.dashboard_id), None),
                "link_token": next((m.link_token for m in members if m.link_token), None),
                "version": next((m.version for m in members if m.version), None),
                # A viewer who asked six times was not satisfied by the first five.
                # Flagged here rather than left for the reader to notice, because
                # the number is only meaningful next to the answers.
                "kept_asking": int(r.turns or 0) >= LONG_CONVERSATION,
            }
        )
    return {"total": int(total), "conversations": out}


def conversation_detail(db: Session, *, brain_key: str, key: str) -> dict[str, Any] | None:
    """Every turn of one conversation, oldest first, each with what the flow did.

    Steps are included per turn but WITHOUT the per-version node config that
    `runs.run_detail` attaches: reading a conversation is about how the answers
    developed, and pulling every turn's version config to render a list of six
    conversations' worth of steps costs a lot to answer a question nobody asked
    here. The single-run view remains the place for a step's configuration.
    """
    q = db.query(AgentFlowRun).filter(
        AgentFlowRun.brain_key == brain_key, _group_key() == key
    )
    rows = q.order_by(AgentFlowRun.created_at.asc(), AgentFlowRun.id.asc()).all()
    if not rows:
        return None

    ids = [r.id for r in rows]
    contents = {
        c.run_id: c
        for c in db.query(AgentFlowRunContent)
        .filter(AgentFlowRunContent.run_id.in_(ids))
        .all()
    }
    steps_by_run: dict[int, list[Any]] = {}
    for s in (
        db.query(AgentFlowRunStep)
        .filter(AgentFlowRunStep.run_id.in_(ids))
        .order_by(AgentFlowRunStep.run_id, AgentFlowRunStep.seq)
        .all()
    ):
        steps_by_run.setdefault(s.run_id, []).append(s)

    turns = []
    for idx, r in enumerate(rows):
        c = contents.get(r.id)
        steps = steps_by_run.get(r.id, [])
        turns.append(
            {
                "index": idx,
                "run_id": r.id,
                "at": r.created_at.isoformat() if r.created_at else None,
                "status": r.status,
                "version": r.version,
                "is_test": bool(r.is_test),
                "trigger": r.trigger,
                "rating": r.rating,
                "question": (c.question if c else None) or r.question_norm,
                "answer": c.answer if c else None,
                "citations": (c.citations if c else None) or [],
                "notices": (c.notices if c else None) or [],
                "execution_path": r.execution_path,
                "blocked_reason": r.blocked_reason,
                "missing_requirements": r.missing_requirements or [],
                "usage": {
                    "llm_calls": r.llm_calls,
                    "tool_calls": r.tool_calls,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "ms": r.latency_ms,
                    "usd": float(r.usd) if r.usd is not None else None,
                },
                "steps": [
                    {
                        "seq": s.seq, "key": s.node_key, "type": s.node_type,
                        "name": s.node_name, "status": s.status, "ms": s.latency_ms,
                        "branch": s.branch, "iteration": s.iteration,
                        "preview": s.output_preview, "input": s.input_preview,
                        "error": s.error, "tool_calls": s.tool_calls or [],
                        "prompt_tokens": s.prompt_tokens,
                        "completion_tokens": s.completion_tokens,
                    }
                    for s in steps
                ],
                # What in THIS turn could explain a complaint. Computed for every
                # turn, not only rated ones, because the turn that caused the
                # thumbs-down is often the one BEFORE it.
                "signals": signals_for(r, c, steps),
            }
        )

    first = rows[0]
    return {
        "key": key,
        "session_key": next((r.session_key for r in rows if r.session_key), None),
        "brain_key": brain_key,
        "turns": turns,
        "turn_count": len(turns),
        "started_at": turns[0]["at"],
        "last_at": turns[-1]["at"],
        "is_test": any(bool(r.is_test) for r in rows),
        "dashboard_id": next((r.dashboard_id for r in rows if r.dashboard_id), None),
        "link_token": next((r.link_token for r in rows if r.link_token), None),
        "version": first.version,
        "tokens": sum((r.prompt_tokens or 0) + (r.completion_tokens or 0) for r in rows),
        "up": sum(1 for r in rows if r.rating == "up"),
        "down": sum(1 for r in rows if r.rating == "down"),
    }


def signals_for(run: Any, content: Any, steps: list[Any]) -> list[dict[str, str]]:
    """What the flow did that could explain a reaction to this turn.

    Deliberately short and deliberately factual: each entry names something that
    was recorded, never an inference about why the viewer was unhappy. An author
    reading a thumbs-down needs the shortlist of candidates, and a list padded with
    everything that happened is the same as no list.
    """
    out: list[dict[str, str]] = []
    if run.status and run.status != "ok":
        out.append({"code": f"status_{run.status}", "text": f"Lượt này kết thúc ở trạng thái “{run.status}”."})
    if run.blocked_reason:
        out.append({"code": "blocked", "text": f"Bị chặn: {run.blocked_reason}."})
    for req in (run.missing_requirements or [])[:4]:
        name = req if isinstance(req, str) else str(req.get("key") or req)
        out.append({"code": "missing_requirement", "text": f"Thiếu dữ liệu bắt buộc: {name}."})
    for n in ((content.notices if content else None) or [])[:6]:
        if isinstance(n, dict) and n.get("code"):
            out.append({"code": str(n["code"]), "text": str(n.get("text") or n["code"])})
    for s in steps:
        if s.status == "error":
            out.append({
                "code": "step_error",
                "text": f"Bước “{s.node_name or s.node_key}” lỗi: {(s.error or '')[:160]}",
            })
        elif s.status == "skipped":
            out.append({
                "code": "step_skipped",
                "text": f"Bước “{s.node_name or s.node_key}” không chạy trong lượt này.",
            })
    # An answer with no citation on a flow that reads a report is worth noticing:
    # it is the shape of a number the viewer cannot check.
    if content is not None and content.answer and not (content.citations or []):
        out.append({
            "code": "no_citation",
            "text": "Câu trả lời không dẫn nguồn nào, nên người xem không kiểm chứng được số.",
        })
    return out


def feedback(
    db: Session,
    *,
    brain_key: str,
    rating: str | None = None,
    since_hours: int = 24 * 7,
    source: str = "all",
    limit: int = 50,
) -> dict[str, Any]:
    """Every rated turn, with the conversation it sits in and why it might be rated.

    A week by default rather than a day: a thumbs-down arrives when somebody
    bothered, which is rarer than a question, and a 24-hour window showed an empty
    tab on a flow that had real complaints in it.
    """
    q = (
        db.query(AgentFlowRun)
        .filter(AgentFlowRun.brain_key == brain_key, AgentFlowRun.rating.isnot(None))
    )
    if rating in ("up", "down"):
        q = q.filter(AgentFlowRun.rating == rating)
    q = _by_source(q, source)
    q = _window(q, since_hours)
    rows = q.order_by(AgentFlowRun.created_at.desc()).limit(limit).all()

    ids = [r.id for r in rows]
    contents = {
        c.run_id: c
        for c in db.query(AgentFlowRunContent)
        .filter(AgentFlowRunContent.run_id.in_(ids or [-1]))
        .all()
    }
    steps_by_run: dict[int, list[Any]] = {}
    if ids:
        for s in (
            db.query(AgentFlowRunStep)
            .filter(AgentFlowRunStep.run_id.in_(ids))
            .order_by(AgentFlowRunStep.run_id, AgentFlowRunStep.seq)
            .all()
        ):
            steps_by_run.setdefault(s.run_id, []).append(s)

    # How many turns the conversation had by the time this one was rated. A
    # thumbs-down on turn one and a thumbs-down on turn seven are different
    # complaints, and the count is what tells them apart at a glance.
    session_keys = [r.session_key for r in rows if r.session_key]
    turn_counts: dict[str, int] = {}
    if session_keys:
        for sk, n in (
            db.query(AgentFlowRun.session_key, func.count(AgentFlowRun.id))
            .filter(
                AgentFlowRun.brain_key == brain_key,
                AgentFlowRun.session_key.in_(session_keys),
            )
            .group_by(AgentFlowRun.session_key)
            .all()
        ):
            turn_counts[sk] = int(n or 0)

    items = []
    for r in rows:
        c = contents.get(r.id)
        items.append(
            {
                "run_id": r.id,
                "conversation_key": r.session_key or str(r.id),
                "session_key": r.session_key,
                "conversation_turns": turn_counts.get(r.session_key or "", 1),
                "at": r.created_at.isoformat() if r.created_at else None,
                "rating": r.rating,
                "status": r.status,
                "is_test": bool(r.is_test),
                "version": r.version,
                "link_token": r.link_token,
                "dashboard_id": r.dashboard_id,
                "question": (c.question if c else None) or r.question_norm,
                "answer": c.answer if c else None,
                "execution_path": r.execution_path,
                "signals": signals_for(r, c, steps_by_run.get(r.id, [])),
            }
        )
    return {"items": items, "summary": _feedback_summary(items)}


def _feedback_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    """What the complaints have in common.

    The point of the tab. One thumbs-down is an anecdote; eight thumbs-down that
    all ran the same branch, or all carried `branch_unmatched`, is a defect with an
    address. Counted only over the DOWN votes — an up vote sharing a signal with a
    down vote means the signal is not what went wrong.
    """
    up = sum(1 for i in items if i["rating"] == "up")
    down = sum(1 for i in items if i["rating"] == "down")
    by_signal: dict[str, int] = {}
    by_path: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for i in items:
        if i["rating"] != "down":
            continue
        for s in i["signals"]:
            by_signal[s["code"]] = by_signal.get(s["code"], 0) + 1
        if i.get("execution_path"):
            by_path[i["execution_path"]] = by_path.get(i["execution_path"], 0) + 1
        by_status[i["status"]] = by_status.get(i["status"], 0) + 1

    def top(d: dict[str, int]) -> list[dict[str, Any]]:
        return [
            {"key": k, "count": v}
            for k, v in sorted(d.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
        ]

    return {
        "up": up,
        "down": down,
        "rated": up + down,
        # Not a quality score. It is the share of the people who bothered to react
        # who reacted badly, over however long the window is — useful as a trend,
        # meaningless as an absolute, and labelled that way on screen.
        "down_share": round(down / (up + down), 3) if (up + down) else 0.0,
        "by_signal": top(by_signal),
        "by_path": top(by_path),
        "by_status": top(by_status),
    }
