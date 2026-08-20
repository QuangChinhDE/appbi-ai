"""From "a viewer asked something" to "a flow ran". The one place that path exists.

WHY THIS IS NOT IN `public.py`
-----------------------------
It used to be: the chat endpoint resolved the flow, patched the shared tool context
mid-setup, and called the engine with nine loose arguments. Three callers now need
that same path — the public bot, the Studio's Test button, and replaying a stored
run — and a path that lives inside an HTTP handler can only ever have one.

So the envelope is BUILT here, and everything downstream takes a value.

FAIL CLOSED, EVERY TIME
-----------------------
No binding, a binding that no longer matches its dashboard, or a flow with nothing
published: the bot says so and does not answer. It never falls back to "read
whatever is on the dashboard" — that fallback is exactly what "define the data
before assigning the flow" exists to remove.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator

from sqlalchemy.orm import Session

from app.models.agent_flow_binding import AgentFlowBinding
from app.services.agent_flows import binding as binding_service
from app.services.agent_flows import registry as reg
from app.services.agent_flows import runs as runs_service
from app.services.agent_flows.contract import Flow
from app.services.agent_flows.envelope import (
    ChartInfo,
    ConversationInfo,
    FieldRef,
    FiltersInfo,
    FlowInput,
    FlowOutput,
    MemoryInfo,
    Notice,
    PageInfo,
    QuestionInfo,
    ReportInfo,
    RequestInfo,
    RuntimeInfo,
    Turn,
    blocked,
)
from app.services.agent_flows.envelope import AppliedFilter, Budget as BudgetEnvelope
from app.services.agent_flows.runtime import executor
from app.services.dashboard_ai_bot.events import AgentEvent

logger = logging.getLogger(__name__)

#: How long a session's established facts stay valid without anything changing.
#: A warehouse can refresh mid-conversation, and calling a two-hour-old figure
#: "continuity" is just being wrong more confidently.
MEMORY_TTL_MINUTES = 30


def new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:20]}"


# ═══ Building the envelope ════════════════════════════════════════════════════
def build_report_info(dashboard: Any, ctx: Any) -> ReportInfo:
    """Describe the report. Never name it to the flow as a target — this is context.

    Read off the tool context, which already extracted each chart's measures and
    dimensions through the semantic layer. Re-deriving them here would be a second
    answer to "what does this chart measure".
    """
    charts: list[ChartInfo] = []
    for chart_id, meta in (getattr(ctx, "chart_meta", None) or {}).items():
        fields = meta.get("fields") or {}
        charts.append(
            ChartInfo(
                id=int(chart_id),
                title=str(meta.get("name") or f"Chart {chart_id}"),
                chart_type=str(meta.get("chart_type") or ""),
                description=str(meta.get("description") or ""),
                measures=[
                    FieldRef(field=str(m.get("field") or m.get("name") or ""),
                             label=str(m.get("label") or ""))
                    for m in (fields.get("measures") or [])
                    if isinstance(m, dict)
                ],
                dimensions=[
                    FieldRef(field=str(d.get("field") or d.get("name") or ""),
                             label=str(d.get("label") or ""))
                    for d in (fields.get("dimensions") or [])
                    if isinstance(d, dict)
                ],
            )
        )
    pages = [
        PageInfo(
            id=str(p.get("id") or p.get("page_id") or ""),
            name=str(p.get("name") or ""),
            chart_ids=[int(c) for c in (p.get("chart_ids") or []) if isinstance(c, int)],
        )
        for p in (getattr(ctx, "pages", None) or [])
        if isinstance(p, dict)
    ]
    return ReportInfo(
        dashboard_id=int(getattr(dashboard, "id", 0) or 0),
        name=str(getattr(dashboard, "name", "") or ""),
        description=str(getattr(dashboard, "description", "") or ""),
        charts=charts,
        pages=pages,
    )


def fingerprint(*, binding_id: int, version: int, filters: list[dict], charts: list[int],
                locale: str) -> str:
    """What invalidates a session's memory.

    Change the filters, the version, the allowed charts or the language, and every
    fact derived under the old ones is stale. One hash rather than per-fact
    reasoning: cheap, and impossible to get subtly wrong per variable.
    """
    payload = json.dumps(
        {
            "b": binding_id,
            "v": version,
            "f": sorted(json.dumps(f, sort_keys=True, default=str) for f in (filters or [])),
            "c": sorted(charts or []),
            "l": locale,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def load_memory(db: Session, *, session_key: str, token: str, fp: str) -> tuple[MemoryInfo, list[Notice]]:
    """Read the SERVER-owned session store, dropping anything stale.

    Never `ai_chat_sessions.conv_state`: that column is assigned straight from the
    request body on a public unauthenticated endpoint, so a variable kept there could
    be set by the person asking the question and then read into prompts, branch
    conditions and tool arguments.
    """
    empty = MemoryInfo(fingerprint=fp)
    if not session_key:
        return empty, []
    try:
        from app.models.ai_chat_session import AiChatSession

        row = (
            db.query(AiChatSession)
            .filter(AiChatSession.session_key == session_key)
            .first()
        )
        if row is not None and row.token != token:
            # Same browser tab, different public link — and therefore a different
            # data contract. Nothing established under the other link may be read
            # here, or the per-link scope would leak through the session store.
            return empty, []
    except Exception:  # noqa: BLE001
        logger.warning("[flow] session memory unreadable", exc_info=True)
        return empty, []

    stored = getattr(row, "flow_state", None) if row is not None else None
    if not isinstance(stored, dict) or not stored:
        return empty, []

    if stored.get("fingerprint") != fp:
        # Said out loud rather than silently recomputed. A viewer who was told 8,4B
        # two minutes ago and now sees 8,7B with no explanation stops trusting both.
        return empty, [
            Notice(
                code="memory_reset",
                text="Bộ lọc hoặc cấu hình đã đổi nên tôi tính lại từ đầu.",
            )
        ]

    at = stored.get("at")
    try:
        if at and datetime.fromisoformat(at) < datetime.now(timezone.utc) - timedelta(
            minutes=MEMORY_TTL_MINUTES
        ):
            return empty, [
                Notice(code="memory_expired", text="Số liệu đã cũ nên tôi đọc lại từ báo cáo.")
            ]
    except (TypeError, ValueError):
        return empty, []

    return (
        MemoryInfo(
            fingerprint=fp,
            vars=stored.get("vars") or {},
            reusable_nodes=stored.get("nodes") or [],
        ),
        [],
    )


def save_memory(
    db: Session, *, session_key: str, token: str, fp: str, out: FlowOutput, flow: Flow
) -> None:
    """Persist what this turn established, server-side only."""
    if not session_key or not out.memory_delta.set:
        return
    try:
        from app.models.ai_chat_session import AiChatSession

        # LOOK UP BY `session_key` ALONE — it carries a UNIQUE index.
        #
        # Filtering by (session_key, token) missed a row that existed under another
        # token and then tried to INSERT one, which violated that index and lost the
        # memory every turn. But the token still has to be checked, just afterwards:
        # a browser tab keeps one session key while moving between links, and two
        # links have two different data contracts. Memory from one must never be
        # read on the other, so a token change RESETS the row rather than joining it.
        row = (
            db.query(AiChatSession)
            .filter(AiChatSession.session_key == session_key)
            .first()
        )
        if row is None:
            # The row is normally created by the chat client's own
            # `PUT /ai/session/...` call. Depending on that meant any client which
            # streams a turn without maintaining a session — a script, an embed, a
            # mobile shell — re-read the whole report every turn with nothing to
            # show why. The engine owns its own memory.
            row = AiChatSession(token=token, session_key=session_key)
            db.add(row)
        elif row.token != token:
            row.token = token

        remembered = out.memory_delta.set
        # Which NODES may be skipped next turn, derived from the flow rather than
        # stored by the executor: the policy is the author's declaration, and reading
        # it back from the contract keeps one source of truth.
        node_keys = [
            n.key
            for n in flow.all_nodes()
            if getattr(n, "run_policy", "every_turn") != "every_turn"
            and getattr(n, "output_var", "")
            and n.output_var in remembered
        ]
        row.flow_state = {
            "fingerprint": fp,
            "at": datetime.now(timezone.utc).isoformat(),
            "vars": remembered,
            "nodes": node_keys,
        }
        db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("[flow] session memory not saved", exc_info=True)
        db.rollback()


# ═══ The public path ══════════════════════════════════════════════════════════
def resolve_for_link(
    db: Session, *, link: Any, dashboard: Any
) -> tuple[AgentFlowBinding | None, Any, Flow | None, str]:
    """Binding → version → flow, with the reason when any of it is missing.

    Returns `(binding, row, flow, problem)`. A non-empty `problem` means DO NOT RUN.
    """
    binding = binding_service.get_for_link(db, link.id)
    if binding is None:
        return None, None, None, "not_configured"
    if binding.status == binding_service.BROKEN:
        return binding, None, None, "binding_broken"

    drift = binding_service.cheap_validate(binding, dashboard)
    if drift:
        binding_service.mark_broken(db, binding, drift)
        return binding, None, None, "binding_broken"

    resolved = reg.resolve_version(db, binding.brain_key, binding.pinned_version)
    if resolved is None:
        # TWO VERY DIFFERENT REASONS, and only one of them is drift.
        #
        # Chart drift above is recorded on the binding; this branch recorded
        # nothing, so a binding whose FLOW had ceased to exist went on reporting
        # itself `active` while every question failed. The asymmetry is why one
        # such binding sat unnoticed in this deployment: the screens that exist to
        # show unhealthy links had no idea.
        #
        # Zero versions means the flow is gone for good — that is drift, and it is
        # marked, so the link shows as broken wherever bindings are listed.
        #
        # Versions exist but none is published is RECOVERABLE: an author who
        # unpublishes to fix something would otherwise have to re-activate every
        # binding by hand after publishing again. Left alone deliberately.
        if not reg.has_any_version(db, binding.brain_key):
            binding_service.mark_broken(
                db, binding,
                f"Flow '{binding.brain_key}' không còn tồn tại — link này đang trỏ "
                f"vào chỗ trống. Hãy gán lại flow khác cho link.",
            )
            return binding, None, None, "binding_broken"
        return binding, None, None, "not_published"
    row, flow = resolved
    return binding, row, flow, ""


def flow_supplies_credentials(db: Session, *, token: str) -> bool:
    """Does the flow on this link bring its own API keys?

    Asked in TWO places — the endpoint that 400s on "no key", and the public payload
    flag that decides whether the viewer is shown a "paste your API key" panel — and
    they must agree. A per-node token that the runtime honours but the panel does not
    know about leaves the viewer stuck at a gate in front of a working bot.

    Resolved through the BINDING, so a link pinned to an older version is judged on
    the version it actually runs.

    Fails CLOSED: anything unexpected means the viewer is asked for a key rather than
    dropped into a chat that cannot call anything.
    """
    try:
        from app.models.models import DashboardPublicLink

        link = (
            db.query(DashboardPublicLink)
            .filter(DashboardPublicLink.token == token)
            .first()
        )
        if link is None:
            return False
        bind = binding_service.get_for_link(db, link.id)
        if bind is None:
            return False
        resolved = reg.resolve_version(db, bind.brain_key, bind.pinned_version)
        return bool(resolved and not resolved[1].steps_missing_credentials())
    except Exception:  # noqa: BLE001
        logger.warning("[flow] credential self-sufficiency check failed", exc_info=True)
        return False


BLOCK_MESSAGES = {
    "not_configured": (
        "Link này chưa gán trợ lý. Vào phần ChatBot của link, chọn một Agent Flow và "
        "định nghĩa phạm vi dữ liệu trước khi gán."
    ),
    "binding_broken": "Trợ lý đang được cấu hình lại cho báo cáo này.",
    "not_published": "Trợ lý của link này chưa có bản phát hành nào.",
}


async def run_for_link(
    db: Session,
    *,
    link: Any,
    dashboard: Any,
    ctx: Any,
    question: str,
    history: list[dict] | None = None,
    session_key: str = "",
    filters: list[dict] | None = None,
    api_key: str = "",
    provider: str = "",
    model: str = "",
    base_system_prompt: str = "",
    locale: str = "vi",
) -> AsyncGenerator[AgentEvent, None]:
    """One turn on a public link. Always ends with `result`, even when blocked."""
    run_id = new_run_id()
    binding, row, flow, problem = resolve_for_link(db, link=link, dashboard=dashboard)

    if problem or flow is None or row is None:
        out = blocked(run_id, BLOCK_MESSAGES.get(problem, BLOCK_MESSAGES["not_configured"]), problem or "not_configured")
        _record_blocked(db, out, binding, question, session_key, link, dashboard)
        yield AgentEvent(type="text", text=out.answer.plain_text())
        yield AgentEvent(type="result", extra={"envelope": out.to_dict()})
        yield AgentEvent(type="done")
        return

    report = build_report_info(dashboard, ctx)
    binding_info = binding_service.build_binding_info(
        binding, flow=flow, report=report, link_token=getattr(link, "token", ""),
        version=row.version, ctx=ctx,
    )

    # THE CEILING. `allowed_chart_ids` already exists on the tool context; this is
    # the intersection that turns it from "everything on the dashboard" into "what
    # this link declared".
    ctx.allowed_chart_ids = set(ctx.allowed_chart_ids or set()) & set(binding_info.allowed_chart_ids)
    # The row ceiling is part of the same declaration and was previously
    # unenforced: the binding said 500, the reading tool clamped to 50, and the
    # gap was invisible from both ends. Carried on the context because a tool
    # body cannot see the binding and should not learn to.
    ctx.max_rows_per_call = binding_info.capabilities.max_rows_per_call
    # The payload ceiling travels the same way, for the same reason: a tool
    # body cannot see the binding and should not learn to.
    ctx.max_result_tokens = binding_info.capabilities.max_result_tokens
    from app.services.agent_flows.permissions import run_scope

    ctx.knowledge_scope = run_scope(
        db, row, flow, binding_info.knowledge.model_dump()
    )

    fp = fingerprint(
        binding_id=binding.id, version=row.version, filters=filters or [],
        charts=binding_info.allowed_chart_ids, locale=locale,
    )
    memory, memory_notices = load_memory(
        db, session_key=session_key, token=getattr(link, "token", ""), fp=fp
    )
    contract = binding_service.contract_of(binding)

    inp = FlowInput(
        request=RequestInfo(id=run_id, at=datetime.now(timezone.utc).isoformat(), locale=locale),
        question=QuestionInfo(raw=question, normalized=question),
        conversation=ConversationInfo(
            session_key=session_key,
            history=[
                Turn(role=h.get("role", "user"), content=str(h.get("content") or ""))
                for h in (history or [])
                if h.get("role") in ("user", "assistant")
            ],
        ),
        report=report,
        filters=FiltersInfo(
            applied=[
                AppliedFilter(
                    field=str(f.get("field") or f.get("column") or ""),
                    op=str(f.get("operator") or f.get("op") or "in"),
                    values=list(f.get("values") or ([f.get("value")] if f.get("value") is not None else [])),
                    scope=str(f.get("scope") or ""),
                )
                for f in (filters or [])
                if isinstance(f, dict)
            ],
            fingerprint=fp,
        ),
        binding=binding_info,
        memory=memory,
        runtime=RuntimeInfo(
            # Coerced at the boundary. The link's stored model is nullable and the
            # envelope's types are fixed by design (L1: a field that is present
            # always has the same type) — so the None-to-"" translation belongs
            # here, once, rather than loosening the contract for every consumer.
            provider=provider or "",
            model=model or "",
            budget=BudgetEnvelope(**contract.budget.model_dump()),
        ),
    )

    recorded = False
    started = datetime.now(timezone.utc)
    try:
        async for ev in executor.run_flow(
            inp, flow=flow, ctx=ctx, api_key=api_key,
            base_system_prompt=base_system_prompt, db=db,
        ):
            if ev.type == "result":
                out = FlowOutput.model_validate(ev.extra.get("envelope"))
                out.notices = [*memory_notices, *out.notices]
                ev.extra["envelope"] = out.to_dict()
                save_memory(
                    db, session_key=session_key, token=getattr(link, "token", ""),
                    fp=fp, out=out, flow=flow,
                )
                runs_service.record(
                    db, inp=inp, out=out, brain_key=flow.key, version=row.version,
                    binding_id=binding.id,
                    store_content=bool(binding.store_question_content),
                )
                recorded = True
            yield ev
    finally:
        # A TURN THAT WAS ABANDONED IS STILL A TURN.
        #
        # Recording only on the `result` event meant a viewer who closed the tab —
        # or a client that gave up on a slow model — left NO trace at all: the Runs
        # table showed a flow nobody had used, while in fact it was being used and
        # failing. That is the exact blindness that made a real "the bot never
        # answers" report take an hour to diagnose.
        if not recorded:
            elapsed = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
            aborted = FlowOutput(
                run_id=run_id,
                status="failed",
                answer=blocked(run_id, "").answer,
                notices=[
                    *memory_notices,
                    Notice(
                        code="turn_abandoned",
                        text="Lượt hỏi kết thúc trước khi có câu trả lời — "
                             "người xem đóng trang, hoặc mô hình trả lời quá chậm.",
                    ),
                ],
            )
            aborted.usage.ms = elapsed
            runs_service.record(
                db, inp=inp, out=aborted, brain_key=flow.key, version=row.version,
                binding_id=binding.id,
                store_content=bool(binding.store_question_content),
            )


def _record_blocked(
    db: Session, out: FlowOutput, binding: Any, question: str,
    session_key: str, link: Any, dashboard: Any,
) -> None:
    """A blocked turn is still a run.

    It is in fact the most useful kind to record: "this link answered nothing 40
    times today because its binding is broken" is the row an operator needs, and
    dropping it leaves a bot that appears simply unused.
    """
    from app.services.agent_flows.envelope import BindingInfo

    inp = FlowInput(
        request=RequestInfo(id=out.run_id, at=datetime.now(timezone.utc).isoformat()),
        question=QuestionInfo(raw=question, normalized=question),
        conversation=ConversationInfo(session_key=session_key),
        report=ReportInfo(dashboard_id=int(getattr(dashboard, "id", 0) or 0)),
        binding=BindingInfo(
            id=getattr(binding, "id", 0) or 0,
            link_token=getattr(link, "token", ""),
        ),
    )
    runs_service.record(
        db, inp=inp, out=out,
        brain_key=getattr(binding, "brain_key", "") or "(none)",
        version=None, binding_id=getattr(binding, "id", None),
        store_content=bool(getattr(binding, "store_question_content", True)),
    )


# ═══ The Studio path ══════════════════════════════════════════════════════════
async def run_preview(
    db: Session,
    *,
    flow: Flow,
    version: int,
    binding: AgentFlowBinding,
    link: Any,
    dashboard: Any,
    ctx: Any,
    question: str,
    api_key: str = "",
    provider: str = "",
    model: str = "",
    base_system_prompt: str = "",
) -> AsyncGenerator[AgentEvent, None]:
    """Test the DRAFT against a real binding, as the author.

    Against a binding rather than a bare dashboard, because "does this flow work" is
    not a question about a flow — it is a question about a flow ON A LINK, and the
    two links a flow serves resolve their requirements differently.
    """
    run_id = new_run_id()
    report = build_report_info(dashboard, ctx)
    binding_info = binding_service.build_binding_info(
        binding, flow=flow, report=report,
        link_token=getattr(link, "token", ""), version=version, ctx=ctx,
    )
    ctx.allowed_chart_ids = set(ctx.allowed_chart_ids or set()) & set(binding_info.allowed_chart_ids)
    contract = binding_service.contract_of(binding)

    inp = FlowInput(
        request=RequestInfo(
            id=run_id, at=datetime.now(timezone.utc).isoformat(),
            is_test=True, trigger="studio_test",
        ),
        question=QuestionInfo(raw=question, normalized=question),
        report=report,
        binding=binding_info,
        runtime=RuntimeInfo(
            # Coerced at the boundary. The link's stored model is nullable and the
            # envelope's types are fixed by design (L1: a field that is present
            # always has the same type) — so the None-to-"" translation belongs
            # here, once, rather than loosening the contract for every consumer.
            provider=provider or "",
            model=model or "",
            budget=BudgetEnvelope(**contract.budget.model_dump()),
        ),
    )
    async for ev in executor.run_flow(
        inp, flow=flow, ctx=ctx, api_key=api_key,
        base_system_prompt=base_system_prompt, db=db,
    ):
        if ev.type == "result":
            out = FlowOutput.model_validate(ev.extra.get("envelope"))
            runs_service.record(
                db, inp=inp, out=out, brain_key=flow.key, version=version,
                # `or None`: a test on a bare report carries the sentinel id 0 in
                # the envelope (where the type is fixed), and storing that in the
                # run row would read as a binding that exists. The column is
                # nullable precisely so "no binding" can be said honestly.
                binding_id=binding.id or None, store_content=True,
            )
        yield ev
