"""Semantic health — the assumptions the semantic engine's numbers rest on,
checked on the data the engine actually reads.

Three layers, reported side by side and never merged into one score:

  * ``source_quality``  — the user-authored quality rules on the source
    (``dataset_quality_service``; included by reference, not recomputed — one
    system of record per layer);
  * ``semantic_health`` — what the MODEL assumes: every many-to-one / one-to-one
    relationship's one-side key is unique, every declared primary key is
    unique, and every definition names columns that exist. These checks are
    derived from the model itself — nobody has to author them — and run on the
    TRANSFORMED relation (type overrides + transformations applied, exactly what
    the engine FROMs), not on the raw source table;
  * ``snapshot_health`` — the published snapshot generation still matches the
    live relation (row parity per table).

Why the uniqueness checks are the ones that GATE publishing: a relationship
declared many-to-one whose one side has duplicate keys makes every JOIN through
it repeat rows, and every SUM over it grows — the chart renders, the number is
plausible, and it is wrong. Nothing else in the pipeline notices. A dangling
reference, by contrast, fails loudly at the warehouse, so it is reported but
does not block.

A check that cannot run (no datasource, the warehouse refused, cost guard) is
``unknown`` with the reason — never ``pass``.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

logger = logging.getLogger(__name__)

LAYER_SOURCE = "source_quality"
LAYER_SEMANTIC = "semantic_health"
LAYER_SNAPSHOT = "snapshot_health"


@dataclass
class HealthCheck:
    id: str
    layer: str
    kind: str
    subject: str
    status: str                      # pass | fail | unknown
    blocking: bool = False           # a failure here blocks Sync & Publish
    detail: str = ""
    evidence: Dict[str, Any] = field(default_factory=dict)


def _ds_type(ds) -> str:
    t = getattr(ds, "type", None)
    return t if isinstance(t, str) else getattr(t, "value", str(t or ""))


def _relation_for_table(db: Session, table: DatasetTable):
    """(datasource, dialect, relation_sql) for a table, or None when it has no
    source of its own (generated calendar, composition reference)."""
    from app.services.dataset_calendar_service import is_generated_calendar_table
    from app.services.dataset_relation_service import resolve_dataset_table_relation
    from app.services.live_query_service import _dialect_for_ds_type

    if is_generated_calendar_table(table) or not table.datasource_id:
        return None
    ds = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if ds is None:
        return None
    return ds, _dialect_for_ds_type(_ds_type(ds)), resolve_dataset_table_relation(ds, table).sql


def _scalar(ds, sql: str) -> int:
    from app.services.datasource_service import DataSourceConnectionService

    _cols, rows, _ms = DataSourceConnectionService.execute_query(_ds_type(ds), ds.config, sql, limit=None)
    if not rows:
        return 0
    row = rows[0]
    value = list(row.values())[0] if isinstance(row, dict) else row[0]
    return int(value or 0)


def _duplicate_key_sql(relation: str, columns: List[str], dialect: str) -> str:
    from app.services.live_query_service import _quote_identifier

    cols = [_quote_identifier(c, dialect) for c in columns]
    not_null = " AND ".join(f"{c} IS NOT NULL" for c in cols)
    return (
        f"SELECT COUNT(*) AS duplicate_keys FROM (SELECT {', '.join(cols)} "
        f"FROM ({relation}) AS _appbi_health WHERE {not_null} "
        f"GROUP BY {', '.join(cols)} HAVING COUNT(*) > 1) AS _appbi_dups"
    )


def _join_key_columns(join: dict) -> tuple[List[str], List[str]]:
    import re

    frm = [c for c in (join.get("from_columns") or []) if c] or ([join["from_column"]] if join.get("from_column") else [])
    to = [c for c in (join.get("to_columns") or []) if c] or ([join["to_column"]] if join.get("to_column") else [])
    if frm and to:
        return frm, to
    pairs = re.findall(r"\$\{TABLE\}\.(\w+)\s*=\s*\$\{\w+\}\.(\w+)", str(join.get("sql_on") or ""))
    return [p[0] for p in pairs], [p[1] for p in pairs]


def _views_by_name(db: Session, dataset_id: int) -> Dict[str, tuple]:
    tables = {t.id: t for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()}
    views = db.query(SemanticView).filter(SemanticView.dataset_table_id.in_(list(tables) or [-1])).all()
    return {v.name: (v, tables[v.dataset_table_id]) for v in views}


def uniqueness_checks(
    db: Session, dataset_id: int, *, execute: bool = True, include_primary_keys: bool = True,
) -> List[HealthCheck]:
    """One-side keys of active M:1 / 1:1 relationships (blocking), and declared
    primary keys of other views (reported, never blocking: a PK a relationship
    does not rely on changes no joined number)."""
    from app.services.semantic_join_resolver import canonical_cardinality

    views = _views_by_name(db, dataset_id)
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    wanted: Dict[tuple, str] = {}  # (view, cols) -> why

    for e in (db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all() if model else []):
        for j in e.joins or []:
            if not isinstance(j, dict) or j.get("is_active") is False:
                continue
            card = canonical_cardinality(j.get("cardinality") or j.get("relationship"))
            frm_cols, to_cols = _join_key_columns(j)
            src = str(j.get("from_view") or e.base_view_name or "")
            dst = str(j.get("view") or "")
            if card in ("many_to_one", "one_to_one") and to_cols:
                wanted.setdefault((dst, tuple(to_cols)), f"relationship {src} → {dst} ({card})")
            if card in ("one_to_many", "one_to_one") and frm_cols:
                wanted.setdefault((src, tuple(frm_cols)), f"relationship {src} → {dst} ({card})")
    relationship_keys = set(wanted)
    for name, (view, _t) in views.items() if include_primary_keys else []:
        pk = [c for c in (getattr(view, "primary_key", None) or []) if isinstance(c, str) and c]
        if pk:
            wanted.setdefault((name, tuple(pk)), f"primary key of {name}")

    out: List[HealthCheck] = []
    for (view_name, cols), why in sorted(wanted.items()):
        check = HealthCheck(
            id=f"unique:{view_name}:{','.join(cols)}", layer=LAYER_SEMANTIC, kind="key_unique",
            subject=f"{view_name}({', '.join(cols)})", status="unknown",
            blocking=(view_name, cols) in relationship_keys,
            evidence={"why": why},
        )
        pair = views.get(view_name)
        rel = _relation_for_table(db, pair[1]) if pair else None
        if rel is None:
            check.detail = "Không kiểm được: bảng không có nguồn riêng (calendar / bảng tham chiếu)."
            check.blocking = False
        elif not execute:
            check.detail = "Chưa chạy (execute=False)."
            check.blocking = False
        else:
            ds, dialect, relation = rel
            try:
                dups = _scalar(ds, _duplicate_key_sql(relation, list(cols), dialect))
                check.evidence["duplicate_keys"] = dups
                if dups:
                    check.status = "fail"
                    check.detail = (
                        f"{dups} giá trị khoá bị lặp trên {view_name}({', '.join(cols)}) — {why} giả định "
                        "khoá này là duy nhất; mọi JOIN qua quan hệ sẽ nhân dòng và SUM bị phóng đại. "
                        "Làm sạch dữ liệu, sửa cardinality, hoặc đổi khoá."
                    )
                else:
                    check.status = "pass"
            except Exception as exc:  # noqa: BLE001 — a check that cannot run is unknown, never pass
                check.blocking = False
                check.detail = f"Không kiểm được: {type(exc).__name__}: {str(exc)[:300]}"
        out.append(check)
    return out


def dangling_checks(db: Session, dataset_id: int) -> List[HealthCheck]:
    from app.services.dataset_model_service import dangling_model_references

    return [
        HealthCheck(
            id=f"dangling:{d['kind']}:{d['view']}:{d['name']}:{d['column']}", layer=LAYER_SEMANTIC,
            kind="dangling_reference", subject=f"{d['view']}.{d['name']}", status="fail", blocking=False,
            detail=f"{d['kind']} '{d['name']}' trên {d['view']} dùng cột '{d['column']}' không còn trong bảng.",
            evidence=d,
        )
        for d in dangling_model_references(db, dataset_id)
    ]


def snapshot_parity_checks(db: Session, dataset_id: int, *, execute: bool = True) -> List[HealthCheck]:
    """Published generation row counts vs the live relation, per table."""
    from app.models.dataset import DatasetTableSnapshot

    ds_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    generation = getattr(ds_obj, "published_generation", None)
    if generation is None:
        return []
    out: List[HealthCheck] = []
    snaps = (
        db.query(DatasetTableSnapshot)
        .filter(DatasetTableSnapshot.dataset_id == dataset_id,
                DatasetTableSnapshot.generation == int(generation),
                DatasetTableSnapshot.retired_at.is_(None))
        .all()
    )
    for snap in snaps:
        table = db.query(DatasetTable).filter(DatasetTable.id == snap.dataset_table_id).first()
        check = HealthCheck(
            id=f"snapshot_rows:{snap.dataset_table_id}", layer=LAYER_SNAPSHOT, kind="snapshot_row_parity",
            subject=str(getattr(table, "display_name", snap.dataset_table_id)), status="unknown",
            evidence={"generation": int(generation), "snapshot_rows": snap.row_count,
                      "built_at": snap.built_at.isoformat() if snap.built_at else None},
        )
        rel = _relation_for_table(db, table) if table is not None else None
        if rel is None or snap.row_count is None or not execute:
            check.detail = "Không so được (không có nguồn live hoặc snapshot không ghi số dòng)."
        else:
            ds, _dialect, relation = rel
            try:
                live = _scalar(ds, f"SELECT COUNT(*) AS n FROM ({relation}) AS _appbi_health")
                check.evidence["live_rows"] = live
                check.status = "pass" if live == snap.row_count else "fail"
                if live != snap.row_count:
                    check.detail = (
                        f"Snapshot (generation {generation}) có {snap.row_count} dòng, nguồn hiện có {live} — "
                        "dashboard đang đọc dữ liệu cũ hơn nguồn. Chạy lại Sync & Publish nếu cần số mới."
                    )
            except Exception as exc:  # noqa: BLE001
                check.detail = f"Không so được: {type(exc).__name__}: {str(exc)[:300]}"
        out.append(check)
    return out


def source_quality_layer(db: Session, dataset_id: int) -> Dict[str, Any]:
    """The existing quality system's own summary, by reference."""
    try:
        from app.services.dataset_quality_service import DatasetQualityService

        summary = DatasetQualityService.get_summary(db, dataset_id)
        data = summary.model_dump() if hasattr(summary, "model_dump") else dict(summary)
        return {"layer": LAYER_SOURCE, "system_of_record": "dataset_quality_service", "summary": data}
    except Exception as exc:  # noqa: BLE001
        return {"layer": LAYER_SOURCE, "system_of_record": "dataset_quality_service",
                "status": "unknown", "detail": f"{type(exc).__name__}: {str(exc)[:200]}"}


def _layer_status(checks: List[HealthCheck]) -> str:
    if any(c.status == "fail" for c in checks):
        return "fail"
    if any(c.status == "unknown" for c in checks) or not checks:
        return "unknown"
    return "pass"


def evaluate(db: Session, dataset_id: int, *, execute: bool = True) -> Dict[str, Any]:
    semantic = uniqueness_checks(db, dataset_id, execute=execute) + dangling_checks(db, dataset_id)
    snapshot = snapshot_parity_checks(db, dataset_id, execute=execute)
    return {
        "dataset_id": dataset_id,
        "layers": {
            LAYER_SOURCE: source_quality_layer(db, dataset_id),
            LAYER_SEMANTIC: {"status": _layer_status(semantic), "checks": [asdict(c) for c in semantic]},
            LAYER_SNAPSHOT: {"status": _layer_status(snapshot) if snapshot else "not_published",
                             "checks": [asdict(c) for c in snapshot]},
        },
        "blocking": [asdict(c) for c in semantic if c.blocking and c.status == "fail"],
    }


def publish_blockers(db: Session, dataset_id: int) -> List[str]:
    """Reasons Sync & Publish must refuse: semantic assumptions the data breaks."""
    # Only the keys relationships rely on — a declared PK on a large fact is not
    # scanned at publish time. Each check runs under the datasource's own guard
    # (BigQuery dry-run cost limit, statement timeout); one that cannot run is
    # `unknown` and does not block. The checks read the live relation the
    # generation was just built from, moments earlier.
    return [c.detail for c in uniqueness_checks(db, dataset_id, execute=True, include_primary_keys=False)
            if c.blocking and c.status == "fail"]
