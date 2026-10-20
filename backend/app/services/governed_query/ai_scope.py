"""What a semantic field READS, for GovernAIScope on an AI surface (spec §1, I-1).

A field reaches data through more than its name: its `sql`, its `expression`, the
fields an expression or `depends_on` names (followed, transitively), the fields
and SQL of its own `filters` / `where_sql`, and `source_columns`. A check on names
alone was bypassed in review (a measure `${TABLE}.revenue - ${TABLE}.cost`, a
formula over an excluded measure, a conditional aggregate on an excluded column,
a dimension renamed over the excluded column, a role-play alias).

So the closure is walked, and every identifier in every SQL fragment reached is
compared with the exclusions. It over-refuses on purpose: a SQL keyword that
happens to equal an excluded column's name refuses the question. Anything the
walk cannot resolve (an unqualified ref, an unknown view or alias, a ref to a
field that does not exist) is `policy_unenforceable`, never "nothing excluded".
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from app.services.governed_query.principal import GovernedRefusal

_PLACEHOLDER = re.compile(r"\$\{\s*([^}]*?)\s*\}")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_QUOTED = re.compile(r'"([^"]+)"|`([^`]+)`|\[([^\]]+)\]')
_MAX_FIELDS = 500


def norm(name: Any) -> str:
    """One comparison key for an exclusion and an identifier: folded, and every run
    of non-alphanumerics is `_` (an exclusion authored as "Giá vốn" matches the
    physical `gia_von`)."""
    from app.core.text_fold import fold_text

    return re.sub(r"[^0-9a-z]+", "_", fold_text(name)).strip("_")


class FieldReach:
    """The closure of one model's semantic fields, resolved the way the engine
    resolves them: a view of the model's Dataset tables, a tableless view an
    explore of the model names, or a join alias of one of its explores."""

    def __init__(self, db, model, dataset_table_ids: Iterable[int]):
        from app.models.semantic import SemanticExplore, SemanticView

        self.db = db
        table_ids = set(dataset_table_ids)
        explores = (db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
                    if model is not None else [])
        named = {str(e.base_view_name or "") for e in explores}
        self.alias: dict[str, str] = {}
        for e in explores:
            for j in e.joins or []:
                if isinstance(j, dict) and j.get("view"):
                    named.add(str(j["view"]))
                    a = str(j.get("alias") or "").strip()
                    if a and a != j["view"]:
                        self.alias[a] = str(j["view"])
        from sqlalchemy import and_, or_

        self.views: dict[str, list] = {}
        clauses = []
        if table_ids:
            clauses.append(SemanticView.dataset_table_id.in_(table_ids))
        if named:
            clauses.append(and_(SemanticView.dataset_table_id.is_(None), SemanticView.name.in_(named)))
        for v in (db.query(SemanticView).filter(or_(*clauses)).all() if clauses else []):
            self.views.setdefault(v.name, []).append(v)

    def _fields(self, view_name: str, field_name: str) -> list[dict]:
        name = self.alias.get(view_name, view_name)
        out = []
        for v in self.views.get(name, []):
            for f in list(v.dimensions or []) + list(v.measures or []):
                if isinstance(f, dict) and f.get("name") == field_name:
                    out.append(f)
        return out

    def reach(self, refs: Iterable[str]) -> tuple[set[str], set[str]]:
        """(field names reached, identifiers in every SQL fragment reached)."""
        names: set[str] = set()
        idents: set[str] = set()
        seen: set[str] = set()
        stack = [str(r) for r in refs]
        while stack:
            ref = stack.pop()
            if ref in seen:
                continue
            seen.add(ref)
            if len(seen) > _MAX_FIELDS:
                raise GovernedRefusal("policy_unenforceable",
                                      "Không xác định được phạm vi dữ liệu câu hỏi đọc tới.", {"reason": "too_deep"})
            view, dot, field = ref.partition(".")
            if not dot or not view or not field:
                raise GovernedRefusal("policy_unenforceable",
                                      "Trường phải ghi đủ dạng view.field để kiểm tra phạm vi dữ liệu AI.",
                                      {"field": ref})
            defs = self._fields(view, field)
            if not defs:
                raise GovernedRefusal("policy_unenforceable",
                                      "Không xác định được trường này đọc dữ liệu nào.", {"field": ref})
            names.add(field)
            real_view = self.alias.get(view, view)
            for f in defs:
                for key in ("sql", "expression", "where_sql"):
                    text = f.get(key)
                    if isinstance(text, str) and text.strip():
                        self._scan(text, real_view, stack, idents)
                for dep in f.get("depends_on") or []:
                    stack.append(dep if "." in str(dep) else f"{real_view}.{dep}")
                for sc in f.get("source_columns") or []:
                    if isinstance(sc, dict) and sc.get("view") and sc.get("field"):
                        stack.append(f"{sc['view']}.{sc['field']}")
                for flt in f.get("filters") or []:
                    if isinstance(flt, dict):
                        fr = flt.get("field")
                        if isinstance(fr, str) and fr:
                            stack.append(fr if "." in fr else f"{real_view}.{fr}")
                        if isinstance(flt.get("sql"), str):
                            self._scan(flt["sql"], real_view, stack, idents)
        return names, idents

    def _scan(self, text: str, view: str, stack: list, idents: set) -> None:
        for inner in _PLACEHOLDER.findall(text):
            inner = inner.strip()
            if inner.upper() == "TABLE" or not inner:
                continue
            if "." in inner:
                head, _, tail = inner.partition(".")
                if head.upper() == "TABLE":
                    idents.add(tail)
                else:
                    stack.append(inner)
            else:
                # `${x}` names a field of the same view; the engine may also read
                # it as a column. Both are checked.
                idents.add(inner)
                if self._fields(view, inner):
                    stack.append(f"{view}.{inner}")
        body = _PLACEHOLDER.sub(" ", text)
        for groups in _QUOTED.findall(body):
            idents.update(g for g in groups if g)
        idents.update(_IDENT.findall(body))


def refuse_excluded(reach: FieldReach, refs: Iterable[str], excluded_cols: set, excluded_measures: set) -> None:
    cols = {norm(c) for c in excluded_cols if norm(c)}
    fields = {norm(m) for m in excluded_measures if norm(m)}
    if not cols and not fields:
        return
    refs = sorted({str(r) for r in refs if r})
    hits = []
    for ref in refs:
        names, idents = reach.reach([ref])
        if ({norm(n) for n in names} & (cols | fields)) or ({norm(i) for i in idents} & cols):
            hits.append(ref)
    if hits:
        raise GovernedRefusal(
            "column_excluded",
            "Câu hỏi dùng dữ liệu nằm ngoài phạm vi AI được phép (Phạm vi dữ liệu AI trong Govern).",
            {"fields": hits},
        )
