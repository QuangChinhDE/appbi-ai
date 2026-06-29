"""
Proxy API: /api/v1/catalog/*  — powers AppBI's Govern + Observability modules.

The AppBI frontend talks ONLY to these endpoints; they forward to the hidden OM
server and reshape responses into AppBI vocabulary. OM's URL/token/envelope never
reach the browser.

Resilience: list endpoints return an empty list (never 5xx) when OM has no data or
an OM path differs by version — so the UI renders OM-style empty states gracefully.

Mounted only when settings.METADATA_CATALOG_ENABLED is True (see app/api/__init__.py).
"""
from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.dependencies import get_current_user, require_edit_access
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import Chart, Dashboard, DashboardChart, Dataset, DatasetTable
from app.models.resource_share import ResourceShare, ResourceType
from app.models.semantic import SemanticView
from app.models.user import User

from .om_client import OpenMetadataClient, OMError
from .publisher import Publisher

logger = logging.getLogger("app.metadata_catalog.api")

router = APIRouter(prefix="/catalog", tags=["catalog"])


def _client() -> OpenMetadataClient:
    if not settings.OPENMETADATA_API_URL:
        raise HTTPException(status_code=503, detail="Catalog backend is not configured.")
    return OpenMetadataClient(settings.OPENMETADATA_API_URL, settings.OPENMETADATA_BOT_TOKEN)


async def _safe_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET from OM; on any OM error return an empty envelope so the UI degrades to an empty state."""
    try:
        return await _client().get(path, params)
    except OMError as exc:
        logger.warning("OM GET %s failed: %s", path, exc.status)
        return {"data": []}
    except Exception as exc:  # network/down
        logger.warning("OM GET %s error: %s", path, exc)
        return {"data": []}


async def _safe_search(index: str, query: str = "*", size: int = 200) -> list[dict[str, Any]]:
    try:
        raw = await _client().search(query=query, index=index, size=size)
        return [(h.get("_source") or {}) for h in (raw.get("hits") or {}).get("hits", [])]
    except Exception as exc:
        logger.warning("OM search %s error: %s", index, exc)
        return []


def _build_vn_map() -> dict[int, int]:
    """Transliterate Vietnamese diacritics so machine names read cleanly
    ('Khách hàng' → 'khach_hang', not 'kh_ch_h_ng')."""
    groups = {
        "a": "àáạảãâầấậẩẫăằắặẳẵ",
        "e": "èéẹẻẽêềếệểễ",
        "i": "ìíịỉĩ",
        "o": "òóọỏõôồốộổỗơờớợởỡ",
        "u": "ùúụủũưừứựửữ",
        "y": "ỳýỵỷỹ",
        "d": "đ",
    }
    m: dict[int, int] = {}
    for base, chars in groups.items():
        for ch in chars:
            m[ord(ch)] = ord(base)
            m[ord(ch.upper())] = ord(base)
    return m


_VN_MAP = _build_vn_map()


def _slug(text: str, fallback: str = "item") -> str:
    """Stable machine name from free text — OM's entityName, FQN-safe (no dots/spaces)."""
    s = (text or "").strip().translate(_VN_MAP).lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return (s or fallback)[:128]


def _require_name(name: str | None) -> str:
    """A display name is mandatory on create/edit (don't let a blank slug to a junk name)."""
    display = (name or "").strip()
    if not display:
        raise HTTPException(status_code=422, detail="Tên không được để trống.")
    return display


def _om_write_error(exc: OMError) -> HTTPException:
    """Surface an OM write failure to the user (don't swallow it like reads do)."""
    body = exc.body
    detail = body.get("message") if isinstance(body, dict) else str(body)
    status = exc.status if exc.status in (400, 401, 403, 404, 409, 422) else 502
    return HTTPException(status_code=status, detail=detail or "Catalog backend rejected the request.")


async def _patch_curated_fields(collection: str, fqn: str, fields: dict[str, Any], not_found: str) -> dict[str, Any]:
    """Edit an existing OM entity's curated fields (displayName/description/synonyms)
    via JSON Patch — createOrUpdate PUT intentionally preserves these, so PUT can't edit them."""
    client = _client()
    entity = await client.get_by_fqn(collection, fqn)
    if entity is None:
        raise HTTPException(status_code=404, detail=not_found)
    ops = [{"op": "add", "path": f"/{k}", "value": v} for k, v in fields.items()]
    await client.patch(collection, str(entity["id"]), ops)
    return {"ok": True, "fqn": fqn, "machine_name": fqn.rsplit(".", 1)[-1]}


# ── Status ────────────────────────────────────────────────────────────────
@router.get("/status")
async def catalog_status(_: User = Depends(get_current_user)) -> dict[str, Any]:
    connected = await _client().health()
    return {"enabled": True, "connected": connected}


# ── Shared: asset search (Explore-style, used for pickers) ──────────────────
@router.get("/search")
async def catalog_search(q: str = Query(""), _: User = Depends(get_current_user)) -> dict[str, Any]:
    hits = await _safe_search("table_search_index", q or "*", 25)
    return {
        "results": [
            {
                "name": s.get("name"),
                "displayName": s.get("displayName") or s.get("name"),
                "type": s.get("entityType") or "table",
                "fqn": s.get("fullyQualifiedName"),
                "description": s.get("description"),
            }
            for s in hits
        ]
    }


# ════════════════════════ GOVERN: GLOSSARY ═════════════════════════════════
# Glossary terms live in the hidden OM (the catalog store), edited through this
# proxy. The edit model mirrors Metrics: `machine_name` is the stable identifier;
# the user edits the display name / description / synonyms (re-PUT = idempotent
# upsert by name). Lists read from OM's REST API (fresh) not the lagging index.


class GlossaryWrite(BaseModel):
    name: str                          # display text the user typed
    description: str | None = None
    machine_name: str | None = None    # set on EDIT (keep name stable); derived from `name` on CREATE


class TermWrite(BaseModel):
    glossary: str                      # glossary machine name (FQN) the term belongs to
    name: str
    description: str | None = None
    synonyms: list[str] = []
    machine_name: str | None = None


@router.get("/govern/glossaries")
async def govern_glossaries(_: User = Depends(get_current_user)) -> dict[str, Any]:
    """Glossary containers (each holds terms)."""
    raw = await _safe_get("/glossaries", {"fields": "termCount", "limit": 200})
    items = [
        {
            "name": g.get("displayName") or g.get("name"),
            "machine_name": g.get("name"),
            "fqn": g.get("fullyQualifiedName") or g.get("name"),
            "description": g.get("description"),
            "termCount": g.get("termCount") or 0,
            "provider": g.get("provider") or "user",
        }
        for g in (raw.get("data") or [])
    ]
    return {"glossaries": items, "total": len(items)}


@router.put("/govern/glossary")
async def upsert_glossary(body: GlossaryWrite, _: User = Depends(get_current_user)) -> dict[str, Any]:
    display = _require_name(body.name)
    desc = body.description or display
    try:
        if body.machine_name:  # EDIT existing → PATCH (PUT preserves displayName/description)
            return await _patch_curated_fields(
                "glossaries", body.machine_name, {"displayName": display, "description": desc}, "Không tìm thấy bộ thuật ngữ.")
        g = await _client().put("glossaries", {"name": _slug(body.name, "glossary"), "displayName": display, "description": desc})
        return {"ok": True, "fqn": g.get("fullyQualifiedName"), "machine_name": g.get("name")}
    except OMError as exc:
        raise _om_write_error(exc)


@router.delete("/govern/glossary/{fqn:path}")
async def delete_glossary(fqn: str, _: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        await _client().delete_by_fqn("glossaries", fqn, recursive=True)
    except OMError as exc:
        raise _om_write_error(exc)
    return {"ok": True}


@router.get("/govern/glossary")
async def govern_glossary(_: User = Depends(get_current_user)) -> dict[str, Any]:
    """All glossary terms (REST — fresh, not the lagging search index). The FE
    filters by glossary chip client-side; each term carries its glossary ref."""
    raw = await _safe_get("/glossaryTerms", {"fields": "synonyms,glossary", "limit": 1000})
    terms = []
    for t in (raw.get("data") or []):
        gl = t.get("glossary") if isinstance(t.get("glossary"), dict) else {}
        terms.append(
            {
                "name": t.get("displayName") or t.get("name"),
                "machine_name": t.get("name"),
                "fqn": t.get("fullyQualifiedName"),
                "definition": t.get("description"),
                "synonyms": t.get("synonyms") or [],
                "status": t.get("status"),
                "glossary": gl.get("displayName") or gl.get("name"),
                "glossaryFqn": gl.get("fullyQualifiedName") or gl.get("name"),
                "provider": t.get("provider") or "user",
            }
        )
    return {"terms": terms, "total": len(terms)}


@router.put("/govern/glossary-term")
async def upsert_term(body: TermWrite, _: User = Depends(get_current_user)) -> dict[str, Any]:
    display = _require_name(body.name)
    desc = body.description or display
    synonyms = [s.strip() for s in (body.synonyms or []) if s and s.strip()]
    try:
        if body.machine_name:  # EDIT → PATCH
            return await _patch_curated_fields(
                "glossaryTerms", f"{body.glossary}.{body.machine_name}",
                {"displayName": display, "description": desc, "synonyms": synonyms}, "Không tìm thấy thuật ngữ.")
        t = await _client().put("glossaryTerms", {
            "glossary": body.glossary, "name": _slug(body.name, "term"),
            "displayName": display, "description": desc, "synonyms": synonyms})
        return {"ok": True, "fqn": t.get("fullyQualifiedName"), "machine_name": t.get("name")}
    except OMError as exc:
        raise _om_write_error(exc)


@router.delete("/govern/glossary-term/{fqn:path}")
async def delete_term(fqn: str, _: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        await _client().delete_by_fqn("glossaryTerms", fqn, recursive=True)
    except OMError as exc:
        raise _om_write_error(exc)
    return {"ok": True}


# ════════════════════════ GOVERN: CLASSIFICATION ═══════════════════════════
# Classifications group Tags. mutuallyExclusive = single-select ("classify",
# e.g. one Tier only) vs multi-select ("categorize"). OM ships system
# classifications (PII/Tier/…) that are read-only — flagged via provider.


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
async def govern_classifications(_: User = Depends(get_current_user)) -> dict[str, Any]:
    raw = await _safe_get("/classifications", {"fields": "termCount", "limit": 200})
    items = [
        {
            "name": c.get("displayName") or c.get("name"),
            "machine_name": c.get("name"),
            "fqn": c.get("fullyQualifiedName") or c.get("name"),
            "description": c.get("description"),
            "termCount": c.get("termCount", 0),
            "mutuallyExclusive": c.get("mutuallyExclusive", False),
            "provider": c.get("provider") or "user",
        }
        for c in (raw.get("data") or [])
    ]
    return {"classifications": items, "total": len(items)}


@router.put("/govern/classification")
async def upsert_classification(body: ClassificationWrite, _: User = Depends(get_current_user)) -> dict[str, Any]:
    display = _require_name(body.name)
    desc = body.description or display
    try:
        if body.machine_name:  # EDIT → PATCH (mutuallyExclusive kept as-is; OM restricts changing it after tags exist)
            return await _patch_curated_fields(
                "classifications", body.machine_name, {"displayName": display, "description": desc}, "Không tìm thấy phân loại.")
        c = await _client().put("classifications", {
            "name": _slug(body.name, "classification"), "displayName": display,
            "description": desc, "mutuallyExclusive": bool(body.mutuallyExclusive)})
        return {"ok": True, "fqn": c.get("fullyQualifiedName"), "machine_name": c.get("name")}
    except OMError as exc:
        raise _om_write_error(exc)


@router.delete("/govern/classification/{fqn:path}")
async def delete_classification(fqn: str, _: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        await _client().delete_by_fqn("classifications", fqn, recursive=True)
    except OMError as exc:
        raise _om_write_error(exc)
    return {"ok": True}


@router.get("/govern/tags")
async def govern_tags(classification: str | None = Query(default=None), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """Tags of a classification (direct children); omit `classification` to list ALL tags (assignment picker)."""
    params: dict[str, Any] = {"limit": 1000}
    if classification:
        params["parent"] = classification
    raw = await _safe_get("/tags", params)
    items = [
        {
            "name": t.get("displayName") or t.get("name"),
            "machine_name": t.get("name"),
            "fqn": t.get("fullyQualifiedName"),
            "description": t.get("description"),
            "classification": (t.get("classification") or {}).get("name") if isinstance(t.get("classification"), dict) else None,
            "provider": t.get("provider") or "user",
        }
        for t in (raw.get("data") or [])
    ]
    return {"tags": items, "total": len(items)}


@router.put("/govern/tag")
async def upsert_tag(body: TagWrite, _: User = Depends(get_current_user)) -> dict[str, Any]:
    display = _require_name(body.name)
    desc = body.description or display
    try:
        if body.machine_name:  # EDIT → PATCH
            return await _patch_curated_fields(
                "tags", f"{body.classification}.{body.machine_name}",
                {"displayName": display, "description": desc}, "Không tìm thấy tag.")
        t = await _client().put("tags", {
            "classification": body.classification, "name": _slug(body.name, "tag"),
            "displayName": display, "description": desc})
        return {"ok": True, "fqn": t.get("fullyQualifiedName"), "machine_name": t.get("name")}
    except OMError as exc:
        raise _om_write_error(exc)


@router.delete("/govern/tag/{fqn:path}")
async def delete_tag(fqn: str, _: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        await _client().delete_by_fqn("tags", fqn, recursive=False)
    except OMError as exc:
        raise _om_write_error(exc)
    return {"ok": True}


def _collect_accessible_metrics(db: Session, user: User) -> list[dict[str, Any]]:
    """
    Permission-aware measures (from datasets the user owns or is shared) + a
    CONFLICT annotation: metrics that share a name but have different definitions
    or formats across datasets are flagged, so the team can see divergence
    ("who's right?") and converge on one agreed metric (single source of truth).
    Format is taken straight from the measure (not a free-typed field).
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
                    "format": fmt,  # the measure's own format (normalized to a string) — source of truth
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

    # Conflict = same name on the SAME underlying source/model but a DIFFERENT
    # definition/format. Same name on DIFFERENT sources = genuinely different metrics
    # (not a conflict) — mirrors OM's "one name → one metric" intent, applied per
    # source. `variants` counts same-name peers (any source) for the compare tab.
    from collections import defaultdict

    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_name_source: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for m in metrics:
        nm = (m["name"] or "").strip().lower()
        by_name[nm].append(m)
        by_name_source[(nm, m["_src"])].append(m)

    for group in by_name_source.values():
        distinct_defs = {(x["definition"] or "").strip() for x in group}
        # A conflict is a DEFINITION disagreement on the same source (who's right?).
        # Format-only differences are a softer issue, not flagged as a hard conflict.
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
    definitions/formats can be compared and reconciled to one agreed metric."""
    key = (name or "").strip().lower()
    variants = [m for m in _collect_accessible_metrics(db, user) if (m["name"] or "").strip().lower() == key]
    distinct_defs = len({(v["definition"] or "").strip() for v in variants})
    return {"name": name, "count": len(variants), "distinctDefinitions": distinct_defs, "variants": variants}


@router.get("/govern/vocab-usage")
def vocab_usage(fqn: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Reverse lineage: which metrics have this glossary term / classification tag attached.
    Closes the catalog loop — a term/tag shows where it's actually used."""
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
    glossary terms, classification tags) — fields that do NOT affect SQL generation,
    so the engine is never at risk. Format comes from the measure itself; formula/type
    edits stay in the validated Dataset measure editor. Requires edit access to the dataset.
    """
    view = db.query(SemanticView).filter(SemanticView.id == body.view_id).first()
    if view is None:
        raise HTTPException(status_code=404, detail="Metric view not found")
    table = db.query(DatasetTable).filter(DatasetTable.id == view.dataset_table_id).first()
    dataset = db.query(Dataset).filter(Dataset.id == table.dataset_id).first() if table else None
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    require_edit_access(db, user, dataset, "datasets")  # 403 if the user can't edit this dataset

    measures = list(view.measures) if isinstance(view.measures, list) else []
    found = False
    new_measures: list[Any] = []
    for m in measures:
        if isinstance(m, dict) and m.get("name") == body.name:
            found = True
            m = dict(m)  # copy; only touch safe metadata fields
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

    view.measures = new_measures  # reassign so the JSON column change is persisted
    db.commit()
    return {"ok": True}


@router.get("/govern/metric-usage")
def metric_usage(
    table_id: int,
    name: str,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Lineage "used in": which charts (and their dashboards) reference this measure.
    Best-effort — matches the quoted measure name in chart configs scoped to the
    measure's dataset (charts can reference measures across the dataset's tables).
    """
    import json as _json

    table = db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
    if table is None:
        return {"charts": [], "dashboards": [], "chartCount": 0, "dashboardCount": 0}

    sibling_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == table.dataset_id).all()]
    charts = db.query(Chart).filter(Chart.dataset_table_id.in_(sibling_ids)).all() if sibling_ids else []

    # Charts reference a measure as `dataset_table_<table_id>.<name>` (its model
    # field ref); fall back to a bare quoted name for legacy configs.
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


# ════════════════════════ OBSERVABILITY MODULE ═════════════════════════════
@router.get("/observability/data-quality")
async def observability_data_quality(_: User = Depends(get_current_user)) -> dict[str, Any]:
    raw = await _safe_get("/dataQuality/testCases", {"fields": "testCaseResult", "limit": 500})
    cases = raw.get("data") or []
    counts = {"total": len(cases), "success": 0, "failed": 0, "aborted": 0}
    tests = []
    for c in cases:
        status = ((c.get("testCaseResult") or {}).get("testCaseStatus") or "").lower()
        if status == "success":
            counts["success"] += 1
        elif status == "failed":
            counts["failed"] += 1
        elif status == "aborted":
            counts["aborted"] += 1
        tests.append(
            {
                "name": c.get("displayName") or c.get("name"),
                "fqn": c.get("fullyQualifiedName"),
                "status": status or "queued",
                "entity": c.get("entityLink"),
            }
        )
    success_rate = round(100 * counts["success"] / counts["total"]) if counts["total"] else 0
    return {"summary": {**counts, "successRate": success_rate}, "tests": tests}


@router.get("/observability/incidents")
async def observability_incidents(_: User = Depends(get_current_user)) -> dict[str, Any]:
    raw = await _safe_get("/dataQuality/testCases/testCaseIncidentStatus", {"limit": 100})
    items = [
        {
            "id": i.get("id"),
            "testCase": (i.get("testCaseReference") or {}).get("name") if isinstance(i.get("testCaseReference"), dict) else None,
            "severity": i.get("severity"),
            "status": (i.get("testCaseResolutionStatusType") or i.get("status")),
            "assignee": (i.get("assignee") or {}).get("name") if isinstance(i.get("assignee"), dict) else None,
            "timestamp": i.get("timestamp"),
        }
        for i in (raw.get("data") or [])
    ]
    return {"incidents": items, "total": len(items)}


@router.get("/observability/alerts")
async def observability_alerts(_: User = Depends(get_current_user)) -> dict[str, Any]:
    raw = await _safe_get("/events/subscriptions", {"limit": 100})
    items = [
        {
            "name": a.get("displayName") or a.get("name"),
            "fqn": a.get("fullyQualifiedName") or a.get("name"),
            "description": a.get("description"),
            "enabled": a.get("enabled", False),
            "alertType": a.get("alertType"),
        }
        for a in (raw.get("data") or [])
    ]
    return {"alerts": items, "total": len(items)}


# ── AppBI-native Data Quality (the REAL engine — supersedes the empty OM proxy) ──
# Observability's Data Quality + Incident Manager surface AppBI's own dataset
# quality engine (rules run against live data), permission-aware like Metrics —
# NOT empty OM test cases. Alerts stays OM-backed (OM's eventing).
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
    """Real AppBI data-quality rollup across owned/shared datasets (supersedes the empty OM proxy)."""
    return _collect_quality_overview(db, user)


# ── Admin: publish a datasource catalog into OM (Tier-1) ────────────────────
@router.post("/sync/datasource/{datasource_id}")
async def sync_datasource(
    datasource_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin required to sync the catalog.")
    try:
        return await Publisher(_client()).publish_datasource(db, datasource_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except OMError:
        raise HTTPException(status_code=502, detail="Catalog backend rejected the sync.")
