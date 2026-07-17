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
    """MVP scope (all-BQ perf path): only heavy custom-SQL tables. Physical tables
    are already flat; calendar is generated live; derived tables reference other
    tables by alias. UNCHANGED — the all-BigQuery materialization path keys off
    this exactly as before; federation uses `is_federated_materializable` below."""
    return getattr(table, "source_kind", None) == "sql_query" and bool(table.source_query)


def is_federated_materializable(table: DatasetTable) -> bool:
    """Federation scope: a table whose rows we can copy into the host BigQuery
    snapshot dataset so the WHOLE dataset runs as one BigQuery query. Covers heavy
    custom-SQL (sql_query) AND physical tables (e.g. Google Sheets / manual /
    other-warehouse dims). Excludes generated calendar (rendered inline in BQ) and
    derived tables (aliased over other tables — not independently extractable)."""
    kind = getattr(table, "source_kind", None)
    if kind == "sql_query":
        return bool(table.source_query)
    return kind == "physical_table"


def resolve_host(db: Session, dataset_id: int) -> Optional[DataSource]:
    """The BigQuery datasource that HOSTS this dataset's snapshots. For a
    single-source BQ dataset this is just that datasource; for a MIXED dataset
    (BQ facts + a Google Sheets dim, etc.) it is the BQ datasource all other
    tables materialize INTO, so the chart runs entirely in BigQuery. Returns the
    materialization-enabled BQ datasource among the dataset's tables (lowest id if
    several), or None when there is no enabled BQ host."""
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
    ds_ids = sorted({t.datasource_id for t in tables if t.datasource_id})
    if not ds_ids:
        return None
    rows = db.query(DataSource).filter(DataSource.id.in_(ds_ids)).all()
    hosts = sorted(
        (d for d in rows if _ds_type(d) == "bigquery" and settings_for(d)["enabled"]),
        key=lambda d: d.id,
    )
    return hosts[0] if hosts else None


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
def _source_select_sql(source_ds: DataSource, table: DatasetTable) -> str:
    """A plain SELECT returning the table's rows on its OWN (non-BigQuery) engine,
    for the federated extract step. sql_query → wrap the source query; physical →
    SELECT * from the source table (dialect-quoted)."""
    from app.services.live_query_service import _dialect_for_ds_type
    kind = getattr(table, "source_kind", None)
    if kind == "sql_query" and table.source_query:
        return f"SELECT * FROM (\n{table.source_query}\n) AS _appbi_src"
    name = str(getattr(table, "source_table_name", "") or "").strip()
    dia = _dialect_for_ds_type(_ds_type(source_ds))
    q = ("`" + name.replace("`", "") + "`") if dia == "mysql" else ('"' + name.replace('"', "") + '"')
    return f"SELECT * FROM {q}"


def build_table_snapshot(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable,
    datasource: DataSource,
    *,
    force: bool = False,
    host_datasource: Optional[DataSource] = None,
) -> Optional[DatasetTableSnapshot]:
    """Ensure a fresh snapshot for one table. Idempotent + single-flight: the
    first caller builds; concurrent callers block then reuse the ready row.
    Returns the current-ready row, or None on failure (caller falls back to live).

    ``datasource`` is the table's SOURCE (used to EXTRACT). ``host_datasource`` is
    the BigQuery datasource whose snapshot dataset the rows LOAD into; it defaults
    to ``datasource`` (the all-BigQuery path — byte-identical to before). When they
    differ (a Google Sheets / other-warehouse table in a BQ-hosted federated
    dataset), rows are extracted on the source's own engine and loaded into the
    host BQ so the whole dataset can be queried in one BigQuery statement."""
    is_federated = getattr(table, "source_kind", None) != "sql_query" or _ds_type(datasource) != "bigquery"
    if is_federated:
        if not is_federated_materializable(table):
            return None
    elif not should_materialize(table):
        return None

    host = host_datasource or datasource
    # Fingerprint + (for a BigQuery source) the resolved BQ SQL to extract.
    try:
        if _ds_type(datasource) == "bigquery":
            resolved_sql = _resolved_sql(dataset_obj, table, datasource, db)
            source_sig = resolved_sql
        else:
            resolved_sql = None
            source_sig = _source_select_sql(datasource, table)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[snapshot] resolve SQL failed for table %s: %s", table.id, exc)
        return None
    fp = _fingerprint(source_sig, table)
    cfg = settings_for(host)
    snap_dataset = cfg["dataset"]
    project = str((host.config or {}).get("project_id") or "").strip()

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
            # EXTRACT with the SOURCE's own read credential, LOAD with the host's
            # write service account — the write SA never reads the source, and the
            # host snapshot dataset is SA-only (per the chosen access model). The
            # snapshot dataset lives in (and is colocated with) the HOST.
            location = _source_location(host)
            DataSourceConnectionService.ensure_bigquery_dataset(host.config, snap_dataset, location=location)
            if _ds_type(datasource) == "bigquery":
                bq_schema, rows = DataSourceConnectionService.extract_bigquery_for_snapshot(
                    datasource.config, resolved_sql, timeout_seconds=_DDL_TIMEOUT_SEC
                )
            else:
                # Federated: pull rows on the source's own engine (Sheets/PG/…),
                # load into the host BQ with autodetect (schema=None).
                bq_schema, rows = DataSourceConnectionService.extract_generic_for_snapshot(
                    _ds_type(datasource), datasource.config, source_sig,
                    timeout_seconds=_DDL_TIMEOUT_SEC,
                )
            row.row_count = DataSourceConnectionService.load_bigquery_snapshot(
                host.config, snap_dataset, table_name, bq_schema, rows,
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
        # perf #5 — capture the source watermark (MAX last_modified of the tables
        # this snapshot read) so a later render can detect SOURCE-DATA changes and
        # rebuild only when the data actually changed (change-driven, no spam).
        # Only meaningful for a BigQuery source; non-BQ → None (TTL fallback).
        try:
            row.source_watermark = (
                DataSourceConnectionService.bigquery_source_watermark(datasource.config, resolved_sql)
                if resolved_sql is not None else None
            )
        except Exception:  # noqa: BLE001 — best-effort; None → TTL fallback
            row.source_watermark = None
        db.commit()

        # Best-effort GC of the just-superseded physical tables (in the HOST).
        for p in prior:
            try:
                DataSourceConnectionService.drop_bigquery_table(host.config, p.physical_ref)
            except Exception:  # noqa: BLE001
                pass
        logger.info(
            "[snapshot] built table=%s ref=%s rows=%s in %sms (federated=%s)",
            table.id, ref, row.row_count, row.build_ms, is_federated,
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
    # Host = the BQ datasource that snapshots load into. Present → the whole
    # dataset (incl. Google Sheets / other-source tables) materializes into BQ
    # and can be queried as one BigQuery statement. Absent → nothing to build.
    from app.services.dataset_calendar_service import is_generated_calendar_table
    host = resolve_host(db, dataset_id)
    built, skipped = [], []
    for t in tables:
        ds = datasource_by_id.get(t.datasource_id)
        if (host is None or ds is None or is_generated_calendar_table(t)
                or not is_federated_materializable(t)):
            skipped.append(t.id)
            continue
        row = build_table_snapshot(db, dataset_obj, t, ds, force=force, host_datasource=host)
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


def invalidate_stale_fingerprints(db: Session, dataset_id: int) -> int:
    """Schema-drift guard (call after a model/table edit): recompute each current
    snapshot's fingerprint against the CURRENT table definition and mark stale
    (is_current=False) any whose fingerprint changed — so the resolver never
    serves a column-mismatched or stale-logic snapshot. Unchanged tables keep
    their fast snapshot; drifted ones rebuild on the next Refresh (builder) or
    TTL view (public). Cheap: runs only on edits, never in the chart hot path.
    Returns the number invalidated. NEVER raises."""
    try:
        dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if dataset_obj is None:
            return 0
        current = (
            db.query(DatasetTableSnapshot)
            .filter(
                DatasetTableSnapshot.dataset_id == dataset_id,
                DatasetTableSnapshot.is_current.is_(True),
                DatasetTableSnapshot.status == "ready",
            )
            .all()
        )
        if not current:
            return 0
        by_tid = {r.dataset_table_id: r for r in current}
        tables = db.query(DatasetTable).filter(DatasetTable.id.in_(list(by_tid))).all()
        table_by_id = {t.id: t for t in tables}
        ds_cache: Dict[int, Optional[DataSource]] = {}
        n = 0
        for tid, row in by_tid.items():
            t = table_by_id.get(tid)
            if t is None:  # table deleted → snapshot orphaned → invalidate
                row.is_current = False
                row.status = "superseded"
                n += 1
                continue
            ds = ds_cache.get(t.datasource_id)
            if ds is None and t.datasource_id:
                ds = db.query(DataSource).filter(DataSource.id == t.datasource_id).first()
                ds_cache[t.datasource_id] = ds
            try:
                fp = _fingerprint(_resolved_sql(dataset_obj, t, ds, db), t)
            except Exception:  # noqa: BLE001 — can't resolve → be safe, invalidate
                fp = None
            if fp != row.fingerprint:
                row.is_current = False
                row.status = "superseded"
                n += 1
        if n:
            db.commit()
            logger.info("[snapshot] invalidated %d drifted snapshot(s) dataset=%s", n, dataset_id)
        return n
    except Exception:  # noqa: BLE001 — invalidation must never break an edit
        db.rollback()
        logger.warning("[snapshot] fingerprint invalidation failed dataset=%s", dataset_id, exc_info=True)
        return 0


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
# Global ceiling on CONCURRENT background rebuilds across ALL datasets. Each
# rebuild's extract-load pulls the whole table into Python then re-loads it (a
# GIL-bound, RAM-heavy job that runs in-process). A public dashboard spanning K
# datasets would otherwise fire K heavy rebuild threads at once — starving the
# GIL so foreground /charts/{id}/data requests (which the viewer is waiting on)
# stall and tiles "spin". Cap it so at most this many run together; skipped
# datasets are picked up on the next trigger (TTL / watermark) — serve-stale
# keeps them fast meanwhile, so nothing is lost by deferring.
_MAX_CONCURRENT_REBUILDS = 1


def _reserve_rebuild_slot(dataset_id: int) -> bool:
    """Reserve a global rebuild slot for `dataset_id` under `_async_refresh_lock`.
    Returns False (caller must NOT rebuild) when this dataset is already building
    OR the global concurrency cap is reached. Caller frees the slot in `finally`
    via `_async_refresh_inflight.pop`. MUST be called while holding the lock."""
    if dataset_id in _async_refresh_inflight:
        return False
    if len(_async_refresh_inflight) >= _MAX_CONCURRENT_REBUILDS:
        logger.info(
            "[snapshot] rebuild cap %s reached; deferring dataset=%s (serve-stale meanwhile)",
            _MAX_CONCURRENT_REBUILDS, dataset_id,
        )
        return False
    _async_refresh_inflight[dataset_id] = time.time()
    return True


def trigger_async_refresh(dataset_id: int) -> None:
    """Fire-and-forget rebuild of one dataset's snapshots. Idempotent: a dataset
    already rebuilding is skipped. NEVER raises (background best-effort)."""
    if not dataset_id:
        return
    with _async_refresh_lock:
        if not _reserve_rebuild_slot(dataset_id):
            return

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


# ── change-driven refresh: rebuild when the SOURCE DATA actually changed ──────
# Detects source-data changes via the source tables' `last_modified_time`
# (metadata only, no scan/cost) instead of a fixed schedule — so a rebuild fires
# only on a REAL change (no time-based spam) and works for the builder too (which
# has no TTL). The metadata check is rate-limited per dataset and runs in the
# BACKGROUND so the request never waits; TTL remains the backstop for sources
# whose last_modified is unreliable (streaming buffer) or absent (views).
_watermark_check_at: Dict[int, float] = {}
_WATERMARK_CHECK_INTERVAL = 120  # seconds between metadata checks per dataset


def _source_changed(db: Session, dataset_id: int) -> bool:
    """True if any current snapshot's source tables were modified AFTER the
    snapshot's stored watermark. Metadata only (read cred). Missing watermark →
    skip that table (TTL backstop). NEVER raises."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset_obj is None:
        return False
    rows = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_id == dataset_id,
            DatasetTableSnapshot.is_current.is_(True),
            DatasetTableSnapshot.status == "ready",
        )
        .all()
    )
    if not rows:
        return False
    by_tid = {r.dataset_table_id: r for r in rows}
    tables = db.query(DatasetTable).filter(DatasetTable.id.in_(list(by_tid))).all()
    ds_cache: Dict[int, Optional[DataSource]] = {}
    for t in tables:
        row = by_tid.get(t.id)
        if row is None or row.source_watermark is None:
            continue  # no baseline → rely on TTL
        ds = ds_cache.get(t.datasource_id)
        if ds is None and t.datasource_id:
            ds = db.query(DataSource).filter(DataSource.id == t.datasource_id).first()
            ds_cache[t.datasource_id] = ds
        if ds is None:
            continue
        try:
            cur = DataSourceConnectionService.bigquery_source_watermark(
                ds.config, _resolved_sql(dataset_obj, t, ds, db)
            )
        except Exception:  # noqa: BLE001
            cur = None
        if cur is None:
            continue
        base = row.source_watermark
        if base.tzinfo is None:
            base = base.replace(tzinfo=timezone.utc)
        if cur > base:
            return True
    return False


def schedule_source_change_check(dataset_id: int) -> None:
    """Change-driven refresh (perf #5): rate-limited, in the BACKGROUND, detect a
    SOURCE-DATA change (via last_modified watermark) and rebuild only then. The
    request serves the current snapshot instantly; rebuilds happen off-thread and
    only on a real change. NEVER blocks / raises."""
    if not dataset_id:
        return
    now = time.time()
    with _async_refresh_lock:
        if dataset_id in _async_refresh_inflight:
            return  # a rebuild is already running
        if now - _watermark_check_at.get(dataset_id, 0.0) < _WATERMARK_CHECK_INTERVAL:
            return  # checked recently → don't spam metadata
        _watermark_check_at[dataset_id] = now

    def _run() -> None:
        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            if not _source_changed(db, dataset_id):
                return
            with _async_refresh_lock:
                if not _reserve_rebuild_slot(dataset_id):
                    return
            try:
                refresh_all_for_dataset(db, dataset_id, force=True)
                logger.info("[snapshot] source-change rebuild done dataset=%s", dataset_id)
            finally:
                with _async_refresh_lock:
                    _async_refresh_inflight.pop(dataset_id, None)
        except Exception:  # noqa: BLE001 — background best-effort
            logger.warning("[snapshot] source-change check failed dataset=%s", dataset_id, exc_info=True)
        finally:
            db.close()

    threading.Thread(target=_run, name=f"snap-wmcheck-{dataset_id}", daemon=True).start()


def start_manual_refresh(dataset_ids: List[int]) -> List[int]:
    """Manual "Refresh data": rebuild the given datasets' snapshots in the
    BACKGROUND and return immediately, so the HTTP request never blocks on a long
    extract-load. This fixes the sync-refresh-in-request problem (a big rebuild
    used to run inside the POST, blowing past nginx's 120s while backend kept
    going to 280s/table and the viewer saw a timeout even though it was still
    building). Rebuilds SEQUENTIALLY in ONE thread — the extract-load holds a
    whole table in RAM, so one-at-a-time keeps peak memory bounded on a small VM
    (do NOT parallelise here until the build is moved server-side). Marks each
    dataset in the SAME in-flight registry the auto-refresh uses, so a concurrent
    TTL/watermark rebuild won't double-build, and the client can poll
    ``datasets_rebuilding`` for a "đang làm mới…" indicator. NEVER raises. Returns
    the dataset ids actually claimed (those not already rebuilding)."""
    ids: List[int] = []
    seen = set()
    for d in dataset_ids or []:
        try:
            di = int(d)
        except (TypeError, ValueError):
            continue
        if di and di not in seen:
            seen.add(di)
            ids.append(di)
    if not ids:
        return []
    with _async_refresh_lock:
        claimed = [d for d in ids if d not in _async_refresh_inflight]
        for d in claimed:
            _async_refresh_inflight[d] = time.time()
    if not claimed:
        return []

    def _run() -> None:
        from app.core.database import SessionLocal
        db = SessionLocal()
        try:
            for d in claimed:
                try:
                    refresh_all_for_dataset(db, d, force=True)
                    logger.info("[snapshot] manual refresh done dataset=%s", d)
                except Exception:  # noqa: BLE001 — one dataset's failure must not block the rest
                    logger.warning("[snapshot] manual refresh failed dataset=%s", d, exc_info=True)
                finally:
                    # Release each dataset as it finishes so freshness polling
                    # reflects real progress instead of flipping only at the end.
                    with _async_refresh_lock:
                        _async_refresh_inflight.pop(d, None)
        finally:
            db.close()

    threading.Thread(target=_run, name="snap-manual-refresh", daemon=True).start()
    return claimed


def datasets_rebuilding(dataset_ids: List[int]) -> bool:
    """True if ANY of the given datasets currently has a snapshot rebuild in
    flight (manual or auto). Drives the client's "đang làm mới…" poll after an
    async refresh so the UI knows when the rebuild has actually finished."""
    with _async_refresh_lock:
        for d in dataset_ids or []:
            try:
                if int(d) in _async_refresh_inflight:
                    return True
            except (TypeError, ValueError):
                continue
    return False
