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

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.governance import Classification, ClassificationTag, Glossary, GlossaryTerm


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
        else:  # CREATE
            name = slugify(display, "term")
            t = GlossaryTerm(glossary_id=g.id, name=name, display_name=display,
                             description=description or display, synonyms=syn, status="Approved", provider="user")
            db.add(t)
        GovernanceService._commit(db)
        return {"ok": True, "fqn": f"{g.name}.{t.name}", "machine_name": t.name}

    @staticmethod
    def delete_term(db: Session, fqn: str) -> dict[str, Any]:
        t = GovernanceService._term_by_fqn(db, fqn)
        if t is None:
            return {"ok": True}
        GovernanceService._guard_system(t)
        db.delete(t)
        db.commit()
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
