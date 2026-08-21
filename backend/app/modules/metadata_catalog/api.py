"""
API: /api/v1/catalog/*  — powers AppBI's Govern + Observability modules.

NATIVE backend (no OpenMetadata): Glossary + Classification are AppBI's own
Postgres tables (GovernanceService); Metrics + Data Quality + Incidents come from
AppBI's semantic/quality engines; Alerts are derived live from the quality engine.
Nothing depends on a 3rd-party catalog server.

Mounted only when settings.METADATA_CATALOG_ENABLED is True (see app/api/__init__.py).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_edit_access, require_permission
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import Chart, Dashboard, Dataset, DatasetTable
from app.models.resource_share import ResourceShare, ResourceType
from app.models.semantic import SemanticView
from app.models.user import User
from app.services.governance_service import GovernanceError, GovernanceService

logger = logging.getLogger("app.metadata_catalog.api")

# ── Module-permission floor for the ENTIRE /catalog router (Govern + Intelligence)
# Mirrors how every other module gates its API: reads (GET) need govern:view,
# writes (PUT/POST/DELETE/PATCH) need govern:edit. ONE method-based gate — no
# per-endpoint drift. Admin back-fill + scoped-token caps are inherited from
# require_permission(). Previously these endpoints only checked authentication
# (get_current_user), so a user with govern:none/view could read AND write ALL
# knowledge (metrics, glossary, rules, playbooks, QA, caveats, AI scope, docs) —
# unlike dashboards/datasets/observability which enforce require_permission. This
# closes that gap and makes the Intelligence group consistent with the system.
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_CATALOG_CHECKERS = {
    m: {"view": require_permission(m, "view"), "edit": require_permission(m, "edit")}
    for m in ("govern", "datasets", "observability")
}

#: Paths whose UI has been deleted.
#:
#: AI Readiness, AI Suggestions and AI Guidance were four sidebar entries carved
#: out of one Knowledge Hub for permission reasons (see 80f5074, then 2b1beb7).
#: The screens are gone; these routes are not, because deleting sixty-odd handlers
#: is a separate change from removing the navigation.
#:
#: They answer 404 rather than being reassigned to `govern`. Mapping an orphaned
#: endpoint onto a surviving module's key silently WIDENS that key: a Documents
#: editor would gain write access to rules, playbooks and the review ledger they
#: were never granted. 404 says what is true — the feature is not here.
_DELETED_PREFIXES = (
    "rules", "playbooks", "qa", "instructions", "ai-scope",
    "review-items", "review", "intelligence", "certify", "ai-draft",
)
# `caveats` was in this list for one build and it was wrong: a data caveat is a
# warning attached to a metric, authored on the Metrics & Terms screen, not part
# of AI Guidance. The 404 showed up in the browser console on a page that still
# works — the kind of half-break a route test would have passed.

#: Metrics & Terms follows the dataset it describes, so it is granted by
#: `datasets` — one module, one key, the rule the rest of the matrix already
#: follows. Everything a metric or a glossary term means is a statement ABOUT a
#: dataset, which is why it moves there rather than keeping a key of its own.
_DATASET_PREFIXES = (
    "managed-metric", "metrics", "metric-", "metric", "vocab-",
    "glossary", "glossaries", "term", "classification", "classifications", "tag", "tags",
    "caveats",
)

#: Documents — the one catalog module that is still its own destination.
_GOVERN_PREFIXES = (
    "knowledge", "search", "graph", "asset-docs", "change-log",
    "google-connection", "vector-store-health", "embedding-profiles",
)


def _catalog_module_for(path: str) -> str:
    """Map a /catalog/* request path to the module that grants it.

    Returns "" for a path belonging to a deleted feature; the gate turns that into
    a 404. An unknown path also returns "" — fail closed, because a new endpoint
    that nobody assigned a key should not inherit one by accident.
    """
    sub = path.split("/catalog/", 1)[-1] if "/catalog/" in path else path
    if sub.startswith("observability/"):
        return "observability"
    if sub.startswith("govern/"):
        rest = sub[len("govern/"):]
        if rest.startswith(_DELETED_PREFIXES):
            return ""
        if rest.startswith(_DATASET_PREFIXES):
            return "datasets"
        if rest.startswith(_GOVERN_PREFIXES):
            return "govern"
    return ""


async def govern_module_gate(request: Request, user: User = Depends(get_current_user)) -> User:
    """Per-module floor for the whole /catalog router: reads → <module>:view,
    writes → <module>:edit. One gate, no per-endpoint drift.

    An unmapped path 404s. It used to fall through to the group's cockpit key,
    which meant a new endpoint was reachable by anyone with that key before
    anybody decided it should be — the convenient default, and the wrong one.
    """
    module = _catalog_module_for(request.url.path)
    if not module:
        raise HTTPException(status_code=404, detail="Not Found")
    level = "view" if request.method in _READ_METHODS else "edit"
    return await _CATALOG_CHECKERS[module][level](user=user)


router = APIRouter(
    prefix="/catalog",
    tags=["catalog"],
    dependencies=[Depends(govern_module_gate)],
)


def _run(fn):
    """Run a GovernanceService call, mapping its GovernanceError → HTTP error."""
    try:
        return fn()
    except GovernanceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)


# ── Status ──────────────────────────────────────────────────────────────────
@router.get("/status")
def catalog_status(_: User = Depends(get_current_user)) -> dict[str, Any]:
    """Native backend — always connected when the router is mounted."""
    return {"enabled": True, "connected": True}


# ════════════════════════ GOVERN: GLOSSARY ═════════════════════════════════
# Native: glossaries hold terms (synonyms, status). `machine_name` is the stable
# id (FQN = glossary.machine.term.machine); display name / description / synonyms
# are editable. System-provider items are read-only.
class GlossaryWrite(BaseModel):
    name: str                          # display text the user typed
    description: str | None = None
    machine_name: str | None = None    # set on EDIT (keep name stable); derived on CREATE


class TermWrite(BaseModel):
    glossary: str                      # glossary machine name the term belongs to
    name: str
    description: str | None = None
    synonyms: list[str] = []
    machine_name: str | None = None


@router.get("/govern/glossaries")
def govern_glossaries(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    items = GovernanceService.list_glossaries(db)
    return {"glossaries": items, "total": len(items)}


@router.put("/govern/glossary")
def upsert_glossary(body: GlossaryWrite, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.upsert_glossary(db, body.name, body.machine_name, body.description))


@router.delete("/govern/glossary/{fqn:path}")
def delete_glossary(fqn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.delete_glossary(db, fqn))


@router.get("/govern/glossary")
def govern_glossary(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """All glossary terms; the FE filters by glossary chip client-side."""
    terms = GovernanceService.list_terms(db)
    return {"terms": terms, "total": len(terms)}


@router.put("/govern/glossary-term")
def upsert_term(body: TermWrite, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.upsert_term(db, body.glossary, body.name, body.machine_name, body.description, body.synonyms))


@router.delete("/govern/glossary-term/{fqn:path}")
def delete_term(fqn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.delete_term(db, fqn))


# ════════════════════════ GOVERN: CLASSIFICATION ═══════════════════════════
# Classifications group Tags. mutuallyExclusive = single-select ("classify",
# e.g. one Tier only) vs multi-select ("categorize"). Seeded standard groups
# (PII/Tier/…) are provider="system" → read-only.
class ClassificationWrite(BaseModel):
    name: str
    description: str | None = None
    mutuallyExclusive: bool = False
    machine_name: str | None = None


class TagWrite(BaseModel):
    classification: str                # classification machine name the tag belongs to
    name: str
    description: str | None = None
    machine_name: str | None = None


@router.get("/govern/classifications")
def govern_classifications(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    items = GovernanceService.list_classifications(db)
    return {"classifications": items, "total": len(items)}


@router.put("/govern/classification")
def upsert_classification(body: ClassificationWrite, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.upsert_classification(db, body.name, body.machine_name, body.description, body.mutuallyExclusive))


@router.delete("/govern/classification/{fqn:path}")
def delete_classification(fqn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.delete_classification(db, fqn))


@router.get("/govern/tags")
def govern_tags(classification: str | None = Query(default=None), db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """Tags of a classification; omit `classification` to list ALL tags (assignment picker)."""
    items = GovernanceService.list_tags(db, classification)
    return {"tags": items, "total": len(items)}


@router.put("/govern/tag")
def upsert_tag(body: TagWrite, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.upsert_tag(db, body.classification, body.name, body.machine_name, body.description))


@router.delete("/govern/tag/{fqn:path}")
def delete_tag(fqn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _run(lambda: GovernanceService.delete_tag(db, fqn))


# ════════════ GOVERN: MANAGED METRICS (metrics quản trị doanh nghiệp) ════════
# AUTHORED KPIs a business governs by — definition, formula, unit, grain, target,
# owner, physical binding, status/version. This is the DATA-ENTRY surface (nhập
# liệu) that produces accurate business context; distinct from the derived
# semantic measures under /govern/metrics. The AI reads these as authoritative.
class ManagedMetricWrite(BaseModel):
    name: str                              # display name the user typed
    machine_name: str | None = None        # set on EDIT (keep stable); derived on CREATE
    definition: str | None = None
    formula: str | None = None
    unit: str | None = None
    grain: str | None = None               # daily|weekly|monthly|quarterly|yearly|point_in_time
    category: str | None = None
    direction: str | None = "neutral"      # up_good|down_good|neutral
    target_value: float | None = None
    target_operator: str | None = None     # >= | <= | = | between
    target_value2: float | None = None
    owner: str | None = None
    related_term_fqn: str | None = None
    # THE PRIMARY realization. Kept for clients written before `bindings`, and
    # mirrored from whichever binding is primary on every write.
    dataset_id: int | None = None
    dataset_table_id: int | None = None
    measure_ref: str | None = None
    # EVERY place this definition is computed. `None` means "leave them alone" —
    # an older client sending only the scalar fields must not wipe the others.
    bindings: list[dict[str, Any]] | None = None
    home_doc_id: int | None = None         # knowledge doc where this metric is DEFINED (home/SSOT)
    anchor: str | None = None
    synonyms: list[str] = []
    status: str | None = "Draft"           # Draft|Approved|Deprecated


@router.get("/govern/managed-metrics")
def govern_managed_metrics(
    category: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {"metrics": GovernanceService.list_managed_metrics(db, category, status)}


@router.get("/govern/managed-metric/{name}")
def govern_managed_metric(name: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    m = GovernanceService.get_managed_metric(db, name)
    if m is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy chỉ số quản trị.")
    return m


@router.put("/govern/managed-metric")
def upsert_managed_metric(
    body: ManagedMetricWrite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.upsert_managed_metric(db, body.model_dump(), changed_by=who))


@router.delete("/govern/managed-metric/{name}")
def delete_managed_metric(name: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.delete_managed_metric(db, name, changed_by=who))


@router.get("/govern/change-log")
def govern_change_log(
    entity_type: str | None = Query(default=None),
    entity_fqn: str | None = Query(default=None),
    limit: int = Query(default=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Evolution of the business domain (log theo sự phát triển) — audit trail
    of every governed-knowledge change."""
    return {"entries": GovernanceService.list_change_log(db, entity_type, entity_fqn, limit)}


# ════════════ GOVERN: KNOWLEDGE HUB (Cẩm nang tri thức) ══════════════════════
# Rich-text knowledge articles organized into spaces + a page tree — the
# onboarding "kho tàng" where a business records how its whole reporting system
# works, with metrics/glossary/dashboards riding along as related links.
class KnowledgeDocWrite(BaseModel):
    id: int | None = None                 # set on EDIT
    title: str
    space: str | None = "Chung"
    parent_id: int | None = None
    position: int | None = 0
    doc_type: str | None = "article"      # overview|guide|domain|process|faq|article
    summary: str | None = None
    body: str | None = None               # markdown
    tags: list[str] = []
    related_metrics: list[str] = []
    related_terms: list[str] = []
    related_dashboard_ids: list[int] = []
    related_dataset_ids: list[int] = []
    status: str | None = "Draft"          # Draft|Published|Archived
    pinned: bool | None = False
    owner: str | None = None
    change_note: str | None = None        # optional note recorded on the version snapshot
    # Knowledge Hub metadata (AI-readable node + review workflow)
    business_domain: str | None = None
    process_ref: str | None = None
    review_date: str | None = None        # "YYYY-MM-DD"
    importance: str | None = None         # low|normal|high
    # External-embedding control. `None` means "leave as it is" — the service
    # only writes these when the key is actually present in the payload.
    # None = leave unchanged. See GovernanceService.upsert_knowledge_doc: the
    # payload always carries every optional key, so presence cannot mean intent.
    external_processing: str | None = None   # none | embedding | full
    sensitivity: str | None = None           # internal|confidential|restricted
    # Used only when the document is created. Existing documents can switch
    # model only through the explicit vector reset endpoint.
    embedding_model: str | None = None


@router.get("/govern/knowledge")
def govern_knowledge_list(
    space: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "docs": GovernanceService.list_knowledge_docs(db, user, space, status),
        "spaces": GovernanceService.knowledge_spaces(db, user),
    }


@router.get("/govern/knowledge/insights")
def govern_knowledge_insights(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Knowledge-health lists (missing owner/summary/tags, stale review, not
    embedded) + most viewed / most retrieved — for knowledge managers."""
    return GovernanceService.knowledge_insights(db, user)


@router.get("/govern/search")
def govern_search_everything(
    q: str = Query(default=""), db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Search everything inside the Knowledge Hub — documents, governed KPIs,
    business terms, dashboards, datasets — grouped results."""
    return GovernanceService.govern_search(db, q, user)


@router.get("/govern/graph")
def govern_knowledge_graph(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Cross-layer AppBI knowledge network, including disconnected assets."""
    return GovernanceService.knowledge_graph(db, user)


@router.get("/govern/knowledge-map")
def govern_knowledge_map(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    """Backward-compatible alias for clients that used the former Map tab."""
    return GovernanceService.knowledge_graph(db, user)


@router.get("/govern/knowledge/{doc_id}")
def govern_knowledge_get(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    d = _run(lambda: GovernanceService.get_knowledge_doc(db, doc_id, user))
    if d is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy trang tri thức.")
    # Usage telemetry (fire-and-forget): the doc was opened for reading.
    try:
        from sqlalchemy import text as _t
        db.execute(_t("UPDATE govern_knowledge_docs SET view_count = COALESCE(view_count,0) + 1, last_viewed_at = NOW() WHERE id = :i"), {"i": doc_id})
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return d


@router.post("/govern/knowledge/{doc_id}/verify")
def govern_knowledge_verify(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Owner attests the document is still correct → refreshes the review clock."""
    return _run(lambda: GovernanceService.verify_knowledge_doc(db, doc_id, changed_by=getattr(user, "email", None), current_user=user))


@router.post("/govern/knowledge/{doc_id}/ai-summary")
def govern_knowledge_ai_summary(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Force-regenerate the AI summary/keywords for a document."""
    from app.models.governance import GovernKnowledgeDoc
    from app.services.dashboard_ai_bot.govern_ai_summary import generate_summary
    d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
    if d is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy trang tri thức.")
    _run(lambda: GovernanceService._require_doc(db, user, d, "edit"))
    status = generate_summary(db, d, force=True)
    if status not in ("generated", "unchanged"):
        raise HTTPException(status_code=503, detail=f"AI chưa sinh được tóm tắt ({status}). Kiểm tra khoá AI.")
    return {"ok": True, "ai_summary": d.ai_summary, "ai_keywords": d.ai_keywords or []}


@router.put("/govern/knowledge")
def govern_knowledge_upsert(
    body: KnowledgeDocWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.upsert_knowledge_doc(db, body.model_dump(), changed_by=who, current_user=user))


class KnowledgeAIDraftReq(BaseModel):
    # A knowledge doc usually spans several sources — accept a list. `dataset_id`
    # is kept for backward compatibility with older single-select callers.
    dataset_ids: list[int] = []
    dataset_id: int | None = None
    dashboard_ids: list[int] = []
    focus: str | None = None


@router.post("/govern/knowledge/ai-draft")
def govern_knowledge_ai_draft(
    body: KnowledgeAIDraftReq, db: Session = Depends(get_db), _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """AI reads the real model + sample + metrics of ONE OR MORE datasets (plus
    optional dashboards and a focus) and drafts a business document (unsaved).
    The user reviews/edits before saving."""
    from app.services.dashboard_ai_bot.govern_ai_draft import draft_document
    ids = body.dataset_ids or ([body.dataset_id] if body.dataset_id else [])
    if not ids:
        raise HTTPException(status_code=422, detail="Chọn ít nhất một dataset.")
    draft = draft_document(db, ids, body.dashboard_ids, body.focus)
    if draft is None:
        raise HTTPException(
            status_code=503,
            detail="AI chưa soạn được tài liệu. Kiểm tra dataset tồn tại và đã cấu hình khoá AI (OPENAI/GEMINI/ANTHROPIC).",
        )
    return draft


@router.delete("/govern/knowledge/{doc_id}")
def govern_knowledge_delete(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.delete_knowledge_doc(db, doc_id, changed_by=who, current_user=user))


@router.get("/govern/asset-docs")
def govern_asset_docs(
    asset_type: str = Query(...),   # dashboard | dataset | term
    asset_ref: str = Query(...),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Reverse lineage: knowledge docs that reference a given report/dataset/term
    (so an asset's Govern view can show 'documented in …')."""
    return {"docs": GovernanceService.docs_referencing_asset(db, asset_type, asset_ref)}


@router.get("/govern/knowledge/{doc_id}/versions")
def govern_knowledge_versions(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Locked version history of a business document (evolution over time)."""
    _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    return {"versions": GovernanceService.list_doc_versions(db, doc_id)}


@router.get("/govern/knowledge/{doc_id}/versions/{version}")
def govern_knowledge_version(doc_id: int, version: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    v = GovernanceService.get_doc_version(db, doc_id, version)
    if v is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy phiên bản.")
    return v


class PublishVersionReq(BaseModel):
    version: int
    change_note: str


@router.post("/govern/knowledge/{doc_id}/publish")
def govern_knowledge_publish(doc_id: int, body: PublishVersionReq, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Make a specific version LIVE (RAG/public reads it) with a required change
    note. The latest working draft is unaffected — v1 can stay live while v2 drafts."""
    return _run(lambda: GovernanceService.publish_version(db, doc_id, body.version, body.change_note, changed_by=getattr(user, "email", None), current_user=user))


@router.post("/govern/knowledge/{doc_id}/versions/{version}/change-note-ai")
def govern_knowledge_change_note_ai(doc_id: int, version: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """AI drafts a short 'what changed' note by diffing this version against the
    previously-published/previous one (diff only — never the whole document)."""
    return _run(lambda: (GovernanceService.require_doc_access(db, doc_id, user, "edit"), GovernanceService.version_change_note_ai(db, doc_id, version))[1])


# ── GOVERN: KNOWLEDGE DOC — external sources + configurable/transparent embedding ──
# Source & Sync tab: connect a doc to a Google Doc (reuses the same per-user
# Google OAuth already used for BigQuery/Sheets datasources), an uploaded
# file (PDF/DOCX/XLSX), or a crawled web page, instead of only hand-typing.
# Embedding tab: chunk strategy/size/overlap/model become user-configurable
# with a real preview, instead of the previous hardcoded black box.
class DocSourceWrite(BaseModel):
    source_type: str | None = None          # google_doc | file | web | null (disconnect)
    source_config: dict[str, Any] = {}      # {datasource_id, google_doc_id} | {} | {url}
    sync_schedule: dict[str, Any] | None = None  # {mode, at, cron, timezone}


def _google_docs_sources(db: Session, user: User) -> list[dict[str, Any]]:
    """Google Docs data sources this user may use. A Knowledge Doc picks one of
    these (the same way a chart picks a BigQuery source) — the source carries
    the Google account, so different docs can read through different accounts."""
    from app.models.models import DataSource, DataSourceType
    from app.core.permissions import _owned_or_shared
    from app.models.resource_share import ResourceType
    from app.core.crypto import decrypt_config
    from app.services.google_data_access_service import source_google_capabilities

    rows = (
        _owned_or_shared(db, DataSource, ResourceType.DATASOURCE, user)
        .filter(DataSource.type == DataSourceType.GOOGLE_DOCS)
        .all()
    )
    out = []
    for ds in rows:
        cfg = decrypt_config(ds.config or {})
        has_own = bool(cfg.get("google_oauth_credentials"))
        caps = source_google_capabilities(cfg)
        out.append({
            "id": ds.id,
            "name": ds.name,
            "email": cfg.get("google_oauth_email"),
            # A source connected before Docs access existed reports False here
            # instead of looking ready and then failing at sync time.
            "can_read_docs": bool(caps.get("docs")) if has_own else False,
        })
    return out


@router.get("/govern/google-connection")
def govern_google_sources(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Google Docs sources available to a NEW doc (create wizard needs this
    before any doc exists)."""
    return {"sources": _google_docs_sources(db, user)}


@router.get("/govern/knowledge/{doc_id}/source")
def govern_doc_source_get(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from app.models.governance import GovernDocSourceFile

    file_info = None
    f = db.query(GovernDocSourceFile).filter(GovernDocSourceFile.doc_id == doc_id).first()
    if f is not None:
        file_info = {"filename": f.filename, "content_type": f.content_type, "byte_size": f.byte_size, "uploaded_at": f.uploaded_at}
    return {
        "source_type": d.source_type,
        "source_config": d.source_config or {},
        "sync_schedule": d.sync_schedule,
        "last_synced_at": d.last_synced_at,
        "last_sync_status": d.last_sync_status,
        "file": file_info,
        "google_sources": _google_docs_sources(db, user),
    }


@router.put("/govern/knowledge/{doc_id}/source")
def govern_doc_source_put(doc_id: int, body: DocSourceWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Set/change the source connector + schedule. Does NOT sync — call
    /sync (or /source/upload for a file) explicitly afterward."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    source_type = (body.source_type or "").strip().lower() or None
    if source_type not in (None, "google_doc", "file", "web"):
        raise HTTPException(status_code=422, detail="source_type must be google_doc, file, web, or null.")
    d.source_type = source_type
    d.source_config = dict(body.source_config or {})
    d.sync_schedule = body.sync_schedule
    db.commit()
    from app.services.govern_doc_sync_scheduler import sync_doc_job
    sync_doc_job(doc_id)  # hot re-register the scheduled job (or remove it) without a restart
    return {"ok": True}


@router.post("/govern/knowledge/{doc_id}/source/upload")
async def govern_doc_source_upload(doc_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Upload a PDF/DOCX/XLSX as the doc's source — extracts text immediately
    and writes it into doc.body (a file's "sync" IS the upload)."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    data = await file.read()
    if len(data) > 25 * 1024 * 1024:  # mirrors WorkboardMedia's MAX_MEDIA_BYTES
        raise HTTPException(status_code=400, detail="File too large (max 25 MB).")
    from app.services.govern_doc_sync_service import save_uploaded_file
    d.source_type = "file"
    db.commit()
    result = save_uploaded_file(
        db, d, filename=file.filename or "upload", content_type=file.content_type or "application/octet-stream",
        data=data, changed_by=getattr(user, "email", None),
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("detail") or "Failed to process the uploaded file.")
    return result


@router.get("/govern/knowledge/{doc_id}/source/snapshot")
def govern_doc_source_snapshot(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """The stored snapshot of a crawled web page, so the reader can see the
    ORIGINAL page (not just the extracted prose). Returned as a raw string for
    the FE to render inside a script-less sandboxed iframe — never treated as
    trusted markup anywhere."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from app.models.governance import GovernDocSourceFile
    row = db.query(GovernDocSourceFile).filter(GovernDocSourceFile.doc_id == doc_id).first()
    if row is None or (row.content_type or "") != "text/html":
        raise HTTPException(status_code=404, detail="This document has no stored page snapshot.")
    return {
        "html": bytes(row.data or b"").decode("utf-8", errors="replace"),
        "url": (d.source_config or {}).get("url"),
        "byte_size": row.byte_size,
        "fetched_at": row.uploaded_at,
    }


@router.post("/govern/knowledge/{doc_id}/sync")
def govern_doc_sync_now(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Manual sync for google_doc/web sources (file sources re-sync via
    /source/upload — there's nothing external to re-fetch for a file)."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    from app.services.govern_doc_sync_service import sync_doc
    result = sync_doc(db, d, trigger="manual", changed_by=getattr(user, "email", None))
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("detail") or "Sync failed.")
    return result


class EmbeddingConfigWrite(BaseModel):
    chunk_strategy: str = "paragraph"   # paragraph | heading | fixed
    chunk_size: int = 850
    chunk_overlap: int = 0
    embedding_model: str | None = None


def _validated_embedding_config(body: EmbeddingConfigWrite, current_model: str) -> tuple[str, int, int, str]:
    from app.services.dashboard_ai_bot.govern_doc_embeddings import _clamp_chunk_params
    from app.services.embedding_service import EmbeddingService

    if body.chunk_strategy not in ("paragraph", "heading", "fixed"):
        raise HTTPException(
            status_code=422,
            detail="chunk_strategy must be paragraph, heading, or fixed.",
        )
    size, overlap = _clamp_chunk_params(body.chunk_size, body.chunk_overlap)
    try:
        model = EmbeddingService.resolve_model(body.embedding_model or current_model)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return body.chunk_strategy, size, overlap, model


def _embedding_is_locked(db: Session, doc_id: int, embedded_hash: str | None) -> bool:
    from sqlalchemy import text as _t
    from app.services.dashboard_ai_bot.govern_doc_embeddings import authoring_scope

    authoring_scope(db)
    count = db.execute(
        _t("SELECT COUNT(*) FROM govern_doc_chunk WHERE doc_id = :d"),
        {"d": doc_id},
    ).scalar() or 0
    return bool(embedded_hash or count)


@router.get("/govern/embedding-profiles")
def govern_embedding_profiles(_: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.services.embedding_service import EmbeddingService

    profiles = EmbeddingService.embedding_profiles()
    return {
        "profiles": profiles,
        "default_model": EmbeddingService.resolve_model(),
    }


@router.get("/govern/knowledge/{doc_id}/embedding-config")
def govern_doc_embedding_config_get(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from sqlalchemy import text as _t
    from app.services.dashboard_ai_bot.govern_doc_embeddings import authoring_scope
    authoring_scope(db)  # the author is inspecting their own doc, draft or not
    chunk_count = db.execute(_t("SELECT COUNT(*) FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc_id}).scalar() or 0

    # Whether THIS document would hit the runaway chunk cap, recomputed from the
    # body rather than remembered from the last run — so the warning is still
    # right after an edit and survives a page reload. Pure string work, no I/O.
    from app.services.dashboard_ai_bot.govern_doc_embeddings import (
        chunk_doc_detailed, egress_allowed, index_is_stale, processing_policy,
    )
    from app.services.govern_doc_index_queue import job_status

    _index_job = job_status(db, doc_id)
    from app.services.embedding_service import EmbeddingService
    _stale = index_is_stale(db, d)
    _, stats = chunk_doc_detailed(
        GovernanceService.published_body(db, d) or "",
        strategy=d.chunk_strategy or "paragraph",
        size=d.chunk_size or 850,
        overlap=d.chunk_overlap or 0,
    )
    return {
        "chunk_strategy": d.chunk_strategy, "chunk_size": d.chunk_size, "chunk_overlap": d.chunk_overlap,
        "embedding_model": d.embedding_model, "embedded_hash": d.embedded_hash, "chunk_count": int(chunk_count),
        "model_locked": bool(d.embedded_hash or chunk_count),
        "available_models": EmbeddingService.embedding_profiles(),
        "index_stale": _stale,
        # Indexing is asynchronous now, so "is it done yet" has to be answerable.
        "index_job": _index_job,
        "external_processing": processing_policy(d),
        "embedding_allowed": egress_allowed(d, "embedding"),
        "sensitivity": getattr(d, "sensitivity", None) or "internal",
        "truncated": bool(stats.get("truncated")), "dropped_chunks": int(stats.get("dropped_chunks") or 0),
        "dropped_chars": int(stats.get("dropped_chars") or 0), "max_chunks": int(stats.get("max_chunks") or 0),
    }


@router.put("/govern/knowledge/{doc_id}/embedding-config")
def govern_doc_embedding_config_put(doc_id: int, body: EmbeddingConfigWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Save chunk/embedding settings. Does not re-embed by itself — call /embed."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    strategy, size, overlap, model = _validated_embedding_config(
        body, d.embedding_model
    )
    if model != d.embedding_model and _embedding_is_locked(db, doc_id, d.embedded_hash):
        raise HTTPException(
            status_code=409,
            detail=(
                "Embedding model is locked after indexing. Use Reset & Re-embed "
                "to delete the old vector space and rebuild it."
            ),
        )
    d.chunk_strategy = strategy
    d.chunk_size = size
    d.chunk_overlap = overlap
    d.embedding_model = model
    db.commit()
    return {"ok": True}


class EmbeddingPreviewReq(BaseModel):
    chunk_strategy: str = "paragraph"
    chunk_size: int = 850
    chunk_overlap: int = 0


@router.post("/govern/knowledge/{doc_id}/embedding-preview")
def govern_doc_embedding_preview(doc_id: int, body: EmbeddingPreviewReq, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Preview chunking with the given (possibly unsaved) settings against the
    live body — zero DB writes, zero embedding-API calls."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from app.services.dashboard_ai_bot.govern_doc_embeddings import preview_chunks
    live_body = GovernanceService.published_body(db, d)
    chunks = preview_chunks(live_body, strategy=body.chunk_strategy, size=body.chunk_size, overlap=body.chunk_overlap)
    return {
        "chunks": [{"index": i, "text": c, "char_count": len(c)} for i, c in enumerate(chunks)],
        "total_chunks": len(chunks),
    }


@router.post("/govern/knowledge/{doc_id}/embed")
def govern_doc_embed_now(doc_id: int, body: EmbeddingConfigWrite | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """"Save & Re-embed" — optionally persists embedding config, then force
    re-embeds now (independent of the auto-embed-on-save/publish flow)."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    if body is not None:
        strategy, size, overlap, model = _validated_embedding_config(
            body, d.embedding_model
        )
        if model != d.embedding_model and _embedding_is_locked(db, doc_id, d.embedded_hash):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Embedding model is locked after indexing. Use Reset & Re-embed "
                    "to delete the old vector space and rebuild it."
                ),
            )
        d.chunk_strategy = strategy
        d.chunk_size = size
        d.chunk_overlap = overlap
        d.embedding_model = model
        db.commit()
    # The button queues like everything else. Keeping a synchronous path here
    # "just for one document" is exactly the second behaviour this refactor
    # removed: it would be the path nobody tests and the one that times out.
    from app.services.govern_doc_index_queue import enqueue

    job = enqueue(db, doc_id, reason="manual", requested_by=getattr(user, "email", None))
    GovernanceService.log_doc_run(
        db, doc_id, "embed", trigger="manual", status="queued",
        detail="đã đưa vào hàng đợi lập chỉ mục", stats=job,
        changed_by=getattr(user, "email", None),
    )
    return {"status": "queued", "job": job}


@router.post("/govern/knowledge/{doc_id}/embedding-reset")
def govern_doc_embedding_reset(
    doc_id: int,
    body: EmbeddingConfigWrite,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete the old vector space, switch profile, and rebuild from zero."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "edit"))
    strategy, size, overlap, model = _validated_embedding_config(
        body, d.embedding_model
    )
    from app.services.dashboard_ai_bot.govern_doc_embeddings import reset_doc_embedding

    result = reset_doc_embedding(
        db,
        d,
        model=model,
        chunk_strategy=strategy,
        chunk_size=size,
        chunk_overlap=overlap,
        changed_by=getattr(user, "email", None),
    )
    GovernanceService.log_doc_run(
        db,
        doc_id,
        "embed",
        trigger="manual",
        status=result.get("status", "error"),
        detail=result.get("detail"),
        stats={**result, "reset": True, "model": model},
        changed_by=getattr(user, "email", None),
    )
    return result


class VectorQueryReq(BaseModel):
    query: str
    k: int = 5


@router.get("/govern/knowledge/{doc_id}/egress-log")
def govern_doc_egress_log(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Every time this document's text was sent to an external embedding
    provider — including the times it was refused."""
    _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from sqlalchemy import text as _t
    rows = db.execute(
        _t(
            """
            SELECT occurred_at, purpose, provider, model, chunks_sent, chars_sent,
                   outcome, sensitivity, triggered_by
            FROM govern_doc_egress_log WHERE doc_id = :d
            ORDER BY occurred_at DESC LIMIT 100
            """
        ),
        {"d": doc_id},
    ).fetchall()
    return {"entries": [
        {"occurred_at": r[0].isoformat() if r[0] else None, "purpose": r[1], "provider": r[2],
         "model": r[3], "chunks_sent": r[4], "chars_sent": r[5], "outcome": r[6],
         "sensitivity": r[7], "triggered_by": r[8]}
        for r in rows
    ]}


@router.get("/govern/vector-store-health")
def govern_vector_store_health(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """What the chunk store actually guarantees right now — not what it intends.

    Deliberately reachable by any user who can view Govern: a row-level-security
    policy that is silently inert is exactly the failure this endpoint exists to
    make impossible to miss.
    """
    return GovernanceService.vector_store_health(db)


@router.get("/govern/knowledge/{doc_id}/vectors")
def govern_doc_vectors(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Inspect what actually landed in the vector store for this document —
    the same thing a Pinecone console shows: one row per vector with its id,
    the text it encodes, the model, dimensions and a peek at the raw values.
    Read-only; the full 768-float vector is never shipped (only a preview)."""
    _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from sqlalchemy import text as _t
    from app.services.dashboard_ai_bot.govern_doc_embeddings import authoring_scope
    authoring_scope(db)  # the vector browser exists to inspect drafts too
    rows = db.execute(
        _t(
            """
            SELECT id, chunk_index, content, content_hash, model_version, created_at, trust, doc_status,
                   heading_path, page, block_kind, section_index,
                   (embedding IS NOT NULL) AS has_vector,
                   CASE WHEN embedding IS NOT NULL
                        THEN array_length(embedding::real[], 1) END AS dims,
                   CASE WHEN embedding IS NOT NULL
                        THEN (embedding::real[])[1:6] END AS preview
            FROM govern_doc_chunk
            WHERE doc_id = :d
            ORDER BY chunk_index
            """
        ),
        {"d": doc_id},
    ).fetchall()
    vectors = [
        {
            "id": r[0], "chunk_index": r[1], "content": r[2], "content_hash": r[3],
            "model": r[4], "created_at": r[5],
            "trust": r[6], "doc_status": r[7],
            # Where in the document this chunk is — the browser shows it, and it is
            # what a citation is made of.
            "heading_path": r[8], "page": r[9], "block_kind": r[10],
            "section_index": r[11],
            "has_vector": bool(r[12]),
            "dims": r[13], "preview": [float(x) for x in (r[14] or [])],
            "char_count": len(r[2] or ""),
        }
        for r in rows
    ]
    return {
        "vectors": vectors,
        "total": len(vectors),
        "dims": next((v["dims"] for v in vectors if v["dims"]), None),
        "model": next((v["model"] for v in vectors if v["model"]), None),
    }


@router.post("/govern/knowledge/{doc_id}/vectors/query")
def govern_doc_vectors_query(doc_id: int, body: VectorQueryReq, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Run a similarity search against THIS document's vectors — the Pinecone
    "query" box. Shows exactly which chunk the AI would retrieve for a question
    and how close it scored, so retrieval can be sanity-checked per document."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))

    q = (body.query or "").strip()
    if not q:
        raise HTTPException(status_code=422, detail="Enter a question to test retrieval.")
    k = max(1, min(int(body.k or 5), 20))

    # Same multi-model hybrid path as the bot. For one document this produces
    # exactly one query embedding using that document's locked model.
    from app.services.dashboard_ai_bot.govern_doc_embeddings import search_doc_chunks

    rows = search_doc_chunks(
        db,
        q,
        k=k,
        doc_ids={doc_id},
        published_only=False,
        authoring=True,
    )
    # An empty result has two very different causes and the console has to tell
    # them apart. "Nothing matched" is an answer; "this document's index is not
    # searchable" is a defect the author can fix with one button — and it looked
    # exactly like the former until this said so.
    reason = None
    if not rows:
        from app.services.dashboard_ai_bot.govern_doc_embeddings import _is_current_index_hash

        if not _is_current_index_hash(getattr(d, "embedded_hash", None)):
            reason = "index_not_searchable"
    return {
        "reason": reason,
        "matches": [
            {
                "chunk_index": row["chunk_index"],
                "content": row["content"],
                "score": float(row.get("similarity") or 0.0),
                # Cosine is shown as `score` because that is what a vector browser
                # means by it, but the ORDER comes from `rerank_score` — so both
                # are returned rather than leaving the console to explain a list
                # that is not sorted by the number next to it.
                "rerank_score": row.get("rerank_score"),
                "term_coverage": row.get("term_coverage"),
                "trust": row.get("trust"),
                "matched_by": row.get("matched_by"),
                # The citation. Without these the console can show WHICH passage
                # the AI would retrieve but not WHERE it is, which is half the
                # question an author is asking when they open this box.
                "heading_path": row.get("heading_path"),
                "page": row.get("page"),
                "block_kind": row.get("block_kind"),
                "section_content": row.get("section_content"),
                "is_metric_home": row.get("is_metric_home"),
                "embedding_model": row.get("embedding_model"),
            }
            for row in rows
        ]
    }


@router.get("/govern/knowledge/{doc_id}/history")
def govern_doc_history(doc_id: int, limit: int = Query(default=100), db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Unified sync+embed run timeline, alongside the existing content-version
    list, so the History tab can render one merged timeline."""
    _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from app.models.governance import GovernDocRun
    runs = (
        db.query(GovernDocRun)
        .filter(GovernDocRun.doc_id == doc_id)
        .order_by(GovernDocRun.started_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "runs": [
            {
                "id": r.id, "run_type": r.run_type, "trigger": r.trigger, "status": r.status,
                "detail": r.detail, "stats": r.stats, "started_at": r.started_at,
                "finished_at": r.finished_at, "triggered_by": r.triggered_by,
            }
            for r in runs
        ],
        "versions": GovernanceService.list_doc_versions(db, doc_id),
    }


@router.get("/govern/knowledge/{doc_id}/usage")
def govern_doc_usage(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Which dashboards use this doc (via GovernDocAssetLink) + retrieval_count
    — the Usage tab's data source."""
    d = _run(lambda: GovernanceService.require_doc_access(db, doc_id, user, "view"))
    from app.models.governance import GovernDocAssetLink
    links = (
        db.query(GovernDocAssetLink)
        .filter(GovernDocAssetLink.doc_id == doc_id, GovernDocAssetLink.asset_type == "dashboard")
        .all()
    )
    dashboard_ids = [int(l.asset_ref) for l in links if str(l.asset_ref).isdigit()]
    dashboards = []
    if dashboard_ids:
        rows = db.query(Dashboard).filter(Dashboard.id.in_(dashboard_ids)).all()
        dashboards = [{"id": r.id, "name": r.name} for r in rows]
    return {"dashboards": dashboards, "retrieval_count": d.retrieval_count or 0}


# ════════════════════════ GOVERN: METRICS (AppBI-native) ════════════════════
def _collect_accessible_metrics(db: Session, user: User) -> list[dict[str, Any]]:
    """
    Permission-aware measures (from datasets the user owns or is shared) + a
    CONFLICT annotation: metrics that share a name but have different definitions
    on the SAME source are flagged, so the team can converge on one agreed metric.
    """
    accessible = _owned_or_shared(db, Dataset, ResourceType.DATASET, user).all()
    stamp_owner_emails(db, accessible)
    ds_info = {d.id: {"name": d.name, "owner": getattr(d, "owner_email", None)} for d in accessible}
    if not ds_info:
        return []

    shared_ids = {
        int(r)
        for (r,) in db.query(ResourceShare.resource_id)
        .filter(ResourceShare.resource_type == ResourceType.DATASET)
        .distinct()
        .all()
        if str(r).isdigit()
    }
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id.in_(list(ds_info.keys()))).all()
    table_by_id = {t.id: t for t in tables}
    views = (
        db.query(SemanticView).filter(SemanticView.dataset_table_id.in_(list(table_by_id.keys()))).all()
        if table_by_id
        else []
    )

    metrics: list[dict[str, Any]] = []
    for view in views:
        measures = view.measures if isinstance(view.measures, list) else []
        table = table_by_id.get(view.dataset_table_id)
        ds_id = table.dataset_id if table else None
        info = ds_info.get(ds_id, {})
        table_name = (table.display_name if table else None) or view.name
        for m in measures:
            if not isinstance(m, dict) or not m.get("name"):
                continue
            raw_fmt = m.get("format")
            fmt = (raw_fmt.get("formatType") or raw_fmt.get("type") or "custom") if isinstance(raw_fmt, dict) else raw_fmt
            metrics.append(
                {
                    "name": m.get("name"),
                    "label": m.get("label") or m.get("name"),
                    "type": m.get("type") or "measure",
                    "definition": m.get("expression") or m.get("sql") or "",
                    "format": fmt,
                    "description": m.get("description"),
                    "hidden": bool(m.get("hidden")),
                    "dataset": info.get("name"),
                    "dataset_id": ds_id,
                    "owner": info.get("owner"),
                    "shared": ds_id in shared_ids,
                    "table": table_name,
                    "source": (table.source_table_name if table else None) or table_name,
                    "_src": (
                        table.datasource_id if table else None,
                        ((table.source_table_name if table else None) or "").strip().lower(),
                    ),
                    "view_id": view.id,
                    "table_id": view.dataset_table_id,
                    "glossaryTerms": [t for t in (m.get("glossary_terms") or []) if isinstance(t, dict) and t.get("fqn")],
                    "tags": [t for t in (m.get("tags") or []) if isinstance(t, dict) and t.get("fqn")],
                }
            )

    from collections import defaultdict

    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_name_source: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for m in metrics:
        nm = (m["name"] or "").strip().lower()
        by_name[nm].append(m)
        by_name_source[(nm, m["_src"])].append(m)

    for group in by_name_source.values():
        distinct_defs = {(x["definition"] or "").strip() for x in group}
        conflict = len(group) >= 2 and len(distinct_defs) > 1
        for x in group:
            x["conflict"] = conflict
            x["distinctDefs"] = len(distinct_defs)
            x["sameSourceCount"] = len(group)

    for m in metrics:
        m["variants"] = len(by_name[(m["name"] or "").strip().lower()])
        m.setdefault("conflict", False)
        m.setdefault("distinctDefs", 1)
        m.pop("_src", None)

    metrics.sort(key=lambda x: ((x["dataset"] or "~"), (x["table"] or ""), x["label"]))
    return metrics


@router.get("/govern/metrics")
def govern_metrics(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Metrics library — permission-aware (owned/shared), SSOT within a dataset,
    with cross-dataset conflict flags for governance."""
    metrics = _collect_accessible_metrics(db, user)
    datasets_covered = len({m["dataset"] for m in metrics if m["dataset"]})
    conflicts = len({(m["name"] or "").strip().lower() for m in metrics if m.get("conflict")})
    return {"metrics": metrics, "total": len(metrics), "datasets": datasets_covered, "conflicts": conflicts}


@router.get("/govern/metric-variants")
def metric_variants(name: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """All metrics sharing a name (across the user's datasets), so divergent
    definitions can be compared and reconciled to one agreed metric."""
    key = (name or "").strip().lower()
    variants = [m for m in _collect_accessible_metrics(db, user) if (m["name"] or "").strip().lower() == key]
    distinct_defs = len({(v["definition"] or "").strip() for v in variants})
    return {"name": name, "count": len(variants), "distinctDefinitions": distinct_defs, "variants": variants}


@router.get("/govern/vocab-usage")
def vocab_usage(fqn: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Reverse lineage: which metrics have this glossary term / classification tag attached."""
    out: list[dict[str, Any]] = []
    for m in _collect_accessible_metrics(db, user):
        linked = {x.get("fqn") for x in (m.get("glossaryTerms") or [])} | {x.get("fqn") for x in (m.get("tags") or [])}
        if fqn in linked:
            out.append({
                "name": m["name"], "label": m["label"], "type": m["type"],
                "dataset": m["dataset"], "dataset_id": m["dataset_id"], "table": m["table"],
                "view_id": m["view_id"], "table_id": m["table_id"],
            })
    return {"fqn": fqn, "metrics": out, "count": len(out)}


def _norm_vocab(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Normalize a glossary-term / tag assignment list to [{fqn, label}], deduped."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for it in items or []:
        if isinstance(it, dict) and it.get("fqn") and it["fqn"] not in seen:
            seen.add(it["fqn"])
            out.append({"fqn": str(it["fqn"]), "label": str(it.get("label") or str(it["fqn"]).split(".")[-1])})
    return out


class MetricPatch(BaseModel):
    view_id: int
    name: str
    label: str | None = None
    description: str | None = None
    glossary_terms: list[dict[str, Any]] | None = None  # [{fqn, label}] — assign/clear governance links
    tags: list[dict[str, Any]] | None = None


@router.patch("/govern/metric")
def patch_metric(body: MetricPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """
    In-place edit of a measure's SAFE doc metadata only (display name, description,
    glossary terms, classification tags) — fields that do NOT affect SQL generation.
    Requires edit access to the dataset.
    """
    view = db.query(SemanticView).filter(SemanticView.id == body.view_id).first()
    if view is None:
        raise HTTPException(status_code=404, detail="Metric view not found")
    table = db.query(DatasetTable).filter(DatasetTable.id == view.dataset_table_id).first()
    dataset = db.query(Dataset).filter(Dataset.id == table.dataset_id).first() if table else None
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    require_edit_access(db, user, dataset, "datasets")

    measures = list(view.measures) if isinstance(view.measures, list) else []
    found = False
    new_measures: list[Any] = []
    for m in measures:
        if isinstance(m, dict) and m.get("name") == body.name:
            found = True
            m = dict(m)
            if body.label is not None:
                m["label"] = body.label
            if body.description is not None:
                m["description"] = body.description or None
            if body.glossary_terms is not None:
                m["glossary_terms"] = _norm_vocab(body.glossary_terms)
            if body.tags is not None:
                m["tags"] = _norm_vocab(body.tags)
        new_measures.append(m)
    if not found:
        raise HTTPException(status_code=404, detail="Metric not found in view")

    view.measures = new_measures
    db.commit()
    return {"ok": True}


@router.get("/govern/metric-usage")
def metric_usage(
    table_id: int,
    name: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Lineage "used in": which charts (and their dashboards) reference this measure."""
    import json as _json

    table = db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
    if table is None:
        return {"charts": [], "dashboards": [], "chartCount": 0, "dashboardCount": 0}

    sibling_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == table.dataset_id).all()]
    charts = db.query(Chart).filter(Chart.dataset_table_id.in_(sibling_ids)).all() if sibling_ids else []

    ref = f"dataset_table_{table_id}.{name}"
    bare = f'"{name}"'
    chart_out: list[dict[str, Any]] = []
    dash_ids: set[int] = set()
    for c in charts:
        cfg = _json.dumps(c.config or {}, default=str)
        if ref not in cfg and bare not in cfg:
            continue
        cdash = [dc.dashboard_id for dc in (c.dashboard_charts or []) if getattr(dc, "dashboard_id", None)]
        dash_ids.update(cdash)
        chart_out.append(
            {
                "id": c.id,
                "name": c.name,
                "chartType": c.chart_type.value if c.chart_type else None,
                "dashboardIds": cdash,
            }
        )

    dash_names = (
        {d.id: d.name for d in db.query(Dashboard).filter(Dashboard.id.in_(dash_ids)).all()} if dash_ids else {}
    )
    dashboards = [{"id": did, "name": dash_names.get(did, f"Dashboard {did}")} for did in sorted(dash_ids)]
    return {"charts": chart_out, "dashboards": dashboards, "chartCount": len(chart_out), "dashboardCount": len(dashboards)}


# ════════════════════════ OBSERVABILITY (AppBI-native) ══════════════════════
# Data Quality + Incident Manager surface AppBI's own dataset quality engine
# (rules run against live data). Alerts are derived live from the same engine.
def _empty_quality_summary() -> dict[str, Any]:
    return {"datasets": 0, "totalRules": 0, "enabledRules": 0, "passed": 0, "failed": 0, "incidents": 0, "avgScore": None}


def _collect_quality_overview(db: Session, user: User) -> dict[str, Any]:
    from app.services.dataset_quality_service import DatasetQualityService  # lazy: heavy module

    accessible = _owned_or_shared(db, Dataset, ResourceType.DATASET, user).all()
    stamp_owner_emails(db, accessible)
    if not accessible:
        return {"summary": _empty_quality_summary(), "datasets": [], "incidents": [], "candidates": []}

    ds_ids = [d.id for d in accessible]
    table_names = {
        t.id: (t.display_name or t.source_table_name or f"table_{t.id}")
        for t in db.query(DatasetTable).filter(DatasetTable.dataset_id.in_(ds_ids)).all()
    }

    rows: list[dict[str, Any]] = []
    incidents: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []  # accessible datasets with no rules yet (setup picker)
    tot_rules = tot_enabled = tot_pass = tot_fail = 0
    score_sum = 0.0
    score_n = 0

    for ds in accessible:
        try:
            summary = DatasetQualityService.get_summary(db, ds.id)
        except Exception as exc:  # one bad dataset must not break the rollup
            logger.warning("quality summary failed for dataset %s: %s", ds.id, exc)
            continue
        if summary.total_rules == 0:
            candidates.append({"dataset_id": ds.id, "dataset": ds.name})
            continue  # not yet monitored — offered in the setup picker instead
        passed = sum((d.passed or 0) for d in summary.dimension_breakdown)
        failed = sum((d.failed or 0) for d in summary.dimension_breakdown)
        last_run = summary.last_run
        ran_at = None
        if last_run:
            dt = last_run.completed_at or last_run.created_at
            ran_at = dt.isoformat() if dt else None

        tot_rules += summary.total_rules
        tot_enabled += summary.enabled_rules
        tot_pass += passed
        tot_fail += failed
        if summary.score is not None:
            score_sum += summary.score
            score_n += 1

        rows.append({
            "dataset_id": ds.id,
            "dataset": ds.name,
            "owner": getattr(ds, "owner_email", None),
            "score": summary.score,
            "totalRules": summary.total_rules,
            "enabledRules": summary.enabled_rules,
            "coveredTables": summary.covered_tables,
            "passed": passed,
            "failed": failed,
            "lastRunStatus": last_run.status if last_run else None,
            "lastRunAt": ran_at,
        })

        if last_run and last_run.results:
            rules_by_id = {r.id: r for r in DatasetQualityService.list_rules(db, ds.id)}
            for rid_str, res in last_run.results.items():
                if not isinstance(res, dict) or res.get("skipped") or res.get("passed"):
                    continue
                try:
                    rid = int(rid_str)
                except (TypeError, ValueError):
                    continue
                rule = rules_by_id.get(rid)
                if rule is None or not rule.enabled:
                    continue
                incidents.append({
                    "dataset_id": ds.id,
                    "dataset": ds.name,
                    "table": table_names.get(rule.table_id),
                    "column": rule.column_name,
                    "rule": rule.name,
                    "dimension": rule.dimension,
                    "severity": rule.severity,
                    "rowsFailed": res.get("rows_failed"),
                    "error": bool(res.get("error")),
                    "lastRunAt": ran_at,
                })

    rows.sort(key=lambda r: (r["failed"] == 0, -(r["failed"] or 0), (r["dataset"] or "").lower()))
    sev_order = {"critical": 0, "blocker": 0, "high": 1, "major": 1, "medium": 2, "minor": 3, "low": 3, "error": 0, "warning": 1, "info": 2}
    incidents.sort(key=lambda i: (sev_order.get((i["severity"] or "").lower(), 2), (i["dataset"] or "").lower()))
    candidates.sort(key=lambda x: (x["dataset"] or "").lower())

    return {
        "summary": {
            "datasets": len(rows),
            "totalRules": tot_rules,
            "enabledRules": tot_enabled,
            "passed": tot_pass,
            "failed": tot_fail,
            "incidents": len(incidents),
            "avgScore": round(score_sum / score_n) if score_n else None,
        },
        "datasets": rows,
        "incidents": incidents,
        "candidates": candidates,
    }


@router.get("/observability/quality-overview")
def observability_quality_overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Real AppBI data-quality rollup across owned/shared datasets."""
    return _collect_quality_overview(db, user)


@router.get("/observability/alerts")
def observability_alerts(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Live quality alerts derived from the native quality engine (no OM):
    one alert per dataset with failing checks, plus low-score datasets."""
    from collections import defaultdict

    ov = _collect_quality_overview(db, user)
    by_ds: dict[str, list[dict[str, Any]]] = defaultdict(list)
    worst: dict[str, str] = {}
    sev_rank = {"error": 3, "critical": 3, "warning": 2, "high": 2, "info": 1}
    for inc in ov["incidents"]:
        ds = inc["dataset"]
        by_ds[ds].append(inc)
        sev = (inc.get("severity") or "warning").lower()
        if sev_rank.get(sev, 1) >= sev_rank.get(worst.get(ds, "info"), 1):
            worst[ds] = sev

    alerts: list[dict[str, Any]] = []
    for ds, incs in by_ds.items():
        alerts.append({
            "name": f"Chất lượng giảm — {ds}",
            "fqn": ds,
            "description": f"{len(incs)} kiểm tra đang thất bại ở lần chạy gần nhất",
            "enabled": True,
            "alertType": f"Quality · {worst.get(ds, 'warning')}",
        })
    for r in ov["datasets"]:
        if r.get("score") is not None and r["score"] < 70 and r["dataset"] not in by_ds:
            alerts.append({
                "name": f"Điểm chất lượng thấp — {r['dataset']}",
                "fqn": r["dataset"],
                "description": f"Điểm tổng thể {round(r['score'])}/100 (dưới ngưỡng 70)",
                "enabled": True,
                "alertType": "Quality · score",
            })
    return {"alerts": alerts, "total": len(alerts)}


# ═════════════════════════════════════════════════════════════════════════════
# Intelligence modules — teach-the-AI knowledge (rules / playbooks / verified
# Q&A / instructions) + governance spine (single review inbox, caveats, AI data
# scope, provenance cockpit). All additive; the AI bot consumes Approved only.
# ═════════════════════════════════════════════════════════════════════════════
from app.services.governance_ai_service import GovernanceAIService  # noqa: E402


class RuleWrite(BaseModel):
    id: int | None = None
    name: str
    condition_text: str
    conclusion_text: str
    exceptions_text: str | None = None
    applies_to: list[dict[str, Any]] = []
    owner: str | None = None
    status: str | None = None


class PlaybookWrite(BaseModel):
    id: int | None = None
    name: str
    trigger_text: str
    steps: list[str] = []
    dim_priority: list[str] = []
    expected_output: str | None = None
    linked_metrics: list[str] = []
    owner: str | None = None
    status: str | None = None


class QAWrite(BaseModel):
    id: int | None = None
    question: str
    trigger_phrases: list[str] = []
    answer_md: str
    chart_id: int | None = None
    dashboard_id: int | None = None
    playbook_id: int | None = None
    as_test: bool = True
    owner: str | None = None
    status: str | None = None


class InstructionWrite(BaseModel):
    scope: str = "global"
    scope_id: int | None = None
    content_md: str


class CaveatWrite(BaseModel):
    id: int | None = None
    dataset_id: int | None = None
    title: str
    content: str
    always_inject: bool = True
    status: str = "Approved"
    owner: str | None = None


class ScopeWrite(BaseModel):
    excluded_columns: list[str] = []
    excluded_measures: list[str] = []


class ReviewItemWrite(BaseModel):
    entity_type: str
    entity_id: int | None = None
    action: str = "suggest"
    title: str
    payload: dict[str, Any] | None = None
    evidence: str | None = None
    confidence: float | None = None


class ReviewResolve(BaseModel):
    note: str | None = None


# ── Rules ────────────────────────────────────────────────────────────────────
@router.get("/govern/rules")
def govern_rules(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"rules": GovernanceAIService.list_rules(db)}


@router.put("/govern/rules")
def govern_rules_upsert(body: RuleWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.upsert_rule(db, body.model_dump(), changed_by=who))


@router.delete("/govern/rules/{rule_id}")
def govern_rules_delete(rule_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    _run(lambda: GovernanceAIService.delete_rule(db, rule_id, changed_by=getattr(user, "email", None)))
    return {"ok": True}


# ── Playbooks ────────────────────────────────────────────────────────────────
@router.get("/govern/playbooks")
def govern_playbooks(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"playbooks": GovernanceAIService.list_playbooks(db)}


@router.put("/govern/playbooks")
def govern_playbooks_upsert(body: PlaybookWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.upsert_playbook(db, body.model_dump(), changed_by=who))


@router.delete("/govern/playbooks/{playbook_id}")
def govern_playbooks_delete(playbook_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    _run(lambda: GovernanceAIService.delete_playbook(db, playbook_id, changed_by=getattr(user, "email", None)))
    return {"ok": True}


# ── Verified Q&A ─────────────────────────────────────────────────────────────
@router.get("/govern/qa")
def govern_qa(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"qa": GovernanceAIService.list_qa(db)}


@router.put("/govern/qa")
def govern_qa_upsert(body: QAWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.upsert_qa(db, body.model_dump(), changed_by=who))


@router.delete("/govern/qa/{qa_id}")
def govern_qa_delete(qa_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    _run(lambda: GovernanceAIService.delete_qa(db, qa_id, changed_by=getattr(user, "email", None)))
    return {"ok": True}


# ── Certify (in-context; ALWAYS writes the single review ledger) ─────────────
@router.post("/govern/certify/{entity_type}/{entity_id}")
def govern_certify(entity_type: str, entity_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.certify(db, entity_type, entity_id, changed_by=who))


# ── AI Instructions ──────────────────────────────────────────────────────────
@router.get("/govern/instructions")
def govern_instructions(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"instructions": GovernanceAIService.list_instructions(db)}


@router.put("/govern/instructions")
def govern_instructions_create(body: InstructionWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.create_instruction_version(db, body.model_dump(), changed_by=who))


# ── Data caveats ─────────────────────────────────────────────────────────────
@router.get("/govern/caveats")
def govern_caveats(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"caveats": GovernanceAIService.list_caveats(db)}


@router.put("/govern/caveats")
def govern_caveats_upsert(body: CaveatWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.upsert_caveat(db, body.model_dump(), changed_by=who))


@router.delete("/govern/caveats/{caveat_id}")
def govern_caveats_delete(caveat_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    _run(lambda: GovernanceAIService.delete_caveat(db, caveat_id, changed_by=getattr(user, "email", None)))
    return {"ok": True}


# ── AI data scope ────────────────────────────────────────────────────────────
@router.get("/govern/ai-scope/{dataset_id}")
def govern_ai_scope_get(dataset_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    scope = GovernanceAIService.get_scope(db, dataset_id)
    scope["fields"] = GovernanceAIService.scope_fields(db, dataset_id)
    return scope


@router.put("/govern/ai-scope/{dataset_id}")
def govern_ai_scope_put(dataset_id: int, body: ScopeWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.put_scope(db, dataset_id, body.model_dump(), changed_by=who))


# ── Review inbox (single ledger) ─────────────────────────────────────────────
@router.get("/govern/review-items")
def govern_review_items(
    status: str = Query(default="pending"),
    entity_type: str | None = Query(default=None),
    db: Session = Depends(get_db), _: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "items": GovernanceAIService.list_review_items(db, status=status, entity_type=entity_type),
        "pending": GovernanceAIService.review_count(db),
    }


@router.get("/govern/review-items/count")
def govern_review_count(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"pending": GovernanceAIService.review_count(db)}


@router.post("/govern/review-items")
def govern_review_create(body: ReviewItemWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.create_review_item(db, body.model_dump(), created_by=who))


@router.post("/govern/review-items/{item_id}/approve")
def govern_review_approve(item_id: int, body: ReviewResolve | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    note = body.note if body else None
    return _run(lambda: GovernanceAIService.resolve_review_item(db, item_id, approve=True, resolved_by=who, note=note))


@router.post("/govern/review-items/{item_id}/reject")
def govern_review_reject(item_id: int, body: ReviewResolve | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    note = body.note if body else None
    return _run(lambda: GovernanceAIService.resolve_review_item(db, item_id, approve=False, resolved_by=who, note=note))


# ── Cockpit overview ─────────────────────────────────────────────────────────
@router.get("/govern/intelligence/overview")
def govern_intelligence_overview(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return GovernanceAIService.intelligence_overview(db)


@router.post("/govern/managed-metric/{name}/certify")
def govern_metric_certify(name: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceAIService.certify_metric_by_name(db, name, changed_by=who))


class AiDraftReq(BaseModel):
    entity_type: str          # rule | playbook | qa | caveat | metric
    prompt: str
    dataset_id: int | None = None


@router.post("/govern/ai-draft")
def govern_intel_ai_draft(body: AiDraftReq, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """AI-compose an Intelligence entity from a natural-language prompt.
    Returns a draft the create modal fills in for the user to review/edit."""
    return _run(lambda: GovernanceAIService.ai_draft(db, body.entity_type, body.prompt, body.dataset_id))


# ── Flow Studio ─────────────────────────────────────────────────────────────
# Mounted last so /catalog/ai/* inherits this router's module gate. The Studio
# lets a non-engineer compose the AI's analysis flow; see
# docs/Intelligence/appbi_intelligence_flow_map.md §2.

