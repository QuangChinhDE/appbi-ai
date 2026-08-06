"""
Native governance catalog service — Glossary (terms) + Classification (tags).

AppBI's own CRUD over its Postgres, replacing the OpenMetadata proxy. Returns
API-shaped dicts so the FE (unchanged /catalog/govern/* contract) keeps working.
FQN = "<parent_machine>.<child_machine>" (mirrors OM) so existing measure
glossary-term / tag references resolve unchanged.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import text as sa_text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.governance import (
    Classification,
    ClassificationTag,
    GovernChangeLog,
    GovernDocAssetLink,
    GovernDocLink,
    GovernDocRun,
    GovernDocSourceFile,
    GovernKnowledgeDoc,
    GovernKnowledgeDocVersion,
    GovernMetric,
    GovernMetricUsage,
    Glossary,
    GlossaryTerm,
)
from app.models.user import User

# {{metric:slug}} embed token — how a knowledge doc references a managed metric.
_METRIC_TOKEN_RE = re.compile(r"\{\{\s*metric:\s*([A-Za-z0-9_\-]+)\s*\}\}")
# {{dashboard:id}} / {{dataset:id}} / {{term:fqn}} — embed reporting assets.
_ASSET_TOKEN_RE = re.compile(r"\{\{\s*(dashboard|dataset|term):\s*([A-Za-z0-9_.\-]+)\s*\}\}")


def metric_slugs_in(body: str | None) -> set[str]:
    return {m.group(1) for m in _METRIC_TOKEN_RE.finditer(body or "")}


def asset_tokens_in(body: str | None) -> set[tuple[str, str]]:
    return {(m.group(1), m.group(2)) for m in _ASSET_TOKEN_RE.finditer(body or "")}


# Obsidian-style doc↔doc wikilink: [[Doc Title]] or [[Doc Title|alias]].
_WIKILINK_RE = re.compile(r"\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]")


def wikilinks_in(body: str | None) -> list[tuple[str, str | None]]:
    """Ordered (target, alias|None) pairs from [[...]] wikilinks in the body."""
    out: list[tuple[str, str | None]] = []
    for m in _WIKILINK_RE.finditer(body or ""):
        target = (m.group(1) or "").strip()
        alias = (m.group(2) or "").strip() or None
        if target:
            out.append((target, alias))
    return out


class GovernanceError(Exception):
    """Carries an HTTP status + detail so the API layer can surface it cleanly."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _build_vn_map() -> dict[int, int]:
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


def slugify(text: str, fallback: str = "item") -> str:
    """Stable, FQN-safe machine name (VN diacritics transliterated)."""
    s = (text or "").strip().translate(_VN_MAP).lower()
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return (s or fallback)[:128]


def require_name(name: str | None) -> str:
    display = (name or "").strip()
    if not display:
        raise GovernanceError(422, "Tên không được để trống.")
    return display


class GovernanceService:
    # ── Glossary ────────────────────────────────────────────────────────────
    @staticmethod
    def list_glossaries(db: Session) -> list[dict[str, Any]]:
        out = []
        for g in db.query(Glossary).order_by(Glossary.display_name).all():
            out.append({
                "name": g.display_name,
                "machine_name": g.name,
                "fqn": g.name,
                "description": g.description,
                "termCount": db.query(GlossaryTerm).filter(GlossaryTerm.glossary_id == g.id).count(),
                "provider": g.provider or "user",
            })
        return out

    @staticmethod
    def list_terms(db: Session) -> list[dict[str, Any]]:
        glossaries = {g.id: g for g in db.query(Glossary).all()}
        out = []
        for t in db.query(GlossaryTerm).order_by(GlossaryTerm.display_name).all():
            g = glossaries.get(t.glossary_id)
            out.append({
                "name": t.display_name,
                "machine_name": t.name,
                "fqn": f"{g.name}.{t.name}" if g else t.name,
                "definition": t.description,
                "synonyms": t.synonyms or [],
                "status": t.status,
                "glossary": g.display_name if g else None,
                "glossaryFqn": g.name if g else None,
                "provider": t.provider or "user",
            })
        return out

    @staticmethod
    def upsert_glossary(db: Session, display: str, machine_name: str | None, description: str | None) -> dict[str, Any]:
        display = require_name(display)
        desc = description or display
        if machine_name:  # EDIT (name stays stable)
            g = db.query(Glossary).filter(Glossary.name == machine_name).first()
            if g is None:
                raise GovernanceError(404, "Không tìm thấy bộ thuật ngữ.")
            GovernanceService._guard_system(g)
            g.display_name = display
            g.description = desc
        else:  # CREATE
            name = slugify(display, "glossary")
            g = Glossary(name=name, display_name=display, description=desc, provider="user")
            db.add(g)
        GovernanceService._commit(db)
        return {"ok": True, "fqn": g.name, "machine_name": g.name}

    @staticmethod
    def delete_glossary(db: Session, fqn: str) -> dict[str, Any]:
        g = db.query(Glossary).filter(Glossary.name == fqn).first()
        if g is None:
            return {"ok": True}  # idempotent
        GovernanceService._guard_system(g)
        db.delete(g)  # cascade removes terms
        db.commit()
        return {"ok": True}

    @staticmethod
    def upsert_term(db: Session, glossary_machine: str, display: str, machine_name: str | None,
                    description: str | None, synonyms: list[str]) -> dict[str, Any]:
        display = require_name(display)
        g = db.query(Glossary).filter(Glossary.name == glossary_machine).first()
        if g is None:
            raise GovernanceError(404, "Không tìm thấy bộ thuật ngữ.")
        syn = [s.strip() for s in (synonyms or []) if s and s.strip()]
        if machine_name:  # EDIT
            t = db.query(GlossaryTerm).filter(GlossaryTerm.glossary_id == g.id, GlossaryTerm.name == machine_name).first()
            if t is None:
                raise GovernanceError(404, "Không tìm thấy thuật ngữ.")
            GovernanceService._guard_system(t)
            t.display_name = display
            t.description = description or display
            t.synonyms = syn
            action = "update"
        else:  # CREATE
            name = slugify(display, "term")
            t = GlossaryTerm(glossary_id=g.id, name=name, display_name=display,
                             description=description or display, synonyms=syn, status="Approved", provider="user")
            db.add(t)
            action = "create"
        GovernanceService._commit(db)
        GovernanceService.log_change(
            db, "glossary_term", f"{g.name}.{t.name}", action,
            summary=f"{action} term '{t.display_name}'",
            snapshot={"definition": t.description, "synonyms": t.synonyms, "status": t.status},
        )
        return {"ok": True, "fqn": f"{g.name}.{t.name}", "machine_name": t.name}

    @staticmethod
    def delete_term(db: Session, fqn: str) -> dict[str, Any]:
        t = GovernanceService._term_by_fqn(db, fqn)
        if t is None:
            return {"ok": True}
        GovernanceService._guard_system(t)
        label = t.display_name
        db.delete(t)
        db.commit()
        GovernanceService.log_change(db, "glossary_term", fqn, "delete", summary=f"deleted term '{label}'")
        return {"ok": True}

    # ── Classification ───────────────────────────────────────────────────────
    @staticmethod
    def list_classifications(db: Session) -> list[dict[str, Any]]:
        out = []
        for c in db.query(Classification).order_by(Classification.display_name).all():
            out.append({
                "name": c.display_name,
                "machine_name": c.name,
                "fqn": c.name,
                "description": c.description,
                "termCount": db.query(ClassificationTag).filter(ClassificationTag.classification_id == c.id).count(),
                "mutuallyExclusive": bool(c.mutually_exclusive),
                "provider": c.provider or "user",
            })
        return out

    @staticmethod
    def list_tags(db: Session, classification_machine: str | None) -> list[dict[str, Any]]:
        classes = {c.id: c for c in db.query(Classification).all()}
        q = db.query(ClassificationTag)
        if classification_machine:
            c = next((c for c in classes.values() if c.name == classification_machine), None)
            if c is None:
                return []
            q = q.filter(ClassificationTag.classification_id == c.id)
        out = []
        for t in q.order_by(ClassificationTag.display_name).all():
            c = classes.get(t.classification_id)
            out.append({
                "name": t.display_name,
                "machine_name": t.name,
                "fqn": f"{c.name}.{t.name}" if c else t.name,
                "description": t.description,
                "classification": c.name if c else None,
                "provider": t.provider or "user",
            })
        return out

    @staticmethod
    def upsert_classification(db: Session, display: str, machine_name: str | None,
                              description: str | None, mutually_exclusive: bool) -> dict[str, Any]:
        display = require_name(display)
        desc = description or display
        if machine_name:  # EDIT (keep mutually_exclusive as-is)
            c = db.query(Classification).filter(Classification.name == machine_name).first()
            if c is None:
                raise GovernanceError(404, "Không tìm thấy phân loại.")
            GovernanceService._guard_system(c)
            c.display_name = display
            c.description = desc
        else:  # CREATE
            name = slugify(display, "classification")
            c = Classification(name=name, display_name=display, description=desc,
                               mutually_exclusive=bool(mutually_exclusive), provider="user")
            db.add(c)
        GovernanceService._commit(db)
        return {"ok": True, "fqn": c.name, "machine_name": c.name}

    @staticmethod
    def delete_classification(db: Session, fqn: str) -> dict[str, Any]:
        c = db.query(Classification).filter(Classification.name == fqn).first()
        if c is None:
            return {"ok": True}
        GovernanceService._guard_system(c)
        db.delete(c)  # cascade removes tags
        db.commit()
        return {"ok": True}

    @staticmethod
    def upsert_tag(db: Session, classification_machine: str, display: str, machine_name: str | None,
                   description: str | None) -> dict[str, Any]:
        display = require_name(display)
        c = db.query(Classification).filter(Classification.name == classification_machine).first()
        if c is None:
            raise GovernanceError(404, "Không tìm thấy phân loại.")
        if machine_name:  # EDIT
            t = db.query(ClassificationTag).filter(ClassificationTag.classification_id == c.id, ClassificationTag.name == machine_name).first()
            if t is None:
                raise GovernanceError(404, "Không tìm thấy tag.")
            GovernanceService._guard_system(t)
            t.display_name = display
            t.description = description or display
        else:  # CREATE
            name = slugify(display, "tag")
            t = ClassificationTag(classification_id=c.id, name=name, display_name=display,
                                  description=description or display, provider="user")
            db.add(t)
        GovernanceService._commit(db)
        return {"ok": True, "fqn": f"{c.name}.{t.name}", "machine_name": t.name}

    @staticmethod
    def delete_tag(db: Session, fqn: str) -> dict[str, Any]:
        t = GovernanceService._tag_by_fqn(db, fqn)
        if t is None:
            return {"ok": True}
        GovernanceService._guard_system(t)
        db.delete(t)
        db.commit()
        return {"ok": True}

    # ── Management Metrics (metrics quản trị doanh nghiệp) ───────────────────
    @staticmethod
    def _metric_dict(m: GovernMetric) -> dict[str, Any]:
        return {
            "name": m.display_name,
            "machine_name": m.name,
            "fqn": m.name,
            "definition": m.definition,
            "formula": m.formula,
            "unit": m.unit,
            "grain": m.grain,
            "category": m.category,
            "direction": m.direction,
            "target_value": m.target_value,
            "target_operator": m.target_operator,
            "target_value2": m.target_value2,
            "owner": m.owner,
            "related_term_fqn": m.related_term_fqn,
            "dataset_id": m.dataset_id,
            "dataset_table_id": m.dataset_table_id,
            "measure_ref": m.measure_ref,
            "home_doc_id": m.home_doc_id,
            "anchor": m.anchor,
            "synonyms": m.synonyms or [],
            "status": m.status,
            "version": m.version,
            "provider": m.provider or "user",
            "updated_at": m.updated_at.isoformat() if m.updated_at else None,
        }

    @staticmethod
    def list_managed_metrics(
        db: Session, category: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        q = db.query(GovernMetric)
        if category:
            q = q.filter(GovernMetric.category == category)
        if status:
            q = q.filter(GovernMetric.status == status)
        rows = q.order_by(GovernMetric.category, GovernMetric.display_name).all()
        from sqlalchemy import func as _f
        counts = dict(
            db.query(GovernMetricUsage.metric_id, _f.count(GovernMetricUsage.id))
            .group_by(GovernMetricUsage.metric_id).all()
        )
        home_ids = {m.home_doc_id for m in rows if m.home_doc_id}
        docs = (
            {d.id: d for d in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id.in_(home_ids)).all()}
            if home_ids else {}
        )
        out = []
        for m in rows:
            d = GovernanceService._metric_dict(m)
            d["usage_count"] = int(counts.get(m.id, 0))
            hd = docs.get(m.home_doc_id) if m.home_doc_id else None
            d["home_doc_title"] = hd.title if hd else None
            out.append(d)
        return out

    @staticmethod
    def get_managed_metric(db: Session, name: str) -> dict[str, Any] | None:
        m = db.query(GovernMetric).filter(GovernMetric.name == name).first()
        if m is None:
            return None
        d = GovernanceService._metric_dict(m)
        d["lineage"] = GovernanceService.metric_lineage(db, m)
        return d

    @staticmethod
    def upsert_managed_metric(db: Session, payload: dict[str, Any], *, changed_by: str | None = None) -> dict[str, Any]:
        display = require_name(payload.get("name"))
        machine_name = payload.get("machine_name")
        fields = dict(
            definition=payload.get("definition"),
            formula=payload.get("formula"),
            unit=payload.get("unit"),
            grain=payload.get("grain"),
            category=payload.get("category"),
            direction=(payload.get("direction") or "neutral"),
            target_value=payload.get("target_value"),
            target_operator=payload.get("target_operator"),
            target_value2=payload.get("target_value2"),
            owner=payload.get("owner"),
            related_term_fqn=payload.get("related_term_fqn"),
            dataset_id=payload.get("dataset_id"),
            dataset_table_id=payload.get("dataset_table_id"),
            measure_ref=payload.get("measure_ref"),
            home_doc_id=payload.get("home_doc_id"),
            anchor=payload.get("anchor"),
            synonyms=[s.strip() for s in (payload.get("synonyms") or []) if s and str(s).strip()],
            status=(payload.get("status") or "Draft"),
        )
        if machine_name:  # EDIT — bump version, keep machine name stable
            m = db.query(GovernMetric).filter(GovernMetric.name == machine_name).first()
            if m is None:
                raise GovernanceError(404, "Không tìm thấy chỉ số quản trị.")
            GovernanceService._guard_system(m)
            m.display_name = display
            for k, v in fields.items():
                setattr(m, k, v)
            m.version = (m.version or 1) + 1
            action = "update"
        else:  # CREATE
            name = slugify(display, "metric")
            if db.query(GovernMetric).filter(GovernMetric.name == name).first():
                name = f"{name}_{int(db.query(GovernMetric).count()) + 1}"
            m = GovernMetric(name=name, display_name=display, version=1, provider="user", **fields)
            db.add(m)
            action = "create"
        GovernanceService._commit(db)
        GovernanceService.log_change(
            db, "metric", m.name, action,
            summary=f"{action} metric '{m.display_name}' (v{m.version}, {m.status})",
            changed_by=changed_by, snapshot=GovernanceService._metric_dict(m),
        )
        return {"ok": True, "fqn": m.name, "machine_name": m.name, "version": m.version}

    @staticmethod
    def delete_managed_metric(db: Session, name: str, *, changed_by: str | None = None) -> dict[str, Any]:
        m = db.query(GovernMetric).filter(GovernMetric.name == name).first()
        if m is None:
            return {"ok": True}  # idempotent
        GovernanceService._guard_system(m)
        label = m.display_name
        db.delete(m)
        db.commit()
        GovernanceService.log_change(db, "metric", name, "delete", summary=f"deleted metric '{label}'", changed_by=changed_by)
        return {"ok": True}

    # ── Metric ↔ doc lineage (SSOT + reuse graph) ────────────────────────────
    @staticmethod
    def _doc_ref(db: Session, doc_id: int | None) -> dict[str, Any] | None:
        if not doc_id:
            return None
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        return {"id": d.id, "title": d.title, "space": d.space} if d else None

    @staticmethod
    def metric_lineage(db: Session, metric: GovernMetric) -> dict[str, Any]:
        usages = db.query(GovernMetricUsage).filter(GovernMetricUsage.metric_id == metric.id).all()
        return {
            "home_doc": GovernanceService._doc_ref(db, metric.home_doc_id),
            "used_in": [r for r in (GovernanceService._doc_ref(db, u.doc_id) for u in usages) if r],
        }

    @staticmethod
    def sync_doc_metric_usage(db: Session, doc_id: int, body: str | None) -> None:
        """Reconcile a doc's reuse edges from its {{metric:slug}} tokens. A token
        whose metric is DEFINED elsewhere (home_doc_id != this doc) is a reuse;
        a token in the metric's own home doc is the definition, not a reuse."""
        slugs = metric_slugs_in(body)
        metrics = db.query(GovernMetric).filter(GovernMetric.name.in_(slugs)).all() if slugs else []
        desired = {m.id for m in metrics if m.home_doc_id != doc_id}
        existing = {u.metric_id: u for u in db.query(GovernMetricUsage).filter(GovernMetricUsage.doc_id == doc_id).all()}
        for mid in desired - set(existing):
            db.add(GovernMetricUsage(metric_id=mid, doc_id=doc_id))
        for mid in set(existing) - desired:
            db.delete(existing[mid])
        db.commit()

    @staticmethod
    def sync_doc_asset_links(db: Session, doc_id: int, body: str | None) -> None:
        """Reconcile a doc's {{dashboard:}} / {{dataset:}} / {{term:}} links."""
        desired = asset_tokens_in(body)  # {(type, ref)}
        existing = {
            (l.asset_type, l.asset_ref): l
            for l in db.query(GovernDocAssetLink).filter(GovernDocAssetLink.doc_id == doc_id).all()
        }
        for key in desired - set(existing):
            db.add(GovernDocAssetLink(doc_id=doc_id, asset_type=key[0], asset_ref=key[1]))
        for key in set(existing) - desired:
            db.delete(existing[key])
        db.commit()

    @staticmethod
    def _doc_title_index(db: Session) -> dict[str, int]:
        """Lowercased title (and slug) → doc id, for resolving [[wikilinks]]."""
        idx: dict[str, int] = {}
        for d in db.query(GovernKnowledgeDoc.id, GovernKnowledgeDoc.title, GovernKnowledgeDoc.slug).all():
            if d.slug:
                idx.setdefault(str(d.slug).strip().lower(), d.id)
            if d.title:
                idx[str(d.title).strip().lower()] = d.id  # title wins over slug
        return idx

    @staticmethod
    def resolve_wikilinks(db: Session, body: str | None) -> list[dict[str, Any]]:
        """Resolve each [[target]] to a doc card (for the reader). Preserves the
        raw target + alias so the FE can replace the exact literal in the body."""
        pairs = wikilinks_in(body)
        if not pairs:
            return []
        idx = GovernanceService._doc_title_index(db)
        titles = {d.id: d.title for d in db.query(GovernKnowledgeDoc.id, GovernKnowledgeDoc.title).all()}
        out: list[dict[str, Any]] = []
        seen: set[tuple[str, str | None]] = set()
        for target, alias in pairs:
            if (target, alias) in seen:
                continue
            seen.add((target, alias))
            doc_id = idx.get(target.strip().lower())
            out.append({
                "target": target, "alias": alias,
                "doc_id": doc_id, "title": titles.get(doc_id) if doc_id else None,
                "exists": doc_id is not None,
            })
        return out

    @staticmethod
    def sync_doc_links(db: Session, doc_id: int, body: str | None) -> None:
        """Reconcile a doc's [[wikilink]] edges → govern_doc_links (resolved, by
        id; self-links ignored)."""
        idx = GovernanceService._doc_title_index(db)
        desired: set[int] = set()
        for target, _alias in wikilinks_in(body):
            tid = idx.get(target.strip().lower())
            if tid and tid != doc_id:
                desired.add(tid)
        existing = {l.to_doc_id: l for l in db.query(GovernDocLink).filter(GovernDocLink.from_doc_id == doc_id).all()}
        for tid in desired - set(existing):
            db.add(GovernDocLink(from_doc_id=doc_id, to_doc_id=tid))
        for tid in set(existing) - desired:
            db.delete(existing[tid])
        db.commit()

    @staticmethod
    def knowledge_graph(db: Session, current_user) -> dict[str, Any]:
        """Whole-hub knowledge graph (Obsidian graph view): visible docs as nodes,
        with EXPLICIT [[wikilink]] edges + implicit shared-KPI edges."""
        docs = GovernanceService._visible_docs_query(db, current_user).all()
        ids = {d.id for d in docs}
        nodes = [{"id": d.id, "title": d.title, "space": d.space, "doc_type": d.doc_type} for d in docs]
        edges: list[dict[str, Any]] = []
        seen: set[tuple[int, int, str]] = set()

        def add(a: int, b: int, kind: str):
            key = (min(a, b), max(a, b), kind)
            if a != b and a in ids and b in ids and key not in seen:
                seen.add(key)
                edges.append({"from": a, "to": b, "type": kind})

        # Explicit wikilink edges (directed, but drawn undirected in the graph).
        for l in db.query(GovernDocLink).all():
            add(l.from_doc_id, l.to_doc_id, "link")
        # Implicit shared-governed-KPI edges (docs co-using the same metric).
        by_metric: dict[int, set[int]] = {}
        for mid, did in db.query(GovernMetricUsage.metric_id, GovernMetricUsage.doc_id).all():
            if did in ids:
                by_metric.setdefault(mid, set()).add(did)
        for dset in by_metric.values():
            dl = sorted(dset)
            for i in range(len(dl)):
                for j in range(i + 1, len(dl)):
                    add(dl[i], dl[j], "metric")
        return {"nodes": nodes, "edges": edges}

    @staticmethod
    def resolve_asset(db: Session, asset_type: str, asset_ref: str) -> dict[str, Any]:
        """Minimal card for an embedded asset (name + open target + existence)."""
        try:
            if asset_type == "dashboard":
                from app.models.models import Dashboard
                d = db.query(Dashboard).filter(Dashboard.id == int(asset_ref)).first() if str(asset_ref).isdigit() else None
                return {"type": "dashboard", "ref": asset_ref, "name": (d.name if d else None),
                        "open_path": (f"/dashboards/{d.id}" if d else None), "exists": bool(d)}
            if asset_type == "dataset":
                from app.models.dataset import Dataset
                d = db.query(Dataset).filter(Dataset.id == int(asset_ref)).first() if str(asset_ref).isdigit() else None
                return {"type": "dataset", "ref": asset_ref, "name": (d.name if d else None),
                        "description": (d.description if d else None),
                        "open_path": (f"/datasets/{d.id}" if d else None), "exists": bool(d)}
            if asset_type == "term":
                t = GovernanceService._term_by_fqn(db, asset_ref)
                return {"type": "term", "ref": asset_ref, "name": (t.display_name if t else None),
                        "definition": (t.description if t else None), "exists": bool(t)}
        except Exception:  # noqa: BLE001
            pass
        return {"type": asset_type, "ref": asset_ref, "name": None, "exists": False}

    @staticmethod
    def docs_referencing_asset(db: Session, asset_type: str, asset_ref: str) -> list[dict[str, Any]]:
        links = (
            db.query(GovernDocAssetLink)
            .filter(GovernDocAssetLink.asset_type == asset_type, GovernDocAssetLink.asset_ref == str(asset_ref))
            .all()
        )
        return [r for r in (GovernanceService._doc_ref(db, l.doc_id) for l in links) if r]

    # ── Change log (log Business domain theo sự phát triển) ──────────────────
    @staticmethod
    def log_change(
        db: Session, entity_type: str, entity_fqn: str, action: str,
        summary: str | None = None, changed_by: str | None = None, snapshot: Any = None,
    ) -> None:
        try:
            db.add(GovernChangeLog(
                entity_type=entity_type, entity_fqn=entity_fqn, action=action,
                summary=(summary or "")[:512], changed_by=changed_by, snapshot=snapshot,
            ))
            db.commit()
        except Exception:  # noqa: BLE001 — audit must never break the write
            db.rollback()

    @staticmethod
    def log_doc_run(
        db: Session, doc_id: int, run_type: str, *, trigger: str = "manual",
        status: str, detail: str | None = None, stats: Any = None,
        changed_by: str | None = None, finished_at: Any = None,
    ) -> None:
        """Persist one Knowledge Doc sync/embed run — the History tab's data
        source. Mirrors log_change()'s try/commit/except-rollback idiom: a
        logging failure must never break the sync/embed run it's recording."""
        try:
            from datetime import datetime as _dt
            db.add(GovernDocRun(
                doc_id=doc_id, run_type=run_type, trigger=trigger, status=status,
                detail=(detail or "")[:512] or None, stats=stats,
                triggered_by=changed_by, finished_at=finished_at or _dt.utcnow(),
            ))
            db.commit()
        except Exception:  # noqa: BLE001 — logging must never break the run
            db.rollback()

    @staticmethod
    def list_change_log(
        db: Session, entity_type: str | None = None, entity_fqn: str | None = None, limit: int = 100,
    ) -> list[dict[str, Any]]:
        q = db.query(GovernChangeLog)
        if entity_type:
            q = q.filter(GovernChangeLog.entity_type == entity_type)
        if entity_fqn:
            q = q.filter(GovernChangeLog.entity_fqn == entity_fqn)
        rows = q.order_by(GovernChangeLog.created_at.desc()).limit(min(max(1, limit), 500)).all()
        return [{
            "id": r.id, "entity_type": r.entity_type, "entity_fqn": r.entity_fqn,
            "action": r.action, "summary": r.summary, "changed_by": r.changed_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]

    # ── Knowledge Hub (Cẩm nang tri thức) ────────────────────────────────────
    @staticmethod
    def _source_url(d: GovernKnowledgeDoc) -> str | None:
        """Where this doc's content actually lives, when it isn't hand-typed."""
        cfg = d.source_config or {}
        if d.source_type == "google_doc":
            gid = str(cfg.get("google_doc_id") or "").strip()
            return f"https://docs.google.com/document/d/{gid}/edit" if gid else None
        if d.source_type == "web":
            return str(cfg.get("url") or "").strip() or None
        return None

    @staticmethod
    def _doc_dict(d: GovernKnowledgeDoc, *, include_body: bool = True) -> dict[str, Any]:
        out = {
            "id": d.id, "title": d.title, "slug": d.slug, "space": d.space,
            "parent_id": d.parent_id, "position": d.position, "doc_type": d.doc_type,
            "summary": d.summary, "tags": d.tags or [],
            "related_metrics": d.related_metrics or [], "related_terms": d.related_terms or [],
            "related_dashboard_ids": d.related_dashboard_ids or [],
            "related_dataset_ids": d.related_dataset_ids or [],
            "status": d.status, "version": d.version, "pinned": bool(d.pinned),
            "owner": d.owner, "provider": d.provider or "user",
            "updated_at": d.updated_at.isoformat() if d.updated_at else None,
            # Knowledge Hub metadata + AI section + usage telemetry
            "business_domain": d.business_domain, "process_ref": d.process_ref,
            "review_date": d.review_date.isoformat() if d.review_date else None,
            "last_verified_at": d.last_verified_at.isoformat() if d.last_verified_at else None,
            "importance": d.importance or "normal",
            "ai_summary": d.ai_summary, "ai_keywords": d.ai_keywords or [],
            "view_count": int(d.view_count or 0),
            "retrieval_count": int(d.retrieval_count or 0),
            "published_version": d.published_version,
            "owner_id": str(d.owner_id) if d.owner_id else None,
            # External source (Source & Sync tab) + embedding config (Embedding tab)
            "source_type": d.source_type,
            "source_config": d.source_config or {},
            # Deep link back to the ORIGINAL (Google Doc / crawled page) so a
            # read-only source can always be opened where it's actually edited.
            "source_url": GovernanceService._source_url(d),
            "sync_schedule": d.sync_schedule,
            "last_synced_at": d.last_synced_at.isoformat() if d.last_synced_at else None,
            "last_sync_status": d.last_sync_status,
            "chunk_strategy": d.chunk_strategy or "paragraph",
            "chunk_size": d.chunk_size or 850,
            "chunk_overlap": d.chunk_overlap or 0,
            "embedding_model": d.embedding_model,
        }
        if include_body:
            out["body"] = d.body or ""
        return out

    # ── Resource permission helpers (shared with the Dataset stack) ─────────
    _LEVEL = {"none": 0, "view": 1, "edit": 2, "full": 3}

    @staticmethod
    def _doc_permission(db: Session, current_user, d: GovernKnowledgeDoc) -> str:
        """Effective permission ('none'|'view'|'edit'|'full') of user on a doc."""
        from app.core.dependencies import get_effective_permission
        return get_effective_permission(db, current_user, d, "govern")

    @staticmethod
    def _require_doc(db: Session, current_user, d: GovernKnowledgeDoc, min_level: str) -> str:
        eff = GovernanceService._doc_permission(db, current_user, d)
        if GovernanceService._LEVEL.get(eff, 0) < GovernanceService._LEVEL.get(min_level, 0):
            raise GovernanceError(403, "Bạn không có quyền thao tác trên tài liệu này.")
        return eff

    @staticmethod
    def require_doc_access(db: Session, doc_id: int, current_user, min_level: str = "view") -> GovernKnowledgeDoc:
        """Load a doc + enforce the caller has at least `min_level` on it."""
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None:
            raise GovernanceError(404, "Không tìm thấy trang tri thức.")
        if current_user is not None:
            GovernanceService._require_doc(db, current_user, d, min_level)
        return d

    # ── AI-ready score (deterministic — no LLM) ─────────────────────────────
    # A document is "AI ready" when it carries everything the RAG/bot pipeline
    # and a new reader need. Each miss returns a machine key the FE turns into
    # a concrete suggestion.
    @staticmethod
    def _ai_ready(d: GovernKnowledgeDoc, has_chunks: bool) -> dict[str, Any]:
        import re as _re
        from datetime import date, datetime, timedelta

        body = d.body or ""
        checks: list[tuple[str, int, bool]] = [
            ("summary", 14, bool((d.summary or "").strip() or (d.ai_summary or "").strip())),
            ("tags", 9, bool(d.tags)),
            ("owner", 9, bool((d.owner or "").strip())),
            ("headings", 13, len(_re.findall(r"^#{1,3}\s", body, _re.M)) >= 2),
            ("links", 13, bool(_re.search(r"\{\{(metric|dashboard|dataset|term):[^}]+\}\}", body))),
            ("context", 9, bool((d.business_domain or "").strip() or (d.process_ref or "").strip())),
            ("review", 9, bool(
                (d.review_date and d.review_date >= date.today())
                or (d.last_verified_at and d.last_verified_at >= datetime.utcnow() - timedelta(days=90))
            )),
            ("embedded", 14, has_chunks),
            # Optional nice-to-have signal, not as load-bearing as embedded/headings —
            # a doc can be perfectly AI-ready while still hand-typed.
            ("source_connected", 10, bool(getattr(d, "source_type", None))),
        ]
        score = sum(w for _, w, ok in checks if ok)
        return {"score": score, "missing": [k for k, _, ok in checks if not ok]}

    @staticmethod
    def _chunked_doc_ids(db: Session, doc_ids: list[int]) -> set[int]:
        """Doc ids that have RAG chunk embeddings (raw table; best-effort)."""
        if not doc_ids:
            return set()
        try:
            rows = db.execute(
                sa_text("SELECT DISTINCT doc_id FROM govern_doc_chunk WHERE doc_id = ANY(:ids) AND embedding IS NOT NULL"),
                {"ids": doc_ids},
            ).fetchall()
            return {r[0] for r in rows}
        except Exception:  # noqa: BLE001 — table may not exist pre-migration
            return set()

    @staticmethod
    def _visible_docs_query(db: Session, current_user):
        """Docs the user may see: owned + shared (+ everything for admins), via
        the same resource-permission stack Datasets use."""
        from app.core.permissions import _owned_or_shared
        from app.models.resource_share import ResourceType
        return _owned_or_shared(db, GovernKnowledgeDoc, ResourceType.KNOWLEDGE_DOC, current_user)

    @staticmethod
    def list_knowledge_docs(
        db: Session, current_user, space: str | None = None, status: str | None = None,
    ) -> list[dict[str, Any]]:
        """Lightweight (no body) list, scoped to docs the user owns / is shared."""
        from app.core.permissions import stamp_owner_emails
        q = GovernanceService._visible_docs_query(db, current_user)
        if space:
            q = q.filter(GovernKnowledgeDoc.space == space)
        if status:
            q = q.filter(GovernKnowledgeDoc.status == status)
        rows = q.order_by(
            GovernKnowledgeDoc.space, GovernKnowledgeDoc.position, GovernKnowledgeDoc.title
        ).all()
        chunked = GovernanceService._chunked_doc_ids(db, [d.id for d in rows])
        stamp_owner_emails(db, rows)
        out = []
        for d in rows:
            item = GovernanceService._doc_dict(d, include_body=False)
            item["ai_ready"] = GovernanceService._ai_ready(d, d.id in chunked)
            item["user_permission"] = GovernanceService._doc_permission(db, current_user, d)
            item["owner_email"] = getattr(d, "owner_email", None)
            out.append(item)
        return out

    @staticmethod
    def knowledge_spaces(db: Session, current_user) -> list[dict[str, Any]]:
        """Top-level spaces with doc counts (scoped to visible docs)."""
        rows = GovernanceService._visible_docs_query(db, current_user).all()
        agg: dict[str, int] = {}
        for d in rows:
            agg[d.space or "Chung"] = agg.get(d.space or "Chung", 0) + 1
        return [{"space": s, "count": n} for s, n in sorted(agg.items())]

    @staticmethod
    def get_knowledge_doc(db: Session, doc_id: int, current_user=None) -> dict[str, Any] | None:
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None:
            return None
        eff = "full"
        if current_user is not None:
            eff = GovernanceService._require_doc(db, current_user, d, "view")
        out = GovernanceService._doc_dict(d)
        out["user_permission"] = eff
        if d.owner_id:
            u = db.query(User.email).filter(User.id == d.owner_id).first()
            out["owner_email"] = u[0] if u else None
        # Resolve {{metric:slug}} embeds → live metric cards + provenance flag
        # (is_source = this doc IS the metric's home/definition, else "reused").
        slugs = metric_slugs_in(d.body)
        if slugs:
            metrics = db.query(GovernMetric).filter(GovernMetric.name.in_(slugs)).all()
            found = {m.name for m in metrics}
            out["metrics_on_page"] = [
                {**GovernanceService._metric_dict(m), "is_source": (m.home_doc_id == d.id)}
                for m in metrics
            ]
            out["missing_metric_tokens"] = sorted(slugs - found)
        else:
            out["metrics_on_page"] = []
            out["missing_metric_tokens"] = []
        # Resolve embedded reporting assets (dashboards/datasets/terms).
        out["assets_on_page"] = [
            GovernanceService.resolve_asset(db, t, r) for (t, r) in sorted(asset_tokens_in(d.body))
        ]
        # Related docs — the knowledge-graph neighborhood. A doc is related when
        # it shares: a governed metric (co-use or reuse of one this doc defines),
        # a linked dashboard/dataset, or ≥2 tags. Each entry carries WHICH
        # signals connect them so the reader sees the reason.
        try:
            related: dict[int, dict[str, Any]] = {}

            def entry(od: GovernKnowledgeDoc) -> dict[str, Any]:
                return related.setdefault(od.id, {
                    "id": od.id, "title": od.title, "space": od.space,
                    "shared_metrics": [], "shared_dashboards": [], "shared_datasets": [], "shared_tags": [],
                })

            # 1) shared governed metrics
            used_ids = {u.metric_id for u in db.query(GovernMetricUsage.metric_id).filter(GovernMetricUsage.doc_id == d.id).all()}
            homed_ids = {m.id for m in db.query(GovernMetric.id).filter(GovernMetric.home_doc_id == d.id).all()}
            rel_ids = used_ids | homed_ids
            if rel_ids:
                mname = {m.id: m.display_name for m in db.query(GovernMetric).filter(GovernMetric.id.in_(rel_ids)).all()}
                usages = (
                    db.query(GovernMetricUsage)
                    .filter(GovernMetricUsage.metric_id.in_(rel_ids), GovernMetricUsage.doc_id != d.id)
                    .all()
                )
                other_ids = {u.doc_id for u in usages}
                docmap = {
                    x.id: x for x in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id.in_(other_ids)).all()
                } if other_ids else {}
                for u in usages:
                    od = docmap.get(u.doc_id)
                    if od is None:
                        continue
                    nm = mname.get(u.metric_id)
                    e = entry(od)
                    if nm and nm not in e["shared_metrics"]:
                        e["shared_metrics"].append(nm)

            # 2) shared dashboards / datasets (via asset links)
            my_links = db.query(GovernDocAssetLink).filter(
                GovernDocAssetLink.doc_id == d.id,
                GovernDocAssetLink.asset_type.in_(["dashboard", "dataset"]),
            ).all()
            if my_links:
                keys = {(l.asset_type, l.asset_ref) for l in my_links}
                others = db.query(GovernDocAssetLink).filter(
                    GovernDocAssetLink.asset_type.in_(["dashboard", "dataset"]),
                    GovernDocAssetLink.doc_id != d.id,
                ).all()
                match = [l for l in others if (l.asset_type, l.asset_ref) in keys]
                oids = {l.doc_id for l in match}
                docmap2 = {
                    x.id: x for x in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id.in_(oids)).all()
                } if oids else {}
                for l in match:
                    od = docmap2.get(l.doc_id)
                    if od is None:
                        continue
                    a = GovernanceService.resolve_asset(db, l.asset_type, l.asset_ref)
                    label = (a or {}).get("name") or l.asset_ref
                    e = entry(od)
                    bucket = e["shared_dashboards"] if l.asset_type == "dashboard" else e["shared_datasets"]
                    if label not in bucket:
                        bucket.append(label)

            # 3) ≥2 shared tags
            my_tags = set(d.tags or [])
            if len(my_tags) >= 2:
                for od in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id != d.id).all():
                    common = my_tags & set(od.tags or [])
                    if len(common) >= 2:
                        e = entry(od)
                        e["shared_tags"] = sorted(common)

            def weight(r: dict[str, Any]) -> int:
                return len(r["shared_metrics"]) * 3 + len(r["shared_dashboards"]) * 2 + len(r["shared_datasets"]) * 2 + (1 if r["shared_tags"] else 0)

            out["related_docs"] = sorted(related.values(), key=lambda r: -weight(r))[:8]
        except Exception:  # noqa: BLE001
            out["related_docs"] = []
        # [[wikilinks]] this doc points at (resolved for the reader) + BACKLINKS
        # (docs that explicitly link here — the Obsidian "linked mentions").
        try:
            out["wikilinks_on_page"] = GovernanceService.resolve_wikilinks(db, d.body)
        except Exception:  # noqa: BLE001
            out["wikilinks_on_page"] = []
        try:
            back_ids = [l.from_doc_id for l in db.query(GovernDocLink.from_doc_id).filter(GovernDocLink.to_doc_id == d.id).all()]
            backs = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id.in_(back_ids)).all() if back_ids else []
            out["backlinks"] = [{"id": b.id, "title": b.title, "space": b.space} for b in backs]
        except Exception:  # noqa: BLE001
            out["backlinks"] = []
        # AI-ready score for this doc (single chunk-existence check)
        out["ai_ready"] = GovernanceService._ai_ready(d, d.id in GovernanceService._chunked_doc_ids(db, [d.id]))
        return out

    @staticmethod
    def _parse_date(v: Any):
        """'YYYY-MM-DD' → date | None (tolerant)."""
        if not v:
            return None
        try:
            from datetime import date
            return date.fromisoformat(str(v)[:10])
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def upsert_knowledge_doc(db: Session, payload: dict[str, Any], *, changed_by: str | None = None, current_user=None) -> dict[str, Any]:
        title = require_name(payload.get("title"))
        doc_id = payload.get("id")
        fields = dict(
            space=(payload.get("space") or "Chung").strip() or "Chung",
            parent_id=payload.get("parent_id"),
            position=int(payload.get("position") or 0),
            doc_type=(payload.get("doc_type") or "article"),
            summary=(payload.get("summary") or None),
            body=(payload.get("body") or None),
            tags=[str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()],
            related_metrics=[str(x) for x in (payload.get("related_metrics") or [])],
            related_terms=[str(x) for x in (payload.get("related_terms") or [])],
            related_dashboard_ids=[int(x) for x in (payload.get("related_dashboard_ids") or []) if str(x).lstrip("-").isdigit()],
            related_dataset_ids=[int(x) for x in (payload.get("related_dataset_ids") or []) if str(x).lstrip("-").isdigit()],
            status=(payload.get("status") or "Draft"),
            pinned=bool(payload.get("pinned")),
            owner=payload.get("owner"),
            # Knowledge Hub metadata
            business_domain=(payload.get("business_domain") or None),
            process_ref=(payload.get("process_ref") or None),
            review_date=GovernanceService._parse_date(payload.get("review_date")),
            importance=(payload.get("importance") or "normal"),
        )
        if doc_id:  # EDIT — bump version
            d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == int(doc_id)).first()
            if d is None:
                raise GovernanceError(404, "Không tìm thấy trang tri thức.")
            if current_user is not None:
                GovernanceService._require_doc(db, current_user, d, "edit")
            d.title = title
            # Google Doc / crawled web sources OWN their content: the body is
            # whatever the last sync pulled, so a save must never overwrite it
            # (the FE also renders those read-only). Everything else on the
            # page — title, summary, tags, owner, metadata — stays ours to edit.
            if (d.source_type or "") in ("google_doc", "web"):
                fields.pop("body", None)
            for k, v in fields.items():
                setattr(d, k, v)
            d.version = (d.version or 1) + 1
            action = "update"
        else:  # CREATE — the creator owns the doc (resource-level ownership)
            d = GovernKnowledgeDoc(title=title, slug=slugify(title, "doc"), version=1, provider="user", **fields)
            if current_user is not None:
                d.owner_id = current_user.id
            db.add(d)
            action = "create"
        # First publish only: saving as "Published" with nothing live yet adopts
        # this version as the live one. If a version is ALREADY published, a save
        # leaves it untouched — the new version stays a draft until explicitly
        # published from the versions panel (so v1 stays live while v2 is drafted).
        if (d.status == "Published") and (d.published_version is None):
            d.published_version = d.version
        GovernanceService._commit(db)
        GovernanceService.log_change(
            db, "knowledge", d.slug or str(d.id), action,
            summary=f"{action} trang '{d.title}' (space {d.space}, v{d.version}, {d.status})",
            changed_by=changed_by,
        )
        # Reconcile which metrics this doc reuses (from {{metric:slug}} tokens)
        # and which reporting assets (dashboards/datasets/terms) it links.
        GovernanceService.sync_doc_metric_usage(db, d.id, d.body)
        GovernanceService.sync_doc_asset_links(db, d.id, d.body)
        GovernanceService.sync_doc_links(db, d.id, d.body)  # [[wikilinks]] → graph edges
        # Lock an immutable snapshot of this version (history / evolution).
        try:
            db.add(GovernKnowledgeDocVersion(
                doc_id=d.id, version=d.version, title=d.title, space=d.space,
                doc_type=d.doc_type, summary=d.summary, body=d.body, status=d.status,
                change_note=(payload.get("change_note") or None), changed_by=changed_by,
            ))
            db.commit()
        except Exception:  # noqa: BLE001 — history must never block a save
            db.rollback()
        # Embed the doc body into chunks for RAG (hash-gated → unchanged body = 0
        # embedding calls). Best-effort: never block a save on embedding.
        try:
            from app.services.dashboard_ai_bot.govern_doc_embeddings import embed_doc
            result = embed_doc(db, d)
            GovernanceService.log_doc_run(
                db, d.id, "embed", trigger="save", status=result.get("status", "error"),
                detail=result.get("detail"), stats=result, changed_by=changed_by,
            )
        except Exception:  # noqa: BLE001
            db.rollback()
        # AI summary + keywords (hash-gated the same way; user-editable output).
        try:
            from app.services.dashboard_ai_bot.govern_ai_summary import generate_summary
            generate_summary(db, d)
        except Exception:  # noqa: BLE001
            db.rollback()
        return {"ok": True, "id": d.id, "version": d.version, "slug": d.slug}

    @staticmethod
    def delete_knowledge_doc(db: Session, doc_id: int, *, changed_by: str | None = None, current_user=None) -> dict[str, Any]:
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None:
            return {"ok": True}
        if current_user is not None:
            GovernanceService._require_doc(db, current_user, d, "full")  # owner/admin only
        # Also drop resource shares for this doc.
        try:
            from app.models.resource_share import ResourceShare, ResourceType
            db.query(ResourceShare).filter(
                ResourceShare.resource_type == ResourceType.KNOWLEDGE_DOC,
                ResourceShare.resource_id == str(doc_id),
            ).delete(synchronize_session=False)
        except Exception:  # noqa: BLE001
            pass
        title = d.title
        # Re-parent children to this doc's parent so the tree doesn't orphan.
        for child in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.parent_id == doc_id).all():
            child.parent_id = d.parent_id
        # Cascade-clean this doc's owned rows so no orphans linger (asset links
        # that would otherwise still point the AI/knowledge assembler at a
        # deleted doc, reuse edges, and locked version snapshots).
        from app.models.governance import GovernDocAssetLink as _Link
        db.query(_Link).filter(_Link.doc_id == doc_id).delete(synchronize_session=False)
        db.query(GovernMetricUsage).filter(GovernMetricUsage.doc_id == doc_id).delete(synchronize_session=False)
        # Wikilink edges in BOTH directions (this doc's out-links + others' backlinks to it).
        db.query(GovernDocLink).filter((GovernDocLink.from_doc_id == doc_id) | (GovernDocLink.to_doc_id == doc_id)).delete(synchronize_session=False)
        db.query(GovernKnowledgeDocVersion).filter(GovernKnowledgeDocVersion.doc_id == doc_id).delete(synchronize_session=False)
        # Drop RAG chunk embeddings for this doc (raw table, no ORM model).
        try:
            db.execute(sa_text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc_id})
        except Exception:  # noqa: BLE001 — table may not exist pre-migration
            pass
        # Metrics that called this doc their SSOT home lose the pointer (kept as metrics).
        for m in db.query(GovernMetric).filter(GovernMetric.home_doc_id == doc_id).all():
            m.home_doc_id = None
        db.delete(d)
        db.commit()
        GovernanceService.log_change(db, "knowledge", str(doc_id), "delete", summary=f"xoá trang '{title}'", changed_by=changed_by)
        return {"ok": True}

    @staticmethod
    def verify_knowledge_doc(db: Session, doc_id: int, *, changed_by: str | None = None, current_user=None) -> dict[str, Any]:
        """Owner attests the doc is still correct → refreshes the review clock."""
        from datetime import datetime
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None:
            raise GovernanceError(404, "Không tìm thấy trang tri thức.")
        if current_user is not None:
            GovernanceService._require_doc(db, current_user, d, "edit")
        d.last_verified_at = datetime.utcnow()
        GovernanceService._commit(db)
        GovernanceService.log_change(db, "knowledge", d.slug or str(d.id), "verify",
                                     summary=f"kiểm chứng trang '{d.title}'", changed_by=changed_by)
        return {"ok": True, "last_verified_at": d.last_verified_at.isoformat()}

    @staticmethod
    def published_body(db: Session, doc: GovernKnowledgeDoc) -> str:
        """The body that is LIVE for RAG/public: the published version's snapshot
        if one is set, else the current working body (docs that never used
        explicit publishing keep serving their latest)."""
        if doc.published_version:
            v = (
                db.query(GovernKnowledgeDocVersion)
                .filter(GovernKnowledgeDocVersion.doc_id == doc.id,
                        GovernKnowledgeDocVersion.version == doc.published_version)
                .first()
            )
            if v is not None:
                return v.body or ""
        return doc.body or ""

    @staticmethod
    def publish_version(db: Session, doc_id: int, version: int, change_note: str, *, changed_by: str | None = None, current_user=None) -> dict[str, Any]:
        """Make a SPECIFIC version live. Records the change note on that version,
        points published_version at it, flips the doc to Published, and re-embeds
        the (now different) live body for RAG. The latest draft is unaffected."""
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if d is None:
            raise GovernanceError(404, "Không tìm thấy trang tri thức.")
        if current_user is not None:
            GovernanceService._require_doc(db, current_user, d, "full")  # publish = owner/admin
        snap = (
            db.query(GovernKnowledgeDocVersion)
            .filter(GovernKnowledgeDocVersion.doc_id == doc_id, GovernKnowledgeDocVersion.version == version)
            .first()
        )
        if snap is None:
            raise GovernanceError(404, f"Không tìm thấy phiên bản v{version}.")
        note = (change_note or "").strip()
        if not note:
            raise GovernanceError(422, "Cần ghi tóm tắt thay đổi khi xuất bản.")
        snap.change_note = note[:512]
        d.published_version = version
        d.status = "Published"
        GovernanceService._commit(db)
        GovernanceService.log_change(db, "knowledge", d.slug or str(d.id), "publish",
                                     summary=f"xuất bản v{version} trang '{d.title}': {note[:120]}", changed_by=changed_by)
        # Re-embed the live body (published version) for RAG. Best-effort.
        try:
            from app.services.dashboard_ai_bot.govern_doc_embeddings import embed_doc
            result = embed_doc(db, d)
            GovernanceService.log_doc_run(
                db, d.id, "embed", trigger="publish", status=result.get("status", "error"),
                detail=result.get("detail"), stats=result, changed_by=changed_by,
            )
        except Exception:  # noqa: BLE001
            db.rollback()
        return {"ok": True, "published_version": version}

    @staticmethod
    def version_change_note_ai(db: Session, doc_id: int, version: int) -> dict[str, Any]:
        """Draft a 1-2 sentence 'what changed' note by diffing this version's body
        against the previously-published (or previous) version — feeds the LLM the
        DIFF only, never the whole document (token-safe for huge docs)."""
        rows = (
            db.query(GovernKnowledgeDocVersion)
            .filter(GovernKnowledgeDocVersion.doc_id == doc_id)
            .order_by(GovernKnowledgeDocVersion.version.desc())
            .all()
        )
        cur = next((r for r in rows if r.version == version), None)
        if cur is None:
            raise GovernanceError(404, f"Không tìm thấy phiên bản v{version}.")
        d = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        base_v = d.published_version if (d and d.published_version and d.published_version != version) else None
        prev = next((r for r in rows if r.version == base_v), None) if base_v else \
            next((r for r in rows if r.version < version), None)
        from app.services.dashboard_ai_bot.govern_ai_summary import summarize_change
        note = summarize_change(prev.body if prev else "", cur.body or "", prev_label=f"v{prev.version}" if prev else "trước")
        return {"change_note": note}

    @staticmethod
    def knowledge_insights(db: Session, current_user) -> dict[str, Any]:
        """Knowledge-health lists for managers — scoped to docs the user can see."""
        from datetime import date
        docs = GovernanceService._visible_docs_query(db, current_user).all()
        chunked = GovernanceService._chunked_doc_ids(db, [d.id for d in docs])

        def ref(d: GovernKnowledgeDoc) -> dict[str, Any]:
            return {"id": d.id, "title": d.title}

        out: dict[str, Any] = {
            "no_owner": [ref(d) for d in docs if not (d.owner or "").strip()][:8],
            "no_summary": [ref(d) for d in docs if not ((d.summary or "").strip() or (d.ai_summary or "").strip())][:8],
            "no_tags": [ref(d) for d in docs if not d.tags][:8],
            "stale_review": [ref(d) for d in docs if d.review_date and d.review_date < date.today()][:8],
            "not_embedded": [ref(d) for d in docs if d.id not in chunked][:8],
            "most_viewed": [
                {**ref(d), "count": int(d.view_count or 0)}
                for d in sorted(docs, key=lambda x: -(x.view_count or 0)) if (d.view_count or 0) > 0
            ][:8],
            "most_retrieved": [
                {**ref(d), "count": int(d.retrieval_count or 0)}
                for d in sorted(docs, key=lambda x: -(x.retrieval_count or 0)) if (d.retrieval_count or 0) > 0
            ][:8],
        }
        return out

    @staticmethod
    def govern_search(db: Session, q: str, current_user) -> dict[str, Any]:
        """Search-everything inside the Knowledge Hub: documents + governed KPIs +
        business terms + dashboards + datasets, grouped (≤5 per group). Keyword
        first; documents also get a semantic top-up from RAG chunks when
        embeddings are available (best-effort). Documents are scoped to what the
        user can see."""
        ql = (q or "").strip().lower()
        out: dict[str, Any] = {"documents": [], "metrics": [], "terms": [], "dashboards": [], "datasets": []}
        if not ql:
            return out

        def hit(*parts: Any) -> bool:
            return any(ql in str(p or "").lower() for p in parts)

        # Documents — keyword over title/summary/tags/keywords (visible docs only)
        docs = GovernanceService._visible_docs_query(db, current_user).all()
        visible_ids = {d.id for d in docs}
        seen: set[int] = set()
        for d in docs:
            if hit(d.title, d.summary, d.ai_summary, " ".join(d.tags or []), " ".join(d.ai_keywords or [])):
                out["documents"].append({"id": d.id, "name": d.title, "subtitle": d.space})
                seen.add(d.id)
            if len(out["documents"]) >= 5:
                break
        # Semantic top-up from chunk embeddings (skip silently when unavailable)
        if len(out["documents"]) < 5:
            try:
                from app.services.embedding_service import EmbeddingService
                qvec = EmbeddingService.generate_query_embedding(q) if EmbeddingService else None
                if qvec is not None:
                    rows = db.execute(
                        sa_text(
                            "SELECT c.doc_id, d.title, d.space FROM govern_doc_chunk c "
                            "JOIN govern_knowledge_docs d ON d.id = c.doc_id "
                            "WHERE c.embedding IS NOT NULL "
                            f"ORDER BY c.embedding <=> '{qvec}'::vector LIMIT 6"
                        )
                    ).fetchall()
                    for r in rows:
                        if r[0] in visible_ids and r[0] not in seen and len(out["documents"]) < 5:
                            out["documents"].append({"id": r[0], "name": r[1], "subtitle": r[2]})
                            seen.add(r[0])
            except Exception:  # noqa: BLE001
                pass

        for m in db.query(GovernMetric).all():
            if hit(m.display_name, m.definition, " ".join(m.synonyms or [])):
                out["metrics"].append({"id": m.name, "name": m.display_name, "subtitle": m.definition or ""})
            if len(out["metrics"]) >= 5:
                break
        for term in db.query(GlossaryTerm).all():
            if hit(term.display_name, term.description, " ".join(term.synonyms or [])):
                out["terms"].append({"id": term.fqn, "name": term.display_name, "subtitle": term.description or ""})
            if len(out["terms"]) >= 5:
                break
        try:
            from app.models.models import Dashboard
            for dash in db.query(Dashboard).filter(Dashboard.name.ilike(f"%{q}%")).limit(5).all():
                out["dashboards"].append({"id": dash.id, "name": dash.name, "subtitle": "", "open_path": f"/dashboards/{dash.id}"})
        except Exception:  # noqa: BLE001
            pass
        try:
            from app.models.dataset import Dataset
            for ds in db.query(Dataset).filter(Dataset.name.ilike(f"%{q}%")).limit(5).all():
                out["datasets"].append({"id": ds.id, "name": ds.name, "subtitle": "", "open_path": f"/datasets/{ds.id}"})
        except Exception:  # noqa: BLE001
            pass
        return out

    @staticmethod
    def list_doc_versions(db: Session, doc_id: int) -> list[dict[str, Any]]:
        rows = (
            db.query(GovernKnowledgeDocVersion)
            .filter(GovernKnowledgeDocVersion.doc_id == doc_id)
            .order_by(GovernKnowledgeDocVersion.version.desc())
            .all()
        )
        doc = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        pub = doc.published_version if doc else None
        latest = max((r.version for r in rows), default=None)
        return [{
            "version": r.version, "title": r.title, "status": r.status,
            "change_note": r.change_note, "changed_by": r.changed_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "is_published": (r.version == pub),
            "is_latest": (r.version == latest),
        } for r in rows]

    @staticmethod
    def get_doc_version(db: Session, doc_id: int, version: int) -> dict[str, Any] | None:
        r = (
            db.query(GovernKnowledgeDocVersion)
            .filter(GovernKnowledgeDocVersion.doc_id == doc_id, GovernKnowledgeDocVersion.version == version)
            .first()
        )
        if r is None:
            return None
        return {
            "doc_id": r.doc_id, "version": r.version, "title": r.title, "space": r.space,
            "doc_type": r.doc_type, "summary": r.summary, "body": r.body, "status": r.status,
            "change_note": r.change_note, "changed_by": r.changed_by,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }

    # ── internals ──────────────────────────────────────────────────────────
    @staticmethod
    def _term_by_fqn(db: Session, fqn: str) -> GlossaryTerm | None:
        gname, _, tname = (fqn or "").partition(".")
        if not tname:
            return None
        g = db.query(Glossary).filter(Glossary.name == gname).first()
        if g is None:
            return None
        return db.query(GlossaryTerm).filter(GlossaryTerm.glossary_id == g.id, GlossaryTerm.name == tname).first()

    @staticmethod
    def _tag_by_fqn(db: Session, fqn: str) -> ClassificationTag | None:
        cname, _, tname = (fqn or "").partition(".")
        if not tname:
            return None
        c = db.query(Classification).filter(Classification.name == cname).first()
        if c is None:
            return None
        return db.query(ClassificationTag).filter(ClassificationTag.classification_id == c.id, ClassificationTag.name == tname).first()

    @staticmethod
    def _guard_system(obj: Any) -> None:
        if getattr(obj, "provider", "user") == "system":
            raise GovernanceError(403, "Mục hệ thống — chỉ đọc.")

    @staticmethod
    def _commit(db: Session) -> None:
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise GovernanceError(409, "Tên đã tồn tại.")
