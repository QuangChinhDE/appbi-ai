"""Permission-aware discovery for the Analyst (M2): what this person may ask about.

Built from the semantic model that already exists (explores, views, their
dimensions and measures, labels and descriptions). No second metadata store.

An explore is listed only when:
  * its Dataset is `reporting` (operational data is refused by GQS anyway);
  * the person holds `explore` on it, and on every composition parent;
  * its source is one GQS can bound (Postgres, MySQL, BigQuery).
Fields GovernAIScope hides from AI surfaces are not listed. Listing is a hint
for the planner, not the enforcement: GQS re-checks every ref at execution.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from app.services.governed_query.ai_scope import norm

BOUNDED = frozenset({"postgresql", "mysql", "bigquery"})
_TIME_TYPES = frozenset({"date", "time", "datetime", "timestamp"})


@dataclass
class CatalogField:
    ref: str              # view.field — what GQS takes
    kind: str             # dimension | measure
    type: str
    label: str
    description: str = ""


@dataclass
class CatalogExplore:
    explore_id: int
    model_id: Optional[int]
    dataset_id: int
    dataset_name: str
    dataset_table_id: Optional[int]
    base_view: str
    source_type: str
    label: str
    fields: list[CatalogField] = field(default_factory=list)

    def as_prompt(self) -> dict:
        return {
            "explore_id": self.explore_id, "dataset": self.dataset_name, "label": self.label,
            "dimensions": [{"ref": f.ref, "type": f.type, "label": f.label, **({"description": f.description} if f.description else {})}
                           for f in self.fields if f.kind == "dimension"],
            "measures": [{"ref": f.ref, "type": f.type, "label": f.label, **({"description": f.description} if f.description else {})}
                         for f in self.fields if f.kind == "measure"],
        }


def _label(defn: dict) -> str:
    return str(defn.get("label") or defn.get("name") or "").replace("_", " ").strip()


def discover(authz: Any, *, limit: int = 40) -> list[CatalogExplore]:
    from app.core.authz.decision import Action
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    db = authz.db
    out: list[CatalogExplore] = []
    rows = (db.query(SemanticExplore, SemanticModel, Dataset)
            .join(SemanticModel, SemanticModel.id == SemanticExplore.model_id)
            .join(Dataset, Dataset.id == SemanticModel.dataset_id)
            .order_by(SemanticExplore.id.desc()).all())
    decided: dict[int, bool] = {}

    def may(ds) -> bool:
        if ds.id not in decided:
            decided[ds.id] = bool(authz.decide(Action.EXPLORE, ds).allowed)
        return decided[ds.id]

    for explore, model, dataset in rows:
        if len(out) >= limit:
            break
        if str(getattr(dataset, "purpose", None) or "reporting").strip().lower() != "reporting":
            continue
        if not may(dataset):
            continue
        parents = _ancestors(db, dataset.id)
        if any((p := db.get(Dataset, pid)) is None or not may(p) for pid in parents):
            continue
        base = db.get(SemanticView, explore.base_view_id) if explore.base_view_id else None
        if base is None:
            continue
        table = db.get(DatasetTable, base.dataset_table_id) if base.dataset_table_id else None
        source = db.get(DataSource, table.datasource_id) if table is not None else None
        stype = getattr(getattr(source, "type", None), "value", getattr(source, "type", None))
        if stype not in BOUNDED:
            continue
        ex_cols, ex_measures = authz.ai_scope_exclusions([dataset.id, *parents])
        views = [base] + [v for v in _joined_views(db, explore, [dataset.id, *parents]) if v.id != base.id]
        fields: list[CatalogField] = []
        for v in views:
            for d in v.dimensions or []:
                if isinstance(d, dict) and d.get("name") and norm(d["name"]) not in ex_cols:
                    fields.append(CatalogField(f"{v.name}.{d['name']}", "dimension", str(d.get("type") or "string"),
                                               _label(d), str(d.get("description") or "")[:200]))
            for m in v.measures or []:
                if isinstance(m, dict) and m.get("name") and norm(m["name"]) not in ex_measures:
                    fields.append(CatalogField(f"{v.name}.{m['name']}", "measure", str(m.get("type") or "sum"),
                                               _label(m), str(m.get("description") or "")[:200]))
        if not any(f.kind == "measure" for f in fields):
            continue
        out.append(CatalogExplore(
            explore_id=explore.id, model_id=explore.model_id, dataset_id=dataset.id,
            dataset_name=str(dataset.name), dataset_table_id=base.dataset_table_id, base_view=base.name,
            source_type=str(stype), label=str(getattr(explore, "label", None) or dataset.name), fields=fields))
    return out


def is_time(f: CatalogField) -> bool:
    return f.kind == "dimension" and f.type.lower() in _TIME_TYPES


def _ancestors(db, dataset_id: int) -> list[int]:
    """The same transitive walk GQS applies (composition parents)."""
    from app.services import dataset_composition_service as comp

    seen: set[int] = set()
    stack = list(comp._direct_parents(db, dataset_id))
    while stack:
        pid = stack.pop()
        if pid in seen or pid == dataset_id:
            continue
        seen.add(pid)
        stack.extend(comp._direct_parents(db, pid))
    return sorted(seen)


def _joined_views(db, explore, dataset_ids: list[int]) -> list:
    """Views the explore joins, resolved inside its own Dataset lineage only (a
    view name is not unique across models)."""
    from app.models.dataset import DatasetTable
    from app.models.semantic import SemanticView

    names = [str(j.get("view") or j.get("name") or "") for j in (explore.joins or []) if isinstance(j, dict)]
    names = [n for n in names if n]
    if not names:
        return []
    return (db.query(SemanticView).join(DatasetTable, DatasetTable.id == SemanticView.dataset_table_id)
            .filter(SemanticView.name.in_(names), DatasetTable.dataset_id.in_(dataset_ids)).all())
