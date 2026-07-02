"""
Near-realtime snapshot materialization (Dashboard perf #5).

Heavy `sql_query` dataset tables (multi-CTE pipelines re-scanned per chart) are
materialized into flat snapshot tables in a dedicated BigQuery dataset
(default `appbi_snapshots`). Charts then read the flat snapshot instead of
re-running the pipeline, so a 38-chart dashboard scans flat tables (<1s each)
instead of colliding on the warehouse (60s timeout).

Opt-in per datasource. When disabled / not BigQuery / write-denied, callers fall
back to the live path unchanged. Snapshot = per table (the semantic model is
kept intact; the engine still joins flat tables). Calendar / derived / physical
tables are NOT materialized (calendar+derived are computed/aliased; physical is
already a flat scan).

Freshness + consistency: each build inserts a `building` registry row, runs a
`CREATE OR REPLACE TABLE` CTAS, then in ONE Postgres txn flips the `is_current`
pointer (old→superseded, new→ready). A failed build leaves the previous current
untouched. A `fingerprint` over the resolved SQL + column schema forces a
rebuild when the model changes. Concurrent charts collapse to one build per
table via the existing in-process `single_flight`.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable, DatasetTableSnapshot
from app.models.models import DataSource
from app.services import query_cache as _qc
from app.services.datasource_service import DataSourceConnectionService

logger = logging.getLogger(__name__)

DEFAULT_SNAPSHOT_DATASET = "appbi_snapshots"
_DDL_TIMEOUT_SEC = 280  # build budget per table (< the 300s BQ result cap)
# BQ location per datasource (snapshots must be COLOCATED with the source —
# BQ cannot CTAS across locations). Resolved once per datasource.
_location_cache: Dict[int, Optional[str]] = {}


def _source_location(datasource: DataSource) -> Optional[str]:
    if datasource.id not in _location_cache:
        try:
            _location_cache[datasource.id] = DataSourceConnectionService.get_bigquery_location(
                datasource.config
            )
        except Exception:  # noqa: BLE001
            _location_cache[datasource.id] = None
    return _location_cache[datasource.id]


# ── datasource helpers ──────────────────────────────────────────────────────
def _ds_type(datasource: DataSource) -> str:
    t = datasource.type
    return (t if isinstance(t, str) else t.value).lower()


def settings_for(datasource: DataSource) -> dict:
    """Materialization settings for a datasource. Dataset name + default TTL fall
    back to the .env-configured global (`MATERIALIZATION_DATASET` /
    `MATERIALIZATION_DEFAULT_TTL_MINUTES`), then to the hardcoded default —
    per-datasource config always wins."""
    from app.core.config import settings
    cfg = datasource.config or {}
    global_ds = (str(getattr(settings, "MATERIALIZATION_DATASET", "") or "").strip()
                 or DEFAULT_SNAPSHOT_DATASET)
    ttl = cfg.get("materialization_default_ttl_minutes")
    if ttl is None:
        ttl = getattr(settings, "MATERIALIZATION_DEFAULT_TTL_MINUTES", None)
    return {
        "enabled": bool(cfg.get("materialization_enabled")),
        "dataset": (str(cfg.get("materialization_dataset") or "").strip() or global_ds),
        "default_ttl": ttl,
    }


def is_enabled(datasource: Optional[DataSource]) -> bool:
    """True only for a BigQuery datasource that has opted in."""
    if datasource is None or _ds_type(datasource) != "bigquery":
        return False
    return settings_for(datasource)["enabled"]


def should_materialize(table: DatasetTable) -> bool:
    """MVP scope: only heavy custom-SQL tables. Physical tables are already flat;
    calendar is generated live; derived tables reference other tables by alias."""
    return getattr(table, "source_kind", None) == "sql_query" and bool(table.source_query)


# ── fingerprint + naming ────────────────────────────────────────────────────
def _resolved_sql(dataset_obj: Dataset, table: DatasetTable, datasource: DataSource, db: Session) -> str:
    """The exact per-view SQL the engine would use (`_sql_table_for_table`), so the
    snapshot is a 1:1 drop-in for `SELECT * FROM snapshot`."""
    from app.services.dataset_model_service import _sql_table_for_table
    return _sql_table_for_table(
        dataset_obj, table, calendar_dialect="bigquery", datasource=datasource, db=db
    )


def _fingerprint(resolved_sql: str, table: DatasetTable) -> str:
    cols = []
    cc = getattr(table, "columns_cache", None)
    if isinstance(cc, dict):
        for c in (cc.get("columns") or []):
            name = str(c.get("name") or "").strip()
            typ = str(c.get("source_type") or c.get("type") or "").strip().lower()
            if name:
                cols.append(f"{name}:{typ}")
    payload = "bigquery" + resolved_sql + "" + "|".join(sorted(cols))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()




# ── build (single-flight) ───────────────────────────────────────────────────
def build_table_snapshot(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable,
    datasource: DataSource,
    *,
    force: bool = False,
) -> Optional[DatasetTableSnapshot]:
    """Ensure a fresh snapshot for one table. Idempotent + single-flight: the
    first caller builds; concurrent callers block then reuse the ready row.
    Returns the current-ready row, or None on failure (caller falls back to live)."""
    if not should_materialize(table):
        return None
    try:
        resolved_sql = _resolved_sql(dataset_obj, table, datasource, db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[snapshot] resolve SQL failed for table %s: %s", table.id, exc)
        return None
    fp = _fingerprint(resolved_sql, table)
    cfg = settings_for(datasource)
    snap_dataset = cfg["dataset"]
    project = str((datasource.config or {}).get("project_id") or "").strip()

    def _do() -> Optional[DatasetTableSnapshot]:
        # Re-check inside the lock: a concurrent build may have just finished.
        current = (
            db.query(DatasetTableSnapshot)
            .filter(
                DatasetTableSnapshot.dataset_table_id == table.id,
                DatasetTableSnapshot.is_current.is_(True),
                DatasetTableSnapshot.status == "ready",
            )
            .first()
        )
        if current and current.fingerprint == fp and not force:
            return current

        version = int(time.time() * 1000)
        table_name = f"snap_t{table.id}_v{version}"
        ref = f"{project}.{snap_dataset}.{table_name}"
        row = DatasetTableSnapshot(
            dataset_id=dataset_obj.id,
            dataset_table_id=table.id,
            version=version,
            physical_ref=ref,
            fingerprint=fp,
            status="building",
            is_current=False,
        )
        db.add(row)
        db.commit()

        t0 = time.time()
        try:
            # EXTRACT with the datasource's own read credential, LOAD with the
            # write service account — the write SA never reads the source, and
            # the snapshot dataset is SA-only (per the chosen access model).
            location = _source_location(datasource)
            DataSourceConnectionService.ensure_bigquery_dataset(datasource.config, snap_dataset, location=location)
            bq_schema, rows = DataSourceConnectionService.extract_bigquery_for_snapshot(
                datasource.config, resolved_sql, timeout_seconds=_DDL_TIMEOUT_SEC
            )
            row.row_count = DataSourceConnectionService.load_bigquery_snapshot(
                datasource.config, snap_dataset, table_name, bq_schema, rows,
                timeout_seconds=_DDL_TIMEOUT_SEC,
            )
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            row = db.query(DatasetTableSnapshot).get(row.id)
            if row is not None:
                row.status = "failed"
                row.error = str(exc)[:2000]
                db.commit()
            logger.warning("[snapshot] build failed table=%s ref=%s: %s", table.id, ref, exc)
            return None

        # Atomic pointer swap: supersede the old current, promote the new one.
        prior = (
            db.query(DatasetTableSnapshot)
            .filter(
                DatasetTableSnapshot.dataset_table_id == table.id,
                DatasetTableSnapshot.is_current.is_(True),
            )
            .all()
        )
        for p in prior:
            p.is_current = False
            p.status = "superseded"
        row.status = "ready"
        row.is_current = True
        row.built_at = datetime.utcnow()
        row.build_ms = int((time.time() - t0) * 1000)
        db.commit()

        # Best-effort GC of the just-superseded physical tables.
        for p in prior:
            try:
                DataSourceConnectionService.drop_bigquery_table(datasource.config, p.physical_ref)
            except Exception:  # noqa: BLE001
                pass
        logger.info(
            "[snapshot] built table=%s ref=%s rows=%s in %sms",
            table.id, ref, row.row_count, row.build_ms,
        )
        return row

    return _qc.single_flight(f"snapbuild::{table.id}::{fp}", _do)


def resolve_current_ref(db: Session, table_id: int, *, ttl_minutes: Optional[int] = None) -> Optional[str]:
    """Physical ref of the current ready snapshot, or None if missing/stale-per-TTL."""
    row = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_table_id == table_id,
            DatasetTableSnapshot.is_current.is_(True),
            DatasetTableSnapshot.status == "ready",
        )
        .first()
    )
    if row is None:
        return None
    if ttl_minutes and row.built_at is not None:
        age_min = (datetime.utcnow() - row.built_at).total_seconds() / 60.0
        if age_min > ttl_minutes:
            return None
    return row.physical_ref


def refresh_all_for_dataset(db: Session, dataset_id: int, *, force: bool = True) -> dict:
    """Rebuild the materializable snapshots for one dataset (the Refresh action).
    Returns {built:[{table_id,row_count,build_ms}], skipped:[table_id], as_of}."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset_obj is None:
        return {"built": [], "skipped": [], "as_of": None}
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
    ds_ids = {t.datasource_id for t in tables if t.datasource_id}
    datasource_by_id = {
        d.id: d for d in db.query(DataSource).filter(DataSource.id.in_(list(ds_ids))).all()
    }
    built, skipped = [], []
    for t in tables:
        ds = datasource_by_id.get(t.datasource_id)
        if not (should_materialize(t) and is_enabled(ds)):
            skipped.append(t.id)
            continue
        row = build_table_snapshot(db, dataset_obj, t, ds, force=force)
        if row is not None:
            built.append({"table_id": t.id, "row_count": row.row_count, "build_ms": row.build_ms})
        else:
            skipped.append(t.id)
    built_ids = [b["table_id"] for b in built]
    ts = as_of(db, built_ids) if built_ids else None
    return {"built": built, "skipped": skipped, "as_of": ts.isoformat() if ts else None}


def as_of(db: Session, table_ids: List[int]) -> Optional[datetime]:
    """Oldest built_at across the current ready snapshots of the given tables.
    Oldest wins so the "as of" label never over-claims freshness."""
    rows = (
        db.query(DatasetTableSnapshot.built_at)
        .filter(
            DatasetTableSnapshot.dataset_table_id.in_(table_ids or [-1]),
            DatasetTableSnapshot.is_current.is_(True),
            DatasetTableSnapshot.status == "ready",
        )
        .all()
    )
    times = [r[0] for r in rows if r[0] is not None]
    if not times:
        return None
    # `built_at` is stored as naive UTC (datetime.utcnow at build time). Stamp it
    # UTC-aware so callers' `.isoformat()` emits an offset (…+00:00) — otherwise
    # the tz-less string is parsed by the browser as LOCAL time, showing the
    # "as of" label ~7h off in UTC+7. The frontend's toLocaleString then renders
    # it in the viewer's own timezone.
    oldest = min(times)
    if oldest.tzinfo is None:
        oldest = oldest.replace(tzinfo=timezone.utc)
    return oldest


def is_stale(as_of_ts: Optional[datetime], ttl_minutes: Optional[int]) -> bool:
    """True when a snapshot built at `as_of_ts` is older than `ttl_minutes`.
    ttl None / <= 0 → never stale (no age-out; freshness is manual/realtime is
    handled upstream). Used by the public path to decide a lazy async rebuild."""
    if not ttl_minutes or ttl_minutes <= 0 or as_of_ts is None:
        return False
    now = datetime.now(timezone.utc)
    ref = as_of_ts if as_of_ts.tzinfo else as_of_ts.replace(tzinfo=timezone.utc)
    return (now - ref).total_seconds() / 60.0 > ttl_minutes


# ── lazy async rebuild (public per-link TTL, Stage 2) ────────────────────────
# When a public viewer opens a link whose snapshot has aged past its TTL, we
# serve the STALE snapshot instantly and rebuild in the BACKGROUND (stale-then-
# async) so no viewer ever waits ~1-2 min for an extract-load. A per-dataset
# in-process guard collapses the ~38 concurrent tile triggers of one open into a
# single rebuild; the table-level single_flight in build_table_snapshot dedupes
# further. Once the rebuild finishes, built_at is fresh → not stale → no more
# triggers until the next TTL expiry (no polling / scheduler).
_async_refresh_inflight: Dict[int, float] = {}
_async_refresh_lock = threading.Lock()


def trigger_async_refresh(dataset_id: int) -> None:
    """Fire-and-forget rebuild of one dataset's snapshots. Idempotent: a dataset
    already rebuilding is skipped. NEVER raises (background best-effort)."""
    if not dataset_id:
        return
    with _async_refresh_lock:
        if dataset_id in _async_refresh_inflight:
            return
        _async_refresh_inflight[dataset_id] = time.time()

    def _run() -> None:
        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            refresh_all_for_dataset(db, dataset_id, force=True)
            logger.info("[snapshot] async TTL rebuild done dataset=%s", dataset_id)
        except Exception:  # noqa: BLE001 — background must never crash a request
            logger.warning("[snapshot] async TTL rebuild failed dataset=%s", dataset_id, exc_info=True)
        finally:
            db.close()
            with _async_refresh_lock:
                _async_refresh_inflight.pop(dataset_id, None)

    threading.Thread(target=_run, name=f"snap-refresh-{dataset_id}", daemon=True).start()
