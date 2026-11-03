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
    viewer, _, banner = PL.scope(rev.filters or [], link.filters_config)
    path = f"/public/reports/{token}/document"
    if link.password_hash and x_public_session:
        path += "?s=" + x_public_session  # the frame cannot send a header; the session is the same grant
    doc, isolated = L.document_url(path)
    appearance = {k: v for k, v in (link.appearance_config or {}).items() if not str(k).startswith("ai_bot")}
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
def public_document(token: str, request: Request, s: Optional[str] = None, db: Session = Depends(get_db)):
    art, rev, _ = _live(db, token, s)
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
    if binding is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    try:
        state = PL.effective_state(rev.filters or [], link.filters_config, body.state)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return B.mint_dto(db, binding, rev.filters or [], state, public=True)


@router.post("/{token}/values")
@_limiter.limit("300/minute")
def public_values(token: str, body: PublicValuesBody, request: Request, db: Session = Depends(get_db),
                  x_public_session: Optional[str] = Header(default=None)):
    art, rev, link = _live(db, token, x_public_session)
    try:
        viewer, _, _ = PL.scope(rev.filters or [], link.filters_config)
        if body.key not in {f["key"] for f in viewer}:
            raise ValueError("Bộ lọc không có trong báo cáo.")  # a locked or hidden filter has no value list
        state = PL.effective_state(rev.filters or [], link.filters_config, body.state)
        return {"values": B.filter_values(db, rev.filters or [], state, body.key, body.search)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
