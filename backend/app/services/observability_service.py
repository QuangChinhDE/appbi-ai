"""
ObservabilityService — the spine that turns AppBI's detectors into a real
data-observability platform (5 pillars: freshness · volume · schema ·
distribution · quality).

Responsibilities
----------------
1. Run the 3 native monitor kinds (freshness / volume / schema) against live
   source data, snapshot each run into ``observability_checks``, and open /
   resolve ``observability_incidents`` with full lifecycle.
2. Fold the OTHER detectors into the same incident store so one feed has
   everything:
     - quality : failing DatasetQualityRule in the latest DatasetQualityRun
     - anomaly : AnomalyAlert rows from the existing Phase-4 engine
3. Compute the cross-dataset Overview scorecard, the lineage / impact graph,
   and the usage / resource footprint.

Live querying reuses the exact helpers the anomaly engine already uses
(dialect-aware, BigQuery / PostgreSQL / MySQL).
"""
import logging
import re
import statistics
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.dataset import (
    Dataset, DatasetTable, DatasetQualityRule, DatasetQualityRun,
)
from app.models.models import DataSource, Chart, DashboardChart, Dashboard
from app.models.anomaly import AnomalyAlert, MonitoredMetric
from app.models.observability import (
    ObservabilityMonitor, ObservabilityCheck, ObservabilityIncident,
)

logger = logging.getLogger(__name__)

# Severity ranking shared across pillars (higher = worse).
SEV_RANK = {"info": 1, "warning": 2, "critical": 3, "error": 3, "high": 2}
#: A schema baseline whose column types are the LIVE relation's (type families).
#: Older baselines carry columns_cache types and are compared by name only.
SCHEMA_BASELINE_V = 2
PILLAR_FOR_SOURCE = {
    "freshness": "freshness", "volume": "volume", "schema": "schema",
    "quality": "quality", "anomaly": "distribution", "semantic": "semantic",
}


class ObservabilityService:

    # ── live-query helpers (mirror AnomalyDetectionService) ──────────────────

    @staticmethod
    def _live_base(db: Session, table: DatasetTable):
        """Return (datasource, dialect, base_sql) for live querying a table, or
        (None, None, None) if it can't be resolved."""
        from app.services.live_query_service import _dialect_for_ds_type
        from app.services.dataset_relation_service import resolve_dataset_table_relation

        ds: Optional[DataSource] = db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not ds:
            return None, None, None
        ds_type = ds.type if isinstance(ds.type, str) else ds.type.value
        dialect = _dialect_for_ds_type(ds_type)
        try:
            plan = resolve_dataset_table_relation(ds, table)
        except Exception as exc:
            logger.warning("[obs] query plan failed for table %s: %s", table.id, exc)
            return None, None, None
        return ds, dialect, f"({plan.sql}) AS base_table"

    @staticmethod
    def _run_sql(db: Session, table: DatasetTable, sql: str) -> Optional[List[dict]]:
        from app.services.datasource_service import DataSourceConnectionService
        ds: Optional[DataSource] = db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not ds:
            return None
        ds_type = ds.type if isinstance(ds.type, str) else ds.type.value
        try:
            _, rows, _ = DataSourceConnectionService.execute_query(
                ds_type, ds.config, sql, timeout_seconds=60,
            )
            return rows
        except Exception as exc:
            logger.warning("[obs] query failed: %s", exc)
            return None

    @staticmethod
    def _utc_iso(dt: Any) -> Optional[str]:
        """An instant the browser reads AS UTC. The columns are naive UTC
        (datetime.utcnow); a bare isoformat() is parsed as browser-local, so
        "refreshed" / incident times were off by the viewer's offset (a
        just-loaded table read "7 hours ago" at UTC+7). Same contract as the
        refresh history (api/datasets.py _iso). One definition: time_contract."""
        from app.services.time_contract import utc_iso

        return utc_iso(dt)

    @staticmethod
    def _type_family(raw: Any) -> str:
        """number / text / date / datetime / boolean / other — what a schema
        change means to a chart. Engine spellings (int4, INT64, integer,
        NUMERIC(10,2), varchar, STRING…) of one family are not a change."""
        t = str(raw or "").strip().lower()
        if not t:
            return "unknown"
        if any(k in t for k in ("bool",)):
            return "boolean"
        if "timestamp" in t or "datetime" in t or t in ("time", "timetz"):
            return "datetime"
        if t == "date" or t.startswith("date"):
            return "date"
        if any(k in t for k in ("int", "numeric", "decimal", "float", "double", "real", "number", "money")):
            return "number"
        if any(k in t for k in ("char", "text", "string", "uuid", "json", "enum")):
            return "text"
        return t

    @staticmethod
    def _live_columns_fingerprint(db: Session, table: DatasetTable,
                                  reason: Optional[list] = None) -> Optional[List[Dict[str, str]]]:
        """The columns the table's LOGICAL relation has NOW (source → its
        transformations → type overrides), as [{name, type-family}] — what every
        chart reads. None when it cannot be determined (→ the check errors; it
        is never "ok"). A table with no datasource of its own (calculated /
        composed) is described by its AppBI definition (columns_cache)."""
        if not getattr(table, "datasource_id", None):
            return [{"name": c["name"], "type": ObservabilityService._type_family(c.get("type"))}
                    for c in ObservabilityService._columns_fingerprint(table)]
        from app.services.dataset_relation_service import logical_relation_columns

        cols = logical_relation_columns(db, table, reason)
        if cols is None:
            return None
        out = [{"name": c["name"], "type": ObservabilityService._type_family(c.get("type"))} for c in cols]
        out.sort(key=lambda c: c["name"].lower())
        return out

    @staticmethod
    def _columns_fingerprint(table: DatasetTable) -> List[Dict[str, str]]:
        """Stable [{name,type}] list from the table's cached schema."""
        cache = table.columns_cache or {}
        cols = cache.get("columns") if isinstance(cache, dict) else None
        out: List[Dict[str, str]] = []
        for c in cols or []:
            if isinstance(c, dict) and c.get("name"):
                out.append({"name": str(c["name"]), "type": str(c.get("type") or c.get("dtype") or "")})
        out.sort(key=lambda c: c["name"].lower())
        return out

    # ── monitor execution ────────────────────────────────────────────────────

    @staticmethod
    def run_monitor(monitor: ObservabilityMonitor, db: Session) -> Dict[str, Any]:
        """Execute one monitor → {status, value, detail}. Records a snapshot,
        updates the monitor cache, and opens/resolves its incident."""
        table: Optional[DatasetTable] = monitor.dataset_table
        cfg = monitor.config or {}
        status, value, detail = "unknown", None, {}

        try:
            if not table:
                status, detail = "error", {"error": "dataset table missing"}
            elif monitor.kind == "freshness":
                status, value, detail = ObservabilityService._check_freshness(db, table, cfg)
            elif monitor.kind == "volume":
                status, value, detail = ObservabilityService._check_volume(db, monitor, table, cfg)
            elif monitor.kind == "schema":
                status, value, detail = ObservabilityService._check_schema(db, monitor, table, cfg)
            else:
                status, detail = "error", {"error": f"unknown monitor kind {monitor.kind}"}
        except Exception as exc:  # one monitor never breaks the scan
            logger.warning("[obs] monitor %s failed: %s", monitor.id, exc)
            status, detail = "error", {"error": str(exc)}

        now = datetime.utcnow()
        db.add(ObservabilityCheck(
            monitor_id=monitor.id, checked_at=now, value=value, status=status, detail=detail,
        ))
        monitor.last_status = status
        monitor.last_value = value
        monitor.last_detail = detail
        monitor.last_checked_at = now

        # Lifecycle: breach → open/refresh incident; ok → resolve any open one.
        created = None
        if status == "breached":
            inc, was_created = ObservabilityService.upsert_incident(
                db,
                dataset_id=monitor.dataset_id,
                dataset_table_id=monitor.dataset_table_id,
                source=monitor.kind,
                dedup_key=f"{monitor.kind}:monitor_{monitor.id}",
                title=ObservabilityService._monitor_title(monitor, detail),
                detail=detail,
                severity=monitor.severity,
            )
            if was_created:
                created = inc
        elif status == "ok":
            ObservabilityService.resolve_incidents(db, f"{monitor.kind}:monitor_{monitor.id}")

        return {"status": status, "value": value, "detail": detail, "created_incident": created}

    @staticmethod
    def _monitor_title(monitor: ObservabilityMonitor, detail: Dict[str, Any]) -> str:
        tname = monitor.dataset_table.display_name if monitor.dataset_table else "table"
        if monitor.kind == "freshness":
            return f"{tname}: dữ liệu trễ {detail.get('lag_hours', '?')}h"
        if monitor.kind == "volume":
            return f"{tname}: khối lượng bất thường ({detail.get('reason', 'volume')})"
        if monitor.kind == "schema":
            return f"{tname}: lược đồ thay đổi"
        return f"{tname}: {monitor.kind}"

    @staticmethod
    def _check_freshness(db, table, cfg) -> tuple:
        from app.services.live_query_service import _quote_identifier
        time_col = cfg.get("time_column")
        max_lag = float(cfg.get("max_lag_hours") or 24)
        if not time_col:
            return "error", None, {"error": "freshness monitor needs a time_column"}
        ds, dialect, base = ObservabilityService._live_base(db, table)
        if base is None:
            return "error", None, {"error": "cannot resolve source query"}
        q = _quote_identifier(time_col, dialect)
        rows = ObservabilityService._run_sql(db, table, f"SELECT MAX({q}) AS mx FROM {base}")
        if rows is None:
            return "error", None, {"error": "freshness query failed"}
        mx = rows[0].get("mx") if rows else None
        if mx is None:
            return "breached", None, {"reason": "no rows / null max", "max_lag_hours": max_lag}
        # Coerce to datetime
        if not isinstance(mx, datetime):
            try:
                mx = datetime.fromisoformat(str(mx).replace("Z", "").split("+")[0].strip())
            except Exception:
                return "error", None, {"error": f"unparseable timestamp: {mx}"}
        if mx.tzinfo is not None:
            # A timezone-aware TIMESTAMP (BigQuery, timestamptz): compare in UTC —
            # naive utcnow() minus an aware value raised, and the check errored forever.
            from datetime import timezone as _tz

            mx = mx.astimezone(_tz.utc).replace(tzinfo=None)
        lag_hours = round((datetime.utcnow() - mx).total_seconds() / 3600.0, 2)
        detail = {"last_loaded_at": mx.isoformat(), "lag_hours": lag_hours, "max_lag_hours": max_lag}
        return ("breached" if lag_hours > max_lag else "ok"), lag_hours, detail

    @staticmethod
    def _check_volume(db, monitor, table, cfg) -> tuple:
        z_threshold = float(cfg.get("z_threshold") or 3.0)
        min_rows = cfg.get("min_rows")
        ds, dialect, base = ObservabilityService._live_base(db, table)
        if base is None:
            return "error", None, {"error": "cannot resolve source query"}
        rows = ObservabilityService._run_sql(db, table, f"SELECT COUNT(*) AS cnt FROM {base}")
        if rows is None:
            return "error", None, {"error": "volume query failed"}
        cnt = float(rows[0].get("cnt") or 0) if rows else 0.0
        detail: Dict[str, Any] = {"row_count": cnt, "z_threshold": z_threshold}

        if min_rows is not None and cnt < float(min_rows):
            detail.update({"reason": f"dưới ngưỡng tối thiểu ({int(min_rows)})", "min_rows": min_rows})
            return "breached", cnt, detail

        # Baseline from our OWN snapshot history (last 30 ok/breached checks).
        hist = (
            db.query(ObservabilityCheck.value)
            .filter(ObservabilityCheck.monitor_id == monitor.id)
            .filter(ObservabilityCheck.value.isnot(None))
            .order_by(ObservabilityCheck.checked_at.desc())
            .limit(30).all()
        )
        vals = [float(v[0]) for v in hist if v[0] is not None]
        if len(vals) < 5:
            # Not enough history to judge: UNKNOWN (learning), never "ok" — an
            # "ok" here resolved an open volume incident with nothing checked.
            detail["reason"] = "đang học baseline"
            return "unknown", cnt, detail
        mean = statistics.mean(vals)
        try:
            std = statistics.stdev(vals)
        except statistics.StatisticsError:
            std = 0.0
        if std == 0:
            # A constant baseline: ANY change from it is the anomaly (100 rows
            # every day, then 0 — was "ok", the z-score being undefined).
            if cnt != mean:
                detail.update({"expected": round(mean, 2), "reason": "khác baseline cố định",
                               "change_pct": round((cnt - mean) / mean * 100, 1) if mean else None})
                return "breached", cnt, detail
            return "ok", cnt, detail
        z = (cnt - mean) / std
        detail.update({"expected": round(mean, 2), "z_score": round(z, 2),
                       "change_pct": round((cnt - mean) / mean * 100, 1) if mean else 0})
        if abs(z) >= z_threshold:
            detail["reason"] = ("phình bất thường" if z > 0 else "sụt bất thường")
            return "breached", cnt, detail
        return "ok", cnt, detail

    @staticmethod
    def _check_schema(db, monitor, table, cfg) -> tuple:
        # The schema the charts READ, now — not the cached description of it (a
        # column dropped or retyped upstream left columns_cache, and so this
        # monitor, "ok" until someone opened a preview).
        why: list = []
        current = ObservabilityService._live_columns_fingerprint(db, table, why)
        if current is None:
            return "error", None, {"error": "cannot read the table's current schema"
                                    + (f": {why[0]}" if why else "")}
        # The ACCEPTED schema: the most recent check that found it unchanged
        # ("ok"). A breach is not a new baseline — comparing against the
        # breaching check made the next scan "ok" and auto-resolved a schema
        # change that was still there; an error check (no columns) re-baselined
        # it the same way. It moves only when a person resolves the incident
        # (accept_schema_baseline) or nothing was ever accepted.
        prev = (
            db.query(ObservabilityCheck)
            .filter(ObservabilityCheck.monitor_id == monitor.id)
            .filter(ObservabilityCheck.status == "ok")
            .filter(ObservabilityCheck.detail.isnot(None))
            .order_by(ObservabilityCheck.checked_at.desc())
            .first()
        )
        prev_cols = (prev.detail or {}).get("columns") if prev else None
        if not prev_cols:
            return "ok", float(len(current)), {"columns": current, "reason": "baseline đã lưu",
                                               "baseline_v": SCHEMA_BASELINE_V}

        fam = ObservabilityService._type_family
        prev_map = {c["name"]: fam(c.get("type", "")) for c in prev_cols}
        cur_map = {c["name"]: fam(c.get("type", "")) for c in current}
        added = [n for n in cur_map if n not in prev_map]
        removed = [n for n in prev_map if n not in cur_map]
        # A baseline from before live reading carries columns_cache types (value-
        # sampled: a Sheets text column of digits cached as "integer"): comparing
        # them to physical types would raise a retype on every such column. Such
        # a baseline is compared by NAME only; unchanged, this check (typed, v2)
        # becomes the baseline.
        typed = (prev.detail or {}).get("baseline_v") == SCHEMA_BASELINE_V
        retyped = [
            {"column": n, "from": prev_map[n], "to": cur_map[n]}
            for n in cur_map if typed and n in prev_map and prev_map[n] != cur_map[n]
        ]
        detail = {"columns": current, "added": added, "removed": removed, "retyped": retyped,
                  "baseline_v": SCHEMA_BASELINE_V}
        if added or removed or retyped:
            detail["reason"] = "cột thêm/xoá/đổi kiểu"
            return "breached", float(len(current)), detail
        return "ok", float(len(current)), detail

    @staticmethod
    def accept_schema_baseline(db: Session, incident: "ObservabilityIncident") -> None:
        """A person resolved a schema incident: the CURRENT columns become the
        accepted schema (an "ok" check), so the change is not re-raised — and is
        never silently accepted by the scanner itself."""
        key = str(getattr(incident, "dedup_key", "") or "")
        if not key.startswith("schema:monitor_"):
            return
        try:
            monitor_id = int(key.split("_", 1)[1])
        except (IndexError, ValueError):
            return
        monitor = db.query(ObservabilityMonitor).filter(ObservabilityMonitor.id == monitor_id).first()
        if monitor is None or monitor.dataset_table is None:
            return
        live = ObservabilityService._live_columns_fingerprint(db, monitor.dataset_table)
        current = live or ObservabilityService._columns_fingerprint(monitor.dataset_table)
        detail = {"columns": current, "reason": "baseline được chấp nhận"}
        if live:
            detail["baseline_v"] = SCHEMA_BASELINE_V          # typed only when read live
        db.add(ObservabilityCheck(monitor_id=monitor.id, checked_at=datetime.utcnow(), value=float(len(current)),
                                  status="ok", detail=detail))

    @staticmethod
    def _quality_run_state(db: Session, dataset_ids: List[int]) -> Dict[int, Dict[str, int]]:
        """Per dataset, the ENABLED quality rules judged on the latest run:
        a rule that FAILED is breached (now — not only once a scan has folded it
        into an incident, up to a day later); one that ERRORED, or a run that
        failed as a whole, is a check that did not run; a not-evaluated result,
        or a rule the latest run never reached (never run, added since), is
        unknown. Only a passed result is a pass."""
        enabled: Dict[int, set] = {}
        for (rid, ds_id) in db.query(DatasetQualityRule.id, DatasetQualityRule.dataset_id).filter(
                DatasetQualityRule.dataset_id.in_(dataset_ids),
                DatasetQualityRule.enabled == True).all():  # noqa: E712
            enabled.setdefault(ds_id, set()).add(str(rid))
        out: Dict[int, Dict[str, int]] = {}
        for ds_id, rule_ids in enabled.items():
            q = {"breached": 0, "errored": 0, "unknown": 0}
            out[ds_id] = q
            run = (
                db.query(DatasetQualityRun).filter(DatasetQualityRun.dataset_id == ds_id)
                .filter(DatasetQualityRun.status.in_(("completed", "failed")))
                .order_by(DatasetQualityRun.id.desc()).first()
            )
            if run is None:
                q["unknown"] = len(rule_ids)
                continue
            if run.status == "failed":
                q["errored"] = len(rule_ids)
                continue
            results = {str(k): v for k, v in (run.results or {}).items()}
            for rid in rule_ids:
                res = results.get(rid)
                if isinstance(res, dict) and res.get("error"):
                    q["errored"] += 1
                elif not isinstance(res, dict) or res.get("skipped"):
                    q["unknown"] += 1
                elif not res.get("passed"):
                    q["breached"] += 1
        return out

    @staticmethod
    def health_state(*, open_incidents: int, breached: int, errored: int, unknown: int, checks: int,
                     semantic_invalid: bool = False) -> str:
        """One honest state: semantic_invalid > breached > error > unknown >
        not_monitored > healthy. "healthy" only when every check ran and passed
        — a check that failed to run, one never run / still learning, or no
        check at all is NOT healthy — AND the Semantic Kernel can use the
        model: a known semantic failure (charts on it are refused) outranks
        every data check, configured or not."""
        if semantic_invalid:
            return "semantic_invalid"
        if open_incidents or breached:
            return "breached"
        if errored:
            return "error"
        if unknown:
            return "unknown"
        if not checks:
            return "not_monitored"
        return "healthy"

    # ── incident lifecycle ────────────────────────────────────────────────────

    @staticmethod
    def upsert_incident(db: Session, *, dataset_id: int, dataset_table_id: Optional[int],
                        source: str, dedup_key: str, title: str, detail: dict,
                        severity: str):
        """Open a new incident or refresh the existing OPEN/ACK one for this key.
        Returns (incident, created_bool) — created=True only on a fresh open."""
        existing = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dedup_key == dedup_key)
            .filter(ObservabilityIncident.status != "resolved")
            .order_by(ObservabilityIncident.id.desc())
            .first()
        )
        now = datetime.utcnow()
        if existing:
            existing.last_seen_at = now
            existing.title = title
            existing.detail = detail
            existing.severity = severity
            return existing, False
        inc = ObservabilityIncident(
            dataset_id=dataset_id, dataset_table_id=dataset_table_id,
            source=source, pillar=PILLAR_FOR_SOURCE.get(source, source),
            dedup_key=dedup_key, title=title, detail=detail, severity=severity,
            status="open", first_seen_at=now, last_seen_at=now,
        )
        db.add(inc)
        return inc, True

    @staticmethod
    def resolve_incidents(db: Session, dedup_key: str) -> int:
        """Auto-resolve any open/ack incident whose underlying check now passes.
        Also clears any still-unread UserNotification for the same key —
        Datadog-style auto-resolve: a fixed problem shouldn't keep nagging."""
        now = datetime.utcnow()
        rows = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dedup_key == dedup_key)
            .filter(ObservabilityIncident.status != "resolved")
            .all()
        )
        for inc in rows:
            inc.status = "resolved"
            inc.resolved_at = now
        if rows:
            from app.models.user_notification import UserNotification
            db.query(UserNotification).filter(
                UserNotification.dedup_key == dedup_key,
                UserNotification.read == False,  # noqa: E712
            ).delete(synchronize_session=False)
        return len(rows)

    # ── semantic usability (Pair #5) ──────────────────────────────────────────

    @staticmethod
    def semantic_state(db: Session, dataset_id: int, *, live: bool = False) -> Dict[str, Any]:
        """Can the Semantic Kernel answer this dataset's CURRENT model? The
        semantic-health checks the Kernel itself relies on — an invalid active
        relationship, a definition naming a column the table no longer has
        (dangling join / key / dimension / measure) and, ``live``, a one-side
        key a relationship trusts that is not unique — read cheaply from the
        model metadata (``live=False``: the column cache) or against the live
        relation (``live=True``, the scan).

        ``fail`` when any fails (the charts on it are refused); ``pass``;
        ``unknown`` when it could not be evaluated; ``not_modelled`` without a
        model. Its own layer: a semantic failure is never reported as a quality
        or freshness one."""
        from app.models.semantic import SemanticModel
        from app.services import semantic_health_service as shs

        if db.query(SemanticModel.id).filter(SemanticModel.dataset_id == dataset_id).first() is None:
            return {"status": "not_modelled", "reasons": [], "failed": 0}
        unreadable: List[str] = []
        try:
            if live:
                # A modelled table whose CURRENT relation cannot be read at all (a
                # column its transformation needs was dropped upstream) is not
                # "valid": the dangling check would fall back to the column cache
                # and pass, while every chart on the table is refused.
                from app.services.dataset_calendar_service import is_generated_calendar_table
                from app.services.dataset_relation_service import logical_relation_columns

                for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all():
                    if (not getattr(t, "datasource_id", None) or getattr(t, "enabled", True) is False
                            or is_generated_calendar_table(t)):
                        continue
                    why: list = []
                    if logical_relation_columns(db, t, why) is None:
                        unreadable.append(f"Bảng {t.display_name or t.source_table_name or t.id}: không đọc "
                                          f"được quan hệ hiện tại — {why[0] if why else 'không rõ lý do'}")
            checks = shs.invalid_relationship_checks(db, dataset_id) + shs.dangling_checks(
                db, dataset_id, live=live)
            if live:
                checks += [c for c in shs.uniqueness_checks(db, dataset_id, execute=True,
                                                            include_primary_keys=False) if c.blocking]
        except Exception as exc:  # noqa: BLE001 — unknown, never "pass"
            logger.warning("[obs] semantic state dataset=%s failed: %s", dataset_id, exc)
            return {"status": "unknown", "reasons": [f"{type(exc).__name__}: {str(exc)[:200]}"], "failed": 0}
        failed = [c for c in checks if c.status == "fail"]
        if failed or unreadable:
            return {"status": "fail", "failed": len(failed) + len(unreadable),
                    "blocking": sum(1 for c in failed if c.blocking) + len(unreadable),
                    "reasons": (unreadable + [c.detail for c in failed])[:10]}
        return {"status": "pass", "reasons": [], "failed": 0}

    @staticmethod
    def fold_semantic(db: Session, dataset_ids: Optional[List[int]] = None) -> List[ObservabilityIncident]:
        """The scan's semantic pass: each modelled dataset's semantic state
        against its LIVE relation, as one incident per dataset in the
        ``semantic`` pillar (opened / refreshed while it fails, resolved once it
        passes; an evaluation that could not run changes nothing)."""
        from app.models.semantic import SemanticModel

        q = db.query(SemanticModel.dataset_id).filter(SemanticModel.dataset_id.isnot(None))
        if dataset_ids is not None:
            q = q.filter(SemanticModel.dataset_id.in_(dataset_ids))
        created: List[ObservabilityIncident] = []
        for (ds_id,) in q.distinct().all():
            st = ObservabilityService.semantic_state(db, ds_id, live=True)
            key = f"semantic:dataset_{ds_id}"
            if st["status"] == "fail":
                inc, was_created = ObservabilityService.upsert_incident(
                    db, dataset_id=ds_id, dataset_table_id=None, source="semantic", dedup_key=key,
                    title=f"Mô hình ngữ nghĩa không dùng được: {st['failed']} lỗi",
                    detail={"reasons": st["reasons"], "blocking": st.get("blocking", 0)},
                    severity="critical" if st.get("blocking") else "warning")
                if was_created:
                    created.append(inc)
                    ObservabilityService._invalidate_dataset_results(db, ds_id)
            elif st["status"] == "pass":
                if ObservabilityService.resolve_incidents(db, key):
                    ObservabilityService._invalidate_dataset_results(db, ds_id)
        return created

    @staticmethod
    def _invalidate_dataset_results(db: Session, dataset_id: int) -> None:
        """The scan just learned the dataset's model changed state (broke, or
        was repaired): a cached live result computed before is not served
        again — the next read asks the source (refused, or the repaired rows)."""
        try:
            from app.services import query_cache

            for (ds,) in db.query(DatasetTable.datasource_id).filter(
                    DatasetTable.dataset_id == dataset_id, DatasetTable.datasource_id.isnot(None)).distinct():
                query_cache.invalidate_datasource(int(ds))
        except Exception:  # noqa: BLE001 — cache hygiene never fails a scan
            logger.warning("[obs] result cache invalidation failed dataset=%s", dataset_id, exc_info=True)

    # ── folding the other detectors into the incident store ────────────────────

    @staticmethod
    def fold_quality(db: Session) -> List[ObservabilityIncident]:
        """Mirror failing quality rules from each dataset's latest run into the
        incident store (and resolve rules that now pass). Returns NEW incidents."""
        created: List[ObservabilityIncident] = []
        ds_ids = [d.id for d in db.query(Dataset.id).all()]
        for ds_id in ds_ids:
            run = (
                db.query(DatasetQualityRun)
                .filter(DatasetQualityRun.dataset_id == ds_id)
                .filter(DatasetQualityRun.status == "completed")
                .order_by(DatasetQualityRun.id.desc()).first()
            )
            if not run or not run.results:
                continue
            rules = {r.id: r for r in db.query(DatasetQualityRule).filter(
                DatasetQualityRule.dataset_id == ds_id).all()}
            for rid_str, res in run.results.items():
                try:
                    rid = int(rid_str)
                except (TypeError, ValueError):
                    continue
                rule = rules.get(rid)
                if rule is None:
                    continue
                key = f"quality:rule_{rid}"
                if isinstance(res, dict) and res.get("skipped") and rule.enabled:
                    # Not evaluated (no data, source unreachable): says nothing
                    # about the breach — it neither opens nor RESOLVES one.
                    continue
                failing = isinstance(res, dict) and not res.get("skipped") and (
                    res.get("error") or not res.get("passed"))
                if failing and rule.enabled:
                    sev = "critical" if (rule.severity == "error" or res.get("error")) else (
                        rule.severity if rule.severity in ("warning", "info") else "warning")
                    inc, was_created = ObservabilityService.upsert_incident(
                        db, dataset_id=ds_id, dataset_table_id=rule.table_id,
                        source="quality", dedup_key=key,
                        title=f"{rule.name}: kiểm tra chất lượng thất bại",
                        detail={"dimension": rule.dimension, "rule_type": rule.rule_type,
                                "column": rule.column_name, "rows_failed": res.get("rows_failed")},
                        severity=sev,
                    )
                    if was_created:
                        created.append(inc)
                else:
                    ObservabilityService.resolve_incidents(db, key)
        return created

    @staticmethod
    def fold_anomaly(db: Session, lookback_days: int = 14) -> List[ObservabilityIncident]:
        """Mirror recent anomaly alerts into the incident store (one open
        incident per monitored metric). Returns NEW incidents."""
        since = datetime.utcnow() - timedelta(days=lookback_days)
        alerts = (
            db.query(AnomalyAlert)
            .filter(AnomalyAlert.detected_at >= since)
            .order_by(AnomalyAlert.detected_at.desc()).all()
        )
        created: List[ObservabilityIncident] = []
        for a in alerts:
            metric = a.metric
            if not metric or not metric.dataset_table:
                continue
            table = metric.dataset_table
            inc, was_created = ObservabilityService.upsert_incident(
                db, dataset_id=table.dataset_id, dataset_table_id=table.id,
                source="anomaly", dedup_key=f"anomaly:metric_{metric.id}",
                title=f"{metric.metric_column}: bất thường ({a.change_pct:+.1f}%, z={a.z_score:.1f})",
                detail={"current": a.current_value, "expected": a.expected_value,
                        "z_score": a.z_score, "change_pct": a.change_pct,
                        "explanation": a.explanation, "dimension_values": a.dimension_values},
                severity="critical" if a.severity in ("critical", "error") else (
                    a.severity if a.severity in ("warning", "info") else "warning"),
            )
            if was_created:
                created.append(inc)
        return created

    # ── full scan (scheduler + manual trigger) ─────────────────────────────────

    @staticmethod
    def _notify_incident_owners(db: Session, incidents: List[ObservabilityIncident]) -> None:
        """Every ObservabilityIncident only ever reached admin-configured alert
        channels (email/Slack/webhook) — never the end user actually looking at
        the affected dataset. Give each dataset owner a UserNotification too."""
        from app.services.user_notification_service import notify_user

        ds_ids = {i.dataset_id for i in incidents if i.dataset_id}
        if not ds_ids:
            return
        owners = dict(
            db.query(Dataset.id, Dataset.owner_id).filter(Dataset.id.in_(ds_ids)).all()
        )
        for inc in incidents:
            owner_id = owners.get(inc.dataset_id)
            if not owner_id:
                continue
            notify_user(
                db, owner_id,
                level="warning" if inc.severity != "critical" else "error",
                title=inc.title,
                description=f"Trụ cột: {inc.pillar} · Nguồn: {inc.source}",
                link=f"/observability?incident={inc.id}",
                source="observability",
                dedup_key=inc.dedup_key,
            )

    @staticmethod
    def scan_all(db: Session) -> Dict[str, int]:
        monitors = db.query(ObservabilityMonitor).filter(
            ObservabilityMonitor.is_active == True  # noqa: E712
        ).all()
        breached = 0
        new_incidents: List[ObservabilityIncident] = []
        for m in monitors:
            try:
                r = ObservabilityService.run_monitor(m, db)
                if r["status"] == "breached":
                    breached += 1
                if r.get("created_incident") is not None:
                    new_incidents.append(r["created_incident"])
            except Exception as exc:
                logger.warning("[obs] monitor %s scan error: %s", m.id, exc)
        q_new = ObservabilityService.fold_quality(db)
        a_new = ObservabilityService.fold_anomaly(db)
        new_incidents.extend(q_new)
        new_incidents.extend(a_new)
        try:
            new_incidents.extend(ObservabilityService.fold_semantic(db))
        except Exception as exc:  # noqa: BLE001 — one layer's failure never loses the scan
            logger.warning("[obs] semantic fold failed: %s", exc)
        try:
            db.commit()
        except Exception as exc:
            logger.error("[obs] scan commit failed — retrying once: %s", exc)
            db.rollback()
            try:
                db.commit()
            except Exception as exc2:
                # A second failure means these incidents genuinely did not
                # persist this round; dropping them silently used to hide a
                # real breach entirely. Surface it as its own visible incident
                # instead of just an error log line.
                logger.error("[obs] scan commit failed twice, incidents lost: %s", exc2)
                db.rollback()
                try:
                    meta = ObservabilityIncident(
                        dataset_id=new_incidents[0].dataset_id if new_incidents else 0,
                        source="quality", pillar="quality",
                        dedup_key="observability:scan_commit_failed",
                        title="Observability scan lỗi khi lưu kết quả",
                        detail={"error": str(exc2)[:2000], "incidents_lost": len(new_incidents)},
                        severity="critical", status="open",
                        first_seen_at=datetime.utcnow(), last_seen_at=datetime.utcnow(),
                    )
                    db.add(meta)
                    db.commit()
                    new_incidents = [meta]
                except Exception:  # noqa: BLE001 — best-effort, do not crash the scan
                    db.rollback()
                    new_incidents = []

        # Fan newly-opened incidents out to alert channels (best-effort) and to
        # each affected dataset's owner (server-side notification feed).
        alerts_sent = 0
        if new_incidents:
            try:
                from app.services.observability_notifier import notify_new_incidents
                alerts_sent = notify_new_incidents(db, new_incidents)
            except Exception as exc:
                logger.warning("[obs] notify failed: %s", exc)
            try:
                ObservabilityService._notify_incident_owners(db, new_incidents)
            except Exception as exc:
                logger.warning("[obs] owner notify failed: %s", exc)

        result = {"monitors": len(monitors), "breached": breached,
                  "quality_folded": len(q_new), "anomaly_folded": len(a_new),
                  "new_incidents": len(new_incidents), "alerts_sent": alerts_sent}
        logger.info("[obs] scan_all %s", result)
        return result

    # ── read-side aggregations ──────────────────────────────────────────────

    @staticmethod
    def get_overview(db: Session, dataset_ids: List[int]) -> Dict[str, Any]:
        """Cross-dataset scorecard driven by the unified incident store +
        monitor cache. Pillars: freshness · volume · schema · distribution ·
        quality."""
        if not dataset_ids:
            return {"datasetsMonitored": 0, "monitors": {"total": 0, "active": 0},
                    "incidents": {"open": 0, "acknowledged": 0, "resolved7d": 0,
                                  "bySeverity": {}, "byPillar": {}},
                    "pillars": [], "mttrHours": None, "recentIncidents": []}

        monitors = db.query(ObservabilityMonitor).filter(
            ObservabilityMonitor.dataset_id.in_(dataset_ids)).all()
        incidents = db.query(ObservabilityIncident).filter(
            ObservabilityIncident.dataset_id.in_(dataset_ids)).all()

        open_inc = [i for i in incidents if i.status != "resolved"]
        by_sev: Dict[str, int] = {}
        by_pillar: Dict[str, int] = {}
        for i in open_inc:
            by_sev[i.severity] = by_sev.get(i.severity, 0) + 1
            by_pillar[i.pillar] = by_pillar.get(i.pillar, 0) + 1

        # MTTR from incidents resolved in the last 30 days.
        since30 = datetime.utcnow() - timedelta(days=30)
        durations = [
            (i.resolved_at - i.first_seen_at).total_seconds() / 3600.0
            for i in incidents
            if i.status == "resolved" and i.resolved_at and i.first_seen_at and i.resolved_at >= since30
        ]
        mttr = round(statistics.mean(durations), 1) if durations else None

        since7 = datetime.utcnow() - timedelta(days=7)
        resolved7 = sum(1 for i in incidents if i.status == "resolved" and i.resolved_at and i.resolved_at >= since7)

        # Per-pillar health card. Monitor-backed pillars also report breached count.
        mon_by_kind: Dict[str, List[ObservabilityMonitor]] = {}
        for m in monitors:
            mon_by_kind.setdefault(m.kind, []).append(m)
        pillars = []
        quality_rules = (
            db.query(DatasetQualityRule).filter(DatasetQualityRule.dataset_id.in_(dataset_ids))
            .filter(DatasetQualityRule.enabled == True).count()  # noqa: E712
            if dataset_ids else 0
        )
        # The quality pillar is judged on the rules' latest run, not on their
        # mere existence (a rule never run read "healthy").
        q_state = ObservabilityService._quality_run_state(db, dataset_ids) if dataset_ids else {}
        for pillar in ("freshness", "volume", "schema", "distribution", "quality"):
            kind_monitors = [m for m in mon_by_kind.get(pillar, []) if m.is_active]
            breached = sum(1 for m in kind_monitors if m.last_status == "breached")
            errored = sum(1 for m in kind_monitors if m.last_status == "error")
            unknown = sum(1 for m in kind_monitors if m.last_status in (None, "unknown"))
            if pillar == "quality":
                breached += sum(q["breached"] for q in q_state.values())
                errored += sum(q["errored"] for q in q_state.values())
                unknown += sum(q["unknown"] for q in q_state.values())
            checks = len(kind_monitors) + (quality_rules if pillar == "quality" else 0)
            state = ObservabilityService.health_state(
                open_incidents=by_pillar.get(pillar, 0), breached=breached, errored=errored,
                unknown=unknown, checks=checks)
            pillars.append({
                "pillar": pillar,
                "monitors": len(kind_monitors),
                "breached": breached,
                "errored": errored,
                "unknown": unknown,
                "openIncidents": by_pillar.get(pillar, 0),
                "status": state,
                "healthy": state == "healthy",
            })
        # Semantic usability, its own pillar: each modelled dataset is one check.
        sem_states = [ObservabilityService.semantic_state(db, ds_id, live=False) for ds_id in dataset_ids]
        sem_states = [st for st in sem_states if st["status"] != "not_modelled"]
        sem_failed = sum(1 for st in sem_states if st["status"] == "fail")
        sem_unknown = sum(1 for st in sem_states if st["status"] == "unknown")
        sem_state = ObservabilityService.health_state(
            open_incidents=by_pillar.get("semantic", 0), breached=0, errored=0, unknown=sem_unknown,
            checks=len(sem_states), semantic_invalid=bool(sem_failed) or bool(by_pillar.get("semantic")))
        pillars.append({
            "pillar": "semantic", "monitors": len(sem_states), "breached": sem_failed, "errored": 0,
            "unknown": sem_unknown, "openIncidents": by_pillar.get("semantic", 0),
            "status": sem_state, "healthy": sem_state == "healthy",
        })

        recent = sorted(open_inc, key=lambda i: (SEV_RANK.get(i.severity, 0), i.last_seen_at or datetime.min), reverse=True)[:8]

        ds_names = {d.id: d.name for d in db.query(Dataset).filter(Dataset.id.in_(dataset_ids)).all()}
        return {
            "datasetsMonitored": len({m.dataset_id for m in monitors} | {i.dataset_id for i in open_inc}),
            "monitors": {"total": len(monitors), "active": sum(1 for m in monitors if m.is_active)},
            "incidents": {
                "open": sum(1 for i in open_inc if i.status == "open"),
                "acknowledged": sum(1 for i in open_inc if i.status == "acknowledged"),
                "resolved7d": resolved7,
                "bySeverity": by_sev,
                "byPillar": by_pillar,
            },
            "pillars": pillars,
            "mttrHours": mttr,
            "recentIncidents": [ObservabilityService.incident_dict(i, ds_names.get(i.dataset_id)) for i in recent],
        }

    @staticmethod
    def incident_dict(i: ObservabilityIncident, dataset_name: Optional[str] = None) -> Dict[str, Any]:
        mttr = None
        if i.resolved_at and i.first_seen_at:
            mttr = round((i.resolved_at - i.first_seen_at).total_seconds() / 3600.0, 1)
        return {
            "id": i.id, "datasetId": i.dataset_id, "dataset": dataset_name,
            "datasetTableId": i.dataset_table_id, "source": i.source, "pillar": i.pillar,
            "title": i.title, "detail": i.detail, "severity": i.severity, "status": i.status,
            "firstSeenAt": ObservabilityService._utc_iso(i.first_seen_at),
            "lastSeenAt": ObservabilityService._utc_iso(i.last_seen_at),
            "resolvedAt": ObservabilityService._utc_iso(i.resolved_at),
            "acknowledgedAt": ObservabilityService._utc_iso(i.acknowledged_at),
            "mttrHours": mttr,
        }

    @staticmethod
    def build_lineage(db: Session, dataset_id: int) -> Dict[str, Any]:
        """source → table → chart → dashboard graph + per-table impact."""
        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            return {"dataset": None, "nodes": [], "edges": [], "tables": []}
        tables = db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()
        table_ids = [t.id for t in tables]
        ds_names = {
            s.id: s.name for s in db.query(DataSource).filter(
                DataSource.id.in_([t.datasource_id for t in tables if t.datasource_id])).all()
        }
        charts = db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).all() if table_ids else []
        chart_ids = [c.id for c in charts]
        dcs = db.query(DashboardChart).filter(DashboardChart.chart_id.in_(chart_ids)).all() if chart_ids else []
        dash_ids = sorted({dc.dashboard_id for dc in dcs})
        dashboards = {d.id: d.name for d in db.query(Dashboard).filter(Dashboard.id.in_(dash_ids)).all()} if dash_ids else {}
        # chart_id → dashboard_ids
        chart_dashboards: Dict[int, List[int]] = {}
        for dc in dcs:
            chart_dashboards.setdefault(dc.chart_id, []).append(dc.dashboard_id)

        # open incidents per table
        open_inc = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dataset_id == dataset_id)
            .filter(ObservabilityIncident.status != "resolved").all()
        )
        inc_by_table: Dict[int, int] = {}
        for i in open_inc:
            if i.dataset_table_id:
                inc_by_table[i.dataset_table_id] = inc_by_table.get(i.dataset_table_id, 0) + 1

        # Quality-rule coverage per table — so the lineage shows which tables
        # have checks (and which are unguarded), and the blast radius of a
        # failing rule.
        rules_by_table: Dict[int, int] = {}
        if table_ids:
            for (tid,) in db.query(DatasetQualityRule.table_id).filter(
                    DatasetQualityRule.table_id.in_(table_ids)).all():
                if tid is not None:
                    rules_by_table[tid] = rules_by_table.get(tid, 0) + 1

        nodes: List[dict] = []
        edges: List[dict] = []
        seen_src = set()
        for t in tables:
            if t.datasource_id and t.datasource_id not in seen_src:
                seen_src.add(t.datasource_id)
                nodes.append({"id": f"src:{t.datasource_id}", "type": "source",
                              "label": ds_names.get(t.datasource_id, "Source")})
            tnode = f"tbl:{t.id}"
            nodes.append({"id": tnode, "type": "table",
                          "label": t.display_name or t.source_table_name or f"table_{t.id}",
                          "openIncidents": inc_by_table.get(t.id, 0),
                          "rules": rules_by_table.get(t.id, 0),
                          "rows": t.estimated_row_count})
            if t.datasource_id:
                edges.append({"from": f"src:{t.datasource_id}", "to": tnode})

        chart_by_table: Dict[int, List[Chart]] = {}
        for c in charts:
            chart_by_table.setdefault(c.dataset_table_id, []).append(c)
            cnode = f"chart:{c.id}"
            nodes.append({"id": cnode, "type": "chart", "label": c.name})
            edges.append({"from": f"tbl:{c.dataset_table_id}", "to": cnode})
            for did in chart_dashboards.get(c.id, []):
                edges.append({"from": cnode, "to": f"dash:{did}"})
        for did, dname in dashboards.items():
            nodes.append({"id": f"dash:{did}", "type": "dashboard", "label": dname})

        tables_summary = []
        for t in tables:
            t_charts = chart_by_table.get(t.id, [])
            t_dash = sorted({did for c in t_charts for did in chart_dashboards.get(c.id, [])})
            tables_summary.append({
                "tableId": t.id,
                "name": t.display_name or t.source_table_name or f"table_{t.id}",
                "source": ds_names.get(t.datasource_id, None),
                "chartCount": len(t_charts),
                "dashboardCount": len(t_dash),
                "dashboards": [{"id": did, "name": dashboards.get(did, f"#{did}")} for did in t_dash],
                "openIncidents": inc_by_table.get(t.id, 0),
                "rules": rules_by_table.get(t.id, 0),
                "rows": t.estimated_row_count,
            })
        # Sort by risk: open incidents first, then broad blast radius, then
        # unguarded tables (no rules) that feed many charts.
        tables_summary.sort(key=lambda x: (-x["openIncidents"], -x["chartCount"], x["rules"]))

        return {
            "dataset": {"id": dataset.id, "name": dataset.name},
            "nodes": nodes, "edges": edges, "tables": tables_summary,
            "impact": {"charts": len(charts), "dashboards": len(dash_ids)},
        }

    # ── semantic (column + measure level) lineage ────────────────────────────

    @staticmethod
    def _identifiers(text: Optional[str]) -> set:
        """Bare identifiers + ${...} refs found in a SQL/expression string."""
        if not text:
            return set()
        out = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", str(text)))
        for inner in re.findall(r"\$\{([^}]+)\}", str(text)):
            out.add(inner.strip())
            if "." in inner:
                out.add(inner.rsplit(".", 1)[-1].strip())
        return out

    @staticmethod
    def build_semantic_lineage(db: Session, dataset_id: int) -> Dict[str, Any]:
        """Column- and measure-level lineage from the SEMANTIC MODEL.

        Reads views (columns + measures), explore joins (join keys), maps
        quality rules / incidents down to the column, derives measure→column and
        measure→measure dependencies, and best-effort chart→field usage — so a
        problem on one column can be traced to every dependent measure, joined
        table, chart and dashboard.
        """
        from app.services.dataset_model_service import get_dataset_model

        dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            return {"dataset": None, "tables": [], "joins": [], "charts": [], "dashboards": []}
        model = get_dataset_model(db, dataset_id) or {}
        views = model.get("views") or []
        explores = model.get("explores") or []

        # view name → dataset_table_id (only real table views carry one)
        view_to_table: Dict[str, int] = {}
        table_views = []
        for v in views:
            if v.get("dataset_table_id"):
                view_to_table[v["name"]] = v["dataset_table_id"]
                table_views.append(v)

        # quality rules by (table_id, column); + failing rule ids from latest run
        rules = db.query(DatasetQualityRule).filter(
            DatasetQualityRule.dataset_id == dataset_id).all()
        failing_rule_ids: set = set()
        latest = (
            db.query(DatasetQualityRun)
            .filter(DatasetQualityRun.dataset_id == dataset_id)
            .filter(DatasetQualityRun.status == "completed")
            .order_by(DatasetQualityRun.id.desc()).first()
        )
        if latest and latest.results:
            for rid_str, res in latest.results.items():
                if isinstance(res, dict) and not res.get("skipped") and (res.get("error") or not res.get("passed")):
                    try:
                        failing_rule_ids.add(int(rid_str))
                    except (TypeError, ValueError):
                        pass
        rules_by_col: Dict[tuple, Dict[str, int]] = {}   # (table_id, col) → {rules, failing}
        rules_table_level: Dict[int, Dict[str, int]] = {}
        for r in rules:
            key = (r.table_id, r.column_name)
            slot = rules_by_col.setdefault(key, {"rules": 0, "failing": 0})
            slot["rules"] += 1
            if r.id in failing_rule_ids:
                slot["failing"] += 1
            if r.column_name is None:
                t = rules_table_level.setdefault(r.table_id, {"rules": 0, "failing": 0})
                t["rules"] += 1
                if r.id in failing_rule_ids:
                    t["failing"] += 1

        # open incidents → per table + per column (fold detail carries "column")
        open_inc = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dataset_id == dataset_id)
            .filter(ObservabilityIncident.status != "resolved").all()
        )
        inc_by_table: Dict[int, int] = {}
        inc_by_col: Dict[tuple, int] = {}
        for i in open_inc:
            if i.dataset_table_id:
                inc_by_table[i.dataset_table_id] = inc_by_table.get(i.dataset_table_id, 0) + 1
                col = (i.detail or {}).get("column") if isinstance(i.detail, dict) else None
                if col:
                    inc_by_col[(i.dataset_table_id, col)] = inc_by_col.get((i.dataset_table_id, col), 0) + 1

        # datasource names
        tables_orm = {t.id: t for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == dataset_id).all()}
        ds_names = {
            s.id: s.name for s in db.query(DataSource).filter(
                DataSource.id.in_([t.datasource_id for t in tables_orm.values() if t.datasource_id])).all()
        }

        # join keys per (view) so columns can be flagged as join keys
        join_key_cols: set = set()   # {(table_id, col)}
        joins_out: List[dict] = []
        for e in explores:
            base = e.get("base_view_name")
            base_tid = view_to_table.get(base)
            for j in e.get("joins") or []:
                tview = j.get("view")
                to_tid = view_to_table.get(tview)
                from app.services.semantic_join_resolver import read_join_contract

                _c = read_join_contract(str(base or ""), j)  # lineage shows what the runtime reads
                fcol, tcol = (_c.key_pairs[0] if _c.key_pairs else (j.get("from_column"), j.get("to_column")))
                if base_tid and to_tid and base_tid != to_tid:
                    joins_out.append({
                        "fromTable": base_tid, "fromColumn": fcol,
                        "toTable": to_tid, "toColumn": tcol,
                        "relationship": _c.cardinality,
                        "active": _c.is_active if _c.valid else False,
                        "invalid": list(_c.invalid),
                    })
                    if fcol:
                        join_key_cols.add((base_tid, fcol))
                    if tcol and to_tid:
                        join_key_cols.add((to_tid, tcol))

        # build tables with columns + measures (+ derived deps)
        tables_out: List[dict] = []
        for v in table_views:
            tid = v["dataset_table_id"]
            dim_names = {d.get("name") for d in (v.get("dimensions") or []) if isinstance(d, dict) and d.get("name")}
            measure_names = {m.get("name") for m in (v.get("measures") or []) if isinstance(m, dict) and m.get("name")}

            columns = []
            for d in (v.get("dimensions") or []):
                if not isinstance(d, dict) or not d.get("name"):
                    continue
                name = d["name"]
                rc = rules_by_col.get((tid, name), {"rules": 0, "failing": 0})
                columns.append({
                    "name": name, "type": d.get("type"),
                    "rules": rc["rules"], "failingRules": rc["failing"],
                    "incidents": inc_by_col.get((tid, name), 0),
                    "joinKey": (tid, name) in join_key_cols,
                })

            measures = []
            for m in (v.get("measures") or []):
                if not isinstance(m, dict) or not m.get("name"):
                    continue
                # same-view column deps: tokens in sql/expression/filters that match this view's dims
                toks = ObservabilityService._identifiers(m.get("sql")) | ObservabilityService._identifiers(m.get("expression"))
                for f in (m.get("filters") or []):
                    if isinstance(f, dict) and f.get("field"):
                        toks.add(str(f["field"]).rsplit(".", 1)[-1])
                dep_cols = [{"table": tid, "column": c} for c in sorted(toks & dim_names)]
                # cross-view column deps (scope=dataset) via source_columns
                for sc in (m.get("source_columns") or []):
                    if isinstance(sc, dict) and sc.get("field"):
                        sc_tid = view_to_table.get(sc.get("view"))
                        if sc_tid:
                            dep_cols.append({"table": sc_tid, "column": sc["field"]})
                # measure→measure deps
                dep_measures = []
                for dep in (m.get("depends_on") or []):
                    if "." in dep:
                        dv, dm = dep.rsplit(".", 1)
                        dt = view_to_table.get(dv)
                        dep_measures.append({"table": dt or tid, "measure": dm})
                    else:
                        dep_measures.append({"table": tid, "measure": dep})
                measures.append({
                    "name": m["name"], "label": m.get("label") or m["name"], "type": m.get("type"),
                    "dependsColumns": dep_cols, "dependsMeasures": dep_measures,
                })

            t_orm = tables_orm.get(tid)
            tl = rules_table_level.get(tid, {"rules": 0, "failing": 0})
            tables_out.append({
                "tableId": tid,
                "view": v["name"],
                "name": v.get("table_display_name") or (t_orm.display_name if t_orm else v["name"]),
                "source": ds_names.get(t_orm.datasource_id) if t_orm and t_orm.datasource_id else None,
                "columns": columns,
                "measures": measures,
                "tableRules": tl["rules"],
                "tableFailingRules": tl["failing"],
                "openIncidents": inc_by_table.get(tid, 0),
            })

        # charts on these tables + best-effort field usage + dashboards
        table_ids = list(tables_orm.keys())
        charts = db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).all() if table_ids else []
        chart_ids = [c.id for c in charts]
        dcs = db.query(DashboardChart).filter(DashboardChart.chart_id.in_(chart_ids)).all() if chart_ids else []
        chart_dash: Dict[int, List[int]] = {}
        for dc in dcs:
            chart_dash.setdefault(dc.chart_id, []).append(dc.dashboard_id)
        dash_ids = sorted({dc.dashboard_id for dc in dcs})
        dashboards = {d.id: d.name for d in db.query(Dashboard).filter(Dashboard.id.in_(dash_ids)).all()} if dash_ids else {}
        # per-table field name sets for matching
        dims_by_table = {t["tableId"]: {c["name"] for c in t["columns"]} for t in tables_out}
        meas_by_table = {t["tableId"]: {m["name"] for m in t["measures"]} for t in tables_out}
        charts_out: List[dict] = []
        for c in charts:
            strs = ObservabilityService._collect_config_strings(c.config)
            uses_cols = sorted(strs & dims_by_table.get(c.dataset_table_id, set()))
            uses_meas = sorted(strs & meas_by_table.get(c.dataset_table_id, set()))
            charts_out.append({
                "id": c.id, "name": c.name, "tableId": c.dataset_table_id,
                "usesColumns": uses_cols, "usesMeasures": uses_meas,
                "dashboardIds": chart_dash.get(c.id, []),
            })

        return {
            "dataset": {"id": dataset.id, "name": dataset.name},
            "hasModel": bool(model.get("views")),
            "tables": tables_out,
            "joins": joins_out,
            "charts": charts_out,
            "dashboards": [{"id": did, "name": dashboards.get(did, f"#{did}")} for did in dash_ids],
        }

    @staticmethod
    def _collect_config_strings(config: Any) -> set:
        """Recursively collect string leaf values + dict keys from a chart config."""
        out: set = set()

        def walk(node):
            if isinstance(node, dict):
                for k, val in node.items():
                    out.add(str(k))
                    walk(val)
            elif isinstance(node, (list, tuple)):
                for item in node:
                    walk(item)
            elif isinstance(node, str):
                out.add(node)
                if "." in node:
                    out.add(node.rsplit(".", 1)[-1])
        walk(config or {})
        return out

    @staticmethod
    def get_usage(db: Session, dataset_ids: List[int]) -> List[Dict[str, Any]]:
        """Per-dataset usage + resource footprint: consumption (charts/
        dashboards), size (rows/bytes), staleness, monitoring coverage."""
        if not dataset_ids:
            return []
        datasets = db.query(Dataset).filter(Dataset.id.in_(dataset_ids)).all()
        tables = db.query(DatasetTable).filter(DatasetTable.dataset_id.in_(dataset_ids)).all()
        tables_by_ds: Dict[int, List[DatasetTable]] = {}
        for t in tables:
            tables_by_ds.setdefault(t.dataset_id, []).append(t)
        all_table_ids = [t.id for t in tables]
        table_ds = {t.id: t.dataset_id for t in tables}

        charts = db.query(Chart).filter(Chart.dataset_table_id.in_(all_table_ids)).all() if all_table_ids else []
        charts_per_ds: Dict[int, List[int]] = {}
        for c in charts:
            ds_id = table_ds.get(c.dataset_table_id)
            if ds_id:
                charts_per_ds.setdefault(ds_id, []).append(c.id)
        chart_ids = [c.id for c in charts]
        dcs = db.query(DashboardChart).filter(DashboardChart.chart_id.in_(chart_ids)).all() if chart_ids else []
        chart_to_dash: Dict[int, List[int]] = {}
        for dc in dcs:
            chart_to_dash.setdefault(dc.chart_id, []).append(dc.dashboard_id)

        monitors = db.query(ObservabilityMonitor).filter(
            ObservabilityMonitor.dataset_id.in_(dataset_ids)).all()
        mon_per_ds: Dict[int, int] = {}
        # What health is judged on: the checks that actually RUN — an active
        # monitor, an enabled rule. A dataset whose only monitors are paused is
        # not "healthy", it is not monitored.
        active_mon_per_ds: Dict[int, int] = {}
        err_per_ds: Dict[int, int] = {}
        unk_per_ds: Dict[int, int] = {}
        brk_per_ds: Dict[int, int] = {}
        for m in monitors:
            mon_per_ds[m.dataset_id] = mon_per_ds.get(m.dataset_id, 0) + 1
            if not m.is_active:
                continue
            active_mon_per_ds[m.dataset_id] = active_mon_per_ds.get(m.dataset_id, 0) + 1
            if m.last_status == "error":
                err_per_ds[m.dataset_id] = err_per_ds.get(m.dataset_id, 0) + 1
            elif m.last_status in (None, "unknown"):
                unk_per_ds[m.dataset_id] = unk_per_ds.get(m.dataset_id, 0) + 1
            elif m.last_status == "breached":
                brk_per_ds[m.dataset_id] = brk_per_ds.get(m.dataset_id, 0) + 1
        open_inc = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dataset_id.in_(dataset_ids))
            .filter(ObservabilityIncident.status != "resolved").all()
        )
        inc_per_ds: Dict[int, int] = {}
        sem_inc: Dict[int, ObservabilityIncident] = {}
        for i in open_inc:
            inc_per_ds[i.dataset_id] = inc_per_ds.get(i.dataset_id, 0) + 1
            if i.pillar == "semantic":
                sem_inc[i.dataset_id] = i
        # Quality rules per dataset — a dataset with rules is "observed" even
        # without a native monitor, so the FE list can include it.
        rules_per_ds: Dict[int, int] = {}
        enabled_rules_per_ds: Dict[int, int] = {}
        for (ds_id, enabled) in db.query(DatasetQualityRule.dataset_id, DatasetQualityRule.enabled).filter(
                DatasetQualityRule.dataset_id.in_(dataset_ids)).all():
            rules_per_ds[ds_id] = rules_per_ds.get(ds_id, 0) + 1
            if enabled:
                enabled_rules_per_ds[ds_id] = enabled_rules_per_ds.get(ds_id, 0) + 1

        for ds_id, q in ObservabilityService._quality_run_state(db, dataset_ids).items():
            for key, bucket in (("errored", err_per_ds), ("unknown", unk_per_ds), ("breached", brk_per_ds)):
                if q[key]:
                    bucket[ds_id] = bucket.get(ds_id, 0) + q[key]

        # Semantic usability: the model's state from its metadata now (cheap),
        # or the scan's live finding (an open semantic incident) — either way a
        # known semantic failure is never "healthy".
        def _semantic(ds_id: int) -> Dict[str, Any]:
            st = ObservabilityService.semantic_state(db, ds_id, live=False)
            inc = sem_inc.get(ds_id)
            if inc is not None and st["status"] != "fail":
                reasons = list((inc.detail or {}).get("reasons") or [])
                st = {"status": "fail", "failed": len(reasons) or 1, "reasons": reasons[:10],
                      "source": "scan", "since": ObservabilityService._utc_iso(inc.first_seen_at)}
            return st

        out = []
        for d in datasets:
            ts = tables_by_ds.get(d.id, [])
            sem = _semantic(d.id)
            rows = sum((t.estimated_row_count or 0) for t in ts)
            size = sum((t.estimated_size_bytes or 0) for t in ts)
            last_refresh = max([t.stats_updated_at for t in ts if t.stats_updated_at], default=None)
            ds_chart_ids = charts_per_ds.get(d.id, [])
            dash_ids = sorted({did for cid in ds_chart_ids for did in chart_to_dash.get(cid, [])})
            out.append({
                "datasetId": d.id, "dataset": d.name,
                "tables": len(ts), "rows": rows, "sizeBytes": size,
                "chartCount": len(ds_chart_ids), "dashboardCount": len(dash_ids),
                "lastRefresh": ObservabilityService._utc_iso(last_refresh),
                "monitors": mon_per_ds.get(d.id, 0),
                "qualityRules": rules_per_ds.get(d.id, 0),
                "openIncidents": inc_per_ds.get(d.id, 0),
                "erroredChecks": err_per_ds.get(d.id, 0),
                "unknownChecks": unk_per_ds.get(d.id, 0),
                "health": ObservabilityService.health_state(
                    open_incidents=inc_per_ds.get(d.id, 0), breached=brk_per_ds.get(d.id, 0),
                    errored=err_per_ds.get(d.id, 0), unknown=unk_per_ds.get(d.id, 0),
                    checks=active_mon_per_ds.get(d.id, 0) + enabled_rules_per_ds.get(d.id, 0),
                    semantic_invalid=sem["status"] == "fail"),
                "semantic": sem,
                "unused": len(ds_chart_ids) == 0,
                # "observed" = has any check set up (monitor or rule), an open
                # incident, or a known semantic failure (listed even unmonitored)
                "observed": (mon_per_ds.get(d.id, 0) > 0 or rules_per_ds.get(d.id, 0) > 0
                             or inc_per_ds.get(d.id, 0) > 0 or sem["status"] == "fail"),
            })
        out.sort(key=lambda x: (-(x["chartCount"] + x["dashboardCount"]), -x["rows"]))
        return out
