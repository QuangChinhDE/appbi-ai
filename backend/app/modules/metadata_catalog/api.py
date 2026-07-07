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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_edit_access
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import Chart, Dashboard, Dataset, DatasetTable
from app.models.resource_share import ResourceShare, ResourceType
from app.models.semantic import SemanticView
from app.models.user import User
from app.services.governance_service import GovernanceError, GovernanceService

logger = logging.getLogger("app.metadata_catalog.api")

router = APIRouter(prefix="/catalog", tags=["catalog"])


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
    dataset_id: int | None = None
    dataset_table_id: int | None = None
    measure_ref: str | None = None
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


@router.get("/govern/knowledge")
def govern_knowledge_list(
    space: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "docs": GovernanceService.list_knowledge_docs(db, space, status),
        "spaces": GovernanceService.knowledge_spaces(db),
    }


@router.get("/govern/knowledge/insights")
def govern_knowledge_insights(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """Knowledge-health lists (missing owner/summary/tags, stale review, not
    embedded) + most viewed / most retrieved — for knowledge managers."""
    return GovernanceService.knowledge_insights(db)


@router.get("/govern/search")
def govern_search_everything(
    q: str = Query(default=""), db: Session = Depends(get_db), _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Search everything inside the Knowledge Hub — documents, governed KPIs,
    business terms, dashboards, datasets — grouped results."""
    return GovernanceService.govern_search(db, q)


@router.get("/govern/knowledge/{doc_id}")
def govern_knowledge_get(doc_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    d = GovernanceService.get_knowledge_doc(db, doc_id)
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
    return _run(lambda: GovernanceService.verify_knowledge_doc(db, doc_id, changed_by=getattr(user, "email", None)))


@router.post("/govern/knowledge/{doc_id}/ai-summary")
def govern_knowledge_ai_summary(doc_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """Force-regenerate the AI summary/keywords for a document."""
    from app.models.governance import GovernKnowledgeDoc
    from app.services.dashboard_ai_bot.govern_ai_summary import generate_summary
    d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
    if d is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy trang tri thức.")
    status = generate_summary(db, d, force=True)
    if status not in ("generated", "unchanged"):
        raise HTTPException(status_code=503, detail=f"AI chưa sinh được tóm tắt ({status}). Kiểm tra khoá AI.")
    return {"ok": True, "ai_summary": d.ai_summary, "ai_keywords": d.ai_keywords or []}


@router.put("/govern/knowledge")
def govern_knowledge_upsert(
    body: KnowledgeDocWrite, db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.upsert_knowledge_doc(db, body.model_dump(), changed_by=who))


class KnowledgeAIDraftReq(BaseModel):
    dataset_id: int
    dashboard_id: int | None = None


@router.post("/govern/knowledge/ai-draft")
def govern_knowledge_ai_draft(
    body: KnowledgeAIDraftReq, db: Session = Depends(get_db), _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """AI reads the dataset's real model + sample + metrics and drafts a business
    document (unsaved). The user reviews/edits before saving."""
    from app.services.dashboard_ai_bot.govern_ai_draft import draft_document
    draft = draft_document(db, body.dataset_id, body.dashboard_id)
    if draft is None:
        raise HTTPException(
            status_code=503,
            detail="AI chưa soạn được tài liệu. Kiểm tra dataset tồn tại và đã cấu hình khoá AI (OPENAI/GEMINI/ANTHROPIC).",
        )
    return draft


@router.delete("/govern/knowledge/{doc_id}")
def govern_knowledge_delete(doc_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    who = getattr(user, "email", None)
    return _run(lambda: GovernanceService.delete_knowledge_doc(db, doc_id, changed_by=who))


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
def govern_knowledge_versions(doc_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """Locked version history of a business document (evolution over time)."""
    return {"versions": GovernanceService.list_doc_versions(db, doc_id)}


@router.get("/govern/knowledge/{doc_id}/versions/{version}")
def govern_knowledge_version(doc_id: int, version: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    v = GovernanceService.get_doc_version(db, doc_id, version)
    if v is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy phiên bản.")
    return v


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
