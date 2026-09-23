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
    reader_notices,
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
                locale: str, shape: str = "", scope: dict[str, Any] | None = None) -> str:
    """What invalidates a session's memory.

    Change the filters, the version, the allowed charts or the language, and every
    fact derived under the old ones is stale. One hash rather than per-fact
    reasoning: cheap, and impossible to get subtly wrong per variable.

    `shape` exists for the studio. A viewer's session runs one published version, so
    the version number is enough to notice a change; an author's test session runs a
    DRAFT they are editing under a version number that does not move. Without this,
    editing the step you are testing and re-running reused the old step's output as
    "still valid" — the silent skip, arrived at from the other direction.

    `scope` exists for direct chat, where the READER has rights of their own and they
    can be revoked mid-conversation. A fact established while a document was readable
    must not be recalled after the grant behind it is gone — that is a leak with a
    delay on it. The tool-result cache already keys on the knowledge scope for
    exactly this reason; memory is the same argument with a longer lifetime.

    Both default to nothing, so the hash a public link computes is byte-identical to
    what it computed before either existed. That matters on deploy day: a changed
    input here would reset every live session's memory at once.
    """
    payload = json.dumps(
        {
            "b": binding_id,
            "v": version,
            "f": sorted(json.dumps(f, sort_keys=True, default=str) for f in (filters or [])),
            "c": sorted(charts or []),
            "l": locale,
            "s": shape,
            **({"k": json.dumps(scope, sort_keys=True, default=str)} if scope else {}),
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def flow_shape(flow: Flow) -> str:
    """A hash of the flow as configured. Changes when the author changes anything.

    Only the studio uses it. Serialising the whole flow is the point: a narrower
    signature (node keys, or node count) would miss the edit that matters most —
    rewriting the prompt of the very step you are re-testing — and leave its
    previous output in session memory marked reusable.
    """
    try:
        body = flow.model_dump(mode="json") if hasattr(flow, "model_dump") else {}
    except Exception:  # noqa: BLE001 — a fingerprint must never fail a run
        return ""
    return hashlib.sha256(
        json.dumps(body, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def studio_token(brain_key: str) -> str:
    """The session store's owner for an author's test.

    `load_memory` refuses a session whose stored token differs from the caller's,
    which is what keeps one browser tab from carrying facts between two public
    links. A studio test has no link, so it gets its own token rather than an empty
    one: distinct from every real token, so a test session can never be read on a
    link and a link's session can never be read here.
    """
    return f"studio:{brain_key}"[:200]


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
    # AND THE TWO THAT WERE LEFT OUT OF THIS BLOCK. `read_rows` was read in one
    # place in the whole codebase — the report-read node — so a tool granted to an
    # agent step ignored it entirely; `web_search` was checked when the schema was
    # built but not when a call arrived. Both now reach the registry's call-time
    # gate by the same route as the two above.
    ctx.read_rows = binding_info.capabilities.read_rows
    ctx.web_search = binding_info.capabilities.web_search
    from app.services.agent_flows.permissions import chart_scope, run_scope

    ctx.knowledge_scope = run_scope(
        db, row, flow, binding_info.knowledge.model_dump()
    )
    # AND ALSO THESE. The line above is the report the viewer is on; this one is
    # what its author attached on top of it — the only way a bot flow reaches past
    # a single report, and the thing that lets `search_business_assets` answer
    # "which report shows this" rather than "the one you are looking at".
    #
    # A UNION, deliberately, and it does not escape the ceiling: every dataset here
    # already survived owner ∩ flow ∩ link inside `run_scope`, so a link that
    # narrows its knowledge contract narrows these charts with it. It is also never
    # automatic — a flow that attached no dataset reaches no extra charts, which
    # was every flow in this deployment when the union was written.
    #
    # `adopt_scope` rather than a plain assignment, because the added charts are
    # not on this report: their names and their column-hiding rules come from the
    # charts and datasets themselves, not from the dashboard's tiles.
    ctx.adopt_scope(
        set(ctx.allowed_chart_ids or set()) | chart_scope(db, ctx.knowledge_scope),
        ctx.knowledge_scope.get("dataset_ids") or [],
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
                # READER BOUNDARY — ON THE WAY OUT ONLY.
                #
                # What is SENT drops author diagnostics; what is RECORDED keeps
                # them. Filtering before `record` stored the reader's copy, so a
                # flow's real viewer traffic left no diagnostics in Runs at all —
                # an author saw them only for questions they asked themselves,
                # which is the opposite of where they are needed.
                ev.extra["envelope"] = out.to_dict(notices=reader_notices(out.notices))
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
def _studio_input(
    *,
    run_id: str,
    question: str,
    history: list[dict] | None,
    session_key: str,
    report: Any,
    binding_info: Any,
    memory: Any,
    contract: Any,
    provider: str,
    model: str,
) -> FlowInput:
    """The ENVELOPE a studio turn runs on — one definition, two callers.

    It takes the parts rather than computing them, because the two callers differ
    legitimately in how the parts are obtained: a test loads session memory and
    carries the link's token, a preview has neither. What must NOT differ is the
    envelope itself. A preview assembled from a second definition would describe a
    run that does not happen, and "what the AI sees" is the one screen that may not
    be approximately right.

    The first version of this function computed the parts too, and `run_preview`
    went on building its own envelope beside it — a second definition shipped under
    a docstring promising there was only one. Taking the parts is what makes the
    sharing real instead of asserted.
    """
    turns = [
        Turn(role=h.get("role", "user"), content=str(h.get("content") or ""))
        for h in (history or [])
        if isinstance(h, dict) and h.get("role") in ("user", "assistant")
    ]
    return FlowInput(
        request=RequestInfo(
            id=run_id, at=datetime.now(timezone.utc).isoformat(),
            is_test=True, trigger="studio_test",
        ),
        question=QuestionInfo(
            raw=question, normalized=question, turn_index=len(turns) // 2),
        conversation=ConversationInfo(session_key=session_key, history=turns),
        report=report,
        binding=binding_info,
        memory=memory or MemoryInfo(),
        runtime=RuntimeInfo(
            # Coerced at the boundary. The link's stored model is nullable and the
            # envelope's types are fixed by design (L1: a field that is present
            # always has the same type) — so the None-to-"" translation belongs
            # here, once, rather than loosening the contract for every consumer.
            provider=provider or "", model=model or "",
            budget=BudgetEnvelope(**contract.budget.model_dump()),
        ),
    )


# Deliberately NOT async: this awaits nothing. It assembles inputs and returns
# them, and marking it async would promise a suspension point that does not
# exist — which is how the endpoint first shipped returning a coroutine.
def preview_step(
    *,
    flow: Flow,
    version: int,
    node_key: str,
    binding: AgentFlowBinding,
    dashboard: Any,
    ctx: Any,
    question: str,
    history: list[dict] | None = None,
    provider: str = "",
    model: str = "",
    base_system_prompt: str = "",
) -> dict:
    """What ONE step will hand the model, for a question the author types.

    NOTHING IS CALLED AND NOTHING IS SPENT. This assembles the inputs and stops —
    no provider, no tools, no warehouse. That is the point: an author checking
    "will this step see what I think it sees" should not have to pay for an answer
    to find out, and should not have to read the answer backwards to guess.

    It is built on the SAME envelope `run_preview` builds, through the same
    binding_service calls, because a preview assembled a second way would describe
    a run that does not exist. The one thing it does differently is stop early.
    """
    from app.services.agent_flows.runtime import executor
    from app.services.agent_flows.runtime.handlers import agent as agent_handler
    from app.services.agent_flows.runtime.state import Budget, RunState

    node = flow.node(node_key)
    if node is None:
        raise ValueError(f"không có bước '{node_key}' trong flow này")
    if getattr(node, "type", "") != "agent":
        raise ValueError("chỉ bước AI mới có prompt để xem trước")

    report = build_report_info(dashboard, ctx)
    binding_info = binding_service.build_binding_info(
        binding, flow=flow, report=report, link_token="", version=version, ctx=ctx,
    )
    # The intersection is "what the LINK declared", so it only applies when there
    # is one. On the chat surface there is no link and no report: the scope was
    # already set from what the flow attached, and narrowing it by an allowlist
    # that describes a report would empty it — showing the author a step that can
    # reach nothing, on the exact screen they opened to find out what it reaches.
    if dashboard is not None:
        ctx.allowed_chart_ids = (
            set(ctx.allowed_chart_ids or set()) & set(binding_info.allowed_chart_ids)
        )
    inp = _studio_input(
        run_id=new_run_id(), question=question, history=history, session_key="",
        report=report, binding_info=binding_info, memory=None,
        contract=binding_service.contract_of(binding),
        provider=provider, model=model,
    )
    state = RunState(
        vars=inp.seed_vars(),
        budget=Budget(
            max_llm_calls=inp.runtime.budget.max_llm_calls,
            max_tool_calls=inp.runtime.budget.max_tool_calls,
            max_seconds=inp.runtime.budget.max_seconds,
        ),
    )
    rctx = executor.RunContext(
        inp=inp, flow=flow, ctx=ctx, api_key="",
        base_system_prompt=base_system_prompt,
        answer_key=flow.answering_key(), db=None,
    )
    out = agent_handler.preview(node, state, rctx)
    # EARLIER STEPS HAVE NOT RUN, and the preview must not imply they have. A step
    # that reads `{{dashboard_context}}` shows the placeholder unresolved here, and
    # saying so is more useful than silently rendering an empty block — the author
    # would read the gap as "this step gets nothing" rather than "this comes from
    # the step above, at run time".
    upstream = [
        n.output_var for n in flow.all_nodes()
        if getattr(n, "output_var", "") and n.key != node_key
    ]
    out["pending_upstream"] = sorted({v for v in upstream if v})
    return out


async def run_preview(
    db: Session,
    *,
    flow: Flow,
    version: int,
    binding: AgentFlowBinding,
    link: Any,
    dashboard: Any,
    ctx: Any,
    #: The flow's stored row. Optional only so older callers keep working; pass it,
    #: because it is what lets a test read the SAME knowledge a run reads. Without
    #: it `ctx.knowledge_scope` is never set, and an unset scope does not mean
    #: "nothing" — on a report it falls through to everything that report may read,
    #: which is WIDER than the live ceiling, and on the chat surface it falls
    #: through to nothing at all, which is narrower. Both make the Test panel
    #: describe a run that does not happen.
    brain_row: Any = None,
    question: str,
    session_key: str = "",
    history: list[dict] | None = None,
    api_key: str = "",
    provider: str = "",
    model: str = "",
    base_system_prompt: str = "",
) -> AsyncGenerator[AgentEvent, None]:
    """Test the DRAFT against a real binding, as the author.

    Against a binding rather than a bare dashboard, because "does this flow work" is
    not a question about a flow — it is a question about a flow ON A LINK, and the
    two links a flow serves resolve their requirements differently.

    ONE QUESTION WAS NEVER A TEST OF A FLOW.
    This used to take a question and nothing else, and that quietly put half the
    authoring surface out of reach. `context_policy: last_3` has nothing to read
    without history. `run_policy: once_per_session` cannot be observed reusing
    anything on a first turn. A `memory_delta` cannot be seen surviving into a turn
    that does not exist. So an author could configure all three, watch a single
    question answer correctly, and ship a flow whose second turn behaved in a way
    nothing in the studio had ever shown them.

    The session is the SAME machinery a viewer gets — `load_memory` / `save_memory`
    over the server-owned store — because a test that exercises a different
    mechanism proves nothing about the one that runs. It differs in exactly two
    places, both deliberate: the store is owned by a `studio:` token so a test
    session and a link session can never read each other, and the fingerprint
    includes the flow's shape so editing the step you are testing does not leave the
    old step's output behind as "still valid".
    """
    run_id = new_run_id()
    report = build_report_info(dashboard, ctx)
    binding_info = binding_service.build_binding_info(
        binding, flow=flow, report=report,
        link_token=getattr(link, "token", ""), version=version, ctx=ctx,
    )
    if brain_row is not None:
        from app.services.agent_flows.permissions import run_scope as _run_scope

        ctx.knowledge_scope = _run_scope(
            db, brain_row, flow, binding_info.knowledge.model_dump()
        )

    ctx.allowed_chart_ids = set(ctx.allowed_chart_ids or set()) & set(binding_info.allowed_chart_ids)
    # THE SAME ADDON THE LIVE LINK GETS, so the Test button answers the question an
    # author is actually asking it. Without this, attaching a dataset changed what a
    # viewer could reach and changed nothing in the panel the author checks it in —
    # and the honest reading of that gap is "the attachment did not work".
    #
    # Taken from the contract rather than re-derived: this path's contract is
    # `knowledge.mode = flow_all`, so it already lists exactly what the flow
    # attached, and the author testing is the owner whose rights those are.
    from app.services.agent_flows.permissions import chart_scope as _chart_scope

    _attached = list(binding_info.knowledge.dataset_ids or [])
    if _attached:
        ctx.adopt_scope(
            set(ctx.allowed_chart_ids or set())
            | _chart_scope(db, {"dataset_ids": _attached}),
            _attached,
        )
    contract = binding_service.contract_of(binding)

    turns = [
        Turn(role=h.get("role", "user"), content=str(h.get("content") or ""))
        for h in (history or [])
        if isinstance(h, dict) and h.get("role") in ("user", "assistant")
    ]
    token = studio_token(flow.key)
    fp = fingerprint(
        binding_id=binding.id or 0, version=version, filters=[],
        charts=binding_info.allowed_chart_ids, locale="vi",
        shape=flow_shape(flow),
    )
    memory, memory_notices = load_memory(db, session_key=session_key, token=token, fp=fp)

    inp = _studio_input(
        run_id=run_id, question=question, history=history, session_key=session_key,
        report=report, binding_info=binding_info, memory=memory, contract=contract,
        provider=provider, model=model,
    )
    async for ev in executor.run_flow(
        inp, flow=flow, ctx=ctx, api_key=api_key,
        base_system_prompt=base_system_prompt, db=db,
    ):
        if ev.type == "result":
            out = FlowOutput.model_validate(ev.extra.get("envelope"))
            # A memory notice explains an answer that would otherwise look
            # unexplained ("I recalculated from scratch"), and the author needs to
            # see it for the same reason the viewer does — more so, since in the
            # studio it usually means their own edit invalidated the session.
            out.notices = [*memory_notices, *out.notices]
            ev.extra["envelope"] = out.to_dict()
            if session_key:
                save_memory(db, session_key=session_key, token=token, fp=fp, out=out, flow=flow)
            row_id = runs_service.record(
                db, inp=inp, out=out, brain_key=flow.key, version=version,
                # `or None`: a test on a bare report carries the sentinel id 0 in
                # the envelope (where the type is fixed), and storing that in the
                # run row would read as a binding that exists. The column is
                # nullable precisely so "no binding" can be said honestly.
                binding_id=binding.id or None, store_content=True,
            )
            # The row id, not the envelope's `run_id`. They are different keys for
            # the same run: the envelope carries a generated string, the Runs tab
            # addresses a row (`?run=193`). This test was just written to history —
            # handing back the id is what lets the author open its full trace
            # instead of re-reading the summary the dialog has room for.
            if row_id:
                ev.extra["run_row_id"] = row_id
        yield ev


# ═══ The direct-chat path ═════════════════════════════════════════════════════
def chat_base_prompt(ctx: Any, *, max_tool_calls: int = 8) -> str:
    """The shared base prompt for a step running with no report.

    IT WAS NOT BEING BUILT AT ALL. `chat_api` calls `run_for_chat_thread` without
    one, so `base_system_prompt` defaulted to `""` and every chat step ran with no
    base — no citation contract, no answer-in-the-viewer's-language rule, no
    analysis guardrails. Those are exactly the rules that stop an answer inventing
    a figure, and Chat was the one surface running without them.

    The builder's preview panel meanwhile DID build one, so it showed authors a
    base prompt the run never received — and the report-flavoured base at that,
    which opens "You are an AI Data Analyst embedded in a published BI dashboard".
    Two different wrong answers to the same question; this is the one answer.

    `surface="chat"` swaps only the opening and the context block. Everything after
    them holds on either surface and is not duplicated.
    """
    from app.services.dashboard_ai_bot.thinking.prompts import build_agent_system_prompt

    return build_agent_system_prompt(
        dashboard_name="",
        dashboard_description=None,
        chart_count=len(getattr(ctx, "allowed_chart_ids", None) or []),
        filters_applied=[],
        max_tool_calls=max_tool_calls,
        # A flow grants tools per NODE, so the prose narration is both a duplicate
        # of the API's `tools` field and wrong for every node holding fewer tools
        # than the product has. Same reason the link path drops it.
        include_tools=False,
        surface="chat",
    )


async def run_for_chat_thread(
    db: Session,
    *,
    thread_id: int,
    user_id: Any,
    ctx: Any,
    question: str,
    history: list[dict] | None = None,
    api_key: str = "",
    provider: str = "",
    model: str = "",
    base_system_prompt: str = "",
    locale: str = "vi",
) -> AsyncGenerator[AgentEvent, None]:
    """One turn of a signed-in user talking to a flow, with no report and no link.

    TAKES IDS, NOT ORM OBJECTS, and reloads both here. A streaming response runs its
    body AFTER the request's dependencies have been torn down, so `get_db` has
    already called `Session.close()` by the time this generator starts — which
    DETACHES every instance the endpoint had loaded. A detached instance is readable
    only while its attributes are still populated, and any `commit()` before the
    stream (recording the thread as active, say) expires them all. The result is a
    `DetachedInstanceError` on the first attribute read, from a line that merely says
    `thread.brain_key`. Reloading inside the generator sidesteps the whole class of
    bug: the session reopens a transaction on first use and everything read from here
    is bound to it.

    THE SAME ENGINE, A DIFFERENT CEILING. Everything downstream of the envelope is
    byte-for-byte the public path. What differs is assembled here, and only here:

      report      the `dashboard_id=0` sentinel. Not a stub Dashboard row — a fake
                  one would make every report-reading tool believe it had something
                  to read and answer from an empty result instead of refusing.
      binding     ephemeral, `id=0`, never saved. Charts are an explicit empty
                  allowlist, so `assert_chart_in_scope` refuses every id.
      scope       `run_scope` — the SAME delegation the public path uses. Being
                  shared the assistant is the whole gate; what it reads was decided
                  by its author, and `share_disclosure()` says so when it is shared.
      actor       `CHAT_USER`, set by the caller. It no longer changes what may be
                  READ — it marks who is driving, which is what keeps `remember_fact`
                  from letting a reader rewrite what the assistant knows, and what
                  keeps one reader's cached tool results from serving another.
      permission  re-resolved every turn (`resolve_for_chat`), so an unshared flow,
                  an unpublished one, or one that has since grown a `report_read`
                  step stops the NEXT question rather than the next thread.
    """
    from app.models.user import User
    from app.services.agent_flows import direct_chat
    from app.services.agent_flows.permissions import chart_scope, run_scope

    run_id = new_run_id()
    user = db.query(User).filter(User.id == user_id).first()
    thread = direct_chat.get_thread(db, user, thread_id) if user is not None else None
    if user is None or thread is None:
        # Deleted, or the account went away, between the request being accepted and
        # the stream starting. Nothing to record it against, so it is said and dropped.
        out = blocked(run_id, direct_chat.BLOCK_MESSAGES["not_published"], "not_published")
        yield AgentEvent(type="text", text=out.answer.plain_text())
        yield AgentEvent(type="result", extra={"envelope": out.to_dict()})
        yield AgentEvent(type="done")
        return

    # MAY THIS PERSON ADD TO THIS CONVERSATION? Separate from whether they may
    # read it: a conversation shared at `view` is a transcript to look at, and a
    # reader typing into it would be writing in somebody else's record.
    if direct_chat.thread_access(db, user, thread) not in ("owner", "edit", "full"):
        out = blocked(
            run_id,
            "Cuộc trò chuyện này được chia sẻ cho bạn ở mức chỉ đọc.",
            "thread_read_only",
        )
        yield AgentEvent(type="text", text=out.answer.plain_text())
        yield AgentEvent(type="result", extra={"envelope": out.to_dict()})
        yield AgentEvent(type="done")
        return

    direct_chat.touch(db, thread, title_from=question)
    # AND MAY THEY USE THE ASSISTANT? Checked against the FLOW's own share, not the
    # conversation's — which is what stops handing somebody a conversation from
    # becoming a way around who may run the flow behind it.
    row, flow, problem = direct_chat.resolve_for_chat(db, user, thread.brain_key)

    if problem or flow is None or row is None:
        out = blocked(
            run_id,
            direct_chat.BLOCK_MESSAGES.get(
                problem, direct_chat.BLOCK_MESSAGES["not_published"]
            ),
            problem or "not_published",
        )
        _record_chat_blocked(db, out, thread, question)
        yield AgentEvent(type="text", text=out.answer.plain_text())
        yield AgentEvent(type="result", extra={"envelope": out.to_dict()})
        yield AgentEvent(type="done")
        return

    report = ReportInfo(dashboard_id=0)
    binding = direct_chat.ephemeral_chat_binding(flow)
    binding_info = binding_service.build_binding_info(
        binding, flow=flow, report=report, link_token="", version=row.version, ctx=ctx,
    )

    ctx.max_rows_per_call = binding_info.capabilities.max_rows_per_call
    ctx.max_result_tokens = binding_info.capabilities.max_result_tokens
    # The chat surface declares `read_rows=False`, and until now nothing read it.
    ctx.read_rows = binding_info.capabilities.read_rows
    ctx.web_search = binding_info.capabilities.web_search
    ctx.knowledge_scope = run_scope(db, row, flow, binding_info.knowledge.model_dump())
    # THE CHARTS THIS ASSISTANT WAS GRANTED — derived from the knowledge scope, not
    # from a link. A chat flow that attached no dataset still measures nothing, so
    # attaching remains the gate; what changed is that attaching now opens it.
    #
    # `adopt_scope` rather than a plain assignment: with no dashboard this context
    # also has no chart NAMES and no column-exclusion rules, and a catalogue of
    # charts called "Chart 412" is one no question can match.
    ctx.adopt_scope(
        chart_scope(db, ctx.knowledge_scope),
        ctx.knowledge_scope.get("dataset_ids") or [],
    )
    # Built HERE, not by the caller, because it needs the chart count and the scope
    # is only known once `adopt_scope` has run. A caller may still override it.
    base_system_prompt = base_system_prompt or chat_base_prompt(ctx)

    fp = fingerprint(
        binding_id=0, version=row.version, filters=[], charts=[], locale=locale,
        scope=ctx.knowledge_scope,
    )
    token = direct_chat.session_token(thread.id)
    memory, memory_notices = load_memory(
        db, session_key=thread.session_key, token=token, fp=fp
    )
    contract = binding_service.contract_of(binding)

    turns = [
        Turn(role=h.get("role", "user"), content=str(h.get("content") or ""))
        for h in (history or [])
        if isinstance(h, dict) and h.get("role") in ("user", "assistant")
    ]

    inp = FlowInput(
        request=RequestInfo(
            id=run_id, at=datetime.now(timezone.utc).isoformat(),
            locale=locale, trigger="direct_chat",
        ),
        question=QuestionInfo(raw=question, normalized=question, turn_index=len(turns) // 2),
        conversation=ConversationInfo(session_key=thread.session_key, history=turns),
        report=report,
        filters=FiltersInfo(fingerprint=fp),
        binding=binding_info,
        memory=memory,
        runtime=RuntimeInfo(
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
                # READER BOUNDARY — ON THE WAY OUT ONLY.
                #
                # What is SENT drops author diagnostics; what is RECORDED keeps
                # them. Filtering before `record` stored the reader's copy, so a
                # flow's real viewer traffic left no diagnostics in Runs at all —
                # an author saw them only for questions they asked themselves,
                # which is the opposite of where they are needed.
                ev.extra["envelope"] = out.to_dict(notices=reader_notices(out.notices))
                save_memory(
                    db, session_key=thread.session_key, token=token,
                    fp=fp, out=out, flow=flow,
                )
                runs_service.record(
                    db, inp=inp, out=out, brain_key=flow.key, version=row.version,
                    binding_id=None, chat_thread_id=thread.id, store_content=True,
                )
                recorded = True
            yield ev
    finally:
        # An abandoned turn is still a turn — and here it is also a LOST MESSAGE.
        # On a public link this row is telemetry; in a chat the content row IS the
        # transcript, so failing to write it means the user watched an answer arrive
        # and then found the thread empty.
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
                             "bạn đã rời trang, hoặc mô hình trả lời quá chậm.",
                    ),
                ],
            )
            aborted.usage.ms = elapsed
            runs_service.record(
                db, inp=inp, out=aborted, brain_key=flow.key, version=row.version,
                binding_id=None, chat_thread_id=thread.id, store_content=True,
            )


def _record_chat_blocked(db: Session, out: FlowOutput, thread: Any, question: str) -> None:
    """A refused chat turn is still a turn, and it is the one worth having: "this
    flow answered nothing for a week because its share was revoked" is invisible
    otherwise."""
    from app.services.agent_flows.envelope import BindingInfo

    inp = FlowInput(
        request=RequestInfo(
            id=out.run_id, at=datetime.now(timezone.utc).isoformat(),
            trigger="direct_chat",
        ),
        question=QuestionInfo(raw=question, normalized=question),
        conversation=ConversationInfo(session_key=thread.session_key or ""),
        report=ReportInfo(dashboard_id=0),
        binding=BindingInfo(id=0),
    )
    runs_service.record(
        db, inp=inp, out=out, brain_key=thread.brain_key or "(none)",
        version=None, binding_id=None, chat_thread_id=thread.id, store_content=True,
    )
