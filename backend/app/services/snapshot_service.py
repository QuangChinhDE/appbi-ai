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
from app.services import sync_control as _sc
from app.services.datasource_service import DataSourceConnectionService, _is_quota_exceeded

logger = logging.getLogger(__name__)

DEFAULT_SNAPSHOT_DATASET = "appbi_snapshots"
_DDL_TIMEOUT_SEC = 280  # build budget per table (< the 300s BQ result cap)
# Resume window: a Sync interrupted (Stop / crash) leaves an UNpublished generation
# with some tables already built. The next Sync RESUMES that generation — reusing
# every already-built table (even one whose source watermark can't be computed, so
# it would otherwise rebuild every time) and building only what's missing/changed,
# then publishing. Bounded by age so a long-abandoned generation isn't resumed with
# stale data (a fresh full rebuild is safer past this window).
_RESUME_MAX_AGE_MS = 24 * 3600 * 1000  # 24h

# After a BigQuery quota 403 (partition-modifications), suppress BACKGROUND
# auto-retries for a cooldown so we don't keep burning the (per-day) quota — a
# manual Sync click is still allowed (the user's explicit choice). In-process,
# single-worker (mirrors sync_progress / sync_control).
_QUOTA_COOLDOWN_SECONDS = 1800  # 30 min
_quota_cooldown: Dict[int, float] = {}
_quota_cooldown_lock = threading.Lock()


def _note_quota_cooldown(dataset_id: int) -> None:
    with _quota_cooldown_lock:
        _quota_cooldown[int(dataset_id)] = time.time()


def _in_quota_cooldown(dataset_id: int) -> bool:
    with _quota_cooldown_lock:
        ts = _quota_cooldown.get(int(dataset_id))
    return ts is not None and (time.time() - ts) < _QUOTA_COOLDOWN_SECONDS
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
    tables materialize INTO, so the chart runs entirely in BigQuery.

    Phase 4 (issue #18/#19): the host RECORDED on the newest snapshot rows wins
    — existing snapshots keep being read with the host that actually built them,
    so adding/toggling another BigQuery datasource can no longer silently flip
    which project/credential a dataset's reads go through. Fallback (no recorded
    host / recorded host gone or disabled): the materialization-enabled BQ
    datasource among the dataset's tables (lowest id if several), or None."""
    recorded = (
        db.query(DatasetTableSnapshot.host_datasource_id)
        .filter(
            DatasetTableSnapshot.dataset_id == dataset_id,
            DatasetTableSnapshot.host_datasource_id.isnot(None),
            DatasetTableSnapshot.retired_at.is_(None),
            DatasetTableSnapshot.status.in_(("ready", "superseded")),
        )
        .order_by(DatasetTableSnapshot.id.desc())
        .first()
    )
    if recorded and recorded[0]:
        d = db.query(DataSource).filter(DataSource.id == int(recorded[0])).first()
        if d is not None and _ds_type(d) == "bigquery" and settings_for(d)["enabled"]:
            return d
    tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
    ds_ids = sorted({t.datasource_id for t in tables if t.datasource_id})
    if not ds_ids:
        return None
    rows = db.query(DataSource).filter(DataSource.id.in_(ds_ids)).all()
    hosts = sorted(
        (d for d in rows if _ds_type(d) == "bigquery" and settings_for(d)["enabled"]),
        key=lambda d: d.id,
    )
    if hosts:
        return hosts[0]
    # No BigQuery source of its own (Sheets-only / Postgres-only dataset). The
    # serving invariant is "snapshot store = BigQuery", so fall back to the
    # platform default BQ snapshot host — every non-BQ table federates INTO it.
    return _default_snapshot_host(db)


def _default_snapshot_host(db: Session) -> Optional[DataSource]:
    """Platform default BigQuery host for datasets with no BQ source of their own.
    Explicit `MATERIALIZATION_HOST_DATASOURCE_ID` wins; otherwise the lowest-id
    materialization-enabled BigQuery datasource in the system. None if there is
    no materialization-enabled BQ datasource anywhere (nothing can host)."""
    from app.core.config import settings
    explicit = getattr(settings, "MATERIALIZATION_HOST_DATASOURCE_ID", None)
    if explicit:
        d = db.query(DataSource).filter(DataSource.id == int(explicit)).first()
        if d is not None and _ds_type(d) == "bigquery" and settings_for(d)["enabled"]:
            return d
    candidates = sorted(
        (d for d in db.query(DataSource).all()
         if _ds_type(d) == "bigquery" and settings_for(d)["enabled"]),
        key=lambda d: d.id,
    )
    return candidates[0] if candidates else None


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


def _sanitize_name_part(name: Optional[str]) -> str:
    """BigQuery-safe fragment from a user display name for the snapshot table name:
    lowercase, non-alphanumerics → '_', collapsed, trimmed, length-bounded.
    Empty/none → 't'."""
    import re
    s = re.sub(r"[^a-z0-9]+", "_", str(name or "").strip().lower())
    s = re.sub(r"_+", "_", s).strip("_")
    return s[:40] or "t"


def build_table_snapshot(
    db: Session,
    dataset_obj: Dataset,
    table: DatasetTable,
    datasource: DataSource,
    *,
    force: bool = False,
    host_datasource: Optional[DataSource] = None,
    generation: Optional[int] = None,
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

        # Nấc A — watermark-gated REUSE on the forced (Sync&Publish / scheduled)
        # path. A forced refresh normally re-scans the whole source and rewrites
        # the table (WRITE_TRUNCATE) even when nothing changed. Instead: if the
        # design is unchanged (same fingerprint) AND the BigQuery source has not
        # been modified since this snapshot was built (same watermark), CLONE the
        # metadata into the NEW generation reusing the SAME physical table — no
        # re-scan, no re-load, no BQ cost. Only for BigQuery sources (non-BQ has
        # no cheap watermark → always rebuilt). The generation stays COMPLETE, so
        # publish's coverage check + pinned reads still pass.
        if (
            force
            and current is not None
            and current.fingerprint == fp
            and generation is not None
            and current.generation != generation
            and _ds_type(datasource) == "bigquery"
            and resolved_sql is not None
            and current.source_watermark is not None
        ):
            try:
                cur_wm = DataSourceConnectionService.bigquery_source_watermark(
                    datasource.config, resolved_sql
                )
            except Exception:  # noqa: BLE001
                cur_wm = None
            if cur_wm is not None and cur_wm == current.source_watermark:
                reuse = DatasetTableSnapshot(
                    dataset_id=dataset_obj.id,
                    dataset_table_id=table.id,
                    version=int(time.time() * 1000),
                    physical_ref=current.physical_ref,  # SHARE the existing table
                    fingerprint=fp,
                    status="ready",
                    is_current=False,
                    generation=generation,
                    host_datasource_id=current.host_datasource_id,
                    host_project=current.host_project,
                    host_location=current.host_location,
                    row_count=current.row_count,
                    source_watermark=current.source_watermark,
                    built_at=current.built_at,
                    build_ms=0,
                )
                current.is_current = False
                current.status = "superseded"
                reuse.is_current = True
                db.add(reuse)
                db.commit()
                logger.info(
                    "[snapshot] REUSED table=%s ref=%s gen=%s (source unchanged — no re-scan)",
                    table.id, current.physical_ref, generation,
                )
                return reuse

        version = int(time.time() * 1000)
        # Human-readable snapshot name: snap_t<id>_<display-name>_v<version>. Keeps
        # the table-id KEY (stable, unambiguous) AND the user's name (easy to find
        # in BigQuery). Zero-cost on rename: each refresh builds a fresh table with
        # the CURRENT name, so a rename flows through on the next publish — no BQ
        # ALTER, no scan. (A pure rename with no data change reuses the old-named
        # table until the next real rebuild.)
        table_name = f"snap_t{table.id}_{_sanitize_name_part(getattr(table, 'display_name', None))}_v{version}"
        ref = f"{project}.{snap_dataset}.{table_name}"
        row = DatasetTableSnapshot(
            dataset_id=dataset_obj.id,
            dataset_table_id=table.id,
            version=version,
            physical_ref=ref,
            fingerprint=fp,
            status="building",
            is_current=False,
            # Phase 4 — dataset-level consistency + host identity, recorded at
            # build time so reads resolve from the registry (what actually
            # happened), not from mutable config.
            generation=generation,
            host_datasource_id=host.id,
            host_project=project,
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
            row.host_location = location
            DataSourceConnectionService.ensure_bigquery_dataset(host.config, snap_dataset, location=location)
            # Batched EXTRACT+LOAD (bounds VM memory to one chunk) into a
            # PARTITIONED/CLUSTERED table per the dataset's storage config.
            from app.services import dataset_snapshot_config as _snapcfg
            from app.services import sync_progress as _sp
            _storage = _snapcfg.table_storage_config(dataset_obj, table.id)
            _cols_meta = (getattr(table, "columns_cache", None) or {}).get("columns")

            def _row_progress(n: int, _dsid=dataset_obj.id, _tid=table.id) -> None:
                # Cooperative Stop: abort the in-flight load between chunks. The
                # SyncCancelled propagates out of stream_extract_load_snapshot and
                # is caught below WITHOUT swapping is_current → prior snapshot stays.
                if _sc.is_stop_requested(_dsid):
                    raise _sc.SyncCancelled()
                _sp.note_rows(_dsid, _tid, n)

            # Task 1 — for a DIRECT physical BigQuery table with a partition
            # configured, try PARTITION-SCOPED incremental (clone prev snapshot +
            # reload only changed source partitions) before falling back to a full
            # rebuild. Only reloads partitions modified since the last snapshot.
            inc = None
            if (getattr(table, "source_kind", None) == "physical_table"
                    and _ds_type(datasource) == "bigquery"
                    and _storage.get("partition_field")
                    and current is not None
                    and getattr(current, "source_watermark", None) is not None):
                inc = DataSourceConnectionService.try_partition_incremental_snapshot(
                    source_config=datasource.config,
                    source_table_name=table.source_table_name,
                    partition_field=_storage["partition_field"],
                    host_config=host.config, dataset_name=snap_dataset,
                    new_table_name=table_name, clone_from_ref=current.physical_ref,
                    since=current.source_watermark, timeout_seconds=_DDL_TIMEOUT_SEC,
                    progress_cb=_row_progress,
                )
            if inc is not None:
                row.row_count = inc["row_count"]
                logger.info(
                    "[snapshot] PARTITION-INCREMENTAL table=%s ref=%s reloaded %d partition(s): %s",
                    table.id, ref, len(inc["changed"]), inc["changed"][:8],
                )
            else:
                _did_ctas = False
                # BQ→BQ: prefer a SINGLE CREATE OR REPLACE TABLE … PARTITION BY …
                # CLUSTER BY … AS <sql>. One job writes every partition ONCE — no
                # partition_modifications quota blowup (the chunked WRITE_APPEND
                # path re-touches the same day-partitions across every 50k chunk)
                # and no VM round-trip. Falls back to streaming on any NON-quota
                # error (2-account write-SA can't read source / cross-project /
                # location mismatch). A quota 403 is re-raised (streaming would use
                # even MORE quota) → the outer handler surfaces it + cooldowns.
                if _ds_type(datasource) == "bigquery" and resolved_sql:
                    try:
                        row.row_count, _warn = DataSourceConnectionService.bigquery_ctas_snapshot(
                            host_config=host.config, target_ref=ref, resolved_sql=resolved_sql,
                            storage=_storage, timeout_seconds=_DDL_TIMEOUT_SEC, location=location,
                        )
                        _did_ctas = True
                        _sp.note_rows(dataset_obj.id, table.id, row.row_count)
                        if _warn:
                            logger.warning("[snapshot] storage-config table=%s: %s", table.id, _warn)
                        logger.info("[snapshot] CTAS build table=%s ref=%s rows=%s (BQ→BQ, one job)",
                                    table.id, ref, row.row_count)
                    except Exception as _ctas_exc:  # noqa: BLE001
                        if _is_quota_exceeded(_ctas_exc):
                            raise  # not a fallback case — streaming would burn more quota
                        logger.info("[snapshot] CTAS unavailable table=%s (%s) → streaming fallback",
                                    table.id, str(_ctas_exc)[:160])
                if not _did_ctas:
                    row.row_count, _warn = DataSourceConnectionService.stream_extract_load_snapshot(
                        source_ds_type=_ds_type(datasource), source_config=datasource.config,
                        resolved_sql=resolved_sql, source_select_sql=source_sig,
                        columns_meta=_cols_meta, host_config=host.config,
                        dataset_name=snap_dataset, table_name=table_name,
                        storage=_storage, timeout_seconds=_DDL_TIMEOUT_SEC, progress_cb=_row_progress,
                    )
                    if _warn:
                        logger.warning("[snapshot] storage-config table=%s: %s", table.id, _warn)
        except _sc.SyncCancelled:
            # Stop requested mid-load: abandon the partial physical table WITHOUT
            # swapping is_current, so the prior COMPLETE snapshot keeps serving.
            db.rollback()
            _cancel_row = db.query(DatasetTableSnapshot).get(row.id)
            if _cancel_row is not None:
                _cancel_row.status = "cancelled"
                db.commit()
            logger.info("[snapshot] build CANCELLED table=%s (stop requested)", table.id)
            return None
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            _quota = _is_quota_exceeded(exc)
            row = db.query(DatasetTableSnapshot).get(row.id)
            if row is not None:
                row.status = "failed"
                row.error = (
                    "Hết quota BigQuery (partition-modifications) cho hôm nay — chờ ~24h để quota "
                    "reset hoặc nâng quota trong GCP; đừng bấm Sync lại liên tục."
                ) if _quota else str(exc)[:2000]
                db.commit()
            if _quota:
                # Suppress background auto-retries so we don't keep burning the
                # per-day quota; a manual Sync is still allowed.
                _note_quota_cooldown(dataset_obj.id)
                logger.warning("[snapshot] QUOTA exceeded table=%s ref=%s → cooldown dataset=%s: %s",
                               table.id, ref, dataset_obj.id, exc)
            else:
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

        # Phase 4 — NO immediate GC of just-superseded physical tables. A query
        # that resolved the old refs may still be executing (issue #10); the
        # delayed GC pass at the end of refresh_all_for_dataset retires old
        # generations only once a newer COMPLETE generation exists + a grace
        # window has passed.
        logger.info(
            "[snapshot] built table=%s ref=%s rows=%s in %sms (federated=%s gen=%s)",
            table.id, ref, row.row_count, row.build_ms, is_federated, generation,
        )
        return row

    return _qc.single_flight(f"snapbuild::{table.id}::{fp}", _do)


def build_calendar_snapshot(
    db: Session, dataset_obj: Dataset, table: DatasetTable, host: DataSource,
    *, generation: Optional[int] = None, force: bool = True,
) -> Optional[DatasetTableSnapshot]:
    """Materialize the generated_calendar (Date) as a REAL snapshot table via CTAS
    on the host BigQuery (self-contained calendar SQL — no source read, so the
    write SA can run it). Makes the Date table uniform with every other snapshot
    table ("query only the BQ snapshot") AND pins it to the generation — the
    previous inline calendar regenerated from LIVE settings on every query, which
    could drift a published dashboard's date range without a re-publish. Fingerprint
    = the calendar SQL, so it rebuilds only when calendar settings change; otherwise
    it clones the metadata into the new generation (tiny table, reused)."""
    from app.services.dataset_calendar_service import get_calendar_settings, build_calendar_live_sql
    from app.services.datasource_service import _build_bigquery_client, _materialization_bq_config

    settings = get_calendar_settings(dataset_obj, enabled_default=False)
    cal_sql = build_calendar_live_sql(settings, "bigquery")
    fp = hashlib.sha256(("calendar:" + cal_sql).encode("utf-8")).hexdigest()  # 64-char (col limit)
    cfg = settings_for(host)
    snap_dataset = cfg["dataset"]
    project = str((host.config or {}).get("project_id") or "").strip()

    def _do() -> Optional[DatasetTableSnapshot]:
        current = (
            db.query(DatasetTableSnapshot)
            .filter(DatasetTableSnapshot.dataset_table_id == table.id,
                    DatasetTableSnapshot.is_current.is_(True),
                    DatasetTableSnapshot.status == "ready")
            .first()
        )
        # Unchanged calendar → clone metadata into the new generation (reuse table).
        if (current and current.fingerprint == fp and generation is not None
                and current.generation != generation):
            reuse = DatasetTableSnapshot(
                dataset_id=dataset_obj.id, dataset_table_id=table.id,
                version=int(time.time() * 1000), physical_ref=current.physical_ref,
                fingerprint=fp, status="ready", is_current=False, generation=generation,
                host_datasource_id=current.host_datasource_id, host_project=current.host_project,
                host_location=current.host_location, row_count=current.row_count,
                built_at=current.built_at, build_ms=0,
            )
            current.is_current = False; current.status = "superseded"; reuse.is_current = True
            db.add(reuse); db.commit()
            return reuse
        if current and current.fingerprint == fp and not force:
            return current

        version = int(time.time() * 1000)
        table_name = f"snap_t{table.id}_date_v{version}"
        ref = f"{project}.{snap_dataset}.{table_name}"
        row = DatasetTableSnapshot(
            dataset_id=dataset_obj.id, dataset_table_id=table.id, version=version,
            physical_ref=ref, fingerprint=fp, status="building", is_current=False,
            generation=generation, host_datasource_id=host.id, host_project=project,
        )
        db.add(row); db.commit()
        t0 = time.time()
        try:
            location = _source_location(host)
            row.host_location = location
            DataSourceConnectionService.ensure_bigquery_dataset(host.config, snap_dataset, location=location)
            DataSourceConnectionService.execute_bigquery_ddl(
                host.config, f"CREATE OR REPLACE TABLE `{ref}` AS {cal_sql}",
                timeout_seconds=_DDL_TIMEOUT_SEC, location=location,
            )
            client = _build_bigquery_client(_materialization_bq_config(host.config))
            row.row_count = int(getattr(client.get_table(ref), "num_rows", 0) or 0)
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            row = db.query(DatasetTableSnapshot).get(row.id)
            if row is not None:
                row.status = "failed"; row.error = str(exc)[:2000]; db.commit()
            logger.warning("[snapshot] calendar build failed table=%s ref=%s: %s", table.id, ref, exc)
            return None
        for p in db.query(DatasetTableSnapshot).filter(
                DatasetTableSnapshot.dataset_table_id == table.id,
                DatasetTableSnapshot.is_current.is_(True)).all():
            p.is_current = False; p.status = "superseded"
        row.status = "ready"; row.is_current = True
        row.built_at = datetime.utcnow(); row.build_ms = int((time.time() - t0) * 1000)
        row.source_watermark = None  # generated → no source watermark
        db.commit()
        logger.info("[snapshot] built CALENDAR table=%s ref=%s rows=%s gen=%s",
                    table.id, ref, row.row_count, generation)
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


# ── Phase 4: generation-consistent reads + delayed GC ────────────────────────
_GC_GRACE_SECONDS = 600          # never drop a physical younger than this
_RETAIN_COMPLETE_GENERATIONS = 2  # latest + previous (in-flight query fallback)


def resolve_generation_refs(
    db: Session, table_ids: List[int], *, before_generation: Optional[int] = None
) -> Tuple[Dict[int, str], Dict[int, str], Optional[int], Optional[datetime]]:
    """Resolve physical refs for ALL ``table_ids`` from ONE consistent snapshot
    generation (the newest generation that covers every table — issue #8/#9).
    Returns ``(refs, fingerprints, generation, as_of)``; empty refs ⇒ not built.

    Mid-rebuild reads stay consistent: while a refresh batch is flipping tables
    one by one, the newest COMPLETE generation is still the previous one, whose
    physical tables are retained by the delayed GC — so a dashboard never reads
    a torn half-old/half-new mix. Legacy rows (generation NULL, pre-Phase-4)
    fall back to the per-table ``is_current`` pointers exactly as before."""
    if not table_ids:
        return {}, {}, None, None
    want = set(int(t) for t in table_ids)
    rows = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_table_id.in_(list(want)),
            DatasetTableSnapshot.status.in_(("ready", "superseded")),
            DatasetTableSnapshot.retired_at.is_(None),
        )
        .all()
    )
    by_gen: Dict[int, Dict[int, DatasetTableSnapshot]] = {}
    for r in rows:
        if r.generation is None:
            continue
        by_gen.setdefault(int(r.generation), {})[r.dataset_table_id] = r
    complete = [g for g, m in by_gen.items() if want <= set(m.keys())]
    if before_generation is not None:
        # Phase 7 (#16): fallback resolve — the newest complete generation
        # STRICTLY OLDER than the one that just failed (its physical tables are
        # retained by the delayed GC), so a federated dataset can keep serving
        # instead of erroring while the failed generation rebuilds.
        complete = [g for g in complete if g < int(before_generation)]
        if not complete:
            return {}, {}, None, None  # no older complete generation retained
    if complete:
        g = max(complete)
        m = by_gen[g]
        refs = {tid: m[tid].physical_ref for tid in want}
        fps = {tid: m[tid].fingerprint for tid in want}
        builts = [m[tid].built_at for tid in want if m[tid].built_at is not None]
        return refs, fps, g, (min(builts) if builts else None)

    # Legacy fallback — per-table current pointers (pre-Phase-4 rows).
    refs, fps, builts = {}, {}, []
    for tid in want:
        row = (
            db.query(DatasetTableSnapshot)
            .filter(
                DatasetTableSnapshot.dataset_table_id == tid,
                DatasetTableSnapshot.is_current.is_(True),
                DatasetTableSnapshot.status == "ready",
                DatasetTableSnapshot.retired_at.is_(None),
            )
            .first()
        )
        if row is None:
            return {}, {}, None, None
        refs[tid] = row.physical_ref
        fps[tid] = row.fingerprint
        if row.built_at is not None:
            builts.append(row.built_at)
    return refs, fps, None, (min(builts) if builts else None)


def resolve_specific_generation_refs(
    db: Session, table_ids: List[int], generation: int
) -> Tuple[Dict[int, str], Dict[int, str], Optional[datetime]]:
    """Resolve refs for a PINNED generation (Phase 1 published-only reads). A
    Dashboard on a published Dataset must read EXACTLY the published generation
    — never 'newest'. Returns ``(refs, fingerprints, as_of)``; empty refs ⇒ that
    generation no longer fully covers the tables (→ caller BLOCKS + asks to
    re-sync; it must NOT fall back to live)."""
    if not table_ids or generation is None:
        return {}, {}, None
    want = set(int(t) for t in table_ids)
    rows = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_table_id.in_(list(want)),
            DatasetTableSnapshot.generation == int(generation),
            DatasetTableSnapshot.status.in_(("ready", "superseded")),
            DatasetTableSnapshot.retired_at.is_(None),
        )
        .all()
    )
    m = {r.dataset_table_id: r for r in rows}
    if not (want <= set(m.keys())):
        return {}, {}, None
    refs = {tid: m[tid].physical_ref for tid in want}
    fps = {tid: m[tid].fingerprint for tid in want}
    builts = [m[tid].built_at for tid in want if m[tid].built_at is not None]
    return refs, fps, (min(builts) if builts else None)


def host_for_generation(
    db: Session, dataset_id: int, generation: Optional[int]
) -> Optional[DataSource]:
    """The HOST DataSource recorded on a specific snapshot generation's rows
    (issue #1/#2). Read-time credential/project MUST come from the generation
    actually being served — NOT from an independent resolve_host(), which can
    return a different (newer/changed) host while an older generation's physical
    tables live in another project. Returns None for legacy rows (generation
    NULL) or when the recorded host is gone/disabled → caller falls back to
    resolve_host()."""
    if generation is None:
        return None
    row = (
        db.query(DatasetTableSnapshot.host_datasource_id)
        .filter(
            DatasetTableSnapshot.dataset_id == dataset_id,
            DatasetTableSnapshot.generation == int(generation),
            DatasetTableSnapshot.host_datasource_id.isnot(None),
        )
        .first()
    )
    if not row or not row[0]:
        return None
    d = db.query(DataSource).filter(DataSource.id == int(row[0])).first()
    if d is not None and _ds_type(d) == "bigquery" and settings_for(d)["enabled"]:
        return d
    return None


def current_fingerprint_for_table(
    db: Session, dataset_obj: Dataset, table: DatasetTable, datasource: DataSource
) -> Optional[str]:
    """Fingerprint of the table's CURRENT definition — the exact recipe
    ``build_table_snapshot`` stamps at build time, so a mismatch against a
    snapshot row's stored fingerprint means the snapshot no longer matches the
    live definition (SQL/schema/columns_cache drift → INCOMPATIBLE, issue #12).
    None ⇒ cannot fingerprint (treat as unknown, do NOT flag)."""
    try:
        if _ds_type(datasource) == "bigquery":
            sig = _resolved_sql(dataset_obj, table, datasource, db)
        else:
            sig = _source_select_sql(datasource, table)
        return _fingerprint(sig, table)
    except Exception:  # noqa: BLE001 — unknown, never break a read
        return None


def _ready_snapshot_in_generation(
    db: Session, table: DatasetTable, generation: int,
    dataset_obj: Dataset, datasource: Optional[DataSource],
) -> Optional[DatasetTableSnapshot]:
    """The current-ready snapshot of `table` that ALREADY belongs to `generation`
    and still matches the live design — i.e. a table finished in a previous
    (interrupted) run of THIS generation that a resume must NOT rebuild. None when
    absent or drifted. Calendar tables can't be SQL-fingerprinted → accepted as-is
    when a ready snapshot exists (calendar drift is caught by fingerprint
    invalidation elsewhere)."""
    from app.services.dataset_calendar_service import is_generated_calendar_table

    row = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_table_id == table.id,
            DatasetTableSnapshot.generation == int(generation),
            DatasetTableSnapshot.is_current.is_(True),
            DatasetTableSnapshot.status == "ready",
            DatasetTableSnapshot.retired_at.is_(None),
        )
        .first()
    )
    if row is None:
        return None
    if is_generated_calendar_table(table):
        return row
    exp = current_fingerprint_for_table(db, dataset_obj, table, datasource)
    if exp is not None and row.fingerprint != exp:
        return None  # design drifted since it was built → must rebuild
    return row


def _resumable_generation(
    db: Session, dataset_id: int, dataset_obj: Dataset,
    tables: List[DatasetTable], datasource_by_id: Dict[int, DataSource],
    host: Optional[DataSource],
) -> Optional[int]:
    """Newest UNpublished generation worth RESUMING (interrupted Sync) instead of
    starting a fresh one. Requirements: not the published generation; younger than
    `_RESUME_MAX_AGE_MS`; has ≥1 current-ready snapshot; and EVERY current-ready
    snapshot in it still matches the live design (else the model changed → full
    rebuild). None ⇒ start a fresh generation (unchanged behaviour)."""
    if host is None:
        return None
    published = getattr(dataset_obj, "published_generation", None)
    rows = (
        db.query(DatasetTableSnapshot)
        .filter(
            DatasetTableSnapshot.dataset_id == dataset_id,
            DatasetTableSnapshot.is_current.is_(True),
            DatasetTableSnapshot.status == "ready",
            DatasetTableSnapshot.generation.isnot(None),
            DatasetTableSnapshot.retired_at.is_(None),
        )
        .all()
    )
    if not rows:
        return None
    by_gen: Dict[int, List[DatasetTableSnapshot]] = {}
    for r in rows:
        by_gen.setdefault(int(r.generation), []).append(r)
    now_ms = int(time.time() * 1000)
    table_by_id = {t.id: t for t in tables}
    for gen in sorted(by_gen.keys(), reverse=True):
        if published is not None and gen == int(published):
            continue  # the published generation is complete, not a resume target
        if now_ms - gen > _RESUME_MAX_AGE_MS:
            continue  # abandoned too long → fresh rebuild is safer than stale reuse
        ok = True
        for s in by_gen[gen]:
            t = table_by_id.get(s.dataset_table_id)
            if t is None:
                ok = False
                break
            if _ready_snapshot_in_generation(db, t, gen, dataset_obj, datasource_by_id.get(t.datasource_id)) is None:
                ok = False
                break
        if ok:
            return gen
    return None


def gc_dataset_snapshots(db: Session, dataset_id: int, host: DataSource) -> int:
    """Delayed GC (issue #10): retire snapshot rows + drop their physical tables
    ONLY when they are no longer needed for consistent reads:
      keep — rows of the latest ``_RETAIN_COMPLETE_GENERATIONS`` complete
             generations (current + in-flight-query fallback);
      keep — anything built within the grace window;
      keep — legacy current pointers (generation NULL, is_current, ready).
    Everything else: best-effort DROP of the physical table + ``retired_at``.
    Returns the number of rows retired. Best-effort — never raises."""
    from app.services.dataset_calendar_service import is_generated_calendar_table

    try:
        tables = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id)
            .all()
        )
        want = {
            t.id for t in tables
            if not is_generated_calendar_table(t)
            and is_federated_materializable(t)
            and getattr(t, "enabled", True) is not False
        }
        rows = (
            db.query(DatasetTableSnapshot)
            .filter(
                DatasetTableSnapshot.dataset_id == dataset_id,
                DatasetTableSnapshot.retired_at.is_(None),
            )
            .all()
        )
        by_gen: Dict[int, set] = {}
        for r in rows:
            if r.generation is not None and r.status in ("ready", "superseded"):
                by_gen.setdefault(int(r.generation), set()).add(r.dataset_table_id)
        complete = sorted(
            (g for g, tids in by_gen.items() if want and want <= tids), reverse=True
        )
        keep_gens = set(complete[:_RETAIN_COMPLETE_GENERATIONS])
        # Phase 1: NEVER GC the PUBLISHED generation — Dashboards are pinned to
        # it and scheduled refreshes build newer generations WITHOUT publishing,
        # so the published one can be older than the retained window. It must
        # survive until a NEW publish moves the pin.
        try:
            pub = (
                db.query(Dataset.published_generation)
                .filter(Dataset.id == dataset_id)
                .scalar()
            )
            if pub is not None:
                keep_gens.add(int(pub))
        except Exception:  # noqa: BLE001
            pass

        # Composition: NEVER GC a generation of THIS dataset that a downstream
        # child has PINNED (dataset_dependencies.parent_generation). The child
        # reads the parent snapshot by a plain FROM at that exact generation, so
        # retiring it would break the child (principle #2).
        try:
            from app.services import dataset_composition_service as _comp
            for g in _comp.pinned_parent_generations(db, dataset_id):
                keep_gens.add(int(g))
        except Exception:  # noqa: BLE001
            pass

        now = datetime.utcnow()

        def _is_kept(r) -> bool:
            if r.status == "building":
                return True
            if r.generation is not None and int(r.generation) in keep_gens:
                return True
            born = r.built_at or r.created_at
            if born is not None and (now - born).total_seconds() < _GC_GRACE_SECONDS:
                return True
            if r.generation is None and r.is_current and r.status == "ready":
                return True
            return False

        # Nấc A ref-count safety: watermark-reuse SHARES one physical table across
        # generations. Never DROP a physical_ref that a kept row still references —
        # only retire the metadata row. The physical is dropped only once NO kept
        # row references it (i.e. the table was actually rebuilt into a new file).
        kept_refs = {r.physical_ref for r in rows if _is_kept(r)}
        retired = 0
        for r in rows:
            if _is_kept(r):
                continue
            if r.physical_ref not in kept_refs:
                try:
                    DataSourceConnectionService.drop_bigquery_table(host.config, r.physical_ref)
                except Exception:  # noqa: BLE001 — already gone / permission: retire anyway
                    pass
            r.retired_at = now
            if r.status == "ready":
                r.is_current = False
                r.status = "superseded"
            retired += 1
        if retired:
            db.commit()
            logger.info("[snapshot] delayed GC retired %d rows dataset=%s (kept gens=%s)",
                        retired, dataset_id, sorted(keep_gens, reverse=True))
        return retired
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("[snapshot] delayed GC error dataset=%s", dataset_id, exc_info=True)
        return 0


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
    # Phase 4 — ONE generation id for the whole refresh batch. Every row built
    # in this pass carries it, so readers can resolve a CONSISTENT set (the
    # newest generation that covers every table) instead of a torn mix while
    # this loop is mid-flight.
    # RESUME (interrupted Sync): if an unpublished generation with already-built,
    # design-matching tables exists, continue IT instead of starting fresh — so a
    # Stop/crash becomes a pause and the heavy tables are not rebuilt.
    _resume_gen = _resumable_generation(db, dataset_id, dataset_obj, tables, datasource_by_id, host)
    generation = _resume_gen if _resume_gen is not None else int(time.time() * 1000)
    if _resume_gen is not None:
        logger.info("[snapshot] RESUMING generation=%s dataset=%s (reuse already-built tables)",
                    generation, dataset_id)
    built: list = []
    stopped = False
    from app.services import sync_progress as _sp

    def _eligible(t) -> bool:
        if host is None or getattr(t, "enabled", True) is False:
            return False
        # The generated calendar materializes via a host-side CTAS (no source
        # datasource) — it must be a snapshot table too, so the whole dataset is
        # queried from BigQuery snapshots and the Date range is pinned to the
        # generation (not regenerated from live settings each query).
        if is_generated_calendar_table(t):
            return True
        return datasource_by_id.get(t.datasource_id) is not None and is_federated_materializable(t)

    _to_build = [t for t in tables if _eligible(t)]
    skipped = [t.id for t in tables if not _eligible(t)]
    # rows_total_est per table = row_count of the CURRENT (previous complete)
    # snapshot — a free "≈ rows remaining" denominator (None on the first sync).
    _build_ids = [t.id for t in _to_build]
    _prev_counts: Dict[int, int] = {}
    if _build_ids:
        for _r in (
            db.query(DatasetTableSnapshot.dataset_table_id, DatasetTableSnapshot.row_count)
            .filter(
                DatasetTableSnapshot.dataset_table_id.in_(_build_ids),
                DatasetTableSnapshot.is_current.is_(True),
                DatasetTableSnapshot.status == "ready",
            )
            .all()
        ):
            if _r[1] is not None:
                _prev_counts[int(_r[0])] = int(_r[1])
    _sp.begin(dataset_id, [
        {"table_id": t.id,
         "name": getattr(t, "display_name", None) or f"table {t.id}",
         "rows_total_est": _prev_counts.get(t.id)}
        for t in _to_build
    ])

    for t in _to_build:
        # Cooperative Stop — checked BETWEEN tables (primary stop point; the load
        # callback aborts mid-table too). A stopped batch leaves the previous
        # COMPLETE generation intact, so readers keep serving last-complete.
        if _sc.is_stop_requested(dataset_id):
            stopped = True
            break
        # RESUME: a table already built in THIS generation (design unchanged) is
        # reused as-is — never rebuilt. This is what saves a heavy table whose
        # source watermark can't be computed (which would otherwise rebuild every
        # run). For a FRESH generation nothing matches → builds normally.
        _reused = _ready_snapshot_in_generation(
            db, t, generation, dataset_obj, datasource_by_id.get(t.datasource_id)
        )
        if _reused is not None:
            _sp.begin_table(dataset_id, t.id)
            built.append({"table_id": t.id, "row_count": _reused.row_count, "build_ms": 0})
            _sp.finish_table(dataset_id, t.id, _reused.row_count or 0)
            continue
        _sp.begin_table(dataset_id, t.id)
        try:
            if is_generated_calendar_table(t):
                row = build_calendar_snapshot(db, dataset_obj, t, host, generation=generation, force=force)
            else:
                row = build_table_snapshot(
                    db, dataset_obj, t, datasource_by_id.get(t.datasource_id),
                    force=force, host_datasource=host, generation=generation,
                )
        except Exception as exc:  # noqa: BLE001 — one table's failure must not crash the refresh
            db.rollback()
            logger.warning("[snapshot] build raised for table=%s: %s", t.id, exc)
            row = None
        # A None row while a stop is pending = a mid-load cancel, not a real failure.
        if row is None and _sc.is_stop_requested(dataset_id):
            stopped = True
            break
        if row is not None:
            built.append({"table_id": t.id, "row_count": row.row_count, "build_ms": row.build_ms})
            _sp.finish_table(dataset_id, t.id, row.row_count)
        else:
            skipped.append(t.id)
            _sp.finish_table(dataset_id, t.id, 0, skipped=True)

    built_ids = [b["table_id"] for b in built]
    ts = as_of(db, built_ids) if built_ids else None
    # Phase 4 — delayed GC: retire generations older than the retained window
    # (latest 2 complete generations + grace period). Best-effort. SKIP on stop —
    # the interrupted generation is incomplete, so nothing new is safe to retire.
    try:
        if host is not None and built and not stopped:
            gc_dataset_snapshots(db, dataset_id, host)
    except Exception:  # noqa: BLE001 — GC must never fail a refresh
        logger.warning("[snapshot] delayed GC failed dataset=%s", dataset_id, exc_info=True)
    return {"built": built, "skipped": skipped, "as_of": ts.isoformat() if ts else None,
            "generation": generation, "stopped": stopped}


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


_REBUILD_LEASE_SECONDS = 1800  # cross-worker lease; self-expires if a worker dies


def _reserve_rebuild_slot(dataset_id: int) -> bool:
    """Reserve a rebuild slot for `dataset_id` under `_async_refresh_lock`.
    Returns False (caller must NOT rebuild) when this dataset is already building
    OR the concurrency cap is reached. Caller frees the slot in `finally` via
    `_release_rebuild_slot`. MUST be called while holding the lock.

    Phase 7 (#36): dedup is now also CROSS-WORKER — a shared lease (backed by the
    shared sqlite in-flight table) is claimed per dataset, so two uvicorn workers
    can no longer both rebuild the same dataset. The in-process cap stays as the
    per-worker concurrency bound."""
    if dataset_id in _async_refresh_inflight:
        return False
    if len(_async_refresh_inflight) >= _MAX_CONCURRENT_REBUILDS:
        logger.info(
            "[snapshot] rebuild cap %s reached; deferring dataset=%s (serve-stale meanwhile)",
            _MAX_CONCURRENT_REBUILDS, dataset_id,
        )
        return False
    if not _qc.try_claim_global(f"snaprebuild::{dataset_id}", _REBUILD_LEASE_SECONDS):
        logger.info("[snapshot] dataset=%s already rebuilding in another worker; skipping", dataset_id)
        return False
    _async_refresh_inflight[dataset_id] = time.time()
    return True


def _release_rebuild_slot(dataset_id: int) -> None:
    """Free both the in-process slot and the cross-worker lease."""
    with _async_refresh_lock:
        _async_refresh_inflight.pop(dataset_id, None)
    _qc.release_global(f"snaprebuild::{dataset_id}")


def trigger_async_refresh(dataset_id: int) -> None:
    """Fire-and-forget rebuild of one dataset's snapshots. Idempotent: a dataset
    already rebuilding is skipped. NEVER raises (background best-effort)."""
    if not dataset_id:
        return
    if _in_quota_cooldown(dataset_id):
        logger.info("[snapshot] dataset=%s in quota cooldown → skip background refresh", dataset_id)
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
            _release_rebuild_slot(dataset_id)

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
    if _in_quota_cooldown(dataset_id):
        return  # a recent quota 403 — don't burn more quota with background rebuilds
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
                _release_rebuild_slot(dataset_id)
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
        # Phase 7 (#36): claim each dataset's CROSS-WORKER lease too, so a manual
        # refresh and another worker's TTL/watermark rebuild can't double-build.
        claimed = [
            d for d in ids
            if d not in _async_refresh_inflight
            and _qc.try_claim_global(f"snaprebuild::{d}", _REBUILD_LEASE_SECONDS)
        ]
        for d in claimed:
            _async_refresh_inflight[d] = time.time()
    if not claimed:
        return []

    def _run() -> None:
        from app.core.database import SessionLocal
        from app.services import sync_progress as _sp
        db = SessionLocal()
        try:
            for d in claimed:
                _sc.clear_stop(d)  # fresh run — ignore any stale Stop flag
                try:
                    res = refresh_all_for_dataset(db, d, force=True)
                    if res.get("stopped"):
                        _sp.set_phase(d, "stopped")
                        logger.info("[snapshot] manual refresh STOPPED dataset=%s", d)
                    else:
                        _sp.set_phase(d, "done")
                        logger.info("[snapshot] manual refresh done dataset=%s", d)
                except Exception:  # noqa: BLE001 — one dataset's failure must not block the rest
                    _sp.set_phase(d, "failed")
                    logger.warning("[snapshot] manual refresh failed dataset=%s", d, exc_info=True)
                finally:
                    # Release each dataset as it finishes so freshness polling
                    # reflects real progress instead of flipping only at the end.
                    _sc.clear_stop(d)
                    _release_rebuild_slot(d)
        finally:
            db.close()

    threading.Thread(target=_run, name="snap-manual-refresh", daemon=True).start()
    return claimed


def datasets_rebuilding(dataset_ids: List[int]) -> bool:
    """True if ANY of the given datasets currently has a snapshot rebuild in
    flight (manual or auto). Drives the client's "đang làm mới…" poll after an
    async refresh so the UI knows when the rebuild has actually finished.

    Phase 7 (#38): also consults the CROSS-WORKER lease, so the poll is accurate
    even when the request lands on a different uvicorn worker than the one
    running the rebuild (previously it answered from per-process state only)."""
    ids = []
    with _async_refresh_lock:
        for d in dataset_ids or []:
            try:
                di = int(d)
            except (TypeError, ValueError):
                continue
            if di in _async_refresh_inflight:
                return True
            ids.append(di)
    for di in ids:
        if _qc.is_claimed_global(f"snaprebuild::{di}"):
            return True
    return False
