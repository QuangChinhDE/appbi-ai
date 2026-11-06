"""Public Read MCP — the AppBI side of a customer's own Claude reading one public link.

Two callers, two credentials, nothing else:

- the VIEWER's browser, on the public page, pairs: `POST /public/mcp/pair` with the link
  token (+ its password session) — the same proof any viewer of the link holds — and
  gets a GRANT bound to that link, its security generation and one viewer session;
- the Public MCP server (integrations/appbi-mcp, `appbi_mcp.public`) reads with that
  grant (`X-Public-MCP-Grant`): describe / chart-data / check-state / filter-values.

Every grant request re-resolves the link through the official resolver
(`public._get_dashboard_by_token`, `public_links.resolve`): revoke, expiry, password
change, "Claude access off" and the publisher's disconnect all take effect on the next
call. Read-only by construction: there is no route here that writes anything.
"""
# No `from __future__ import annotations`: slowapi wraps each endpoint (see public_reports.py).
import hashlib
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.core import get_db
from app.services.public_mcp import access as A
from app.services.public_mcp import service as S

log = logging.getLogger("app.public_mcp")

router = APIRouter(prefix="/public/mcp", tags=["public-mcp"])
_limiter = Limiter(key_func=get_remote_address)


def _grant_key(request: Request) -> str:
    raw = request.headers.get("x-public-mcp-grant") or ""
    return "public-mcp:" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def _refused(exc: S.Refused) -> JSONResponse:
    return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status,
                        headers={"Cache-Control": "no-store"})


class PairBody(BaseModel):
    kind: str = Field(pattern="^(dashboard|report)$")
    token: str = Field(min_length=8, max_length=128)


class StateBody(BaseModel):
    state: Dict[str, Any] = Field(default_factory=dict)


class ChartBody(StateBody):
    chart: Any


class ValuesBody(StateBody):
    key: str = Field(min_length=1, max_length=200)
    search: str = Field(default="", max_length=200)


# ── opening a link ────────────────────────────────────────────────────────────

def _open_dashboard(db: Session, token: str, session: Optional[str]):
    from app.api import public as P
    from app.models.models import DashboardPublicLink

    if token.startswith("emb_"):
        raise S.Refused("not_available", "Claude access is not available on an embedded report.", 404)
    try:
        dash, fcfg, name, appearance = P._get_dashboard_by_token(token, db, session_token=session, track_access=False)
    except HTTPException as exc:
        raise S.Refused({404: "link_closed", 410: "link_expired", 401: "password_required"}.get(exc.status_code, "link_refused"),
                        str(exc.detail), exc.status_code)
    link = db.query(DashboardPublicLink).filter(DashboardPublicLink.token == token).first()
    return dash, fcfg, name, appearance, link


def _open_report(db: Session, token: str, session: Optional[str]):
    from app.services.report_code import public_links as PL

    try:
        return PL.resolve(db, token, session, track=False)
    except PL.LinkRefused:
        raise S.Refused("link_closed", "This shared report link is closed.", 404)
    except PL.LinkExpired:
        raise S.Refused("link_expired", "This shared report link has expired.", 410)
    except PL.PasswordRequired:
        raise S.Refused("password_required", "This shared report link needs its password.", 401)


def _handle(db: Session, grant: Optional[str]) -> S.Handle:
    claims = S.grant_decode(grant)
    from app.services import public_link_session as PLS

    if claims["k"] == S.DASHBOARD:
        from app.models.models import DashboardPublicLink

        row = db.get(DashboardPublicLink, claims["lid"])
        if row is None or not row.is_active:
            raise S.Refused("link_closed", "This shared link has been closed by its publisher.", 404)
        S.check_grant_against(row, claims)
        session = PLS.create_session(row, PLS.DASHBOARD) if row.password_hash else None
        dash, fcfg, name, appearance, _ = _open_dashboard(db, row.token, session)
        return S.Handle(kind=S.DASHBOARD, link=row, sid=claims["sid"], name=str(appearance.get("headline") or dash.name or name),
                        appearance=dict(appearance or {}), filters_config=list(fcfg or []), dash=dash)
    from app.models.report_artifact import ReportArtifactPublicLink
    from app.services.report_code import public_links as PL

    row = db.get(ReportArtifactPublicLink, claims["lid"])
    if row is None or not row.is_active:
        raise S.Refused("link_closed", "This shared report link has been closed by its publisher.", 404)
    S.check_grant_against(row, claims)
    session = PLS.create_session(row, PL.KIND) if row.password_hash else None
    art, rev, link = _open_report(db, row.token, session)
    return S.Handle(kind=S.REPORT, link=link, sid=claims["sid"], name=str((link.appearance_config or {}).get("headline") or art.name),
                    appearance=dict(link.appearance_config or {}), filters_config=list(link.filters_config or []), art=art, rev=rev)


# ── the viewer pairs ──────────────────────────────────────────────────────────

@router.post("/pair")
@_limiter.limit("10/minute")
def pair(body: PairBody, request: Request, db: Session = Depends(get_db),
         x_public_session: Optional[str] = Header(default=None)):
    """A viewer of the link asks to connect their Claude. Same proof as viewing the link."""
    try:
        if body.kind == S.DASHBOARD:
            dash, _, name, appearance, link = _open_dashboard(db, body.token, x_public_session)
            if link is None:
                raise S.Refused("not_available", "Claude access is not available on this link.", 404)
            title = str(appearance.get("headline") or dash.name or name)
        else:
            art, _, link = _open_report(db, body.token, x_public_session)
            if getattr(link, "is_preview", False):
                raise S.Refused("not_available", "Claude access is not available on a link preview.", 404)
            title = str((link.appearance_config or {}).get("headline") or art.name)
        if not A.enabled(link.appearance_config):
            raise S.Refused("mcp_disabled", "The publisher has not turned on Claude access for this report.", 403)
        out = S.grant_encode(body.kind, link)
    except S.Refused as exc:
        return _refused(exc)
    log.info("public_mcp op=pair kind=%s link=%s sid=%s", body.kind, link.id, out["sid"][:10])
    from app.core.config import settings as _settings

    mcp_base = (_settings.PUBLIC_MCP_URL or "").rstrip("/")
    return JSONResponse({**out, "report": {"kind": body.kind, "name": title}, "mcp_base": mcp_base},
                        headers={"Cache-Control": "no-store"})


# ── the Public MCP reads ──────────────────────────────────────────────────────

@router.post("/describe")
@_limiter.limit("60/minute", key_func=_grant_key)
def describe(body: StateBody, request: Request, db: Session = Depends(get_db),
             x_public_mcp_grant: Optional[str] = Header(default=None)):
    try:
        h = _handle(db, x_public_mcp_grant)
        out = S.describe(db, h, body.state)
    except S.Refused as exc:
        return _refused(exc)
    S.audit(h, "describe")
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


@router.post("/chart-data")
@_limiter.limit("60/minute", key_func=_grant_key)
def chart_data(body: ChartBody, request: Request, db: Session = Depends(get_db),
               x_public_mcp_grant: Optional[str] = Header(default=None)):
    try:
        h = _handle(db, x_public_mcp_grant)
        out = S.chart_data(db, h, body.chart, body.state)
    except S.Refused as exc:
        return _refused(exc)
    S.audit(h, "chart_data", chart=body.chart, rows=out.get("row_count", ""))
    from fastapi.encoders import jsonable_encoder

    return JSONResponse(jsonable_encoder(out, custom_encoder={float: lambda v: v if v == v and v not in (float("inf"), float("-inf")) else None}),
                        headers={"Cache-Control": "no-store"})


@router.post("/check-state")
@_limiter.limit("120/minute", key_func=_grant_key)
def check_state(body: StateBody, request: Request, db: Session = Depends(get_db),
                x_public_mcp_grant: Optional[str] = Header(default=None)):
    try:
        h = _handle(db, x_public_mcp_grant)
        out = S.check_state(db, h, body.state)
    except S.Refused as exc:
        return _refused(exc)
    S.audit(h, "check_state")
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


@router.post("/filter-values")
@_limiter.limit("60/minute", key_func=_grant_key)
def filter_values(body: ValuesBody, request: Request, db: Session = Depends(get_db),
                  x_public_mcp_grant: Optional[str] = Header(default=None)):
    try:
        h = _handle(db, x_public_mcp_grant)
        if h.kind != S.REPORT:
            raise S.Refused("not_supported", "Read the values from a chart of this dashboard instead.", 400)
        values = S.report_filter_values(db, h, body.key, body.search, body.state)
    except S.Refused as exc:
        return _refused(exc)
    S.audit(h, "filter_values", key=body.key)
    from fastapi.encoders import jsonable_encoder

    return JSONResponse({"values": jsonable_encoder(values[:200]), "truncated": len(values) > 200},
                        headers={"Cache-Control": "no-store"})
