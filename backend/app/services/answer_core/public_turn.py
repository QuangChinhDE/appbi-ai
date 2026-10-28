"""A public Dashboard AI Bot turn: the Answer Core, for a viewer of a public link.

PO directive (2026-10-28): the public bot is a CONSUMER of the one Answer Core
(services/data_core/service.ask), exactly as AI Chat is. It needs no Agent Flow:
a link with the bot enabled answers BI questions about its published report as
soon as a model credential and budget exist. A bound flow is an optional add-on
the Core may call for documents (services/answer_core/link_extension.py); it never
writes the answer and never reads data.

  begin()   admission BEFORE anything is spent: question size, a retried submit
            (same idempotency key) is the same turn, one running turn per viewer
            conversation, the link's running-turn and budget pre-checks (fail
            closed) - then the turn row is written `running`.
  run()     the Core in a worker thread with its own session, over the link's
            PublishedReportScope, under the link's billing (Model Gateway: the
            link's own encrypted key if it has one, else the server's; the
            link's USD ceiling); then, only if `extension.decide` says so, the
            link's flow as a documents-only add-on; then the ONE terminal write.
  cancel()  the viewer stops it: the same conditional write.

The terminal write is `UPDATE ... WHERE status = 'running'`: whatever wins is what
the viewer's stream, a refresh and a retry all see.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.ai_runtime import PublicAnswerTurn
from app.services.answer_core import guided_analysis, publisher_guide
from app.services.chat import envelope as env
from app.services.data_core.intent import is_followup

logger = logging.getLogger("app.public_answer")

MAX_QUESTION = 2000
MAX_RUNNING_PER_LINK = 8


class TurnRejected(Exception):
    def __init__(self, status_code: int, detail: Any):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


@dataclass
class PublicTurnRequest:
    question: str
    conversation_key: str
    idempotency_key: str
    page_id: Optional[str] = None
    viewer_filters: list = field(default_factory=list)
    follow_up: bool = True
    choice_token: Optional[str] = None
    extension: str = "auto"


@dataclass
class LinkTurnContext:
    """What a worker needs about the link, re-resolved on ITS session each time."""

    ctx: Any                 # the link's ToolContext (agent_flows.tools.context)
    appearance: dict
    flow_key: Optional[str] = None


#: (db) -> LinkTurnContext - the public router resolves the token, password
#: session, expiry, revocation and published tiles on the session it is given.
Resolver = Callable[[Session], LinkTurnContext]


def _session() -> Session:
    from app.core.database import SessionLocal

    return SessionLocal()


def _by_key(db: Session, link_id: int, key: str) -> Optional[PublicAnswerTurn]:
    return db.query(PublicAnswerTurn).filter(PublicAnswerTurn.link_id == link_id,
                                             PublicAnswerTurn.idempotency_key == key).first()


def _clean_key(value: str, name: str) -> str:
    v = str(value or "").strip()
    if not (8 <= len(v) <= 64) or not all(c.isalnum() or c in "-_" for c in v):
        raise TurnRejected(422, f"{name} không hợp lệ.")
    return v


# ── admission ────────────────────────────────────────────────────────────────

def begin(db: Session, *, link_id: int, token: str, appearance: dict,
          req: PublicTurnRequest) -> tuple[PublicAnswerTurn, bool]:
    """(turn, replayed)."""
    from app.services.dashboard_ai_bot.budget import check_budget

    question = " ".join(str(req.question or "").split())
    if not question:
        raise TurnRejected(422, "Hãy nhập câu hỏi.")
    if len(question) > MAX_QUESTION:
        raise TurnRejected(422, f"Câu hỏi dài quá {MAX_QUESTION} ký tự.")
    conversation_key = _clean_key(req.conversation_key, "conversation_key")
    idem = _clean_key(req.idempotency_key, "idempotency_key")
    existing = _by_key(db, link_id, idem)
    if existing is not None:
        if existing.conversation_key != conversation_key:
            raise TurnRejected(409, "Mã gửi này đã được dùng.")
        return existing, True

    if db.get_bind().dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"public_answer:{link_id}"})
    expire_stale(db, link_id)
    if db.query(PublicAnswerTurn.id).filter(PublicAnswerTurn.link_id == link_id,
                                             PublicAnswerTurn.conversation_key == conversation_key,
                                             PublicAnswerTurn.status == "running").first():
        db.rollback()
        raise TurnRejected(409, "Câu hỏi trước vẫn đang chạy; hãy chờ hoặc bấm Dừng.")
    running = (db.query(func.count(PublicAnswerTurn.id))
               .filter(PublicAnswerTurn.link_id == link_id, PublicAnswerTurn.status == "running").scalar() or 0)
    if running >= MAX_RUNNING_PER_LINK:
        db.rollback()
        raise TurnRejected(429, "Trợ lý AI của báo cáo này đang bận; bạn thử lại sau ít phút nhé.")
    verdict = check_budget(db, token=token, appearance_config=appearance)
    if not verdict.allowed:
        db.rollback()
        raise TurnRejected(429, verdict.message)

    turn = PublicAnswerTurn(link_id=link_id, conversation_key=conversation_key, turn_id=uuid.uuid4().hex,
                            idempotency_key=idem, question=question[:MAX_QUESTION], status="running")
    db.add(turn)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _by_key(db, link_id, idem)
        if existing is None or existing.conversation_key != conversation_key:
            raise TurnRejected(409, "Mã gửi này đã được dùng.")
        return existing, True
    db.refresh(turn)
    return turn, False


def expire_stale(db: Session, link_id: int, minutes: int = 10) -> None:
    """A turn left `running` by a crashed worker is not running: it failed."""
    try:
        (db.query(PublicAnswerTurn)
         .filter(PublicAnswerTurn.link_id == link_id, PublicAnswerTurn.status == "running",
                 PublicAnswerTurn.created_at < func.now() - text(f"interval '{int(minutes)} minutes'"))
         .update({PublicAnswerTurn.status: "failed",
                  PublicAnswerTurn.envelope: env.failed("interrupted", "Câu hỏi bị gián đoạn; hãy hỏi lại."),
                  PublicAnswerTurn.finished_at: func.now()}, synchronize_session=False))
    except Exception:  # noqa: BLE001 - sqlite in unit tests has no interval; nothing to expire there
        db.rollback()


def is_running(turn_id: str) -> bool:
    db = _session()
    try:
        return db.query(PublicAnswerTurn.status).filter(PublicAnswerTurn.turn_id == turn_id).scalar() == "running"
    finally:
        db.close()


def finish(db: Session, turn_id: str, envelope: dict, *, plan: Optional[dict], usd: float) -> bool:
    n = (db.query(PublicAnswerTurn)
         .filter(PublicAnswerTurn.turn_id == turn_id, PublicAnswerTurn.status == "running")
         .update({PublicAnswerTurn.status: envelope.get("status") or "failed", PublicAnswerTurn.envelope: envelope,
                  PublicAnswerTurn.plan: plan, PublicAnswerTurn.usd: usd,
                  PublicAnswerTurn.finished_at: func.now()}, synchronize_session=False))
    db.commit()
    return bool(n)


def cancel(db: Session, *, link_id: int, turn_id: str, conversation_key: str) -> dict:
    t = db.query(PublicAnswerTurn).filter(PublicAnswerTurn.turn_id == turn_id,
                                          PublicAnswerTurn.link_id == link_id).first()
    if t is None or t.conversation_key != str(conversation_key or ""):
        raise TurnRejected(404, "Không tìm thấy câu hỏi.")
    if t.status != "running":
        return {"cancelled": False, "status": t.status}
    done = finish(db, turn_id, env.cancelled(), plan=None, usd=0.0)
    return {"cancelled": done, "status": "cancelled" if done else t.status}


def view(db: Session, *, link_id: int, turn_id: str, conversation_key: str) -> dict:
    t = db.query(PublicAnswerTurn).filter(PublicAnswerTurn.turn_id == turn_id,
                                          PublicAnswerTurn.link_id == link_id).first()
    if t is None or t.conversation_key != str(conversation_key or ""):
        raise TurnRejected(404, "Không tìm thấy câu hỏi.")
    return {"turn_id": t.turn_id, "status": t.status, "question": t.question, "rating": t.rating,
            "envelope": env.normalize(t.envelope, t.status) if t.envelope else None}


RATEABLE = ("answered", "clarification_required")


def rate(db: Session, *, link_id: int, turn_id: str, conversation_key: str, rating: str) -> dict:
    """The viewer's verdict on one answer of THEIR conversation: up or down, one
    current verdict, never cleared (frontend lib/readerRating.ts). A turn that
    failed, was cancelled or is still running holds no answer to rate."""
    if rating not in ("up", "down"):
        raise TurnRejected(422, "rating must be up or down")
    t = db.query(PublicAnswerTurn).filter(PublicAnswerTurn.turn_id == turn_id,
                                          PublicAnswerTurn.link_id == link_id).first()
    if t is None or t.conversation_key != str(conversation_key or ""):
        raise TurnRejected(404, "Không tìm thấy câu hỏi.")
    if t.status not in RATEABLE:
        raise TurnRejected(409, "Câu hỏi này không có câu trả lời để đánh giá.")
    t.rating = rating
    db.commit()
    return {"turn_id": t.turn_id, "rating": t.rating}


def _previous_plan(db: Session, link_id: int, conversation_key: str, turn_id: str) -> Optional[dict]:
    t = (db.query(PublicAnswerTurn)
         .filter(PublicAnswerTurn.link_id == link_id, PublicAnswerTurn.conversation_key == conversation_key,
                 PublicAnswerTurn.status == "answered", PublicAnswerTurn.turn_id != turn_id,
                 PublicAnswerTurn.plan.isnot(None))
         .order_by(PublicAnswerTurn.created_at.desc()).first())
    return t.plan if t is not None and isinstance(t.plan, dict) else None


# ── the turn ─────────────────────────────────────────────────────────────────

def for_viewer(e: dict) -> dict:
    """What a public viewer receives: the Core's answer, without anything only a
    signed-in surface uses (save/edit affordances, the internal plan)."""
    data = e.get("data")
    if isinstance(data, dict):
        data = {k: v for k, v in data.items() if k not in ("plan", "chart_draft", "can_save",
                                                           "chart_draft_unavailable", "consent_available")}
        e = {**e, "data": data}
    return e


def _core(link_id: int, turn_id: str, req: PublicTurnRequest, resolve: Resolver,
          on_step: Callable[[dict], None]) -> tuple[dict, Optional[dict], Optional[str], dict]:
    """The Answer Core over the link's published report, in a worker thread with its
    own session. Returns (envelope, plan, add-on flow key, appearance)."""
    from app.services.ai_runtime import gateway
    from app.services.answer_core.published_report import PublishedReportScope
    from app.services.chat.orchestrator import SOURCE_UNAVAILABLE, _is_source_error
    from app.services.dashboard_ai_bot.budget import resolve_usd_limit
    from app.services.data_core.service import TurnStopped, ask

    db = _session()
    try:
        try:
            link = resolve(db)
        except Exception as ex:  # noqa: BLE001 - the link closed/expired between admission and run
            logger.info("[public_answer] link unavailable for turn %s: %s", turn_id, type(ex).__name__)
            return env.refused("link_unavailable", "Liên kết báo cáo không còn hiệu lực."), None, None, {}
        scope = PublishedReportScope(db, ctx=link.ctx, link_id=link_id, turn_id=turn_id, page_id=req.page_id)
        # the publisher's prompt: a glossary for the planner, the guide of the analysis
        instructions = str((link.appearance or {}).get("ai_bot_report_context_note") or "").strip() or None
        scope.notes = instructions
        # the publisher's structured guide: what code can answer, code answers (no model)
        guide = publisher_guide.load(link.appearance)
        scope.guide = guide
        knows = bool(instructions) or guide is not None
        topic = publisher_guide.out_of_scope(guide, req.question)
        if topic is not None:
            return (env.refused("guide_out_of_scope", topic.reason or
                                f"Trợ lý của báo cáo này không trả lời về “{topic.topic}”."),
                    None, link.flow_key, link.appearance)
        meaning = publisher_guide.definition(guide, req.question)
        if meaning is not None:
            return env.with_definition(meaning.model_dump()), None, link.flow_key, link.appearance
        # the viewer's client sends every message as a possible follow-up; it refines the
        # previous answer only when it says so (`intent.is_followup`), else it is new
        follow_up = req.follow_up and is_followup(req.question)
        previous = _previous_plan(db, link_id, req.conversation_key, turn_id) if follow_up else None
        bill = gateway.Billing(purpose="public_core", link_id=link_id,
                               link_usd_per_day=resolve_usd_limit(link.appearance), turn_ref=turn_id,
                               credential=gateway.link_credential(db, link.appearance))
        if bill.credential is None:  # the publisher's key and model; never the server's
            return (env.failed("model_unavailable", "Trợ lý AI của báo cáo này chưa được cấu hình mô hình AI."),
                    None, link.flow_key, link.appearance)
        try:
            with gateway.billing(bill):
                core = ask(db, None, req.question, None, scope=scope, previous=previous, turn_id=turn_id,
                           choice_token=req.choice_token, on_step=on_step,
                           should_stop=lambda: not is_running(turn_id))
        except TurnStopped:
            return env.cancelled(), None, link.flow_key, link.appearance
        except gateway.AiPolicyRefused as refused:
            return env.refused(refused.code, refused.message_vi), None, link.flow_key, link.appearance
        except Exception as ex:  # noqa: BLE001 - classified; re-raised when it is not the source's
            if _is_source_error(ex):
                logger.warning("[public_answer] source unavailable for turn %s: %s", turn_id, type(ex).__name__)
                return env.failed("source_unavailable", SOURCE_UNAVAILABLE), None, link.flow_key, link.appearance
            raise
        plan = core.get("plan") if core.get("status") == "answered" and isinstance(core.get("plan"), dict) else None
        e = env.from_core(core)
        target = publisher_guide.target_for(guide, plan, core, _filters_in_force(link.ctx, core)) if plan else None
        if target is not None:
            e = env.with_target(e, target)
        refused = guided_analysis.eligible(e, req.question, has_notes=knows, has_addon=bool(link.flow_key))
        evaluate = not refused and guided_analysis.wants_evaluation(e, req.question, has_notes=knows)
        if (refused or evaluate) and is_running(turn_id):
            # The Core could not plan it - or answered a figure the question asks to
            # evaluate: the AI reads the PUBLISHED charts and the publisher's prompt;
            # labelled, its figures checked against the data and the prompt.
            on_step({"step": "analysis", "detail": "Phân tích từ dữ liệu đã công khai của báo cáo"})
            try:
                with gateway.billing(bill):
                    analysis = guided_analysis.analyse(
                        scope, question=req.question, instructions=instructions, guide=guide,
                        previous_answer=_previous_answer(db, link_id, req.conversation_key, turn_id)
                        if follow_up else None,
                        core_answer=_core_answer(req.question, e) if evaluate else None)
            except gateway.AiPolicyRefused as policy:
                if refused:  # the link's budget, said as it is - not the Core's "unsupported"
                    return env.refused(policy.code, policy.message_vi), plan, link.flow_key, link.appearance
                analysis = None  # an evaluation: the Core's answer stands alone
            except Exception:  # noqa: BLE001 - the Core's refusal stands
                logger.warning("[public_answer] guided analysis failed for turn %s", turn_id, exc_info=True)
                analysis = None
            if analysis:
                e = env.with_analysis(e, analysis)
        return e, plan, link.flow_key, link.appearance
    finally:
        db.close()


def _filters_in_force(ctx: Any, core: dict) -> list:
    """The filters the chart the Core read ran under, beyond the question's own: the
    link's / viewer's (per chart when a custom-scope slicer applies) and its page bounds."""
    cid = (core.get("evidence") or {}).get("chart_id")
    by_chart = getattr(ctx, "public_filters_by_chart", None) or {}
    pages = getattr(ctx, "page_scope_by_chart", None) or {}
    return [*(by_chart.get(cid) if cid in by_chart else getattr(ctx, "public_filters", None) or []),
            *(pages.get(cid) or [])]


def _core_answer(question: str, e: dict) -> dict:
    """The Core's answer to this turn, as the viewer sees it: what an evaluation reads."""
    data = e.get("data") if isinstance(e.get("data"), dict) else {}
    answer = data.get("answer") if isinstance(data.get("answer"), dict) else {}
    return {"question": question, "headline": answer.get("headline"), "rows": (data.get("rows") or [])[:30]}


def _previous_answer(db: Session, link_id: int, conversation_key: str, turn_id: str) -> Optional[dict]:
    """The last answer of this conversation, as the viewer saw it: question, headline,
    rows (capped) - the context of "phân tích hơn về con số đó"."""
    t = (db.query(PublicAnswerTurn)
         .filter(PublicAnswerTurn.link_id == link_id, PublicAnswerTurn.conversation_key == conversation_key,
                 PublicAnswerTurn.status == "answered", PublicAnswerTurn.turn_id != turn_id)
         .order_by(PublicAnswerTurn.created_at.desc()).first())
    data = (t.envelope or {}).get("data") if t is not None and isinstance(t.envelope, dict) else None
    if not isinstance(data, dict):
        return None
    answer = data.get("answer") if isinstance(data.get("answer"), dict) else {}
    analysis = data.get("analysis") if isinstance(data.get("analysis"), dict) else {}
    return {"question": t.question, "headline": answer.get("headline") or analysis.get("text", "")[:600],
            "rows": (data.get("rows") or [])[:30]}


async def run(*, link_id: int, token: str, turn_id: str, req: PublicTurnRequest, resolve: Resolver,
              emit: Callable[[dict], None]) -> dict:
    """Run the turn to its one terminal state; return the envelope the viewer gets."""
    from starlette.concurrency import run_in_threadpool

    from app.services.ai_runtime import gateway
    from app.services.chat import extension

    loop = asyncio.get_running_loop()

    def on_step(step: dict) -> None:
        loop.call_soon_threadsafe(emit, {"type": "status", "step": step.get("step"), "detail": step.get("detail")})

    try:
        live, plan, flow_key, appearance = await run_in_threadpool(_core, link_id, turn_id, req, resolve, on_step)
    except Exception:  # noqa: BLE001 - recorded as `failed`, never as an answer
        logger.exception("[public_answer] core failed for turn %s", turn_id)
        live, plan, flow_key, appearance = env.failed("internal_error", "Có lỗi khi xử lý câu hỏi; hãy thử lại."), \
            None, None, {}

    reason = extension.decide(req.question, req.extension, flow_key, live) if flow_key and is_running(turn_id) \
        else None
    if reason:
        from app.services.answer_core.link_extension import invoke_for_link

        emit({"type": "extension", "state": "started", "reason": reason})
        supporting, notices = await invoke_for_link(
            link_id=link_id, turn_id=turn_id, reason=reason, question=req.question, core_env=live,
            resolve=resolve, appearance=appearance, is_cancelled=lambda: not is_running(turn_id))
        emit({"type": "extension", "state": supporting["status"]})
        live = env.with_supporting(live, supporting, notices)

    live = for_viewer(live)
    db = _session()
    try:
        usd = gateway.turn_usd(turn_id)
        _log_turn(db, token=token, turn_id=turn_id, question=req.question, envelope=live, usd=usd)
        if finish(db, turn_id, env.stored(live, 500), plan=plan, usd=usd):
            return live
        t = db.query(PublicAnswerTurn).filter(PublicAnswerTurn.turn_id == turn_id).one()
        return env.normalize(t.envelope, t.status)
    finally:
        db.close()


def _log_turn(db: Session, *, token: str, turn_id: str, question: str, envelope: dict, usd: float) -> None:
    """The link's turn log - what the per-link turns/hour and USD/day pre-check reads."""
    try:
        from app.models.ai_chat_turn_log import AiChatTurnLog

        db.add(AiChatTurnLog(token=token, session_key=turn_id[:64], mode="core", routed="answer_core",
                             question=question[:2000], usd=float(usd or 0.0),
                             had_answer=envelope.get("status") == "answered",
                             errored=envelope.get("status") == "failed"))
        db.commit()
    except Exception:  # noqa: BLE001 - telemetry; the ledger already holds the spend
        db.rollback()
        logger.warning("[public_answer] turn log not written for %s", turn_id)
