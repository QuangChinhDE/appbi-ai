"""Report Studio (Report-as-Code) — authenticated API.

Every endpoint is gated on the `dashboards` module at the router and on the report
itself through `get_effective_permission` (owner with module ≥ edit, or a module
administrator). Data reads additionally pass the same chart checks as
`GET /charts/{id}/data`: view on the chart and on its dataset lineage.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core import get_db
from app.core.dependencies import (
    get_effective_permission,
    require_edit_access,
    require_full_access,
    require_permission,
    require_view_access,
)
from app.models.audit_log import AuditAction
from app.models.dataset import Dataset
from app.models.report_artifact import ReportArtifact, ReportArtifactRevision
from app.models.user import User
from app.services.audit_service import audit
from app.services.report_code import bindings as B
from app.services.report_code import document as D
from app.services.report_code import generation as G
from app.services.report_code import lifecycle as L
from app.services.report_code import public_links as PL
from app.schemas.schemas import PublicLinkCreate, PublicLinkUpdate

router = APIRouter(prefix="/report-artifacts", tags=["report-artifacts"])
MODULE = "dashboards"
MAX_IMAGE_CHARS = 4_000_000
MAX_UPLOAD_CHARS = 600_000


class CreateBody(BaseModel):
    dataset_id: int
    prompt: str = Field("", max_length=4000)
    name: Optional[str] = Field(None, max_length=200)
    reference_html: Optional[str] = Field(None, max_length=MAX_UPLOAD_CHARS)
    reference_image: Optional[str] = Field(None, max_length=MAX_IMAGE_CHARS)


class EditBody(BaseModel):
    instruction: str = Field(..., min_length=2, max_length=4000)
    region: Optional[str] = Field(None, max_length=80)
    reference_image: Optional[str] = Field(None, max_length=MAX_IMAGE_CHARS)
    # The AI may add governed data (new bindings/filters) only when the author allows it.
    allow_data: bool = False


class PublicLinkPreviewRequest(BaseModel):
    """The link configuration being edited, to preview before saving it."""
    filters_config: Optional[List[Dict[str, Any]]] = None
    appearance_config: Optional[Dict[str, Any]] = None


class BlankBody(BaseModel):
    dataset_id: int
    name: Optional[str] = Field(None, max_length=200)


class SourceBody(BaseModel):
    html: str = Field("", max_length=D.MAX_HTML)
    css: str = Field("", max_length=D.MAX_CSS)
    js: str = Field("", max_length=D.MAX_JS)
    base_number: Optional[int] = None


class MetaBody(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)


class DataBody(BaseModel):
    binding: str = Field(..., max_length=20)
    state: Dict[str, Any] = Field(default_factory=dict)
    revision: Optional[int] = None


class ValuesBody(BaseModel):
    key: str = Field(..., max_length=20)
    search: str = Field("", max_length=80)
    state: Dict[str, Any] = Field(default_factory=dict)
    revision: Optional[int] = None


class PublishBody(BaseModel):
    revision_id: Optional[int] = None
    #: publish although sample numbers remain - readers then see them labelled "số mẫu"
    allow_samples: bool = False


class AddBindingBody(BaseModel):
    candidate_id: Optional[str] = Field(None, max_length=20)
    chart_id: Optional[int] = None
    title: Optional[str] = Field(None, max_length=160)


class AddFilterBody(BaseModel):
    dimension_id: str = Field(..., max_length=20)
    #: a date filter picked per month ("Kỳ"), and the period shown when nobody picked one
    grain: Optional[Literal["month"]] = None
    default: Optional[Literal["latest"]] = None


class FilterOptionsBody(BaseModel):
    grain: Optional[Literal["month"]] = None
    default: Optional[Literal["latest"]] = None
    #: one value at a time (an org picker), and the value shown until a viewer picks one
    single: bool = False
    default_value: Optional[str] = Field(None, max_length=200)


def _filter_options(kind: str, grain: Optional[str], default: Optional[str], single: bool = False,
                    default_value: Optional[str] = None) -> Dict[str, Any]:
    if grain and kind != "date":
        raise HTTPException(status_code=400, detail="Chỉ bộ lọc ngày mới chọn theo tháng.")
    if default == "latest" and kind == "date" and grain != "month":
        raise HTTPException(status_code=400, detail="Kỳ mặc định 'mới nhất' cần bộ lọc theo tháng.")
    if (single or default_value) and kind == "date":
        raise HTTPException(status_code=400, detail="Bộ lọc ngày dùng 'theo tháng' thay cho một giá trị.")
    if default and default_value:
        raise HTTPException(status_code=400, detail="Chọn một kiểu mặc định: mới nhất hoặc một giá trị.")
    out: Dict[str, Any] = {k: v for k, v in (("grain", grain), ("default", default)) if v}
    if single:
        out["single"] = True
    if default_value:
        out["default_value"] = default_value
    return out


def _image(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    if not value.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Ảnh tham chiếu phải là data URL của một ảnh.")
    return value


def _load(db: Session, artifact_id: int, user: User, level: str = "view") -> ReportArtifact:
    art = db.query(ReportArtifact).filter(ReportArtifact.id == artifact_id).first()
    if art is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy báo cáo.")
    if level == "view":
        require_view_access(db, user, art, MODULE)
    elif level == "edit":
        require_edit_access(db, user, art, MODULE)
    else:
        require_full_access(db, user, art, MODULE)
    return art


def _draft(db: Session, art: ReportArtifact) -> ReportArtifactRevision:
    rev = L.get_revision(db, art, art.draft_revision_id)
    if rev is None:
        raise HTTPException(status_code=409, detail="Báo cáo chưa có nội dung — đợi AI dựng xong.")
    return rev


def _revision_for(db: Session, art: ReportArtifact, number: Optional[int]) -> ReportArtifactRevision:
    if number is None:
        return _draft(db, art)
    rev = L.revision_by_number(db, art, number)
    if rev is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy phiên bản.")
    return rev


def _detail(db: Session, art: ReportArtifact, user: User) -> Dict[str, Any]:
    out = L.summary(db, art)
    draft = L.get_revision(db, art, art.draft_revision_id)
    out["draft"] = L.revision_view(draft, with_source=True) if draft else None
    # What a public link meets: the PUBLISHED revision's filters (the Public Modal's rows).
    pub = L.get_revision(db, art, art.published_revision_id)
    out["published_filters"] = B.public_filters(pub.filters or []) if pub else []
    out["user_permission"] = get_effective_permission(db, user, art, MODULE)
    if draft:
        out["warnings"] = D.validate(draft.html, draft.css, draft.js).warnings
    ds = db.query(Dataset).filter(Dataset.id == art.dataset_id).first() if art.dataset_id else None
    out["dataset_name"] = ds.name if ds else None
    return out


@router.get("")
def list_reports(db: Session = Depends(get_db), current_user: User = Depends(require_permission(MODULE, "view"))):
    """Every report the caller may see - no silent cut-off; the summaries are built in a
    fixed number of queries (lifecycle.summaries), not several per report."""
    rows = db.query(ReportArtifact).order_by(ReportArtifact.updated_at.desc()).all()
    levels = {a.id: get_effective_permission(db, current_user, a, MODULE) for a in rows}
    rows = [a for a in rows if levels[a.id] != "none"]
    owner_ids = {a.owner_id for a in rows if a.owner_id}
    owners = {u.id: u.email for u in db.query(User).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}
    # The same per-row facts the dashboard list carries, so /dashboards decides the
    # actions on both kinds of report the same way (UX only; every action re-checks).
    return [{**summary, "user_permission": levels[a.id], "owner_email": owners.get(a.owner_id)}
            for a, summary in zip(rows, L.summaries(db, rows))]


@router.post("", status_code=201)
def create_report(body: CreateBody, request: Request, db: Session = Depends(get_db),
                  current_user: User = Depends(require_permission(MODULE, "edit"))):
    ds = db.query(Dataset).filter(Dataset.id == body.dataset_id).first()
    if ds is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy dataset.")
    require_view_access(db, current_user, ds, "datasets")
    image = _image(body.reference_image)
    art = ReportArtifact(name=(body.name or "").strip() or "Báo cáo AI (đang dựng…)", description=body.prompt.strip()[:2000] or None,
                         dataset_id=ds.id, owner_id=current_user.id)
    db.add(art)
    db.commit()
    db.refresh(art)
    goal, name, raw, user_id = body.prompt, (body.name or "").strip() or None, body.reference_html, current_user.id
    keep_name = bool(name)

    def run(job_db, job_art, progress):
        if raw:
            out = G.import_html(job_db, dataset_id=job_art.dataset_id, raw=raw, goal=goal, name=name, owner_id=user_id, progress=progress)
            out["source"] = "ai_import"
        else:
            out = G.generate(job_db, dataset_id=job_art.dataset_id, goal=goal, name=name, owner_id=user_id,
                             progress=progress, image=image)
            out["source"] = "ai_generate"
        if not keep_name:
            job_art.name = out["name"]
        out["note"] = goal or "Tạo báo cáo"
        return out

    L.start_job(db, art, kind="import" if raw else "generate", user_id=current_user.id, run=run)
    return L.summary(db, art)


class ImportAnalyzeBody(BaseModel):
    dataset_id: int
    html: str = Field("", max_length=D.MAX_HTML * 2)
    css: str = Field("", max_length=D.MAX_CSS)
    js: str = Field("", max_length=D.MAX_JS)
    prompt: str = Field("", max_length=2000)


class ImportApplyBody(ImportAnalyzeBody):
    name: Optional[str] = Field(None, max_length=200)
    mapping: List[Dict[str, Any]] = Field(default_factory=list, max_length=80)
    filters: List[str] = Field(default_factory=list, max_length=B.MAX_FILTERS)
    artifact_id: Optional[int] = None


def _dataset_for(db: Session, user: User, dataset_id: int) -> Dataset:
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if ds is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy dataset.")
    require_view_access(db, user, ds, "datasets")
    return ds


@router.get("/context-pack")
def context_pack(dataset_id: int, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "edit"))):
    """The AI Design Context Pack for a dataset — meanings and the SDK, never data."""
    from fastapi.responses import Response

    from app.services.report_code import importer as I

    ds = _dataset_for(db, current_user, dataset_id)
    try:
        text = I.context_pack(db, dataset_id=ds.id, dataset_name=ds.name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ds.name).strip("-").lower() or "dataset"
    return Response(text, media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="appbi-context-pack-{slug}.md"'})


@router.post("/import/analyze")
def import_analyze(body: ImportAnalyzeBody, db: Session = Depends(get_db),
                   current_user: User = Depends(require_permission(MODULE, "edit"))):
    """Where the pasted code holds data, and which governed data each place should get."""
    from app.services.report_code import importer as I

    _dataset_for(db, current_user, body.dataset_id)
    try:
        return I.analyze(db, dataset_id=body.dataset_id, html=body.html, css=body.css, js=body.js, goal=body.prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/import", status_code=202)
def import_apply(body: ImportApplyBody, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "edit"))):
    """Connect pasted code to the reviewed mapping — a new report, or a new draft of one."""
    from app.services.report_code import importer as I

    ds = _dataset_for(db, current_user, body.dataset_id)
    if body.artifact_id is not None:
        art = _load(db, body.artifact_id, current_user, "edit")
        if art.dataset_id != ds.id:
            raise HTTPException(status_code=400, detail="Mã dán vào phải dùng cùng dataset với báo cáo.")
        draft = L.get_revision(db, art, art.draft_revision_id)
    else:
        art = ReportArtifact(name=(body.name or "").strip() or "Báo cáo từ mã dán", dataset_id=ds.id, owner_id=current_user.id,
                             description=body.prompt.strip()[:2000] or None)
        db.add(art)
        db.commit()
        db.refresh(art)
        draft = None
    html, css, js, mapping, filters, user_id = body.html, body.css, body.js, body.mapping, body.filters, current_user.id
    existing = list(draft.bindings or []) if draft else []
    existing_filters = list(draft.filters or []) if draft else []

    def run(job_db, job_art, progress):
        out = I.apply(job_db, dataset_id=job_art.dataset_id, html=html, css=css, js=js, mapping=mapping, filters=filters,
                      owner_id=user_id, report_name=job_art.name, existing=existing, existing_filters=existing_filters,
                      progress=progress)
        out.update({"source": "import", "note": "Dán mã HTML/CSS/JS và gắn dữ liệu", "design_source": "preserved"})
        return out

    try:
        L.start_job(db, art, kind="import", user_id=current_user.id, run=run)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return L.summary(db, art)


@router.post("/blank", status_code=201)
def create_blank(body: BlankBody, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "edit"))):
    """Code-first: a report with a commented starter page — no AI involved."""
    ds = _dataset_for(db, current_user, body.dataset_id)
    art = ReportArtifact(name=(body.name or "").strip() or "Báo cáo mới (mã nguồn)", dataset_id=ds.id, owner_id=current_user.id)
    db.add(art)
    db.flush()
    html, css, js = G.starter_page(art.name)
    L.add_revision(db, art, user_id=current_user.id, html=html, css=css, js=js, bindings=[], filters=[],
                   source="manual", note="Tạo báo cáo trống (tự viết mã)")
    db.commit()
    return L.summary(db, art)


@router.get("/{artifact_id}")
def get_report(artifact_id: int, db: Session = Depends(get_db),
               current_user: User = Depends(require_permission(MODULE, "view"))):
    return _detail(db, _load(db, artifact_id, current_user), current_user)


@router.get("/{artifact_id}/job")
def get_job(artifact_id: int, db: Session = Depends(get_db),
            current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    draft = L.get_revision(db, art, art.draft_revision_id)
    return {"job": L.job_view(art), "draft_number": draft.number if draft else None}


@router.patch("/{artifact_id}")
def update_meta(artifact_id: int, body: MetaBody, db: Session = Depends(get_db),
                current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    if body.name is not None:
        art.name = body.name.strip()
    if body.description is not None:
        art.description = body.description.strip() or None
    db.commit()
    return L.summary(db, art)


@router.delete("/{artifact_id}", status_code=204)
def delete_report(artifact_id: int, request: Request, db: Session = Depends(get_db),
                  current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "full")
    name = art.name
    removed = L.delete(db, art)
    audit(db, AuditAction.REPORT_ARTIFACT_DELETED, request=request, user_id=current_user.id,
          resource_type="report_artifact", resource_id=str(artifact_id),
          details={"name": name, "charts_removed": removed})
    db.commit()


@router.post("/{artifact_id}/duplicate", status_code=201)
def duplicate_report(artifact_id: int, request: Request, db: Session = Depends(get_db),
                     current_user: User = Depends(require_permission(MODULE, "edit"))):
    """A copy the caller owns - the same bar as duplicating a dashboard: read the source, edit the module."""
    art = _load(db, artifact_id, current_user, "view")
    _require_bindings_access(db, current_user, _draft(db, art))
    try:
        copy = L.duplicate(db, art, user_id=current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()  # like a dashboard's duplicate (and a report's create): not an audit event
    return L.summary(db, copy)


@router.get("/{artifact_id}/export-html")
def export_report_html(artifact_id: int, db: Session = Depends(get_db),
                       current_user: User = Depends(require_permission(MODULE, "view"))):
    """The report as one standalone HTML file with a data snapshot (the dashboard's
    Export HTML, for a Vibe Report). Data is minted under the caller's own rights."""
    import datetime as _dt

    art = _load(db, artifact_id, current_user, "view")
    rev = _served_revision(db, art)
    _require_bindings_access(db, current_user, rev)
    snapshot = {b["id"]: B.mint_dto(db, b, rev.filters or [], {}, public=True) for b in rev.bindings or []}
    stamp = _dt.datetime.now().strftime("%H:%M %d/%m/%Y")
    which = (f"phiên bản {rev.number} đã xuất bản" if rev.id == art.published_revision_id
             else f"bản nháp phiên bản {rev.number} (chưa xuất bản)")
    period = []
    resolved = next((d.get("state") for d in snapshot.values() if isinstance(d, dict) and d.get("state")), {}) or {}
    for f in rev.filters or []:
        v = resolved.get(f["key"])
        if v and B.is_period(f):
            period.append(f"{f['label']}: tháng {str(v[0])[5:7]}/{str(v[0])[:4]}")
        elif v:
            period.append(f"{f['label']}: " + (" – ".join(str(x) for x in v if x) if f["kind"] == "date" else ", ".join(map(str, v))))
    body = D.build_export(html=rev.html, css=rev.css, js=rev.js, title=art.name,
                          bindings=B.public_bindings(rev.bindings or []), snapshot=snapshot, stamp=stamp,
                          scope=" · ".join([which] + period), filters=B.public_filters(rev.filters or []))
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", art.name).strip("-") or "report"
    return HTMLResponse(body, headers={"Content-Disposition": f'attachment; filename="{safe}.html"',
                                       "Cache-Control": "no-store"})


@router.put("/{artifact_id}/source")
def save_source(artifact_id: int, body: SourceBody, db: Session = Depends(get_db),
                current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    if body.base_number is not None and body.base_number != draft.number:
        raise HTTPException(status_code=409, detail=f"Bản nháp đã đổi (phiên bản {draft.number}) — tải lại trước khi lưu.")
    try:
        rev, warnings = L.add_revision(db, art, user_id=current_user.id, html=body.html, css=body.css, js=body.js,
                                       bindings=list(draft.bindings or []), filters=list(draft.filters or []),
                                       source="manual", note="Sửa mã nguồn")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return {"revision": L.revision_view(rev, with_source=True), "warnings": warnings}


@router.post("/{artifact_id}/ai-edit", status_code=202)
def ai_edit(artifact_id: int, body: EditBody, db: Session = Depends(get_db),
            current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    if body.region and D.region_span(draft.html, body.region) is None:
        raise HTTPException(status_code=400, detail=f"Không tìm thấy vùng '{body.region}'.")
    image, instruction, region, user_id, base_id = _image(body.reference_image), body.instruction, body.region, current_user.id, draft.id
    allow_data = body.allow_data

    def run(job_db, job_art, progress):
        rev = L.get_revision(job_db, job_art, base_id)
        out = G.edit(job_db, artifact=job_art, revision=rev, instruction=instruction, region=region,
                     owner_id=user_id, progress=progress, image=image, allow_data=allow_data)
        out["source"] = "ai_edit"
        out["note"] = (f"[{region}] " if region else "") + instruction
        return out

    try:
        job = L.start_job(db, art, kind="edit", user_id=current_user.id, run=run)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"job": job}


@router.get("/{artifact_id}/revisions")
def list_revisions(artifact_id: int, db: Session = Depends(get_db),
                   current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    revs = db.query(ReportArtifactRevision).filter(ReportArtifactRevision.artifact_id == art.id) \
        .order_by(ReportArtifactRevision.number.desc()).limit(300).all()
    return [{**L.revision_view(r, with_source=False), "is_draft": r.id == art.draft_revision_id,
             "is_published": r.id == art.published_revision_id} for r in revs]


@router.get("/{artifact_id}/revisions/{number}")
def get_revision(artifact_id: int, number: int, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    rev = _revision_for(db, art, number)
    return {**L.revision_view(rev, with_source=True), "is_draft": rev.id == art.draft_revision_id,
            "is_published": rev.id == art.published_revision_id}


@router.post("/{artifact_id}/revisions/{number}/restore")
def restore_revision(artifact_id: int, number: int, db: Session = Depends(get_db),
                     current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    src = _revision_for(db, art, number)
    rev = L.restore(db, art, revision_id=src.id, user_id=current_user.id)
    db.commit()
    return {"revision": L.revision_view(rev, with_source=False)}


@router.post("/{artifact_id}/publish")
def publish_report(artifact_id: int, body: PublishBody, request: Request, db: Session = Depends(get_db),
                   current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "full")
    previous = L.get_revision(db, art, art.published_revision_id)
    candidate = (db.get(ReportArtifactRevision, body.revision_id) if body.revision_id is not None else None) \
        or L.get_revision(db, art, art.draft_revision_id)
    if candidate is not None and candidate.artifact_id == art.id:
        _require_bindings_access(db, current_user, candidate)
    try:
        target = L.publish(db, art, revision_id=body.revision_id, allow_samples=body.allow_samples)
    except L.SampleNumbersRemain as exc:
        raise HTTPException(status_code=409, detail={"code": "SAMPLE_NUMBERS", "message": str(exc),
                                                     "count": L.sample_marks(candidate.html if candidate else "")})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    rollback = body.revision_id is not None and body.revision_id != art.draft_revision_id
    audit(db, AuditAction.REPORT_ARTIFACT_ROLLED_BACK if rollback else AuditAction.REPORT_ARTIFACT_PUBLISHED,
          request=request, user_id=current_user.id, resource_type="report_artifact", resource_id=str(art.id),
          details={"revision": target.number, "previous": previous.number if previous else None})
    db.commit()
    refused = PL.links_refused_by(db, art, target)
    out = L.summary(db, art)
    if refused:
        out["warnings"] = [f"Liên kết “{n}” sẽ ngừng hiển thị: nó khoá một bộ lọc mà phiên bản {target.number} "
                           "không có. Sửa bộ lọc của liên kết hoặc xuất bản phiên bản có bộ lọc đó." for n in refused]
    return out


# ── Public links (the dashboard model: many named links per report) ─────────────
# Listing is a view-level read; the token (the anonymous bearer capability) and every
# change need FULL access — the same bar as publishing, as for dashboards.

def _link_out(db: Session, link, *, with_token: bool) -> Dict[str, Any]:
    """A link as the publisher's client receives it: never a secret. The link's own AI
    key lives in the encrypted credential store; the link holds only its id (as on a
    dashboard link: api/dashboards.py:_sanitize_link_for_admin)."""
    out = PL.view(link, with_token=with_token)
    raw = dict(out.get("appearance_config") or {})
    raw.pop("ai_bot_key", None)
    raw["ai_bot_key_configured"] = bool(raw.get("ai_bot_credential_id"))
    if raw.get("ai_bot_credential_id"):
        from app.models.ai_provider_credential import AiProviderCredential

        cred = db.get(AiProviderCredential, int(raw["ai_bot_credential_id"]))
        raw["ai_bot_key_hint"] = str(getattr(cred, "key_hint", "") or "")[-4:] if cred is not None else ""
    out["appearance_config"] = raw
    return out


def _link_catalog(db: Session, art: ReportArtifact, link) -> dict:
    """What the link's AI Bot reads (published charts, the link's locks) — built
    exactly as a turn builds it, for the publisher guide's pickers and save check."""
    from app.services.answer_core.published_report import PublishedReportScope
    from app.services.answer_core.publisher_guide import catalog_payload
    from app.services.report_code import public_bot as PB

    rev = L.get_revision(db, art, art.published_revision_id)
    if rev is None:
        return {"charts": [], "fields": []}
    ctx = PB.build_context(db, rev, link, {})
    return catalog_payload(PublishedReportScope(db, ctx=ctx, link_id=PB.ledger_link_id(link.id),
                                                turn_id=f"guide-r{link.id}"))


def _stored_appearance(db: Session, user: User, art: ReportArtifact, incoming: Optional[dict], link=None) -> dict:
    """The appearance to STORE: no plaintext key ever (moved to the encrypted store),
    a credential only the saver owns, a model the key can call, a well-formed guide
    naming only what the link's bot reads - the dashboard link's rules, reused."""
    from app.api.dashboards import _apply_ai_credential, _with_checked_guide

    out = _apply_ai_credential(db, user, dict(incoming or {}), dict(getattr(link, "appearance_config", None) or {}),
                               getattr(link, "id", None))
    return _with_checked_guide(out, (lambda: _link_catalog(db, art, link)) if link is not None else None)


def _can_publish(db: Session, user: User, art: ReportArtifact) -> bool:
    from app.core.dependencies import get_effective_permission

    return get_effective_permission(db, user, art, MODULE) == "full"


@router.get("/{artifact_id}/public-links")
def list_public_links(artifact_id: int, db: Session = Depends(get_db),
                      current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    publisher = _can_publish(db, current_user, art)
    return [_link_out(db, link, with_token=publisher) for link in PL.list_links(db, art)]


@router.post("/{artifact_id}/public-links", status_code=status.HTTP_201_CREATED)
def create_public_link(artifact_id: int, body: PublicLinkCreate, request: Request, db: Session = Depends(get_db),
                       current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "full")
    _require_bindings_access(db, current_user, _served_revision(db, art))
    try:
        link = PL.create(db, art, name=body.name, filters_config=body.filters_config,
                         appearance_config=_stored_appearance(db, current_user, art, body.appearance_config),
                         password=body.password,
                         expires_at=body.expires_at, user_id=current_user.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit(db, AuditAction.PUBLIC_LINK_CREATED, request=request, user_id=current_user.id,
          resource_type="report_artifact", resource_id=str(art.id), details={"link": link.id, "name": link.name})
    db.commit()
    db.refresh(link)
    return _link_out(db, link, with_token=True)


@router.post("/{artifact_id}/public-links/preview")
def preview_public_link(artifact_id: int, body: PublicLinkPreviewRequest, db: Session = Depends(get_db),
                        current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    _require_bindings_access(db, current_user, _served_revision(db, art))
    try:
        # a preview shows the report; it never opens (or spends) the AI bot nor carries a key
        appearance = {k: v for k, v in dict(body.appearance_config or {}).items() if not str(k).startswith("ai_bot")}
        token, expires_at = PL.make_preview(db, art, body.filters_config, appearance)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"token": token, "expires_at": expires_at}


@router.patch("/{artifact_id}/public-links/{link_id}")
def update_public_link(artifact_id: int, link_id: int, body: PublicLinkUpdate, request: Request,
                       db: Session = Depends(get_db), current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "full")
    link = PL.get_link(db, art, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy liên kết.")
    _require_bindings_access(db, current_user, _served_revision(db, art))
    fields = {k: getattr(body, k) for k in body.model_fields_set}
    if fields.get("appearance_config") is not None:
        fields["appearance_config"] = _stored_appearance(db, current_user, art, fields["appearance_config"], link)
    try:
        PL.update(db, art, link, fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    audit(db, AuditAction.PUBLIC_LINK_UPDATED, request=request, user_id=current_user.id,
          resource_type="report_artifact", resource_id=str(art.id),
          details={"link": link.id, "fields": sorted(k for k in fields if k != "password"),
                   "password_changed": "password" in fields})
    db.commit()
    db.refresh(link)
    return _link_out(db, link, with_token=True)


@router.get("/{artifact_id}/public-links/{link_id}/ai-status")
def public_link_ai_status(artifact_id: int, link_id: int, db: Session = Depends(get_db),
                          current_user: User = Depends(require_permission(MODULE, "edit"))):
    """Is the model ready for this link's AI Bot? Never a key, never a credential secret."""
    from app.services.ai_runtime import gateway

    art = _load(db, artifact_id, current_user, "full")
    link = PL.get_link(db, art, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy liên kết.")
    return {**gateway.readiness(db, dict(link.appearance_config or {})), "models": gateway.answer_models()}


@router.get("/{artifact_id}/public-links/{link_id}/ai/catalog")
def public_link_ai_catalog(artifact_id: int, link_id: int, db: Session = Depends(get_db),
                           current_user: User = Depends(require_permission(MODULE, "edit"))):
    """What the link's AI Bot can read, for the publisher guide's pickers."""
    art = _load(db, artifact_id, current_user, "full")
    link = PL.get_link(db, art, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy liên kết.")
    return _link_catalog(db, art, link)


@router.delete("/{artifact_id}/public-links/{link_id}")
def delete_public_link(artifact_id: int, link_id: int, request: Request, db: Session = Depends(get_db),
                       current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "full")
    link = PL.get_link(db, art, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy liên kết.")
    db.delete(link)
    audit(db, AuditAction.PUBLIC_LINK_DELETED, request=request, user_id=current_user.id,
          resource_type="report_artifact", resource_id=str(art.id), details={"link": link_id})
    db.commit()
    return {"deleted": link_id}


@router.post("/{artifact_id}/document-ticket")
def document_ticket(artifact_id: int, revision: Optional[int] = None, db: Session = Depends(get_db),
                    current_user: User = Depends(require_permission(MODULE, "view"))):
    """Where the studio frame loads a revision from: the isolated report origin, with a
    10-minute signed ticket (cookies of the app never reach that origin)."""
    art = _load(db, artifact_id, current_user)
    rev = _revision_for(db, art, revision)
    from app.core.dependencies import get_effective_permission
    can_edit = get_effective_permission(db, current_user, art, MODULE) in ("edit", "full")
    url, isolated = L.document_url(f"/public/report-docs/{L.make_ticket(art.id, rev.id, edit=can_edit)}")
    return {"url": url, "isolated": isolated, "revision": rev.number}


def _check_chart_access(db: Session, user: User, chart_id: int) -> None:
    from app.services import dataset_grants_service
    from app.services.chart_service import ChartService
    from app.services.dataset_crud import DatasetCRUDService

    chart = ChartService.get_by_id(db, chart_id)
    if chart is None:
        raise HTTPException(status_code=404, detail="Biểu đồ của nguồn dữ liệu này không còn tồn tại.")
    if get_effective_permission(db, user, chart, "explore_charts") == "none":
        raise HTTPException(status_code=403, detail="Bạn không có quyền xem dữ liệu của phần này.")
    if chart.dataset_table_id is not None:
        dt = DatasetCRUDService.get_table_by_id(db, chart.dataset_table_id)
        if dt is not None and getattr(dt, "dataset_id", None) is not None:
            dataset_grants_service.require_view_lineage(db, user, dt.dataset_id)


def _require_bindings_access(db: Session, user: User, rev: ReportArtifactRevision) -> None:
    """Every bound chart and its dataset lineage readable by `user` — the bar /data sets.

    A share on a REPORT is not a grant on its DATA. Every path that turns a report into
    numbers someone else can read (export, a copy the caller owns, publish, a public
    link, its preview) must clear it, or the report is a way around the data's rights."""
    for b in rev.bindings or []:
        if isinstance(b, dict) and b.get("chart_id") is not None:
            _check_chart_access(db, user, int(b["chart_id"]))


def _served_revision(db: Session, art: ReportArtifact) -> ReportArtifactRevision:
    """What a public link (or an export) shows: the published revision, else the draft."""
    return L.get_revision(db, art, art.published_revision_id) or _draft(db, art)


@router.post("/{artifact_id}/data")
def binding_data(artifact_id: int, body: DataBody, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    rev = _revision_for(db, art, body.revision)
    binding = next((b for b in rev.bindings or [] if b.get("id") == body.binding), None)
    if binding is None:
        raise HTTPException(status_code=404, detail="Nguồn dữ liệu không thuộc báo cáo này.")
    try:
        state = B.clean_state(rev.filters or [], body.state)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _check_chart_access(db, current_user, int(binding["chart_id"]))
    ds = db.query(Dataset).filter(Dataset.id == art.dataset_id).first() if art.dataset_id else None
    return B.mint_dto(db, binding, rev.filters or [], state, source_label=ds.name if ds else None)


@router.post("/{artifact_id}/values")
def filter_values(artifact_id: int, body: ValuesBody, db: Session = Depends(get_db),
                  current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    rev = _revision_for(db, art, body.revision)
    try:
        state = B.clean_state(rev.filters or [], body.state)
        decl = rev.filters or []
        f = next((x for x in decl if x["key"] == body.key), None)
        if f is None:
            raise ValueError("Bộ lọc không có trong báo cáo.")
        ds = db.query(Dataset).filter(Dataset.id == f["datasetId"]).first()
        if ds is None:
            raise ValueError("Dataset của bộ lọc không còn tồn tại.")
        require_view_access(db, current_user, ds, "datasets")
        return {"values": B.filter_values(db, decl, state, body.key, body.search)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{artifact_id}/catalog")
def data_catalog(artifact_id: int, db: Session = Depends(get_db),
                 current_user: User = Depends(require_permission(MODULE, "view"))):
    art = _load(db, artifact_id, current_user)
    if not art.dataset_id:
        return {"candidates": [], "dimensions": []}
    try:
        model = B.load_model(db, art.dataset_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    cands = sorted(B.candidates(model), key=lambda c: (c.get("rank", 9), c["id"]))
    return {"candidates": [{"id": c["id"], "kind": c["kind"], "type": c["type"], "title": c["title"]} for c in cands[:300]],
            "dimensions": [{"id": d["id"], "label": d["label"], "kind": d["kind"]} for d in B.filter_dimensions(model, art.dataset_id)]}


def _new_data_revision(db: Session, art: ReportArtifact, draft: ReportArtifactRevision, user: User, *,
                       bindings: List[Dict[str, Any]], filters: List[Dict[str, Any]], note: str) -> Dict[str, Any]:
    rev, warnings = L.add_revision(db, art, user_id=user.id, html=draft.html, css=draft.css, js=draft.js,
                                   bindings=bindings, filters=filters, source="data", note=note)
    db.commit()
    return {"revision": L.revision_view(rev, with_source=True), "warnings": warnings}


@router.post("/{artifact_id}/bindings")
def add_binding(artifact_id: int, body: AddBindingBody, db: Session = Depends(get_db),
                current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    bindings = list(draft.bindings or [])
    if len(bindings) >= B.MAX_BINDINGS:
        raise HTTPException(status_code=400, detail="Báo cáo đã đủ số nguồn dữ liệu tối đa.")
    model = B.load_model(db, art.dataset_id)
    meta = B.field_meta(model)
    if body.chart_id is not None:
        from app.services.chart_service import ChartService
        from app.services.dataset_crud import DatasetCRUDService

        _check_chart_access(db, current_user, body.chart_id)
        chart = ChartService.get_by_id(db, body.chart_id)
        dt = DatasetCRUDService.get_table_by_id(db, chart.dataset_table_id) if chart.dataset_table_id else None
        if dt is None or dt.dataset_id != art.dataset_id:
            raise HTTPException(status_code=400, detail="Chỉ gắn được biểu đồ thuộc cùng dataset của báo cáo.")
        b = B.make_binding(B.next_binding_id(bindings), chart, body.title or chart.name, meta)
        added = [b]
    elif body.candidate_id:
        cand = next((c for c in B.candidates(model) if c["id"] == body.candidate_id), None)
        if cand is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy dữ liệu đề xuất.")
        added, _m, notes = B.bind_candidates(db, [(cand, body.title or "")], existing=bindings, owner_id=current_user.id,
                                             dataset_id=art.dataset_id, prefix=f"[Code] {art.name}", meta=meta)
        if not added:
            raise HTTPException(status_code=400, detail=(notes or ["Truy vấn không trả về số liệu."])[0])
    else:
        raise HTTPException(status_code=400, detail="Cần candidate_id hoặc chart_id.")
    out = _new_data_revision(db, art, draft, current_user, bindings=bindings + added, filters=list(draft.filters or []),
                             note=f"Thêm dữ liệu {added[0]['id']}: {added[0]['title']}")
    out["binding"] = {k: added[0].get(k) for k in ("id", "chart_id", "title", "kind")}
    return out


@router.delete("/{artifact_id}/bindings/{binding_id}")
def remove_binding(artifact_id: int, binding_id: str, db: Session = Depends(get_db),
                   current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    bindings = [b for b in draft.bindings or [] if b.get("id") != binding_id]
    if len(bindings) == len(draft.bindings or []):
        raise HTTPException(status_code=404, detail="Nguồn dữ liệu không thuộc báo cáo này.")
    return _new_data_revision(db, art, draft, current_user, bindings=bindings, filters=list(draft.filters or []),
                              note=f"Gỡ dữ liệu {binding_id}")


@router.post("/{artifact_id}/filters")
def add_filter(artifact_id: int, body: AddFilterBody, db: Session = Depends(get_db),
               current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    decl = list(draft.filters or [])
    if len(decl) >= B.MAX_FILTERS:
        raise HTTPException(status_code=400, detail="Báo cáo đã đủ số bộ lọc tối đa.")
    dims = B.filter_dimensions(B.load_model(db, art.dataset_id), art.dataset_id)
    d = next((x for x in dims if x["id"] == body.dimension_id), None)
    if d is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy chiều dữ liệu.")
    if any(f["fieldKey"] == d["fieldKey"] for f in decl):
        raise HTTPException(status_code=400, detail="Bộ lọc này đã có.")
    key = f"f{max([int(f['key'][1:]) for f in decl if f['key'][1:].isdigit()] + [0]) + 1}"
    decl.append({"key": key, "label": d["label"], "kind": d["kind"], "fieldKey": d["fieldKey"], "field": d["field"],
                 "datasetId": d["datasetId"], **_filter_options(d["kind"], body.grain, body.default)})
    out = _new_data_revision(db, art, draft, current_user, bindings=list(draft.bindings or []), filters=decl,
                             note=f"Thêm bộ lọc {key}: {d['label']}")
    out["filter"] = {"key": key, "label": d["label"], "kind": d["kind"]}
    return out


@router.patch("/{artifact_id}/filters/{key}")
def set_filter_options(artifact_id: int, key: str, body: FilterOptionsBody, db: Session = Depends(get_db),
                       current_user: User = Depends(require_permission(MODULE, "edit"))):
    """A declared filter's grain / default period — a new draft revision, like any change."""
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    decl, found = [], None
    for f in draft.filters or []:
        if f.get("key") == key:
            found = {k: v for k, v in f.items() if k not in ("grain", "default", "single", "default_value")}
            found.update(_filter_options(found["kind"], body.grain, body.default, body.single, body.default_value))
            decl.append(found)
        else:
            decl.append(f)
    if found is None:
        raise HTTPException(status_code=404, detail="Bộ lọc không có trong báo cáo.")
    return _new_data_revision(db, art, draft, current_user, bindings=list(draft.bindings or []), filters=decl,
                              note=f"Bộ lọc {key}: " + (", ".join(f"{k}={v}" for k, v in found.items()
                                                                  if k in ("grain", "default", "single", "default_value"))
                                                  or "mặc định"))


@router.delete("/{artifact_id}/filters/{key}")
def remove_filter(artifact_id: int, key: str, db: Session = Depends(get_db),
                  current_user: User = Depends(require_permission(MODULE, "edit"))):
    art = _load(db, artifact_id, current_user, "edit")
    draft = _draft(db, art)
    decl = [f for f in draft.filters or [] if f.get("key") != key]
    if len(decl) == len(draft.filters or []):
        raise HTTPException(status_code=404, detail="Bộ lọc không có trong báo cáo.")
    return _new_data_revision(db, art, draft, current_user, bindings=list(draft.bindings or []), filters=decl,
                              note=f"Gỡ bộ lọc {key}")
