"""Chatting with a flow when there is no report on screen.

WHY A FLOW HAS TO EARN THIS
---------------------------
Every flow in this product was authored against a report. Most read it: a
`report_read` step, or a step granted `get_chart_data` and its nineteen siblings,
or a requirement that only a binding can resolve to a chart. Run one of those with
no dashboard and it does not fail — `report_read` returns `{"charts": [], "read_ok":
false}` and the answering step carries on and answers from nothing. A wrong answer
delivered confidently is worse than a refusal, so the refusal happens at the door:
a flow that needs a report never appears in the Chat picker.

`binding.preflight` cannot be that door. It hard-errors `no_charts` on a contract
with no charts, which is every direct-chat contract by definition — it is asking
"can this flow be assigned to this LINK", a different question with a different
right answer.

THE OPT-IN IS SEPARATE FROM THE CHECK
-------------------------------------
Passing the check means "this flow CAN run without a report". `direct_chat_enabled`
means "its author MEANT it to". Both are required, because a knowledge-only flow
written as one link's FAQ assistant is technically runnable anywhere and was still
never intended to be a company-wide chat bot.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.agent_brain import AgentBrainVersion
from app.models.agent_flow_chat_thread import AgentFlowChatThread
from app.services.agent_flows.contract import (
    _CHART_KEYED_TOOLS,
    Flow,
    ReportReadNode,
)

logger = logging.getLogger(__name__)

#: Requirement kinds a binding resolves against a specific chart. `metric` is
#: deliberately absent: a metric requirement is a `GovernMetric.name`, a unique
#: machine name that resolves the same way on every report and therefore on none.
_REPORT_BOUND_REQUIREMENT_KINDS = {"chart", "measure", "dimension"}


def ineligibility_reasons(flow: Flow) -> list[str]:
    """Why this flow cannot run without a report. Empty means it can.

    Returns every reason rather than the first, so an author fixing a flow sees the
    whole list instead of discovering the next one after each edit.
    """
    reasons: list[str] = []

    read_steps = [n.key for n in flow.all_nodes() if isinstance(n, ReportReadNode)]
    if read_steps:
        reasons.append(
            "Flow có bước đọc báo cáo ("
            + ", ".join(read_steps)
            + ") — chat trực tiếp không có báo cáo nào để đọc."
        )

    for node in flow.agent_nodes():
        needs = sorted(set(node.tool_names()) & _CHART_KEYED_TOOLS)
        if needs:
            reasons.append(
                f"Bước “{node.key}” được cấp công cụ cần biểu đồ ("
                + ", ".join(needs)
                + ")."
            )

    blocked_reqs = [
        r.label or r.key
        for r in flow.requirements.items
        if r.required and r.kind in _REPORT_BOUND_REQUIREMENT_KINDS
    ]
    if blocked_reqs:
        reasons.append(
            "Flow bắt buộc phải có: "
            + ", ".join(blocked_reqs)
            + " — những thứ này chỉ giải được khi gắn vào một báo cáo cụ thể."
        )

    return reasons


def is_eligible(flow: Flow) -> bool:
    return not ineligibility_reasons(flow)


def published_chat_brains(db: Session, user: Any) -> list[tuple[AgentBrainVersion, Flow]]:
    """The flows this user may open in the Chat module.

    ONE ROW PER `brain_key` — the published one. `usable_brains` returns version
    rows, and a flow on its ninth revision is nine rows there; handing that to a
    picker would list the same assistant nine times.
    """
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.permissions import usable_brains

    rows = (
        usable_brains(db, user)
        .filter(AgentBrainVersion.status == "published")
        .filter(AgentBrainVersion.direct_chat_enabled.is_(True))
        .order_by(AgentBrainVersion.name.asc())
        .all()
    )

    out: list[tuple[AgentBrainVersion, Flow]] = []
    seen: set[str] = set()
    for row in rows:
        if row.brain_key in seen:
            continue
        flow = reg.parse_flow(row)
        # An unparseable or report-bound flow is dropped rather than listed as
        # broken: the picker is a menu of things that work, and a flow that cannot
        # answer here is not this user's problem to diagnose.
        if flow is None or not is_eligible(flow):
            continue
        seen.add(row.brain_key)
        out.append((row, flow))
    return out


def resolve_for_chat(
    db: Session, user: Any, brain_key: str
) -> tuple[AgentBrainVersion | None, Flow | None, str]:
    """Published version + flow for a direct-chat turn, or the reason there is none.

    Re-checked on EVERY turn, not once when the thread was opened: a share can be
    revoked, a flow unpublished, and an author can publish a revision that reads a
    report. Each of those must stop the next question rather than the next thread.
    """
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.permissions import usable_brains

    row = (
        usable_brains(db, user)
        .filter(AgentBrainVersion.brain_key == brain_key)
        .filter(AgentBrainVersion.status == "published")
        .first()
    )
    if row is None:
        # One code for "never yours", "no longer yours" and "no published version".
        # Telling them apart would tell a caller which flows exist.
        return None, None, "not_published"
    if not bool(row.direct_chat_enabled):
        return row, None, "direct_chat_disabled"

    flow = reg.parse_flow(row)
    if flow is None:
        return row, None, "not_published"
    if not is_eligible(flow):
        return row, flow, "direct_chat_ineligible"
    return row, flow, ""


BLOCK_MESSAGES = {
    "not_published": (
        "Trợ lý này hiện không còn hoạt động — flow chưa có bản phát hành, hoặc "
        "bạn không còn quyền dùng nó."
    ),
    "direct_chat_disabled": "Trợ lý này đã được tắt chế độ chat trực tiếp.",
    "direct_chat_ineligible": (
        "Bản mới của trợ lý này cần một báo cáo để đọc, nên không chạy được ở màn "
        "hình chat."
    ),
    "permission_revoked": "Bạn không còn quyền dùng trợ lý này.",
}


# ═══ The contract a direct chat runs under ════════════════════════════════════
def chat_contract(flow: Flow) -> Any:
    """The data contract for a turn with no report.

    NOT `ad_hoc_contract`, which is the Studio's. That one forces `web_search` off
    with a reason that belongs to testing — "a surface whose whole purpose is to be
    run repeatedly while iterating" must not reach outside the deployment — and
    picks the report's first twelve charts, which here would be zero anyway. Direct
    chat is a real conversation, so the flow's own declaration decides.
    """
    from app.services.agent_flows.binding import (
        BudgetContract,
        ChartsScope,
        DataContract,
        KnowledgeContract,
    )
    from app.services.agent_flows.envelope import Capabilities

    return DataContract(
        # `allowlist` with nothing in it, said explicitly. `all_current` would also
        # resolve to zero charts today, but it means "whatever the report has" — and
        # stating that about a chat with no report invites a later reader to make it
        # true.
        charts=ChartsScope(mode="allowlist", ids=[]),
        resolve={},
        knowledge=KnowledgeContract(mode="flow_all"),
        capabilities=Capabilities(
            web_search=flow.uses_capability("web_search"),
            read_rows=False,
        ),
        defaults={},
        budget=BudgetContract(),
    )


def ephemeral_chat_binding(flow: Flow) -> Any:
    """A binding that is never saved, for a chat with no link and no report.

    `id=0` is the same sentinel `ephemeral_binding` uses: `BindingInfo.id` is a plain
    `int` by contract, and `agent_flow_runs.binding_id` is nullable so the run row
    can say "no binding" honestly.
    """
    from app.models.agent_flow_binding import AgentFlowBinding
    from app.services.agent_flows.binding import ACTIVE

    return AgentFlowBinding(
        id=0,
        link_id=None,
        dashboard_id=None,
        brain_key=flow.key,
        status=ACTIVE,
        data_contract=chat_contract(flow).model_dump(mode="json"),
        # The transcript IS the run content here, so it is never optional.
        store_question_content=True,
    )


# ═══ Threads ══════════════════════════════════════════════════════════════════
def new_session_key() -> str:
    """Owner of this thread's runtime memory row.

    `ai_chat_sessions.session_key` is globally unique and the engine looks a session
    up by it ALONE, so this must not collide with a public link's browser-tab key.
    """
    return f"dc_{secrets.token_hex(16)}"[:64]


def session_token(thread_id: int) -> str:
    """`ai_chat_sessions.token` for a direct-chat thread.

    That column is NOT NULL and `load_memory` drops memory whose stored token differs
    from the caller's — the mechanism that stops one browser tab carrying facts
    between two public links. A direct chat has no link token, so it gets its own
    namespace, exactly as a Studio test does with `studio:`.
    """
    return f"chat:{thread_id}"[:200]


def create_thread(db: Session, user: Any, brain_key: str) -> AgentFlowChatThread:
    thread = AgentFlowChatThread(
        user_id=user.id,
        brain_key=brain_key,
        session_key=new_session_key(),
    )
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return thread


def get_thread(db: Session, user: Any, thread_id: int) -> AgentFlowChatThread | None:
    return (
        db.query(AgentFlowChatThread)
        .filter(
            AgentFlowChatThread.id == thread_id,
            AgentFlowChatThread.user_id == user.id,
            AgentFlowChatThread.deleted_at.is_(None),
        )
        .first()
    )


def list_threads(
    db: Session, user: Any, brain_key: str | None = None, limit: int = 100
) -> list[AgentFlowChatThread]:
    q = db.query(AgentFlowChatThread).filter(
        AgentFlowChatThread.user_id == user.id,
        AgentFlowChatThread.deleted_at.is_(None),
    )
    if brain_key:
        q = q.filter(AgentFlowChatThread.brain_key == brain_key)
    return q.order_by(AgentFlowChatThread.last_active_at.desc()).limit(limit).all()


def touch(db: Session, thread: AgentFlowChatThread, *, title_from: str = "") -> None:
    """Mark the thread used, and name it from the first question asked in it."""
    thread.last_active_at = datetime.now(timezone.utc)
    if title_from and not (thread.title or "").strip():
        cleaned = " ".join(title_from.split())
        thread.title = cleaned[:120] + ("…" if len(cleaned) > 120 else "")
    try:
        db.commit()
    except Exception:  # noqa: BLE001 — never fail a turn over its own bookkeeping
        logger.warning("[chat] thread touch failed", exc_info=True)
        db.rollback()


def soft_delete(db: Session, thread: AgentFlowChatThread) -> None:
    """The ONLY lifecycle action. Runs keep their `chat_thread_id` so a user tidying
    their chat list does not erase the deployment's cost history."""
    thread.deleted_at = datetime.now(timezone.utc)
    db.commit()


def transcript(db: Session, thread: AgentFlowChatThread, limit: int = 50) -> list[dict]:
    """The conversation, rebuilt from run history.

    THE RUN CONTENT IS THE TRANSCRIPT, and `ai_chat_sessions.messages` is not. That
    column is assigned straight from a request body by a public endpoint, so it is
    whatever a client last posted; `agent_flow_run_content` is written by the runtime
    from the envelope it actually produced.

    The cost of that choice, stated: content rows are pruned on a retention window
    (180 days by default), so a thread older than that keeps its runs — and its
    metrics — but loses its words. A dedicated message table is what buys longer,
    and it is not worth a second write path until somebody needs it.
    """
    from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent

    # Newest `limit` runs, then flipped: a long thread must keep its RECENT turns,
    # and taking them ascending would hand back the opening of the conversation and
    # drop everything the last answer depended on.
    rows = (
        db.query(AgentFlowRun, AgentFlowRunContent)
        .outerjoin(AgentFlowRunContent, AgentFlowRunContent.run_id == AgentFlowRun.id)
        .filter(AgentFlowRun.chat_thread_id == thread.id)
        .order_by(AgentFlowRun.created_at.desc())
        .limit(limit)
        .all()
    )
    rows = list(reversed(rows))

    out: list[dict] = []
    for run, content in rows:
        question = (content.question if content else None) or run.question_norm or ""
        if question:
            out.append({"role": "user", "content": question})
        answer = (content.answer if content else None) or ""
        if answer or run.status in ("blocked", "failed"):
            out.append({
                "role": "assistant",
                "content": answer,
                "status": run.status,
                "notices": (content.notices if content else None) or [],
                "citations": (content.citations if content else None) or [],
                "run_id": run.id,
                "rating": run.rating,
            })
    return out


def history_turns(db: Session, thread: AgentFlowChatThread, limit: int = 12) -> list[dict]:
    """The last few turns, in the `{role, content}` shape the envelope wants."""
    rows = transcript(db, thread, limit=limit)
    return [
        {"role": r["role"], "content": r["content"]}
        for r in rows
        if r.get("content")
    ]
