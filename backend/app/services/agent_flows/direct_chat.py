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

THE DECLARED TYPE IS THE GATE; THE CHECK IS THE SAFETY NET
----------------------------------------------------------
`flow_type == "chat"` is the author saying what they built, asked when the flow is
created — so nobody discovers after building it that their assistant cannot be
used. The same declaration refuses a chat flow on the LINK side, which until now
had no check at all: `_usable_flow` asked only whether a flow was shared and
published.

`ineligibility_reasons` stays, with a narrower job. It no longer decides whether a
flow MAY be a chat flow; it reports whether one that claims to be has been edited
into something that cannot run, so the author hears it at the step rather than at
the door.
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

    # CHART TOOLS ARE NO LONGER A REASON.
    #
    # They were banned because this surface had no charts: `allowed_chart_ids` was
    # a hardcoded empty set, so every one of those calls came back
    # `chart_out_of_scope`. That froze Chat at "documents only" by disqualifying 20
    # of the 36 tools — the rule was right about the consequence and wrong about
    # the cause, and the cause has been fixed.
    #
    # A chat flow now resolves its chart at run time from the datasets its author
    # granted. The tool is HOW it does that; granting one is not evidence the flow
    # cannot run. A flow that attached nothing still measures nothing, and says so
    # through the tool's own refusal rather than through a blanket ban here.

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
        .filter(AgentBrainVersion.flow_type == "chat")
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
    if str(getattr(row, "flow_type", "") or "") != "chat":
        # Not "disabled" — it was never this kind of flow. A bot flow arriving at
        # the chat door means a stale thread, or a type changed under it.
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
    # It was never a chat assistant, which is a different thing from having been
    # switched off — and the difference matters to whoever has to fix it.
    "direct_chat_disabled": (
        "Trợ lý này được tạo cho Bot trên báo cáo, nên không dùng được ở màn hình "
        "chat."
    ),
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


#: What a person may do with a conversation that is not theirs.
#:
#:   none   it is not theirs and nobody shared it
#:   view   they may read the transcript
#:   edit   they may read it AND ask the next question in it
#:   owner  they started it: rename, delete, share
ThreadAccess = str


def _module_level(user: Any) -> str:
    """This person's `chat` level, read the same way every gate reads it."""
    from app.core.dependencies import _normalize_permissions, _sanitize_permission_level

    return _sanitize_permission_level(_normalize_permissions(user).get("chat", "none"))


def thread_access(db: Session, user: Any, thread: AgentFlowChatThread) -> ThreadAccess:
    """How this person stands to this conversation.

    THREE WAYS IN, AND THEY ARE NOT THE SAME.

      owner   they started it. Rename, delete and share are theirs alone.
      share   somebody handed it to them, at `view` or `edit`.
      full    `chat: full` — the oversight level, which reads everything in the
              workspace the way `full` does in every other module.

    Deliberately NOT a way to run the flow. Asking the next question is checked
    separately against the FLOW's own share (`resolve_for_chat`), so handing
    somebody a conversation can never become a way around who may use the
    assistant behind it.
    """
    if str(getattr(thread, "user_id", "")) == str(getattr(user, "id", "")):
        return "owner"
    if _module_level(user) == "full":
        return "full"

    from app.core.resource_shares import get_highest_share_for_resource
    from app.models.resource_share import ResourceType

    share = get_highest_share_for_resource(
        db, user, ResourceType.CHAT_THREAD, str(thread.id)
    )
    if share is None:
        return "none"
    level = getattr(share.permission, "value", share.permission)
    return "edit" if str(level) == "edit" else "view"


def get_thread(db: Session, user: Any, thread_id: int) -> AgentFlowChatThread | None:
    """The conversation, if this person may READ it at all.

    Callers that go on to WRITE — rename, delete, or ask the next question — must
    additionally consult `thread_access`; reading is the weaker question and this
    answers only that.
    """
    thread = (
        db.query(AgentFlowChatThread)
        .filter(
            AgentFlowChatThread.id == thread_id,
            AgentFlowChatThread.deleted_at.is_(None),
        )
        .first()
    )
    if thread is None:
        return None
    return thread if thread_access(db, user, thread) != "none" else None


def list_threads(
    db: Session, user: Any, brain_key: str | None = None, limit: int = 100
) -> list[AgentFlowChatThread]:
    """Their own conversations, plus the ones shared with them.

    `chat: full` sees every conversation in the workspace — the oversight level.
    Ordered by last activity across all three sources, so a conversation somebody
    just added to does not sit below a stale one of your own.
    """
    from sqlalchemy import or_

    q = db.query(AgentFlowChatThread).filter(
        AgentFlowChatThread.deleted_at.is_(None)
    )
    if _module_level(user) != "full":
        from app.core.resource_shares import get_shared_resource_ids_query
        from app.models.resource_share import ResourceType

        shared = get_shared_resource_ids_query(db, user, ResourceType.CHAT_THREAD)
        ids = [int(r[0]) for r in shared.all() if str(r[0]).strip().isdigit()]
        own = AgentFlowChatThread.user_id == user.id
        q = q.filter(or_(own, AgentFlowChatThread.id.in_(ids)) if ids else own)
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
                # Stored turns are replayed to a READER, including turns recorded
                # before the audience boundary existed, so the filter runs here on
                # plain dicts rather than trusting what was written.
                "notices": [
                    n for n in ((content.notices if content else None) or [])
                    if (n or {}).get("audience", "reader") != "author"
                ],
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
