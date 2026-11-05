"""Report lifecycle: append-only revisions, draft/publish pointers, rollback, AI jobs.

* A revision is never updated. Save, AI generation, AI edit, data change and restore
  each ADD one.
* Draft and published are pointers. Publish = point `published` at the draft
  revision; rollback = point it at an older one. The public surface serves only the
  revision `published` points at, so a viewer never sees a draft and a published
  report cannot change underneath them.
* AI work runs in a background thread; its state lives in the artifact row because
  any of the API workers may answer the poll.
"""
from __future__ import annotations

import datetime as _dt
import logging
import re
import secrets
import threading
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.share_access import register_share_resource
from app.models.report_artifact import ReportArtifact, ReportArtifactRevision
from app.models.resource_share import ResourceType

register_share_resource(ResourceType.REPORT_ARTIFACT, ReportArtifact, "dashboards")
from app.services.report_code import bindings as B
from app.services.report_code import document as D

logger = logging.getLogger(__name__)

JOB_STALE_AFTER_S = 8 * 60


def _now() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def get_revision(db: Session, artifact: ReportArtifact, revision_id: Optional[int]) -> Optional[ReportArtifactRevision]:
    if not revision_id:
        return None
    return db.query(ReportArtifactRevision).filter(
        ReportArtifactRevision.id == revision_id, ReportArtifactRevision.artifact_id == artifact.id).first()


def revision_by_number(db: Session, artifact: ReportArtifact, number: int) -> Optional[ReportArtifactRevision]:
    return db.query(ReportArtifactRevision).filter(
        ReportArtifactRevision.artifact_id == artifact.id, ReportArtifactRevision.number == number).first()


def add_revision(db: Session, artifact: ReportArtifact, *, user_id, html: str, css: str, js: str,
                 bindings: List[Dict[str, Any]], filters: List[Dict[str, Any]], source: str,
                 note: Optional[str] = None) -> tuple[ReportArtifactRevision, List[str]]:
    v = D.validate(html, css, js)
    known = {b["id"] for b in bindings}
    warnings = list(v.warnings)
    live_html = re.sub(r"<!--.*?-->", "", v.html, flags=re.S)  # commented-out examples are not references
    live_js = re.sub(r"/\*.*?\*/|^\s*//.*$", "", v.js, flags=re.S | re.M)
    for ref in set(_refs(live_html + live_js)) - known:
        warnings.append(f"'{ref}' không phải dữ liệu của báo cáo này — chỗ đó sẽ hiện 'Chưa gắn dữ liệu'.")
    number = (db.query(func.max(ReportArtifactRevision.number)).filter(
        ReportArtifactRevision.artifact_id == artifact.id).scalar() or 0) + 1
    rev = ReportArtifactRevision(
        artifact_id=artifact.id, number=number, html=v.html, css=v.css, js=v.js,
        bindings=bindings, filters=filters, source=source[:32], note=(note or "")[:4000] or None,
        content_hash=D.content_hash(v.html, v.css, v.js, bindings, filters), created_by=user_id)
    db.add(rev)
    db.flush()
    artifact.draft_revision_id = rev.id
    artifact.updated_at = _now()
    return rev, warnings


_REF_RX = re.compile(
    r"data-rac-(?:bind|value|title|asof)=[\"']([^\"']+)[\"']"
    r"|rac\.(?:bind|data|primary)\(\s*['\"]([^'\"]+)['\"]"
    r"|rac\.viz\.\w+\([^,()]+,\s*['\"]([^'\"]+)['\"]")


def _refs(text: str) -> List[str]:
    return [next(g for g in groups if g) for groups in _REF_RX.findall(text or "")]


_SAMPLE_RX = re.compile(r"<[a-zA-Z][^>]*\sdata-rac-sample(?:[\s=>/])", re.S)


def sample_marks(html: str) -> int:
    """How many places still show the design's SAMPLE numbers (not BI Core data)."""
    return len(_SAMPLE_RX.findall(html or ""))


class SampleNumbersRemain(ValueError):
    """Publishing would present a design's sample numbers to readers as if they were data."""


def publish(db: Session, artifact: ReportArtifact, *, revision_id: Optional[int] = None,
            allow_samples: bool = False) -> ReportArtifactRevision:
    target = get_revision(db, artifact, revision_id or artifact.draft_revision_id)
    if target is None:
        raise ValueError("Báo cáo chưa có phiên bản nào để xuất bản.")
    n = sample_marks(target.html)
    if n and not allow_samples:
        raise SampleNumbersRemain(
            f"Còn {n} vị trí hiển thị SỐ MẪU từ thiết kế (đánh dấu data-rac-sample), chưa nối dữ liệu BI Core. "
            "Nối chúng với dữ liệu, đánh dấu là chữ tĩnh, hoặc xác nhận xuất bản kèm nhãn \"số mẫu\".")
    artifact.published_revision_id = target.id
    artifact.last_published_at = _now()
    return target


def restore(db: Session, artifact: ReportArtifact, *, revision_id: int, user_id) -> ReportArtifactRevision:
    src = get_revision(db, artifact, revision_id)
    if src is None:
        raise ValueError("Không tìm thấy phiên bản.")
    rev, _ = add_revision(db, artifact, user_id=user_id, html=src.html, css=src.css, js=src.js,
                          bindings=list(src.bindings or []), filters=list(src.filters or []),
                          source="restore", note=f"Khôi phục từ phiên bản {src.number}")
    return rev


def delete(db: Session, artifact: ReportArtifact) -> int:
    """Delete the report, its revisions and links (FK cascade), and the charts it made.

    Every binding chart was created FOR the report (bindings.bind_candidates is the only
    way a binding gets a chart), so deleting the report would otherwise orphan them in
    Explore. A chart is kept when anything else still uses it: a dashboard tile, or a
    revision of another report. Returns how many charts were removed."""
    from app.models.models import Chart, DashboardChart

    chart_ids = set()
    for (bindings,) in db.query(ReportArtifactRevision.bindings).filter(
            ReportArtifactRevision.artifact_id == artifact.id).all():
        for b in bindings or []:
            if isinstance(b, dict) and isinstance(b.get("chart_id"), int):
                chart_ids.add(b["chart_id"])
    artifact.draft_revision_id = None
    artifact.published_revision_id = None
    db.flush()
    db.delete(artifact)
    db.flush()  # revisions and links go with it (ON DELETE CASCADE)
    removed = 0
    for cid in sorted(chart_ids):
        if db.query(DashboardChart.id).filter(DashboardChart.chart_id == cid).first():
            continue
        if db.query(ReportArtifactRevision.id).filter(
                ReportArtifactRevision.bindings.contains([{"chart_id": cid}])).first():
            continue
        chart = db.get(Chart, cid)
        if chart is not None:
            db.delete(chart)
            removed += 1
    return removed


# ── Serialization ─────────────────────────────────────────────────────────────

def duplicate(db: Session, art: ReportArtifact, *, user_id) -> ReportArtifact:
    """A copy of the report as its draft stands: one new revision, owned by the caller,
    unpublished, with no public link. Its bindings keep pointing at the same governed
    charts (a chart used by another report is never deleted with this one: delete())."""
    src = get_revision(db, art, art.draft_revision_id)
    if src is None:
        raise ValueError("Báo cáo chưa có phiên bản nào để nhân bản.")
    copy = ReportArtifact(name=f"{art.name} (bản sao)"[:255], description=art.description,
                          dataset_id=art.dataset_id, owner_id=user_id)
    db.add(copy)
    db.flush()
    rev, _ = add_revision(db, copy, user_id=user_id, html=src.html, css=src.css, js=src.js,
                          bindings=list(src.bindings or []), filters=list(src.filters or []),
                          source="manual", note=f"Nhân bản từ “{art.name}” phiên bản {src.number}")
    return copy


def summaries(db: Session, arts: List[ReportArtifact]) -> List[Dict[str, Any]]:
    """`summary` for many reports in three queries (revisions, link counts), not 3 per row."""
    from sqlalchemy import func as _f

    from app.models.report_artifact import ReportArtifactPublicLink

    if not arts:
        return []
    rev_ids = {i for a in arts for i in (a.draft_revision_id, a.published_revision_id) if i}
    revs = {r.id: r for r in db.query(ReportArtifactRevision.id, ReportArtifactRevision.number,
                                      ReportArtifactRevision.content_hash, ReportArtifactRevision.bindings,
                                      _f.jsonb_array_length(ReportArtifactRevision.bindings).label("binding_count"))
            .filter(ReportArtifactRevision.id.in_(rev_ids)).all()} if rev_ids else {}
    links = dict(db.query(ReportArtifactPublicLink.artifact_id, _f.count(ReportArtifactPublicLink.id))
                 .filter(ReportArtifactPublicLink.artifact_id.in_([a.id for a in arts]),
                         ReportArtifactPublicLink.is_active.is_(True))
                 .group_by(ReportArtifactPublicLink.artifact_id).all())
    return [_summary(a, revs.get(a.draft_revision_id), revs.get(a.published_revision_id), int(links.get(a.id, 0)))
            for a in arts]


def _active_links(db: Session, art: ReportArtifact) -> int:
    from app.models.report_artifact import ReportArtifactPublicLink

    return db.query(ReportArtifactPublicLink).filter(
        ReportArtifactPublicLink.artifact_id == art.id, ReportArtifactPublicLink.is_active.is_(True)).count()


def summary(db: Session, art: ReportArtifact) -> Dict[str, Any]:
    return _summary(art, get_revision(db, art, art.draft_revision_id),
                    get_revision(db, art, art.published_revision_id), _active_links(db, art))


def _summary(art: ReportArtifact, draft, pub, active_links: int) -> Dict[str, Any]:
    return {
        "id": art.id, "name": art.name, "description": art.description, "dataset_id": art.dataset_id,
        "owner_id": str(art.owner_id) if art.owner_id else None,
        "draft_number": draft.number if draft else None, "published_number": pub.number if pub else None,
        # what the report holds: the data sources (bindings) of its draft
        "binding_count": len(draft.bindings or []) if draft else 0,
        # the saved charts it reads (draft + published): the list's Chart / Source / Dataset
        # filters relate a Vibe Report the way they relate a dashboard's tiles
        "chart_ids": sorted({int(x["chart_id"]) for r in (draft, pub) if r is not None
                             for x in (r.bindings or []) if isinstance(x, dict) and isinstance(x.get("chart_id"), int)}),
        "has_unpublished_changes": bool(draft and (not pub or draft.content_hash != pub.content_hash)),
        # Sharing lives in report_artifact_public_links (public_links.py); the retired
        # public_token / public_enabled columns are never read.
        "public_enabled": active_links > 0, "public_link_count": active_links,
        "job": job_view(art), "updated_at": art.updated_at.isoformat() if art.updated_at else None,
        "last_published_at": art.last_published_at.isoformat() if art.last_published_at else None,
    }


def revision_view(rev: ReportArtifactRevision, *, with_source: bool) -> Dict[str, Any]:
    out = {"id": rev.id, "number": rev.number, "source": rev.source, "note": rev.note,
           "content_hash": rev.content_hash, "created_by": str(rev.created_by) if rev.created_by else None,
           "created_at": rev.created_at.isoformat() if rev.created_at else None,
           "binding_count": len(rev.bindings or []), "filter_count": len(rev.filters or [])}
    if with_source:
        out.update({"html": rev.html, "css": rev.css, "js": rev.js,
                    "bindings": [{k: b.get(k) for k in ("id", "chart_id", "title", "kind")} for b in rev.bindings or []],
                    # grain/default/single are how the filter behaves (a period picker, a default
                    # value) - the studio frame needs them as much as a public link does
                    "filters": [{k: f.get(k) for k in ("key", "label", "kind", "fieldKey", "grain", "default", "single",
                                                     "default_value") if k in ("key", "label", "kind", "fieldKey")
                                 or f.get(k) not in (None, "", False)} for f in rev.filters or []],
                    "regions": D.list_regions(rev.html)})
    return out


# ── AI jobs ───────────────────────────────────────────────────────────────────

def job_view(art: ReportArtifact) -> Optional[Dict[str, Any]]:
    job = dict(art.job or {}) or None
    if job and "proposal" in job:
        # The proposed code is read through GET /proposal only, never in lists/summaries.
        job.pop("proposal")
        job["has_proposal"] = True
    if job and job.get("state") == "running":
        started = job.get("started_at")
        try:
            if started and (_now() - _dt.datetime.fromisoformat(started)).total_seconds() > JOB_STALE_AFTER_S:
                job.update({"state": "failed", "error": "Tác vụ AI không phản hồi và đã hết thời gian."})
        except ValueError:
            pass
    return job


def stage_proposal(db: Session, art: ReportArtifact, *, user_id, base_revision_id: int, html: str, css: str, js: str,
                   bindings: List[Dict[str, Any]], filters: List[Dict[str, Any]], source: str, note: Optional[str]) -> Dict[str, Any]:
    """Keep proposed code (validated, NOT saved as a revision) for review and live preview.

    Uses the report's job slot, so it cannot coexist with a running AI job; a later AI
    job replaces it (apply then refuses: the proposal is gone)."""
    current = job_view(art)
    if current and current.get("state") == "running":
        raise ValueError("Báo cáo đang có một tác vụ AI chạy — chờ nó xong rồi thử lại.")
    v = D.validate(html, css, js)
    art.job = {"id": uuid.uuid4().hex, "kind": "proposal", "state": "done", "propose": True, "base_revision_id": base_revision_id,
               "user": str(user_id) if user_id else None, "started_at": _now().isoformat(), "steps": [],
               "proposal": {"html": v.html, "css": v.css, "js": v.js, "bindings": bindings, "filters": filters,
                            "source": source, "note": note},
               "notes": list(v.warnings)}
    flag_modified(art, "job")
    return art.job


def proposal_of(art: ReportArtifact, proposal_id: str) -> Optional[Dict[str, Any]]:
    job = art.job or {}
    if job.get("id") != proposal_id or not job.get("propose") or job.get("state") != "done" or not job.get("proposal"):
        return None
    return job


class ProposalStale(ValueError):
    """The draft moved on after the proposal was made; applying it would discard that work."""


def apply_proposal(db: Session, art: ReportArtifact, *, proposal_id: str, base_number: int, user_id) -> tuple[ReportArtifactRevision, List[str]]:
    job = proposal_of(art, proposal_id)
    if job is None:
        raise ValueError("Đề xuất không còn (đã áp dụng, bị huỷ, hoặc một tác vụ AI khác đã thay thế).")
    draft = get_revision(db, art, art.draft_revision_id)
    if draft is None or draft.number != base_number or draft.id != job.get("base_revision_id"):
        raise ProposalStale(f"Bản nháp đã đổi (phiên bản {draft.number if draft else '-'}) — đề xuất được tạo trên bản cũ.")
    p = job["proposal"]
    rev, warnings = add_revision(db, art, user_id=user_id, html=p["html"], css=p["css"], js=p["js"],
                                 bindings=list(p.get("bindings") or []), filters=list(p.get("filters") or []),
                                 source=p.get("source") or "ai", note=p.get("note"))
    art.job = {**{k: v for k, v in job.items() if k != "proposal"}, "propose": False, "applied": True, "revision": rev.number}
    flag_modified(art, "job")
    return rev, warnings


def discard_proposal(art: ReportArtifact, proposal_id: str) -> bool:
    if proposal_of(art, proposal_id) is None:
        return False
    art.job = {**{k: v for k, v in art.job.items() if k != "proposal"}, "propose": False, "discarded": True}
    flag_modified(art, "job")
    return True


def start_job(db: Session, art: ReportArtifact, *, kind: str, user_id, run, propose: bool = False,
              base_revision_id: Optional[int] = None) -> Dict[str, Any]:
    """Claim the report's AI slot and run `run(db, art, progress)` in a thread.

    `run` returns (revision kwargs) or raises ValueError with a user-facing message."""
    current = job_view(art)
    if current and current.get("state") == "running":
        raise ValueError("Báo cáo đang có một tác vụ AI chạy — chờ nó xong rồi thử lại.")
    job_id = uuid.uuid4().hex
    art.job = {"id": job_id, "kind": kind, "state": "running", "step": "Bắt đầu", "steps": [],
               "started_at": _now().isoformat(), "user": str(user_id) if user_id else None}
    if propose:
        art.job.update({"propose": True, "base_revision_id": base_revision_id})
    db.commit()
    threading.Thread(target=_run_job, args=(art.id, job_id, user_id, run), name=f"report-code-{art.id}", daemon=True).start()
    return art.job


def _update_job(db: Session, artifact_id: int, job_id: str, **changes) -> bool:
    art = db.query(ReportArtifact).filter(ReportArtifact.id == artifact_id).with_for_update().first()
    if art is None or not art.job or art.job.get("id") != job_id:
        db.rollback()
        return False
    job = dict(art.job)
    if "step" in changes:
        job["steps"] = (job.get("steps") or []) + [changes["step"]]
    job.update(changes)
    art.job = job
    flag_modified(art, "job")
    db.commit()
    return True


def _run_job(artifact_id: int, job_id: str, user_id, run) -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    progress_db = SessionLocal()
    started = _now()

    def progress(step: str) -> None:
        try:
            _update_job(progress_db, artifact_id, job_id, step=step)
        except Exception:  # noqa: BLE001 - progress is advisory
            progress_db.rollback()

    try:
        art = db.query(ReportArtifact).filter(ReportArtifact.id == artifact_id).first()
        if art is None:
            return
        out = run(db, art, progress)
        if (art.job or {}).get("propose"):
            # A PROPOSAL: nothing of the report changes. Discard anything the run wrote,
            # validate the code like a save would, and keep it in the job slot until the
            # author applies or discards it (apply_proposal re-checks the base revision).
            db.rollback()
            v = D.validate(out["html"], out["css"], out["js"])
            proposal = {"html": v.html, "css": v.css, "js": v.js, "bindings": out["bindings"], "filters": out["filters"],
                        "source": out.get("source", "ai"), "note": out.get("note")}
            _update_job(progress_db, artifact_id, job_id, state="done", step="Hoàn tất (đề xuất, chưa lưu)",
                        proposal=proposal, notes=(out.get("notes") or []) + list(v.warnings), summary=out.get("summary"),
                        elapsed_ms=int((_now() - started).total_seconds() * 1000))
            return
        if out.get("name") and not (art.name or "").strip():
            art.name = out["name"]
        rev, warnings = add_revision(db, art, user_id=user_id, html=out["html"], css=out["css"], js=out["js"],
                                     bindings=out["bindings"], filters=out["filters"], source=out.get("source", "ai"),
                                     note=out.get("note"))
        db.commit()
        _update_job(progress_db, artifact_id, job_id, state="done", step="Hoàn tất", revision=rev.number,
                    notes=(out.get("notes") or []) + warnings, summary=out.get("summary"),
                    design_source=out.get("design_source"), data_source=out.get("data_source"),
                    elapsed_ms=int((_now() - started).total_seconds() * 1000))
    except ValueError as exc:
        db.rollback()
        _update_job(progress_db, artifact_id, job_id, state="failed", error=str(exc)[:500],
                    elapsed_ms=int((_now() - started).total_seconds() * 1000))
    except Exception:  # noqa: BLE001 - a background job must never crash the worker
        logger.exception("report-code: job %s on artifact %s failed", job_id, artifact_id)
        db.rollback()
        _update_job(progress_db, artifact_id, job_id, state="failed", error="Lỗi nội bộ khi chạy tác vụ AI.",
                    elapsed_ms=int((_now() - started).total_seconds() * 1000))
    finally:
        db.close()
        progress_db.close()


def frame_ancestors_for_draft() -> str:
    from app.core.config import settings

    origins = [o for o in settings.cors_origins_list if o.startswith("http")]
    return " ".join(["'self'"] + origins)


# ── Report origin + document tickets ──────────────────────────────────────────

def report_origin() -> Optional[str]:
    """The isolated origin report documents are served from, or None (opaque mode)."""
    from urllib.parse import urlsplit

    from app.core.config import settings

    configured = (settings.REPORT_ARTIFACT_ORIGIN or "").strip().rstrip("/")
    app_origins = [o.strip().rstrip("/") for o in settings.cors_origins_list if o.strip().startswith("http")]
    if configured:
        return None if configured in app_origins else configured
    for o in app_origins:
        parts = urlsplit(o)
        if parts.hostname == "localhost":
            return f"{parts.scheme}://127.0.0.1{':' + str(parts.port) if parts.port else ''}"
    return None


TICKET_TTL_S = 600


def _ticket_key() -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    from app.core.config import settings

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"appbi/report-doc-ticket/v1").derive(settings.SECRET_KEY.encode())


def make_ticket(artifact_id: int, revision_id: int, now: Optional[float] = None, edit: bool = False) -> str:
    """A short-lived, signed grant to read ONE revision's document (code, never data).

    ``edit`` also lets the holder render unsaved code (live preview) - editors only."""
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    grant = {"a": artifact_id, "r": revision_id, "e": int((now or _time.time()) + TICKET_TTL_S)}
    if edit:
        grant["w"] = 1
    body = json.dumps(grant, separators=(",", ":")).encode()
    b = base64.urlsafe_b64encode(body).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(hmac.new(_ticket_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{b}.{sig}"


def read_ticket(ticket: str, now: Optional[float] = None, need_edit: bool = False) -> Optional[tuple[int, int]]:
    import base64
    import hashlib
    import hmac
    import json
    import time as _time

    try:
        b, sig = (ticket or "").split(".", 1)
        want = base64.urlsafe_b64encode(hmac.new(_ticket_key(), b.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(want, sig):
            return None
        data = json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))
        if int(data["e"]) < (now or _time.time()):
            return None
        if need_edit and data.get("w") != 1:
            return None
        return int(data["a"]), int(data["r"])
    except Exception:  # noqa: BLE001 - any malformed ticket is simply refused
        return None


def document_url(path: str) -> tuple[str, bool]:
    """(url, isolated) for a document path under /api/v1."""
    origin = report_origin()
    return (f"{origin}/api/v1{path}", True) if origin else (f"/api/v1{path}", False)
