"""Public Report-as-Code links — unauthenticated, read-only, published revision only.

What a public link exposes is the published revision's code and, per request, the
DTO of ONE of its declared bindings under ONLY its declared filters — with the link's
locked filters applied on top, server-side, whatever the viewer sends. A token resolves
ONLY through an active row of report_artifact_public_links (services/report_code/
public_links.py); unknown, disabled, deleted or unpublished all get the same 404, so the
endpoint is no oracle. Expired is 410, password-protected without a session is 401 —
the same answers a dashboard link gives.
No chart id, dataset id, field reference, SQL or debug leaves this module.
"""
# No `from __future__ import annotations`: slowapi wraps each endpoint, and FastAPI
# could then no longer resolve the body models from string annotations.
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.core import get_db
from app.services.report_code import bindings as B
from app.services.report_code import document as D
from app.services.report_code import lifecycle as L
from app.services.report_code import public_links as PL

router = APIRouter(prefix="/public/reports", tags=["public-reports"])
docs_router = APIRouter(prefix="/public/report-docs", tags=["public-reports"])
_limiter = Limiter(key_func=get_remote_address)
_NOT_FOUND = "Báo cáo không tồn tại hoặc chưa được chia sẻ."


class PublicDataBody(BaseModel):
    binding: str = Field(..., max_length=20)
    state: Dict[str, Any] = Field(default_factory=dict)


class PublicPasswordBody(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)


class PublicValuesBody(BaseModel):
    key: str = Field(..., max_length=20)
    search: str = Field("", max_length=80)
    state: Dict[str, Any] = Field(default_factory=dict)


def _live(db: Session, token: str, session: Optional[str] = None, *, track: bool = False):
    try:
        return PL.resolve_any(db, token, session, track=track)
    except PL.LinkRefused:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except PL.LinkExpired:
        raise HTTPException(status_code=410, detail="Liên kết đã hết hạn.")
    except PL.PasswordRequired:
        raise HTTPException(status_code=401, detail="Liên kết này cần mật khẩu.",
                            headers={"X-Link-Password-Required": "true"})


def _link_token_key(request: Request) -> str:
    """Password attempts are also capped per LINK, not only per caller (as for dashboards)."""
    return "public-report-link-auth:" + str(request.path_params.get("token") or "")


@router.post("/{token}/auth")
@_limiter.limit("10/minute")
@_limiter.limit("100/hour", key_func=_link_token_key)
def public_auth(token: str, body: PublicPasswordBody, request: Request, db: Session = Depends(get_db)):
    from app.services import public_link_session as S

    try:
        session = PL.authenticate(db, token, body.password)
    except PL.LinkRefused:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except PL.LinkExpired:
        raise HTTPException(status_code=410, detail="Liên kết đã hết hạn.")
    except PermissionError:
        raise HTTPException(status_code=403, detail="Sai mật khẩu.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"session_token": session, "expires_in": S.PUBLIC_SESSION_SECONDS}


@router.get("/{token}")
@_limiter.limit("120/minute")
def public_report(token: str, request: Request, db: Session = Depends(get_db),
                  x_public_session: Optional[str] = Header(default=None)):
    art, rev, link = _live(db, token, x_public_session, track=True)
    viewer, _, banner = PL.scope(rev.filters or [], link.filters_config, link.appearance_config)
    path = f"/public/reports/{token}/document"
    if link.password_hash:
        # Never the session: the report's own code can read its URL. A document grant
        # opens this revision's code only (services/report_code/public_links.py).
        path += "?g=" + PL.make_doc_grant(link, rev.id)
    doc, isolated = L.document_url(path)
    appearance = {k: v for k, v in (link.appearance_config or {}).items() if not str(k).startswith("ai_bot")}
    appearance["ai_bot_enabled"] = bool((link.appearance_config or {}).get("ai_bot_enabled")) \
        and not getattr(link, "is_preview", False)
    from app.services.public_mcp import access as _mcp_access  # the switch's state only, never its settings
    appearance = _mcp_access.for_viewer(appearance, preview=bool(getattr(link, "is_preview", False)))
    return {"name": art.name, "link_name": link.name, "version": rev.number,
            "published_at": art.last_published_at.isoformat() if art.last_published_at else None,
            "bindings": B.public_bindings(rev.bindings or []), "filters": B.public_filters(viewer),
            "locked_filters": banner, "appearance": appearance,
            "document_url": doc, "isolated": isolated, "preview": bool(getattr(link, "is_preview", False))}


def _document(art, rev, frame_ancestors: str) -> HTMLResponse:
    nonce = D.new_nonce()
    headers = {"Content-Security-Policy": D.csp_header(nonce, frame_ancestors), "Permissions-Policy": D.PERMISSIONS_POLICY,
               "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
               "X-DNS-Prefetch-Control": "off"}
    return HTMLResponse(D.build_document(html=rev.html, css=rev.css, js=rev.js, title=art.name, nonce=nonce), headers=headers)


@router.get("/{token}/document", response_class=HTMLResponse)
@_limiter.limit("120/minute")
def public_document(token: str, request: Request, g: Optional[str] = None, db: Session = Depends(get_db)):
    try:
        art, rev, _ = PL.resolve_document(db, token, g)
    except PL.LinkRefused:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    except PL.LinkExpired:
        raise HTTPException(status_code=410, detail="Liên kết đã hết hạn.")
    except PL.PasswordRequired:
        raise HTTPException(status_code=401, detail="Liên kết này cần mật khẩu.")
    # The document holds code, never data (data only arrives over the host's
    # MessagePort), so it may sit under any page that embeds the /embed host.
    return _document(art, rev, "*")


@docs_router.post("/{ticket}/preview", response_class=HTMLResponse)
@_limiter.limit("240/minute")
async def ticket_preview(ticket: str, request: Request, db: Session = Depends(get_db)):
    """Live preview of UNSAVED editor code: the studio posts its source into the frame.

    The ticket (signed, 10 min, one report) is the authority; nothing is stored. The
    code goes through the same validation as a save and runs under the same CSP, and
    the frame still gets data only over the host's MessagePort."""
    from app.models.report_artifact import ReportArtifact

    grant = L.read_ticket(ticket, need_edit=True)  # a viewer's ticket renders saved code only
    art = db.query(ReportArtifact).filter(ReportArtifact.id == grant[0]).first() if grant else None
    if art is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    form = await request.form()
    try:
        v = D.validate(str(form.get("html") or ""), str(form.get("css") or ""), str(form.get("js") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc))

    class _Rev:  # the posted source, shaped like a revision for _document
        html, css, js = v.html, v.css, v.js

    return _document(art, _Rev, L.frame_ancestors_for_draft())


@docs_router.get("/{ticket}", response_class=HTMLResponse)
@_limiter.limit("240/minute")
def ticket_document(ticket: str, request: Request, db: Session = Depends(get_db)):
    """A studio preview document, reachable only with a signed 10-minute ticket."""
    from app.models.report_artifact import ReportArtifact

    grant = L.read_ticket(ticket)
    if grant is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    art = db.query(ReportArtifact).filter(ReportArtifact.id == grant[0]).first()
    rev = L.get_revision(db, art, grant[1]) if art else None
    if rev is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return _document(art, rev, L.frame_ancestors_for_draft())


@router.post("/{token}/data")
@_limiter.limit("600/minute")
def public_data(token: str, body: PublicDataBody, request: Request, db: Session = Depends(get_db),
                x_public_session: Optional[str] = Header(default=None)):
    art, rev, link = _live(db, token, x_public_session)
    binding = next((b for b in rev.bindings or [] if b.get("id") == body.binding), None)
    try:  # first: an override of a lock is refused whatever binding is asked for
        state = PL.effective_state(rev.filters or [], link.filters_config, body.state, link.appearance_config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if binding is None:
        # the link is live (resolved above): the PLACE is not bound - said as such
        return B.unbound_dto(body.binding)
    hidden = {str(e.get("field")) for e in (link.filters_config or []) if isinstance(e, dict) and e.get("hidden")}
    return B.mint_dto(db, binding, rev.filters or [], state, public=True,
                      disclose=[f["key"] for f in rev.filters or [] if f["key"] not in hidden],
                      enforced=PL.enforced_keys(rev.filters or [], link.filters_config, link.appearance_config))


@router.post("/{token}/values")
@_limiter.limit("300/minute")
def public_values(token: str, body: PublicValuesBody, request: Request, db: Session = Depends(get_db),
                  x_public_session: Optional[str] = Header(default=None)):
    art, rev, link = _live(db, token, x_public_session)
    try:
        viewer, _, _ = PL.scope(rev.filters or [], link.filters_config, link.appearance_config)
        if body.key not in {f["key"] for f in viewer}:
            raise ValueError("Bộ lọc không có trong báo cáo.")  # a locked or hidden filter has no value list
        state = PL.effective_state(rev.filters or [], link.filters_config, body.state, link.appearance_config)
        return {"values": B.filter_values(db, rev.filters or [], state, body.key, body.search,
                                          enforced=PL.enforced_keys(rev.filters or [], link.filters_config,
                                                                    link.appearance_config))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ── AI Bot (viewer-facing): the dashboard bot's Answer Core on a report link ──────
# Distinct from the Studio's AI (which writes report code for an author): this one
# answers a VIEWER, only from what the link serves (services/report_code/public_bot.py).

class PublicAnswerBody(BaseModel):
    question: str = Field(..., max_length=4000)
    conversation_key: str = Field(..., max_length=64)
    idempotency_key: str = Field(..., max_length=64)
    #: the viewer's filter choices on the report, as the frame holds them ({key: value})
    viewer_state: Dict[str, Any] = Field(default_factory=dict)
    follow_up: bool = True
    choice_token: Optional[str] = Field(None, max_length=200)


class PublicTurnRef(BaseModel):
    conversation_key: str = Field(..., max_length=64)


class PublicRating(BaseModel):
    conversation_key: str = Field(..., max_length=64)
    rating: str = Field(..., max_length=8)


def _bot_link(db: Session, token: str, session: Optional[str]):
    from app.services.report_code import public_bot as PB

    if token.startswith(PL.PREVIEW_PREFIX):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)  # a preview never opens (or spends) the bot
    art, rev, link = _live(db, token, session)
    if not PB.bot_enabled(link.appearance_config):
        raise HTTPException(status_code=403, detail="Trợ lý AI chưa được bật cho liên kết này.")
    return art, rev, link


@router.get("/{token}/ai/status")
@_limiter.limit("60/minute")
def public_ai_status(token: str, request: Request, db: Session = Depends(get_db),
                     x_public_session: Optional[str] = Header(default=None)):
    """Is the report's AI Bot ready to answer? No key, no credential id, no budget figure."""
    from app.services.ai_runtime import gateway
    from app.services.report_code import public_bot as PB

    if token.startswith(PL.PREVIEW_PREFIX):
        return {"enabled": False, "ready": False}
    _, _, link = _live(db, token, x_public_session)
    enabled = PB.bot_enabled(link.appearance_config)
    ready = enabled and bool(gateway.readiness(db, link.appearance_config).get("ready"))
    return {"enabled": enabled, "ready": ready}


@router.post("/{token}/ai/answer")
@_limiter.limit("20/minute")
async def public_ai_answer(token: str, body: PublicAnswerBody, request: Request, db: Session = Depends(get_db),
                           x_public_session: Optional[str] = Header(default=None)):
    """Ask the report's AI Bot. Streams `chat.v1` events (accepted, status, final, done),
    the same stream the dashboard bot sends; the link's budget decides what is spent."""
    import asyncio
    import json as _json

    from fastapi.responses import StreamingResponse

    from app.models.report_artifact import ReportAnswerTurn
    from app.services.answer_core import public_turn
    from app.services.report_code import public_bot as PB

    _, rev, link = _bot_link(db, token, x_public_session)
    try:  # the viewer's choices are checked before anything is admitted or spent
        PL.effective_state(rev.filters or [], link.filters_config, body.viewer_state, link.appearance_config)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    req = public_turn.PublicTurnRequest(
        question=body.question, conversation_key=body.conversation_key, idempotency_key=body.idempotency_key,
        follow_up=bool(body.follow_up), choice_token=body.choice_token, extension="never")
    try:
        turn, replayed = public_turn.begin(db, link_id=link.id, token=token, appearance=link.appearance_config or {},
                                           req=req, T=ReportAnswerTurn)
    except public_turn.TurnRejected as rejected:
        raise HTTPException(status_code=rejected.status_code, detail=rejected.detail)
    turn_id, link_id = turn.turn_id, link.id
    resolve = PB.resolver(token, x_public_session, body.viewer_state)

    def frame(ev: dict) -> str:
        return "data: " + _json.dumps(ev, ensure_ascii=False, default=str) + "\n\n"

    async def stream():
        yield frame({"type": "accepted", "turn_id": turn_id, "replayed": replayed})
        if replayed:
            from app.core.database import SessionLocal

            for _ in range(240):
                s = SessionLocal()
                try:
                    view = public_turn.view(s, link_id=link_id, turn_id=turn_id,
                                            conversation_key=req.conversation_key, T=ReportAnswerTurn)
                finally:
                    s.close()
                if view["status"] != "running":
                    yield frame({"type": "final", "turn_id": turn_id, "envelope": view["envelope"]})
                    break
                await asyncio.sleep(1.0)
            yield frame({"type": "done"})
            return
        queue: asyncio.Queue = asyncio.Queue()
        task = asyncio.ensure_future(public_turn.run(
            link_id=link_id, token=token, turn_id=turn_id, req=req, resolve=resolve, emit=queue.put_nowait,
            T=ReportAnswerTurn, ledger_link_id=PB.ledger_link_id(link_id)))
        while True:
            getter = asyncio.ensure_future(queue.get())
            done, _ = await asyncio.wait({getter, task}, return_when=asyncio.FIRST_COMPLETED)
            if getter in done:
                yield frame(getter.result())
                continue
            getter.cancel()
            while not queue.empty():
                yield frame(queue.get_nowait())
            break
        try:
            envelope = task.result()
        except Exception:  # noqa: BLE001 - never an answer
            envelope = {"v": "chat.v1", "status": "failed", "code": "internal_error",
                        "message": "Có lỗi khi xử lý câu hỏi; hãy thử lại.", "data": None, "supporting": None,
                        "notices": []}
        yield frame({"type": "final", "turn_id": turn_id, "envelope": envelope})
        yield frame({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@router.post("/{token}/ai/answer/{turn_id}/cancel")
@_limiter.limit("30/minute")
def public_ai_cancel(token: str, turn_id: str, body: PublicTurnRef, request: Request, db: Session = Depends(get_db),
                     x_public_session: Optional[str] = Header(default=None)):
    from app.models.report_artifact import ReportAnswerTurn
    from app.services.answer_core import public_turn

    _, _, link = _bot_link(db, token, x_public_session)
    try:
        return public_turn.cancel(db, link_id=link.id, turn_id=turn_id, conversation_key=body.conversation_key,
                                  T=ReportAnswerTurn)
    except public_turn.TurnRejected as rejected:
        raise HTTPException(status_code=rejected.status_code, detail=rejected.detail)


@router.post("/{token}/ai/answer/{turn_id}/rating")
@_limiter.limit("30/minute")
def public_ai_rating(token: str, turn_id: str, body: PublicRating, request: Request, db: Session = Depends(get_db),
                     x_public_session: Optional[str] = Header(default=None)):
    from app.models.report_artifact import ReportAnswerTurn
    from app.services.answer_core import public_turn

    _, _, link = _bot_link(db, token, x_public_session)
    try:
        return public_turn.rate(db, link_id=link.id, turn_id=turn_id, conversation_key=body.conversation_key,
                                rating=body.rating, T=ReportAnswerTurn)
    except public_turn.TurnRejected as rejected:
        raise HTTPException(status_code=rejected.status_code, detail=rejected.detail)


@router.get("/{token}/ai/answer/{turn_id}")
@_limiter.limit("60/minute")
def public_ai_turn(token: str, turn_id: str, conversation_key: str, request: Request, db: Session = Depends(get_db),
                   x_public_session: Optional[str] = Header(default=None)):
    from app.models.report_artifact import ReportAnswerTurn
    from app.services.answer_core import public_turn

    _, _, link = _bot_link(db, token, x_public_session)
    try:
        return public_turn.view(db, link_id=link.id, turn_id=turn_id, conversation_key=conversation_key,
                                T=ReportAnswerTurn)
    except public_turn.TurnRejected as rejected:
        raise HTTPException(status_code=rejected.status_code, detail=rejected.detail)
