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
PILLAR_FOR_SOURCE = {
    "freshness": "freshness", "volume": "volume", "schema": "schema",
    "quality": "quality", "anomaly": "distribution",
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
            detail["reason"] = "đang học baseline"
            return "ok", cnt, detail  # not enough history yet
        mean = statistics.mean(vals)
        try:
            std = statistics.stdev(vals)
        except statistics.StatisticsError:
            std = 0.0
        if std == 0:
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
        current = ObservabilityService._columns_fingerprint(table)
        # Compare to the most recent prior snapshot that captured columns.
        prev = (
            db.query(ObservabilityCheck)
            .filter(ObservabilityCheck.monitor_id == monitor.id)
            .filter(ObservabilityCheck.detail.isnot(None))
            .order_by(ObservabilityCheck.checked_at.desc())
            .first()
        )
        prev_cols = (prev.detail or {}).get("columns") if prev else None
        if not prev_cols:
            return "ok", float(len(current)), {"columns": current, "reason": "baseline đã lưu"}

        prev_map = {c["name"]: c.get("type", "") for c in prev_cols}
        cur_map = {c["name"]: c.get("type", "") for c in current}
        added = [n for n in cur_map if n not in prev_map]
        removed = [n for n in prev_map if n not in cur_map]
        retyped = [
            {"column": n, "from": prev_map[n], "to": cur_map[n]}
            for n in cur_map if n in prev_map and prev_map[n] != cur_map[n]
        ]
        detail = {"columns": current, "added": added, "removed": removed, "retyped": retyped}
        if added or removed or retyped:
            detail["reason"] = "cột thêm/xoá/đổi kiểu"
            return "breached", float(len(current)), detail
        return "ok", float(len(current)), detail

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
        """Auto-resolve any open/ack incident whose underlying check now passes."""
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
        return len(rows)

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
            db.commit()
        except Exception as exc:
            logger.error("[obs] scan commit failed: %s", exc)
            db.rollback()
            new_incidents = []

        # Fan newly-opened incidents out to alert channels (best-effort).
        alerts_sent = 0
        if new_incidents:
            try:
                from app.services.observability_notifier import notify_new_incidents
                alerts_sent = notify_new_incidents(db, new_incidents)
            except Exception as exc:
                logger.warning("[obs] notify failed: %s", exc)

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
        for pillar in ("freshness", "volume", "schema", "distribution", "quality"):
            kind_monitors = mon_by_kind.get(pillar, [])
            breached = sum(1 for m in kind_monitors if m.last_status == "breached")
            pillars.append({
                "pillar": pillar,
                "monitors": len(kind_monitors),
                "breached": breached,
                "openIncidents": by_pillar.get(pillar, 0),
                "healthy": by_pillar.get(pillar, 0) == 0 and breached == 0,
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
            "firstSeenAt": i.first_seen_at.isoformat() if i.first_seen_at else None,
            "lastSeenAt": i.last_seen_at.isoformat() if i.last_seen_at else None,
            "resolvedAt": i.resolved_at.isoformat() if i.resolved_at else None,
            "acknowledgedAt": i.acknowledged_at.isoformat() if i.acknowledged_at else None,
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
                fcol, tcol = j.get("from_column"), j.get("to_column")
                if base_tid and to_tid and base_tid != to_tid:
                    joins_out.append({
                        "fromTable": base_tid, "fromColumn": fcol,
                        "toTable": to_tid, "toColumn": tcol,
                        "relationship": j.get("relationship"),
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
        for m in monitors:
            mon_per_ds[m.dataset_id] = mon_per_ds.get(m.dataset_id, 0) + 1
        open_inc = (
            db.query(ObservabilityIncident)
            .filter(ObservabilityIncident.dataset_id.in_(dataset_ids))
            .filter(ObservabilityIncident.status != "resolved").all()
        )
        inc_per_ds: Dict[int, int] = {}
        for i in open_inc:
            inc_per_ds[i.dataset_id] = inc_per_ds.get(i.dataset_id, 0) + 1
        # Quality rules per dataset — a dataset with rules is "observed" even
        # without a native monitor, so the FE list can include it.
        rules_per_ds: Dict[int, int] = {}
        for (ds_id,) in db.query(DatasetQualityRule.dataset_id).filter(
                DatasetQualityRule.dataset_id.in_(dataset_ids)).all():
            rules_per_ds[ds_id] = rules_per_ds.get(ds_id, 0) + 1

        out = []
        for d in datasets:
            ts = tables_by_ds.get(d.id, [])
            rows = sum((t.estimated_row_count or 0) for t in ts)
            size = sum((t.estimated_size_bytes or 0) for t in ts)
            last_refresh = max([t.stats_updated_at for t in ts if t.stats_updated_at], default=None)
            ds_chart_ids = charts_per_ds.get(d.id, [])
            dash_ids = sorted({did for cid in ds_chart_ids for did in chart_to_dash.get(cid, [])})
            out.append({
                "datasetId": d.id, "dataset": d.name,
                "tables": len(ts), "rows": rows, "sizeBytes": size,
                "chartCount": len(ds_chart_ids), "dashboardCount": len(dash_ids),
                "lastRefresh": last_refresh.isoformat() if last_refresh else None,
                "monitors": mon_per_ds.get(d.id, 0),
                "qualityRules": rules_per_ds.get(d.id, 0),
                "openIncidents": inc_per_ds.get(d.id, 0),
                "unused": len(ds_chart_ids) == 0,
                # "observed" = has any check set up (monitor or rule) or an open incident
                "observed": mon_per_ds.get(d.id, 0) > 0 or rules_per_ds.get(d.id, 0) > 0 or inc_per_ds.get(d.id, 0) > 0,
            })
        out.sort(key=lambda x: (-(x["chartCount"] + x["dashboardCount"]), -x["rows"]))
        return out
