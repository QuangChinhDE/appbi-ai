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


def _relation_for_generation(db: Session, table: DatasetTable, generation: int):
    """(host datasource, dialect, relation_sql, physical_ref) of the table's
    snapshot in ``generation`` — the artifact that generation SERVES — or None
    when the generation holds no snapshot of it (a calendar or composition
    reference: read elsewhere)."""
    from app.models.dataset import DatasetTableSnapshot
    from app.services.live_query_service import _dialect_for_ds_type

    row = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_table_id == table.id,
            DatasetTableSnapshot.generation == int(generation),
            DatasetTableSnapshot.status.in_(("ready", "superseded")),
            DatasetTableSnapshot.retired_at.is_(None),
        )
        .order_by(DatasetTableSnapshot.id.desc())
        .first()
    )
    if row is None or not row.physical_ref or not row.host_datasource_id:
        return None
    host = db.query(DataSource).filter(DataSource.id == row.host_datasource_id).first()
    if host is None:
        return None
    dialect = _dialect_for_ds_type(_ds_type(host))
    ref = str(row.physical_ref)
    quoted = f"`{ref}`" if dialect == "bigquery" else ".".join(f'"{p}"' for p in ref.split("."))
    return host, dialect, f"SELECT * FROM {quoted}", ref


def _snapshot_columns(columns: List[str], dialect: str) -> List[str]:
    """A snapshot stores a column under its BigQuery-safe name (the build's own
    per-name function): the check reads the name the table actually has."""
    if dialect != "bigquery":
        return list(columns)
    from app.services.datasource_service import bq_safe_field

    return [bq_safe_field(c) for c in columns]


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


def _join_key_columns(contract) -> tuple[List[str], List[str]]:
    """The FULL key of a relationship, from the same contract the resolver
    builds its edges from (every sql_on spelling; composite keys whole)."""
    return [f for f, _t in contract.key_pairs], [t for _f, t in contract.key_pairs]


def _views_by_name(db: Session, dataset_id: int) -> Dict[str, tuple]:
    tables = {t.id: t for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()}
    views = db.query(SemanticView).filter(SemanticView.dataset_table_id.in_(list(tables) or [-1])).all()
    return {v.name: (v, tables[v.dataset_table_id]) for v in views}


def uniqueness_checks(
    db: Session, dataset_id: int, *, execute: bool = True, include_primary_keys: bool = True,
    generation: Optional[int] = None, generation_label: str = "candidate_generation",
) -> List[HealthCheck]:
    """One-side keys of active M:1 / 1:1 relationships (blocking), and declared
    primary keys of other views (reported, never blocking: a PK a relationship
    does not rely on changes no joined number).

    WHAT is checked is part of the result (``evidence.checked``): without
    ``generation`` the LIVE source relation (``live_source``); with it, the
    table's snapshot IN THAT GENERATION on its host (``candidate_generation`` /
    ``published_generation``, ``evidence.generation``) — the exact artifact a
    dashboard reads once that generation is visible. A table that generation
    holds no snapshot of is ``unknown`` (relation None, non-blocking) — its
    live relation is not the generation's artifact; the runtime key probe
    re-checks a live relation on every query."""
    from app.services.semantic_join_resolver import read_join_contract

    views = _views_by_name(db, dataset_id)
    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    wanted: Dict[tuple, str] = {}  # (view, cols) -> why

    for e in (db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all() if model else []):
        for j in e.joins or []:
            contract = read_join_contract(e.base_view_name, j)
            if not contract.valid or not contract.is_active:
                continue  # invalid rows are reported by invalid_relationship_checks
            card = contract.cardinality
            frm_cols, to_cols = _join_key_columns(contract)
            src = contract.from_view
            dst = contract.view
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
        check_cols = list(cols)
        rel = None
        if generation is not None and pair:
            rel_g = _relation_for_generation(db, pair[1], generation)
            if rel_g is not None:
                host, dialect_g, relation_g, ref = rel_g
                rel = (host, dialect_g, relation_g)
                check_cols = _snapshot_columns(list(cols), dialect_g)
                check.evidence.update(checked=generation_label, generation=int(generation), relation=ref)
        if rel is None and generation is not None:
            # The generation does not hold this table (a calendar, a composition
            # reference): the live relation is NOT the artifact served — never
            # report its result as the generation's.
            check.evidence.update(checked=generation_label, generation=int(generation), relation=None)
            check.detail = "Không kiểm được trên generation này: generation không chứa snapshot của bảng."
            check.blocking = False
            out.append(check)
            continue
        if rel is None:
            rel = _relation_for_table(db, pair[1]) if pair else None
            check.evidence["checked"] = "live_source"
        if rel is None:
            check.detail = "Không kiểm được: bảng không có nguồn riêng (calendar / bảng tham chiếu)."
            check.blocking = False
        elif not execute:
            check.detail = "Chưa chạy (execute=False)."
            check.blocking = False
        else:
            ds, dialect, relation = rel
            try:
                dups = _scalar(ds, _duplicate_key_sql(relation, check_cols, dialect))
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


def invalid_relationship_checks(db: Session, dataset_id: int) -> List[HealthCheck]:
    """Persisted relationships whose contract is invalid — judged exactly as
    the runtime judges them. Active or unknown-activation: BLOCKING (the engine
    refuses every query on the model, so it must not publish). Definitively
    inactive: a WARNING (dormant — outside every graph, cannot change a number;
    no writer can activate it until it is repaired)."""
    from app.services.semantic_join_resolver import read_join_contract

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    out: List[HealthCheck] = []
    for e in (db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all() if model else []):
        for i, j in enumerate(e.joins or []):
            c = read_join_contract(e.base_view_name, j)
            if c.valid:
                continue
            name = str(j.get("name") or c.node or i) if isinstance(j, dict) else str(i)
            if c.dormant:
                out.append(HealthCheck(
                    id=f"invalid_relationship:{e.base_view_name}:{name}", layer=LAYER_SEMANTIC,
                    kind="invalid_relationship_inactive", subject=f"{e.base_view_name} → {name}",
                    status="warn", blocking=False,
                    detail="Quan hệ đang TẮT và không hợp lệ (không được dùng khi truy vấn) — sửa hoặc xoá "
                           "trước khi bật lại: " + "; ".join(c.invalid),
                    evidence={"reasons": list(c.invalid), "active": False},
                ))
                continue
            out.append(HealthCheck(
                id=f"invalid_relationship:{e.base_view_name}:{name}", layer=LAYER_SEMANTIC,
                kind="invalid_relationship", subject=f"{e.base_view_name} → {name}", status="fail",
                blocking=True, detail="Quan hệ không hợp lệ: " + "; ".join(c.invalid),
                evidence={"reasons": list(c.invalid), "active": c.is_active if c.activation_known else None},
            ))
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
    semantic = (
        invalid_relationship_checks(db, dataset_id)
        + uniqueness_checks(db, dataset_id, execute=execute)
        + dangling_checks(db, dataset_id)
    )
    snapshot = snapshot_parity_checks(db, dataset_id, execute=execute)
    # The relationship keys on the PUBLISHED generation itself (what dashboards
    # read), next to the live-source checks above — each labelled with what it
    # checked. Informational here: the publish gate checked the candidate.
    ds_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    published = getattr(ds_obj, "published_generation", None)
    if published is not None:
        for c in uniqueness_checks(db, dataset_id, execute=execute, include_primary_keys=False,
                                   generation=published, generation_label="published_generation"):
            if c.evidence.get("relation") is None:
                continue  # not a table this generation holds — the live check above covers it
            c.layer = LAYER_SNAPSHOT
            c.id = "published:" + c.id
            c.blocking = False
            snapshot.append(c)
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


def publish_blockers(db: Session, dataset_id: int, *, generation: Optional[int] = None) -> List[str]:
    """Reasons Sync & Publish must refuse: semantic assumptions the data breaks.

    With ``generation`` the keys are checked on THAT generation's snapshot
    tables — the artifact that becomes visible — not on the live source (which
    may have changed since the build, or been repaired after a duplicated build
    that a resumed sync would reuse). Only the keys relationships rely on; one
    that cannot run is ``unknown`` and does not block (the runtime key guard
    still refuses an unverifiable trusted join at query time)."""
    checks = invalid_relationship_checks(db, dataset_id) + uniqueness_checks(
        db, dataset_id, execute=True, include_primary_keys=False, generation=generation,
    )
    return [c.detail for c in checks if c.blocking and c.status == "fail"]
