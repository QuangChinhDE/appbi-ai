"""THE orchestrator of an AI Chat turn: one turn, one authority, one answer.

Contract: docs/features/unified-ai-chat/contract.md (C5, D.1, D.2). There is no
other path that answers a signed-in person's question: the Analyst routes and the
Flow-first chat were retired, and nothing here falls back to either.

  begin()   admission, BEFORE anything is spent: the conversation may be asked in,
            the operator switch is on, a retried submit (same idempotency key) is
            the same turn, one running turn per conversation, the per-person daily
            and concurrent ceilings - then the turn row is written `running`.
  run()     the Data Core (services/data_core: GQS under the asker's identity) in a
            worker thread; then, only if `extension.decide` says so, the bound Agent
            Flow as a bounded extension; then the ONE terminal write.
  cancel()  the asker stops the turn: the same conditional write, so a stop and a
            finished answer cannot both win; the running governed read is
            cancelled through the ledger and the extension stops at its next tick.

The terminal write is `UPDATE ... WHERE status = 'running'` (conversations.finish).
Whatever wins is what every reader sees, the asker's live stream included.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.chat_conversation import ChatConversation, ChatTurn
from app.services.chat import conversations, envelope as env, extension

logger = logging.getLogger("app.chat")


class TurnRejected(Exception):
    """Refused before the turn exists; the API answers with `status_code`."""

    def __init__(self, status_code: int, detail: Any):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


@dataclass
class TurnRequest:
    question: str
    idempotency_key: str
    follow_up: bool = True
    #: auto | always | never - whether the conversation's bound Flow may be used
    extension: str = "auto"
    choice_token: Optional[str] = None
    dataset_id: Optional[int] = None
    value_choice: Optional[dict] = None
    consented_plan: Optional[dict] = None
    drop_consent: Optional[str] = None
    extra: dict = field(default_factory=dict)


# ── the Core's dependencies: one ledger + one cancel watcher per worker ───────

_lock = threading.Lock()
_deps = None


def core_deps():
    global _deps
    with _lock:
        if _deps is None:
            from app.services.data_core.service import CoreDeps, ledger_from_settings
            from app.services.governed_query.cancellation import REGISTRY
            from app.services.governed_query.ledger import CancelWatcher

            ledger = ledger_from_settings()
            CancelWatcher(ledger, REGISTRY, interval_seconds=1.0, recover_after_seconds=600).start()
            _deps = CoreDeps(ledger=ledger, registry=REGISTRY)
        return _deps


# ── admission ────────────────────────────────────────────────────────────────

def begin(db: Session, user: Any, conversation_id: int, req: TurnRequest) -> tuple[ChatTurn, bool]:
    """(turn, replayed). A replay is the stored turn for this idempotency key."""
    from app.core.config import settings

    c, level = conversations.get(db, user, conversation_id)
    if c is None:
        raise TurnRejected(404, "Không tìm thấy cuộc trò chuyện.")
    if not conversations.can_ask(level):
        raise TurnRejected(403, "Bạn đọc được cuộc trò chuyện này nhưng không hỏi tiếp được.")
    existing = _by_key(db, c.id, req.idempotency_key)
    if existing is not None:
        if str(existing.asked_by) != str(user.id):
            raise TurnRejected(409, "Mã gửi này đã được dùng.")
        return existing, True
    if not settings.AI_CHAT_ENABLED:
        raise TurnRejected(503, "AI Chat đang tạm dừng để bảo trì. Lịch sử hội thoại vẫn xem được.")
    if req.extension not in extension.MODES:
        raise TurnRejected(422, "extension must be auto, always or never")

    if db.get_bind().dialect.name == "postgresql":
        # One person's admission at a time: the ceilings below count rows this
        # transaction is about to add, so two simultaneous submits cannot both pass.
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"chat_turns:{user.id}"})
    conversations.expire_stale(db, c.id)
    if db.query(ChatTurn.id).filter(ChatTurn.conversation_id == c.id, ChatTurn.status == "running").first():
        db.rollback()
        raise TurnRejected(409, "Câu hỏi trước trong cuộc trò chuyện này vẫn đang chạy.")
    per_day = int(settings.AI_CHAT_TURNS_PER_USER_DAY or 0)
    if per_day > 0:
        n = (db.query(func.count(ChatTurn.id))
             .filter(ChatTurn.asked_by == user.id, ChatTurn.origin == "core",
                     ChatTurn.created_at >= func.now() - text("interval '24 hours'")).scalar() or 0)
        if n >= per_day:
            db.rollback()
            raise TurnRejected(429, f"Bạn đã dùng hết {per_day} câu hỏi AI Chat trong 24 giờ.")
    running = int(settings.AI_CHAT_MAX_RUNNING_PER_USER or 0)
    if running > 0 and (db.query(func.count(ChatTurn.id))
                        .filter(ChatTurn.asked_by == user.id, ChatTurn.status == "running").scalar() or 0) >= running:
        db.rollback()
        raise TurnRejected(429, "Bạn đang có quá nhiều câu hỏi chạy cùng lúc; hãy chờ câu trước xong.")

    seq = (db.query(func.coalesce(func.max(ChatTurn.seq), 0)).filter(ChatTurn.conversation_id == c.id).scalar()
           or 0) + 1
    turn = ChatTurn(conversation_id=c.id, seq=seq, turn_id=uuid.uuid4().hex, idempotency_key=req.idempotency_key,
                    asked_by=user.id, question=req.question.strip()[:4000], status="running", origin="core")
    db.add(turn)
    if not c.title:
        c.title = " ".join(req.question.split())[:120]
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _by_key(db, c.id, req.idempotency_key)
        if existing is None or str(existing.asked_by) != str(user.id):
            raise TurnRejected(409, "Mã gửi này đã được dùng.")
        return existing, True
    db.refresh(turn)
    return turn, False


def _by_key(db: Session, conversation_id: int, key: str) -> Optional[ChatTurn]:
    return (db.query(ChatTurn)
            .filter(ChatTurn.conversation_id == conversation_id, ChatTurn.idempotency_key == key).first())


# ── the turn ─────────────────────────────────────────────────────────────────

def _session() -> Session:
    from app.core.database import SessionLocal

    return SessionLocal()


def is_running(turn_id: str) -> bool:
    db = _session()
    try:
        return db.query(ChatTurn.status).filter(ChatTurn.turn_id == turn_id).scalar() == "running"
    finally:
        db.close()


SOURCE_UNAVAILABLE = ("Không đọc được nguồn dữ liệu của câu hỏi này: nguồn đang bị chặn theo chính sách kết nối "
                      "hoặc không kết nối được. Hãy báo quản trị viên của nguồn dữ liệu.")

#: Driver / connector packages whose exceptions mean "the source could not be reached or
#: refused the read" - a fact about the source, not a bug in the turn.
_SOURCE_MODULES = ("psycopg", "psycopg2", "pymysql", "MySQLdb", "google.", "google_", "duckdb", "sqlalchemy.exc")


def _is_source_error(ex: BaseException) -> bool:
    from app.services.source_network_policy import SourceNetworkPolicyError

    if isinstance(ex, SourceNetworkPolicyError):
        return True
    mod = type(ex).__module__ or ""
    return any(mod == m.rstrip(".") or mod.startswith(m) for m in _SOURCE_MODULES)


def _core(turn_id: str, user_id: Any, conversation_id: int, req: TurnRequest,
          on_step: Callable[[dict], None]) -> tuple[dict, list, list]:
    """The Data Core, in a worker thread with its own session. Returns the envelope
    (live: the asker's tokens kept) and its data footprint (Datasets, fields)."""
    from app.core.config import settings
    from app.models.user import User
    from app.services.data_core.service import TurnStopped, ask

    db = _session()
    try:
        user = db.get(User, user_id)
        c = db.get(ChatConversation, conversation_id)
        catalog = conversations.data_catalog(db, user)
        scope = conversations.ViewerScope.of(db, user, catalog)
        previous = conversations.previous_plan(db, c, scope, user.id) if req.follow_up else None
        try:
            core = ask(db, user, req.question, core_deps(), previous=previous, turn_id=turn_id,
                       drop_consent=req.drop_consent,
                       consented_plan=req.consented_plan if isinstance(req.consented_plan, dict) else None,
                       dataset_id=req.dataset_id,
                       value_choice=req.value_choice if isinstance(req.value_choice, dict) else None,
                       choice_token=req.choice_token, on_step=on_step,
                       should_stop=lambda: not is_running(turn_id))
        except TurnStopped:
            return env.cancelled(), [], []
        except Exception as ex:  # noqa: BLE001 - classified below, re-raised when it is not the source's
            if _is_source_error(ex):
                logger.warning("[chat] source unavailable for turn %s: %s", turn_id, type(ex).__name__)
                return env.failed("source_unavailable", SOURCE_UNAVAILABLE), [], []
            raise
        e = env.from_core(core)
        e["data"]["consent_available"] = bool(core.get("consent_available")) and bool(
            getattr(settings, "ANALYST_DROP_CONSENT_ENABLED", False))
        ds, refs, _ = conversations.footprint(e, catalog)
        return e, ds, refs
    finally:
        db.close()


async def run(turn_id: str, user_id: Any, conversation_id: int, req: TurnRequest,
              emit: Callable[[dict], None]) -> dict:
    """Run the turn to its one terminal state; return the envelope the asker gets."""
    from starlette.concurrency import run_in_threadpool

    from app.core.config import settings
    from app.models.user import User

    loop = asyncio.get_running_loop()

    def on_step(step: dict) -> None:
        loop.call_soon_threadsafe(emit, {"type": "status", "step": step.get("step"), "detail": step.get("detail")})

    try:
        live, ds, refs = await run_in_threadpool(_core, turn_id, user_id, conversation_id, req, on_step)
    except Exception:  # noqa: BLE001 - recorded as `failed`, never as an answer
        logger.exception("[chat] core failed for turn %s", turn_id)
        live, ds, refs = env.failed("internal_error", "Có lỗi khi xử lý câu hỏi; hãy thử lại."), [], []

    docs: list = []
    db = _session()
    try:
        user = db.get(User, user_id)
        c = db.get(ChatConversation, conversation_id)
        reason = extension.decide(req.question, req.extension, c.extension_flow_key, live) \
            if is_running(turn_id) else None
        if reason:
            emit({"type": "extension", "state": "started", "flow_key": c.extension_flow_key, "reason": reason})
            supporting, notices = await extension.invoke(
                db, user=user, conversation_id=c.id, turn_id=turn_id, flow_key=c.extension_flow_key,
                reason=reason, question=req.question, core_env=live,
                is_cancelled=lambda: not is_running(turn_id))
            emit({"type": "extension", "state": supporting["status"], "flow_key": c.extension_flow_key})
            live = env.with_supporting(live, supporting, notices)
            docs = sorted({d["doc_id"] for d in supporting.get("documents") or []})
        turn = db.query(ChatTurn).filter(ChatTurn.turn_id == turn_id).one()
        stored = env.stored(live, int(settings.ANALYST_MAX_ROWS))
        if conversations.finish(db, turn, stored, ds, refs, docs, usage={}):
            return live
        db.refresh(turn)
        return env.normalize(turn.envelope, turn.status)
    finally:
        db.close()


def cancel(db: Session, user: Any, turn_id: str) -> dict:
    t = db.query(ChatTurn).filter(ChatTurn.turn_id == turn_id).first()
    if t is None or str(t.asked_by) != str(user.id):
        raise TurnRejected(404, "Không tìm thấy câu hỏi.")
    if t.status != "running":
        return {"cancelled": False, "status": t.status}
    done = conversations.finish(db, t, env.cancelled(), [], [], [])
    if done:
        try:
            core_deps().ledger.request_cancel_run(turn_id, requested_by=user.id)
        except Exception:  # noqa: BLE001 - the turn is already cancelled; the read stops at its timeout
            logger.warning("[chat] ledger cancel failed for %s", turn_id, exc_info=True)
    return {"cancelled": done, "status": "cancelled" if done else t.status}
