"""Named public links of a Report-as-Code report.

The same model a dashboard link has (api/dashboards.py + api/public.py), on the
report's own table: one token per link, optional password, expiry and on/off switch,
locked or hidden filters, appearance options. The public side resolves a token ONLY
through an ACTIVE row of this table and only ever serves the PUBLISHED revision —
`report_artifacts.public_token` is retired and never read (migration 20261103_0002).

A link's filters_config names the report's DECLARED filters by key:
    {"field": "f1", "operator": "in", "value": ["SP"], "hidden": false}
    {"field": "f2", "operator": "between", "value": ["2024-01-01", "2024-12-31"]}
    {"field": "f3", "hidden": true}                      # not offered to the viewer
A value is a lock the viewer can neither change nor clear; `hidden` with a value is
an undisclosed lock; `hidden` without a value removes the filter from the viewer.
An entry naming a filter the published revision does not declare makes the link
refuse to serve (fail closed) instead of silently dropping a restriction.
"""
from __future__ import annotations

import datetime as _dt
import secrets
from typing import Any, Dict, List, Optional, Tuple

from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.models.report_artifact import ReportArtifact, ReportArtifactPublicLink, ReportArtifactRevision
from app.services.report_code import bindings as B

KIND = "report"
MAX_LINKS = 50
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


class LinkRefused(Exception):
    """One answer for every refusal reason the viewer must not be able to tell apart."""


class PasswordRequired(Exception):
    pass


class LinkExpired(Exception):
    pass


def new_token() -> str:
    return "rpt_" + secrets.token_urlsafe(24)


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


# ── Filter scope ─────────────────────────────────────────────────────────────

def normalize_config(decl: List[Dict[str, Any]], config: Any) -> List[Dict[str, Any]]:
    """Validate a link's filters_config against the report's declared filters (author side)."""
    if config in (None, []):
        return []
    if not isinstance(config, list) or len(config) > 50:
        raise ValueError("Cấu hình bộ lọc của liên kết không hợp lệ.")
    by_key = {f["key"]: f for f in decl}
    out: List[Dict[str, Any]] = []
    seen = set()
    for entry in config:
        if not isinstance(entry, dict):
            raise ValueError("Cấu hình bộ lọc của liên kết không hợp lệ.")
        key = str(entry.get("field") or "")
        f = by_key.get(key)
        if f is None:
            raise ValueError(f"Bộ lọc '{key[:40]}' không có trong báo cáo.")
        if key in seen:
            continue
        seen.add(key)
        if entry.get("limit"):
            raise ValueError("Báo cáo AI chưa hỗ trợ chế độ 'Giới hạn' — dùng Khoá hoặc Ẩn.")
        hidden = bool(entry.get("hidden"))
        value = entry.get("value")
        clean = B.clean_state(decl, {key: value}).get(key) if value not in (None, [], "") else None
        if clean is None and not hidden:
            continue  # an empty, visible entry restricts nothing
        out.append({"field": key, "operator": "between" if f["kind"] == "date" else "in",
                    "value": clean, "hidden": hidden, "label": f["label"]})
    return out


def viewer_filters_allowed(appearance: Any) -> bool:
    """The link's "Allow viewer filters" switch (on unless the publisher turned it off)."""
    return not (isinstance(appearance, dict) and appearance.get("allow_viewer_filters") is False)


def scope(decl: List[Dict[str, Any]], config: Any, appearance: Any = None
          ) -> Tuple[List[Dict[str, Any]], Dict[str, Any], List[Dict[str, Any]]]:
    """(filters the viewer may set, locked state, visible locks for the banner).

    With "Allow viewer filters" off the viewer may set none; locks apply either way.
    With "Show locked-filter banner" off the banner is empty; locks apply either way.
    Raises LinkRefused when the config names a filter the revision does not declare."""
    by_key = {f["key"]: f for f in decl}
    locked: Dict[str, Any] = {}
    removed = set()
    banner: List[Dict[str, Any]] = []
    for entry in config or []:
        if not isinstance(entry, dict):
            raise LinkRefused()
        key = str(entry.get("field") or "")
        f = by_key.get(key)
        if f is None:
            raise LinkRefused()
        if entry.get("limit"):
            raise LinkRefused()  # never stored by normalize_config; refuse rather than guess
        value = entry.get("value")
        removed.add(key)
        if value in (None, [], ""):
            continue  # hidden, no value: the filter is simply not offered
        try:
            clean = B.clean_state(decl, {key: value}).get(key)
        except ValueError:
            raise LinkRefused()
        if clean is None:
            continue
        locked[key] = clean
        if not entry.get("hidden"):
            banner.append({"key": key, "label": f["label"], "kind": f["kind"], "value": clean})
    viewer = [f for f in decl if f["key"] not in removed] if viewer_filters_allowed(appearance) else []
    if isinstance(appearance, dict) and appearance.get("show_filter_banner") is False:
        banner = []
    return viewer, locked, banner


def effective_state(decl: List[Dict[str, Any]], config: Any, viewer_state: Any,
                    appearance: Any = None) -> Dict[str, Any]:
    """The state the engine runs with: the viewer's choice on the filters they may set,
    then every lock on top. A viewer naming a locked, hidden or switched-off filter is refused."""
    viewer, locked, _ = scope(decl, config, appearance)
    state = B.clean_state(viewer, viewer_state)  # ValueError for any key outside `viewer`
    state.update(locked)
    return state


# ── Resolution (public side) ─────────────────────────────────────────────────

def links_refused_by(db: Session, art: ReportArtifact, rev: ReportArtifactRevision) -> List[str]:
    """Active links that this revision would make REFUSE to serve: they lock or hide a
    filter the revision does not declare (fail closed - serving it would drop the lock).
    Told to the publisher at publish / rollback time, never to a viewer."""
    out = []
    for link in list_links(db, art):
        if not link.is_active:
            continue
        try:
            scope(rev.filters or [], link.filters_config)
        except LinkRefused:
            out.append(link.name)
    return out


def resolve(db: Session, token: str, session_token: Optional[str], *, track: bool = True
            ) -> Tuple[ReportArtifact, ReportArtifactRevision, ReportArtifactPublicLink]:
    from app.services import public_link_session as S
    from app.services.report_code import lifecycle as L

    if not token or not token.startswith("rpt_") or len(token) > 64:
        raise LinkRefused()
    link = db.query(ReportArtifactPublicLink).filter(
        ReportArtifactPublicLink.token == token, ReportArtifactPublicLink.is_active.is_(True)).first()
    if link is None:
        raise LinkRefused()
    if link.expires_at:
        exp = link.expires_at if link.expires_at.tzinfo else link.expires_at.replace(tzinfo=_dt.timezone.utc)
        if _now() > exp:
            raise LinkExpired()
    art = db.query(ReportArtifact).filter(ReportArtifact.id == link.artifact_id).first()
    if art is None or not art.published_revision_id:
        raise LinkRefused()
    if link.password_hash and not S.verify_session(session_token, link, KIND):
        raise PasswordRequired()
    rev = L.get_revision(db, art, art.published_revision_id)
    if rev is None:
        raise LinkRefused()
    scope(rev.filters or [], link.filters_config)  # fail closed on a stale config
    if track:
        last = link.last_accessed_at
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=_dt.timezone.utc)
        if last is None or (_now() - last).total_seconds() >= 30:
            link.access_count = (link.access_count or 0) + 1
            link.last_accessed_at = _now()
            db.commit()
    return art, rev, link


def authenticate(db: Session, token: str, password: str) -> str:
    from app.services import public_link_session as S

    if not token or not token.startswith("rpt_") or len(token) > 64:
        raise LinkRefused()
    link = db.query(ReportArtifactPublicLink).filter(
        ReportArtifactPublicLink.token == token, ReportArtifactPublicLink.is_active.is_(True)).first()
    if link is None:
        raise LinkRefused()
    if link.expires_at:
        exp = link.expires_at if link.expires_at.tzinfo else link.expires_at.replace(tzinfo=_dt.timezone.utc)
        if _now() > exp:
            raise LinkExpired()
    if not link.password_hash:
        raise ValueError("Liên kết này không cần mật khẩu.")
    if not _pwd.verify(password or "", link.password_hash):
        raise PermissionError("Sai mật khẩu.")
    return S.create_session(link, KIND)


# ── Author side ───────────────────────────────────────────────────────────────

def list_links(db: Session, art: ReportArtifact) -> List[ReportArtifactPublicLink]:
    return db.query(ReportArtifactPublicLink).filter(ReportArtifactPublicLink.artifact_id == art.id) \
        .order_by(ReportArtifactPublicLink.created_at.asc(), ReportArtifactPublicLink.id.asc()).all()


def get_link(db: Session, art: ReportArtifact, link_id: int) -> Optional[ReportArtifactPublicLink]:
    return db.query(ReportArtifactPublicLink).filter(
        ReportArtifactPublicLink.id == link_id, ReportArtifactPublicLink.artifact_id == art.id).first()


def _decl_for(db: Session, art: ReportArtifact) -> List[Dict[str, Any]]:
    """Locks are validated against the filters a viewer could meet: the published
    revision's, else the draft's (a link may be prepared before the first publish)."""
    from app.services.report_code import lifecycle as L

    rev = L.get_revision(db, art, art.published_revision_id or art.draft_revision_id)
    return list(rev.filters or []) if rev else []


def create(db: Session, art: ReportArtifact, *, name: str, filters_config: Any, appearance_config: Any,
           password: Optional[str], expires_at: Optional[_dt.datetime], user_id) -> ReportArtifactPublicLink:
    if db.query(ReportArtifactPublicLink).filter(ReportArtifactPublicLink.artifact_id == art.id).count() >= MAX_LINKS:
        raise ValueError(f"Mỗi báo cáo có tối đa {MAX_LINKS} liên kết công khai.")
    link = ReportArtifactPublicLink(
        artifact_id=art.id, name=name.strip()[:255] or "Liên kết công khai", token=new_token(),
        filters_config=normalize_config(_decl_for(db, art), filters_config),
        appearance_config=dict(appearance_config or {}), is_active=True,
        expires_at=expires_at, password_hash=_pwd.hash(password) if password else None,
        auth_version=0, access_count=0, created_by=user_id)
    db.add(link)
    db.flush()
    return link


def update(db: Session, art: ReportArtifact, link: ReportArtifactPublicLink, fields: Dict[str, Any]) -> None:
    """`fields` holds only what the request set. Every security-relevant change bumps
    auth_version, so a password session minted before it stops working at once."""
    security = False
    if "name" in fields and fields["name"]:
        link.name = str(fields["name"]).strip()[:255]
    if "filters_config" in fields and fields["filters_config"] is not None:
        link.filters_config = normalize_config(_decl_for(db, art), fields["filters_config"])
    if "appearance_config" in fields and fields["appearance_config"] is not None:
        link.appearance_config = dict(fields["appearance_config"])
    if "is_active" in fields and fields["is_active"] is not None and bool(fields["is_active"]) != bool(link.is_active):
        link.is_active = bool(fields["is_active"])
        security = True
    if "password" in fields and fields["password"] is not None:
        link.password_hash = _pwd.hash(fields["password"]) if fields["password"] else None
        security = True
    if "expires_at" in fields and fields["expires_at"] != link.expires_at:
        link.expires_at = fields["expires_at"]
        security = True
    if security:
        link.auth_version = int(link.auth_version or 0) + 1


def view(link: ReportArtifactPublicLink, *, with_token: bool) -> Dict[str, Any]:
    """The dashboard PublicLinkResponse shape, so the shared Public Modal reads both."""
    return {
        "id": link.id, "artifact_id": link.artifact_id, "dashboard_id": link.artifact_id, "name": link.name,
        "token": link.token if with_token else None,
        "filters_config": link.filters_config or [], "appearance_config": link.appearance_config or {},
        "is_active": bool(link.is_active), "has_password": link.has_password,
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "access_count": link.access_count or 0,
        "last_accessed_at": link.last_accessed_at.isoformat() if link.last_accessed_at else None,
        "created_at": link.created_at.isoformat() if link.created_at else None,
        "updated_at": link.updated_at.isoformat() if link.updated_at else None,
        "capabilities": {"manage": with_token, "reveal_token": with_token},
    }


# ── Preview of a link being configured ───────────────────────────────────────
# A signed, short-lived token carrying the draft link's filters/appearance — never a
# stored row, never listed, never password-gated (the author previews the content,
# not the gate). It resolves to the PUBLISHED revision like any link; nothing is
# published and no live link is touched.
PREVIEW_PREFIX = "rpv_"
PREVIEW_TTL_S = 15 * 60


def _preview_key() -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    from app.core.config import settings

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"appbi/report-link-preview/v1").derive(settings.SECRET_KEY.encode())


def make_preview(db: Session, art: ReportArtifact, filters_config: Any, appearance_config: Any,
                 now: Optional[float] = None) -> Tuple[str, _dt.datetime]:
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    if not art.published_revision_id:
        raise ValueError("Báo cáo chưa được xuất bản — xuất bản trước để xem trước liên kết.")
    exp = int((now or _time.time()) + PREVIEW_TTL_S)
    body = json.dumps({"a": art.id, "f": normalize_config(_decl_for(db, art), filters_config),
                       "p": dict(appearance_config or {}), "e": exp}, separators=(",", ":"), ensure_ascii=False).encode()
    if len(body) > 3000:  # it travels in a URL (nginx header buffers are 8k)
        raise ValueError("Cấu hình liên kết quá lớn để xem trước.")
    b = base64.urlsafe_b64encode(body).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(_preview_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{PREVIEW_PREFIX}{b}.{sig}", _dt.datetime.fromtimestamp(exp, _dt.timezone.utc)


def read_preview(token: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    try:
        if not token.startswith(PREVIEW_PREFIX) or len(token) > 12000:
            return None
        b, sig = token[len(PREVIEW_PREFIX):].split(".", 1)
        want = base64.urlsafe_b64encode(hmac.new(_preview_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(want, sig):
            return None
        data = json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))
        if int(data["e"]) < (now or _time.time()):
            return None
        return data
    except Exception:  # noqa: BLE001 - any malformed token is simply refused
        return None


class _PreviewLink:
    """A preview, shaped like a link for the public handlers (never persisted)."""
    def __init__(self, data: Dict[str, Any]):
        self.id = 0
        self.name = "Preview"
        self.filters_config = data.get("f") or []
        self.appearance_config = data.get("p") or {}
        self.password_hash = None
        self.is_preview = True


def resolve_any(db: Session, token: str, session_token: Optional[str], *, track: bool = True):
    """A live link token (rpt_…) or an author's preview token (rpv_…)."""
    from app.services.report_code import lifecycle as L

    if token and token.startswith(PREVIEW_PREFIX):
        data = read_preview(token)
        if data is None:
            raise LinkRefused()
        art = db.query(ReportArtifact).filter(ReportArtifact.id == int(data["a"])).first()
        if art is None or not art.published_revision_id:
            raise LinkRefused()
        rev = L.get_revision(db, art, art.published_revision_id)
        if rev is None:
            raise LinkRefused()
        link = _PreviewLink(data)
        scope(rev.filters or [], link.filters_config)
        return art, rev, link
    return resolve(db, token, session_token, track=track)


# ── The document grant of a password-protected link ──────────────────────────
# The report frame cannot send the X-Public-Session header, and the reusable session
# must never sit in a URL the report's own code can read (location.href). The frame
# gets a separate grant instead: signed, 5 minutes, bound to ONE link at ONE security
# generation and ONE published revision, and good for nothing but that revision's
# document — code the viewer is already running. It does not open /data, /values,
# /auth or the report meta; those still need the session header.
DOC_GRANT_TTL_S = 300


def _doc_key() -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    from app.core.config import settings

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"appbi/report-link-document-grant/v1").derive(settings.SECRET_KEY.encode())


def make_doc_grant(link: ReportArtifactPublicLink, revision_id: int, now: Optional[float] = None) -> str:
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    body = json.dumps({"l": link.id, "av": int(link.auth_version or 0), "r": int(revision_id),
                       "e": int((now or _time.time()) + DOC_GRANT_TTL_S)}, separators=(",", ":")).encode()
    b = base64.urlsafe_b64encode(body).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(_doc_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{b}.{sig}"


def doc_grant_ok(grant: Optional[str], link: ReportArtifactPublicLink, revision_id: int,
                 now: Optional[float] = None) -> bool:
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    try:
        b, sig = (grant or "").split(".", 1)
        want = base64.urlsafe_b64encode(hmac.new(_doc_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(want, sig):
            return False
        d = json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))
        return (int(d["e"]) >= (now or _time.time()) and d.get("l") == link.id
                and d.get("av") == int(link.auth_version or 0) and d.get("r") == int(revision_id))
    except Exception:  # noqa: BLE001 - any malformed grant is simply refused
        return False


def resolve_document(db: Session, token: str, grant: Optional[str]):
    """The published document behind a link, for the frame: a password link needs the
    document grant (never the session); everything else exactly as `resolve_any`."""
    if token and token.startswith(PREVIEW_PREFIX):
        return resolve_any(db, token, None, track=False)
    try:
        return resolve(db, token, None, track=False)
    except PasswordRequired:
        pass
    # a password link: the same checks, then the grant in place of the session
    from app.services.report_code import lifecycle as L

    link = db.query(ReportArtifactPublicLink).filter(
        ReportArtifactPublicLink.token == token, ReportArtifactPublicLink.is_active.is_(True)).first()
    art = db.query(ReportArtifact).filter(ReportArtifact.id == link.artifact_id).first() if link else None
    if link is None or art is None or not art.published_revision_id:
        raise LinkRefused()
    if not doc_grant_ok(grant, link, art.published_revision_id):
        raise PasswordRequired()
    rev = L.get_revision(db, art, art.published_revision_id)
    if rev is None:
        raise LinkRefused()
    scope(rev.filters or [], link.filters_config)
    return art, rev, link
