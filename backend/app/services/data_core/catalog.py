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
    #: Business words people use for this field (semantic definition key
    #: `synonyms`), e.g. "nhóm sản phẩm" for a category column.
    synonyms: tuple[str, ...] = ()

    def as_prompt(self) -> dict:
        out = {"ref": self.ref, "type": self.type, "label": self.label}
        if self.kind == "dimension" and is_identifier(self):
            out["identifier"] = True
        if self.synonyms:
            out["synonyms"] = list(self.synonyms)
        if self.description:
            out["description"] = self.description
        return out


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
            "dimensions": [f.as_prompt() for f in self.fields if f.kind == "dimension"],
            "measures": [f.as_prompt() for f in self.fields if f.kind == "measure"],
        }


def _synonyms(defn: dict) -> tuple[str, ...]:
    raw = defn.get("synonyms")
    if not isinstance(raw, list):
        return ()
    return tuple(str(x).strip()[:60] for x in raw if isinstance(x, str) and str(x).strip())[:8]


def governed_aliases(db, dataset_ids: list[int]) -> dict[str, tuple[str, ...]]:
    """Business names of measures, from APPROVED governed metrics bound to these
    Datasets: {measure_ref or bare measure name: (display name, synonyms...)}.

    Semantic views carry no synonyms of their own (DimensionDefinition /
    MeasureDefinition do not declare the key, so a PUT drops it and no editor
    writes it). The words people use for a metric are governed in the Registry
    (`govern_metrics.synonyms`, `display_name`) and bound to a measure
    (`govern_metric_bindings`, the scalar columns as the documented fallback). A
    Draft or Deprecated metric is not official and adds nothing."""
    from app.models.governance import GovernMetric, GovernMetricBinding

    out: dict[str, list[str]] = {}

    def add(ref, metric):
        if not ref:
            return
        words = [metric.display_name, *(metric.synonyms or [])]
        for key in {str(ref), str(ref).rsplit(".", 1)[-1]}:
            bucket = out.setdefault(key, [])
            bucket.extend(str(w).strip()[:60] for w in words if isinstance(w, str) and str(w).strip())

    if not dataset_ids:
        return {}
    approved = GovernMetric.status == "Approved"
    for b, m in (db.query(GovernMetricBinding, GovernMetric)
                 .join(GovernMetric, GovernMetric.id == GovernMetricBinding.metric_id)
                 .filter(approved, GovernMetricBinding.dataset_id.in_(dataset_ids)).all()):
        add(b.measure_ref, m)
    for m in db.query(GovernMetric).filter(approved, GovernMetric.dataset_id.in_(dataset_ids)).all():
        add(m.measure_ref, m)
    return {k: tuple(dict.fromkeys(v))[:8] for k, v in out.items()}


def glossary_words(db, fqns: set[str]) -> dict[str, tuple[str, ...]]:
    """{term fqn: (display name, synonyms...)} for APPROVED glossary terms. A Draft
    or Deprecated term is not official vocabulary and adds nothing."""
    from app.models.governance import Glossary, GlossaryTerm

    if not fqns:
        return {}
    out: dict[str, tuple[str, ...]] = {}
    for term, gname in (db.query(GlossaryTerm, Glossary.name).join(Glossary, Glossary.id == GlossaryTerm.glossary_id)
                        .filter(GlossaryTerm.status == "Approved").all()):
        fqn = f"{gname}.{term.name}"
        if fqn in fqns:
            words = [term.display_name, *(term.synonyms or [])]
            out[fqn] = tuple(str(w).strip()[:60] for w in words if isinstance(w, str) and str(w).strip())
    return out


def _term_refs(defn: dict) -> list[str]:
    return [str(r.get("fqn")) for r in defn.get("glossary_terms") or [] if isinstance(r, dict) and r.get("fqn")]


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
        aliases = governed_aliases(db, [dataset.id, *parents])
        views = [base] + [v for v in _joined_views(db, explore, [dataset.id, *parents]) if v.id != base.id]
        terms = glossary_words(db, {t for v in views for defn in [*(v.dimensions or []), *(v.measures or [])]
                                    if isinstance(defn, dict) for t in _term_refs(defn)})

        def vocab(defn, extra=()):
            words = [*_synonyms(defn), *extra]
            for t in _term_refs(defn):
                words.extend(terms.get(t, ()))
            return tuple(dict.fromkeys(words))[:12]

        fields: list[CatalogField] = []
        for v in views:
            for d in v.dimensions or []:
                if isinstance(d, dict) and d.get("name") and norm(d["name"]) not in ex_cols:
                    fields.append(CatalogField(f"{v.name}.{d['name']}", "dimension", str(d.get("type") or "string"),
                                               _label(d), str(d.get("description") or "")[:200], vocab(d)))
            for m in v.measures or []:
                if isinstance(m, dict) and m.get("name") and norm(m["name"]) not in ex_measures:
                    gov = aliases.get(f"{v.name}.{m['name']}") or aliases.get(str(m["name"])) or ()
                    fields.append(CatalogField(f"{v.name}.{m['name']}", "measure", str(m.get("type") or "sum"),
                                               _label(m), str(m.get("description") or "")[:200], vocab(m, gov)))
        if not any(f.kind == "measure" for f in fields):
            continue
        out.append(CatalogExplore(
            explore_id=explore.id, model_id=explore.model_id, dataset_id=dataset.id,
            dataset_name=str(dataset.name), dataset_table_id=base.dataset_table_id, base_view=base.name,
            source_type=str(stype), label=str(getattr(explore, "label", None) or dataset.name), fields=fields))
    return out


def datasets_named(catalog: list[CatalogExplore], question: str) -> set[int]:
    """Datasets the question names WORD FOR WORD: one of their metrics (label or
    governed synonym, as a whole phrase) or the Dataset itself. Set 9 root cause:
    for "doanh số" the model kept planning on another Dataset's English "Revenue"
    and mixing fields of two Datasets; the person had named Rig Commerce's metric."""
    import re as _re

    from app.services.data_core.grounding import fold

    q = " " + " ".join(w for w in _re.split(r"[^0-9a-z]+", fold(question)) if w) + " "

    def phrase(t: str) -> str:
        return " ".join(w for w in _re.split(r"[^0-9a-z]+", fold(t)) if w)

    out: set[int] = set()
    for e in catalog:
        texts = [e.dataset_name] + [t for f in e.fields if f.kind == "measure" for t in (f.label, *f.synonyms)]
        if any(p and f" {p} " in q for p in map(phrase, texts)):
            out.add(e.dataset_id)
    return out


def is_identifier(f: CatalogField) -> bool:
    """A key column (one value per row/entity): grouping by it lists items, it
    does not summarise them."""
    name = f.ref.rsplit(".", 1)[-1].lower()
    return f.kind == "dimension" and (name == "id" or name.endswith("_id"))


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
    """Every view the explore's base can reach through the model's relationships
    (multi-hop, the same graph the query engine and the chart builder walk), resolved
    inside its own Dataset lineage only (a view name is not unique across models).

    Holdout run: listing only the explore's DIRECT joins hid `customers.region`
    from an order-lines explore (order_lines -> orders -> customers), so "sales by
    region" was answered "not in the data" although the engine can answer it."""
    from app.models.dataset import DatasetTable
    from app.models.semantic import SemanticView
    from app.services.semantic_join_resolver import SemanticJoinResolver

    base = db.get(SemanticView, explore.base_view_id) if explore.base_view_id else None
    if base is None or explore.model is None:
        return []
    resolver = SemanticJoinResolver(db, explore.model, base.name, bidirectional=True)
    # Role-played aliases are left out: a catalog ref is `<view>.<field>`.
    names = [n for n in resolver.reachable_nodes() if resolver.view_for_node(n) == n and n != base.name]
    if not names:
        return []
    return (db.query(SemanticView).join(DatasetTable, DatasetTable.id == SemanticView.dataset_table_id)
            .filter(SemanticView.name.in_(names), DatasetTable.dataset_id.in_(dataset_ids)).all())
